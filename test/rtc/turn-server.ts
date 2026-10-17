/**
 * Minimal in-process TURN server (RFC 8656, UDP transport only) — TEST ONLY.
 *
 * Written from the RFC, independently of the client in src/rtc (it does not
 * share its STUN code), so that the two can validate each other:
 *
 * * long-term credentials (RFC 8489 §9.2): a request without
 *   MESSAGE-INTEGRITY gets 401 with REALM and NONCE; the key is
 *   MD5(username ":" realm ":" password); a nonce we did not issue (or one
 *   forced stale with {@link TurnServer.staleNonce}) gets 438 with a fresh
 *   one; FINGERPRINT is checked when present; responses carry
 *   MESSAGE-INTEGRITY + FINGERPRINT;
 * * Allocate (REQUESTED-TRANSPORT = UDP; XOR-RELAYED-ADDRESS,
 *   XOR-MAPPED-ADDRESS, LIFETIME; a retransmitted Allocate gets the same
 *   answer, another one on the same 5-tuple 437), Refresh (LIFETIME 0
 *   deletes), CreatePermission (IP-based, one or more XOR-PEER-ADDRESS),
 *   ChannelBind (0x4000–0x4FFF, also installs the permission);
 * * Send indications and ChannelData from the client are relayed to the
 *   peer when a permission exists; peer datagrams reach the client as
 *   ChannelData when a channel is bound, else as a Data indication, and are
 *   dropped without a permission;
 * * a plain Binding request is answered with XOR-MAPPED-ADDRESS (TURN
 *   servers are STUN servers too).
 *
 * Lifetimes are configurable (tests): the RFC's are 600 s (allocation
 * default, max 3600 s), 300 s (permission) and 600 s (channel).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import dgram, { type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import * as zlib from 'node:zlib';

const MAGIC = 0x2112a442;

export const Method = { Binding: 0x001, Allocate: 0x003, Refresh: 0x004, Send: 0x006, Data: 0x007, CreatePermission: 0x008, ChannelBind: 0x009 } as const;

export const Attr = {
  MappedAddress: 0x0001,
  Username: 0x0006,
  MessageIntegrity: 0x0008,
  ErrorCode: 0x0009,
  UnknownAttributes: 0x000a,
  ChannelNumber: 0x000c,
  Lifetime: 0x000d,
  XorPeerAddress: 0x0012,
  Data: 0x0013,
  Realm: 0x0014,
  Nonce: 0x0015,
  XorRelayedAddress: 0x0016,
  RequestedTransport: 0x0019,
  DontFragment: 0x001a,
  XorMappedAddress: 0x0020,
  Software: 0x8022,
  Fingerprint: 0x8028,
} as const;

/** Class bits of the message type: 0 request, 1 indication, 2 success, 3 error. */
export function stunType(method: number, cls: 0 | 1 | 2 | 3): number {
  return (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
}

function methodOf(type: number): number {
  return (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
}

function classOf(type: number): number {
  return ((type & 0x0010) >> 4) | ((type & 0x0100) >> 7);
}

interface Addr {
  address: string;
  port: number;
}

interface Msg {
  type: number;
  txid: Buffer;
  raw: Buffer;
  /** attribute type → [value offset, value length] (first occurrence) and all XOR-PEER-ADDRESS values. */
  attrs: Map<number, [number, number]>;
  peers: [number, number][];
  /** Offset of the MESSAGE-INTEGRITY attribute header, -1 if absent. */
  miAt: number;
  fpAt: number;
}

function parse(raw: Buffer): Msg | null {
  if (raw.length < 20 || (raw[0]! & 0xc0) !== 0 || raw.readUInt32BE(4) !== MAGIC) return null;
  const len = raw.readUInt16BE(2);
  if ((len & 3) !== 0 || 20 + len > raw.length) return null;
  const m: Msg = { type: raw.readUInt16BE(0), txid: raw.subarray(8, 20), raw: raw.subarray(0, 20 + len), attrs: new Map(), peers: [], miAt: -1, fpAt: -1 };
  let off = 20;
  while (off + 4 <= 20 + len) {
    const t = raw.readUInt16BE(off);
    const l = raw.readUInt16BE(off + 2);
    if (off + 4 + l > 20 + len) return null;
    if (m.fpAt >= 0) return null; // nothing may follow FINGERPRINT
    if (m.miAt >= 0 && t !== Attr.Fingerprint) {
      off += 4 + ((l + 3) & ~3);
      continue; // attributes after MESSAGE-INTEGRITY are ignored (RFC 8489 §14.5)
    }
    if (t === Attr.MessageIntegrity) m.miAt = off;
    else if (t === Attr.Fingerprint) m.fpAt = off;
    if (t === Attr.XorPeerAddress) m.peers.push([off + 4, l]);
    if (!m.attrs.has(t)) m.attrs.set(t, [off + 4, l]);
    off += 4 + ((l + 3) & ~3);
  }
  return off === 20 + len ? m : null;
}

function crc32(b: Uint8Array): number {
  return (zlib as unknown as { crc32: (d: Uint8Array) => number }).crc32(b) >>> 0;
}

function readXor(raw: Buffer, off: number, len: number, txid: Buffer): Addr | null {
  const fam = raw[off + 1];
  const port = raw.readUInt16BE(off + 2) ^ (MAGIC >>> 16);
  if (fam === 1 && len >= 8) {
    const a: number[] = [];
    for (let i = 0; i < 4; i++) a.push(raw[off + 4 + i]! ^ ((MAGIC >>> (24 - 8 * i)) & 0xff));
    return { address: a.join('.'), port };
  }
  if (fam === 2 && len >= 20) {
    const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txid]);
    const g: string[] = [];
    for (let i = 0; i < 8; i++) g.push((((raw[off + 4 + 2 * i]! ^ mask[2 * i]!) << 8) | (raw[off + 5 + 2 * i]! ^ mask[2 * i + 1]!)).toString(16));
    return { address: g.join(':'), port };
  }
  return null;
}

