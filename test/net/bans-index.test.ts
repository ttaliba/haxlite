/**
 * BanList range lookup: the merged-interval index must answer exactly like a
 * linear scan over the listed ranges (`IpRange.contains`) plus the exact-IP
 * records, across adds, removals and clears.
 */
import { describe, expect, it } from 'vitest';
import { BanList, IpRange, canonicalIp, formatIp, parseIp } from '../../src/net/index.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
const byte = (r: Rng): number => Math.floor(r() * 256);

const V4_ANCHORS = ['10.0.0.0', '192.168.0.0', '203.0.113.0', '127.0.0.0', '255.255.0.0', '0.0.0.0', '172.16.0.0', '128.0.0.0'];
const V6_ANCHORS = ['2001:db8::', 'fe80::', '::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '8000::', '::1', '2001:db8:8000::', '64:ff9b::'];

/** Random address bytes clustered around a few anchors so ranges overlap and nest. */
function near(r: Rng, anchors: readonly string[], len: number): Uint8Array {
  if (r() < 0.2) return Uint8Array.from({ length: len }, () => byte(r));
  const a = parseIp(pick(r, anchors))!.slice();
  const k = 1 + Math.floor(r() * (len === 4 ? 3 : 14));
  for (let i = len - k; i < len; i++) a[i] = byte(r);
  return a;
}

function randomRangeText(r: Rng): string {
  const f = r();
  if (f < 0.68) {
    const base = near(r, V4_ANCHORS, 4);
    if (r() < 0.1) return formatIp(base);
    const p = r() < 0.005 ? 0 : pick(r, [1, 8, 8, 12, 16, 16, 20, 24, 24, 24, 28, 30, 31, 32, 32]);
    return `${formatIp(base)}/${p}`;
  }
  if (f < 0.93) {
    const base = near(r, V6_ANCHORS, 16);
    if (r() < 0.1) return formatIp(base);
    const p = r() < 0.005 ? 0 : pick(r, [1, 2, 16, 32, 32, 48, 56, 64, 64, 96, 112, 120, 126, 127, 128]);
    return `${formatIp(base)}/${p}`;
  }
  const base = near(r, V4_ANCHORS, 4);
  if (r() < 0.2) return `::ffff:${formatIp(base)}`;
  return `::ffff:${formatIp(base)}/${96 + pick(r, [1, 8, 16, 24, 32])}`;
}

function randomIpText(r: Rng): string {
  const f = r();
  if (f < 0.55) return formatIp(near(r, V4_ANCHORS, 4));
  if (f < 0.85) {
    const t = formatIp(near(r, V6_ANCHORS, 16));
    return r() < 0.1 ? `[${t.toUpperCase()}]` : t;
  }
  if (f < 0.95) return `::ffff:${formatIp(near(r, V4_ANCHORS, 4))}`;
  return pick(r, ['not-an-ip', '', '1.2.3', 'abc.local', 'fe80::1%eth0']);
}

/** Highest address of `r`, computed bit by bit. */
function lastOf(r: IpRange): Uint8Array {
  const out = r.base.slice();
  for (let bit = r.prefix; bit < out.length * 8; bit++) out[bit >> 3]! |= 0x80 >> (bit & 7);
  return out;
}

/** `b` plus `d` (+1 or -1) as big-endian integers, or null when it would wrap. */
function step(b: Uint8Array, d: 1 | -1): Uint8Array | null {
  const out = b.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const v = out[i]! + d;
    if (v >= 0 && v <= 255) {
      out[i] = v;
      return out;
    }
    out[i] = d > 0 ? 0 : 255;
  }
  return null;
}

interface Entry {
  readonly id: number;
  readonly ips: readonly string[];
  readonly range: IpRange | null;
}

/** The reference: every record scanned one by one, with the plain `IpRange.contains`. */
class Linear {
  entries: Entry[] = [];

