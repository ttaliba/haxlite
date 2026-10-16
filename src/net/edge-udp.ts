/**
 * haxlite Edge tunnel v2 data plane: our own SCTP association
 * (src/rtc/sctp) over AEAD-sealed UDP datagrams (AES-128-GCM, or
 * ChaCha20-Poly1305 when both ends agree: {@link TunnelAead}). Shared by the host
 * (`edge-client.ts`, SCTP initiator) and the edge (`src/edge`, SCTP passive
 * side). No WebRTC and no native addon. See docs/09-haxlite-edge.md §1.3.
 *
 * Keys: both sides generate an ephemeral x25519 key pair per tunnel session
 * and exchange the public halves over the already-authenticated control
 * WebSocket (`Auth`/`AuthOk`, both MAC'd with the API key, see
 * `edge-protocol.ts`). Then
 *
 * ```
 * salt   = HMAC-SHA256(apiSecret, "haxlite-tunnel/2 salt" ‖ helloNonce)
 * okm    = HKDF-SHA256(ikm = X25519(priv, peerPub), salt,
 *                      info = "haxlite-tunnel/2" ‖ hostPub ‖ edgePub ‖ u32 connId, 64)
 * s_h2e  = okm[0..32)   s_e2h = okm[32..64)        (one secret per direction)
 * key_e  = HKDF(s_e, "haxlite-tunnel/2 key", 16)   iv_e = HKDF(s_e, "haxlite-tunnel/2 iv", 12)
 *          (ChaCha20-Poly1305: key_e = HKDF(s_e, "haxlite-tunnel/2 chacha20 key", 32))
 * s_e+1  = HKDF(s_e, "haxlite-tunnel/2 next", 32)  (ratchet every 2^24 datagrams; old keys erased)
 * ```
 *
 * so the data keys need the ECDHE secret (forward secrecy) AND the API key
 * (a man in the middle of a non-TLS control channel still cannot derive them).
 *
 * Datagram (both directions):
 *
 * ```
 * [u8 type][u32 connId][u16 epoch][u48 seq] [AEAD(payload)] [16 B tag]
 *  └──────────────── 13 B header = AAD ──┘
 * nonce = iv_epoch XOR (0^6 ‖ seq48)
 * ```
 *
 * `type`: {@link UdpType}. `seq` is per direction and epoch, strictly
 * increasing; the receiver keeps a {@link REPLAY_WINDOW}-packet sliding
 * window. Everything is authenticated before anything is acted on.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPublicKey,
  createSecretKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import { ChaCha20Poly1305 } from '../rtc/dtls/chacha.js';
import { AuthFlag } from './edge-protocol.js';
import { SctpAssociation, type SctpChannelConfig } from '../rtc/sctp/index.js';

/** Datagram types (cleartext, authenticated). Outside RFC 7983's STUN/DTLS/TURN/RTP ranges. */
export const UdpType = {
  /** One SCTP packet. */
  Sctp: 0xf0,
  /** `[f64 t]` (≤ 64 B): answered with a {@link Pong} of the same size. NAT keep-alive from the host. */
  Ping: 0xf1,
  Pong: 0xf2,
  /** The sender is closing the tunnel. */
  Close: 0xf3,
} as const;

export const UDP_HEADER_LENGTH = 13;
export const UDP_TAG_LENGTH = 16;
/** Bytes a datagram adds to its payload. */
export const UDP_OVERHEAD = UDP_HEADER_LENGTH + UDP_TAG_LENGTH;
/** Sliding anti-replay window (packets). */
export const REPLAY_WINDOW = 1024;
/** Datagrams sealed per key before the sender ratchets to the next epoch. */
export const REKEY_AFTER_PACKETS = 1 << 24;
/** How long the previous epoch's key is still accepted after a ratchet (reordering). */
const PREV_EPOCH_GRACE_MS = 30_000;
const MAX_SEQ = 2 ** 48 - 1;
const MAX_PING = 64;

/** Largest tunnel message (one player payload + headers, or a multicast). */
export const TUNNEL_MAX_MESSAGE = 1 << 20;
/** SCTP packet size inside the tunnel: + 29 B (AEAD) + 48 B (IPv6/UDP) stays ≤ 1280. */
export const TUNNEL_SCTP_MTU = 1200;

