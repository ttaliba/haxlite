/**
 * Growable binary writer (clean-room equivalent of the official StreamWriter).
 *
 * - Big-endian by default; explicit `*LE` methods exist for the few
 *   little-endian fields (RoomInfo). There is no endianness *mode*: each call
 *   site states what it writes, which keeps the hot methods branch-free.
 * - Owns one reusable buffer. `reset()` rewinds without reallocating, so a
 *   long-lived Writer per connection / per purpose costs zero allocations per
 *   message once warmed up.
 * - Capacity grows by doubling (like the official writer), copying once.
 * - `finish()` returns a zero-copy view over the internal buffer. That view is
 *   only valid until the next write or `reset()`; use `toArrayBuffer()` /
 *   `copyBytes()` when the bytes must outlive the writer state.
 */
import { CodecError } from './errors.js';
import { encodeHaxUtf8Into, haxUtf8Length, standardUtf8Encode } from './utf8.js';

export class Writer {
  /** Current write position (= number of bytes written). May be moved back to patch earlier fields. */
  pos = 0;
  private buf: Uint8Array;
  private view: DataView;

  constructor(initialCapacity = 256) {
    if (initialCapacity < 1) initialCapacity = 1;
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  /** Bytes written so far. */
  get length(): number {
    return this.pos;
  }

  /** Current capacity of the internal buffer. */
  get capacity(): number {
    return this.buf.length;
  }

  /** Rewinds to 0 keeping the allocated buffer. Returns `this` for chaining. */
  reset(): this {
    this.pos = 0;
    return this;
  }

  /** Makes room for `n` more bytes after `pos`. */
  ensure(n: number): void {
    const need = this.pos + n;
    if (need > this.buf.length) this.grow(need);
  }

  private grow(need: number): void {
    const doubled = this.buf.length * 2;
    const cap = doubled >= need ? doubled : need;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  // ---------------------------------------------------------------- integers

  u8(v: number): void {
    const p = this.pos;
    if (p + 1 > this.buf.length) this.grow(p + 1);
    this.buf[p] = v; // Uint8Array store = ToUint8 (mod 256), same as DataView.setUint8
    this.pos = p + 1;
  }

  /** Signed byte. Same bytes as u8 (two's complement); kept for readability. */
  i8(v: number): void {
    this.u8(v);
  }

  u16(v: number): void {
    const p = this.pos;
    if (p + 2 > this.buf.length) this.grow(p + 2);
    this.view.setUint16(p, v);
    this.pos = p + 2;
  }

  i16(v: number): void {
    const p = this.pos;
    if (p + 2 > this.buf.length) this.grow(p + 2);
    this.view.setInt16(p, v);
    this.pos = p + 2;
  }

  u32(v: number): void {
    const p = this.pos;
    if (p + 4 > this.buf.length) this.grow(p + 4);
    this.view.setUint32(p, v);
    this.pos = p + 4;
  }

  i32(v: number): void {
    const p = this.pos;
    if (p + 4 > this.buf.length) this.grow(p + 4);
    this.view.setInt32(p, v);
    this.pos = p + 4;
  }

  f32(v: number): void {
    const p = this.pos;
    if (p + 4 > this.buf.length) this.grow(p + 4);
    this.view.setFloat32(p, v);
    this.pos = p + 4;
  }

  f64(v: number): void {
    const p = this.pos;
    if (p + 8 > this.buf.length) this.grow(p + 8);
    this.view.setFloat64(p, v);
    this.pos = p + 8;
  }

  // ------------------------------------------------------- little-endian ops

  u16LE(v: number): void {
    const p = this.pos;
    if (p + 2 > this.buf.length) this.grow(p + 2);
    this.view.setUint16(p, v, true);
    this.pos = p + 2;
  }

  i16LE(v: number): void {
    const p = this.pos;
    if (p + 2 > this.buf.length) this.grow(p + 2);
    this.view.setInt16(p, v, true);
    this.pos = p + 2;
  }

  u32LE(v: number): void {
    const p = this.pos;
    if (p + 4 > this.buf.length) this.grow(p + 4);
    this.view.setUint32(p, v, true);
    this.pos = p + 4;
  }

  i32LE(v: number): void {
    const p = this.pos;
    if (p + 4 > this.buf.length) this.grow(p + 4);
    this.view.setInt32(p, v, true);
    this.pos = p + 4;
  }

  f32LE(v: number): void {
    const p = this.pos;
    if (p + 4 > this.buf.length) this.grow(p + 4);
    this.view.setFloat32(p, v, true);
    this.pos = p + 4;
  }

  f64LE(v: number): void {
    const p = this.pos;
    if (p + 8 > this.buf.length) this.grow(p + 8);
    this.view.setFloat64(p, v, true);
    this.pos = p + 8;
  }

  // ------------------------------------------------------------------ varint

  /**
   * Unsigned LEB128, 1..5 bytes, byte-identical to the official writer.
   * `v` is taken as uint32 (`v >>> 0`). Quirk reproduced on purpose: the 5th
   * byte is `(v >> 28) & 127` using a *signed* shift, so for v >= 2^31 bits
   * 4..6 of that byte are set (0x80000000 -> `80 80 80 80 78`, not `... 08`).
   * Readers ignore those bits, but the bytes (and therefore checksums) differ.
   */
  varUint(v: number): void {
    const a = v >>> 0;
    const p = this.pos;
    if (p + 5 > this.buf.length) this.grow(p + 5);
    const b = this.buf;
    if (a < 0x80) {
      b[p] = a;
      this.pos = p + 1;
    } else if (a < 0x4000) {
      b[p] = a | 0x80;
      b[p + 1] = (a >> 7) & 0x7f;
      this.pos = p + 2;
    } else if (a < 0x200000) {
      b[p] = a | 0x80;
      b[p + 1] = (a >> 7) | 0x80;
      b[p + 2] = (a >> 14) & 0x7f;
      this.pos = p + 3;
    } else if (a < 0x10000000) {
      b[p] = a | 0x80;
      b[p + 1] = (a >> 7) | 0x80;
      b[p + 2] = (a >> 14) | 0x80;
      b[p + 3] = (a >> 21) & 0x7f;
      this.pos = p + 4;
    } else {
      b[p] = a | 0x80;
      b[p + 1] = (a >> 7) | 0x80;
      b[p + 2] = (a >> 14) | 0x80;
      b[p + 3] = (a >> 21) | 0x80;
      b[p + 4] = (a >> 28) & 0x7f;
      this.pos = p + 5;
    }
  }

  // ------------------------------------------------------------------- bytes

  /** Raw bytes, no length prefix. */
  bytes(src: Uint8Array): void {
    const n = src.length;
    const p = this.pos;
    if (p + n > this.buf.length) this.grow(p + n);
    this.buf.set(src, p);
    this.pos = p + n;
  }

  /** Raw bytes from an ArrayBuffer / view, no length prefix. */
  bytesFrom(src: ArrayBuffer | ArrayBufferView): void {
    this.bytes(
      ArrayBuffer.isView(src)
        ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
        : new Uint8Array(src),
    );
  }

  // ----------------------------------------------------------------- strings

  /** String contents only (HaxBall UTF-8, no prefix). Official "writeStringContents". */
  stringRaw(s: string): void {
    const n = haxUtf8Length(s);
    const p = this.pos;
    if (p + n > this.buf.length) this.grow(p + n);
    this.pos = encodeHaxUtf8Into(s, this.buf, p);
  }

  /** `varuint byteLength` + HaxBall UTF-8. */
  string(s: string): void {
    this.varUint(haxUtf8Length(s));
    this.stringRaw(s);
  }

  /** `varuint (byteLength + 1)` + HaxBall UTF-8; `0` encodes `null`. */
  nullableString(s: string | null | undefined): void {
    if (s == null) {
      this.varUint(0);
      return;
    }
    this.varUint(haxUtf8Length(s) + 1);
    this.stringRaw(s);
  }

  /**
   * `u8 byteLength` + STANDARD UTF-8 (TextEncoder), as the official writer does
   * for this form (RoomInfo name/flag). Throws if longer than 255 bytes.
   * (node-haxball deviates here and uses the HaxBall encoder.)
   */
  stringU8(s: string): void {
    const enc = standardUtf8Encode(s);
    if (enc.length > 255) throw new CodecError('String too long for u8 length prefix');
    this.u8(enc.length);
    this.bytes(enc);
  }

  /** `JSON.stringify(value)` written with {@link string}. */
  json(value: unknown): void {
    this.string(JSON.stringify(value));
  }

  // ----------------------------------------------------------------- patches

  /** Overwrites a u8 at absolute offset `at` (< pos). Does not move `pos`. */
  setU8At(at: number, v: number): void {
    this.buf[at] = v;
  }

  /** Overwrites a big-endian u16 at absolute offset `at`. Does not move `pos`. */
  setU16At(at: number, v: number): void {
    this.view.setUint16(at, v);
  }

  /** Overwrites a big-endian u32 at absolute offset `at`. Does not move `pos`. */
  setU32At(at: number, v: number): void {
    this.view.setUint32(at, v);
  }

  // ----------------------------------------------------------------- output

  /** Zero-copy view of the written bytes; invalidated by the next write/reset. */
  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  /** Alias of {@link finish} (zero-copy), matching node-haxball's naming. */
  toUint8Array(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  /** Fresh copy of the written bytes. */
  copyBytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  /** Fresh ArrayBuffer containing exactly the written bytes. */
  toArrayBuffer(): ArrayBuffer {
    return this.buf.slice(0, this.pos).buffer;
  }
}
