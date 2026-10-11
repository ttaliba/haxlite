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
 *   the browser's authenticated STUN checks (its NAT's public address);
 * * **per-iteration bundling**: the first `send` to a peer in an event-loop
 *   iteration corks its SCTP association and every corked peer is flushed
 *   from one `setImmediate` (the check phase of the same iteration). All the
 *   messages a peer gets in that iteration (event on `ru`, heartbeat on `uu`,
 *   pong, CheckConsistency…, plus the SACK it is owed) leave as one SCTP
 *   packet (RFC 9260 bundling, up to the MTU and the congestion window) →
 *   one DTLS record, one cipher operation, one datagram. Each message is
 *   still delivered separately to the data channel; no latency is added
 *   beyond the rest of the current iteration. Closing a link flushes first,
 *   so a kick message still precedes the ABORT;
 * * received messages may be transient views (only valid during
 *   `onMessage`, see `transientDelivery` in src/rtc/sctp): the transport and
 *   the host consume them synchronously and copy what they keep.
 */
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import type { RtcCertificate, RtcEndpoint, RtcEndpointStats, RtcSession, SharedEndpointLease } from '../rtc/index.js';
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
  /** DTLS certificate (default: {@link certificateFile}, else one ECDSA P-256 key per process, generated off-thread). */
  certificate?: RtcCertificate;
  /** Keep the DTLS identity in this PEM file (created 0600 on first use): stable fingerprint, no key generation at start. */
  certificateFile?: string;
  /**
   * Share one endpoint (one UDP socket) with every other room of this process
   * that uses the same settings (default true; with `port` 0 they all get the
   * same ephemeral port). false: this room gets its own endpoint and socket.
   */
  shared?: boolean;
  /** DTLS cipher suites in preference order (default ChaCha20-Poly1305, AES-128-GCM, AES-256-GCM; see RtcEndpointOptions). */
  cipherSuites?: readonly (number | string)[];
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

/**
 * Per-iteration bundling of every RtcPeerLink in the process. A link corks
 * its session on its first send and registers here; everything registered
 * is flushed (uncorked) either
 *
 * * when the outermost explicit scope ends ({@link RtcPeerBackend.cork} /
 *   `uncork`, used by HostRoom around each wake-up / message / action: the
 *   flush happens before control returns to the event loop, no allocation), or
 * * from one shared `setImmediate` (check phase of the same iteration) for
 *   sends issued outside any scope (transport handshake, user code…).
 */
class SendBundler {
  private list: RtcPeerLink[] = [];
  private spare: RtcPeerLink[] = [];
  private depth = 0;
  private scheduled = false;
  private flushing = false;
  private readonly immediateFn = (): void => {
    this.scheduled = false;
    this.flush();
  };

  add(link: RtcPeerLink): void {
    this.list.push(link);
    if (this.depth === 0 && !this.scheduled && !this.flushing) {
      this.scheduled = true;
      setImmediate(this.immediateFn);
    }
  }

  enter(): void {
    this.depth++;
  }

  leave(): void {
    if (this.depth > 0 && --this.depth === 0) this.flush();
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // a flush can deliver deferred input → host sends → new corks: take them in the same pass
      while (this.list.length > 0) {
        const l = this.list;
        this.list = this.spare;
        for (let i = 0; i < l.length; i++) l[i]!.flushBundle();
        l.length = 0;
        this.spare = l;
      }
    } finally {
      this.flushing = false;
      if (this.list.length > 0 && this.depth === 0 && !this.scheduled) {
        this.scheduled = true;
        setImmediate(this.immediateFn);
      }
    }
  }
}

