/**
 * HostTransport closes a connected peer that stops taking what it is sent
 * (`maxPeerBufferedBytes` / `peerBufferedTimeoutMs`, close reason
 * `'stalled'`) while it keeps sending, and validates its numeric options at
 * construction. Stub backend (no WebRTC); one case drives a real
 * SctpAssociation pair whose client side keeps its receive window closed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Writer, deflateRaw } from '../../src/codec/index.js';
import { HostTransport, encodeHandshake, type HostTransportOptions, type Peer, type PeerCloseReason } from '../../src/net/index.js';
import { DEFAULT_MAX_PEER_BUFFERED_BYTES } from '../../src/net/transport.js';
import type { PeerBackend, PeerLink, PeerLinkEvents } from '../../src/net/peer-backend.js';
import { SctpAssociation, type SctpChannelConfig } from '../../src/rtc/sctp/index.js';

interface StubLink {
  ev: PeerLinkEvents;
  closed: boolean;
  /** What `queuedBytes()` reports. */
  queued: number;
}

const transports: HostTransport[] = [];
afterEach(() => {
  for (const t of transports.splice(0)) t.stop();
});

/** `makeLink` replaces the default stub link (e.g. one backed by a real SCTP association). */
function host(opts: Partial<HostTransportOptions> = {}, makeLink?: (l: StubLink) => PeerLink) {
  const links: StubLink[] = [];
  const backend: PeerBackend = {
    kind: 'stub',
    prefiltered: true,
    ready: true,
    start: () => {},
    stop: () => {},
    createPeer: (_peerId, _sdp, ev) => {
      const l: StubLink = { ev, closed: false, queued: 0 };
      links.push(l);
      if (makeLink !== undefined) return makeLink(l);
      return {
        addRemoteCandidate: () => {},
        send: () => true,
        queuedBytes: () => l.queued,
        close: () => (l.closed = true),
      };
    },
  };
  const t = new HostTransport({ token: 'thr1.test', backend, peerIdleTimeoutMs: 60_000, ...opts });
  transports.push(t);
  t.start();
  const closes: { peer: Peer; reason: PeerCloseReason }[] = [];
  t.onPeerClose = (peer, reason) => closes.push({ peer, reason });
  const feed = (frame: Uint8Array) => (t.signaling as unknown as { onMessage(m: Uint8Array): void }).onMessage(frame);
  return { t, links, closes, feed };
}

function offerFrame(peerId: number, ip: string): Uint8Array {
  const p = new Writer(256);
  p.u8(0);
  p.string('v=0\r\n');
  p.json([]);
  p.u16(9);
  p.nullableString(null);
  const z = deflateRaw(p.copyBytes());
  const conn = new TextEncoder().encode(ip);
  const w = new Writer(64 + z.length);
  w.u8(1);
  w.u32(peerId);
  w.u8(conn.length);
  w.bytes(conn);
  w.bytes(z);
  return w.copyBytes();
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Offer, channels open, handshake: returns the joined peer and its stub link. */
async function joinOne(h: ReturnType<typeof host>, peerId = 1): Promise<{ peer: Peer; link: StubLink }> {
  let joined: Peer | null = null;
  h.t.onPeerJoin = (peer) => (joined = peer);
  h.feed(offerFrame(peerId, '198.51.100.7'));
  const link = h.links.at(-1)!;
  for (let i = 0; i < 3; i++) link.ev.onChannelOpen(i, null);
  link.ev.onMessage(0, encodeHandshake(null, { name: 'p', flag: 'ar', avatar: null }));
  for (let i = 0; i < 20 && joined === null; i++) await tick();
  expect(joined).not.toBeNull();
  return { peer: joined!, link };
}

/** Keeps the peer active (a client message every `every` ms) for `ms`, calling `each` too. */
async function activeFor(link: StubLink, ms: number, every = 20, each?: () => void): Promise<void> {
  const ping = Uint8Array.of(12, 1, 2, 3);
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (!link.closed) link.ev.onMessage(0, ping);
    each?.();
    await tick(every);
  }
}