/**
 * SCTP tuning of the tunnel. Both ends are ours (no browser defaults to stay
 * compatible with), so the delayed-SACK timer is short and the RTO floor
 * low: a loss on the host↔edge path is repaired in ~tens of ms instead of
 * the ≥ 200 ms WebRTC stacks use.
 */
export const TUNNEL_SCTP_TUNING = {
  sackDelay: 10,
  rtoInitial: 300,
  rtoMin: 30,
  rtoMax: 3000,
  rtoMinVariance: 20,
  maxRetransmissions: 20,
  maxInitRetransmits: 12,
};

const EMPTY = Buffer.alloc(0);
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ALGO = 'aes-128-gcm';

/**
 * Datagram AEAD of a tunnel. `'aes-128-gcm'` (node:crypto) is protocol v2's
 * original and the default; `'chacha20-poly1305'` (the allocation-free, in
 * place JS AEAD of src/rtc/dtls/chacha.ts) is used only when both ends
 * agreed on it (`AuthFlag.ChaCha`, see edge-protocol.ts). Same datagram
 * layout, nonce construction, replay window and ratchet; only the key
 * (32 B, its own HKDF label) and the cipher differ.
 */
export type TunnelAead = 'aes-128-gcm' | 'chacha20-poly1305';

const IS_BUN = typeof (process.versions as Record<string, string | undefined>).bun === 'string';

/**
 * This runtime's cheaper tunnel AEAD. Node: ChaCha20-Poly1305 in JS (no
 * native cipher object and no Buffers per datagram, where node:crypto's
 * AES-GCM costs ~4 µs per seal or open, mostly the per-datagram cipher
 * object). Bun: AES-128-GCM — its node:crypto is cheap and JSC runs the JS
 * ChaCha slower than V8.
 */
export function preferredTunnelAead(bun = IS_BUN): TunnelAead {
  return bun ? 'aes-128-gcm' : 'chacha20-poly1305';
}

/** Tunnel AEAD setting of either end: `'auto'` = {@link preferredTunnelAead}. */
export type TunnelAeadOption = TunnelAead | 'auto';

/** Host: the AEAD flag to add to a v2 `Auth` that asks for {@link AuthFlag.Udp} (0 = AES-128-GCM). */
export function tunnelAeadRequest(option: TunnelAeadOption = 'auto'): number {
  const want = option === 'auto' ? preferredTunnelAead() : option;
  return want === 'chacha20-poly1305' ? AuthFlag.ChaCha : 0;
}

/**
 * Edge: the AEAD for a host that asked for `requested` flags (granting the
 * UDP plane). ChaCha20-Poly1305 only when the host asked for it and this
 * end's setting agrees; otherwise AES-128-GCM (what every v2 peer speaks).
 */
export function grantTunnelAead(requested: number, option: TunnelAeadOption = 'auto'): TunnelAead {
  if ((requested & AuthFlag.ChaCha) === 0) return 'aes-128-gcm';
  return (option === 'auto' ? preferredTunnelAead() : option) === 'chacha20-poly1305' ? 'chacha20-poly1305' : 'aes-128-gcm';
}

/** The flag that announces `aead` in `AuthOk`. */
export function tunnelAeadFlag(aead: TunnelAead): number {
  return aead === 'chacha20-poly1305' ? AuthFlag.ChaCha : 0;
}

/** Host: the AEAD the edge granted (its `AuthOk` flags). */
export function grantedTunnelAead(granted: number): TunnelAead {
  return (granted & AuthFlag.ChaCha) !== 0 ? 'chacha20-poly1305' : 'aes-128-gcm';
}

// ------------------------------------------------------------------ keys

export interface X25519Pair {
  privateKey: KeyObject;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
}

export function x25519Generate(): X25519Pair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: Buffer.from(der.subarray(der.length - 32)) };
}

/** X25519(priv, peerPub). Throws on a malformed or low-order peer key (all-zero secret). */
export function x25519Shared(privateKey: KeyObject, peerPublic: Uint8Array): Buffer {
  if (peerPublic.length !== 32) throw new Error('bad x25519 public key');
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, peerPublic]), format: 'der', type: 'spki' });
  const s = diffieHellman({ privateKey, publicKey });
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc |= s[i]!;
  if (acc === 0) throw new Error('x25519: low-order public key');
  return s;
}

