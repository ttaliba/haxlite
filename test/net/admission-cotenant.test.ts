/**
 * HostTransport admission against a co-tenant (another client behind the
 * same public address) and against join hooks with unusual results: the
 * abuse penalty's slow lane is only taken by a connection that works, a
 * reverse retry only cancels a direct attempt when a place is needed,
 * `{accept: false}` refuses, a decision that throws when read is refused at
 * once, and `abusePenalty.admitEveryMs` has no ambiguous value. Stub peer
 * backend (no WebRTC) and a mocked `performance.now()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writer, deflateRaw } from '../../src/codec/index.js';
import { HostTransport, encodeHandshake, type HostTransportOptions, type JoinDecision, type Peer } from '../../src/net/index.js';
import type { PeerBackend, PeerLinkEvents } from '../../src/net/peer-backend.js';

interface StubLink {
  peerId: number;
  ev: PeerLinkEvents;
  closed: boolean;
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

interface OfferOpts {
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
    p.json([]);
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

function host(opts: Partial<HostTransportOptions> = {}) {
  const links: StubLink[] = [];
  const backend: PeerBackend = {
    kind: 'stub',
    prefiltered: true,
    ready: true,
    start: () => {},
    stop: () => {},
    createPeer: (peerId, _sdp, ev) => {
      const l: StubLink = { peerId, ev, closed: false };
      links.push(l);
      return { addRemoteCandidate: () => {}, send: () => true, close: () => (l.closed = true) };
    },
  };
  const t = new HostTransport({ token: 'thr1.test', backend, maxPlayers: 100, sweepIntervalMs: 0x7fffffff, ...opts });
  transports.push(t);
  t.start();
  const rejects: { peerId: number; code: number; why: string }[] = [];
  t.onJoinRejected = (r, code, why) => rejects.push({ peerId: r.peerId, code, why });
  const answered: number[] = [];
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
  const offer = (ip: string, o: OfferOpts = {}): StubLink | null => {
    const n = links.length;
    (t.signaling as unknown as { onMessage(m: Uint8Array): void }).onMessage(offerFrame(nextId++, ip, o));
    return links.length > n ? links.at(-1)! : null;
  };
  const sweep = () => (t as unknown as { sweep(): void }).sweep();
  return { t, links, rejects, answered, errors, joined, offer, sweep };
}

function open(l: StubLink): void {
  for (let i = 0; i < 3; i++) l.ev.onChannelOpen(i, null);
}

function handshake(l: StubLink, name = 'p'): void {
  l.ev.onMessage(0, encodeHandshake(null, { name, flag: 'ar', avatar: null }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

const flood = (l: StubLink) => {
  for (let i = 0; i < 110; i++) l.ev.onMessage(1, Uint8Array.of(2, i));
};

const NAT = '198.51.100.9';
const LIMITED = 'address blocked after abusive connections';
const PW = 'pw';

describe('abusePenalty options', () => {
  // first in the file: the notice is given once per process
  it('an object without admitEveryMs gets the slow lane, said once on log', () => {
    const logs: string[] = [];
    host({ abusePenalty: { capacity: 3, msPerToken: 20_000, blockMs: 30_000 }, log: (m) => logs.push(m) });
    host({ abusePenalty: { capacity: 3, msPerToken: 20_000, blockMs: 30_000 }, log: (m) => logs.push(m) });
    host({ abusePenalty: { capacity: 3, msPerToken: 20_000, blockMs: 30_000, admitEveryMs: Infinity }, log: (m) => logs.push(m) });
    const notices = logs.filter((m) => m.includes('abusePenalty without admitEveryMs'));
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('admitEveryMs: Infinity');
  });

  it('admitEveryMs: 0 fails at construction and says what to use instead', () => {
    const mk = () => host({ abusePenalty: { capacity: 1, msPerToken: 1000, blockMs: 1000, admitEveryMs: 0 } });
    expect(mk).toThrow(RangeError);
    expect(mk).toThrow(/Infinity refuses every new connection.*abusePenalty: null disables/);
  });

  it('admitEveryMs: Infinity refuses every connection while limited (the earlier behaviour)', () => {
    const h = host({ abusePenalty: { capacity: 1, msPerToken: 60_000, blockMs: 10_000, admitEveryMs: Infinity } });
    for (let i = 0; i < 2; i++) {
      const l = h.offer(NAT)!;
      open(l);
      l.ev.onMessage(0, 'x');
    }
    for (let s = 0; s < 9; s++, clock += 1_000) expect(h.offer(NAT)).toBeNull();
    clock += 1_000;
    expect(h.offer(NAT)).not.toBeNull();
  });
});

describe('slow lane against a co-tenant', () => {
  /**
   * The attacker joins bots, floods 21 of them to limit the address and
   * floods one more every second to keep it limited. Meanwhile, every 100 ms
   * (always before the victim in the same tick) it sends an offer that will
   * not work: garbage payload, wrong password, wrong version, a negotiation
   * that fails at once or after 300 ms, or one that never completes (every
   * 2 s, swept after 10 s). Legitimate players behind the same address try
   * once a second; their channel 0 opens 200 ms after the offer.
   */
  async function cotenant(opts: Partial<HostTransportOptions> = {}) {
    const h = host({ password: PW, ...opts });
    const bots: StubLink[] = [];
    for (let i = 0; i < 60; i++) {
      const l = h.offer(NAT, { password: PW })!;
      open(l);
      handshake(l, `bot${i}`);
      await settle();
      bots.push(l);
    }
    for (let i = 0; i < 21; i++) flood(bots.pop()!);
    expect(h.offer(NAT, { password: PW })).toBeNull();
    expect(h.rejects.at(-1)?.why).toBe(LIMITED);
    const timers: { at: number; fn: () => void | Promise<void> }[] = [];
    const blockedUntil = (h.t as unknown as { blockedUntil: Map<string, number> }).blockedUntil;
    const start = clock;
    let tryingSince = start;
    let victim: StubLink | null = null;
    let victimsIn = 0;
    let longestWaitMs = 0;
    let attackerOffers = 0;
    let stillLimited = true;
    for (let step = 1; step <= 300; step++) {
      clock = start + step * 100;
      for (let i = timers.length - 1; i >= 0; i--) {
        if (timers[i]!.at > clock) continue;
        const { fn } = timers[i]!;
        timers.splice(i, 1);
        await fn();
      }
      if (step % 10 === 0) {
        flood(bots.pop()!);
        h.sweep();
      }
      // the attacker
      attackerOffers++;
      const kind = step % 20 === 0 ? 'hang' : ['garbage', 'password', 'version', 'fail', 'failLater'][step % 5]!;
      if (kind === 'garbage') h.offer(NAT, { payload: Uint8Array.of(1, 2, 3) });
      else if (kind === 'password') h.offer(NAT, { password: 'guess' });
      else if (kind === 'version') h.offer(NAT, { version: 8, password: PW });
      else {
        const l = h.offer(NAT, { password: PW });
        if (l !== null && kind === 'fail') l.ev.onConnectionState('failed');
        if (l !== null && kind === 'failLater') timers.push({ at: clock + 300, fn: () => l.ev.onConnectionState('failed') });
      }
      // the victim
      if (step % 10 === 5 && victim === null) {
        const l = h.offer(NAT, { password: PW });
        if (l !== null) {
          victim = l;
          timers.push({
            at: clock + 200,
            fn: async () => {
              open(l);
              if (l.closed) {
                victim = null; // lost the slot: tries again
                return;
              }
              handshake(l, 'victim');
              await settle(); // signature verification
              if (h.joined.at(-1)?.info?.name !== 'victim') throw new Error('victim not joined');
              victimsIn++;
              longestWaitMs = Math.max(longestWaitMs, clock - tryingSince);
              tryingSince = clock; // the next player starts trying
              victim = null;
            },
          });
        }
      }
      stillLimited &&= (blockedUntil.get(NAT) ?? 0) > clock;
    }
    longestWaitMs = Math.max(longestWaitMs, clock - tryingSince);
    return { victimsIn, longestWaitMs, attackerOffers, stillLimited, h };
  }

  it('a co-tenant opening connections that fail cannot keep legitimate players out: worst wait ~4.2 s with the defaults', async () => {
    const r = await cotenant();
    // admitEveryMs (3 s) + the victim's retry period (1 s) + its negotiation (0.2 s)
    expect(r.longestWaitMs).toBeLessThanOrEqual(4_200);
    expect(r.victimsIn).toBeGreaterThanOrEqual(7);
    expect(r.attackerOffers).toBe(300);
    expect(r.stillLimited).toBe(true);
    expect(r.h.errors).toEqual([]);
  });

  it('offers refused after the address check or failing negotiations take no slot', () => {
    const h = host({ password: PW, abusePenalty: { capacity: 1, msPerToken: 600_000, blockMs: 60_000, admitEveryMs: 5_000 } });
    for (let i = 0; i < 2; i++) {
      const l = h.offer(NAT, { password: PW })!;
      open(l);
      l.ev.onMessage(0, 'x');
    }
    clock += 5_000;
    expect(h.offer(NAT, { payload: Uint8Array.of(1, 2, 3) })).toBeNull();
    expect(h.offer(NAT, { password: 'nope' })).toBeNull();
    expect(h.offer(NAT, { version: 3, password: PW })).toBeNull();
    h.offer(NAT, { password: PW })!.ev.onConnectionState('failed');
    const hanging = h.offer(NAT, { password: PW })!;
    expect(h.answered).toEqual([0, 4101, 4103]);
    // the slot is still free: the next connection that works gets it
    const ok = h.offer(NAT, { password: PW })!;
    open(ok);
    expect(ok.closed).toBe(false);
    expect(h.offer(NAT, { password: PW })).toBeNull();
    expect(h.rejects.at(-1)?.why).toBe(LIMITED);
    // a connection admitted in the same window that opens channel 0 afterwards is closed before the challenge
    open(hanging);
    expect(hanging.closed).toBe(true);
    expect(h.t.connectionCount).toBe(1);
    clock += 5_000;
    expect(h.offer(NAT, { password: PW })).not.toBeNull();
  });

  it('closing the second connection of a window is not abuse; connections admitted before the limit are not gated', () => {
    const h = host({ abusePenalty: { capacity: 1, msPerToken: 600_000, blockMs: 20_000, admitEveryMs: 3_000 } });
    const early = h.offer(NAT)!; // negotiating when the address gets limited
    for (let i = 0; i < 2; i++) {
      const l = h.offer(NAT)!;
      open(l);
      l.ev.onMessage(0, 'x');
    }
    clock += 3_000;
    const a = h.offer(NAT)!;
    const b = h.offer(NAT)!;
    open(a);
    open(b);
    open(early);
    expect([a.closed, b.closed, early.closed]).toEqual([false, true, false]);
    // b was not counted: the limit still ends blockMs after the last abusive close
    clock += 17_001;
    for (let i = 0; i < 3; i++) expect(h.offer(NAT)).not.toBeNull();
  });
});

