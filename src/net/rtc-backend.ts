/**
 * `peerBackend: 'rtc'`: player connections terminated by haxlite-rtc
 * (`src/rtc`, pure TypeScript ICE + DTLS 1.2 + SCTP) in this process,
 * every player on **one UDP port**, no native addon, no extra threads.
 *
 * ICE (src/rtc/ice-agent.ts, gather.ts): by default a full ICE agent in the
 * controlled role — host candidates from the interfaces (filtered by
 * `iceCandidatePolicy`) or the configured {@link RtcBackendOptions.publicAddresses},
 * server-reflexive candidates from the STUN servers (`iceServers`, default the
 * same as `ndc`), and our own connectivity checks towards the player's
 * candidates so that a home/cloud NAT in front of the host opens a pinhole:
 * it works behind NAT without configuration, like node-datachannel.
 * `iceLite: true` restores the original ICE-lite mode (only `publicAddresses`,
 * no checks: the server must be directly reachable).
 *
 * Everything protocol-related stays in {@link HostTransport} (admission
 * before any session exists, answer timing, challenge, flood, idle timeouts,
 * bans by conn/srflx IP, kicks). Differences from node-datachannel that the
 * transport sees:
 *
 * * the answer SDP carries every candidate known at once: `onLocalDescription`,
 *   the candidates and (when no STUN round is running: the srflx result is
 *   cached per endpoint for `gatherRefreshMs`) `onGatheringComplete` are all
 *   delivered inside `createPeer`, so the answer goes out without the 500 ms
 *   gathering wait; while a STUN round runs, the srflx candidates and
 *   `onGatheringComplete` follow asynchronously (≤ 1.5 s, like `ndc`);
 * * the three channels open together when the SCTP association comes up
 *   (one `onChannelOpen` per channel, in order 0, 1, 2);
 * * `prefiltered`: the endpoint applies `iceCandidatePolicy` itself (srflx
 *   candidates always carry `raddr 0.0.0.0 rport 0`); explicit
 *   `publicAddresses` are announced as given;
 * * the selected-pair address given with channel 0 is the source address of
 *   the browser's authenticated STUN checks (its NAT's public address);
 * * **bundling**: the first `send` to a peer in an event-loop iteration
 *   corks its SCTP association; corked peers are flushed together from one
 *   `setImmediate` (check phase of the same iteration, right after the poll
 *   phase: no timer, no added wait). All the messages a peer gets in that
 *   iteration — from every HostRoom wake-up / client message / action that
 *   ran in it (event on `ru`, heartbeat on `uu`, pong, CheckConsistency…,
 *   plus the SACK it is owed) — leave as one SCTP packet (RFC 9260 bundling,
 *   up to the MTU and the congestion window) → one DTLS record, one cipher
 *   operation, one datagram. Each message is still delivered separately to
 *   the data channel. Closing a link flushes first, so a kick message still
 *   precedes the ABORT;
 * * **frame batching** (opt-in, {@link RtcBackendOptions.sendBatchFrames}):
 *   messages on `ru` are held (the association stays corked) until the
 *   next boundary of the process-wide 60 Hz frame grid (every 1 or 2
 *   frames), see SendBatcher;
 * * received messages may be transient views (only valid during
 *   `onMessage`, see `transientDelivery` in src/rtc/sctp): the transport and
 *   the host consume them synchronously and copy what they keep.
 */
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { ClockEntry, hostClock } from '../host/clock.js';
import { TICKS_PER_MS } from '../protocol.js';
import type { RtcCertificate, RtcEndpoint, RtcEndpointStats, RtcSession, SharedEndpointLease } from '../rtc/index.js';
import { freezeSctpClock, thawSctpClock } from '../rtc/sctp/clock.js';
import { beginUdpBatch, endUdpBatch } from '../rtc/udp.js';
import { classifyAddress, type IceCandidatePolicy, type IceServerConfig } from './ice.js';
import { DEFAULT_ICE_SERVERS } from './constants.js';
import type { PeerBackend, PeerLink, PeerLinkEvents } from './peer-backend.js';

