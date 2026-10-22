/**
 * Ban lists evaluated at signaling time (before any WebRTC object exists).
 *
 * Official behavior (`Aa.vg/$g/Vg/Cd/Dd`): banning a player stores its `conn`
 * (client IP seen by the master) and every srflx IP from its ICE candidates;
 * an offer whose conn or any srflx candidate IP is listed is rejected with
 * 4102, and trickled srflx candidates with a banned IP are ignored.
 * `clearBan(id)` removes one player's entries, `clearBans()` all.
 *
 * haxlite adds: single IPs, CIDR ranges (IPv4/IPv6) and `auth` bans (the
 * public key, known only after the data-channel handshake). Every entry is a
 * {@link BanRecord} with an id; IP entries are reference-counted so removing
 * one record never unbans an IP still listed by another. Ranges are looked up
 * in a merged, sorted interval index (binary search) rebuilt lazily after the
 * list changes, so a lookup does not scan every listed range.
 */
import { IpRange, canonicalIp, formatIp, parseIp } from './ip.js';

export type BanKind = 'peer' | 'ip' | 'range' | 'auth';

export interface BanRecord {
  readonly id: number;
  readonly kind: BanKind;
  /** Canonical IPs (kind `peer`/`ip`). */
  readonly ips: readonly string[];
  /** CIDR text (kind `range`). */
  readonly range: string | null;
  /** Public key (kind `auth`, or `peer` when banned with `auth: true`). */
  readonly auth: string | null;
  /** Free text for the operator (player name, reason…). */
  readonly note: string | null;
  readonly createdAt: number;
}

interface StoredRange {
  readonly id: number;
  readonly range: IpRange;
}

const EMPTY = new Uint32Array(0);

export class BanList {
  private nextId = 1;
  private readonly records = new Map<number, BanRecord>();
  private readonly ipRefs = new Map<string, number>();
  private readonly authRefs = new Map<string, number>();
  private ranges: StoredRange[] = [];
  /**
   * Union of {@link ranges} per address family: sorted, disjoint `[lo, hi]`
   * pairs of big-endian 32-bit words (1 word per bound for IPv4, 4 for IPv6).
   */
  private v4: Uint32Array = EMPTY;
  private v6: Uint32Array = EMPTY;
  /** The interval index no longer matches {@link ranges}. */
  private stale = false;

  /** Bans the exact IPs (conn IP + srflx IPs) and optionally the auth of a peer (official kick-ban). */
  addPeer(ips: readonly string[], auth: string | null = null, note: string | null = null): BanRecord {
    const canon: string[] = [];
    for (const ip of ips) {
      const c = canonicalIp(ip);
      if (c !== null && canon.indexOf(c) < 0) canon.push(c);
    }
    return this.store('peer', canon, null, auth, note);
  }

  /** Bans one IP. Throws on an invalid literal. */
  addIp(ip: string, note: string | null = null): BanRecord {
    const c = canonicalIp(ip);
    if (c === null) throw new TypeError(`invalid IP: ${ip}`);
    return this.store('ip', [c], null, null, note);
  }

  /** Bans a CIDR range such as `203.0.113.0/24` or `2001:db8::/32`. Throws if invalid. */
  addRange(cidr: string, note: string | null = null): BanRecord {
    const r = IpRange.parse(cidr);
    if (r === null) throw new TypeError(`invalid CIDR range: ${cidr}`);
    const rec = this.store('range', [], r.toString(), null, note);
    this.ranges.push({ id: rec.id, range: r });
    this.stale = true;
    return rec;
  }

  /** Bans a player public key (`player.auth`). */
  addAuth(auth: string, note: string | null = null): BanRecord {
    return this.store('auth', [], null, auth, note);
  }

  /** Removes one record (`clearBan`). */
  remove(id: number): boolean {
    const rec = this.records.get(id);
    if (rec === undefined) return false;
    this.records.delete(id);
    for (const ip of rec.ips) decRef(this.ipRefs, ip);
    if (rec.auth !== null) decRef(this.authRefs, rec.auth);
    if (rec.kind === 'range') {
      this.ranges = this.ranges.filter((r) => r.id !== id);
      this.stale = true;
    }
    return true;
  }

  /** Removes everything (`clearBans`). */
  clear(): void {
    this.records.clear();
    this.ipRefs.clear();
    this.authRefs.clear();
    this.ranges = [];
    this.v4 = this.v6 = EMPTY;
    this.stale = false;
  }

  get(id: number): BanRecord | undefined {
    return this.records.get(id);
  }

  list(): BanRecord[] {
    return [...this.records.values()];
  }

  get size(): number {
    return this.records.size;
  }

  /** Whether an IP literal is banned (exact or by range). Non-IP strings are never banned. */
  isIpBanned(ip: string): boolean {
    const bytes = parseIp(ip);
    if (bytes === null) return false;
    if (this.ipRefs.size > 0 && this.ipRefs.has(formatIp(bytes))) return true;
    if (this.ranges.length === 0) return false;
    if (this.stale) this.reindex();
    if (bytes.length === 4) {
      return inIntervals4(this.v4, ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0);
    }
    return inIntervals6(this.v6, bytes);
  }

