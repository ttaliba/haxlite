/**
 * Peer backends: where the player-facing WebRTC PeerConnections live.
 *
 * {@link HostTransport} owns everything protocol-related (admission, the
 * answer/ICE timing of the official host, challenge, handshake, flood, idle
 * timeouts, bans). The backend only creates the PeerConnection for an offer
 * and moves bytes on its three negotiated channels:
 *
 * * {@link LocalPeerBackend} (default): node-datachannel in this process, the
 *   players connect to this machine.
 * * `EdgePeerBackend` (`edge-client.ts`): the PeerConnections live on a
 *   remote haxlite Edge; this process only talks to the edge through an
 *   outbound tunnel, so players never learn its address.
 */
import type { DataChannel, PeerConnection, RtcConfig } from 'node-datachannel';
import { CHANNELS } from './constants.js';
import { toNativeIceServers, type IceServerConfig } from './ice.js';
import { closeNative, createDataChannel, createPeerConnection } from './webrtc.js';

/** Events of one {@link PeerLink}. Never called after {@link PeerLink.close}. */
export interface PeerLinkEvents {
  /** Local answer SDP (unfiltered unless the backend is {@link PeerBackend.prefiltered}). May be called inside `createPeer`. */
  onLocalDescription(sdp: string): void;
  /** Local ICE candidate line (with or without `a=`), and its mid. */
  onLocalCandidate(candidate: string, mid: string): void;
  onGatheringComplete(): void;
  /**
   * Channel `index` opened. For channel 0 the backend passes the remote
   * address of the selected ICE pair (`ip`, no port) when known.
   */
  onChannelOpen(index: number, remoteAddress: string | null): void;
  onChannelClosed(index: number): void;
  /** A message on channel `index`. Binary `data` is only valid during the call (copy to keep it). */
  onMessage(index: number, data: string | Uint8Array): void;
  /** Connection-level `failed`/`closed`. */
  onConnectionState(state: 'failed' | 'closed'): void;
  /**
   * The backend already dropped this peer for abuse (edge-side flood limiter
   * or a text message): the host treats it like its own `flood`/`protocol`
   * close ("Bad actor").
   */
  onAbuse(kind: 'flood' | 'protocol'): void;
  onError(err: Error): void;
}

/** One player's connection inside a backend. */
export interface PeerLink {
  /** Adds a remote candidate line (no `a=` prefix) for `mid`. Errors are swallowed (`.catch(function(){})`). */
  addRemoteCandidate(candidate: string, mid: string): void;
  /** Sends on channel `index` (already known to be open). Returns false when nothing was sent. */
  send(index: number, data: Uint8Array): boolean;
  /** Releases everything; no event is delivered afterwards. Idempotent. */
  close(): void;
}

/** What the transport knows about an offer besides its SDP. */
export interface PeerOfferInfo {
  /** IP the client reached the master from (`offer.ip`). */
  ip?: string;
}

