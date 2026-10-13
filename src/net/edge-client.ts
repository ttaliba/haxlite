/**
 * Host side of the haxlite Edge tunnel: {@link EdgePeerBackend}, a
 * {@link PeerBackend} whose player PeerConnections live on a remote edge.
 *
 * ```
 *  HostTransport ── createPeer(offer) ──▶ EdgePeerBackend ══ WS (control, wss)        ══▶ edge ── WebRTC ── player
 *                ◀─ answer/candidates ──                 ══ UDP: SCTP over AES-GCM ══▶
 * ```
 *
 * This process only opens OUTBOUND connections to the edge: the control
 * WebSocket and, for the data plane, one UDP "socket" to the edge's tunnel
 * port (tunnel v2, `edge-udp.ts`: our own SCTP over AEAD datagrams, no
 * native addon), or the legacy host↔edge node-datachannel PeerConnection
 * (`dataPlane: 'webrtc'`, loaded lazily), or the WebSocket itself. If the
 * tunnel drops, every player is lost (official clients cannot reconnect) and
 * the tunnel is re-established with backoff; joins are refused (4104)
 * meanwhile.
 */
import type dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { WebSocket, type ClientOptions, type RawData } from './ws.js';
import { Reader, Writer } from '../codec/index.js';
import { CHANNELS } from './constants.js';
import { candidateLine, toNativeIceServers, type IceServerConfig } from './ice.js';
import type { PeerBackend, PeerLink, PeerLinkEvents } from './peer-backend.js';
import {
  AuthFlag,
  EDGE_LEGACY_VERSION,
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
  parseEdgeKey,
  roLaneChannel,
} from './edge-protocol.js';
import { UdpTunnelPlane, deriveTunnelSecrets, x25519Generate, x25519Shared, type UdpPlaneStats, type X25519Pair } from './edge-udp.js';
import type { NdcTunnelPlane } from './edge-ndc.js';

/** Data plane of a tunnel: `'udp'` (v2, default), `'webrtc'` (legacy node-datachannel), `'ws'`. */
export type EdgeDataPlane = 'udp' | 'webrtc' | 'ws';

export interface EdgeOptions {
  /** Control endpoint, e.g. `wss://edge.example.com:8443/tunnel` (`ws://` only for tests/LAN). */
  url: string;
  /** API key issued by the edge operator: `"<keyId>:<secret>"`. */
  key: string;
  /**
   * When the UDP data plane (tunnel v2, or the legacy PeerConnection) cannot
   * be established within `dataPlaneTimeoutMs` (or the edge does not grant
   * it), carry all player traffic over the WebSocket instead (TCP:
   * head-of-line blocking, slightly more latency). Default true.
   */
  fallbackWs?: boolean;
  /**
   * `'udp'` (default): tunnel v2, SCTP over AES-GCM UDP datagrams to the
   * edge's tunnel port (pure TypeScript). `'webrtc'`: the legacy host↔edge
   * node-datachannel PeerConnection (loads the native addon). `'ws'`: start
   * directly on the WebSocket (UDP known to be blocked).
   */
  dataPlane?: EdgeDataPlane;
  /**
   * Ask the edge for `ro` lanes ({@link AuthFlag.RoLanes}): player `ro`
   * traffic spread over several ordered tunnel channels so a loss on the
   * host↔edge path does not stall every player's `ro` messages. Default true
   * (ignored by edges that don't support it).
   */
  roLanes?: boolean;
  /** Local address for the outbound WebSocket and the tunnel's UDP socket / PeerConnection. */
  bindAddress?: string;
  /** `dataPlane: 'webrtc'` only: STUN/TURN for the tunnel PeerConnection (default none: the edge is public). */
  iceServers?: readonly IceServerConfig[];
  /** `dataPlane: 'webrtc'` only: local UDP port range of the tunnel PeerConnection. */
  portRange?: readonly [number, number] | null;
  /** WS connect + auth deadline. Default 10 s. */
  connectTimeoutMs?: number;
  /** Data-plane PeerConnection deadline (then `fallbackWs`). Default 5 s. */
  dataPlaneTimeoutMs?: number;
  /** Reconnect backoff: first delay (doubles up to `reconnectMaxMs`). Default 250 ms / 10 s. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /**
   * Application ping period and dead-tunnel timeout. Default 5 s / 15 s. With
   * the UDP tunnel the host also sends an authenticated UDP ping each period
   * (NAT keep-alive + RTT) and drops the tunnel when nothing authenticated
   * came back over UDP for `pingTimeoutMs`.
   */
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Extra `ws` client options (TLS `ca`, `rejectUnauthorized`, `agent`…). */
  wsOptions?: ClientOptions;
  /** Debug logger. */
  log?: (msg: string) => void;
  /** @internal tests/benchmarks: UDP tunnel SCTP overrides and rekey threshold. */
  udpTuning?: { sctp?: Record<string, number>; rekeyAfterPackets?: number };
}

export type EdgeState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'stopped';

export type EdgeErrorKind = 'auth' | 'version' | 'quota' | 'protocol' | 'connect' | 'tunnel';

