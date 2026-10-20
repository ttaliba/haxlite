/**
 * haxlite Edge server: a game-agnostic WebRTC gateway that terminates the
 * players' PeerConnections on a public (protected) machine and relays their
 * data-channel payloads to haxlite hosts through outbound tunnels, so the
 * hosts' addresses are never exposed to players. See docs/09-haxlite-edge.md
 * and `src/net/edge-protocol.ts` for the wire format.
 *
 * ```
 *  player ══ WebRTC (ro/ru/uu) ══▶ EdgeServer ── EdgeSession (per host tunnel) ══ WS + UDP (SCTP/AES-GCM) ══ host
 *          haxlite-rtc, 1 UDP port                                               1 UDP port for all tunnels
 * ```
 *
 * One {@link EdgeSession} per tunnel WebSocket (one room). Many hosts (API
 * keys) and many rooms per key, each bounded by per-key quotas.
 *
 * With `playerBackend: 'rtc'` (default) and tunnel v2 hosts nothing here
 * loads node-datachannel: the `'ndc'` player backend and the legacy WebRTC
 * tunnel live in `src/net/edge-ndc.ts`, imported on first use only.
 */
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { createRequire } from 'node:module';
// CJS require on purpose: the ESM facade of node:http(s) evaluates the lazy
// `WebSocket`/`CloseEvent`/`MessageEvent` getters, loading undici (~35 ms of startup);
// the one of node:fs evaluates `fs.promises` (fs/promises, readline…: ~10 ms).
// node:http(s) are required on first use: this module is in the chunk every
// `import 'haxlite'` loads, and a host never creates an EdgeServer.
const require = createRequire(import.meta.url);
const http = (): typeof import('node:http') => require('node:http') as typeof import('node:http');
const https = (): typeof import('node:https') => require('node:https') as typeof import('node:https');
const { readFileSync } = require('node:fs') as typeof import('node:fs');
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from '../net/ws.js';
import type { RtcConfig } from 'node-datachannel';
import { Reader, Writer } from '../codec/index.js';
import { DEFAULT_ICE_SERVERS, NetDefaults } from '../net/constants.js';
import {
  candidateLine,
  classifyAddress,
  filterCandidate,
  filterSdp,
  parseCandidate,
  toNativeIceServers,
  type IceCandidatePolicy,
  type IceServerConfig,
} from '../net/ice.js';
import { formatIp, parseIp } from '../net/ip.js';
import type { PeerLink, PeerLinkEvents } from '../net/peer-backend.js';
import { TokenBucket, assertBucketParams } from '../net/rate-limit.js';
import type { NdcRtcConfig, WebRtcStats } from '../net/webrtc.js';
import type { NdcTunnelPlane } from '../net/edge-ndc.js';
import type { RtcEndpointStats } from '../rtc/index.js';
import {
  AuthFlag,
  EDGE_DEFAULT_PATH,
  EDGE_LEGACY_VERSION,
  EDGE_MAC_LENGTH,
  EDGE_NONCE_LENGTH,
  EDGE_PROTOCOL_VERSION,
  EDGE_RO_LANES,
  EDGE_X25519_LENGTH,
  EdgeCloseCode,
  EdgeLimits,
  EdgeMsg,
  EdgePeerClose,
  edgeAuthMac,
  edgeAuthMacV2,
  edgeAuthOkMac,
  edgeMacEqual,
  roLaneChannel,
} from '../net/edge-protocol.js';
import { deriveTunnelSecrets, grantTunnelAead, tunnelAeadFlag, x25519Generate, x25519Shared } from '../net/edge-udp.js';
import { NdcPlayers, RtcPlayers, resolveEdgePublicAddresses, type EdgePlayerBackendKind, type EdgePlayers } from './players.js';
import { EdgeUdpServer, type EdgeTunnelOptions, type EdgeTunnelStats, type EdgeUdpConn } from './tunnel-udp.js';

export type { EdgeTunnelOptions, EdgeTunnelStats } from './tunnel-udp.js';
export type { EdgePlayerBackendKind } from './players.js';

type NdcModule = typeof import('../net/edge-ndc.js');
let ndcModule: NdcModule | null = null;
let ndcLoading: Promise<NdcModule | null> | null = null;

/** Loads `src/net/edge-ndc.ts` (node-datachannel) once; null when the addon is unavailable. */
function loadNdc(log: (m: string) => void): Promise<NdcModule | null> {
  if (ndcModule !== null) return Promise.resolve(ndcModule);
  ndcLoading ??= import('../net/edge-ndc.js').then(
    (m) => (ndcModule = m),
    (err: Error) => {
      log(`node-datachannel unavailable: ${err.message}`);
      ndcLoading = null;
      return null;
    },
  );
  return ndcLoading;
}

/** One API key (tenant). */
export interface EdgeKeyConfig {
  id: string;
  secret: string;
  /** Concurrent tunnel sessions (rooms) for this key. Default `limits.maxSessionsPerKey`. */
  maxSessions?: number;
  /** Concurrent players over all of this key's sessions. Default `limits.maxPeersPerKey`. */
  maxPeers?: number;
  /** Free-form label for stats/logs. */
  label?: string;
}

export interface EdgeWebRtcOptions {
  /**
   * `'rtc'` only: the addresses announced to players (IP literals, v4 and/or
   * v6 — IPv6 ones only with {@link ipv6}) — the ONLY ones ever written into
   * answers/candidates. Default: `bindAddress` if it is a specific IP, else
   * this machine's interface addresses allowed by `iceCandidatePolicy`
   * (public ones by default; IPv4 only unless {@link ipv6}). Set it behind a
   * 1:1 NAT (cloud VM with a private interface address).
   */
  publicAddresses?: string[];
  /**
   * Use IPv6 for players (default false, as for the host's backends): `'rtc'`
   * binds and announces IPv6 too (IPv6 `publicAddresses` / detected interface
   * addresses are skipped without it, and an IPv6 `bindAddress` is an error);
   * `'ndc'` gathers and trickles IPv6 candidates. IPv6 headers are 20 bytes
   * larger: ≈ +19 % egress for HaxBall's small datagrams.
   */
  ipv6?: boolean;
  /** `'rtc'` only: the players' UDP port (default `portRange[0]`, else ephemeral). */
  port?: number;
  /** `'rtc'` only: advertised port when a NAT maps a different one. */
  publicPort?: number;
  /** `'rtc'` only: ICE consent timeout of a player (no authenticated STUN this long → closed). Default 30 s. */
  consentTimeoutMs?: number;
  /** `'ndc'` (and legacy tunnels): STUN/TURN for the edge's own PeerConnections (default Google STUN, to learn the public IP behind 1:1 NAT). */
  iceServers?: readonly IceServerConfig[];
  /** UDP port range for player and tunnel PeerConnections (`'ndc'`: one port each unless `enableIceUdpMux`; `'rtc'`: `portRange[0]`). */
  portRange?: readonly [number, number] | null;
  /** Local address to bind (and announce). */
  bindAddress?: string;
  /** `'ndc'` only: all PeerConnections on one UDP port (`portRange[0]`). */
  enableIceUdpMux?: boolean;
  /**
   * Which of the edge's own candidates are announced (to players and hosts).
   * Default `'public'`; `'all'` for loopback tests.
   */
  iceCandidatePolicy?: IceCandidatePolicy;
  /**
   * Which remote candidates (from players' offers, and from hosts' tunnel
   * PeerConnections) the edge will send connectivity checks to. Default
   * `'public'`: a host cannot make the edge probe private/loopback addresses
   * (peer-reflexive discovery still connects clients behind NAT). `'all'`
   * for tests/LAN.
   */
  remoteCandidatePolicy?: 'public' | 'private' | 'all';
  /** Extra node-datachannel config for player PeerConnections (mtu, maxMessageSize…). */
  rtc?: Partial<Omit<RtcConfig, 'iceServers'>>;
}

