/**
 * HostTransport admission against hostile signaling, with a stub peer
 * backend (no WebRTC): master frames are fed to the signaling layer as they
 * arrive from the WS. Covers repeated peer ids, the offer candidate cap, the
 * checks that run before inflating an offer, the per-address limits
 * (unjoined connections, abuse penalty), seats held without a handshake,
 * IP bans on verified addresses, the join hook's decisions and option
 * validation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { Writer, deflateRaw } from '../../src/codec/index.js';
import { HostTransport, encodeHandshake, type HostTransportOptions, type JoinDecision, type Peer } from '../../src/net/index.js';
import type { PeerBackend, PeerLinkEvents } from '../../src/net/peer-backend.js';

interface StubLink {
  peerId: number;
  ev: PeerLinkEvents;
  closed: boolean;
  candidates: string[];
  sent: Uint8Array[];
}

const transports: HostTransport[] = [];
afterEach(() => {
  for (const t of transports.splice(0)) t.stop();
});

function host(opts: Partial<HostTransportOptions> = {}) {
  const links: StubLink[] = [];
  const backend: PeerBackend = {
    kind: 'stub',
    prefiltered: true,
    ready: true,
    start: () => {}, // never ready for the master: no network
    stop: () => {},
    createPeer: (peerId, _sdp, ev) => {
      const l: StubLink = { peerId, ev, closed: false, candidates: [], sent: [] };
      links.push(l);
      return {
        addRemoteCandidate: (c) => l.candidates.push(c),
        send: (_ch, data) => (l.sent.push(data.slice()), true),
        close: () => (l.closed = true),
      };
    },
  };
  const t = new HostTransport({ token: 'thr1.test', backend, ...opts });
  transports.push(t);
  t.start();
  const rejects: { peerId: number; code: number; why: string }[] = [];
  t.onJoinRejected = (r, code, why) => rejects.push({ peerId: r.peerId, code, why });
  const answered: [number, number][] = [];
  const sendReject = t.signaling.sendReject.bind(t.signaling);
  t.signaling.sendReject = (peerId, code) => {
    answered.push([peerId, code]);
    sendReject(peerId, code);
  };
  const feed = (frame: Uint8Array) => (t.signaling as unknown as { onMessage(m: Uint8Array): void }).onMessage(frame);
  return { t, links, rejects, answered, feed, live: () => links.filter((l) => !l.closed) };
}

interface OfferOpts {
  candidates?: unknown[];
  version?: number;
  password?: string | null;
  payload?: Uint8Array;
}

/** `[1][u32 peerId][u8 n][conn = IP text] deflate(u8 reverse, sdp, json candidates, u16 version, password)`. */
function offerFrame(peerId: number, ip: string, o: OfferOpts = {}): Uint8Array {
  let z = o.payload;
  if (z === undefined) {
    const p = new Writer(256);
    p.u8(0);
    p.string('v=0\r\n');
    p.json(o.candidates ?? []);
    p.u16(o.version ?? 9);
    p.nullableString(o.password ?? null);
    z = deflateRaw(p.copyBytes());
  }
  const conn = new TextEncoder().encode(ip);
  const w = new Writer(64 + z.length);
  w.u8(1);
  w.u32(peerId);
  w.u8(conn.length);
  w.bytes(conn);
  w.bytes(z);
  return w.copyBytes();
}

const cand = (ip: string, type: string) => ({
  candidate: `candidate:1 1 udp 1 ${ip} 5000 typ ${type}${type === 'host' ? '' : ' raddr 0.0.0.0 rport 0'}`,
  sdpMid: '0',
  sdpMLineIndex: 0,
});

/** Opens the three channels of a stub link (challenge sent once the third is open). */
function open(l: StubLink, remoteAddress: string | null = null): void {
  for (let i = 0; i < 3; i++) l.ev.onChannelOpen(i, i === 0 ? remoteAddress : null);
}