export interface RtcBackendOptions {
  /**
   * UDP port shared by every player (default 0 = ephemeral; set a fixed port
   * and open it in the firewall for production).
   */
  port?: number;
  /**
   * Bind address (default: the wildcard of each family in `publicAddresses`).
   * `'::'` is the IPv4 wildcard unless {@link ipv6} is on; another IPv6
   * literal needs {@link ipv6}.
   */
  address?: string;
  /**
   * Use IPv6 (default false): bind a `udp6` socket too when the machine has a
   * global IPv6 address, announce IPv6 candidates (interface, detected
   * ICE-lite and explicit `publicAddresses`, STUN srflx) and look up STUN
   * servers' AAAA records. Off: IPv4 only — IPv6 headers are 20 bytes
   * larger, ≈ +19 % egress for HaxBall's small datagrams, and browsers
   * prefer IPv6 pairs when both are offered.
   */
  ipv6?: boolean;
  /**
   * IP literals advertised to players as host candidates (instead of the
   * interface addresses). Full ICE: optional (server-reflexive candidates are
   * gathered anyway when `iceServers` apply); set it for a 1:1 NAT whose public
   * IP STUN cannot see, or to skip STUN (then `iceServers` defaults to none).
   * ICE-lite: the only addresses ever written in SDP; default every
   * non-internal interface address classified `public`, and the transport
   * refuses to start when there is none. IPv6 entries (given or detected)
   * are skipped unless {@link ipv6} is on.
   */
  publicAddresses?: readonly string[];
  /**
   * ICE-lite mode (the original haxlite-rtc behaviour): no gathering, no
   * connectivity checks, `a=ice-lite`. Default false (full ICE, works behind NAT).
   */
  iceLite?: boolean;
  /**
   * STUN servers for server-reflexive candidates. Default: `[]` when
   * `publicAddresses` is set, else the transport's `iceServers`
   * (default `stun:stun.l.google.com:19302`, as for `ndc`). TURN entries are
   * ignored (relay not implemented, see docs/10).
   */
  iceServers?: readonly IceServerConfig[];
  /**
   * Which interface addresses are announced and which remote address classes
   * may receive our checks (default: the transport's `iceCandidatePolicy`,
   * else `'public'`). Not applied to explicit `publicAddresses`.
   */
  iceCandidatePolicy?: IceCandidatePolicy;
  /** Re-query the STUN servers at a new session when the last result is older (default 60 000 ms). */
  gatherRefreshMs?: number;
  /** Advertised port when a 1:1 NAT maps a different one (default: the bound port). */
  publicPort?: number;
  /** DTLS certificate (default: {@link certificateFile}, else one ECDSA P-256 key per process, generated synchronously once). */
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
   * Frame batching of outgoing game events (default 0 = off: every message
   * leaves at the end of the event-loop iteration that sent it, as before).
   * 1 or 2: messages on channel 1 (`ru`, the client-event broadcasts: inputs,
   * chat, client-side actions) are held per player and leave together on
   * the next boundary of the process-wide 60 Hz frame grid (every `n`
   * frames, the grid the rooms wake on, so every room and player of the
   * process flushes on one timer wake-up), in one SCTP packet / DTLS record /
   * datagram per player up to the MTU. Any other message to that player
   * (`ro`: join snapshot, host events, kicks; `uu`: heartbeats, pongs) still
   * leaves in its own iteration and takes the held ones with it, so the
   * per-player send order is unchanged and the ping the client shows is not
   * skewed. Cost: other players' inputs arrive on average n × 8.3 ms later
   * (at most n × 16.7 ms); gain: far fewer datagrams, each carrying ≈ 85
   * bytes of IP/UDP/DTLS/SCTP overhead. Applies per room, also on a shared
   * endpoint.
   */
  sendBatchFrames?: 0 | 1 | 2;
  /**
   * Use an already-listening endpoint (several rooms on one UDP port). It is
   * not closed by this backend; the options above are then ignored.
   */
  endpoint?: RtcEndpoint;
}

/**
 * Public addresses of this machine's interfaces (non-internal, `public`
 * class: not RFC 1918/CGNAT/ULA/link-local/loopback). IPv4 only unless
 * `opts.ipv6`.
 */
export function detectPublicAddresses(opts: { ipv6?: boolean } = {}): string[] {
  const out: string[] = [];
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] ?? []) {
      if (a.internal) continue;
      const addr = a.address.split('%')[0]!;
      if (opts.ipv6 !== true && isIP(addr) !== 4) continue;
      if (classifyAddress(addr) === 'public' && out.indexOf(addr) < 0) out.push(addr);
    }
  }
  return out;
}

