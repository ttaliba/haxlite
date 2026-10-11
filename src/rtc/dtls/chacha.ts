/**
 * ChaCha20-Poly1305 AEAD (RFC 8439) in plain JavaScript, for the DTLS record
 * layer (TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, RFC 7905).
 *
 * Why not node:crypto: an AEAD there needs a fresh native Cipher object per
 * record (GCM/ChaCha ciphers cannot be re-keyed with a new nonce) plus fresh
 * output and tag Buffers. At HaxBall rates (thousands of 30–300 B records per
 * second) that is the bulk of the host's young-generation garbage, and the
 * native-backed objects lengthen GC pauses. This implementation encrypts in
 * place, keeps all state in preallocated typed arrays and allocates nothing
 * per record; for small records it is also faster than the native path (the
 * JS↔C++ crossings dominate there; see docs/10 §6.3).
 *
 * Constant time (as far as JavaScript allows): ChaCha20 is pure ARX on int32;
 * Poly1305 uses 13-bit limbs (poly1305-donna-16 layout, as in stablelib /
 * tweetnacl-js) whose partial products stay below 2^32, so no value ever
 * leaves the exact integer range, there are no secret-dependent branches or
 * table lookups, the final reduction selects with masks and the tag check
 * ORs all byte differences. AES is deliberately NOT implemented in JS (table
 * lookups are not constant time): AES-GCM suites keep using node:crypto.
 *
 * Endianness-independent (bytes are assembled with shifts).
 */

/** Keystream block scratch (16 words). Single-threaded: shared by every instance. */
const KS = new Int32Array(16);
/** Poly1305 state: h[0..9], r[10..19], s (pad) as 16-bit words [20..27]. */
const P = new Int32Array(28);
/** Zero-padded partial block / length block scratch. */
const PB = new Uint8Array(16);

const C0 = 0x61707865;
const C1 = 0x3320646e;
const C2 = 0x79622d32;
const C3 = 0x6b206574;

/** One ChaCha20 block (RFC 8439 §2.3) for `counter` into {@link KS}. */
function chachaBlock(k: Int32Array, counter: number, n0: number, n1: number, n2: number): void {
  const k0 = k[0]!, k1 = k[1]!, k2 = k[2]!, k3 = k[3]!, k4 = k[4]!, k5 = k[5]!, k6 = k[6]!, k7 = k[7]!;
  let x0 = C0, x1 = C1, x2 = C2, x3 = C3;
  let x4 = k0, x5 = k1, x6 = k2, x7 = k3, x8 = k4, x9 = k5, x10 = k6, x11 = k7;
  let x12 = counter | 0, x13 = n0, x14 = n1, x15 = n2;
  for (let i = 0; i < 10; i++) {
    // column rounds
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 16) | (x12 >>> 16);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 12) | (x4 >>> 20);
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 8) | (x12 >>> 24);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 7) | (x4 >>> 25);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 16) | (x13 >>> 16);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 12) | (x5 >>> 20);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 8) | (x13 >>> 24);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 7) | (x5 >>> 25);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 16) | (x14 >>> 16);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 12) | (x6 >>> 20);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 8) | (x14 >>> 24);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 7) | (x6 >>> 25);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 16) | (x15 >>> 16);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 12) | (x7 >>> 20);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 8) | (x15 >>> 24);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 7) | (x7 >>> 25);
    // diagonal rounds
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 16) | (x15 >>> 16);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 12) | (x5 >>> 20);
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 8) | (x15 >>> 24);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 7) | (x5 >>> 25);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 16) | (x12 >>> 16);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 12) | (x6 >>> 20);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 8) | (x12 >>> 24);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 7) | (x6 >>> 25);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 16) | (x13 >>> 16);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 12) | (x7 >>> 20);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 8) | (x13 >>> 24);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 7) | (x7 >>> 25);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 16) | (x14 >>> 16);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 12) | (x4 >>> 20);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 8) | (x14 >>> 24);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 7) | (x4 >>> 25);
  }
  const o = KS;
  o[0] = (x0 + C0) | 0; o[1] = (x1 + C1) | 0; o[2] = (x2 + C2) | 0; o[3] = (x3 + C3) | 0;
  o[4] = (x4 + k0) | 0; o[5] = (x5 + k1) | 0; o[6] = (x6 + k2) | 0; o[7] = (x7 + k3) | 0;
  o[8] = (x8 + k4) | 0; o[9] = (x9 + k5) | 0; o[10] = (x10 + k6) | 0; o[11] = (x11 + k7) | 0;
  o[12] = (x12 + counter) | 0; o[13] = (x13 + n0) | 0; o[14] = (x14 + n1) | 0; o[15] = (x15 + n2) | 0;
}