/** Tunnel problem. `fatal` errors (bad key, protocol version) won't fix themselves by retrying. */
export class EdgeError extends Error {
  readonly kind: EdgeErrorKind;
  readonly fatal: boolean;
  constructor(message: string, kind: EdgeErrorKind, fatal = false) {
    super(`[haxlite/edge] ${message}`);
    this.name = 'EdgeError';
    this.kind = kind;
    this.fatal = fatal;
  }
}

export interface EdgeBackendStats {
  state: EdgeState;
  dataPlane: EdgeDataPlane | null;
  /** Ordered tunnel channels carrying player `ro` traffic (1 = single channel; null when not ready). */
  roLanes: number | null;
  sessionId: number | null;
  /** Last tunnel round-trip time (application ping), ms. */
  rttMs: number | null;
  peers: number;
  /** Successful tunnel sessions so far. */
  sessions: number;
  bytesOut: number;
  bytesIn: number;
  messagesOut: number;
  messagesIn: number;
  /** UDP tunnel counters (`dataPlane: 'udp'`), else null. */
  udp: UdpPlaneStats | null;
}

const Phase = {
  Hello: 0,
  Auth: 1,
  DataPlane: 2,
  Ready: 3,
  Closed: 4,
} as const;
type Phase = (typeof Phase)[keyof typeof Phase];

function readStr(r: Reader, max: number): string {
  const n = r.varUint();
  if (n > max || n > r.remaining) throw new Error('string too long');
  return r.stringRaw(n);
}

/** One player connection through the edge. */
class EdgeLink implements PeerLink {
  ev: PeerLinkEvents | null;
  readonly slot: number;
  readonly session: TunnelSession;
  private readonly backend: EdgePeerBackend;
  remoteCandidates = 0;

  constructor(backend: EdgePeerBackend, session: TunnelSession, slot: number, ev: PeerLinkEvents) {
    this.backend = backend;
    this.session = session;
    this.slot = slot;
    this.ev = ev;
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    if (this.ev === null) return;
    if (candidate.length > EdgeLimits.maxCandidate || mid.length > EdgeLimits.maxMid) return;
    if (++this.remoteCandidates > EdgeLimits.maxRemoteCandidates) return;
    this.session.sendPeerCandidate(this.slot, candidate, mid);
  }

  send(index: number, data: Uint8Array): boolean {
    if (this.ev === null) return false;
    return this.session.sendData(index, this.slot, data);
  }

  close(): void {
    if (this.ev === null) return;
    this.ev = null;
    this.backend.forget(this);
    this.session.sendPeerClose(this.slot);
  }
}

/** {@link PeerBackend} that terminates player WebRTC on a haxlite Edge. */
export class EdgePeerBackend implements PeerBackend {
  readonly kind = 'edge';
  readonly prefiltered = true;
  state: EdgeState = 'idle';

  /** @internal */ readonly opts: EdgeOptions;
  /** @internal */ readonly keyId: string;
  /** @internal */ readonly secret: string;
  private handlers: { onReady(): void; onDown(err: Error | null): void; onError(err: Error): void } | null = null;
  private session: TunnelSession | null = null;
  /** @internal */ readonly links = new Map<number, EdgeLink>();
  private nextSlot = 1;
  /** Current data-plane preference (switches to 'ws' after a fallback). */
  private mode: EdgeDataPlane;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sessions = 0;
  /** @internal */ readonly counters = { bytesOut: 0, bytesIn: 0, messagesOut: 0, messagesIn: 0 };

  constructor(opts: EdgeOptions) {
    this.opts = opts;
    const { id, secret } = parseEdgeKey(opts.key);
    this.keyId = id;
    this.secret = secret;
    this.mode = opts.dataPlane ?? 'udp';
    this.backoff = opts.reconnectMinMs ?? 250;
    if (!/^wss?:\/\//i.test(opts.url)) throw new Error('edge url must start with ws:// or wss://');
  }

  get ready(): boolean {
    return this.session !== null && this.session.phase === Phase.Ready;
  }

  stats(): EdgeBackendStats {
    const s = this.session;
    return {
      state: this.state,
      dataPlane: s !== null && s.phase === Phase.Ready ? s.mode : null,
      roLanes: s !== null && s.phase === Phase.Ready ? s.roLanes : null,
      sessionId: s?.sessionId ?? null,
      rttMs: s?.rttMs ?? null,
      peers: this.links.size,
      sessions: this.sessions,
      ...this.counters,
      udp: s !== null && s.phase === Phase.Ready ? s.udpStats() : null,
    };
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

  start(handlers: { onReady(): void; onDown(err: Error | null): void; onError(err: Error): void }): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.handlers = handlers;
    this.state = 'connecting';
    this.connect();
  }

  stop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const s = this.session;
    this.session = null;
    this.dropLinks();
    if (s !== null) s.close(1000, 'host stopped');
  }

  private connect(): void {
    this.reconnectTimer = null;
    if (this.state === 'stopped') return;
    this.log(`connecting to ${this.opts.url} (data plane ${this.mode})`);
    this.session = new TunnelSession(this, this.mode);
  }

