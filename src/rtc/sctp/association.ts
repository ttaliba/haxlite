/**
 * Minimal SCTP association for WebRTC data channels (RFC 9260 / RFC 4960,
 * RFC 3758 PR-SCTP, RFC 6525 stream reset, RFC 8831/8832 data channels,
 * RFC 8261 SCTP over DTLS, RFC 9653 zero checksum), tailored to HaxBall's
 * three pre-negotiated channels.
 *
 * Design notes
 * - One association per DTLS connection. Either side may initiate
 *   ({@link SctpAssociation.connect}); the passive side answers INITs
 *   statelessly with an HMAC-protected state cookie.
 * - Hot paths avoid allocations: outgoing payloads are copied into a FIFO
 *   byte arena, chunk metadata lives in typed-array rings indexed by TSN, and
 *   packets are built in a shared module-level buffer. The Uint8Array handed
 *   to `onMessage` is a view of the input packet (`zeroCopyDelivery`, one
 *   small view object per message), a copy, or — with `transientDelivery` —
 *   a cached view of a per-association scratch buffer valid only during the
 *   callback (no allocation at all for unfragmented messages).
 * - `send` never delays (no Nagle): a message is transmitted at once if the
 *   congestion/receive windows allow. Sends issued while processing an
 *   incoming packet (from `onMessage`) or between {@link cork}/{@link uncork}
 *   are bundled (RFC 9260 §6.10: DATA chunks of any streams, plus the SACK
 *   and control chunks) into as few MTU-sized packets as possible; while
 *   corked even the end-of-input flush (SACK) waits for the outermost uncork.
 * - A single timer per association (injectable `setTimer`/`clearTimer`) is
 *   re-armed lazily: a timer that fires early just re-arms.
 * - `input` never throws on malformed packets (everything is bounds-checked
 *   and a last-resort try/catch counts the error).
 *
 * Packets passed to `opts.send` are views of a shared buffer, valid only
 * during the call (DTLS encrypts them synchronously).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readChecksum, sctpChecksum, writeChecksum } from './crc32c.js';

// ---------------------------------------------------------------------------
// Public types

export interface SctpChannelConfig {
  id: number;
  ordered: boolean;
  /** PR-SCTP limit (0 = never retransmit). Omitted = fully reliable. */
  maxRetransmits?: number;
}

export interface SctpAssociationOptions {
  /** Hands an SCTP packet to DTLS. The buffer is only valid during the call. */
  send(packet: Uint8Array): void;
  /** Pre-negotiated (negotiated: true) data channels. */
  channels: SctpChannelConfig[];
  /** Remote max-message-size (from SDP): larger sends are refused. */
  maxMessageSize: number;
  /**
   * A complete message. The callee may keep `data` unless `transientDelivery`
   * is set (then it is only valid during the call: copy what you retain).
   */
  onMessage(channelId: number, data: Uint8Array, ppid: number): void;
  /** Association established (all pre-negotiated channels are open). */
  onOpen(): void;
  /**
   * Association gone: 'shutdown' (graceful), 'abort' (peer ABORT), 'timeout',
   * 'init-timeout', 'message-too-large'. At most once; never after close()/abort().
   */
  onClose(reason: string): void;
  /** A channel was closed (stream reset by the peer, or our own reset completed). */
  onChannelClose?(channelId: number): void;
  /** A DCEP-opened channel was accepted (only with `acceptDcep`). */
  onChannelOpen?(channelId: number, label: string, protocol: string): void;
  /** Exceptions thrown by callbacks. Default: rethrown asynchronously. */
  onError?(err: unknown): void;
  /** Monotonic clock in ms. Default `performance.now`. */
  now?: () => number;
  /** Timer hooks (deterministic tests, shared wheels). Default setTimeout (unref'd). */
  setTimer?: (cb: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Max SCTP packet size (common header included). Default 1200. */
  mtu?: number;
  localPort?: number;
  remotePort?: number;
  /** Largest message accepted from the peer (our SDP max-message-size). Default 262144. */
  maxReceiveMessageSize?: number;
  /** Receive buffer advertised as a_rwnd. Default 1 MiB. */
  receiveBufferSize?: number;
  /** Max bytes queued (unsent + unacked) before `send` returns false. Default 4 MiB. */
  sendBufferLimit?: number;
  /** Advertise/accept RFC 9653 zero checksum (DTLS already protects integrity). Default true. */
  zeroChecksum?: boolean;
  /** Accept DCEP DATA_CHANNEL_OPEN for unknown stream ids (default: reject by stream reset). */
  acceptDcep?: boolean;
  /**
   * Deliver unfragmented messages as views into the packet given to `input`
   * (default true: per the src/rtc contract input packets are freshly
   * allocated and never reused). Set false if the caller reuses input buffers.
   */
  zeroCopyDelivery?: boolean;
  /**
   * `onMessage` data is only valid during the call (default false): an
   * unfragmented message is copied into a per-association scratch buffer and
   * handed out as a cached view of it, so receiving allocates nothing.
   * Reassembled (fragmented / out-of-order) messages are still owned copies.
   */
  transientDelivery?: boolean;
  /** Delayed-SACK timeout (ms). Default 200. */
  sackDelay?: number;
  rtoInitial?: number;
  rtoMin?: number;
  rtoMax?: number;
  /**
   * Floor of the RTTVAR term (dcsctp's min_rtt_variance): RTO = SRTT +
   * max(4·RTTVAR, this). Keeps the RTO above the peer's delayed-SACK timeout
   * so a lone message is not spuriously retransmitted. Default 220.
   */
  rtoMinVariance?: number;
  /** Association.Max.Retrans / Max.Init.Retransmits. Default 10 / 8. */
  maxRetransmissions?: number;
  maxInitRetransmits?: number;
  /** Initial cwnd in bytes. Default 10 × mtu. */
  initialCwnd?: number;
  /** Receive TSN window (power of two). Default 1024. */
  receiveWindowTsns?: number;
  /** Random uint32 source (tags, initial TSN). Default crypto. */
  randomU32?: () => number;
}

export interface SctpStats {
  state: string;
  packetsSent: number;
  packetsReceived: number;
  bytesSent: number;
  bytesReceived: number;
  messagesSent: number;
  messagesReceived: number;
  dataChunksSent: number;
  dataChunksReceived: number;
  retransmissions: number;
  fastRetransmits: number;
  t3Expirations: number;
  abandonedMessages: number;
  forwardTsnSent: number;
  forwardTsnReceived: number;
  sacksSent: number;
  sacksReceived: number;
  duplicateTsns: number;
  checksumErrors: number;
  malformed: number;
  droppedMessages: number;
  callbackErrors: number;
  internalErrors: number;
  cwnd: number;
  ssthresh: number;
  flightSize: number;
  peerRwnd: number;
  srtt: number;
  rto: number;
  bufferedAmount: number;
  zeroChecksum: boolean;
}

// ---------------------------------------------------------------------------
// Constants

const CT_DATA = 0;
const CT_INIT = 1;
const CT_INIT_ACK = 2;
const CT_SACK = 3;
const CT_HEARTBEAT = 4;
const CT_HEARTBEAT_ACK = 5;
const CT_ABORT = 6;
const CT_SHUTDOWN = 7;
const CT_SHUTDOWN_ACK = 8;
const CT_ERROR = 9;
const CT_COOKIE_ECHO = 10;
const CT_COOKIE_ACK = 11;
const CT_SHUTDOWN_COMPLETE = 14;
const CT_RECONFIG = 130;
const CT_FORWARD_TSN = 192;

const PT_STATE_COOKIE = 7;
const PT_UNRECOGNIZED = 8;
const PT_ZERO_CHECKSUM = 0x8001;
const PT_SUPPORTED_EXT = 0x8008;
const PT_FORWARD_TSN_SUPPORTED = 0xc000;
const PT_OUT_RESET = 13;
const PT_IN_RESET = 14;
const PT_RECONF_RESPONSE = 16;

const RR_NOTHING = 0;
const RR_PERFORMED = 1;
const RR_DENIED = 2;
const RR_BAD_SEQ = 5;
const RR_IN_PROGRESS = 6;

export const PPID_DCEP = 50;
export const PPID_STRING = 51;
export const PPID_BINARY = 53;
export const PPID_STRING_EMPTY = 56;
export const PPID_BINARY_EMPTY = 57;

const S_CLOSED = 0;
const S_COOKIE_WAIT = 1;
const S_COOKIE_ECHOED = 2;
const S_ESTABLISHED = 3;
const S_SHUTDOWN_PENDING = 4;
const S_SHUTDOWN_SENT = 5;
const S_SHUTDOWN_RECEIVED = 6;
const S_SHUTDOWN_ACK_SENT = 7;
const STATE_NAMES = [
  'closed',
  'cookie-wait',
  'cookie-echoed',
  'established',
  'shutdown-pending',
  'shutdown-sent',
  'shutdown-received',
  'shutdown-ack-sent',
];

// DATA chunk flags (also the low bits of tx/rx records)
const F_E = 1;
const F_B = 2;
const F_U = 4;
const F_I = 8;

// tx record flags (Uint16)
const T_ACKED = 8;
const T_ABANDONED = 16;
const T_RETX = 32;
const T_INFLIGHT = 64;
const T_FR_PENDING = 128;
const T_FR_DONE = 256;

// rx held-slot flags
const H_HELD = 8;
const H_PENDING = 16;

// channel flags
const CH_CONFIGURED = 1;
const CH_ORDERED = 2;
const CH_CLOSING = 4; // no more sends (local close or peer reset)
const CH_NOTIFIED = 8; // onChannelClose delivered

const COOKIE_LEN = 72;
const COOKIE_LIFETIME = 60_000;
const OUR_STREAMS = 65535;
const MAX_TX_RECORDS = 1 << 20;
const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------
// Helpers

const lt32 = (a: number, b: number): boolean => ((a - b) | 0) < 0;
const le32 = (a: number, b: number): boolean => ((a - b) | 0) <= 0;
const lt16 = (a: number, b: number): boolean => ((a - b) << 16) >> 16 < 0;
const u16 = (p: Uint8Array, o: number): number => (p[o] << 8) | p[o + 1];
const u32 = (p: Uint8Array, o: number): number => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
function w16(p: Uint8Array, o: number, v: number): void {
  p[o] = v >>> 8;
  p[o + 1] = v;
}
function w32(p: Uint8Array, o: number, v: number): void {
  p[o] = v >>> 24;
  p[o + 1] = v >>> 16;
  p[o + 2] = v >>> 8;
  p[o + 3] = v;
}

const defaultNow = (): number => performance.now();
const defaultSetTimer = (cb: () => void, ms: number): unknown => {
  const t = setTimeout(cb, ms);
  t.unref?.();
  return t;
};
const defaultClearTimer = (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>);
const defaultRandom = (): number => randomBytes(4).readUInt32BE(0);

// Shared packet buffer: packets are built here and handed to DTLS
// synchronously; views per length are cached so sending allocates nothing.
let SHARED = new Uint8Array(1500);
let SHARED_VIEWS: (Uint8Array | undefined)[] = [];
let sharedBusy = false;
function ensureShared(size: number): void {
  if (SHARED.length < size) {
    SHARED = new Uint8Array(size);
    SHARED_VIEWS = [];
  }
}

interface InitInfo {
  tag: number;
  arwnd: number;
  os: number;
  mis: number;
  tsn: number;
  fwdTsn: boolean;
  reconfig: boolean;
  zeroCk: boolean;
  cookieOff: number;
  cookieLen: number;
  /** [offset, length] pairs of params to report as unrecognized. */
  unrecognized: number[] | null;
}

interface ResetRequest {
  seq: number;
  sids: number[];
  lastTsn: number;
}

// ---------------------------------------------------------------------------

export class SctpAssociation {
  // --- config / callbacks
  private readonly sendFn: (packet: Uint8Array) => void;
  private readonly onMessageFn: (channelId: number, data: Uint8Array, ppid: number) => void;
  private readonly onOpenFn: () => void;
  private readonly onCloseFn: (reason: string) => void;
  private readonly onChannelCloseFn: ((id: number) => void) | undefined;
  private readonly onChannelOpenFn: ((id: number, label: string, protocol: string) => void) | undefined;
  private readonly onErrorFn: ((err: unknown) => void) | undefined;
  private readonly nowFn: () => number;
  private readonly setTimerFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (h: unknown) => void;
  private readonly randomFn: () => number;
  private readonly mtu: number;
  private readonly maxFrag: number;
  private readonly localPort: number;
  private readonly remotePort: number;
  private readonly maxMessageSize: number;
  private readonly maxRecvMessage: number;
  private readonly rxBufferSize: number;
  private readonly sendBufferLimit: number;
  private readonly zeroCkEnabled: boolean;
  private readonly acceptDcep: boolean;
  private readonly zeroCopy: boolean;
  private readonly transient: boolean;
  /** transientDelivery scratch (lazily allocated) and its cached views by length. */
  private scratch: Uint8Array | null = null;
  private scratchViews: (Uint8Array | undefined)[] | null = null;
  private scratchBusy = false;
  private readonly sackDelay: number;
  private readonly rtoInitial: number;
  private readonly rtoMin: number;
  private readonly rtoMax: number;
  private readonly rtoMinVar: number;
  private readonly maxRetrans: number;
  private readonly maxInitRetrans: number;
  private readonly initialCwnd: number;
  private readonly rxCap: number;
  private readonly rxMask: number;
  private readonly cookieKey: Buffer;
  private readonly onTimerBound: () => void;

