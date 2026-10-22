/**
 * `ws://` edge names accepted as private by their look (single label,
 * `.local`, `.internal`, `.lan`, `.home.arpa`) are held to what they resolve
 * to on every connection: a public address is refused (before any Auth is
 * sent) unless `allowInsecure`, which then turns the WebSocket fallback off.
 */
import { randomBytes } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { Writer } from '../../src/codec/index.js';
import { EdgeError, EdgePeerBackend, type EdgeOptions } from '../../src/net/edge-client.js';
import { EdgeMsg } from '../../src/net/edge-protocol.js';
import { sleep, waitFor, type Any } from '../host/harness.js';

const KEY = `fake:${randomBytes(24).toString('base64url')}`;

function msg(build: (w: Writer) => void): Uint8Array {
  const w = new Writer(256);
  build(w);
  return w.copyBytes();
}

interface FakeEdge {
  port: number;
  connections: number;
  auths: number;
  sockets: WebSocket[];
  close(): Promise<void>;
}

/** Control endpoint on 127.0.0.1 granting the WebSocket data plane to any Auth. */
async function fakeEdge(): Promise<FakeEdge> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const edge: FakeEdge = {
    port: (wss.address() as Any).port,
    connections: 0,
    auths: 0,
    sockets: [],
    close: () => {
      for (const s of edge.sockets) s.terminate();
      return new Promise((r) => wss.close(() => r()));
    },
  };
  wss.on('connection', (ws) => {
    edge.connections++;
    edge.sockets.push(ws);
    ws.send(msg((w) => (w.u8(EdgeMsg.Hello), w.u8(1), w.bytes(randomBytes(32)), w.u8(2))));
    ws.on('message', (d: Buffer) => {
      if (d[0] !== EdgeMsg.Auth) return;
      edge.auths++;
      ws.send(msg((w) => (w.u8(EdgeMsg.AuthOk), w.u32(edge.auths), w.u16(40), w.u8(0))));
    });
    ws.on('error', () => {});
  });
  return edge;
}

