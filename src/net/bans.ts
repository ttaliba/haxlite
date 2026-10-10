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
 * one record never unbans an IP still listed by another.
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

export class BanList {
  private nextId = 1;
  private readonly records = new Map<number, BanRecord>();
  private readonly ipRefs = new Map<string, number>();
  private readonly authRefs = new Map<string, number>();
  private ranges: StoredRange[] = [];

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
    if (rec.kind === 'range') this.ranges = this.ranges.filter((r) => r.id !== id);
    return true;
  }

  /** Removes everything (`clearBans`). */
  clear(): void {
    this.records.clear();
    this.ipRefs.clear();
    this.authRefs.clear();
    this.ranges = [];
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
    const rs = this.ranges;
    for (let i = 0; i < rs.length; i++) if (rs[i]!.range.contains(bytes)) return true;
    return false;
  }

  isAuthBanned(auth: string | null): boolean {
    return auth !== null && this.authRefs.has(auth);
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
