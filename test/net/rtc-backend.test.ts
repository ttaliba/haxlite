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
import { closeNative } from '../../src/net/webrtc.js';

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
  it('publicAddresses must be IP literals; an empty list or an unknown backend is refused at construction', () => {
    const base = { token: 't', masterUrl: 'http://127.0.0.1:9/' };
    expect(() => new HostTransport({ ...base, peerBackend: 'rtc', rtcEndpoint: { publicAddresses: ['example.com'] } })).toThrow(/IP literals/);
    expect(() => new HostTransport({ ...base, peerBackend: 'rtc', rtcEndpoint: { publicAddresses: [] } })).toThrow(/empty/);
    expect(() => new HostTransport({ ...base, peerBackend: 'bogus' as 'rtc' })).toThrow(/peerBackend/);
    expect(resolvePublicAddresses({ publicAddresses: ['203.0.113.7', '2001:db8::7'] })).toEqual(['203.0.113.7', '2001:db8::7']);
    // without publicAddresses: the machine's public interface addresses, or a clear error
    let detected: string[] | null = null;
    try {
      detected = resolvePublicAddresses({});
    } catch (err) {
      expect((err as Error).message).toMatch(/publicAddresses/);
    }
    if (detected !== null) expect(detected.length).toBeGreaterThan(0);
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
  it('answer announces exactly the configured address/port (ICE-lite); client joins; remote address is the STUN source', async () => {
    const { t, roomId, backend } = await startHost({ iceCandidatePolicy: () => false /* ignored by rtc */ });
    expect(backend.kind).toBe('rtc');
    expect(backend.prefiltered).toBe(true);
    const j = nextJoin(t);
    const c = join(roomId);
    const { peer, info } = await j;
    await c.whenOpen();
    const sdp = c.answerSdp!;
    expect(sdp).toMatch(/a=ice-lite/);
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
