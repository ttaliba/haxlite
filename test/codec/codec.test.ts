/**
 * Differential tests: src/codec vs node-haxball's StreamWriter/StreamReader
 * (which match the official headless writer/reader method by method; see
 * docs/06 §6). node-haxball public aliases are used where they exist; two of
 * its aliases are mislabeled by its own name table: instance `gM`
 * ("writeUTF8Char") is the varuint WRITER and `vM` ("readUTF8Char") is the
 * varuint READER — we call the minified names directly.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  CodecError,
  Reader,
  SIGNALING_INFLATE_LIMIT,
  Writer,
  decodeHaxUtf8,
  deflateRaw,
  encodeHaxUtf8,
  haxUtf8Length,
  inflateRaw,
  varUintSize,
  xorInt32Words,
} from '../../src/codec/index.js';
import { nhReader, nhWriter, prng } from '../oracle/index.js';

const require = createRequire(import.meta.url);
const pako = require('pako') as {
  deflateRaw(d: Uint8Array): Uint8Array;
  inflateRaw(d: Uint8Array): Uint8Array;
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const nhBytes = (w: { toUint8Array(): Uint8Array }) => Uint8Array.from(w.toUint8Array());

// ------------------------------------------------------------- value pools

const rnd = prng(42);
const ints: number[] = [
  0, 1, -1, 2, 63, 64, 127, 128, 129, 255, 256, 1000, 16383, 16384, 32767, 32768, -32768, 65535, 65536,
  2097151, 2097152, 268435455, 268435456, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), 2 ** 32 - 1, 2 ** 32, -2, 0x12345678,
  15035990, 5671397, 16777215, -2147483648, 1.5, -1.5, 300.7, NaN, Infinity, -Infinity,
];
for (let i = 0; i < 300; i++) {
  ints.push(Math.floor((rnd() - 0.5) * 2 ** (1 + Math.floor(rnd() * 33))));
}
const floats: number[] = [
  0, -0, 1, -1, 0.1, 1 / 3, Math.PI, 1e-310, 5e-324, Number.MAX_VALUE, Number.MIN_VALUE, Infinity, -Infinity, NaN,
  0.016666666666666666, 277.5, -277.5, 0.99, 0.96, 1e20, -1e-20, 3.4028234663852886e38, 1.1754943508222875e-38,
];
for (let i = 0; i < 300; i++) floats.push((rnd() - 0.5) * 10 ** Math.floor(rnd() * 20 - 10));

const strings: string[] = [
  '', 'a', 'Player', 'Classic', 'hé', 'ñandú', '€', '中文字符', 'é'.repeat(200), 'x'.repeat(300),
  '😀', 'a😀b', '👍🏽', '🇪🇸', '\u0000', '\u007f', '\u0080', '߿', 'ࠀ', '￿', '�',
  '\ud800', '\udfff', 'a\ud83dz', '\udc00\ud800', 'mixed ascii é 中 😀 \ud800 end',
  JSON.stringify({ a: [1, 2, 3], b: 'é😀' }),
];
for (let i = 0; i < 100; i++) {
  let s = '';
  const n = Math.floor(rnd() * 40);
  for (let k = 0; k < n; k++) s += String.fromCharCode(Math.floor(rnd() * 0x10000));
  strings.push(s);
}

// ------------------------------------------------------------------ writer

describe('Writer is byte-identical to node-haxball StreamWriter', () => {
  const cases: Array<[string, (w: Writer, v: never) => void, (n: any, v: never) => void, readonly unknown[]]> = [
    ['u8', (w, v) => w.u8(v), (n, v) => n.writeUint8(v), ints],
    ['i8', (w, v) => w.i8(v), (n, v) => n.writeUint8(v), ints],
    ['u16', (w, v) => w.u16(v), (n, v) => n.writeUint16(v), ints],
    ['i16', (w, v) => w.i16(v), (n, v) => n.writeInt16(v), ints],
    ['u32', (w, v) => w.u32(v), (n, v) => n.writeUint32(v), ints],
    ['i32', (w, v) => w.i32(v), (n, v) => n.writeInt32(v), ints],
    ['f32', (w, v) => w.f32(v), (n, v) => n.writeFloat32(v), floats],
    ['f64', (w, v) => w.f64(v), (n, v) => n.writeFloat64(v), floats],
    ['varUint', (w, v) => w.varUint(v), (n, v) => n.gM(v), ints],
    ['string', (w, v) => w.string(v), (n, v) => n.writeString(v), strings],
    ['nullableString', (w, v) => w.nullableString(v), (n, v) => n.writeNullableString(v), [...strings, null]],
    ['stringRaw', (w, v) => w.stringRaw(v), (n, v) => n.writeStringContents(v), strings],
    ['json', (w, v) => w.json(v), (n, v) => n.writeJSON(v), [null, 1, 'é😀', { a: 1, b: [true, null, 'x'] }, [1.5, -0]]],
  ];
  for (const [name, ours, theirs, values] of cases) {
    it(`${name} (${values.length} values, one at a time and concatenated)`, () => {
      const wAll = new Writer(1); // tiny initial capacity => exercises growth
      const nAll = nhWriter(1);
      for (const v of values) {
        const w = new Writer(4);
        const n = nhWriter(4);
        ours(w, v as never);
        theirs(n, v as never);
        expect(hex(w.finish()), `${name}(${String(v)})`).toBe(hex(nhBytes(n)));
        ours(wAll, v as never);
        theirs(nAll, v as never);
      }
      expect(hex(wAll.finish())).toBe(hex(nhBytes(nAll)));
    });
  }

  it('little-endian variants match a node-haxball writer in LE mode', () => {
    const w = new Writer();
    const n = nhWriter(8);
    n.littleEndian = true;
    for (const v of ints) {
      w.u16LE(v);
      n.writeUint16(v);
      w.i16LE(v);
      n.writeInt16(v);
      w.u32LE(v);
      n.writeUint32(v);
      w.i32LE(v);
      n.writeInt32(v);
    }
    for (const v of floats) {
      w.f32LE(v);
      n.writeFloat32(v);
      w.f64LE(v);
      n.writeFloat64(v);
    }
    expect(hex(w.finish())).toBe(hex(nhBytes(n)));
  });

  it('varuint quirk: 5th byte uses a signed shift (0x80000000 -> ...78)', () => {
    const w = new Writer();
    w.varUint(0x80000000);
    expect(hex(w.finish())).toBe('8080808078');
    w.reset();
    w.varUint(-1);
    expect(hex(w.finish())).toBe('ffffffff7f');
    expect(varUintSize(127)).toBe(1);
    expect(varUintSize(128)).toBe(2);
    expect(varUintSize(-1)).toBe(5);
  });

  it('stringU8 uses standard UTF-8 like the official writer (TextEncoder)', () => {
    const w = new Writer();
    w.stringU8('ES');
    w.stringU8('😀'); // 4-byte UTF-8 here, NOT the CESU-style 6 bytes
    expect(hex(w.finish())).toBe('024553' + '04f09f9880');
    // For BMP text it equals node-haxball's writeString2.
    const n = nhWriter();
    n.writeString2('ES');
    n.writeString2('Sala de prueba ñ');
    const w2 = new Writer();
    w2.stringU8('ES');
    w2.stringU8('Sala de prueba ñ');
    expect(hex(w2.finish())).toBe(hex(nhBytes(n)));
    expect(() => new Writer().stringU8('x'.repeat(256))).toThrow(CodecError);
  });

  it('CESU-8 style encoding of non-BMP characters', () => {
    expect(hex(encodeHaxUtf8('😀'))).toBe('eda0bdedb880');
    expect(haxUtf8Length('😀')).toBe(6);
    expect(hex(encodeHaxUtf8('\ud800'))).toBe('eda080'); // lone surrogate kept, no U+FFFD
  });

  it('reset() reuses the buffer; finish() is zero-copy; patches work', () => {
    const w = new Writer(8);
    w.u32(1);
    w.u32(2);
    w.u32(3); // grows
    const cap = w.capacity;
    const view = w.finish();
    expect(view.buffer).toBe(w.finish().buffer);
    const copy = w.copyBytes();
    w.reset();
    expect(w.length).toBe(0);
    w.u8(0); // placeholder
    w.u16(0);
    w.f64(1);
    w.setU8At(0, 9);
    w.setU16At(1, 0xbeef);
    expect(hex(w.finish().subarray(0, 3))).toBe('09beef');
    expect(w.capacity).toBe(cap);
    expect(hex(copy)).toBe('000000010000000200000003');
    expect(new Uint8Array(w.toArrayBuffer()).length).toBe(11);
  });
});

// ------------------------------------------------------------------ reader

describe('Reader reads what node-haxball writes (and vice versa)', () => {
  it('fixed-size ints/floats', () => {
    const n = nhWriter();
    for (const v of ints) {
      n.writeUint8(v);
      n.writeInt16(v);
      n.writeUint16(v);
      n.writeInt32(v);
      n.writeUint32(v);
    }
    for (const v of floats) {
      n.writeFloat32(v);
      n.writeFloat64(v);
    }
    const bytes = nhBytes(n);
    const r = new Reader(bytes);
    const nr = nhReader(bytes);
    for (let i = 0; i < ints.length; i++) {
      expect(r.u8()).toBe(nr.readUint8());
      expect(r.i16()).toBe(nr.readInt16());
      expect(r.u16()).toBe(nr.readUint16());
      expect(r.i32()).toBe(nr.readInt32());
      expect(r.u32()).toBe(nr.readUint32());
    }
    for (let i = 0; i < floats.length; i++) {
      expect(Object.is(r.f32(), nr.readFloat32())).toBe(true);
      expect(Object.is(r.f64(), nr.readFloat64())).toBe(true);
    }
    expect(r.remaining).toBe(0);
  });

  it('i8 / LE readers', () => {
    const r = new Reader(Uint8Array.of(0xff, 0x80, 0x01, 0x02, 0x01, 0x02, 0x03, 0x04));
    expect(r.i8()).toBe(-1);
    expect(r.i8()).toBe(-128);
    expect(r.u16LE()).toBe(0x0201);
    expect(r.u32LE()).toBe(0x04030201);
  });

  it('varuint, strings, nullable strings, json', () => {
    const n = nhWriter();
    for (const v of ints) n.gM(v);
    for (const s of strings) {
      n.writeString(s);
      n.writeNullableString(s);
    }
    n.writeNullableString(null);
    n.writeJSON({ a: 'é😀', b: [1, 2] });
    const bytes = nhBytes(n);
    const r = new Reader(bytes);
    const nr = nhReader(bytes);
    for (let i = 0; i < ints.length; i++) expect(r.varUint()).toBe(nr.vM());
    for (const s of strings) {
      const a = r.string();
      expect(a).toBe(nr.readString());
      expect(a).toBe(s);
      expect(r.nullableString()).toBe(nr.readNullableString());
    }
    expect(r.nullableString()).toBeNull();
    expect(r.json()).toEqual({ a: 'é😀', b: [1, 2] });
    expect(r.remaining).toBe(0);
  });

  it('our bytes are read back by node-haxball', () => {
    const w = new Writer();
    for (const s of strings) w.string(s);
    for (const v of ints) w.varUint(v);
    w.nullableString(null);
    const nr = nhReader(w.finish());
    for (const s of strings) expect(nr.readString()).toBe(s);
    for (const v of ints) expect(nr.vM()).toBe(v >>> 0 | 0);
    expect(nr.readNullableString()).toBeNull();
  });

  it('decodes standard 4-byte UTF-8 and legacy 5/6-byte forms like the official reader', () => {
    const emoji4 = Uint8Array.of(0xf0, 0x9f, 0x98, 0x80);
    expect(decodeHaxUtf8(emoji4, 0, 4)).toBe('😀');
    expect(new Reader(Uint8Array.of(4, ...emoji4)).string()).toBe(nhReader(Uint8Array.of(4, ...emoji4)).readString());
    // 5-byte form of U+0041 (overlong) decodes to "A" in the official reader
    const five = Uint8Array.of(0xf8, 0x80, 0x80, 0x81, 0x81);
    expect(decodeHaxUtf8(five, 0, 5)).toBe(nhReader(Uint8Array.of(5, ...five)).readString());
    // invalid lead byte
    expect(() => decodeHaxUtf8(Uint8Array.of(0xff), 0, 1)).toThrow(CodecError);
    expect(() => nhReader(Uint8Array.of(1, 0xff)).readString()).toThrow();
    // sequence overruns declared length
    expect(() => decodeHaxUtf8(Uint8Array.of(0xc3, 0xa9), 0, 1)).toThrow(/differs/);
    // u8-length string reader
    expect(new Reader(Uint8Array.of(2, 0x45, 0x53)).stringU8()).toBe('ES');
  });

  it('varuint reader keeps consuming continuation bytes past 5 and returns int32', () => {
    const r = new Reader(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0x81, 0x00, 0x07));
    const nr = nhReader(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0x81, 0x00, 0x07));
    expect(r.varUint()).toBe(nr.vM());
    expect(r.pos).toBe(7);
    expect(r.u8()).toBe(7);
    expect(new Reader(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x78)).varUint()).toBe(-(2 ** 31));
  });

  it('bounds: reading past the end throws', () => {
    const r = new Reader(Uint8Array.of(1, 2, 3));
    expect(() => r.u32()).toThrow(RangeError);
    expect(() => r.bytes(4)).toThrow(CodecError);
    expect(r.bytes().length).toBe(3);
    expect(() => new Reader(Uint8Array.of(0x80)).varUint()).toThrow(RangeError);
    expect(() => new Reader(Uint8Array.of(5, 0x41)).string()).toThrow();
  });

  it('works on subarrays (non-zero byteOffset)', () => {
    const big = Uint8Array.of(9, 9, 9, 0, 0, 0, 42, 2, 0x45, 0x53);
    const r = new Reader(big.subarray(3));
    expect(r.u32()).toBe(42);
    expect(r.string()).toBe('ES');
  });
});

// --------------------------------------------------------- deflate / hash

describe('raw deflate', () => {
  const payloads: Uint8Array[] = [new Uint8Array(0), Uint8Array.of(1, 2, 3)];
  for (let i = 0; i < 20; i++) {
    const b = new Uint8Array(1 + Math.floor(rnd() * 20000));
    for (let k = 0; k < b.length; k++) b[k] = rnd() < 0.7 ? k & 3 : Math.floor(rnd() * 256);
    payloads.push(b);
  }

  it('interoperates with pako in both directions', () => {
    for (const p of payloads) {
      expect(hex(pako.inflateRaw(deflateRaw(p)))).toBe(hex(p));
      expect(hex(inflateRaw(pako.deflateRaw(p)))).toBe(hex(p));
    }
  });

  it('enforces the signaling inflate limit (51200 accepted, 51201 rejected)', () => {
    expect(inflateRaw(deflateRaw(new Uint8Array(SIGNALING_INFLATE_LIMIT)), SIGNALING_INFLATE_LIMIT).length).toBe(
      SIGNALING_INFLATE_LIMIT,
    );
    expect(() => inflateRaw(deflateRaw(new Uint8Array(SIGNALING_INFLATE_LIMIT + 1)), SIGNALING_INFLATE_LIMIT)).toThrow(
      /exceeds limit/,
    );
    expect(() => inflateRaw(Uint8Array.of(0xff, 0xff, 0xff))).toThrow(CodecError);
  });
});

describe('xorInt32Words', () => {
  it('XORs complete big-endian words and ignores the tail', () => {
    expect(xorInt32Words(Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 3, 0xff))).toBe(2);
    expect(xorInt32Words(Uint8Array.of(0x80, 0, 0, 0))).toBe(-(2 ** 31));
    expect(xorInt32Words(new Uint8Array(3))).toBe(0);
  });
});
