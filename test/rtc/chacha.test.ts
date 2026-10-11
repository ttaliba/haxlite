/**
 * Pure-JS ChaCha20-Poly1305 (src/rtc/dtls/chacha.ts): RFC 8439 vectors, a
 * BigInt reference Poly1305 (incl. the reduction edge cases of RFC 8439
 * App. A.3), and random equivalence with node:crypto's chacha20-poly1305.
 * (`HAXLITE_CHACHA_CASES=3000000` runs the long randomized comparison.)
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChaCha20Poly1305, poly1305 } from '../../src/rtc/dtls/chacha.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/[^0-9a-f]/gi, ''), 'hex');

/** Reference Poly1305 with BigInt (straight from RFC 8439 §2.5.1). */
function polyRef(key: Uint8Array, msg: Uint8Array): Buffer {
  const le = (b: Uint8Array) => {
    let x = 0n;
    for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
    return x;
  };
  const r = le(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = le(key.subarray(16, 32));
  const p = (1n << 130n) - 5n;
  let acc = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const blk = msg.subarray(i, Math.min(i + 16, msg.length));
    const n = le(blk) | (1n << BigInt(8 * blk.length));
    acc = ((acc + n) * r) % p;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = Number((acc >> BigInt(8 * i)) & 0xffn);
  return out;
}

function nodeSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array): { ct: Buffer; tag: Buffer } {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: pt.length });
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return { ct, tag: c.getAuthTag() };
}

describe('ChaCha20-Poly1305 (pure JS)', () => {
  it('RFC 8439 §2.5.2 Poly1305 vector', () => {
    const key = hex('85:d6:be:78:57:55:6d:33:7f:44:52:fe:42:d5:06:a8:01:03:80:8a:fb:0d:b2:fd:4a:bf:f6:af:41:49:f5:1b');
    const msg = Buffer.from('Cryptographic Forum Research Group');
    expect(Buffer.from(poly1305(key, msg)).toString('hex')).toBe('a8061dc1305136c6c22b8baf0c0127a9');
    expect(polyRef(key, msg).toString('hex')).toBe('a8061dc1305136c6c22b8baf0c0127a9');
  });

  it('Poly1305 reduction edge cases (RFC 8439 A.3 #5–#9) and random inputs match a BigInt reference', () => {
    const k = (r: string, s: string) => Buffer.concat([hex(r.padEnd(32, '0')), hex(s.padEnd(32, '0'))]);
    const ff = 'ff'.repeat(16);
    const cases: [Buffer, Buffer][] = [
      [k('02', '00'), hex(ff)],
      [k('02', ff), hex('02'.padEnd(32, '0'))],
      [k('01', '00'), hex(ff + 'f0' + 'ff'.repeat(15) + '11' + '00'.repeat(15))],
      [k('01', '00'), hex(ff + 'fb' + 'fe'.repeat(15) + '01'.repeat(16))],
      [k('02', '00'), hex('fd' + 'ff'.repeat(15))],
    ];
    const expectTags = ['03' + '00'.repeat(15), '03' + '00'.repeat(15), '05' + '00'.repeat(15), '00'.repeat(16), 'fa' + 'ff'.repeat(15)];
    cases.forEach(([key, msg], i) => {
      expect(Buffer.from(poly1305(key, msg)).toString('hex')).toBe(expectTags[i]);
      expect(polyRef(key, msg).toString('hex')).toBe(expectTags[i]);
    });
    // all-ones r (max clamped) and h near 2^130-5, random lengths
    for (let i = 0; i < 3000; i++) {
      const key = randomBytes(32);
      if (i % 4 === 0) key.fill(0xff, 0, 16);
      const msg = i % 5 === 0 ? Buffer.alloc(i % 97, 0xff) : randomBytes(i % 131);
      expect(Buffer.from(poly1305(key, msg)).equals(polyRef(key, msg))).toBe(true);
    }
  });

  it('RFC 8439 §2.8.2 AEAD vector (seal and open, in place)', () => {
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hex('070000004041424344454647');
    const aad = hex('50515253c0c1c2c3c4c5c6c7');
    const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const ct = hex(
      'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116',
    );
    const a = new ChaCha20Poly1305(key);
    const buf = Buffer.alloc(pt.length + 16);
    pt.copy(buf);
    a.seal(nonce, aad, 0, aad.length, buf, 0, pt.length, buf, pt.length);
    expect(buf.subarray(0, pt.length).toString('hex')).toBe(ct.toString('hex'));
    expect(buf.subarray(pt.length).toString('hex')).toBe('1ae10b594f09e26a7e902ecbd0600691');
    expect(a.open(nonce, aad, 0, aad.length, buf, 0, pt.length, buf, pt.length)).toBe(true);
    expect(buf.subarray(0, pt.length).equals(pt)).toBe(true);
  });

  it('rejects any modified byte (ciphertext, tag, AAD, nonce) without touching the buffer', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad = randomBytes(13);
    const a = new ChaCha20Poly1305(key);
    const pt = randomBytes(77);
    const sealed = Buffer.alloc(pt.length + 16);
    pt.copy(sealed);
    a.seal(nonce, aad, 0, 13, sealed, 0, pt.length, sealed, pt.length);
    for (let i = 0; i < sealed.length; i++) {
      const b = Buffer.from(sealed);
      b[i]! ^= 0x01;
      const before = Buffer.from(b);
      expect(a.open(nonce, aad, 0, 13, b, 0, pt.length, b, pt.length)).toBe(false);
      expect(b.equals(before)).toBe(true);
    }
    for (let i = 0; i < 13; i++) {
      const bad = Buffer.from(aad);
      bad[i]! ^= 0x80;
      expect(a.open(nonce, bad, 0, 13, Buffer.from(sealed), 0, pt.length, sealed, pt.length)).toBe(false);
    }
    const n2 = Buffer.from(nonce);
    n2[11]! ^= 1;
    expect(a.open(n2, aad, 0, 13, Buffer.from(sealed), 0, pt.length, sealed, pt.length)).toBe(false);
    expect(() => new ChaCha20Poly1305(randomBytes(16))).toThrow(RangeError);
  });

  it('matches node:crypto chacha20-poly1305 on random keys, nonces, AAD and lengths (0–1300 B, unaligned offsets)', () => {
    const cases = Number(process.env.HAXLITE_CHACHA_CASES ?? 20000);
    for (let i = 0; i < cases; i++) {
      const key = randomBytes(32);
      const nonce = randomBytes(12);
      const aadLen = i % 4 === 0 ? 13 : i % 41;
      const len = i % 50 === 0 ? 1200 + (i % 101) : (i * 7919) % 321;
      const aad = randomBytes(aadLen);
      const pt = randomBytes(len);
      const ref = nodeSeal(key, nonce, aad, pt);
      const off = i % 7;
      const buf = Buffer.alloc(off + len + 16 + 3);
      pt.copy(buf, off);
      const a = new ChaCha20Poly1305(key);
      a.seal(nonce, aad, 0, aadLen, buf, off, len, buf, off + len);
      if (!buf.subarray(off, off + len).equals(ref.ct) || !buf.subarray(off + len, off + len + 16).equals(ref.tag)) {
        throw new Error(`mismatch at case ${i} (len ${len}, aad ${aadLen})`);
      }
      if (!a.open(nonce, aad, 0, aadLen, buf, off, len, buf, off + len) || !buf.subarray(off, off + len).equals(pt)) {
        throw new Error(`open failed at case ${i}`);
      }
    }
  });
});
