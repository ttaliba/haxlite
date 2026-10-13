/**
 * Self-signed ECDSA P-256 X.509 v3 certificate for DTLS (WebRTC
 * authenticates it only by its SDP fingerprint, RFC 8827 §6.5). Node can
 * sign but not build certificates, so this file carries a minimal DER
 * encoder (X.690) for the few types a certificate needs.
 */
import {
  X509Certificate,
  createHash,
  createPrivateKey,
  generateKeyPair,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

// ---------------------------------------------------------------- DER

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}

/** TLV with `tag` around the concatenation of `parts`. */
export function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const hdr = derLength(len);
  const out = new Uint8Array(1 + hdr.length + len);
  out[0] = tag;
  out.set(hdr, 1);
  let o = 1 + hdr.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const derSeq = (...parts: Uint8Array[]): Uint8Array => der(0x30, ...parts);
export const derSet = (...parts: Uint8Array[]): Uint8Array => der(0x31, ...parts);

/** INTEGER from big-endian unsigned bytes (minimal, positive). */
export function derUInt(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.subarray(i);
  if (v[0]! & 0x80) {
    const w = new Uint8Array(v.length + 1);
    w.set(v, 1);
    v = w;
  }
  return der(0x02, v);
}

export function derSmallInt(n: number): Uint8Array {
  return derUInt(Uint8Array.of(n));
}

/** OBJECT IDENTIFIER from dotted notation. */
export function derOid(oid: string): Uint8Array {
  const arcs = oid.split('.').map(Number);
  const out: number[] = [40 * arcs[0]! + arcs[1]!];
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i]!;
    const tmp: number[] = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      tmp.unshift(0x80 | (v & 0x7f));
      v = Math.floor(v / 128);
    }
    out.push(...tmp);
  }
  return der(0x06, Uint8Array.from(out));
}

export function derUtf8(s: string): Uint8Array {
  return der(0x0c, new TextEncoder().encode(s));
}

/** UTCTime (years 1950–2049) or GeneralizedTime, seconds precision, Zulu. */
export function derTime(d: Date): Uint8Array {
  const y = d.getUTCFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y < 2050) return der(0x17, new TextEncoder().encode(pad(y % 100) + rest));
  return der(0x18, new TextEncoder().encode(String(y).padStart(4, '0') + rest));
}

export function derBitString(bytes: Uint8Array): Uint8Array {
  const v = new Uint8Array(bytes.length + 1);
  v.set(bytes, 1);
  return der(0x03, v);
}

/** Explicit context tag [n] (constructed). */
export function derExplicit(n: number, inner: Uint8Array): Uint8Array {
  return der(0xa0 | n, inner);
}

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_CN = '2.5.4.3';

// ---------------------------------------------------------------- certificate

interface CertOptions {
  commonName?: string;
  validDays?: number;
}

