/**
 * DTLS 1.2 server (RFC 6347 over RFC 5246) for WebRTC data channels.
 *
 * Exactly one handshake shape is supported — the one every browser uses
 * for WebRTC — and everything else is refused:
 *
 * ```
 * ClientHello            →
 *                        ←  ServerHello, Certificate, ServerKeyExchange,
 *                           CertificateRequest, ServerHelloDone      (flight 4)
 * Certificate, ClientKeyExchange, CertificateVerify,
 * [ChangeCipherSpec], Finished                                       (flight 5)
 *                        ←  [ChangeCipherSpec], Finished             (flight 6)
 * ```
 *
 * * No HelloVerifyRequest by default (RFC 6347 §4.2.1 lets the server skip
 *   it): the endpoint only routes DTLS from transport addresses that passed
 *   an authenticated STUN exchange (ICE), which already proves the address
 *   is the peer's — the cookie round trip would only delay every join by one
 *   RTT. Opt-in with {@link DtlsServerOptions.helloVerify}.
 * * ECDHE (x25519 preferred, secp256r1) with ECDSA P-256 server
 *   certificate; AES-128-GCM / AES-256-GCM / ChaCha20-Poly1305.
 * * extended_master_secret (RFC 7627) is mandatory (browsers always send it).
 * * The client certificate is mandatory and must hash to the SDP
 *   a=fingerprint (RFC 8827 §6.5); its CertificateVerify is checked.
 * * No session resumption, no renegotiation (RFC 5746 initial-handshake
 *   signalling only), no compression, no DTLS 1.0. A DTLS 1.3-capable
 *   client (supported_versions) gets a plain 1.2 ServerHello.
 * * Record layer: epochs 0/1, 48-bit sequence numbers, 64-entry
 *   anti-replay window on epoch 1, silently discards records that do not
 *   authenticate (RFC 6347 §4.1.2.7).
 */