type Lookup = (hostname: string, options: LookupOptions, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => void;

/** A resolver answering `next()` for every name (both lookup forms). */
function resolver(next: () => string[]): { lookup: Lookup; names: string[] } {
  const names: string[] = [];
  const lookup: Lookup = (hostname, options, cb) => {
    names.push(hostname);
    const list = next();
    const all = list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    setImmediate(() => (options.all === true ? cb(null, all) : cb(null, all[0]!.address, all[0]!.family)));
  };
  return { lookup, names };
}

const edges: FakeEdge[] = [];
const backends: EdgePeerBackend[] = [];

afterEach(async () => {
  for (const b of backends.splice(0)) b.stop();
  for (const e of edges.splice(0)) await e.close();
});

interface Run {
  backend: EdgePeerBackend;
  errors: Error[];
  readies: number;
  logs: string[];
}

function run(url: string, extra: Partial<EdgeOptions>): Run {
  const r: Run = { backend: null as unknown as EdgePeerBackend, errors: [], readies: 0, logs: [] };
  r.backend = new EdgePeerBackend({
    url,
    key: KEY,
    dataPlane: 'ws',
    reconnectMinMs: 20,
    reconnectMaxMs: 60,
    log: (m) => r.logs.push(m),
    ...extra,
  });
  backends.push(r.backend);
  r.backend.start({
    onReady: () => r.readies++,
    onDown: () => {},
    onError: (e) => r.errors.push(e),
  });
  return r;
}

async function edge(): Promise<FakeEdge> {
  const e = await fakeEdge();
  edges.push(e);
  return e;
}

describe('ws:// private names: resolution checked on connect', () => {
  it('a docker-style name resolving to a private address connects', async () => {
    const e = await edge();
    for (const host of ['edge', 'edge.internal', 'box.home.arpa']) {
      const { lookup, names } = resolver(() => ['127.0.0.1']);
      const r = run(`ws://${host}:${e.port}/tunnel`, { wsOptions: { lookup } as never });
      await waitFor(() => r.readies === 1, 3000, 'tunnel ready');
      expect(names).toContain(host);
      expect(r.errors).toEqual([]);
      expect(r.backend.fallbackWs).toBe(true);
      r.backend.stop();
    }
  });

  it('a name resolving to a public address is refused before connecting, without allowInsecure', async () => {
    const e = await edge();
    for (const answer of [['203.0.113.9'], ['::ffff:198.51.100.20'], ['127.0.0.1', '198.51.100.20'], ['2001:db8::1']]) {
      const { lookup } = resolver(() => answer);
      const r = run(`ws://edge.lan:${e.port}/tunnel`, { wsOptions: { lookup } as never });
      await waitFor(() => r.errors.length > 0, 3000, 'refusal');
      const err = r.errors[0] as EdgeError;
      expect(err).toBeInstanceOf(EdgeError);
      expect(err.fatal).toBe(true);
      expect(err.message).toMatch(/edge\.lan resolved to a public address/);
      expect(err.message).toMatch(/allowInsecure: true/);
      expect(r.readies).toBe(0);
      r.backend.stop();
    }
    expect(e.connections).toBe(0);
    expect(e.auths).toBe(0);
  });

  it('the policy applies to every reconnection, not only the first one', async () => {
    const e = await edge();
    const answers = [['127.0.0.1'], ['203.0.113.9'], ['127.0.0.1']];
    let i = 0;
    const { lookup } = resolver(() => answers[Math.min(i++, answers.length - 1)]!);
    const r = run(`ws://edge:${e.port}/tunnel`, { wsOptions: { lookup } as never });
    await waitFor(() => r.readies === 1, 3000, 'tunnel ready');
    // the edge drops the tunnel: the next connection resolves elsewhere
    for (const s of e.sockets) s.terminate();
    await waitFor(() => r.errors.some((x) => /resolved to a public address/.test(x.message)), 3000, 'refusal');
    expect(e.auths).toBe(1);
    await waitFor(() => r.readies === 2, 3000, 'tunnel ready');
    expect(e.auths).toBe(2);
  });

  it('allowInsecure accepts a public resolution with a warning and the WebSocket fallback off by default', async () => {
    const { lookup } = resolver(() => ['203.0.113.9']);
    const r = run('ws://edge.internal:9/tunnel', { allowInsecure: true, connectTimeoutMs: 300, wsOptions: { lookup } as never });
    expect(r.backend.fallbackWs).toBe(true);
    await waitFor(() => r.logs.some((l) => /resolved to a public address \(203\.0\.113\.9\)/.test(l)), 3000, 'public resolution warning');
    expect(r.backend.fallbackWs).toBe(false);
    expect(r.backend.fallbackWsHint).toMatch(/fallbackWs: true/);
    expect(r.errors.some((x) => /resolved to a public address/.test(x.message))).toBe(false);
    const explicit = run('ws://edge.internal:9/tunnel', { allowInsecure: true, fallbackWs: true, connectTimeoutMs: 300, wsOptions: { lookup } as never });
    await sleep(50);
    expect(explicit.backend.fallbackWs).toBe(true);
  });

  it('the peer actually reached is checked too, before the Auth', async () => {
    const e = await edge();
    const r = run(`ws://edge:${e.port}/tunnel`, {
      wsOptions: {
        // a connection the name lookup does not govern (an agent, another runtime): its peer is public
        createConnection: () => {
          const s = tcpConnect({ host: '127.0.0.1', port: e.port });
          Object.defineProperty(s, 'remoteAddress', { get: () => '198.51.100.20' });
          return s;
        },
      },
    });
    await waitFor(() => r.errors.length > 0, 3000, 'refusal');
    expect(r.errors[0]!.message).toMatch(/resolved to a public address \(198\.51\.100\.20\)/);
    await sleep(100);
    expect(e.auths).toBe(0);
    expect(r.readies).toBe(0);
  });

  it('only names are checked: IP literals, localhost and wss:// keep their policy', () => {
    const make = (url: string) => new EdgePeerBackend({ url, key: KEY, log: () => {} });
    expect(make('ws://edge:8443/t').checkResolved).toBe(true);
    expect(make('ws://edge.local/t').checkResolved).toBe(true);
    expect(make('ws://10.0.0.5/t').checkResolved).toBe(false);
    expect(make('ws://[fd00::1]/t').checkResolved).toBe(false);
    expect(make('ws://127.0.0.1/t').checkResolved).toBe(false);
    expect(make('ws://localhost/t').checkResolved).toBe(false);
    expect(make('wss://edge/t').checkResolved).toBe(false);
  });

  it('classifies the resolved address', () => {
    const b = new EdgePeerBackend({ url: 'ws://edge/t', key: KEY, log: () => {} });
    for (const a of ['203.0.113.9', '::ffff:203.0.113.9', '2001:db8::1', '0.0.0.0', '8.8.8.8']) expect(b.resolvedCheck(a), a).toBeInstanceOf(EdgeError);
    for (const a of ['10.0.0.5', '::ffff:10.0.0.5', 'fe80::1%eth0', '127.0.0.1', '::1', '172.18.0.3', '100.64.1.2', 'fd12::3']) {
      expect(b.resolvedCheck(a), a).toBeNull();
    }
  });
});
