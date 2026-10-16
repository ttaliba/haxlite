/**
 * The UDP endpoint: one socket per address family shared by every session,
 * demultiplexed per RFC 7983 (first byte 0–3 STUN, 20–63 DTLS) — STUN
 * requests by the USERNAME's ufrag, STUN responses by transaction id (our
 * connectivity/consent checks and STUN gathering, ice-agent.ts / gather.ts),
 * DTLS by the remote transport address once ICE has authenticated it.
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
import { IceScheduler, type BoundSocket, type IceStats } from './ice-agent.js';
import { UdpIo, literalLookup } from './udp.js';

/** A socket bound by {@link RtcEndpoint.listen}, before the endpoint wraps it. */
interface RawBound {
  sock: Socket;
  family: 4 | 6;
  bindAddress: string;
}

export interface RtcEndpointOptions {
  /** UDP port (default 0 = ephemeral). With two families both sockets use the same port. */
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
   * STUN servers for server-reflexive candidates (URL strings like
   * `stun:stun.l.google.com:19302`, node-datachannel or `RTCIceServer`
   * objects). Default none. TURN entries are ignored (not implemented).
   */
  iceServers?: readonly IceServerInput[];
  /**
   * Which interface addresses become host candidates, and which remote
   * address classes may receive our checks (default `'public'`; see
   * `CandidatePolicy` in gather.ts). Not applied to {@link publicAddresses}.
   */
  candidatePolicy?: CandidatePolicy;
  /** Re-query the STUN servers at a new session when the last result is older than this (default 60 000 ms). */
  gatherRefreshMs?: number;
  /** Advertised port when a 1:1 NAT maps a different one (default: the bound port). */
  publicPort?: number;
  /** DTLS identity (default: {@link certificateFile} if set, else the process-wide {@link RtcCertificate.processDefault}). */
  certificate?: RtcCertificate;
  /** Load/persist the DTLS identity in this PEM file ({@link RtcCertificate.loadOrCreate}). */
  certificateFile?: string;
  /** Close an open session after this long without ICE consent (default 30 000 ms). */
  idleTimeoutMs?: number;
  /** Close a session not open this long after createSession (default 20 000 ms). */
  handshakeTimeoutMs?: number;
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
   * dtls/crypto.ts): on Node ChaCha20-Poly1305 first (allocation-free JS
   * AEAD), then AES-128-GCM, AES-256-GCM; on Bun AES-128-GCM first (Bun's
   * native AES-GCM is cheaper than the JS ChaCha20), then ChaCha20-Poly1305,
   * AES-256-GCM. A browser without the first suite gets the next one.
   */
  cipherSuites?: readonly (number | string)[];
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
  /** DTLS-looking datagrams from addresses no session validated. */
  dtlsUnknownSource: number;
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
}

const ICE_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomIceString(n: number): string {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ICE_ALNUM[b[i]! % 62]; // 256 % 62 bias is irrelevant here
  return s;
}

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
  private readonly opts: RtcEndpointOptions;
  private readonly bound: BoundSocket[];
  private readonly gatherer: Gatherer;
  private readonly ice: IceScheduler;
  private readonly iceLite: boolean;
  private readonly byUfrag = new Map<string, RtcSessionImpl>();
  /** remote address → remote port → validated address (DTLS demux). */
  private readonly byAddress = new Map<string, Map<number, ValidatedAddress>>();
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
    unknownPackets: 0,
    handshakesCompleted: 0,
    handshakesFailed: 0,
    dtlsReplayed: 0,
    dtlsBadRecords: 0,
    stunResponses: 0,
  };

  private constructor(opts: RtcEndpointOptions, raw: RawBound[], port: number, certificate: RtcCertificate, dataLayer: SctpFactory) {
    this.opts = opts;
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
    this.ice = new IceScheduler({ send: rawSend, now, sockets: bound, policy, ownClasses: [...ownClasses] });
    this.gatherer = new Gatherer(
      { sockets: bound, send: rawSend, now, register: (k, h) => this.ice.register(k, h), unregister: (k) => this.ice.unregister(k) },
      {
        ...(opts.publicAddresses !== undefined ? { publicAddresses: opts.publicAddresses } : null),
        ...(opts.publicPort !== undefined ? { publicPort: opts.publicPort } : null),
        port,
        stunServers: this.iceLite ? [] : stunServers(opts.iceServers),
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
    };
    this.gatherer.start();
  }

  /** Binds the socket(s). */
  static async listen(opts: RtcEndpointOptions): Promise<RtcEndpoint> {
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

  /** Creates the session for a browser offer. Throws RtcSdpError on an unusable offer. */
  createSession(offerSdp: string): RtcSession {
    if (this.closed) throw new Error('RtcEndpoint closed');
    if (this.byUfrag.size >= this.maxSessions) throw new Error('RtcEndpoint: too many sessions');
    const offer = parseOffer(offerSdp);
    let ufrag = randomIceString(8);
    while (this.byUfrag.has(ufrag)) ufrag = randomIceString(8);
    const pwd = randomIceString(24);
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
    const b0 = msg[0]!;
    if (b0 < 4) {
      this.onStun(sock, msg, address, port);
      return;
    }
    if (b0 >= 20 && b0 <= 63) {
      const ports = this.byAddress.get(address);
      const v = ports === undefined ? undefined : ports.get(port);
      if (v === undefined || v.sock !== sock) {
        c.dtlsUnknownSource++;
        return;
      }
      v.session.handleDtls(msg, v);
      return;
    }
    c.unknownPackets++;
  }

  private onStun(sock: UdpIo, msg: Buffer, address: string, port: number): void {
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
    if (s === undefined || !s.handleBinding(m, sock, address, port)) {
      c.stunRejected++;
      return;
    }
    c.stunAuthenticated++;
  }

  private bindAddress(v: ValidatedAddress): void {
    let ports = this.byAddress.get(v.address);
    if (ports === undefined) {
      ports = new Map();
      this.byAddress.set(v.address, ports);
    }
    const prev = ports.get(v.port);
    if (prev === v) return;
    ports.set(v.port, v);
    if (prev !== undefined && prev.session !== v.session) prev.session.forgetAddress(prev);
  }

  /** Releases v's 5-tuple from the DTLS demux if v still owns it. */
  private unbindAddress(v: ValidatedAddress): void {
    const ports = this.byAddress.get(v.address);
    if (ports !== undefined && ports.get(v.port) === v) {
      ports.delete(v.port);
      if (ports.size === 0) this.byAddress.delete(v.address);
    }
  }

  private unregister(s: RtcSessionImpl): void {
    if (this.byUfrag.get(s.localUfrag) === s) this.byUfrag.delete(s.localUfrag);
    this.gatherer.forget(s);
    for (const v of s.validated) this.unbindAddress(v);
    const d = s.dtlsDrops;
    this.counters.dtlsReplayed += d.replayed;
    this.counters.dtlsBadRecords += d.bad;
  }

  // ------------------------------------------------------------ timers

  /** 1 Hz sweep (handshake timeout, consent expiry), only while sessions exist. */
  private armSweep(): void {
    if (this.sweepTimer !== null || this.closed) return;
    const t = setInterval(() => {
      const now = Date.now();
      // forEach: no iterator result objects
      this.byUfrag.forEach((s) => s.checkTimers(now, this.handshakeTimeoutMs, this.idleTimeoutMs));
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
    };
  }

  /** Closes every session (onClose('endpoint-closed')) and the socket(s). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.byUfrag.values()]) s.terminate('endpoint-closed');
    this.gatherer.close();
    this.ice.close();
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.all(this.sockets.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
