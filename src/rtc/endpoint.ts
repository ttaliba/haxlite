/**
 * The UDP endpoint: one socket per address family shared by every session,
 * demultiplexed per RFC 7983 (first byte 0–3 STUN, 20–63 DTLS) — STUN
 * requests by the USERNAME's ufrag, STUN responses by transaction id (our
 * connectivity/consent checks and STUN gathering, ice-agent.ts / gather.ts),
 * DTLS by the remote transport address once ICE has validated it (full
 * ICE: our check to it succeeded; ICE-lite: an authenticated request came
 * from it — see session.ts).
 *
 * TURN (turn.ts): with a `turn:` server in `iceServers` the endpoint holds
 * one allocation on its IPv4 socket. Datagrams from the TURN server's
 * address go to the relay, which unwraps ChannelData / Data indications and
 * feeds the peer's datagram back into the same demux with the relay as the
 * receiving "socket" (its validated addresses live in their own map). The
 * only cost for other datagrams is one port comparison.
 */
import dgram, { type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { RtcCertificate } from './cert.js';
import { buildAnswer, parseOffer } from './sdp.js';
import { RtcSessionImpl, type SessionHost, type ValidatedAddress } from './session.js';
import { StunMessage, StunType, parseStun } from './stun.js';
import { SctpAssociation } from './sctp/index.js';
import { DtlsServer } from './dtls/server.js';
import { resolveSuites } from './dtls/crypto.js';
import type { RtcSession, SctpFactory } from './types.js';
import { Gatherer, classifyIp, hasGlobalIpv6, stunServers, type AddressClass, type CandidatePolicy, type IceServerInput } from './gather.js';
import { IceScheduler, type BoundSocket, type IceStats, type RelayIo } from './ice-agent.js';
import { UdpIo, literalLookup, type PacketIo } from './udp.js';
import { TurnRelay, turnServers, type TurnStats, type TurnServerSpec } from './turn.js';
import { sameIp } from './gather.js';

/**
 * Throws a `RangeError` for a numeric option that would silently disable a
 * limit or a timer: `NaN` passes no comparison, `Infinity` never expires, a
 * port outside 0–65535 cannot be bound or announced. Absent options keep their defaults.
 */
function checkEndpointOptions(o: RtcEndpointOptions): void {
  const int = (name: string, v: number | undefined, min: number, max: number, unbounded = false): void => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !(v >= min) || (v === Infinity ? !unbounded : !Number.isInteger(v) || v > max)) {
      throw new RangeError(`RtcEndpoint: ${name} must be an integer in ${min}..${max}${unbounded ? ' or Infinity' : ''} (got ${String(v)})`);
    }
  };
  const ms = (name: string, v: number | undefined, unbounded: boolean): void => {
    if (v === undefined) return;
    if (typeof v !== 'number' || (unbounded ? !(v >= 0) : !(v > 0 && v < Infinity))) {
      throw new RangeError(`RtcEndpoint: ${name} must be ${unbounded ? 'a number of ms >= 0 or Infinity' : 'a finite number of ms > 0'} (got ${String(v)})`);
    }
  };
  int('port', o.port, 0, 65535);
  int('publicPort', o.publicPort, 1, 65535);
  int('maxSessions', o.maxSessions, 1, Number.MAX_SAFE_INTEGER);
  int('maxTurnAllocations', o.maxTurnAllocations, 1, Number.MAX_SAFE_INTEGER);
  int('turnPeersPerAllocation', o.turnPeersPerAllocation, 1, Number.MAX_SAFE_INTEGER, true);
  ms('idleTimeoutMs', o.idleTimeoutMs, false);
  ms('handshakeTimeoutMs', o.handshakeTimeoutMs, false);
  ms('gatherRefreshMs', o.gatherRefreshMs, true);
}

/** A socket bound by {@link RtcEndpoint.listen}, before the endpoint wraps it. */
interface RawBound {
  sock: Socket;
  family: 4 | 6;
  bindAddress: string;
}

