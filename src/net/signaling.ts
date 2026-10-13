/**
 * Host side of the master signaling WebSocket (official class `Aa`).
 *
 * Flow: `POST api/host` (token, rcr) -> `{url, token}` -> WS `<url>?token=…`.
 * master -> host: 1 offer (+peerId, conn), 4 ICE candidate, 5 room id, 6 new token.
 * host -> master: 0 end/reject, 1 answer, 4 candidate, 7 RoomInfo, 8 keep-alive,
 * 9 require captcha. Every message is `[u8 type]…`; offer/answer/candidate
 * payloads are raw-deflated. Reconnects after 10–60 s unless closed with 4001,
 * reusing the latest token received in message 6.
 *
 * Liveness (haxlite addition): the WS upgrade has a handshake timeout, and
 * every keep-alive tick also sends a WS ping; if nothing (pong or message)
 * arrived since the previous tick the socket is considered dead (blackholed
 * TCP) and goes through the normal reconnect path. No extra timers: it rides
 * on the existing 40 s keep-alive interval, so a dead link is detected in
 * 40–80 s instead of whenever the kernel gives up on the TCP connection.
 *
 * This class only frames/deframes; admission control and WebRTC live in
 * `transport.ts`.
 */
import WebSocket from 'ws';
import type http from 'node:http';
import { Reader, Writer, deflateRaw, inflateRaw } from '../codec/index.js';
import { DEFAULT_WS_ORIGIN, HostToMaster, MasterCloseCode, MasterToHost, NetDefaults } from './constants.js';
import type { IceCandidateInit } from './ice.js';
import { bytesToConn, connBytesToText } from './ip.js';
import { MasterError, requestHostSession, type MasterHttpOptions } from './master-http.js';

export interface SignalingOffer {
  /** Master-assigned negotiation id (u32). */
  peerId: number;
  /** Official `conn`: uppercase hex of the master's client-IP bytes. */
  conn: string;
  /** The same bytes as text: the client IP as seen by the master. */
  ip: string;
  /** "Reverse connection" retry flag (host delays remote ICE by 2.5 s). */
  reverse: boolean;
  sdp: string;
  candidates: IceCandidateInit[];
  /** Reader positioned at the join data: `u16 version`, `nullableString password`. */
  joinData: Reader;
}

export interface HostSignalingOptions extends MasterHttpOptions {
  /** Headless token (`HBInit({token})`); replaced by the master's message 6. */
  token: string;
  /** Overrides the WS URL returned by `api/host` (proxies, custom backends). */
  wsUrl?: string | null;
  /** WS Origin header (default `https://html5.haxball.com`; null = none). */
  origin?: string | null;
  /** Extra WS handshake headers. */
  wsHeaders?: Record<string, string>;
  /** Reconnect on unexpected close (default true, like the official host). */
  reconnect?: boolean;
  /** Keep-alive period (message 8 + WS ping liveness check). Default 40 s. */
  keepAliveMs?: number;
  /** WS upgrade timeout (default 15 s); on expiry the normal reconnect path runs. */
  handshakeTimeoutMs?: number;
  roomInfoThrottleMs?: number;
  recaptchaDebounceMs?: number;
  reconnectMinMs?: number;
  reconnectRangeMs?: number;
  /** RNG for the reconnect delay (tests). */
  random?: () => number;
}

export interface HostSignalingHandlers {
  /** WS open. */
  onOpen?(): void;
  /** Message 5: the room id (link = `play?c=<id>`). Called again after reconnects. */
  onRoomId?(roomId: string): void;
  /** Message 1 (already deframed; malformed offers are rejected with code 0 here). */
  onOffer?(offer: SignalingOffer): void;
  /** Message 4. */
  onCandidate?(peerId: number, candidate: IceCandidateInit): void;
  /** WS lost (or HTTP step failed). All pending negotiations must be dropped (`Aa.Lg`). */
  onDisconnect?(info: { code: number; willReconnect: boolean }): void;
  /** Token invalid/expired: the master wants a captcha. Call {@link HostSignaling.useRecaptchaToken} to retry. */
  onRecaptcha?(sitekey: string): void;
  onError?(err: Error): void;
}