function xorAddrValue(a: Addr, txid: Buffer): Buffer {
  if (isIPv4(a.address)) {
    const v = Buffer.alloc(8);
    v[1] = 1;
    v.writeUInt16BE(a.port ^ (MAGIC >>> 16), 2);
    a.address.split('.').forEach((x, i) => (v[4 + i] = Number(x) ^ ((MAGIC >>> (24 - 8 * i)) & 0xff)));
    return v;
  }
  throw new Error('turn-server: IPv4 only');
}

/** Message builder: attributes, then optional MESSAGE-INTEGRITY and FINGERPRINT. */
class Builder {
  private readonly parts: Buffer[] = [];
  constructor(
    private readonly type: number,
    readonly txid: Buffer,
  ) {}
  add(t: number, v: Buffer): this {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(t, 0);
    h.writeUInt16BE(v.length, 2);
    this.parts.push(h, v, Buffer.alloc((4 - (v.length & 3)) & 3));
    return this;
  }
  u32(t: number, n: number): this {
    const v = Buffer.alloc(4);
    v.writeUInt32BE(n >>> 0);
    return this.add(t, v);
  }
  str(t: number, s: string): this {
    return this.add(t, Buffer.from(s, 'utf8'));
  }
  build(key: Buffer | null, fingerprint = true): Buffer {
    const hdr = Buffer.alloc(20);
    hdr.writeUInt16BE(this.type, 0);
    hdr.writeUInt32BE(MAGIC, 4);
    this.txid.copy(hdr, 8);
    let body = Buffer.concat(this.parts);
    if (key !== null) {
      hdr.writeUInt16BE(body.length + 24, 2);
      const mac = createHmac('sha1', key).update(hdr).update(body).digest();
      const a = Buffer.alloc(24);
      a.writeUInt16BE(Attr.MessageIntegrity, 0);
      a.writeUInt16BE(20, 2);
      mac.copy(a, 4);
      body = Buffer.concat([body, a]);
    }
    if (fingerprint) {
      hdr.writeUInt16BE(body.length + 8, 2);
      const crc = (crc32(Buffer.concat([hdr, body])) ^ 0x5354554e) >>> 0;
      const a = Buffer.alloc(8);
      a.writeUInt16BE(Attr.Fingerprint, 0);
      a.writeUInt16BE(4, 2);
      a.writeUInt32BE(crc, 4);
      body = Buffer.concat([body, a]);
    }
    hdr.writeUInt16BE(body.length, 2);
    return Buffer.concat([hdr, body]);
  }
}