  createPeer(_id: number, offerSdp: string, events: PeerLinkEvents): PeerLink {
    const s = this.session;
    if (s === null || s.phase !== Phase.Ready) throw new EdgeError('tunnel not ready', 'tunnel');
    if (offerSdp.length > EdgeLimits.maxSdp) throw new Error('offer SDP too large');
    let slot = this.nextSlot;
    for (let i = 0; this.links.has(slot); i++) {
      if (i > 0xffff) throw new EdgeError('no free slot', 'quota');
      slot = slot >= 0xffff ? 1 : slot + 1;
    }
    this.nextSlot = slot >= 0xffff ? 1 : slot + 1;
    const link = new EdgeLink(this, s, slot, events);
    this.links.set(slot, link);
    s.sendPeerOpen(slot, offerSdp);
    return link;
  }

  sendMany(links: readonly PeerLink[], channel: number, data: Uint8Array): void {
    const s = this.session;
    if (s === null || s.phase !== Phase.Ready) return;
    s.sendMulticast(channel, links as readonly EdgeLink[], data);
  }

  /** @internal */ forget(link: EdgeLink): void {
    if (this.links.get(link.slot) === link) this.links.delete(link.slot);
  }

  // ------------------------------------------------------------ session events

  /** @internal */ onSessionReady(s: TunnelSession): void {
    if (s !== this.session) return;
    this.state = 'ready';
    this.sessions++;
    this.backoff = this.opts.reconnectMinMs ?? 250;
    this.log(`tunnel ready (session ${s.sessionId}, data plane ${s.mode})`);
    this.handlers?.onReady();
  }

  /** @internal */ onSessionDown(s: TunnelSession, err: EdgeError | null, opts: { fallback?: boolean } = {}): void {
    if (s !== this.session) return;
    const wasReady = this.state === 'ready';
    this.session = null;
    this.dropLinks();
    if (this.state === 'stopped') return;
    this.state = 'reconnecting';
    this.log(`tunnel down: ${err?.message ?? 'closed'}`);
    if (err !== null && (wasReady || err.fatal || this.sessions === 0)) this.handlers?.onError(err);
    if (wasReady) this.handlers?.onDown(err);
    let delay = this.backoff;
    if (opts.fallback === true) {
      this.mode = 'ws';
      delay = 0;
    } else if (err?.fatal) {
      delay = this.opts.reconnectMaxMs ?? 10_000;
    } else if (wasReady) {
      delay = 0; // first retry at once: players are waiting
    }
    this.backoff = Math.min(this.backoff * 2, this.opts.reconnectMaxMs ?? 10_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Every live link is lost (tunnel gone): report 'closed' to the transport. */
  private dropLinks(): void {
    if (this.links.size === 0) return;
    const all = [...this.links.values()];
    this.links.clear();
    for (const l of all) {
      const ev = l.ev;
      l.ev = null;
      if (ev !== null) ev.onConnectionState('closed');
    }
  }

  /** @internal control/in-band message for a player slot. */
  onPeerMessage(type: number, r: Reader): void {
    const slot = r.u16();
    const link = this.links.get(slot);
    const ev = link?.ev ?? null;
    if (link === undefined || ev === null) return;
    switch (type) {
      case EdgeMsg.PeerAnswer:
        ev.onLocalDescription(readStr(r, EdgeLimits.maxSdp));
        return;
      case EdgeMsg.PeerLocalCandidate: {
        const cand = readStr(r, EdgeLimits.maxCandidate);
        const mid = readStr(r, EdgeLimits.maxMid);
        ev.onLocalCandidate(candidateLine(cand), mid);
        return;
      }
      case EdgeMsg.PeerGathered:
        ev.onGatheringComplete();
        return;
      case EdgeMsg.PeerChannelOpen: {
        const ch = r.u8();
        const addr = r.remaining > 0 ? readStr(r, 64) : '';
        if (ch < CHANNELS.length) ev.onChannelOpen(ch, addr.length > 0 ? addr : null);
        return;
      }
      case EdgeMsg.PeerClosed: {
        const reason = r.remaining > 0 ? r.u8() : EdgePeerClose.Closed;
        link.ev = null;
        this.forget(link);
        if (reason === EdgePeerClose.Flood) ev.onAbuse('flood');
        else if (reason === EdgePeerClose.Protocol) ev.onAbuse('protocol');
        else ev.onConnectionState(reason === EdgePeerClose.Closed ? 'closed' : 'failed');
        return;
      }
    }
  }

  /** @internal player data from the edge. */
  onPeerData(channel: number, slot: number, payload: Uint8Array): void {
    const link = this.links.get(slot);
    const ev = link?.ev ?? null;
    if (ev !== null) ev.onMessage(channel, payload);
  }
}

/** Host name of a `ws(s)://` URL, without IPv6 brackets. */
function urlHost(url: string): string {
  const h = new URL(url).hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** Granted ready data plane: the UDP tunnel or the legacy PeerConnection. */
interface DataPlane {
  ready(ch: number): boolean;
  send(ch: number, frame: Uint8Array): boolean;
  cork?(): void;
  uncork?(): void;
}

/** One tunnel connection attempt / session (WS + optional UDP / PeerConnection data plane). */
class TunnelSession {
  phase: Phase = Phase.Hello;
  /** Data plane: the requested one until `AuthOk`, then the granted one. */
  mode: EdgeDataPlane;
  sessionId: number | null = null;
  private wsRttMs: number | null = null;
  private readonly backend: EdgePeerBackend;
  private readonly ws: WebSocket;
  /** `ro` lanes granted by the edge (1 = the single `ro` channel). */
  private lanes = 1;
  /** Flags requested in `Auth`. */
  private requested = 0;
  private nonce: Uint8Array | null = null;
  private x25519: X25519Pair | null = null;
  private plane: DataPlane | null = null;
  private udp: UdpTunnelPlane | null = null;
  private udpSock: dgram.Socket | null = null;
  private udpStartedAt = 0;
  private ndc: NdcTunnelPlane | null = null;
  private answerApplied = false;
  private readonly heldCandidates: [string, string][] = [];
  private readonly heldRemote: [string, string][] = [];
  private deadline: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastRx = performance.now();
  private readonly w = new Writer(1024);
  private scratch = Buffer.allocUnsafe(4096);

  get roLanes(): number {
    return this.lanes;
  }

  /** UDP round trip when the UDP tunnel is up, else the WebSocket's. */
  get rttMs(): number | null {
    return this.udp?.rttMs ?? this.wsRttMs;
  }

  udpStats(): UdpPlaneStats | null {
    return this.udp?.stats() ?? null;
  }

  constructor(backend: EdgePeerBackend, mode: EdgeDataPlane) {
    this.backend = backend;
    this.mode = mode;
    const o = backend.opts;
    const wsOpts: ClientOptions = {
      perMessageDeflate: false,
      maxPayload: EdgeLimits.maxWsMessage + 4096,
      handshakeTimeout: o.connectTimeoutMs ?? 10_000,
      ...o.wsOptions,
    };
    if (o.bindAddress !== undefined) wsOpts.localAddress = o.bindAddress;
    this.ws = new WebSocket(o.url, wsOpts);
    this.ws.binaryType = 'nodebuffer';
    this.deadline = setTimeout(() => this.fail(new EdgeError('connect/auth timeout', 'connect')), o.connectTimeoutMs ?? 10_000);
    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      try {
        this.onWsMessage(data as Buffer, isBinary);
      } catch (err) {
        this.fail(new EdgeError(`bad message from edge: ${(err as Error).message}`, 'protocol'));
      }
    });
    this.ws.on('close', (code: number, reason: Buffer) => this.onWsClose(code, reason.toString('utf8')));
    this.ws.on('error', (err: Error) => {
      if (this.phase !== Phase.Closed) this.fail(new EdgeError(`websocket: ${err.message}`, 'connect'));
    });
  }

  // ---------------------------------------------------------------- sending

  private sendWs(bytes: Uint8Array): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(bytes);
    return true;
  }

