/**
 * haxlite Edge control listener hardening: per-address limits on
 * unauthenticated tunnel sockets, the anonymous view of the stats endpoint,
 * clean failure of a partial start, log hygiene and timer bounds.
 */
import { createSocket, type Socket } from 'node:dgram';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import { EdgeServer, loadEdgeConfig, type EdgeServerOptions } from '../../src/edge/index.js';
import { EdgeCloseCode, EdgeMsg, edgeAuthMac } from '../../src/net/index.js';
import { EDGE_IP, makeKey, startEdge, type TestKey } from './harness.js';

const key = makeKey('alice');
const edges: EdgeServer[] = [];
const sockets: WebSocket[] = [];

async function edgeWith(options: Partial<EdgeServerOptions>, keys: TestKey[] = [key]): Promise<EdgeServer> {
  const e = await startEdge(keys, options);
  edges.push(e);
  return e;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const e of edges.splice(0)) await e.close();
});

interface Conn {
  ws: WebSocket;
  /** Resolves with the Hello nonce, or null if the socket never opened. */
  hello: Promise<Uint8Array | null>;
  closed: Promise<number>;
}

function connect(url: string, localAddress: string): Conn {
  const ws = new WebSocket(url, { localAddress });
  ws.binaryType = 'nodebuffer';
  ws.on('error', () => {});
  sockets.push(ws);
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
  return { ws, hello, closed };
}

/** Authenticates (protocol 1, WebSocket data plane); resolves with the AuthOk/close outcome. */
async function authenticate(c: Conn, k: TestKey, keyId = k.id): Promise<'ok' | number> {
  const nonce = await c.hello;
  if (nonce === null) return c.closed;
  const w = new Writer(256);
  w.u8(EdgeMsg.Auth);
  w.u8(1);
  w.string(keyId);
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

describe('EdgeServer control listener limits', () => {
  it('anonymous sockets from one address cannot take the slots of authenticated hosts', async () => {
    // loopback stands in for a public address here
    const edge = await edgeWith({ limits: { maxSessions: 20, maxPreAuthPerIp: 32, perIpLimitsApplyToPrivate: true } });
    const url = edge.url();
    let opened = 0;
    for (let i = 0; i < 60; i++) {
      const c = connect(url, '127.0.0.1');
      if ((await c.hello) !== null) opened++;
    }
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThanOrEqual(32);
    // a host on another address still gets in
    expect(await authenticate(connect(url, '127.0.0.3'), key)).toBe('ok');
  });

  it('new upgrades per address are rate limited', async () => {
    const edge = await edgeWith({ limits: { ipConnectCapacity: 5, ipConnectMsPerToken: 60_000, perIpLimitsApplyToPrivate: true } });
    let opened = 0;
    for (let i = 0; i < 10; i++) {
      const c = connect(edge.url(), '127.0.0.4');
      if ((await c.hello) !== null) opened++;
      c.ws.terminate();
      await c.closed;
    }
    expect(opened).toBe(5);
    // other addresses are not affected
    expect(await connect(edge.url(), '127.0.0.5').hello).not.toBeNull();
  });

  it('a full pre-auth pool of fresh sockets refuses the newcomer, then admits it once a slot frees', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthSessions: 4 } });
    const idle: Conn[] = [];
    for (let i = 0; i < 4; i++) {
      const c = connect(edge.url(), `127.0.1.${i + 1}`);
      expect(await c.hello).not.toBeNull();
      idle.push(c);
    }
    expect(await connect(edge.url(), '127.0.1.5').hello).toBeNull();
    expect(await connect(edge.url(), '127.0.1.6').hello).toBeNull();
    await sleep(50);
    expect(edge.stats().sessions).toBe(4);
    for (const c of idle) expect(c.ws.readyState).toBe(WebSocket.OPEN);
    // one authenticates (leaves the pool): a new host gets in
    expect(await authenticate(idle[0]!, key)).toBe('ok');
    expect(await authenticate(connect(edge.url(), '127.0.1.10'), key)).toBe('ok');
  });

  it('several rooms behind one address authenticate; maxSessions counts authenticated tunnels', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthPerIp: 1, maxSessions: 3 } });
    for (let i = 0; i < 3; i++) expect(await authenticate(connect(edge.url(), '127.0.0.6'), key)).toBe('ok');
    expect(await authenticate(connect(edge.url(), '127.0.0.6'), key)).toBe(EdgeCloseCode.Quota);
    expect(edge.stats().sessions).toBe(3);
  });
});

