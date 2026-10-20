/**
 * HostTransport per-address limits when many players share one public
 * address (NAT, CGNAT, a school): the abuse penalty only counts abuse a
 * connection commits itself and limits instead of locking the address out,
 * reverse retries do not count twice, seats held without a handshake are
 * only given up to a connection that works, kick-bans never store a relay
 * address, the join hook keeps accepting values it used to accept, and bad
 * options fail at construction. Stub peer backend (no WebRTC) and a mocked
 * `performance.now()` so minutes of traffic run instantly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writer, deflateRaw } from '../../src/codec/index.js';
import { HostTransport, encodeHandshake, type HostTransportOptions, type JoinDecision, type Peer } from '../../src/net/index.js';
import type { PeerBackend, PeerLinkEvents } from '../../src/net/peer-backend.js';

interface StubLink {
  peerId: number;
  ev: PeerLinkEvents;
  closed: boolean;
  sent: Uint8Array[];
}

let clock = 1_000_000;
const transports: HostTransport[] = [];
beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  for (const t of transports.splice(0)) t.stop();
  vi.restoreAllMocks();
});

function host(opts: Partial<HostTransportOptions> = {}) {
  const links: StubLink[] = [];
  const backend: PeerBackend = {
    kind: 'stub',
    prefiltered: true,
    ready: true,
    start: () => {},
    stop: () => {},
    createPeer: (peerId, _sdp, ev) => {
      const l: StubLink = { peerId, ev, closed: false, sent: [] };
      links.push(l);
      return {
        addRemoteCandidate: () => {},
        send: (_ch, data) => (l.sent.push(data.slice()), true),
        close: () => (l.closed = true),
      };
    },
  };
  // the sweep only runs when a test calls it (the clock is mocked)
  const t = new HostTransport({ token: 'thr1.test', backend, maxPlayers: 30, sweepIntervalMs: 0x7fffffff, ...opts });
  transports.push(t);
  t.start();
  const rejects: { peerId: number; code: number; why: string }[] = [];
  t.onJoinRejected = (r, code, why) => rejects.push({ peerId: r.peerId, code, why });
  const answered: number[] = []; // every refusal code sent to the master, parse errors included
  const sendReject = t.signaling.sendReject.bind(t.signaling);
  t.signaling.sendReject = (peerId, code) => {
    answered.push(code);
    sendReject(peerId, code);
  };
  const errors: Error[] = [];
  t.onError = (e) => errors.push(e);
  const joined: Peer[] = [];
  t.onPeerJoin = (p) => joined.push(p);
  let nextId = 1;
  /** Feeds an offer; returns its link, or null when it was refused. */
  const offer = (ip: string, o: OfferOpts = {}): StubLink | null => {
    const n = links.length;
    (t.signaling as unknown as { onMessage(m: Uint8Array): void }).onMessage(offerFrame(nextId++, ip, o));
    return links.length > n ? links.at(-1)! : null;
  };
  const sweep = () => (t as unknown as { sweep(): void }).sweep();
  return { t, links, rejects, answered, errors, joined, offer, sweep };
}

interface OfferOpts {
  candidates?: unknown[];
  reverse?: boolean;
  version?: number;
  password?: string | null;
  payload?: Uint8Array;
}

