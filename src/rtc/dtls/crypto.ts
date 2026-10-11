/**
 * DTLS 1.2 cryptographic building blocks: the TLS 1.2 PRF (RFC 5246 §5),
 * the AEAD record protection of the supported cipher suites (AES-GCM per
 * RFC 5288/6347, ChaCha20-Poly1305 per RFC 7905) and the anti-replay
 * window (RFC 6347 §4.1.2.6).
 */
import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

// ---------------------------------------------------------------- PRF

/** P_hash(secret, label || seed) truncated to `length` (RFC 5246 §5). */
export function prf(hash: 'sha256' | 'sha384', secret: Uint8Array, label: string, seed: Uint8Array, length: number): Buffer {
  const labelSeed = Buffer.concat([Buffer.from(label, 'latin1'), seed]);
  const out = Buffer.allocUnsafe(length);
  let a: Buffer = labelSeed; // A(0)
  let off = 0;
  while (off < length) {
    a = createHmac(hash, secret).update(a).digest(); // A(i)
    const block = createHmac(hash, secret).update(a).update(labelSeed).digest();
    const n = Math.min(block.length, length - off);
    block.copy(out, off, 0, n);
    off += n;
  }
  return out;
}

// ---------------------------------------------------------------- cipher suites

export interface CipherSuite {
  id: number;
  name: string;
  /** Node cipher name. */
  cipher: 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-poly1305';
  /** PRF / transcript hash. */
  hash: 'sha256' | 'sha384';
  keyLength: number;
  /** Fixed IV length from the key block (GCM salt 4, ChaCha 12). */
  ivLength: number;
  /** Explicit per-record nonce carried in the record (GCM 8, ChaCha 0). */
  explicitNonce: number;
}

export const SUITES: readonly CipherSuite[] = [
  {
    id: 0xc02b,
    name: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
    cipher: 'aes-128-gcm',
    hash: 'sha256',
    keyLength: 16,
    ivLength: 4,
    explicitNonce: 8,
  },
  {
    id: 0xc02c,
    name: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
    cipher: 'aes-256-gcm',
    hash: 'sha384',
    keyLength: 32,
    ivLength: 4,
    explicitNonce: 8,
  },
  {
    id: 0xcca9,
    name: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
    cipher: 'chacha20-poly1305',
    hash: 'sha256',
    keyLength: 32,
    ivLength: 12,
    explicitNonce: 0,
  },
];

export const TAG_LENGTH = 16;
export const RECORD_HEADER = 13;

/**
 * One direction of record protection for one epoch. `seal`/`open` take the
 * record header fields; the nonce/AAD scratch buffers are reused.
 */
export class RecordCipher {
  readonly suite: CipherSuite;
  private readonly key: Buffer;
  private readonly iv: Buffer;
  private readonly nonce = Buffer.alloc(12);
  private readonly aad = Buffer.alloc(13);

  constructor(suite: CipherSuite, key: Buffer, iv: Buffer) {
    this.suite = suite;
    this.key = key;
    this.iv = iv;
  }

  /** Bytes added to a plaintext by {@link seal}. */
  get overhead(): number {
    return this.suite.explicitNonce + TAG_LENGTH;
  }

  private setNonce(epoch: number, seqHi: number, seqLo: number): void {
    const n = this.nonce;
    if (this.suite.explicitNonce === 8) {
      // GCM: salt(4) || epoch(2) || seq(6)
      this.iv.copy(n, 0, 0, 4);
      n.writeUInt16BE(epoch, 4);
      n.writeUInt16BE(seqHi, 6);
      n.writeUInt32BE(seqLo, 8);
    } else {
      // ChaCha20-Poly1305 (RFC 7905 §2): iv XOR (0^32 || epoch || seq)
      this.iv.copy(n, 0, 0, 12);
      n[4] = n[4]! ^ (epoch >>> 8);
      n[5] = n[5]! ^ (epoch & 0xff);
      n[6] = n[6]! ^ (seqHi >>> 8);
      n[7] = n[7]! ^ (seqHi & 0xff);
      n[8] = n[8]! ^ (seqLo >>> 24);
      n[9] = n[9]! ^ ((seqLo >>> 16) & 0xff);
      n[10] = n[10]! ^ ((seqLo >>> 8) & 0xff);
      n[11] = n[11]! ^ (seqLo & 0xff);
    }
  }