/** XORs the ChaCha20 keystream (blocks counter, counter+1, …) into buf[off, off+len) in place. */
function chachaXor(k: Int32Array, counter: number, n0: number, n1: number, n2: number, buf: Uint8Array, off: number, len: number): void {
  const ks = KS;
  while (len > 0) {
    chachaBlock(k, counter, n0, n1, n2);
    counter = (counter + 1) | 0;
    if (len >= 64) {
      for (let i = 0; i < 16; i++) {
        const w = ks[i]!;
        const p = off + 4 * i;
        buf[p] ^= w;
        buf[p + 1] ^= w >>> 8;
        buf[p + 2] ^= w >>> 16;
        buf[p + 3] ^= w >>> 24;
      }
      off += 64;
      len -= 64;
    } else {
      for (let i = 0; i < len; i++) buf[off + i] ^= ks[i >>> 2]! >>> ((i & 3) << 3);
      return;
    }
  }
}

/** Poly1305 key = first 32 bytes of keystream block 0 (in {@link KS}): clamps r, resets h. */
function polyInit(): void {
  const ks = KS;
  const w0 = ks[0]!, w1 = ks[1]!, w2 = ks[2]!, w3 = ks[3]!;
  // r as 16-bit words, clamped (RFC 8439 §2.5: r &= 0x0ffffffc0ffffffc0ffffffc0fffffff)
  const t0 = w0 & 0xffff;
  const t1 = (w0 >>> 16) & 0x0fff;
  const t2 = w1 & 0xfffc;
  const t3 = (w1 >>> 16) & 0x0fff;
  const t4 = w2 & 0xfffc;
  const t5 = (w2 >>> 16) & 0x0fff;
  const t6 = w3 & 0xfffc;
  const t7 = (w3 >>> 16) & 0x0fff;
  const p = P;
  for (let i = 0; i < 10; i++) p[i] = 0;
  p[10] = t0 & 0x1fff;
  p[11] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
  p[12] = ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
  p[13] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
  p[14] = ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
  p[15] = (t4 >>> 1) & 0x1fff;
  p[16] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
  p[17] = ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
  p[18] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
  p[19] = (t7 >>> 5) & 0x1fff;
  for (let i = 0; i < 4; i++) {
    const w = ks[4 + i]!;
    p[20 + 2 * i] = w & 0xffff;
    p[21 + 2 * i] = w >>> 16;
  }
}