  isIpBanned(ip: string): boolean {
    const bytes = parseIp(ip);
    if (bytes === null) return false;
    const canon = formatIp(bytes);
    for (const e of this.entries) {
      if (e.ips.includes(canon)) return true;
      if (e.range !== null && e.range.contains(bytes)) return true;
    }
    return false;
  }
}

/** Applies one random change to `bl` and `ref` alike. */
function mutate(r: Rng, bl: BanList, ref: Linear, maxRanges: number): void {
  const f = r();
  const nRanges = ref.entries.filter((e) => e.range !== null).length;
  if (f < 0.45 && nRanges < maxRanges) {
    const text = randomRangeText(r);
    const rec = bl.addRange(text);
    ref.entries.push({ id: rec.id, ips: [], range: IpRange.parse(text) });
  } else if (f < 0.55) {
    const v4 = r() < 0.7;
    const text = formatIp(near(r, v4 ? V4_ANCHORS : V6_ANCHORS, v4 ? 4 : 16));
    const rec = bl.addIp(text);
    ref.entries.push({ id: rec.id, ips: [canonicalIp(text)!], range: null });
  } else if (f < 0.65) {
    const texts: string[] = [];
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) texts.push(r() < 0.1 ? 'host.local' : r() < 0.7 ? formatIp(near(r, V4_ANCHORS, 4)) : formatIp(near(r, V6_ANCHORS, 16)));
    const rec = bl.addPeer(texts, r() < 0.3 ? 'AUTH' : null);
    const ips = [...new Set(texts.map((t) => canonicalIp(t)).filter((c): c is string => c !== null))];
    ref.entries.push({ id: rec.id, ips, range: null });
  } else if (f < 0.85 && ref.entries.length > 0) {
    const at = Math.floor(r() * ref.entries.length);
    expect(bl.remove(ref.entries[at]!.id)).toBe(true);
    ref.entries.splice(at, 1);
  } else if (f < 0.86) {
    bl.clear();
    ref.entries = [];
  } else {
    expect(bl.remove(1e9)).toBe(false);
  }
}

/** Query set: random IPs plus the edges (and their neighbours) of listed ranges. */
function queries(r: Rng, ref: Linear, n: number): string[] {
  const out: string[] = [];
  const ranges = ref.entries.filter((e) => e.range !== null).map((e) => e.range!);
  for (let i = 0; i < n; i++) {
    if (ranges.length > 0 && r() < 0.5) {
      const rg = pick(r, ranges);
      const edge = r() < 0.5 ? rg.base : lastOf(rg);
      const b = r() < 0.5 ? edge : step(edge, r() < 0.5 ? 1 : -1) ?? edge;
      out.push(r() < 0.1 && b.length === 4 ? `::ffff:${formatIp(b)}` : formatIp(b));
    } else {
      out.push(randomIpText(r));
    }
  }
  return out;
}

function compare(bl: BanList, ref: Linear, ips: readonly string[], bad: string[], tally: { hit: number; miss: number }): void {
  for (const ip of ips) {
    const want = ref.isIpBanned(ip);
    if (bl.isIpBanned(ip) !== want) bad.push(`${ip}: expected ${want}`);
    if (want) tally.hit++;
    else tally.miss++;
  }
}