  private control(type: number): Writer {
    const w = this.w;
    w.reset();
    w.u8(type);
    return w;
  }

  sendPeerOpen(slot: number, sdp: string): void {
    const w = this.control(EdgeMsg.PeerOpen);
    w.u16(slot);
    w.string(sdp);
    this.sendWs(w.copyBytes());
  }

  sendPeerCandidate(slot: number, candidate: string, mid: string): void {
    const w = this.control(EdgeMsg.PeerRemoteCandidate);
    w.u16(slot);
    w.string(candidate);
    w.string(mid);
    this.sendWs(w.copyBytes());
  }

  /** In-band on `ro` so it is ordered after the last data sent to the player (kick notice). */
  sendPeerClose(slot: number): void {
    if (this.phase !== Phase.Ready) return;
    const buf = Buffer.allocUnsafe(5);
    buf[0] = 0;
    buf[1] = 0;
    buf[2] = EdgeMsg.PeerClose;
    buf.writeUInt16BE(slot, 3);
    if (this.mode === 'ws') this.sendWs(buf.subarray(2));
    else this.sendDc(roLaneChannel(slot, this.lanes), buf);
  }

  private sendDc(ch: number, frame: Uint8Array): boolean {
    const p = this.plane;
    if (p === null || !p.ready(ch) || !p.send(ch, frame)) return false;
    const c = this.backend.counters;
    c.messagesOut++;
    c.bytesOut += frame.length;
    return true;
  }

  private ensureScratch(n: number): Buffer {
    if (this.scratch.length < n) this.scratch = Buffer.allocUnsafe(Math.max(n, this.scratch.length * 2));
    return this.scratch;
  }

