/**
 * IP address helpers: parsing (IPv4, IPv6 incl. embedded IPv4 and zone ids),
 * canonical text form (IPv4 dotted / IPv6 RFC 5952), CIDR ranges, and the
 * official `conn` encoding (the master sends the client IP as ASCII text; the
 * host exposes it as uppercase hex of those bytes, `R.yi`).
 *
 * IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are treated as the IPv4
 * address so a ban on one form matches the other.
 */

/** Parses an IP literal into 4 (IPv4) or 16 (IPv6) bytes; `null` if invalid. */
export function parseIp(text: string): Uint8Array | null {
  let s = text.trim();
  if (s.length === 0) return null;
  if (s.charCodeAt(0) === 91 /* [ */ && s.charCodeAt(s.length - 1) === 93 /* ] */) s = s.slice(1, -1);
  if (s.indexOf(':') < 0) return parseIpv4(s);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v6 = parseIpv6(s);
  if (v6 === null) return null;
  // IPv4-mapped (::ffff:0:0/96) -> IPv4
  let mapped = v6[10] === 0xff && v6[11] === 0xff;
  for (let i = 0; mapped && i < 10; i++) if (v6[i] !== 0) mapped = false;
  return mapped ? v6.slice(12) : v6;
}

function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (p.length === 0 || p.length > 3 || !/^\d+$/.test(p)) return null;
    if (p.length > 1 && p.charCodeAt(0) === 48 /* 0 */) return null; // no octal-looking forms
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(s: string): Uint8Array | null {
  const out = new Uint8Array(16);
  const dbl = s.indexOf('::');
  if (dbl >= 0 && s.indexOf('::', dbl + 1) >= 0) return null;
  const head = dbl >= 0 ? s.slice(0, dbl) : s;
  const tail = dbl >= 0 ? s.slice(dbl + 2) : '';
  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail.length > 0 ? tail.split(':') : [];
  const words: number[] = [];
  const tailWords: number[] = [];
  if (!pushGroups(headParts, words, dbl < 0 && tailParts.length === 0)) return null;
  if (!pushGroups(tailParts, tailWords, true)) return null;
  const total = words.length + tailWords.length;
  if (dbl >= 0 ? total > 7 : total !== 8) return null;
  for (let i = 0; i < words.length; i++) {
    out[i * 2] = words[i]! >> 8;
    out[i * 2 + 1] = words[i]! & 0xff;
  }
  const off = 8 - tailWords.length;
  for (let i = 0; i < tailWords.length; i++) {
    out[(off + i) * 2] = tailWords[i]! >> 8;
    out[(off + i) * 2 + 1] = tailWords[i]! & 0xff;
  }
  return out;
}

/** Hex groups -> 16-bit words; the last group of the address may be dotted IPv4. */
function pushGroups(parts: string[], into: number[], lastMayBeV4: boolean): boolean {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (lastMayBeV4 && i === parts.length - 1 && p.indexOf('.') >= 0) {
      const v4 = parseIpv4(p);
      if (v4 === null) return false;
      into.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      continue;
    }
    if (p.length === 0 || p.length > 4 || !/^[0-9a-fA-F]+$/.test(p)) return false;
    into.push(parseInt(p, 16));
  }
  return true;
}

/** Text form of 4/16 address bytes (IPv6 per RFC 5952: lowercase, longest zero run compressed). */
export function formatIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  const words: number[] = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (from: number, to: number) => words.slice(from, to).map((w) => w.toString(16)).join(':');
  if (bestStart < 0) return hex(0, 8);
  return `${hex(0, bestStart)}::${hex(bestStart + bestLen, 8)}`;
}

/** Canonical text form of an IP literal (`null` if not an IP). */
export function canonicalIp(text: string): string | null {
  const b = parseIp(text);
  return b === null ? null : formatIp(b);
}

/** A parsed CIDR range (`10.0.0.0/8`, `2001:db8::/32`; a bare IP is a /32 or /128). */
export class IpRange {
  readonly base: Uint8Array;
  readonly prefix: number;

  private constructor(base: Uint8Array, prefix: number) {
    this.base = base;
    this.prefix = prefix;
  }

  static parse(cidr: string): IpRange | null {
    const slash = cidr.indexOf('/');
    const addr = parseIp(slash >= 0 ? cidr.slice(0, slash) : cidr);
    if (addr === null) return null;
    const bits = addr.length * 8;
    let prefix = bits;
    if (slash >= 0) {
      const p = cidr.slice(slash + 1).trim();
      if (!/^\d{1,3}$/.test(p)) return null;
      prefix = Number(p);
      // "::ffff:10.0.0.0/104" style prefixes on mapped addresses
      if (addr.length === 4 && cidr.indexOf(':') >= 0) {
        if (prefix < 96) return null;
        prefix -= 96;
      }
      if (prefix > bits) return null;
    }
    const base = addr.slice();
    for (let i = 0; i < base.length; i++) {
      const keep = Math.max(0, Math.min(8, prefix - i * 8));
      base[i]! &= (0xff << (8 - keep)) & 0xff;
    }
    return new IpRange(base, prefix);
  }

  /** Whether `addr` (bytes from {@link parseIp}) is inside the range. */
  contains(addr: Uint8Array): boolean {
    if (addr.length !== this.base.length) return false;
    const full = this.prefix >> 3;
    for (let i = 0; i < full; i++) if (addr[i] !== this.base[i]) return false;
    const rest = this.prefix & 7;
    if (rest === 0) return true;
    const mask = (0xff << (8 - rest)) & 0xff;
    return (addr[full]! & mask) === this.base[full];
  }

  toString(): string {
    return `${formatIp(this.base)}/${this.prefix}`;
  }
}

const HEX = '0123456789ABCDEF';

/** Official `conn`: uppercase hex of the raw bytes the master sent (`R.yi`). */
export function bytesToConn(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += HEX[b >> 4]! + HEX[b & 15]!;
  }
  return s;
}

/** Decodes a `conn` hex string back to the text the master sent (the client IP). */
export function connToText(conn: string): string {
  let s = '';
  for (let i = 0; i + 1 < conn.length; i += 2) s += String.fromCharCode(parseInt(conn.slice(i, i + 2), 16));
  return s;
}

/** ASCII text of the master's conn bytes (the client IP as seen by the master). */
export function connBytesToText(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}