describe('stalled peers', () => {
  it('a peer that keeps more than maxPeerBufferedBytes queued for peerBufferedTimeoutMs is closed with stalled, even while it sends', async () => {
    const h = host({ sweepIntervalMs: 20, peerBufferedTimeoutMs: 200 });
    const { peer, link } = await joinOne(h);
    link.queued = 4 << 20;
    await activeFor(link, 600);
    expect(h.closes.map((c) => c.reason)).toEqual(['stalled']);
    expect(h.closes[0]!.peer).toBe(peer);
    expect(peer.closeReason).toBe('stalled');
    expect(link.closed).toBe(true); // the link (and its send buffer) is released at once
    expect(h.t.connectionCount).toBe(0);
  });

  it('a burst that drains before the timeout is tolerated, and the timer restarts after it', async () => {
    const h = host({ sweepIntervalMs: 20, peerBufferedTimeoutMs: 300 });
    const { peer, link } = await joinOne(h);
    for (let round = 0; round < 3; round++) {
      link.queued = 2 << 20;
      await activeFor(link, 150);
      link.queued = 30_000; // ordinary traffic in flight
      await activeFor(link, 80);
    }
    expect(h.closes).toEqual([]);
    expect(peer.state).toBe('joined');
    // exactly at the threshold is not over it
    link.queued = DEFAULT_MAX_PEER_BUFFERED_BYTES;
    await activeFor(link, 400);
    expect(peer.state).toBe('joined');
  });

  it('default: 1 MiB for 10 s', async () => {
    const h = host({ sweepIntervalMs: 20 });
    const { peer, link } = await joinOne(h);
    link.queued = DEFAULT_MAX_PEER_BUFFERED_BYTES + 1;
    await activeFor(link, 300);
    expect(peer.state).toBe('joined');
    expect(peer.backlogSince).toBeGreaterThan(0);
  });

  it('maxPeerBufferedBytes: Infinity disables it; links that do not report their queue are never checked', async () => {
    const off = host({ sweepIntervalMs: 20, peerBufferedTimeoutMs: 50, maxPeerBufferedBytes: Infinity });
    const a = await joinOne(off);
    a.link.queued = 64 << 20;
    await activeFor(a.link, 250);
    expect(a.peer.state).toBe('joined');

    const unknown = host({ sweepIntervalMs: 20, peerBufferedTimeoutMs: 50 }, (l) => ({
      addRemoteCandidate: () => {},
      send: () => true,
      close: () => (l.closed = true),
    }));
    const b = await joinOne(unknown);
    await activeFor(b.link, 250);
    expect(b.peer.state).toBe('joined');
  });

  it('a peer still handshaking is checked too (its seat is held all the same)', async () => {
    const h = host({ sweepIntervalMs: 20, peerBufferedTimeoutMs: 100 });
    h.feed(offerFrame(5, '198.51.100.8'));
    const link = h.links[0]!;
    for (let i = 0; i < 3; i++) link.ev.onChannelOpen(i, null);
    expect(h.t.connectionCount).toBe(1);
    link.queued = 2 << 20;
    await tick(400);
    expect(link.closed).toBe(true);
    expect(h.t.connectionCount).toBe(0);
    expect(h.closes).toEqual([]); // never joined: no onPeerClose
  });
});

