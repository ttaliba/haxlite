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
import type { RtcConfig } from 'node-datachannel';
import { PROTOCOL_VERSION } from '../protocol.js';
import { createChallenge, verifyAuthBlob } from './auth.js';
import { BanList, type BanRecord } from './bans.js';
import { DEFAULT_ICE_SERVERS, DEFAULT_ROOM_LINK_BASE, NetDefaults, RejectCode } from './constants.js';
import { EdgePeerBackend, type EdgeOptions } from './edge-client.js';
import { encodeChallenge, encodeKick, parseHandshake, parseJoinInfo, type JoinPlayerInfo } from './handshake.js';
import {
  candidateLine,
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
import { KeyedRateLimiter, TokenBucket } from './rate-limit.js';
import { defaultRoomInfo, encodeRoomInfo, type RoomInfo } from './room-info.js';
import { HostSignaling, type HostSignalingOptions, type SignalingOffer } from './signaling.js';
import { Writer } from '../codec/index.js';
import { LocalPeerBackend, type PeerBackend, type PeerLink, type PeerLinkEvents } from './peer-backend.js';
import { RtcPeerBackend, type RtcBackendOptions } from './rtc-backend.js';

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
  /** No message for 10 s (`Ya.Qh`). */
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
  readonly createdAt: number;
  /** performance.now() of the last message received (idle timeout). */
  lastMessageAt: number;

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
  /** @internal signaling `[0][peer]` already sent (`la.qf`). */ endSent = false;
  /** @internal */ answerSent = false;
  /** @internal */ gatheringDone = false;
  /** @internal one-shot timer: answer ICE wait, then challenge delay */ timer: NodeJS.Timeout | null = null;
  /** @internal */ localSdp: string | null = null;
  /** @internal */ readonly localCandidates: IceCandidateInit[] = [];
  /** @internal candidates received while 'validating' */ queuedRemote: IceCandidateInit[] = [];
  /** @internal */ mids: string[] = [];

  constructor(offer: SignalingOffer, srflxIps: string[], now: number) {
    this.id = offer.peerId;
    this.conn = offer.conn;
    this.ip = offer.ip;
    this.srflxIps = srflxIps;
    this.reverse = offer.reverse;
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
   * For relay-only operation add `rtc: { iceTransportPolicy: 'relay' }`.
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
  /** Async admission hook evaluated after the official checks, before WebRTC. */
  onJoinRequest?: (req: JoinRequest) => JoinDecision | Promise<JoinDecision>;
  /** Per-IP join attempt limit (not official; default off). `code` default 4104. */
  joinRateLimit?: { capacity: number; msPerToken: number; code?: number } | null;
  floodCapacity?: number;
  floodMsPerToken?: number;
  maxPendingNegotiations?: number;
  channelOpenTimeoutMs?: number;
  peerIdleTimeoutMs?: number;
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
   * `maxMessageSize`, `mtu`, `proxyServer`…
   */
  rtc?: Partial<Omit<RtcConfig, 'iceServers'>>;
  /** Housekeeping period (timeouts, deferred closes). Default 1000 ms. */
  sweepIntervalMs?: number;
  /**
   * Delay between channel-0 open and the challenge (official: 0). Default 40 ms
   * so libdatachannel-based clients (node-haxball) don't drop it; see
   * `maybeSendChallenge`. Same default with `peerBackend: 'rtc'` (the delay
   * protects the client side, whatever the server stack).
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
   * ICE-lite/DTLS/SCTP, every player on one UDP port, no native threads, about
   * half the CPU per player, but the host must be directly reachable at
   * {@link RtcBackendOptions.publicAddresses} (public IP or 1:1 NAT). With
   * `'rtc'`, `iceServers`, `iceCandidatePolicy`, `portRange` and `rtc` are
   * ignored (see {@link rtcEndpoint}). See docs/10.
   */
  peerBackend?: 'ndc' | 'rtc';
  /** `peerBackend: 'rtc'` settings: UDP `port`, bind `address`, `publicAddresses`, timeouts… */
  rtcEndpoint?: RtcBackendOptions | null;
}

/** See {@link HostTransportOptions.challengeDelayMs}. */
const DEFAULT_CHALLENGE_DELAY_MS = 40;

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
  private sweepTimer: NodeJS.Timeout | null = null;
  private running = false;

  private password: string | null;
  private maxPlayers: number;
  private isPublic: boolean;
  private readonly roomInfo: RoomInfo;
  private readonly roomInfoWriter = new Writer(64);

  constructor(opts: HostTransportOptions) {
    this.opts = opts;
    if (opts.backend != null) this.backend = opts.backend;
    else if (opts.edge != null) this.backend = new EdgePeerBackend(opts.edge);
    else if (opts.peerBackend === 'rtc') this.backend = new RtcPeerBackend(opts.rtcEndpoint ?? {});
    else {
      if (opts.peerBackend !== undefined && opts.peerBackend !== 'ndc') {
        throw new TypeError(`peerBackend must be 'ndc' or 'rtc' (got ${JSON.stringify(opts.peerBackend)})`);
      }
      const iceServers: (string | NativeIceServer)[] = toNativeIceServers(opts.iceServers ?? DEFAULT_ICE_SERVERS);
      const range = opts.portRange;
      const rtc: RtcConfig = {
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
      (this.joinLimiter === null || this.joinLimiter.size === 0)
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
    const links = this.linkScratch;
    links.length = 0;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i]!.peer;
      if (p.state !== 'closed' && p.link !== null && p.channelOpen[0]) links.push(p.link);
    }
    if (links.length > 0) many.call(this.backend, links, channel, data);
    links.length = 0;
  }
  private readonly linkScratch: PeerLink[] = [];

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
   * (conn + srflx IPs, plus `auth` with `banAuth`), then closes. Returns the
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

  /** Official kick-ban storage (`Aa.vg`): conn IP + srflx IPs (+ auth if asked). */
  banPeer(peer: Peer, opts: { auth?: boolean; note?: string | null } = {}): BanRecord {
    return this.bans.addPeer(peer.ips, opts.auth ? peer.auth : null, opts.note ?? peer.info?.name ?? null);
  }

  // ================================================================== admission

  private reject(offer: { peerId: number; ip: string; conn: string }, code: number, why: string): void {
    this.signaling.sendReject(offer.peerId, code);
    const cb = this.onJoinRejected;
    if (cb !== null) this.callUser(() => cb({ peerId: offer.peerId, ip: offer.ip, conn: offer.conn }, code, why));
  }

  /** `Aa.$g` + `Wa.Xg` + hook. */
  private handleOffer(offer: SignalingOffer): void {
    if (!this.running) return;
    if (!this.backend.ready) {
      this.reject(offer, RejectCode.TooManyPending, `${this.backend.kind} backend not ready`);
      return;
    }
    if (this.pending.size >= (this.opts.maxPendingNegotiations ?? NetDefaults.maxPendingNegotiations)) {
      this.reject(offer, RejectCode.TooManyPending, 'too many pending negotiations');
      return;
    }
    if (this.bans.isIpBanned(offer.ip)) {
      this.reject(offer, RejectCode.Banned, 'banned conn');
      return;
    }
    const srflx: string[] = [];
    const addresses: string[] = [];
    for (const c of offer.candidates) {
      const parsed = parseCandidate(c.candidate);
      if (parsed !== null) addresses.push(parsed.address);
      const ip = parsed !== null && parsed.type === 'srflx' ? parsed.address : null;
      if (ip !== null) {
        if (this.bans.isIpBanned(ip)) {
          this.reject(offer, RejectCode.Banned, 'banned srflx');
          return;
        }
        srflx.push(ip);
      }
    }
    if (this.joinLimiter !== null) this.ensureSweep(); // prunes the limiter's buckets
    if (this.joinLimiter !== null && !this.joinLimiter.take(offer.ip)) {
      this.reject(offer, this.opts.joinRateLimit?.code ?? RejectCode.TooManyPending, 'join rate limit');
      return;
    }
    // Wa.Xg
    if (this.connected.length >= this.maxPlayers) {
      this.reject(offer, RejectCode.Full, 'room full');
      return;
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
    let result: JoinDecision | Promise<JoinDecision>;
    try {
      result = hook(req);
    } catch (err) {
      this.hookFailed(peer, offer, err);
      return;
    }
    if (result instanceof Promise) {
      result.then(
        (d) => this.safely(() => this.applyDecision(peer, offer, d)),
        (err) => this.safely(() => this.hookFailed(peer, offer, err)),
      );
    } else {
      this.applyDecision(peer, offer, result);
    }
  }

  private hookFailed(peer: Peer, offer: SignalingOffer, err: unknown): void {
    this.reportError(err);
    this.applyDecision(peer, offer, RejectCode.TooManyPending);
  }

  private applyDecision(peer: Peer, offer: SignalingOffer, d: JoinDecision): void {
    if (peer.state !== 'validating' || this.pending.get(peer.id) !== peer) return; // dropped meanwhile
    let code = -1;
    if (d === false) code = RejectCode.Banned;
    else if (typeof d === 'number') code = d;
    else if (d !== null && typeof d === 'object' && 'reject' in d) code = d.reject;
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
    peer.mids = sdpMids(offer.sdp);
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
      link = this.backend.createPeer(peer.id, offer.sdp, events);
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
    for (const c of offer.candidates) this.addRemoteCandidate(peer, c);
    for (const c of peer.queuedRemote) this.addRemoteCandidate(peer, c);
    peer.queuedRemote = [];
  }

  /**
   * Local answer available (synchronously for the local backend, after a
   * tunnel round trip for an edge): wait for gathering or `answerIceWaitMs`.
   */
  private onLocalDescription(peer: Peer, sdp: string): void {
    if (peer.state !== 'negotiating' || peer.localSdp !== null) return;
    try {
      peer.localSdp = filterSdp(sdp, this.icePolicy);
    } catch (err) {
      this.reportError(err);
      this.failNegotiation(peer, 'sdp error');
      return;
    }
    if (peer.gatheringDone) this.sendAnswer(peer);
    else {
      peer.timer = setTimeout(
        () => this.safely(() => this.sendAnswer(peer)),
        this.opts.answerIceWaitMs ?? NetDefaults.answerIceWaitMs,
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
    if (!peer.answerSent) peer.localCandidates.push(c);
    else if (!peer.endSent) this.signaling.sendCandidate(peer.id, c);
  }

  private onGatheringComplete(peer: Peer): void {
    peer.gatheringDone = true;
    if (peer.state !== 'negotiating') return;
    if (peer.timer !== null && peer.localSdp !== null) this.sendAnswer(peer);
    else if (peer.answerSent) this.sendEnd(peer);
  }

  /** `Aa.Zh` (after `ub.li`: gathering complete or 500 ms). */
  private sendAnswer(peer: Peer): void {
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = null;
    if (peer.answerSent || peer.state !== 'negotiating' || peer.localSdp === null) return;
    peer.answerSent = true;
    this.log(`peer ${peer.id}: answer sent with ${peer.localCandidates.length} candidates`);
    this.signaling.sendAnswer(peer.id, peer.localSdp, peer.localCandidates);
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
    if (peer.reverse) setTimeout(() => this.safely(apply), this.opts.reverseIceDelayMs ?? NetDefaults.reverseIceDelayMs);
    else apply();
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
    this.pending.delete(peer.id);
    this.sendEnd(peer);
    if (peer.timer !== null) clearTimeout(peer.timer);
    peer.timer = null;
    if (this.connected.length >= this.maxPlayers) {
      peer.state = 'closed';
      peer.closeReason = 'full';
      this.destroyNative(peer);
      return;
    }
    const now = performance.now();
    peer.state = 'challenged';
    peer.lastMessageAt = now;
    peer.bucket = new TokenBucket(
      this.opts.floodCapacity ?? NetDefaults.floodCapacity,
      this.opts.floodMsPerToken ?? NetDefaults.floodMsPerToken,
      now,
    );
    this.connected.push(peer);
    peer.challenge = createChallenge();
    const delay = this.opts.challengeDelayMs ?? DEFAULT_CHALLENGE_DELAY_MS;
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
   * three channels are open and `challengeDelayMs` (default 40 ms) elapsed.
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
    if (this.bans.isAuthBanned(auth)) {
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
    const ci = this.connected.indexOf(peer);
    if (ci >= 0) this.connected.splice(ci, 1);
    if (state === 'joined') {
      const ji = this.joined.indexOf(peer);
      if (ji >= 0) this.joined.splice(ji, 1);
    }
    if (deferNative && this.running) {
      this.deferredDestroy.push(peer);
      this.ensureSweep();
    } else this.destroyNative(peer);
    if (state === 'joined') {
      const cb = this.onPeerClose;
      if (cb !== null) this.callUser(() => cb(peer, reason));
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
    if (this.deferredDestroy.length > 0) {
      for (const p of this.deferredDestroy) this.destroyNative(p);
      this.deferredDestroy.length = 0;
    }
    const openTimeout = this.opts.channelOpenTimeoutMs ?? NetDefaults.channelOpenTimeoutMs;
    for (const p of this.pending.values()) {
      if (p.state === 'negotiating' && now - p.createdAt >= openTimeout) this.failNegotiation(p, 'channel open timeout');
    }
    const idle = this.opts.peerIdleTimeoutMs ?? NetDefaults.peerIdleTimeoutMs;
    const conns = this.connected;
    for (let i = conns.length - 1; i >= 0; i--) {
      const p = conns[i]!;
      if (now - p.lastMessageAt >= idle) this.closePeer(p, 'timeout');
    }
    this.joinLimiter?.prune(now);
  }
}
