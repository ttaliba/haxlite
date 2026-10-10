/**
 * Host side of the haxlite Edge tunnel: {@link EdgePeerBackend}, a
 * {@link PeerBackend} whose player PeerConnections live on a remote edge.
 *
 * ```
 *  HostTransport ── createPeer(offer) ──▶ EdgePeerBackend ══ WS (control) ══▶ edge ── WebRTC ── player
 *                ◀─ answer/candidates ──                 ══ PC 3 ch (data) ══▶
 * ```
 *
 * This process only opens OUTBOUND connections to the edge (WebSocket +
 * optionally one host↔edge PeerConnection whose candidates are exchanged
 * with the edge only). If the tunnel drops, every player is lost (official
 * clients cannot reconnect) and the tunnel is re-established with backoff;
 * joins are refused (4104) meanwhile.
 */
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import type { DataChannel, PeerConnection } from 'node-datachannel';
import { Reader, Writer } from '../codec/index.js';
import { CHANNELS } from './constants.js';
import { candidateLine, toNativeIceServers, type IceServerConfig } from './ice.js';
import type { PeerBackend, PeerLink, PeerLinkEvents } from './peer-backend.js';
import { closeNative, createDataChannel, createPeerConnection } from './webrtc.js';
import {
  AuthFlag,
  EDGE_NONCE_LENGTH,
  EDGE_PROTOCOL_VERSION,
  EdgeCloseCode,
  EdgeLimits,
  EdgeMsg,
  EdgePeerClose,
  edgeAuthMac,
  parseEdgeKey,
} from './edge-protocol.js';

export interface EdgeOptions {
  /** Control endpoint, e.g. `wss://edge.example.com:8443/tunnel` (`ws://` only for tests/LAN). */
  url: string;
  /** API key issued by the edge operator: `"<keyId>:<secret>"`. */
  key: string;
  /**
   * When the UDP data plane (host↔edge PeerConnection) cannot be established
   * within `dataPlaneTimeoutMs`, carry all player traffic over the WebSocket
   * instead (TCP: head-of-line blocking, slightly more latency). Default true.
   */
  fallbackWs?: boolean;
  /** Start directly with `'ws'` (UDP known to be blocked). Default `'webrtc'`. */
  dataPlane?: 'webrtc' | 'ws';
  /** Local address for the outbound WebSocket and the tunnel PeerConnection. */
  bindAddress?: string;
  /** STUN/TURN for the tunnel PeerConnection (default none: the edge is public). */
  iceServers?: readonly IceServerConfig[];
  /** Local UDP port range of the tunnel PeerConnection. */
  portRange?: readonly [number, number] | null;
  /** WS connect + auth deadline. Default 10 s. */
  connectTimeoutMs?: number;
  /** Data-plane PeerConnection deadline (then `fallbackWs`). Default 5 s. */
  dataPlaneTimeoutMs?: number;
  /** Reconnect backoff: first delay (doubles up to `reconnectMaxMs`). Default 250 ms / 10 s. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Application ping period and dead-tunnel timeout. Default 5 s / 15 s. */
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Extra `ws` client options (TLS `ca`, `rejectUnauthorized`, `agent`…). */
  wsOptions?: ClientOptions;
  /** Debug logger. */
  log?: (msg: string) => void;
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
  dataPlane: 'webrtc' | 'ws' | null;
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
  private mode: 'webrtc' | 'ws';
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sessions = 0;
  /** @internal */ readonly counters = { bytesOut: 0, bytesIn: 0, messagesOut: 0, messagesIn: 0 };