export interface TunnelSecrets {
  /** host → edge traffic secret (epoch 0). */
  h2e: Buffer;
  /** edge → host traffic secret (epoch 0). */
  e2h: Buffer;
}

/** Per-session traffic secrets (see the module comment). */
export function deriveTunnelSecrets(
  shared: Uint8Array,
  apiSecret: string,
  nonce: Uint8Array,
  hostPub: Uint8Array,
  edgePub: Uint8Array,
  connId: number,
): TunnelSecrets {
  const salt = createHmac('sha256', apiSecret).update('haxlite-tunnel/2 salt').update(nonce).digest();
  const id = Buffer.allocUnsafe(4);
  id.writeUInt32BE(connId >>> 0, 0);
  const info = Buffer.concat([Buffer.from('haxlite-tunnel/2'), hostPub, edgePub, id]);
  const okm = Buffer.from(hkdfSync('sha256', shared, salt, info, 64));
  return { h2e: okm.subarray(0, 32), e2h: okm.subarray(32, 64) };
}

function expand(secret: Uint8Array, label: string, n: number): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, EMPTY, label, n));
}

interface EpochKeys {
  epoch: number;
  secret: Buffer;
  /** AES-128-GCM key (null with ChaCha20-Poly1305). */
  key: KeyObject | null;
  /** ChaCha20-Poly1305 AEAD (null with AES-128-GCM). */
  chacha: ChaCha20Poly1305 | null;
  iv: Buffer;
}

function epochKeys(secret: Buffer, epoch: number, aead: TunnelAead): EpochKeys {
  const iv = expand(secret, 'haxlite-tunnel/2 iv', 12);
  if (aead === 'chacha20-poly1305') {
    const raw = expand(secret, 'haxlite-tunnel/2 chacha20 key', 32);
    const chacha = new ChaCha20Poly1305(raw);
    raw.fill(0);
    return { epoch, secret, key: null, chacha, iv };
  }
  return { epoch, secret, key: createSecretKey(expand(secret, 'haxlite-tunnel/2 key', 16)), chacha: null, iv };
}

function nextEpoch(k: EpochKeys): EpochKeys {
  return epochKeys(expand(k.secret, 'haxlite-tunnel/2 next', 32), k.epoch + 1, k.chacha !== null ? 'chacha20-poly1305' : 'aes-128-gcm');
}

/** Best-effort erasure of a retired epoch's key material. */
function wipe(k: EpochKeys): void {
  k.chacha?.wipe();
  k.secret.fill(0);
}

/** Receive state of one epoch: key + sliding replay window. */
class RecvEpoch {
  readonly keys: EpochKeys;
  max = -1;
  private readonly bits = new Uint32Array(REPLAY_WINDOW >>> 5);
  retiredAt = 0;
  constructor(keys: EpochKeys) {
    this.keys = keys;
  }

  /** Not yet seen and inside the window (no state change). */
  check(seq: number): boolean {
    if (seq > this.max) return true;
    if (this.max - seq >= REPLAY_WINDOW) return false;
    const i = seq % REPLAY_WINDOW;
    return (this.bits[i >>> 5]! & (1 << (i & 31))) === 0;
  }

  /** Marks `seq` seen (after authentication). Returns true when it is the newest so far. */
  accept(seq: number): boolean {
    let newest = false;
    if (seq > this.max) {
      newest = true;
      if (seq - this.max >= REPLAY_WINDOW) this.bits.fill(0);
      else for (let s = this.max + 1; s < seq; s++) this.bits[(s % REPLAY_WINDOW) >>> 5]! &= ~(1 << (s % REPLAY_WINDOW & 31));
      this.max = seq;
    }
    const i = seq % REPLAY_WINDOW;
    this.bits[i >>> 5]! |= 1 << (i & 31);
    return newest;
  }
}

/** Reads the connection id of a datagram (no authentication). -1 if too short. */
export function udpConnId(d: Uint8Array): number {
  if (d.length < UDP_OVERHEAD) return -1;
  return ((d[1]! << 24) | (d[2]! << 16) | (d[3]! << 8) | d[4]!) >>> 0;
}

/** Smallest reusable output buffer (an MTU-sized SCTP packet + overhead fits). */
const SCRATCH_SIZE = 2048;