export interface PeerBackend {
  /** `'local'` or `'edge'` (diagnostics). */
  readonly kind: string;
  /**
   * The SDP/candidates this backend reports were already filtered by their
   * owner (the edge applies its own `iceCandidatePolicy`), so the transport
   * must not filter them again with the host's policy.
   */
  readonly prefiltered: boolean;
  /** New peers can be created now (the edge tunnel is up). */
  readonly ready: boolean;
  /**
   * The transport may send the answer as soon as one local candidate passes
   * the ICE policy, trickling the rest, instead of waiting for gathering to
   * complete (or `answerIceWaitMs`). Set by {@link LocalPeerBackend}: its
   * host candidates are known at once while the STUN (srflx) one takes a
   * round trip — or never comes when the STUN server is unreachable.
   */
  readonly answerOnFirstCandidate?: boolean;
  /**
   * Starts the backend; `onReady` is called every time it becomes ready (the
   * edge tunnel after each (re)connection), `onDown` when it stops being
   * ready (every live link has already been closed with
   * `onConnectionState('closed')`).
   */
  start(handlers: { onReady(): void; onDown(err: Error | null): void; onError(err: Error): void }): void;
  stop(): void;
  /**
   * Creates the connection for a client's offer: applies the offer, creates
   * the three negotiated channels and the answer. Throws if that fails
   * (nothing is left behind then).
   */
  createPeer(id: number, offerSdp: string, events: PeerLinkEvents, info?: PeerOfferInfo): PeerLink;
  /** Optional: replaces the STUN/TURN servers at runtime (fresh short-lived TURN credentials). */
  setIceServers?(list: readonly IceServerConfig[]): void;
  /**
   * Optional fan-out: the same bytes to several links on `channel` (each
   * link falls back to channel 0 like {@link PeerLink.send}). Lets the edge
   * backend send one tunnel message instead of one per player.
   */
  sendMany?(links: readonly PeerLink[], channel: number, data: Uint8Array): void;
  /**
   * Optional bundling scope (nestable): the sends issued until the matching
   * {@link uncork} may be held and sent together (one packet per peer) when
   * the outermost scope ends. HostRoom wraps each wake-up / message / action.
   */
  cork?(): void;
  uncork?(): void;
}

export interface LocalPeerBackendOptions {
  /** node-datachannel config (iceServers, port range, bindAddress…). `disableAutoNegotiation` is forced. */
  rtc: RtcConfig;
}

/** Player PeerConnections in this process (the classic haxlite host). */
export class LocalPeerBackend implements PeerBackend {
  readonly kind = 'local';
  readonly prefiltered = false;
  readonly ready = true;
  readonly answerOnFirstCandidate = true;
  private readonly rtc: RtcConfig;

  constructor(opts: LocalPeerBackendOptions) {
    this.rtc = { ...opts.rtc, disableAutoNegotiation: true };
  }

  start(handlers: { onReady(): void }): void {
    handlers.onReady();
  }

  stop(): void {}

  createPeer(id: number, offerSdp: string, ev: PeerLinkEvents): PeerLink {
    return new LocalPeerLink(`haxlite-${id}`, this.rtc, offerSdp, ev);
  }

  /** New PeerConnections use `list` (existing ones keep theirs). */
  setIceServers(list: readonly IceServerConfig[]): void {
    (this.rtc as { iceServers?: unknown }).iceServers = toNativeIceServers(list);
  }
}

/**
 * Makes libdatachannel answer `a=setup:passive` (this side = DTLS server) to
 * an `actpass` offer by presenting the offer as `a=setup:active`; the answer
 * that goes to the client says `passive`, which every WebRTC stack accepts
 * for an `actpass` offer (RFC 8842 §5.3), so the client becomes the DTLS
 * client. Left alone, libdatachannel answers `active` and sends its
 * ClientHello the moment ICE connects — usually *before* the client has the
 * answer (a full ICE agent answers connectivity checks before it knows the
 * remote description) — so the client drops it and the handshake waits for
 * OpenSSL's 1 s retransmission: ≈ 0.5–1 s of every join. As DTLS server the
 * host just waits for the client's ClientHello, which the client only sends
 * once it has the answer.
 */
export function passiveDtlsOffer(sdp: string): string {
  return sdp.indexOf('a=setup:actpass') >= 0 ? sdp.replaceAll('a=setup:actpass', 'a=setup:active') : sdp;
}

/** Selected-pair remote IP of a PeerConnection, or null. */
export function selectedRemoteAddress(pc: PeerConnection): string | null {
  try {
    return pc.getSelectedCandidatePair()?.remote.address ?? null;
  } catch {
    return null;
  }
}

/**
 * One node-datachannel PeerConnection answering a client offer with the
 * three negotiated channels of the official host (`la.Hg`). Shared by the
 * local backend and the edge server.
 */
export class LocalPeerLink implements PeerLink {
  private pc: PeerConnection | null;
  private readonly channels: (DataChannel | null)[] = [null, null, null];
  private readonly open: boolean[] = [false, false, false];
  private ev: PeerLinkEvents | null;

