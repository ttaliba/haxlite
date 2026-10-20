/**
 * HostTransport: everything between the master server and decoded peer
 * messages, for the phase-2 host (`src/host`).
 *
 * ```
 *  master WS ── offer ─▶ admission (4104, bans 4102, rate, full 4100, version 4103,
 *                        password 4101, async onJoinRequest hook)      ── no WebRTC yet
 *            ◀─ answer + trickle ICE ─ node-datachannel PeerConnection (3 negotiated channels)
 *  channel 0 open ─▶ challenge ─▶ handshake (auth blob + join info) ─▶ ECDSA verify
 *            ─▶ onPeerJoin(peer, info) ─▶ onPeerMessage(peer, bytes, channel) … onPeerClose
 * ```
 *
 * Official references: `Aa` (signaling), `la` (negotiating peer), `Ya`
 * (connected peer), `Wa.Xg/Ah/Jh/Lh/Mg` (admission, challenge, message entry,
 * handshake, kick). Behavior and defaults match the official host; extensions
 * (CIDR/auth bans, join rate limit, pre-join hook, allowNullAuth=false) are
 * opt-in.
 *
 * Where the player PeerConnections live is a {@link PeerBackend}: this
 * process — node-datachannel ({@link LocalPeerBackend}, `peerBackend: 'ndc'`,
 * default) or haxlite-rtc ({@link RtcPeerBackend}, `peerBackend: 'rtc'`: pure
 * TypeScript ICE-lite, one UDP port, needs a public address; docs/10) — or a
 * remote haxlite Edge (`edge: {url, key}` → `EdgePeerBackend`, docs/09), which
 * keeps this machine's address away from players. Everything above (admission, answer
 * timing, challenge, handshake, flood, timeouts, bans) is identical for both.
 *
 * Usage:
 * ```ts
 * const t = new HostTransport({ token, public: true, roomInfo: { name: 'My room' } });
 * t.onPeerJoin = (peer, info) => { … t.send(peer, Channel.ReliableOrdered, snapshot); };
 * t.onPeerMessage = (peer, bytes, channel) => { … };
 * t.onPeerClose = (peer, reason) => { … };
 * t.start();
 * ```
 */
import { PROTOCOL_VERSION } from '../protocol.js';
import { createChallenge, verifyAuthBlob } from './auth.js';
import { BanList, type BanRecord } from './bans.js';
import { DEFAULT_ICE_SERVERS, DEFAULT_ROOM_LINK_BASE, MAX_REMOTE_CANDIDATES, NetDefaults, RejectCode } from './constants.js';
import { EdgePeerBackend, type EdgeOptions } from './edge-client.js';
import { encodeChallenge, encodeKick, parseHandshake, parseJoinInfo, type JoinPlayerInfo } from './handshake.js';
import {
  candidateLine,
  classifyAddress,
  filterCandidate,
  filterSdp,
  parseCandidate,
  sdpMids,
  srflxAddress,
  toNativeIceServers,
  type IceCandidateInit,
  type IceCandidatePolicy,
  type IceServerConfig,
  type NativeIceServer,
} from './ice.js';
import { canonicalIp } from './ip.js';
import { KeyedRateLimiter, TokenBucket } from './rate-limit.js';
import { defaultRoomInfo, encodeRoomInfo, type RoomInfo } from './room-info.js';
import { HostSignaling, type HostSignalingOptions, type SignalingOffer } from './signaling.js';
import { Writer } from '../codec/index.js';
import { LocalPeerBackend, type PeerBackend, type PeerLink, type PeerLinkEvents } from './peer-backend.js';
import { RtcPeerBackend, type RtcBackendOptions } from './rtc-backend.js';
import type { NdcRtcConfig } from './webrtc.js';

/** Lifecycle of a {@link Peer}. */
export type PeerState =
  /** Offer accepted by the sync checks; waiting for the async `onJoinRequest` hook. */
  | 'validating'
  /** WebRTC negotiation in progress (counts toward the 16 pending limit). */
  | 'negotiating'
  /** Channel 0 open, challenge sent, waiting for the handshake. */
  | 'challenged'
  /** Handshake received, verifying the signature. */
  | 'verifying'
  /** Announced to the host with onPeerJoin. */
  | 'joined'
  | 'closed';

export type PeerCloseReason =
  /** The remote side closed a channel or the connection failed/closed. */
  | 'closed'
  /**
   * No message for 10 s (`Ya.Qh`), or no handshake within
   * {@link NetDefaults.staleChallengeMs} while the room is full and a new
   * connection needs the seat.
   */
  | 'timeout'
  /** Flood bucket exhausted (official `r.l(1)`; host should kick with "Bad actor"). */
  | 'flood'
  /** Malformed/unexpected message (host should kick with "Bad actor"). */
  | 'protocol'
  /** {@link HostTransport.kick}. */
  | 'kicked'
  /** {@link HostTransport.close} by the host. */
  | 'host'
  /** Room full when channel 0 opened. */
  | 'full'
  /** Auth required (`allowNullAuth: false`) and verification failed. */
  | 'auth'
  /** Banned `auth`. */
  | 'banned'
  /** Negotiation failed/timed out before channel 0 opened. */
  | 'failed'
  /** Transport stopped or signaling lost during negotiation. */
  | 'shutdown';

/** `mids` of an offer with one m-section whose mid is `0` (every HaxBall client): shared by all peers. */
const SINGLE_MID: readonly string[] = Object.freeze(['0']);

/** A client connection. Fields are read-only for the host except `playerId`/`userData`. */
export class Peer {
  /** Master-assigned negotiation id (u32), unique per signaling session. */
  readonly id: number;
  /** Official `player.conn` (uppercase hex of the master's IP text). */
  readonly conn: string;
  /** Client IP as seen by the master. */
  readonly ip: string;
  /** srflx IPs from the offer and trickled candidates (`la.Tb`). */
  readonly srflxIps: string[];
  /** Offer came with the "reverse connection" retry flag. */
  readonly reverse: boolean;
  state: PeerState = 'validating';
  closeReason: PeerCloseReason | null = null;
  /** Verified public key (`player.auth`), null if verification failed. */
  auth: string | null = null;
  /** Parsed join info (set when joined). */
  info: JoinPlayerInfo | null = null;
  /** Free for the host (e.g. the player id it assigned). */
  playerId = -1;
  /** Free for the host. */
  userData: unknown = null;
  // Numeric initializers (not bare declarations, which define the field as
  // `undefined` first): the field gets a double representation and the
  // per-message store of `now` updates it in place instead of boxing a new
  // HeapNumber every time.
  readonly createdAt: number = 0;
  /** performance.now() of the last message received (idle timeout). */
  lastMessageAt = 0;

  /**
   * Remote address of the selected ICE pair once channel 0 opened (what the
   * player's packets come from; with an edge backend, as seen by the edge).
   */
  remoteAddress: string | null = null;

  /** @internal connection in the peer backend (local PeerConnection or edge slot) */ link: PeerLink | null = null;
  /** @internal */ readonly channelOpen: boolean[] = [false, false, false];
  /** @internal */ bucket: TokenBucket | null = null;
  /** @internal */ challenge: Uint8Array | null = null;
  /** @internal */ challengeDue = false;
  /** @internal */ challengeSent = false;
  /** @internal ms between channel-0 open and the challenge (set at negotiation) */ challengeDelay = 0;
  /** @internal signaling `[0][peer]` already sent (`la.qf`). */ endSent = false;
  /** @internal */ answerSent = false;
  /** @internal */ gatheringDone = false;
  /** @internal one-shot timer: answer ICE wait, then challenge delay */ timer: NodeJS.Timeout | null = null;
  /** @internal answer SDP until it is sent (then released) */ localSdp: string | null = null;
  /** @internal candidates for the answer (emptied once it is sent) */ readonly localCandidates: IceCandidateInit[] = [];
  /** @internal candidates received while 'validating' */ queuedRemote: IceCandidateInit[] = [];
  /** @internal when a deferred close started (see CLOSE_LINGER_MS) */ closedAt = 0;
  /** @internal remote candidates accepted so far (capped by MAX_REMOTE_CANDIDATES) */ remoteCandidates = 0;
  /** @internal mids of the offer's m-sections (usually the shared {@link SINGLE_MID}) */ mids: readonly string[] = SINGLE_MID;
  /** @internal canonical `ip` for the per-address limits; null when exempt (not a public address) */ limitKey: string | null = null;