import {
  createECDH,
  createHash,
  createHmac,
  createSecretKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import type { RtcCertificate } from '../cert.js';
import { RECORD_HEADER, RecordCipher, ReplayWindow, SUITES, TAG_LENGTH, defaultSuites, prf, type ChaChaImpl, type CipherSuite } from './crypto.js';

export const ContentType = { ChangeCipherSpec: 20, Alert: 21, Handshake: 22, ApplicationData: 23 } as const;

export const HandshakeType = {
  HelloRequest: 0,
  ClientHello: 1,
  ServerHello: 2,
  HelloVerifyRequest: 3,
  Certificate: 11,
  ServerKeyExchange: 12,
  CertificateRequest: 13,
  ServerHelloDone: 14,
  CertificateVerify: 15,
  ClientKeyExchange: 16,
  Finished: 20,
} as const;

export const AlertDescription = {
  CloseNotify: 0,
  UnexpectedMessage: 10,
  BadRecordMac: 20,
  RecordOverflow: 22,
  HandshakeFailure: 40,
  BadCertificate: 42,
  UnsupportedCertificate: 43,
  IllegalParameter: 47,
  DecodeError: 50,
  DecryptError: 51,
  ProtocolVersion: 70,
  InsufficientSecurity: 71,
  InternalError: 80,
  NoRenegotiation: 100,
} as const;

const AlertLevel = { Warning: 1, Fatal: 2 } as const;

export const DTLS_1_0 = 0xfeff;
export const DTLS_1_2 = 0xfefd;
export const DTLS_1_3 = 0xfefc;
const HS_HEADER = 12;

const Ext = {
  SupportedGroups: 10,
  EcPointFormats: 11,
  SignatureAlgorithms: 13,
  ExtendedMasterSecret: 23,
  SupportedVersions: 43,
  RenegotiationInfo: 0xff01,
} as const;

const GROUP_SECP256R1 = 23;
const GROUP_X25519 = 29;
const SIG_ECDSA_SHA256 = 0x0403;
const SCSV_RENEGOTIATION = 0x00ff;

/** Signature schemes accepted in the client's CertificateVerify (TLS 1.2 code points). */
const CLIENT_SIG_ALGS: ReadonlyMap<number, { hash: string; key: 'ec' | 'rsa' }> = new Map([
  [0x0403, { hash: 'sha256', key: 'ec' }],
  [0x0503, { hash: 'sha384', key: 'ec' }],
  [0x0603, { hash: 'sha512', key: 'ec' }],
  [0x0401, { hash: 'sha256', key: 'rsa' }],
  [0x0501, { hash: 'sha384', key: 'rsa' }],
  [0x0601, { hash: 'sha512', key: 'rsa' }],
]);

const FP_HASHES: Record<string, string> = { 'sha-224': 'sha224', 'sha-256': 'sha256', 'sha-384': 'sha384', 'sha-512': 'sha512' };

/** Largest handshake message we reassemble (a client certificate chain). */
const MAX_HANDSHAKE_MESSAGE = 16 * 1024;
/** Largest (fragmented) ClientHello we reassemble in the listen state. */
const MAX_CLIENT_HELLO = 8 * 1024;
/** How far ahead of the next expected message_seq fragments are buffered. */
const MAX_SEQ_AHEAD = 8;
const MAX_PLAINTEXT = 16384;

export type DtlsState = 'listen' | 'handshake' | 'connected' | 'closed';

export interface DtlsServerOptions {
  certificate: RtcCertificate;
  /** From the offer's a=fingerprint. */
  remoteFingerprint: { algorithm: string; digest: Uint8Array };
  /**
   * Sends one datagram (`datagram[0, length)`, default the whole buffer) to
   * the peer, synchronously: the buffer may be reused once this returns
   * (unless {@link sendBuffer} says otherwise).
   */
  send(datagram: Buffer, length?: number): void;
  /**
   * Scratch buffer of at least `size` bytes that application-data records are
   * sealed into before {@link send} (shared by every session of an endpoint).
   * Absent: a fresh exact-size buffer per record.
   */
  sendBuffer?(size: number): Buffer;
  onConnected(): void;
  /**
   * One application-data record: `data[off, off+len)`. With
   * ChaCha20-Poly1305 `data` is the received datagram, decrypted in place
   * (never reused by us: may be kept); with AES-GCM a fresh buffer.
   */
  onData(data: Uint8Array, off: number, len: number): void;
  /** Handshake failure, fatal alert or close_notify from the peer. Not called after {@link DtlsServer.close}. */
  onClose(reason: string): void;
  /** Max datagram size we emit (default 1200). */
  mtu?: number;
  /** First retransmission timeout of flight 4 (default 1000 ms, doubles up to 8 s). */
  retransmitMs?: number;
  /**
   * Cipher suites in preference order (default {@link defaultSuites}: ChaCha20-Poly1305
   * first on Node, AES-128-GCM first on Bun).
   */
  suites?: readonly number[];
  /** ChaCha20-Poly1305 implementation (default 'js', allocation-free; 'node' is 'js' on Bun). */
  chacha?: ChaChaImpl;
  /**
   * Stateless cookie exchange (HelloVerifyRequest, RFC 6347 §4.2.1) before
   * any handshake state is allocated: proves the client owns its source
   * address. Default false — set it only when datagrams can reach
   * {@link DtlsServer.handleDatagram} from addresses ICE did not authenticate
   * (RtcEndpoint never does that). Costs the client one extra round trip.
   */
  helloVerify?: boolean;
}

interface Reassembly {
  type: number;
  length: number;
  epoch: number;
  body: Buffer;
  /** One byte per body byte: 1 = received. */
  have: Uint8Array;
  missing: number;
}

/** Handshake message of one of our flights (null body = ChangeCipherSpec). */
interface OutMessage {
  type: number;
  seq: number;
  body: Uint8Array | null;
  epoch: number;
}

interface ClientHello {
  version: number;
  random: Buffer;
  sessionId: Buffer;
  cookie: Buffer;
  suites: number[];
  compression: Buffer;
  /** extension type → body. */
  extensions: Map<number, Buffer>;
}

class DecodeError extends Error {}

/** Big-endian reader over a handshake body; throws DecodeError on truncation. */
class Reader {
  p = 0;
  readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  u8(): number {
    if (this.p + 1 > this.b.length) throw new DecodeError('truncated');
    return this.b[this.p++]!;
  }
  u16(): number {
    if (this.p + 2 > this.b.length) throw new DecodeError('truncated');
    const v = this.b.readUInt16BE(this.p);
    this.p += 2;
    return v;
  }
  u24(): number {
    if (this.p + 3 > this.b.length) throw new DecodeError('truncated');
    const v = (this.b[this.p]! << 16) | (this.b[this.p + 1]! << 8) | this.b[this.p + 2]!;
    this.p += 3;
    return v;
  }
  bytes(n: number): Buffer {
    if (this.p + n > this.b.length) throw new DecodeError('truncated');
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  vec8(): Buffer {
    return this.bytes(this.u8());
  }
  vec16(): Buffer {
    return this.bytes(this.u16());
  }
  vec24(): Buffer {
    return this.bytes(this.u24());
  }
  get done(): boolean {
    return this.p === this.b.length;
  }
}

function u16(n: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(n);
  return b;
}
function u24(n: number): Buffer {
  return Buffer.from([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
const vec8 = (b: Uint8Array): Buffer => Buffer.concat([Buffer.from([b.length]), b]);
const vec16 = (b: Uint8Array): Buffer => Buffer.concat([u16(b.length), b]);
const vec24 = (b: Uint8Array): Buffer => Buffer.concat([u24(b.length), b]);

export function parseClientHello(body: Buffer): ClientHello {
  const r = new Reader(body);
  const version = r.u16();
  const random = r.bytes(32);
  const sessionId = r.vec8();
  if (sessionId.length > 32) throw new DecodeError('session_id');
  const cookie = r.vec8();
  const cs = r.vec16();
  if (cs.length < 2 || cs.length & 1) throw new DecodeError('cipher_suites');
  const suites: number[] = [];
  for (let i = 0; i < cs.length; i += 2) suites.push(cs.readUInt16BE(i));
  const compression = r.vec8();
  if (compression.length < 1) throw new DecodeError('compression');
  const extensions = new Map<number, Buffer>();
  if (!r.done) {
    const ext = new Reader(r.vec16());
    while (!ext.done) {
      const t = ext.u16();
      const v = ext.vec16();
      if (extensions.has(t)) throw new DecodeError('duplicate extension');
      extensions.set(t, v);
    }
    if (!r.done) throw new DecodeError('trailing bytes');
  }
  return { version, random, sessionId, cookie, suites, compression, extensions };
}

function u16List(b: Buffer | undefined, lenBytes: 1 | 2): number[] | null {
  if (b === undefined) return null;
  try {
    const r = new Reader(b);
    const v = lenBytes === 2 ? r.vec16() : r.vec8();
    if (!r.done || v.length & 1) return null;
    const out: number[] = [];
    for (let i = 0; i < v.length; i += 2) out.push(v.readUInt16BE(i));
    return out;
  } catch {
    return null;
  }
}

class HandshakeError extends Error {
  readonly alert: number;
  readonly reason: string;
  constructor(alert: number, reason: string) {
    super(reason);
    this.alert = alert;
    this.reason = reason;
  }
}

/** Key exchange state of the selected group. */
interface Ecdhe {
  group: number;
  publicKey: Buffer;
  derive(peer: Buffer): Buffer;
}

function makeEcdhe(group: number): Ecdhe {
  if (group === GROUP_X25519) {
    const kp = generateKeyPairSync('x25519');
    const jwk = kp.publicKey.export({ format: 'jwk' });
    return {
      group,
      publicKey: Buffer.from(jwk.x!, 'base64url'),
      derive(peer) {
        if (peer.length !== 32) throw new HandshakeError(AlertDescription.IllegalParameter, 'bad x25519 key');
        const pub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peer.toString('base64url') }, format: 'jwk' });
        const shared = diffieHellman({ privateKey: kp.privateKey, publicKey: pub });
        let acc = 0;
        for (let i = 0; i < shared.length; i++) acc |= shared[i]!;
        if (acc === 0) throw new HandshakeError(AlertDescription.IllegalParameter, 'x25519 all-zero secret');
        return shared;
      },
    };
  }
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    group,
    publicKey: ecdh.getPublicKey(),
    derive(peer) {
      if (peer.length !== 65 || peer[0] !== 4) throw new HandshakeError(AlertDescription.IllegalParameter, 'bad P-256 point');
      try {
        return ecdh.computeSecret(peer); // validates the point is on the curve
      } catch {
        throw new HandshakeError(AlertDescription.IllegalParameter, 'invalid P-256 point');
      }
    },
  };
}

export class DtlsServer {
  state: DtlsState = 'listen';
  /** Records dropped: replayed (epoch 1). */
  replayed = 0;
  /** Records dropped: did not authenticate / malformed. */
  badRecords = 0;
  /** Negotiated suite (after ClientHello). */
  suite: CipherSuite | null = null;
  /** Negotiated ECDHE group. */
  group = 0;
  /** The client offered DTLS 1.3 (supported_versions) and was answered with 1.2. */
  clientOfferedDtls13 = false;

  private readonly opts: DtlsServerOptions;
  private readonly mtu: number;
  /** HelloVerifyRequest cookie key (made on first use: only with {@link DtlsServerOptions.helloVerify}). */
  private cookieKey: KeyObject | null = null;
  private readonly suitePrefs: readonly number[];

  // handshake state (allocated on the first acceptable ClientHello)
  private clientRandom: Buffer | null = null;
  private serverRandom: Buffer | null = null;
  private ecdhe: Ecdhe | null = null;
  private transcript: Buffer[] = [];
  private nextReceiveSeq = 0;
  private nextSendSeq = 0;
  private reassembly = new Map<number, Reassembly>();
  private helloReassembly: { seq: number; length: number; body: Buffer; have: Uint8Array; missing: number } | null = null;
  private expect: 'certificate' | 'cke' | 'cv' | 'ccs' | 'finished' | 'done' = 'certificate';
  private clientKey: KeyObject | null = null;
  private masterSecret: Buffer | null = null;
  private pendingRead: RecordCipher | null = null;
  private pendingWrite: RecordCipher | null = null;

  // record layer
  private readCipher: RecordCipher | null = null;
  private writeCipher: RecordCipher | null = null;
  private writeEpoch = 0;
  private readonly writeSeqHi = [0, 0];
  private readonly writeSeqLo = [0, 0];
  private readonly replay = new ReplayWindow();

  // retransmission
  private lastFlight: OutMessage[] | null = null;
  private retransmitTimer: NodeJS.Timeout | null = null;
  private retransmitMs: number;
  private lastPeerTriggeredRetransmit = 0;
  /** Client proved it has our Finished (sent epoch-1 application data). */
  private peerHasFinished = false;

  constructor(opts: DtlsServerOptions) {
    this.opts = opts;
    this.mtu = opts.mtu ?? 1200;
    this.retransmitMs = opts.retransmitMs ?? 1000;
    this.suitePrefs = opts.suites ?? defaultSuites();
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  // ------------------------------------------------------------ input

  /**
   * One UDP datagram from the (ICE-validated) peer. `peerKey` identifies the
   * transport address and is bound into the HelloVerifyRequest cookie (only
   * used with {@link DtlsServerOptions.helloVerify}).
   */
  handleDatagram(buf: Uint8Array, peerKey: string): void {
    let off = 0;
    const len = buf.length;
    while (off + RECORD_HEADER <= len && this.state !== 'closed') {
      const type = buf[off]!;
      const version = (buf[off + 1]! << 8) | buf[off + 2]!;
      const epoch = (buf[off + 3]! << 8) | buf[off + 4]!;
      const seqHi = (buf[off + 5]! << 8) | buf[off + 6]!;
      const seqLo = ((buf[off + 7]! << 24) | (buf[off + 8]! << 16) | (buf[off + 9]! << 8) | buf[off + 10]!) >>> 0;
      const length = (buf[off + 11]! << 8) | buf[off + 12]!;
      const end = off + RECORD_HEADER + length;
      if (end > len) {
        this.badRecords++;
        return; // truncated: drop the rest of the datagram
      }
      if (version >>> 8 === 0xfe && type >= 20 && type <= 23) {
        if (epoch === 1 && type === ContentType.ApplicationData && this.state === 'connected') {
          this.handleAppData(version, seqHi, seqLo, buf, off + RECORD_HEADER, length); // hot path: no fragment view
        } else {
          const fragment = Buffer.from(buf.buffer, buf.byteOffset + off + RECORD_HEADER, length);
          this.handleRecord(type, version, epoch, seqHi, seqLo, fragment, peerKey);
        }
      } else {
        this.badRecords++;
      }
      off = end;
    }
  }

  /** Epoch-1 application data while connected (the steady state). */
  private handleAppData(version: number, seqHi: number, seqLo: number, buf: Uint8Array, off: number, length: number): void {
    const rc = this.readCipher;
    if (rc === null) {
      this.badRecords++;
      return;
    }
    const seq = seqHi * 4294967296 + seqLo;
    if (!this.replay.check(seq)) {
      this.replayed++;
      return;
    }
    const n = rc.openRange(ContentType.ApplicationData, version, 1, seqHi, seqLo, buf, off, length);
    if (n < 0) {
      this.badRecords++;
      return;
    }
    this.replay.mark(seq);
    if (n > MAX_PLAINTEXT) {
      this.fail(AlertDescription.RecordOverflow, 'record-overflow');
      return;
    }
    if (!this.peerHasFinished) {
      this.peerHasFinished = true;
      this.lastFlight = null;
    }
    this.opts.onData(rc.plainBuf, rc.plainOff, n);
  }

  private handleRecord(
    type: number,
    version: number,
    epoch: number,
    seqHi: number,
    seqLo: number,
    fragment: Buffer,
    peerKey: string,
  ): void {
    if (epoch === 0) {
      if (this.state === 'connected') {
        // Unauthenticated: only a retransmitted flight 5 is meaningful (our flight 6 was lost).
        if (type === ContentType.Handshake) this.peerRetransmitted();
        return;
      }
      if (type === ContentType.Handshake) this.handleHandshakeRecord(fragment, 0, seqHi, seqLo, peerKey);
      else if (type === ContentType.ChangeCipherSpec) this.handleChangeCipherSpec(fragment);
      else if (type === ContentType.Alert) this.handleAlert(fragment);
      else this.badRecords++; // application data in epoch 0
      return;
    }
    if (epoch !== 1 || this.readCipher === null) {
      this.badRecords++;
      return;
    }
    const seq = seqHi * 4294967296 + seqLo;
    if (!this.replay.check(seq)) {
      this.replayed++;
      return;
    }
    const plain = this.readCipher.open(type, version, epoch, seqHi, seqLo, fragment);
    if (plain === null) {
      this.badRecords++;
      return;
    }
    this.replay.mark(seq);
    if (plain.length > MAX_PLAINTEXT) {
      this.fail(AlertDescription.RecordOverflow, 'record-overflow');
      return;
    }
    switch (type) {
      case ContentType.ApplicationData:
        if (this.state !== 'connected') {
          this.badRecords++;
          return;
        }
        if (!this.peerHasFinished) {
          this.peerHasFinished = true;
          this.lastFlight = null;
        }
        this.opts.onData(plain, 0, plain.length);
        return;
      case ContentType.Handshake:
        this.handleHandshakeRecord(plain, 1, seqHi, seqLo, peerKey);
        return;
      case ContentType.Alert:
        this.handleAlert(plain);
        return;
      default:
        return; // duplicate ChangeCipherSpec in epoch 1: ignore
    }
  }

  private handleAlert(fragment: Buffer): void {
    if (fragment.length !== 2) {
      this.badRecords++;
      return;
    }
    const level = fragment[0]!;
    const desc = fragment[1]!;
    if (desc === AlertDescription.CloseNotify) {
      if (this.state === 'connected') this.sendAlert(AlertLevel.Warning, AlertDescription.CloseNotify);
      this.terminate('remote-close');
      return;
    }
    if (level === AlertLevel.Fatal) this.terminate(`dtls-alert:${desc}`);
    // warnings (no_renegotiation, user_canceled…) are ignored
  }

  private handleChangeCipherSpec(fragment: Buffer): void {
    if (fragment.length !== 1 || fragment[0] !== 1) {
      this.badRecords++;
      return;
    }
    if (this.state === 'handshake' && this.expect === 'ccs') {
      this.readCipher = this.pendingRead;
      this.expect = 'finished';
    }
    // otherwise early/duplicate: ignored (the client retransmits its flight)
  }

  private handleHandshakeRecord(data: Buffer, epoch: number, recSeqHi: number, recSeqLo: number, peerKey: string): void {
    let p = 0;
    while (p + HS_HEADER <= data.length && this.state !== 'closed') {
      const msgType = data[p]!;
      const length = (data[p + 1]! << 16) | (data[p + 2]! << 8) | data[p + 3]!;
      const msgSeq = (data[p + 4]! << 8) | data[p + 5]!;
      const fragOff = (data[p + 6]! << 16) | (data[p + 7]! << 8) | data[p + 8]!;
      const fragLen = (data[p + 9]! << 16) | (data[p + 10]! << 8) | data[p + 11]!;
      const bodyStart = p + HS_HEADER;
      if (bodyStart + fragLen > data.length || fragOff + fragLen > length) {
        this.badRecords++;
        return;
      }
      const frag = data.subarray(bodyStart, bodyStart + fragLen);
      p = bodyStart + fragLen;

      if (this.state === 'listen') {
        if (msgType !== HandshakeType.ClientHello || epoch !== 0) {
          this.badRecords++;
        } else if (fragOff === 0 && fragLen === length) {
          this.handleInitialClientHello(frag, msgSeq, recSeqHi, recSeqLo, peerKey);
        } else if (length <= MAX_CLIENT_HELLO) {
          // Fragmented ClientHello (e.g. a DTLS 1.3 client with post-quantum key shares):
          // one bounded reassembly buffer. The peer is already ICE-authenticated, so this is
          // not an amplification/state-exhaustion vector.
          let h = this.helloReassembly;
          if (h === null || h.seq !== msgSeq || h.length !== length) {
            h = { seq: msgSeq, length, body: Buffer.alloc(length), have: new Uint8Array(length), missing: length };
            this.helloReassembly = h;
          }
          for (let i = 0; i < fragLen; i++) {
            if (h.have[fragOff + i] === 0) {
              h.have[fragOff + i] = 1;
              h.body[fragOff + i] = frag[i]!;
              h.missing--;
            }
          }
          if (h.missing === 0) {
            this.helloReassembly = null;
            this.handleInitialClientHello(h.body, msgSeq, recSeqHi, recSeqLo, peerKey);
          }
        } else {
          this.badRecords++;
        }
        continue;
      }
      if (this.state === 'connected') {
        if (msgSeq < this.nextReceiveSeq) this.peerRetransmitted();
        else if (msgType === HandshakeType.ClientHello) this.sendAlert(AlertLevel.Warning, AlertDescription.NoRenegotiation);
        continue;
      }
      // handshake in progress
      if (msgSeq < this.nextReceiveSeq) {
        this.peerRetransmitted();
        continue;
      }
      if (msgSeq >= this.nextReceiveSeq + MAX_SEQ_AHEAD || length > MAX_HANDSHAKE_MESSAGE) {
        this.badRecords++;
        continue;
      }
      if (this.retransmitTimer !== null) this.stopRetransmitTimer(); // our flight 4 arrived
      let r = this.reassembly.get(msgSeq);
      if (r === undefined) {
        r = { type: msgType, length, epoch, body: Buffer.alloc(length), have: new Uint8Array(length), missing: length };
        this.reassembly.set(msgSeq, r);
      } else if (r.type !== msgType || r.length !== length || r.epoch !== epoch) {
        this.fail(AlertDescription.DecodeError, 'dtls-error:inconsistent-fragments');
        return;
      }
      for (let i = 0; i < fragLen; i++) {
        if (r.have[fragOff + i] === 0) {
          r.have[fragOff + i] = 1;
          r.body[fragOff + i] = frag[i]!;
          r.missing--;
        }
      }
    }
    if (this.state === 'handshake') this.processReassembled();
  }

  private processReassembled(): void {
    for (;;) {
      const r = this.reassembly.get(this.nextReceiveSeq);
      if (r === undefined || r.missing !== 0) return;
      this.reassembly.delete(this.nextReceiveSeq);
      const seq = this.nextReceiveSeq++;
      try {
        this.handleMessage(r.type, r.body, seq, r.epoch);
      } catch (err) {
        if (err instanceof HandshakeError) this.fail(err.alert, `dtls-error:${err.reason}`);
        else if (err instanceof DecodeError) this.fail(AlertDescription.DecodeError, `dtls-error:decode-${err.message}`);
        else this.fail(AlertDescription.InternalError, `dtls-error:internal-${(err as Error).message}`);
      }
      if (this.state !== 'handshake') return;
    }
  }

  // ------------------------------------------------------------ ClientHello / cookie

  private computeCookie(ch: ClientHello, peerKey: string): Buffer {
    const h = createHmac('sha256', (this.cookieKey ??= createSecretKey(randomBytes(32))));
    h.update(peerKey);
    h.update(u16(ch.version));
    h.update(ch.random);
    h.update(vec8(ch.sessionId));
    for (const s of ch.suites) h.update(u16(s));
    h.update(vec8(ch.compression));
    return h.digest();
  }

  private handleInitialClientHello(body: Buffer, msgSeq: number, recSeqHi: number, recSeqLo: number, peerKey: string): void {
    let ch: ClientHello;
    try {
      ch = parseClientHello(body);
    } catch {
      this.badRecords++;
      return; // stateless: never answer garbage
    }
    if (this.opts.helloVerify === true) {
      const cookie = this.computeCookie(ch, peerKey);
      if (ch.cookie.length !== cookie.length || !timingSafeEqual(ch.cookie, cookie)) {
        this.sendHelloVerifyRequest(cookie, msgSeq, recSeqHi, recSeqLo);
        return;
      }
    }
    // Allocate the handshake and answer with flight 4 (ServerHello's message_seq = the
    // ClientHello's: 0 without HelloVerifyRequest). A retransmitted ClientHello then has
    // msgSeq < nextReceiveSeq and only retransmits flight 4 (handleHandshakeRecord).
    this.state = 'handshake';
    this.helloReassembly = null;
    this.nextReceiveSeq = msgSeq + 1;
    this.nextSendSeq = msgSeq;
    this.writeSeqHi[0] = recSeqHi;
    this.writeSeqLo[0] = recSeqLo;
    this.appendTranscript(HandshakeType.ClientHello, msgSeq, body);
    try {
      this.negotiate(ch);
    } catch (err) {
      if (err instanceof HandshakeError) this.fail(err.alert, `dtls-error:${err.reason}`);
      else this.fail(AlertDescription.InternalError, `dtls-error:internal-${(err as Error).message}`);
    }
  }

  private sendHelloVerifyRequest(cookie: Buffer, msgSeq: number, recSeqHi: number, recSeqLo: number): void {
    // RFC 6347 §4.2.1: version DTLS 1.0 in HVR; record sequence = the ClientHello's.
    const body = Buffer.concat([u16(DTLS_1_0), vec8(cookie)]);
    const hs = handshakeBytes(HandshakeType.HelloVerifyRequest, msgSeq, body, 0, body.length);
    const rec = Buffer.allocUnsafe(RECORD_HEADER + hs.length);
    writeRecordHeader(rec, ContentType.Handshake, DTLS_1_0, 0, recSeqHi, recSeqLo, hs.length);
    hs.copy(rec, RECORD_HEADER);
    this.opts.send(rec);
  }

  private negotiate(ch: ClientHello): void {
    // Version: DTLS numbers count down (1.0 = 0xfeff, 1.2 = 0xfefd). client_version (the
    // legacy_version of a DTLS 1.3 client) must be 1.2 or "newer"; a supported_versions
    // list (DTLS 1.3 clients) must contain 1.2. We always answer 1.2.
    if (ch.version >>> 8 !== 0xfe || ch.version > DTLS_1_2) throw new HandshakeError(AlertDescription.ProtocolVersion, 'protocol-version');
    const sv = ch.extensions.get(Ext.SupportedVersions);
    if (sv !== undefined) {
      const list: number[] = [];
      if (sv.length >= 1 && sv[0] === sv.length - 1 && (sv.length - 1) % 2 === 0) {
        for (let i = 1; i < sv.length; i += 2) list.push(sv.readUInt16BE(i));
      }
      if (!list.includes(DTLS_1_2)) throw new HandshakeError(AlertDescription.ProtocolVersion, 'protocol-version');
      this.clientOfferedDtls13 = list.includes(DTLS_1_3);
    }
    if (!ch.compression.includes(0)) throw new HandshakeError(AlertDescription.HandshakeFailure, 'no-null-compression');

    let suite: CipherSuite | undefined;
    for (const id of this.suitePrefs) {
      if (ch.suites.includes(id)) {
        suite = SUITES.find((s) => s.id === id);
        if (suite !== undefined) break;
      }
    }
    if (suite === undefined) throw new HandshakeError(AlertDescription.HandshakeFailure, 'no-common-cipher-suite');

    const groups = u16List(ch.extensions.get(Ext.SupportedGroups), 2) ?? [GROUP_SECP256R1];
    const group = groups.includes(GROUP_X25519) ? GROUP_X25519 : groups.includes(GROUP_SECP256R1) ? GROUP_SECP256R1 : 0;
    if (group === 0) throw new HandshakeError(AlertDescription.HandshakeFailure, 'no-common-group');

    const pf = ch.extensions.get(Ext.EcPointFormats);
    if (pf !== undefined && (pf.length < 2 || pf[0] !== pf.length - 1 || !pf.subarray(1).includes(0))) {
      throw new HandshakeError(AlertDescription.IllegalParameter, 'ec-point-formats');
    }
    const sigs = u16List(ch.extensions.get(Ext.SignatureAlgorithms), 2);
    if (sigs === null || !sigs.includes(SIG_ECDSA_SHA256)) throw new HandshakeError(AlertDescription.HandshakeFailure, 'no-ecdsa-sha256');

    const ems = ch.extensions.get(Ext.ExtendedMasterSecret);
    if (ems === undefined || ems.length !== 0) {
      throw new HandshakeError(AlertDescription.HandshakeFailure, 'extended-master-secret-required');
    }
    const reneg = ch.extensions.get(Ext.RenegotiationInfo);
    if (reneg !== undefined && (reneg.length !== 1 || reneg[0] !== 0)) {
      throw new HandshakeError(AlertDescription.HandshakeFailure, 'renegotiation-info');
    }
    const secureReneg = reneg !== undefined || ch.suites.includes(SCSV_RENEGOTIATION);

    this.suite = suite;
    this.group = group;
    this.clientRandom = Buffer.from(ch.random);
    this.serverRandom = randomBytes(32);
    this.ecdhe = makeEcdhe(group);

    // ServerHello
    const exts: Buffer[] = [];
    if (secureReneg) exts.push(u16(Ext.RenegotiationInfo), u16(1), Buffer.from([0]));
    exts.push(u16(Ext.ExtendedMasterSecret), u16(0));
    if (pf !== undefined) exts.push(u16(Ext.EcPointFormats), u16(2), Buffer.from([1, 0]));
    const serverHello = Buffer.concat([
      u16(DTLS_1_2),
      this.serverRandom,
      Buffer.from([0]), // empty session_id: no resumption
      u16(suite.id),
      Buffer.from([0]), // null compression
      vec16(Buffer.concat(exts)),
    ]);

    const certificate = vec24(vec24(this.opts.certificate.der));

    const params = Buffer.concat([Buffer.from([3]), u16(group), vec8(this.ecdhe.publicKey)]); // named_curve
    const signature = sign('sha256', Buffer.concat([this.clientRandom, this.serverRandom, params]), {
      key: this.opts.certificate.privateKey,
      dsaEncoding: 'der',
    });
    const serverKeyExchange = Buffer.concat([params, u16(SIG_ECDSA_SHA256), vec16(signature)]);

    const sigAlgs = Buffer.alloc(CLIENT_SIG_ALGS.size * 2);
    let i = 0;
    for (const k of CLIENT_SIG_ALGS.keys()) {
      sigAlgs.writeUInt16BE(k, i);
      i += 2;
    }
    const certificateRequest = Buffer.concat([
      vec8(Buffer.from([64, 1])), // ecdsa_sign, rsa_sign
      vec16(sigAlgs),
      u16(0), // no certificate_authorities
    ]);

    const flight: OutMessage[] = [];
    const add = (type: number, body: Uint8Array) => {
      const seq = this.nextSendSeq++;
      this.appendTranscript(type, seq, body);
      flight.push({ type, seq, body, epoch: 0 });
    };
    add(HandshakeType.ServerHello, serverHello);
    add(HandshakeType.Certificate, certificate);
    add(HandshakeType.ServerKeyExchange, serverKeyExchange);
    add(HandshakeType.CertificateRequest, certificateRequest);
    add(HandshakeType.ServerHelloDone, new Uint8Array(0));
    this.expect = 'certificate';
    this.lastFlight = flight;
    this.sendFlight(flight);
    this.armRetransmitTimer();
  }

  // ------------------------------------------------------------ flight 5

  private handleMessage(type: number, body: Buffer, seq: number, epoch: number): void {
    switch (this.expect) {
      case 'certificate': {
        this.expectType(type, HandshakeType.Certificate, epoch, 0);
        this.handleClientCertificate(body);
        this.appendTranscript(type, seq, body);
        this.expect = 'cke';
        return;
      }
      case 'cke': {
        this.expectType(type, HandshakeType.ClientKeyExchange, epoch, 0);
        const r = new Reader(body);
        const point = r.vec8();
        if (!r.done) throw new DecodeError('cke');
        const pms = this.ecdhe!.derive(point);
        this.ecdhe = null;
        this.appendTranscript(type, seq, body);
        const suite = this.suite!;
        const sessionHash = this.transcriptHash(suite.hash);
        const master = prf(suite.hash, pms, 'extended master secret', sessionHash, 48);
        pms.fill(0);
        this.masterSecret = master;
        const k = suite.keyLength;
        const iv = suite.ivLength;
        const block = prf(suite.hash, master, 'key expansion', Buffer.concat([this.serverRandom!, this.clientRandom!]), 2 * k + 2 * iv);
        const impl = this.opts.chacha ?? 'js';
        this.pendingRead = new RecordCipher(suite, Buffer.from(block.subarray(0, k)), Buffer.from(block.subarray(2 * k, 2 * k + iv)), impl);
        this.pendingWrite = new RecordCipher(suite, Buffer.from(block.subarray(k, 2 * k)), Buffer.from(block.subarray(2 * k + iv, 2 * k + 2 * iv)), impl);
        block.fill(0);
        block.fill(0);
        this.expect = 'cv';
        return;
      }
      case 'cv': {
        this.expectType(type, HandshakeType.CertificateVerify, epoch, 0);
        const r = new Reader(body);
        const scheme = r.u16();
        const sig = r.vec16();
        if (!r.done) throw new DecodeError('certificate-verify');
        const alg = CLIENT_SIG_ALGS.get(scheme);
        const key = this.clientKey!;
        if (alg === undefined || key.asymmetricKeyType !== alg.key) {
          throw new HandshakeError(AlertDescription.IllegalParameter, 'certificate-verify-scheme');
        }
        const signed = Buffer.concat(this.transcript);
        const ok = verify(alg.hash, signed, alg.key === 'ec' ? { key, dsaEncoding: 'der' } : key, sig);
        if (!ok) throw new HandshakeError(AlertDescription.DecryptError, 'certificate-verify');
        this.appendTranscript(type, seq, body);
        this.expect = 'ccs';
        return;
      }
      case 'finished': {
        this.expectType(type, HandshakeType.Finished, epoch, 1);
        const suite = this.suite!;
        const expected = prf(suite.hash, this.masterSecret!, 'client finished', this.transcriptHash(suite.hash), 12);
        if (body.length !== 12 || !timingSafeEqual(body, expected)) {
          throw new HandshakeError(AlertDescription.DecryptError, 'finished');
        }
        this.appendTranscript(type, seq, body);
        const verifyData = prf(suite.hash, this.masterSecret!, 'server finished', this.transcriptHash(suite.hash), 12);
        this.writeCipher = this.pendingWrite;
        this.pendingWrite = null;
        this.pendingRead = null;
        const finSeq = this.nextSendSeq++;
        const flight: OutMessage[] = [
          { type: -1, seq: -1, body: null, epoch: 0 },
          { type: HandshakeType.Finished, seq: finSeq, body: verifyData, epoch: 1 },
        ];
        this.lastFlight = flight;
        this.expect = 'done';
        this.transcript = [];
        this.reassembly.clear();
        this.helloReassembly = null;
        this.clientRandom = null;
        this.serverRandom = null;
        // handshake-only secrets/keys: not needed once the record keys exist
        this.masterSecret!.fill(0);
        this.masterSecret = null;
        this.ecdhe = null;
        this.clientKey = null;
        this.state = 'connected';
        this.sendFlight(flight);
        this.lastPeerTriggeredRetransmit = Date.now();
        this.opts.onConnected();
        return;
      }
      default:
        throw new HandshakeError(AlertDescription.UnexpectedMessage, 'unexpected-message');
    }
  }

  private expectType(type: number, want: number, epoch: number, wantEpoch: number): void {
    if (type !== want || epoch !== wantEpoch) throw new HandshakeError(AlertDescription.UnexpectedMessage, `unexpected-message-${type}`);
  }

  private handleClientCertificate(body: Buffer): void {
    const r = new Reader(body);
    const list = new Reader(r.vec24());
    if (!r.done) throw new DecodeError('certificate');
    if (list.done) throw new HandshakeError(AlertDescription.HandshakeFailure, 'no-client-certificate');
    const der = list.vec24();
    const fp = this.opts.remoteFingerprint;
    const hashName = FP_HASHES[fp.algorithm];
    if (hashName === undefined) throw new HandshakeError(AlertDescription.BadCertificate, 'fingerprint-algorithm');
    const digest = createHash(hashName).update(der).digest();
    if (digest.length !== fp.digest.length || !timingSafeEqual(digest, fp.digest)) {
      throw new HandshakeError(AlertDescription.BadCertificate, 'fingerprint-mismatch');
    }
    let key: KeyObject;
    try {
      key = new X509Certificate(der).publicKey;
    } catch {
      throw new HandshakeError(AlertDescription.BadCertificate, 'unparsable-certificate');
    }
    if (key.asymmetricKeyType !== 'ec' && key.asymmetricKeyType !== 'rsa') {
      throw new HandshakeError(AlertDescription.UnsupportedCertificate, 'certificate-key-type');
    }
    this.clientKey = key;
  }

  // ------------------------------------------------------------ transcript

  private appendTranscript(type: number, seq: number, body: Uint8Array): void {
    this.transcript.push(handshakeBytes(type, seq, body, 0, body.length));
  }

  private transcriptHash(hash: string): Buffer {
    const h = createHash(hash);
    for (const b of this.transcript) h.update(b);
    return h.digest();
  }

  // ------------------------------------------------------------ output

  /** Encrypts and sends one application-data record. false when not connected or too large. */
  send(data: Uint8Array): boolean {
    if (this.state !== 'connected' || data.length > MAX_PLAINTEXT) return false;
    const c = this.writeCipher!;
    const size = RECORD_HEADER + data.length + c.overhead;
    const sb = this.opts.sendBuffer;
    // no shared scratch from the host: an exact-size record (send() then gets the whole buffer)
    const rec = sb !== undefined ? sb(size) : Buffer.allocUnsafe(size);
    const epoch = this.writeEpoch;
    const hi = this.writeSeqHi[epoch]!;
    const lo = this.writeSeqLo[epoch]!;
    this.nextWriteSeq(epoch);
    const n = c.seal(ContentType.ApplicationData, DTLS_1_2, epoch, hi, lo, data, rec, RECORD_HEADER);
    writeRecordHeader(rec, ContentType.ApplicationData, DTLS_1_2, epoch, hi, lo, n);
    this.opts.send(rec, RECORD_HEADER + n);
    return true;
  }

  /** Largest application-data record {@link send} produces (header + max plaintext + AEAD overhead). */
  static readonly MAX_RECORD = RECORD_HEADER + MAX_PLAINTEXT + 8 + TAG_LENGTH;

  private nextWriteSeq(epoch: number): void {
    let lo = this.writeSeqLo[epoch]! + 1;
    if (lo > 0xffffffff) {
      lo = 0;
      this.writeSeqHi[epoch] = this.writeSeqHi[epoch]! + 1;
    }
    this.writeSeqLo[epoch] = lo;
  }

  /** A complete record (header + protected fragment) at the current write epoch. */
  private sealRecord(type: number, payload: Uint8Array, epoch = this.writeEpoch): Buffer {
    const hi = this.writeSeqHi[epoch]!;
    const lo = this.writeSeqLo[epoch]!;
    this.nextWriteSeq(epoch);
    if (epoch === 0) {
      const rec = Buffer.allocUnsafe(RECORD_HEADER + payload.length);
      writeRecordHeader(rec, type, DTLS_1_2, 0, hi, lo, payload.length);
      rec.set(payload, RECORD_HEADER);
      return rec;
    }
    const c = this.writeCipher!;
    const rec = Buffer.allocUnsafe(RECORD_HEADER + payload.length + c.overhead);
    const n = c.seal(type, DTLS_1_2, epoch, hi, lo, payload, rec, RECORD_HEADER);
    writeRecordHeader(rec, type, DTLS_1_2, epoch, hi, lo, n);
    return rec;
  }

  private sendFlight(flight: OutMessage[]): void {
    const datagram: Buffer[] = [];
    let size = 0;
    const flush = () => {
      if (datagram.length === 0) return;
      this.opts.send(datagram.length === 1 ? datagram[0]! : Buffer.concat(datagram, size));
      datagram.length = 0;
      size = 0;
    };
    const push = (rec: Buffer) => {
      if (size + rec.length > this.mtu) flush();
      datagram.push(rec);
      size += rec.length;
    };
    for (const m of flight) {
      if (m.body === null) {
        push(this.sealRecord(ContentType.ChangeCipherSpec, CCS_BODY, 0));
        this.writeEpoch = 1;
        continue;
      }
      const overhead = RECORD_HEADER + HS_HEADER + (m.epoch === 1 ? this.writeCipher!.overhead : 0);
      const maxFrag = Math.max(64, this.mtu - overhead);
      let off = 0;
      do {
        const n = Math.min(maxFrag, m.body.length - off);
        if (size > 0 && size + overhead + n > this.mtu) flush();
        push(this.sealRecord(ContentType.Handshake, handshakeBytes(m.type, m.seq, m.body, off, n), m.epoch));
        off += n;
      } while (off < m.body.length);
    }
    flush();
  }

  private sendAlert(level: number, desc: number): void {
    try {
      this.opts.send(this.sealRecord(ContentType.Alert, Buffer.from([level, desc])));
    } catch {
      /* best effort */
    }
  }

  // ------------------------------------------------------------ retransmission

  private armRetransmitTimer(): void {
    this.stopRetransmitTimer();
    const t = setTimeout(() => {
      this.retransmitTimer = null;
      if (this.state !== 'handshake' || this.lastFlight === null) return;
      this.sendFlight(this.lastFlight);
      this.retransmitMs = Math.min(this.retransmitMs * 2, 8000);
      this.armRetransmitTimer();
    }, this.retransmitMs);
    t.unref?.();
    this.retransmitTimer = t;
  }

  private stopRetransmitTimer(): void {
    if (this.retransmitTimer !== null) clearTimeout(this.retransmitTimer);
    this.retransmitTimer = null;
  }

  /** The peer resent its previous flight: ours was probably lost. Rate-limited resend. */
  private peerRetransmitted(): void {
    const flight = this.lastFlight;
    if (flight === null) return;
    const now = Date.now();
    if (now - this.lastPeerTriggeredRetransmit < 250) return;
    this.lastPeerTriggeredRetransmit = now;
    // fresh record sequence numbers; CCS + Finished keep their epochs (0 / 1)
    this.sendFlight(flight);
  }

  // ------------------------------------------------------------ teardown

  /** Sends a fatal alert and terminates with `reason`. */
  private fail(alert: number, reason: string): void {
    if (this.state === 'closed') return;
    this.sendAlert(AlertLevel.Fatal, alert);
    this.terminate(reason);
  }

  private terminate(reason: string): void {
    if (this.state === 'closed') return;
    this.release();
    this.opts.onClose(reason);
  }

  private release(): void {
    this.state = 'closed';
    this.stopRetransmitTimer();
    this.lastFlight = null;
    this.transcript = [];
    this.reassembly.clear();
    this.helloReassembly = null;
    this.masterSecret?.fill(0);
    this.masterSecret = null;
    this.pendingRead?.wipe();
    this.pendingWrite?.wipe();
    this.pendingRead = null;
    this.pendingWrite = null;
    this.ecdhe = null;
    this.readCipher?.wipe();
    this.writeCipher?.wipe();
    this.readCipher = null;
    this.writeCipher = null;
  }

  /** Local close: close_notify when connected, no callback. Idempotent. */
  close(): void {
    if (this.state === 'closed') return;
    if (this.state === 'connected') this.sendAlert(AlertLevel.Warning, AlertDescription.CloseNotify);
    this.release();
  }
}

const CCS_BODY = Uint8Array.of(1);

function writeRecordHeader(b: Buffer, type: number, version: number, epoch: number, seqHi: number, seqLo: number, length: number): void {
  b[0] = type;
  b.writeUInt16BE(version, 1);
  b.writeUInt16BE(epoch, 3);
  b.writeUInt16BE(seqHi, 5);
  b.writeUInt32BE(seqLo, 7);
  b.writeUInt16BE(length, 11);
}

/** Handshake header + body[off, off+len) as one fragment of the full message. */
function handshakeBytes(type: number, seq: number, body: Uint8Array, off: number, len: number): Buffer {
  const out = Buffer.allocUnsafe(HS_HEADER + len);
  out[0] = type;
  out[1] = (body.length >>> 16) & 0xff;
  out[2] = (body.length >>> 8) & 0xff;
  out[3] = body.length & 0xff;
  out.writeUInt16BE(seq, 4);
  out[6] = (off >>> 16) & 0xff;
  out[7] = (off >>> 8) & 0xff;
  out[8] = off & 0xff;
  out[9] = (len >>> 16) & 0xff;
  out[10] = (len >>> 8) & 0xff;
  out[11] = len & 0xff;
  out.set(body.subarray(off, off + len), HS_HEADER);
  return out;
}