  // --- association state
  private state = S_CLOSED;
  private dead = false;
  private localTag = 0;
  private peerTag = 0;
  private localInitTsn = 0;
  private outStreams = 0;
  private inStreams = 0;
  private peerFwdTsn = false;
  private peerReconfig = false;
  private zcSend = false;
  private initRetries = 0;
  private cookie: Uint8Array | null = null;
  private errors = 0;

  // --- channels (indexed by stream id)
  private chFlags = new Uint8Array(4);
  private chMaxRtx = new Int32Array(4);

  // --- timers (absolute deadlines in ms, 0 = off)
  private t1At = 0;
  private t2At = 0;
  private t3At = 0;
  private sackAt = 0;
  private reconfAt = 0;
  private timerHandle: unknown = null;
  private timerAt = 0;
  private t = 0; // cached "now"

  // --- receive side
  private rCum = 0;
  private rHighest = 0;
  private rBits: Uint8Array | null = null;
  private hFlags: Uint8Array | null = null;
  private hTsn: Uint32Array | null = null;
  private hSid: Uint16Array | null = null;
  private hSsn: Uint16Array | null = null;
  private hPpid: Uint32Array | null = null;
  private hData: (Uint8Array | null)[] = [];
  private heldBytes = 0;
  private rNextSsn = new Uint16Array(4);
  private rPending: (Map<number, number> | null)[] = [];
  private dups = new Uint32Array(16);
  private dupN = 0;
  private sackOwed = false;
  private sackNow = false;
  private pktsSinceSack = 0;
  private pktHadData = false;
  private lastFwdAt = -1e12;
  private orphanScan = false;
  private cumAtInput = 0;

  // --- send side
  private tCap = 0;
  private tMask = 0;
  private txOff = new Int32Array(0);
  private txLen = new Int32Array(0);
  private txSid = new Uint16Array(0);
  private txSsn = new Uint16Array(0);
  private txPpid = new Uint32Array(0);
  private txFlags = new Uint16Array(0);
  private txCount = new Uint8Array(0);
  private txMiss = new Uint8Array(0);
  private txMaxRtx = new Int32Array(0);
  private txSentAt = new Float64Array(0);
  private tAcked = 0; // peer's cumulative ack
  private tNext = 0; // next TSN to assign
  private tSendNext = 0; // next never-sent TSN
  private advPeerAck = 0;
  private flight = 0;
  private retxCount = 0;
  private frCount = 0;
  private buffered = 0;
  private arena = new Uint8Array(0);
  private aHead = 0;
  private aTail = 0;
  private tOutSsn = new Uint16Array(4);
  private cwnd = 0;
  private ssthresh = 0;
  private pba = 0;
  private peerRwnd = 0;
  private inFastRecovery = false;
  private frExit = 0;
  private srtt = 0;
  private rttvar = 0;
  private rto = 0;

  // --- control chunks pending
  private cookieAckPending = false;
  private fwdTsnPending = false;
  private shutdownPending = false;
  private shutdownAckPending = false;
  private hbAck: Uint8Array | null = null;
  private errorCause: Uint8Array | null = null;

  // --- stream reset (RFC 6525)
  private reqSeq = 0;
  private peerReqExpected = 0;
  private lastPeerReqResult = RR_NOTHING;
  private reconfResp: number[] | null = null; // [seq, result] pairs to send
  private resetQueue: number[] = [];
  private reqInFlight: ResetRequest | null = null;
  private reqNeedsSend = false;
  private deferredReset: ResetRequest | null = null;

  // --- packet building
  private pb: Uint8Array = SHARED;
  private pp = 0;
  private pvtag = 0;
  private usingShared = false;
  private privateBuf: Uint8Array | null = null;

  // --- re-entrancy
  private inInput = false;
  private flushing = false;
  private flushNeeded = false;
  private corked = 0;
  private deferredInput: Uint8Array[] | null = null;

  // --- stats
  private readonly c = {
    packetsSent: 0,
    packetsReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    dataChunksSent: 0,
    dataChunksReceived: 0,
    retransmissions: 0,
    fastRetransmits: 0,
    t3Expirations: 0,
    abandonedMessages: 0,
    forwardTsnSent: 0,
    forwardTsnReceived: 0,
    sacksSent: 0,
    sacksReceived: 0,
    duplicateTsns: 0,
    checksumErrors: 0,
    malformed: 0,
    droppedMessages: 0,
    callbackErrors: 0,
    internalErrors: 0,
  };

  constructor(opts: SctpAssociationOptions) {
    this.sendFn = opts.send;
    this.onMessageFn = opts.onMessage;
    this.onOpenFn = opts.onOpen;
    this.onCloseFn = opts.onClose;
    this.onChannelCloseFn = opts.onChannelClose;
    this.onChannelOpenFn = opts.onChannelOpen;
    this.onErrorFn = opts.onError;
    this.nowFn = opts.now ?? defaultNow;
    this.setTimerFn = opts.setTimer ?? defaultSetTimer;
    this.clearTimerFn = opts.clearTimer ?? defaultClearTimer;
    this.randomFn = opts.randomU32 ?? defaultRandom;
    this.mtu = Math.max(512, Math.min(65535, Math.floor(opts.mtu ?? 1200)));
    this.maxFrag = this.mtu - 28;
    this.localPort = opts.localPort ?? 5000;
    this.remotePort = opts.remotePort ?? 5000;
    this.maxMessageSize = opts.maxMessageSize > 0 ? opts.maxMessageSize : 65536;
    this.maxRecvMessage = opts.maxReceiveMessageSize ?? 262144;
    this.rxBufferSize = opts.receiveBufferSize ?? 1 << 20;
    this.sendBufferLimit = opts.sendBufferLimit ?? 4 << 20;
    this.zeroCkEnabled = opts.zeroChecksum ?? true;
    this.acceptDcep = opts.acceptDcep ?? false;
    this.zeroCopy = opts.zeroCopyDelivery ?? true;
    this.transient = opts.transientDelivery ?? false;
    this.sackDelay = opts.sackDelay ?? 200;
    this.rtoInitial = opts.rtoInitial ?? 500;
    this.rtoMin = opts.rtoMin ?? 200;
    this.rtoMax = opts.rtoMax ?? 6000;
    this.rtoMinVar = opts.rtoMinVariance ?? 220;
    this.maxRetrans = opts.maxRetransmissions ?? 10;
    this.maxInitRetrans = opts.maxInitRetransmits ?? 8;
    this.initialCwnd = opts.initialCwnd ?? 10 * this.mtu;
    let cap = 64;
    while (cap < (opts.receiveWindowTsns ?? 1024) && cap < 1 << 16) cap <<= 1;
    this.rxCap = cap;
    this.rxMask = cap - 1;
    this.cookieKey = randomBytes(32);
    this.rto = this.rtoInitial;
    this.onTimerBound = () => this.onTimer();
    ensureShared(this.mtu);
    for (const ch of opts.channels) {
      if (!Number.isInteger(ch.id) || ch.id < 0 || ch.id > 65534) throw new RangeError(`bad channel id ${ch.id}`);
      this.configureChannel(ch.id, ch.ordered, ch.maxRetransmits);
    }
  }

  // =========================================================================
  // Public API

  /** Starts the association as initiator (sends INIT). */
  connect(): void {
    if (this.dead || this.state !== S_CLOSED) return;
    this.t = this.nowFn();
    this.localTag = this.randomTag();
    this.localInitTsn = this.randomFn() >>> 0;
    this.initTx(this.localInitTsn);
    this.state = S_COOKIE_WAIT;
    this.initRetries = 0;
    this.sendInit();
    this.t1At = this.t + this.rto;
    this.schedule();
  }

  /** Feeds a packet received from DTLS. Never throws on malformed input. */
  input(packet: Uint8Array): void {
    if (this.dead) return;
    if (this.inInput || this.flushing) {
      (this.deferredInput ??= []).push(packet.slice());
      return;
    }
    this.inInput = true;
    try {
      this.t = this.nowFn();
      this.cumAtInput = this.rCum;
      this.processPacket(packet);
    } catch (e) {
      // Only reachable through a bug: malformed input is rejected by bounds checks.
      this.c.internalErrors++;
      if (this.onErrorFn) this.reportError(e);
    } finally {
      this.inInput = false;
    }
    if (!this.dead) {
      this.afterInput();
      this.drainDeferred();
    }
  }

  /**
   * Sends a message (binary by default). Returns false when the association
   * is not open, the channel is closed/unknown, the message exceeds the
   * remote max-message-size, or the send buffer is full.
   */
  send(channelId: number, data: Uint8Array, ppid: number = PPID_BINARY): boolean {
    if (this.state !== S_ESTABLISHED || channelId >= this.chFlags.length || channelId < 0) return false;
    const cf = this.chFlags[channelId];
    if ((cf & (CH_CONFIGURED | CH_CLOSING)) !== CH_CONFIGURED || channelId >= this.outStreams) return false;
    return this.enqueue(channelId, data, ppid, (cf & CH_ORDERED) !== 0, this.chMaxRtx[channelId]);
  }

  /**
   * Bundles subsequent sends (and the SACK / control chunks owed after
   * incoming packets) until the matching {@link uncork}; nestable. No timer
   * is involved: the caller must uncork (e.g. at the end of the event-loop
   * iteration). Retransmission timers keep firing and sending while corked.
   */
  cork(): void {
    this.corked++;
  }

  /** Ends one {@link cork}; the outermost one sends everything pending. */
  uncork(): void {
    if (this.corked > 0 && --this.corked === 0 && this.flushNeeded && !this.inInput && !this.dead) {
      this.t = this.nowFn();
      this.flush();
    }
  }

  /** Closes one channel: resets our outgoing stream (RFC 8831 §6.7). */
  closeChannel(channelId: number): void {
    if (channelId < 0 || channelId >= this.chFlags.length) return;
    const cf = this.chFlags[channelId];
    if (!(cf & CH_CONFIGURED) || cf & CH_CLOSING) return;
    this.chFlags[channelId] = cf | CH_CLOSING;
    if (this.state !== S_ESTABLISHED || !this.peerReconfig) {
      this.notifyChannelClose(channelId);
      return;
    }
    this.t = this.nowFn();
    this.resetQueue.push(channelId);
    this.maybeSendReset();
    this.requestFlush();
  }

  /**
   * Best-effort immediate teardown (sends ABORT if an association exists).
   * Idempotent; `onClose` is not called.
   */
  close(): void {
    this.abort();
  }

  /**
   * Graceful SHUTDOWN once all queued data is acknowledged; `onClose('shutdown')`
   * when the sequence completes (or `'timeout'`).
   */
  shutdown(): void {
    if (this.dead) return;
    this.t = this.nowFn();
    switch (this.state) {
      case S_CLOSED:
      case S_COOKIE_WAIT:
      case S_COOKIE_ECHOED:
        this.abort();
        return;
      case S_ESTABLISHED:
        this.state = S_SHUTDOWN_PENDING;
        this.checkShutdown();
        this.requestFlush();
        return;
      default:
        return;
    }
  }

  /** Sends ABORT (with a User-Initiated Abort cause) and tears down without calling `onClose`. */
  abort(reason = 'closed'): void {
    if (this.dead) return;
    this.sendAbort(reason);
    this.terminate(reason, false);
  }

  /** Protocol failure: ABORT + `onClose(reason)`. */
  private fail(reason: string): void {
    if (this.dead) return;
    this.sendAbort(reason);
    this.terminate(reason, true);
  }