/**
 * Sealing/opening for one tunnel (both directions). Nonces never repeat: one
 * key per direction and epoch, a strictly increasing 48-bit sequence number.
 *
 * Allocations per datagram: with AES-128-GCM, node:crypto needs a fresh
 * native cipher object per nonce plus its output and tag Buffers
 * (unavoidable through its API); everything else is preallocated — the
 * header (AAD), nonce and tag are written to scratch buffers, and with
 * `reuse` the datagram itself is written to a buffer kept across calls.
 * With ChaCha20-Poly1305 nothing but the plaintext view: sealed in the
 * output buffer, opened in place.
 */
export class TunnelCipher {
  readonly connId: number;
  readonly aead: TunnelAead;
  private send: EpochKeys;
  private seq = 0;
  private cur: RecvEpoch;
  private prev: RecvEpoch | null = null;
  private next: RecvEpoch | null = null;
  private readonly rekeyAfter: number;
  private readonly nonce = Buffer.alloc(12);
  /** Header (AAD) of the datagram being sealed/opened. */
  private readonly hdr = Buffer.alloc(UDP_HEADER_LENGTH);
  /** Tag of the datagram being opened. */
  private readonly tag = Buffer.alloc(UDP_TAG_LENGTH);
  /** Reusable output (see {@link seal}) and its last exact-length view. */
  private scratch: Buffer | null = null;
  private view: Buffer | null = null;
  /** Type of the last datagram {@link open} accepted. */
  lastType = 0;
  /** The last accepted datagram was the newest one seen (eligible to move the peer address). */
  lastNewest = false;
  /** Datagrams dropped as replays / outside the window, and failed authentications. */
  replayed = 0;
  badMac = 0;
  /** Epoch ratchets (send + receive). */
  rekeys = 0;

  constructor(connId: number, sendSecret: Buffer, recvSecret: Buffer, opts: { rekeyAfterPackets?: number; aead?: TunnelAead } = {}) {
    this.connId = connId >>> 0;
    const aead = (this.aead = opts.aead ?? 'aes-128-gcm');
    if (aead !== 'aes-128-gcm' && aead !== 'chacha20-poly1305') throw new Error(`unknown tunnel AEAD ${String(aead)}`);
    this.send = epochKeys(Buffer.from(sendSecret), 0, aead);
    this.cur = new RecvEpoch(epochKeys(Buffer.from(recvSecret), 0, aead));
    this.rekeyAfter = Math.max(2, opts.rekeyAfterPackets ?? REKEY_AFTER_PACKETS);
  }

  /**
   * Builds an authenticated datagram; null when the sequence space is
   * exhausted (never in practice). With `reuse` the result is a view of a
   * buffer this cipher reuses on the next `reuse` call: only for a
   * transport that is done with it once its send returns (else call
   * {@link releaseScratch}); without it, a fresh buffer.
   */
  seal(type: number, plain: Uint8Array, reuse = false): Buffer | null {
    if (this.seq >= this.rekeyAfter) {
      if (this.send.epoch >= 0xffff) return null;
      const old = this.send;
      this.send = nextEpoch(old);
      wipe(old);
      this.seq = 0;
      this.rekeys++;
    }
    const seq = this.seq++;
    if (seq > MAX_SEQ) return null;
    const k = this.send;
    const n = plain.length;
    const total = UDP_OVERHEAD + n;
    const out = reuse ? this.output(total) : Buffer.allocUnsafe(total);
    // header: [u8 type][u32 connId][u16 epoch][u48 seq]
    const h = this.hdr;
    const id = this.connId;
    const hi = Math.floor(seq / 0x100000000);
    const lo = seq >>> 0;
    h[0] = type;
    h[1] = id >>> 24;
    h[2] = id >>> 16;
    h[3] = id >>> 8;
    h[4] = id;
    h[5] = k.epoch >>> 8;
    h[6] = k.epoch;
    h[7] = hi >>> 8;
    h[8] = hi;
    h[9] = lo >>> 24;
    h[10] = lo >>> 16;
    h[11] = lo >>> 8;
    h[12] = lo;
    out.set(h, 0);
    const nonce = this.nonce;
    setNonce(nonce, k.iv, h);
    const chacha = k.chacha;
    if (chacha !== null) {
      if (n > 0) out.set(plain, UDP_HEADER_LENGTH);
      chacha.seal(nonce, h, 0, UDP_HEADER_LENGTH, out, UDP_HEADER_LENGTH, n, out, UDP_HEADER_LENGTH + n);
      return out;
    }
    const c = createCipheriv(ALGO, k.key!, nonce, { authTagLength: UDP_TAG_LENGTH });
    c.setAAD(h);
    if (n > 0) out.set(c.update(plain), UDP_HEADER_LENGTH);
    c.final();
    out.set(c.getAuthTag(), UDP_HEADER_LENGTH + n);
    return out;
  }