/** Resolves {@link RtcBackendOptions.publicAddresses} (explicit or detected) for ICE-lite. Throws when none. */
export function resolvePublicAddresses(o: RtcBackendOptions): string[] {
  if (o.publicAddresses !== undefined) {
    const list = [...o.publicAddresses];
    if (list.length === 0) throw new Error("peerBackend 'rtc': publicAddresses is empty");
    for (const a of list) {
      if (isIP(a) === 0) throw new Error(`peerBackend 'rtc': publicAddresses must be IP literals (got ${JSON.stringify(a)})`);
    }
    if (o.ipv6 === true) return list;
    const v4 = list.filter((a) => isIP(a) === 4);
    if (v4.length === 0) throw new Error("peerBackend 'rtc': publicAddresses has only IPv6 addresses (set rtc.ipv6: true to use them)");
    return v4;
  }
  const found = detectPublicAddresses({ ipv6: o.ipv6 === true });
  if (found.length === 0) {
    throw new Error(
      "peerBackend 'rtc' with iceLite needs a publicly reachable address: no interface has a public IP, so set " +
        "rtc.publicAddresses (e.g. ['203.0.113.7'], the public IP of a 1:1 NAT with the UDP port forwarded), " +
        (o.ipv6 === true ? '' : 'or rtc.ipv6: true if the public address is IPv6, ') +
        'or drop iceLite (full ICE works behind NAT)',
    );
  }
  return found;
}

/**
 * Per-iteration bundling of every RtcPeerLink in the process. A link corks
 * its session on its first send and registers here; everything registered
 * is flushed (uncorked) from one shared `setImmediate`, i.e. in the check
 * phase of the same event-loop iteration, right after the poll phase.
 *
 * Flushing once per iteration rather than at the end of each
 * {@link RtcPeerBackend.cork} scope (HostRoom wraps every wake-up, client
 * message and action in one) merges what several scopes of one iteration
 * send to the same peer into one SCTP packet: e.g. the event broadcasts of
 * every client input libuv delivered in one poll phase, or a frame's
 * heartbeat with the events processed right after it. On the bench (20
 * players) that is ≈ 23 % fewer datagrams out — and as many fewer SACK-only
 * datagrams back from the browsers (they acknowledge every second packet), each
 * of which costs a Buffer + rinfo allocation in dgram. The added delay is the
 * rest of that iteration's I/O processing (no timer, no wait: the poll phase
 * does not block while an immediate is pending), so no game latency.
 * Scopes still nest (cork/uncork are kept for the PeerBackend contract) but
 * do not flush by themselves; no allocation in steady state.
 *
 * On Bun the whole flush is also one UDP batch ({@link beginUdpBatch}): the
 * datagrams it produces are copied out of the endpoint's seal buffer and
 * leave per socket in one `sendMany` (`sendmmsg(2)` on Linux) instead of
 * one `sendto` each. Node has no `sendmmsg`: there it is a no-op.
 */
class SendBundler {
  /** Corked links (`n` used; slots are cleared, never shrunk: no allocation in steady state). */
  private list: (RtcPeerLink | null)[] = [];
  private n = 0;
  private depth = 0;
  private scheduled = false;
  private flushing = false;
  private readonly immediateFn = (): void => {
    this.scheduled = false;
    this.flush();
  };

  add(link: RtcPeerLink): void {
    this.list[this.n++] = link;
    // links corked while flushing are flushed by the same pass
    if (!this.scheduled && !this.flushing) {
      this.scheduled = true;
      setImmediate(this.immediateFn);
    }
  }

  enter(): void {
    this.depth++;
  }

  leave(): void {
    if (this.depth > 0) this.depth--;
  }

  /** {@link flushRtcBundles}. */
  flushNow(): void {
    if (!this.flushing) this.flush();
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    const l = this.list;
    freezeSctpClock(); // one clock read for every association flushed here
    beginUdpBatch();
    try {
      // a flush can deliver deferred input → host sends → new corks appended: same pass
      for (let i = 0; i < this.n; i++) {
        const link = l[i]!;
        l[i] = null;
        link.flushBundle();
      }
    } finally {
      for (let i = 0; i < this.n; i++) l[i] = null;
      this.n = 0;
      this.flushing = false;
      thawSctpClock();
      endUdpBatch();
    }
  }
}

const bundler = new SendBundler();

