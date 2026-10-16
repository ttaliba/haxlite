/**
 * HostTransport behavior with a raw test client (offline, fake master):
 * admission (4100-4104, srflx bans, rate limit, hook), handshake/auth policies,
 * message delivery, flood limit, idle timeout, kick/ban, teardown.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { RawClient, type RawJoinOptions } from './raw-client.js';
import {
  HostTransport,
  generateIdentity,
  shutdownWebRtc,
  type HostTransportOptions,
  type JoinInfo,
  type Peer,
  type PeerCloseReason,
} from '../../src/net/index.js';
import { RTC_UNDER_TEST, testTransportBackend } from '../peer-backend-env.js';
import { Reader } from '../../src/codec/index.js';

let master: FakeMaster;
const transports: HostTransport[] = [];
const clients: RawClient[] = [];

beforeAll(async () => {
  master = await FakeMaster.start();
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const t of transports.splice(0)) t.stop();
  master.clientIp = null;
});

afterAll(async () => {
  await master.close();
  await shutdownWebRtc();
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

async function startHost(opts: Partial<HostTransportOptions> = {}) {
  const t = new HostTransport({ token: 'thr1.test', masterUrl: master.httpBase, iceServers: [], log: process.env.NET_DEBUG ? (m) => console.log('[host]', performance.now() | 0, m) : undefined, ...testTransportBackend(), ...opts });
  transports.push(t);
  const room = master.waitForRoom();
  t.start();
  const fakeRoom = await withTimeout(room, 10_000, 'room registration');
  const rejects: number[] = [];
  t.onJoinRejected = (_r, code) => rejects.push(code);
  return { t, roomId: fakeRoom.id, fakeRoom, rejects };
}

function join(roomId: string, opts: Partial<RawJoinOptions> = {}): RawClient {
  const c = new RawClient({ wsBase: master.wsBase, roomId, ...opts });
  clients.push(c);
  return c;
}

function nextJoin(t: HostTransport): Promise<{ peer: Peer; info: JoinInfo }> {
  return withTimeout(new Promise((resolve) => (t.onPeerJoin = (peer, info) => resolve({ peer, info }))), 15_000, 'join');
}

function nextClose(t: HostTransport): Promise<{ peer: Peer; reason: PeerCloseReason }> {
  return withTimeout(new Promise((resolve) => (t.onPeerClose = (peer, reason) => resolve({ peer, reason }))), 15_000, 'close');
}

const srflx = (ip: string) => ({
  candidate: `candidate:842163049 1 udp 1677729535 ${ip} 41234 typ srflx raddr 0.0.0.0 rport 0 generation 0`,
  sdpMid: '0',
  sdpMLineIndex: 0,
});

describe('admission at signaling time (no WebRTC)', () => {
  it('version 4103, password 4101, full 4100, malformed 0', async () => {
    const { roomId, rejects, t } = await startHost({ password: 'pw', maxPlayers: 5 });
    expect(await join(roomId, { signalingOnly: true, version: 8, password: 'pw' }).closed).toBe(4103);
    expect(await join(roomId, { signalingOnly: true, password: null }).closed).toBe(4101);
    expect(await join(roomId, { signalingOnly: true, password: 'nope' }).closed).toBe(4101);
    expect(await join(roomId, { rawPayload: Uint8Array.of(1, 2, 3) }).closed).toBe(1008);
    expect(master.rejections.at(-1)?.code).toBe(0);
    t.setMaxPlayers(0);
    expect(await join(roomId, { signalingOnly: true, password: 'pw' }).closed).toBe(4100);
    expect(rejects).toEqual([4103, 4101, 4101, 4100]); // code 0 is a parse error, not reported as a rejection
    expect(t.pendingCount).toBe(0);
  });

  it('banned srflx candidate IP (exact, IPv4 range, IPv6 range) -> 4102', async () => {
    const { roomId, rejects, t } = await startHost();
    t.bans.addIp('198.51.100.7');
    t.bans.addRange('203.0.113.0/24');
    t.bans.addRange('2001:db8:abcd::/48');
    expect(await join(roomId, { signalingOnly: true, extraCandidates: [srflx('198.51.100.7')] }).closed).toBe(4102);
    expect(await join(roomId, { signalingOnly: true, extraCandidates: [srflx('203.0.113.200')] }).closed).toBe(4102);
    expect(await join(roomId, { signalingOnly: true, extraCandidates: [srflx('2001:db8:abcd:1::5')] }).closed).toBe(4102);
    master.clientIp = () => '::ffff:203.0.113.9'; // mapped IPv4 conn
    expect(await join(roomId, { signalingOnly: true }).closed).toBe(4102);
    expect(rejects).toEqual([4102, 4102, 4102, 4102]);
  });

  it('>= 16 pending negotiations -> 4104; hook sees the request; rate limit per IP', async () => {
    const release: (() => void)[] = [];
    const seen: string[] = [];
    const { roomId, rejects, t } = await startHost({
      onJoinRequest: (req) => {
        seen.push(req.ip);
        return new Promise<{ reject: number }>((resolve) => release.push(() => resolve({ reject: 4100 })));
      },
    });
    const first = Array.from({ length: 16 }, () => join(roomId, { signalingOnly: true }));
    await withTimeout(
      (async () => {
        while (t.pendingCount < 16) await new Promise((r) => setTimeout(r, 10));
      })(),
      5000,
      'pending',
    );
    expect(await join(roomId, { signalingOnly: true }).closed).toBe(4104);
    for (const r of release) r();
    const codes = await Promise.all(first.map((c) => c.closed));
    expect(new Set(codes)).toEqual(new Set([4100]));
    expect(seen.length).toBe(16);
    expect(rejects.filter((c) => c === 4104).length).toBe(1);

    const { roomId: r2, rejects: rj2 } = await startHost({ joinRateLimit: { capacity: 2, msPerToken: 60_000 }, password: 'x' });
    expect(await join(r2, { signalingOnly: true }).closed).toBe(4101);
    expect(await join(r2, { signalingOnly: true }).closed).toBe(4101);
    expect(await join(r2, { signalingOnly: true }).closed).toBe(4104); // limited before the password check
    expect(rj2).toEqual([4101, 4101, 4104]);
  });
});

describe('stuck negotiations and candidate flooding', () => {
  it('an onJoinRequest hook that never settles times out and frees the slot', async () => {
    const { roomId, t } = await startHost({ channelOpenTimeoutMs: 300, onJoinRequest: () => new Promise<boolean>(() => {}) });
    const c = join(roomId, { signalingOnly: true });
    await withTimeout(
      (async () => {
        while (t.pendingCount < 1) await new Promise((r) => setTimeout(r, 10));
      })(),
      5000,
      'pending',
    );
    await withTimeout(
      (async () => {
        while (t.pendingCount > 0) await new Promise((r) => setTimeout(r, 20));
      })(),
      5000,
      'validating timeout',
    );
    c.close();
  });

  it('caps the remote candidates recorded per negotiation', async () => {
    let release!: () => void;
    const { roomId, t } = await startHost({ onJoinRequest: () => new Promise<boolean>((r) => (release = () => r(false))) });
    const many = Array.from({ length: 100 }, (_, i) => srflx(`192.0.2.${i + 1}`));
    const c = join(roomId, { signalingOnly: true, extraCandidates: many });
    await withTimeout(
      (async () => {
        while (t.pendingCount < 1) await new Promise((r) => setTimeout(r, 10));
      })(),
      5000,
      'pending',
    );
    await new Promise((r) => setTimeout(r, 200)); // let every trickled candidate arrive
    const peer = [...(t as unknown as { pending: Map<number, { srflxIps: string[]; queuedRemote: unknown[] }> }).pending.values()][0]!;
    expect(peer.srflxIps.length).toBeLessThanOrEqual(32);
    expect(peer.queuedRemote.length).toBeLessThanOrEqual(32);
    release();
    c.close();
  });
});

describe('handshake and identity', () => {
  it('verified auth, join info, srflx/candidates recorded, messages delivered per channel', async () => {
    const { roomId, t } = await startHost();
    const id = await generateIdentity();
    const joined = nextJoin(t);
    const c = join(roomId, { identity: id, info: { name: 'abc', flag: 'ar', avatar: '⚽' }, extraCandidates: [srflx('192.0.2.77')] });
    const { peer, info } = await joined;
    expect(info).toMatchObject({ name: 'abc', flag: 'ar', avatar: '⚽', auth: id.x, ip: '127.0.0.1' });
    expect(peer.srflxIps).toEqual(['192.0.2.77']);
    expect(peer.ips).toEqual(['127.0.0.1', '192.0.2.77']);
    await c.whenOpen();
    // negotiation state released once the answer went out (per-peer memory)
    expect(peer.localSdp).toBeNull();
    expect(peer.localCandidates).toEqual([]);
    expect(peer.mids).toEqual(['0']);
    expect(c.answerSdp).toContain('a=fingerprint:');

    const got: [number, number[]][] = [];
    const three = new Promise<void>((resolve) => {
      t.onPeerMessage = (p, data, ch) => {
        expect(p).toBe(peer);
        got.push([ch, [...data]]);
        if (got.length === 3) resolve();
      };
    });
    c.send(0, Uint8Array.of(1, 2, 3));
    c.send(1, Uint8Array.of(4));
    c.send(2, Uint8Array.of(5, 6));
    await withTimeout(three, 5000, 'messages');
    expect(got.sort((a, b) => a[0] - b[0])).toEqual([
      [0, [1, 2, 3]],
      [1, [4]],
      [2, [5, 6]],
    ]);

    // host -> client: send / broadcast (same buffer to every peer)
    expect(t.send(peer, 2, Uint8Array.of(9, 9))).toBe(true);
    t.broadcast(1, Uint8Array.of(7));
    t.broadcast(1, Uint8Array.of(8), peer);
    await withTimeout(c.waitMessages(2), 5000, 'host messages');
    expect(c.received.map(([ch, b]) => [ch, [...b]]).sort()).toEqual([
      [1, [7]],
      [2, [9, 9]],
    ]);
  });

  it('challenge delay: 10 ms for a libdatachannel offer (o=rtc), none for a browser offer; challengeDelayMs overrides', async () => {
    const opened = new Map<number, number>();
    const gaps = new Map<number, number>();
    const log = (m: string) => {
      const r = /^peer (\d+): (channel 0 open|challenge sent)$/.exec(m);
      if (r === null) return;
      const id = Number(r[1]);
      if (r[2] === 'channel 0 open') opened.set(id, performance.now());
      else gaps.set(id, performance.now() - opened.get(id)!);
    };
    const nextGap = async (expectedSize: number) => {
      const t0 = performance.now();
      while (gaps.size < expectedSize && performance.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 5));
      expect(gaps.size).toBe(expectedSize);
      return [...gaps.values()][expectedSize - 1]!;
    };
    const { roomId } = await startHost({ log });
    // node-haxball / libdatachannel (the raw client's own offer)
    join(roomId);
    expect(await nextGap(1)).toBeGreaterThanOrEqual(9);
    // the same client presenting a Chrome / Firefox origin line: challenge at once
    // (the libdatachannel client itself may then drop it: only the host side is checked)
    join(roomId, { mungeOffer: (sdp) => sdp.replace(/^o=rtc /m, 'o=- ') });
    expect(await nextGap(2)).toBeLessThan(9);
    join(roomId, { mungeOffer: (sdp) => sdp.replace(/^o=rtc \S+/m, 'o=mozilla...THIS_IS_SDPARTA-99.0') });
    expect(await nextGap(3)).toBeLessThan(9);
    // explicit value: every client
    opened.clear();
    gaps.clear();
    const h2 = await startHost({ log, challengeDelayMs: 40 });
    join(h2.roomId, { mungeOffer: (sdp) => sdp.replace(/^o=rtc /m, 'o=- ') });
    expect(await nextGap(1)).toBeGreaterThanOrEqual(39);
  });

  it('reverse-connection offers (remote ICE delayed) still connect', async () => {
    // The 2.5 s delay only postpones addRemoteCandidate; connectivity checks from the
    // client (peer-reflexive) can complete earlier, exactly as with the official host.
    const { roomId, t } = await startHost({ reverseIceDelayMs: 300 });
    const j = nextJoin(t);
    join(roomId, { reverse: true });
    const { peer } = await j;
    expect(peer.reverse).toBe(true);
  });

  it('bad signature -> auth null (official) or closed with allowNullAuth=false; no key -> null', async () => {
    const id = await generateIdentity();
    const { roomId, t } = await startHost();
    let j = nextJoin(t);
    join(roomId, { identity: id, badSignature: true });
    expect((await j).info.auth).toBeNull();
    j = nextJoin(t);
    join(roomId, { identity: null });
    expect((await j).info.auth).toBeNull();

    const { roomId: r2, t: t2 } = await startHost({ allowNullAuth: false });
    let joinedStrict = 0;
    t2.onPeerJoin = () => joinedStrict++;
    const c = join(r2, { identity: id, badSignature: true });
    await withTimeout(c.waitMessages(1), 10_000, 'kick notice');
    const r = new Reader(c.received[0]![1]);
    expect(r.u8()).toBe(5);
    expect(r.u8()).toBe(0);
    expect(r.string()).toBe('Identity verification failed');
    await withTimeout(c.channelsClosed, 5000, 'closed');
    expect(joinedStrict).toBe(0);
    // a valid identity still gets in
    const ok = nextJoin(t2);
    join(r2, { identity: id });
    expect((await ok).info.auth).toBe(id.x);
  });

  it('banned auth is refused after verification', async () => {
    const id = await generateIdentity();
    const { roomId, t } = await startHost();
    t.bans.addAuth(id.x);
    let joined = 0;
    t.onPeerJoin = () => joined++;
    const c = join(roomId, { identity: id });
    await withTimeout(c.waitMessages(1), 10_000, 'ban notice');
    expect([...c.received[0]![1].subarray(0, 2)]).toEqual([5, 1]);
    await withTimeout(c.channelsClosed, 5000, 'closed');
    expect(joined).toBe(0);
  });

  it('malformed handshake / name too long / message before join -> closed, never joined', async () => {
    const { roomId, t } = await startHost();
    let joined = 0;
    t.onPeerJoin = () => joined++;
    const c1 = join(roomId, { manualHandshake: true });
    await c1.challenge;
    await c1.whenOpen();
    c1.send(0, Uint8Array.of(0, 5, 1)); // truncated
    await withTimeout(c1.channelsClosed, 5000, 'c1 closed');
    const c2 = join(roomId, { info: { name: 'x'.repeat(26), flag: 'ar', avatar: null } });
    await withTimeout(c2.channelsClosed, 5000, 'c2 closed');
    const c3 = join(roomId, { manualHandshake: true });
    await c3.challenge;
    await c3.whenOpen();
    c3.send(0, Uint8Array.of(1, 0, 0, 0, 0)); // action before handshake
    await withTimeout(c3.channelsClosed, 5000, 'c3 closed');
    expect(joined).toBe(0);
    expect(t.connectionCount).toBe(0);
  });
});

describe('ICE privacy and deployment options', () => {
  // node-datachannel only (haxlite-rtc announces exactly its publicAddresses: test/net/rtc-backend.test.ts)
  it.skipIf(RTC_UNDER_TEST)("default policy never sends non-public host addresses; withholding every candidate still connects (peer-reflexive)", async () => {
    const seen: string[] = [];
    const { roomId, t } = await startHost({
      iceCandidatePolicy: (c) => {
        seen.push(c.address);
        return false;
      },
      iceServers: [{ urls: 'stun:127.0.0.1:9' }], // browser-style entry accepted (unreachable: no srflx)
    });
    const j = nextJoin(t);
    const c = join(roomId);
    await j;
    await c.whenOpen();
    expect(seen.length).toBeGreaterThan(0);
    expect(c.answerSdp).not.toBeNull();
    expect(c.answerSdp!).not.toMatch(/a=candidate:/);
    expect(c.answerSdp!).toMatch(/c=IN IP[46] (0\.0\.0\.0|::)\r\n/);
    expect(c.answerCandidates.filter((x) => x.candidate.length > 0)).toEqual([]);
  });

  it.skipIf(RTC_UNDER_TEST)("'all' exposes host candidates; portRange bounds the ICE port", async () => {
    const { roomId, t } = await startHost({ iceCandidatePolicy: 'all', portRange: [41000, 41010] });
    const j = nextJoin(t);
    const c = join(roomId);
    await j;
    const lines = [...(c.answerSdp ?? '').split('\r\n').filter((l) => l.startsWith('a=candidate:')).map((l) => l.slice(2)), ...c.answerCandidates.map((x) => x.candidate)];
    const host = lines.map((l) => l.split(' ')).filter((p) => p[7] === 'host');
    expect(host.length).toBeGreaterThan(0);
    for (const p of host) {
      expect(Number(p[5])).toBeGreaterThanOrEqual(41000);
      expect(Number(p[5])).toBeLessThanOrEqual(41010);
    }
  });

  it.skipIf(RTC_UNDER_TEST)('answers on the first usable candidate (no wait for an unreachable STUN) and takes the DTLS server role', async () => {
    const { roomId, t } = await startHost({
      iceCandidatePolicy: 'all',
      iceServers: ['stun:127.0.0.1:9'], // unreachable: gathering never completes in time
      answerIceWaitMs: 5_000, // the old behaviour would hold the answer this long
    });
    const t0 = performance.now();
    const j = nextJoin(t);
    const c = join(roomId);
    await j;
    expect(performance.now() - t0).toBeLessThan(4_000);
    expect(c.answerSdp).toMatch(/a=setup:passive/);
    expect(c.answerCandidates.some((x) => / typ host/.test(x.candidate))).toBe(true);
  });

  it('a throwing host callback is reported, never crashes the process', async () => {
    const errors: Error[] = [];
    const { roomId, t } = await startHost();
    t.onError = (e) => errors.push(e);
    const j = new Promise<Peer>((resolve) => {
      t.onPeerJoin = (peer) => {
        resolve(peer);
        throw new Error('onPeerJoin bug');
      };
    });
    const c = join(roomId);
    const peer = await withTimeout(j, 15_000, 'join');
    await c.whenOpen();
    const got = new Promise<void>((resolve) => {
      t.onPeerMessage = () => {
        resolve();
        throw new Error('onPeerMessage bug');
      };
    });
    c.send(0, Uint8Array.of(1));
    await withTimeout(got, 5000, 'message');
    const closed = new Promise<void>((resolve) => {
      t.onPeerClose = () => {
        resolve();
        throw new Error('onPeerClose bug');
      };
    });
    c.close();
    await withTimeout(closed, 15_000, 'close');
    expect(peer.state).toBe('closed');
    expect(errors.map((e) => e.message)).toEqual(['onPeerJoin bug', 'onPeerMessage bug', 'onPeerClose bug']);
  });
});

describe('limits and moderation', () => {
  it('flood: 100 burst then +1/16 ms -> closed with "flood"', async () => {
    const { roomId, t } = await startHost();
    const j = nextJoin(t);
    const c = join(roomId);
    const { peer } = await j;
    await c.whenOpen();
    let delivered = 0;
    t.onPeerMessage = () => delivered++;
    const closed = nextClose(t);
    for (let i = 0; i < 150; i++) c.send(0, Uint8Array.of(1));
    const { peer: p, reason } = await closed;
    expect(p).toBe(peer);
    expect(reason).toBe('flood');
    // the handshake consumed 1 token; a few may refill while the burst is in flight
    expect(delivered).toBeGreaterThanOrEqual(99);
    expect(delivered).toBeLessThan(110);
  });

  it('idle timeout closes silent peers', async () => {
    const { roomId, t } = await startHost({ peerIdleTimeoutMs: 300, sweepIntervalMs: 50 });
    const j = nextJoin(t);
    join(roomId);
    await j;
    const { reason } = await nextClose(t);
    expect(reason).toBe('timeout');
  });

  it('kick with ban: notice delivered, conn + srflx banned, rejoin -> 4102, clear -> ok', async () => {
    const { roomId, t, rejects } = await startHost({ sweepIntervalMs: 50 });
    const j = nextJoin(t);
    const c = join(roomId, { extraCandidates: [srflx('192.0.2.99')] });
    const { peer } = await j;
    const closed = nextClose(t);
    const rec = t.kick(peer, { reason: 'bye', ban: true, byName: 'admin' });
    expect((await closed).reason).toBe('kicked');
    await withTimeout(c.waitMessages(1), 5000, 'kick notice');
    const r = new Reader(c.received[0]![1]);
    expect([r.u8(), r.u8(), r.string(), r.string()]).toEqual([5, 1, 'bye', 'admin']);
    await withTimeout(c.channelsClosed, 5000, 'closed');
    expect(rec?.ips).toEqual(['127.0.0.1', '192.0.2.99']);
    expect(await join(roomId, { signalingOnly: true }).closed).toBe(4102);
    master.clientIp = () => '10.9.9.9';
    expect(await join(roomId, { signalingOnly: true, extraCandidates: [srflx('192.0.2.99')] }).closed).toBe(4102);
    t.bans.remove(rec!.id);
    const j2 = nextJoin(t);
    join(roomId);
    await j2;
    expect(rejects).toEqual([4102, 4102]);
  });

  it('room full when channel 0 opens (connections count, not players)', async () => {
    const { roomId, t } = await startHost({ maxPlayers: 1 });
    const j = nextJoin(t);
    join(roomId);
    await j;
    expect(t.connectionCount).toBe(1);
    expect(await join(roomId, { signalingOnly: true }).closed).toBe(4100);
  });

  it('stop() closes everything with "shutdown"', async () => {
    const { roomId, t } = await startHost();
    const j = nextJoin(t);
    const c = join(roomId);
    await j;
    const closed = nextClose(t);
    t.stop();
    expect((await closed).reason).toBe('shutdown');
    await withTimeout(c.channelsClosed, 5000, 'client closed');
    expect(t.peers.length).toBe(0);
  });
});