  private sendAbort(reason: string): void {
    if (this.state !== S_CLOSED && this.peerTag !== 0) {
      const b = this.beginStandalone(this.peerTag);
      let p = 12;
      // ABORT with a User-Initiated Abort cause (12) carrying the reason.
      const text = Buffer.from(reason.slice(0, 64), 'utf8');
      const causeLen = 4 + text.length;
      b[p] = CT_ABORT;
      b[p + 1] = 0;
      w16(b, p + 2, 4 + causeLen);
      w16(b, p + 4, 12);
      w16(b, p + 6, causeLen);
      b.set(text, p + 8);
      p += 4 + ((causeLen + 3) & ~3);
      this.sendStandalone(b, p);
    }
  }

  get readyState(): string {
    return this.dead ? 'closed' : STATE_NAMES[this.state];
  }

  /** Bytes queued for sending or awaiting acknowledgement. */
  get bufferedAmount(): number {
    return this.buffered;
  }

  stats(): SctpStats {
    return {
      state: this.readyState,
      ...this.c,
      cwnd: this.cwnd,
      ssthresh: this.ssthresh,
      flightSize: this.flight,
      peerRwnd: this.peerRwnd,
      srtt: this.srtt,
      rto: this.rto,
      bufferedAmount: this.buffered,
      zeroChecksum: this.zcSend,
    };
  }

  // =========================================================================
  // Channels

  private configureChannel(id: number, ordered: boolean, maxRtx: number | undefined): void {
    this.growChannels(id);
    this.chFlags[id] = CH_CONFIGURED | (ordered ? CH_ORDERED : 0);
    this.chMaxRtx[id] = maxRtx === undefined || maxRtx < 0 ? -1 : Math.min(maxRtx, 255);
  }

  private growChannels(id: number): void {
    if (id < this.chFlags.length) return;
    let n = this.chFlags.length;
    while (n <= id) n <<= 1;
    const f = new Uint8Array(n);
    f.set(this.chFlags);
    this.chFlags = f;
    const m = new Int32Array(n);
    m.set(this.chMaxRtx);
    this.chMaxRtx = m;
    const s = new Uint16Array(n);
    s.set(this.tOutSsn);
    this.tOutSsn = s;
  }

  private notifyChannelClose(id: number): void {
    if (id >= this.chFlags.length) return;
    const cf = this.chFlags[id];
    if (!(cf & CH_CONFIGURED) || cf & CH_NOTIFIED) return;
    this.chFlags[id] = cf | CH_NOTIFIED | CH_CLOSING;
    if (this.onChannelCloseFn) {
      try {
        this.onChannelCloseFn(id);
      } catch (e) {
        this.reportError(e);
      }
    }
  }

  // =========================================================================
  // Outgoing data

  private enqueue(sid: number, data: Uint8Array, ppid: number, ordered: boolean, maxRtx: number): boolean {
    let len = data.length;
    if (len > this.maxMessageSize) return false;
    let payload = data;
    if (len === 0) {
      ppid = ppid === PPID_STRING ? PPID_STRING_EMPTY : PPID_BINARY_EMPTY;
      payload = ZERO1;
      len = 1;
    }
    if (this.buffered + len > this.sendBufferLimit) return false;
    const nfrag = len <= this.maxFrag ? 1 : Math.ceil(len / this.maxFrag);
    const outstanding = (this.tNext - this.tAcked - 1) >>> 0;
    if (outstanding + nfrag > MAX_TX_RECORDS) return false;
    if (outstanding + nfrag > this.tCap) this.growTx(outstanding + nfrag);
    const off = this.arenaAlloc(len);
    this.arena.set(payload, off);
    const ssn = ordered ? this.tOutSsn[sid] : 0;
    if (ordered) this.tOutSsn[sid] = ssn + 1;
    const base = ordered ? 0 : F_U;
    const mask = this.tMask;
    let o = 0;
    for (let k = 0; k < nfrag; k++) {
      const flen = Math.min(this.maxFrag, len - o);
      const i = this.tNext & mask;
      this.txOff[i] = off + o;
      this.txLen[i] = flen;
      this.txSid[i] = sid;
      this.txSsn[i] = ssn;
      this.txPpid[i] = ppid;
      this.txFlags[i] = base | (k === 0 ? F_B : 0) | (k === nfrag - 1 ? F_E : 0);
      this.txCount[i] = 0;
      this.txMiss[i] = 0;
      this.txMaxRtx[i] = this.peerFwdTsn ? maxRtx : -1;
      this.tNext = (this.tNext + 1) >>> 0;
      o += flen;
    }
    this.buffered += len;
    this.c.messagesSent++;
    this.requestFlush();
    return true;
  }

  private requestFlush(): void {
    if (this.inInput || this.corked > 0) {
      this.flushNeeded = true;
      return;
    }
    if (this.flushing) {
      this.flushNeeded = true;
      return;
    }
    this.t = this.nowFn();
    this.flush();
  }

  private growTx(need: number): void {
    let cap = this.tCap === 0 ? 256 : this.tCap;
    while (cap < need) cap <<= 1;
    if (cap === this.tCap) return;
    const oldMask = this.tMask;
    const nOff = new Int32Array(cap);
    const nLen = new Int32Array(cap);
    const nSid = new Uint16Array(cap);
    const nSsn = new Uint16Array(cap);
    const nPpid = new Uint32Array(cap);
    const nFlags = new Uint16Array(cap);
    const nCount = new Uint8Array(cap);
    const nMiss = new Uint8Array(cap);
    const nMax = new Int32Array(cap);
    const nSent = new Float64Array(cap);
    const mask = cap - 1;
    if (this.tCap > 0) {
      for (let t = (this.tAcked + 1) >>> 0; t !== this.tNext; t = (t + 1) >>> 0) {
        const a = t & oldMask;
        const b = t & mask;
        nOff[b] = this.txOff[a];
        nLen[b] = this.txLen[a];
        nSid[b] = this.txSid[a];
        nSsn[b] = this.txSsn[a];
        nPpid[b] = this.txPpid[a];
        nFlags[b] = this.txFlags[a];
        nCount[b] = this.txCount[a];
        nMiss[b] = this.txMiss[a];
        nMax[b] = this.txMaxRtx[a];
        nSent[b] = this.txSentAt[a];
      }
    }
    this.txOff = nOff;
    this.txLen = nLen;
    this.txSid = nSid;
    this.txSsn = nSsn;
    this.txPpid = nPpid;
    this.txFlags = nFlags;
    this.txCount = nCount;
    this.txMiss = nMiss;
    this.txMaxRtx = nMax;
    this.txSentAt = nSent;
    this.tCap = cap;
    this.tMask = mask;
  }

  /** FIFO byte arena: returns a contiguous offset for `n` bytes. */
  private arenaAlloc(n: number): number {
    const empty = this.tNext === ((this.tAcked + 1) >>> 0);
    const size = this.arena.length;
    if (empty) {
      if (n > size) this.growArena(n);
      this.aTail = 0;
      this.aHead = n;
      return 0;
    }
    this.aTail = this.txOff[((this.tAcked + 1) >>> 0) & this.tMask];
    const h = this.aHead;
    const tl = this.aTail;
    if (h > tl) {
      if (size - h >= n) {
        this.aHead = h + n;
        return h;
      }
      if (n <= tl) {
        this.aHead = n;
        return 0;
      }
    } else if (h < tl) {
      if (tl - h >= n) {
        this.aHead = h + n;
        return h;
      }
    }
    this.growArena(n);
    const o = this.aHead;
    this.aHead = o + n;
    return o;
  }

  /** Re-lays every live record contiguously into a bigger arena. */
  private growArena(n: number): void {
    let size = Math.max(4096, this.arena.length * 2);
    while (size < this.buffered + n + 1) size *= 2;
    const na = new Uint8Array(size);
    let o = 0;
    for (let t = (this.tAcked + 1) >>> 0; t !== this.tNext; t = (t + 1) >>> 0) {
      const i = t & this.tMask;
      const off = this.txOff[i];
      const len = this.txLen[i];
      na.set(this.arena.subarray(off, off + len), o);
      this.txOff[i] = o;
      o += len;
    }
    this.arena = na;
    this.aTail = 0;
    this.aHead = o;
  }

  // =========================================================================
  // Packet building

  private beginPacket(): void {
    if (!this.usingShared && !sharedBusy) {
      sharedBusy = true;
      this.usingShared = true;
      this.pb = SHARED;
    } else if (!this.usingShared) {
      this.pb = this.privateBuf ??= new Uint8Array(this.mtu);
    }
    this.pp = 12;
    this.pvtag = this.peerTag;
  }

  private releasePacketBuffer(): void {
    if (this.usingShared) {
      this.usingShared = false;
      sharedBusy = false;
    }
  }

  private endPacket(forceCrc: boolean): void {
    const len = this.pp;
    if (len <= 12) return;
    const b = this.pb;
    w16(b, 0, this.localPort);
    w16(b, 2, this.remotePort);
    w32(b, 4, this.pvtag);
    if (this.zcSend && !forceCrc) {
      b[8] = 0;
      b[9] = 0;
      b[10] = 0;
      b[11] = 0;
    } else {
      writeChecksum(b, len);
    }
    this.pp = 12;
    let view: Uint8Array;
    if (b === SHARED) view = SHARED_VIEWS[len] ??= SHARED.subarray(0, len);
    else view = b.subarray(0, len);
    this.c.packetsSent++;
    this.c.bytesSent += len;
    try {
      this.sendFn(view);
    } catch (e) {
      this.reportError(e);
    }
  }

  /** Standalone control packet (INIT, INIT-ACK, ABORT, ...) in a fresh buffer. */
  private beginStandalone(vtag: number): Uint8Array {
    const b = new Uint8Array(this.mtu);
    w32(b, 4, vtag);
    return b;
  }

  private sendStandalone(b: Uint8Array, len: number): void {
    w16(b, 0, this.localPort);
    w16(b, 2, this.remotePort);
    writeChecksum(b, len);
    this.c.packetsSent++;
    this.c.bytesSent += len;
    try {
      this.sendFn(b.subarray(0, len));
    } catch (e) {
      this.reportError(e);
    }
  }

  private room(n: number): void {
    if (this.pp + n > this.mtu && this.pp > 12) {
      this.endPacket(false);
      this.pp = 12;
    }
  }

  /** Builds and sends everything that is pending. */
  private flush(): void {
    if (this.dead) return;
    if (this.flushing) {
      this.flushNeeded = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushNeeded = false;
        this.flushOnce();
      } while (this.flushNeeded && !this.dead);
    } finally {
      this.releasePacketBuffer();
      this.flushing = false;
    }
    if (!this.dead) {
      if (this.deferredInput !== null && !this.inInput) this.drainDeferred();
      this.schedule();
    }
  }

  private flushOnce(): void {
    const st = this.state;
    if (st < S_ESTABLISHED && !this.cookieAckPending) return;
    const canData = st === S_ESTABLISHED || st === S_SHUTDOWN_PENDING || st === S_SHUTDOWN_RECEIVED;
    const dataReady =
      canData &&
      (this.retxCount > 0 ||
        (this.tSendNext !== this.tNext && (this.flight === 0 || (this.flight < this.cwnd && this.peerRwnd > this.flight))));
    const ctrl =
      this.cookieAckPending ||
      (this.fwdTsnPending && this.peerFwdTsn) ||
      this.reqNeedsSend ||
      this.reconfResp !== null ||
      this.hbAck !== null ||
      this.errorCause !== null ||
      this.shutdownPending ||
      this.shutdownAckPending;
    const sack = this.sackNow || (this.sackOwed && (dataReady || ctrl));
    if (!sack && !ctrl && !dataReady) return;
    this.beginPacket();
    if (this.cookieAckPending) {
      this.cookieAckPending = false;
      const b = this.pb;
      const p = this.pp;
      b[p] = CT_COOKIE_ACK;
      b[p + 1] = 0;
      w16(b, p + 2, 4);
      this.pp = p + 4;
    }
    if (sack) this.writeSack();
    if (this.fwdTsnPending) {
      this.fwdTsnPending = false;
      if (this.peerFwdTsn && lt32(this.tAcked, this.advPeerAck)) this.writeForwardTsn();
    }
    if (this.reconfResp !== null || this.reqNeedsSend) this.writeReconfig();
    if (this.hbAck !== null) {
      const v = this.hbAck;
      this.hbAck = null;
      const n = 4 + v.length;
      this.room((n + 3) & ~3);
      if (this.pp + n <= this.mtu) {
        const b = this.pb;
        const p = this.pp;
        b[p] = CT_HEARTBEAT_ACK;
        b[p + 1] = 0;
        w16(b, p + 2, n);
        b.set(v, p + 4);
        this.pad(p + n);
      }
    }
    if (this.errorCause !== null) {
      const v = this.errorCause;
      this.errorCause = null;
      const n = 4 + v.length;
      this.room((n + 3) & ~3);
      if (this.pp + n <= this.mtu) {
        const b = this.pb;
        const p = this.pp;
        b[p] = CT_ERROR;
        b[p + 1] = 0;
        w16(b, p + 2, n);
        b.set(v, p + 4);
        this.pad(p + n);
      }
    }
    if (this.shutdownPending) {
      this.shutdownPending = false;
      this.room(8);
      const b = this.pb;
      const p = this.pp;
      b[p] = CT_SHUTDOWN;
      b[p + 1] = 0;
      w16(b, p + 2, 8);
      w32(b, p + 4, this.rCum);
      this.pp = p + 8;
    }
    if (this.shutdownAckPending) {
      this.shutdownAckPending = false;
      this.room(4);
      const b = this.pb;
      const p = this.pp;
      b[p] = CT_SHUTDOWN_ACK;
      b[p + 1] = 0;
      w16(b, p + 2, 4);
      this.pp = p + 4;
    }
    if (canData) {
      if (this.retxCount > 0) this.sendRetransmissions();
      this.sendNewData();
    }
    this.endPacket(false);
  }