export interface RtcEndpointOptions {
  /** UDP port, an integer 0–65535 (default 0 = ephemeral). With two families both sockets use the same port. */
  port?: number;
  /**
   * Bind address (default: the wildcard of each family present in
   * {@link publicAddresses}). `'::'` binds both families when {@link ipv6}
   * is on, only IPv4 (`0.0.0.0`) otherwise; any other IPv6 literal needs
   * {@link ipv6}.
   */
  address?: string;
  /**
   * IP literals advertised as host candidates. ICE-lite: required, the only
   * addresses ever written in SDP. Full ICE (default): optional — when set
   * they replace the interface addresses as host candidates; server-reflexive
   * candidates from {@link iceServers} are added either way. IPv6 entries
   * are skipped unless {@link ipv6} is on (an all-IPv6 list is then an error).
   */
  publicAddresses?: string[];
  /**
   * Use IPv6 (default false): bind a `udp6` socket next to the IPv4 one when
   * the machine has a global IPv6 address (or for IPv6 {@link publicAddresses}
   * / {@link address}), announce IPv6 host and server-reflexive candidates
   * and resolve STUN servers over both families.
   *
   * Off by default for bandwidth: an IPv6 header is 20 bytes larger than an
   * IPv4 one, ≈ +19 % egress for HaxBall's small datagrams, and browsers
   * prefer IPv6 pairs when both are offered. With it off the endpoint is
   * IPv4-only: no `udp6` socket, no IPv6 candidates, no AAAA lookups.
   */
  ipv6?: boolean;
  /**
   * ICE-lite (the original behaviour): `a=ice-lite`, only host candidates
   * from {@link publicAddresses}, no connectivity checks, no gathering.
   * Default false: full ICE agent in the controlled role (ice-agent.ts).
   */
  iceLite?: boolean;
  /**
   * STUN and TURN servers (URL strings like `stun:stun.l.google.com:19302`
   * or `turn:user:pass@host:3478`, node-datachannel or `RTCIceServer`
   * objects). Default none. STUN servers give server-reflexive candidates;
   * the first reachable UDP TURN server (`turn:…`, `?transport=udp`; `turns:`
   * and TCP are skipped) gives a relay candidate (turn.ts). Replace them at
   * runtime with {@link RtcEndpoint.setIceServers} (short-lived credentials).
   */
  iceServers?: readonly IceServerInput[];
  /**
   * `'all'` (default): host, server-reflexive and relay candidates.
   * `'relay'`: only the TURN relay candidate is announced (our IP is never in
   * the SDP), checks, consent and DTLS only go through the relay, and nothing
   * that reaches the socket directly from a peer is answered. Needs a `turn:`
   * server; sessions wait for the allocation, and fail (`'turn-unavailable'`)
   * when there is none.
   */
  iceTransportPolicy?: 'all' | 'relay';
  /**
   * TURN: distinct peer transport addresses (ip:port) one allocation is used for before new sessions
   * go to another allocation (default 8). Some servers relay for only a handful of distinct peer
   * addresses per allocation over its whole life (Cloudflare: ~10); a client uses one or two. The
   * endpoint keeps a pool of allocations (the first from its own socket, the others from sockets of
   * their own), gives each new session the relay candidate of one with room left, keeps a spare one
   * ready, and deletes exhausted ones once their sessions are gone. An integer >= 1 (values below
   * 2 count as 2) or `Infinity`.
   */
  turnPeersPerAllocation?: number;
  /** TURN: most allocations at once, a positive integer (default 64). */
  maxTurnAllocations?: number;
  /**
   * Which interface addresses become host candidates, and which remote
   * address classes may receive our checks (default `'public'`; see
   * `CandidatePolicy` in gather.ts). Not applied to {@link publicAddresses}.
   */
  candidatePolicy?: CandidatePolicy;
  /**
   * Re-query the STUN servers at a new session when the last result is older than this (default
   * 60 000 ms; >= 0, `Infinity`: never).
   */
  gatherRefreshMs?: number;
  /** Advertised port (1–65535) when a 1:1 NAT maps a different one (default: the bound port). */
  publicPort?: number;
  /** DTLS identity (default: {@link certificateFile} if set, else the process-wide {@link RtcCertificate.processDefault}). */
  certificate?: RtcCertificate;
  /** Load/persist the DTLS identity in this PEM file ({@link RtcCertificate.loadOrCreate}). */
  certificateFile?: string;
  /** Close an open session after this long without ICE consent (ms, finite, > 0; default 30 000). */
  idleTimeoutMs?: number;
  /** Close a session not open this long after createSession (ms, finite, > 0; default 20 000). */
  handshakeTimeoutMs?: number;
  /** Most sessions at once, a positive integer (default 10 000); `createSession` throws beyond it. */
  maxSessions?: number;
  /** Data-channel layer factory (default: `SctpAssociation` from ./sctp). */
  dataLayer?: SctpFactory;
  /** Max datagram we emit for DTLS handshake flights (default 1200). */
  mtu?: number;
  /** Our a=max-message-size (default 262144). */
  maxMessageSize?: number;
  /** Socket buffer sizes (best effort, default 4 MiB). */
  socketBufferSize?: number;
  /**
   * DTLS cipher suites in server preference order, as IANA names, ids or
   * `'chacha20'` / `'aes128gcm'` / `'aes256gcm'`. Default (`defaultSuites` in
   * dtls/crypto.ts), on Node and Bun: ChaCha20-Poly1305 first (allocation-free
   * JS AEAD; on Bun too, end to end, despite AES-GCM's cheaper micro-benchmark),
   * then AES-128-GCM, AES-256-GCM. A browser without the first suite gets the
   * next one.
   */
  cipherSuites?: readonly (number | string)[];
  /**
   * DTLS cookie exchange (HelloVerifyRequest, RFC 6347 §4.2.1): the server
   * answers a ClientHello with a stateless cookie and only sends its
   * ~1 KB flight 4 to a source that echoes it, so a spoofed ClientHello can
   * never make it send that flight to a victim. Costs one round trip per join.
   *
   * Default: off with full ICE — DTLS is only accepted from, and flights only
   * sent to, addresses that answered our own connectivity check (proven
   * reachable). On with {@link iceLite}: there we send no checks and the
   * addresses DTLS comes from are only vouched for by Binding requests whose
   * key (our ICE password) every joining client knows.
   */
  helloVerify?: boolean;
}

export interface RtcEndpointStats {
  sessions: number;
  open: number;
  packetsIn: number;
  packetsOut: number;
  bytesIn: number;
  bytesOut: number;
  /** Binding requests answered with success. */
  stunAuthenticated: number;
  /** STUN dropped: malformed, unknown ufrag, bad USERNAME/MESSAGE-INTEGRITY/FINGERPRINT, role. */
  stunRejected: number;
  /** DTLS-looking datagrams from addresses no session validated (and not held for a check in progress). */
  dtlsUnknownSource: number;
  /** Full ICE: DTLS datagrams held until our check to their (authenticated, not yet validated) source succeeded. */
  dtlsHeld: number;
  /** First byte outside the STUN/DTLS ranges. */
  unknownPackets: number;
  handshakesCompleted: number;
  handshakesFailed: number;
  /** DTLS records dropped by sessions (replayed / not authenticated), live + closed. */
  dtlsReplayed: number;
  dtlsBadRecords: number;
  /** STUN responses to our own requests (checks, consent, gathering). */
  stunResponses: number;
  /** Full-ICE counters (all zero with ICE-lite). */
  ice: IceStats;
  /** Our addresses as seen by the STUN servers in the last gathering round (`ip:port`). */
  reflexive: string[];
  /** Relay-only sessions closed because no TURN allocation could be made. */
  relayUnavailable: number;
  /** Datagrams from peers dropped because they did not come through the relay (relay-only). */
  directDropped: number;
  /** The TURN allocation (null: no TURN server configured). */
  turn: TurnStats | null;
  /**
   * Received datagrams whose processing threw (a bug in a protocol layer or a data-layer callback):
   * dropped, counted and logged (at most once every 10 s) instead of ending the process.
   */
  packetErrors: number;
}