describe('stalled peers over a real SCTP association', () => {
  const CHANNELS: SctpChannelConfig[] = [
    { id: 0, ordered: true },
    { id: 1, ordered: false },
    { id: 2, ordered: false, maxRetransmits: 0 },
  ];

  /**
   * Host-side association (what the rtc backend's link wraps) and a client
   * association on a virtual clock with 10 ms one-way delay. `clientRwnd`:
   * the client's receive buffer (200: it advertises a closed window forever
   * yet acknowledges the window probes, so the association never times out).
   */
  function pair(clientRwnd: number) {
    let now = 0;
    let seq = 0;
    interface Ev {
      at: number;
      seq: number;
      fn: (() => void) | null;
    }
    const q: Ev[] = [];
    const at = (delay: number, fn: () => void): Ev => {
      const ev: Ev = { at: now + Math.max(0, delay), seq: ++seq, fn };
      let lo = 0;
      let hi = q.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        const e = q[m]!;
        if (e.at < ev.at || (e.at === ev.at && e.seq < ev.seq)) lo = m + 1;
        else hi = m;
      }
      q.splice(lo, 0, ev);
      return ev;
    };
    const clock = {
      now: () => now,
      setTimer: (cb: () => void, ms: number): unknown => at(ms, cb),
      clearTimer: (h: unknown) => void ((h as Ev).fn = null),
    };
    const run = (ms: number): void => {
      const until = now + ms;
      while (q.length > 0 && q[0]!.at <= until) {
        const ev = q.shift()!;
        if (ev.fn === null) continue;
        now = Math.max(now, ev.at);
        const fn = ev.fn;
        ev.fn = null;
        fn();
      }
      now = until;
    };
    let hostClosed: string | null = null;
    const hostSide: SctpAssociation = new SctpAssociation({
      send: (pkt) => {
        const c = pkt.slice();
        at(10, () => client.input(c));
      },
      channels: CHANNELS,
      maxMessageSize: 262144,
      onMessage: () => {},
      onOpen: () => {},
      onClose: (r) => (hostClosed = r),
      ...clock,
    });
    const client: SctpAssociation = new SctpAssociation({
      send: (pkt) => {
        const c = pkt.slice();
        at(10, () => hostSide.input(c));
      },
      channels: CHANNELS,
      maxMessageSize: 262144,
      receiveBufferSize: clientRwnd,
      onMessage: () => {},
      onOpen: () => {},
      onClose: () => {},
      ...clock,
    });
    hostSide.connect();
    run(2000);
    expect(hostSide.readyState).toBe('established');
    return { hostSide, run, hostClosed: () => hostClosed };
  }

  /** Room-script-like load: 30 announcements of 1.5 KB per 100 ms of virtual time (~450 KB/s). */
  async function flood(clientRwnd: number, opts: Partial<HostTransportOptions> = {}) {
    const sctp = pair(clientRwnd);
    let closedLink = false;
    const h = host({ sweepIntervalMs: 20, peerBufferedTimeoutMs: 300, ...opts }, (l) => ({
      addRemoteCandidate: () => {},
      send: (ch, data) => sctp.hostSide.send(ch, data),
      queuedBytes: () => sctp.hostSide.bufferedAmount,
      close: () => {
        l.closed = closedLink = true;
        sctp.hostSide.close();
      },
    }));
    const { peer, link } = await joinOne(h);
    const body = new Uint8Array(1500).fill(65);
    let maxQueued = 0;
    await activeFor(link, 1500, 10, () => {
      if (closedLink) return;
      for (let i = 0; i < 30; i++) h.t.broadcast(0, body);
      sctp.run(100);
      maxQueued = Math.max(maxQueued, sctp.hostSide.bufferedAmount);
    });
    return { h, peer, maxQueued, closedLink: () => closedLink, sctpClosed: sctp.hostClosed };
  }

  it('a client with a closed receive window that keeps pinging is closed', async () => {
    const r = await flood(200);
    expect(r.maxQueued).toBeGreaterThan(DEFAULT_MAX_PEER_BUFFERED_BYTES);
    expect(r.sctpClosed()).toBeNull(); // SCTP alone never gives up on it
    expect(r.peer.closeReason).toBe('stalled');
    expect(r.closedLink()).toBe(true);
  });

  it('without the check it would hold the whole 4 MiB send buffer and stay', async () => {
    const r = await flood(200, { maxPeerBufferedBytes: Infinity });
    expect(r.maxQueued).toBeGreaterThan((4 << 20) - 1500); // the SCTP send buffer limit, full
    expect(r.sctpClosed()).toBeNull();
    expect(r.peer.state).toBe('joined');
  });

  it('a healthy client under the same load stays', async () => {
    const r = await flood(1 << 20);
    expect(r.maxQueued).toBeLessThan(DEFAULT_MAX_PEER_BUFFERED_BYTES);
    expect(r.peer.state).toBe('joined');
    expect(r.h.closes).toEqual([]);
  });
});