  private pad(end: number): void {
    const b = this.pb;
    let p = end;
    while (p & 3) b[p++] = 0;
    this.pp = p;
  }

  private writeSack(): void {
    const b = this.pb;
    this.room(16);
    const p = this.pp;
    const maxEntries = (this.mtu - p - 16) >> 2;
    let nGap = 0;
    if (this.rBits !== null && this.rHighest !== this.rCum) {
      const bits = this.rBits;
      const mask = this.rxMask;
      let q = p + 16;
      let t = (this.rCum + 1) >>> 0;
      const end = (this.rHighest + 1) >>> 0;
      while (t !== end && nGap < maxEntries) {
        while (t !== end && !bits[t & mask]) t = (t + 1) >>> 0;
        if (t === end) break;
        const s = t;
        while (t !== end && bits[t & mask]) t = (t + 1) >>> 0;
        const so = (s - this.rCum) >>> 0;
        const eo = (t - 1 - this.rCum) >>> 0;
        if (eo > 0xffff) break;
        w16(b, q, so);
        w16(b, q + 2, eo);
        q += 4;
        nGap++;
      }
    }
    let nDup = Math.min(this.dupN, maxEntries - nGap);
    if (nDup < 0) nDup = 0;
    let q = p + 16 + nGap * 4;
    for (let k = 0; k < nDup; k++) {
      w32(b, q, this.dups[k]);
      q += 4;
    }
    this.dupN = 0;
    b[p] = CT_SACK;
    b[p + 1] = 0;
    w16(b, p + 2, q - p);
    w32(b, p + 4, this.rCum);
    w32(b, p + 8, Math.max(0, this.rxBufferSize - this.heldBytes));
    w16(b, p + 12, nGap);
    w16(b, p + 14, nDup);
    this.pp = q;
    this.sackOwed = false;
    this.sackNow = false;
    this.sackAt = 0;
    this.pktsSinceSack = 0;
    this.c.sacksSent++;
  }

  private writeForwardTsn(): void {
    // Entries: (sid, largest abandoned SSN) for ordered streams with abandoned messages.
    let entries = 0;
    for (let t = (this.tAcked + 1) >>> 0; t !== ((this.advPeerAck + 1) >>> 0); t = (t + 1) >>> 0) {
      const i = t & this.tMask;
      const f = this.txFlags[i];
      if (f & T_ABANDONED && !(f & F_U) && f & F_B) entries++;
    }
    const maxLen = 8 + entries * 4;
    this.room(Math.min(maxLen, this.mtu - 12));
    const b = this.pb;
    const p = this.pp;
    let q = p + 8;
    const limit = this.mtu - 4;
    for (let t = (this.tAcked + 1) >>> 0; t !== ((this.advPeerAck + 1) >>> 0); t = (t + 1) >>> 0) {
      const i = t & this.tMask;
      const f = this.txFlags[i];
      if (!(f & T_ABANDONED) || f & F_U || !(f & F_B)) continue;
      const sid = this.txSid[i];
      const ssn = this.txSsn[i];
      let k = p + 8;
      for (; k < q; k += 4) if (u16(b, k) === sid) break;
      if (k < q) {
        if (lt16(u16(b, k + 2), ssn)) w16(b, k + 2, ssn);
      } else if (q <= limit) {
        w16(b, q, sid);
        w16(b, q + 2, ssn);
        q += 4;
      }
    }
    b[p] = CT_FORWARD_TSN;
    b[p + 1] = 0;
    w16(b, p + 2, q - p);
    w32(b, p + 4, this.advPeerAck);
    this.pp = q;
    this.c.forwardTsnSent++;
  }

  private writeReconfig(): void {
    let req = this.reqNeedsSend ? this.reqInFlight : null;
    const resp = this.reconfResp ?? EMPTY_LIST;
    this.reqNeedsSend = false;
    this.reconfResp = null;
    // One RE-CONFIG chunk per response; the request rides with the first.
    for (let k = 0; k < resp.length || (k === 0 && req !== null); k += 2) {
      this.writeReconfigChunk(k < resp.length ? resp[k] : -1, k < resp.length ? resp[k + 1] : 0, req);
      req = null;
    }
  }

  private writeReconfigChunk(respSeq: number, result: number, req: ResetRequest | null): void {
    let n = 4;
    if (respSeq >= 0) n += 12;
    if (req !== null) n += 16 + 2 * req.sids.length + ((req.sids.length & 1) << 1);
    this.room(n);
    if (this.pp + n > this.mtu) return;
    const b = this.pb;
    const p = this.pp;
    let q = p + 4;
    if (respSeq >= 0) {
      w16(b, q, PT_RECONF_RESPONSE);
      w16(b, q + 2, 12);
      w32(b, q + 4, respSeq);
      w32(b, q + 8, result);
      q += 12;
    }
    if (req !== null) {
      const plen = 16 + 2 * req.sids.length;
      w16(b, q, PT_OUT_RESET);
      w16(b, q + 2, plen);
      w32(b, q + 4, req.seq);
      w32(b, q + 8, (this.peerReqExpected - 1) >>> 0);
      w32(b, q + 12, req.lastTsn);
      let r = q + 16;
      for (const sid of req.sids) {
        w16(b, r, sid);
        r += 2;
      }
      if (r & 3) {
        b[r++] = 0;
        b[r++] = 0;
      }
      q = r;
    }
    b[p] = CT_RECONFIG;
    b[p + 1] = 0;
    w16(b, p + 2, q - p);
    this.pp = q;
  }

  private writeData(i: number, tsn: number): void {
    const len = this.txLen[i];
    const n = 16 + len;
    if (this.pp + n > this.mtu) {
      this.endPacket(false);
      this.pp = 12;
    }
    const b = this.pb;
    const p = this.pp;
    b[p] = CT_DATA;
    b[p + 1] = this.txFlags[i] & 7;
    w16(b, p + 2, n);
    w32(b, p + 4, tsn);
    w16(b, p + 8, this.txSid[i]);
    w16(b, p + 10, this.txSsn[i]);
    w32(b, p + 12, this.txPpid[i]);
    const off = this.txOff[i];
    const a = this.arena;
    if (len <= 64) {
      for (let k = 0; k < len; k++) b[p + 16 + k] = a[off + k];
    } else {
      b.set(a.subarray(off, off + len), p + 16);
    }
    let e = p + n;
    while (e & 3) b[e++] = 0;
    this.pp = e;
    this.c.dataChunksSent++;
  }

  private sendRetransmissions(): void {
    const mask = this.tMask;
    for (let t = (this.tAcked + 1) >>> 0; t !== this.tSendNext && this.retxCount > 0; t = (t + 1) >>> 0) {
      const i = t & mask;
      const f = this.txFlags[i];
      if (!(f & T_RETX)) continue;
      const fast = (f & T_FR_PENDING) !== 0;
      if (!fast && this.flight > 0 && this.flight >= this.cwnd) {
        if (this.frCount === 0) break;
        continue;
      }
      this.writeData(i, t);
      this.txFlags[i] = (f & ~(T_RETX | T_FR_PENDING)) | T_INFLIGHT | (fast ? T_FR_DONE : 0);
      if (fast) this.frCount--;
      this.retxCount--;
      if (this.txCount[i] < 255) this.txCount[i]++;
      this.txSentAt[i] = this.t;
      this.txMiss[i] = 0;
      this.flight += this.txLen[i];
      this.c.retransmissions++;
      if (fast) this.c.fastRetransmits++;
      if (t === ((this.tAcked + 1) >>> 0) || this.t3At === 0) this.t3At = this.t + this.rto;
    }
  }

  private sendNewData(): void {
    const mask = this.tMask;
    let sent = false;
    while (this.tSendNext !== this.tNext) {
      const t = this.tSendNext;
      const i = t & mask;
      const f = this.txFlags[i];
      if (f & T_ABANDONED) {
        this.tSendNext = (t + 1) >>> 0;
        continue;
      }
      const len = this.txLen[i];
      if (this.flight > 0 && (this.flight >= this.cwnd || this.peerRwnd < this.flight + len)) break;
      this.writeData(i, t);
      this.txFlags[i] = f | T_INFLIGHT;
      this.txCount[i] = 1;
      this.txSentAt[i] = this.t;
      this.flight += len;
      this.tSendNext = (t + 1) >>> 0;
      sent = true;
    }
    if (sent && this.t3At === 0) this.t3At = this.t + this.rto;
  }

  // =========================================================================
  // Incoming packets

  private processPacket(p: Uint8Array): void {
    const len = p.length;
    if (len < 16) {
      this.c.malformed++;
      return;
    }
    const stored = readChecksum(p);
    if (!(stored === 0 && this.zeroCkEnabled && p[12] !== CT_INIT) && stored !== sctpChecksum(p, len)) {
      this.c.checksumErrors++;
      return;
    }
    this.c.packetsReceived++;
    this.c.bytesReceived += len;
    const vtag = u32(p, 4);
    const first = p[12];
    if (first === CT_INIT) {
      const clen = u16(p, 14);
      // INIT must be alone in its packet and carry vtag 0.
      if (vtag !== 0 || clen < 20 || 12 + clen > len || 12 + ((clen + 3) & ~3) + 4 <= len) {
        this.c.malformed++;
        return;
      }
      this.handleInit(p, 12, clen);
      return;
    }
    this.pktHadData = false;
    let off = 12;
    while (off + 4 <= len && !this.dead) {
      const type = p[off];
      const flags = p[off + 1];
      const clen = u16(p, off + 2);
      if (clen < 4 || off + clen > len) {
        this.c.malformed++;
        break;
      }
      const ok = this.state !== S_CLOSED && vtag === this.localTag;
      switch (type) {
        case CT_DATA:
          if (ok) this.handleData(p, off, clen, flags);
          break;
        case CT_SACK:
          if (ok) this.handleSack(p, off, clen);
          break;
        case CT_COOKIE_ECHO:
          this.handleCookieEcho(p, off, clen, vtag);
          break;
        case CT_HEARTBEAT:
          if (ok && clen >= 8) this.hbAck = p.slice(off + 4, off + clen);
          break;
        case CT_FORWARD_TSN:
          if (ok) this.handleForwardTsn(p, off, clen);
          break;
        case CT_RECONFIG:
          if (ok) this.handleReconfig(p, off, clen);
          break;
        case CT_INIT_ACK:
          if (ok && off === 12) this.handleInitAck(p, off, clen);
          break;
        case CT_COOKIE_ACK:
          if (ok && this.state === S_COOKIE_ECHOED) this.established();
          break;
        case CT_ABORT: {
          const tOk = flags & 1 ? vtag === this.peerTag && this.peerTag !== 0 : ok;
          if (tOk) this.terminate('abort', true);
          return;
        }
        case CT_SHUTDOWN:
          if (ok && clen >= 8) this.handleShutdown(u32(p, off + 4));
          break;
        case CT_SHUTDOWN_ACK:
          if (ok && (this.state === S_SHUTDOWN_SENT || this.state === S_SHUTDOWN_ACK_SENT)) {
            this.sendShutdownComplete();
            this.terminate('shutdown', true);
            return;
          }
          break;
        case CT_SHUTDOWN_COMPLETE: {
          const tOk = flags & 1 ? vtag === this.peerTag : ok;
          if (tOk && this.state === S_SHUTDOWN_ACK_SENT) this.terminate('shutdown', true);
          return;
        }
        case CT_HEARTBEAT_ACK:
        case CT_ERROR:
          break;
        case CT_INIT:
          // INIT bundled with other chunks: discard the packet.
          this.c.malformed++;
          return;
        default: {
          const action = type >>> 6;
          if (action === 0 || action === 1) {
            if (action === 1 && ok) this.queueUnrecognizedChunk(p, off, clen);
            return;
          }
          if (action === 3 && ok) this.queueUnrecognizedChunk(p, off, clen);
          break;
        }
      }
      off += (clen + 3) & ~3;
    }
  }