function errorValue(code: number, reason: string): Buffer {
  const r = Buffer.from(reason, 'utf8');
  const v = Buffer.alloc(4 + r.length);
  v[2] = Math.floor(code / 100);
  v[3] = code % 100;
  r.copy(v, 4);
  return v;
}

export interface TurnServerOptions {
  /** Address the listening socket binds (default 127.0.0.1). */
  address?: string;
  /** Address relay sockets bind (default {@link address}). */
  relayAddress?: string;
  port?: number;
  realm?: string;
  /** username → password (default { user: 'pass' }). */
  users?: Record<string, string>;
  /** Default and maximum allocation lifetime in seconds (default 600 / 3600). */
  defaultLifetime?: number;
  maxLifetime?: number;
  /** Permission / channel lifetimes in seconds (default 300 / 600). */
  permissionLifetime?: number;
  channelLifetime?: number;
  /** Log every decision. */
  verbose?: boolean;
  /**
   * Emulates Cloudflare's per-allocation peer limit: an allocation relays for at most this many
   * distinct peer transport addresses (ip:port) over its whole life; Send/ChannelData to and data
   * from any further address are dropped silently and a ChannelBind for one gets 400. 0 = no limit.
   */
  maxPeerAddresses?: number;
}

export interface TurnServerCounters {
  requests: number;
  bindings: number;
  /** 401 (no / bad credentials) answers. */
  unauthorized: number;
  /** 438 Stale Nonce answers. */
  staleNonces: number;
  /** Requests with a bad MESSAGE-INTEGRITY or FINGERPRINT. */
  badIntegrity: number;
  allocations: number;
  /** Refresh requests with a non-zero lifetime. */
  refreshes: number;
  deletes: number;
  permissions: number;
  channels: number;
  sendIndications: number;
  dataIndications: number;
  /** ChannelData client → server (relayed to peers). */
  channelDataIn: number;
  /** ChannelData server → client (from peers). */
  channelDataOut: number;
  /** Peer datagrams dropped for lack of a permission. */
  droppedNoPermission: number;
  /** Client datagrams to a peer without a permission (Send / ChannelData) dropped. */
  droppedSendNoPermission: number;
  /** Allocate requests dropped by {@link TurnServer.dropAllocates}. */
  droppedAllocates: number;
  /** Datagrams dropped / ChannelBinds refused by {@link TurnServerOptions.maxPeerAddresses}. */
  droppedPeerLimit: number;
  /** Errors other than 401/438 sent (code → count). */
  errors: Record<number, number>;
}

interface Allocation {
  client: Addr;
  key: string;
  username: string;
  hmacKey: Buffer;
  relay: Socket;
  relayed: Addr;
  expires: number;
  /** peer IP → expiry (ms). */
  perms: Map<string, number>;
  /** channel number → peer + expiry. */
  channels: Map<number, { peer: Addr; expires: number }>;
  /** `ip:port` of peer → channel. */
  byPeer: Map<string, number>;
  /** `ip:port` of every peer it has relayed for (maxPeerAddresses). */
  peerAddrs: Set<string>;
  /** Transaction id of the Allocate that made it (retransmission → same response). */
  allocTxid: string;
  allocResponse: Buffer;
}