  constructor(offer: SignalingOffer, srflxIps: string[], now: number) {
    this.id = offer.peerId;
    this.conn = offer.conn;
    this.ip = offer.ip;
    this.srflxIps = srflxIps;
    this.reverse = offer.reverse;
    this.remoteCandidates = offer.candidates.length;
    this.createdAt = now;
    this.lastMessageAt = now;
  }

  /** Every IP known for this peer (conn IP first), as banned by an official kick-ban. */
  get ips(): string[] {
    const out = [this.ip];
    for (const ip of this.srflxIps) if (out.indexOf(ip) < 0) out.push(ip);
    return out;
  }
}

/** Data given to the pre-join hook (before any WebRTC object is created). */
export interface JoinRequest {
  peerId: number;
  conn: string;
  ip: string;
  srflxIps: readonly string[];
  /** All candidate addresses in the offer (host/srflx/relay, may include mDNS names). */
  candidateAddresses: readonly string[];
  reverse: boolean;
  version: number;
  password: string | null;
}

/**
 * Hook result: `undefined`/`true`/`{accept: true}` accepts; `false` rejects
 * with 4102; a number or `{reject: code}` rejects with that close code.
 */
export type JoinDecision = void | boolean | number | { accept: true } | { reject: number };

/** Everything known about a joining player, given to onPeerJoin. */
export interface JoinInfo extends JoinPlayerInfo {
  auth: string | null;
  conn: string;
  ip: string;
  srflxIps: readonly string[];
}

export interface HostTransportOptions extends Omit<HostSignalingOptions, 'token'> {
  /** Headless token from https://www.haxball.com/headlesstoken. */
  token: string;
  /**
   * STUN/TURN servers (default Google STUN, like the official host): libdatachannel
   * URLs (`stun:host:port`, `turn:user:pass@host:port?transport=tcp`, `turns:…`),
   * node-datachannel objects or browser `RTCIceServer`s (`{urls, username, credential}`).
   * For relay-only operation add `rtc: { iceTransportPolicy: 'relay' }` (also
   * honoured by `peerBackend: 'rtc'`, whose TURN client is UDP-only:
   * `turns:` and `?transport=tcp` entries are skipped there). Replace them at
   * runtime (short-lived TURN credentials) with {@link HostTransport.setIceServers}.
   */
  iceServers?: readonly IceServerConfig[];
  /**
   * Which of the host's own ICE candidates (and SDP connection address) are
   * sent to clients. Default `'public'`: LAN/link-local/loopback addresses of
   * the server are never revealed (clients only need srflx/public
   * candidates). `'private'` also sends LAN addresses, `'all'` everything
   * (local tests over loopback). See {@link IceCandidatePolicy}.
   */
  iceCandidatePolicy?: IceCandidatePolicy;
  /**
   * Local UDP port range for ICE (firewall-friendly deployment), shorthand for
   * `rtc.portRangeBegin/portRangeEnd`. With the default UDP mux every
   * connection shares `portRange[0]`; with `rtc.enableIceUdpMux: false`
   * each connection uses its own port of the range.
   */
  portRange?: readonly [number, number] | null;
  /** List the room publicly (send RoomInfo, message 7). Default false (HBInit default). */
  public?: boolean;
  password?: string | null;
  /** Capacity checked against open connections (4100). The API clamps to [2, 30]. Default 12. */
  maxPlayers?: number;
  /** Protocol version required from clients (4103). Default 9. */
  version?: number;
  /** Initial RoomInfo fields (name, flag, lat, lon, players). */
  roomInfo?: Partial<Omit<RoomInfo, 'version' | 'password' | 'maxPlayers'>>;
  /** Let players whose signature fails join with `auth = null` (official). Default true. */
  allowNullAuth?: boolean;
  /** Shared ban list (default: a new one). */
  bans?: BanList;
  /**
   * Async admission hook evaluated after the official checks, before WebRTC.
   * Any thenable is awaited (not only this realm's `Promise`); a value that is
   * not a {@link JoinDecision} (e.g. `NaN`, `{reject: undefined}`, a string)
   * is reported to onError and rejects with 4104, like a hook that throws.
   */
  onJoinRequest?: (req: JoinRequest) => JoinDecision | PromiseLike<JoinDecision>;
  /** Per-IP join attempt limit (not official; default off). `code` default 4104. */
  joinRateLimit?: { capacity: number; msPerToken: number; code?: number } | null;
  floodCapacity?: number;
  floodMsPerToken?: number;
  /** Max simultaneous negotiations (4104). A positive integer; default 16 (official). */
  maxPendingNegotiations?: number;
  /**
   * haxlite: max connections from one address that have not joined yet
   * (negotiating, awaiting the hook, challenged or verifying); more offers
   * from it are refused with 4104. Default {@link NetDefaults.maxUnjoinedPerIp}
   * (8); `Infinity` disables it. Only public addresses are counted: a
   * loopback/private one (local tests, a proxied master) is exempt.
   */
  maxUnjoinedPerIp?: number;
  /**
   * haxlite: per-address penalty after abusive closes (`'flood'`,
   * `'protocol'`, or `'timeout'` before the handshake): see
   * {@link NetDefaults.abusePenalty} (default 3 tokens, one back every 20 s,
   * then 30 s of 4104). `null` disables it. Public addresses only, like
   * {@link maxUnjoinedPerIp}.
   */
  abusePenalty?: { capacity: number; msPerToken: number; blockMs: number } | null;
  /**
   * haxlite (default true): IP bans rely on addresses the host has verified.
   * A kick-ban stores the conn IP and the public address of the selected ICE
   * pair (where the player's packets come from), not the srflx IPs the
   * client declares (which could be anyone's); at the handshake that address
   * is checked against the bans, and so are public `host`/`prflx` candidates
   * of the offer. `false`: official behaviour (conn + declared srflx only).
   */
  verifiedIpBans?: boolean;
  /** Channel 0 must open within this time (ms, finite, > 0). Default 10000 (official). */
  channelOpenTimeoutMs?: number;
  /** Connected peer idle timeout (ms, finite, > 0). Default 10000 (official). */
  peerIdleTimeoutMs?: number;
  /**
   * Max wait for local ICE gathering before sending the answer (default 500
   * ms, official `ub.li`). Backends with `answerOnFirstCandidate`
   * (node-datachannel) answer as soon as one candidate passes
   * `iceCandidatePolicy` and trickle the rest, so this is only the fallback
   * when no allowed candidate shows up (e.g. an unreachable STUN server behind
   * NAT with the `'public'` policy).
   */
  answerIceWaitMs?: number;
  reverseIceDelayMs?: number;
  /** Room link prefix (default `https://www.haxball.com/play?c=`). */
  roomLinkBase?: string;
  /**
   * Extra node-datachannel config: `bindAddress`, `portRangeBegin/End`,
   * `enableIceUdpMux` (default **true** in haxlite: all peers share one UDP
   * socket — 1 fd instead of 1 per player and ≈ −6 % host CPU with 20
   * players, docs/07 «Pasada de ligereza — red»; set it to false to give
   * each connection its own port, e.g. per-player `bindAddress`), `iceTransportPolicy`,
   * `maxMessageSize`, `mtu`, `proxyServer`…, plus haxlite's `ipv6` (default
   * false: IPv4 only, see {@link NdcRtcConfig}). For `peerBackend: 'rtc'`
   * use {@link rtcEndpoint} (`rtcEndpoint.ipv6`) instead.
   */
  rtc?: Partial<Omit<NdcRtcConfig, 'iceServers'>>;
  /** Housekeeping period (timeouts, deferred closes). Default 1000 ms. */
  sweepIntervalMs?: number;
  /**
   * Delay between channel-0 open and the challenge, for every client (official:
   * 0). Default: 10 ms for libdatachannel-based clients (node-haxball bots,
   * offer origin `o=rtc `), which drop a message that arrives before they
   * report their channels open (see `maybeSendChallenge`; docs/10 measured
   * 0/30 failures with 10 ms on both backends, 29/30 with 0 ms on `rtc`), and
   * 0 for everyone else (browsers, like the official host). The delay protects
   * the client side, whatever the server stack.
   */
  challengeDelayMs?: number;
  /** Debug logger (peer lifecycle). */
  log?: (msg: string) => void;
  /**
   * haxlite Edge: player WebRTC connections are terminated by a remote edge
   * (reached through an outbound tunnel) so players never see this machine's
   * address. `iceServers`, `iceCandidatePolicy`, `portRange` and `rtc` then
   * only describe the edge's own settings (configured on the edge).
   * See docs/09-haxlite-edge.md.
   */
  edge?: EdgeOptions | null;
  /** Custom peer backend (advanced; overrides `edge` and `peerBackend`). */
  backend?: PeerBackend | null;
  /**
   * Where player connections are terminated when there is no `edge`:
   * `'ndc'` (default) node-datachannel/libdatachannel — full ICE with STUN,
   * works behind NAT; `'rtc'` haxlite-rtc (`src/rtc`) — pure TypeScript
   * ICE/DTLS/SCTP, every player on one UDP port, no native threads, about
   * half the CPU per player; also full ICE with STUN by default (works behind
   * NAT), or ICE-lite with `rtcEndpoint.iceLite`. With `'rtc'`, `iceServers`
   * and `iceCandidatePolicy` are the defaults of {@link rtcEndpoint}'s own;
   * `portRange` and `rtc` are ignored. See docs/10.
   */
  peerBackend?: 'ndc' | 'rtc';
  /** `peerBackend: 'rtc'` settings: UDP `port`, bind `address`, `publicAddresses`, timeouts… */
  rtcEndpoint?: RtcBackendOptions | null;
}