  /** Forgets the reusable output buffer (the transport kept the last one). */
  releaseScratch(): void {
    this.scratch = null;
    this.view = null;
  }

  private output(total: number): Buffer {
    let s = this.scratch;
    if (s === null || s.length < total) {
      s = this.scratch = Buffer.allocUnsafeSlow(Math.max(SCRATCH_SIZE, total));
      this.view = null;
    }
    let v = this.view;
    if (v === null || v.length !== total) v = this.view = s.subarray(0, total);
    return v;
  }

  /**
   * Authenticates and decrypts a datagram addressed to this tunnel. Returns
   * the plaintext or null (malformed, replayed, bad MAC; `d` untouched).
   * AES-128-GCM: a fresh buffer. ChaCha20-Poly1305: decrypted in place, a
   * view of `d` (whose ciphertext is overwritten: `d` must be the caller's).
   */
  open(d: Uint8Array, now: number = performance.now()): Buffer | null {
    if (d.length < UDP_OVERHEAD || udpConnId(d) !== this.connId) return null;
    const epoch = (d[5]! << 8) | d[6]!;
    const seq = (d[7]! * 2 ** 40) + (d[8]! * 2 ** 32) + (((d[9]! << 24) | (d[10]! << 16) | (d[11]! << 8) | d[12]!) >>> 0);
    let e: RecvEpoch | null;
    const cur = this.cur;
    if (epoch === cur.keys.epoch) e = cur;
    else if (epoch === cur.keys.epoch + 1) e = this.next ??= new RecvEpoch(nextEpoch(cur.keys));
    else if (this.prev !== null && epoch === this.prev.keys.epoch && now - this.prev.retiredAt < PREV_EPOCH_GRACE_MS) e = this.prev;
    else e = null;
    if (e === null || !e.check(seq)) {
      this.replayed++;
      return null;
    }
    const k = e.keys;
    const tagAt = d.length - UDP_TAG_LENGTH;
    const nonce = this.nonce;
    setNonce(nonce, k.iv, d);
    let pt: Buffer;
    const chacha = k.chacha;
    if (chacha !== null) {
      const n = tagAt - UDP_HEADER_LENGTH;
      if (!chacha.open(nonce, d, 0, UDP_HEADER_LENGTH, d, UDP_HEADER_LENGTH, n, d, tagAt)) {
        this.badMac++;
        return null;
      }
      pt = n > 0 ? Buffer.from(d.buffer, d.byteOffset + UDP_HEADER_LENGTH, n) : EMPTY;
    } else {
      const h = this.hdr;
      for (let i = 0; i < UDP_HEADER_LENGTH; i++) h[i] = d[i]!;
      const tag = this.tag;
      for (let i = 0; i < UDP_TAG_LENGTH; i++) tag[i] = d[tagAt + i]!;
      try {
        const dc = createDecipheriv(ALGO, k.key!, nonce, { authTagLength: UDP_TAG_LENGTH });
        dc.setAAD(h);
        dc.setAuthTag(tag);
        pt = tagAt > UDP_HEADER_LENGTH ? dc.update(d.subarray(UDP_HEADER_LENGTH, tagAt)) : EMPTY;
        dc.final();
      } catch {
        this.badMac++;
        return null;
      }
    }
    let newest = e.accept(seq);
    if (e === this.next) {
      // the peer ratcheted: previous epoch kept a little for reordered packets, older keys erased
      cur.retiredAt = now;
      if (this.prev !== null) wipe(this.prev.keys);
      this.prev = cur;
      this.cur = e;
      this.next = null;
      this.rekeys++;
      newest = true;
    } else if (e === this.prev) newest = false;
    this.lastType = d[0]!;
    this.lastNewest = newest;
    return pt;
  }
}