  isAuthBanned(auth: string | null): boolean {
    return auth !== null && this.authRefs.has(auth);
  }

  private reindex(): void {
    const r4: IpRange[] = [];
    const r6: IpRange[] = [];
    for (const s of this.ranges) (s.range.base.length === 4 ? r4 : r6).push(s.range);
    this.v4 = mergeRanges(r4, 1);
    this.v6 = mergeRanges(r6, 4);
    this.stale = false;
  }

  private store(kind: BanKind, ips: string[], range: string | null, auth: string | null, note: string | null): BanRecord {
    const rec: BanRecord = { id: this.nextId++, kind, ips, range, auth, note, createdAt: Date.now() };
    this.records.set(rec.id, rec);
    for (const ip of ips) incRef(this.ipRefs, ip);
    if (auth !== null) incRef(this.authRefs, auth);
    return rec;
  }
}

function incRef(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function decRef(m: Map<string, number>, k: string): void {
  const n = (m.get(k) ?? 0) - 1;
  if (n <= 0) m.delete(k);
  else m.set(k, n);
}

/** Orders `n` big-endian words of `a` at `ai` against those of `b` at `bi`: -1, 0 or 1. */
function cmpWords(a: Uint32Array, ai: number, b: Uint32Array, bi: number, n: number): number {
  for (let i = 0; i < n; i++) {
    const x = a[ai + i]!;
    const y = b[bi + i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function putWords(dst: Uint32Array, at: number, bytes: Uint8Array, words: number): void {
  for (let w = 0; w < words; w++) {
    dst[at + w] = (bytes[w * 4]! << 24) | (bytes[w * 4 + 1]! << 16) | (bytes[w * 4 + 2]! << 8) | bytes[w * 4 + 3]!;
  }
}

/**
 * Union of same-family `ranges` as sorted, disjoint `[lo, hi]` pairs, each
 * bound being `words` big-endian 32-bit words, laid out flat.
 */
function mergeRanges(ranges: readonly IpRange[], words: number): Uint32Array {
  const n = ranges.length;
  if (n === 0) return EMPTY;
  const stride = words * 2;
  const raw = new Uint32Array(n * stride);
  for (let i = 0; i < n; i++) {
    putWords(raw, i * stride, ranges[i]!.base, words);
    putWords(raw, i * stride + words, ranges[i]!.last(), words);
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => cmpWords(raw, a * stride, raw, b * stride, words));
  const out = new Uint32Array(n * stride);
  let end = 0;
  for (let k = 0; k < n; k++) {
    const at = order[k]! * stride;
    if (end > 0 && cmpWords(raw, at, out, end - words, words) <= 0) {
      // overlaps the previous interval: only its upper bound can grow
      if (cmpWords(raw, at + words, out, end - words, words) > 0) out.set(raw.subarray(at + words, at + stride), end - words);
    } else {
      out.set(raw.subarray(at, at + stride), end);
      end += stride;
    }
  }
  return out.slice(0, end);
}

/** Whether `x` (unsigned 32-bit) lies in one of the sorted, disjoint `[lo, hi]` pairs. */
function inIntervals4(iv: Uint32Array, x: number): boolean {
  let lo = 0;
  let hi = iv.length >> 1;
  // first interval starting above x
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (iv[mid << 1]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && x <= iv[(lo << 1) - 1]!;
}

/** Orders the 128-bit value at `iv[at..at+3]` against `a0..a3`: negative, 0 or positive. */
function cmp128(iv: Uint32Array, at: number, a0: number, a1: number, a2: number, a3: number): number {
  const x0 = iv[at]!;
  if (x0 !== a0) return x0 < a0 ? -1 : 1;
  const x1 = iv[at + 1]!;
  if (x1 !== a1) return x1 < a1 ? -1 : 1;
  const x2 = iv[at + 2]!;
  if (x2 !== a2) return x2 < a2 ? -1 : 1;
  const x3 = iv[at + 3]!;
  return x3 === a3 ? 0 : x3 < a3 ? -1 : 1;
}

/** Like {@link inIntervals4} for 16 address bytes against 128-bit pairs. */
function inIntervals6(iv: Uint32Array, b: Uint8Array): boolean {
  const a0 = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const a1 = ((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!) >>> 0;
  const a2 = ((b[8]! << 24) | (b[9]! << 16) | (b[10]! << 8) | b[11]!) >>> 0;
  const a3 = ((b[12]! << 24) | (b[13]! << 16) | (b[14]! << 8) | b[15]!) >>> 0;
  let lo = 0;
  let hi = iv.length >> 3;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp128(iv, mid << 3, a0, a1, a2, a3) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && cmp128(iv, ((lo - 1) << 3) + 4, a0, a1, a2, a3) >= 0;
}
