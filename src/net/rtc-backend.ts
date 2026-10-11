/**
 * `peerBackend: 'rtc'`: player connections terminated by haxlite-rtc
 * (`src/rtc`, pure TypeScript ICE-lite + DTLS 1.2 + SCTP) in this process,
 * every player on **one UDP port**, no native addon, no extra threads.
 *
 * ICE-lite never gathers candidates: the answer only carries the configured
 * {@link RtcBackendOptions.publicAddresses} (host candidates), so the server
 * must be directly reachable there — a public IP on an interface, or a 1:1
 * NAT that forwards the UDP port (cloud VMs: set `publicAddresses` to the
 * elastic/public IP and open the port). Hosts behind a home NAT keep using
 * node-datachannel (`'ndc'`, STUN srflx candidates) or a haxlite Edge.
 *
 * Everything protocol-related stays in {@link HostTransport} (admission
 * before any session exists, answer timing, challenge, flood, idle timeouts,
 * bans by conn/srflx IP, kicks). Differences from node-datachannel that the
 * transport sees:
 *
 * * the answer SDP is complete at once (candidates included,
 *   `a=end-of-candidates`): `onLocalDescription`, the candidates and
 *   `onGatheringComplete` are all delivered inside `createPeer`, so the answer
 *   goes out without the 500 ms gathering wait;
 * * the three channels open together when the SCTP association comes up
 *   (one `onChannelOpen` per channel, in order 0, 1, 2);
 * * `prefiltered`: the host's `iceCandidatePolicy` is not applied — the
 *   configured public addresses are the only ones ever announced;
 * * the selected-pair address given with channel 0 is the source address of
 *   the browser's authenticated STUN checks (its NAT's public address).
 */
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import type { RtcCertificate, RtcEndpoint, RtcEndpointStats, RtcSession } from '../rtc/index.js';
import { classifyAddress } from './ice.js';
import type { PeerBackend, PeerLink, PeerLinkEvents } from './peer-backend.js';

export interface RtcBackendOptions {
  /**
   * UDP port shared by every player (default 0 = ephemeral; set a fixed port
   * and open it in the firewall for production).
   */
  port?: number;
  /** Bind address (default: the wildcard of each family in `publicAddresses`). */
  address?: string;
  /**
   * IP literals advertised to players — the only addresses ever written in
   * SDP. Default: every non-internal interface address classified `public`
   * (see `classifyAddress`); if there is none (NAT, cloud 1:1 NAT) the
   * transport refuses to start and this must be set explicitly.
   */
  publicAddresses?: readonly string[];
  /** Advertised port when a 1:1 NAT maps a different one (default: the bound port). */
  publicPort?: number;
  /** DTLS certificate (default: a new ECDSA P-256 one per endpoint). */
  certificate?: RtcCertificate;
  /** No ICE consent from an open session for this long → closed (default 30 000 ms). */
  idleTimeoutMs?: number;
  /** A session not open this long after the offer → closed (default 20 000 ms; the transport's own 10 s open timeout fires first). */
  handshakeTimeoutMs?: number;
  /** Session cap of the endpoint (default 10 000; the transport's 16-pending / maxPlayers limits apply first). */
  maxSessions?: number;
  /**
   * Use an already-listening endpoint (several rooms on one UDP port). It is
   * not closed by this backend; the options above are then ignored.
   */
  endpoint?: RtcEndpoint;
}

/**
 * Public addresses of this machine's interfaces (non-internal, `public`
 * class: not RFC 1918/CGNAT/ULA/link-local/loopback).
 */
export function detectPublicAddresses(): string[] {
  const out: string[] = [];
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] ?? []) {
      if (a.internal) continue;
      const addr = a.address.split('%')[0]!;
      if (classifyAddress(addr) === 'public' && out.indexOf(addr) < 0) out.push(addr);
    }
  }
  return out;
}

/** Resolves {@link RtcBackendOptions.publicAddresses} (explicit or detected). Throws when none. */
export function resolvePublicAddresses(o: RtcBackendOptions): string[] {
  if (o.publicAddresses !== undefined) {
    const list = [...o.publicAddresses];
    if (list.length === 0) throw new Error("peerBackend 'rtc': publicAddresses is empty");
    for (const a of list) {
      if (isIP(a) === 0) throw new Error(`peerBackend 'rtc': publicAddresses must be IP literals (got ${JSON.stringify(a)})`);
    }
    return list;
  }
  const found = detectPublicAddresses();
  if (found.length === 0) {
    throw new Error(
      "peerBackend 'rtc' needs a publicly reachable address: no interface has a public IP, so set " +
        "rtc.publicAddresses (e.g. ['203.0.113.7'], the public IP of a 1:1 NAT with the UDP port forwarded), " +
        "or use peerBackend 'ndc' (works behind NAT) or a haxlite Edge",
    );
  }
  return found;
}

/** {@link PeerBackend} over one haxlite-rtc {@link RtcEndpoint} (all peers on one UDP port). */
export class RtcPeerBackend implements PeerBackend {
  readonly kind = 'rtc';
  /** Only the configured public addresses are ever announced (no host policy filtering). */
  readonly prefiltered = true;
  private ep: RtcEndpoint | null = null;
  private readonly owned: boolean;
  private readonly opts: RtcBackendOptions;
  private readonly publicAddresses: string[];
  /** start() generation: a listen that completes after stop() is discarded. */
  private generation = 0;
  private readonly links = new Set<RtcPeerLink>();
  private closing: Promise<void> = Promise.resolve();