export interface EdgeLimitsOptions {
  /** Concurrent authenticated tunnel sessions on this edge. Default 1000. */
  maxSessions?: number;
  /**
   * Concurrent tunnel sockets still in the `Hello` → `Auth` phase (counted
   * apart from {@link maxSessions}, so anonymous sockets never take a host's
   * slot). When full, a socket that has waited 5 s or more without
   * authenticating is closed (4408) to make room; if every one is younger,
   * the new upgrade gets HTTP 503 instead (a host mid-handshake is never
   * pushed out). Default 1024 (0 = unlimited).
   */
  maxPreAuthSessions?: number;
  /**
   * Unauthenticated tunnel sockets per source address (IPv6: per /64);
   * further upgrades get HTTP 429. Hosts leave this state as soon as they
   * authenticate, so many rooms behind one address are only limited while
   * they all reconnect at once. Public sources only, unless
   * {@link perIpLimitsApplyToPrivate}. Default 256 (0 = unlimited).
   */
  maxPreAuthPerIp?: number;
  /**
   * New tunnel upgrades per source address (IPv6: per /64), token bucket:
   * burst {@link ipConnectCapacity}, one more per {@link ipConnectMsPerToken};
   * over it → HTTP 429. Public sources only, unless
   * {@link perIpLimitsApplyToPrivate}. Default 256 burst, 1 per 20 ms
   * (0 capacity = off).
   */
  ipConnectCapacity?: number;
  ipConnectMsPerToken?: number;
  /**
   * Apply {@link maxPreAuthPerIp} and {@link ipConnectCapacity} to loopback,
   * private (RFC 1918, 100.64/10, fc00::/7) and link-local sources too.
   * Default false: behind a reverse proxy (or a LAN NAT) every host and every
   * attacker shares one such address, and limiting it would let one client
   * lock every host out. Set it when the edge is reached directly.
   */
  perIpLimitsApplyToPrivate?: boolean;
  /**
   * Behind a reverse proxy: when the connection comes from a non-public
   * address, key the per-address limits on the last `X-Forwarded-For` entry
   * (the address the proxy appended; entries before it are client-supplied).
   * The proxy must append it (nginx `$proxy_add_x_forwarded_for`). Default
   * false: the header is ignored. Only enable it when nothing but the proxy
   * can reach the edge from a private address.
   */
  trustForwardedFor?: boolean;
  /** Default per-key session quota. Default 16. */
  maxSessionsPerKey?: number;
  /** Default per-key player quota. Default 256. */
  maxPeersPerKey?: number;
  /** Players per session (room). Default 40. */
  maxPeersPerSession?: number;
  /** Player negotiations in progress per session. Default 16 (official 4104 limit). */
  maxPendingPerSession?: number;
  /** PeerOpen rate per session (token bucket). Default 30 burst, 1 per 100 ms. */
  peerOpenCapacity?: number;
  peerOpenMsPerToken?: number;
  /** Player flood bucket (official `new Ra(100, 16)`); exhausted → host is told to kick ("Bad actor"). */
  floodCapacity?: number;
  floodMsPerToken?: number;
  /** Channel 0 must open within this time (edge-side cleanup). Default 15 s. */
  channelOpenTimeoutMs?: number;
  /** Hello → AuthOk deadline. Default 5 s. */
  authTimeoutMs?: number;
  /** Tunnel PeerConnection must open within this time. Default 15 s. */
  dataPlaneTimeoutMs?: number;
  /** WS keep-alive ping period (dead hosts are dropped after two). Default 10 s. */
  keepAliveMs?: number;
  /** Allow sessions that carry player data over the WebSocket. Default true. */
  allowWsDataPlane?: boolean;
}

export interface EdgeServerOptions {
  /**
   * Player-facing WebRTC: `'rtc'` (default) = haxlite-rtc (pure TypeScript,
   * ICE-lite, one UDP port for every player); `'ndc'` = node-datachannel
   * PeerConnections (native addon, loaded on demand).
   */
  playerBackend?: EdgePlayerBackendKind;
  /** Host↔edge tunnel v2 (UDP) settings. */
  tunnel?: EdgeTunnelOptions;
  /** Listen address. Default `'0.0.0.0'`. */
  host?: string;
  /** Listen port. Default 8443 (0 = ephemeral). */
  port?: number;
  /** WS path. Default `/tunnel`. */
  path?: string;
  /** TLS (`wss://`): PEM file paths. Reloaded on {@link EdgeServer.reloadTls} (SIGHUP in the CLI). */
  tls?: { certFile: string; keyFile: string } | null;
  /** Use an existing HTTP(S) server instead of creating one (`host`/`port`/`tls` ignored). */
  server?: HttpServer | HttpsServer;
  keys: readonly EdgeKeyConfig[];
  webrtc?: EdgeWebRtcOptions;
  limits?: EdgeLimitsOptions;
  /**
   * `GET <path>` returns {@link EdgeStats} as JSON (`null` disables). Default
   * `/stats`. Without {@link statsToken} only edge-wide aggregates are served
   * (`keys` empty; `webrtc`, `rtc` and `tunnel` null; `redacted: true`).
   */
  statsPath?: string | null;
  /** Bearer token for the full stats (per-key ids, labels and traffic). Default none: aggregates only. */
  statsToken?: string | null;
  /** Log a one-line summary every N ms (0 = off; at most 2147483647). */
  statsLogIntervalMs?: number;
  log?: (msg: string) => void;
}

export interface EdgeKeyStats {
  id: string;
  label: string | null;
  sessions: number;
  peers: number;
  /** Player → host / host → player traffic through this edge. */
  bytesIn: number;
  bytesOut: number;
  messagesIn: number;
  messagesOut: number;
  /** Messages per second since the previous stats() call. */
  ppsIn: number;
  ppsOut: number;
  /** Players dropped by the edge flood limiter. */
  floods: number;
}

export interface EdgeStats {
  uptimeSec: number;
  playerBackend: EdgePlayerBackendKind;
  sessions: number;
  peers: number;
  authFailures: number;
  keys: EdgeKeyStats[];
  /** node-datachannel objects (null while the addon was never loaded). */
  webrtc: WebRtcStats | null;
  /** haxlite-rtc player endpoint counters (`playerBackend: 'rtc'`). */
  rtc: RtcEndpointStats | null;
  /** Tunnel v2 UDP socket counters (null when disabled). */
  tunnel: EdgeTunnelStats | null;
  /** Sessions per data plane. */
  dataPlanes: { udp: number; webrtc: number; ws: number };
  memoryRssMb: number;
  /**
   * `true` in the stats endpoint's anonymous view (no {@link EdgeServerOptions.statsToken}):
   * `keys` is empty and `webrtc`, `rtc` and `tunnel` are null because they were
   * withheld, not because there is nothing to report. Absent otherwise.
   */
  redacted?: true;
}

const DEFAULTS = {
  maxSessions: 1000,
  maxPreAuthSessions: 1024,
  maxPreAuthPerIp: 256,
  ipConnectCapacity: 256,
  ipConnectMsPerToken: 20,
  perIpLimitsApplyToPrivate: false,
  trustForwardedFor: false,
  maxSessionsPerKey: 16,
  maxPeersPerKey: 256,
  maxPeersPerSession: 40,
  maxPendingPerSession: NetDefaults.maxPendingNegotiations,
  peerOpenCapacity: 30,
  peerOpenMsPerToken: 100,
  floodCapacity: NetDefaults.floodCapacity,
  floodMsPerToken: NetDefaults.floodMsPerToken,
  channelOpenTimeoutMs: 15_000,
  authTimeoutMs: 5_000,
  dataPlaneTimeoutMs: 15_000,
  keepAliveMs: 10_000,
};

interface KeyState {
  readonly cfg: EdgeKeyConfig;
  sessions: number;
  peers: number;
  bytesIn: number;
  bytesOut: number;
  messagesIn: number;
  messagesOut: number;
  floods: number;
  lastIn: number;
  lastOut: number;
  lastAt: number;
}

function readStr(r: Reader, max: number): string {
  const n = r.varUint();
  if (n > max || n > r.remaining) throw new Error('string too long');
  return r.stringRaw(n);
}

function remoteAllowed(policy: 'public' | 'private' | 'all', address: string): boolean {
  if (policy === 'all') return true;
  const cls = classifyAddress(address);
  if (cls === 'public') return true;
  return policy === 'private' && (cls === 'private' || cls === 'linklocal');
}