  private setAad(type: number, version: number, epoch: number, seqHi: number, seqLo: number, length: number): void {
    const a = this.aad;
    a.writeUInt16BE(epoch, 0);
    a.writeUInt16BE(seqHi, 2);
    a.writeUInt32BE(seqLo, 4);
    a[8] = type;
    a.writeUInt16BE(version, 9);
    a.writeUInt16BE(length, 11);
  }

  /**
   * Writes the protected fragment of `plaintext` into `out` at `off`
   * (explicit nonce, ciphertext, tag); returns the fragment length.
   * `out` must have room for `plaintext.length + overhead`.
   */
  seal(
    type: number,
    version: number,
    epoch: number,
    seqHi: number,
    seqLo: number,
    plaintext: Uint8Array,
    out: Buffer,
    off: number,
  ): number {
    this.setNonce(epoch, seqHi, seqLo);
    this.setAad(type, version, epoch, seqHi, seqLo, plaintext.length);
    let p = off;
    if (this.suite.explicitNonce === 8) {
      this.nonce.copy(out, p, 4, 12);
      p += 8;
    }
    // (typed as GCM: the ChaCha20-Poly1305 AEAD API is identical)
    const c = createCipheriv(this.suite.cipher as 'aes-128-gcm', this.key, this.nonce, { authTagLength: TAG_LENGTH });
    c.setAAD(this.aad);
    const ct = c.update(plaintext);
    ct.copy(out, p);
    p += ct.length;
    const fin = c.final();
    if (fin.length > 0) {
      fin.copy(out, p);
      p += fin.length;
    }
    c.getAuthTag().copy(out, p);
    p += TAG_LENGTH;
    return p - off;
  }

  /** Decrypts a protected fragment; null when it does not authenticate. */
  open(type: number, version: number, epoch: number, seqHi: number, seqLo: number, fragment: Uint8Array): Buffer | null {
    const explicit = this.suite.explicitNonce;
    const ptLen = fragment.length - explicit - TAG_LENGTH;
    if (ptLen < 0) return null;
    if (explicit === 8) {
      const n = this.nonce;
      this.iv.copy(n, 0, 0, 4);
      for (let i = 0; i < 8; i++) n[4 + i] = fragment[i]!;
    } else {
      this.setNonce(epoch, seqHi, seqLo);
    }
    this.setAad(type, version, epoch, seqHi, seqLo, ptLen);
    try {
      const d = createDecipheriv(this.suite.cipher as 'aes-128-gcm', this.key, this.nonce, { authTagLength: TAG_LENGTH });
      d.setAuthTag(fragment.subarray(explicit + ptLen));
      d.setAAD(this.aad);
      const pt = d.update(fragment.subarray(explicit, explicit + ptLen));
      const fin = d.final(); // throws when the tag does not match
      return fin.length === 0 ? pt : Buffer.concat([pt, fin]);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------- anti-replay

const WINDOW_BITS = 64;

/**
 * Sliding anti-replay window over 48-bit sequence numbers (held as doubles,
 * exact below 2^53). Two 32-bit words, bit i = (max - i) seen.
 */
export class ReplayWindow {
  private max = -1;
  private lo = 0; // bits 0..31 → max..max-31
  private hi = 0; // bits 32..63

  /** true if `seq` is new and inside the window (does not mark it). */
  check(seq: number): boolean {
    if (seq > this.max) return true;
    const d = this.max - seq;
    if (d >= WINDOW_BITS) return false;
    return d < 32 ? ((this.lo >>> d) & 1) === 0 : ((this.hi >>> (d - 32)) & 1) === 0;
  }

  /** Marks `seq` as received (call only after the record authenticated). */
  mark(seq: number): void {
    if (seq > this.max) {
      const shift = this.max < 0 ? WINDOW_BITS : seq - this.max;
      if (shift >= WINDOW_BITS) {
        this.lo = 0;
        this.hi = 0;
      } else if (shift >= 32) {
        this.hi = shift === 32 ? this.lo : this.lo << (shift - 32);
        this.lo = 0;
      } else {
        this.hi = (this.hi << shift) | (this.lo >>> (32 - shift));
        this.lo = this.lo << shift;
      }
      this.max = seq;
      this.lo |= 1;
      return;
    }
    const d = this.max - seq;
    if (d >= WINDOW_BITS) return;
    if (d < 32) this.lo |= 1 << d;
    else this.hi |= 1 << (d - 32);
  }
}
