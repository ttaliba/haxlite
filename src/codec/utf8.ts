/**
 * HaxBall's hand-rolled "UTF-8" (clean-room reimplementation).
 *
 * Quirk that MUST be preserved for byte-exact interop (docs/02 §1.4):
 *  - The encoder walks the string by UTF-16 *code unit* (`charCodeAt`), so a
 *    character outside the BMP (e.g. an emoji) is written as TWO 3-byte
 *    sequences, one per surrogate (CESU-8 / WTF-8 style), never as a 4-byte
 *    sequence. Lone surrogates are encoded the same way (no U+FFFD).
 *  - The decoder accepts the original (pre RFC 3629) 1..6 byte forms and turns
 *    every decoded value into `String.fromCodePoint(value)`; decoded surrogate
 *    halves therefore re-join into the original UTF-16 string.
 *  - Length prefixes count BYTES of this encoding.
 *
 * The u8-length string form ("string2", used only by RoomInfo) is the
 * exception: the official writer uses the platform `TextEncoder` there
 * (standard UTF-8, see {@link standardUtf8Encode}); it is still decoded with
 * {@link decodeHaxUtf8}.
 */
import { CodecError } from './errors.js';

/** Number of bytes `s` occupies in HaxBall's per-code-unit encoding. */
export function haxUtf8Length(s: string): number {
  let n = 0;
  for (let i = 0, len = s.length; i < len; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

/**
 * Encodes `s` into `out` starting at `pos`; returns the position after the
 * last written byte. The caller guarantees capacity (see {@link haxUtf8Length}).
 * A UTF-16 code unit is always < 0x10000, so only the 1/2/3-byte forms of the
 * official encoder are reachable.
 */
export function encodeHaxUtf8Into(s: string, out: Uint8Array, pos: number): number {
  for (let i = 0, len = s.length; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out[pos++] = c;
    } else if (c < 0x800) {
      out[pos++] = 0xc0 | ((c >> 6) & 0x1f);
      out[pos++] = 0x80 | (c & 0x3f);
    } else {
      out[pos++] = 0xe0 | ((c >> 12) & 0x0f);
      out[pos++] = 0x80 | ((c >> 6) & 0x3f);
      out[pos++] = 0x80 | (c & 0x3f);
    }
  }
  return pos;
}

/** Convenience: returns a fresh buffer with the HaxBall encoding of `s`. */
export function encodeHaxUtf8(s: string): Uint8Array {
  const out = new Uint8Array(haxUtf8Length(s));
  encodeHaxUtf8Into(s, out, 0);
  return out;
}

const textEncoder = new TextEncoder();
/** Standard UTF-8 (TextEncoder), as used by the official u8-length string writer. */
export function standardUtf8Encode(s: string): Uint8Array {
  return textEncoder.encode(s);
}

// Scratch buffer for code units while decoding (grown on demand, never shrunk).
let scratch = new Uint16Array(256);

function flushChunked(units: Uint16Array, count: number): string {
  // String.fromCharCode.apply has an argument-count limit; chunk to stay safe.
  if (count <= 4096) return String.fromCharCode.apply(null, units.subarray(0, count) as unknown as number[]);
  let out = '';
  for (let i = 0; i < count; i += 4096) {
    out += String.fromCharCode.apply(null, units.subarray(i, Math.min(count, i + 4096)) as unknown as number[]);
  }
  return out;
}

/**
 * Decodes `byteLength` bytes of `bytes` starting at `start`.
 *
 * Mirrors the official reader: sequences are parsed one by one; a multi-byte
 * sequence may read past `start + byteLength` (but not past the end of
 * `bytes`), in which case "Actual string length differs from the specified"
 * is thrown afterwards. Invalid lead bytes throw. Decoded values above
 * U+10FFFF (only reachable via 5/6-byte forms) throw like
 * `String.fromCodePoint` does in the official code.
 */
export function decodeHaxUtf8(bytes: Uint8Array, start: number, byteLength: number): string {
  const end = start + byteLength;
  const limit = bytes.length;
  if (end > limit) throw new CodecError('Read too much');
  // Fast path: pure ASCII.
  let i = start;
  while (i < end && bytes[i]! < 0x80) i++;
  if (i === end) return latin1Slice(bytes, start, end);

  // A sequence yields at most 2 code units and is at least 1 byte long, so
  // `byteLength + 2` units always suffice (an overshooting final sequence is
  // rejected below anyway).
  if (scratch.length < byteLength + 2) scratch = new Uint16Array(Math.max(byteLength + 2, scratch.length * 2));
  const units = scratch;
  let n = 0;
  for (let k = start; k < i; k++) units[n++] = bytes[k]!;
  let p = i;
  while (p < end) {
    const b0 = bytes[p]!;
    let cp: number;
    let len: number;
    if ((b0 & 0x80) === 0) {
      cp = b0;
      len = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = ((b0 & 0x1f) << 6) | (at(bytes, p + 1, limit) & 0x3f);
      len = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = ((b0 & 0x0f) << 12) | ((at(bytes, p + 1, limit) & 0x3f) << 6) | (at(bytes, p + 2, limit) & 0x3f);
      len = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp =
        ((b0 & 0x07) << 18) |
        ((at(bytes, p + 1, limit) & 0x3f) << 12) |
        ((at(bytes, p + 2, limit) & 0x3f) << 6) |
        (at(bytes, p + 3, limit) & 0x3f);
      len = 4;
    } else if ((b0 & 0xfc) === 0xf8) {
      cp =
        ((b0 & 0x03) << 24) |
        ((at(bytes, p + 1, limit) & 0x3f) << 18) |
        ((at(bytes, p + 2, limit) & 0x3f) << 12) |
        ((at(bytes, p + 3, limit) & 0x3f) << 6) |
        (at(bytes, p + 4, limit) & 0x3f);
      len = 5;
    } else if ((b0 & 0xfe) === 0xfc) {
      cp =
        ((b0 & 0x01) << 30) |
        ((at(bytes, p + 1, limit) & 0x3f) << 24) |
        ((at(bytes, p + 2, limit) & 0x3f) << 18) |
        ((at(bytes, p + 3, limit) & 0x3f) << 12) |
        ((at(bytes, p + 4, limit) & 0x3f) << 6) |
        (at(bytes, p + 5, limit) & 0x3f);
      len = 6;
    } else {
      throw new CodecError(`Cannot decode UTF8 character at offset ${p}: charCode (${b0}) is invalid`);
    }
    p += len;
    if (cp <= 0xffff) {
      units[n++] = cp;
    } else if (cp <= 0x10ffff) {
      // Same result as String.fromCodePoint(cp): a surrogate pair.
      const v = cp - 0x10000;
      units[n++] = 0xd800 | (v >> 10);
      units[n++] = 0xdc00 | (v & 0x3ff);
    } else {
      throw new CodecError(`Invalid code point ${cp}`);
    }
  }
  if (p !== end) {
    throw new CodecError(`Actual string length differs from the specified: ${p - end} bytes`);
  }
  return flushChunked(units, n);
}

function at(bytes: Uint8Array, i: number, limit: number): number {
  if (i >= limit) throw new CodecError('Read too much');
  return bytes[i]!;
}

function latin1Slice(bytes: Uint8Array, start: number, end: number): string {
  const len = end - start;
  if (len === 0) return '';
  if (len <= 64) {
    let s = '';
    for (let k = start; k < end; k++) s += String.fromCharCode(bytes[k]!);
    return s;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, len).toString('latin1');
}
