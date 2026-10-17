/**
 * STUN (RFC 5389/8489) as needed by an ICE-lite agent (RFC 8445): parse
 * Binding requests, check MESSAGE-INTEGRITY (short-term credentials,
 * HMAC-SHA1 keyed with the ICE password) and FINGERPRINT (CRC-32 ^
 * 0x5354554e), and build authenticated Binding responses with
 * XOR-MAPPED-ADDRESS.
 *
 * Parsing fills a reusable {@link StunMessage} (offsets into the datagram,
 * no per-attribute objects).
 */
import { createHmac, timingSafeEqual, type KeyObject } from 'node:crypto';
import { isIPv4 } from 'node:net';
import * as zlib from 'node:zlib';

/**
 * MESSAGE-INTEGRITY key: the ICE password as bytes, or (sessions) the same
 * bytes as a secret KeyObject made once, which spares createHmac the
 * per-call key import (Node 26: ≈ 47 → 4 µs per HMAC; neutral on Bun).
 */
export type StunKey = Uint8Array | KeyObject;

export const STUN_HEADER = 20;
export const MAGIC_COOKIE = 0x2112a442;
const FINGERPRINT_XOR = 0x5354554e;

export const StunType = {
  BindingRequest: 0x0001,
  BindingIndication: 0x0011,
  BindingSuccess: 0x0101,
  BindingError: 0x0111,
} as const;

export const StunAttr = {
  MappedAddress: 0x0001,
  Username: 0x0006,
  MessageIntegrity: 0x0008,
  ErrorCode: 0x0009,
  UnknownAttributes: 0x000a,
  XorMappedAddress: 0x0020,
  Priority: 0x0024,
  UseCandidate: 0x0025,
  Software: 0x8022,
  Fingerprint: 0x8028,
  IceControlled: 0x8029,
  IceControlling: 0x802a,
} as const;

// ---------------------------------------------------------------- CRC-32

// (Bun has zlib.crc32 too. Bun.hash.crc32 gives the same values but is not faster —
// Bun 1.4, 68 / 548 B: 83 / 111 ns vs zlib.crc32's 80 / 101 ns — so zlib it is everywhere.)
const zlibCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;
let crcTable: Uint32Array | null = null;