/** nonce = iv XOR (0^6 ‖ seq48), seq48 = header[7..13). */
function setNonce(nonce: Buffer, iv: Buffer, h: Uint8Array): void {
  for (let i = 0; i < 6; i++) nonce[i] = iv[i]!;
  for (let i = 6; i < 12; i++) nonce[i] = iv[i]! ^ h[i + 1]!;
}

// ------------------------------------------------------------------ plane

/** Tunnel channels: ro, ru, uu, then the extra ordered `ro` lanes. */
export function tunnelChannels(lanes: number): SctpChannelConfig[] {
  const out: SctpChannelConfig[] = [
    { id: 0, ordered: true },
    { id: 1, ordered: false },
    { id: 2, ordered: false, maxRetransmits: 0 },
  ];
  for (let k = 1; k < lanes; k++) out.push({ id: 2 + k, ordered: true });
  return out;
}

export interface UdpPlaneEvents {
  /** SCTP association up: every tunnel channel is usable. */
  onOpen(): void;
  /** A tunnel message on channel `ch` (fresh memory, may be kept). */
  onMessage(ch: number, data: Uint8Array): void;
  /** Tunnel gone (`'sctp:<reason>'`, `'remote-close'`). Never after {@link UdpTunnelPlane.close}. */
  onClose(reason: string): void;
  onError?(err: unknown): void;
}

export interface UdpPlaneOptions {
  /** `'client'` (host: SCTP initiator, sends first) or `'server'` (edge: passive). */
  role: 'client' | 'server';
  connId: number;
  secrets: TunnelSecrets;
  /** `ro` lanes (1 = the single `ro` channel). */
  lanes: number;
  /**
   * Puts a sealed datagram on the wire (the edge drops it while the host's
   * address is unknown). Returning `true` promises the buffer is no longer
   * referenced (sent synchronously, copied or dropped): the plane then
   * writes the next datagrams into one reused buffer instead of a fresh one each.
   */
  transmit(datagram: Buffer): boolean | void;
  events: UdpPlaneEvents;
  /** Datagram AEAD both ends agreed on (default AES-128-GCM, see {@link TunnelAead}). */
  aead?: TunnelAead;
  /** Tests: ratchet after this many datagrams. */
  rekeyAfterPackets?: number;
  /** SCTP overrides (benchmarks). */
  sctp?: Partial<typeof TUNNEL_SCTP_TUNING>;
}

export interface UdpPlaneStats {
  packetsIn: number;
  packetsOut: number;
  bytesIn: number;
  bytesOut: number;
  /** Datagrams that failed authentication / were replayed. */
  badMac: number;
  replayed: number;
  rekeys: number;
  /** Last UDP round trip (Ping/Pong), ms. */
  rttMs: number | null;
  sctp: ReturnType<SctpAssociation['stats']>;
}

/** SCTP association + {@link TunnelCipher}: one tunnel's UDP data plane (either side). */
export class UdpTunnelPlane {
  readonly cipher: TunnelCipher;
  readonly role: 'client' | 'server';
  private readonly assoc: SctpAssociation;
  private readonly transmitFn: (d: Buffer) => boolean | void;
  /** The transport released the last datagram on return: seal into the cipher's reusable buffer. */
  private reuse = false;
  private readonly pingBuf = Buffer.alloc(8);
  private readonly ev: UdpPlaneEvents;
  open = false;
  closed = false;
  /** performance.now() of the last authenticated datagram (0 = none yet). */
  lastRx = 0;
  rttMs: number | null = null;
  private readonly c = { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };

