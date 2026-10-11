/**
 * The UDP endpoint: one socket per address family shared by every session,
 * demultiplexed per RFC 7983 (first byte 0–3 STUN, 20–63 DTLS) — STUN by
 * the USERNAME's ufrag, DTLS by the remote transport address once ICE has
 * authenticated it.
 */
import dgram, { type RemoteInfo, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { RtcCertificate } from './cert.js';
import { buildAnswer, hostCandidates, parseOffer, type HostCandidate } from './sdp.js';
import { RtcSessionImpl, type SessionHost, type ValidatedAddress } from './session.js';
import { StunMessage, StunType, parseStun } from './stun.js';
import { SctpAssociation } from './sctp/index.js';
import type { RtcSession, SctpFactory } from './types.js';

export interface RtcEndpointOptions {
  /** UDP port (default 0 = ephemeral). With two families both sockets use the same port. */
  port?: number;
  /** Bind address (default: the wildcard of each family present in {@link publicAddresses}). */
  address?: string;
  /** IP literals advertised as host candidates — the only addresses ever written in SDP. */
  publicAddresses: string[];
  /** Advertised port when a 1:1 NAT maps a different one (default: the bound port). */
  publicPort?: number;
  certificate?: RtcCertificate;
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
}

const ICE_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomIceString(n: number): string {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ICE_ALNUM[b[i]! % 62]; // 256 % 62 bias is irrelevant here
  return s;
}

/** Default data-channel layer: R2's SCTP association (src/rtc/sctp). */
const defaultDataLayer: SctpFactory = (o) => new SctpAssociation(o);

function bindSocket(type: 'udp4' | 'udp6', address: string, port: number, bufSize: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type, ipv6Only: type === 'udp6', reuseAddr: false });
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
  private readonly opts: RtcEndpointOptions;
  private readonly candidates: HostCandidate[];
  private readonly candidateLines: string[];
  private readonly byUfrag = new Map<string, RtcSessionImpl>();
  /** remote address → remote port → validated address (DTLS demux). */
  private readonly byAddress = new Map<string, Map<number, ValidatedAddress>>();
  private readonly stunScratch = new StunMessage();
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
  };

  private constructor(opts: RtcEndpointOptions, sockets: Socket[], port: number, certificate: RtcCertificate, dataLayer: SctpFactory) {
    this.opts = opts;
    this.sockets = sockets;
    this.port = port;
    this.certificate = certificate;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 20_000;
    this.maxSessions = opts.maxSessions ?? 10_000;
    const advertisedPort = opts.publicPort ?? port;
    this.candidates = opts.publicAddresses.map((address) => ({ address, port: advertisedPort }));
    this.candidateLines = hostCandidates(this.candidates);
    const counters = this.counters;
    this.host = {
      certificate,
      dataLayer,
      mtu: opts.mtu ?? 1200,
      maxMessageSize: opts.maxMessageSize ?? 262144,
      sctpPort: 5000,
      sendTo: (dest, buf) => {
        counters.packetsOut++;
        counters.bytesOut += buf.length;
        try {
          dest.sock.send(buf, dest.port, dest.address);
        } catch {
          /* socket closed */
        }
      },
      bindAddress: (v) => this.bindAddress(v),
      unregister: (s) => this.unregister(s),
      countHandshake: (ok) => {
        if (ok) counters.handshakesCompleted++;
        else counters.handshakesFailed++;
      },
      now: () => Date.now(),
    };
    for (const sock of sockets) {
      sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => this.onPacket(sock, msg, rinfo));
      sock.on('error', (err) => {
        // ICMP errors etc.: never fatal for a shared UDP socket
        console.error('[haxlite/rtc] socket error:', err.message);
      });
    }
  }

  /** Binds the socket(s). */
  static async listen(opts: RtcEndpointOptions): Promise<RtcEndpoint> {
    const pubs = opts.publicAddresses;
    if (!Array.isArray(pubs) || pubs.length === 0) throw new Error('RtcEndpoint: publicAddresses is required');
    for (const a of pubs) if (isIP(a) === 0) throw new Error(`RtcEndpoint: publicAddresses must be IP literals (${a})`);
    const families = new Set(pubs.map((a) => isIP(a)));
    const bufSize = opts.socketBufferSize ?? 4 << 20;
    let port = opts.port ?? 0;
    const sockets: Socket[] = [];
    const dataLayer = opts.dataLayer ?? defaultDataLayer;
    try {
      if (opts.address !== undefined) {
        const fam = isIP(opts.address);
        if (fam === 0) throw new Error(`RtcEndpoint: address must be an IP literal (${opts.address})`);
        for (const f of families) {
          if (f !== fam && !(fam === 6 && opts.address === '::')) {
            throw new Error('RtcEndpoint: publicAddresses family does not match the bind address');
          }
        }
        const sock = await bindSocket(fam === 4 ? 'udp4' : 'udp6', opts.address, port, bufSize);
        if (fam === 6 && opts.address === '::' && families.has(4)) {
          // '::' explicitly given with IPv4 public addresses: also bind udp4 on the same port
          sockets.push(sock);
          port = sock.address().port;
          sockets.push(await bindSocket('udp4', '0.0.0.0', port, bufSize));
        } else {
          sockets.push(sock);
        }
      } else {
        if (families.has(4)) sockets.push(await bindSocket('udp4', '0.0.0.0', port, bufSize));
        if (sockets.length > 0) port = sockets[0]!.address().port;
        if (families.has(6)) sockets.push(await bindSocket('udp6', '::', port, bufSize));
      }
    } catch (err) {
      for (const s of sockets) s.close();
      throw err;
    }
    port = sockets[0]!.address().port;
    return new RtcEndpoint(opts, sockets, port, opts.certificate ?? RtcCertificate.generate(), dataLayer);
  }

  /** Our candidate lines (no `a=`), identical for every session. */
  get localCandidates(): string[] {
    return this.candidateLines.slice();
  }

  /** Creates the session for a browser offer. Throws RtcSdpError on an unusable offer. */
  createSession(offerSdp: string): RtcSession {
    if (this.closed) throw new Error('RtcEndpoint closed');
    if (this.byUfrag.size >= this.maxSessions) throw new Error('RtcEndpoint: too many sessions');
    const offer = parseOffer(offerSdp);
    let ufrag = randomIceString(8);
    while (this.byUfrag.has(ufrag)) ufrag = randomIceString(8);
    const pwd = randomIceString(24);
    const answer = buildAnswer({
      offer,
      iceUfrag: ufrag,
      icePwd: pwd,
      fingerprint: this.certificate.fingerprint,
      candidates: this.candidates,
      sctpPort: this.host.sctpPort,
      maxMessageSize: this.host.maxMessageSize,
      sessionId: String(BigInt.asUintN(62, randomBytes(8).readBigUInt64BE())),
    });
    const s = new RtcSessionImpl(this.host, offer, ufrag, pwd, answer, this.candidateLines.slice());
    this.byUfrag.set(ufrag, s);
    this.armSweep();
    return s;
  }

  // ------------------------------------------------------------ demux

  private onPacket(sock: Socket, msg: Buffer, rinfo: RemoteInfo): void {
    const c = this.counters;
    c.packetsIn++;
    c.bytesIn += msg.length;
    if (msg.length === 0) return;
    const b0 = msg[0]!;
    if (b0 < 4) {
      this.onStun(sock, msg, rinfo);
      return;
    }
    if (b0 >= 20 && b0 <= 63) {
      const ports = this.byAddress.get(rinfo.address);
      const v = ports === undefined ? undefined : ports.get(rinfo.port);
      if (v === undefined || v.sock !== sock) {
        c.dtlsUnknownSource++;
        return;
      }
      v.session.handleDtls(msg, v);
      return;
    }
    c.unknownPackets++;
  }

  private onStun(sock: Socket, msg: Buffer, rinfo: RemoteInfo): void {
    const m = this.stunScratch;
    const c = this.counters;
    if (!parseStun(msg, m) || m.type !== StunType.BindingRequest || m.usernameOffset < 0) {
      // indications/responses are not for a lite agent; garbage is dropped silently
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
    if (s === undefined || !s.handleBinding(m, sock, rinfo.address, rinfo.port)) {
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

  private unregister(s: RtcSessionImpl): void {
    if (this.byUfrag.get(s.localUfrag) === s) this.byUfrag.delete(s.localUfrag);
    for (const v of s.validated) {
      const ports = this.byAddress.get(v.address);
      if (ports !== undefined && ports.get(v.port) === v) {
        ports.delete(v.port);
        if (ports.size === 0) this.byAddress.delete(v.address);
      }
    }
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
      for (const s of this.byUfrag.values()) s.checkTimers(now, this.handshakeTimeoutMs, this.idleTimeoutMs);
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
    return { ...this.counters, sessions: this.byUfrag.size, open, dtlsReplayed: replayed, dtlsBadRecords: bad };
  }

  /** Closes every session (onClose('endpoint-closed')) and the socket(s). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.byUfrag.values()]) s.terminate('endpoint-closed');
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.all(this.sockets.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