function handshake(l: StubLink, name = 'p'): void {
  l.ev.onMessage(0, encodeHandshake(null, { name, flag: 'ar', avatar: null }));
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Lets the async handshake verification finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

describe('repeated peer ids from the master', () => {
  it('an offer whose peerId is still pending is ignored: no second link, the 16 cap holds', () => {
    const { t, links, answered, feed } = host();
    for (let i = 0; i < 50; i++) feed(offerFrame(7, `198.51.100.${i + 1}`));
    expect(links.length).toBe(1);
    expect(t.pendingCount).toBe(1);
    expect(answered).toEqual([]); // nothing is sent for the repeats: it would reach the live negotiation
    for (let i = 0; i < 20; i++) feed(offerFrame(100 + i, `203.0.113.${i + 1}`));
    expect(t.pendingCount).toBe(16);
    expect(links.length).toBe(16);
  });

  it('channel 0 of a peer only removes its own pending entry', () => {
    const { t, links, feed } = host();
    feed(offerFrame(7, '198.51.100.1'));
    feed(offerFrame(8, '198.51.100.2'));
    open(links[0]!);
    expect(t.pendingCount).toBe(1);
    expect(t.connectionCount).toBe(1);
  });
});

describe('offer candidates', () => {
  it('only the first 32 are parsed, checked and applied', () => {
    const { t, links, rejects, feed } = host();
    t.bans.addIp('203.0.113.66');
    const many: unknown[] = Array.from({ length: 300 }, (_, i) => cand(`192.0.2.${(i % 250) + 1}`, 'host'));
    many[200] = cand('203.0.113.66', 'srflx'); // never applied: not checked either
    many[250] = { bogus: true }; // past the cap: not validated
    feed(offerFrame(1, '198.51.100.1', { candidates: many }));
    expect(rejects).toEqual([]);
    expect(links.length).toBe(1);
    expect(links[0]!.candidates.length).toBe(32);
    // within the cap the official srflx ban still applies
    const early = many.slice(0, 40);
    early[3] = cand('203.0.113.66', 'srflx');
    feed(offerFrame(2, '198.51.100.2', { candidates: early }));
    expect(rejects.map((r) => [r.code, r.why])).toEqual([[4102, 'banned srflx']]);
  });
});

describe('checks before the offer payload is inflated', () => {
  const garbage = Uint8Array.of(1, 2, 3); // not deflate: a parse error (0) once inflated
  it('banned conn, rate limit and full room answer without parsing', () => {
    const { t, answered, rejects, feed } = host({ joinRateLimit: { capacity: 1, msPerToken: 60_000 } });
    feed(offerFrame(1, '198.51.100.1', { payload: garbage }));
    expect(answered.at(-1)).toEqual([1, 0]); // parsed (and the limiter token taken)
    t.bans.addIp('198.51.100.9');
    feed(offerFrame(2, '198.51.100.9', { payload: garbage }));
    expect(answered.at(-1)).toEqual([2, 4102]);
    feed(offerFrame(3, '198.51.100.1', { payload: garbage }));
    expect(answered.at(-1)).toEqual([3, 4104]);
    t.setMaxPlayers(0);
    feed(offerFrame(4, '198.51.100.2', { payload: garbage }));
    expect(answered.at(-1)).toEqual([4, 4100]);
    expect(rejects.map((r) => r.why)).toEqual(['banned conn', 'join rate limit', 'room full']);
  });
});

describe('unjoined connections per address', () => {
  it('8 at a time from one public address by default; others and loopback are not affected', () => {
    const { t, rejects, feed } = host({ onJoinRequest: () => new Promise<boolean>(() => {}) });
    for (let i = 0; i < 9; i++) feed(offerFrame(i + 1, '198.51.100.9'));
    expect(t.pendingCount).toBe(8);
    expect(rejects.map((r) => [r.peerId, r.code, r.why])).toEqual([[9, 4104, 'too many unjoined connections from this address']]);
    feed(offerFrame(20, '::ffff:198.51.100.9')); // same address, another spelling
    expect(rejects.at(-1)?.peerId).toBe(20);
    feed(offerFrame(21, '198.51.100.10'));
    for (let i = 0; i < 6; i++) feed(offerFrame(30 + i, '127.0.0.1'));
    expect(t.pendingCount).toBe(15);
    expect(rejects.length).toBe(2);
  });

  it('handshaking connections count until they join; Infinity disables the limit', async () => {
    const { t, links, rejects, feed } = host({ maxUnjoinedPerIp: 2, maxPlayers: 10 });
    feed(offerFrame(1, '198.51.100.9'));
    feed(offerFrame(2, '198.51.100.9'));
    open(links[0]!);
    open(links[1]!);
    expect(t.connectionCount).toBe(2);
    feed(offerFrame(3, '198.51.100.9'));
    expect(rejects.map((r) => r.code)).toEqual([4104]);
    handshake(links[0]!);
    await settle();
    expect(t.peers.length).toBe(1);
    feed(offerFrame(4, '198.51.100.9'));
    expect(rejects.length).toBe(1);
    expect(t.pendingCount).toBe(1);

    const h2 = host({ maxUnjoinedPerIp: Infinity, onJoinRequest: () => new Promise<boolean>(() => {}) });
    for (let i = 0; i < 16; i++) h2.feed(offerFrame(i + 1, '198.51.100.9'));
    expect(h2.t.pendingCount).toBe(16);
  });
});

describe('seats held without a handshake', () => {
  it('a full room gives the seat of the oldest stale challenged connection to a new one, never a joined one', async () => {
    const { t, links, rejects, feed } = host({ maxPlayers: 3 });
    feed(offerFrame(1, '198.51.100.1'));
    open(links[0]!);
    handshake(links[0]!);
    await settle();
    expect(t.peers.length).toBe(1);
    feed(offerFrame(2, '198.51.100.2'));
    feed(offerFrame(3, '198.51.100.3'));
    open(links[1]!);
    await tick(50);
    open(links[2]!);
    expect(t.connectionCount).toBe(3);
    feed(offerFrame(4, '198.51.100.4'));
    expect(rejects.map((r) => r.code)).toEqual([4100]); // nobody is stale yet
    await tick(3_100);
    links[0]!.ev.onMessage(0, Uint8Array.of(1)); // the joined player stays active
    feed(offerFrame(5, '198.51.100.5'));
    expect(rejects.length).toBe(1);
    expect(links[1]!.closed).toBe(true); // the older silent one
    expect(links[2]!.closed).toBe(false);
    expect(links[0]!.closed).toBe(false);
    open(links[3]!);
    expect(t.connectionCount).toBe(3);
    handshake(links[3]!);
    await settle();
    expect(t.peers.length).toBe(2);
  });
});

describe('abuse penalty per address', () => {
  it('after the abusive closes allowed, offers from the address are refused for blockMs', async () => {
    const { t, links, rejects, feed } = host({ abusePenalty: { capacity: 2, msPerToken: 60_000, blockMs: 300 } });
    const abuse = (id: number, ip: string) => {
      feed(offerFrame(id, ip));
      const l = links.at(-1)!;
      open(l);
      l.ev.onMessage(0, 'text'); // protocol violation
      expect(l.closed).toBe(true);
    };
    abuse(1, '198.51.100.9');
    abuse(2, '198.51.100.9');
    feed(offerFrame(3, '198.51.100.9'));
    expect(rejects).toEqual([]);
    open(links.at(-1)!);
    links.at(-1)!.ev.onMessage(0, 'text'); // third: no token left
    feed(offerFrame(4, '198.51.100.9'));
    expect(rejects.map((r) => [r.code, r.why])).toEqual([[4104, 'address blocked after abusive connections']]);
    feed(offerFrame(5, '198.51.100.10'));
    for (let i = 0; i < 4; i++) abuse(10 + i, '127.0.0.1'); // loopback: exempt
    feed(offerFrame(20, '127.0.0.1'));
    expect(rejects.length).toBe(1);
    await tick(350);
    feed(offerFrame(6, '198.51.100.9'));
    expect(rejects.length).toBe(1);
    expect(t.pendingCount).toBe(3);
  });

  it('null disables it', () => {
    const { links, rejects, feed } = host({ abusePenalty: null });
    for (let i = 0; i < 6; i++) {
      feed(offerFrame(i + 1, '198.51.100.9'));
      open(links.at(-1)!);
      links.at(-1)!.ev.onMessage(0, 'text');
    }
    expect(rejects).toEqual([]);
  });
});

describe('IP bans on verified addresses', () => {
  it('the address of the selected ICE pair is checked at the handshake', async () => {
    const { t, links, feed } = host();
    let joined = 0;
    t.onPeerJoin = () => joined++;
    t.bans.addIp('203.0.113.5');
    feed(offerFrame(1, '198.51.100.20')); // conn through a proxy, not banned
    open(links[0]!, '203.0.113.5');
    handshake(links[0]!);
    await settle();
    expect(joined).toBe(0);
    expect([...links[0]!.sent.at(-1)!.subarray(0, 2)]).toEqual([5, 1]); // "You are banned from this room."
    // official behaviour
    const h2 = host({ verifiedIpBans: false });
    h2.t.bans.addIp('203.0.113.5');
    h2.feed(offerFrame(1, '198.51.100.20'));
    open(h2.links[0]!, '203.0.113.5');
    handshake(h2.links[0]!);
    await settle();
    expect(h2.t.peers.length).toBe(1);
  });

  it('public host/prflx offer candidates are checked; LAN ones and relays are not', () => {
    const { t, rejects, feed } = host();
    t.bans.addIp('203.0.113.66');
    t.bans.addRange('10.0.0.0/8');
    t.bans.addIp('198.51.100.77');
    feed(offerFrame(1, '198.51.100.1', { candidates: [cand('203.0.113.66', 'host')] }));
    feed(offerFrame(2, '198.51.100.2', { candidates: [cand('203.0.113.66', 'prflx')] }));
    feed(offerFrame(3, '198.51.100.3', { candidates: [cand('10.1.2.3', 'host')] }));
    feed(offerFrame(4, '198.51.100.4', { candidates: [cand('198.51.100.77', 'relay')] }));
    expect(rejects.map((r) => [r.peerId, r.code, r.why])).toEqual([
      [1, 4102, 'banned candidate'],
      [2, 4102, 'banned candidate'],
    ]);
    expect(t.pendingCount).toBe(2);
  });

  it('a kick-ban stores the conn IP and the public pair address, not the declared srflx IPs', async () => {
    const { t, links, feed } = host();
    const joined: Peer[] = [];
    t.onPeerJoin = (p) => joined.push(p);
    const victims = ['203.0.113.9', '203.0.113.10'];
    feed(offerFrame(1, '198.51.100.50', { candidates: [...victims, '198.51.100.51'].map((ip) => cand(ip, 'srflx')) }));
    open(links[0]!, '198.51.100.51');
    handshake(links[0]!);
    await settle();
    expect(joined[0]!.srflxIps).toEqual([...victims, '198.51.100.51']);
    const rec = t.kick(joined[0]!, { ban: true });
    expect(rec?.ips).toEqual(['198.51.100.50', '198.51.100.51']);
    for (const v of victims) expect(t.bans.isIpBanned(v)).toBe(false);
    // a private pair address (e.g. a proxy in front of the host) is never stored
    feed(offerFrame(2, '198.51.100.60'));
    open(links[1]!, '10.0.0.5');
    handshake(links[1]!);
    await settle();
    expect(t.kick(joined[1]!, { ban: true })?.ips).toEqual(['198.51.100.60']);
    // official storage: conn + declared srflx
    const h2 = host({ verifiedIpBans: false });
    let p2: Peer | null = null;
    h2.t.onPeerJoin = (p) => (p2 = p);
    h2.feed(offerFrame(1, '198.51.100.50', { candidates: [cand('203.0.113.9', 'srflx')] }));
    open(h2.links[0]!, '198.51.100.51');
    handshake(h2.links[0]!);
    await settle();
    expect(h2.t.kick(p2!, { ban: true })?.ips).toEqual(['198.51.100.50', '203.0.113.9']);
  });
});

describe('join hook decisions', () => {
  async function decide(d: () => unknown) {
    const errors: Error[] = [];
    const h = host({ onJoinRequest: () => d() as JoinDecision });
    h.t.onError = (e) => errors.push(e);
    h.feed(offerFrame(1, '198.51.100.1'));
    await tick(30);
    return { code: h.rejects[0]?.code ?? null, created: h.links.length, errors };
  }

  it('any thenable is awaited: another realm, a custom then, a rejecting one', async () => {
    const thenable = (v: unknown) => ({ then: (res: (x: unknown) => void) => setTimeout(() => res(v), 5) });
    expect(await decide(() => thenable(false))).toMatchObject({ code: 4102, created: 0 });
    expect(await decide(() => thenable({ reject: 4100 }))).toMatchObject({ code: 4100, created: 0 });
    expect(await decide(() => thenable(undefined))).toMatchObject({ code: null, created: 1 });
    expect(await decide(() => vm.runInNewContext('Promise.resolve(false)'))).toMatchObject({ code: 4102, created: 0 });
    const failing = await decide(() => ({ then: (_: unknown, rej: (e: Error) => void) => rej(new Error('db down')) }));
    expect(failing).toMatchObject({ code: 4104, created: 0 });
    expect(failing.errors.map((e) => e.message)).toEqual(['db down']);
    const throwing = await decide(() => ({
      get then() {
        throw new Error('getter');
      },
    }));
    expect(throwing).toMatchObject({ code: 4104, created: 0 });
  });

  it('values outside JoinDecision fail closed with 4104 and are reported; valid ones keep their meaning', async () => {
    for (const bad of [NaN, -1, 1.5, 70_000, { reject: undefined }, { reject: 'x' }, 'false', {}, { accept: false }]) {
      const r = await decide(() => bad);
      expect(r, String(bad)).toMatchObject({ code: 4104, created: 0 });
      expect(r.errors.length).toBe(1);
    }
    for (const [d, code] of [
      [4101, 4101],
      [0, 0],
      [{ reject: 4103 }, 4103],
      [false, 4102],
    ] as const) {
      expect(await decide(() => d)).toMatchObject({ code, created: 0, errors: [] });
    }
    for (const ok of [undefined, null, true, { accept: true }]) {
      expect(await decide(() => ok)).toMatchObject({ code: null, created: 1, errors: [] });
    }
  });
});

describe('option validation', () => {
  const mk = (o: Partial<HostTransportOptions>) => () => host(o);
  it('limits and timeouts must be usable numbers', () => {
    for (const v of [NaN, 0, -1, 1.5, Infinity]) expect(mk({ maxPendingNegotiations: v })).toThrow(RangeError);
    for (const v of [NaN, 0, 2.5]) expect(mk({ maxUnjoinedPerIp: v })).toThrow(RangeError);
    for (const v of [NaN, Infinity, 0, -5]) {
      expect(mk({ channelOpenTimeoutMs: v })).toThrow(RangeError);
      expect(mk({ peerIdleTimeoutMs: v })).toThrow(RangeError);
    }
    expect(mk({ abusePenalty: { capacity: NaN, msPerToken: 1000, blockMs: 1000 } })).toThrow(RangeError);
    expect(mk({ abusePenalty: { capacity: 1, msPerToken: 1000, blockMs: Infinity } })).toThrow(RangeError);
    expect(mk({ maxPendingNegotiations: 4, maxUnjoinedPerIp: Infinity, channelOpenTimeoutMs: 300, peerIdleTimeoutMs: 2_000 })).not.toThrow();
  });
});
