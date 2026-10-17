/**
 * TURN client (RFC 8656) for a full-ICE {@link RtcEndpoint}: one allocation
 * per endpoint, made from the endpoint's own shared UDP socket, gives a
 * `relay` candidate shared by every session (docs/10 §2.1).
 *
 * * **Allocate** with the long-term credential mechanism (RFC 8489 §9.2):
 *   the first request goes unauthenticated, the 401 brings REALM and NONCE,
 *   every later request carries USERNAME/REALM/NONCE and MESSAGE-INTEGRITY
 *   keyed with MD5(username:realm:password); a 438 (stale nonce) is retried
 *   with the new nonce, a 437 (allocation mismatch: an allocation of an
 *   earlier process on the same port) is cleared with a zero-lifetime
 *   Refresh first. Refreshed one minute before LIFETIME ends. A failed
 *   Allocate tries the next server of the list at once (e.g. Cloudflare's
 *   port 53 after 3478), then the whole list again with backoff (5 s
 *   doubling to 5 min); a lost allocation is re-made at once.
 * * **Credentials** may be replaced at runtime ({@link TurnRelay.setServers},
 *   short-lived TURN credentials such as Cloudflare's): they apply to the
 *   next Allocate; the current allocation keeps its own until the server
 *   rejects them (401/441 on a Refresh, permission or channel), when it is
 *   dropped and re-made with the new ones.
 * * **Permissions**: CreatePermission for the IP of every remote candidate
 *   a session pairs with the relay (coalesced: one request per microtask),
 *   kept alive (≈ every 4 min) only while traffic flows to/from that IP.
 *   Datagrams to a peer whose permission is still pending are queued (a few
 *   per IP) and leave when it is installed, so the first check needs no RTO.
 * * **Channels**: a ChannelBind for a peer at its first DTLS datagram (the
 *   pair is validated: it will carry the session), after which every
 *   datagram to/from it costs a 4-byte ChannelData header instead of a
 *   ~36-byte Send/Data indication. Rebound while used (which also refreshes
 *   the permission); unused numbers are reused after the RFC cool-down.
 *
 * {@link TurnRelay} is a {@link PacketIo}: ICE pairs, validated addresses
 * and consent checks use it exactly like a socket. Inbound, the endpoint
 * hands every datagram from the TURN server's address to
 * {@link TurnRelay.onServerPacket}, which unwraps ChannelData and Data
 * indications and feeds the inner datagram back into the endpoint's demux
 * with the peer as source (`deliver`).
 *
 * Only UDP to the TURN server and IPv4 relayed addresses: `turns:` and
 * `?transport=tcp` entries are skipped (not supported yet).
 */