  /** `[u16 slot][payload]` on tunnel channel `ch` (or `[Data0+ch][u16 slot][payload]` on the WS). */
  sendData(ch: number, slot: number, data: Uint8Array): boolean {
    if (this.phase !== Phase.Ready) return false;
    if (this.mode === 'ws') {
      const buf = Buffer.allocUnsafe(3 + data.length);
      buf[0] = EdgeMsg.Data0 + ch;
      buf[1] = slot >>> 8;
      buf[2] = slot & 0xff;
      buf.set(data, 3);
      const c = this.backend.counters;
      c.messagesOut++;
      c.bytesOut += buf.length;
      return this.sendWs(buf);
    }
    const n = 2 + data.length;
    const buf = this.ensureScratch(n);
    buf[0] = slot >>> 8;
    buf[1] = slot & 0xff;
    buf.set(data, 2);
    return this.sendDc(ch === 0 ? roLaneChannel(slot, this.lanes) : ch, buf.subarray(0, n));
  }

  /**
   * One tunnel message for many players (`Multicast`), in chunks of 255
   * slots. On `ro` with lanes, one message per lane in use (each slot's `ro`
   * order lives on its lane); on the UDP tunnel they are bundled into as few
   * datagrams as possible.
   */
  sendMulticast(ch: number, links: readonly EdgeLink[], data: Uint8Array): void {
    const ws = this.mode === 'ws';
    const lanes = ch === 0 && !ws ? this.lanes : 1;
    const plane = this.plane;
    plane?.cork?.();
    try {
      for (let lane = 0; lane < lanes; lane++) {
        let start = 0;
        for (;;) {
          // next ≤ 255 slots of this lane, written straight into the frame
          const room = lanes === 1 ? Math.min(255, links.length - start) : 255; // slots this frame can take
          const size = (ws ? 0 : 2) + 3 + 2 * room + data.length;
          const buf = ws ? Buffer.allocUnsafe(size) : this.ensureScratch(size);
          let p = ws ? 0 : 2;
          if (!ws) {
            buf[0] = 0;
            buf[1] = 0;
          }
          buf[p++] = EdgeMsg.Multicast;
          buf[p++] = ch;
          const countAt = p++;
          let count = 0;
          while (start < links.length && count < 255) {
            const slot = links[start++]!.slot;
            if (lanes > 1 && slot % lanes !== lane) continue;
            buf[p++] = slot >>> 8;
            buf[p++] = slot & 0xff;
            count++;
          }
          if (count > 0) {
            buf[countAt] = count;
            buf.set(data, p);
            const n = p + data.length;
            if (ws) {
              const c = this.backend.counters;
              c.messagesOut++;
              c.bytesOut += n;
              this.sendWs(buf.subarray(0, n));
            } else this.sendDc(lane === 0 ? ch : 2 + lane, buf.subarray(0, n));
          }
          if (start >= links.length) break;
        }
      }
    } finally {
      plane?.uncork?.();
    }
  }

  // ---------------------------------------------------------------- receiving

  private onWsMessage(data: Buffer, isBinary: boolean): void {
    if (this.phase === Phase.Closed) return;
    this.lastRx = performance.now();
    if (!isBinary || data.length === 0) throw new Error('non-binary message');
    const type = data[0]!;
    if (type >= EdgeMsg.Data0 && type <= EdgeMsg.Data2) {
      if (this.phase !== Phase.Ready || this.mode !== 'ws' || data.length < 3) return;
      const c = this.backend.counters;
      c.messagesIn++;
      c.bytesIn += data.length;
      this.backend.onPeerData(type - EdgeMsg.Data0, (data[1]! << 8) | data[2]!, data.subarray(3));
      return;
    }
    this.onControl(new Reader(data), data);
  }

  private onControl(r: Reader, raw: Uint8Array): void {
    const type = r.u8();
    switch (type) {
      case EdgeMsg.Hello:
        this.onHello(r);
        return;
      case EdgeMsg.AuthOk:
        this.onAuthOk(r, raw);
        return;
      case EdgeMsg.TunnelAnswer: {
        const ndc = this.ndc;
        if (ndc === null || this.phase !== Phase.DataPlane || this.answerApplied) throw new Error('unexpected tunnel answer');
        ndc.setAnswer(readStr(r, EdgeLimits.maxSdp));
        this.answerApplied = true;
        for (const [c, m] of this.heldRemote.splice(0)) ndc.addRemoteCandidate(c, m);
        for (const [c, m] of this.heldCandidates.splice(0)) this.sendTunnelCandidate(c, m);
        return;
      }
      case EdgeMsg.TunnelCandidate: {
        const c = readStr(r, EdgeLimits.maxCandidate);
        const m = readStr(r, EdgeLimits.maxMid);
        if (this.ndc === null) return;
        if (!this.answerApplied) {
          if (this.heldRemote.length < EdgeLimits.maxRemoteCandidates) this.heldRemote.push([c, m]);
        } else this.ndc.addRemoteCandidate(c, m);
        return;
      }
      case EdgeMsg.Ping: {
        const t = r.f64();
        const w = this.control(EdgeMsg.Pong);
        w.f64(t);
        this.sendWs(w.copyBytes());
        return;
      }
      case EdgeMsg.Pong:
        this.wsRttMs = performance.now() - r.f64();
        return;
      case EdgeMsg.Error: {
        const code = r.u16();
        const msg = readStr(r, 1024);
        this.backend.log(`edge error ${code}: ${msg}`);
        return;
      }
      case EdgeMsg.PeerAnswer:
      case EdgeMsg.PeerLocalCandidate:
      case EdgeMsg.PeerGathered:
      case EdgeMsg.PeerChannelOpen:
      case EdgeMsg.PeerClosed:
        if (this.phase === Phase.Ready) this.backend.onPeerMessage(type, r);
        return;
      default:
        throw new Error(`unknown message type ${type}`);
    }
  }