/** Absorbs `len` bytes (a multiple of 16) of blocks from m[off…]; `hibit` = 1 << 11 (2^128) for full blocks. */
function polyBlocks(m: Uint8Array, off: number, len: number, hibit = 1 << 11): void {
  const p = P;
  let h0 = p[0]!, h1 = p[1]!, h2 = p[2]!, h3 = p[3]!, h4 = p[4]!, h5 = p[5]!, h6 = p[6]!, h7 = p[7]!, h8 = p[8]!, h9 = p[9]!;
  const r0 = p[10]!, r1 = p[11]!, r2 = p[12]!, r3 = p[13]!, r4 = p[14]!, r5 = p[15]!, r6 = p[16]!, r7 = p[17]!, r8 = p[18]!, r9 = p[19]!;
  const s1 = 5 * r1, s2 = 5 * r2, s3 = 5 * r3, s4 = 5 * r4, s5 = 5 * r5, s6 = 5 * r6, s7 = 5 * r7, s8 = 5 * r8, s9 = 5 * r9;
  while (len >= 16) {
    const t0 = m[off]! | (m[off + 1]! << 8);
    const t1 = m[off + 2]! | (m[off + 3]! << 8);
    const t2 = m[off + 4]! | (m[off + 5]! << 8);
    const t3 = m[off + 6]! | (m[off + 7]! << 8);
    const t4 = m[off + 8]! | (m[off + 9]! << 8);
    const t5 = m[off + 10]! | (m[off + 11]! << 8);
    const t6 = m[off + 12]! | (m[off + 13]! << 8);
    const t7 = m[off + 14]! | (m[off + 15]! << 8);
    h0 += t0 & 0x1fff;
    h1 += ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
    h2 += ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
    h3 += ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
    h4 += ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
    h5 += (t4 >>> 1) & 0x1fff;
    h6 += ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
    h7 += ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
    h8 += ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
    h9 += (t7 >>> 5) | hibit;

    // h *= r (mod 2^130 - 5); every partial sum of five products stays < 2^32
    let c = 0;
    let d0 = c;
    d0 += h0 * r0;
    d0 += h1 * s9;
    d0 += h2 * s8;
    d0 += h3 * s7;
    d0 += h4 * s6;
    c = d0 >>> 13;
    d0 &= 0x1fff;
    d0 += h5 * s5;
    d0 += h6 * s4;
    d0 += h7 * s3;
    d0 += h8 * s2;
    d0 += h9 * s1;
    c += d0 >>> 13;
    d0 &= 0x1fff;
    let d1 = c;
    d1 += h0 * r1;
    d1 += h1 * r0;
    d1 += h2 * s9;
    d1 += h3 * s8;
    d1 += h4 * s7;
    c = d1 >>> 13;
    d1 &= 0x1fff;
    d1 += h5 * s6;
    d1 += h6 * s5;
    d1 += h7 * s4;
    d1 += h8 * s3;
    d1 += h9 * s2;
    c += d1 >>> 13;
    d1 &= 0x1fff;
    let d2 = c;
    d2 += h0 * r2;
    d2 += h1 * r1;
    d2 += h2 * r0;
    d2 += h3 * s9;
    d2 += h4 * s8;
    c = d2 >>> 13;
    d2 &= 0x1fff;
    d2 += h5 * s7;
    d2 += h6 * s6;
    d2 += h7 * s5;
    d2 += h8 * s4;
    d2 += h9 * s3;
    c += d2 >>> 13;
    d2 &= 0x1fff;
    let d3 = c;
    d3 += h0 * r3;
    d3 += h1 * r2;
    d3 += h2 * r1;
    d3 += h3 * r0;
    d3 += h4 * s9;
    c = d3 >>> 13;
    d3 &= 0x1fff;
    d3 += h5 * s8;
    d3 += h6 * s7;
    d3 += h7 * s6;
    d3 += h8 * s5;
    d3 += h9 * s4;
    c += d3 >>> 13;
    d3 &= 0x1fff;
    let d4 = c;
    d4 += h0 * r4;
    d4 += h1 * r3;
    d4 += h2 * r2;
    d4 += h3 * r1;
    d4 += h4 * r0;
    c = d4 >>> 13;
    d4 &= 0x1fff;
    d4 += h5 * s9;
    d4 += h6 * s8;
    d4 += h7 * s7;
    d4 += h8 * s6;
    d4 += h9 * s5;
    c += d4 >>> 13;
    d4 &= 0x1fff;
    let d5 = c;
    d5 += h0 * r5;
    d5 += h1 * r4;
    d5 += h2 * r3;
    d5 += h3 * r2;
    d5 += h4 * r1;
    c = d5 >>> 13;
    d5 &= 0x1fff;
    d5 += h5 * r0;
    d5 += h6 * s9;
    d5 += h7 * s8;
    d5 += h8 * s7;
    d5 += h9 * s6;
    c += d5 >>> 13;
    d5 &= 0x1fff;
    let d6 = c;
    d6 += h0 * r6;
    d6 += h1 * r5;
    d6 += h2 * r4;
    d6 += h3 * r3;
    d6 += h4 * r2;
    c = d6 >>> 13;
    d6 &= 0x1fff;
    d6 += h5 * r1;
    d6 += h6 * r0;
    d6 += h7 * s9;
    d6 += h8 * s8;
    d6 += h9 * s7;
    c += d6 >>> 13;
    d6 &= 0x1fff;
    let d7 = c;
    d7 += h0 * r7;
    d7 += h1 * r6;
    d7 += h2 * r5;
    d7 += h3 * r4;
    d7 += h4 * r3;
    c = d7 >>> 13;
    d7 &= 0x1fff;
    d7 += h5 * r2;
    d7 += h6 * r1;
    d7 += h7 * r0;
    d7 += h8 * s9;
    d7 += h9 * s8;
    c += d7 >>> 13;
    d7 &= 0x1fff;
    let d8 = c;
    d8 += h0 * r8;
    d8 += h1 * r7;
    d8 += h2 * r6;
    d8 += h3 * r5;
    d8 += h4 * r4;
    c = d8 >>> 13;
    d8 &= 0x1fff;
    d8 += h5 * r3;
    d8 += h6 * r2;
    d8 += h7 * r1;
    d8 += h8 * r0;
    d8 += h9 * s9;
    c += d8 >>> 13;
    d8 &= 0x1fff;
    let d9 = c;
    d9 += h0 * r9;
    d9 += h1 * r8;
    d9 += h2 * r7;
    d9 += h3 * r6;
    d9 += h4 * r5;
    c = d9 >>> 13;
    d9 &= 0x1fff;
    d9 += h5 * r4;
    d9 += h6 * r3;
    d9 += h7 * r2;
    d9 += h8 * r1;
    d9 += h9 * r0;
    c += d9 >>> 13;
    d9 &= 0x1fff;
    c = ((c << 2) + c) | 0;
    c = (c + d0) | 0;
    d0 = c & 0x1fff;
    c = c >>> 13;
    d1 += c;

    h0 = d0; h1 = d1; h2 = d2; h3 = d3; h4 = d4; h5 = d5; h6 = d6; h7 = d7; h8 = d8; h9 = d9;
    off += 16;
    len -= 16;
  }
  p[0] = h0; p[1] = h1; p[2] = h2; p[3] = h3; p[4] = h4; p[5] = h5; p[6] = h6; p[7] = h7; p[8] = h8; p[9] = h9;
}