/**
 * Frame batching ({@link RtcBackendOptions.sendBatchFrames}): links holding
 * `ru` messages, released on the process-wide 60 Hz frame grid.
 *
 * A held link keeps its SCTP association corked across event-loop
 * iterations (the messages wait in the association's send queue, in order;
 * the SACK it owes the player waits too and rides along). At its due grid
 * boundary (the first one after the hold whose index is a multiple of the
 * link's batch frames) it is handed to the per-iteration {@link SendBundler},
 * so the release is one `setImmediate` pass (one clock read, one UDP batch)
 * right after the timer callback, together with any heartbeat a room sent
 * at that boundary. A send that may not be held promotes the link to the
 * bundler at once (it leaves in that iteration, held messages first).
 *
 * The timer is one {@link ClockEntry} in the rooms' {@link hostClock}: the
 * boundary is the same double the rooms compute, so it shares their
 * wake-ups; it is not armed while nothing is held, and nothing exists until
 * a backend enables batching. SCTP retransmission and delayed-SACK timers
 * still fire while held (they flush the association early).
 */
class SendBatcher {
  /** Held links (may contain stale entries: checked against `mode` / `holdDue`). */
  private list: (RtcPeerLink | null)[] = [];
  private n = 0;
  /** Grid index the clock entry is armed for (Infinity = none). */
  private armed = Infinity;
  /** Registered in {@link hostClock} only while something is held. */
  private readonly entry = new ClockEntry(() => this.onTick());

  /** Holds `link` (just corked) until the grid boundary due for `frames`. */
  hold(link: RtcPeerLink, frames: number): void {
    // next grid boundary strictly after now, rounded up to a multiple of `frames`
    let due = Math.floor(performance.now() * TICKS_PER_MS + 1e-6) + 1;
    if (frames > 1) {
      const m = due % frames;
      if (m !== 0) due += frames - m;
    }
    link.holdDue = due;
    this.list[this.n++] = link;
    if (due < this.armed) this.arm(due);
  }

  private arm(due: number): void {
    this.armed = due;
    const e = this.entry;
    if (due === Infinity) {
      hostClock.remove(e);
      return;
    }
    hostClock.add(e);
    // the same double the rooms compute for this boundary: one shared wake-up
    hostClock.set(e, due / TICKS_PER_MS);
  }

  /** Grid wake-up: releases the due links to the bundler, keeps the rest. */
  private onTick(): void {
    this.armed = Infinity;
    this.release(Math.floor(performance.now() * TICKS_PER_MS + 1e-6));
  }

  /** Releases every held link due at or before grid index `g` (Infinity: all). */
  release(g: number): void {
    const l = this.list;
    let k = 0;
    let next = Infinity;
    for (let i = 0; i < this.n; i++) {
      const link = l[i]!;
      l[i] = null;
      if (link.mode !== LINK_HELD) continue; // promoted / flushed / closed since: stale entry
      if (link.holdDue <= g) {
        link.mode = LINK_BUNDLED;
        bundler.add(link);
      } else {
        l[k++] = link;
        if (link.holdDue < next) next = link.holdDue;
      }
    }
    this.n = k;
    if (next !== this.armed) this.arm(next);
  }
}

/** Created by the first backend with batching on: no cost at all otherwise. */
let batcher: SendBatcher | null = null;

/** RtcPeerLink send states: nothing pending. */
const LINK_IDLE = 0;
/** Corked, held by the {@link SendBatcher} until a frame boundary. */
const LINK_HELD = 1;
/** Corked, registered in the {@link SendBundler} for this iteration. */
const LINK_BUNDLED = 2;

/** The only channel whose messages frame batching holds (`ru`, see {@link RtcBackendOptions.sendBatchFrames}). */
const BATCHED_CHANNEL = 1;

/**
 * Flushes every bundled peer now instead of at the end of the iteration.
 * For synchronous harnesses (simulated time, benches) only.
 */
export function flushRtcBundles(): void {
  batcher?.release(Infinity);
  bundler.flushNow();
}

/** Fallback delay after start() before the endpoint is brought up without an offer / whenListening() call. */
const LISTEN_DELAY_MS = 50;

