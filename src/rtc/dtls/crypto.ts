/**
 * DTLS 1.2 cryptographic building blocks: the TLS 1.2 PRF (RFC 5246 §5),
 * the AEAD record protection of the supported cipher suites (AES-GCM per
 * RFC 5288/6347, ChaCha20-Poly1305 per RFC 7905) and the anti-replay
 * window (RFC 6347 §4.1.2.6).
 *
 * ChaCha20-Poly1305 records are protected by the allocation-free JS AEAD of
 * ./chacha.ts (in place); AES-GCM uses node:crypto (one native cipher object
 * and fresh buffers per record — AES is never done in JS: not constant time).
 *
 * Every fixed key handed to node:crypto (PRF secret, record keys) is a
 * KeyObject made once: with a Buffer, createHmac/createCipheriv import the
 * key again on every call (Node 26: ≈ 47 → 4 µs per HMAC, ≈ 54 → 5.5 µs per
 * AES-GCM record; neutral on Bun).
 */
import { createCipheriv, createDecipheriv, createHmac, createSecretKey, getCiphers, type KeyObject } from 'node:crypto';
import { ChaCha20Poly1305 } from './chacha.js';

// ---------------------------------------------------------------- PRF

/** P_hash(secret, label || seed) truncated to `length` (RFC 5246 §5). */
export function prf(hash: 'sha256' | 'sha384', secret: Uint8Array, label: string, seed: Uint8Array, length: number): Buffer {
  const labelSeed = Buffer.concat([Buffer.from(label, 'latin1'), seed]);
  const key = createSecretKey(secret); // imported once for the whole HMAC chain
  const out = Buffer.allocUnsafe(length);
  let a: Buffer = labelSeed; // A(0)
  let off = 0;
  while (off < length) {
    a = createHmac(hash, key).update(a).digest(); // A(i)
    const block = createHmac(hash, key).update(a).update(labelSeed).digest();
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

/**
 * Supported suites (the default preference order is {@link defaultSuites}).
 */
export const SUITES: readonly CipherSuite[] = [
  {
    id: 0xcca9,
    name: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
    cipher: 'chacha20-poly1305',
    hash: 'sha256',
    keyLength: 32,
    ivLength: 12,
    explicitNonce: 0,
  },
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
];

/**
 * Default server preference order, the same on Node and Bun:
 * ChaCha20-Poly1305 first (the allocation-free, in-place JS AEAD: docs/10
 * §6.3), then AES-128-GCM (every browser), then AES-256-GCM. Overridden by an
 * explicit suite list (`suites` / `cipherSuites`).
 *
 * On Bun a micro-benchmark favours AES-GCM per record (≈ 2.9 µs vs ≈ 10.4 µs
 * seal+open of 300 B), but end to end it loses: AES-GCM makes a native cipher
 * object per record, and the churn keeps Bun's mimalloc scavenger busy.
 * Game N=10, Linux 4 vCPU, Bun 1.4.0: AES first 2.96 % CPU, 5635 B/s UDP per
 * player; ChaCha first 2.45 %, 5150 B/s (Node 26: 2.42 %, 5140 B/s).
 * `_bun` is kept for callers and tests; the order no longer depends on it.
 */
export function defaultSuites(_bun?: boolean): number[] {
  return [0xcca9, 0xc02b, 0xc02c];
}

/** Suite ids or IANA names (`TLS_ECDHE_ECDSA_WITH_…`, or the short OpenSSL-style `chacha20` / `aes128gcm` / `aes256gcm`) → ids. Throws on unknown entries. */
export function resolveSuites(list: readonly (number | string)[]): number[] {
  const out: number[] = [];
  for (const x of list) {
    let suite: CipherSuite | undefined;
    if (typeof x === 'number') suite = SUITES.find((s) => s.id === x);
    else {
      const k = x.toLowerCase().replace(/[^a-z0-9]/g, '');
      suite = SUITES.find(
        (s) =>
          s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === k ||
          (k === 'chacha20' || k === 'chacha20poly1305' ? s.id === 0xcca9 : k === 'aes128gcm' ? s.id === 0xc02b : k === 'aes256gcm' ? s.id === 0xc02c : false),
      );
    }
    if (suite === undefined) throw new Error(`unknown DTLS cipher suite ${JSON.stringify(x)}`);
    if (!out.includes(suite.id)) out.push(suite.id);
  }
  if (out.length === 0) throw new Error('no DTLS cipher suite configured');
  return out;
}

export const TAG_LENGTH = 16;
const EMPTY = new Uint8Array(0);
export const RECORD_HEADER = 13;

/**
 * How ChaCha20-Poly1305 records are protected: the JS AEAD (default) or
 * node:crypto (diagnostics / A-B). 'node' falls back to the JS AEAD where
 * node:crypto lacks chacha20-poly1305 (Bun).
 */
export type ChaChaImpl = 'js' | 'node';

let nativeChaCha: boolean | null = null;

/** node:crypto implements chacha20-poly1305 (Node: yes; Bun 1.x: no). */
export function hasNativeChaCha(): boolean {
  return (nativeChaCha ??= getCiphers().includes('chacha20-poly1305'));
}

/**
 * One direction of record protection for one epoch. `seal`/`open` take the
 * record header fields; the nonce/AAD scratch buffers are reused.
 */
export class RecordCipher {
  readonly suite: CipherSuite;
  private readonly key: Buffer;
  /** {@link key} imported once for node:crypto (null: JS AEAD). */
  private readonly keyObject: KeyObject | null;
  private readonly iv: Buffer;
  private readonly nonce = Buffer.alloc(12);
  private readonly aad = Buffer.alloc(13);
  /** Allocation-free AEAD for ChaCha20-Poly1305 (null: node:crypto). */
  private readonly js: ChaCha20Poly1305 | null;
  /** JS AEAD: the 12-byte IV as little-endian words (the nonce is built from them as integers). */
  private ivw0 = 0;
  private ivw1 = 0;
  private ivw2 = 0;

  constructor(suite: CipherSuite, key: Buffer, iv: Buffer, chacha: ChaChaImpl = 'js') {
    this.suite = suite;
    this.key = key;
    this.iv = iv;
    this.js = suite.cipher === 'chacha20-poly1305' && (chacha === 'js' || !hasNativeChaCha()) ? new ChaCha20Poly1305(key) : null;
    this.keyObject = this.js === null ? createSecretKey(key) : null;
    if (this.js !== null) {
      this.ivw0 = le32(iv, 0);
      this.ivw1 = le32(iv, 4);
      this.ivw2 = le32(iv, 8);
    }
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
   * `out` must have room for `plaintext.length + overhead`. `plaintext` may
   * already sit at out[off…] (no copy then).
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
    const len = plaintext.length;
    const js = this.js;
    if (js !== null) {
      // (offsets first: `.buffer` is a native getter, materializing an ArrayBuffer on JSC)
      if (plaintext.byteOffset !== out.byteOffset + off || plaintext.buffer !== out.buffer) out.set(plaintext, off);
      // nonce = iv XOR (0^32 || epoch || seq) as little-endian words; AAD from the fields (RFC 7905 §2)
      js.sealDtls(this.ivw0, this.ivw1 ^ nonceWord1(epoch, seqHi), this.ivw2 ^ bswap32(seqLo), type, version, epoch, seqHi, seqLo, out, off, len);
      return len + TAG_LENGTH;
    }
    this.setNonce(epoch, seqHi, seqLo);
    this.setAad(type, version, epoch, seqHi, seqLo, len);
    let p = off;
    if (this.suite.explicitNonce === 8) {
      this.nonce.copy(out, p, 4, 12);
      p += 8;
    }
    // (typed as GCM: the ChaCha20-Poly1305 AEAD API is identical)
    const c = createCipheriv(this.suite.cipher as 'aes-128-gcm', this.keyObject!, this.nonce, { authTagLength: TAG_LENGTH });
    c.setAAD(this.aad);
    p += c.update(plaintext).copy(out, p);
    const fin = c.final();
    if (fin.length > 0) p += fin.copy(out, p);
    p += c.getAuthTag().copy(out, p);
    return p - off;
  }

  /** Decrypts a protected fragment; null when it does not authenticate. See {@link openAt}. */
  open(type: number, version: number, epoch: number, seqHi: number, seqLo: number, fragment: Uint8Array): Buffer | null {
    return this.openAt(type, version, epoch, seqHi, seqLo, fragment, 0, fragment.length);
  }

  /**
   * Decrypts the protected fragment buf[off, off+len); null when it does not
   * authenticate. ChaCha20-Poly1305 (JS) decrypts IN PLACE after the tag
   * verified and returns a view of `buf`; AES-GCM returns a fresh buffer and
   * leaves `buf` untouched.
   */
  openAt(type: number, version: number, epoch: number, seqHi: number, seqLo: number, buf: Uint8Array, off: number, len: number): Buffer | null {
    const n = this.openRange(type, version, epoch, seqHi, seqLo, buf, off, len);
    if (n < 0) return null;
    const b = this.plainBuf;
    return Buffer.from(b.buffer, b.byteOffset + this.plainOff, n);
  }

  /** Where the plaintext of the last successful {@link openRange} is: plainBuf[plainOff, plainOff + length). */
  plainBuf: Uint8Array = EMPTY;
  plainOff = 0;

  /**
   * Allocation-free {@link openAt} (for the JS AEAD): returns the plaintext
   * length (-1 when the record does not authenticate) and points
   * {@link plainBuf}/{@link plainOff} at it.
   */
  openRange(type: number, version: number, epoch: number, seqHi: number, seqLo: number, buf: Uint8Array, off: number, len: number): number {
    const explicit = this.suite.explicitNonce;
    const ptLen = len - explicit - TAG_LENGTH;
    if (ptLen < 0) return -1;
    const js = this.js;
    if (js !== null) {
      if (!js.openDtls(this.ivw0, this.ivw1 ^ nonceWord1(epoch, seqHi), this.ivw2 ^ bswap32(seqLo), type, version, epoch, seqHi, seqLo, buf, off, ptLen)) return -1;
      this.plainBuf = buf;
      this.plainOff = off;
      return ptLen;
    }
    if (explicit === 8) {
      const n = this.nonce;
      this.iv.copy(n, 0, 0, 4);
      for (let i = 0; i < 8; i++) n[4 + i] = buf[off + i]!;
    } else {
      this.setNonce(epoch, seqHi, seqLo);
    }
    this.setAad(type, version, epoch, seqHi, seqLo, ptLen);
    try {
      const d = createDecipheriv(this.suite.cipher as 'aes-128-gcm', this.keyObject!, this.nonce, { authTagLength: TAG_LENGTH });
      d.setAuthTag(buf.subarray(off + explicit + ptLen, off + len));
      d.setAAD(this.aad);
      const pt = d.update(buf.subarray(off + explicit, off + explicit + ptLen));
      const fin = d.final(); // throws when the tag does not match
      const out = fin.length === 0 ? pt : Buffer.concat([pt, fin]);
      this.plainBuf = out;
      this.plainOff = 0;
      return out.length;
    } catch {
      return -1;
    }
  }

  /** Best-effort key hygiene when the session ends (a KeyObject's native copy cannot be wiped: it goes with the object). */
  wipe(): void {
    this.key.fill(0);
    this.js?.wipe();
    this.ivw0 = this.ivw1 = this.ivw2 = 0;
  }
}

/** Little-endian 32-bit word of b[o, o+4). */
function le32(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);
}

/** Nonce bytes 4..7 XOR part, epoch(2) || seqHi(2) big-endian, as a little-endian word. */
function nonceWord1(epoch: number, seqHi: number): number {
  return (epoch >>> 8) | ((epoch & 0xff) << 8) | ((seqHi >>> 8) << 16) | ((seqHi & 0xff) << 24);
}

/** Byte swap: seqLo big-endian, read as a little-endian word. */
function bswap32(x: number): number {
  return (x >>> 24) | ((x >>> 8) & 0xff00) | ((x & 0xff00) << 8) | ((x & 0xff) << 24);
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
