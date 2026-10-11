/**
 * Server-side WebRTC backends for the interop harness, behind the host's own
 * {@link PeerBackend} interface (src/net/peer-backend.ts) so the harness
 * drives them exactly like HostTransport does:
 *
 *  * `ndc`: {@link LocalPeerBackend} (node-datachannel / libdatachannel), the
 *    reference implementation used by haxlite today.
 *  * `rtc`: haxlite-rtc `RtcEndpoint` (src/rtc), through {@link RtcPeerBackend}
 *    below (an adapter written against the src/rtc/README.md contract; the
 *    real `peerBackend: 'rtc'` wiring will live in src/net).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalPeerBackend, type PeerBackend, type PeerLink, type PeerLinkEvents } from '../../../src/net/peer-backend.js';
import { shutdownWebRtc } from '../../../src/net/webrtc.js';

export type BackendKind = 'ndc' | 'rtc';

export interface BackendHandle {
  kind: BackendKind;
  backend: PeerBackend;
  /** Releases sockets/threads. */
  close(): Promise<void>;
  /** Backend-specific counters (haxlite-rtc `ep.stats()`), if any. */
  stats(): unknown;
}

export interface BackendOptions {
  /** The only address the server advertises/binds for ICE (IP literal). */
  address: string;
  /** haxlite-rtc: UDP port (0 = ephemeral). */
  port?: number;
  /** haxlite-rtc: ICE consent idle timeout (ms). */
  idleTimeoutMs?: number;
}

const RTC_INDEX = new URL('../../../src/rtc/index.ts', import.meta.url);

const SCTP_INDEX = new URL('../../../src/rtc/sctp/index.ts', import.meta.url);

/** True once src/rtc/index.ts (R1) and its SCTP layer src/rtc/sctp/index.ts (R2) exist. */
export function rtcAvailable(): boolean {
  return existsSync(fileURLToPath(RTC_INDEX)) && existsSync(fileURLToPath(SCTP_INDEX));
}

export async function createBackend(kind: BackendKind, o: BackendOptions): Promise<BackendHandle> {
  if (kind === 'ndc') {
    const backend = new LocalPeerBackend({ rtc: { iceServers: [], bindAddress: o.address, maxMessageSize: 262144 } });
    return {
      kind,
      backend,
      close: async () => {
        await shutdownWebRtc();
      },
      stats: () => null,
    };
  }
  const mod = (await import(RTC_INDEX.href)) as RtcModule;
  const ep = await mod.RtcEndpoint.listen({
    port: o.port ?? 0,
    address: o.address,
    publicAddresses: [o.address],
    ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : null),
  });
  const backend = new RtcPeerBackend(ep);
  return {
    kind,
    backend,
    close: () => ep.close(),
    stats: () => ep.stats(),
  };
}

// ---------------------------------------------------------------- haxlite-rtc adapter

/** Structural view of src/rtc (README contract); avoids a static import while it is being built. */
interface RtcModule {
  RtcEndpoint: { listen(o: Record<string, unknown>): Promise<RtcEndpointLike> };
}
interface RtcEndpointLike {
  createSession(offerSdp: string): RtcSessionLike;
  close(): Promise<void>;
  stats(): unknown;
}
interface RtcSessionLike {
  readonly answerSdp: string;
  readonly localCandidates: string[];
  readonly mid: string;
  addRemoteCandidate(candidate: string): void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  onMessage?: (channelId: number, data: Uint8Array) => void;
  send(channelId: number, data: Uint8Array): boolean;
  readonly remoteAddress: { address: string; port: number } | null;
  readonly state: string;
  close(): void;
}

/** `PeerBackend` over one haxlite-rtc `RtcEndpoint` (all peers on one UDP port). */
export class RtcPeerBackend implements PeerBackend {
  readonly kind = 'rtc';
  readonly prefiltered = false;
  readonly ready = true;
  /** Close reason of each session, by peer id (diagnostics for the tests). */
  readonly closeReasons = new Map<number, string>();

  constructor(private readonly ep: RtcEndpointLike) {}

  start(h: { onReady(): void }): void {
    h.onReady();
  }
  stop(): void {}

  createPeer(id: number, offerSdp: string, ev: PeerLinkEvents): PeerLink {
    const s = this.ep.createSession(offerSdp);
    let events: PeerLinkEvents | null = ev;
    const reasons = this.closeReasons;
    s.onOpen = () => {
      for (let i = 0; i < 3; i++) events?.onChannelOpen(i, i === 0 ? (s.remoteAddress?.address ?? null) : null);
    };
    s.onMessage = (ch, data) => events?.onMessage(ch, data);
    s.onClose = (reason) => {
      reasons.set(id, reason);
      const e = events;
      events = null;
      if (e === null) return;
      for (let i = 0; i < 3; i++) e.onChannelClosed(i);
      e.onConnectionState(reason === 'timeout' || reason.startsWith('dtls') || reason === 'handshake-timeout' ? 'failed' : 'closed');
    };
    ev.onLocalDescription(s.answerSdp);
    for (const c of s.localCandidates) ev.onLocalCandidate(c, s.mid);
    ev.onGatheringComplete();
    return {
      addRemoteCandidate: (c) => {
        try {
          s.addRemoteCandidate(c);
        } catch {
          /* ignored like the official .catch(function(){}) */
        }
      },
      send: (i, data) => s.send(i, data),
      close: () => {
        events = null;
        s.close();
      },
    };
  }
}