/** Remote candidate filter: null = drop. */
function remoteCandidateOk(policy: 'public' | 'private' | 'all', line: string): boolean {
  const p = parseCandidate(line);
  if (p === null) return false;
  return remoteAllowed(policy, p.address);
}

/** Largest delay `setTimeout`/`setInterval` honour; a larger one fires after 1 ms. */
const MAX_TIMER_MS = 0x7fffffff;

function timerMs(name: string, ms: number): number {
  const n = Number(ms);
  if (Number.isNaN(n)) throw new RangeError(`${name} must be a number of milliseconds`);
  return n > MAX_TIMER_MS ? MAX_TIMER_MS : n;
}

/** Per-source state of the control listener. */
interface SourceState {
  /** Unauthenticated sessions from this source. */
  preAuth: number;
  /** New upgrades (null when `ipConnectCapacity` is 0). */
  readonly bucket: TokenBucket | null;
}

/** Limit key of a remote address: the IP (IPv4-mapped → IPv4), or its /64 for IPv6. */
function sourceKey(remote: string): string {
  const b = parseIp(remote);
  if (b === null) return remote;
  if (b.length === 4) return formatIp(b);
  b.fill(0, 8);
  return `${formatIp(b)}/64`;
}

/** Loopback, private and link-local sources (a reverse proxy, a LAN NAT): exempt from per-address limits by default. */
function sharedSource(remote: string): boolean {
  const cls = classifyAddress(remote);
  return cls === 'loopback' || cls === 'private' || cls === 'linklocal';
}

/** Last `X-Forwarded-For` entry (the one the nearest proxy appended), canonical; null if absent or not an IP. */
function forwardedClient(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const h = typeof header === 'string' ? header : header[header.length - 1];
  if (h === undefined) return null;
  const b = parseIp(h.slice(h.lastIndexOf(',') + 1));
  return b === null ? null : formatIp(b);
}

/** Validates the numeric limits where the edge is built (a bad one would otherwise throw in the upgrade handler). */
function checkLimits(l: Required<EdgeLimitsOptions>): void {
  const counts = [
    'maxSessions',
    'maxPreAuthSessions',
    'maxPreAuthPerIp',
    'ipConnectCapacity',
    'maxSessionsPerKey',
    'maxPeersPerKey',
    'maxPeersPerSession',
    'maxPendingPerSession',
  ] as const;
  for (const name of counts) {
    const v = l[name];
    if (typeof v !== 'number' || !(v >= 0)) throw new RangeError(`limits.${name} must be a number >= 0, got ${String(v)}`);
  }
  const buckets: [string, number, number][] = [
    ['peerOpen', l.peerOpenCapacity, l.peerOpenMsPerToken],
    ['flood', l.floodCapacity, l.floodMsPerToken],
  ];
  if (l.ipConnectCapacity > 0) buckets.push(['ipConnect', l.ipConnectCapacity, l.ipConnectMsPerToken]);
  for (const [name, capacity, ms] of buckets) {
    if (typeof capacity !== 'number' || typeof ms !== 'number') {
      throw new RangeError(`limits.${name}Capacity / ${name}MsPerToken must be numbers`);
    }
    try {
      assertBucketParams(capacity, ms);
    } catch (err) {
      throw new RangeError(`limits.${name}Capacity / ${name}MsPerToken: ${(err as Error).message}`);
    }
  }
}

/** A refused upgrade is torn down after this long even if the peer never reads the response. */
const REFUSE_LINGER_MS = 2000;
/** A full pre-auth pool only closes sockets that have waited this long without authenticating. */
const PREAUTH_EVICT_AGE_MS = 5000;

/** Remote-supplied text for a log line: control and line-separator characters escaped. */
function printable(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
    const n = c.charCodeAt(0);
    if (n === 10) return '\\n';
    if (n === 13) return '\\r';
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16)}`;
  });
}

function refuseUpgrade(socket: Duplex, status: string): void {
  // the HTTP server removed its own error listener before 'upgrade': a reset here would be uncaught
  socket.on('error', () => socket.destroy());
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const linger = setTimeout(() => socket.destroy(), REFUSE_LINGER_MS);
  linger.unref();
  socket.once('close', () => clearTimeout(linger));
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n`);
}

export class EdgeServer {
  readonly opts: EdgeServerOptions;
  private readonly server: HttpServer | HttpsServer;
  private readonly ownsServer: boolean;
  private readonly wss: WebSocketServer;
  private readonly keys = new Map<string, KeyState>();
  /** @internal */ readonly sessions = new Set<EdgeSession>();
  /** Sessions not authenticated yet, oldest first. */
  private readonly preAuth = new Set<EdgeSession>();
  private readonly sources = new Map<string, SourceState>();
  /** `sources` size that triggers a prune from the upgrade path (doubles while it stays busy). */
  private prunePoint = 1024;
  /** @internal */ readonly limits: Required<EdgeLimitsOptions>;
  /** @internal */ readonly playerRtc: NdcRtcConfig;
  /** @internal */ readonly tunnelRtc: RtcConfig;
  /** @internal */ readonly icePolicy: IceCandidatePolicy;
  /** @internal */ readonly remotePolicy: 'public' | 'private' | 'all';
  /** @internal */ readonly playerBackend: EdgePlayerBackendKind;
  /** @internal player connections (set by {@link listen}). */
  players: EdgePlayers | null = null;
  /** @internal tunnel v2 socket (set by {@link listen}; null when disabled). */
  udp: EdgeUdpServer | null = null;
  /** @internal */ readonly allowWebRtcTunnel: boolean;
  private readonly startedAt = performance.now();
  private authFailures = 0;
  private nextSessionId = 1;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private readonly statsLogMs: number;
  private statsTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Dummy secret: unknown key ids still cost one HMAC (no timing oracle on ids). */
  private readonly dummySecret = randomBytes(32).toString('hex');

