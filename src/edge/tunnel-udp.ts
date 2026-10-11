/**
 * Edge side of tunnel v2 (see `src/net/edge-udp.ts`): ONE UDP socket for
 * every host tunnel, demultiplexed by the cleartext connection id the edge
 * issued over the authenticated control WebSocket.
 *
 * Anti-abuse rules (docs/09 §4):
 * * a datagram whose connection id is unknown is dropped without any answer
 *   (and without crypto: one map lookup);
 * * nothing is ever sent to an address before a datagram from it passed
 *   AES-GCM authentication under that tunnel's keys, so a spoofed source
 *   cannot make the edge send anything (no amplification, no reflection);
 *   the only replies to a host packet are SCTP's and a same-size Pong;
 * * the peer address only moves (NAT rebinding) on an authenticated datagram
 *   that is the newest seen (a replayed or delayed one cannot redirect it);
 * * per connection id: a token bucket for datagrams from the authenticated
 *   address and a small one for any other source (AEAD attempts against a
 *   known connection id are bounded);
 * * a tunnel that sends nothing authenticated for `idleTimeoutMs` is closed.
 */
import dgram, { type RemoteInfo, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { TokenBucket } from '../net/rate-limit.js';
import { UdpTunnelPlane, udpConnId, type TunnelSecrets, type UdpPlaneEvents } from '../net/edge-udp.js';

export interface EdgeTunnelOptions {
  /** Accept tunnel v2 (UDP) data planes. Default true. */
  udp?: boolean;
  /**
   * UDP port of the tunnel. Default: the control WebSocket's port number (TCP
   * and UDP 8443 — one number to open; an ephemeral port if it is taken and
   * none was configured). 0 = ephemeral.
   */
  port?: number;
  /** Bind address. Default `webrtc.bindAddress`, else the control listen host. */
  bindAddress?: string;
  /** Host name/IP hosts send to (default: the host of the control URL they used). */
  publicHost?: string;
  /** Port hosts send to (default: the bound port; set it behind a port-mapping NAT). */
  publicPort?: number;
  /** Datagrams/s accepted from a tunnel's authenticated address (bucket of 2 s). Default 20 000. */
  maxPps?: number;
  /** Datagrams/s accepted for one connection id from any other address (NAT rebinding, attacks). Default 20. */
  maxForeignPps?: number;
  /** Close a tunnel when nothing authenticated arrived for this long. Default 30 s (hosts ping every 5 s). */
  idleTimeoutMs?: number;
  /** Accept the legacy WebRTC (node-datachannel) tunnel from hosts that ask for it (loads the addon then). Default true. */
  allowWebRtc?: boolean;
}

export interface EdgeTunnelStats {
  port: number;
  tunnels: number;
  datagramsIn: number;
  datagramsOut: number;
  bytesIn: number;
  bytesOut: number;
  /** Dropped: unknown connection id / too short. */
  unknownConn: number;
  /** Dropped by the per-connection buckets. */
  rateLimited: number;
  /** Failed authentication or replayed. */
  rejected: number;
  /** Peer address changes (authenticated NAT rebinding). */
  migrations: number;
}

function bindSocket(address: string, port: number): Promise<Socket> {
  const fam = isIP(address);
  if (fam === 0) throw new Error(`tunnel bind address must be an IP literal (${address})`);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: fam === 6 ? 'udp6' : 'udp4', reuseAddr: false });
    const onError = (err: Error) => {
      sock.close();
      reject(err);
    };
    sock.once('error', onError);
    sock.bind({ address, port, exclusive: true }, () => {
      sock.off('error', onError);
      try {
        sock.setRecvBufferSize(4 << 20);
        sock.setSendBufferSize(4 << 20);
      } catch {
        /* capped by the kernel */
      }
      resolve(sock);
    });
  });
}

/** One host tunnel on the shared socket. */
export class EdgeUdpConn {
  readonly connId: number;
  readonly plane: UdpTunnelPlane;
  /** Authenticated peer address (null until the first valid datagram). */
  addr: { address: string; port: number } | null = null;
  readonly createdAt = performance.now();
  private readonly server: EdgeUdpServer;
  private readonly own: TokenBucket;
  private readonly foreign: TokenBucket;
  private readonly onDead: (reason: string) => void;
  closed = false;

  /** @internal use {@link EdgeUdpServer.open} */
  constructor(server: EdgeUdpServer, connId: number, secrets: TunnelSecrets, lanes: number, events: UdpPlaneEvents, extra: { rekeyAfterPackets?: number }) {
    this.server = server;
    this.connId = connId;
    const pps = server.maxPps;
    this.own = new TokenBucket(Math.max(16, Math.round(pps * 2)), 1000 / pps);
    const fpps = server.maxForeignPps;
    this.foreign = new TokenBucket(Math.max(4, fpps), 1000 / Math.max(fpps, 0.001));
    this.onDead = events.onClose;
    this.plane = new UdpTunnelPlane({
      role: 'server',
      connId,
      secrets,
      lanes,
      transmit: (d) => {
        const a = this.addr;
        if (a !== null) this.server.sendTo(d, a.address, a.port); // never to an unauthenticated address
      },
      events,
      ...(extra.rekeyAfterPackets !== undefined ? { rekeyAfterPackets: extra.rekeyAfterPackets } : null),
    });
  }