const ICE_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomIceString(n: number): string {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ICE_ALNUM[b[i]! % 62]; // 256 % 62 bias is irrelevant here
  return s;
}

/** Internal errors (a datagram or a timer whose processing threw) are logged at most this often. */
const ERROR_LOG_INTERVAL_MS = 10_000;
/** A session whose datagrams throw this many times in a row is closed ('error'): its state is suspect. */
const SESSION_PACKET_ERRORS = 5;

/** Largest datagram whose exact-length scratch view is cached (≥ the 1200-byte SCTP MTU + DTLS overhead). */
const VIEW_CACHE_MAX = 1536;

/** Default data-channel layer: R2's SCTP association (src/rtc/sctp). */
const defaultDataLayer: SctpFactory = (o) => new SctpAssociation(o);


/** STUN server name → its IPv4 addresses (used when the endpoint has no IPv6 socket: `ipv6` off or no global IPv6). */
function ipv4Lookup(host: string): Promise<{ address: string; family: number }[]> {
  const fam = isIP(host);
  if (fam !== 0) return Promise.resolve(fam === 4 ? [{ address: host, family: 4 }] : []);
  return new Promise((resolve) => {
    dnsLookup(host, { all: true, family: 4 }, (err, addrs) => resolve(err ? [] : addrs.slice(0, 4)));
  });
}

function bindSocket(type: 'udp4' | 'udp6', address: string, port: number, bufSize: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type, ipv6Only: type === 'udp6', reuseAddr: false, lookup: literalLookup as never });
    const onError = (err: Error) => {
      sock.close();
      reject(err);
    };
    sock.once('error', onError);
    sock.bind({ address, port, exclusive: true }, () => {
      sock.off('error', onError);
      try {
        sock.setRecvBufferSize(bufSize);
        sock.setSendBufferSize(bufSize);
      } catch {
        /* capped by the kernel: fine */
      }
      resolve(sock);
    });
  });
}

export class RtcEndpoint {
  readonly certificate: RtcCertificate;
  /** Bound port. */
  readonly port: number;
  private readonly sockets: Socket[];
  private readonly ios: UdpIo[];
  private readonly bound: BoundSocket[];
  private readonly gatherer: Gatherer;
  private readonly ice: IceScheduler;
  private readonly iceLite: boolean;
  private readonly byUfrag = new Map<string, RtcSessionImpl>();
  /** remote address → remote port → validated address (DTLS demux). */
  private readonly byAddress = new Map<string, Map<number, ValidatedAddress>>();
  /** The first TURN allocation, made from the endpoint's IPv4 socket (null without a TURN server or with ICE-lite). */
  private readonly relay: TurnRelay | null;
  /** Every TURN allocation ({@link relay} first; the others from sockets of their own). Shared with the ICE scheduler. */
  private readonly pool: TurnRelay[] = [];
  /** The allocation whose relay candidate new sessions get (one element; the gatherer's relay list). */
  private readonly current: TurnRelay[] = [];
  /** Per allocation: DTLS demux of the addresses validated through it, live sessions announcing it, its own socket. */
  private readonly relayMaps = new Map<TurnRelay, Map<string, Map<number, ValidatedAddress>>>();
  private readonly relaySessions = new Map<TurnRelay, Set<RtcSessionImpl>>();
  private readonly relaySockets = new Map<TurnRelay, Socket>();
  private readonly sessionRelays = new Map<RtcSessionImpl, TurnRelay[]>();
  private turnSpecs: TurnServerSpec[] = [];
  private spawning = false;
  private readonly turnBudget: number;
  private readonly maxTurn: number;
  private readonly turnBind: string;
  private readonly makeRelay: (io: PacketIo, shared: boolean) => TurnRelay;
  /** The socket {@link relay} allocates from. */
  private readonly turnIo: PacketIo;
  /** `iceTransportPolicy: 'relay'`. */
  readonly relayOnly: boolean;
  /**
   * Full ICE: `address|port` of authenticated Binding requests not validated
   * yet → session whose triggered check is on its way (DTLS from there is
   * held for it instead of dropped). Bounded per session; dropped with it.
   */
  private readonly holds = new Map<string, RtcSessionImpl>();
  private readonly stunScratch = new StunMessage();
  /** Shared seal buffer for outgoing records (replaced if the kernel ever queues a send that still references it). */
  private sendScratch: Buffer = Buffer.allocUnsafeSlow(2048);
  /**
   * Exact-length views of {@link sendScratch} by datagram length (≤ {@link VIEW_CACHE_MAX}):
   * dgram would otherwise build a new view for every offset/length send.
   */
  private sendViews: (Buffer | undefined)[] = [];
  private readonly host: SessionHost;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly idleTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly counters = {
    packetsIn: 0,
    packetsOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    stunAuthenticated: 0,
    stunRejected: 0,
    dtlsUnknownSource: 0,
    dtlsHeld: 0,
    unknownPackets: 0,
    handshakesCompleted: 0,
    handshakesFailed: 0,
    dtlsReplayed: 0,
    dtlsBadRecords: 0,
    stunResponses: 0,
    relayUnavailable: 0,
    directDropped: 0,
    packetErrors: 0,
  };
  /** When an internal error was last logged (see {@link internalError}). */
  private errorLoggedAt = -ERROR_LOG_INTERVAL_MS;

