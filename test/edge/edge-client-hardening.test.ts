/**
 * Host side of the Edge tunnel against hostile or broken control endpoints
 * (fake edges on loopback, src/net/edge-client.ts):
 *  - `ws://` is only accepted for loopback unless `allowInsecure`;
 *  - a tunnel that reaches Ready and drops at once is retried with backoff;
 *  - the WebSocket data plane has a bounded send queue (hard limit tears the
 *    tunnel down, unreliable frames are shed first) and the edge must answer
 *    our pings;
 *  - strings and counts coming from the edge are bounded / validated.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import { EdgeError, EdgePeerBackend, type EdgeOptions } from '../../src/net/edge-client.js';
import { EdgeMsg } from '../../src/net/edge-protocol.js';
import type { PeerLinkEvents } from '../../src/net/peer-backend.js';
import { sleep, waitFor, type Any } from '../host/harness.js';

const KEY = `fake:${randomBytes(24).toString('base64url')}`;

function msg(build: (w: Writer) => void): Uint8Array {
  const w = new Writer(256);
  build(w);
  return w.copyBytes();
}

interface FakeEdge {
  url: string;
  /** Control connections accepted so far (arrival time, `performance.now()`). */
  arrivals: number[];
  sockets: WebSocket[];
  close(): Promise<void>;
}

interface FakeEdgeScript {
  /** Protocol of the Hello: 2 (carries maxVersion) or 1 (legacy). Default 2. */
  hello?: 1 | 2;
  /** The host's Auth arrived. Default: grant nothing (WebSocket data plane). */
  onAuth?(ws: WebSocket, conn: number): void;
  onMessage?(ws: WebSocket, data: Buffer, conn: number): void;
}

const authOk = (): Uint8Array => msg((w) => (w.u8(EdgeMsg.AuthOk), w.u32(1), w.u16(40), w.u8(0)));
const ping = (): Uint8Array => msg((w) => (w.u8(EdgeMsg.Ping), w.f64(0)));

/** A control endpoint on loopback that does not know the key (the host never gets a MAC to check without Udp). */
async function fakeEdge(script: FakeEdgeScript = {}): Promise<FakeEdge> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const edge: FakeEdge = {
    url: '',
    arrivals: [],
    sockets: [],
    close: () => {
      for (const s of edge.sockets) s.terminate();
      return new Promise((r) => wss.close(() => r()));
    },
  };
  wss.on('connection', (ws) => {
    const conn = edge.arrivals.length;
    edge.arrivals.push(performance.now());
    edge.sockets.push(ws);
    ws.send(msg((w) => (w.u8(EdgeMsg.Hello), w.u8(1), w.bytes(randomBytes(32)), script.hello === 1 ? undefined : w.u8(2))));
    let authed = false;
    ws.on('message', (d: Buffer) => {
      if (d[0] === EdgeMsg.Auth && !authed) {
        authed = true;
        if (script.onAuth !== undefined) script.onAuth(ws, conn);
        else ws.send(authOk());
        return;
      }
      script.onMessage?.(ws, d, conn);
    });
    ws.on('error', () => {});
  });
  edge.url = `ws://127.0.0.1:${(wss.address() as Any).port}/tunnel`;
  return edge;
}

const noop = (): void => {};
function linkEvents(over: Partial<PeerLinkEvents> = {}): PeerLinkEvents {
  return {
    onLocalDescription: noop,
    onLocalCandidate: noop,
    onGatheringComplete: noop,
    onChannelOpen: noop,
    onChannelClosed: noop,
    onMessage: noop,
    onConnectionState: noop,
    onAbuse: noop,
    onError: noop,
    ...over,
  } as PeerLinkEvents;
}

