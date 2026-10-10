/**
 * Binary reader (clean-room equivalent of the official StreamReader).
 *
 * Big-endian by default with explicit `*LE` variants. Reads past the end throw
 * (the DataView RangeError for fixed-size reads, CodecError otherwise), as the
 * official reader does; on the network path any throw means "drop the peer".
 * Fixed-size reads use byte arithmetic (no DataView per input buffer), and
 * {@link Reader.reset} re-targets a reader, so decoding allocates nothing.
 *
 * `bytes()` returns zero-copy subarrays of the input; use `bytesCopy()` if the
 * slice must outlive the input buffer.
 */
import { CodecError } from './errors.js';
import { decodeHaxUtf8 } from './utf8.js';

const OOB = 'Offset is outside the bounds of the DataView';

// Scratch for float decoding (no DataView per input buffer).
const F64 = new Float64Array(1);
const F32 = new Float32Array(1);
const F64B = new Uint8Array(F64.buffer);
const F32B = new Uint8Array(F32.buffer);
const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class Reader {
  /** Current read position (relative to the start of `data`). */
  pos = 0;
  /** Input bytes (replaced by {@link reset}). */
  data: Uint8Array;

  constructor(data: Uint8Array | ArrayBuffer, offset = 0) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.pos = offset;
  }

  /**
   * Re-targets this reader at new input (no allocation): lets a long-lived
   * reader decode every incoming message. Returns `this`.
   */
  reset(data: Uint8Array, offset = 0): this {
    this.data = data;
    this.pos = offset;
    return this;
  }

  get length(): number {
    return this.data.length;
  }

  /** Bytes left to read. */
  get remaining(): number {
    return this.data.length - this.pos;
  }

  /** Position of an `n`-byte fixed-size read; throws like DataView past the end. */
  private take(n: number): number {
    const p = this.pos;
    if (p + n > this.data.length) throw new RangeError(OOB);
    this.pos = p + n;
    return p;
  }

  // ---------------------------------------------------------------- integers
  // Byte arithmetic instead of a DataView: no view object per input buffer.

  u8(): number {
    const p = this.pos;
    if (p >= this.data.length) throw new RangeError(OOB);
    this.pos = p + 1;
    return this.data[p]!;
  }

  i8(): number {
    return (this.u8() << 24) >> 24;
  }

  u16(): number {
    const p = this.take(2);
    const d = this.data;
    return (d[p]! << 8) | d[p + 1]!;
  }

  i16(): number {
    return (this.u16() << 16) >> 16;
  }

  u32(): number {
    return this.i32() >>> 0;
  }

  i32(): number {
    const p = this.take(4);
    const d = this.data;
    return (d[p]! << 24) | (d[p + 1]! << 16) | (d[p + 2]! << 8) | d[p + 3]!;
  }

  f32(): number {
    return this.float32(false);
  }

  f64(): number {
    return this.float64(false);
  }

  // ------------------------------------------------------- little-endian ops

  u16LE(): number {
    const p = this.take(2);
    const d = this.data;
    return d[p]! | (d[p + 1]! << 8);
  }

  i16LE(): number {
    return (this.u16LE() << 16) >> 16;
  }

  u32LE(): number {
    return this.i32LE() >>> 0;
  }

  i32LE(): number {
    const p = this.take(4);
    const d = this.data;
    return d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24);
  }

  f32LE(): number {
    return this.float32(true);
  }

  f64LE(): number {
    return this.float64(true);
  }

  private float32(le: boolean): number {
    const p = this.take(4);
    const d = this.data;
    if (le === HOST_LE) for (let i = 0; i < 4; i++) F32B[i] = d[p + i]!;
    else for (let i = 0; i < 4; i++) F32B[i] = d[p + 3 - i]!;
    return F32[0]!;
  }

  private float64(le: boolean): number {
    const p = this.take(8);
    const d = this.data;
    if (le === HOST_LE) for (let i = 0; i < 8; i++) F64B[i] = d[p + i]!;
    else for (let i = 0; i < 8; i++) F64B[i] = d[p + 7 - i]!;
    return F64[0]!;
  }

  // ------------------------------------------------------------------ varint

  /**
   * Unsigned LEB128 as the official reader: keeps consuming while the
   * continuation bit is set (no hard 5-byte stop), only the first 5 groups
   * contribute, and the result is returned as int32 (`| 0`), so values
   * >= 2^31 come back negative.
   */
  varUint(): number {
    const d = this.data;
    const len = d.length;
    let p = this.pos;
    let shift = 0;
    let result = 0;
    let c: number;
    do {
      if (p >= len) throw new RangeError('Offset is outside the bounds of the DataView');
      c = d[p++]!;
      if (shift < 35) result |= ((c & 0x7f) << shift) >>> 0;
      shift += 7;
    } while ((c & 0x80) !== 0);
    this.pos = p;
    return result | 0;
  }

  // ------------------------------------------------------------------- bytes

  /** Zero-copy slice of `n` bytes (default: all remaining). Throws "Read too much". */
  bytes(n?: number): Uint8Array {
    const count = n ?? this.data.length - this.pos;
    if (count < 0 || this.pos + count > this.data.length) throw new CodecError('Read too much');
    const out = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  /** Copied slice of `n` bytes (default: all remaining). */
  bytesCopy(n?: number): Uint8Array {
    return this.bytes(n).slice();
  }

  // ----------------------------------------------------------------- strings

  /** `byteLength` bytes of HaxBall UTF-8 (no prefix). */
  stringRaw(byteLength: number): string {
    const s = decodeHaxUtf8(this.data, this.pos, byteLength);
    this.pos += byteLength;
    return s;
  }

  /** `varuint byteLength` + HaxBall UTF-8. */
  string(): string {
    return this.stringRaw(this.varUint());
  }

  /** `varuint (byteLength + 1)`; values <= 0 mean `null`. */
  nullableString(): string | null {
    const n = this.varUint();
    return n <= 0 ? null : this.stringRaw(n - 1);
  }

  /** `u8 byteLength` + UTF-8 (decoded with the HaxBall decoder, as officially). */
  stringU8(): string {
    return this.stringRaw(this.u8());
  }

  /** {@link string} parsed with `JSON.parse`. */
  json<T = unknown>(): T {
    return JSON.parse(this.string()) as T;
  }
}
