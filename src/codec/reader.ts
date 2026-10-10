/**
 * Binary reader (clean-room equivalent of the official StreamReader).
 *
 * Big-endian by default with explicit `*LE` variants. Reads past the end throw
 * (RangeError from DataView for fixed-size reads, CodecError otherwise), as the
 * official reader does; on the network path any throw means "drop the peer".
 *
 * `bytes()` returns zero-copy subarrays of the input; use `bytesCopy()` if the
 * slice must outlive the input buffer.
 */
import { CodecError } from './errors.js';
import { decodeHaxUtf8 } from './utf8.js';

export class Reader {
  /** Current read position (relative to the start of `data`). */
  pos = 0;
  readonly data: Uint8Array;
  private readonly view: DataView;

  constructor(data: Uint8Array | ArrayBuffer, offset = 0) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    this.pos = offset;
  }

  get length(): number {
    return this.data.length;
  }

  /** Bytes left to read. */
  get remaining(): number {
    return this.data.length - this.pos;
  }

  // ---------------------------------------------------------------- integers

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  i8(): number {
    return this.view.getInt8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  // ------------------------------------------------------- little-endian ops

  u16LE(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16LE(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32LE(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32LE(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32LE(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64LE(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
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