const k = (a: Addr) => `${a.address}:${a.port}`;

export class TurnServer {
  readonly counters: TurnServerCounters = {
    requests: 0,
    bindings: 0,
    unauthorized: 0,
    staleNonces: 0,
    badIntegrity: 0,
    allocations: 0,
    refreshes: 0,
    deletes: 0,
    permissions: 0,
    channels: 0,
    sendIndications: 0,
    dataIndications: 0,
    channelDataIn: 0,
    channelDataOut: 0,
    droppedNoPermission: 0,
    droppedSendNoPermission: 0,
    droppedAllocates: 0,
    droppedPeerLimit: 0,
    errors: {},
  };
  readonly realm: string;
  /** Live allocations by client 5-tuple. */
  readonly allocations = new Map<string, Allocation>();
  /** Nonces issued and still valid. */
  private readonly nonces = new Set<string>();
  /** Next authenticated request with a valid nonce gets 438 (then the flag clears). */
  staleNonce = false;
  /** Drop every datagram (unreachable server). */
  silent = false;
  /** Silently drop this many more Allocate requests (lost / filtered: tests the client's retransmission and fallback). */
  dropAllocates = 0;
  private readonly o: Required<Omit<TurnServerOptions, 'port'>>;
  private sweep: NodeJS.Timeout;
  private closed = false;

  private constructor(
    private readonly sock: Socket,
    readonly address: string,
    readonly port: number,
    o: TurnServerOptions,
  ) {
    this.o = {
      address,
      relayAddress: o.relayAddress ?? address,
      realm: o.realm ?? 'haxlite.test',
      users: { ...(o.users ?? { user: 'pass' }) },
      defaultLifetime: o.defaultLifetime ?? 600,
      maxLifetime: o.maxLifetime ?? 3600,
      permissionLifetime: o.permissionLifetime ?? 300,
      channelLifetime: o.channelLifetime ?? 600,
      verbose: o.verbose ?? false,
      maxPeerAddresses: o.maxPeerAddresses ?? 0,
    };
    this.realm = this.o.realm;
    sock.on('message', (msg, r) => this.onClient(msg, { address: r.address, port: r.port }));
    sock.on('error', () => {});
    this.sweep = setInterval(() => this.expire(), 250);
    this.sweep.unref();
  }

  static async start(o: TurnServerOptions = {}): Promise<TurnServer> {
    const address = o.address ?? '127.0.0.1';
    const sock = await bindUdp(address, o.port ?? 0);
    return new TurnServer(sock, address, sock.address().port, o);
  }

  /** `turn:host:port` (credentials go in username/credential or the URL). */
  get url(): string {
    return `turn:${this.address}:${this.port}`;
  }

  /** `turn:user:pass@host:port` for the first configured user. */
  urlWithCredentials(user = Object.keys(this.o.users)[0]!): string {
    return `turn:${user}:${this.o.users[user]}@${this.address}:${this.port}`;
  }

  private log(...a: unknown[]): void {
    if (this.o.verbose) console.log('[turn]', ...a);
  }

  private send(buf: Buffer, to: Addr): void {
    if (!this.closed) this.sock.send(buf, to.port, to.address);
  }

  // ------------------------------------------------------------ client side

