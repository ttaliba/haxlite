/**
 * `peerBackend: 'rtc'` (haxlite-rtc) specifics with a libdatachannel raw
 * client, offline through the fake master: configuration errors, what the
 * answer announces, channel-close mapping, remote address, idle behaviour.
 * The generic transport/host/API suites also run with this backend (vitest
 * project `rtc`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { RawClient } from './raw-client.js';
import {
  HostTransport,
  RtcPeerBackend,
  resolvePublicAddresses,
  shutdownWebRtc,
  type HostTransportOptions,
  type JoinInfo,
  type Peer,
  type PeerCloseReason,
} from '../../src/net/index.js';
import { resolvePeerBackend } from '../../src/net/transport.js';
import { closeNative } from '../../src/net/webrtc.js';
import { FakeStunServer } from '../rtc/nat-sim.js';

let master: FakeMaster;
const transports: HostTransport[] = [];
const clients: RawClient[] = [];

beforeAll(async () => {
  master = await FakeMaster.start();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const t of transports.splice(0)) {
    t.stop();
    if (t.backend instanceof RtcPeerBackend) await t.backend.whenClosed();
  }
});

afterAll(async () => {
  await master.close();
  await shutdownWebRtc();
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

const LOOPBACK = { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] };

async function startHost(opts: Partial<HostTransportOptions> = {}) {
  const t = new HostTransport({
    token: 'thr1.test',
    masterUrl: master.httpBase,
    peerBackend: 'rtc',
    rtcEndpoint: LOOPBACK,
    ...opts,
  });
  transports.push(t);
  const room = master.waitForRoom();
  t.start();
  const fakeRoom = await withTimeout(room, 10_000, 'room registration');
  return { t, roomId: fakeRoom.id, backend: t.backend as RtcPeerBackend };
}

function join(roomId: string): RawClient {
  const c = new RawClient({ wsBase: master.wsBase, roomId });
  clients.push(c);
  return c;
}

const nextJoin = (t: HostTransport) =>
  withTimeout(new Promise<{ peer: Peer; info: JoinInfo }>((resolve) => (t.onPeerJoin = (peer, info) => resolve({ peer, info }))), 15_000, 'join');
const nextClose = (t: HostTransport) =>
  withTimeout(new Promise<{ peer: Peer; reason: PeerCloseReason }>((resolve) => (t.onPeerClose = (peer, reason) => resolve({ peer, reason }))), 15_000, 'close');

describe("peerBackend: 'rtc' configuration", () => {
  it("is the default; node-datachannel settings (portRange, rtc) keep 'ndc' so they are not ignored", () => {
    expect(resolvePeerBackend({})).toBe('rtc');
    expect(resolvePeerBackend({ portRange: null, rtc: undefined })).toBe('rtc');
    expect(resolvePeerBackend({ portRange: [40000, 40100] })).toBe('ndc');
    expect(resolvePeerBackend({ rtc: { enableIceUdpMux: false } })).toBe('ndc');
    expect(resolvePeerBackend({ peerBackend: 'rtc', portRange: [40000, 40100] })).toBe('rtc');
    expect(resolvePeerBackend({ peerBackend: 'ndc' })).toBe('ndc');
    expect(() => resolvePeerBackend({ peerBackend: 'bogus' as 'rtc' })).toThrow(/peerBackend/);
    const base = { token: 't', masterUrl: 'http://127.0.0.1:9/' };
    const implicit = new HostTransport(base);
    expect(implicit.backend).toBeInstanceOf(RtcPeerBackend);
    implicit.stop();
    const ndc = new HostTransport({ ...base, portRange: [40000, 40100] });
    expect(ndc.backend).not.toBeInstanceOf(RtcPeerBackend);
    ndc.stop();
  });

  it('publicAddresses must be IP literals; an empty list or an unknown backend is refused at construction', () => {
    const base = { token: 't', masterUrl: 'http://127.0.0.1:9/' };
    expect(() => new HostTransport({ ...base, peerBackend: 'rtc', rtcEndpoint: { publicAddresses: ['example.com'] } })).toThrow(/IP literals/);
    expect(() => new HostTransport({ ...base, peerBackend: 'rtc', rtcEndpoint: { publicAddresses: [] } })).toThrow(/empty/);
    expect(() => new HostTransport({ ...base, peerBackend: 'bogus' as 'rtc' })).toThrow(/peerBackend/);
    // IPv6 entries only with ipv6: true
    expect(resolvePublicAddresses({ publicAddresses: ['203.0.113.7', '2001:db8::7'] })).toEqual(['203.0.113.7']);
    expect(resolvePublicAddresses({ publicAddresses: ['203.0.113.7', '2001:db8::7'], ipv6: true })).toEqual(['203.0.113.7', '2001:db8::7']);
    expect(() => new HostTransport({ ...base, peerBackend: 'rtc', rtcEndpoint: { publicAddresses: ['2001:db8::7'] } })).toThrow(/ipv6/);
    // without publicAddresses: the machine's public interface addresses, or a clear error
    let detected: string[] | null = null;
    try {
      detected = resolvePublicAddresses({});
    } catch (err) {
      expect((err as Error).message).toMatch(/publicAddresses/);
    }
    if (detected !== null) expect(detected.length).toBeGreaterThan(0);
    // full ICE (default) needs no public address: STUN / our checks handle NAT; ICE-lite still insists
    expect(() => new HostTransport({ ...base, peerBackend: 'rtc' })).not.toThrow();
    if (detected === null) expect(() => new HostTransport({ ...base, peerBackend: 'rtc', rtcEndpoint: { iceLite: true } })).toThrow(/iceLite/);
  });

  it('rooms with the same settings share one endpoint (one UDP socket); the last one closes it', async () => {
    const a = await startHost();
    const b = await startHost();
    await a.backend.whenListening();
    await b.backend.whenListening();
    expect(a.backend.endpoint).not.toBeNull();
    expect(b.backend.endpoint).toBe(a.backend.endpoint);
    const own = await startHost({ rtcEndpoint: { ...LOOPBACK, shared: false } });
    await own.backend.whenListening();
    expect(own.backend.endpoint).not.toBe(a.backend.endpoint);
    const ep = a.backend.endpoint!;
    a.t.stop();
    await a.backend.whenClosed();
    expect((ep as unknown as { closed: boolean }).closed).toBe(false); // b still uses it
    b.t.stop();
    await b.backend.whenClosed();
    expect((ep as unknown as { closed: boolean }).closed).toBe(true);
  });

  it('a port already in use (unshared endpoint) is reported through onError', async () => {
    const first = await startHost();
    await first.backend.whenListening();
    const port = first.backend.port!;
    const t = new HostTransport({ token: 'thr1.test', masterUrl: master.httpBase, peerBackend: 'rtc', rtcEndpoint: { ...LOOPBACK, port, shared: false } });
    transports.push(t);
    const err = withTimeout(new Promise<Error>((resolve) => (t.onError = resolve)), 5000, 'onError');
    t.start();
    expect((await err).message).toMatch(/cannot listen on UDP 127\.0\.0\.1:\d+/);
    expect(t.backend.ready).toBe(false);
  });
});

describe("peerBackend: 'rtc' with a libdatachannel client", () => {
  it('answer announces exactly the configured address/port (full ICE); client joins; remote address is the STUN source', async () => {
    // explicit publicAddresses bypass the candidate policy (and STUN: iceServers default to none)
    const { t, roomId, backend } = await startHost({ iceCandidatePolicy: () => false });
    expect(backend.kind).toBe('rtc');
    expect(backend.prefiltered).toBe(true);
    const j = nextJoin(t);
    const c = join(roomId);
    const { peer, info } = await j;
    await c.whenOpen();
    const sdp = c.answerSdp!;
    expect(sdp).not.toMatch(/a=ice-lite/);
    const lines = [...sdp.split('\r\n').filter((l) => l.startsWith('a=candidate:')).map((l) => l.slice(2)), ...c.answerCandidates.map((x) => x.candidate)];
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const p = l.split(' ');
      expect([p[4], Number(p[5]), p[7]]).toEqual(['127.0.0.1', backend.port, 'host']);
    }
    expect(info.ip).toBe('127.0.0.1');
    expect(peer.remoteAddress).toBe('127.0.0.1');
    expect(peer.channelOpen).toEqual([true, true, true]);
    expect(backend.stats()!.open).toBe(1);
    // all three channels carry data both ways
    const got: number[] = [];
    t.onPeerMessage = (_p, _d, ch) => got.push(ch);
    for (let ch = 0; ch < 3; ch++) c.send(ch, Uint8Array.of(9, ch));
    for (let ch = 0; ch < 3; ch++) expect(t.send(peer, ch, Uint8Array.of(7, ch))).toBe(true);
    await withTimeout(c.waitMessages(3), 5000, 'host -> client');
    await withTimeout(
      (async () => {
        while (got.length < 3) await new Promise((r) => setTimeout(r, 10));
      })(),
      5000,
      'client -> host',
    );
    expect(got.sort()).toEqual([0, 1, 2]);
    expect(c.received.map(([ch, b]) => [ch, b[1]]).sort()).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('ICE-lite: the client joins through the DTLS cookie exchange (on by default there); helloVerify is plumbed', async () => {
    const helloVerifyOf = (b: RtcPeerBackend) => (b.endpoint as unknown as { host: { helloVerify: boolean } }).host.helloVerify;
    const { t, roomId, backend } = await startHost({ rtcEndpoint: { ...LOOPBACK, iceLite: true, shared: false } });
    const j = nextJoin(t);
    const c = join(roomId);
    const { peer } = await j;
    await c.whenOpen();
    expect(c.answerSdp).toContain('a=ice-lite');
    expect(peer.channelOpen).toEqual([true, true, true]);
    expect(helloVerifyOf(backend)).toBe(true);
    const full = await startHost({ rtcEndpoint: { ...LOOPBACK, shared: false } });
    await full.backend.whenListening();
    expect(helloVerifyOf(full.backend)).toBe(false);
    const forced = await startHost({ rtcEndpoint: { ...LOOPBACK, iceLite: true, helloVerify: false, shared: false } });
    await forced.backend.whenListening();
    expect(helloVerifyOf(forced.backend)).toBe(false);
  });

  it('a join after gatherRefreshMs answers with the cached srflx at once, even when the refresh gets no reply', async () => {
    const stun = await FakeStunServer.start('127.0.0.1');
    try {
      const { t, roomId, backend } = await startHost({
        rtcEndpoint: { address: '127.0.0.1', iceServers: [stun.url], iceCandidatePolicy: 'public', gatherRefreshMs: 100, shared: false },
      });
      const timeJoin = async () => {
        const j = nextJoin(t);
        const t0 = performance.now();
        const c = join(roomId);
        await j;
        await c.whenOpen();
        return { c, ms: performance.now() - t0 };
      };
      // 'public': the loopback host candidate is withheld, the srflx (127.0.0.1) is the only one
      await timeJoin(); // first round (answer may wait for it)
      await backend.endpoint!.whenGathered();
      await new Promise((r) => setTimeout(r, 150)); // stale
      stun.silent = true; // the refresh round's reply is lost
      const before = stun.requests;
      const { c, ms } = await timeJoin();
      expect(stun.requests).toBeGreaterThan(before); // a refresh did start
      // the answer was not held for the refresh (answerIceWaitMs: 500 ms)
      expect(c.answerSdp).toContain('typ srflx');
      expect(c.answerSdp).not.toContain('a=end-of-candidates'); // completed by trickle once the refresh ends
      expect(ms).toBeLessThan(450); // 555–577 ms before (the 500 ms answer wait), ≈ 63 ms after
    } finally {
      stun.close();
    }
  });

  it('a refresh that finds a different srflx: the client answered meanwhile gets it trickled', async () => {
    const stun = await FakeStunServer.start('127.0.0.1');
    try {
      const { t, roomId, backend } = await startHost({
        rtcEndpoint: { address: '127.0.0.1', iceServers: [stun.url], iceCandidatePolicy: 'public', gatherRefreshMs: 100, shared: false },
      });
      await backend.whenListening();
      const ep = backend.endpoint!;
      await ep.whenGathered();
      await new Promise((r) => setTimeout(r, 150)); // stale
      stun.portOffset = 5; // the mapping changed (the reported port does not reach us: only the trickle is checked)
      const j = nextJoin(t);
      const c = join(roomId);
      await j;
      await c.whenOpen();
      expect(c.answerSdp).toContain(`127.0.0.1 ${ep.port} typ srflx`);
      await ep.whenGathered();
      for (let i = 0; i < 50 && !c.answerCandidates.some((x) => x.candidate.includes(` ${ep.port + 5} typ srflx`)); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(c.answerCandidates.map((x) => x.candidate).filter((x) => x.includes(` ${ep.port + 5} typ srflx`))).toHaveLength(1);
    } finally {
      stun.close();
    }
  });

  it('the client closing one data channel (stream reset) closes the peer at once', async () => {
    const { t, roomId } = await startHost();
    const j = nextJoin(t);
    const c = join(roomId);
    const { peer } = await j;
    await c.whenOpen();
    const closed = nextClose(t);
    const t0 = performance.now();
    closeNative(c.channels[1]!); // RFC 8831 §6.7 reset of stream 1 only, the PeerConnection stays up
    const r = await closed;
    expect(r.peer).toBe(peer);
    expect(r.reason).toBe('closed');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('kick: notice delivered before the close; ban covers conn + srflx; idle endpoint has no sessions and no timers', async () => {
    const { t, roomId, backend } = await startHost({ sweepIntervalMs: 50 });
    const j = nextJoin(t);
    const c = join(roomId);
    const { peer } = await j;
    await c.whenOpen();
    const closed = nextClose(t);
    t.kick(peer, { reason: 'bye', ban: true });
    expect((await closed).reason).toBe('kicked');
    await withTimeout(c.waitMessages(1), 5000, 'kick notice');
    expect(c.received[0]![1][0]).toBe(5);
    await withTimeout(c.channelsClosed, 5000, 'client sees the close');
    expect(await join(roomId).closed).toBe(4102);
    // nothing left: no session and, after its last 1 s tick, no endpoint sweep timer
    const ep = backend.endpoint!;
    expect(ep.stats().sessions).toBe(0);
    const t0 = performance.now();
    while ((ep as unknown as { sweepTimer: unknown }).sweepTimer !== null && performance.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((ep as unknown as { sweepTimer: unknown }).sweepTimer).toBeNull();
  });
});

describe("peerBackend: 'rtc' frame batching (sendBatchFrames)", () => {
  const FRAME_MS = 1000 / 60;
  const gridIndex = () => Math.floor(performance.now() * 0.06 + 1e-6);
  /** Resolves within the first quarter of a frame of the process-wide 60 Hz grid. */
  async function frameStart(): Promise<void> {
    for (;;) {
      const f = performance.now() * 0.06;
      if (f - Math.floor(f) < 0.25) return;
      await new Promise((r) => setTimeout(r, Math.max(1, Math.ceil((Math.floor(f) + 1 - f) * FRAME_MS))));
    }
  }
  const nextIteration = () => new Promise<void>((r) => setImmediate(r));

  async function setup(sendBatchFrames: 0 | 1 | 2) {
    const h = await startHost({ rtcEndpoint: { ...LOOPBACK, shared: false, sendBatchFrames } });
    const j = nextJoin(h.t);
    const c = join(h.roomId);
    const { peer } = await j;
    await c.whenOpen();
    await new Promise((r) => setTimeout(r, 300)); // handshake traffic and SACKs settle
    return { ...h, c, peer };
  }

  /** `n` messages on `ru`, one per event-loop iteration inside one frame: datagrams out, start frame, arrival (in frames). */
  async function burst(s: Awaited<ReturnType<typeof setup>>, n: number) {
    const ep = s.backend.endpoint!;
    const have = s.c.received.length;
    await frameStart();
    const g0 = gridIndex();
    const out0 = ep.stats().packetsOut;
    for (let i = 0; i < n; i++) {
      expect(s.t.send(s.peer, 1, Uint8Array.of(2, i))).toBe(true);
      await nextIteration();
    }
    await withTimeout(s.c.waitMessages(have + n), 5000, 'burst');
    const arrivedFrame = performance.now() * 0.06;
    await new Promise((r) => setTimeout(r, 50));
    return { datagrams: ep.stats().packetsOut - out0, g0, arrivedFrame, payloads: s.c.received.slice(have).map(([ch, b]) => [ch, b[1]]) };
  }

  it('is validated at construction (0, 1 or 2)', () => {
    const base = { token: 't', masterUrl: 'http://127.0.0.1:9/', peerBackend: 'rtc' as const };
    expect(() => new HostTransport({ ...base, rtcEndpoint: { ...LOOPBACK, sendBatchFrames: 3 as 2 } })).toThrow(/sendBatchFrames/);
    expect(() => new HostTransport({ ...base, rtcEndpoint: { ...LOOPBACK, sendBatchFrames: 1 } })).not.toThrow();
  });

  it('off: every iteration sends its own datagram', async () => {
    const r = await burst(await setup(0), 4);
    expect(r.datagrams).toBe(4);
  });

  it('1 frame: ru messages of several iterations leave together on the next grid boundary, in order', async () => {
    const r = await burst(await setup(1), 4);
    expect(r.datagrams).toBe(1);
    expect(r.payloads).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    expect(r.arrivedFrame).toBeGreaterThanOrEqual(r.g0 + 1 - 1e-6); // not before the boundary
  });

  it('2 frames: held until an even boundary; ro / uu are not held and take the held ru messages along', async () => {
    const s = await setup(2);
    const r = await burst(s, 3);
    expect(r.datagrams).toBe(1);
    const due = r.g0 % 2 === 0 ? r.g0 + 2 : r.g0 + 1;
    expect(r.arrivedFrame).toBeGreaterThanOrEqual(due - 1e-6);
    // a held ru message, then one on uu (heartbeat / pong) or ro: both leave at once, in one datagram
    for (const ch of [2, 0]) {
      const ep = s.backend.endpoint!;
      const have = s.c.received.length;
      await frameStart();
      const g = gridIndex();
      const out0 = ep.stats().packetsOut;
      s.t.send(s.peer, 1, Uint8Array.of(2, 10 + ch));
      s.t.send(s.peer, ch, Uint8Array.of(3, 20 + ch));
      await withTimeout(s.c.waitMessages(have + 2), 5000, `held ru + ${ch}`);
      expect(performance.now() * 0.06).toBeLessThan(g + 1); // the held one was due at g + 1 or g + 2
      expect(ep.stats().packetsOut - out0).toBe(1);
      // same datagram; SCTP does not order delivery across streams (libdatachannel on Linux may hand
      // the ro / uu message to the app first), so only the contents are checked
      const got = s.c.received.slice(have).map(([c, b]) => [c, b[1]]);
      expect(got).toHaveLength(2);
      expect(got).toEqual(expect.arrayContaining([
        [1, 10 + ch],
        [ch, 20 + ch],
      ]));
    }
  });
});
