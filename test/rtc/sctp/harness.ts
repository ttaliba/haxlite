/**
 * Deterministic simulation for SctpAssociation tests: a virtual clock with a
 * single event queue (timers + packet deliveries) and a seeded lossy /
 * duplicating / reordering link between two associations.
 */
import { SctpAssociation, type SctpAssociationOptions, type SctpChannelConfig } from '../../../src/rtc/sctp/index.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ev {
  at: number;
  seq: number;
  fn: (() => void) | null;
}

export class Sim {
  now = 0;
  private seq = 0;
  private q: Ev[] = [];

  at(delay: number, fn: () => void): Ev {
    const ev: Ev = { at: this.now + Math.max(0, delay), seq: ++this.seq, fn };
    // binary insert (stable by seq)
    let lo = 0;
    let hi = this.q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.q[mid];
      if (m.at < ev.at || (m.at === ev.at && m.seq < ev.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.q.splice(lo, 0, ev);
    return ev;
  }

  setTimer = (cb: () => void, ms: number): unknown => this.at(ms, cb);
  clearTimer = (h: unknown): void => {
    (h as Ev).fn = null;
  };
  clock = (): number => this.now;

  /** Runs one event; false when the queue is empty or the next event is after `until`. */
  step(until = Infinity): boolean {
    while (this.q.length > 0) {
      const ev = this.q[0];
      if (ev.at > until) return false;
      this.q.shift();
      if (ev.fn === null) continue;
      this.now = Math.max(this.now, ev.at);
      const fn = ev.fn;
      ev.fn = null;
      fn();
      return true;
    }
    return false;
  }

  run(ms: number): void {
    const until = this.now + ms;
    while (this.step(until));
    this.now = Math.max(this.now, until);
  }

  /** Runs until `pred()` holds; returns false on timeout (virtual ms). */
  runUntil(pred: () => boolean, maxMs = 120_000): boolean {
    const until = this.now + maxMs;
    while (!pred()) if (!this.step(until)) return pred();
    return true;
  }
}

export interface LinkOptions {
  delay?: number;
  jitter?: number;
  loss?: number;
  dup?: number;
}

export interface Received {
  ch: number;
  data: Uint8Array;
}

export interface Peer {
  sctp: SctpAssociation;
  received: Received[];
  opened: boolean;
  closed: string | null;
  channelClosed: number[];
  errors: unknown[];
  /** Raw packets this side put on the wire (before loss/duplication). */
  wire: Uint8Array[];
}

export interface PairOptions {
  seed?: number;
  link?: LinkOptions;
  /** Per-direction overrides. */
  linkAB?: LinkOptions;
  linkBA?: LinkOptions;
  channels?: SctpChannelConfig[];
  opts?: Partial<SctpAssociationOptions>;
  optsA?: Partial<SctpAssociationOptions>;
  optsB?: Partial<SctpAssociationOptions>;
  recordWire?: boolean;
}

export const HAX_CHANNELS: SctpChannelConfig[] = [
  { id: 0, ordered: true },
  { id: 1, ordered: false },
  { id: 2, ordered: false, maxRetransmits: 0 },
];

export function makePair(po: PairOptions = {}): { sim: Sim; a: Peer; b: Peer; cutLink(): void; setLink(l: LinkOptions): void } {
  const sim = new Sim();
  const rnd = mulberry32(po.seed ?? 1);
  let cut = false;
  let lab: LinkOptions = { ...po.link, ...po.linkAB };
  let lba: LinkOptions = { ...po.link, ...po.linkBA };
  const mk = (name: 'a' | 'b', extra: Partial<SctpAssociationOptions> | undefined): Peer => {
    const peer: Peer = { sctp: null as unknown as SctpAssociation, received: [], opened: false, closed: null, channelClosed: [], errors: [], wire: [] };
    const rng = mulberry32((po.seed ?? 1) * 31 + (name === 'a' ? 7 : 13));
    peer.sctp = new SctpAssociation({
      send: (pkt) => {
        const copy = pkt.slice();
        if (po.recordWire) peer.wire.push(copy);
        if (cut) return;
        const l = name === 'a' ? lab : lba;
        const target = () => (name === 'a' ? B : A).sctp;
        const deliver = (): void => {
          sim.at((l.delay ?? 10) + (l.jitter ?? 0) * rnd(), () => target().input(copy.slice()));
        };
        if (rnd() < (l.loss ?? 0)) return;
        deliver();
        if (rnd() < (l.dup ?? 0)) deliver();
      },
      channels: po.channels ?? HAX_CHANNELS,
      maxMessageSize: 262144,
      onMessage: (ch, data) => {
        peer.received.push({ ch, data: data.slice() });
      },
      onOpen: () => {
        peer.opened = true;
      },
      onClose: (reason) => {
        peer.closed = reason;
      },
      onChannelClose: (id) => {
        peer.channelClosed.push(id);
      },
      onError: (e) => {
        peer.errors.push(e);
      },
      now: sim.clock,
      setTimer: sim.setTimer,
      clearTimer: sim.clearTimer,
      randomU32: () => (rng() * 4294967296) >>> 0,
      ...po.opts,
      ...extra,
    });
    return peer;
  };
  const A = mk('a', po.optsA);
  const B = mk('b', po.optsB);
  return {
    sim,
    a: A,
    b: B,
    cutLink: () => {
      cut = true;
    },
    setLink: (l) => {
      lab = { ...l };
      lba = { ...l };
    },
  };
}

/** Connects a → b and runs until both are open. */
export function connectPair(p: ReturnType<typeof makePair>, maxMs = 60_000): boolean {
  p.a.sctp.connect();
  return p.sim.runUntil(() => p.a.opened && p.b.opened, maxMs);
}

export function msg(ch: number, i: number, size = 30): Uint8Array {
  const m = new Uint8Array(Math.max(size, 8));
  const dv = new DataView(m.buffer);
  dv.setUint32(0, i);
  dv.setUint32(4, ch);
  for (let k = 8; k < m.length; k++) m[k] = (i * 7 + k * 13 + ch) & 0xff;
  return m;
}

export function msgId(m: Uint8Array): number {
  return new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(0);
}

export function checkMsg(ch: number, m: Uint8Array): boolean {
  const i = msgId(m);
  const exp = msg(ch, i, m.length);
  if (exp.length !== m.length) return false;
  for (let k = 0; k < m.length; k++) if (exp[k] !== m[k]) return false;
  return true;
}

/** Parses DATA chunks of a packet: [tsn, sid] pairs. */
export function dataChunks(pkt: Uint8Array): { tsn: number; sid: number; flags: number }[] {
  const out: { tsn: number; sid: number; flags: number }[] = [];
  let off = 12;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  while (off + 4 <= pkt.length) {
    const type = pkt[off];
    const len = dv.getUint16(off + 2);
    if (len < 4) break;
    if (type === 0) out.push({ tsn: dv.getUint32(off + 4), sid: dv.getUint16(off + 8), flags: pkt[off + 1] });
    off += (len + 3) & ~3;
  }
  return out;
}

export function chunkTypes(pkt: Uint8Array): number[] {
  const out: number[] = [];
  let off = 12;
  while (off + 4 <= pkt.length) {
    const len = (pkt[off + 2] << 8) | pkt[off + 3];
    out.push(pkt[off]);
    if (len < 4) break;
    off += (len + 3) & ~3;
  }
  return out;
}