/** CRC-32 (ISO 3309 / zlib) of `buf[start, end)`. */
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  if (zlibCrc32 !== undefined) return zlibCrc32(buf.subarray(start, end)) >>> 0;
  let t = crcTable;
  if (t === null) {
    t = crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = t[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- parsing

/** Reusable parse result (offsets refer to the last parsed buffer; -1 = absent). */
export class StunMessage {
  buf: Uint8Array = new Uint8Array(0);
  type = 0;
  /** Total message size (header + attributes). */
  size = 0;
  usernameOffset = -1;
  usernameLength = 0;
  /** Offset of the MESSAGE-INTEGRITY attribute header. */
  integrityOffset = -1;
  /** Offset of the FINGERPRINT attribute header. */
  fingerprintOffset = -1;
  useCandidate = false;
  controlling = false;
  controlled = false;
  /** Tie-breaker of ICE-CONTROLLING/ICE-CONTROLLED (hi/lo 32 bits). */
  tieHi = 0;
  tieLo = 0;
  priority = 0;
  /** Comprehension-required attributes (< 0x8000) we do not know: first one, or -1. */
  unknownRequired = -1;

  reset(): void {
    this.type = 0;
    this.size = 0;
    this.usernameOffset = -1;
    this.usernameLength = 0;
    this.integrityOffset = -1;
    this.fingerprintOffset = -1;
    this.useCandidate = false;
    this.controlling = false;
    this.controlled = false;
    this.tieHi = 0;
    this.tieLo = 0;
    this.priority = 0;
    this.unknownRequired = -1;
  }

  /** USERNAME as a latin1 string (ICE ufrags are ASCII), or null. */
  username(): string | null {
    if (this.usernameOffset < 0) return null;
    return Buffer.from(this.buf.buffer, this.buf.byteOffset + this.usernameOffset, this.usernameLength).toString('latin1');
  }

  /** Transaction ID bytes (a view). */
  transactionId(): Uint8Array {
    return this.buf.subarray(8, 20);
  }
}

const KNOWN_REQUIRED = new Set<number>([
  StunAttr.MappedAddress,
  StunAttr.Username,
  StunAttr.MessageIntegrity,
  StunAttr.ErrorCode,
  StunAttr.UnknownAttributes,
  StunAttr.XorMappedAddress,
  StunAttr.Priority,
  StunAttr.UseCandidate,
]);

/** Quick check: looks like STUN (RFC 7983 first byte 0–3, magic cookie, length multiple of 4). */
export function isStun(buf: Uint8Array, len = buf.length): boolean {
  return (
    len >= STUN_HEADER &&
    buf[0]! < 4 &&
    buf[4] === 0x21 &&
    buf[5] === 0x12 &&
    buf[6] === 0xa4 &&
    buf[7] === 0x42 &&
    (((buf[2]! << 8) | buf[3]!) & 3) === 0
  );
}

/**
 * Parses `buf` into `out`. Returns false for anything malformed (bad header,
 * truncated attributes, MESSAGE-INTEGRITY not followed only by FINGERPRINT,
 * FINGERPRINT not last).
 */
export function parseStun(buf: Uint8Array, out: StunMessage): boolean {
  out.reset();
  out.buf = buf;
  if (!isStun(buf)) return false;
  const bodyLen = (buf[2]! << 8) | buf[3]!;
  const size = STUN_HEADER + bodyLen;
  if (size > buf.length) return false;
  out.type = (buf[0]! << 8) | buf[1]!;
  out.size = size;
  let p = STUN_HEADER;
  while (p < size) {
    if (p + 4 > size) return false;
    const t = (buf[p]! << 8) | buf[p + 1]!;
    const l = (buf[p + 2]! << 8) | buf[p + 3]!;
    const v = p + 4;
    if (v + l > size) return false;
    if (out.fingerprintOffset >= 0) return false; // nothing may follow FINGERPRINT
    if (out.integrityOffset >= 0 && t !== StunAttr.Fingerprint) {
      // RFC 5389 §15.4: attributes after MESSAGE-INTEGRITY are ignored except FINGERPRINT;
      // keep parsing strictly: ignore them.
      p = v + ((l + 3) & ~3);
      continue;
    }
    switch (t) {
      case StunAttr.Username:
        out.usernameOffset = v;
        out.usernameLength = l;
        break;
      case StunAttr.MessageIntegrity:
        if (l !== 20) return false;
        out.integrityOffset = p;
        break;
      case StunAttr.Fingerprint:
        if (l !== 4) return false;
        out.fingerprintOffset = p;
        break;
      case StunAttr.UseCandidate:
        out.useCandidate = true;
        break;
      case StunAttr.Priority:
        if (l !== 4) return false;
        out.priority = ((buf[v]! << 24) | (buf[v + 1]! << 16) | (buf[v + 2]! << 8) | buf[v + 3]!) >>> 0;
        break;
      case StunAttr.IceControlling:
      case StunAttr.IceControlled:
        if (l !== 8) return false;
        if (t === StunAttr.IceControlling) out.controlling = true;
        else out.controlled = true;
        out.tieHi = ((buf[v]! << 24) | (buf[v + 1]! << 16) | (buf[v + 2]! << 8) | buf[v + 3]!) >>> 0;
        out.tieLo = ((buf[v + 4]! << 24) | (buf[v + 5]! << 16) | (buf[v + 6]! << 8) | buf[v + 7]!) >>> 0;
        break;
      default:
        if (t < 0x8000 && !KNOWN_REQUIRED.has(t) && out.unknownRequired < 0) out.unknownRequired = t;
    }
    p = v + ((l + 3) & ~3);
  }
  return p === size;
}

/** FINGERPRINT present and correct (RFC 5389 §15.5). */
export function checkFingerprint(m: StunMessage): boolean {
  const off = m.fingerprintOffset;
  if (off < 0) return false;
  const buf = m.buf;
  const expected = (crc32WithLength(buf, off, off + 8 - STUN_HEADER) ^ FINGERPRINT_XOR) >>> 0;
  const got = ((buf[off + 4]! << 24) | (buf[off + 5]! << 16) | (buf[off + 6]! << 8) | buf[off + 7]!) >>> 0;
  return expected === got;
}

/** CRC-32 of `buf[0, end)` with the header length field replaced by `len`. */
function crc32WithLength(buf: Uint8Array, end: number, len: number): number {
  const b2 = buf[2]!;
  const b3 = buf[3]!;
  buf[2] = len >>> 8;
  buf[3] = len & 0xff;
  const c = crc32(buf, 0, end);
  buf[2] = b2;
  buf[3] = b3;
  return c;
}

/**
 * MESSAGE-INTEGRITY present and valid for `key` (the ICE password as bytes;
 * RFC 5389 §15.4 short-term credential: key = SASLprep(password), ASCII here).
 */
export function checkIntegrity(m: StunMessage, key: StunKey): boolean {
  const off = m.integrityOffset;
  if (off < 0) return false;
  const buf = m.buf;
  const mac = hmacWithLength(buf, off, off + 24 - STUN_HEADER, key);
  return timingSafeEqual(mac, buf.subarray(off + 4, off + 24));
}

function hmacWithLength(buf: Uint8Array, end: number, len: number, key: StunKey): Buffer {
  const b2 = buf[2]!;
  const b3 = buf[3]!;
  buf[2] = len >>> 8;
  buf[3] = len & 0xff;
  const h = createHmac('sha1', key);
  h.update(buf.subarray(0, end));
  buf[2] = b2;
  buf[3] = b3;
  return h.digest();
}

// ---------------------------------------------------------------- building

/** Encodes `address` (v4 or v6 literal, v4-mapped v6 is reduced to v4) XORed into `out` at `p`; returns bytes written (value only). */
export function writeXorAddress(out: Uint8Array, p: number, address: string, port: number, txid: Uint8Array): number {
  let addr = address;
  if (addr.startsWith('::ffff:') && isIPv4(addr.slice(7))) addr = addr.slice(7);
  const xport = port ^ (MAGIC_COOKIE >>> 16);
  out[p] = 0;
  out[p + 2] = (xport >>> 8) & 0xff;
  out[p + 3] = xport & 0xff;
  if (isIPv4(addr)) {
    out[p + 1] = 0x01;
    const parts = addr.split('.');
    for (let i = 0; i < 4; i++) out[p + 4 + i] = Number(parts[i]) ^ COOKIE_BYTES[i]!;
    return 8;
  }
  out[p + 1] = 0x02;
  const bytes = ipv6Bytes(addr);
  for (let i = 0; i < 16; i++) out[p + 4 + i] = bytes[i]! ^ (i < 4 ? COOKIE_BYTES[i]! : txid[i - 4]!);
  return 20;
}

const COOKIE_BYTES = Uint8Array.of(0x21, 0x12, 0xa4, 0x42);

/** 16 bytes of an IPv6 literal (supports `::` and an embedded dotted IPv4 tail; zone ids stripped). */
export function ipv6Bytes(address: string): Uint8Array {
  let a = address;
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct);
  const out = new Uint8Array(16);
  let tail: number[] = [];
  const v4 = a.lastIndexOf(':');
  if (v4 >= 0 && a.indexOf('.', v4) > v4) {
    const parts = a.slice(v4 + 1).split('.').map(Number);
    tail = [(parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!];
    a = a.slice(0, v4 + 1) + '0:0';
  }
  const dbl = a.indexOf('::');
  let groups: number[];
  if (dbl >= 0) {
    const head = a.slice(0, dbl) === '' ? [] : a.slice(0, dbl).split(':');
    const rest = a.slice(dbl + 2) === '' ? [] : a.slice(dbl + 2).split(':');
    const fill = 8 - head.length - rest.length;
    groups = [...head.map((g) => parseInt(g, 16)), ...new Array<number>(fill).fill(0), ...rest.map((g) => parseInt(g, 16))];
  } else {
    groups = a.split(':').map((g) => parseInt(g, 16));
  }
  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? 0;
    out[2 * i] = (g >>> 8) & 0xff;
    out[2 * i + 1] = g & 0xff;
  }
  return out;
}

/** Decodes an XOR-MAPPED-ADDRESS value (tests / diagnostics). */
export function readXorAddress(buf: Uint8Array, v: number, txid: Uint8Array): { address: string; port: number } {
  const family = buf[v + 1];
  const port = (((buf[v + 2]! << 8) | buf[v + 3]!) ^ (MAGIC_COOKIE >>> 16)) & 0xffff;
  if (family === 1) {
    const p: number[] = [];
    for (let i = 0; i < 4; i++) p.push(buf[v + 4 + i]! ^ COOKIE_BYTES[i]!);
    return { address: p.join('.'), port };
  }
  const g: string[] = [];
  for (let i = 0; i < 8; i++) {
    const hi = buf[v + 4 + 2 * i]! ^ (2 * i < 4 ? COOKIE_BYTES[2 * i]! : txid[2 * i - 4]!);
    const lo = buf[v + 5 + 2 * i]! ^ (2 * i + 1 < 4 ? COOKIE_BYTES[2 * i + 1]! : txid[2 * i + 1 - 4]!);
    g.push(((hi << 8) | lo).toString(16));
  }
  return { address: g.join(':'), port };
}

/** Finds attribute `type` in a parsed message; returns the value offset or -1. */
export function findAttr(m: StunMessage, type: number): number {
  const buf = m.buf;
  let p = STUN_HEADER;
  while (p + 4 <= m.size) {
    const t = (buf[p]! << 8) | buf[p + 1]!;
    const l = (buf[p + 2]! << 8) | buf[p + 3]!;
    if (t === type) return p + 4;
    p += 4 + ((l + 3) & ~3);
  }
  return -1;
}

/** Appends MESSAGE-INTEGRITY (if `key`) and FINGERPRINT to a message whose attributes end at `p`; returns the final size. */
export function finishMessage(out: Uint8Array, p: number, key: StunKey | null): number {
  if (key !== null) {
    out[p] = 0x00;
    out[p + 1] = 0x08;
    out[p + 2] = 0;
    out[p + 3] = 20;
    const len = p + 24 - STUN_HEADER;
    out[2] = len >>> 8;
    out[3] = len & 0xff;
    const mac = createHmac('sha1', key).update(out.subarray(0, p)).digest();
    out.set(mac, p + 4);
    p += 24;
  }
  out[p] = 0x80;
  out[p + 1] = 0x28;
  out[p + 2] = 0;
  out[p + 3] = 4;
  const len = p + 8 - STUN_HEADER;
  out[2] = len >>> 8;
  out[3] = len & 0xff;
  const fp = (crc32(out, 0, p) ^ FINGERPRINT_XOR) >>> 0;
  out[p + 4] = fp >>> 24;
  out[p + 5] = (fp >>> 16) & 0xff;
  out[p + 6] = (fp >>> 8) & 0xff;
  out[p + 7] = fp & 0xff;
  return p + 8;
}

export function writeHeader(out: Uint8Array, type: number, txid: Uint8Array): void {
  out[0] = type >>> 8;
  out[1] = type & 0xff;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0x21;
  out[5] = 0x12;
  out[6] = 0xa4;
  out[7] = 0x42;
  out.set(txid, 8);
}

/**
 * Binding success response: XOR-MAPPED-ADDRESS(source), MESSAGE-INTEGRITY
 * (our password), FINGERPRINT. Returns a new buffer (it is handed to the
 * socket, which may keep it until sent).
 */
export function buildBindingSuccess(txid: Uint8Array, address: string, port: number, key: StunKey): Buffer {
  const out = Buffer.allocUnsafe(STUN_HEADER + 4 + 20 + 24 + 8);
  writeHeader(out, StunType.BindingSuccess, txid);
  out[20] = 0x00;
  out[21] = 0x20;
  const n = writeXorAddress(out, 24, address, port, txid);
  out[22] = 0;
  out[23] = n;
  const size = finishMessage(out, 24 + n, key);
  return out.subarray(0, size);
}

/** Binding error response (e.g. 487 Role Conflict, 400 Bad Request), authenticated when `key` is given. */
export function buildBindingError(txid: Uint8Array, code: number, reason: string, key: StunKey | null): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const vlen = 4 + reasonBytes.length;
  const out = Buffer.alloc(STUN_HEADER + 4 + ((vlen + 3) & ~3) + 24 + 8);
  writeHeader(out, StunType.BindingError, txid);
  out[20] = 0x00;
  out[21] = 0x09;
  out[22] = vlen >>> 8;
  out[23] = vlen & 0xff;
  out[26] = Math.floor(code / 100) & 7;
  out[27] = code % 100;
  out.set(reasonBytes, 28);
  const size = finishMessage(out, 24 + ((vlen + 3) & ~3), key);
  return out.subarray(0, size);
}