function offerFrame(peerId: number, ip: string, o: OfferOpts = {}): Uint8Array {
  let z = o.payload;
  if (z === undefined) {
    const p = new Writer(256);
    p.u8(o.reverse ? 1 : 0);
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

function open(l: StubLink, remoteAddress: string | null = null): void {
  for (let i = 0; i < 3; i++) l.ev.onChannelOpen(i, i === 0 ? remoteAddress : null);
}

function handshake(l: StubLink, name = 'p'): void {
  l.ev.onMessage(0, encodeHandshake(null, { name, flag: 'ar', avatar: null }));
}

/** Lets the async handshake verification finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const NAT = '198.51.100.9';
const LIMITED = 'address blocked after abusive connections';
const OLD_DEFAULT_PENALTY = { capacity: 3, msPerToken: 20_000, blockMs: 30_000, admitEveryMs: Infinity };

describe('abuse penalty with a shared address', () => {
  /** 10 players reconnect twice in a minute, each time timing out before the handshake; then all try again. */
  function badNetworkNat(opts: Partial<HostTransportOptions>) {
    const h = host(opts);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 10; i++) {
        const l = h.offer(NAT);
        if (l !== null) open(l); // channel 0 opens, the handshake never arrives
      }
      clock += 10_000;
      h.sweep(); // idle timeout before the handshake: abusive closes
      clock += 2_000;
    }
    let admitted = 0;
    for (let i = 0; i < 10; i++) if (h.offer(NAT) !== null) admitted++;
    return { admitted, rejects: h.rejects };
  }

  it('10 players behind one NAT that each time out twice in a minute are never limited', () => {
    expect(badNetworkNat({})).toEqual({ admitted: 10, rejects: [] });
    // the defaults this replaces locked the whole address out after the 4th
    const old = badNetworkNat({ abusePenalty: OLD_DEFAULT_PENALTY });
    expect(old.admitted).toBe(0);
    expect(old.rejects.every((r) => r.why === LIMITED)).toBe(true);
  });

  it('a join -> flood -> kicked loop from 3 workers on one address stays at a few dozen joins a minute', async () => {
    const h = host();
    let attempts = 0;
    for (let step = 0; step < 600; step++, clock += 100) {
      for (let w = 0; w < 3; w++) {
        attempts++;
        const l = h.offer(NAT);
        if (l === null) continue;
        open(l);
        handshake(l);
        await settle();
        for (let i = 0; i < 110; i++) l.ev.onMessage(1, Uint8Array.of(2, i)); // flood (transport bucket of 100)
        expect(l.closed).toBe(true);
      }
    }
    expect(attempts).toBe(1800);
    // 20 tokens, then one connection every 3 s
    expect(h.joined.length).toBeGreaterThanOrEqual(20);
    expect(h.joined.length).toBeLessThanOrEqual(45);
    expect(h.joined.every((p) => p.closeReason === 'flood')).toBe(true);
  });

  /** The attacker drains the tokens, then commits one abusive close every `everyMs` from connections opened beforehand. */
  async function sharedAttack(opts: Partial<HostTransportOptions>, everyMs: number) {
    const h = host(opts);
    const banked: StubLink[] = [];
    for (let i = 0; i < 11; i++) {
      const l = h.offer(NAT)!;
      open(l);
      banked.push(l);
    }
    let a = 0;
    while (h.rejects.length === 0) {
      const l = h.offer(NAT);
      if (l === null) break;
      open(l);
      l.ev.onMessage(0, 'x'); // protocol violation
      if (++a > 100) throw new Error('never limited');
    }
    h.rejects.length = 0;
    // the victim behind the same address tries once a second for a minute
    let refusedRun = 0;
    let longestRefusedMs = 0;
    let victimIn = 0;
    const start = clock;
    let nextStrike = start + everyMs;
    for (let s = 0; s < 60; s++) {
      clock = start + s * 1_000 + 500;
      while (nextStrike <= clock && banked.length > 0) {
        banked.pop()!.ev.onMessage(0, 'x');
        nextStrike += everyMs;
      }
      const l = h.offer(NAT);
      if (l === null) {
        refusedRun += 1_000;
        longestRefusedMs = Math.max(longestRefusedMs, refusedRun);
      } else {
        refusedRun = 0;
        victimIn++;
        l.ev.onConnectionState('failed'); // (its own network) frees the slot
      }
    }
    return { victimIn, longestRefusedMs };
  }

  it('an attacker behind the same address cannot lock it out, and keeping it limited costs one abusive close every 3 s', async () => {
    // slow lane: the victim always gets in within admitEveryMs, whatever the attacker does
    for (const every of [1_000, 4_000]) {
      const r = await sharedAttack({}, every);
      expect(r.longestRefusedMs, `every ${every}`).toBeLessThanOrEqual(3_000);
      expect(r.victimIn).toBeGreaterThanOrEqual(19);
    }
    // even with admitEveryMs: Infinity (total refusal), one close every 4 s cannot keep it limited
    const strict = await sharedAttack({ abusePenalty: { capacity: 20, msPerToken: 3_000, blockMs: 30_000, admitEveryMs: Infinity } }, 4_000);
    expect(strict.longestRefusedMs).toBeLessThanOrEqual(30_000);
    expect(strict.victimIn).toBeGreaterThanOrEqual(25);
    // the defaults this replaces: one close every 4 s kept the victim out for the whole minute
    const old = await sharedAttack({ abusePenalty: OLD_DEFAULT_PENALTY }, 4_000);
    expect(old.victimIn).toBe(0);
  });

  it('closes requested by the host (the room kicking joined players as "Bad actor") are never counted', async () => {
    const h = host({ abusePenalty: { capacity: 1, msPerToken: 60_000, blockMs: 60_000 } });
    for (let i = 0; i < 30; i++) {
      const l = h.offer(NAT)!;
      open(l);
      handshake(l);
      await settle();
      h.t.close(h.joined.at(-1)!, 'protocol'); // HostRoom.badActor: a throwing script, the chat limit…
      expect(l.closed).toBe(true);
    }
    expect(h.joined.length).toBe(30);
    expect(h.rejects).toEqual([]);
    // a quiet joined player timing out is not abuse either
    for (let i = 0; i < 3; i++) {
      const l = h.offer(NAT)!;
      open(l);
      handshake(l);
      await settle();
    }
    clock += 10_000;
    h.sweep();
    expect(h.offer(NAT)).not.toBeNull();
    expect(h.rejects).toEqual([]);
  });

  it('the first abusive closes past the tokens refuse the address for admitEveryMs, then admit one at a time', () => {
    const h = host({ abusePenalty: { capacity: 1, msPerToken: 60_000, blockMs: 10_000, admitEveryMs: 2_000 } });
    for (let i = 0; i < 2; i++) {
      const l = h.offer(NAT)!;
      open(l);
      l.ev.onMessage(0, Uint8Array.of(9)); // not a handshake
    }
    expect(h.offer(NAT)).toBeNull();
    clock += 1_999;
    expect(h.offer(NAT)).toBeNull();
    expect(h.offer('198.51.100.10')).not.toBeNull(); // other addresses are not affected
    clock += 1;
    expect(h.offer(NAT)).not.toBeNull();
    expect(h.offer(NAT)).toBeNull();
    clock += 2_000;
    expect(h.offer(NAT)).not.toBeNull();
    clock += 10_000; // blockMs since the last close past the tokens
    for (let i = 0; i < 3; i++) expect(h.offer(NAT)).not.toBeNull();
    expect(h.rejects.map((r) => r.why)).toEqual([LIMITED, LIMITED, LIMITED]);
  });

  it('IPv6 addresses share the penalty and the unjoined limit per /64', () => {
    const h = host({ abusePenalty: { capacity: 1, msPerToken: 60_000, blockMs: 60_000 } });
    for (let i = 1; i <= 2; i++) {
      const l = h.offer(`2001:db8:1:2::${i}`)!;
      open(l);
      l.ev.onMessage(0, 'x');
    }
    expect(h.offer('2001:db8:1:2::99')).toBeNull();
    expect(h.offer('2001:db8:1:3::1')).not.toBeNull();
    const h2 = host();
    for (let i = 1; i <= 12; i++) expect(h2.offer(`2001:db8:5:6:${i}::1`)).not.toBeNull();
    expect(h2.offer('2001:db8:5:6:ffff::1')).toBeNull();
    expect(h2.rejects.at(-1)?.why).toBe('too many unjoined connections from this address');
  });
});