describe('BanList range index', () => {
  it('IpRange.last is the highest address of the range', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const rg = IpRange.parse(randomRangeText(r))!;
      expect(Array.from(rg.last())).toEqual(Array.from(lastOf(rg)));
    }
  });

  it('matches a linear scan on 100000 random IPs over random lists with adds, removals and clears', () => {
    const bad: string[] = [];
    const tally = { hit: 0, miss: 0 };
    let total = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = mulberry32(seed * 7919);
      const bl = new BanList();
      const ref = new Linear();
      const maxRanges = 20 + seed * 35;
      let done = 0;
      let ops = 0;
      while (done < 12_500) {
        const burst = 1 + Math.floor(r() * 3);
        for (let i = 0; i < burst; i++) mutate(r, bl, ref, maxRanges);
        const qs = queries(r, ref, Math.min(12_500 - done, 1 + Math.floor(r() * 60)));
        compare(bl, ref, qs, bad, tally);
        done += qs.length;
        if (++ops % 40 === 0) expect(bl.list().map((x) => x.id)).toEqual(ref.entries.map((e) => e.id));
      }
      total += done;
      expect(bl.size).toBe(ref.entries.length);
    }
    expect(total).toBe(100_000);
    expect(bad.slice(0, 10)).toEqual([]);
    // the sets must exercise both outcomes
    expect(tally.hit).toBeGreaterThan(total * 0.1);
    expect(tally.miss).toBeGreaterThan(total * 0.1);
  });

  it('matches a linear scan on a large list', () => {
    const r = mulberry32(424242);
    const bl = new BanList();
    const ref = new Linear();
    for (let i = 0; i < 3000; i++) {
      // narrow prefixes only, so the list leaves gaps to miss in
      let text = randomRangeText(r);
      for (let rg = IpRange.parse(text)!; rg.prefix < (rg.base.length === 4 ? 14 : 28); rg = IpRange.parse(text)!) text = randomRangeText(r);
      ref.entries.push({ id: bl.addRange(text).id, ips: [], range: IpRange.parse(text) });
    }
    const bad: string[] = [];
    const tally = { hit: 0, miss: 0 };
    compare(bl, ref, queries(r, ref, 15_000), bad, tally);
    // drop a third of the records and ask again (the index is rebuilt once)
    for (let i = ref.entries.length - 1; i >= 0; i -= 3) {
      bl.remove(ref.entries[i]!.id);
      ref.entries.splice(i, 1);
    }
    compare(bl, ref, queries(r, ref, 15_000), bad, tally);
    expect(bad.slice(0, 10)).toEqual([]);
    expect(tally.hit).toBeGreaterThan(1000);
    expect(tally.miss).toBeGreaterThan(1000);
  });

  it('handles the ends of the address space and prefix extremes', () => {
    const bl = new BanList();
    const hi = bl.addRange('255.255.255.255/32');
    const lo = bl.addRange('0.0.0.0');
    const top = bl.addRange('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128');
    const zero = bl.addRange('::/128');
    const highHalf = bl.addRange('8000::/1');
    expect(['255.255.255.255', '0.0.0.0', '255.255.255.254', '0.0.0.1', '1.2.3.4', '128.0.0.0'].map((ip) => bl.isIpBanned(ip))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '::', '::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe', '8000::', '7fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'c000::5'].map((ip) => bl.isIpBanned(ip))).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
    for (const rec of [hi, lo, top, zero, highHalf]) expect(bl.remove(rec.id)).toBe(true);
    expect(bl.isIpBanned('255.255.255.255')).toBe(false);
    expect(bl.isIpBanned('c000::5')).toBe(false);
  });

  it('keeps IPv4 and IPv6 ranges apart, with mapped addresses treated as IPv4', () => {
    const bl = new BanList();
    const all6 = bl.addRange('::/0');
    expect(bl.isIpBanned('2001:db8::1')).toBe(true);
    expect(bl.isIpBanned('1.2.3.4')).toBe(false);
    expect(bl.isIpBanned('::ffff:1.2.3.4')).toBe(false);
    const all4 = bl.addRange('0.0.0.0/0');
    expect(bl.isIpBanned('1.2.3.4')).toBe(true);
    expect(bl.isIpBanned('::ffff:1.2.3.4')).toBe(true);
    bl.remove(all6.id);
    expect(bl.isIpBanned('2001:db8::1')).toBe(false);
    expect(bl.isIpBanned('255.255.255.255')).toBe(true);
    bl.remove(all4.id);
    expect(bl.isIpBanned('255.255.255.255')).toBe(false);
    const mapped = bl.addRange('::ffff:10.0.0.0/104');
    expect(bl.isIpBanned('10.20.30.40')).toBe(true);
    expect(bl.isIpBanned('::ffff:10.20.30.40')).toBe(true);
    expect(bl.isIpBanned('11.0.0.0')).toBe(false);
    bl.remove(mapped.id);
    expect(bl.isIpBanned('10.20.30.40')).toBe(false);
  });

  it('keeps nested, adjacent and overlapping ranges consistent when one is removed', () => {
    const bl = new BanList();
    const outer = bl.addRange('10.0.0.0/8');
    const mid = bl.addRange('10.1.0.0/16');
    bl.addRange('10.1.2.0/24');
    const lowHalf = bl.addRange('192.0.2.0/25');
    const highHalf = bl.addRange('192.0.2.128/25');
    const wide = bl.addRange('192.0.2.64/26');
    const probes = ['10.0.0.0', '10.1.2.3', '10.255.255.255', '11.0.0.0', '9.255.255.255', '192.0.2.0', '192.0.2.127', '192.0.2.128', '192.0.2.255', '192.0.3.0', '192.0.1.255'];
    const state = () => probes.map((ip) => bl.isIpBanned(ip));
    expect(state()).toEqual([true, true, true, false, false, true, true, true, true, false, false]);
    bl.remove(outer.id);
    expect(state()).toEqual([false, true, false, false, false, true, true, true, true, false, false]);
    bl.remove(mid.id);
    expect(state()).toEqual([false, true, false, false, false, true, true, true, true, false, false]);
    bl.remove(lowHalf.id);
    expect(bl.isIpBanned('192.0.2.0')).toBe(false);
    expect(bl.isIpBanned('192.0.2.64')).toBe(true); // still covered by the /26
    expect(bl.isIpBanned('192.0.2.127')).toBe(true);
    bl.remove(wide.id);
    expect(bl.isIpBanned('192.0.2.64')).toBe(false);
    expect(bl.isIpBanned('192.0.2.128')).toBe(true);
    bl.remove(highHalf.id);
    expect(bl.isIpBanned('192.0.2.128')).toBe(false);
  });

  it('keeps an IP banned while another record still lists it', () => {
    const bl = new BanList();
    const a = bl.addPeer(['1.2.3.4', '2001:db8::7'], 'K');
    const c = bl.addRange('1.2.3.0/24');
    const d = bl.addIp('::ffff:1.2.3.4');
    bl.remove(a.id);
    expect(bl.isIpBanned('1.2.3.4')).toBe(true);
    bl.remove(d.id);
    expect(bl.isIpBanned('1.2.3.4')).toBe(true); // by the range
    bl.remove(c.id);
    expect(bl.isIpBanned('1.2.3.4')).toBe(false);
    expect(bl.isIpBanned('2001:db8::7')).toBe(false);
    expect(bl.isAuthBanned('K')).toBe(false);
  });

  it('answers correctly right after every change, with and without lookups in between', () => {
    const bl = new BanList();
    const ids: number[] = [];
    for (let i = 0; i < 64; i++) {
      ids.push(bl.addRange(`10.${i}.0.0/16`).id);
      if (i % 2 === 0) expect(bl.isIpBanned(`10.${i}.9.9`)).toBe(true);
    }
    for (let i = 0; i < 64; i++) expect(bl.isIpBanned(`10.${i}.9.9`)).toBe(true);
    for (let i = 0; i < 64; i += 2) bl.remove(ids[i]!);
    for (let i = 0; i < 64; i++) expect(bl.isIpBanned(`10.${i}.9.9`)).toBe(i % 2 === 1);
    bl.clear();
    expect(bl.isIpBanned('10.1.9.9')).toBe(false);
    expect(bl.addRange('10.1.0.0/16').id).toBeGreaterThan(ids[63]!);
    expect(bl.isIpBanned('10.1.9.9')).toBe(true);
    expect(bl.isIpBanned('10.0.9.9')).toBe(false);
  });
});