  constructor(opts: EdgeServerOptions) {
    this.opts = opts;
    for (const k of opts.keys) {
      if (!k.id || !k.secret) throw new Error('edge keys need an id and a secret');
      if (k.id.length > EdgeLimits.maxKeyId || k.id.includes(':')) throw new Error(`invalid key id "${k.id}"`);
      if (k.secret.length < 16) throw new Error(`secret of key "${k.id}" is too short (min 16 chars)`);
      if (this.keys.has(k.id)) throw new Error(`duplicate key id "${k.id}"`);
      this.keys.set(k.id, {
        cfg: k,
        sessions: 0,
        peers: 0,
        bytesIn: 0,
        bytesOut: 0,
        messagesIn: 0,
        messagesOut: 0,
        floods: 0,
        lastIn: 0,
        lastOut: 0,
        lastAt: performance.now(),
      });
    }
    const limits = { ...DEFAULTS, allowWsDataPlane: true, ...stripUndefined(opts.limits ?? {}) };
    limits.channelOpenTimeoutMs = timerMs('channelOpenTimeoutMs', limits.channelOpenTimeoutMs);
    limits.authTimeoutMs = timerMs('authTimeoutMs', limits.authTimeoutMs);
    limits.dataPlaneTimeoutMs = timerMs('dataPlaneTimeoutMs', limits.dataPlaneTimeoutMs);
    limits.keepAliveMs = timerMs('keepAliveMs', limits.keepAliveMs);
    checkLimits(limits);
    limits.perIpLimitsApplyToPrivate = limits.perIpLimitsApplyToPrivate === true;
    limits.trustForwardedFor = limits.trustForwardedFor === true;
    this.limits = limits;
    this.statsLogMs = timerMs('statsLogIntervalMs', opts.statsLogIntervalMs ?? 0);
    const w = opts.webrtc ?? {};
    const range = w.portRange;
    const base: RtcConfig = {
      iceServers: toNativeIceServers(w.iceServers ?? DEFAULT_ICE_SERVERS),
      ...(range ? { portRangeBegin: range[0], portRangeEnd: range[1] } : null),
      ...(w.bindAddress !== undefined ? { bindAddress: w.bindAddress } : null),
      ...(w.enableIceUdpMux ? { enableIceUdpMux: true } : null),
    };
    this.playerRtc = { ...base, ...w.rtc, ...(w.ipv6 === true ? { ipv6: true } : null), iceServers: base.iceServers, disableAutoNegotiation: true };
    this.tunnelRtc = { ...base, maxMessageSize: 1 << 20, disableAutoNegotiation: true };
    this.icePolicy = w.iceCandidatePolicy ?? 'public';
    this.remotePolicy = w.remoteCandidatePolicy ?? 'public';
    this.playerBackend = opts.playerBackend ?? 'rtc';
    if (this.playerBackend !== 'rtc' && this.playerBackend !== 'ndc') throw new Error(`playerBackend must be 'rtc' or 'ndc'`);
    this.allowWebRtcTunnel = opts.tunnel?.allowWebRtc !== false;

    if (opts.server) {
      this.server = opts.server;
      this.ownsServer = false;
    } else if (opts.tls) {
      this.server = https().createServer({ cert: readFileSync(opts.tls.certFile), key: readFileSync(opts.tls.keyFile) });
      this.ownsServer = true;
    } else {
      this.server = http().createServer();
      this.ownsServer = true;
    }
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: EdgeLimits.maxWsMessage + 4096 });
    this.server.on('upgrade', this.onUpgrade);
    this.server.on('request', this.onRequest);
  }

  /** Creates and starts listening. */
  static async start(opts: EdgeServerOptions): Promise<EdgeServer> {
    const s = new EdgeServer(opts);
    try {
      await s.listen();
    } catch (err) {
      // nobody else holds `s`: release the listener / handlers it attached
      await s.close();
      throw err;
    }
    return s;
  }

  /**
   * Binds the player UDP socket ('rtc') or loads node-datachannel ('ndc'),
   * the tunnel v2 UDP socket, then the control listener.
   */
  async listen(): Promise<void> {
    const w = this.opts.webrtc ?? {};
    const t = this.opts.tunnel ?? {};
    let bound = false;
    try {
      if (this.players === null) {
        if (this.playerBackend === 'rtc') {
          const publicAddresses = resolveEdgePublicAddresses(w, this.icePolicy);
          this.players = await RtcPlayers.start({
            port: w.port ?? w.portRange?.[0] ?? 0,
            ...(w.bindAddress !== undefined ? { address: w.bindAddress } : null),
            publicAddresses,
            ...(w.ipv6 === true ? { ipv6: true } : null),
            ...(w.publicPort !== undefined ? { publicPort: w.publicPort } : null),
            handshakeTimeoutMs: Math.min(this.limits.channelOpenTimeoutMs + 1000, MAX_TIMER_MS),
            ...(w.consentTimeoutMs !== undefined ? { idleTimeoutMs: timerMs('consentTimeoutMs', w.consentTimeoutMs) } : null),
          });
          this.log(`players: haxlite-rtc on UDP ${(this.players as RtcPlayers).port}, announcing ${publicAddresses.join(', ')}`);
        } else {
          this.players = await NdcPlayers.start(this.playerRtc);
          ndcModule = (this.players as NdcPlayers).mod;
        }
      }
      if (this.ownsServer && !this.server.listening) {
        await new Promise<void>((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(this.opts.port ?? 8443, this.opts.host ?? '0.0.0.0', () => {
            this.server.off('error', reject);
            resolve();
          });
        });
        bound = true;
      }
      if (this.udp === null && t.udp !== false) {
        const host = this.opts.host ?? '0.0.0.0';
        const bind = t.bindAddress ?? w.bindAddress ?? (host === '' ? '0.0.0.0' : host);
        const wsPort = this.server.listening ? (this.server.address() as AddressInfo).port : 0;
        this.udp = await EdgeUdpServer.listen(bind, t.port ?? wsPort, t, t.port === undefined);
        this.log(`tunnel v2: UDP ${bind}:${this.udp.port}`);
      }
    } catch (err) {
      await this.players?.close();
      this.players = null;
      if (bound) {
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
      }
      throw err;
    }
    const every = this.statsLogMs;
    if (every > 0 && this.statsTimer === null) this.statsTimer = setInterval(() => this.logStats(), every);
  }

  /** UDP port of the tunnel v2 socket (null when disabled or not listening). */
  get tunnelPort(): number | null {
    return this.udp?.port ?? null;
  }

  /** UDP port of the haxlite-rtc player socket (null with `playerBackend: 'ndc'`). */
  get playerPort(): number | null {
    return this.players instanceof RtcPlayers ? this.players.port : null;
  }

  /** Bound address (`{address, port}`). */
  get address(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  /** `ws(s)://host:port/path` for hosts on this machine (tests). */
  url(host?: string): string {
    const a = this.address;
    const h = host ?? (a.address === '0.0.0.0' || a.address === '::' ? '127.0.0.1' : a.address);
    const scheme = this.server instanceof https().Server ? 'wss' : 'ws';
    return `${scheme}://${h.includes(':') ? `[${h}]` : h}:${a.port}${this.opts.path ?? EDGE_DEFAULT_PATH}`;
  }

  /** Re-reads the TLS certificate/key files (e.g. after a Let's Encrypt renewal). */
  reloadTls(): void {
    const t = this.opts.tls;
    if (!t || !(this.server instanceof https().Server)) return;
    this.server.setSecureContext({ cert: readFileSync(t.certFile), key: readFileSync(t.keyFile) });
    this.log('TLS certificate reloaded');
  }

  /** @internal */ log(msg: string): void {
    const l = this.opts.log;
    if (l === undefined) return;
    try {
      l(msg);
    } catch {
      /* ignore */
    }
  }

  /** Closes every session (hosts see 4503 and reconnect elsewhere/later) and the listener. */
  async close(opts: { shutdownWebRtc?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    for (const s of [...this.sessions]) s.close(EdgeCloseCode.Shutdown, 'edge shutting down');
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    this.server.off('upgrade', this.onUpgrade);
    this.server.off('request', this.onRequest);
    if (this.ownsServer) {
      this.server.closeAllConnections?.();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    const udp = this.udp;
    this.udp = null;
    if (udp !== null) await udp.close();
    const players = this.players;
    this.players = null;
    if (players !== null) await players.close();
    if (opts.shutdownWebRtc && ndcModule !== null) await ndcModule.shutdownWebRtc();
  }

  stats(): EdgeStats {
    const now = performance.now();
    let peers = 0;
    const keys: EdgeKeyStats[] = [];
    for (const k of this.keys.values()) {
      peers += k.peers;
      const dt = (now - k.lastAt) / 1000;
      keys.push({
        id: k.cfg.id,
        label: k.cfg.label ?? null,
        sessions: k.sessions,
        peers: k.peers,
        bytesIn: k.bytesIn,
        bytesOut: k.bytesOut,
        messagesIn: k.messagesIn,
        messagesOut: k.messagesOut,
        ppsIn: dt > 0 ? Math.round((k.messagesIn - k.lastIn) / dt) : 0,
        ppsOut: dt > 0 ? Math.round((k.messagesOut - k.lastOut) / dt) : 0,
        floods: k.floods,
      });
      k.lastIn = k.messagesIn;
      k.lastOut = k.messagesOut;
      k.lastAt = now;
    }
    return {
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      playerBackend: this.playerBackend,
      sessions: this.sessions.size,
      peers,
      authFailures: this.authFailures,
      keys,
      webrtc: ndcModule !== null ? ndcModule.webRtcStats() : null,
      rtc: this.players instanceof RtcPlayers ? this.players.stats() : null,
      tunnel: this.udp?.stats() ?? null,
      dataPlanes: this.dataPlaneCounts(),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
    };
  }

  /** Edge-wide aggregates only (the stats endpoint without a token); leaves the pps windows alone. */
  private publicStats(): EdgeStats {
    let peers = 0;
    for (const k of this.keys.values()) peers += k.peers;
    return {
      uptimeSec: Math.round((performance.now() - this.startedAt) / 1000),
      playerBackend: this.playerBackend,
      sessions: this.sessions.size,
      peers,
      authFailures: this.authFailures,
      keys: [],
      webrtc: null,
      rtc: null,
      tunnel: null,
      dataPlanes: this.dataPlaneCounts(),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
      redacted: true,
    };
  }

  private dataPlaneCounts(): EdgeStats['dataPlanes'] {
    const dataPlanes = { udp: 0, webrtc: 0, ws: 0 };
    for (const s of this.sessions) if (s.dataPlane !== null) dataPlanes[s.dataPlane]++;
    return dataPlanes;
  }

  private logStats(): void {
    const s = this.stats();
    const per = s.keys
      .filter((k) => k.sessions > 0 || k.ppsIn > 0)
      .map((k) => `${k.id}: ${k.sessions}s/${k.peers}p in ${k.ppsIn}pps out ${k.ppsOut}pps`)
      .join('; ');
    const native = s.webrtc !== null ? ` pcs=${s.webrtc.peerConnections}` : '';
    const rtc = s.rtc !== null ? ` rtc=${s.rtc.open}/${s.rtc.sessions}` : '';
    const tun = s.tunnel !== null ? ` udp=${s.tunnel.tunnels}` : '';
    this.log(`stats sessions=${s.sessions} peers=${s.peers}${rtc}${tun}${native} rss=${s.memoryRssMb}MB${per ? ` | ${per}` : ''}`);
  }

  // ------------------------------------------------------------------ HTTP

  private readonly onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const statsPath = this.opts.statsPath === undefined ? '/stats' : this.opts.statsPath;
    const path = (req.url ?? '/').split('?')[0];
    if (statsPath !== null && req.method === 'GET' && path === statsPath) {
      const token = this.opts.statsToken ?? null;
      if (token !== null) {
        const got = Buffer.from(req.headers.authorization ?? '');
        const want = Buffer.from(`Bearer ${token}`);
        if (!edgeMacEqual(got, want)) {
          res.writeHead(401).end();
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      // no token configured: nothing that names or profiles a tenant
      res.end(JSON.stringify(token !== null ? this.stats() : this.publicStats()));
      return;
    }
    res.writeHead(404).end();
  };

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    try {
      this.upgrade(req, socket, head);
    } catch (err) {
      this.log(`upgrade failed: ${(err as Error).message}`);
      socket.destroy();
    }
  };

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '/').split('?')[0];
    if (this.closed || path !== (this.opts.path ?? EDGE_DEFAULT_PATH)) {
      socket.destroy();
      return;
    }
    // per-source limits before the WebSocket handshake (cheap to refuse)
    const lim = this.limits;
    let remote = req.socket.remoteAddress ?? '?';
    if (lim.trustForwardedFor && sharedSource(remote)) remote = forwardedClient(req.headers['x-forwarded-for']) ?? remote;
    // shared (proxy / NAT) sources are not limited per address unless asked
    const key = lim.perIpLimitsApplyToPrivate || !sharedSource(remote) ? sourceKey(remote) : null;
    let src: SourceState | null = null;
    if (key !== null) {
      if (this.sources.size >= this.prunePoint) {
        this.pruneSources();
        this.prunePoint = Math.max(1024, this.sources.size * 2);
      }
      src = this.sources.get(key) ?? null;
      if (src === null) {
        src = { preAuth: 0, bucket: lim.ipConnectCapacity > 0 ? new TokenBucket(lim.ipConnectCapacity, lim.ipConnectMsPerToken) : null };
        this.sources.set(key, src);
      }
      if ((src.bucket !== null && !src.bucket.take()) || (lim.maxPreAuthPerIp > 0 && src.preAuth >= lim.maxPreAuthPerIp)) {
        refuseUpgrade(socket, '429 Too Many Requests');
        return;
      }
    }
    // anonymous sockets compete only among themselves; one that has waited long makes room,
    // a host mid-handshake is never pushed out (the newcomer retries instead)
    if (this.preAuthFull() && this.evictable() === null) {
      refuseUpgrade(socket, '503 Service Unavailable');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // until a session owns it: a broken frame from the peer must not be an uncaught 'error'
      const onError = (): void => ws.terminate();
      ws.on('error', onError);
      if (this.closed) {
        ws.terminate();
        return;
      }
      if (this.sessions.size - this.preAuth.size >= lim.maxSessions) {
        ws.close(EdgeCloseCode.Quota, 'edge full');
        setTimeout(() => ws.terminate(), 2000).unref();
        return;
      }
      if (this.preAuthFull()) this.evictable()?.close(EdgeCloseCode.Timeout, 'auth timeout');
      ws.off('error', onError);
      const s = new EdgeSession(this, ws, this.nextSessionId++, remote, key);
      this.sessions.add(s);
      this.preAuth.add(s);
      if (src !== null) src.preAuth++;
      // keep-alive pings only while there is a tunnel to keep alive
      if (this.keepAliveTimer === null) this.keepAliveTimer = setInterval(() => this.keepAlive(), lim.keepAliveMs);
    });
  }

  private preAuthFull(): boolean {
    const max = this.limits.maxPreAuthSessions;
    return max > 0 && this.preAuth.size >= max;
  }

  /** The oldest unauthenticated session if it has waited long enough to be closed for a newcomer. */
  private evictable(): EdgeSession | null {
    const oldest = this.preAuth.values().next().value;
    return oldest !== undefined && performance.now() - oldest.createdAt >= PREAUTH_EVICT_AGE_MS ? oldest : null;
  }

  private keepAlive(): void {
    for (const s of this.sessions) s.keepAlive();
    this.pruneSources();
  }

  /** Forgets sources with no unauthenticated session and a full bucket. */
  private pruneSources(): void {
    const now = performance.now();
    for (const [key, src] of this.sources) {
      if (src.preAuth === 0 && (src.bucket === null || src.bucket.isFull(now))) this.sources.delete(key);
    }
  }

  // ------------------------------------------------------------------ auth / quotas

  /**
   * @internal Returns the key state if the MAC matches, else null
   * (constant-time on the MAC). `mac(secret)` computes the expected MAC.
   */
  authenticate(keyId: string, mac: Uint8Array, expectedFor: (secret: string) => Uint8Array): KeyState | null {
    const k = this.keys.get(keyId);
    const expected = expectedFor(k?.cfg.secret ?? this.dummySecret);
    const ok = edgeMacEqual(expected, mac);
    if (k === undefined || !ok) {
      this.authFailures++;
      return null;
    }
    return k;
  }

  /** @internal */ sessionQuota(k: KeyState): number {
    return k.cfg.maxSessions ?? this.limits.maxSessionsPerKey;
  }

  /** @internal */ peerQuota(k: KeyState): number {
    return k.cfg.maxPeers ?? this.limits.maxPeersPerKey;
  }

  /** @internal True while authenticated sessions are below `maxSessions` (`s` itself is still pre-auth). */
  hasRoom(): boolean {
    return this.sessions.size - this.preAuth.size < this.limits.maxSessions;
  }

  /** @internal `s` authenticated (or closed): it no longer counts against its source's pre-auth limit. */
  leavePreAuth(s: EdgeSession): void {
    if (!this.preAuth.delete(s) || s.source === null) return;
    const src = this.sources.get(s.source);
    if (src !== undefined) src.preAuth--;
  }

  /** @internal */ removeSession(s: EdgeSession): void {
    this.leavePreAuth(s);
    this.sessions.delete(s);
    if (this.sessions.size === 0 && this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      this.pruneSources();
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

const SPhase = {
  Hello: 0,
  DataPlane: 1,
  Ready: 2,
  Closed: 3,
} as const;
type SPhase = (typeof SPhase)[keyof typeof SPhase];


/** A player connection on the edge. */
class EdgePeer {
  readonly slot: number;
  link: PeerLink | null = null;
  readonly open = [false, false, false];
  bucket: TokenBucket | null = null;
  remoteCandidates = 0;
  readonly createdAt = performance.now();
  closed = false;
  constructor(slot: number) {
    this.slot = slot;
  }
}

/** The tunnel data plane once granted (UDP tunnel v2 or legacy PeerConnection). */
interface DataPlane {
  ready(ch: number): boolean;
  send(ch: number, frame: Uint8Array): boolean;
}

type DataPlaneKind = 'udp' | 'webrtc' | 'ws';

/** One host tunnel (one room). */
class EdgeSession {
  readonly id: number;
  phase: SPhase = SPhase.Hello;
  /** Granted data plane (null before `AuthOk`). */
  dataPlane: DataPlaneKind | null = null;
  private readonly edge: EdgeServer;
  private readonly ws: WebSocket;
  private readonly remote: string;
  /** @internal Limit key of {@link remote} (null: not limited per address). */
  readonly source: string | null;
  readonly createdAt = performance.now();
  private readonly nonce = randomBytes(EDGE_NONCE_LENGTH);
  private key: KeyState | null = null;
  /** `Auth` accepted, `AuthOk` waiting for node-datachannel to load. */
  private authing = false;
  private wsData = false;
  private plane: DataPlane | null = null;
  private udpConn: EdgeUdpConn | null = null;
  private ndc: NdcTunnelPlane | null = null;
  /** `ro` lanes granted to this host ({@link AuthFlag.RoLanes}; 1 = single `ro` channel). */
  private lanes = 1;
  private tunnelRemoteCandidates = 0;
  private readonly peers = new Map<number, EdgePeer>();
  private pendingCount = 0;
  private openBucket: TokenBucket | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private alive = true;
  private readonly w = new Writer(1024);
  private scratch = Buffer.allocUnsafe(4096);

  constructor(edge: EdgeServer, ws: WebSocket, id: number, remote: string, source: string | null) {
    this.edge = edge;
    this.ws = ws;
    this.id = id;
    this.remote = remote;
    this.source = source;
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.alive = true;
      try {
        this.onWsMessage(data as Buffer, isBinary);
      } catch (err) {
        this.edge.log(`session ${id}: protocol error: ${(err as Error).message}`);
        this.close(EdgeCloseCode.Protocol, 'protocol error');
      }
    });
    ws.on('pong', () => (this.alive = true));
    ws.on('close', () => this.teardown());
    ws.on('error', () => this.teardown());
    this.deadline = setTimeout(() => this.close(EdgeCloseCode.Timeout, 'auth timeout'), edge.limits.authTimeoutMs);
    // [u8 1][nonce][u8 maxVersion]: protocol-1 hosts read the first two fields only
    const w = this.control(EdgeMsg.Hello);
    w.u8(EDGE_LEGACY_VERSION);
    w.bytes(this.nonce);
    w.u8(EDGE_PROTOCOL_VERSION);
    this.sendWs(w.copyBytes());
  }

  keepAlive(): void {
    if (this.phase === SPhase.Closed) return;
    if (!this.alive) {
      this.edge.log(`session ${this.id}: keep-alive timeout`);
      this.close(EdgeCloseCode.Timeout, 'keep-alive timeout');
      return;
    }
    this.alive = false;
    try {
      this.ws.ping();
    } catch {
      /* closing */
    }
  }

  // ---------------------------------------------------------------- sending

  private control(type: number): Writer {
    const w = this.w;
    w.reset();
    w.u8(type);
    return w;
  }

  private sendWs(bytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  /** In-band control about `slot` (ordered with its `ro` data): the slot's `ro` lane, or the WS. */
  private sendInBand(slot: number, bytes: Uint8Array): void {
    const ch = roLaneChannel(slot, this.lanes);
    const plane = this.plane;
    if (!this.wsData && plane !== null && plane.ready(ch)) {
      const n = bytes.length + 2;
      const buf = this.ensureScratch(n);
      buf[0] = 0;
      buf[1] = 0;
      buf.set(bytes, 2);
      plane.send(ch, buf.subarray(0, n));
    } else this.sendWs(bytes);
  }

  private ensureScratch(n: number): Buffer {
    if (this.scratch.length < n) this.scratch = Buffer.allocUnsafe(Math.max(n, this.scratch.length * 2));
    return this.scratch;
  }

  /** Player → host. */
  private forward(ch: number, slot: number, data: Uint8Array): void {
    const k = this.key!;
    k.messagesIn++;
    k.bytesIn += data.length;
    if (this.wsData) {
      const buf = Buffer.allocUnsafe(3 + data.length);
      buf[0] = EdgeMsg.Data0 + ch;
      buf[1] = slot >>> 8;
      buf[2] = slot & 0xff;
      buf.set(data, 3);
      this.sendWs(buf);
      return;
    }
    const tch = ch === 0 ? roLaneChannel(slot, this.lanes) : ch;
    const plane = this.plane;
    if (plane === null || !plane.ready(tch)) return;
    const n = 2 + data.length;
    const buf = this.ensureScratch(n);
    buf[0] = slot >>> 8;
    buf[1] = slot & 0xff;
    buf.set(data, 2);
    plane.send(tch, buf.subarray(0, n));
  }

  /** Host → player, with the official channel-0 fallback. */
  private deliver(slot: number, ch: number, payload: Uint8Array): void {
    const p = this.peers.get(slot);
    if (p === undefined || p.link === null) return;
    let c = ch < 3 ? ch : 0;
    if (c !== 0 && !p.open[c]) c = 0;
    if (!p.open[c]) return;
    if (p.link.send(c, payload)) {
      const k = this.key!;
      k.messagesOut++;
      k.bytesOut += payload.length;
    }
  }

  // ---------------------------------------------------------------- receiving

  private onWsMessage(data: Buffer, isBinary: boolean): void {
    if (this.phase === SPhase.Closed) return;
    if (!isBinary || data.length === 0) throw new Error('non-binary message');
    const type = data[0]!;
    if (type >= EdgeMsg.Data0 && type <= EdgeMsg.Data2) {
      if (this.phase !== SPhase.Ready || !this.wsData || data.length < 3) return;
      this.deliver((data[1]! << 8) | data[2]!, type - EdgeMsg.Data0, data.subarray(3));
      return;
    }
    if (type === EdgeMsg.Multicast) {
      if (this.key === null) throw new Error('not authenticated');
      if (this.phase === SPhase.Ready && this.wsData) this.onMulticast(data, 1);
      return;
    }
    const r = new Reader(data);
    r.u8();
    switch (type) {
      case EdgeMsg.Auth:
        this.onAuth(r);
        return;
      case EdgeMsg.Ping: {
        const w = this.control(EdgeMsg.Pong);
        w.f64(r.f64());
        this.sendWs(w.copyBytes());
        return;
      }
      case EdgeMsg.Pong:
        return;
    }
    if (this.key === null || this.authing) throw new Error('not authenticated');
    switch (type) {
      case EdgeMsg.TunnelOffer:
        this.onTunnelOffer(readStr(r, EdgeLimits.maxSdp));
        return;
      case EdgeMsg.TunnelCandidate: {
        const c = candidateLine(readStr(r, EdgeLimits.maxCandidate));
        const mid = readStr(r, EdgeLimits.maxMid);
        if (this.ndc === null || ++this.tunnelRemoteCandidates > EdgeLimits.maxRemoteCandidates) return;
        if (!remoteCandidateOk(this.edge.remotePolicy, c)) return;
        this.ndc.addRemoteCandidate(c, mid);
        return;
      }
      case EdgeMsg.PeerOpen:
        this.onPeerOpen(r.u16(), readStr(r, EdgeLimits.maxSdp));
        return;
      case EdgeMsg.PeerRemoteCandidate:
        this.onPeerCandidate(r.u16(), readStr(r, EdgeLimits.maxCandidate), readStr(r, EdgeLimits.maxMid));
        return;
      case EdgeMsg.PeerClose:
        this.closePeer(r.u16(), null);
        return;
      default:
        throw new Error(`unknown message type ${type}`);
    }
  }

  /** Data-plane frame from the host on tunnel channel `ch`. */
  private onDcMessage(ch: number, msg: Uint8Array): void {
    // DataPlane too: the host may see the channels open (and use them) a moment before we do
    if ((this.phase !== SPhase.Ready && this.phase !== SPhase.DataPlane) || msg.length < 2) return;
    const slot = (msg[0]! << 8) | msg[1]!;
    if (slot !== 0) {
      this.deliver(slot, ch, msg.subarray(2));
      return;
    }
    if (msg.length < 3) return;
    // in-band control `[u16 0][u8 type]…`, parsed in place (multicasts are hot: every broadcast)
    const type = msg[2]!;
    if (type === EdgeMsg.Multicast) this.onMulticast(msg, 3);
    else if (type === EdgeMsg.PeerClose && msg.length >= 5) this.closePeer((msg[3]! << 8) | msg[4]!, null);
  }

  /** `[u8 channel][u8 n][u16 slot × n][payload]` starting at `at`: one payload view for every slot. */
  private onMulticast(d: Uint8Array, at: number): void {
    if (at + 2 > d.length) return;
    const ch = d[at]!;
    const start = at + 2;
    const end = start + 2 * d[at + 1]!;
    if (end > d.length) return;
    const payload = d.subarray(end);
    for (let i = start; i < end; i += 2) this.deliver((d[i]! << 8) | d[i + 1]!, ch, payload);
  }

  // ---------------------------------------------------------------- auth + data plane

  private onAuth(r: Reader): void {
    if (this.phase !== SPhase.Hello || this.key !== null || this.authing) throw new Error('unexpected auth');
    const version = r.u8();
    if (version !== EDGE_LEGACY_VERSION && version !== EDGE_PROTOCOL_VERSION) {
      this.close(EdgeCloseCode.Version, `edge speaks protocols ${EDGE_LEGACY_VERSION}-${EDGE_PROTOCOL_VERSION}`);
      return;
    }
    const keyId = readStr(r, EdgeLimits.maxKeyId);
    const mac = r.bytes(EDGE_MAC_LENGTH);
    let flags = r.u8();
    let hostPub: Uint8Array | null = null;
    if (version === EDGE_LEGACY_VERSION) flags &= AuthFlag.WebRtc | AuthFlag.RoLanes;
    else if ((flags & AuthFlag.Udp) !== 0) hostPub = r.bytesCopy(EDGE_X25519_LENGTH);
    const nonce = this.nonce;
    const k = this.edge.authenticate(keyId, mac, (secret) =>
      version === EDGE_LEGACY_VERSION ? edgeAuthMac(secret, nonce) : edgeAuthMacV2(secret, nonce, flags, hostPub),
    );
    if (k === null) {
      this.edge.log(`session ${this.id} from ${this.remote}: authentication failed (key "${printable(keyId.slice(0, 32))}")`);
      this.close(EdgeCloseCode.AuthFailed, 'authentication failed');
      return;
    }
    if (k.sessions >= this.edge.sessionQuota(k)) {
      this.close(EdgeCloseCode.Quota, 'too many sessions for this key');
      return;
    }
    if (!this.edge.hasRoom()) {
      this.close(EdgeCloseCode.Quota, 'edge full');
      return;
    }
    // data plane: the UDP tunnel, else the legacy PeerConnection, else this WebSocket
    const lim = this.edge.limits;
    let plane: DataPlaneKind = 'ws';
    if (hostPub !== null && this.edge.udp !== null) plane = 'udp';
    else if ((flags & AuthFlag.WebRtc) !== 0 && this.edge.allowWebRtcTunnel) plane = 'webrtc';
    if (plane === 'ws' && !lim.allowWsDataPlane) {
      this.close(EdgeCloseCode.Quota, 'WebSocket data plane disabled on this edge');
      return;
    }
    this.key = k;
    k.sessions++;
    this.edge.leavePreAuth(this);
    if (plane === 'webrtc' && ndcModule === null) {
      // the legacy tunnel needs node-datachannel: load it now (only hosts asking for it pay for it)
      this.authing = true;
      void loadNdc((m) => this.edge.log(m)).then((mod) => {
        this.authing = false;
        if (this.phase === SPhase.Closed) return;
        if (mod === null && !lim.allowWsDataPlane) {
          this.close(EdgeCloseCode.Quota, 'no WebRTC on this edge and WebSocket data plane disabled');
          return;
        }
        this.grant(mod !== null ? 'webrtc' : 'ws', version, flags, hostPub);
      });
      return;
    }
    this.grant(plane, version, flags, hostPub);
  }

  /** Sends `AuthOk` for the chosen data plane and arms its deadline. */
  private grant(plane: DataPlaneKind, version: number, flags: number, hostPub: Uint8Array | null): void {
    const k = this.key!;
    const lim = this.edge.limits;
    this.openBucket = new TokenBucket(lim.peerOpenCapacity, lim.peerOpenMsPerToken);
    this.dataPlane = plane;
    this.wsData = plane === 'ws';
    if (plane !== 'ws' && (flags & AuthFlag.RoLanes) !== 0) this.lanes = EDGE_RO_LANES;
    const lanesFlag = this.lanes > 1 ? AuthFlag.RoLanes : 0;
    const aead = plane === 'udp' ? grantTunnelAead(flags, this.edge.udp!.aead) : 'aes-128-gcm';
    const granted = plane === 'udp' ? AuthFlag.Udp | lanesFlag | tunnelAeadFlag(aead) : plane === 'webrtc' ? AuthFlag.WebRtc | lanesFlag : 0;
    const w = this.control(EdgeMsg.AuthOk);
    w.u32(this.id);
    w.u16(Math.min(lim.maxPeersPerSession, 0xffff));
    w.u8(granted);
    if (plane === 'udp') {
      const udp = this.edge.udp!;
      const x = x25519Generate();
      let shared: Buffer;
      try {
        shared = x25519Shared(x.privateKey, hostPub!);
      } catch {
        this.close(EdgeCloseCode.Protocol, 'bad key share');
        return;
      }
      const nonce = this.nonce;
      const conn = udp.open((connId) => deriveTunnelSecrets(shared, k.cfg.secret, nonce, hostPub!, x.publicKey, connId), this.lanes, {
        onOpen: () => {
          if (this.udpConn !== conn || this.phase !== SPhase.DataPlane) return;
          this.dataPlaneUp();
        },
        onMessage: (ch, data) => {
          if (this.udpConn === conn) this.onDcMessage(ch, data);
        },
        onClose: (reason) => {
          if (this.udpConn === conn) this.close(EdgeCloseCode.Timeout, `tunnel ${reason}`);
        },
        onError: (err) => this.edge.log(`session ${this.id}: tunnel: ${(err as Error)?.message ?? err}`),
      }, { aead });
      this.udpConn = conn;
      this.plane = { ready: () => conn.plane.open, send: (ch, f) => conn.plane.send(ch, f) };
      const t = this.edge.opts.tunnel ?? {};
      w.bytes(x.publicKey);
      w.u32(conn.connId);
      w.u16(t.publicPort ?? udp.port);
      w.string(t.publicHost ?? '');
      const body = w.copyBytes();
      const okMac = edgeAuthOkMac(k.cfg.secret, nonce, hostPub!, body);
      const msg = Buffer.allocUnsafe(body.length + okMac.length);
      msg.set(body, 0);
      msg.set(okMac, body.length);
      this.sendWs(msg);
    } else this.sendWs(w.copyBytes());
    this.edge.log(`session ${this.id}: key "${k.cfg.id}" from ${this.remote} (protocol ${version}, data plane ${plane}${this.lanes > 1 ? ', ro lanes' : ''})`);
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    if (plane !== 'ws') {
      this.phase = SPhase.DataPlane;
      this.deadline = setTimeout(() => this.close(EdgeCloseCode.Timeout, 'data plane timeout'), lim.dataPlaneTimeoutMs);
    } else this.phase = SPhase.Ready;
  }

  private dataPlaneUp(): void {
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    this.phase = SPhase.Ready;
    this.edge.log(`session ${this.id}: data plane up (${this.dataPlane})`);
  }

  private onTunnelOffer(sdp: string): void {
    const mod = ndcModule;
    if (this.phase !== SPhase.DataPlane || this.dataPlane !== 'webrtc' || this.ndc !== null || mod === null) throw new Error('unexpected tunnel offer');
    const policy = this.edge.icePolicy;
    const ndc = new mod.NdcTunnelPlane(`edge-tunnel-${this.id}`, this.edge.tunnelRtc, this.lanes, {
      onOpen: () => {
        if (this.ndc === ndc && this.phase === SPhase.DataPlane) this.dataPlaneUp();
      },
      onMessage: (ch, data) => {
        if (this.ndc === ndc) this.onDcMessage(ch, data);
      },
      onClose: (reason) => {
        if (this.ndc === ndc) this.close(EdgeCloseCode.Timeout, reason);
      },
      onLocalCandidate: (cand, mid) => {
        if (this.ndc !== ndc) return;
        const line = filterCandidate(cand, policy);
        if (line === null || line.length === 0) return;
        const w = this.control(EdgeMsg.TunnelCandidate);
        w.string(line);
        w.string(mid);
        this.sendWs(w.copyBytes());
      },
      onError: (err) => this.edge.log(`session ${this.id}: tunnel pc error: ${err.message}`),
    });
    this.ndc = ndc;
    this.plane = ndc;
    // remote (host) candidates inside the offer obey the remote policy too
    const answer = ndc.answer(filterSdp(sdp, this.edge.remotePolicy));
    const w = this.control(EdgeMsg.TunnelAnswer);
    w.string(filterSdp(answer, policy));
    this.sendWs(w.copyBytes());
  }

  // ---------------------------------------------------------------- players

  private peerClosedMsg(slot: number, reason: number): Uint8Array {
    const w = this.control(EdgeMsg.PeerClosed);
    w.u16(slot);
    w.u8(reason);
    return w.copyBytes();
  }

  private refuse(slot: number, reason: number, why: string): void {
    this.edge.log(`session ${this.id}: peer slot ${slot} refused (${why})`);
    this.sendWs(this.peerClosedMsg(slot, reason));
  }

  private onPeerOpen(slot: number, sdp: string): void {
    const k = this.key!;
    const lim = this.edge.limits;
    const players = this.edge.players;
    // DataPlane is accepted: the host may see the tunnel channels open a moment before the edge does
    if ((this.phase !== SPhase.Ready && this.phase !== SPhase.DataPlane) || players === null) return this.refuse(slot, EdgePeerClose.Failed, 'not ready');
    if (slot === 0 || this.peers.has(slot)) return this.refuse(slot, EdgePeerClose.Limit, 'slot in use');
    if (this.peers.size >= lim.maxPeersPerSession) return this.refuse(slot, EdgePeerClose.Limit, 'session peer limit');
    if (k.peers >= this.edge.peerQuota(k)) return this.refuse(slot, EdgePeerClose.Limit, 'key peer quota');
    if (this.pendingCount >= lim.maxPendingPerSession) return this.refuse(slot, EdgePeerClose.Limit, 'too many pending');
    if (!this.openBucket!.take()) return this.refuse(slot, EdgePeerClose.Limit, 'peer open rate');
    if (sdp.indexOf('m=application') < 0) return this.refuse(slot, EdgePeerClose.Failed, 'not a data-channel offer');

    const peer = new EdgePeer(slot);
    this.peers.set(slot, peer);
    this.pendingCount++;
    // negotiation timeouts: swept once per second while a negotiation is pending
    if (this.sweepTimer === null) this.sweepTimer = setInterval(() => this.sweep(), 1000);
    k.peers++;
    const policy = this.edge.icePolicy;
    const ev: PeerLinkEvents = {
      onLocalDescription: (answer) => {
        if (peer.closed) return;
        const w = this.control(EdgeMsg.PeerAnswer);
        w.u16(slot);
        w.string(filterSdp(answer, policy));
        this.sendWs(w.copyBytes());
      },
      onLocalCandidate: (cand, mid) => {
        if (peer.closed) return;
        const line = filterCandidate(candidateLine(cand), policy);
        if (line === null || line.length === 0) return;
        const w = this.control(EdgeMsg.PeerLocalCandidate);
        w.u16(slot);
        w.string(line);
        w.string(mid);
        this.sendWs(w.copyBytes());
      },
      onGatheringComplete: () => {
        if (peer.closed) return;
        const w = this.control(EdgeMsg.PeerGathered);
        w.u16(slot);
        this.sendWs(w.copyBytes());
      },
      onChannelOpen: (index, remoteAddress) => {
        if (peer.closed) return;
        peer.open[index] = true;
        if (index === 0 && peer.bucket === null) {
          this.pendingCount--;
          peer.bucket = new TokenBucket(lim.floodCapacity, lim.floodMsPerToken);
        }
        const w = this.control(EdgeMsg.PeerChannelOpen);
        w.u16(slot);
        w.u8(index);
        w.string(remoteAddress ?? '');
        this.sendInBand(slot, w.copyBytes());
      },
      onChannelClosed: () => this.closePeer(slot, EdgePeerClose.Closed),
      onConnectionState: (state) => this.closePeer(slot, state === 'failed' ? EdgePeerClose.Failed : EdgePeerClose.Closed),
      onMessage: (index, data) => {
        if (peer.closed) return;
        const bucket = peer.bucket;
        // official `la`: any message before channel 0 opens fails the negotiation
        if (bucket === null) return this.closePeer(slot, EdgePeerClose.Failed);
        if (!bucket.take()) {
          k.floods++;
          this.edge.log(`session ${this.id}: peer slot ${slot} flooding`);
          return this.closePeer(slot, EdgePeerClose.Flood);
        }
        if (typeof data === 'string') return this.closePeer(slot, EdgePeerClose.Protocol);
        this.forward(index, slot, data);
      },
      onAbuse: () => {},
      onError: (err) => this.edge.log(`session ${this.id}: peer slot ${slot}: ${err.message}`),
    };
    try {
      const link = players.createLink(`edge-${this.id}-${slot}`, filterSdp(sdp, this.edge.remotePolicy), ev);
      if (peer.closed) link.close();
      else peer.link = link;
    } catch (err) {
      this.edge.log(`session ${this.id}: peer slot ${slot}: bad offer: ${printable((err as Error).message)}`);
      this.closePeer(slot, EdgePeerClose.Failed);
    }
  }

  private onPeerCandidate(slot: number, candidate: string, mid: string): void {
    const p = this.peers.get(slot);
    if (p === undefined || p.link === null) return;
    if (++p.remoteCandidates > EdgeLimits.maxRemoteCandidates) return;
    const line = candidateLine(candidate);
    if (!remoteCandidateOk(this.edge.remotePolicy, line)) return;
    p.link.addRemoteCandidate(line, mid);
  }

  /**
   * Closes a player connection; `reason !== null` reports it to the host
   * (in-band). Host-requested closes keep the connection 250 ms so a
   * just-sent kick notice can leave first.
   */
  private closePeer(slot: number, reason: number | null, lingerMs = reason === null ? 250 : 0): void {
    const p = this.peers.get(slot);
    if (p === undefined || p.closed) return;
    p.closed = true;
    this.peers.delete(slot);
    if (p.bucket === null) this.pendingCount--;
    const k = this.key;
    if (k !== null) k.peers--;
    const link = p.link;
    p.link = null;
    if (link !== null) {
      if (lingerMs > 0) setTimeout(() => link.close(), lingerMs);
      else link.close();
    }
    if (reason !== null && this.phase !== SPhase.Closed) this.sendInBand(slot, this.peerClosedMsg(slot, reason));
  }

  private sweep(): void {
    const now = performance.now();
    const t = this.edge.limits.channelOpenTimeoutMs;
    for (const p of this.peers.values()) {
      if (p.bucket === null && now - p.createdAt > t) this.closePeer(p.slot, EdgePeerClose.Failed);
    }
    if (this.pendingCount <= 0 && this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ---------------------------------------------------------------- teardown

  close(code: number, reason: string): void {
    if (this.phase === SPhase.Closed) return;
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
    this.teardown();
    // don't wait for a misbehaving peer's close handshake
    setTimeout(() => this.ws.terminate(), 2000).unref();
  }

  private teardown(): void {
    if (this.phase === SPhase.Closed) return;
    this.phase = SPhase.Closed;
    this.edge.removeSession(this);
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const slot of [...this.peers.keys()]) this.closePeer(slot, null, 0);
    if (this.key !== null) this.key.sessions--;
    this.plane = null;
    const conn = this.udpConn;
    this.udpConn = null;
    if (conn !== null) conn.close();
    const ndc = this.ndc;
    this.ndc = null;
    if (ndc !== null) ndc.close();
    this.edge.log(`session ${this.id}: closed`);
  }
}