describe('seats held without a handshake', () => {
  /** A full room (2 seats): one joined player and one slow one past staleChallengeMs. */
  async function fullRoomWithSlowPlayer(opts: Partial<HostTransportOptions> = {}) {
    const h = host({ maxPlayers: 2, ...opts });
    const joined = h.offer('198.51.100.1', { password: opts.password ?? null })!;
    open(joined);
    handshake(joined);
    await settle();
    const slow = h.offer('198.51.100.2', { password: opts.password ?? null })!;
    open(slow);
    clock += 5_000;
    return { ...h, joinedLink: joined, slow };
  }

  it('an offer that is then refused (password, version, payload, ban, join hook) gives nobody\'s seat away', async () => {
    const cases: [Partial<HostTransportOptions>, OfferOpts, number][] = [
      [{ password: 'secret' }, { password: 'wrong' }, 4101],
      [{}, { version: 8 }, 4103],
      [{}, { payload: Uint8Array.of(1, 2, 3) }, 0],
      [{}, { candidates: [cand('203.0.113.66', 'srflx')] }, 4102],
      [{ onJoinRequest: (r) => r.ip !== '203.0.113.7' }, {}, 4102],
    ];
    for (const [opts, o, code] of cases) {
      const h = await fullRoomWithSlowPlayer(opts);
      h.t.bans.addIp('203.0.113.66');
      expect(h.offer('203.0.113.7', o)).toBeNull();
      await settle();
      expect(h.answered.at(-1), JSON.stringify(o)).toBe(code);
      expect(h.slow.closed).toBe(false);
      expect(h.t.connectionCount).toBe(2);
    }
  });

  it('the seat goes to a new connection once it opens channel 0, without counting against the slow player\'s address', async () => {
    const h = await fullRoomWithSlowPlayer({ abusePenalty: { capacity: 1, msPerToken: 600_000, blockMs: 600_000 } });
    let slow = h.slow;
    for (let i = 0; i < 6; i++) {
      const next = h.offer('203.0.113.7')!;
      expect(next).not.toBeNull();
      expect(slow.closed).toBe(false);
      open(next);
      expect(slow.closed).toBe(true);
      expect(h.t.connectionCount).toBe(2);
      // the slow player (same address every time) tries again and is admitted
      next.ev.onMessage(0, encodeHandshake(null, { name: 'n', flag: 'ar', avatar: null }));
      await settle();
      h.t.close(h.joined.at(-1)!, 'host');
      slow = h.offer('198.51.100.2')!;
      expect(slow).not.toBeNull();
      open(slow);
      clock += 5_000;
    }
    expect(h.rejects).toEqual([]);
  });

  it('the stale clock starts when the challenge is sent, not when channel 0 opens', async () => {
    const h = host({ maxPlayers: 1 });
    const slow = h.offer('198.51.100.2')!;
    slow.ev.onChannelOpen(0, null);
    clock += 4_000;
    slow.ev.onChannelOpen(1, null);
    slow.ev.onChannelOpen(2, null); // challenge sent now
    expect(slow.sent.length).toBe(1);
    clock += 4_000;
    expect(h.offer('203.0.113.7')).toBeNull();
    expect(h.rejects.at(-1)?.code).toBe(4100);
    clock += 1_000;
    const next = h.offer('203.0.113.8')!;
    open(next);
    expect(slow.closed).toBe(true);
    expect(slow.sent.length).toBe(1);
  });
});

