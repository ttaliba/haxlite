/**
 * Player-facing WebRTC of the haxlite Edge, behind one small interface:
 *
 * * {@link RtcPlayers} (`playerBackend: 'rtc'`, default): haxlite-rtc
 *   (src/rtc) — ICE-lite + DTLS 1.2 + SCTP in pure TypeScript, ONE UDP
 *   socket for every player, only the configured public addresses are ever
 *   announced, and (ICE-lite) the edge never sends a connectivity check: it
 *   only answers authenticated STUN requests.
 * * `playerBackend: 'ndc'`: node-datachannel PeerConnections
 *   (`LocalPeerLink`), loaded lazily through `src/net/edge-ndc.ts`.
 *
 * Both produce {@link PeerLink}s driven through the host's
 * {@link PeerLinkEvents}, exactly like `HostTransport` drives a backend.
 */
import { networkInterfaces } from 'node:os';
import type { RtcConfig } from 'node-datachannel';
import { classifyAddress, parseCandidate, type IceCandidatePolicy } from '../net/ice.js';
import type { PeerLink, PeerLinkEvents } from '../net/peer-backend.js';
import type { WebRtcStats } from '../net/webrtc.js';
import type { RtcEndpoint, RtcEndpointStats, RtcSession } from '../rtc/index.js';

export type EdgePlayerBackendKind = 'rtc' | 'ndc';

export interface EdgePlayers {
  readonly kind: EdgePlayerBackendKind;
  /** Creates the connection for a player's offer (answer/candidates/open via `ev`). Throws on a bad offer. */
  createLink(name: string, offerSdp: string, ev: PeerLinkEvents): PeerLink;
  close(): Promise<void>;
}

/**
 * Addresses the edge announces when `webrtc.publicAddresses` is not set: the
 * bind address if it is a specific IP, else this machine's interface
 * addresses allowed by `policy` (`'public'`: public ones only).
 */
export function detectPublicAddresses(bindAddress: string | undefined, policy: IceCandidatePolicy): string[] {
  if (bindAddress !== undefined && bindAddress !== '0.0.0.0' && bindAddress !== '::') return [bindAddress];
  const p = typeof policy === 'function' ? 'public' : policy;
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv6' && a.scopeid !== undefined && a.scopeid !== 0) continue; // link-local
      if (bindAddress === '0.0.0.0' && a.family !== 'IPv4') continue;
      const cls = classifyAddress(a.address);
      const ok = p === 'all' ? cls !== 'linklocal' : p === 'private' ? cls === 'public' || cls === 'private' : cls === 'public';
      if (ok && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** First srflx address among the offer's candidates (the player's public IP as its STUN server saw it). */
function offerSrflx(offerSdp: string): string | null {
  for (const line of offerSdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const c = parseCandidate(line.slice(2));
    if (c !== null && c.type === 'srflx') return c.address;
  }
  return null;
}

/** Why a haxlite-rtc session closed → the PeerLink connection state. */
function closeState(reason: string): 'failed' | 'closed' {
  return reason === 'timeout' || reason === 'handshake-timeout' || reason.startsWith('dtls') ? 'failed' : 'closed';
}

export interface RtcPlayersOptions {
  /** UDP port for every player (0 = ephemeral). */
  port: number;
  /** Bind address (default: wildcard of the public addresses' families). */
  address?: string;
  /** The only addresses ever written into answers/candidates. */
  publicAddresses: string[];
  /** Advertised port behind a 1:1 NAT. */
  publicPort?: number;
  handshakeTimeoutMs: number;
  /** ICE consent timeout (default 30 s). */
  idleTimeoutMs?: number;
  maxSessions?: number;
}

/** Players on haxlite-rtc: one {@link RtcEndpoint}, one UDP socket. */
export class RtcPlayers implements EdgePlayers {
  readonly kind = 'rtc';
  readonly ep: RtcEndpoint;

  private constructor(ep: RtcEndpoint) {
    this.ep = ep;
  }

  static async start(o: RtcPlayersOptions): Promise<RtcPlayers> {
    const { RtcEndpoint } = await import('../rtc/index.js');
    const ep = await RtcEndpoint.listen({
      port: o.port,
      ...(o.address !== undefined && o.address !== '' ? { address: o.address } : null),
      publicAddresses: o.publicAddresses,
      ...(o.publicPort !== undefined ? { publicPort: o.publicPort } : null),
      handshakeTimeoutMs: o.handshakeTimeoutMs,
      ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : null),
      ...(o.maxSessions !== undefined ? { maxSessions: o.maxSessions } : null),
    });
    return new RtcPlayers(ep);
  }

  get port(): number {
    return this.ep.port;
  }

  stats(): RtcEndpointStats {
    return this.ep.stats();
  }

  createLink(_name: string, offerSdp: string, ev: PeerLinkEvents): PeerLink {
    const s: RtcSession = this.ep.createSession(offerSdp);
    let events: PeerLinkEvents | null = ev;
    s.onOpen = () => {
      // all three pre-negotiated channels open together with the association; the address is
      // the nominated pair's (as the edge sees the player), else the offer's srflx
      const addr = s.remoteAddress?.address ?? offerSrflx(offerSdp);
      for (let i = 0; i < 3 && events !== null; i++) events.onChannelOpen(i, i === 0 ? addr : null);
    };
    s.onMessage = (ch, data) => events?.onMessage(ch, data);
    // stream reset of one channel (the official client closes everything then)
    s.onChannelClose = (id) => events?.onChannelClosed(id);
    s.onClose = (reason) => {
      const e = events;
      events = null;
      if (e !== null) e.onConnectionState(closeState(reason));
    };
    ev.onLocalDescription(s.answerSdp);
    for (const c of s.localCandidates) {
      if (events === null) break;
      ev.onLocalCandidate(c, s.mid);
    }
    if (events !== null) ev.onGatheringComplete();
    return {
      addRemoteCandidate: (c) => {
        try {
          s.addRemoteCandidate(c); // ICE-lite: only a hint, no check is ever sent to it
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

  close(): Promise<void> {
    return this.ep.close();
  }
}

type NdcModule = typeof import('../net/edge-ndc.js');

/** Players on node-datachannel (`playerBackend: 'ndc'`); the addon is loaded by {@link start}. */
export class NdcPlayers implements EdgePlayers {
  readonly kind = 'ndc';
  readonly mod: NdcModule;
  private readonly rtc: RtcConfig;

  private constructor(mod: NdcModule, rtc: RtcConfig) {
    this.mod = mod;
    this.rtc = rtc;
  }

  static async start(rtc: RtcConfig): Promise<NdcPlayers> {
    return new NdcPlayers(await import('../net/edge-ndc.js'), rtc);
  }

  stats(): WebRtcStats {
    return this.mod.webRtcStats();
  }

  createLink(name: string, offerSdp: string, ev: PeerLinkEvents): PeerLink {
    return new this.mod.LocalPeerLink(name, this.rtc, offerSdp, ev);
  }

  async close(): Promise<void> {
    /* PeerConnections are closed by their sessions; shutdownWebRtc() releases the threads */
  }
}