/** Absorbs m[off, off+len) zero-padded to a multiple of 16 (RFC 8439 §2.8 pad16). */
function polyPadded(m: Uint8Array, off: number, len: number): void {
  const full = len & ~15;
  if (full > 0) polyBlocks(m, off, full);
  const rest = len - full;
  if (rest > 0) {
    const b = PB;
    for (let i = 0; i < 16; i++) b[i] = i < rest ? m[off + full + i]! : 0;
    polyBlocks(b, 0, 16);
  }
}

/** Absorbs le64(aadLen) || le64(ctLen) (both < 2^32 here). */
function polyLengths(aadLen: number, ctLen: number): void {
  const b = PB;
  b[0] = aadLen; b[1] = aadLen >>> 8; b[2] = aadLen >>> 16; b[3] = aadLen >>> 24;
  b[4] = 0; b[5] = 0; b[6] = 0; b[7] = 0;
  b[8] = ctLen; b[9] = ctLen >>> 8; b[10] = ctLen >>> 16; b[11] = ctLen >>> 24;
  b[12] = 0; b[13] = 0; b[14] = 0; b[15] = 0;
  polyBlocks(b, 0, 16);
}

/**
 * Final reduction of h mod 2^130-5 and tag = (h + s) mod 2^128, written as
 * 16 bytes to out[off…] or, with `out` null, compared (constant time) with
 * tag[off…]. Returns true when written / equal.
 */