  private constructor(opts: RtcEndpointOptions, raw: RawBound[], port: number, certificate: RtcCertificate, dataLayer: SctpFactory) {
    this.sockets = raw.map((b) => b.sock);
    const onError = (err: Error) => {
      // ICMP errors etc.: never fatal for a shared UDP socket
      console.error('[haxlite/rtc] socket error:', err.message);
    };
    this.ios = this.sockets.map((sock) => {
      const io: UdpIo = new UdpIo(sock, (msg, address, port) => this.onPacket(io, msg, address, port), onError);
      return io;
    });
    const bound: BoundSocket[] = raw.map((b, i) => ({ sock: this.ios[i]!, family: b.family, bindAddress: b.bindAddress }));
    this.bound = bound;
    this.port = port;
    this.certificate = certificate;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 20_000;
    this.maxSessions = opts.maxSessions ?? 10_000;
    this.iceLite = opts.iceLite === true;
    const counters = this.counters;
    const policy: CandidatePolicy = opts.candidatePolicy ?? 'public';
    // STUN requests we originate (checks, consent, gathering): rare, outside the data path
    const rawSend = (sock: UdpIo, buf: Buffer, address: string, port: number) => {
      counters.packetsOut++;
      counters.bytesOut += buf.length;
      if (this.closed) return;
      try {
        sock.send(buf, port, address); // never a shared scratch: a queued send may keep `buf`
      } catch {
        /* socket closed */
      }
    };
    const now = () => Date.now();
    const ownClasses = new Set<AddressClass>();
    for (const a of opts.publicAddresses ?? []) ownClasses.add(classifyIp(a));
    for (const b of bound) if (b.bindAddress !== '0.0.0.0' && b.bindAddress !== '::') ownClasses.add(classifyIp(b.bindAddress));
    const turn = this.iceLite ? [] : turnServers(opts.iceServers);
    this.relayOnly = opts.iceTransportPolicy === 'relay';
    // the first allocation from the IPv4 socket (relayed addresses are IPv4); more from sockets of their own
    const turnSock = bound.find((b) => b.family === 4) ?? bound[0]!;
    this.turnSpecs = turn;
    this.turnBudget = Math.max(2, opts.turnPeersPerAllocation ?? 8);
    this.maxTurn = Math.max(1, opts.maxTurnAllocations ?? 64);
    this.turnBind = turnSock.family === 4 ? turnSock.bindAddress : '0.0.0.0';
    this.makeRelay = (io, shared) => {
      const relay = new TurnRelay(
        {
          io,
          family: 4,
          now,
          reportMapped: shared,
          deliver: (r, msg, address, port) => this.onRelayPacket(r, msg, address, port),
          onChange: (r) => this.onRelayChange(r),
          countOut: (n) => {
            counters.packetsOut++;
            counters.bytesOut += n;
          },
        },
        this.turnSpecs,
      );
      this.pool.push(relay);
      this.relayMaps.set(relay, new Map());
      this.relaySessions.set(relay, new Set());
      return relay;
    };
    this.relay = turn.length === 0 ? null : this.makeRelay(turnSock.sock, true);
    if (this.relay !== null) this.current.push(this.relay);
    this.turnIo = turnSock.sock;
    this.ice = new IceScheduler({
      send: rawSend,
      now,
      sockets: bound,
      policy,
      ownClasses: [...ownClasses],
      ...(this.relay !== null ? { relays: this.pool } : null),
      ...(this.relayOnly ? { relayOnly: true } : null),
    });
    this.gatherer = new Gatherer(
      { sockets: bound, send: rawSend, now, register: (k, h) => this.ice.register(k, h), unregister: (k) => this.ice.unregister(k) },
      {
        ...(opts.publicAddresses !== undefined ? { publicAddresses: opts.publicAddresses } : null),
        ...(opts.publicPort !== undefined ? { publicPort: opts.publicPort } : null),
        port,
        stunServers: this.iceLite || this.relayOnly ? [] : stunServers(opts.iceServers),
        ...(this.relay !== null ? { relays: this.current } : null),
        ...(this.relayOnly ? { relayOnly: true } : null),
        policy,
        ...(opts.gatherRefreshMs !== undefined ? { refreshMs: opts.gatherRefreshMs } : null),
        // no udp6 socket: STUN servers are only resolved to IPv4 (no AAAA lookups)
        ...(bound.some((b) => b.family === 6) ? null : { lookup: ipv4Lookup }),
      },
    );
    this.host = {
      certificate,
      dataLayer,
      mtu: opts.mtu ?? 1200,
      maxMessageSize: opts.maxMessageSize ?? 262144,
      sctpPort: 5000,
      suites: opts.cipherSuites !== undefined ? resolveSuites(opts.cipherSuites) : undefined,
      sendTo: (dest, buf, length = buf.length) => {
        counters.packetsOut++;
        counters.bytesOut += length;
        if (this.closed) return;
        const scratch = buf === this.sendScratch;
        let out = buf;
        if (length !== buf.length) {
          if (scratch && length <= VIEW_CACHE_MAX) out = this.sendViews[length] ??= buf.subarray(0, length);
          else out = buf.subarray(0, length);
        }
        let sent: boolean;
        try {
          sent = dest.sock.send(out, dest.port, dest.address);
        } catch {
          /* socket closed */
          return;
        }
        // EAGAIN: libuv queued the datagram and still references `buf`: never reuse it
        if (scratch && !sent) this.replaceScratch(buf.length);
      },
      sendBuffer: (size) => {
        if (this.sendScratch.length < size) this.replaceScratch(Math.min(Math.max(size, 2 * this.sendScratch.length), DtlsServer.MAX_RECORD));
        return this.sendScratch;
      },
      bindAddress: (v) => this.bindAddress(v),
      unbindAddress: (v) => this.unbindAddress(v),
      unregister: (s) => this.unregister(s),
      countHandshake: (ok) => {
        if (ok) counters.handshakesCompleted++;
        else counters.handshakesFailed++;
      },
      now,
      ice: this.iceLite ? null : this.ice,
      relayOnly: this.relayOnly,
      countRelayUnavailable: () => counters.relayUnavailable++,
      ...(this.relay !== null
        ? {
            currentRelay: () => this.current[0] ?? null,
            assignRelay: (s: RtcSessionImpl, r: RelayIo) => this.assignRelay(s, r as TurnRelay),
          }
        : null),
      helloVerify: opts.helloVerify ?? this.iceLite,
      holdAddress: (s, address, port) => {
        const key = `${address}|${port}`;
        const prev = this.holds.get(key);
        if (prev === s) return;
        this.holds.set(key, s); // the latest authenticated session (a rejoin from the same port)
        s.holdKeys.push(key);
      },
      unholdAddress: (s, address, port) => {
        const key = `${address}|${port}`;
        const i = s.holdKeys.indexOf(key);
        if (i < 0) return;
        s.holdKeys.splice(i, 1);
        if (this.holds.get(key) === s) this.holds.delete(key);
      },
    };
    this.gatherer.start();
  }