/** Binding request (tests: plays the browser's role). */
export function buildBindingRequest(opts: {
  txid: Uint8Array;
  username: string;
  key: StunKey;
  priority?: number;
  useCandidate?: boolean;
  controlling?: boolean;
  controlled?: boolean;
  tieBreaker?: Uint8Array;
}): Buffer {
  const user = Buffer.from(opts.username, 'utf8');
  const out = Buffer.alloc(512);
  writeHeader(out, StunType.BindingRequest, opts.txid);
  let p = STUN_HEADER;
  const attr = (type: number, value: Uint8Array) => {
    out[p] = type >>> 8;
    out[p + 1] = type & 0xff;
    out[p + 2] = value.length >>> 8;
    out[p + 3] = value.length & 0xff;
    out.set(value, p + 4);
    p += 4 + ((value.length + 3) & ~3);
  };
  attr(StunAttr.Username, user);
  if (opts.priority !== undefined) {
    const v = Buffer.alloc(4);
    v.writeUInt32BE(opts.priority >>> 0);
    attr(StunAttr.Priority, v);
  }
  const tie = opts.tieBreaker ?? new Uint8Array(8).fill(7);
  if (opts.controlling !== false && opts.controlled !== true) attr(StunAttr.IceControlling, tie);
  if (opts.controlled === true) attr(StunAttr.IceControlled, tie);
  if (opts.useCandidate) attr(StunAttr.UseCandidate, new Uint8Array(0));
  const size = finishMessage(out, p, opts.key);
  return out.subarray(0, size);
}