describe('unjoined connections: reverse retries', () => {
  it('10 players behind one NAT whose direct attempts all fail get in with their reverse retries', () => {
    const h = host();
    const directs: StubLink[] = [];
    for (let i = 0; i < 10; i++) directs.push(h.offer(NAT)!);
    expect(directs.every((l) => l !== null)).toBe(true);
    clock += 4_200; // the official client gives up after 4 s and retries with the reverse flag
    const reverses: (StubLink | null)[] = [];
    for (let i = 0; i < 10; i++) {
      clock += 30;
      reverses.push(h.offer(NAT, { reverse: true }));
    }
    expect(h.rejects).toEqual([]);
    expect(reverses.every((l) => l !== null)).toBe(true);
    expect(directs.every((l) => l.closed)).toBe(true); // replaced
    expect(h.t.pendingCount).toBe(10);
    for (const l of reverses) {
      open(l!);
      handshake(l!);
    }
    expect(h.t.connectionCount).toBe(10);
  });

  it('a reverse offer only replaces direct attempts of its address older than 4 s; the cap still holds', () => {
    const h = host();
    const other = h.offer('198.51.100.10')!;
    const old = h.offer(NAT)!;
    clock += 3_000;
    const young = h.offer(NAT)!;
    clock += 1_000;
    expect(h.offer(NAT, { reverse: true })).not.toBeNull();
    expect([other.closed, old.closed, young.closed]).toEqual([false, true, false]);
    expect(h.offer(NAT, { reverse: true })).not.toBeNull(); // nothing left to replace: counted normally
    expect(young.closed).toBe(false);
    // abandoned direct attempts still count for direct offers: 12 at most from one address
    const h2 = host();
    for (let i = 0; i < 12; i++) h2.offer(NAT);
    clock += 5_000;
    expect(h2.offer(NAT)).toBeNull();
    expect(h2.rejects.map((r) => r.why)).toEqual(['too many unjoined connections from this address']);
    // and a reverse offer replaces one, so the total stays at 12
    expect(h2.offer(NAT, { reverse: true })).not.toBeNull();
    expect(h2.t.pendingCount).toBe(12);
  });
});