  private onClient(raw: Buffer, from: Addr): void {
    if (this.closed || this.silent || raw.length === 0) return;
    const b0 = raw[0]!;
    if (b0 >= 0x40 && b0 <= 0x4f) {
      this.onChannelData(raw, from);
      return;
    }
    if (b0 > 3) return;
    const m = parse(raw);
    if (m === null) return;
    const cls = classOf(m.type);
    const method = methodOf(m.type);
    if (cls === 1) {
      if (method === Method.Send) this.onSend(m, from);
      return;
    }
    if (cls !== 0) return;
    this.counters.requests++;
    if (m.fpAt >= 0) {
      const crc = (crc32(raw.subarray(0, m.fpAt)) ^ 0x5354554e) >>> 0;
      // the length field already covers FINGERPRINT (it is the last attribute)
      if (raw.readUInt32BE(m.fpAt + 4) !== crc) {
        this.counters.badIntegrity++;
        return; // silently discarded (RFC 8489 §7.3)
      }
    }
    if (method === Method.Binding) {
      this.counters.bindings++;
      this.send(new Builder(stunType(Method.Binding, 2), m.txid).add(Attr.XorMappedAddress, xorAddrValue(from, m.txid)).build(null), from);
      return;
    }
    if (method !== Method.Allocate && method !== Method.Refresh && method !== Method.CreatePermission && method !== Method.ChannelBind) {
      this.error(m, from, 400, 'Bad Request', null);
      return;
    }
    if (method === Method.Allocate && this.dropAllocates > 0) {
      this.dropAllocates--;
      this.counters.droppedAllocates++;
      return;
    }
    const auth = this.authenticate(m, from);
    if (auth === null) return;
    const { username, hmacKey } = auth;
    switch (method) {
      case Method.Allocate:
        this.onAllocate(m, from, username, hmacKey);
        break;
      case Method.Refresh:
        this.onRefresh(m, from, username, hmacKey);
        break;
      case Method.CreatePermission:
        this.onCreatePermission(m, from, username, hmacKey);
        break;
      case Method.ChannelBind:
        this.onChannelBind(m, from, username, hmacKey);
        break;
    }
  }

  private newNonce(): string {
    const n = randomBytes(12).toString('hex');
    this.nonces.add(n);
    return n;
  }

  private challenge(m: Msg, from: Addr, code: 401 | 438, reason: string): void {
    if (code === 401) this.counters.unauthorized++;
    else this.counters.staleNonces++;
    const b = new Builder(stunType(methodOf(m.type), 3), m.txid)
      .add(Attr.ErrorCode, errorValue(code, reason))
      .str(Attr.Realm, this.realm)
      .str(Attr.Nonce, this.newNonce());
    this.send(b.build(null), from);
    this.log(code, reason, k(from));
  }

  /** Long-term credential check; null when a challenge / error was sent. */
  private authenticate(m: Msg, from: Addr): { username: string; hmacKey: Buffer } | null {
    const raw = m.raw;
    const u = m.attrs.get(Attr.Username);
    const r = m.attrs.get(Attr.Realm);
    const n = m.attrs.get(Attr.Nonce);
    if (m.miAt < 0) {
      this.challenge(m, from, 401, 'Unauthorized');
      return null;
    }
    if (u === undefined || r === undefined || n === undefined) {
      this.error(m, from, 400, 'Bad Request', null);
      return null;
    }
    const username = raw.toString('utf8', u[0], u[0] + u[1]);
    const realm = raw.toString('utf8', r[0], r[0] + r[1]);
    const nonce = raw.toString('utf8', n[0], n[0] + n[1]);
    const password = this.o.users[username];
    if (password === undefined || realm !== this.realm) {
      this.challenge(m, from, 401, 'Unauthorized');
      return null;
    }
    const hmacKey = createHash('md5').update(`${username}:${realm}:${password}`).digest();
    // MESSAGE-INTEGRITY over everything before it, with the length set to end right after it
    const hdr = Buffer.from(raw.subarray(0, m.miAt));
    hdr.writeUInt16BE(m.miAt + 24 - 20, 2);
    const mac = createHmac('sha1', hmacKey).update(hdr).digest();
    if (!mac.equals(raw.subarray(m.miAt + 4, m.miAt + 24))) {
      this.counters.badIntegrity++;
      this.challenge(m, from, 401, 'Unauthorized');
      return null;
    }
    if (!this.nonces.has(nonce) || this.staleNonce) {
      this.staleNonce = false;
      this.nonces.delete(nonce);
      this.challenge(m, from, 438, 'Stale Nonce');
      return null;
    }
    return { username, hmacKey };
  }