  private queueUnrecognizedChunk(p: Uint8Array, off: number, clen: number): void {
    const n = Math.min(clen, 256);
    const v = new Uint8Array(4 + ((n + 3) & ~3));
    w16(v, 0, 6);
    w16(v, 2, 4 + n);
    v.set(p.subarray(off, off + n), 4);
    this.errorCause = v;
  }

  /** Post-packet bookkeeping: SACK policy, deferred stream resets, flush. */
  private afterInput(): void {
    if (this.heldBytes > 0 && (this.orphanScan || (this.rCum !== this.cumAtInput && this.t - this.lastFwdAt < 10_000))) {
      this.dropOrphanFragments();
    }
    this.orphanScan = false;
    if (this.pktHadData) {
      this.pktHadData = false;
      this.sackOwed = true;
      this.pktsSinceSack++;
      if (this.pktsSinceSack >= 2 || this.rHighest !== this.rCum || this.state === S_SHUTDOWN_SENT) this.sackNow = true;
      else if (this.sackAt === 0) this.sackAt = this.t + this.sackDelay;
      if (this.state === S_SHUTDOWN_SENT) this.shutdownPending = true;
    }
    if (this.deferredReset !== null && le32(this.deferredReset.lastTsn, this.rCum)) {
      const d = this.deferredReset;
      this.deferredReset = null;
      this.performIncomingReset(d.sids);
      if (((d.seq + 1) >>> 0) === this.peerReqExpected) this.lastPeerReqResult = RR_PERFORMED;
    }
    if (this.corked > 0) {
      // Corked (e.g. per event-loop-iteration bundling): the SACK and any
      // data wait for the outermost uncork, which bundles them together.
      this.flushNeeded = true;
      this.schedule();
      return;
    }
    this.flush();
  }

  private drainDeferred(): void {
    while (this.deferredInput !== null && !this.dead && !this.inInput && !this.flushing) {
      const q = this.deferredInput;
      this.deferredInput = null;
      for (const pkt of q) this.input(pkt);
    }
  }

  // --- handshake ----------------------------------------------------------

  private randomTag(): number {
    let v = 0;
    while (v === 0) v = this.randomFn() >>> 0;
    return v;
  }

  private parseInit(p: Uint8Array, off: number, clen: number, isAck: boolean): InitInfo | null {
    const info: InitInfo = {
      tag: u32(p, off + 4),
      arwnd: u32(p, off + 8),
      os: u16(p, off + 12),
      mis: u16(p, off + 14),
      tsn: u32(p, off + 16),
      fwdTsn: false,
      reconfig: false,
      zeroCk: false,
      cookieOff: -1,
      cookieLen: 0,
      unrecognized: null,
    };
    if (info.tag === 0 || info.os === 0 || info.mis === 0) return null;
    const end = off + clen;
    let q = off + 20;
    while (q + 4 <= end) {
      const pt = u16(p, q);
      const pl = u16(p, q + 2);
      if (pl < 4 || q + pl > end) break;
      switch (pt) {
        case PT_STATE_COOKIE:
          if (isAck) {
            info.cookieOff = q + 4;
            info.cookieLen = pl - 4;
          }
          break;
        case PT_FORWARD_TSN_SUPPORTED:
          info.fwdTsn = true;
          break;
        case PT_SUPPORTED_EXT:
          for (let k = q + 4; k < q + pl; k++) {
            if (p[k] === CT_FORWARD_TSN) info.fwdTsn = true;
            else if (p[k] === CT_RECONFIG) info.reconfig = true;
          }
          break;
        case PT_ZERO_CHECKSUM:
          if (pl >= 8 && u32(p, q + 4) === 1) info.zeroCk = true;
          break;
        case 5: // IPv4
        case 6: // IPv6
        case 9: // cookie preservative
        case 11: // host name (deprecated)
        case 12: // supported address types
        case PT_UNRECOGNIZED:
          break;
        default: {
          const action = pt >>> 14;
          if (action === 0 || action === 1) {
            // Stop processing: we keep what we have rather than failing the handshake.
            if (action === 1 && !isAck) (info.unrecognized ??= []).push(q, pl);
            return info;
          }
          if (action === 3 && !isAck) (info.unrecognized ??= []).push(q, pl);
        }
      }
      q += (pl + 3) & ~3;
    }
    return info;
  }

  /** Writes INIT / INIT-ACK common fields + params; returns the end offset. */
  private writeInitBody(b: Uint8Array, p: number, type: number, tag: number, tsn: number): number {
    b[p] = type;
    b[p + 1] = 0;
    w32(b, p + 4, tag);
    w32(b, p + 8, this.rxBufferSize);
    w16(b, p + 12, OUR_STREAMS);
    w16(b, p + 14, OUR_STREAMS);
    w32(b, p + 16, tsn);
    return p + 20;
  }

  private writeInitParams(b: Uint8Array, q: number): number {
    // Forward-TSN supported
    w16(b, q, PT_FORWARD_TSN_SUPPORTED);
    w16(b, q + 2, 4);
    q += 4;
    if (this.zeroCkEnabled) {
      w16(b, q, PT_ZERO_CHECKSUM);
      w16(b, q + 2, 8);
      w32(b, q + 4, 1);
      q += 8;
    }
    // Supported extensions (last: its padding is not counted)
    w16(b, q, PT_SUPPORTED_EXT);
    w16(b, q + 2, 6);
    b[q + 4] = CT_RECONFIG;
    b[q + 5] = CT_FORWARD_TSN;
    return q + 6;
  }

  private sendInit(): void {
    const b = this.beginStandalone(0);
    const p = 12;
    let q = this.writeInitBody(b, p, CT_INIT, this.localTag, this.localInitTsn);
    q = this.writeInitParams(b, q);
    w16(b, p + 2, q - p);
    while (q & 3) b[q++] = 0;
    this.sendStandalone(b, q);
  }

  private handleInit(p: Uint8Array, off: number, clen: number): void {
    if (this.dead) return;
    const st = this.state;
    if (st >= S_ESTABLISHED) return; // no restart support
    const info = this.parseInit(p, off, clen, false);
    if (info === null) {
      this.c.malformed++;
      return;
    }
    let tag: number;
    let tsn: number;
    if (st === S_CLOSED) {
      tag = this.randomTag();
      tsn = this.randomFn() >>> 0;
    } else {
      // INIT collision (RFC 9260 §5.2.1): answer with our existing parameters.
      tag = this.localTag;
      tsn = this.localInitTsn;
    }
    const cookie = this.makeCookie(tag, tsn, info);
    const b = this.beginStandalone(info.tag);
    const c0 = 12;
    let q = this.writeInitBody(b, c0, CT_INIT_ACK, tag, tsn);
    w16(b, q, PT_STATE_COOKIE);
    w16(b, q + 2, 4 + COOKIE_LEN);
    b.set(cookie, q + 4);
    q += 4 + COOKIE_LEN;
    if (info.unrecognized !== null) {
      const u = info.unrecognized;
      for (let k = 0; k < u.length; k += 2) {
        const pl = u[k + 1];
        if (q + 4 + pl + 32 > this.mtu) break;
        w16(b, q, PT_UNRECOGNIZED);
        w16(b, q + 2, 4 + pl);
        b.set(p.subarray(u[k], u[k] + pl), q + 4);
        q += 4 + pl;
        while (q & 3) b[q++] = 0;
      }
    }
    q = this.writeInitParams(b, q);
    w16(b, c0 + 2, q - c0);
    while (q & 3) b[q++] = 0;
    this.sendStandalone(b, q);
  }

  private makeCookie(localTag: number, localTsn: number, info: InitInfo): Uint8Array {
    const c = new Uint8Array(COOKIE_LEN);
    const dv = new DataView(c.buffer);
    c[0] = 1;
    dv.setFloat64(4, this.t);
    dv.setUint32(12, localTag);
    dv.setUint32(16, info.tag);
    dv.setUint32(20, localTsn);
    dv.setUint32(24, info.tsn);
    dv.setUint32(28, info.arwnd);
    dv.setUint16(32, info.os);
    dv.setUint16(34, info.mis);
    c[36] = (info.fwdTsn ? 1 : 0) | (info.reconfig ? 2 : 0) | (info.zeroCk ? 4 : 0);
    const mac = createHmac('sha256', this.cookieKey).update(c.subarray(0, 40)).digest();
    c.set(mac, 40);
    return c;
  }

  private handleCookieEcho(p: Uint8Array, off: number, clen: number, vtag: number): void {
    if (this.dead || clen !== 4 + COOKIE_LEN) return;
    const c = p.subarray(off + 4, off + 4 + COOKIE_LEN);
    if (c[0] !== 1) return;
    const mac = createHmac('sha256', this.cookieKey).update(c.subarray(0, 40)).digest();
    if (!timingSafeEqual(mac, Buffer.from(c.buffer, c.byteOffset + 40, 32))) return;
    const dv = new DataView(c.buffer, c.byteOffset, COOKIE_LEN);
    const ts = dv.getFloat64(4);
    if (!(this.t - ts <= COOKIE_LIFETIME) || ts - this.t > 1000) return;
    const cLocal = dv.getUint32(12);
    const cPeer = dv.getUint32(16);
    if (vtag !== cLocal) return;
    const st = this.state;
    if (st >= S_ESTABLISHED) {
      // Our COOKIE-ACK was lost (case D): resend.
      if (cLocal === this.localTag && cPeer === this.peerTag) this.cookieAckPending = true;
      return;
    }
    if (st !== S_CLOSED && cLocal !== this.localTag) return;
    const flags = c[36];
    this.localTag = cLocal;
    this.peerTag = cPeer;
    if (st === S_CLOSED) {
      this.localInitTsn = dv.getUint32(20);
      this.initTx(this.localInitTsn);
    }
    this.setPeerParams(dv.getUint32(24), dv.getUint32(28), dv.getUint16(32), dv.getUint16(34), (flags & 1) !== 0, (flags & 2) !== 0, (flags & 4) !== 0);
    this.cookieAckPending = true;
    this.established();
  }

  private handleInitAck(p: Uint8Array, off: number, clen: number): void {
    if (this.state !== S_COOKIE_WAIT || clen < 20) return;
    const info = this.parseInit(p, off, clen, true);
    if (info === null || info.cookieOff < 0 || info.cookieLen <= 0) {
      this.c.malformed++;
      return;
    }
    this.peerTag = info.tag;
    this.setPeerParams(info.tsn, info.arwnd, info.os, info.mis, info.fwdTsn, info.reconfig, info.zeroCk);
    this.cookie = p.slice(info.cookieOff, info.cookieOff + info.cookieLen);
    this.state = S_COOKIE_ECHOED;
    this.initRetries = 0;
    this.sendCookieEcho();
    this.t1At = this.t + this.rto;
  }

  private sendCookieEcho(): void {
    const ck = this.cookie;
    if (ck === null) return;
    const n = 4 + ck.length;
    const b = new Uint8Array(12 + ((n + 3) & ~3));
    w32(b, 4, this.peerTag);
    b[12] = CT_COOKIE_ECHO;
    w16(b, 14, n);
    b.set(ck, 16);
    this.sendStandalone(b, b.length);
  }

  private setPeerParams(tsn: number, arwnd: number, os: number, mis: number, fwd: boolean, reconf: boolean, zc: boolean): void {
    this.rCum = (tsn - 1) >>> 0;
    this.rHighest = this.rCum;
    this.peerReqExpected = tsn;
    this.peerRwnd = arwnd;
    this.ssthresh = arwnd;
    this.outStreams = Math.min(OUR_STREAMS, mis);
    this.inStreams = Math.min(OUR_STREAMS, os);
    this.peerFwdTsn = fwd;
    this.peerReconfig = reconf;
    this.zcSend = zc && this.zeroCkEnabled;
  }

  private initTx(tsn: number): void {
    this.tAcked = (tsn - 1) >>> 0;
    this.tNext = tsn;
    this.tSendNext = tsn;
    this.advPeerAck = this.tAcked;
    this.reqSeq = tsn;
    this.cwnd = this.initialCwnd;
    this.ssthresh = 1 << 30;
    this.rto = this.rtoInitial;
  }

