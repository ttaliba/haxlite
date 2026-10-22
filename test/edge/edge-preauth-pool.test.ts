/**
 * haxlite Edge pre-auth pool with the default auth timeout: a full pool admits
 * a newcomer by closing a socket of the source holding the most slots, so a
 * single source renewing idle sockets cannot keep hosts from other sources
 * out, nor push out a host mid-handshake.
 */
import { connect as tcpConnect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import type { EdgeServer, EdgeServerOptions } from '../../src/edge/index.js';
import { EdgeCloseCode, EdgeMsg, edgeAuthMac } from '../../src/net/index.js';
import { EDGE_IP, makeKey, startEdge } from './harness.js';

const key = makeKey('alice');
const edges: EdgeServer[] = [];
const sockets: WebSocket[] = [];
const raws: Socket[] = [];
let stopAttack = (): void => {};

afterEach(async () => {
  stopAttack();
  for (const s of raws.splice(0)) s.destroy();
  for (const s of sockets.splice(0)) s.terminate();
  for (const e of edges.splice(0)) await e.close();
});

async function edgeWith(options: Partial<EdgeServerOptions>): Promise<EdgeServer> {
  const e = await startEdge([{ ...key, maxSessions: 100 }], options);
  edges.push(e);
  return e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Conn {
  ws: WebSocket;
  hello: Promise<Uint8Array | null>;
  closed: Promise<number>;
  status: Promise<number>;
}

function connect(url: string, localAddress: string): Conn {
  const ws = new WebSocket(url, { localAddress });
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

async function authenticate(c: Conn): Promise<'ok' | number> {
  const nonce = await c.hello;
  if (nonce === null) return c.status.then((s) => (s !== 0 ? s : c.closed));
  const w = new Writer(256);
  w.u8(EdgeMsg.Auth);
  w.u8(1);
  w.string(key.id);
  w.bytes(edgeAuthMac(key.secret, nonce));
  w.u8(0);
  c.ws.send(w.copyBytes());
  return new Promise((resolve) => {
    c.ws.on('message', (d: Buffer) => {
      if (d[0] === EdgeMsg.AuthOk) resolve('ok');
    });
    void c.closed.then(resolve);
  });
}

/**
 * Idle sockets that never authenticate, each re-opened as soon as the edge
 * closes or refuses it (raw upgrades: nothing but the handshake).
 */
function attack(port: number, localAddress: string, slots: number): { opened: () => number } {
  let stop = false;
  let opened = 0;
  const req =
    `GET /tunnel HTTP/1.1\r\nHost: ${EDGE_IP}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';
  const one = (): void => {
    if (stop) return;
    const s = tcpConnect({ host: EDGE_IP, port, localAddress }, () => s.write(req));
    raws.push(s);
    let first = true;
    let ok = false;
    s.on('error', () => {});
    s.on('data', (d: Buffer) => {
      if (first) {
        first = false;
        ok = d.toString('latin1').startsWith('HTTP/1.1 101');
        if (ok) opened++;
      } else if ((d[0]! & 0x0f) === 0x8) s.destroy();
    });
    s.on('close', () => {
      const i = raws.indexOf(s);
      if (i >= 0) raws.splice(i, 1);
      setTimeout(one, ok ? 0 : 15);
    });
  };
  for (let i = 0; i < slots; i++) one();
  stopAttack = () => {
    stop = true;
  };
  return { opened: () => opened };
}

describe('EdgeServer pre-auth pool fairness (default auth timeout)', () => {
  it('a host gets in at once while one source keeps the pool full of renewed idle sockets', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthSessions: 64 } });
    const attacker = attack(edge.address.port, '127.0.3.1', 80);
    await sleep(500);
    const before = attacker.opened();
    expect(before).toBeGreaterThanOrEqual(64);
    const t0 = performance.now();
    let firstOk = Number.POSITIVE_INFINITY;
    const results: ('ok' | number)[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await authenticate(connect(edge.url(), '127.0.9.9'));
      results.push(r);
      if (r === 'ok' && firstOk === Number.POSITIVE_INFINITY) firstOk = performance.now() - t0;
      await sleep(300);
    }
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(firstOk).toBeLessThan(2000);
    // the attacker kept renewing its sockets all along
    expect(attacker.opened() - before).toBeGreaterThan(16);
  }, 20_000);

  it('a host mid-handshake is not pushed out by a single source, even past the grace wait', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthSessions: 4 } });
    const host = connect(edge.url(), '127.0.4.1');
    expect(await host.hello).not.toBeNull();
    const flood: Conn[] = [];
    for (let i = 0; i < 12; i++) {
      const c = connect(edge.url(), '127.0.4.2');
      flood.push(c);
      expect(await c.hello).not.toBeNull();
    }
    await sleep(1200);
    for (let i = 0; i < 6; i++) {
      const c = connect(edge.url(), '127.0.4.2');
      flood.push(c);
      expect(await c.hello).not.toBeNull();
    }
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    expect(await authenticate(host)).toBe('ok');
    // the source replaced its own oldest sockets
    expect(await flood[0]!.closed).toBe(EdgeCloseCode.Timeout);
    for (const c of flood.slice(-3)) expect(c.ws.readyState).toBe(WebSocket.OPEN);
  }, 15_000);

  it('a newcomer from the source holding the most slots replaces its own oldest socket', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthSessions: 3 } });
    const other = connect(edge.url(), '127.0.4.10');
    expect(await other.hello).not.toBeNull();
    const mine: Conn[] = [];
    for (let i = 0; i < 2; i++) {
      const c = connect(edge.url(), '127.0.4.11');
      mine.push(c);
      expect(await c.hello).not.toBeNull();
    }
    const late = connect(edge.url(), '127.0.4.11');
    expect(await late.hello).not.toBeNull();
    expect(await mine[0]!.closed).toBe(EdgeCloseCode.Timeout);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
    expect(mine[1]!.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('when every source holds one slot, the oldest makes room once it has waited 1 s (auth timeout 5 s)', async () => {
    const edge = await edgeWith({ limits: { maxPreAuthSessions: 3 } });
    const held: Conn[] = [];
    for (let i = 0; i < 3; i++) {
      const c = connect(edge.url(), `127.0.4.${20 + i}`);
      held.push(c);
      expect(await c.hello).not.toBeNull();
    }
    expect(await connect(edge.url(), '127.0.4.30').status).toBe(503);
    await sleep(1100);
    const host = connect(edge.url(), '127.0.4.31');
    expect(await authenticate(host)).toBe('ok');
    expect(await held[0]!.closed).toBe(EdgeCloseCode.Timeout);
    expect(held[1]!.ws.readyState).toBe(WebSocket.OPEN);
    expect(held[2]!.ws.readyState).toBe(WebSocket.OPEN);
  });
});