  private error(m: Msg, from: Addr, code: number, reason: string, key: Buffer | null): void {
    this.counters.errors[code] = (this.counters.errors[code] ?? 0) + 1;
    this.send(new Builder(stunType(methodOf(m.type), 3), m.txid).add(Attr.ErrorCode, errorValue(code, reason)).build(key), from);
    this.log('error', code, reason, k(from));
  }

  private lifetimeOf(m: Msg): number {
    const l = m.attrs.get(Attr.Lifetime);
    const want = l !== undefined && l[1] >= 4 ? m.raw.readUInt32BE(l[0]) : this.o.defaultLifetime;
    if (want === 0) return 0;
    return Math.min(Math.max(want, Math.min(this.o.defaultLifetime, 600)), this.o.maxLifetime);
  }

  private async onAllocate(m: Msg, from: Addr, username: string, hmacKey: Buffer): Promise<void> {
    const existing = this.allocations.get(k(from));
    if (existing !== undefined) {
      if (existing.allocTxid === m.txid.toString('hex')) this.send(existing.allocResponse, from);
      else this.error(m, from, 437, 'Allocation Mismatch', hmacKey);
      return;
    }
    const rt = m.attrs.get(Attr.RequestedTransport);
    if (rt === undefined) {
      this.error(m, from, 400, 'Bad Request', hmacKey);
      return;
    }
    if (m.raw[rt[0]] !== 17) {
      this.error(m, from, 442, 'Unsupported Transport Protocol', hmacKey);
      return;
    }
    const lifetime = this.lifetimeOf(m) || this.o.defaultLifetime;
    const relay = await bindUdp(this.o.relayAddress, 0);
    if (this.closed) {
      relay.close();
      return;
    }
    if (this.allocations.has(k(from))) {
      relay.close(); // a retransmission raced the bind
      const a = this.allocations.get(k(from))!;
      if (a.allocTxid === m.txid.toString('hex')) this.send(a.allocResponse, from);
      return;
    }
    const relayed = { address: this.o.relayAddress, port: relay.address().port };
    const resp = new Builder(stunType(Method.Allocate, 2), m.txid)
      .add(Attr.XorRelayedAddress, xorAddrValue(relayed, m.txid))
      .u32(Attr.Lifetime, lifetime)
      .add(Attr.XorMappedAddress, xorAddrValue(from, m.txid))
      .build(hmacKey);
    const a: Allocation = {
      client: from,
      key: k(from),
      username,
      hmacKey,
      relay,
      relayed,
      expires: Date.now() + lifetime * 1000,
      perms: new Map(),
      channels: new Map(),
      byPeer: new Map(),
      peerAddrs: new Set(),
      allocTxid: m.txid.toString('hex'),
      allocResponse: resp,
    };
    relay.on('message', (msg, r) => this.onPeer(a, msg, { address: r.address, port: r.port }));
    relay.on('error', () => {});
    this.allocations.set(a.key, a);
    this.counters.allocations++;
    this.log('allocate', k(from), '→ relay', k(relayed), `${lifetime}s`);
    this.send(resp, from);
  }

  /** The caller's allocation, or null (437 sent). Also checks the username matches. */
  private allocationFor(m: Msg, from: Addr, username: string, hmacKey: Buffer): Allocation | null {
    const a = this.allocations.get(k(from));
    if (a === undefined) {
      this.error(m, from, 437, 'Allocation Mismatch', hmacKey);
      return null;
    }
    if (a.username !== username) {
      this.error(m, from, 441, 'Wrong Credentials', hmacKey);
      return null;
    }
    return a;
  }

  private onRefresh(m: Msg, from: Addr, username: string, hmacKey: Buffer): void {
    const a = this.allocationFor(m, from, username, hmacKey);
    if (a === null) return;
    const lifetime = this.lifetimeOf(m);
    if (lifetime === 0) {
      this.deleteAllocation(a);
      this.counters.deletes++;
    } else {
      a.expires = Date.now() + lifetime * 1000;
      this.counters.refreshes++;
    }
    this.log('refresh', k(from), `${lifetime}s`);
    this.send(new Builder(stunType(Method.Refresh, 2), m.txid).u32(Attr.Lifetime, lifetime).build(hmacKey), from);
  }