  constructor(name: string, rtc: RtcConfig, offerSdp: string, ev: PeerLinkEvents) {
    this.ev = ev;
    const onError = (err: Error) => this.ev?.onError(err);
    const pc = createPeerConnection(name, rtc, {
      onLocalCandidate: (cand, mid) => this.ev?.onLocalCandidate(cand, mid),
      onGatheringStateChange: (state) => {
        if (state === 'complete') this.ev?.onGatheringComplete();
      },
      onStateChange: (state) => {
        if (state === 'failed' || state === 'closed') this.ev?.onConnectionState(state);
      },
      onError,
    });
    this.pc = pc;
    let sdp: string | null;
    try {
      pc.setRemoteDescription(passiveDtlsOffer(offerSdp), 'offer');
      for (let i = 0; i < CHANNELS.length; i++) this.createChannel(pc, i, onError);
      pc.setLocalDescription('answer');
      sdp = pc.localDescription()?.sdp ?? null;
      if (sdp === null) throw new Error('no local description');
    } catch (err) {
      this.close();
      throw err;
    }
    ev.onLocalDescription(sdp);
  }

  /** `la.Hg`: negotiated channel `id = index`, `maxRetransmits: 0` when unreliable. */
  private createChannel(pc: PeerConnection, index: number, onError: (err: Error) => void): void {
    const cfg = CHANNELS[index]!;
    const dc = createDataChannel(
      pc,
      cfg.label,
      {
        negotiated: true,
        id: index,
        unordered: !cfg.ordered,
        ...(cfg.reliable ? {} : { maxRetransmits: 0 }),
      },
      {
        onOpen: () => {
          if (this.channels[index] !== dc) return; // stale (already destroyed)
          this.open[index] = true;
          const ev = this.ev;
          if (ev !== null) ev.onChannelOpen(index, index === 0 && this.pc !== null ? selectedRemoteAddress(this.pc) : null);
        },
        onClosed: () => {
          if (this.channels[index] !== dc) return;
          this.open[index] = false;
          this.ev?.onChannelClosed(index);
        },
        onMessage: (msg) => {
          if (this.channels[index] !== dc) return;
          const ev = this.ev;
          if (ev !== null) ev.onMessage(index, msg instanceof ArrayBuffer ? new Uint8Array(msg) : msg);
        },
        onError,
      },
    );
    this.channels[index] = dc;
  }

  /** The native PeerConnection (null once closed). */
  get native(): PeerConnection | null {
    return this.pc;
  }

  isOpen(index: number): boolean {
    return this.open[index] === true;
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    const pc = this.pc;
    if (pc === null) return;
    try {
      pc.addRemoteCandidate(candidate, mid);
    } catch {
      // unresolvable (e.g. mDNS) or malformed: ignored like `.catch(function(){})`
    }
  }

  send(index: number, data: Uint8Array): boolean {
    const dc = this.channels[index];
    if (dc == null || !this.open[index]) return false;
    try {
      return dc.sendMessageBinary(data);
    } catch {
      return false;
    }
  }

  /** Bytes buffered on channel `index` (backpressure diagnostics). */
  bufferedAmount(index: number): number {
    const dc = this.channels[index];
    if (dc == null) return 0;
    try {
      return dc.bufferedAmount();
    } catch {
      return 0;
    }
  }

  /**
   * Detaches the native objects at once (late callbacks are ignored) and
   * closes them on the next turn via {@link closeNative}, which keeps them
   * referenced until libdatachannel confirms the close.
   */
  close(): void {
    this.ev = null;
    for (let i = 0; i < this.channels.length; i++) {
      const dc = this.channels[i];
      this.open[i] = false;
      this.channels[i] = null;
      if (dc != null) closeNative(dc);
    }
    const pc = this.pc;
    this.pc = null;
    if (pc !== null) closeNative(pc);
  }
}