  constructor(opts: EdgeOptions) {
    this.opts = opts;
    const { id, secret } = parseEdgeKey(opts.key);
    this.keyId = id;
    this.secret = secret;
    this.mode = opts.dataPlane ?? 'webrtc';
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
      sessionId: s?.sessionId ?? null,
      rttMs: s?.rttMs ?? null,
      peers: this.links.size,
      sessions: this.sessions,
      ...this.counters,
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

/** One tunnel connection attempt / session (WS + optional data-plane PeerConnection). */
class TunnelSession {
  phase: Phase = Phase.Hello;
  readonly mode: 'webrtc' | 'ws';
  sessionId: number | null = null;
  rttMs: number | null = null;
  private readonly backend: EdgePeerBackend;
  private readonly ws: WebSocket;
  private pc: PeerConnection | null = null;
  private readonly dcs: (DataChannel | null)[] = [null, null, null];
  private readonly dcOpen = [false, false, false];
  private answerApplied = false;
  private readonly heldCandidates: [string, string][] = [];
  private readonly heldRemote: [string, string][] = [];
  private deadline: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastRx = performance.now();
  private readonly w = new Writer(1024);
  private scratch = Buffer.allocUnsafe(4096);

  constructor(backend: EdgePeerBackend, mode: 'webrtc' | 'ws') {
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
    else this.sendDc(0, buf);
  }

  private sendDc(ch: number, frame: Uint8Array): boolean {
    const dc = this.dcs[ch];
    if (dc == null || !this.dcOpen[ch]) return false;
    try {
      if (!dc.sendMessageBinary(frame)) return false;
    } catch {
      return false;
    }
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
    return this.sendDc(ch, buf.subarray(0, n));
  }

  /** One tunnel message for many players (`Multicast`), in chunks of 255 slots. */
  sendMulticast(ch: number, links: readonly EdgeLink[], data: Uint8Array): void {
    for (let start = 0; start < links.length; start += 255) {
      const count = Math.min(255, links.length - start);
      const head = (this.mode === 'ws' ? 0 : 2) + 3 + 2 * count;
      const n = head + data.length;
      const buf = this.mode === 'ws' ? Buffer.allocUnsafe(n) : this.ensureScratch(n);
      let p = 0;
      if (this.mode !== 'ws') {
        buf[p++] = 0;
        buf[p++] = 0;
      }
      buf[p++] = EdgeMsg.Multicast;
      buf[p++] = ch;
      buf[p++] = count;
      for (let i = 0; i < count; i++) {
        const slot = links[start + i]!.slot;
        buf[p++] = slot >>> 8;
        buf[p++] = slot & 0xff;
      }
      buf.set(data, p);
      if (this.mode === 'ws') {
        const c = this.backend.counters;
        c.messagesOut++;
        c.bytesOut += n;
        this.sendWs(buf);
      } else this.sendDc(ch, buf.subarray(0, n));
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
    this.onControl(new Reader(data));
  }

  private onControl(r: Reader): void {
    const type = r.u8();
    switch (type) {
      case EdgeMsg.Hello: {
        if (this.phase !== Phase.Hello) throw new Error('unexpected hello');
        const version = r.u8();
        if (version !== EDGE_PROTOCOL_VERSION) {
          this.fail(new EdgeError(`edge speaks protocol ${version}, host ${EDGE_PROTOCOL_VERSION}`, 'version', true));
          return;
        }
        const nonce = r.bytes(EDGE_NONCE_LENGTH);
        const w = this.control(EdgeMsg.Auth);
        w.u8(EDGE_PROTOCOL_VERSION);
        w.string(this.backend.keyId);
        w.bytes(edgeAuthMac(this.backend.secret, nonce));
        w.u8(this.mode === 'webrtc' ? AuthFlag.WebRtc : 0);
        this.phase = Phase.Auth;
        this.sendWs(w.copyBytes());
        return;
      }
      case EdgeMsg.AuthOk: {
        if (this.phase !== Phase.Auth) throw new Error('unexpected auth ok');
        this.sessionId = r.u32();
        r.u16(); // maxPeers (informational)
        this.startPing();
        if (this.mode === 'ws') this.becomeReady();
        else this.startDataPlane();
        return;
      }
      case EdgeMsg.TunnelAnswer: {
        const pc = this.pc;
        if (pc === null || this.phase !== Phase.DataPlane || this.answerApplied) throw new Error('unexpected tunnel answer');
        pc.setRemoteDescription(readStr(r, EdgeLimits.maxSdp), 'answer');
        this.answerApplied = true;
        for (const [c, m] of this.heldRemote.splice(0)) this.addTunnelCandidate(c, m);
        for (const [c, m] of this.heldCandidates.splice(0)) this.sendTunnelCandidate(c, m);
        return;
      }
      case EdgeMsg.TunnelCandidate: {
        const c = readStr(r, EdgeLimits.maxCandidate);
        const m = readStr(r, EdgeLimits.maxMid);
        if (this.pc === null) return;
        if (!this.answerApplied) {
          if (this.heldRemote.length < EdgeLimits.maxRemoteCandidates) this.heldRemote.push([c, m]);
        } else this.addTunnelCandidate(c, m);
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
        this.rttMs = performance.now() - r.f64();
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

  private startDataPlane(): void {
    this.phase = Phase.DataPlane;
    const o = this.backend.opts;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (this.phase !== Phase.DataPlane) return;
      if (o.fallbackWs !== false) {
        this.backend.log('data plane timeout: falling back to WebSocket');
        this.fail(new EdgeError('UDP data plane timed out, falling back to WebSocket', 'tunnel'), true);
      } else this.fail(new EdgeError('UDP data plane timed out', 'tunnel'));
    }, o.dataPlaneTimeoutMs ?? 5_000);
    const range = o.portRange;
    const onError = (err: Error) => this.backend.log(`tunnel pc error: ${err.message}`);
    try {
      const pc = createPeerConnection(
        'haxlite-edge-tunnel',
        {
          iceServers: toNativeIceServers(o.iceServers ?? []),
          ...(o.bindAddress !== undefined ? { bindAddress: o.bindAddress } : null),
          ...(range ? { portRangeBegin: range[0], portRangeEnd: range[1] } : null),
          maxMessageSize: 1 << 20,
          disableAutoNegotiation: true,
        },
        {
          onLocalCandidate: (cand, mid) => {
            if (this.pc !== pc) return;
            const line = candidateLine(cand);
            if (this.answerApplied) this.sendTunnelCandidate(line, mid);
            else this.heldCandidates.push([line, mid]);
          },
          onStateChange: (state) => {
            if (this.pc !== pc) return;
            if (state === 'failed' || state === 'closed') this.fail(new EdgeError(`tunnel connection ${state}`, 'tunnel'));
          },
          onError,
        },
      );
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
              if (this.phase === Phase.DataPlane && this.dcOpen.every((x) => x)) this.becomeReady();
            },
            onClosed: () => {
              if (this.dcs[i] !== dc) return;
              this.dcOpen[i] = false;
              this.fail(new EdgeError(`tunnel channel ${cfg.label} closed`, 'tunnel'));
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
      pc.setLocalDescription('offer');
      const sdp = pc.localDescription()?.sdp;
      if (sdp === undefined) throw new Error('no local offer');
      const w = this.control(EdgeMsg.TunnelOffer);
      w.string(sdp);
      this.sendWs(w.copyBytes());
    } catch (err) {
      this.fail(new EdgeError(`tunnel peer connection: ${(err as Error).message}`, 'tunnel'), o.fallbackWs !== false);
    }
  }

  private sendTunnelCandidate(c: string, mid: string): void {
    const w = this.control(EdgeMsg.TunnelCandidate);
    w.string(c);
    w.string(mid);
    this.sendWs(w.copyBytes());
  }

  private addTunnelCandidate(c: string, mid: string): void {
    try {
      this.pc?.addRemoteCandidate(c, mid);
    } catch {
      /* ignore */
    }
  }

  private onDcMessage(ch: number, msg: Buffer): void {
    if (this.phase !== Phase.Ready || msg.length < 2) return;
    const c = this.backend.counters;
    c.messagesIn++;
    c.bytesIn += msg.length;
    const slot = (msg[0]! << 8) | msg[1]!;
    if (slot !== 0) {
      this.backend.onPeerData(ch, slot, msg.subarray(2));
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
    for (let i = 0; i < this.dcs.length; i++) {
      const dc = this.dcs[i];
      this.dcs[i] = null;
      this.dcOpen[i] = false;
      if (dc != null) closeNative(dc);
    }
    const pc = this.pc;
    this.pc = null;
    if (pc !== null) closeNative(pc);
  }
}