  private onCreatePermission(m: Msg, from: Addr, username: string, hmacKey: Buffer): void {
    const a = this.allocationFor(m, from, username, hmacKey);
    if (a === null) return;
    if (m.peers.length === 0) {
      this.error(m, from, 400, 'Bad Request', hmacKey);
      return;
    }
    const ips: string[] = [];
    for (const [off, len] of m.peers) {
      const p = readXor(m.raw, off, len, m.txid);
      if (p === null || !isIPv4(p.address)) {
        this.error(m, from, 443, 'Peer Address Family Mismatch', hmacKey);
        return;
      }
      ips.push(p.address);
    }
    const until = Date.now() + this.o.permissionLifetime * 1000;
    for (const ip of ips) {
      a.perms.set(ip, until);
      this.counters.permissions++;
    }
    this.log('permission', k(from), ips.join(','));
    this.send(new Builder(stunType(Method.CreatePermission, 2), m.txid).build(hmacKey), from);
  }

  private onChannelBind(m: Msg, from: Addr, username: string, hmacKey: Buffer): void {
    const a = this.allocationFor(m, from, username, hmacKey);
    if (a === null) return;
    const cn = m.attrs.get(Attr.ChannelNumber);
    const pa = m.peers[0];
    const peer = pa === undefined ? null : readXor(m.raw, pa[0], pa[1], m.txid);
    if (cn === undefined || cn[1] < 4 || peer === null) {
      this.error(m, from, 400, 'Bad Request', hmacKey);
      return;
    }
    const ch = m.raw.readUInt16BE(cn[0]);
    if (ch < 0x4000 || ch > 0x4fff) {
      this.error(m, from, 400, 'Bad Request', hmacKey);
      return;
    }
    const cur = a.channels.get(ch);
    const peerCh = a.byPeer.get(k(peer));
    // a channel is bound to one peer and a peer to one channel
    if ((cur !== undefined && k(cur.peer) !== k(peer)) || (peerCh !== undefined && peerCh !== ch)) {
      this.error(m, from, 400, 'Bad Request', hmacKey);
      return;
    }
    if (!this.peerAllowed(a, peer)) {
      this.error(m, from, 400, 'Bad Request', hmacKey);
      return;
    }
    const now = Date.now();
    a.channels.set(ch, { peer, expires: now + this.o.channelLifetime * 1000 });
    a.byPeer.set(k(peer), ch);
    a.perms.set(peer.address, now + this.o.permissionLifetime * 1000);
    if (cur === undefined) this.counters.channels++;
    this.log('channel', k(from), ch.toString(16), '→', k(peer));
    this.send(new Builder(stunType(Method.ChannelBind, 2), m.txid).build(hmacKey), from);
  }

  /** maxPeerAddresses: whether `peer` is (or can become) one of the allocation's peer addresses. */
  private peerAllowed(a: Allocation, peer: Addr): boolean {
    const max = this.o.maxPeerAddresses;
    if (max <= 0) return true;
    const key = k(peer);
    if (a.peerAddrs.has(key)) return true;
    if (a.peerAddrs.size >= max) {
      this.counters.droppedPeerLimit++;
      return false;
    }
    a.peerAddrs.add(key);
    return true;
  }

  private hasPerm(a: Allocation, ip: string): boolean {
    const t = a.perms.get(ip);
    return t !== undefined && t > Date.now();
  }