describe('EdgeServer stats endpoint', () => {
  it('without a token serves aggregates only; with one, the full stats', async () => {
    const labelled = { ...makeKey('tenant-x'), label: 'Secret Customer Ltd' };
    const edge = await startEdge([labelled], {});
    edges.push(edge);
    const url = `http://${EDGE_IP}:${edge.address.port}/stats`;
    expect(await authenticate(connect(edge.url(), '127.0.0.3'), labelled)).toBe('ok');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('tenant-x');
    const json = JSON.parse(text);
    expect(json.sessions).toBe(1);
    expect(json.keys).toEqual([]);
    expect(json.tunnel).toBeNull();
    expect(json.rtc).toBeNull();

    const withToken = await startEdge([labelled], { statsToken: 'tok-123' });
    edges.push(withToken);
    const url2 = `http://${EDGE_IP}:${withToken.address.port}/stats`;
    expect((await fetch(url2)).status).toBe(401);
    const full = (await (await fetch(url2, { headers: { authorization: 'Bearer tok-123' } })).json()) as { keys: { id: string }[]; tunnel: unknown };
    expect(full.keys.map((k) => k.id)).toEqual(['tenant-x']);
    expect(full.tunnel).not.toBeNull();
  });
});

describe('EdgeServer lifecycle and logs', () => {
  it('a failed start releases the control listener', async () => {
    const busy: Socket = createSocket('udp4');
    await new Promise<void>((r) => busy.bind(0, EDGE_IP, () => r()));
    const tcpServers = () => process.getActiveResourcesInfo().filter((n) => n === 'TCPServerWrap').length;
    try {
      await sleep(50);
      const before = tcpServers();
      await expect(startEdge([key], { tunnel: { port: busy.address().port } })).rejects.toThrow(/EADDRINUSE/);
      await sleep(50); // handle close is asynchronous
      expect(tcpServers()).toBe(before);
      // a caller-owned server gets its listeners back
      const own = createServer();
      await expect(startEdge([key], { server: own, tunnel: { port: busy.address().port, bindAddress: EDGE_IP } })).rejects.toThrow(/EADDRINUSE/);
      expect(own.listenerCount('upgrade')).toBe(0);
      expect(own.listenerCount('request')).toBe(0);
    } finally {
      busy.close();
    }
  });

  it('remote key ids are logged without control characters', async () => {
    const lines: string[] = [];
    const edge = await edgeWith({ log: (m) => lines.push(m) });
    const c = connect(edge.url(), '127.0.0.7');
    expect(await authenticate(c, key, '")\n1.2.3.4 ROOT LOGIN OK \u001b[2J')).toBe(EdgeCloseCode.AuthFailed);
    const line = lines.find((l) => l.includes('authentication failed'))!;
    expect(line).toBeDefined();
    expect(/[\u0000-\u001f\u007f]/.test(line)).toBe(false);
    expect(line).toContain('\\n1.2.3.4 ROOT LOGIN OK \\x1b[2J');
  });

  it('timer periods beyond the 32-bit setTimeout range are bounded', async () => {
    const lines: string[] = [];
    const edge = await edgeWith({ statsLogIntervalMs: 3e9, limits: { authTimeoutMs: 3e9, keepAliveMs: 3e9 }, log: (m) => lines.push(m) });
    const c = connect(edge.url(), '127.0.0.8');
    expect(await c.hello).not.toBeNull();
    await sleep(150);
    expect(lines.filter((l) => l.startsWith('stats ')).length).toBe(0);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    const env = { HAXLITE_EDGE_KEYS: 'h1:0123456789abcdef0123' };
    expect(() => loadEdgeConfig([], { ...env, HAXLITE_EDGE_LOG_INTERVAL_MS: '2592000000' })).toThrow(/log interval/);
    expect(() => loadEdgeConfig([], { ...env, HAXLITE_EDGE_LOG_INTERVAL_MS: 'soon' })).toThrow(/log interval/);
    expect(loadEdgeConfig([], { ...env, HAXLITE_EDGE_LOG_INTERVAL_MS: '0' }).statsLogIntervalMs).toBe(0);
  });
});
