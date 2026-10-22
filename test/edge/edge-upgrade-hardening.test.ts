/**
 * haxlite Edge control listener: remote resets on refused upgrades, broken
 * frames on refused WebSockets, per-address limits behind a reverse proxy,
 * limit validation, the pre-auth pool policy and the anonymous stats marker.
 */
import { connect as tcpConnect, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import { EdgeServer, type EdgeServerOptions } from '../../src/edge/index.js';
import { EdgeCloseCode, EdgeMsg, edgeAuthMac } from '../../src/net/index.js';
import { EDGE_IP, makeKey, startEdge, type TestKey } from './harness.js';

const key = makeKey('alice');
const edges: EdgeServer[] = [];
const sockets: WebSocket[] = [];
const uncaught: Error[] = [];
const onUncaught = (err: Error): void => {
  uncaught.push(err);
};

beforeEach(() => {
  uncaught.length = 0;
  process.on('uncaughtException', onUncaught);
});

afterEach(async () => {
  process.off('uncaughtException', onUncaught);
  for (const s of sockets.splice(0)) s.terminate();
  for (const e of edges.splice(0)) await e.close();
});

async function edgeWith(options: Partial<EdgeServerOptions>, keys: TestKey[] = [key]): Promise<EdgeServer> {
  const e = await startEdge(keys, options);
  edges.push(e);
  return e;
}

interface Conn {
  ws: WebSocket;
  /** Resolves with the Hello nonce, or null if the socket never opened. */
  hello: Promise<Uint8Array | null>;
  closed: Promise<number>;
  /** HTTP status of a refused upgrade (0 when it was not refused that way). */
  status: Promise<number>;
}

function connect(url: string, localAddress: string, headers: Record<string, string> = {}): Conn {
  const ws = new WebSocket(url, { localAddress, headers });
  ws.binaryType = 'nodebuffer';
  ws.on('error', () => {});
  sockets.push(ws);
  const status = new Promise<number>((resolve) => {
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.on('close', () => resolve(0));
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const hello = new Promise<Uint8Array | null>((resolve) => {
    ws.once('message', (d: Buffer) => {
      if (d[0] !== EdgeMsg.Hello) return resolve(null);
      const r = new Reader(d);
      r.u8();
      r.u8();
      resolve(r.bytesCopy(32));
    });
    void closed.then(() => resolve(null));
  });
  return { ws, hello, closed, status };
}

/** Authenticates (protocol 1, WebSocket data plane); resolves with the AuthOk/close outcome. */
async function authenticate(c: Conn, k: TestKey): Promise<'ok' | number> {
  const nonce = await c.hello;
  if (nonce === null) return c.closed;
  const w = new Writer(256);
  w.u8(EdgeMsg.Auth);
  w.u8(1);
  w.string(k.id);
  w.bytes(edgeAuthMac(k.secret, nonce));
  w.u8(0);
  c.ws.send(w.copyBytes());
  return new Promise((resolve) => {
    c.ws.on('message', (d: Buffer) => {
      if (d[0] === EdgeMsg.AuthOk) resolve('ok');
    });
    void c.closed.then(resolve);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function upgradeRequest(port: number): string {
  return (
    `GET /tunnel HTTP/1.1\r\nHost: ${EDGE_IP}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
}

/** Raw TCP connection that sends an upgrade request; resolves once it is connected and written. */
function rawUpgrade(port: number, localAddress: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = tcpConnect({ host: EDGE_IP, port, localAddress }, () => s.write(upgradeRequest(port), () => resolve(s)));
    s.on('error', () => {});
    s.once('error', reject);
  });
}

describe('EdgeServer refused upgrades survive remote resets', () => {
  it('hundreds of upgrades reset while the 429 is written do not take the edge down', async () => {
    const edge = await edgeWith({ limits: { ipConnectCapacity: 1, ipConnectMsPerToken: 60_000, perIpLimitsApplyToPrivate: true } });
    const port = edge.address.port;
    for (let round = 0; round < 40; round++) {
      const batch: Promise<void>[] = [];
      for (let i = 0; i < 15; i++) {
        batch.push(
          rawUpgrade(port, '127.0.0.20').then(
            (s) =>
              new Promise<void>((resolve) => {
                // reset at different points around the edge's reply
                const reset = () => {
                  s.resetAndDestroy();
                  resolve();
                };
                if (i % 3 === 0) reset();
                else if (i % 3 === 1) setImmediate(reset);
                else s.once('data', reset);
                setTimeout(resolve, 200);
              }),
            () => undefined,
          ),
        );
      }
      await Promise.all(batch);
    }
    await sleep(100);
    expect(uncaught).toEqual([]);
    // still serving
    expect(await authenticate(connect(edge.url(), '127.0.0.21'), key)).toBe('ok');
  });

  it('a broken frame on a WebSocket refused because the edge is full does not take the edge down', async () => {
    const edge = await edgeWith({ limits: { maxSessions: 0 } });
    const port = edge.address.port;
    for (let i = 0; i < 20; i++) {
      const s = await rawUpgrade(port, '127.0.0.22');
      await new Promise<void>((resolve) => {
        let got = '';
        s.on('data', (d: Buffer) => {
          got += d.toString('latin1');
          if (got.includes('\r\n\r\n')) {
            // binary frame without the mandatory client mask
            s.write(Buffer.from([0x82, 0x01, 0x00]));
            resolve();
          }
        });
      });
      await new Promise<void>((resolve) => {
        s.once('close', () => resolve());
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 3000);
      });
    }
    await sleep(50);
    expect(uncaught).toEqual([]);
    expect((await fetch(`http://${EDGE_IP}:${port}/stats`)).status).toBe(200);
  });
});

describe('EdgeServer per-address limits and shared sources', () => {
  const tight = { maxPreAuthPerIp: 2, ipConnectCapacity: 3, ipConnectMsPerToken: 60_000 };

  it('loopback/private sources (a reverse proxy) are exempt unless asked', async () => {
    const edge = await edgeWith({ limits: tight });
    let opened = 0;
    for (let i = 0; i < 10; i++) if ((await connect(edge.url(), '127.0.0.30').hello) !== null) opened++;
    expect(opened).toBe(10);

    const strict = await edgeWith({ limits: { ...tight, perIpLimitsApplyToPrivate: true } });
    const statuses: number[] = [];
    opened = 0;
    for (let i = 0; i < 6; i++) {
      const c = connect(strict.url(), '127.0.0.31');
      if ((await c.hello) !== null) opened++;
      else statuses.push(await c.status);
    }
    expect(opened).toBe(2);
    expect(statuses.every((s) => s === 429)).toBe(true);
  });

  it('trustForwardedFor keys the limits on the address the proxy appended', async () => {
    const edge = await edgeWith({ limits: { ...tight, trustForwardedFor: true } });
    const viaProxy = (xff: string) => connect(edge.url(), '127.0.0.32', { 'X-Forwarded-For': xff });
    let opened = 0;
    // the client-supplied leftmost entries change nothing: the proxy's own entry (rightmost) counts
    for (let i = 0; i < 4; i++) if ((await viaProxy(`198.51.100.${i + 1}, 203.0.113.7`).hello) !== null) opened++;
    expect(opened).toBe(2);
    expect(await viaProxy('203.0.113.7').status).toBe(429);
    // another client behind the same proxy is unaffected
    expect(await authenticate(viaProxy('203.0.113.8'), key)).toBe('ok');
    // a private forwarded address is exempt, a malformed one falls back to the (exempt) proxy address
    opened = 0;
    for (let i = 0; i < 4; i++) if ((await viaProxy('10.1.2.3').hello) !== null) opened++;
    for (let i = 0; i < 4; i++) if ((await viaProxy('not-an-ip').hello) !== null) opened++;
    expect(opened).toBe(8);

    // without the option the header is ignored
    const plain = await edgeWith({ limits: tight });
    opened = 0;
    for (let i = 0; i < 4; i++) {
      const c = connect(plain.url(), '127.0.0.33', { 'X-Forwarded-For': '203.0.113.9' });
      if ((await c.hello) !== null) opened++;
    }
    expect(opened).toBe(4);
  });

  it('200 rooms behind one public address come back at once with the default limits', async () => {
    const many = { ...makeKey('fleet'), maxSessions: 200 };
    const edge = await edgeWith({ limits: { perIpLimitsApplyToPrivate: true } }, [many]);
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 200 }, () => authenticate(connect(edge.url(), '127.0.0.34'), many)));
    const elapsed = performance.now() - t0;
    expect(results.filter((r) => r !== 'ok')).toEqual([]);
    expect(elapsed).toBeLessThan(5000);
    expect(edge.stats().sessions).toBe(200);
  });
});

describe('EdgeServer limits validation', () => {
  it('rejects unusable limits when the edge is built, not on the first upgrade', async () => {
    const bad: Record<string, unknown>[] = [
      { ipConnectMsPerToken: 0 },
      { ipConnectCapacity: 0.5 },
      { ipConnectCapacity: Number.NaN },
      { ipConnectMsPerToken: Number.NaN },
      { maxPreAuthPerIp: -1 },
      { maxPreAuthSessions: Number.NaN },
      { maxPreAuthSessions: '8' },
      { maxSessions: -5 },
      { peerOpenMsPerToken: 0 },
      { floodCapacity: 0 },
      { floodMsPerToken: Number.POSITIVE_INFINITY },
    ];
    for (const limits of bad) {
      expect(() => new EdgeServer({ keys: [{ id: key.id, secret: key.secret }], limits: limits as never }), JSON.stringify(limits)).toThrow(RangeError);
    }
    // a disabled bucket does not need a rate
    const off = new EdgeServer({ keys: [{ id: key.id, secret: key.secret }], limits: { ipConnectCapacity: 0, ipConnectMsPerToken: 0 } });
    await off.close();
    await expect(startEdge([key], { limits: { ipConnectMsPerToken: 0 } })).rejects.toThrow(/ipConnectMsPerToken/);
  });
});

describe('EdgeServer pre-auth pool', () => {
  it('a pool full of fresh sockets refuses the newcomer instead of evicting a host mid-handshake', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthSessions: 4, authTimeoutMs: 30_000 } });
    const idle: Conn[] = [];
    for (let i = 0; i < 4; i++) {
      const c = connect(edge.url(), `127.0.2.${i + 1}`);
      expect(await c.hello).not.toBeNull();
      idle.push(c);
    }
    const late = connect(edge.url(), '127.0.2.10');
    expect(await late.status).toBe(503);
    await sleep(50);
    for (const c of idle) expect(c.ws.readyState).toBe(WebSocket.OPEN);
    // a socket in the pool still authenticates
    expect(await authenticate(idle[0]!, key)).toBe('ok');
    expect(edge.stats().sessions).toBe(4);
  });

  it('only a socket that has waited long without authenticating makes room', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthSessions: 2, authTimeoutMs: 30_000 } });
    const old = connect(edge.url(), '127.0.2.20');
    expect(await old.hello).not.toBeNull();
    await sleep(5200);
    const fresh = connect(edge.url(), '127.0.2.21');
    expect(await fresh.hello).not.toBeNull();
    const host = connect(edge.url(), '127.0.2.22');
    expect(await authenticate(host, key)).toBe('ok');
    expect(await old.closed).toBe(EdgeCloseCode.Timeout);
    expect(fresh.ws.readyState).toBe(WebSocket.OPEN);
  }, 15_000);
});

describe('EdgeServer anonymous stats', () => {
  it('marks the aggregate-only view so it cannot be mistaken for an edge without keys', async () => {
    const edge = await edgeWith({});
    const anon = (await (await fetch(`http://${EDGE_IP}:${edge.address.port}/stats`)).json()) as { redacted?: boolean; keys: unknown[] };
    expect(anon.redacted).toBe(true);
    expect(anon.keys).toEqual([]);
    const full = await edgeWith({ statsToken: 'tok-9' });
    const json = (await (
      await fetch(`http://${EDGE_IP}:${full.address.port}/stats`, { headers: { authorization: 'Bearer tok-9' } })
    ).json()) as { redacted?: boolean; keys: unknown[] };
    expect(json.redacted).toBeUndefined();
    expect(json.keys.length).toBe(1);
    expect(edge.stats().redacted).toBeUndefined();
  });
});
