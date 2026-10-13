/**
 * Userspace NAT simulator and a minimal STUN server (TEST ONLY).
 *
 * No network namespaces are needed: the NAT is a set of UDP sockets on
 * loopback. The machine "behind" the NAT reaches the outside world only
 * through **aliases**: for every outside transport address R the NAT has an
 * internal socket alias(R); a datagram the inside host sends to alias(R)
 * leaves through the NAT's external socket for that host (its mapping) to R,
 * and a datagram arriving at that external socket from R' is delivered to the
 * inside host from alias(R') — **only if the filtering rule allows it**.
 * Tests rewrite the remote candidates the inside host learns (offer,
 * trickle, STUN server address) to their aliases: that is the "routing"
 * through the NAT, so the inside host's sockets behave exactly as behind a
 * real NAT.
 *
 *   inside host H ──▶ alias(R) ──▶ [mapping of H: external socket E] ──▶ R
 *   R ──▶ E ──(filter: has H sent to R?)──▶ alias(R) ──▶ H
 *
 * Mapping (RFC 4787): `endpoint-independent` (one E per inside source: what
 * STUN reports is what every peer sees), `address-dependent` (a new E per
 * destination address) or `address-port-dependent` (per destination address
 * and port) — "symmetric" NATs: the STUN-reported address is useless to peers. Filtering: `endpoint-independent` (full cone),
 * `address-dependent` (restricted cone) or `address-port-dependent` (port
 * restricted — the default, the strictest common one).
 */
import dgram, { type Socket } from 'node:dgram';

export type NatMapping = 'endpoint-independent' | 'address-dependent' | 'address-port-dependent';
export type NatFiltering = 'endpoint-independent' | 'address-dependent' | 'address-port-dependent';

export interface NatOptions {
  mapping?: NatMapping;
  filtering?: NatFiltering;
  /** Inside (LAN-side) address: where the aliases listen (default 127.0.0.1). */
  insideAddress?: string;
  /** Outside (WAN-side) address of the external sockets (default {@link insideAddress}). */
  outsideAddress?: string;
  /** Log every decision. */
  verbose?: boolean;
}

export interface Addr {
  address: string;
  port: number;
}

interface Mapping {
  /** Inside source. */
  inside: Addr;
  ext: Socket;
  extPort: number;
  /** Outside addresses contacted from this mapping (`ip` and `ip:port`). */
  contacted: Set<string>;
}

export interface NatStats {
  /** Datagrams inside → outside. */
  out: number;
  /** Outside → inside, delivered. */
  in: number;
  /** Outside → inside, dropped by the filtering rule (unsolicited). */
  dropped: number;
  mappings: number;
}

const key = (a: Addr) => `${a.address}:${a.port}`;

function bind(address: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, address, () => {
      s.off('error', reject);
      resolve(s);
    });
  });
}

export class UdpNat {
  readonly stats: NatStats = { out: 0, in: 0, dropped: 0, mappings: 0 };
  private readonly o: Required<Omit<NatOptions, 'verbose'>> & { verbose: boolean };
  /** Every external port opened so far (tests: what a peer could have learned). */
  readonly externalPorts: number[] = [];
  /** outside address → alias socket. */
  private readonly aliases = new Map<string, Promise<Socket>>();
  private readonly aliasOf = new Map<Socket, Addr>();
  /** inside source (and destination for address-dependent mapping) → mapping. */
  private readonly mappings = new Map<string, Promise<Mapping>>();
  private readonly sockets = new Set<Socket>();
  private closed = false;
  /** Drops everything when false (simulates a dead link). */
  up = true;

  constructor(o: NatOptions = {}) {
    this.o = {
      mapping: o.mapping ?? 'endpoint-independent',
      filtering: o.filtering ?? 'address-port-dependent',
      insideAddress: o.insideAddress ?? '127.0.0.1',
      outsideAddress: o.outsideAddress ?? o.insideAddress ?? '127.0.0.1',
      verbose: o.verbose ?? false,
    };
  }

  private log(...a: unknown[]): void {
    if (this.o.verbose) console.log('[nat]', ...a);
  }

  /** The inside-facing alias of outside address `r` (created on first use). */
  async alias(r: Addr): Promise<Addr> {
    const s = await this.aliasSocket(r);
    return { address: this.o.insideAddress, port: s.address().port };
  }

  private aliasSocket(r: Addr): Promise<Socket> {
    const k = key(r);
    let p = this.aliases.get(k);
    if (p === undefined) {
      p = bind(this.o.insideAddress).then((s) => {
        this.sockets.add(s);
        this.aliasOf.set(s, r);
        s.on('message', (msg, rinfo) => this.fromInside(s, msg, { address: rinfo.address, port: rinfo.port }));
        s.on('error', () => {});
        return s;
      });
      this.aliases.set(k, p);
    }
    return p;
  }

