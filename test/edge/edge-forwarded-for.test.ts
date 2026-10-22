/**
 * haxlite Edge `X-Forwarded-For` handling: only trusted proxies' headers
 * count, entries with a port are keyed on their address, and exempt sources
 * are reported in the log.
 */
import { connect as tcpConnect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EdgeServer, type EdgeServerOptions } from '../../src/edge/index.js';
import { EdgeMsg } from '../../src/net/index.js';
import { EDGE_IP, makeKey, startEdge } from './harness.js';

const key = makeKey('alice');
const edges: EdgeServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const e of edges.splice(0)) await e.close();
});

const tight = { maxPreAuthPerIp: 2, ipConnectCapacity: 3, ipConnectMsPerToken: 60_000 };

async function edgeWith(options: Partial<EdgeServerOptions>): Promise<EdgeServer> {
  const e = await startEdge([key], options);
  edges.push(e);
  return e;
}

/** Upgrade outcome: 101 once the Hello arrived, else the refusal status. */
function open(edge: EdgeServer, localAddress: string, xff?: string): Promise<number> {
  const ws = new WebSocket(edge.url(), { localAddress, headers: xff === undefined ? {} : { 'X-Forwarded-For': xff } });
  ws.on('error', () => {});
  sockets.push(ws);
  return new Promise((resolve) => {
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.once('message', (d: Buffer) => resolve(d[0] === EdgeMsg.Hello ? 101 : -1));
    ws.on('close', () => resolve(0));
  });
}

async function statuses(edge: EdgeServer, localAddress: string, xffs: readonly (string | undefined)[]): Promise<number[]> {
  const out: number[] = [];
  for (const x of xffs) out.push(await open(edge, localAddress, x));
  return out;
}

/** Raw upgrade with the given extra header lines; resolves with the response status. */
function rawStatus(edge: EdgeServer, localAddress: string, headerLines: readonly string[]): Promise<number> {
  const port = edge.address.port;
  return new Promise((resolve) => {
    const s = tcpConnect({ host: EDGE_IP, port, localAddress }, () =>
      s.write(
        `GET /tunnel HTTP/1.1\r\nHost: ${EDGE_IP}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headerLines.map((l) => `${l}\r\n`).join('')}\r\n`,
      ),
    );
    s.on('error', () => resolve(0));
    s.once('data', (d: Buffer) => {
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(d.toString('latin1'))?.[1] ?? -1));
      s.destroy();
    });
  });
}

describe('EdgeServer trustForwardedFor', () => {
  it('a list trusts only those proxies: another private source cannot spend a client address quota', async () => {
    const edge = await edgeWith({ limits: { ...tight, trustForwardedFor: ['127.0.0.40', '127.0.7.0/24'] } });
    // a co-tenant reaching the edge directly: its header is ignored (and loopback is exempt)
    expect(await statuses(edge, '127.0.6.1', Array(6).fill('203.0.113.50'))).toEqual(Array(6).fill(101));
    // the victim through the real proxy is unaffected; the proxy's entries are honoured and limited
    expect(await statuses(edge, '127.0.0.40', ['203.0.113.50', '203.0.113.50', '203.0.113.50'])).toEqual([101, 101, 429]);
    // a CIDR entry
    expect(await statuses(edge, '127.0.7.9', ['203.0.113.51', '203.0.113.51', '203.0.113.51'])).toEqual([101, 101, 429]);
  });

  it('true trusts loopback proxies', async () => {
    const edge = await edgeWith({ limits: { ...tight, trustForwardedFor: true } });
    expect(await statuses(edge, '127.0.0.41', ['203.0.113.60', '203.0.113.60', '203.0.113.60'])).toEqual([101, 101, 429]);
    expect(edge.limits.trustForwardedFor).toBe(true);
  });

  it('an entry with a port is keyed on its address instead of lifting the limits', async () => {
    const edge = await edgeWith({ limits: { ...tight, trustForwardedFor: true } });
    expect(await statuses(edge, '127.0.0.42', ['198.51.100.7:51234', '198.51.100.7:51235', '198.51.100.7'])).toEqual([101, 101, 429]);
    // IPv6 with a port shares its /64 with the bare form
    expect(await statuses(edge, '127.0.0.42', ['[2001:db8::1]:443', '2001:db8::2', '[2001:db8::3]'])).toEqual([101, 101, 429]);
    // an IPv4-mapped address is the IPv4 address
    expect(await statuses(edge, '127.0.0.42', ['::ffff:203.0.113.7', '203.0.113.7', '[::ffff:203.0.113.7]:80'])).toEqual([101, 101, 429]);
  });

  it('several header lines: the last entry of the last one counts', async () => {
    const edge = await edgeWith({ limits: { ...tight, trustForwardedFor: true } });
    expect(await statuses(edge, '127.0.0.43', ['203.0.113.90', '203.0.113.90'])).toEqual([101, 101]);
    expect(await rawStatus(edge, '127.0.0.43', ['X-Forwarded-For: 203.0.113.80', 'X-Forwarded-For: 10.0.0.1, 203.0.113.90'])).toBe(429);
    expect(await rawStatus(edge, '127.0.0.43', ['X-Forwarded-For: 203.0.113.90', 'X-Forwarded-For: 10.0.0.1, 203.0.113.91'])).toBe(101);
  });

  it('an unusable last entry keys on the proxy and is logged once', async () => {
    const logs: string[] = [];
    const edge = await edgeWith({ limits: { ...tight, trustForwardedFor: true }, log: (m) => logs.push(m) });
    expect(await statuses(edge, '127.0.0.44', ['not-an-ip', '1.2.3.4:http', '[2001:db8::1', '[2001:db8::1]x'])).toEqual([101, 101, 101, 101]);
    expect(logs.filter((l) => /X-Forwarded-For from proxy 127\.0\.0\.44 has no usable last entry/.test(l))).toHaveLength(1);
  });

  it('rejects a list entry that is not an address or a CIDR range when the edge is built', () => {
    for (const bad of [['10.0.0.0/33'], ['proxy'], [42], ['127.0.0.1', '']]) {
      expect(() => new EdgeServer({ keys: [{ id: key.id, secret: key.secret }], limits: { trustForwardedFor: bad as never } }), JSON.stringify(bad)).toThrow(
        RangeError,
      );
    }
  });
});

describe('EdgeServer exempt sources', () => {
  it('logs (once) that a loopback/private source is exempt from the per-address limits', async () => {
    const logs: string[] = [];
    const edge = await edgeWith({ limits: tight, log: (m) => logs.push(m) });
    expect(await statuses(edge, '127.0.0.45', [undefined, undefined, undefined, undefined])).toEqual([101, 101, 101, 101]);
    const notes = logs.filter((l) => /exempt from the per-address limits/.test(l));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('127.0.0.45');
    expect(notes[0]).toContain('trustForwardedFor');
    expect(notes[0]).toContain('perIpLimitsApplyToPrivate');

    const strict = await edgeWith({ limits: { ...tight, perIpLimitsApplyToPrivate: true }, log: (m) => logs.push(m) });
    logs.length = 0;
    await open(strict, '127.0.0.46');
    expect(logs.some((l) => /exempt/.test(l))).toBe(false);
  });
});