  private onSend(m: Msg, from: Addr): void {
    const a = this.allocations.get(k(from));
    if (a === undefined) return;
    const pa = m.peers[0];
    const d = m.attrs.get(Attr.Data);
    const peer = pa === undefined ? null : readXor(m.raw, pa[0], pa[1], m.txid);
    if (peer === null || d === undefined) return;
    if (!this.hasPerm(a, peer.address)) {
      this.counters.droppedSendNoPermission++;
      return;
    }
    if (!this.peerAllowed(a, peer)) return;
    this.counters.sendIndications++;
    a.relay.send(m.raw.subarray(d[0], d[0] + d[1]), peer.port, peer.address);
  }

  private onChannelData(raw: Buffer, from: Addr): void {
    if (raw.length < 4) return;
    const a = this.allocations.get(k(from));
    if (a === undefined) return;
    const ch = raw.readUInt16BE(0);
    const len = raw.readUInt16BE(2);
    if (4 + len > raw.length) return;
    const c = a.channels.get(ch);
    if (c === undefined || c.expires <= Date.now()) return;
    if (!this.hasPerm(a, c.peer.address)) {
      this.counters.droppedSendNoPermission++;
      return;
    }
    this.counters.channelDataIn++;
    a.relay.send(raw.subarray(4, 4 + len), c.peer.port, c.peer.address);
  }

  // ------------------------------------------------------------ peer side

  private onPeer(a: Allocation, msg: Buffer, from: Addr): void {
    if (this.closed || this.silent) return;
    if (!this.hasPerm(a, from.address)) {
      this.counters.droppedNoPermission++;
      this.log('drop (no permission)', k(from), '→ relay', k(a.relayed));
      return;
    }
    if (!this.peerAllowed(a, from)) return;
    const ch = a.byPeer.get(k(from));
    const c = ch === undefined ? undefined : a.channels.get(ch);
    if (ch !== undefined && c !== undefined && c.expires > Date.now()) {
      const out = Buffer.allocUnsafe(4 + msg.length);
      out.writeUInt16BE(ch, 0);
      out.writeUInt16BE(msg.length, 2);
      msg.copy(out, 4);
      this.counters.channelDataOut++;
      this.send(out, a.client); // no padding over UDP (RFC 8656 §12.5)
      return;
    }
    this.counters.dataIndications++;
    const txid = randomBytes(12);
    this.send(new Builder(stunType(Method.Data, 1), txid).add(Attr.XorPeerAddress, xorAddrValue(from, txid)).add(Attr.Data, msg).build(null, false), a.client);
  }

  // ------------------------------------------------------------ housekeeping

  private expire(): void {
    const now = Date.now();
    for (const a of [...this.allocations.values()]) {
      if (a.expires <= now) {
        this.log('allocation expired', a.key);
        this.deleteAllocation(a);
        continue;
      }
      for (const [ip, t] of a.perms) if (t <= now) a.perms.delete(ip);
      for (const [ch, c] of a.channels) {
        if (c.expires <= now) {
          a.channels.delete(ch);
          a.byPeer.delete(k(c.peer));
        }
      }
    }
  }

  private deleteAllocation(a: Allocation): void {
    this.allocations.delete(a.key);
    try {
      a.relay.close();
    } catch {
      /* closed */
    }
  }

  /**
   * Sets (or, with null, removes) a user's password: credential rotation.
   * Live allocations keep working only for requests signed with the new key
   * (a Refresh with the old one gets 401, as with time-limited REST credentials).
   */
  setPassword(user: string, password: string | null): void {
    if (password === null) delete this.o.users[user];
    else this.o.users[user] = password;
  }

  /** Relayed transport addresses of the live allocations (`ip:port`). */
  relayedAddresses(): string[] {
    return [...this.allocations.values()].map((a) => k(a.relayed));
  }

  /** Live channels / permissions over all allocations. */
  liveChannels(): number {
    let n = 0;
    for (const a of this.allocations.values()) n += a.channels.size;
    return n;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweep);
    for (const a of [...this.allocations.values()]) this.deleteAllocation(a);
    this.sock.close();
  }
}

function bindUdp(address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(port, address, () => {
      s.off('error', reject);
      resolve(s);
    });
  });
}
