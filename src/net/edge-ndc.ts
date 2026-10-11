/**
 * Everything of the haxlite Edge stack that needs node-datachannel, in ONE
 * module that `edge-client.ts` and `src/edge/server.ts` only reach through a
 * dynamic `import()`: the legacy WebRTC tunnel data plane (protocol flag
 * `AuthFlag.WebRtc`) and the edge's `playerBackend: 'ndc'` player links. An
 * edge running `playerBackend: 'rtc'` with tunnel v2 hosts, and a host using
 * the UDP tunnel, never load the native addon.
 */
import type { DataChannel, PeerConnection, RtcConfig } from 'node-datachannel';
import { CHANNELS } from './constants.js';
import { candidateLine } from './ice.js';
import { LocalPeerLink } from './peer-backend.js';
import { closeNative, createDataChannel, createPeerConnection, shutdownWebRtc, webRtcStats } from './webrtc.js';

export { LocalPeerLink, shutdownWebRtc, webRtcStats };

export interface NdcTunnelEvents {
  /** Every tunnel channel is open. */
  onOpen(): void;
  onMessage(ch: number, data: Uint8Array): void;
  /** Connection failed/closed or a channel closed (once). */
  onClose(reason: string): void;
  /** Local candidate line (no `a=`) to signal to the other side. */
  onLocalCandidate(candidate: string, mid: string): void;
  onError(err: Error): void;
}

/**
 * The legacy host↔edge PeerConnection: 3 + (lanes − 1) negotiated channels
 * mirroring `ro`/`ru`/`uu` (+ ordered `ro` lanes). The host creates the
 * offer, the edge answers.
 */
export class NdcTunnelPlane {
  private pc: PeerConnection | null;
  private readonly dcs: (DataChannel | null)[];
  private readonly dcOpen: boolean[];
  private readonly ev: NdcTunnelEvents;
  private done = false;

  constructor(name: string, rtc: RtcConfig, lanes: number, ev: NdcTunnelEvents) {
    this.ev = ev;
    const onError = (err: Error) => this.ev.onError(err);
    const pc = createPeerConnection(name, { ...rtc, disableAutoNegotiation: true }, {
      onLocalCandidate: (cand, mid) => {
        if (this.pc === pc && !this.done) this.ev.onLocalCandidate(candidateLine(cand), mid);
      },
      onStateChange: (state) => {
        if (this.pc === pc && (state === 'failed' || state === 'closed')) this.fail(`tunnel connection ${state}`);
      },
      onError,
    });
    this.pc = pc;
    const total = CHANNELS.length + lanes - 1;
    this.dcs = new Array<DataChannel | null>(total).fill(null);
    this.dcOpen = new Array<boolean>(total).fill(false);
    for (let i = 0; i < total; i++) {
      const cfg = CHANNELS[i] ?? { label: `ro${i - 2}`, ordered: true, reliable: true };
      const dc = createDataChannel(
        pc,
        `tunnel-${cfg.label}`,
        { negotiated: true, id: i, unordered: !cfg.ordered, ...(cfg.reliable ? {} : { maxRetransmits: 0 }) },
        {
          onOpen: () => {
            if (this.dcs[i] !== dc) return;
            this.dcOpen[i] = true;
            if (this.dcOpen.every((x) => x)) this.ev.onOpen();
          },
          onClosed: () => {
            if (this.dcs[i] !== dc) return;
            this.dcOpen[i] = false;
            this.fail(`tunnel channel ${cfg.label} closed`);
          },
          onMessage: (msg) => {
            if (this.dcs[i] !== dc || typeof msg === 'string' || this.done) return;
            this.ev.onMessage(i, msg instanceof ArrayBuffer ? new Uint8Array(msg) : msg);
          },
          onError,
        },
      );
      this.dcs[i] = dc;
    }
  }

  /** Host: creates the offer. */
  createOffer(): string {
    const pc = this.pc!;
    pc.setLocalDescription('offer');
    const sdp = pc.localDescription()?.sdp;
    if (sdp === undefined) throw new Error('no local offer');
    return sdp;
  }

  /** Edge: applies the host's offer and returns the answer. */
  answer(offerSdp: string): string {
    const pc = this.pc!;
    pc.setRemoteDescription(offerSdp, 'offer');
    pc.setLocalDescription('answer');
    const sdp = pc.localDescription()?.sdp;
    if (sdp === undefined) throw new Error('no tunnel answer');
    return sdp;
  }

  /** Host: applies the edge's answer. */
  setAnswer(sdp: string): void {
    this.pc?.setRemoteDescription(sdp, 'answer');
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    try {
      this.pc?.addRemoteCandidate(candidate, mid);
    } catch {
      /* ignore */
    }
  }

  ready(ch: number): boolean {
    return this.dcOpen[ch] === true;
  }

  send(ch: number, frame: Uint8Array): boolean {
    const dc = this.dcs[ch];
    if (dc == null || !this.dcOpen[ch]) return false;
    try {
      return dc.sendMessageBinary(frame as Buffer);
    } catch {
      return false;
    }
  }

  private fail(reason: string): void {
    if (this.done) return;
    this.close();
    this.ev.onClose(reason);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
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