describe('kick-ban storage on verified addresses', () => {
  async function banOf(candidates: unknown[], pair: string, trickle: unknown[] = []) {
    const h = host();
    const l = h.offer('198.51.100.50', { candidates })!;
    for (const c of trickle) {
      const w = new Writer(128);
      w.u8(4);
      w.u32(l.peerId);
      const p = new Writer(128);
      p.json(c);
      w.bytes(deflateRaw(p.copyBytes()));
      (h.t.signaling as unknown as { onMessage(m: Uint8Array): void }).onMessage(w.copyBytes());
    }
    open(l, pair);
    handshake(l);
    await settle();
    return h.t.kick(h.joined[0]!, { ban: true })!.ips;
  }

  it('the pair address is stored only when the client declared it as its own (host/srflx): never a relay', async () => {
    // a client relayed through a TURN server: the pair is the server's address
    expect(await banOf([cand('198.51.100.50', 'srflx'), cand('203.0.113.200', 'relay')], '203.0.113.200')).toEqual(['198.51.100.50']);
    expect(await banOf([], '203.0.113.200')).toEqual(['198.51.100.50']);
    expect(await banOf([cand('203.0.113.9', 'host')], '203.0.113.9')).toEqual(['198.51.100.50', '203.0.113.9']);
    expect(await banOf([cand('203.0.113.9', 'srflx')], '::ffff:203.0.113.9')).toEqual(['198.51.100.50', '203.0.113.9']);
    expect(await banOf([], '203.0.113.9', [cand('203.0.113.9', 'host')])).toEqual(['198.51.100.50', '203.0.113.9']); // trickled
  });
});

describe('join hook: values outside JoinDecision', () => {
  it('accept as they always did, and are reported to onError once', async () => {
    const values: unknown[] = ['false', {}, { accept: false }, [], { ip: '198.51.100.1', banned: false }, () => false, 1n];
    let i = 0;
    const h = host({ onJoinRequest: () => values[i++] as JoinDecision });
    for (let k = 0; k < values.length; k++) expect(h.offer(`198.51.100.${k + 1}`)).not.toBeNull();
    expect(h.rejects).toEqual([]);
    expect(h.errors.map((e) => e.message)).toEqual(['onJoinRequest returned a value that is not a JoinDecision (string): the join is accepted']);
    const h2 = host({ onJoinRequest: () => Promise.resolve({ row: 1 } as unknown as JoinDecision) });
    h2.offer('198.51.100.1');
    await settle();
    expect(h2.links.length).toBe(1);
    expect(h2.errors.length).toBe(1);
  });
});

describe('option validation', () => {
  const mk = (o: Partial<HostTransportOptions>) => () => host(o);
  it('flood bucket and abusePenalty.admitEveryMs fail at construction', () => {
    for (const v of [0, -1, NaN, 0.5]) expect(mk({ floodCapacity: v })).toThrow(RangeError);
    for (const v of [0, -16, NaN, Infinity]) expect(mk({ floodMsPerToken: v })).toThrow(RangeError);
    for (const v of [0, -1, NaN]) {
      expect(mk({ abusePenalty: { capacity: 1, msPerToken: 1000, blockMs: 1000, admitEveryMs: v } })).toThrow(RangeError);
    }
    expect(mk({ abusePenalty: { capacity: 1, msPerToken: 1000, blockMs: 1000, admitEveryMs: Infinity } })).not.toThrow();
    expect(mk({ abusePenalty: { capacity: 1, msPerToken: 1000, blockMs: 1000 } })).not.toThrow();
    expect(mk({ floodCapacity: 1, floodMsPerToken: 1 })).not.toThrow();
  });
});