function polyFinish(out: Uint8Array | null, cmp: Uint8Array | null, off: number): boolean {
  const p = P;
  let h0 = p[0]!, h1 = p[1]!, h2 = p[2]!, h3 = p[3]!, h4 = p[4]!, h5 = p[5]!, h6 = p[6]!, h7 = p[7]!, h8 = p[8]!, h9 = p[9]!;
  // full carry
  let c = h1 >>> 13; h1 &= 0x1fff;
  h2 += c; c = h2 >>> 13; h2 &= 0x1fff;
  h3 += c; c = h3 >>> 13; h3 &= 0x1fff;
  h4 += c; c = h4 >>> 13; h4 &= 0x1fff;
  h5 += c; c = h5 >>> 13; h5 &= 0x1fff;
  h6 += c; c = h6 >>> 13; h6 &= 0x1fff;
  h7 += c; c = h7 >>> 13; h7 &= 0x1fff;
  h8 += c; c = h8 >>> 13; h8 &= 0x1fff;
  h9 += c; c = h9 >>> 13; h9 &= 0x1fff;
  h0 += c * 5; c = h0 >>> 13; h0 &= 0x1fff;
  h1 += c; c = h1 >>> 13; h1 &= 0x1fff;
  h2 += c;
  // g = h + 5 - 2^130; keep g if it did not borrow (i.e. h >= p)
  let g0 = h0 + 5; c = g0 >>> 13; g0 &= 0x1fff;
  let g1 = h1 + c; c = g1 >>> 13; g1 &= 0x1fff;
  let g2 = h2 + c; c = g2 >>> 13; g2 &= 0x1fff;
  let g3 = h3 + c; c = g3 >>> 13; g3 &= 0x1fff;
  let g4 = h4 + c; c = g4 >>> 13; g4 &= 0x1fff;
  let g5 = h5 + c; c = g5 >>> 13; g5 &= 0x1fff;
  let g6 = h6 + c; c = g6 >>> 13; g6 &= 0x1fff;
  let g7 = h7 + c; c = g7 >>> 13; g7 &= 0x1fff;
  let g8 = h8 + c; c = g8 >>> 13; g8 &= 0x1fff;
  let g9 = h9 + c; c = g9 >>> 13; g9 &= 0x1fff;
  // c = 1 → h + 5 >= 2^130 → select g (mask all ones); c = 0 → keep h
  const mg = -c | 0;
  const mh = ~mg;
  h0 = (h0 & mh) | (g0 & mg);
  h1 = (h1 & mh) | (g1 & mg);
  h2 = (h2 & mh) | (g2 & mg);
  h3 = (h3 & mh) | (g3 & mg);
  h4 = (h4 & mh) | (g4 & mg);
  h5 = (h5 & mh) | (g5 & mg);
  h6 = (h6 & mh) | (g6 & mg);
  h7 = (h7 & mh) | (g7 & mg);
  h8 = (h8 & mh) | (g8 & mg);
  h9 = (h9 & mh) | (g9 & mg);
  // to 16-bit words (low 128 bits)
  const w0 = (h0 | (h1 << 13)) & 0xffff;
  const w1 = ((h1 >>> 3) | (h2 << 10)) & 0xffff;
  const w2 = ((h2 >>> 6) | (h3 << 7)) & 0xffff;
  const w3 = ((h3 >>> 9) | (h4 << 4)) & 0xffff;
  const w4 = ((h4 >>> 12) | (h5 << 1) | (h6 << 14)) & 0xffff;
  const w5 = ((h6 >>> 2) | (h7 << 11)) & 0xffff;
  const w6 = ((h7 >>> 5) | (h8 << 8)) & 0xffff;
  const w7 = ((h8 >>> 8) | (h9 << 5)) & 0xffff;
  // + s mod 2^128, little-endian
  let f = w0 + p[20]!;
  let diff = putTagWord(out, cmp, off, f);
  f = w1 + p[21]! + (f >>> 16);
  diff |= putTagWord(out, cmp, off + 2, f);
  f = w2 + p[22]! + (f >>> 16);
  diff |= putTagWord(out, cmp, off + 4, f);
  f = w3 + p[23]! + (f >>> 16);
  diff |= putTagWord(out, cmp, off + 6, f);
  f = w4 + p[24]! + (f >>> 16);
  diff |= putTagWord(out, cmp, off + 8, f);
  f = w5 + p[25]! + (f >>> 16);
  diff |= putTagWord(out, cmp, off + 10, f);
  f = w6 + p[26]! + (f >>> 16);
  diff |= putTagWord(out, cmp, off + 12, f);
  f = w7 + p[27]! + (f >>> 16);
  diff |= putTagWord(out, cmp, off + 14, f);
  return out !== null || diff === 0;
}