export class HostSignaling {
  /** Latest signaling token (headless token, then message 6 updates). */
  token: string;
  /** Room id from message 5 (null until received). */
  roomId: string | null = null;

  private readonly opts: HostSignalingOptions;
  private readonly handlers: HostSignalingHandlers;
  private ws: WebSocket | null = null;
  private stopped = true;
  private generation = 0;

  private roomInfo: Uint8Array | null = null;
  private roomInfoDirty = false;
  private roomInfoTimer: NodeJS.Timeout | null = null;

  private requireRecaptcha = false;
  private sentRequireRecaptcha = false;
  private recaptchaTimer: NodeJS.Timeout | null = null;

  private keepAliveTimer: NodeJS.Timeout | null = null;
  /** Something (message/pong) was received since the last keep-alive tick. */
  private alive = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly w = new Writer(256);

  constructor(opts: HostSignalingOptions, handlers: HostSignalingHandlers = {}) {
    this.opts = opts;
    this.handlers = handlers;
    this.token = opts.token ?? '';
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Starts (`Aa.be`). `rcr` = captcha response, normally empty. */
  start(rcr = ''): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect(rcr);
  }

  /** Retries the HTTP step with a captcha response after {@link HostSignalingHandlers.onRecaptcha}. */
  useRecaptchaToken(rcr: string): void {
    if (this.stopped) return;
    void this.connect(rcr);
  }

  /** Closes everything and disables reconnection. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    this.dropSocket();
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        ws.close(1000);
      } catch {
        ws.terminate();
      }
    }
  }

  // ------------------------------------------------------------------ outgoing

  /** `[0][u32 peer]`: signaling for this peer is over (`qc(0, …)`). */
  sendEnd(peerId: number): void {
    const w = this.w.reset();
    w.u8(HostToMaster.End);
    w.u32(peerId);
    this.send(w.copyBytes());
  }

  /** `[0][u32 peer][u16 code]`: reject a join (`Aa.pc`). */
  sendReject(peerId: number, code: number): void {
    const w = this.w.reset();
    w.u8(HostToMaster.End);
    w.u32(peerId);
    w.u16(code);
    this.send(w.copyBytes());
  }

  /** `[1][u32 peer] deflate(string sdp, json candidates[])` (`Aa.Zh`). */
  sendAnswer(peerId: number, sdp: string, candidates: readonly IceCandidateInit[]): void {
    const p = new Writer(sdp.length + 256);
    p.string(sdp);
    p.json(candidates);
    this.sendPeerPayload(HostToMaster.Answer, peerId, p.finish());
  }

  /** `[4][u32 peer] deflate(json candidate)` (`Aa.Xh`). */
  sendCandidate(peerId: number, candidate: IceCandidateInit): void {
    const p = new Writer(256);
    p.json(candidate);
    this.sendPeerPayload(HostToMaster.Candidate, peerId, p.finish());
  }