  /** A datagram carrying this connection id. */
  onDatagram(msg: Buffer, rinfo: RemoteInfo, now: number): void {
    const a = this.addr;
    const fromPeer = a !== null && a.port === rinfo.port && a.address === rinfo.address;
    if (!(fromPeer ? this.own : this.foreign).take(now)) {
      this.server.counters.rateLimited++;
      return;
    }
    const pt = this.plane.authenticate(msg);
    if (pt === null) {
      this.server.counters.rejected++;
      return;
    }
    if (!fromPeer && this.plane.cipher.lastNewest) {
      if (a !== null) this.server.counters.migrations++;
      this.addr = { address: rinfo.address, port: rinfo.port };
    }
    this.plane.dispatch(pt);
  }

  /** Idle check (server sweep). */
  checkIdle(now: number, idleMs: number): void {
    if (this.closed) return;
    const last = Math.max(this.plane.lastRx, this.createdAt);
    if (now - last > idleMs) {
      this.close();
      this.onDead('idle-timeout');
    }
  }

  /** Closes (Close datagram + SCTP ABORT to the host, best effort) and unregisters. No callback. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.plane.close();
    this.server.remove(this);
  }
}

/** The edge's tunnel v2 UDP socket. */
export class EdgeUdpServer {
  readonly port: number;
  readonly maxPps: number;
  readonly maxForeignPps: number;
  private readonly idleMs: number;
  private readonly sock: Socket;
  private readonly conns = new Map<number, EdgeUdpConn>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;
  readonly counters = { datagramsIn: 0, datagramsOut: 0, bytesIn: 0, bytesOut: 0, unknownConn: 0, rateLimited: 0, rejected: 0, migrations: 0 };

  private constructor(sock: Socket, o: EdgeTunnelOptions) {
    this.sock = sock;
    this.port = sock.address().port;
    this.maxPps = Math.max(1, o.maxPps ?? 20_000);
    this.maxForeignPps = Math.max(1, o.maxForeignPps ?? 20);
    this.idleMs = o.idleTimeoutMs ?? 30_000;
    sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => this.onPacket(msg, rinfo));
    sock.on('error', () => {
      /* ICMP errors etc.: never fatal for a shared socket */
    });
  }

  /** Binds `address:port`; with `fallbackEphemeral`, an in-use port falls back to an ephemeral one. */
  static async listen(address: string, port: number, o: EdgeTunnelOptions, fallbackEphemeral: boolean): Promise<EdgeUdpServer> {
    let sock: Socket;
    try {
      sock = await bindSocket(address, port);
    } catch (err) {
      if (!fallbackEphemeral || port === 0) throw err;
      sock = await bindSocket(address, 0);
    }
    return new EdgeUdpServer(sock, o);
  }

  /** Registers a new tunnel with a fresh random connection id. */
  open(secretsFor: (connId: number) => TunnelSecrets, lanes: number, events: UdpPlaneEvents, extra: { rekeyAfterPackets?: number } = {}): EdgeUdpConn {
    if (this.closed) throw new Error('tunnel socket closed');
    let id = 0;
    while (id === 0 || this.conns.has(id)) id = randomBytes(4).readUInt32BE(0);
    const conn = new EdgeUdpConn(this, id, secretsFor(id), lanes, events, extra);
    this.conns.set(id, conn);
    if (this.sweepTimer === null) {
      const t = setInterval(() => this.sweep(), Math.min(5000, Math.max(250, this.idleMs / 3)));
      t.unref?.();
      this.sweepTimer = t;
    }
    return conn;
  }

  /** @internal */ remove(conn: EdgeUdpConn): void {
    if (this.conns.get(conn.connId) === conn) this.conns.delete(conn.connId);
    if (this.conns.size === 0 && this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** @internal */ sendTo(d: Buffer, address: string, port: number): void {
    const c = this.counters;
    c.datagramsOut++;
    c.bytesOut += d.length;
    try {
      this.sock.send(d, port, address);
    } catch {
      /* closed */
    }
  }

  private onPacket(msg: Buffer, rinfo: RemoteInfo): void {
    const c = this.counters;
    c.datagramsIn++;
    c.bytesIn += msg.length;
    const id = udpConnId(msg);
    const conn = id <= 0 ? undefined : this.conns.get(id);
    if (conn === undefined) {
      c.unknownConn++;
      return;
    }
    conn.onDatagram(msg, rinfo, performance.now());
  }

  private sweep(): void {
    const now = performance.now();
    for (const conn of [...this.conns.values()]) conn.checkIdle(now, this.idleMs);
  }

  stats(): EdgeTunnelStats {
    return { port: this.port, tunnels: this.conns.size, ...this.counters };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const conn of [...this.conns.values()]) conn.close();
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await new Promise<void>((r) => this.sock.close(() => r()));
  }
}