/** Writes the low 16 bits of `f` (LE) to out[o…], or returns their difference with cmp[o…]. */
function putTagWord(out: Uint8Array | null, cmp: Uint8Array | null, o: number, f: number): number {
  if (out !== null) {
    out[o] = f;
    out[o + 1] = f >>> 8;
    return 0;
  }
  return (cmp![o]! ^ (f & 0xff)) | (cmp![o + 1]! ^ ((f >>> 8) & 0xff));
}

/** Reads 12 nonce bytes as three little-endian words into n[0..2]. */
function nonceWords(nonce: Uint8Array, n: Int32Array): void {
  for (let i = 0; i < 3; i++) {
    n[i] = nonce[4 * i]! | (nonce[4 * i + 1]! << 8) | (nonce[4 * i + 2]! << 16) | (nonce[4 * i + 3]! << 24);
  }
}

const NW = new Int32Array(3);

/** ChaCha20-Poly1305 with one 256-bit key; every call is allocation-free. */
export class ChaCha20Poly1305 {
  private readonly k = new Int32Array(8);

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new RangeError('ChaCha20-Poly1305 key must be 32 bytes');
    for (let i = 0; i < 8; i++) {
      this.k[i] = key[4 * i]! | (key[4 * i + 1]! << 8) | (key[4 * i + 2]! << 16) | (key[4 * i + 3]! << 24);
    }
  }

  /**
   * Encrypts buf[off, off+len) in place and writes the 16-byte tag to
   * tagOut[tagOff…] (which may directly follow the ciphertext).
   */
  seal(
    nonce: Uint8Array,
    aad: Uint8Array,
    aadOff: number,
    aadLen: number,
    buf: Uint8Array,
    off: number,
    len: number,
    tagOut: Uint8Array,
    tagOff: number,
  ): void {
    const n = NW;
    nonceWords(nonce, n);
    const n0 = n[0]!, n1 = n[1]!, n2 = n[2]!;
    chachaBlock(this.k, 0, n0, n1, n2);
    polyInit();
    chachaXor(this.k, 1, n0, n1, n2, buf, off, len);
    polyPadded(aad, aadOff, aadLen);
    polyPadded(buf, off, len);
    polyLengths(aadLen, len);
    polyFinish(tagOut, null, tagOff);
  }

  /**
   * Verifies the tag at tag[tagOff…] over buf[off, off+len) and, only when it
   * authenticates, decrypts buf[off, off+len) in place. Returns false (buffer
   * untouched) otherwise.
   */
  open(
    nonce: Uint8Array,
    aad: Uint8Array,
    aadOff: number,
    aadLen: number,
    buf: Uint8Array,
    off: number,
    len: number,
    tag: Uint8Array,
    tagOff: number,
  ): boolean {
    const n = NW;
    nonceWords(nonce, n);
    const n0 = n[0]!, n1 = n[1]!, n2 = n[2]!;
    chachaBlock(this.k, 0, n0, n1, n2);
    polyInit();
    polyPadded(aad, aadOff, aadLen);
    polyPadded(buf, off, len);
    polyLengths(aadLen, len);
    if (!polyFinish(null, tag, tagOff)) return false;
    chachaXor(this.k, 1, n0, n1, n2, buf, off, len);
    return true;
  }

  /** Overwrites the key schedule (best effort hygiene on close). */
  wipe(): void {
    this.k.fill(0);
  }
}

/**
 * Plain Poly1305 MAC (RFC 8439 §2.5) of `msg` under a 32-byte one-time key —
 * for tests against the RFC vectors and a BigInt reference; the record layer
 * only uses the AEAD.
 */
export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  for (let i = 0; i < 8; i++) KS[i] = key[4 * i]! | (key[4 * i + 1]! << 8) | (key[4 * i + 2]! << 16) | (key[4 * i + 3]! << 24);
  polyInit();
  const full = msg.length & ~15;
  if (full > 0) polyBlocks(msg, 0, full);
  const rest = msg.length - full;
  if (rest > 0) {
    // final partial block: append 0x01, zero-pad, no 2^128 bit
    for (let i = 0; i < 16; i++) PB[i] = i < rest ? msg[full + i]! : i === rest ? 1 : 0;
    polyBlocks(PB, 0, 16, 0);
  }
  const out = new Uint8Array(16);
  polyFinish(out, null, 0);
  return out;
}