  private established(): void {
    this.state = S_ESTABLISHED;
    this.t1At = 0;
    this.cookie = null;
    this.errors = 0;
    this.rto = this.rtoInitial;
    try {
      this.onOpenFn();
    } catch (e) {
      this.reportError(e);
    }
    this.requestFlush();
  }

  // --- DATA ---------------------------------------------------------------

  private handleData(p: Uint8Array, off: number, clen: number, flags: number): void {
    const st = this.state;
    if (st !== S_ESTABLISHED && st !== S_SHUTDOWN_PENDING && st !== S_SHUTDOWN_SENT) return;
    if (clen <= 16) {
      this.c.malformed++;
      return;
    }
    this.pktHadData = true;
    this.c.dataChunksReceived++;
    if (flags & F_I) this.sackNow = true;
    const tsn = u32(p, off + 4);
    const d = (tsn - this.rCum) | 0;
    if (d <= 0) {
      this.addDup(tsn);
      return;
    }
    if (d > this.rxCap) {
      this.sackNow = true;
      return;
    }
    const sid = u16(p, off + 8);
    const ssn = u16(p, off + 10);
    const ppid = u32(p, off + 12);
    const dOff = off + 16;
    const dLen = clen - 16;
    const fl = flags & 7;
    // Fast path: next in-order TSN, complete message, deliverable now.
    if (d === 1 && this.rHighest === this.rCum && fl & F_B && fl & F_E) {
      if (fl & F_U) {
        this.rCum = tsn;
        this.rHighest = tsn;
        this.deliverView(sid, ppid, p, dOff, dLen);
        return;
      }
      if (sid < this.inStreams) {
        this.ensureStream(sid);
        if (this.rNextSsn[sid] === ssn) {
          const pend = this.rPending[sid];
          if (pend === null || pend === undefined || pend.size === 0) {
            this.rCum = tsn;
            this.rHighest = tsn;
            this.rNextSsn[sid] = ssn + 1;
            this.deliverView(sid, ppid, p, dOff, dLen);
            return;
          }
        }
      }
    }
    // Slow path.
    this.ensureRxStore();
    const bits = this.rBits!;
    const mask = this.rxMask;
    if (d > 1 && bits[tsn & mask]) {
      this.addDup(tsn);
      return;
    }
    if (sid >= this.inStreams) {
      // Invalid stream: acknowledge and drop.
      this.markReceived(tsn, d);
      this.c.droppedMessages++;
      return;
    }
    const s = tsn & mask;
    const hf = this.hFlags!;
    if (hf[s] & H_HELD) {
      if (hf[s] & H_PENDING) return; // slot busy with a deliverable message: drop, peer retransmits
      this.releaseSlot(s);
    }
    if (d > 1 && this.heldBytes + dLen > this.rxBufferSize) return; // receive buffer full
    hf[s] = H_HELD | fl;
    this.hTsn![s] = tsn;
    this.hSid![s] = sid;
    this.hSsn![s] = ssn;
    this.hPpid![s] = ppid;
    this.hData[s] = p.slice(dOff, dOff + dLen);
    this.heldBytes += dLen;
    this.markReceived(tsn, d);
    if (this.rHighest !== this.rCum) this.sackNow = true;
    this.tryAssemble(tsn);
  }

  private addDup(tsn: number): void {
    this.c.duplicateTsns++;
    this.sackNow = true;
    if (this.dupN < this.dups.length) this.dups[this.dupN++] = tsn;
  }

  private markReceived(tsn: number, d: number): void {
    const bits = this.rBits!;
    const mask = this.rxMask;
    if (d === 1) {
      let c = tsn;
      bits[c & mask] = 0;
      while (bits[((c + 1) >>> 0) & mask] && c !== this.rHighest) {
        c = (c + 1) >>> 0;
        bits[c & mask] = 0;
      }
      this.rCum = c;
      if (lt32(this.rHighest, c)) this.rHighest = c;
    } else {
      bits[tsn & mask] = 1;
      if (lt32(this.rHighest, tsn)) this.rHighest = tsn;
    }
  }

  private ensureRxStore(): void {
    if (this.rBits !== null) return;
    const n = this.rxCap;
    this.rBits = new Uint8Array(n);
    this.hFlags = new Uint8Array(n);
    this.hTsn = new Uint32Array(n);
    this.hSid = new Uint16Array(n);
    this.hSsn = new Uint16Array(n);
    this.hPpid = new Uint32Array(n);
    this.hData = new Array<Uint8Array | null>(n).fill(null);
  }

  private ensureStream(sid: number): void {
    if (sid < this.rNextSsn.length) return;
    let n = this.rNextSsn.length;
    while (n <= sid) n <<= 1;
    const a = new Uint16Array(n);
    a.set(this.rNextSsn);
    this.rNextSsn = a;
  }

  private releaseSlot(s: number): void {
    const d = this.hData[s];
    if (d !== null) this.heldBytes -= d.length;
    this.hData[s] = null;
    this.hFlags![s] = 0;
  }

  private matches(s: number, t: number, sid: number, u: number, ssn: number): boolean {
    const f = this.hFlags![s];
    return (f & (H_HELD | H_PENDING)) === H_HELD && this.hTsn![s] === t && this.hSid![s] === sid && (f & F_U) === u && (u !== 0 || this.hSsn![s] === ssn);
  }

  /** Delivers the message containing `tsn` if all its fragments are present. */
  private tryAssemble(tsn: number): void {
    const mask = this.rxMask;
    const hf = this.hFlags!;
    const s0 = tsn & mask;
    const f0 = hf[s0];
    const sid = this.hSid![s0];
    const ssn = this.hSsn![s0];
    const u = f0 & F_U;
    let b = tsn;
    let n = 0;
    let total = this.hData[s0]!.length;
    while (!(hf[b & mask] & F_B)) {
      const pb = (b - 1) >>> 0;
      const ps = pb & mask;
      if (!this.matches(ps, pb, sid, u, ssn) || hf[ps] & F_E) return;
      b = pb;
      total += this.hData[ps]!.length;
      if (++n >= this.rxCap) return;
    }
    let e = tsn;
    while (!(hf[e & mask] & F_E)) {
      const ne = (e + 1) >>> 0;
      const ns = ne & mask;
      if (!this.matches(ns, ne, sid, u, ssn) || hf[ns] & F_B) return;
      e = ne;
      total += this.hData[ns]!.length;
      if (++n >= this.rxCap) return;
    }
    if (total > this.maxRecvMessage) {
      this.fail('message-too-large');
      return;
    }
    if (u) {
      this.deliverRange(b, e, total);
      return;
    }
    this.ensureStream(sid);
    const next = this.rNextSsn[sid];
    if (ssn === next) {
      this.rNextSsn[sid] = ssn + 1;
      this.deliverRange(b, e, total);
      this.drainPending(sid);
    } else if (lt16(next, ssn)) {
      for (let t = b; ; t = (t + 1) >>> 0) {
        hf[t & mask] |= H_PENDING;
        if (t === e) break;
      }
      let m = this.rPending[sid];
      if (m === undefined || m === null) m = this.rPending[sid] = new Map();
      m.set(ssn, b);
    } else {
      for (let t = b; ; t = (t + 1) >>> 0) {
        this.releaseSlot(t & mask);
        if (t === e) break;
      }
    }
  }

  private drainPending(sid: number): void {
    const m = this.rPending[sid];
    if (m === undefined || m === null) return;
    while (m.size > 0 && !this.dead) {
      const ssn = this.rNextSsn[sid];
      const b = m.get(ssn);
      if (b === undefined) return;
      m.delete(ssn);
      this.rNextSsn[sid] = ssn + 1;
      this.deliverPending(b, sid);
    }
  }

  /** Delivers a complete pending (H_PENDING) message starting at `b`. */
  private deliverPending(b: number, sid: number): void {
    const mask = this.rxMask;
    const hf = this.hFlags!;
    const sb = b & mask;
    if (!(hf[sb] & H_PENDING) || !(hf[sb] & F_B) || this.hTsn![sb] !== b || this.hSid![sb] !== sid) return;
    let e = b;
    let total = this.hData[sb]!.length;
    let n = 0;
    while (!(hf[e & mask] & F_E)) {
      e = (e + 1) >>> 0;
      const se = e & mask;
      if (!(hf[se] & H_PENDING) || this.hTsn![se] !== e || ++n >= this.rxCap) return;
      total += this.hData[se]!.length;
    }
    this.deliverRange(b, e, total);
  }

  private deliverRange(b: number, e: number, total: number): void {
    const mask = this.rxMask;
    const sb = b & mask;
    const sid = this.hSid![sb];
    const ppid = this.hPpid![sb];
    let data: Uint8Array;
    if (b === e) {
      data = this.hData[sb]!;
      this.releaseSlot(sb);
    } else {
      data = new Uint8Array(total);
      let o = 0;
      for (let t = b; ; t = (t + 1) >>> 0) {
        const s = t & mask;
        const part = this.hData[s]!;
        data.set(part, o);
        o += part.length;
        this.releaseSlot(s);
        if (t === e) break;
      }
    }
    this.deliver(sid, ppid, data);
  }

  private deliverView(sid: number, ppid: number, p: Uint8Array, off: number, len: number): void {
    if (ppid === PPID_DCEP) {
      this.handleDcep(sid, p, off, len);
      return;
    }
    if (sid >= this.chFlags.length || !(this.chFlags[sid] & CH_CONFIGURED)) {
      this.c.droppedMessages++;
      return;
    }
    if (ppid === PPID_BINARY_EMPTY || ppid === PPID_STRING_EMPTY) {
      this.c.messagesReceived++;
      this.callOnMessage(sid, EMPTY, ppid);
      return;
    }
    if (this.transient && !this.scratchBusy && len <= this.maxFrag) {
      // Copy into the scratch buffer (tens of bytes for HaxBall) and hand out
      // its cached view of that length: no allocation. scratchBusy guards
      // against a nested delivery (callback feeding this association again
      // is deferred by `input`, but stay safe).
      let sc = this.scratch;
      let views = this.scratchViews;
      if (sc === null || views === null) {
        sc = this.scratch = new Uint8Array(this.maxFrag);
        views = this.scratchViews = [];
      }
      if (len <= 64) for (let k = 0; k < len; k++) sc[k] = p[off + k];
      else sc.set(p.subarray(off, off + len));
      const view = (views[len] ??= sc.subarray(0, len));
      this.c.messagesReceived++;
      this.scratchBusy = true;
      try {
        this.callOnMessage(sid, view, ppid);
      } finally {
        this.scratchBusy = false;
      }
      return;
    }
    const data = this.zeroCopy && !this.transient ? p.subarray(off, off + len) : p.slice(off, off + len);
    this.c.messagesReceived++;
    this.callOnMessage(sid, data, ppid);
  }

  private callOnMessage(sid: number, data: Uint8Array, ppid: number): void {
    try {
      this.onMessageFn(sid, data, ppid);
    } catch (e) {
      this.reportError(e);
    }
  }

  private deliver(sid: number, ppid: number, data: Uint8Array): void {
    if (ppid === PPID_DCEP) {
      this.handleDcep(sid, data, 0, data.length);
      return;
    }
    if (sid >= this.chFlags.length || !(this.chFlags[sid] & CH_CONFIGURED)) {
      this.c.droppedMessages++;
      return;
    }
    this.c.messagesReceived++;
    try {
      this.onMessageFn(sid, ppid === PPID_BINARY_EMPTY || ppid === PPID_STRING_EMPTY ? EMPTY : data, ppid);
    } catch (e) {
      this.reportError(e);
    }
  }

  // --- DCEP (RFC 8832) ------------------------------------------------------

  private handleDcep(sid: number, p: Uint8Array, off: number, len: number): void {
    if (len < 1 || p[off] !== 0x03) return; // only DATA_CHANNEL_OPEN needs an answer
    if (len < 12) return;
    const chType = p[off + 1];
    const rel = u32(p, off + 4);
    const labelLen = u16(p, off + 8);
    const protoLen = u16(p, off + 10);
    if (12 + labelLen + protoLen > len) return;
    this.growChannels(sid);
    const cf = this.chFlags[sid];
    if (cf & CH_CONFIGURED && !(cf & CH_CLOSING)) {
      this.enqueue(sid, DCEP_ACK, PPID_DCEP, true, -1);
      return;
    }
    if (!this.acceptDcep || cf & CH_CLOSING || sid >= this.outStreams) {
      // Reject: reset our outgoing stream, the peer then closes the channel.
      if (!(cf & CH_CLOSING) && this.peerReconfig) {
        this.chFlags[sid] = cf | CH_CLOSING | CH_NOTIFIED;
        this.resetQueue.push(sid);
        this.maybeSendReset();
      }
      return;
    }
    const kind = chType & 0x7f;
    this.configureChannel(sid, !(chType & 0x80), kind === 1 ? rel : undefined);
    this.enqueue(sid, DCEP_ACK, PPID_DCEP, true, -1);
    if (this.onChannelOpenFn) {
      const td = new TextDecoder();
      const label = td.decode(p.subarray(off + 12, off + 12 + labelLen));
      const proto = td.decode(p.subarray(off + 12 + labelLen, off + 12 + labelLen + protoLen));
      try {
        this.onChannelOpenFn(sid, label, proto);
      } catch (e) {
        this.reportError(e);
      }
    }
  }