  /**
   * Publishes RoomInfo bytes (`Aa.ae`): ignored if unchanged; sent at once
   * when the socket is open and no batching window is running, otherwise at
   * the end of the 10 s window.
   */
  setRoomInfo(bytes: Uint8Array): void {
    const prev = this.roomInfo;
    if (prev !== null && prev.length === bytes.length) {
      let same = true;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== bytes[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.roomInfo = bytes.slice();
    this.roomInfoDirty = true;
    if (this.isOpen && this.roomInfoTimer === null) {
      this.sendRoomInfo();
      this.roomInfoTimer = setTimeout(() => {
        this.roomInfoTimer = null;
        if (this.isOpen && this.roomInfoDirty) this.sendRoomInfo();
      }, this.opts.roomInfoThrottleMs ?? NetDefaults.roomInfoThrottleMs);
    }
  }

  /** Message 9 with a 1 s debounce (`Aa.$d`). */
  setRequireRecaptcha(on: boolean): void {
    this.requireRecaptcha = on;
    if (this.recaptchaTimer !== null) return;
    const flush = () => {
      if (this.isOpen && this.requireRecaptcha !== this.sentRequireRecaptcha) this.sendRequireRecaptcha();
      this.recaptchaTimer = null;
    };
    flush();
    this.recaptchaTimer = setTimeout(flush, this.opts.recaptchaDebounceMs ?? NetDefaults.recaptchaDebounceMs);
  }

  // ------------------------------------------------------------------ internals

  private async connect(rcr: string): Promise<void> {
    const gen = ++this.generation;
    if (this.ws !== null) {
      // explicit retry while connected (useRecaptchaToken): replace the session
      this.dropSocket();
      this.lost(1000, false);
    }
    this.clearTimers();
    let session;
    try {
      session = await requestHostSession(this.token, rcr, this.opts);
    } catch (err) {
      if (gen !== this.generation || this.stopped) return;
      this.handlers.onError?.(err as Error);
      this.lost(0, true);
      return;
    }
    if (gen !== this.generation || this.stopped) return;
    if (session.action === 'recaptcha') {
      this.handlers.onError?.(
        new MasterError('recaptcha', 'Invalid or expired token: the master requested a captcha', { sitekey: session.sitekey }),
      );
      this.handlers.onRecaptcha?.(session.sitekey);
      return;
    }
    const base = this.opts.wsUrl ?? session.url;
    const headers: Record<string, string> = { ...this.opts.wsHeaders };
    const origin = this.opts.origin === undefined ? DEFAULT_WS_ORIGIN : this.opts.origin;
    if (origin !== null) headers['Origin'] = origin;
    const wsOpts: WebSocket.ClientOptions = {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: this.opts.handshakeTimeoutMs ?? NetDefaults.signalingHandshakeTimeoutMs,
    };
    if (this.opts.agent) wsOpts.agent = this.opts.agent as http.Agent;
    const ws = new WebSocket(`${base}?token=${session.token}`, wsOpts);
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.onOpen();
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (this.ws !== ws) return;
      this.alive = true;
      if (!isBinary) return;
      this.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
    ws.on('pong', () => {
      if (this.ws === ws) this.alive = true;
    });
    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.lost(code, code !== MasterCloseCode.RoomClosed);
    });
    ws.on('error', (err: Error) => this.fail(ws, err));
  }

  /** Socket error or dead link: drop it and go through the reconnect path. */
  private fail(ws: WebSocket, err: Error): void {
    if (this.ws !== ws) return;
    this.handlers.onError?.(err);
    this.ws = null;
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.terminate();
    this.lost(1006, true);
  }

  /** `Aa.bh`. */
  private onOpen(): void {
    if (this.roomInfo !== null) this.sendRoomInfo();
    if (this.requireRecaptcha) this.sendRequireRecaptcha();
    this.alive = true;
    this.keepAliveTimer = setInterval(() => this.keepAlive(), this.opts.keepAliveMs ?? NetDefaults.keepAliveMs);
    this.handlers.onOpen?.();
  }