  private mapping(inside: Addr, dest: Addr): Promise<Mapping> {
    const mp = this.o.mapping;
    const k = mp === 'endpoint-independent' ? key(inside) : `${key(inside)}>${mp === 'address-dependent' ? dest.address : key(dest)}`;
    let p = this.mappings.get(k);
    if (p === undefined) {
      p = bind(this.o.outsideAddress).then((ext) => {
        this.sockets.add(ext);
        this.externalPorts.push(ext.address().port);
        const m: Mapping = { inside, ext, extPort: ext.address().port, contacted: new Set() };
        this.stats.mappings++;
        ext.on('message', (msg, rinfo) => this.fromOutside(m, msg, { address: rinfo.address, port: rinfo.port }));
        ext.on('error', () => {});
        this.log('new mapping', key(inside), '→ ext', m.extPort, 'for', key(dest));
        return m;
      });
      this.mappings.set(k, p);
    }
    return p;
  }

  private fromInside(alias: Socket, msg: Buffer, from: Addr): void {
    if (this.closed || !this.up) return;
    const dest = this.aliasOf.get(alias)!;
    void this.mapping(from, dest).then((m) => {
      if (this.closed) return;
      m.contacted.add(dest.address);
      m.contacted.add(key(dest));
      this.stats.out++;
      m.ext.send(msg, dest.port, dest.address);
    });
  }

  private fromOutside(m: Mapping, msg: Buffer, from: Addr): void {
    if (this.closed || !this.up) return;
    const f = this.o.filtering;
    const ok = f === 'endpoint-independent' || (f === 'address-dependent' ? m.contacted.has(from.address) : m.contacted.has(key(from)));
    if (!ok) {
      this.stats.dropped++;
      this.log('drop unsolicited', key(from), '→ ext', m.extPort);
      return;
    }
    this.stats.in++;
    // delivered from the alias of the real source (a new one for a peer-reflexive source)
    void this.aliasSocket(from).then((a) => {
      if (!this.closed) a.send(msg, m.inside.port, m.inside.address);
    });
  }

  /** External port of the (endpoint-independent) mapping of `inside`, if any. */
  async externalPort(inside: Addr): Promise<number | null> {
    const p = this.mappings.get(key(inside));
    return p === undefined ? null : (await p).extPort;
  }

  /**
   * Rewrites a candidate line's address/port to its alias (what the inside
   * host must use to reach it). Returns null for candidates the inside host
   * cannot use (mDNS names, TCP).
   */
  async rewriteCandidate(line: string): Promise<string | null> {
    const prefix = line.startsWith('a=') ? 'a=' : '';
    const p = (prefix ? line.slice(2) : line).split(' ');
    if (p.length < 8 || p[6] !== 'typ' || p[2]!.toLowerCase() !== 'udp' || !/^\d+\.\d+\.\d+\.\d+$/.test(p[4]!)) return null;
    const a = await this.alias({ address: p[4]!, port: Number(p[5]) });
    p[4] = a.address;
    p[5] = String(a.port);
    return prefix + p.join(' ');
  }

  /** Rewrites every `a=candidate:` line of an SDP (unusable ones are removed). */
  async rewriteSdp(sdp: string): Promise<string> {
    const out: string[] = [];
    for (const l of sdp.split(/\r\n/)) {
      if (!l.startsWith('a=candidate:')) {
        out.push(l);
        continue;
      }
      const r = await this.rewriteCandidate(l);
      if (r !== null) out.push(r);
    }
    return out.join('\r\n');
  }

  close(): void {
    this.closed = true;
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        /* closed */
      }
    }
    this.sockets.clear();
  }
}

/** Minimal STUN server (RFC 8489 Binding): answers with XOR-MAPPED-ADDRESS of the source. */
export class FakeStunServer {
  requests = 0;
  private constructor(
    private readonly sock: Socket,
    readonly address: string,
    readonly port: number,
  ) {}

  static async start(address = '127.0.0.1'): Promise<FakeStunServer> {
    const sock = await bind(address);
    const srv = new FakeStunServer(sock, address, sock.address().port);
    sock.on('message', (m, r) => {
      if (m.length < 20 || m.readUInt16BE(0) !== 0x0001 || m.readUInt32BE(4) !== 0x2112a442) return;
      srv.requests++;
      const out = Buffer.alloc(32);
      out.writeUInt16BE(0x0101, 0);
      out.writeUInt16BE(12, 2);
      out.writeUInt32BE(0x2112a442, 4);
      m.copy(out, 8, 8, 20);
      out.writeUInt16BE(0x0020, 20);
      out.writeUInt16BE(8, 22);
      out[25] = 1;
      out.writeUInt16BE(r.port ^ 0x2112, 26);
      const ip = r.address.split('.').map(Number);
      for (let i = 0; i < 4; i++) out[28 + i] = ip[i]! ^ [0x21, 0x12, 0xa4, 0x42][i]!;
      sock.send(out, r.port, r.address);
    });
    sock.on('error', () => {});
    return srv;
  }

  get url(): string {
    return `stun:${this.address}:${this.port}`;
  }

  close(): void {
    this.sock.close();
  }
}
