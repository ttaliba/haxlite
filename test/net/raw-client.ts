/**
 * Minimal HaxBall client for tests (TEST ONLY): speaks the client side of the
 * master signaling (docs/02 §2.3) and the data-channel handshake, built on
 * node-datachannel + haxlite's codec/auth helpers. Lets tests drive what a
 * node-haxball client can't (custom offers, floods, raw messages).
 */
import type { DataChannel, PeerConnection } from 'node-datachannel';
import { WebSocket } from 'ws';
import { Reader, Writer, deflateRaw, inflateRaw } from '../../src/codec/index.js';
import { CHANNELS } from '../../src/net/constants.js';
import { createAuthBlob, type PlayerIdentity } from '../../src/net/auth.js';
import { encodeHandshake, type JoinPlayerInfo } from '../../src/net/handshake.js';
import type { IceCandidateInit } from '../../src/net/ice.js';
import { closeNative, createDataChannel, createPeerConnection } from '../../src/net/webrtc.js';

export interface RawJoinOptions {
  wsBase: string;
  roomId: string;
  version?: number;
  password?: string | null;
  reverse?: boolean;
  /** Extra (fake) candidates appended to the offer, e.g. a srflx with a banned IP. */
  extraCandidates?: IceCandidateInit[];
  /** Replace the offer payload entirely (malformed-offer tests). */
  rawPayload?: Uint8Array;
  /** Skip WebRTC: send a fake SDP (for signaling-only rejection tests). */
  signalingOnly?: boolean;
  identity?: PlayerIdentity | null;
  info?: JoinPlayerInfo;
  /** Corrupt the signature. */
  badSignature?: boolean;
  /** Don't answer the challenge automatically. */
  manualHandshake?: boolean;
}

export class RawClient {
  readonly ws: WebSocket;
  pc: PeerConnection | null = null;
  readonly channels: DataChannel[] = [];
  /** WS close code (rejections arrive here). */
  readonly closed: Promise<number>;
  /** Resolves with the challenge once received. */
  readonly challenge: Promise<Uint8Array>;
  /** Messages received from the host after the challenge: [channel, bytes]. */
  readonly received: [number, Uint8Array][] = [];
  private resolveChallenge!: (c: Uint8Array) => void;
  private readonly opts: RawJoinOptions;
  private readonly openWaiters: (() => void)[] = [];
  private openCount = 0;
  private dcClosed = false;
  readonly dcClosedPromise: Promise<void>;
  private resolveDcClosed!: () => void;
  messageWaiters: (() => void)[] = [];

  constructor(opts: RawJoinOptions) {
    this.opts = opts;
    this.challenge = new Promise((r) => (this.resolveChallenge = r));
    this.dcClosedPromise = new Promise((r) => (this.resolveDcClosed = r));
    this.ws = new WebSocket(`${opts.wsBase}client?id=${opts.roomId}`);
    this.ws.binaryType = 'nodebuffer';
    this.closed = new Promise((resolve) => this.ws.on('close', (code) => resolve(code)));
    this.ws.on('error', () => {});
    this.ws.on('open', () => void this.start().catch(() => this.close()));
    this.ws.on('message', (data: Buffer) => this.onSignal(new Uint8Array(data)));
  }

  /** All three channels open. */
  whenOpen(): Promise<void> {
    if (this.openCount === CHANNELS.length) return Promise.resolve();
    return new Promise((r) => this.openWaiters.push(r));
  }