/** Default challenge delay for libdatachannel clients, see {@link HostTransportOptions.challengeDelayMs}. */
const LIBDATACHANNEL_CHALLENGE_DELAY_MS = 10;

/**
 * The offer comes from libdatachannel (node-datachannel, node-haxball): its
 * SDP origin line is `o=rtc …` (Chrome/Safari write `o=- …`, Firefox
 * `o=mozilla…`).
 */
export function isLibdatachannelOffer(sdp: string): boolean {
  return sdp.startsWith('o=rtc ') || sdp.indexOf('\no=rtc ') >= 0;
}
/** Minimum time between a deferred close (kick) and the native close, so the notice is delivered first. */
const CLOSE_LINGER_MS = 500;
/** See {@link HostTransportOptions.answerIceWaitMs} (official {@link NetDefaults.answerIceWaitMs}). */
const DEFAULT_ANSWER_ICE_WAIT_MS = NetDefaults.answerIceWaitMs;

/**
 * A count limit: a positive integer, or `Infinity` (no limit) where allowed.
 * `NaN` (e.g. `Number(process.env.X)` unset) would silently disable a `>=` check.
 */
function checkLimit(name: string, v: number | null | undefined, def: number, unbounded: boolean): number {
  if (v == null) return def;
  if (typeof v !== 'number' || !(v >= 1) || (v === Infinity ? !unbounded : !Number.isInteger(v))) {
    throw new RangeError(`${name} must be an integer >= 1${unbounded ? ' or Infinity' : ''} (got ${String(v)})`);
  }
  return v;
}

/** A duration in ms: finite and > 0 (`Infinity`/`NaN` would never expire, 0 would expire everything). */
function checkMs(name: string, v: number | null | undefined, def: number): number {
  if (v == null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`${name} must be a finite number of ms > 0 (got ${String(v)})`);
  }
  return v;
}

/** Key for the per-address limits: the canonical IP when public, null (exempt) otherwise. */
function limitKeyOf(ip: string): string | null {
  return classifyAddress(ip) === 'public' ? canonicalIp(ip) : null;
}

const isCloseCode = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffff;

/**
 * `onJoinRequest` result as a close code (`-1` accepts), or null when it is
 * not a {@link JoinDecision}. Codes are sent as u16.
 */
function decisionCode(d: unknown): number | null {
  if (d === undefined || d === null || d === true) return -1;
  if (d === false) return RejectCode.Banned;
  if (typeof d === 'number') return isCloseCode(d) ? d : null;
  if (typeof d === 'object') {
    if ('reject' in d) {
      const code = (d as { reject: unknown }).reject;
      return typeof code === 'number' && isCloseCode(code) ? code : null;
    }
    if ((d as { accept?: unknown }).accept === true) return -1;
  }
  return null;
}

export class HostTransport {
  readonly bans: BanList;
  readonly signaling: HostSignaling;

  /** Room link (`play?c=<id>[&p=1]`) every time the master assigns the room id. */
  onRoomLink: ((link: string, roomId: string) => void) | null = null;
  /** A verified player is ready: send it the snapshot. */
  onPeerJoin: ((peer: Peer, info: JoinInfo) => void) | null = null;
  /**
   * A message from a joined peer (raw bytes, type byte first). Flood-checked
   * already. `data` is only valid during the call (the `rtc` backend may hand
   * out a view of a reused buffer): copy it to keep it.
   */
  onPeerMessage: ((peer: Peer, data: Uint8Array, channel: number) => void) | null = null;
  /** A joined peer is gone (not called for peers that never joined). */
  onPeerClose: ((peer: Peer, reason: PeerCloseReason) => void) | null = null;
  /** A join was refused at signaling time (diagnostics). */
  onJoinRejected: ((req: { peerId: number; ip: string; conn: string }, code: number, why: string) => void) | null = null;
  /** The master wants a captcha (token invalid/expired). */
  onRecaptcha: ((sitekey: string) => void) | null = null;
  onError: ((err: Error) => void) | null = null;
  /**
   * Peer backend availability: `'ready'` (joins accepted), `'down'` (edge
   * tunnel lost: every player was disconnected, joins are refused with 4104
   * until it reconnects). Local backends are always ready.
   */
  onBackendState: ((state: 'ready' | 'down', err: Error | null) => void) | null = null;

  private readonly opts: HostTransportOptions;
  /** Where the player PeerConnections live (this process or a haxlite Edge). */
  readonly backend: PeerBackend;
  private readonly icePolicy: IceCandidatePolicy;
  private signalingStarted = false;
  private readonly reportError = (err: unknown): void => {
    const e = err instanceof Error ? err : new Error(String(err));
    const h = this.onError;
    try {
      if (h !== null) h(e);
      else console.error('[haxlite/net]', e);
    } catch {
      /* never propagate */
    }
  };
  private readonly pending = new Map<number, Peer>();
  /** Peers with channel 0 open (official `Ha`), joined or not. */
  private connected: Peer[] = [];
  /** Joined peers (official `dd`), in join order. Broadcast target. */
  private readonly joined: Peer[] = [];
  private readonly deferredDestroy: Peer[] = [];
  private readonly joinLimiter: KeyedRateLimiter | null;
  private readonly maxPending: number;
  private readonly maxUnjoinedPerIp: number;
  private readonly channelOpenTimeoutMs: number;
  private readonly peerIdleTimeoutMs: number;
  private readonly verifiedIpBans: boolean;
  /** Abusive closes per address ({@link HostTransportOptions.abusePenalty}). */
  private readonly abuseStrikes: KeyedRateLimiter | null;
  private readonly abuseBlockMs: number;
  /** Address -> time until which its offers are refused. */
  private readonly blockedUntil = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private running = false;

  private password: string | null;
  private maxPlayers: number;
  private isPublic: boolean;
  private readonly roomInfo: RoomInfo;
  private readonly roomInfoWriter = new Writer(64);