  /** `Aa.Yh` (message 8) + liveness check: no pong/message for a whole period => dead link. */
  private keepAlive(): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    if (!this.alive) {
      this.fail(ws, new Error('master signaling: no response to keep-alive (dead connection)'));
      return;
    }
    this.alive = false;
    const w = this.w.reset();
    w.u8(HostToMaster.KeepAlive);
    ws.send(w.copyBytes());
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }

  /** `Aa.Gd`. */
  private lost(code: number, reconnect: boolean): void {
    this.clearTimers();
    this.roomInfoDirty = false;
    this.sentRequireRecaptcha = false;
    const willReconnect = reconnect && !this.stopped && this.opts.reconnect !== false;
    this.handlers.onDisconnect?.({ code, willReconnect });
    if (willReconnect) {
      const rnd = (this.opts.random ?? Math.random)();
      const delay =
        ((this.opts.reconnectMinMs ?? NetDefaults.reconnectMinMs) + rnd * (this.opts.reconnectRangeMs ?? NetDefaults.reconnectRangeMs)) | 0;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopped) void this.connect('');
      }, delay);
    }
  }

  private clearTimers(): void {
    if (this.roomInfoTimer !== null) clearTimeout(this.roomInfoTimer);
    if (this.recaptchaTimer !== null) clearTimeout(this.recaptchaTimer);
    if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.roomInfoTimer = this.recaptchaTimer = this.keepAliveTimer = this.reconnectTimer = null;
  }

  /** `Aa.ah`. */
  private onMessage(msg: Uint8Array): void {
    if (msg.length === 0) return;
    const r = new Reader(msg);
    try {
      switch (r.u8()) {
        case MasterToHost.Offer:
          this.onOfferMessage(r);
          break;
        case MasterToHost.Candidate:
          this.onCandidateMessage(r);
          break;
        case MasterToHost.RoomLink:
          this.roomId = r.stringRaw(r.u8());
          this.handlers.onRoomId?.(this.roomId);
          break;
        case MasterToHost.Token:
          this.token = r.stringRaw(r.remaining);
          break;
      }
    } catch (err) {
      this.handlers.onError?.(err as Error);
    }
  }

  /** `Aa.Zg`. */
  private onOfferMessage(r: Reader): void {
    const peerId = r.u32();
    const connBytes = r.bytes(r.u8());
    let offer: SignalingOffer;
    try {
      const payload = new Reader(inflateRaw(r.bytes(), NetDefaults.signalingInflateLimit));
      const reverse = payload.u8() !== 0;
      const sdp = payload.string();
      const raw = payload.json<unknown>();
      if (!Array.isArray(raw)) throw new Error('candidates is not an array');
      const candidates: IceCandidateInit[] = [];
      for (const c of raw) candidates.push(toCandidate(c));
      offer = { peerId, conn: bytesToConn(connBytes), ip: connBytesToText(connBytes), reverse, sdp, candidates, joinData: payload };
    } catch {
      this.sendReject(peerId, 0);
      return;
    }
    this.handlers.onOffer?.(offer);
  }

  /** `Aa.Ug`: malformed candidates are ignored. */
  private onCandidateMessage(r: Reader): void {
    const peerId = r.u32();
    let cand: IceCandidateInit;
    try {
      cand = toCandidate(new Reader(inflateRaw(r.bytes(), NetDefaults.signalingInflateLimit)).json<unknown>());
    } catch {
      return;
    }
    this.handlers.onCandidate?.(peerId, cand);
  }

  private sendPeerPayload(type: number, peerId: number, payload: Uint8Array): void {
    const z = deflateRaw(payload);
    const w = this.w.reset();
    w.u8(type);
    w.u32(peerId);
    w.bytes(z);
    this.send(w.copyBytes());
  }

  /** `Aa.Yd`. */
  private sendRoomInfo(): void {
    this.roomInfoDirty = false;
    const info = this.roomInfo;
    const out = new Uint8Array(1 + (info?.length ?? 0));
    out[0] = HostToMaster.RoomInfo;
    if (info !== null) out.set(info, 1);
    this.send(out);
  }

  /** `Aa.Df`. */
  private sendRequireRecaptcha(): void {
    this.send(Uint8Array.of(HostToMaster.RequireRecaptcha, this.requireRecaptcha ? 1 : 0));
    this.sentRequireRecaptcha = this.requireRecaptcha;
  }

  private send(bytes: Uint8Array): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(bytes);
  }
}

/** Validates a JSON candidate the way `new RTCIceCandidate(json)` would (lenient on extra fields). */
function toCandidate(c: unknown): IceCandidateInit {
  if (c === null || typeof c !== 'object') throw new Error('bad candidate');
  const o = c as Record<string, unknown>;
  if (typeof o.candidate !== 'string') throw new Error('bad candidate');
  const mid = typeof o.sdpMid === 'string' ? o.sdpMid : null;
  const idx = typeof o.sdpMLineIndex === 'number' ? o.sdpMLineIndex : null;
  if (mid === null && idx === null) throw new Error('sdpMid and sdpMLineIndex are both null');
  const out: IceCandidateInit = { candidate: o.candidate, sdpMid: mid, sdpMLineIndex: idx };
  if (typeof o.usernameFragment === 'string') out.usernameFragment = o.usernameFragment;
  return out;
}