/** {@link PeerBackend} over one haxlite-rtc {@link RtcEndpoint} (all peers on one UDP port). */
export class RtcPeerBackend implements PeerBackend {
  readonly kind = 'rtc';
  /** Only the configured public addresses are ever announced (no host policy filtering). */
  readonly prefiltered = true;
  private ep: RtcEndpoint | null = null;
  private readonly owned: boolean;
  private readonly opts: RtcBackendOptions;
  /** Explicit (or, for ICE-lite, detected) public addresses; undefined: full ICE gathers. */
  private readonly publicAddresses: string[] | undefined;
  private readonly iceServers: readonly IceServerConfig[];
  private readonly policy: IceCandidatePolicy;
  /** start() generation: a listen that completes after stop() is discarded. */
  private generation = 0;
  private readonly links = new Set<RtcPeerLink>();
  private closing: Promise<void> = Promise.resolve();
  /** Lease on the endpoint while owned and started. */
  private lease: SharedEndpointLease | null = null;
  /** Settles when the endpoint of the current start() listens (rejects when it cannot); null until it begins. */
  private listening: Promise<void> | null = null;
  private listenTimer: NodeJS.Timeout | null = null;
  private handlers: { onError(err: Error): void } | null = null;
  /** Between start() and the endpoint listening (or failing to). */
  private starting = false;
  /** Offers accepted while {@link starting}, answered once the endpoint listens. */
  private readonly deferred = new Set<DeferredRtcPeerLink>();
  /** {@link RtcBackendOptions.sendBatchFrames} (0 = off). */
  private readonly batchFrames: number;