  /** Binds the socket(s). Rejects with a `RangeError` on an unusable numeric option (see {@link RtcEndpointOptions}). */
  static async listen(opts: RtcEndpointOptions): Promise<RtcEndpoint> {
    checkEndpointOptions(opts);
    let pubs = opts.publicAddresses;
    const lite = opts.iceLite === true;
    const ipv6 = opts.ipv6 === true;
    if (pubs !== undefined) {
      if (!Array.isArray(pubs) || pubs.length === 0) throw new Error('RtcEndpoint: publicAddresses is empty');
      for (const a of pubs) if (isIP(a) === 0) throw new Error(`RtcEndpoint: publicAddresses must be IP literals (${a})`);
      if (!ipv6) {
        pubs = pubs.filter((a) => isIP(a) === 4);
        if (pubs.length === 0) throw new Error('RtcEndpoint: publicAddresses has only IPv6 addresses (set ipv6: true to use them)');
      }
    } else if (lite) {
      throw new Error('RtcEndpoint: publicAddresses is required with iceLite');
    }
    if (opts.iceTransportPolicy === 'relay') {
      if (lite) throw new Error("RtcEndpoint: iceTransportPolicy 'relay' needs full ICE (not iceLite)");
      if (turnServers(opts.iceServers).length === 0) throw new Error("RtcEndpoint: iceTransportPolicy 'relay' needs a UDP turn: server in iceServers");
    } else if (opts.iceTransportPolicy !== undefined && opts.iceTransportPolicy !== 'all') {
      throw new Error(`RtcEndpoint: iceTransportPolicy must be 'all' or 'relay' (got ${String(opts.iceTransportPolicy)})`);
    }
    // '::' without IPv6 is the IPv4 wildcard; another IPv6 literal is a contradiction
    let address = opts.address;
    if (address !== undefined && !ipv6 && isIP(address) === 6) {
      if (address !== '::') throw new Error(`RtcEndpoint: IPv6 bind address ${address} needs ipv6: true`);
      address = undefined;
    }
    // families to bind: those of the public addresses, else of the bind address, else IPv4 (+ IPv6 when enabled and routable)
    let families: Set<number>;
    let optional6 = false;
    if (pubs !== undefined) families = new Set(pubs.map((a) => isIP(a)));
    else if (address !== undefined) families = new Set(address === '::' ? [6, 4] : [isIP(address)]);
    else {
      families = new Set([4]);
      if (ipv6 && hasGlobalIpv6()) {
        families.add(6);
        optional6 = true;
      }
    }
    const bufSize = opts.socketBufferSize ?? 4 << 20;
    let port = opts.port ?? 0;
    const bound: RawBound[] = [];
    const dataLayer = opts.dataLayer ?? defaultDataLayer;
    // the key pair is generated on the thread pool while the socket binds
    const certificatePromise: Promise<RtcCertificate> =
      opts.certificate !== undefined
        ? Promise.resolve(opts.certificate)
        : opts.certificateFile !== undefined
          ? RtcCertificate.loadOrCreate(opts.certificateFile)
          : RtcCertificate.processDefault();
    certificatePromise.catch(() => {}); // awaited below (unless binding fails first)
    try {
      if (address !== undefined) {
        const fam = isIP(address);
        if (fam === 0) throw new Error(`RtcEndpoint: address must be an IP literal (${address})`);
        for (const f of families) {
          if (f !== fam && !(fam === 6 && address === '::')) {
            throw new Error('RtcEndpoint: publicAddresses family does not match the bind address');
          }
        }
        const sock = await bindSocket(fam === 4 ? 'udp4' : 'udp6', address, port, bufSize);
        bound.push({ sock, family: fam === 4 ? 4 : 6, bindAddress: address });
        if (fam === 6 && address === '::' && families.has(4)) {
          // '::' explicitly given with IPv4 public addresses: also bind udp4 on the same port
          port = sock.address().port;
          bound.push({ sock: await bindSocket('udp4', '0.0.0.0', port, bufSize), family: 4, bindAddress: '0.0.0.0' });
        }
      } else {
        if (families.has(4)) bound.push({ sock: await bindSocket('udp4', '0.0.0.0', port, bufSize), family: 4, bindAddress: '0.0.0.0' });
        if (bound.length > 0) port = bound[0]!.sock.address().port;
        if (families.has(6)) {
          try {
            bound.push({ sock: await bindSocket('udp6', '::', port, bufSize), family: 6, bindAddress: '::' });
          } catch (err) {
            if (!optional6) throw err; // auto-detected IPv6 that cannot be bound: IPv4 only
          }
        }
      }
    } catch (err) {
      for (const s of bound) s.sock.close();
      throw err;
    }
    port = bound[0]!.sock.address().port;
    let certificate: RtcCertificate;
    try {
      certificate = await certificatePromise;
    } catch (err) {
      for (const s of bound) s.sock.close();
      throw err;
    }
    return new RtcEndpoint(pubs !== opts.publicAddresses ? { ...opts, publicAddresses: pubs } : opts, bound, port, certificate, dataLayer);
  }

  private replaceScratch(size: number): void {
    this.sendScratch = Buffer.allocUnsafeSlow(size);
    this.sendViews = [];
  }

  /** Our candidate lines (no `a=`) known now (host + server-reflexive), identical for every new session. */
  get localCandidates(): string[] {
    return this.gatherer.candidateLines();
  }

  /**
   * A STUN refresh round runs while the previous result is known: new
   * sessions get those candidates in their answer, but not
   * end-of-candidates (a changed srflx follows by trickle).
   */
  get refreshingCandidates(): boolean {
    return this.gatherer.isRefreshing;
  }