/** DER of a self-signed v3 certificate for `spki`, signed by `signer`. */
function buildCertificate(spki: Uint8Array, opts: CertOptions, signer: (tbs: Uint8Array) => Uint8Array): Buffer;
function buildCertificate(spki: Uint8Array, opts: CertOptions, signer: (tbs: Uint8Array) => Promise<Uint8Array>): Promise<Buffer>;
function buildCertificate(
  spki: Uint8Array,
  opts: CertOptions,
  signer: (tbs: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Buffer | Promise<Buffer> {
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  const name = derSeq(derSet(derSeq(derOid(OID_CN), derUtf8(opts.commonName ?? 'haxlite'))));
  const now = Date.now();
  const notBefore = new Date(now - 86_400_000);
  const notAfter = new Date(now + (opts.validDays ?? 365) * 86_400_000);
  const algId = derSeq(derOid(OID_ECDSA_SHA256));
  const tbs = derSeq(
    derExplicit(0, derSmallInt(2)), // v3
    derUInt(serial),
    algId,
    name,
    derSeq(derTime(notBefore), derTime(notAfter)),
    name,
    spki,
  );
  const finish = (sig: Uint8Array) => Buffer.from(derSeq(tbs, algId, derBitString(sig)));
  const sig = signer(tbs);
  return sig instanceof Promise ? sig.then(finish) : finish(sig);
}

let processDefault: Promise<RtcCertificate> | null = null;

/** Our DTLS identity: private key + DER certificate + SDP fingerprint. */
export class RtcCertificate {
  /** DER of the X.509 certificate. */
  readonly der: Buffer;
  readonly privateKey: KeyObject;
  /** sha-256 of {@link der} (the SDP a=fingerprint). */
  readonly fingerprint: Uint8Array;
  private parsed: X509Certificate | null;

  /** `x509` given = imported (validated); null = built here from `privateKey` (trusted, parsed on demand). */
  private constructor(derBytes: Buffer, privateKey: KeyObject, x509: X509Certificate | null) {
    this.der = derBytes;
    this.privateKey = privateKey;
    this.fingerprint = createHash('sha256').update(derBytes).digest();
    this.parsed = x509;
    if (x509 !== null) {
      if (x509.publicKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('RtcCertificate: only ECDSA P-256 keys are supported');
      }
      if (!x509.checkPrivateKey(privateKey)) throw new Error('RtcCertificate: key does not match certificate');
    }
  }

  /** The parsed certificate (parsed lazily for generated ones: nothing on the hot path needs it). */
  get x509(): X509Certificate {
    return (this.parsed ??= new X509Certificate(this.der));
  }

  /**
   * New self-signed ECDSA P-256 certificate (CN = `commonName`, random
   * serial, valid from 1 day ago for `validDays`). Synchronous (≈ 1–3 ms on
   * the main thread); see {@link generateAsync}.
   */
  static generate(opts: CertOptions = {}): RtcCertificate {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const der = buildCertificate(spki, opts, (tbs) => sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' }));
    return new RtcCertificate(der, privateKey, null);
  }

  /** Like {@link generate}, with key generation and signing on the libuv thread pool. */
  static async generateAsync(opts: CertOptions = {}): Promise<RtcCertificate> {
    const { privateKey, publicKey } = await new Promise<{ privateKey: KeyObject; publicKey: KeyObject }>((resolve, reject) =>
      generateKeyPair('ec', { namedCurve: 'prime256v1' }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey }))),
    );
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const der = await buildCertificate(
      spki,
      opts,
      (tbs) => new Promise<Uint8Array>((resolve, reject) => sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' }, (err, sig) => (err ? reject(err) : resolve(sig)))),
    );
    return new RtcCertificate(der, privateKey, null);
  }

  /**
   * The process-wide default certificate: generated once and shared by every
   * endpoint that is not given one. Generated synchronously (P-256 keygen +
   * one signature ≈ 1 ms): the async variant would start the four libuv
   * thread-pool threads of an otherwise idle room just for this. WebRTC authenticates it
   * only through the SDP fingerprint of each answer, so sharing it between
   * rooms reveals nothing a player could not already see.
   */
  static processDefault(): Promise<RtcCertificate> {
    const p = (processDefault ??= new Promise<RtcCertificate>((resolve) => resolve(RtcCertificate.generate())));
    p.catch(() => {
      if (processDefault === p) processDefault = null; // retry next time
    });
    return p;
  }

  /**
   * Persistent identity: loads the PEM certificate + key from `file`, or
   * generates one and writes it there (mode 0600) when the file is missing or
   * its certificate expires within a day. Saves the key generation at every
   * start and keeps the fingerprint stable across restarts.
   */
  static async loadOrCreate(file: string, opts: CertOptions = {}): Promise<RtcCertificate> {
    const fs = await import('node:fs/promises');
    let text: string | null = null;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== null) {
      const cert = RtcCertificate.fromPem(text, text);
      if (Date.parse(cert.x509.validTo) - Date.now() > 86_400_000) return cert;
    }
    const cert = await RtcCertificate.generateAsync(opts);
    const pem = cert.toPem();
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, pem.cert + pem.key, { mode: 0o600 });
    await fs.rename(tmp, file);
    return cert;
  }

  /** From PEM/DER certificate + PEM private key (persisted identity). */
  static fromPem(certPem: string | Buffer, keyPem: string | Buffer): RtcCertificate {
    const x = new X509Certificate(certPem);
    return new RtcCertificate(x.raw, createPrivateKey(keyPem), x);
  }

  /** PEM export (`{ cert, key }`). */
  toPem(): { cert: string; key: string } {
    return { cert: this.x509.toString(), key: this.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
  }
}