  waitMessages(n: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.received.length >= n) resolve();
        else this.messageWaiters.push(check);
      };
      check();
    });
  }

  get channelsClosed(): Promise<void> {
    return this.dcClosedPromise;
  }

  send(channel: number, bytes: Uint8Array): boolean {
    try {
      return this.channels[channel]!.sendMessageBinary(bytes);
    } catch {
      return false;
    }
  }

  async sendHandshake(challenge: Uint8Array): Promise<void> {
    // libdatachannel may deliver a message before this side's own `open`
    // callbacks; sending before them would be dropped.
    await this.whenOpen();
    let blob: Uint8Array | null = null;
    if (this.opts.identity) {
      blob = await createAuthBlob(this.opts.identity, challenge);
      if (this.opts.badSignature) blob[blob.length - 1]! ^= 0xff;
    }
    this.send(0, encodeHandshake(blob, this.opts.info ?? { name: 'raw', flag: 'ar', avatar: null }));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    for (const dc of this.channels) closeNative(dc);
    if (this.pc !== null) closeNative(this.pc);
    this.pc = null;
  }

  private sendSignal(type: number, payload: Uint8Array | null): void {
    const z = payload ? deflateRaw(payload) : new Uint8Array(0);
    const out = new Uint8Array(1 + z.length);
    out[0] = type;
    out.set(z, 1);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(out);
  }

  private async start(): Promise<void> {
    const o = this.opts;
    if (o.rawPayload) {
      this.sendSignal(1, o.rawPayload);
      return;
    }
    let sdp = 'v=0\r\n';
    if (!o.signalingOnly) {
      let gatheredResolve!: () => void;
      const gathered = new Promise<void>((resolve) => {
        gatheredResolve = resolve;
        setTimeout(resolve, 500);
      });
      // Explicit negotiation only: auto-negotiation races the explicit offer below.
      const pc = createPeerConnection(
        'raw-client',
        { iceServers: [], disableAutoNegotiation: true },
        {
          onGatheringStateChange: (s) => s === 'complete' && gatheredResolve(),
          onLocalCandidate: (c, mid) => {
            const line = c.startsWith('a=') ? c.slice(2) : c;
            const cand = { candidate: line, sdpMid: mid, sdpMLineIndex: 0 };
            if (this.answerApplied) this.sendSignal(4, jsonPayload(cand));
            else this.ownCandidates.push(cand);
          },
        },
      );
      this.pc = pc;
      for (let i = 0; i < CHANNELS.length; i++) {
        const cfg = CHANNELS[i]!;
        const dc = createDataChannel(
          pc,
          cfg.label,
          {
            negotiated: true,
            id: i,
            unordered: !cfg.ordered,
            ...(cfg.reliable ? {} : { maxRetransmits: 0 }),
          },
          {
            onOpen: () => {
              if (++this.openCount === CHANNELS.length) for (const w of this.openWaiters.splice(0)) w();
            },
            onClosed: () => {
              if (!this.dcClosed) {
                this.dcClosed = true;
                this.resolveDcClosed();
              }
            },
            onMessage: (m) => this.onData(i, m),
          },
        );
        this.channels.push(dc);
      }
      pc.setLocalDescription('offer');
      await gathered;
      if (this.pc !== pc) return; // closed meanwhile
      const local = pc.localDescription();
      if (local === null) return;
      // Candidates are trickled only after the answer is applied (see `ownCandidates`).
      sdp = local.sdp.split('\r\n')
        .filter((l) => !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates')
        .join('\r\n');
    }
    const w = new Writer(1024);
    w.u8(o.reverse ? 1 : 0);
    w.string(sdp);
    w.json(o.extraCandidates ?? []);
    w.u16(o.version ?? 9);
    w.nullableString(o.password ?? null);
    this.sendSignal(1, w.finish());
  }

  private onSignal(msg: Uint8Array): void {
    const type = msg[0];
    if (msg.length <= 1 || this.pc === null) return;
    try {
      const r = new Reader(inflateRaw(msg.subarray(1)));
      if (type === 1) {
        const sdp = r.string();
        const cands = r.json<IceCandidateInit[]>();
        this.answerSdp = sdp;
        this.answerCandidates = cands;
        this.pc.setRemoteDescription(sdp, 'answer');
        for (const c of cands) this.addCandidate(c);
        this.answerApplied = true;
        for (const c of this.ownCandidates.splice(0)) this.sendSignal(4, jsonPayload(c));
      } else if (type === 4) {
        const c = r.json<IceCandidateInit>();
        this.answerCandidates.push(c);
        this.addCandidate(c);
      }
    } catch (err) {
      this.signalError = err as Error;
    }
  }

  private addCandidate(c: IceCandidateInit): void {
    try {
      this.pc?.addRemoteCandidate(c.candidate, c.sdpMid ?? '0');
    } catch {
      /* ignore */
    }
  }

  private onData(channel: number, m: string | Buffer | ArrayBuffer): void {
    if (typeof m === 'string') return;
    const bytes = m instanceof ArrayBuffer ? new Uint8Array(m) : new Uint8Array(m);
    if (bytes[0] === 0 && channel === 0 && this.received.length === 0 && !this.challengeSeen) {
      this.challengeSeen = true;
      const r = new Reader(bytes, 1);
      const ch = r.bytesCopy(r.varUint());
      this.resolveChallenge(ch);
      if (!this.opts.manualHandshake) void this.sendHandshake(ch);
      return;
    }
    this.received.push([channel, bytes]);
    for (const w of this.messageWaiters.splice(0)) w();
  }

  private challengeSeen = false;
  /**
   * Our candidates, held back until the host's answer is applied. If the host
   * knew them earlier it would start ICE checks at once, and over loopback
   * libdatachannel can then run the DTLS handshake before
   * `setRemoteDescription(answer)` has stored the remote fingerprint: the
   * handshake fails with "certificate verify failed / unknown CA" (or the
   * answer throws "Got a remote candidate without ICE transport"). Browser
   * clients don't have this race.
   */
  private readonly ownCandidates: IceCandidateInit[] = [];
  private answerApplied = false;
  /** Answer SDP and candidates received from the host (privacy tests). */
  answerSdp: string | null = null;
  answerCandidates: IceCandidateInit[] = [];
  /** Error applying the host's answer/candidates, if any. */
  signalError: Error | null = null;
}

function jsonPayload(v: unknown): Uint8Array {
  const w = new Writer(256);
  w.json(v);
  return w.copyBytes();
}