  /** Resolves when no STUN gathering round is running (tests / diagnostics). */
  whenGathered(): Promise<void> {
    return this.gatherer.whenIdle();
  }

  /** Our public addresses as reported by the STUN servers in the last round, [] if none. */
  get reflexiveAddresses(): { address: string; port: number }[] {
    return this.gatherer.mapped.slice();
  }

  /** The bound sockets (family and bind address). */
  get boundAddresses(): { family: 4 | 6; address: string }[] {
    return this.bound.map((b) => ({ family: b.family, address: b.bindAddress }));
  }

  /**
   * Replaces the STUN/TURN servers at runtime (e.g. fresh short-lived TURN
   * credentials). TURN: applies to the next Allocate — the current allocation
   * keeps its credentials until the server refuses them, then it is re-made
   * with the new ones (new sessions get the new relay candidate). STUN
   * servers: from the next gathering round. TURN can be changed, not added
   * or removed (the endpoint is created with or without a relay).
   */
  setIceServers(list: readonly IceServerInput[]): void {
    if (this.closed || this.iceLite) return;
    this.gatherer.setStunServers(this.relayOnly ? [] : stunServers(list));
    const turn = turnServers(list);
    if (this.relay !== null && turn.length > 0) {
      this.turnSpecs = turn;
      for (const r of this.pool) r.setServers(turn);
    }
  }

  /** The TURN allocation's state (null: no TURN server configured). */
  get turn(): TurnStats | null {
    return this.turnStats();
  }

  /** The current allocation's state, counters summed over the pool. */
  private turnStats(): TurnStats | null {
    if (this.relay === null) return null;
    const cur = this.current[0] ?? this.relay;
    const out = cur.stats();
    for (const r of this.pool) {
      if (r === cur) continue;
      const x = r.stats();
      out.allocations += x.allocations;
      out.allocationFailures += x.allocationFailures;
      out.refreshes += x.refreshes;
      out.permissions += x.permissions;
      out.channels += x.channels;
      out.packetsOut += x.packetsOut;
      out.bytesOut += x.bytesOut;
      out.packetsIn += x.packetsIn;
      out.bytesIn += x.bytesIn;
      out.sendIndications += x.sendIndications;
      out.channelDataOut += x.channelDataOut;
      out.dropped += x.dropped;
    }
    out.pool = this.pool.length;
    return out;
  }

  /**
   * Creates the session for a browser offer. Throws RtcSdpError on an unusable offer.
   * `remoteIp`: the address the signaling server saw the peer connect from;
   * with TURN it gets a relay permission up front, next to the offer's candidates.
   */
  createSession(offerSdp: string, o?: { remoteIp?: string }): RtcSession {
    if (this.closed) throw new Error('RtcEndpoint closed');
    if (this.byUfrag.size >= this.maxSessions) throw new Error('RtcEndpoint: too many sessions');
    const offer = parseOffer(offerSdp);
    let ufrag = randomIceString(8);
    while (this.byUfrag.has(ufrag)) ufrag = randomIceString(8);
    const pwd = randomIceString(24);
    if (this.relay !== null) this.selectRelay();
    const g = this.gatherer.forSession();
    const answer = buildAnswer({
      offer,
      iceUfrag: ufrag,
      icePwd: pwd,
      fingerprint: this.certificate.fingerprint,
      candidates: [],
      candidateLines: g.lines,
      iceLite: this.iceLite,
      endOfCandidates: g.complete,
      sctpPort: this.host.sctpPort,
      maxMessageSize: this.host.maxMessageSize,
      sessionId: String(BigInt.asUintN(62, randomBytes(8).readBigUInt64BE())),
    });
    const s = new RtcSessionImpl(this.host, offer, ufrag, pwd, answer, g.lines);
    const ip = o?.remoteIp;
    if (ip !== undefined && s.agent !== null && this.relay !== null) s.agent.hintRemoteIp(ip.startsWith('::ffff:') ? ip.slice(7) : ip);
    if (this.relay !== null) this.ensureSpare();
    if (!g.complete) {
      s.gatheringComplete = false;
      this.gatherer.wait(s);
    }
    this.byUfrag.set(ufrag, s);
    this.armSweep();
    return s;
  }

  // ------------------------------------------------------------ demux

  private onPacket(sock: UdpIo, msg: Buffer, address: string, port: number): void {
    const c = this.counters;
    c.packetsIn++;
    c.bytesIn += msg.length;
    if (msg.length === 0) return;
    // straight from the socket's receive callback (relayed datagrams too, via onRelayPacket): a throw would be uncaught
    try {
      const r = this.relay;
      if (r !== null && port === r.serverPort && sock === this.turnIo && r.serverAddress !== null) {
        if ((address === r.serverAddress || sameIp(address, r.serverAddress)) && r.onServerPacket(msg)) return;
      }
      if (this.relayOnly) {
        // nothing from a peer is answered unless it came through the relay
        c.directDropped++;
        return;
      }
      this.demux(sock, this.byAddress, msg, address, port);
    } catch (err) {
      c.packetErrors++;
      this.internalError('datagram', err);
    }
  }

  /** A peer's datagram unwrapped by the relay (packetsIn/bytesIn counted the outer datagram). */
  private onRelayPacket(relay: TurnRelay, msg: Buffer, address: string, port: number): void {
    if (msg.length === 0) return;
    this.demux(relay, this.relayMaps.get(relay) ?? this.byAddress, msg, address, port);
  }

  /** A datagram on the own socket of a pool allocation: only its TURN server talks to it. */
  private onRelaySocketPacket(relay: TurnRelay, msg: Buffer, address: string, port: number): void {
    const c = this.counters;
    c.packetsIn++;
    c.bytesIn += msg.length;
    if (msg.length === 0 || this.closed) return;
    try {
      const sa = relay.serverAddress;
      if (port === relay.serverPort && sa !== null && (address === sa || sameIp(address, sa)) && relay.onServerPacket(msg)) return;
      c.directDropped++;
    } catch (err) {
      c.packetErrors++;
      this.internalError('datagram', err);
    }
  }