describe('numeric options are validated at construction', () => {
  const base = { token: 't', masterUrl: 'http://127.0.0.1:9/' };
  const make = (o: Partial<HostTransportOptions>) => () => new HostTransport({ ...base, ...o });

  it('invalid values throw a RangeError', () => {
    const bad: Partial<HostTransportOptions>[] = [
      { floodCapacity: 0 },
      { floodCapacity: Number.NaN },
      { floodMsPerToken: 0 },
      { floodMsPerToken: Number.NaN },
      { floodMsPerToken: Infinity },
      { maxPlayers: Number.NaN },
      { maxPlayers: -1 },
      { maxPlayers: 3.5 },
      { maxPlayers: 256 },
      { sweepIntervalMs: 0 },
      { sweepIntervalMs: Number.NaN },
      { sweepIntervalMs: 2 ** 31 },
      { answerIceWaitMs: -1 },
      { answerIceWaitMs: Number.NaN },
      { reverseIceDelayMs: Infinity },
      { challengeDelayMs: Number.NaN },
      { version: 70_000 },
      { version: Number.NaN },
      { joinRateLimit: { capacity: 1, msPerToken: 1000, code: 1e6 } },
      { maxPeerBufferedBytes: 0 },
      { maxPeerBufferedBytes: Number.NaN },
      { peerBufferedTimeoutMs: 0 },
      { peerBufferedTimeoutMs: Infinity },
      { peerBackend: 'rtc', rtcEndpoint: { maxSessions: Number.NaN } },
      { peerBackend: 'rtc', rtcEndpoint: { maxSessions: 0 } },
      { peerBackend: 'rtc', rtcEndpoint: { idleTimeoutMs: Infinity } },
      { peerBackend: 'rtc', rtcEndpoint: { handshakeTimeoutMs: Number.NaN } },
      { peerBackend: 'rtc', rtcEndpoint: { port: 70_000 } },
      { peerBackend: 'rtc', rtcEndpoint: { publicPort: 0 } },
      { peerBackend: 'rtc', rtcEndpoint: { gatherRefreshMs: Number.NaN } },
    ];
    for (const o of bad) expect(make(o), JSON.stringify(o)).toThrow(RangeError);
  });

  it('defaults and valid edge values are accepted', () => {
    const ok: Partial<HostTransportOptions>[] = [
      {},
      { maxPlayers: 0 },
      { maxPlayers: 30 },
      { floodCapacity: Infinity, floodMsPerToken: 1 },
      { sweepIntervalMs: 50, answerIceWaitMs: 0, reverseIceDelayMs: 0, challengeDelayMs: 0 },
      { version: 9 },
      { joinRateLimit: { capacity: 1, msPerToken: 1000, code: 4104 } },
      { maxPeerBufferedBytes: Infinity, peerBufferedTimeoutMs: 1 },
      { peerBackend: 'rtc', rtcEndpoint: { port: 0, maxSessions: 1, idleTimeoutMs: 1500, gatherRefreshMs: 0 } },
      { peerBackend: 'rtc', rtcEndpoint: { publicPort: 40_000, gatherRefreshMs: Infinity } },
    ];
    for (const o of ok) expect(make(o), JSON.stringify(o)).not.toThrow();
  });

  it('setMaxPlayers refuses what the constructor refuses', () => {
    const t = new HostTransport(base);
    expect(() => t.setMaxPlayers(Number.NaN)).toThrow(RangeError);
    expect(() => t.setMaxPlayers(300)).toThrow(RangeError);
    t.setMaxPlayers(0);
    expect(t.getRoomInfo().maxPlayers).toBe(0);
  });
});