  /**
   * Replaces the STUN/TURN servers at runtime, e.g. fresh short-lived TURN
   * credentials (Cloudflare's `generate-ice-servers`). `'rtc'`: the next TURN
   * Allocate uses them (the current allocation keeps its credentials until
   * the server refuses them, then it is re-made; see docs/10). `'ndc'`: new
   * PeerConnections use them. Ignored by an edge backend.
   */
  setIceServers(list: readonly IceServerConfig[]): void {
    this.backend.setIceServers?.(list);
  }

  constructor(opts: HostTransportOptions) {
    this.opts = opts;
    this.maxPending = checkLimit('maxPendingNegotiations', opts.maxPendingNegotiations, NetDefaults.maxPendingNegotiations, false);
    this.maxUnjoinedPerIp = checkLimit('maxUnjoinedPerIp', opts.maxUnjoinedPerIp, NetDefaults.maxUnjoinedPerIp, true);
    this.channelOpenTimeoutMs = checkMs('channelOpenTimeoutMs', opts.channelOpenTimeoutMs, NetDefaults.channelOpenTimeoutMs);
    this.peerIdleTimeoutMs = checkMs('peerIdleTimeoutMs', opts.peerIdleTimeoutMs, NetDefaults.peerIdleTimeoutMs);
    this.verifiedIpBans = opts.verifiedIpBans ?? true;
    const ap = opts.abusePenalty === undefined ? NetDefaults.abusePenalty : opts.abusePenalty;
    const apd = NetDefaults.abusePenalty;
    this.abuseStrikes =
      ap === null
        ? null
        : new KeyedRateLimiter(
            checkLimit('abusePenalty.capacity', ap.capacity, apd.capacity, false),
            checkMs('abusePenalty.msPerToken', ap.msPerToken, apd.msPerToken),
          );
    this.abuseBlockMs = ap === null ? 0 : checkMs('abusePenalty.blockMs', ap.blockMs, apd.blockMs);
    if (opts.backend != null) this.backend = opts.backend;
    else if (opts.edge != null) this.backend = new EdgePeerBackend(opts.edge);
    else if (opts.peerBackend === 'rtc') {
      this.backend = new RtcPeerBackend(opts.rtcEndpoint ?? {}, {
        ...(opts.iceServers !== undefined ? { iceServers: opts.iceServers } : null),
        ...(opts.iceCandidatePolicy !== undefined ? { iceCandidatePolicy: opts.iceCandidatePolicy } : null),
        ...(opts.rtc?.iceTransportPolicy === 'relay' ? { iceTransportPolicy: 'relay' as const } : null),
      });
    }
    else {
      if (opts.peerBackend !== undefined && opts.peerBackend !== 'ndc') {
        throw new TypeError(`peerBackend must be 'ndc' or 'rtc' (got ${JSON.stringify(opts.peerBackend)})`);
      }
      const iceServers: (string | NativeIceServer)[] = toNativeIceServers(opts.iceServers ?? DEFAULT_ICE_SERVERS);
      const range = opts.portRange;
      const rtc: NdcRtcConfig = {
        enableIceUdpMux: true,
        ...(range ? { portRangeBegin: range[0], portRangeEnd: range[1] } : null),
        ...opts.rtc,
        iceServers,
      };
      this.backend = new LocalPeerBackend({ rtc });
    }
    // an edge filters its own addresses with its own policy
    this.icePolicy = this.backend.prefiltered ? 'all' : (opts.iceCandidatePolicy ?? 'public');
    this.bans = opts.bans ?? new BanList();
    this.password = opts.password ?? null;
    this.maxPlayers = opts.maxPlayers ?? 12;
    this.isPublic = opts.public ?? false;
    this.roomInfo = { ...defaultRoomInfo(), ...opts.roomInfo, version: opts.version ?? PROTOCOL_VERSION };
    this.roomInfo.password = this.password !== null;
    this.roomInfo.maxPlayers = this.maxPlayers;
    const rl = opts.joinRateLimit;
    this.joinLimiter = rl ? new KeyedRateLimiter(rl.capacity, rl.msPerToken) : null;
    this.signaling = new HostSignaling(
      { ...opts },
      {
        onRoomId: (id) => this.callUser(() => this.onRoomLink?.(this.roomLink ?? '', id)),
        onOfferPreflight: (peerId, ip, conn) => {
          try {
            return this.preflight(peerId, ip, conn);
          } catch (err) {
            this.reportError(err);
            this.signaling.sendReject(peerId, RejectCode.TooManyPending);
            return false;
          }
        },
        onOffer: (offer) => this.safely(() => this.handleOffer(offer)),
        onCandidate: (peerId, c) => this.safely(() => this.handleRemoteCandidate(peerId, c)),
        onDisconnect: () => this.safely(() => this.dropPending('shutdown')),
        onRecaptcha: (sitekey) => this.callUser(() => this.onRecaptcha?.(sitekey)),
        onError: (err) => this.reportError(err),
      },
    );
  }