  // --- SACK ---------------------------------------------------------------

  private handleSack(p: Uint8Array, off: number, clen: number): void {
    if (clen < 16 || this.state < S_ESTABLISHED) {
      this.c.malformed++;
      return;
    }
    this.c.sacksReceived++;
    const cum = u32(p, off + 4);
    const arwnd = u32(p, off + 8);
    let nGap = u16(p, off + 12);
    if (16 + nGap * 4 > clen) nGap = (clen - 16) >> 2;
    this.processAck(cum, arwnd, p, off + 16, nGap);
  }

  /** Cumulative ack + gap blocks (from SACK, or SHUTDOWN with nGap=0, arwnd=-1). */
  private processAck(cum: number, arwnd: number, p: Uint8Array | null, gOff: number, nGap: number): void {
    if (lt32(cum, this.tAcked)) return; // stale
    const lastSent = (this.tSendNext - 1) >>> 0;
    if (lt32(lastSent, cum)) {
      this.c.malformed++; // acks data never sent
      return;
    }
    const mask = this.tMask;
    const flightBefore = this.flight;
    let bytesAcked = 0;
    let htna = this.tAcked;
    let htnaSet = false;
    let rttFrom = -1;
    const cumAdvanced = lt32(this.tAcked, cum);
    // Cumulative part: free records.
    for (let t = (this.tAcked + 1) >>> 0; lt32(this.tAcked, cum); t = (t + 1) >>> 0) {
      const i = t & mask;
      const f = this.txFlags[i];
      const len = this.txLen[i];
      if (!(f & T_ACKED)) {
        if (f & T_INFLIGHT) this.flight -= len;
        if (f & T_RETX) {
          this.retxCount--;
          if (f & T_FR_PENDING) this.frCount--;
        }
        if (!(f & T_ABANDONED)) {
          bytesAcked += len;
          if (this.txCount[i] === 1) rttFrom = this.txSentAt[i];
        }
        htna = t;
        htnaSet = true;
      }
      this.buffered -= len;
      this.txFlags[i] = 0;
      this.tAcked = t;
    }
    // Gap blocks.
    if (p !== null && nGap > 0) {
      for (let g = 0; g < nGap; g++) {
        const so = u16(p, gOff + g * 4);
        const eo = u16(p, gOff + g * 4 + 2);
        if (so === 0 || eo < so) continue;
        let t = (cum + so) >>> 0;
        const end = (cum + eo) >>> 0;
        if (lt32(lastSent, t)) continue;
        for (;;) {
          const i = t & mask;
          const f = this.txFlags[i];
          if (!(f & T_ACKED)) {
            const len = this.txLen[i];
            if (f & T_INFLIGHT) this.flight -= len;
            if (f & T_RETX) {
              this.retxCount--;
              if (f & T_FR_PENDING) this.frCount--;
            }
            if (!(f & T_ABANDONED)) {
              bytesAcked += len;
              if (this.txCount[i] === 1) rttFrom = this.txSentAt[i];
            }
            this.txFlags[i] = (f & ~(T_INFLIGHT | T_RETX | T_FR_PENDING)) | T_ACKED;
            if (lt32(htna, t)) htna = t;
            htnaSet = true;
          }
          if (t === end || t === lastSent) break;
          t = (t + 1) >>> 0;
        }
      }
    }
    if (this.flight < 0) this.flight = 0;
    if (arwnd >= 0) this.peerRwnd = arwnd;
    if (rttFrom >= 0) this.updateRto(this.t - rttFrom);
    if (cumAdvanced || bytesAcked > 0) this.errors = 0;
    // Fast retransmit: miss indications below the highest newly acked TSN.
    if (htnaSet && p !== null && nGap > 0) {
      let newFr = false;
      for (let t = (this.tAcked + 1) >>> 0; lt32(t, htna); t = (t + 1) >>> 0) {
        const i = t & mask;
        const f = this.txFlags[i];
        if (f & (T_ACKED | T_ABANDONED | T_FR_DONE) || !(f & T_INFLIGHT)) continue;
        if (++this.txMiss[i] >= 3) {
          this.txMiss[i] = 0;
          if (this.markRetransmit(t, true)) newFr = true;
        }
      }
      if (newFr && !this.inFastRecovery) {
        this.inFastRecovery = true;
        this.frExit = lastSent;
        this.ssthresh = Math.max(this.cwnd >> 1, 4 * this.mtu);
        this.cwnd = this.ssthresh;
        this.pba = 0;
      }
    }
    if (this.inFastRecovery && le32(this.frExit, this.tAcked)) this.inFastRecovery = false;
    // Congestion window growth (RFC 9260 §7.2.1/7.2.2).
    if (cumAdvanced && !this.inFastRecovery && bytesAcked > 0) {
      if (this.cwnd <= this.ssthresh) {
        if (flightBefore + this.mtu >= this.cwnd) this.cwnd += Math.min(bytesAcked, this.mtu);
      } else {
        this.pba += bytesAcked;
        if (this.pba >= this.cwnd && flightBefore + this.mtu >= this.cwnd) {
          this.pba -= this.cwnd;
          this.cwnd += this.mtu;
        }
      }
    }
    // PR-SCTP: advance the ack point over abandoned chunks.
    this.updateAdvPeerAck();
    // T3 management.
    if (this.flight > 0 || lt32(this.tAcked, this.advPeerAck)) {
      if (cumAdvanced || this.t3At === 0) this.t3At = this.t + this.rto;
    } else {
      this.t3At = 0;
    }
    if (this.state === S_SHUTDOWN_PENDING || this.state === S_SHUTDOWN_RECEIVED) this.checkShutdown();
    if (this.retxCount > 0 || this.tSendNext !== this.tNext) this.flushNeeded = true;
  }

