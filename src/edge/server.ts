/**
 * haxlite Edge server: a game-agnostic WebRTC gateway that terminates the
 * players' PeerConnections on a public (protected) machine and relays their
 * data-channel payloads to haxlite hosts through outbound tunnels, so the
 * hosts' addresses are never exposed to players. See docs/09-haxlite-edge.md
 * and `src/net/edge-protocol.ts` for the wire format.
 *
 * ```
 *  player ══ WebRTC (ro/ru/uu) ══▶ EdgeServer ── EdgeSession (per host tunnel) ══ WS + PC ══ host
 * ```
 *
 * One {@link EdgeSession} per tunnel WebSocket (one room). Many hosts (API
 * keys) and many rooms per key, each bounded by per-key quotas.
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { DataChannel, PeerConnection, RtcConfig } from 'node-datachannel';
import { Reader, Writer } from '../codec/index.js';
import { CHANNELS, DEFAULT_ICE_SERVERS, NetDefaults } from '../net/constants.js';
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
import { LocalPeerLink, type PeerLinkEvents } from '../net/peer-backend.js';
import { TokenBucket } from '../net/rate-limit.js';
import { closeNative, createDataChannel, createPeerConnection, shutdownWebRtc, webRtcStats } from '../net/webrtc.js';
import {
  AuthFlag,
  EDGE_DEFAULT_PATH,
  EDGE_MAC_LENGTH,
  EDGE_NONCE_LENGTH,
  EDGE_PROTOCOL_VERSION,
  EdgeCloseCode,
  EdgeLimits,
  EdgeMsg,
  EdgePeerClose,
  edgeAuthMac,
  edgeMacEqual,
} from '../net/edge-protocol.js';

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
  /** STUN/TURN for the edge's own PeerConnections (default Google STUN, to learn the public IP behind 1:1 NAT). */
  iceServers?: readonly IceServerConfig[];
  /** UDP port range for player and tunnel PeerConnections (one port each unless `enableIceUdpMux`). */
  portRange?: readonly [number, number] | null;
  /** Local address to bind (and announce). */
  bindAddress?: string;
  /** All PeerConnections on one UDP port (`portRange[0]`). */
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
  /** Concurrent tunnel sessions on this edge. Default 1000. */
  maxSessions?: number;
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
  /** Listen address. Default `'0.0.0.0'`. */
  host?: string;
  /** Listen port. Default 8443 (0 = ephemeral). */
  port?: number;
  /** WS path. Default `/tunnel`. */
  path?: string;
  /** TLS (`wss://`): PEM file paths. Reloaded on {@link EdgeServer.reloadTls} (SIGHUP in the CLI). */
  tls?: { certFile: string; keyFile: string } | null;
  /** Use an existing HTTP(S) server instead of creating one (`host`/`port`/`tls` ignored). */
  server?: http.Server | https.Server;
  keys: readonly EdgeKeyConfig[];
  webrtc?: EdgeWebRtcOptions;
  limits?: EdgeLimitsOptions;
  /** `GET <path>` returns {@link EdgeStats} as JSON (`null` disables). Default `/stats`. */
  statsPath?: string | null;
  /** Bearer token required by the stats endpoint (default none: bind it to a private address or firewall it). */
  statsToken?: string | null;
  /** Log a one-line summary every N ms (0 = off). */
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
  sessions: number;
  peers: number;
  authFailures: number;
  keys: EdgeKeyStats[];
  webrtc: ReturnType<typeof webRtcStats>;
  memoryRssMb: number;
}