  // ================================================================== lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.publishRoomInfo();
    // The master only learns about the room once the backend can take joins
    // (immediately for the local backend, after the first tunnel for an edge).
    this.backend.start({
      onReady: () =>
        this.safely(() => {
          if (!this.running) return;
          if (!this.signalingStarted) {
            this.signalingStarted = true;
            this.signaling.start();
          }
          this.callUser(() => this.onBackendState?.('ready', null));
        }),
      onDown: (err) =>
        this.safely(() => {
          if (this.running) this.callUser(() => this.onBackendState?.('down', err));
        }),
      onError: (err) => this.reportError(err),
    });
  }

  /**
   * Arms the housekeeping timer. It only runs while there is something to
   * sweep (a negotiation, a connected peer, a deferred close or join-rate
   * state): an empty room has no periodic timer besides the signaling
   * keep-alive.
   */
  private ensureSweep(): void {
    if (this.sweepTimer !== null || !this.running) return;
    this.sweepTimer = setInterval(this.sweepTick, this.opts.sweepIntervalMs ?? 1000);
  }

  private readonly sweepTick = (): void => {
    this.safely(() => this.sweep());
    if (
      this.sweepTimer !== null &&
      this.pending.size === 0 &&
      this.connected.length === 0 &&
      this.deferredDestroy.length === 0 &&
      (this.joinLimiter === null || this.joinLimiter.size === 0) &&
      (this.abuseStrikes === null || this.abuseStrikes.size === 0) &&
      this.blockedUntil.size === 0
    ) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  };

  /** Closes signaling and every peer (joined peers get onPeerClose 'shutdown'). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.signaling.stop();
    this.signalingStarted = false;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.dropPending('shutdown');
    for (const p of [...this.connected]) this.closePeer(p, 'shutdown');
    for (const p of this.deferredDestroy) this.destroyNative(p);
    this.deferredDestroy.length = 0;
    this.backend.stop();
  }

  /** Runs internal code from a timer/socket/native callback: never throws. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.reportError(err);
    }
  }

  /** Calls a user callback: its exceptions are reported to onError, never propagated. */
  private callUser(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.reportError(err);
    }
  }

  private log(msg: string): void {
    const l = this.opts.log;
    if (l !== undefined) this.callUser(() => l(msg));
  }

  get roomId(): string | null {
    return this.signaling.roomId;
  }

  /** `https://www.haxball.com/play?c=<id>` + `&p=1` with a password (`F.uh`). */
  get roomLink(): string | null {
    const id = this.signaling.roomId;
    if (id === null) return null;
    return (this.opts.roomLinkBase ?? DEFAULT_ROOM_LINK_BASE) + id + (this.password !== null ? '&p=1' : '');
  }

  /** Joined peers in join order (do not mutate). */
  get peers(): readonly Peer[] {
    return this.joined;
  }

  /** Negotiations in progress (incl. those awaiting the join hook). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Open connections (joined + handshaking), the number compared with maxPlayers. */
  get connectionCount(): number {
    return this.connected.length;
  }

  // ================================================================== room settings

  setPassword(password: string | null): void {
    this.password = password;
    this.roomInfo.password = password !== null;
    this.publishRoomInfo();
  }

  setMaxPlayers(n: number): void {
    this.maxPlayers = n;
    this.roomInfo.maxPlayers = n;
    this.publishRoomInfo();
  }

  /**
   * Public rooms publish RoomInfo. Turning it off stops further updates; the
   * master keeps the last published RoomInfo until the signaling reconnects
   * (the official host cannot change visibility at runtime).
   */
  setPublic(on: boolean): void {
    this.isPublic = on;
    this.publishRoomInfo();
  }

  /** Updates RoomInfo fields (name, flag, lat, lon, players) and republishes if public. */
  setRoomInfo(info: Partial<Omit<RoomInfo, 'version' | 'password' | 'maxPlayers'>>): void {
    Object.assign(this.roomInfo, info);
    this.publishRoomInfo();
  }

  getRoomInfo(): Readonly<RoomInfo> {
    return this.roomInfo;
  }

  /** Ask the master to require a captcha from joining clients (message 9). */
  setRequireRecaptcha(on: boolean): void {
    this.signaling.setRequireRecaptcha(on);
  }

  /** Retry the master HTTP step with a captcha response. */
  useRecaptchaToken(rcr: string): void {
    this.signaling.useRecaptchaToken(rcr);
  }

  private publishRoomInfo(): void {
    if (!this.isPublic) return;
    this.signaling.setRoomInfo(encodeRoomInfo(this.roomInfo, this.roomInfoWriter));
  }

  // ================================================================== sending

  /**
   * Sends `data` to one peer (`Ya.pb`). Falls back to channel 0 when the
   * requested channel is not open. Returns false if nothing was sent.
   */
  send(peer: Peer, channel: number, data: Uint8Array): boolean {
    if (peer.state === 'closed') return false;
    let ch = channel;
    if (ch !== 0 && !peer.channelOpen[ch]) ch = 0;
    const link = peer.link;
    if (!peer.channelOpen[ch] || link === null) return false;
    return link.send(ch, data);
  }

  /**
   * Sends the same bytes to `targets[i].peer` for every target (HostRoom's
   * broadcast list). With an edge backend this is one tunnel message.
   */
  broadcastTo(targets: readonly { readonly peer: Peer }[], channel: number, data: Uint8Array): void {
    const many = this.backend.sendMany;
    if (many === undefined || targets.length < 2) {
      for (let i = 0; i < targets.length; i++) this.send(targets[i]!.peer, channel, data);
      return;
    }
    // Reused by index: `length = 0` would drop V8's backing store and the next
    // pushes reallocate it (≈ 0.5 KB per broadcast with 20 players). The
    // length only changes when the number of targets does; the slots are
    // cleared afterwards so no closed link is kept alive.
    const links = this.linkScratch;
    let n = 0;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i]!.peer;
      if (p.state !== 'closed' && p.link !== null && p.channelOpen[0]) links[n++] = p.link;
    }
    if (n === 0) return;
    if (links.length !== n) links.length = n;
    many.call(this.backend, links as PeerLink[], channel, data);
    for (let i = 0; i < n; i++) links[i] = undefined;
  }
  private readonly linkScratch: (PeerLink | undefined)[] = [];

  /** Sends the same bytes to every joined peer (`Wa.jd`), optionally skipping one. */
  broadcast(channel: number, data: Uint8Array, except: Peer | null = null): void {
    const list = this.joined;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      if (p !== except) this.send(p, channel, data);
    }
  }

  // ================================================================== moderation

  /** Closes a peer without notice to the client. */
  close(peer: Peer, reason: PeerCloseReason = 'host'): void {
    this.closePeer(peer, reason);
  }

  /**
   * `Wa.Mg`: sends `[5][u8 ban][reason][byName]` on channel 0, optionally bans
   * (see {@link banPeer}; plus `auth` with `banAuth`), then closes. Returns the
   * ban record (keep its id for clearBan). The KickBanPlayer event broadcast
   * is the host's job.
   */
  kick(peer: Peer, opts: { reason?: string; ban?: boolean; byName?: string | null; banAuth?: boolean } = {}): BanRecord | null {
    let rec: BanRecord | null = null;
    if (opts.ban) rec = this.banPeer(peer, { auth: opts.banAuth ?? false });
    this.send(peer, 0, encodeKick(opts.reason ?? '', opts.ban ?? false, opts.byName ?? null));
    this.closePeer(peer, 'kicked', true);
    return rec;
  }

  /**
   * Kick-ban storage (+ auth if asked): conn IP + the public address of the
   * selected ICE pair with `verifiedIpBans` (default), or the official
   * `Aa.vg` conn IP + declared srflx IPs ({@link Peer.ips}) without it.
   */
  banPeer(peer: Peer, opts: { auth?: boolean; note?: string | null } = {}): BanRecord {
    const ips = this.verifiedIpBans ? this.verifiedIps(peer) : peer.ips;
    return this.bans.addPeer(ips, opts.auth ? peer.auth : null, opts.note ?? peer.info?.name ?? null);
  }

  /**
   * Addresses the host has seen for itself: the conn IP (from the master) and
   * the selected pair's remote address when public (a private/loopback one
   * may be shared by every player, e.g. behind a proxy).
   */
  private verifiedIps(peer: Peer): string[] {
    const out = [peer.ip];
    const ra = peer.remoteAddress;
    if (ra !== null && classifyAddress(ra) === 'public') {
      const c = canonicalIp(ra);
      if (c !== null && c !== canonicalIp(peer.ip)) out.push(c);
    }
    return out;
  }

  // ================================================================== admission

  private reject(offer: { peerId: number; ip: string; conn: string }, code: number, why: string): void {
    this.signaling.sendReject(offer.peerId, code);
    const cb = this.onJoinRejected;
    if (cb !== null) this.callUser(() => cb({ peerId: offer.peerId, ip: offer.ip, conn: offer.conn }, code, why));
  }

  /**
   * Checks that only need the conn address, run before the offer payload is
   * inflated and parsed: `Aa.$g` (pending, conn ban), haxlite's per-address
   * limits, `joinRateLimit` and `Wa.Xg` capacity. False: the offer is dropped.
   */
  private preflight(peerId: number, ip: string, conn: string): boolean {
    if (!this.running) return false;
    // ids are unique per signaling session: any answer to a repeat would reach the live negotiation
    if (this.pending.has(peerId)) {
      this.log(`peer ${peerId}: duplicate offer ignored`);
      return false;
    }
    if (!this.backend.ready) return this.refuse(peerId, ip, conn, RejectCode.TooManyPending, `${this.backend.kind} backend not ready`);
    if (this.pending.size >= this.maxPending) {
      return this.refuse(peerId, ip, conn, RejectCode.TooManyPending, 'too many pending negotiations');
    }
    if (this.bans.isIpBanned(ip)) return this.refuse(peerId, ip, conn, RejectCode.Banned, 'banned conn');
    const now = performance.now();
    const key = limitKeyOf(ip);
    if (key !== null) {
      const until = this.blockedUntil.get(key);
      if (until !== undefined && now < until) {
        return this.refuse(peerId, ip, conn, RejectCode.TooManyPending, 'address blocked after abusive connections');
      }
      if (this.maxUnjoinedPerIp !== Infinity && this.unjoinedFrom(key) >= this.maxUnjoinedPerIp) {
        return this.refuse(peerId, ip, conn, RejectCode.TooManyPending, 'too many unjoined connections from this address');
      }
    }
    if (this.joinLimiter !== null) {
      this.ensureSweep(); // prunes the limiter's buckets
      if (!this.joinLimiter.take(ip, now)) {
        return this.refuse(peerId, ip, conn, this.opts.joinRateLimit?.code ?? RejectCode.TooManyPending, 'join rate limit');
      }
    }
    // Wa.Xg
    if (this.connected.length >= this.maxPlayers && !this.evictStaleChallenged(now)) {
      return this.refuse(peerId, ip, conn, RejectCode.Full, 'room full');
    }
    return true;
  }

  private refuse(peerId: number, ip: string, conn: string, code: number, why: string): false {
    this.reject({ peerId, ip, conn }, code, why);
    return false;
  }

  /** Connections from `key` that have not joined: pending ones and those still handshaking. */
  private unjoinedFrom(key: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.limitKey === key) n++;
    const conns = this.connected;
    for (let i = 0; i < conns.length; i++) {
      const p = conns[i]!;
      if (p.limitKey === key && p.state !== 'joined') n++;
    }
    return n;
  }

  /**
   * Room full: closes the connection that has waited longest for its
   * handshake, once past {@link NetDefaults.staleChallengeMs}. False if none.
   */
  private evictStaleChallenged(now: number): boolean {
    let oldest: Peer | null = null;
    const conns = this.connected;
    for (let i = 0; i < conns.length; i++) {
      const p = conns[i]!;
      // a challenged peer has sent nothing yet: lastMessageAt is when channel 0 opened
      if (p.state !== 'challenged' || now - p.lastMessageAt < NetDefaults.staleChallengeMs) continue;
      if (oldest === null || p.lastMessageAt < oldest.lastMessageAt) oldest = p;
    }
    if (oldest === null) return false;
    this.log(`peer ${oldest.id}: no handshake, seat given to a new connection`);
    this.closePeer(oldest, 'timeout');
    return true;
  }

  /** `Aa.$g` (srflx bans) + `Wa.Xg` (version, password) + hook; the rest ran in {@link preflight}. */
  private handleOffer(offer: SignalingOffer): void {
    if (!this.running) return;
    if (this.pending.has(offer.peerId)) return; // see preflight
    const srflx: string[] = [];
    const addresses: string[] = [];
    const cands = offer.candidates;
    // only these are applied (signaling already drops the rest)
    const n = Math.min(cands.length, MAX_REMOTE_CANDIDATES);
    for (let i = 0; i < n; i++) {
      const parsed = parseCandidate(cands[i]!.candidate);
      if (parsed === null) continue;
      const ip = parsed.address;
      addresses.push(ip);
      if (parsed.type === 'srflx') {
        if (this.bans.isIpBanned(ip)) {
          this.reject(offer, RejectCode.Banned, 'banned srflx');
          return;
        }
        if (srflx.length < MAX_REMOTE_CANDIDATES && srflx.indexOf(ip) < 0) srflx.push(ip);
      } else if (
        this.verifiedIpBans &&
        (parsed.type === 'host' || parsed.type === 'prflx') &&
        classifyAddress(ip) === 'public' &&
        this.bans.isIpBanned(ip)
      ) {
        // a public address labelled host/prflx (LAN addresses are never checked)
        this.reject(offer, RejectCode.Banned, 'banned candidate');
        return;
      }
    }
    let version: number;
    try {
      version = offer.joinData.u16();
      if (version !== this.roomInfo.version) throw new Error('version');
    } catch {
      this.reject(offer, RejectCode.Version, 'incompatible version');
      return;
    }
    let password: string | null;
    try {
      password = offer.joinData.nullableString();
      if (this.password !== null && password !== this.password) throw new Error('password');
    } catch {
      this.reject(offer, RejectCode.WrongPassword, 'wrong password');
      return;
    }

    const peer = new Peer(offer, srflx, performance.now());
    peer.limitKey = limitKeyOf(offer.ip);
    this.pending.set(peer.id, peer);
    this.ensureSweep();
    const hook = this.opts.onJoinRequest;
    if (hook === undefined) {
      this.negotiate(peer, offer);
      return;
    }
    const req: JoinRequest = {
      peerId: offer.peerId,
      conn: offer.conn,
      ip: offer.ip,
      srflxIps: srflx,
      candidateAddresses: addresses,
      reverse: offer.reverse,
      version,
      password,
    };
    let result: unknown;
    try {
      result = hook(req);
      // any thenable (another realm's Promise, Bluebird…), not only `instanceof Promise`
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(result as PromiseLike<unknown>).then(
          (d) => this.safely(() => this.applyDecision(peer, offer, d)),
          (err) => this.safely(() => this.hookFailed(peer, offer, err)),
        );
        return;
      }
    } catch (err) {
      this.hookFailed(peer, offer, err);
      return;
    }
    this.applyDecision(peer, offer, result);
  }

  private hookFailed(peer: Peer, offer: SignalingOffer, err: unknown): void {
    this.reportError(err);
    this.applyDecision(peer, offer, RejectCode.TooManyPending);
  }

  private applyDecision(peer: Peer, offer: SignalingOffer, d: unknown): void {
    if (peer.state !== 'validating' || this.pending.get(peer.id) !== peer) return; // dropped meanwhile
    let code = decisionCode(d);
    if (code === null) {
      // fail closed: an admission filter must not let in what it meant to refuse
      this.reportError(new TypeError(`onJoinRequest returned an invalid decision (${typeof d === 'number' ? String(d) : typeof d})`));
      code = RejectCode.TooManyPending;
    }
    if (code >= 0) {
      this.pending.delete(peer.id);
      peer.state = 'closed';
      peer.closeReason = 'host';
      this.reject(offer, code, 'rejected by onJoinRequest');
      return;
    }
    this.negotiate(peer, offer);
  }

  // ================================================================== negotiation (official `la`)

  private negotiate(peer: Peer, offer: SignalingOffer): void {
    peer.state = 'negotiating';
    const mids = sdpMids(offer.sdp);
    peer.mids = mids.length === 1 && mids[0] === '0' ? SINGLE_MID : mids;
    peer.challengeDelay =
      this.opts.challengeDelayMs ?? (isLibdatachannelOffer(offer.sdp) ? LIBDATACHANNEL_CHALLENGE_DELAY_MS : 0);
    const events: PeerLinkEvents = {
      onLocalDescription: (sdp) => this.safely(() => this.onLocalDescription(peer, sdp)),
      onLocalCandidate: (cand, mid) => this.safely(() => this.onLocalCandidate(peer, cand, mid)),
      onGatheringComplete: () => this.safely(() => this.onGatheringComplete(peer)),
      onConnectionState: (state) =>
        this.safely(() => {
          if (peer.state === 'negotiating') this.failNegotiation(peer, `pc ${state}`);
          else if (peer.state !== 'closed') this.closePeer(peer, 'closed');
        }),
      onChannelOpen: (index, remoteAddress) =>
        this.safely(() => {
          if (peer.state === 'closed') return;
          peer.channelOpen[index] = true;
          if (index === 0 && remoteAddress !== null) peer.remoteAddress = remoteAddress;
          if (index === 0 && peer.state === 'negotiating') this.onChannelZeroOpen(peer);
          if (peer.state === 'challenged' && peer.challengeDue && !peer.challengeSent) this.maybeSendChallenge(peer);
        }),
      onChannelClosed: (index) =>
        this.safely(() => {
          peer.channelOpen[index] = false;
          if (peer.state === 'negotiating') this.failNegotiation(peer, `channel ${index} closed`);
          else if (peer.state !== 'closed') this.closePeer(peer, 'closed');
        }),
      // hot path: no per-message closure (same guarantee as `safely`)
      onMessage: (index, msg) => {
        try {
          this.onChannelMessage(peer, index, msg);
        } catch (err) {
          this.reportError(err);
        }
      },
      onAbuse: (kind) =>
        this.safely(() => {
          if (peer.state === 'negotiating' || peer.state === 'validating') this.failNegotiation(peer, `edge ${kind}`);
          else this.closePeer(peer, kind);
        }),
      onError: this.reportError,
    };
    let link: PeerLink;
    try {
      link = this.backend.createPeer(peer.id, offer.sdp, events, { ip: offer.ip });
    } catch (err) {
      this.reportError(err);
      this.failNegotiation(peer, 'pc create error');
      return;
    }
    if (peer.state !== 'negotiating') {
      link.close(); // failed from inside createPeer (bad answer)
      return;
    }
    peer.link = link;
    const n = Math.min(offer.candidates.length, MAX_REMOTE_CANDIDATES);
    for (let i = 0; i < n; i++) this.addRemoteCandidate(peer, offer.candidates[i]!);
    for (const c of peer.queuedRemote) this.addRemoteCandidate(peer, c);
    peer.queuedRemote = [];
  }

  /**
   * Local answer available (synchronously for the local backend, after a
   * tunnel round trip for an edge): wait for gathering or `answerIceWaitMs`
   * (`ub.li`), or — with an `answerOnFirstCandidate` backend — only until the
   * first candidate allowed by the ICE policy is known.
   */
  private onLocalDescription(peer: Peer, sdp: string): void {
    if (peer.state !== 'negotiating' || peer.answerSent || peer.localSdp !== null) return;
    try {
      peer.localSdp = filterSdp(sdp, this.icePolicy);
    } catch (err) {
      this.reportError(err);
      this.failNegotiation(peer, 'sdp error');
      return;
    }
    if (peer.gatheringDone) this.sendAnswer(peer);
    else if (this.backend.answerOnFirstCandidate === true && peer.localCandidates.length > 0) this.answerSoon(peer);
    else {
      peer.timer = setTimeout(
        () => this.safely(() => this.sendAnswer(peer)),
        this.opts.answerIceWaitMs ?? DEFAULT_ANSWER_ICE_WAIT_MS,
      );
    }
  }

  private onLocalCandidate(peer: Peer, cand: string, mid: string): void {
    if (peer.state === 'closed') return;
    const line = filterCandidate(candidateLine(cand), this.icePolicy);
    if (line === null || line.length === 0) {
      if (line === null) this.log(`peer ${peer.id}: local candidate withheld by iceCandidatePolicy`);
      return;
    }
    const idx = peer.mids.indexOf(mid);
    const c: IceCandidateInit = { candidate: line, sdpMid: mid, sdpMLineIndex: idx >= 0 ? idx : 0 };
    if (!peer.answerSent) {
      peer.localCandidates.push(c);
      if (this.backend.answerOnFirstCandidate === true && peer.localCandidates.length === 1 && peer.localSdp !== null) {
        this.answerSoon(peer);
      }
    } else if (!peer.endSent) this.signaling.sendCandidate(peer.id, c);
  }

  /**
   * `answerOnFirstCandidate` backends (node-datachannel): answer on the next
   * timer turn once one usable candidate is known instead of waiting for the
   * whole gathering (the STUN round trip, or `answerIceWaitMs` when the STUN
   * server is unreachable). The rest of the burst delivered in the same turn
   * still goes in the answer; later candidates are trickled as usual.
   */
  private answerSoon(peer: Peer): void {
    if (peer.state !== 'negotiating' || peer.answerSent) return;
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = setTimeout(() => this.safely(() => this.sendAnswer(peer)), 0);
  }

  private onGatheringComplete(peer: Peer): void {
    peer.gatheringDone = true;
    if (peer.state !== 'negotiating') return;
    if (peer.timer !== null && peer.localSdp !== null) this.sendAnswer(peer);
    else if (peer.answerSent) this.sendEnd(peer);
  }

  /** `Aa.Zh` (after `ub.li`: gathering complete or `answerIceWaitMs`). */
  private sendAnswer(peer: Peer): void {
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = null;
    if (peer.answerSent || peer.state !== 'negotiating' || peer.localSdp === null) return;
    peer.answerSent = true;
    this.log(`peer ${peer.id}: answer sent with ${peer.localCandidates.length} candidates`);
    this.signaling.sendAnswer(peer.id, peer.localSdp, peer.localCandidates);
    // encoded synchronously and never read again (later candidates are trickled): release them
    peer.localSdp = null;
    peer.localCandidates.length = 0;
    if (peer.gatheringDone) this.sendEnd(peer);
  }

  private sendEnd(peer: Peer): void {
    if (peer.endSent) return;
    peer.endSent = true;
    this.signaling.sendEnd(peer.id);
  }

  /** `Aa.Vg`: srflx IPs are recorded; a banned one makes the candidate be ignored. */
  private handleRemoteCandidate(peerId: number, c: IceCandidateInit): void {
    const peer = this.pending.get(peerId);
    if (peer === undefined) return;
    // a real client trickles a handful; the rest would only grow per-peer state and native ICE work
    if (++peer.remoteCandidates > MAX_REMOTE_CANDIDATES) return;
    const ip = srflxAddress(c);
    if (ip !== null) {
      if (peer.srflxIps.indexOf(ip) < 0) peer.srflxIps.push(ip);
      if (this.bans.isIpBanned(ip)) return;
    }
    if (peer.state === 'validating') peer.queuedRemote.push(c);
    else this.addRemoteCandidate(peer, c);
  }

  /** `la.Je` (delayed by 2.5 s on reverse connections). */
  private addRemoteCandidate(peer: Peer, c: IceCandidateInit): void {
    if (c.candidate.length === 0) return;
    const apply = () => {
      const link = peer.link;
      if (link === null || peer.state === 'closed') return;
      let mid = c.sdpMid ?? null;
      if (mid === null) mid = peer.mids[c.sdpMLineIndex ?? 0] ?? peer.mids[0] ?? '0';
      // unresolvable (e.g. mDNS) or malformed candidates are ignored like `.catch(function(){})`
      link.addRemoteCandidate(candidateLine(c.candidate), mid);
    };
    if (peer.reverse) {
      // harmless once the peer is gone (link null): unref'd so it never keeps a stopped host alive
      setTimeout(() => this.safely(apply), this.opts.reverseIceDelayMs ?? NetDefaults.reverseIceDelayMs).unref();
    } else apply();
  }

  /** `la.Rd`: negotiation failed (timeout, channel closed/message before open, PC failed). */
  private failNegotiation(peer: Peer, why: string): void {
    if (peer.state === 'closed') return;
    this.log(`peer ${peer.id}: negotiation failed (${why})`);
    if (this.pending.get(peer.id) === peer) {
      this.pending.delete(peer.id);
      this.sendEnd(peer);
    }
    peer.state = 'closed';
    peer.closeReason = 'failed';
    this.destroyNative(peer);
  }

  /** Signaling lost (`Aa.Lg`) or stop(): drop every negotiation in progress. */
  private dropPending(reason: PeerCloseReason): void {
    for (const peer of this.pending.values()) {
      peer.state = 'closed';
      peer.closeReason = reason;
      this.destroyNative(peer);
    }
    this.pending.clear();
  }

  /** `la.Qd` + `Wa.Ah`. */
  private onChannelZeroOpen(peer: Peer): void {
    this.log(`peer ${peer.id}: channel 0 open`);
    if (this.pending.get(peer.id) === peer) this.pending.delete(peer.id);
    this.sendEnd(peer);
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = null;
    const now = performance.now();
    if (this.connected.length >= this.maxPlayers && !this.evictStaleChallenged(now)) {
      peer.state = 'closed';
      peer.closeReason = 'full';
      this.destroyNative(peer);
      return;
    }
    peer.state = 'challenged';
    peer.lastMessageAt = now;
    peer.bucket = new TokenBucket(
      this.opts.floodCapacity ?? NetDefaults.floodCapacity,
      this.opts.floodMsPerToken ?? NetDefaults.floodMsPerToken,
      now,
    );
    this.connected.push(peer);
    peer.challenge = createChallenge();
    const delay = peer.challengeDelay;
    if (delay <= 0) {
      peer.challengeDue = true;
      this.maybeSendChallenge(peer);
    } else {
      peer.timer = setTimeout(() => {
        peer.timer = null;
        if (peer.state !== 'challenged') return;
        peer.challengeDue = true;
        this.safely(() => this.maybeSendChallenge(peer));
      }, delay);
    }
  }

  /**
   * Sends the challenge once it is due and all three channels are open.
   *
   * The official host sends it as soon as channel 0 opens; browsers open all
   * negotiated channels in the same task and never deliver a message before
   * `open`, so that is safe for browser clients. Clients built on
   * libdatachannel (node-haxball) dispatch `open`/`message` callbacks through
   * separate queues and silently drop a message that arrives before all
   * their channels report open, which happens when the challenge is sent the
   * instant the SCTP association comes up. haxlite therefore waits until its
   * three channels are open and `challengeDelayMs` elapsed (default 10 ms for
   * libdatachannel offers, 0 for browsers).
   */
  private maybeSendChallenge(peer: Peer): void {
    const open = peer.channelOpen;
    for (let i = 0; i < open.length; i++) if (!open[i]) return;
    peer.challengeSent = true;
    this.send(peer, 0, encodeChallenge(peer.challenge!));
    this.log(`peer ${peer.id}: challenge sent`);
  }

  // ================================================================== messages (`Ya` + `Wa.Jh`)

  private onChannelMessage(peer: Peer, channel: number, msg: string | Uint8Array): void {
    const state = peer.state;
    if (state === 'negotiating') {
      this.failNegotiation(peer, `message on channel ${channel} before open`); // `la`: any message before channel 0 opens
      return;
    }
    if (state === 'closed' || state === 'validating') return;
    const now = performance.now();
    peer.lastMessageAt = now;
    if (!peer.bucket!.take(now)) {
      this.closePeer(peer, 'flood');
      return;
    }
    if (typeof msg === 'string') {
      this.closePeer(peer, 'protocol');
      return;
    }
    const data = msg;
    if (state === 'joined') {
      const cb = this.onPeerMessage;
      if (cb !== null) {
        // inlined `callUser` (hot path: no per-message closure)
        try {
          cb(peer, data, channel);
        } catch (err) {
          this.reportError(err);
        }
      }
      return;
    }
    if (state === 'challenged' && data.length > 0 && data[0] === 0) {
      // copy: `data` may be a transient view (rtc backend) and the handshake spans an await
      this.handleHandshake(peer, data.slice()).catch((err: unknown) => {
        this.reportError(err);
        this.safely(() => this.closePeer(peer, 'protocol'));
      });
      return;
    }
    this.closePeer(peer, 'protocol');
  }

  /** `Wa.Lh`. */
  private async handleHandshake(peer: Peer, data: Uint8Array): Promise<void> {
    let authBlob: Uint8Array;
    let infoBytes: Uint8Array;
    try {
      ({ authBlob, info: infoBytes } = parseHandshake(data));
    } catch {
      this.closePeer(peer, 'protocol');
      return;
    }
    const challenge = peer.challenge!;
    peer.challenge = null;
    peer.state = 'verifying';
    let auth: string | null;
    try {
      auth = await verifyAuthBlob(authBlob, challenge);
    } catch {
      auth = null;
    }
    if (peer.state !== 'verifying') return;
    let info: JoinPlayerInfo;
    try {
      info = parseJoinInfo(infoBytes);
    } catch {
      this.closePeer(peer, 'protocol');
      return;
    }
    peer.auth = auth;
    peer.info = info;
    if (auth === null && this.opts.allowNullAuth === false) {
      this.send(peer, 0, encodeKick('Identity verification failed', false, null));
      this.closePeer(peer, 'auth', true);
      return;
    }
    const ra = peer.remoteAddress;
    if (this.bans.isAuthBanned(auth) || (this.verifiedIpBans && ra !== null && this.bans.isIpBanned(ra))) {
      this.send(peer, 0, encodeKick('You are banned from this room.', true, null));
      this.closePeer(peer, 'banned', true);
      return;
    }
    peer.state = 'joined';
    this.joined.push(peer);
    const cb = this.onPeerJoin;
    if (cb === null) return;
    const joinInfo: JoinInfo = {
      name: info.name,
      flag: info.flag,
      avatar: info.avatar,
      auth,
      conn: peer.conn,
      ip: peer.ip,
      srflxIps: peer.srflxIps,
    };
    this.callUser(() => cb(peer, joinInfo));
  }

  // ================================================================== teardown

  /**
   * Closes a connected peer. `deferNative` keeps the native connection open
   * until the next sweep so a just-sent kick notice can be delivered.
   */
  private closePeer(peer: Peer, reason: PeerCloseReason, deferNative = false): void {
    const state = peer.state;
    this.log(`peer ${peer.id}: close (${reason}) from state ${state}`);
    if (state === 'closed') return;
    if (state === 'validating' || state === 'negotiating') {
      if (this.pending.get(peer.id) === peer) {
        this.pending.delete(peer.id);
        this.sendEnd(peer);
      }
      peer.state = 'closed';
      peer.closeReason = reason;
      this.destroyNative(peer);
      return;
    }
    peer.state = 'closed';
    peer.closeReason = reason;
    if (reason === 'flood' || reason === 'protocol' || (reason === 'timeout' && state === 'challenged')) this.strike(peer);
    const ci = this.connected.indexOf(peer);
    if (ci >= 0) this.connected.splice(ci, 1);
    if (state === 'joined') {
      const ji = this.joined.indexOf(peer);
      if (ji >= 0) this.joined.splice(ji, 1);
    }
    if (deferNative && this.running) {
      peer.closedAt = performance.now();
      this.deferredDestroy.push(peer);
      this.ensureSweep();
    } else this.destroyNative(peer);
    if (state === 'joined') {
      const cb = this.onPeerClose;
      if (cb !== null) this.callUser(() => cb(peer, reason));
    }
  }

  /** An abusive close: once its address runs out of tokens, its offers are refused for a while. */
  private strike(peer: Peer): void {
    const key = peer.limitKey;
    const strikes = this.abuseStrikes;
    if (key === null || strikes === null || !this.running) return;
    const now = performance.now();
    this.ensureSweep(); // prunes the strikes and the blocks
    if (!strikes.take(key, now)) {
      this.blockedUntil.set(key, now + this.abuseBlockMs);
      this.log(`address ${key} blocked for ${this.abuseBlockMs} ms after abusive connections`);
    }
  }

  /**
   * Detaches the backend connection from the peer at once (late events are
   * ignored) and releases it (natives are closed on the next turn, see
   * `closeNative`; an edge closes its PeerConnection).
   */
  private destroyNative(peer: Peer): void {
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = null;
    for (let i = 0; i < peer.channelOpen.length; i++) peer.channelOpen[i] = false;
    const link = peer.link;
    peer.link = null;
    if (link !== null) link.close();
  }

  /** Housekeeping: negotiation timeouts (`la.gi`), idle peers (`Ya`), deferred closes. */
  private sweep(): void {
    const now = performance.now();
    const dd = this.deferredDestroy;
    if (dd.length > 0) {
      // linger so the last message (kick notice) leaves before the native close, even on a fast sweep
      let keep = 0;
      for (let i = 0; i < dd.length; i++) {
        const p = dd[i]!;
        if (now - p.closedAt >= CLOSE_LINGER_MS) this.destroyNative(p);
        else dd[keep++] = p;
      }
      dd.length = keep;
    }
    const openTimeout = this.channelOpenTimeoutMs;
    for (const p of this.pending.values()) {
      if (now - p.createdAt < openTimeout) continue;
      if (p.state === 'negotiating') this.failNegotiation(p, 'channel open timeout');
      // an onJoinRequest hook that never settles must not hold a negotiation slot forever (late decisions are ignored)
      else if (p.state === 'validating') this.failNegotiation(p, 'join request timeout');
    }
    const idle = this.peerIdleTimeoutMs;
    const conns = this.connected;
    for (let i = conns.length - 1; i >= 0; i--) {
      const p = conns[i]!;
      if (now - p.lastMessageAt >= idle) this.closePeer(p, 'timeout');
    }
    this.joinLimiter?.prune(now);
    this.abuseStrikes?.prune(now);
    if (this.blockedUntil.size > 0) for (const [k, until] of this.blockedUntil) if (now >= until) this.blockedUntil.delete(k);
  }
}