  constructor(o: UdpPlaneOptions) {
    this.role = o.role;
    this.transmitFn = o.transmit;
    this.ev = o.events;
    const client = o.role === 'client';
    this.cipher = new TunnelCipher(o.connId, client ? o.secrets.h2e : o.secrets.e2h, client ? o.secrets.e2h : o.secrets.h2e, {
      rekeyAfterPackets: o.rekeyAfterPackets,
      aead: o.aead,
    });
    const onError = (err: unknown) => {
      try {
        this.ev.onError?.(err);
      } catch {
        /* never propagate */
      }
    };
    this.assoc = new SctpAssociation({
      ...TUNNEL_SCTP_TUNING,
      ...o.sctp,
      send: (packet) => this.sendRaw(UdpType.Sctp, packet),
      channels: tunnelChannels(o.lanes),
      maxMessageSize: TUNNEL_MAX_MESSAGE,
      maxReceiveMessageSize: TUNNEL_MAX_MESSAGE,
      mtu: TUNNEL_SCTP_MTU,
      onMessage: (ch, data) => {
        if (!this.closed) this.ev.onMessage(ch, data);
      },
      onOpen: () => {
        if (this.closed || this.open) return;
        this.open = true;
        this.ev.onOpen();
      },
      onClose: (reason) => this.fail(`sctp:${reason}`),
      onError,
    });
    if (client) {
      this.ping(); // first datagram from the host: opens its NAT mapping and teaches the edge its address
      this.assoc.connect();
    }
  }

  private sendRaw(type: number, payload: Uint8Array): void {
    if (this.closed) return;
    const reuse = this.reuse;
    const d = this.cipher.seal(type, payload, reuse);
    if (d === null) {
      this.fail('keys-exhausted');
      return;
    }
    this.c.packetsOut++;
    this.c.bytesOut += d.length;
    const released = this.transmitFn(d) === true;
    if (released) this.reuse = true;
    else if (reuse) this.cipher.releaseScratch(); // still referenced (queued): next datagrams get a new buffer
  }

  /**
   * Step 1 of receiving: authenticates `d`. Returns the plaintext or null.
   * The caller may then update the peer address (edge) and must call
   * {@link dispatch} with the plaintext.
   */
  authenticate(d: Uint8Array): Buffer | null {
    if (this.closed) return null;
    const pt = this.cipher.open(d);
    if (pt === null) return null;
    this.lastRx = performance.now();
    this.c.packetsIn++;
    this.c.bytesIn += d.length;
    return pt;
  }

  /** Step 2: acts on an authenticated datagram's plaintext (type: `cipher.lastType`). */
  dispatch(pt: Buffer, type: number = this.cipher.lastType): void {
    if (this.closed) return;
    switch (type) {
      case UdpType.Sctp:
        this.assoc.input(pt);
        return;
      case UdpType.Ping:
        // same size back: never more bytes than we received
        if (pt.length <= MAX_PING) this.sendRaw(UdpType.Pong, pt);
        return;
      case UdpType.Pong:
        if (pt.length === 8) this.rttMs = Math.max(0, performance.now() - pt.readDoubleBE(0));
        return;
      case UdpType.Close:
        this.fail('remote-close');
        return;
    }
  }

  /** {@link authenticate} + {@link dispatch}. */
  receive(d: Uint8Array): boolean {
    const pt = this.authenticate(d);
    if (pt === null) return false;
    this.dispatch(pt);
    return true;
  }

  /** Keep-alive / RTT probe (8 bytes). */
  ping(): void {
    const b = this.pingBuf;
    b.writeDoubleBE(performance.now(), 0);
    this.sendRaw(UdpType.Ping, b); // sealed into the datagram: the buffer is free again
  }

  /** Sends one message on tunnel channel `ch` (copied synchronously). False if not open / buffer full. */
  send(ch: number, frame: Uint8Array): boolean {
    if (!this.open || this.closed) return false;
    return this.assoc.send(ch, frame);
  }

  /** Bundles the following sends into as few datagrams as possible until {@link uncork}. */
  cork(): void {
    this.assoc.cork();
  }

  uncork(): void {
    this.assoc.uncork();
  }

  get bufferedAmount(): number {
    return this.assoc.bufferedAmount;
  }

  stats(): UdpPlaneStats {
    return {
      ...this.c,
      badMac: this.cipher.badMac,
      replayed: this.cipher.replayed,
      rekeys: this.cipher.rekeys,
      rttMs: this.rttMs,
      sctp: this.assoc.stats(),
    };
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.assoc.close();
    try {
      this.ev.onClose(reason);
    } catch (err) {
      this.ev.onError?.(err);
    }
  }

  /** Local close: tells the peer (ABORT + Close datagram, best effort). No onClose. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.assoc.close(); // ABORT goes out through sendRaw while still open
    this.sendRaw(UdpType.Close, EMPTY);
    this.closed = true;
    this.open = false;
  }
}