interface Run {
  backend: EdgePeerBackend;
  ready: number;
  down: number;
  errors: EdgeError[];
  logs: string[];
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** Starts a backend against `edge` on the WebSocket data plane (unless overridden). */
function run(edge: FakeEdge, extra: Partial<EdgeOptions> = {}): Run {
  const logs: string[] = [];
  const backend = new EdgePeerBackend({ url: edge.url, key: KEY, dataPlane: 'ws', log: (m) => logs.push(m), ...extra });
  const st: Run = { backend, ready: 0, down: 0, errors: [], logs };
  cleanup.push(() => backend.stop());
  backend.start({ onReady: () => st.ready++, onDown: () => st.down++, onError: (e) => st.errors.push(e as EdgeError) });
  return st;
}

async function withEdge(script: FakeEdgeScript = {}): Promise<FakeEdge> {
  const edge = await fakeEdge(script);
  cleanup.push(() => edge.close());
  return edge;
}

/** The live TunnelSession's WebSocket (white box: queued bytes). */
const sessionWs = (b: EdgePeerBackend): WebSocket => (b as Any).session.ws as WebSocket;

// ------------------------------------------------------------------ url policy

describe('edge url policy', () => {
  const make = (url: string, extra: Partial<EdgeOptions> = {}) => new EdgePeerBackend({ url, key: KEY, ...extra });

  it('ws:// is only accepted for a loopback host', () => {
    for (const url of ['ws://127.0.0.1:8443/tunnel', 'ws://127.0.0.2:1/t', 'ws://localhost/t', 'ws://[::1]:9/t', 'ws://[::ffff:127.0.0.1]/t', 'WS://LOCALHOST/t']) {
      expect(() => make(url), url).not.toThrow();
    }
    for (const url of [
      'ws://203.0.113.9:8443/tunnel',
      'ws://192.168.1.10/t',
      'ws://10.0.0.1/t',
      'ws://0.0.0.0/t',
      'ws://edge.example.com/t',
      'ws://127.0.0.1.example.com/t',
      'ws://localhost.example.com/t',
      'ws://[2001:db8::1]/t',
      'ws://[::ffff:192.0.2.1]/t',
    ]) {
      expect(() => make(url), url).toThrow(/loopback/);
    }
  });

  it('wss:// is accepted for any host, other schemes are refused', () => {
    expect(() => make('wss://203.0.113.9:8443/tunnel')).not.toThrow();
    expect(() => make('wss://edge.example.com/tunnel')).not.toThrow();
    expect(() => make('http://127.0.0.1/t')).toThrow(/ws:\/\/ or wss:\/\//);
  });

  it('allowInsecure accepts a non-loopback ws:// url with a warning; WebSocket fallback then defaults to off', () => {
    const logs: string[] = [];
    const b = make('ws://203.0.113.9:8443/tunnel', { allowInsecure: true, log: (m) => logs.push(m) });
    expect(logs.some((l) => /without TLS/.test(l))).toBe(true);
    expect(b.fallbackWs).toBe(false);
    expect(make('ws://203.0.113.9/t', { allowInsecure: true, fallbackWs: true }).fallbackWs).toBe(true);
    // unchanged defaults: loopback ws:// and wss://
    expect(make('ws://127.0.0.1/t').fallbackWs).toBe(true);
    expect(make('wss://edge.example.com/t').fallbackWs).toBe(true);
    expect(make('wss://edge.example.com/t', { fallbackWs: false }).fallbackWs).toBe(false);
  });

  it('warns about a short secret on an insecure url and about disabled certificate verification', () => {
    const logs: string[] = [];
    make('ws://203.0.113.9/t', { key: 'k:short', allowInsecure: true, log: (m) => logs.push(m) });
    expect(logs.some((l) => /short edge key secret/.test(l))).toBe(true);
    const tls: string[] = [];
    make('wss://edge.example.com/t', { wsOptions: { rejectUnauthorized: false }, log: (m) => tls.push(m) });
    expect(tls.some((l) => /certificate verification is off/.test(l))).toBe(true);
    const quiet: string[] = [];
    make('wss://edge.example.com/t', { log: (m) => quiet.push(m) });
    expect(quiet).toEqual([]);
  });
});

// ------------------------------------------------------------------ reconnect

describe('reconnect after Ready', () => {
  it('an edge that reaches Ready and drops at once is retried with backoff, not in a loop', async () => {
    const edge = await withEdge({
      onAuth: (ws) => {
        ws.send(authOk());
        setImmediate(() => ws.close(1011, 'bye'));
      },
    });
    const st = run(edge, { reconnectMinMs: 100, reconnectMaxMs: 400 });
    await sleep(1500);
    // 100 ms, 200 ms, then 400 ms apart (±20 %): about six connections in 1.5 s
    expect(edge.arrivals.length).toBeGreaterThanOrEqual(2);
    expect(edge.arrivals.length).toBeLessThanOrEqual(9);
    expect(st.ready).toBeLessThanOrEqual(edge.arrivals.length);
    expect(st.errors.length).toBeLessThanOrEqual(edge.arrivals.length);
  });

  it('a short-lived session keeps the backoff growing; a stable one reconnects at once', async () => {
    const gaps = async (stableMs: number): Promise<number> => {
      const edge = await withEdge({
        onAuth: (ws) => {
          ws.send(authOk());
          setTimeout(() => ws.close(1011, 'bye'), 150);
        },
      });
      run(edge, { reconnectMinMs: 1500, reconnectStableMs: stableMs });
      await waitFor(() => edge.arrivals.length >= 2, 8000, 'second connection');
      return edge.arrivals[1]! - edge.arrivals[0]! - 150;
    };
    // lived 150 ms < 60 s: waits reconnectMinMs ± 20 % after the close
    expect(await gaps(60_000)).toBeGreaterThan(1000);
    // lived 150 ms >= 50 ms: first retry at once
    expect(await gaps(50)).toBeLessThan(900);
  });

  it('a failure before Ready still backs off (unchanged)', async () => {
    const edge = await withEdge({ onAuth: (ws) => ws.close(1011, 'bye') });
    run(edge, { reconnectMinMs: 100, reconnectMaxMs: 400 });
    await sleep(1000);
    expect(edge.arrivals.length).toBeGreaterThanOrEqual(2);
    expect(edge.arrivals.length).toBeLessThanOrEqual(6);
  });
});

// ------------------------------------------------------------------ ws data plane flow control

describe('WebSocket data plane flow control', () => {
  /** An edge that stops reading right after AuthOk (TCP window closes) but keeps pinging. */
  const stalledEdge = (): Promise<FakeEdge> =>
    withEdge({
      onAuth: (ws) => {
        ws.send(authOk());
        (ws as Any)._socket.pause();
        const t = setInterval(() => {
          try {
            ws.send(ping());
          } catch {
            /* closed */
          }
        }, 50);
        ws.once('close', () => clearInterval(t));
      },
    });

  it('an edge that stops reading tears the tunnel down once the queue passes the hard limit', async () => {
    const edge = await stalledEdge();
    const st = run(edge, { reconnectMinMs: 60_000, pingIntervalMs: 1000, pingTimeoutMs: 60_000 });
    await waitFor(() => st.ready === 1, 5000, 'ready');
    const states: string[] = [];
    const link = st.backend.createPeer(1, 'v=0\r\n', linkEvents({ onConnectionState: (s) => states.push(s) }));
    const ws = sessionWs(st.backend);
    const frame = new Uint8Array(64 * 1024);
    let sent = 0;
    let refused = false;
    // 64 MiB offered: the kernel takes a few MiB, the rest queues in the process
    for (let i = 0; i < 1024; i++) {
      if (!link.send(0, frame)) {
        refused = true;
        break;
      }
      sent++;
    }
    expect(refused).toBe(true);
    expect(ws.bufferedAmount).toBeLessThan(8 * 1024 * 1024 + 2 * frame.length);
    expect(sent * frame.length).toBeLessThan(40 * 1024 * 1024);
    // failing is deferred: nothing was torn down inside the sending loop
    expect(states).toEqual([]);
    expect(link.send(0, frame)).toBe(false);
    await waitFor(() => st.errors.length > 0, 2000, 'overflow error');
    expect(st.errors[0]!.kind).toBe('tunnel');
    expect(st.errors[0]!.message).toMatch(/send buffer overflow/);
    expect(states).toEqual(['closed']);
    expect(st.backend.state).toBe('reconnecting');
    expect(st.down).toBe(1);
  });

  it('above the soft limit unreliable frames are shed, reliable ones are queued', async () => {
    const edge = await stalledEdge();
    const st = run(edge, { pingIntervalMs: 1000, pingTimeoutMs: 60_000 });
    await waitFor(() => st.ready === 1, 5000, 'ready');
    const link = st.backend.createPeer(1, 'v=0\r\n', linkEvents());
    const ws = sessionWs(st.backend);
    const small = new Uint8Array(100);
    expect(link.send(2, small)).toBe(true); // idle: everything goes out
    const frame = new Uint8Array(64 * 1024);
    for (let i = 0; i < 1024 && ws.bufferedAmount <= 300 * 1024; i++) link.send(0, frame);
    expect(ws.bufferedAmount).toBeGreaterThan(300 * 1024);
    const queued = ws.bufferedAmount;
    expect(link.send(2, small)).toBe(false);
    st.backend.sendMany([link], 2, small);
    expect(ws.bufferedAmount).toBe(queued);
    expect(link.send(1, small)).toBe(true);
    expect(link.send(0, small)).toBe(true);
    st.backend.sendMany([link], 1, small);
    expect(ws.bufferedAmount).toBeGreaterThan(queued);
    expect(st.errors).toEqual([]);
  });

  /** Edge that pings the host all the time; `answer` decides whether it answers the host's pings. */
  const pingingEdge = (answer: boolean, hello: 1 | 2 = 2): Promise<FakeEdge> =>
    withEdge({
      hello,
      onAuth: (ws) => {
        ws.send(authOk());
        const t = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(ping()), 30);
        ws.once('close', () => clearInterval(t));
      },
      onMessage: (ws, d) => {
        if (!answer || d[0] !== EdgeMsg.Ping) return;
        const r = new Reader(d);
        r.u8();
        const t = r.f64();
        ws.send(msg((w) => (w.u8(EdgeMsg.Pong), w.f64(t))));
      },
    });
  const fast = { pingIntervalMs: 50, pingTimeoutMs: 600, reconnectMinMs: 60_000 };

  it('an edge that pings but never answers our pings is dropped as dead', async () => {
    const edge = await pingingEdge(false);
    const st = run(edge, fast);
    await waitFor(() => st.errors.length > 0, 5000, 'timeout');
    expect(st.errors[0]!.kind).toBe('tunnel');
    expect(st.errors[0]!.message).toMatch(/does not answer pings/);
    expect(st.down).toBe(1);
  });

  it('an edge that answers keeps the tunnel up well past the timeout', async () => {
    const edge = await pingingEdge(true);
    const st = run(edge, fast);
    await waitFor(() => st.ready === 1, 3000, 'ready');
    await sleep(1500);
    expect(st.backend.state).toBe('ready');
    expect(st.errors).toEqual([]);
    expect(st.backend.stats().rttMs).not.toBeNull();
  });

  it('a protocol-1 edge is not required to answer pings', async () => {
    const edge = await pingingEdge(false, 1);
    const st = run(edge, fast);
    await waitFor(() => st.ready === 1, 3000, 'ready');
    await sleep(1500);
    expect(st.backend.state).toBe('ready');
    expect(st.errors).toEqual([]);
  });
});

// ------------------------------------------------------------------ what the edge tells us

describe('edge-supplied data', () => {
  /** A ready WebSocket-plane tunnel with one link, plus the edge's socket. */
  async function ready(events: Partial<PeerLinkEvents> = {}, extra: Partial<EdgeOptions> = {}) {
    const edge = await withEdge();
    const st = run(edge, extra);
    await waitFor(() => st.ready === 1, 5000, 'ready');
    const link = st.backend.createPeer(1, 'v=0\r\n', linkEvents(events));
    return { edge, st, link, ws: edge.sockets[0]! };
  }

  it('remoteAddress must be an IP address', async () => {
    const seen: (string | null)[] = [];
    const { ws, st } = await ready({ onChannelOpen: (_ch, addr) => void seen.push(addr) });
    const open = (addr: string) => ws.send(msg((w) => (w.u8(EdgeMsg.PeerChannelOpen), w.u16(1), w.u8(0), w.string(addr))));
    for (const addr of ['203.0.113.7', '2001:db8::1', 'fe80::1%eth0', '', '\u001b[31m10.0.0.1"; DROP\n[admin] 1.2.3.4', 'host.local', '10.0.0.1 ']) open(addr);
    await waitFor(() => seen.length === 7, 3000, 'channel opens');
    expect(seen).toEqual(['203.0.113.7', '2001:db8::1', 'fe80::1%eth0', null, null, null, null]);
    expect(st.errors).toEqual([]);
  });

  it('edge error texts and close reasons are printable and bounded in logs and errors', async () => {
    const { ws, st } = await ready();
    ws.send(msg((w) => (w.u8(EdgeMsg.Error), w.u16(500), w.string(`\u001b[2J fake log line\n[host] ok${'x'.repeat(900)}`))));
    await waitFor(() => st.logs.some((l) => l.startsWith('edge error 500')), 3000, 'edge error log');
    const line = st.logs.find((l) => l.startsWith('edge error 500'))!;
    expect(line).not.toMatch(/[^\x20-\x7e]/);
    expect(line.length).toBeLessThan(260);
    ws.close(4000, '\u001b[31mred\u0007\nline2');
    await waitFor(() => st.errors.length > 0, 3000, 'close error');
    expect(st.errors[0]!.message).not.toMatch(/[^\x20-\x7e]/);
    expect(st.errors[0]!.message).toContain('4000');
  });

  it('answer, gathering-complete and relayed candidates are bounded per link', async () => {
    let answers = 0;
    let cands = 0;
    let gathered = 0;
    const { ws, st } = await ready({
      onLocalDescription: () => void answers++,
      onLocalCandidate: () => void cands++,
      onGatheringComplete: () => void gathered++,
    });
    for (let i = 0; i < 2; i++) ws.send(msg((w) => (w.u8(EdgeMsg.PeerAnswer), w.u16(1), w.string('v=0\r\n'))));
    for (let i = 0; i < 200; i++) ws.send(msg((w) => (w.u8(EdgeMsg.PeerLocalCandidate), w.u16(1), w.string(`candidate:${i} 1 udp 1 203.0.113.7 ${5000 + i} typ host`), w.string('0'))));
    for (let i = 0; i < 2; i++) ws.send(msg((w) => (w.u8(EdgeMsg.PeerGathered), w.u16(1))));
    await waitFor(() => cands >= 32 && gathered >= 1, 3000, 'relay');
    await sleep(100);
    expect([answers, cands, gathered]).toEqual([1, 32, 1]);
    expect(st.errors).toEqual([]);
  });

  it('tunnel PeerConnection candidates are bounded after the answer too', async () => {
    const { ws, st } = await ready();
    let added = 0;
    const session = (st.backend as Any).session as Any;
    session.ndc = { addRemoteCandidate: () => void added++, close: noop };
    session.answerApplied = true;
    for (let i = 0; i < 100; i++) ws.send(msg((w) => (w.u8(EdgeMsg.TunnelCandidate), w.string(`candidate:${i} 1 udp 1 203.0.113.7 ${5000 + i} typ host`), w.string('0'))));
    await waitFor(() => added >= 32, 3000, 'candidates');
    await sleep(100);
    expect(added).toBe(32);
  });
});