  /** `Hello [u8 1][nonce][u8 maxVersion]`: answers with a v2 `Auth` (or v1 for an old edge). */
  private onHello(r: Reader): void {
    if (this.phase !== Phase.Hello) throw new Error('unexpected hello');
    const first = r.u8();
    if (first !== EDGE_LEGACY_VERSION && first !== EDGE_PROTOCOL_VERSION) {
      this.fail(new EdgeError(`edge speaks protocol ${first}, host ${EDGE_PROTOCOL_VERSION}`, 'version', true));
      return;
    }
    const nonce = r.bytesCopy(EDGE_NONCE_LENGTH);
    this.nonce = nonce;
    const version = Math.min(r.remaining > 0 ? r.u8() : first, EDGE_PROTOCOL_VERSION);
    const o = this.backend.opts;
    const lanes = o.roLanes !== false ? AuthFlag.RoLanes : 0;
    const w = this.control(EdgeMsg.Auth);
    if (version >= 2) {
      let flags = 0;
      let hostPub: Buffer | null = null;
      if (this.mode === 'udp') {
        flags = AuthFlag.Udp | lanes;
        this.x25519 = x25519Generate();
        hostPub = this.x25519.publicKey;
      } else if (this.mode === 'webrtc') flags = AuthFlag.WebRtc | lanes;
      this.requested = flags;
      w.u8(2);
      w.string(this.backend.keyId);
      w.bytes(edgeAuthMacV2(this.backend.secret, nonce, flags, hostPub));
      w.u8(flags);
      if (hostPub !== null) w.bytes(hostPub);
    } else {
      // protocol-1 edge: no UDP tunnel
      if (this.mode === 'udp') {
        if (o.fallbackWs === false) {
          this.fail(new EdgeError('edge speaks protocol 1 (no UDP tunnel) and fallbackWs is off', 'version', true));
          return;
        }
        this.backend.log('edge speaks protocol 1: no UDP tunnel, using the WebSocket data plane');
      }
      const flags = this.mode === 'webrtc' ? AuthFlag.WebRtc | lanes : 0;
      this.requested = flags;
      w.u8(EDGE_LEGACY_VERSION);
      w.string(this.backend.keyId);
      w.bytes(edgeAuthMac(this.backend.secret, nonce));
      w.u8(flags);
    }
    this.phase = Phase.Auth;
    this.sendWs(w.copyBytes());
  }

  private onAuthOk(r: Reader, raw: Uint8Array): void {
    if (this.phase !== Phase.Auth) throw new Error('unexpected auth ok');
    const o = this.backend.opts;
    this.sessionId = r.u32();
    r.u16(); // maxPeers (informational)
    const granted = r.remaining > 0 ? r.u8() : 0;
    if ((granted & ~this.requested) !== 0) throw new Error('edge granted flags that were not requested');
    if ((granted & AuthFlag.RoLanes) !== 0 && o.roLanes !== false) this.lanes = EDGE_RO_LANES;
    if ((granted & AuthFlag.Udp) !== 0) {
      const edgePub = r.bytesCopy(EDGE_X25519_LENGTH);
      const connId = r.u32();
      const port = r.u16();
      const udpHost = readStr(r, EdgeLimits.maxUdpHost);
      const macAt = r.pos;
      const mac = r.bytes(32);
      const x = this.x25519!;
      const want = edgeAuthOkMac(this.backend.secret, this.nonce!, x.publicKey, raw.subarray(0, macAt));
      if (!edgeMacEqual(want, mac)) {
        this.fail(new EdgeError('the edge could not prove it knows the key (AuthOk MAC mismatch)', 'auth', true));
        return;
      }
      if (port === 0 || connId === 0) throw new Error('bad UDP tunnel endpoint');
      this.mode = 'udp';
      this.startPing();
      this.startUdpPlane(edgePub, connId, udpHost.length > 0 ? udpHost : urlHost(o.url), port);
      return;
    }
    this.x25519 = null;
    if ((granted & AuthFlag.WebRtc) !== 0) {
      this.mode = 'webrtc';
      this.startPing();
      this.startNdcPlane();
      return;
    }
    // the edge put this session's data on the WebSocket
    if (this.requested !== 0) {
      if (o.fallbackWs === false) {
        this.fail(new EdgeError('the edge did not grant a UDP data plane and fallbackWs is off', 'tunnel'));
        return;
      }
      this.backend.log('edge granted no UDP data plane: using the WebSocket');
    }
    this.mode = 'ws';
    this.lanes = 1;
    this.startPing();
    this.becomeReady();
  }