  /** A datagram or timer whose processing threw: logged (rate-limited), never propagated. */
  private internalError(what: string, err: unknown): void {
    const now = Date.now();
    if (now - this.errorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
    this.errorLoggedAt = now;
    try {
      console.error(`[haxlite/rtc] error processing a ${what}:`, err);
    } catch {
      /* never propagate */
    }
  }

  // ------------------------------------------------------------ TURN allocation pool

  /** Reserved peer addresses per session that has not connected yet (its srflx and a peer-reflexive one). */
  private static readonly RESERVE = 2;

  /** Peer addresses an allocation can still take for new sessions. */
  private relayRoom(r: TurnRelay): number {
    if (!r.ready || r.full) return 0;
    let pending = 0;
    const set = this.relaySessions.get(r);
    if (set !== undefined) for (const s of set) if (s.state !== 'open') pending++;
    return this.turnBudget - r.peerAddresses - pending * RtcEndpoint.RESERVE;
  }

  /** New sessions go to the current allocation while it has room, else to another one with room. */
  private selectRelay(): void {
    const cur = this.current[0];
    if (cur === undefined || this.relayRoom(cur) >= RtcEndpoint.RESERVE) return;
    let best: TurnRelay | null = null;
    for (const r of this.pool) if (r !== cur && this.relayRoom(r) >= RtcEndpoint.RESERVE && (best === null || this.relayRoom(r) > this.relayRoom(best))) best = r;
    if (best === null) return; // none: the current one takes it (overloaded) while a new one is made
    this.current[0] = best;
    this.gatherer.relaysChanged();
  }

  /** Keeps one more allocation with room ready (or being made) when the current one runs low. */
  private ensureSpare(): void {
    const cur = this.current[0];
    if (cur === undefined || this.closed) return;
    if (cur.ready && this.relayRoom(cur) >= 2 * RtcEndpoint.RESERVE) return;
    for (const r of this.pool) if (r !== cur && (r.state === 'allocating' || this.relayRoom(r) >= 2 * RtcEndpoint.RESERVE)) return;
    this.spawnRelay();
  }

  private spawnRelay(): void {
    if (this.spawning || this.closed || this.pool.length >= this.maxTurn) return;
    this.spawning = true;
    bindSocket('udp4', this.turnBind, 0, 1 << 20).then(
      (sock) => {
        this.spawning = false;
        if (this.closed) {
          sock.close();
          return;
        }
        let relay: TurnRelay | null = null;
        // a throw here would reject this promise unhandled (fatal) and leak the socket
        try {
          const io = new UdpIo(
            sock,
            (msg, address, port) => {
              if (relay !== null) this.onRelaySocketPacket(relay, msg, address, port);
            },
            (err) => console.error('[haxlite/rtc] socket error:', err.message),
          );
          relay = this.makeRelay(io, false);
          this.relaySockets.set(relay, sock);
          relay.allocate();
        } catch (err) {
          this.internalError('new TURN allocation', err);
          const i = relay === null ? -1 : this.pool.indexOf(relay);
          if (i >= 0) {
            this.relaySockets.set(relay!, sock);
            this.dropRelay(i); // closes the socket too
          } else sock.close();
        }
      },
      () => {
        this.spawning = false;
      },
    );
  }

  private onRelayChange(r: TurnRelay): void {
    if (!r.ready) this.relayMaps.get(r)?.clear();
    if (r === this.current[0]) this.gatherer.relaysChanged();
    else if (r.ready && this.current[0] !== undefined && this.relayRoom(this.current[0]) < RtcEndpoint.RESERVE) {
      // a new allocation is up and the current one is out of room: new sessions use it
      this.current[0] = r;
      this.gatherer.relaysChanged();
    }
    if (!r.ready) this.retireIdle();
  }

  private assignRelay(s: RtcSessionImpl, r: TurnRelay): void {
    const set = this.relaySessions.get(r);
    if (set === undefined || set.has(s)) return;
    set.add(s);
    let list = this.sessionRelays.get(s);
    if (list === undefined) {
      list = [];
      this.sessionRelays.set(s, list);
    }
    list.push(r);
  }

  /** Deletes allocations (other than the endpoint socket's and the current one) that have no room and no sessions left. */
  private retireIdle(): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const r = this.pool[i]!;
      if (r === this.relay || r === this.current[0] || r.state === 'allocating') continue;
      if ((this.relaySessions.get(r)?.size ?? 0) > 0) continue;
      if (r.ready && this.relayRoom(r) >= RtcEndpoint.RESERVE) continue; // a spare with room: kept
      this.dropRelay(i);
    }
  }

  /** Removes `pool[i]` from the pool, deletes its allocation and closes its own socket. */
  private dropRelay(i: number): void {
    const r = this.pool[i]!;
    this.pool.splice(i, 1);
    this.relayMaps.delete(r);
    this.relaySessions.delete(r);
    try {
      r.close();
    } finally {
      const sock = this.relaySockets.get(r);
      this.relaySockets.delete(r);
      sock?.close();
    }
  }

  private demux(sock: PacketIo, byAddress: Map<string, Map<number, ValidatedAddress>>, msg: Buffer, address: string, port: number): void {
    const c = this.counters;
    const b0 = msg[0]!;
    if (b0 < 4) {
      this.onStun(sock, msg, address, port);
      return;
    }
    if (b0 >= 20 && b0 <= 63) {
      const ports = byAddress.get(address);
      const v = ports === undefined ? undefined : ports.get(port);
      if (v === undefined || v.sock !== sock) {
        // full ICE: the ClientHello may beat our triggered check to its source: held, not processed
        const h = this.holds.size === 0 ? undefined : this.holds.get(`${address}|${port}`);
        if (h !== undefined && h.holdDtls(msg, sock, address, port)) c.dtlsHeld++;
        else c.dtlsUnknownSource++;
        return;
      }
      const s = v.session;
      try {
        s.handleDtls(msg, v);
      } catch (err) {
        this.sessionPacketError(s, err);
        return;
      }
      s.packetErrors = 0;
      return;
    }
    c.unknownPackets++;
  }

  /** A datagram of `s` threw: counted and logged like any other; a session that keeps throwing is closed. */
  private sessionPacketError(s: RtcSessionImpl, err: unknown): void {
    this.counters.packetErrors++;
    this.internalError('datagram', err);
    if (++s.packetErrors < SESSION_PACKET_ERRORS) return;
    try {
      s.terminate('error');
    } catch (e) {
      this.internalError('session teardown', e);
    }
  }

  private onStun(sock: PacketIo, msg: Buffer, address: string, port: number): void {
    const m = this.stunScratch;
    const c = this.counters;
    if (!parseStun(msg, m)) {
      c.stunRejected++;
      return;
    }
    if (m.type === StunType.BindingSuccess || m.type === StunType.BindingError) {
      // a response to one of our requests (connectivity/consent check, gathering), by transaction id
      if (this.ice.onResponse(m, sock, address, port)) c.stunResponses++;
      else c.stunRejected++;
      return;
    }
    if (m.type !== StunType.BindingRequest || m.usernameOffset < 0) {
      // indications are dropped silently, anything else counts as rejected
      if (m.type !== StunType.BindingIndication) c.stunRejected++;
      return;
    }
    // USERNAME "ourUfrag:theirUfrag": find the colon without building the whole string first
    const buf = m.buf;
    let colon = -1;
    for (let i = 0; i < m.usernameLength; i++) {
      if (buf[m.usernameOffset + i] === 0x3a) {
        colon = i;
        break;
      }
    }
    if (colon <= 0) {
      c.stunRejected++;
      return;
    }
    const ufrag = msg.toString('latin1', m.usernameOffset, m.usernameOffset + colon);
    const s = this.byUfrag.get(ufrag);
    if (s === undefined) {
      c.stunRejected++;
      return;
    }
    let ok: boolean;
    try {
      ok = s.handleBinding(m, sock, address, port);
    } catch (err) {
      this.sessionPacketError(s, err);
      return;
    }
    if (!ok) {
      c.stunRejected++;
      return;
    }
    s.packetErrors = 0;
    c.stunAuthenticated++;
  }

  private mapFor(sock: PacketIo): Map<string, Map<number, ValidatedAddress>> {
    if (sock instanceof TurnRelay) return this.relayMaps.get(sock) ?? this.byAddress;
    return this.byAddress;
  }

  private bindAddress(v: ValidatedAddress): void {
    const map = this.mapFor(v.sock);
    let ports = map.get(v.address);
    if (ports === undefined) {
      ports = new Map();
      map.set(v.address, ports);
    }
    const prev = ports.get(v.port);
    if (prev === v) return;
    ports.set(v.port, v);
    if (prev !== undefined && prev.session !== v.session) prev.session.forgetAddress(prev);
  }

  /** Releases v's 5-tuple from the DTLS demux if v still owns it. */
  private unbindAddress(v: ValidatedAddress): void {
    const map = this.mapFor(v.sock);
    const ports = map.get(v.address);
    if (ports !== undefined && ports.get(v.port) === v) {
      ports.delete(v.port);
      if (ports.size === 0) map.delete(v.address);
    }
  }

  private unregister(s: RtcSessionImpl): void {
    if (this.byUfrag.get(s.localUfrag) === s) this.byUfrag.delete(s.localUfrag);
    this.gatherer.forget(s);
    for (const v of s.validated) this.unbindAddress(v);
    for (const k of s.holdKeys) if (this.holds.get(k) === s) this.holds.delete(k);
    s.holdKeys.length = 0;
    const d = s.dtlsDrops;
    this.counters.dtlsReplayed += d.replayed;
    this.counters.dtlsBadRecords += d.bad;
    const relays = this.sessionRelays.get(s);
    if (relays !== undefined) {
      this.sessionRelays.delete(s);
      for (const r of relays) this.relaySessions.get(r)?.delete(s);
      this.retireIdle();
    }
  }

  // ------------------------------------------------------------ timers

  /** 1 Hz sweep (handshake timeout, consent expiry), only while sessions exist. */
  private armSweep(): void {
    if (this.sweepTimer !== null || this.closed) return;
    const t = setInterval(() => {
      const now = Date.now();
      // forEach: no iterator result objects
      this.byUfrag.forEach((s) => {
        try {
          s.checkTimers(now, this.handshakeTimeoutMs, this.idleTimeoutMs);
        } catch (err) {
          // a session in a state its timers do not expect: closed rather than failing every second
          this.internalError('session timer', err);
          try {
            s.terminate('error');
          } catch {
            /* torn down as far as it goes */
          }
        }
      });
      if (this.byUfrag.size === 0 && this.sweepTimer !== null) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, 1000);
    t.unref?.();
    this.sweepTimer = t;
  }

  // ------------------------------------------------------------ misc

  stats(): RtcEndpointStats {
    let open = 0;
    let replayed = this.counters.dtlsReplayed;
    let bad = this.counters.dtlsBadRecords;
    for (const s of this.byUfrag.values()) {
      if (s.state === 'open') open++;
      const d = s.dtlsDrops;
      replayed += d.replayed;
      bad += d.bad;
    }
    return {
      ...this.counters,
      sessions: this.byUfrag.size,
      open,
      dtlsReplayed: replayed,
      dtlsBadRecords: bad,
      ice: { ...this.ice.stats },
      reflexive: this.gatherer.mapped.map((a) => (isIP(a.address) === 6 ? `[${a.address}]:${a.port}` : `${a.address}:${a.port}`)),
      turn: this.turnStats(),
    };
  }

  /** Closes every session (onClose('endpoint-closed')) and the socket(s). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.byUfrag.values()]) s.terminate('endpoint-closed');
    this.gatherer.close();
    for (const r of this.pool) r.close();
    for (const sock of this.relaySockets.values()) sock.close();
    this.relaySockets.clear();
    this.ice.close();
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.all(this.sockets.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
