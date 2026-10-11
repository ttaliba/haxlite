/**
 * Interop harness wire format and receive-side bookkeeping, shared by the
 * Node side and the browser page. The page loads this very file with its
 * types stripped (`node:module` `stripTypeScriptTypes`, served as
 * `/wire.js`), so it must stay erasable-only TypeScript with no imports.
 *
 * Every harness message: `[u8 kind][u32 seq][f64 ts][payload…]`
 * (big-endian, 13-byte header), `ts` = sender's `performance.timeOrigin +
 * performance.now()` in ms (same wall clock on both sides of the loopback).
 * `data` payload bytes are a deterministic function of `(seq, i)` so the
 * receiver can verify integrity of large (20 KB) messages.
 */

export const Kind = {
  /** Test payload: counts/order/integrity checks. */
  Data: 1,
  /** Client → server ping (uu, like the official `[2][f64 t][varint ping]`). */
  Ping: 2,
  /** Server → client ping reply: header ts = echoed client ts, then `f64 serverTs`. */
  Pong: 3,
  /** Server → all clients broadcast of a client input (ru, official type 2). Payload: `u32 origin, f64 originTs`. */
  Event: 4,
  /** Server → client frame heartbeat (uu, official type 3). */
  Heartbeat: 5,
  /** Client → server input (ro, official client action). Payload: `u32 origin`. */
  Input: 6,
} as const;

export const HEADER = 13;

export function now(): number {
  return performance.timeOrigin + performance.now();
}

function fillByte(seq: number, i: number): number {
  return (seq * 31 + i * 7 + 13) & 255;
}

/** Builds a `kind` message of total `size` bytes (≥ 13). `Data` gets the integrity pattern. */
export function makeMsg(kind: number, seq: number, size: number, ts: number = now()): Uint8Array {
  const n = Math.max(HEADER, size);
  const b = new Uint8Array(n);
  const v = new DataView(b.buffer);
  v.setUint8(0, kind);
  v.setUint32(1, seq >>> 0);
  v.setFloat64(5, ts);
  if (kind === Kind.Data) for (let i = HEADER; i < n; i++) b[i] = fillByte(seq, i);
  return b;
}

export interface Header {
  kind: number;
  seq: number;
  ts: number;
}

export function readHeader(b: Uint8Array): Header | null {
  if (b.byteLength < HEADER) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { kind: v.getUint8(0), seq: v.getUint32(1), ts: v.getFloat64(5) };
}

export function verifyData(b: Uint8Array, seq: number): boolean {
  for (let i = HEADER; i < b.byteLength; i++) if (b[i] !== fillByte(seq, i)) return false;
  return true;
}

/** Per-channel receive statistics (one per channel per connection side). */
export interface ChannelStats {
  /** Messages received (any kind). */
  count: number;
  bytes: number;
  /** `Data` messages received. */
  data: number;
  /** `Data` messages whose seq was already seen. */
  dups: number;
  /** `Data` messages with seq lower than the highest seen before them. */
  reordered: number;
  /** `Data` messages failing the payload pattern check. */
  corrupt: number;
  /** Highest `Data` seq seen (−1 if none). */
  maxSeq: number;
  /** Largest message received. */
  maxLen: number;
  /** Non-binary (string) messages: must stay 0 (binaryType = 'arraybuffer', binary sends). */
  strings: number;
}

export function newChannelStats(): ChannelStats {
  return { count: 0, bytes: 0, data: 0, dups: 0, reordered: 0, corrupt: 0, maxSeq: -1, maxLen: 0, strings: 0 };
}

/**
 * Receive bookkeeping for one connection side: per-channel stats and
 * latency samples (ms) per category.
 */
export class Recorder {
  readonly ch: ChannelStats[] = [newChannelStats(), newChannelStats(), newChannelStats()];
  /** seq bitmap per channel for duplicate detection (Data only). */
  private readonly seen: Set<number>[] = [new Set(), new Set(), new Set()];
  /** Latency samples (ms): `oneWay` from header ts, `ping` RTT, `input` input→event RTT. */
  readonly lat: { oneWay: number[]; ping: number[]; input: number[] } = { oneWay: [], ping: [], input: [] };
  /** Verify `Data` payloads byte by byte (off in benchmarks). */
  verify = true;
  /** Keep latency samples (bounded per category). */
  maxSamples = 200_000;
  /** Own origin id: `Event`s carrying it measure input→event RTT. */
  origin = -1;

  record(chIndex: number, msg: Uint8Array | string, t: number = now()): Header | null {
    const s = this.ch[chIndex];
    if (s === undefined) return null;
    s.count++;
    if (typeof msg === 'string') {
      s.strings++;
      s.bytes += msg.length;
      return null;
    }
    s.bytes += msg.byteLength;
    if (msg.byteLength > s.maxLen) s.maxLen = msg.byteLength;
    const h = readHeader(msg);
    if (h === null) return null;
    if (h.kind === Kind.Data) {
      s.data++;
      const seen = this.seen[chIndex]!;
      if (seen.has(h.seq)) s.dups++;
      else seen.add(h.seq);
      if (h.seq < s.maxSeq) s.reordered++;
      else s.maxSeq = h.seq;
      if (this.verify && !verifyData(msg, h.seq)) s.corrupt++;
      this.sample(this.lat.oneWay, t - h.ts);
    } else if (h.kind === Kind.Pong) {
      this.sample(this.lat.ping, t - h.ts);
    } else if (h.kind === Kind.Heartbeat) {
      this.sample(this.lat.oneWay, t - h.ts);
    } else if (h.kind === Kind.Event && msg.byteLength >= HEADER + 12) {
      const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
      if (v.getUint32(HEADER) === this.origin) this.sample(this.lat.input, t - v.getFloat64(HEADER + 4));
    }
    return h;
  }

  private sample(arr: number[], x: number): void {
    if (arr.length < this.maxSamples) arr.push(x);
  }

  /** Plain-object snapshot (structured-clone / JSON safe). */
  snapshot(withSamples = false): RecorderSnapshot {
    return {
      ch: this.ch.map((s) => ({ ...s })),
      lat: withSamples
        ? { oneWay: this.lat.oneWay.slice(), ping: this.lat.ping.slice(), input: this.lat.input.slice() }
        : { oneWay: [], ping: [], input: [] },
    };
  }

  resetLatency(): void {
    this.lat.oneWay.length = 0;
    this.lat.ping.length = 0;
    this.lat.input.length = 0;
  }
}

export interface RecorderSnapshot {
  ch: ChannelStats[];
  lat: { oneWay: number[]; ping: number[]; input: number[] };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function summarize(samples: number[]): { n: number; p50: number; p90: number; p99: number; max: number } {
  const s = samples.slice().sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p90: percentile(s, 90), p99: percentile(s, 99), max: s.length ? s[s.length - 1]! : NaN };
}