  private onWsClose(code: number, reason: string): void {
    if (this.phase === Phase.Closed) return;
    let err: EdgeError;
    if (code === EdgeCloseCode.AuthFailed) err = new EdgeError(`edge rejected the key (${reason || code})`, 'auth', true);
    else if (code === EdgeCloseCode.Version) err = new EdgeError(`protocol version rejected (${reason || code})`, 'version', true);
    else if (code === EdgeCloseCode.Quota) err = new EdgeError(`edge quota exceeded (${reason || code})`, 'quota');
    else err = new EdgeError(`tunnel closed (${code}${reason ? ` ${reason}` : ''})`, 'tunnel');
    this.fail(err);
  }

  // ---------------------------------------------------------------- data plane

  /** Data-plane deadline: then fall back to the WebSocket (reconnect) or fail. */
  private armDataPlaneDeadline(): void {
    const o = this.backend.opts;
    this.phase = Phase.DataPlane;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (this.phase !== Phase.DataPlane) return;
      if (o.fallbackWs !== false) {
        this.backend.log('data plane timeout: falling back to WebSocket');
        this.fail(new EdgeError('UDP data plane timed out, falling back to WebSocket', 'tunnel'), true);
      } else this.fail(new EdgeError('UDP data plane timed out', 'tunnel'));
    }, o.dataPlaneTimeoutMs ?? 5_000);
  }

  /** Tunnel v2: SCTP (we initiate) over AES-GCM datagrams from one connected UDP socket. */
  private startUdpPlane(edgePub: Uint8Array, connId: number, host: string, port: number): void {
    this.armDataPlaneDeadline();
    const o = this.backend.opts;
    const x = this.x25519!;
    this.x25519 = null; // the private key lives only until the shared secret is computed
    const secrets = deriveTunnelSecrets(x25519Shared(x.privateKey, edgePub), this.backend.secret, this.nonce!, x.publicKey, edgePub, connId);
    void (async () => {
      const bindFamily = o.bindAddress !== undefined ? isIP(o.bindAddress) : 0;
      // node:dgram / node:dns are loaded on first use (only edge rooms need them)
      const req = createRequire(import.meta.url);
      const target =
        isIP(host) !== 0
          ? { address: host, family: isIP(host) }
          : await (req('node:dns') as typeof import('node:dns')).promises.lookup(host, { family: bindFamily === 0 ? undefined : bindFamily });
      const dgramMod = req('node:dgram') as typeof dgram;
      if (this.phase !== Phase.DataPlane) return;
      const sock = dgramMod.createSocket({ type: target.family === 6 ? 'udp6' : 'udp4' });
      this.udpSock = sock;
      sock.on('error', (err) => this.backend.log(`tunnel udp: ${err.message}`));
      await new Promise<void>((resolve, reject) => {
        sock.once('error', reject);
        sock.bind({ port: 0, ...(o.bindAddress !== undefined ? { address: o.bindAddress } : null) }, () => {
          sock.off('error', reject);
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        sock.once('error', reject);
        sock.connect(port, target.address, () => {
          sock.off('error', reject);
          resolve();
        });
      });
      if (this.phase !== Phase.DataPlane || this.udpSock !== sock) return;
      try {
        sock.setRecvBufferSize(1 << 20);
        sock.setSendBufferSize(1 << 20);
      } catch {
        /* capped by the kernel */
      }
      this.udpStartedAt = performance.now();
      const plane = new UdpTunnelPlane({
        role: 'client',
        connId,
        secrets,
        lanes: this.lanes,
        transmit: (d) => {
          try {
            sock.send(d);
          } catch {
            /* closed */
          }
        },
        events: {
          onOpen: () => {
            if (this.udp === plane && this.phase === Phase.DataPlane) this.becomeReady();
          },
          onMessage: (ch, data) => {
            if (this.udp === plane) this.onDcMessage(ch, data);
          },
          onClose: (reason) => {
            if (this.udp === plane) this.fail(new EdgeError(`UDP tunnel closed (${reason})`, 'tunnel'));
          },
          onError: (err) => this.backend.log(`tunnel udp: ${(err as Error)?.message ?? err}`),
        },
        ...(o.udpTuning?.sctp !== undefined ? { sctp: o.udpTuning.sctp } : null),
        ...(o.udpTuning?.rekeyAfterPackets !== undefined ? { rekeyAfterPackets: o.udpTuning.rekeyAfterPackets } : null),
      });
      this.udp = plane;
      this.plane = { ready: () => plane.open, send: (ch, f) => plane.send(ch, f), cork: () => plane.cork(), uncork: () => plane.uncork() };
      sock.on('message', (msg: Buffer) => {
        if (this.udp === plane) plane.receive(msg);
      });
    })().catch((err: Error) => {
      if (this.phase === Phase.DataPlane) this.fail(new EdgeError(`UDP tunnel: ${err.message}`, 'tunnel'), o.fallbackWs !== false);
    });
  }

  /** Legacy data plane: one node-datachannel PeerConnection (the native addon is loaded only now). */
  private startNdcPlane(): void {
    this.armDataPlaneDeadline();
    const o = this.backend.opts;
    const range = o.portRange;
    void import('./edge-ndc.js')
      .then((mod) => {
        if (this.phase !== Phase.DataPlane) return;
        const ndc = new mod.NdcTunnelPlane(
          'haxlite-edge-tunnel',
          {
            iceServers: toNativeIceServers(o.iceServers ?? []),
            ...(o.bindAddress !== undefined ? { bindAddress: o.bindAddress } : null),
            ...(range ? { portRangeBegin: range[0], portRangeEnd: range[1] } : null),
            maxMessageSize: 1 << 20,
          },
          this.lanes,
          {
            onOpen: () => {
              if (this.ndc === ndc && this.phase === Phase.DataPlane) this.becomeReady();
            },
            onMessage: (ch, data) => {
              if (this.ndc === ndc) this.onDcMessage(ch, data);
            },
            onClose: (reason) => {
              if (this.ndc === ndc) this.fail(new EdgeError(reason, 'tunnel'));
            },
            onLocalCandidate: (line, mid) => {
              if (this.ndc !== ndc) return;
              if (this.answerApplied) this.sendTunnelCandidate(line, mid);
              else this.heldCandidates.push([line, mid]);
            },
            onError: (err) => this.backend.log(`tunnel pc error: ${err.message}`),
          },
        );
        this.ndc = ndc;
        this.plane = ndc;
        const w = this.control(EdgeMsg.TunnelOffer);
        w.string(ndc.createOffer());
        this.sendWs(w.copyBytes());
      })
      .catch((err: Error) => {
        if (this.phase === Phase.DataPlane) this.fail(new EdgeError(`tunnel peer connection: ${err.message}`, 'tunnel'), o.fallbackWs !== false);
      });
  }

  private sendTunnelCandidate(c: string, mid: string): void {
    const w = this.control(EdgeMsg.TunnelCandidate);
    w.string(candidateLine(c));
    w.string(mid);
    this.sendWs(w.copyBytes());
  }

  private onDcMessage(ch: number, msg: Uint8Array): void {
    if (this.phase !== Phase.Ready || msg.length < 2) return;
    const c = this.backend.counters;
    c.messagesIn++;
    c.bytesIn += msg.length;
    const slot = (msg[0]! << 8) | msg[1]!;
    if (slot !== 0) {
      this.backend.onPeerData(ch < 3 ? ch : 0, slot, msg.subarray(2)); // channels ≥ 3: `ro` lanes
      return;
    }
    try {
      const r = new Reader(msg, 2);
      const type = r.u8();
      if (type === EdgeMsg.PeerChannelOpen || type === EdgeMsg.PeerClosed) this.backend.onPeerMessage(type, r);
    } catch (err) {
      this.backend.log(`bad in-band message: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  private becomeReady(): void {
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    this.phase = Phase.Ready;
    this.backend.onSessionReady(this);
  }

  private startPing(): void {
    const o = this.backend.opts;
    const period = o.pingIntervalMs ?? 5_000;
    const timeout = o.pingTimeoutMs ?? 15_000;
    this.lastRx = performance.now();
    this.pingTimer = setInterval(() => {
      const now = performance.now();
      if (now - this.lastRx > timeout) {
        this.fail(new EdgeError('tunnel timed out (no traffic from the edge)', 'tunnel'));
        return;
      }
      const udp = this.udp;
      if (udp !== null) {
        if (now - Math.max(udp.lastRx, this.udpStartedAt) > timeout) {
          this.fail(new EdgeError('UDP tunnel timed out (nothing authenticated from the edge)', 'tunnel'));
          return;
        }
        udp.ping(); // NAT keep-alive (we always send first) + RTT
      }
      const w = this.control(EdgeMsg.Ping);
      w.f64(now);
      this.sendWs(w.copyBytes());
    }, period);
  }

  /** Tears the session down and tells the backend (once). */
  fail(err: EdgeError, fallback = false): void {
    if (this.phase === Phase.Closed) return;
    this.release();
    try {
      this.ws.terminate();
    } catch {
      /* ignore */
    }
    this.backend.onSessionDown(this, err, { fallback });
  }

  /** Normal close (host stopping). */
  close(code: number, reason: string): void {
    if (this.phase === Phase.Closed) return;
    this.release();
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason);
      else this.ws.terminate();
    } catch {
      /* ignore */
    }
  }

  private release(): void {
    this.phase = Phase.Closed;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = null;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.plane = null;
    this.x25519 = null;
    const udp = this.udp;
    this.udp = null;
    if (udp !== null) udp.close(); // ABORT + Close datagram, best effort
    const sock = this.udpSock;
    this.udpSock = null;
    if (sock !== null) {
      // let the goodbye datagrams leave first
      setImmediate(() => {
        try {
          sock.close();
        } catch {
          /* already closed */
        }
      });
    }
    const ndc = this.ndc;
    this.ndc = null;
    if (ndc !== null) ndc.close();
  }
}