  private updateRto(r: number): void {
    if (r < 0) r = 0;
    if (this.srtt === 0) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
      this.srtt = 0.875 * this.srtt + 0.125 * r;
    }
    let rto = this.srtt + Math.max(4 * this.rttvar, this.rtoMinVar);
    if (rto < this.rtoMin) rto = this.rtoMin;
    if (rto > this.rtoMax) rto = this.rtoMax;
    this.rto = rto;
  }

  /** Marks a sent chunk for retransmission, or abandons its message (PR-SCTP). */
  private markRetransmit(t: number, fast: boolean): boolean {
    const i = t & this.tMask;
    const f = this.txFlags[i];
    if (f & (T_ACKED | T_ABANDONED | T_RETX)) return false;
    const maxRtx = this.txMaxRtx[i];
    if (maxRtx >= 0 && this.txCount[i] > maxRtx) {
      this.abandonMessage(t);
      return false;
    }
    if (f & T_INFLIGHT) this.flight -= this.txLen[i];
    this.txFlags[i] = (f & ~T_INFLIGHT) | T_RETX | (fast ? T_FR_PENDING : 0);
    this.retxCount++;
    if (fast) this.frCount++;
    return true;
  }

  private abandonMessage(t: number): void {
    const mask = this.tMask;
    const first = (this.tAcked + 1) >>> 0;
    const last = (this.tNext - 1) >>> 0;
    let b = t;
    while (!(this.txFlags[b & mask] & F_B) && b !== first) b = (b - 1) >>> 0;
    let e = t;
    while (!(this.txFlags[e & mask] & F_E) && e !== last) e = (e + 1) >>> 0;
    for (let x = b; ; x = (x + 1) >>> 0) {
      const i = x & mask;
      const f = this.txFlags[i];
      if (!(f & (T_ACKED | T_ABANDONED))) {
        if (f & T_INFLIGHT) this.flight -= this.txLen[i];
        if (f & T_RETX) {
          this.retxCount--;
          if (f & T_FR_PENDING) this.frCount--;
        }
        this.txFlags[i] = (f & ~(T_INFLIGHT | T_RETX | T_FR_PENDING)) | T_ABANDONED;
      }
      if (x === e) break;
    }
    if (le32(this.tSendNext, e)) this.tSendNext = (e + 1) >>> 0;
    this.c.abandonedMessages++;
  }

  private updateAdvPeerAck(): void {
    if (lt32(this.advPeerAck, this.tAcked)) this.advPeerAck = this.tAcked;
    const mask = this.tMask;
    while (this.advPeerAck !== ((this.tSendNext - 1) >>> 0)) {
      const n = (this.advPeerAck + 1) >>> 0;
      if (!(this.txFlags[n & mask] & (T_ABANDONED | T_ACKED))) break;
      this.advPeerAck = n;
    }
    if (lt32(this.tAcked, this.advPeerAck)) this.fwdTsnPending = true;
  }

  // --- FORWARD-TSN (receiver) --------------------------------------------------

  private handleForwardTsn(p: Uint8Array, off: number, clen: number): void {
    const st = this.state;
    if (clen < 8 || (st !== S_ESTABLISHED && st !== S_SHUTDOWN_PENDING && st !== S_SHUTDOWN_SENT)) return;
    this.c.forwardTsnReceived++;
    this.lastFwdAt = this.t;
    this.orphanScan = true;
    this.sackNow = true;
    this.sackOwed = true;
    const newCum = u32(p, off + 4);
    if (!lt32(this.rCum, newCum)) return;
    const diff = (newCum - this.rCum) >>> 0;
    if (this.rBits !== null) {
      const bits = this.rBits;
      const hf = this.hFlags!;
      const mask = this.rxMask;
      if (diff >= this.rxCap) {
        // Every TSN of the receive window is <= newCum.
        bits.fill(0);
      } else {
        for (let t = (this.rCum + 1) >>> 0; ; t = (t + 1) >>> 0) {
          bits[t & mask] = 0;
          if (t === newCum) break;
        }
      }
      this.rCum = newCum;
      if (lt32(this.rHighest, newCum)) this.rHighest = newCum;
      while (this.rCum !== this.rHighest && bits[((this.rCum + 1) >>> 0) & mask]) {
        this.rCum = (this.rCum + 1) >>> 0;
        bits[this.rCum & mask] = 0;
      }
    } else {
      this.rCum = newCum;
      if (lt32(this.rHighest, newCum)) this.rHighest = newCum;
    }
    // Stream entries: skip abandoned ordered messages.
    for (let q = off + 8; q + 4 <= off + clen && !this.dead; q += 4) {
      const sid = u16(p, q);
      const ssn = u16(p, q + 2);
      if (sid >= this.inStreams) continue;
      this.ensureStream(sid);
      const next = this.rNextSsn[sid];
      if (lt16(ssn, next)) continue;
      const m = this.rPending[sid];
      if (m !== undefined && m !== null && m.size > 0) {
        // Deliver complete messages up to `ssn` in order, then skip the rest.
        const keys = [...m.keys()].filter((k) => !lt16(ssn, k)).sort((a, b) => (lt16(a, b) ? -1 : 1));
        for (const k of keys) {
          const b = m.get(k)!;
          m.delete(k);
          this.deliverPending(b, sid);
        }
      }
      this.rNextSsn[sid] = ssn + 1;
      this.drainPending(sid);
    }
  }

  /**
   * Releases partial messages that can no longer complete. Only abandonment
   * (FORWARD-TSN) creates them: a fragment run that breaks at a TSN <= rCum
   * lost that fragment for good. Runs reaching past rCum may still complete.
   * Two passes over the slots <= rCum: predecessor chain, then successor chain.
   */
  private dropOrphanFragments(): void {
    const hf = this.hFlags!;
    const mask = this.rxMask;
    const cum = this.rCum;
    const cap = this.rxCap;
    // Ascending: a non-B fragment needs a live, matching predecessor.
    let t = (cum - cap + 1) >>> 0;
    let prevOk = false;
    let prevSid = -1;
    for (let n = 0; n < cap; n++, t = (t + 1) >>> 0) {
      const s = t & mask;
      const f = hf[s];
      if (!(f & H_HELD) || f & H_PENDING) {
        prevOk = false;
        continue;
      }
      if (this.hTsn![s] !== t) {
        // Same slot, other TSN: one above rCum is live data; one below the window is stale.
        if (!lt32(cum, this.hTsn![s])) this.releaseSlot(s);
        prevOk = false;
        continue;
      }
      const ok = (f & F_B) !== 0 || (prevOk && prevSid === this.hSid![s]);
      if (ok) {
        prevOk = !(f & F_E);
        prevSid = this.hSid![s];
      } else {
        this.releaseSlot(s);
        prevOk = false;
      }
    }
    // Descending: a fragment needs a live continuation unless it reaches past rCum.
    t = cum;
    let nextOk = false;
    let nextSid = -1;
    for (let n = 0; n < cap; n++, t = (t - 1) >>> 0) {
      const s = t & mask;
      const f = hf[s];
      if (!(f & H_HELD) || f & H_PENDING || this.hTsn![s] !== t) {
        nextOk = false;
        continue;
      }
      const ok = !(f & F_E) && (n === 0 || (nextOk && nextSid === this.hSid![s]));
      if (ok) {
        nextOk = !(f & F_B);
        nextSid = this.hSid![s];
      } else {
        this.releaseSlot(s);
        nextOk = false;
      }
    }
  }

  // --- RE-CONFIG (RFC 6525) ----------------------------------------------------

  private handleReconfig(p: Uint8Array, off: number, clen: number): void {
    if (this.state !== S_ESTABLISHED && this.state !== S_SHUTDOWN_PENDING) return;
    const end = off + clen;
    let q = off + 4;
    while (q + 4 <= end) {
      const pt = u16(p, q);
      const pl = u16(p, q + 2);
      if (pl < 4 || q + pl > end) break;
      if (pt === PT_OUT_RESET && pl >= 16) {
        const seq = u32(p, q + 4);
        const lastTsn = u32(p, q + 12);
        const sids: number[] = [];
        for (let k = q + 16; k + 2 <= q + pl; k += 2) sids.push(u16(p, k));
        this.handlePeerOutReset(seq, lastTsn, sids);
      } else if (pt === PT_RECONF_RESPONSE && pl >= 12) {
        this.handleReconfResponse(u32(p, q + 4), u32(p, q + 8));
      } else if (pt >= PT_IN_RESET && pt <= 18 && pt !== PT_RECONF_RESPONSE && pl >= 8) {
        // Incoming / SSN-TSN reset / add streams: not supported.
        this.queueReconfResponse(u32(p, q + 4), RR_DENIED);
      }
      q += (pl + 3) & ~3;
    }
  }

  private queueReconfResponse(seq: number, result: number): void {
    (this.reconfResp ??= []).push(seq, result);
  }

  private handlePeerOutReset(seq: number, lastTsn: number, sids: number[]): void {
    if (seq === this.peerReqExpected) {
      this.peerReqExpected = (seq + 1) >>> 0;
      let result: number;
      if (le32(lastTsn, this.rCum)) {
        this.performIncomingReset(sids);
        result = RR_PERFORMED;
      } else {
        this.deferredReset = { seq, sids, lastTsn };
        result = RR_IN_PROGRESS;
      }
      this.lastPeerReqResult = result;
      this.queueReconfResponse(seq, result);
      // The peer closed these channels: close our side too (RFC 8831 §6.7).
      const list = sids.length > 0 ? sids : this.configuredIds();
      for (const sid of list) {
        if (sid >= this.chFlags.length) continue;
        const cf = this.chFlags[sid];
        if (!(cf & CH_CONFIGURED)) continue;
        if (!(cf & CH_CLOSING)) {
          this.chFlags[sid] = cf | CH_CLOSING;
          this.resetQueue.push(sid);
        }
        this.notifyChannelClose(sid);
      }
      this.maybeSendReset();
    } else if (seq === ((this.peerReqExpected - 1) >>> 0)) {
      this.queueReconfResponse(seq, this.lastPeerReqResult);
    } else {
      this.queueReconfResponse(seq, RR_BAD_SEQ);
    }
  }

  private configuredIds(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.chFlags.length; i++) if (this.chFlags[i] & CH_CONFIGURED) out.push(i);
    return out;
  }

  private performIncomingReset(sids: number[]): void {
    const list = sids.length > 0 ? sids : null;
    const reset = (sid: number): void => {
      if (sid >= this.rNextSsn.length) return;
      this.rNextSsn[sid] = 0;
      const m = this.rPending[sid];
      if (m !== undefined && m !== null && m.size > 0) {
        for (const b of m.values()) {
          const mask = this.rxMask;
          for (let t = b, n = 0; n < this.rxCap; t = (t + 1) >>> 0, n++) {
            const s = t & mask;
            if (!(this.hFlags![s] & H_PENDING) || this.hTsn![s] !== t) break;
            const end = this.hFlags![s] & F_E;
            this.releaseSlot(s);
            if (end) break;
          }
        }
        m.clear();
      }
    };
    if (list === null) for (let sid = 0; sid < this.rNextSsn.length; sid++) reset(sid);
    else for (const sid of list) reset(sid);
  }

  private maybeSendReset(): void {
    if (this.reqInFlight !== null || this.resetQueue.length === 0 || !this.peerReconfig) return;
    const sids = this.resetQueue.splice(0, 128);
    this.reqInFlight = { seq: this.reqSeq, sids, lastTsn: (this.tNext - 1) >>> 0 };
    this.reqSeq = (this.reqSeq + 1) >>> 0;
    this.reqNeedsSend = true;
    this.reconfAt = this.t + this.rto;
  }

  private handleReconfResponse(seq: number, result: number): void {
    const req = this.reqInFlight;
    if (req === null || seq !== req.seq) return;
    if (result === RR_IN_PROGRESS) {
      this.reconfAt = this.t + this.rto;
      return;
    }
    this.reqInFlight = null;
    this.reconfAt = 0;
    for (const sid of req.sids) {
      if (sid < this.tOutSsn.length) this.tOutSsn[sid] = 0;
      this.notifyChannelClose(sid);
    }
    this.maybeSendReset();
  }

  // --- shutdown -------------------------------------------------------------

  private allAcked(): boolean {
    return this.tNext === ((this.tAcked + 1) >>> 0);
  }

  private checkShutdown(): void {
    if (!this.allAcked()) return;
    if (this.state === S_SHUTDOWN_PENDING) {
      this.state = S_SHUTDOWN_SENT;
      this.shutdownPending = true;
      this.t2At = this.t + this.rto;
      this.t3At = 0;
      this.flushNeeded = true;
    } else if (this.state === S_SHUTDOWN_RECEIVED) {
      this.state = S_SHUTDOWN_ACK_SENT;
      this.shutdownAckPending = true;
      this.t2At = this.t + this.rto;
      this.t3At = 0;
      this.flushNeeded = true;
    }
  }

  private handleShutdown(cum: number): void {
    const st = this.state;
    if (st === S_ESTABLISHED || st === S_SHUTDOWN_PENDING || st === S_SHUTDOWN_RECEIVED) {
      this.processAck(cum, -1, null, 0, 0);
      this.state = S_SHUTDOWN_RECEIVED;
      this.checkShutdown();
    } else if (st === S_SHUTDOWN_SENT) {
      this.state = S_SHUTDOWN_ACK_SENT;
      this.shutdownAckPending = true;
      this.t2At = this.t + this.rto;
    }
  }

  private sendShutdownComplete(): void {
    const b = new Uint8Array(16);
    w32(b, 4, this.peerTag);
    b[12] = CT_SHUTDOWN_COMPLETE;
    w16(b, 14, 4);
    this.sendStandalone(b, 16);
  }

  // =========================================================================
  // Timers

  private schedule(): void {
    if (this.dead) return;
    let d = 0;
    if (this.t1At !== 0) d = this.t1At;
    if (this.t2At !== 0 && (d === 0 || this.t2At < d)) d = this.t2At;
    if (this.t3At !== 0 && (d === 0 || this.t3At < d)) d = this.t3At;
    if (this.sackAt !== 0 && (d === 0 || this.sackAt < d)) d = this.sackAt;
    if (this.reconfAt !== 0 && (d === 0 || this.reconfAt < d)) d = this.reconfAt;
    if (d === 0) return; // a stale armed timer just finds nothing to do
    if (this.timerHandle !== null) {
      if (this.timerAt <= d) return;
      this.clearTimerFn(this.timerHandle);
    }
    this.timerAt = d;
    this.timerHandle = this.setTimerFn(this.onTimerBound, Math.max(0, d - this.nowFn()));
  }

  private onTimer(): void {
    this.timerHandle = null;
    if (this.dead) return;
    if (this.inInput || this.flushing) {
      this.timerAt = 0;
      this.timerHandle = this.setTimerFn(this.onTimerBound, 1);
      return;
    }
    const now = (this.t = this.nowFn());
    const due = now + 0.5;
    try {
      if (this.sackAt !== 0 && this.sackAt <= due) {
        this.sackAt = 0;
        if (this.sackOwed) this.sackNow = true;
      }
      if (this.t1At !== 0 && this.t1At <= due) this.onT1();
      if (!this.dead && this.t2At !== 0 && this.t2At <= due) this.onT2();
      if (!this.dead && this.t3At !== 0 && this.t3At <= due) this.onT3();
      if (!this.dead && this.reconfAt !== 0 && this.reconfAt <= due) this.onReconfTimer();
    } catch (e) {
      this.reportError(e);
    }
    if (!this.dead) this.flush();
  }

  private backoff(): void {
    this.rto = Math.min(this.rto * 2, this.rtoMax);
  }

  private onT1(): void {
    if (++this.initRetries > this.maxInitRetrans) {
      this.terminate('init-timeout', true);
      return;
    }
    this.backoff();
    if (this.state === S_COOKIE_WAIT) this.sendInit();
    else if (this.state === S_COOKIE_ECHOED) this.sendCookieEcho();
    else {
      this.t1At = 0;
      return;
    }
    this.t1At = this.t + this.rto;
  }

  private onT2(): void {
    if (++this.errors > this.maxRetrans) {
      this.fail('timeout');
      return;
    }
    this.backoff();
    if (this.state === S_SHUTDOWN_SENT) this.shutdownPending = true;
    else if (this.state === S_SHUTDOWN_ACK_SENT) this.shutdownAckPending = true;
    else {
      this.t2At = 0;
      return;
    }
    this.t2At = this.t + this.rto;
  }

  private onT3(): void {
    this.t3At = 0;
    const hasOutstanding = this.tSendNext !== ((this.tAcked + 1) >>> 0);
    if (!hasOutstanding && !lt32(this.tAcked, this.advPeerAck)) return;
    this.c.t3Expirations++;
    if (++this.errors > this.maxRetrans) {
      this.fail('timeout');
      return;
    }
    this.ssthresh = Math.max(this.cwnd >> 1, 4 * this.mtu);
    this.cwnd = this.mtu;
    this.pba = 0;
    this.inFastRecovery = false;
    this.backoff();
    const mask = this.tMask;
    for (let t = (this.tAcked + 1) >>> 0; t !== this.tSendNext; t = (t + 1) >>> 0) {
      const f = this.txFlags[t & mask];
      if (f & T_INFLIGHT && !(f & (T_ACKED | T_ABANDONED))) this.markRetransmit(t, false);
    }
    this.updateAdvPeerAck();
    if (this.retxCount > 0 || lt32(this.tAcked, this.advPeerAck)) this.t3At = this.t + this.rto;
  }

  private onReconfTimer(): void {
    this.reconfAt = 0;
    if (this.reqInFlight === null) return;
    if (++this.errors > this.maxRetrans) {
      this.fail('timeout');
      return;
    }
    this.backoff();
    this.reqNeedsSend = true;
    this.reconfAt = this.t + this.rto;
  }

  // =========================================================================
  // Teardown / errors

  private terminate(reason: string, notify: boolean): void {
    if (this.dead) return;
    this.dead = true;
    this.state = S_CLOSED;
    if (this.timerHandle !== null) {
      this.clearTimerFn(this.timerHandle);
      this.timerHandle = null;
    }
    this.t1At = this.t2At = this.t3At = this.sackAt = this.reconfAt = 0;
    this.buffered = 0;
    if (!notify) return;
    try {
      this.onCloseFn(reason);
    } catch (e) {
      this.reportError(e);
    }
  }

  private reportError(e: unknown): void {
    this.c.callbackErrors++;
    if (this.onErrorFn) {
      try {
        this.onErrorFn(e);
      } catch {
        /* ignore */
      }
      return;
    }
    queueMicrotask(() => {
      throw e;
    });
  }
}

const ZERO1 = new Uint8Array(1);
const EMPTY_LIST: number[] = [];
const DCEP_ACK = new Uint8Array([0x02]);