const DEFAULTS = {
  maxSessions: 1000,
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

export class EdgeServer {
  readonly opts: EdgeServerOptions;
  private readonly server: http.Server | https.Server;
  private readonly ownsServer: boolean;
  private readonly wss: WebSocketServer;
  private readonly keys = new Map<string, KeyState>();
  /** @internal */ readonly sessions = new Set<EdgeSession>();
  /** @internal */ readonly limits: Required<EdgeLimitsOptions>;
  /** @internal */ readonly playerRtc: RtcConfig;
  /** @internal */ readonly tunnelRtc: RtcConfig;
  /** @internal */ readonly icePolicy: IceCandidatePolicy;
  /** @internal */ readonly remotePolicy: 'public' | 'private' | 'all';
  private readonly startedAt = performance.now();
  private authFailures = 0;
  private nextSessionId = 1;
  private keepAliveTimer: NodeJS.Timeout | null = null;
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
    this.limits = { ...DEFAULTS, allowWsDataPlane: true, ...stripUndefined(opts.limits ?? {}) };
    const w = opts.webrtc ?? {};
    const range = w.portRange;
    const base: RtcConfig = {
      iceServers: toNativeIceServers(w.iceServers ?? DEFAULT_ICE_SERVERS),
      ...(range ? { portRangeBegin: range[0], portRangeEnd: range[1] } : null),
      ...(w.bindAddress !== undefined ? { bindAddress: w.bindAddress } : null),
      ...(w.enableIceUdpMux ? { enableIceUdpMux: true } : null),
    };
    this.playerRtc = { ...base, ...w.rtc, iceServers: base.iceServers, disableAutoNegotiation: true };
    this.tunnelRtc = { ...base, maxMessageSize: 1 << 20, disableAutoNegotiation: true };
    this.icePolicy = w.iceCandidatePolicy ?? 'public';
    this.remotePolicy = w.remoteCandidatePolicy ?? 'public';

    if (opts.server) {
      this.server = opts.server;
      this.ownsServer = false;
    } else if (opts.tls) {
      this.server = https.createServer({ cert: readFileSync(opts.tls.certFile), key: readFileSync(opts.tls.keyFile) });
      this.ownsServer = true;
    } else {
      this.server = http.createServer();
      this.ownsServer = true;
    }
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: EdgeLimits.maxWsMessage + 4096 });
    this.server.on('upgrade', this.onUpgrade);
    this.server.on('request', this.onRequest);
  }

  /** Creates and starts listening. */
  static async start(opts: EdgeServerOptions): Promise<EdgeServer> {
    const s = new EdgeServer(opts);
    await s.listen();
    return s;
  }

  async listen(): Promise<void> {
    if (this.ownsServer && !this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.opts.port ?? 8443, this.opts.host ?? '0.0.0.0', () => {
          this.server.off('error', reject);
          resolve();
        });
      });
    }
    const every = this.opts.statsLogIntervalMs ?? 0;
    if (every > 0) this.statsTimer = setInterval(() => this.logStats(), every);
  }

  /** Bound address (`{address, port}`). */
  get address(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  /** `ws(s)://host:port/path` for hosts on this machine (tests). */
  url(host?: string): string {
    const a = this.address;
    const h = host ?? (a.address === '0.0.0.0' || a.address === '::' ? '127.0.0.1' : a.address);
    const scheme = this.server instanceof https.Server ? 'wss' : 'ws';
    return `${scheme}://${h.includes(':') ? `[${h}]` : h}:${a.port}${this.opts.path ?? EDGE_DEFAULT_PATH}`;
  }

  /** Re-reads the TLS certificate/key files (e.g. after a Let's Encrypt renewal). */
  reloadTls(): void {
    const t = this.opts.tls;
    if (!t || !(this.server instanceof https.Server)) return;
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
    if (opts.shutdownWebRtc) await shutdownWebRtc();
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
      sessions: this.sessions.size,
      peers,
      authFailures: this.authFailures,
      keys,
      webrtc: webRtcStats(),
      memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
    };
  }

  private logStats(): void {
    const s = this.stats();
    const per = s.keys
      .filter((k) => k.sessions > 0 || k.ppsIn > 0)
      .map((k) => `${k.id}: ${k.sessions}s/${k.peers}p in ${k.ppsIn}pps out ${k.ppsOut}pps`)
      .join('; ');
    this.log(`stats sessions=${s.sessions} peers=${s.peers} pcs=${s.webrtc.peerConnections} rss=${s.memoryRssMb}MB${per ? ` | ${per}` : ''}`);
  }

  // ------------------------------------------------------------------ HTTP

  private readonly onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
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
      res.end(JSON.stringify(this.stats()));
      return;
    }
    res.writeHead(404).end();
  };

  private readonly onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0];
    if (this.closed || path !== (this.opts.path ?? EDGE_DEFAULT_PATH)) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (this.sessions.size >= this.limits.maxSessions) {
        ws.close(EdgeCloseCode.Quota, 'edge full');
        return;
      }
      const remote = req.socket.remoteAddress ?? '?';
      const s = new EdgeSession(this, ws, this.nextSessionId++, remote);
      this.sessions.add(s);
      // keep-alive pings only while there is a tunnel to keep alive
      if (this.keepAliveTimer === null) this.keepAliveTimer = setInterval(() => this.keepAlive(), this.limits.keepAliveMs);
    });
  };

  private keepAlive(): void {
    for (const s of this.sessions) s.keepAlive();
  }

  // ------------------------------------------------------------------ auth / quotas

  /** @internal Returns the key state if the MAC matches, else null (constant-time on the MAC). */
  authenticate(keyId: string, nonce: Uint8Array, mac: Uint8Array): KeyState | null {
    const k = this.keys.get(keyId);
    const expected = edgeAuthMac(k?.cfg.secret ?? this.dummySecret, nonce);
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

  /** @internal */ removeSession(s: EdgeSession): void {
    this.sessions.delete(s);
    if (this.sessions.size === 0 && this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
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
  link: LocalPeerLink | null = null;
  readonly open = [false, false, false];
  bucket: TokenBucket | null = null;
  remoteCandidates = 0;
  readonly createdAt = performance.now();
  closed = false;
  constructor(slot: number) {
    this.slot = slot;
  }
}

/** One host tunnel (one room). */
class EdgeSession {
  readonly id: number;
  phase: SPhase = SPhase.Hello;
  private readonly edge: EdgeServer;
  private readonly ws: WebSocket;
  private readonly remote: string;
  private readonly nonce = randomBytes(EDGE_NONCE_LENGTH);
  private key: KeyState | null = null;
  private wsData = false;
  private pc: PeerConnection | null = null;
  private readonly dcs: (DataChannel | null)[] = [null, null, null];
  private readonly dcOpen = [false, false, false];
  private tunnelRemoteCandidates = 0;
  private readonly peers = new Map<number, EdgePeer>();
  private pendingCount = 0;
  private openBucket: TokenBucket | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private alive = true;
  private readonly w = new Writer(1024);
  private scratch = Buffer.allocUnsafe(4096);

  constructor(edge: EdgeServer, ws: WebSocket, id: number, remote: string) {
    this.edge = edge;
    this.ws = ws;
    this.id = id;
    this.remote = remote;
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
    const w = this.control(EdgeMsg.Hello);
    w.u8(EDGE_PROTOCOL_VERSION);
    w.bytes(this.nonce);
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

  /** In-band control (ordered with data on `ro`): the data-plane `ro` channel, or the WS. */
  private sendInBand(bytes: Uint8Array): void {
    if (!this.wsData && this.dcOpen[0]) {
      const n = bytes.length + 2;
      const buf = this.ensureScratch(n);
      buf[0] = 0;
      buf[1] = 0;
      buf.set(bytes, 2);
      try {
        this.dcs[0]!.sendMessageBinary(buf.subarray(0, n));
      } catch {
        /* closing */
      }
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
    const dc = this.dcs[ch];
    if (dc == null || !this.dcOpen[ch]) return;
    const n = 2 + data.length;
    const buf = this.ensureScratch(n);
    buf[0] = slot >>> 8;
    buf[1] = slot & 0xff;
    buf.set(data, 2);
    try {
      dc.sendMessageBinary(buf.subarray(0, n));
    } catch {
      /* closing */
    }
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
    if (this.key === null) throw new Error('not authenticated');
    switch (type) {
      case EdgeMsg.TunnelOffer:
        this.onTunnelOffer(readStr(r, EdgeLimits.maxSdp));
        return;
      case EdgeMsg.TunnelCandidate: {
        const c = candidateLine(readStr(r, EdgeLimits.maxCandidate));
        const mid = readStr(r, EdgeLimits.maxMid);
        if (this.pc === null || ++this.tunnelRemoteCandidates > EdgeLimits.maxRemoteCandidates) return;
        if (!remoteCandidateOk(this.edge.remotePolicy, c)) return;
        try {
          this.pc.addRemoteCandidate(c, mid);
        } catch {
          /* ignore */
        }
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
  private onDcMessage(ch: number, msg: Buffer): void {
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
  private onMulticast(d: Buffer, at: number): void {
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
    if (this.phase !== SPhase.Hello || this.key !== null) throw new Error('unexpected auth');
    const version = r.u8();
    if (version !== EDGE_PROTOCOL_VERSION) {
      this.close(EdgeCloseCode.Version, `edge speaks protocol ${EDGE_PROTOCOL_VERSION}`);
      return;
    }
    const keyId = readStr(r, EdgeLimits.maxKeyId);
    const mac = r.bytes(EDGE_MAC_LENGTH);
    const flags = r.u8();
    const k = this.edge.authenticate(keyId, this.nonce, mac);
    if (k === null) {
      this.edge.log(`session ${this.id} from ${this.remote}: authentication failed (key "${keyId.slice(0, 32)}")`);
      this.close(EdgeCloseCode.AuthFailed, 'authentication failed');
      return;
    }
    if (k.sessions >= this.edge.sessionQuota(k)) {
      this.close(EdgeCloseCode.Quota, 'too many sessions for this key');
      return;
    }
    const webrtc = (flags & AuthFlag.WebRtc) !== 0;
    if (!webrtc && !this.edge.limits.allowWsDataPlane) {
      this.close(EdgeCloseCode.Quota, 'WebSocket data plane disabled on this edge');
      return;
    }
    this.key = k;
    k.sessions++;
    const lim = this.edge.limits;
    this.openBucket = new TokenBucket(lim.peerOpenCapacity, lim.peerOpenMsPerToken);
    this.wsData = !webrtc;
    const w = this.control(EdgeMsg.AuthOk);
    w.u32(this.id);
    w.u16(Math.min(lim.maxPeersPerSession, 0xffff));
    w.u8(flags & AuthFlag.WebRtc);
    this.sendWs(w.copyBytes());
    this.edge.log(`session ${this.id}: key "${k.cfg.id}" from ${this.remote} (data plane ${webrtc ? 'webrtc' : 'ws'})`);
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    if (webrtc) {
      this.phase = SPhase.DataPlane;
      this.deadline = setTimeout(() => this.close(EdgeCloseCode.Timeout, 'data plane timeout'), lim.dataPlaneTimeoutMs);
    } else this.phase = SPhase.Ready;
  }

  private onTunnelOffer(sdp: string): void {
    if (this.phase !== SPhase.DataPlane || this.pc !== null) throw new Error('unexpected tunnel offer');
    const policy = this.edge.icePolicy;
    const onError = (err: Error) => this.edge.log(`session ${this.id}: tunnel pc error: ${err.message}`);
    const pc = createPeerConnection(`edge-tunnel-${this.id}`, this.edge.tunnelRtc, {
      onLocalCandidate: (cand, mid) => {
        if (this.pc !== pc) return;
        const line = filterCandidate(candidateLine(cand), policy);
        if (line === null || line.length === 0) return;
        const w = this.control(EdgeMsg.TunnelCandidate);
        w.string(line);
        w.string(mid);
        this.sendWs(w.copyBytes());
      },
      onStateChange: (state) => {
        if (this.pc !== pc) return;
        if (state === 'failed' || state === 'closed') this.close(EdgeCloseCode.Timeout, `tunnel connection ${state}`);
      },
      onError,
    });
    this.pc = pc;
    for (let i = 0; i < CHANNELS.length; i++) {
      const cfg = CHANNELS[i]!;
      const dc = createDataChannel(
        pc,
        `tunnel-${cfg.label}`,
        { negotiated: true, id: i, unordered: !cfg.ordered, ...(cfg.reliable ? {} : { maxRetransmits: 0 }) },
        {
          onOpen: () => {
            if (this.dcs[i] !== dc) return;
            this.dcOpen[i] = true;
            if (this.phase === SPhase.DataPlane && this.dcOpen.every((x) => x)) {
              if (this.deadline !== null) clearTimeout(this.deadline);
              this.deadline = null;
              this.phase = SPhase.Ready;
              this.edge.log(`session ${this.id}: data plane up`);
            }
          },
          onClosed: () => {
            if (this.dcs[i] !== dc) return;
            this.dcOpen[i] = false;
            this.close(EdgeCloseCode.Timeout, `tunnel channel ${cfg.label} closed`);
          },
          onMessage: (msg) => {
            if (this.dcs[i] !== dc || typeof msg === 'string') return;
            this.onDcMessage(i, msg instanceof ArrayBuffer ? Buffer.from(msg) : msg);
          },
          onError,
        },
      );
      this.dcs[i] = dc;
    }
    // remote (host) candidates inside the offer obey the remote policy too
    pc.setRemoteDescription(filterSdp(sdp, this.edge.remotePolicy), 'offer');
    pc.setLocalDescription('answer');
    const answer = pc.localDescription()?.sdp;
    if (answer === undefined) throw new Error('no tunnel answer');
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
    // DataPlane is accepted: the host may see the tunnel channels open a moment before the edge does
    if (this.phase !== SPhase.Ready && this.phase !== SPhase.DataPlane) return this.refuse(slot, EdgePeerClose.Failed, 'not ready');
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
        const w = this.control(EdgeMsg.PeerAnswer);
        w.u16(slot);
        w.string(filterSdp(answer, policy));
        this.sendWs(w.copyBytes());
      },
      onLocalCandidate: (cand, mid) => {
        const line = filterCandidate(candidateLine(cand), policy);
        if (line === null || line.length === 0) return;
        const w = this.control(EdgeMsg.PeerLocalCandidate);
        w.u16(slot);
        w.string(line);
        w.string(mid);
        this.sendWs(w.copyBytes());
      },
      onGatheringComplete: () => {
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
        this.sendInBand(w.copyBytes());
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
      peer.link = new LocalPeerLink(`edge-${this.id}-${slot}`, this.edge.playerRtc, filterSdp(sdp, this.edge.remotePolicy), ev);
    } catch (err) {
      this.edge.log(`session ${this.id}: peer slot ${slot}: bad offer: ${(err as Error).message}`);
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
   * (in-band). Host-requested closes keep the PeerConnection 250 ms so a
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
    if (reason !== null && this.phase !== SPhase.Closed) this.sendInBand(this.peerClosedMsg(slot, reason));
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
    for (let i = 0; i < this.dcs.length; i++) {
      const dc = this.dcs[i];
      this.dcs[i] = null;
      this.dcOpen[i] = false;
      if (dc != null) closeNative(dc);
    }
    const pc = this.pc;
    this.pc = null;
    if (pc !== null) closeNative(pc);
    this.edge.log(`session ${this.id}: closed`);
  }
}