const bundler = new SendBundler();

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
  /** Lease on the endpoint while owned and started. */
  private lease: SharedEndpointLease | null = null;
  /** Settles when the endpoint of the current start() listens (rejects when it cannot). */
  private listening: Promise<void> = Promise.resolve();
  /** Between start() and the endpoint listening (or failing to). */
  private starting = false;
  /** Offers accepted while {@link starting}, answered once the endpoint listens. */
  private readonly deferred = new Set<DeferredRtcPeerLink>();

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

  /** Listening, or about to (offers taken meanwhile are answered once it listens). */
  get ready(): boolean {
    return this.ep !== null || this.starting;
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
    if (!this.owned || this.ep !== null || this.lease !== null) {
      h.onReady();
      return;
    }
    const o = this.opts;
    const epOpts = {
      port: o.port ?? 0,
      publicAddresses: this.publicAddresses,
      ...(o.address !== undefined ? { address: o.address } : null),
      ...(o.publicPort !== undefined ? { publicPort: o.publicPort } : null),
      ...(o.certificate !== undefined ? { certificate: o.certificate } : null),
      ...(o.certificateFile !== undefined ? { certificateFile: o.certificateFile } : null),
      ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : null),
      ...(o.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: o.handshakeTimeoutMs } : null),
      ...(o.maxSessions !== undefined ? { maxSessions: o.maxSessions } : null),
      ...(o.cipherSuites !== undefined ? { cipherSuites: o.cipherSuites } : null),
    };
    // Like 'ndc' (whose library loads at the first peer), signaling starts at
    // once: the rtc modules, the UDP socket and the certificate come up during
    // the master round trips instead of before them. Until then `ready` is
    // false and an early offer is refused like any offer to a backend not ready.
    this.starting = true;
    h.onReady();
    this.listening = import('../rtc/index.js')
      .then((rtc) => {
        if (gen !== this.generation) return;
        const lease: SharedEndpointLease =
          o.shared === false
            ? (() => {
                const ready = rtc.RtcEndpoint.listen(epOpts);
                return { ready, release: () => ready.then((ep) => new Promise<void>((r) => setImmediate(r)).then(() => ep.close()), () => {}) };
              })()
            : rtc.acquireSharedEndpoint(epOpts);
        this.lease = lease;
        return lease.ready.then((ep) => {
          if (gen !== this.generation) return;
          this.ep = ep;
          this.starting = false;
        });
      })
      .catch((err: unknown) => {
        if (gen === this.generation) this.starting = false;
        const e = err instanceof Error ? err : new Error(String(err));
        const wrapped = new Error(`peerBackend 'rtc': cannot listen on UDP ${o.address ?? '*'}:${o.port ?? 0}: ${e.message}`, { cause: e });
        if (gen === this.generation) h.onError(wrapped);
        throw wrapped;
      });
    this.listening.catch(() => {});
  }

  /** Resolves once the endpoint of the last {@link start} listens (rejects with the listen error). */
  whenListening(): Promise<void> {
    return this.listening;
  }

  /**
   * Opens a bundling scope (nestable, process-wide): sends to any peer until
   * the outermost {@link uncork} are bundled per peer and flushed by it.
   */
  cork(): void {
    bundler.enter();
  }

  /** Ends one {@link cork} scope; the outermost one flushes every bundled peer. */
  uncork(): void {
    bundler.leave();
  }

  /** Closes every session (no events) and, if owned, the endpoint's socket(s). */
  stop(): void {
    this.generation++;
    this.starting = false;
    for (const l of [...this.deferred]) l.close();
    for (const l of [...this.links]) l.close();
    if (this.owned) {
      this.ep = null;
      // Releases the lease: the last room on a shared endpoint closes it one
      // macrotask later, so the SCTP ABORT / DTLS close_notify the sessions
      // just queued leave first and players learn at once that the room is
      // gone instead of waiting for their ICE timeout.
      const lease = this.lease;
      this.lease = null;
      if (lease !== null) this.closing = lease.release();
    }
  }

  /** Resolves once the socket(s) closed by the last {@link stop} are released. */
  whenClosed(): Promise<void> {
    return this.closing;
  }

  createPeer(_id: number, offerSdp: string, ev: PeerLinkEvents): PeerLink {
    const ep = this.ep;
    if (ep === null) {
      if (!this.starting) throw new Error("peerBackend 'rtc' is not listening");
      // the socket is still binding (an offer within ms of the room's registration)
      return new DeferredRtcPeerLink(this, offerSdp, ev, this.deferred);
    }
    return this.attach(ep, offerSdp, ev);
  }

  /** Session for `offerSdp` on `ep`, answer delivered synchronously. Throws RtcSdpError on an unusable offer. */
  attach(ep: RtcEndpoint, offerSdp: string, ev: PeerLinkEvents): RtcPeerLink {
    const s = ep.createSession(offerSdp); // throws RtcSdpError on an unusable offer: nothing left behind
    const link = new RtcPeerLink(s, ev, this.links);
    this.links.add(link);
    ev.onLocalDescription(s.answerSdp);
    if (!link.closed) for (const c of s.localCandidates) ev.onLocalCandidate(c, s.mid);
    if (!link.closed) ev.onGatheringComplete();
    return link;
  }
}