  /**
   * @param defaults the transport's `iceServers` / `iceCandidatePolicy`
   *   (used when `opts` does not set its own).
   */
  constructor(opts: RtcBackendOptions = {}, defaults: { iceServers?: readonly IceServerConfig[]; iceCandidatePolicy?: IceCandidatePolicy } = {}) {
    this.opts = opts;
    const bf = opts.sendBatchFrames ?? 0;
    if (bf !== 0 && bf !== 1 && bf !== 2) throw new Error(`peerBackend 'rtc': sendBatchFrames must be 0, 1 or 2 (got ${String(bf)})`);
    this.batchFrames = bf;
    if (bf > 0 && batcher === null) batcher = new SendBatcher();
    this.owned = opts.endpoint === undefined;
    this.policy = opts.iceCandidatePolicy ?? defaults.iceCandidatePolicy ?? 'public';
    if (opts.endpoint !== undefined) {
      this.ep = opts.endpoint;
      this.publicAddresses = [];
      this.iceServers = [];
    } else {
      // fail fast (synchronously: HostTransport/HBInit construction) on bad / missing (lite) public addresses
      this.publicAddresses = opts.iceLite === true || opts.publicAddresses !== undefined ? resolvePublicAddresses(opts) : undefined;
      this.iceServers =
        opts.iceLite === true ? [] : (opts.iceServers ?? (opts.publicAddresses !== undefined ? [] : (defaults.iceServers ?? DEFAULT_ICE_SERVERS)));
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
    if (!this.owned || this.ep !== null || this.lease !== null || this.starting) {
      h.onReady();
      return;
    }
    // Like 'ndc' (whose native library loads at the first peer), the room is
    // announced at once and the endpoint comes up lazily: the rtc modules, the
    // UDP socket and the certificate are set up on the first of (a) an offer
    // (answered as soon as it listens, see DeferredRtcPeerLink), (b) a
    // whenListening() call (HBInit, at the room link) or (c) LISTEN_DELAY_MS
    // after start — so none of it delays the room link.
    this.starting = true;
    this.handlers = h;
    this.listening = null;
    const t = setTimeout(() => this.beginListen(gen), LISTEN_DELAY_MS);
    t.unref?.();
    this.listenTimer = t;
    h.onReady();
  }

  private beginListen(gen: number): Promise<void> {
    if (this.listening !== null) return this.listening;
    if (this.listenTimer !== null) clearTimeout(this.listenTimer);
    this.listenTimer = null;
    const h = this.handlers!;
    const o = this.opts;
    const epOpts = {
      port: o.port ?? 0,
      ...(this.publicAddresses !== undefined ? { publicAddresses: this.publicAddresses } : null),
      ...(o.iceLite === true ? { iceLite: true } : null),
      ...(this.iceServers.length > 0 ? { iceServers: this.iceServers } : null),
      ...(this.policy !== 'public' ? { candidatePolicy: this.policy } : null),
      ...(o.gatherRefreshMs !== undefined ? { gatherRefreshMs: o.gatherRefreshMs } : null),
      ...(o.address !== undefined ? { address: o.address } : null),
      ...(o.ipv6 === true ? { ipv6: true } : null),
      ...(o.publicPort !== undefined ? { publicPort: o.publicPort } : null),
      ...(o.certificate !== undefined ? { certificate: o.certificate } : null),
      ...(o.certificateFile !== undefined ? { certificateFile: o.certificateFile } : null),
      ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : null),
      ...(o.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: o.handshakeTimeoutMs } : null),
      ...(o.maxSessions !== undefined ? { maxSessions: o.maxSessions } : null),
      ...(o.cipherSuites !== undefined ? { cipherSuites: o.cipherSuites } : null),
    };
    const p = import('../rtc/index.js')
      .then((rtc) => {
        if (gen !== this.generation) throw new Error('stopped');
        const lease: SharedEndpointLease =
          o.shared === false
            ? (() => {
                const ready = rtc.RtcEndpoint.listen(epOpts);
                return { ready, release: () => ready.then((ep) => new Promise<void>((r) => setImmediate(r)).then(() => ep.close()), () => {}) };
              })()
            : rtc.acquireSharedEndpoint(epOpts);
        this.lease = lease;
        return lease.ready.then((ep) => {
          if (gen !== this.generation) throw new Error('stopped');
          this.ep = ep;
          this.starting = false;
        });
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (gen !== this.generation) throw e;
        this.starting = false;
        const wrapped = new Error(`peerBackend 'rtc': cannot listen on UDP ${o.address ?? '*'}:${o.port ?? 0}: ${e.message}`, { cause: e });
        h.onError(wrapped);
        throw wrapped;
      });
    p.catch(() => {});
    this.listening = p;
    return p;
  }

  /**
   * Brings the endpoint up now if it is not yet (see {@link start}) and
   * resolves once it listens; rejects with the listen error (or when the
   * backend was stopped meanwhile).
   */
  whenListening(): Promise<void> {
    if (this.ep !== null && this.listening === null) return Promise.resolve();
    if (this.starting) return this.beginListen(this.generation);
    return this.listening ?? Promise.reject(new Error("peerBackend 'rtc' is not started"));
  }

  /**
   * Opens a bundling scope (nestable, process-wide). Sends are bundled per
   * peer for the whole event-loop iteration anyway (see SendBundler): scopes
   * are accepted for the PeerBackend contract and do not flush by themselves.
   */
  cork(): void {
    bundler.enter();
  }

  /** Ends one {@link cork} scope (the flush happens once per iteration, see SendBundler). */
  uncork(): void {
    bundler.leave();
  }

  /** Closes every session (no events) and, if owned, the endpoint's socket(s). */
  stop(): void {
    this.generation++;
    this.starting = false;
    if (this.listenTimer !== null) clearTimeout(this.listenTimer);
    this.listenTimer = null;
    this.listening = null;
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
    const link = new RtcPeerLink(s, ev, this.links, this.batchFrames);
    this.links.add(link);
    ev.onLocalDescription(s.answerSdp);
    if (!link.closed) for (const c of s.localCandidates) ev.onLocalCandidate(c, s.mid);
    // srflx candidates of a running STUN round follow through the session callbacks (RtcPeerLink)
    if (!link.closed && s.gatheringComplete) ev.onGatheringComplete();
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
  /** LINK_IDLE, LINK_HELD (corked, in the batcher) or LINK_BUNDLED (corked, in the bundler). */
  mode = LINK_IDLE;
  /** Grid index the held messages are due at (LINK_HELD). */
  holdDue = 0;
  /** Frame batching of `ru` (0 = off). */
  private readonly batchFrames: number;

  constructor(s: RtcSession, ev: PeerLinkEvents, owner: Set<RtcPeerLink>, batchFrames = 0) {
    this.s = s;
    this.batchFrames = batchFrames;
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
    // trickle: candidates found by a STUN round still running when the answer was built
    s.onLocalCandidate = (c) => this.ev?.onLocalCandidate(c, s.mid);
    s.onGatheringComplete = () => this.ev?.onGatheringComplete();
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
    const mode = this.mode;
    if (mode !== LINK_BUNDLED && !this.closed) {
      if (index === BATCHED_CHANNEL && this.batchFrames > 0) {
        if (mode === LINK_IDLE) {
          this.mode = LINK_HELD;
          this.s.cork();
          batcher!.hold(this, this.batchFrames);
        }
      } else {
        // leaves this iteration; held messages (queued before it) go first, in the same packet
        if (mode === LINK_IDLE) this.s.cork();
        this.mode = LINK_BUNDLED;
        bundler.add(this);
      }
    }
    return this.s.send(index, data);
  }

  /** End of the iteration / frame boundary (or close): sends what was bundled or held. Never throws. */
  flushBundle(): void {
    if (this.mode === LINK_IDLE) return;
    this.mode = LINK_IDLE;
    try {
      this.s.uncork();
    } catch (err) {
      try {
        this.ev?.onError(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* never propagate: the bundler must reach every link */
      }
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