describe('reverse retries below the caps', () => {
  it('a reverse offer from the same NAT does not cancel another player\'s slow direct attempt', async () => {
    const h = host();
    const slow = h.offer(NAT)!; // a client that does not retry, or a slow mobile link
    clock += 5_000;
    const other = h.offer(NAT, { reverse: true })!;
    expect(other).not.toBeNull();
    expect(slow.closed).toBe(false);
    clock += 2_000; // channel 0 opens at 7 s, within channelOpenTimeoutMs
    open(slow);
    handshake(slow, 'slow');
    await settle();
    expect(h.joined.map((p) => p.info?.name)).toEqual(['slow']);
  });

  it('a reverse offer replaces an abandoned attempt when the negotiation table would be full', () => {
    const h = host({ maxPendingNegotiations: 4 });
    const directs = [h.offer(NAT)!, h.offer(NAT)!];
    h.offer('198.51.100.10');
    clock += 4_500;
    expect(h.offer(NAT, { reverse: true })).not.toBeNull();
    expect(directs.map((l) => l.closed)).toEqual([true, false]);
    expect(h.t.pendingCount).toBe(3);
  });
});

describe('join hook decisions', () => {
  const decide = async (d: unknown) => {
    const h = host({ onJoinRequest: () => d as JoinDecision });
    const l = h.offer('198.51.100.1');
    await settle();
    return { admitted: l !== null || h.links.length > 0, code: h.answered.at(-1), errors: h.errors.map((e) => e.message), pending: h.t.pendingCount };
  };

  it('{accept: false} refuses with 4102, sync or async, without a report', async () => {
    expect(await decide({ accept: false })).toEqual({ admitted: false, code: 4102, errors: [], pending: 0 });
    expect(await decide(Promise.resolve({ accept: false }))).toEqual({ admitted: false, code: 4102, errors: [], pending: 0 });
    // a thenable that resolves to another thenable
    const inner = { then: (ok: (v: unknown) => void) => ok({ accept: false }) };
    const outer = { then: (ok: (v: unknown) => void) => ok(inner) };
    expect(await decide(outer)).toEqual({ admitted: false, code: 4102, errors: [], pending: 0 });
    // the moderation script of the report: every refused address stays out, not only the first
    const vetoed = new Set(['198.51.100.1', '198.51.100.2', '198.51.100.3']);
    const h = host({ onJoinRequest: async (r) => ({ accept: !vetoed.has(r.ip) }) });
    for (let i = 1; i <= 4; i++) h.offer(`198.51.100.${i}`);
    await settle();
    expect(h.answered).toEqual([4102, 4102, 4102]);
    expect(h.links.length).toBe(1);
  });

  it('{accept: true} and objects without reject/accept still accept', async () => {
    expect((await decide({ accept: true })).admitted).toBe(true);
    expect((await decide({ row: 1 })).admitted).toBe(true);
    expect((await decide(Promise.resolve({ accept: true }))).admitted).toBe(true);
  });

  it('an accept key that is not a boolean refuses with 4104 and is reported every time', async () => {
    for (const v of [{ accept: 'no' }, { accept: undefined }, { accept: 1 }]) {
      const r = await decide(v);
      expect(r.code, JSON.stringify(v)).toBe(4104);
      expect(r.errors).toEqual(['onJoinRequest returned an invalid decision (object)']);
    }
  });

  it('a decision that throws when read is refused at once with 4104, not left to the join timeout', async () => {
    const getter = {
      get reject(): number {
        throw new Error('lazy field');
      },
    };
    const trap = new Proxy({}, { has: () => { throw new Error('has trap'); } });
    const cases: [unknown, string][] = [
      [getter, 'lazy field'],
      [trap, 'has trap'],
      [Promise.resolve(getter), 'lazy field'],
      [Promise.resolve(trap), 'has trap'],
      [{ then: (ok: (v: unknown) => void) => ok({ then: (ok2: (v: unknown) => void) => ok2(trap) }) }, 'has trap'],
    ];
    for (const [d, msg] of cases) {
      const r = await decide(d);
      expect(r).toEqual({ admitted: false, code: 4104, errors: [msg], pending: 0 });
    }
  });

  it('a hook that throws a value that cannot be printed is still refused', async () => {
    const evil = new Proxy({}, { getPrototypeOf: () => { throw new Error('no proto'); } });
    const h = host({
      onJoinRequest: () => {
        throw evil;
      },
    });
    expect(h.offer('198.51.100.1')).toBeNull();
    expect(h.answered).toEqual([4104]);
    expect(h.errors.length).toBe(1);
    expect(h.t.pendingCount).toBe(0);
  });
});