/**
 * An offer taken while the endpoint was still binding (start() reports ready
 * at once so that signaling overlaps the bind): the session is created and
 * answered as soon as the endpoint listens, like node-datachannel answering
 * asynchronously. Listen failure or an unusable offer → `'failed'`.
 */
class DeferredRtcPeerLink implements PeerLink {
  private link: RtcPeerLink | null = null;
  private closed = false;
  private readonly candidates: string[] = [];
  private readonly owner: Set<DeferredRtcPeerLink>;

  constructor(backend: RtcPeerBackend, offerSdp: string, ev: PeerLinkEvents, owner: Set<DeferredRtcPeerLink>) {
    this.owner = owner;
    owner.add(this);
    const fail = (err: unknown) => {
      if (this.closed) return;
      this.closed = true;
      owner.delete(this);
      ev.onError(err instanceof Error ? err : new Error(String(err)));
      ev.onConnectionState('failed');
    };
    backend.whenListening().then(() => {
      if (this.closed) return;
      owner.delete(this);
      const ep = backend.endpoint;
      if (ep === null) return fail(new Error("peerBackend 'rtc' is not listening"));
      try {
        this.link = backend.attach(ep, offerSdp, ev);
      } catch (err) {
        return fail(err);
      }
      for (const c of this.candidates.splice(0)) this.link.addRemoteCandidate(c);
    }, fail);
  }

  addRemoteCandidate(candidate: string): void {
    if (this.link !== null) this.link.addRemoteCandidate(candidate);
    else if (!this.closed && this.candidates.length < 32) this.candidates.push(candidate);
  }

  send(index: number, data: Uint8Array): boolean {
    return this.link !== null && this.link.send(index, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.delete(this);
    this.link?.close();
  }
}

/** Close reasons that mean the connection never worked / was lost (→ `'failed'`). */
function isFailure(reason: string): boolean {
  return reason === 'timeout' || reason === 'handshake-timeout' || reason.startsWith('dtls-') || reason === 'sctp:timeout' || reason === 'sctp:init-timeout';
}

class RtcPeerLink implements PeerLink {
  private ev: PeerLinkEvents | null;
  private readonly s: RtcSession;
  private readonly owner: Set<RtcPeerLink>;
  closed = false;
  /** Corked for this event-loop iteration (registered in the bundler). */
  private corked = false;

  constructor(s: RtcSession, ev: PeerLinkEvents, owner: Set<RtcPeerLink>) {
    this.s = s;
    this.owner = owner;
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
    if (!this.corked && !this.closed) {
      this.corked = true;
      this.s.cork();
      bundler.add(this);
    }
    return this.s.send(index, data);
  }

  /** End of the iteration (or close): sends what was bundled. Never throws. */
  flushBundle(): void {
    if (!this.corked) return;
    this.corked = false;
    try {
      this.s.uncork();
    } catch (err) {
      this.ev?.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(): void {
    if (this.closed) return;
    this.flushBundle(); // queued messages (e.g. a kick) leave before the ABORT
    this.release();
    this.s.close();
  }

  private release(): void {
    this.closed = true;
    this.ev = null;
    this.owner.delete(this);
  }
}