  constructor(opts: RtcBackendOptions = {}) {
    this.opts = opts;
    this.owned = opts.endpoint === undefined;
    if (opts.endpoint !== undefined) {
      this.ep = opts.endpoint;
      this.publicAddresses = [];
    } else {
      // fail fast (synchronously: HostTransport/HBInit construction) on a missing public address
      this.publicAddresses = resolvePublicAddresses(opts);
    }
  }

  get ready(): boolean {
    return this.ep !== null;
  }

  /** The endpoint (null until listening, or after stop()). */
  get endpoint(): RtcEndpoint | null {
    return this.ep;
  }

  /** The bound UDP port (null until listening). */
  get port(): number | null {
    return this.ep?.port ?? null;
  }

  /** Endpoint counters (packets, bytes, handshakes, sessions…), null until listening. */
  stats(): RtcEndpointStats | null {
    return this.ep?.stats() ?? null;
  }

  start(h: { onReady(): void; onDown(err: Error | null): void; onError(err: Error): void }): void {
    const gen = ++this.generation;
    if (!this.owned) {
      h.onReady();
      return;
    }
    if (this.ep !== null) {
      h.onReady();
      return;
    }
    const o = this.opts;
    import('../rtc/index.js')
      .then((rtc) =>
        rtc.RtcEndpoint.listen({
          port: o.port ?? 0,
          publicAddresses: this.publicAddresses,
          ...(o.address !== undefined ? { address: o.address } : null),
          ...(o.publicPort !== undefined ? { publicPort: o.publicPort } : null),
          ...(o.certificate !== undefined ? { certificate: o.certificate } : null),
          ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : null),
          ...(o.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: o.handshakeTimeoutMs } : null),
          ...(o.maxSessions !== undefined ? { maxSessions: o.maxSessions } : null),
        }),
      )
      .then(
        (ep) => {
          if (gen !== this.generation) {
            void ep.close(); // stopped meanwhile
            return;
          }
          this.ep = ep;
          h.onReady();
        },
        (err: unknown) => {
          if (gen !== this.generation) return;
          const e = err instanceof Error ? err : new Error(String(err));
          h.onError(new Error(`peerBackend 'rtc': cannot listen on UDP ${o.address ?? '*'}:${o.port ?? 0}: ${e.message}`, { cause: e }));
        },
      );
  }

  /** Closes every session (no events) and, if owned, the endpoint's socket(s). */
  stop(): void {
    this.generation++;
    for (const l of [...this.links]) l.close();
    const ep = this.ep;
    if (this.owned) {
      this.ep = null;
      // The sessions just queued their SCTP ABORT / DTLS close_notify: let
      // the UDP sends leave (dgram resolves the address on the next tick)
      // before the socket is closed, so players learn at once that the room
      // is gone instead of waiting for their ICE timeout.
      if (ep !== null) this.closing = new Promise<void>((r) => setImmediate(r)).then(() => ep.close());
    }
  }

  /** Resolves once the socket(s) closed by the last {@link stop} are released. */
  whenClosed(): Promise<void> {
    return this.closing;
  }

  createPeer(_id: number, offerSdp: string, ev: PeerLinkEvents): PeerLink {
    const ep = this.ep;
    if (ep === null) throw new Error("peerBackend 'rtc' is not listening");
    const s = ep.createSession(offerSdp); // throws RtcSdpError on an unusable offer: nothing left behind
    const link = new RtcPeerLink(s, ev, this.links);
    this.links.add(link);
    ev.onLocalDescription(s.answerSdp);
    if (!link.closed) for (const c of s.localCandidates) ev.onLocalCandidate(c, s.mid);
    if (!link.closed) ev.onGatheringComplete();
    return link;
  }
}

/** Close reasons that mean the connection never worked / was lost (→ `'failed'`). */
function isFailure(reason: string): boolean {
  return reason === 'timeout' || reason === 'handshake-timeout' || reason.startsWith('dtls-') || reason === 'sctp:timeout' || reason === 'sctp:init-timeout';
}

class RtcPeerLink implements PeerLink {
  private ev: PeerLinkEvents | null;
  closed = false;

  constructor(
    private readonly s: RtcSession,
    ev: PeerLinkEvents,
    private readonly owner: Set<RtcPeerLink>,
  ) {
    this.ev = ev;
    s.onOpen = () => {
      // all three channels are usable together (one SCTP association)
      const addr = s.remoteAddress?.address ?? null;
      for (let i = 0; i < 3; i++) {
        const e = this.ev;
        if (e === null) return;
        e.onChannelOpen(i, i === 0 ? addr : null);
      }
    };
    s.onMessage = (ch, data) => {
      const e = this.ev;
      if (e !== null) e.onMessage(ch, data);
    };
    // the browser closed one channel (dc.close() → stream reset), like node-datachannel's DataChannel `closed`
    s.onChannelClose = (ch) => this.ev?.onChannelClosed(ch);
    s.onClose = (reason) => {
      const e = this.ev;
      this.release();
      if (e === null) return;
      // node-datachannel order: channel `closed` events, then the PeerConnection state
      e.onChannelClosed(0);
      e.onConnectionState(isFailure(reason) ? 'failed' : 'closed');
    };
  }

  addRemoteCandidate(candidate: string): void {
    try {
      this.s.addRemoteCandidate(candidate);
    } catch {
      /* ignored like the official .catch(function(){}) */
    }
  }

  send(index: number, data: Uint8Array): boolean {
    return this.s.send(index, data);
  }

  close(): void {
    if (this.closed) return;
    this.release();
    this.s.close();
  }

  private release(): void {
    this.closed = true;
    this.ev = null;
    this.owner.delete(this);
  }
}