import { createHash, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import type { PacketIo } from './udp.js';
import { STUN_HEADER, StunAttr, StunMessage, checkIntegrity, findAttr, finishMessage, parseStun, readXorAddress, writeHeader, writeXorAddress } from './stun.js';

// ---------------------------------------------------------------- protocol constants

export const TurnType = {
  AllocateRequest: 0x0003,
  AllocateSuccess: 0x0103,
  AllocateError: 0x0113,
  RefreshRequest: 0x0004,
  RefreshSuccess: 0x0104,
  RefreshError: 0x0114,
  SendIndication: 0x0016,
  DataIndication: 0x0017,
  CreatePermissionRequest: 0x0008,
  CreatePermissionSuccess: 0x0108,
  CreatePermissionError: 0x0118,
  ChannelBindRequest: 0x0009,
  ChannelBindSuccess: 0x0109,
  ChannelBindError: 0x0119,
} as const;

export const TurnAttr = {
  ChannelNumber: 0x000c,
  Lifetime: 0x000d,
  XorPeerAddress: 0x0012,
  Data: 0x0013,
  Realm: 0x0014,
  Nonce: 0x0015,
  XorRelayedAddress: 0x0016,
  RequestedTransport: 0x0019,
} as const;

export const CHANNEL_MIN = 0x4000;
export const CHANNEL_MAX = 0x4fff;
/** UDP (REQUESTED-TRANSPORT protocol number). */
const PROTO_UDP = 17;

// ---------------------------------------------------------------- servers

export interface TurnServerSpec {
  /** Host name or IP literal. */
  host: string;
  port: number;
  username: string;
  credential: string;
}

/** ICE server entries as accepted by `iceServers` (same shapes as `IceServerInput` in gather.ts). */
export type TurnServerInput =
  | string
  | { hostname: string; port: number; username?: string; password?: string; relayType?: string }
  | { urls: string | readonly string[]; username?: string; credential?: string };

const TURN_URL_RE = /^(turns?):(?:([^@\s]*)@)?(\[[^\]]+\]|[^:?\s/@]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i;

/**
 * The UDP TURN servers of `list` in order: `turn:host[:port][?transport=udp]`
 * URLs (libdatachannel's `turn:user:pass@host:port` form too), browser
 * `{urls, username, credential}` and node-datachannel `{hostname, port,
 * username, password, relayType: 'TurnUdp'}` objects. `turns:`, TCP and
 * malformed entries are skipped (TURN over TCP/TLS is not supported).
 */
export function turnServers(list: readonly TurnServerInput[] | undefined): TurnServerSpec[] {
  const out: TurnServerSpec[] = [];
  const push = (s: TurnServerSpec) => {
    if (s.port <= 0 || s.port > 65535 || s.host === '') return;
    if (!out.some((x) => x.host === s.host && x.port === s.port && x.username === s.username)) out.push(s);
  };
  const fromUrl = (url: string, username: string | undefined, credential: string | undefined) => {
    const m = TURN_URL_RE.exec(url.trim());
    if (m === null || m[1]!.toLowerCase() !== 'turn' || (m[5] ?? 'udp').toLowerCase() !== 'udp') return;
    let user = username;
    let pass = credential;
    if (m[2] !== undefined && m[2] !== '') {
      const c = m[2].indexOf(':');
      const u = decodeURIComponent(c >= 0 ? m[2].slice(0, c) : m[2]);
      const p = c >= 0 ? decodeURIComponent(m[2].slice(c + 1)) : '';
      user ??= u;
      pass ??= p;
    }
    push({ host: m[3]!.replace(/^\[|\]$/g, ''), port: m[4] !== undefined ? Number(m[4]) : 3478, username: user ?? '', credential: pass ?? '' });
  };
  for (const s of list ?? []) {
    if (typeof s === 'string') fromUrl(s, undefined, undefined);
    else if ('urls' in s) for (const u of typeof s.urls === 'string' ? [s.urls] : s.urls) fromUrl(u, s.username, s.credential);
    else if (s.relayType === undefined || s.relayType === 'TurnUdp') {
      push({ host: s.hostname, port: s.port, username: s.username ?? '', credential: s.password ?? '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- codec

/** Long-term credential key (RFC 8489 §9.2.2): MD5(username ":" realm ":" password), no SASLprep (ASCII). */
export function longTermKey(username: string, realm: string, password: string): Buffer {
  return createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

export interface TurnAuth {
  username: string;
  realm: string;
  nonce: string;
  key: Uint8Array;
}

/** An attribute to encode: [type, value]. */
export type TurnAttrValue = [number, Uint8Array];

function u32(v: number): Uint8Array {
  return Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

/** XOR-PEER-ADDRESS / XOR-RELAYED-ADDRESS value for `address:port` under `txid`. */
export function xorAddressValue(address: string, port: number, txid: Uint8Array): Uint8Array {
  const v = new Uint8Array(20);
  const n = writeXorAddress(v, 0, address, port, txid);
  return v.subarray(0, n);
}

/**
 * A TURN request or indication: header, `attrs`, then (with `auth`)
 * USERNAME/REALM/NONCE + MESSAGE-INTEGRITY, then FINGERPRINT. A new buffer.
 */
export function buildTurnMessage(type: number, txid: Uint8Array, attrs: readonly TurnAttrValue[], auth: TurnAuth | null): Buffer {
  const all: TurnAttrValue[] = [...attrs];
  if (auth !== null) {
    all.push([StunAttr.Username, Buffer.from(auth.username, 'utf8')], [TurnAttr.Realm, Buffer.from(auth.realm, 'utf8')], [TurnAttr.Nonce, Buffer.from(auth.nonce, 'utf8')]);
  }
  let size = STUN_HEADER + 24 + 8;
  for (const [, v] of all) size += 4 + ((v.length + 3) & ~3);
  const out = Buffer.alloc(size);
  writeHeader(out, type, txid);
  let p = STUN_HEADER;
  for (const [t, v] of all) {
    out[p] = t >>> 8;
    out[p + 1] = t & 0xff;
    out[p + 2] = v.length >>> 8;
    out[p + 3] = v.length & 0xff;
    out.set(v, p + 4);
    p += 4 + ((v.length + 3) & ~3);
  }
  return out.subarray(0, finishMessage(out, p, auth === null ? null : auth.key));
}

/** ERROR-CODE of a parsed message (0 if none). */
export function stunErrorCode(m: StunMessage): number {
  const v = findAttr(m, StunAttr.ErrorCode);
  if (v < 0 || v + 4 > m.size) return 0;
  return (m.buf[v + 2]! & 7) * 100 + m.buf[v + 3]!;
}

/** A string attribute (REALM, NONCE…) as UTF-8, or null. */
export function stringAttr(m: StunMessage, type: number): string | null {
  const v = findAttr(m, type);
  if (v < 0) return null;
  const len = (m.buf[v - 2]! << 8) | m.buf[v - 1]!;
  return Buffer.from(m.buf.buffer, m.buf.byteOffset + v, len).toString('utf8');
}

/** An XOR-*-ADDRESS attribute, or null when absent/malformed. */
export function xorAddressAttr(m: StunMessage, type: number): { address: string; port: number } | null {
  const v = findAttr(m, type);
  if (v < 0) return null;
  const len = (m.buf[v - 2]! << 8) | m.buf[v - 1]!;
  const fam = m.buf[v + 1];
  if (!((fam === 1 && len >= 8) || (fam === 2 && len >= 20)) || v + len > m.size) return null;
  return readXorAddress(m.buf, v, m.transactionId());
}

/** LIFETIME in seconds, or -1. */
export function lifetimeAttr(m: StunMessage): number {
  const v = findAttr(m, TurnAttr.Lifetime);
  if (v < 0 || v + 4 > m.size) return -1;
  return ((m.buf[v]! << 24) | (m.buf[v + 1]! << 16) | (m.buf[v + 2]! << 8) | m.buf[v + 3]!) >>> 0;
}

/** Writes a ChannelData header for `length` payload bytes at out[0..4). */
export function writeChannelHeader(out: Uint8Array, channel: number, length: number): void {
  out[0] = channel >>> 8;
  out[1] = channel & 0xff;
  out[2] = length >>> 8;
  out[3] = length & 0xff;
}

/** A ChannelData message: channel and payload bounds, or null when malformed (padding after the payload is tolerated). */
export function parseChannelData(buf: Uint8Array): { channel: number; offset: number; length: number } | null {
  if (buf.length < 4) return null;
  const channel = (buf[0]! << 8) | buf[1]!;
  if (channel < CHANNEL_MIN || channel > CHANNEL_MAX) return null;
  const length = (buf[2]! << 8) | buf[3]!;
  if (4 + length > buf.length) return null;
  return { channel, offset: 4, length };
}

// ---------------------------------------------------------------- relay

const RETRANSMIT_MS = [0, 250, 750];
const TXN_TIMEOUT_MS = 1500;
/** Refresh the allocation this long before LIFETIME ends (and at least every 9 min). */
const REFRESH_MARGIN_S = 60;
/** Permissions last 300 s, channels 600 s (RFC 8656 §9, §12): renewed at these ages while used. */
const PERMISSION_REFRESH_MS = 240_000;
const CHANNEL_REFRESH_MS = 480_000;
/** A channel number can be bound to another peer only this long after its last use (600 s lifetime + 300 s, §12). */
const CHANNEL_REUSE_MS = 900_000;
const MAINTENANCE_MS = 15_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 300_000;
/** Datagrams queued per IP while its CreatePermission is in flight. */
const PENDING_PER_PERMISSION = 4;
/** Caps: distinct peer IPs with permissions, distinct peers (ip:port). */
const MAX_PERMISSIONS = 4096;
const MAX_PEERS = 8192;
/** XOR-PEER-ADDRESS entries per CreatePermission. */
const PEERS_PER_PERMISSION_REQUEST = 32;

export type TurnState = 'idle' | 'allocating' | 'allocated' | 'failed' | 'closed';

export interface TurnStats {
  /** `host:port` of the TURN server in use. */
  server: string;
  state: TurnState;
  /** The relayed transport address (`ip:port`), null when not allocated. */
  relayed: string | null;
  allocations: number;
  allocationFailures: number;
  refreshes: number;
  permissions: number;
  channels: number;
  /** Datagrams/bytes relayed to and from peers (payload, without TURN framing). */
  packetsOut: number;
  bytesOut: number;
  packetsIn: number;
  bytesIn: number;
  /** Sent as Send indications (before a channel is bound) / as ChannelData. */
  sendIndications: number;
  channelDataOut: number;
  /** Datagrams to peers dropped: no allocation, caps, permission queue full or permission refused. */
  dropped: number;
  /** Distinct peer transport addresses (ip:port) this allocation has exchanged data with. */
  peerAddresses: number;
  /** The server refused a ChannelBind with 400: treated as out of peer addresses. */
  full: boolean;
  /** Allocations in the endpoint's pool (1 for a single TurnRelay). */
  pool: number;
}

export interface TurnRelayHost {
  /** The endpoint socket the allocation is made from. */
  io: PacketIo;
  /** Its family (the TURN server is resolved to this family). */
  family: 4 | 6;
  now(): number;
  /** An unwrapped datagram from a peer, to be demultiplexed with `relay` as the receiving socket. */
  deliver(relay: TurnRelay, msg: Buffer, address: string, port: number): void;
  /** The allocation was made or lost (relay candidate changed). */
  onChange?(relay: TurnRelay): void;
  /** Counts datagrams the relay itself sends to the server (TURN framing, control messages). */
  countOut?(bytes: number): void;
  /** DNS lookup of the TURN server (tests). */
  lookup?: (host: string, family: 4 | 6) => Promise<string[]>;
  /**
   * Report the allocation's XOR-MAPPED-ADDRESS as {@link TurnRelay.mapped} (default true). False for an
   * allocation made from a socket of its own: that address is not the endpoint socket's reflexive one.
   */
  reportMapped?: boolean;
}

interface Permission {
  installed: boolean;
  /** CreatePermission in flight (or queued for the next flush). */
  pending: boolean;
  /** When it was last installed/refreshed (ms). */
  at: number;
  /** Traffic since the last refresh decision. */
  used: boolean;
  /** Datagrams waiting for the permission ([copy, port]). */
  queue: [Buffer, number][] | null;
}

interface Peer {
  address: string;
  port: number;
  /** Bound channel number (0 = none). */
  channel: number;
  /** ChannelBind in flight. */
  binding: boolean;
  /** When the channel was last bound/refreshed (ms). */
  boundAt: number;
  used: boolean;
}

interface Txn {
  type: number;
  /** Credentials it was sent with (null: unauthenticated). */
  auth: TurnAuth | null;
  attrs: readonly TurnAttrValue[];
  buf: Buffer;
  key: string;
  timers: NodeJS.Timeout[];
  done: (m: StunMessage | null) => void;
  /** Auth retries left (401 / 438). */
  retries: number;
}

function defaultLookup(host: string, family: 4 | 6): Promise<string[]> {
  if (isIP(host) !== 0) return Promise.resolve(isIP(host) === family ? [host] : []);
  return new Promise((resolve) => {
    dnsLookup(host, { all: true, family }, (err, addrs) => resolve(err ? [] : addrs.map((a) => a.address)));
  });
}

function txKey(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset + 8, 12).toString('latin1');
}

/** One TURN allocation (see the file comment). */
export class TurnRelay implements PacketIo {
  /** Family of the relayed address (always IPv4: no REQUESTED-ADDRESS-FAMILY). */
  readonly family = 4 as const;
  readonly host: TurnRelayHost;
  private servers: readonly TurnServerSpec[];
  private serverIndex = 0;
  /** Servers tried in the current round of Allocate attempts. */
  private tried = 0;
  /** Resolved TURN server address / port (null until resolved). */
  serverAddress: string | null = null;
  serverPort = 0;
  state: TurnState = 'idle';
  /** XOR-RELAYED-ADDRESS (null when not allocated). */
  relayed: { address: string; port: number } | null = null;
  /** XOR-MAPPED-ADDRESS of the allocation (our socket's public address as the TURN server sees it). */
  mapped: { address: string; port: number } | null = null;
  private auth: TurnAuth | null = null;
  private lifetimeS = 600;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** The server (and credentials) of the current allocation attempt / allocation. */
  private current: TurnServerSpec;
  private readonly txns = new Map<string, Txn>();
  private readonly perms = new Map<string, Permission>();
  /** address → port → peer. */
  private readonly peers = new Map<string, Map<number, Peer>>();
  private peerCount = 0;
  /** channel - CHANNEL_MIN → peer. */
  private readonly channels: (Peer | undefined)[] = [];
  private nextChannel = CHANNEL_MIN;
  /** Released channel numbers and when they were last used. */
  /** Released channel numbers (still bound at the server until their lifetime ends: inbound ChannelData on them is still the old peer's). */
  private readonly freeChannels: { n: number; at: number; address: string; port: number }[] = [];
  private permFlush = false;
  private readonly permQueue: string[] = [];
  private waiters: ((ok: boolean) => void)[] = [];
  private maintenance: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  /** Outgoing framing scratch (replaced if the socket keeps a reference: see UdpIo.send). */
  private scratch: Buffer = Buffer.allocUnsafeSlow(2048);
  /** Exact-length views of {@link scratch} (≤ 1536 bytes), so a send builds no view per datagram. */
  private views: (Buffer | undefined)[] = [];
  private readonly msg = new StunMessage();
  /**
   * Peer transport addresses (`ip|port`) this allocation has sent to or received from. Some servers
   * (Cloudflare) only relay for a handful of distinct peer addresses per allocation over its whole
   * life: the endpoint spreads sessions over several allocations by this count (endpoint.ts).
   */
  private readonly seen = new Set<string>();
  /** A ChannelBind was refused with 400 (the server's per-allocation peer limit): take no new peers. */
  full = false;
  private readonly counters = {
    allocations: 0,
    allocationFailures: 0,
    refreshes: 0,
    packetsOut: 0,
    bytesOut: 0,
    packetsIn: 0,
    bytesIn: 0,
    sendIndications: 0,
    channelDataOut: 0,
    dropped: 0,
  };

  constructor(host: TurnRelayHost, servers: readonly TurnServerSpec[]) {
    if (servers.length === 0) throw new Error('TurnRelay: no TURN server');
    this.host = host;
    this.servers = servers;
    this.current = servers[0]!;
  }

  /** The allocation is usable (relay pairs may be formed). */
  get ready(): boolean {
    return this.state === 'allocated';
  }

  private get server(): TurnServerSpec {
    return this.servers[this.serverIndex]!;
  }

  /**
   * Makes the allocation if there is none; `done(ok)` when it is made or
   * the attempt failed (at once when already allocated or closed).
   */
  allocate(done?: (ok: boolean) => void): void {
    if (this.state === 'allocated' || this.state === 'closed') {
      done?.(this.state === 'allocated');
      return;
    }
    if (done !== undefined) this.waiters.push(done);
    if (this.state === 'allocating') return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.state = 'allocating';
    const spec = (this.current = this.server);
    (this.host.lookup ?? defaultLookup)(spec.host, this.host.family).then(
      (addrs) => this.onResolved(addrs),
      () => this.onResolved([]),
    );
  }

  private onResolved(addrs: string[]): void {
    if (this.state !== 'allocating') return;
    if (addrs.length === 0) {
      this.allocationFailed();
      return;
    }
    this.serverAddress = addrs[0]!;
    this.serverPort = this.current.port;
    this.auth = null;
    this.sendAllocate(true);
  }

  private sendAllocate(clearMismatch: boolean): void {
    this.request(TurnType.AllocateRequest, [[TurnAttr.RequestedTransport, Uint8Array.of(PROTO_UDP, 0, 0, 0)]], (m) => {
      if (this.state !== 'allocating') return;
      if (m !== null && m.type === TurnType.AllocateSuccess) {
        const relayed = xorAddressAttr(m, TurnAttr.XorRelayedAddress);
        if (relayed === null || isIP(relayed.address) !== 4) {
          this.allocationFailed();
          return;
        }
        this.relayed = relayed;
        this.mapped = this.host.reportMapped === false ? null : xorAddressAttr(m, StunAttr.XorMappedAddress);
        const lt = lifetimeAttr(m);
        this.lifetimeS = lt > 0 ? lt : 600;
        this.scheduleRefresh();
        this.state = 'allocated';
        this.retryMs = RETRY_MIN_MS;
        this.tried = 0;
        this.counters.allocations++;
        this.armMaintenance();
        this.resolveWaiters(true);
        this.host.onChange?.(this);
        return;
      }
      if (m !== null && stunErrorCode(m) === 437 && clearMismatch && this.auth !== null) {
        // an allocation of ours from an earlier run on this 5-tuple: delete it, then allocate again
        this.request(TurnType.RefreshRequest, [[TurnAttr.Lifetime, u32(0)]], () => {
          if (this.state === 'allocating') this.sendAllocate(false);
        });
        return;
      }
      this.allocationFailed();
    });
  }

  private allocationFailed(): void {
    this.counters.allocationFailures++;
    this.serverIndex = (this.serverIndex + 1) % this.servers.length;
    if (++this.tried < this.servers.length) {
      // another server of the list right away (waiters keep waiting)
      this.state = 'idle';
      this.allocate();
      return;
    }
    this.tried = 0;
    this.state = 'failed';
    this.resolveWaiters(false);
    this.scheduleRetry();
  }

  /**
   * Replaces the TURN servers / credentials. The current allocation is kept
   * (it is refreshed with the credentials it was made with until the server
   * refuses them); a failed or missing one is retried at once with the new list.
   */
  setServers(servers: readonly TurnServerSpec[]): void {
    if (servers.length === 0 || this.state === 'closed') return;
    this.servers = servers;
    this.serverIndex = 0;
    this.tried = 0;
    // same server: its new credentials are used by the current allocation's next request
    const cur = this.current;
    const same = servers.find((s) => s.host === cur.host && s.port === cur.port);
    if (same !== undefined) this.current = same;
    if (this.state === 'failed') {
      this.retryMs = RETRY_MIN_MS;
      this.allocate();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.state === 'closed') return;
    const t = setTimeout(() => {
      this.retryTimer = null;
      if (this.state === 'failed') this.allocate();
    }, this.retryMs);
    t.unref?.();
    this.retryTimer = t;
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
  }

  private resolveWaiters(ok: boolean): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f(ok);
  }

  /** The allocation is gone (refresh failed, credentials refused): forget peers, tell the endpoint, allocate again. */
  private lost(): void {
    if (this.state !== 'allocated') return;
    this.reset();
    this.state = 'idle';
    this.auth = null;
    this.counters.allocationFailures++;
    this.host.onChange?.(this);
    this.allocate();
  }

  private reset(): void {
    this.relayed = null;
    this.seen.clear();
    this.full = false;
    this.perms.clear();
    this.peers.clear();
    this.peerCount = 0;
    this.channels.length = 0;
    this.freeChannels.length = 0;
    this.nextChannel = CHANNEL_MIN;
    this.permQueue.length = 0;
    if (this.maintenance !== null) clearInterval(this.maintenance);
    this.maintenance = null;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Refresh one minute before LIFETIME ends (halfway for lifetimes under 2 min). */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    const lt = this.lifetimeS;
    const t = setTimeout(() => {
      this.refreshTimer = null;
      if (this.state !== 'allocated') return;
      this.request(TurnType.RefreshRequest, [[TurnAttr.Lifetime, u32(600)]], (m) => {
        if (this.state !== 'allocated') return;
        if (m !== null && m.type === TurnType.RefreshSuccess) {
          this.counters.refreshes++;
          const v = lifetimeAttr(m);
          if (v > 0) this.lifetimeS = v;
          this.scheduleRefresh();
        } else this.lost();
      });
    }, (lt >= 120 ? Math.min(lt - REFRESH_MARGIN_S, 540) : lt / 2) * 1000);
    t.unref?.();
    this.refreshTimer = t;
  }

  // ------------------------------------------------------------ transactions

  /**
   * Sends a request (authenticated once the server asked for it), retransmitted
   * at 0/250/750 ms; `done(null)` after 1.5 s without a response. 401 and 438
   * are answered by a retry with the new REALM/NONCE.
   */
  private request(type: number, attrs: readonly TurnAttrValue[], done: (m: StunMessage | null) => void, retries = 2): void {
    if (this.serverAddress === null || this.state === 'closed') {
      done(null);
      return;
    }
    const buf = buildTurnMessage(type, randomBytes(12), attrs, this.auth);
    const tx: Txn = { type, auth: this.auth, attrs, buf, key: txKey(buf), timers: [], done, retries };
    this.txns.set(tx.key, tx);
    for (const at of RETRANSMIT_MS) {
      const t = setTimeout(() => this.sendRaw(buf), at);
      t.unref?.();
      tx.timers.push(t);
    }
    const t = setTimeout(() => this.endTxn(tx, null), TXN_TIMEOUT_MS);
    t.unref?.();
    tx.timers.push(t);
  }

  private endTxn(tx: Txn, m: StunMessage | null): void {
    if (this.txns.get(tx.key) !== tx) return;
    this.txns.delete(tx.key);
    for (const t of tx.timers) clearTimeout(t);
    tx.done(m);
  }

  private sendRaw(buf: Buffer): void {
    if (this.serverAddress === null || this.state === 'closed') return;
    this.host.countOut?.(buf.length);
    try {
      this.host.io.send(buf, this.serverPort, this.serverAddress); // a fresh buffer per message: may be kept
    } catch {
      /* socket closed */
    }
  }

  private onResponse(m: StunMessage): void {
    const tx = this.txns.get(txKey(m.buf));
    if (tx === undefined) return;
    const isError = (m.type & 0x0110) === 0x0110;
    if (isError) {
      const code = stunErrorCode(m);
      if ((code === 401 || code === 438) && tx.retries > 0) {
        const realm = stringAttr(m, TurnAttr.Realm) ?? tx.auth?.realm ?? null;
        const nonce = stringAttr(m, TurnAttr.Nonce);
        if (realm !== null && nonce !== null) {
          const s = this.current;
          const key = longTermKey(s.username, realm, s.credential);
          const used = tx.auth;
          // retry only with something new (first challenge, new nonce, new credentials): a plain wrong password fails at once
          if (used === null || code === 438 || used.nonce !== nonce || used.realm !== realm || used.username !== s.username || !key.equals(used.key)) {
            this.auth = { username: s.username, realm, nonce, key };
            this.txns.delete(tx.key);
            for (const t of tx.timers) clearTimeout(t);
            this.request(tx.type, tx.attrs, tx.done, tx.retries - 1);
            return;
          }
        }
      }
      if (tx.type !== TurnType.AllocateRequest && (code === 401 || code === 441) && this.state === 'allocated') {
        // the allocation's credentials are no longer accepted (expired short-lived credentials): make a new one
        this.endTxn(tx, m);
        this.lost();
        return;
      }
    } else if (m.integrityOffset >= 0 && (this.auth === null || !checkIntegrity(m, this.auth.key))) {
      return; // a success that does not authenticate: not from the server (wait for the real one)
    }
    this.endTxn(tx, m);
  }

  // ------------------------------------------------------------ inbound

  /**
   * A datagram from the TURN server's address on our socket. Returns false
   * when it is not TURN (e.g. a Binding response: the server doubles as a
   * STUN server), so the endpoint demultiplexes it as usual.
   */
  onServerPacket(msg: Buffer): boolean {
    const b0 = msg[0]!;
    if (b0 >= 0x40 && b0 <= 0x4f) {
      if (msg.length < 4) return true;
      const len = (msg[2]! << 8) | msg[3]!;
      const n = (b0 << 8) | msg[1]!;
      const peer = this.channels[n - CHANNEL_MIN];
      if (4 + len > msg.length || this.state !== 'allocated') return true;
      if (peer === undefined) {
        // a channel we released that the server still has bound (≤ 10 min): still that peer's
        const f = this.freeChannels.find((x) => x.n === n);
        if (f === undefined) return true;
        const c = this.counters;
        c.packetsIn++;
        c.bytesIn += len;
        this.host.deliver(this, msg.subarray(4, 4 + len), f.address, f.port);
        return true;
      }
      peer.used = true;
      const c = this.counters;
      c.packetsIn++;
      c.bytesIn += len;
      this.host.deliver(this, msg.subarray(4, 4 + len), peer.address, peer.port);
      return true;
    }
    if (b0 >= 4) return false;
    const m = this.msg;
    if (!parseStun(msg, m)) return false;
    const type = m.type;
    if (type === TurnType.DataIndication) {
      if (this.state !== 'allocated') return true;
      const peer = xorAddressAttr(m, TurnAttr.XorPeerAddress);
      const v = findAttr(m, TurnAttr.Data);
      if (peer === null || v < 0) return true;
      const len = (msg[v - 2]! << 8) | msg[v - 1]!;
      if (v + len > m.size) return true;
      const perm = this.perms.get(peer.address);
      if (perm === undefined) return true; // never asked for: the server should not have relayed it
      perm.used = true;
      const ports = this.peers.get(peer.address);
      const p = ports === undefined ? undefined : ports.get(peer.port);
      if (p !== undefined) p.used = true;
      else this.see(peer.address, peer.port);
      const c = this.counters;
      c.packetsIn++;
      c.bytesIn += len;
      this.host.deliver(this, msg.subarray(v, v + len), peer.address, peer.port);
      return true;
    }
    const method = type & 0x3eef;
    if ((type & 0x0100) !== 0 && (method === 0x0003 || method === 0x0004 || method === 0x0008 || method === 0x0009)) {
      this.onResponse(m);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ outbound

  /** Asks for a permission for `address` (an IPv4 literal the ICE policy allows) unless there is one. */
  permit(address: string): void {
    if (this.state !== 'allocated' || isIP(address) !== 4) return;
    const p = this.perms.get(address);
    if (p !== undefined) {
      p.used = true;
      return;
    }
    if (this.perms.size >= MAX_PERMISSIONS) return;
    this.perms.set(address, { installed: false, pending: true, at: 0, used: true, queue: null });
    this.queuePermission(address);
  }

  private queuePermission(address: string): void {
    this.permQueue.push(address);
    if (this.permFlush) return;
    this.permFlush = true;
    queueMicrotask(() => {
      this.permFlush = false;
      while (this.permQueue.length > 0) this.sendPermissions(this.permQueue.splice(0, PEERS_PER_PERMISSION_REQUEST));
    });
  }

  private sendPermissions(ips: string[]): void {
    if (this.state !== 'allocated') return;
    const txid = randomBytes(12);
    // XOR-PEER-ADDRESS is XORed with the transaction id only for IPv6; ports are ignored by the server
    const attrs: TurnAttrValue[] = ips.map((ip) => [TurnAttr.XorPeerAddress, xorAddressValue(ip, 0, txid)]);
    this.request(TurnType.CreatePermissionRequest, attrs, (m) => {
      const ok = m !== null && m.type === TurnType.CreatePermissionSuccess;
      const now = this.host.now();
      for (const ip of ips) {
        const p = this.perms.get(ip);
        if (p === undefined) continue;
        p.pending = false;
        if (ok) {
          p.installed = true;
          p.at = now;
          const q = p.queue;
          p.queue = null;
          if (q !== null) for (const [b, port] of q) this.send(b, port, ip);
        } else {
          if (p.queue !== null) this.counters.dropped += p.queue.length;
          p.queue = null;
          // refused or no answer: forget it unless it was installed (a refresh that failed keeps it until it expires)
          if (!p.installed) this.forgetIp(ip);
        }
      }
    });
  }

  /**
   * Sends `buf` to the peer `address:port` through the relay: ChannelData
   * once a channel is bound, else a Send indication. The buffer is copied
   * (the caller may reuse it at once): always returns true.
   */
  send(buf: Uint8Array, port: number, address: string): boolean {
    if (this.state !== 'allocated') {
      this.counters.dropped++;
      return true;
    }
    let ports = this.peers.get(address);
    let peer = ports === undefined ? undefined : ports.get(port);
    if (peer === undefined) {
      if (this.peerCount >= MAX_PEERS || isIP(address) !== 4) {
        this.counters.dropped++;
        return true;
      }
      if (ports === undefined) {
        ports = new Map();
        this.peers.set(address, ports);
      }
      peer = { address, port, channel: 0, binding: false, boundAt: 0, used: false };
      ports.set(port, peer);
      this.peerCount++;
      this.see(address, port);
    }
    peer.used = true;
    const c = this.counters;
    if (peer.channel !== 0 && !peer.binding) {
      const len = buf.length;
      let out = this.scratch;
      if (out.length < len + 4) {
        this.replaceScratch(Math.max(len + 4, 2 * out.length));
        out = this.scratch;
      }
      writeChannelHeader(out, peer.channel, len);
      out.set(buf, 4);
      c.packetsOut++;
      c.bytesOut += len;
      c.channelDataOut++;
      this.emit(out, len + 4);
      return true;
    }
    let perm = this.perms.get(address);
    if (perm === undefined) {
      this.permit(address);
      perm = this.perms.get(address);
      if (perm === undefined) {
        c.dropped++;
        return true;
      }
    }
    perm.used = true;
    if (!perm.installed) {
      const q = (perm.queue ??= []);
      if (q.length < PENDING_PER_PERMISSION) q.push([Buffer.from(buf), port]);
      else c.dropped++;
      return true;
    }
    // the pair carries DTLS: worth a channel (4-byte framing from now on)
    if (peer.channel === 0 && buf.length > 0 && buf[0]! >= 20 && buf[0]! <= 63) this.bindChannel(peer);
    this.sendIndication(buf, port, address);
    return true;
  }

  private sendIndication(buf: Uint8Array, port: number, address: string): void {
    const len = buf.length;
    const size = STUN_HEADER + 12 + 4 + ((len + 3) & ~3);
    let out = this.scratch;
    if (out.length < size) {
      this.replaceScratch(Math.max(size, 2 * out.length));
      out = this.scratch;
    }
    // header with a random-enough transaction id (indications are never answered)
    out[0] = 0x00;
    out[1] = 0x16;
    out[2] = (size - STUN_HEADER) >>> 8;
    out[3] = (size - STUN_HEADER) & 0xff;
    out.writeUInt32BE(0x2112a442, 4);
    out.writeUInt32BE((Math.random() * 0x100000000) >>> 0, 8);
    out.writeUInt32BE((Math.random() * 0x100000000) >>> 0, 12);
    out.writeUInt32BE((Math.random() * 0x100000000) >>> 0, 16);
    out[20] = 0x00;
    out[21] = 0x12;
    out[22] = 0;
    out[23] = 8;
    writeXorAddress(out, 24, address, port, out.subarray(8, 20));
    out[32] = 0x00;
    out[33] = 0x13;
    out[34] = len >>> 8;
    out[35] = len & 0xff;
    out.set(buf, 36);
    for (let i = 36 + len; i < size; i++) out[i] = 0;
    const c = this.counters;
    c.packetsOut++;
    c.bytesOut += len;
    c.sendIndications++;
    this.emit(out, size);
  }

  private emit(out: Buffer, size: number): void {
    if (this.serverAddress === null) return;
    this.host.countOut?.(size);
    let sent: boolean;
    try {
      const view = size === out.length ? out : size <= 1536 ? (this.views[size] ??= out.subarray(0, size)) : out.subarray(0, size);
      sent = this.host.io.send(view, this.serverPort, this.serverAddress);
    } catch {
      return; // socket closed
    }
    // queued by the kernel/runtime with a reference to the scratch: never overwrite it
    if (!sent) this.replaceScratch(this.scratch.length);
  }

  private replaceScratch(size: number): void {
    this.scratch = Buffer.allocUnsafeSlow(size);
    this.views = [];
  }

  private takeChannel(): number {
    const now = this.host.now();
    const f = this.freeChannels;
    if (f.length > 0 && now - f[0]!.at >= CHANNEL_REUSE_MS) return f.shift()!.n;
    if (this.nextChannel <= CHANNEL_MAX) return this.nextChannel++;
    return 0;
  }

  private bindChannel(peer: Peer): void {
    if (peer.binding) return;
    const isNew = peer.channel === 0;
    let n = peer.channel;
    if (isNew) {
      // the server may still have this peer on a number we released: binding another one would be refused (400)
      const f = this.freeChannels;
      const i = f.findIndex((x) => x.port === peer.port && x.address === peer.address);
      n = i >= 0 ? f.splice(i, 1)[0]!.n : this.takeChannel();
    }
    if (n === 0) return; // all numbers in use: Send indications
    peer.channel = n;
    peer.binding = isNew; // a rebind keeps using the channel meanwhile
    if (isNew) this.channels[n - CHANNEL_MIN] = peer;
    const txid = randomBytes(12);
    const attrs: TurnAttrValue[] = [
      [TurnAttr.ChannelNumber, Uint8Array.of(n >>> 8, n & 0xff, 0, 0)],
      [TurnAttr.XorPeerAddress, xorAddressValue(peer.address, peer.port, txid)],
    ];
    this.request(TurnType.ChannelBindRequest, attrs, (m) => {
      if (this.channels[n - CHANNEL_MIN] !== peer) return; // allocation reset meanwhile
      peer.binding = false;
      if (m !== null && m.type === TurnType.ChannelBindSuccess) {
        const now = this.host.now();
        peer.boundAt = now;
        const perm = this.perms.get(peer.address);
        if (perm !== undefined && perm.installed) perm.at = now; // a ChannelBind refreshes the permission too
        return;
      }
      // 400 to a bind we expect to be valid: the server's peer limit for this allocation (Cloudflare)
      if (m !== null && (m.type & 0x0110) === 0x0110 && stunErrorCode(m) === 400) this.full = true;
      if (isNew) this.releaseChannel(peer); // Send indications instead
    });
  }

  private releaseChannel(peer: Peer): void {
    const n = peer.channel;
    if (n === 0) return;
    peer.channel = 0;
    peer.binding = false;
    this.channels[n - CHANNEL_MIN] = undefined;
    this.freeChannels.push({ n, at: this.host.now(), address: peer.address, port: peer.port });
  }

  // ------------------------------------------------------------ maintenance

  private armMaintenance(): void {
    if (this.maintenance !== null) return;
    const t = setInterval(() => this.maintain(), MAINTENANCE_MS);
    t.unref?.();
    this.maintenance = t;
  }

  private maintain(): void {
    if (this.state !== 'allocated') return;
    const now = this.host.now();
    // channels: rebind used ones, release idle ones
    for (let i = 0; i < this.channels.length; i++) {
      const p = this.channels[i];
      if (p === undefined) continue;
      // ChannelData never touches the permission: a busy channel keeps its permission in use
      // (otherwise it is forgotten ~8 min in, with the channel, and inbound ChannelData is dropped)
      if (p.used) {
        const perm = this.perms.get(p.address);
        if (perm !== undefined) perm.used = true;
      }
      if (p.binding || now - p.boundAt < CHANNEL_REFRESH_MS) continue;
      if (p.used) {
        p.used = false;
        this.bindChannel(p);
      } else this.releaseChannel(p);
    }
    // permissions: refresh used ones, forget idle ones (and their peers)
    const refresh: string[] = [];
    for (const [ip, p] of this.perms) {
      if (!p.installed || p.pending || now - p.at < PERMISSION_REFRESH_MS) continue;
      if (p.used) {
        p.used = false;
        p.pending = true;
        refresh.push(ip);
      } else this.forgetIp(ip);
    }
    for (let i = 0; i < refresh.length; i += PEERS_PER_PERMISSION_REQUEST) this.sendPermissions(refresh.slice(i, i + PEERS_PER_PERMISSION_REQUEST));
  }

  /** Distinct peer transport addresses used so far (see {@link seen}). */
  get peerAddresses(): number {
    return this.seen.size;
  }

  private see(address: string, port: number): void {
    if (this.seen.size < MAX_PEERS) this.seen.add(address + '|' + port);
  }

  /** Drops the permission for `ip` and its peers (their channels are released). */
  private forgetIp(ip: string): void {
    this.perms.delete(ip);
    const ports = this.peers.get(ip);
    if (ports === undefined) return;
    for (const peer of ports.values()) this.releaseChannel(peer);
    this.peerCount -= ports.size;
    this.peers.delete(ip);
  }

  stats(): TurnStats {
    const s = this.current;
    let channels = 0;
    for (const p of this.channels) if (p !== undefined && p.channel !== 0) channels++;
    return {
      server: `${s.host}:${s.port}`,
      state: this.state,
      relayed: this.relayed === null ? null : `${this.relayed.address}:${this.relayed.port}`,
      ...this.counters,
      permissions: this.perms.size,
      channels,
      peerAddresses: this.seen.size,
      full: this.full,
      pool: 1,
    };
  }

  /** Deletes the allocation (best effort: one zero-lifetime Refresh, not retransmitted) and stops every timer. */
  close(): void {
    if (this.state === 'closed') return;
    if (this.state === 'allocated' && this.auth !== null) {
      this.sendRaw(buildTurnMessage(TurnType.RefreshRequest, randomBytes(12), [[TurnAttr.Lifetime, u32(0)]], this.auth));
    }
    this.reset();
    this.state = 'closed';
    for (const tx of this.txns.values()) for (const t of tx.timers) clearTimeout(t);
    this.txns.clear();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.resolveWaiters(false);
  }
}
