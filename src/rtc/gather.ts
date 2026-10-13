/**
 * Local candidate gathering for a full-ICE {@link RtcEndpoint} (RFC 8445 §5.1):
 *
 * * **host** candidates: the interface addresses of each bound socket (all
 *   addresses of the family for a wildcard bind, else the bind address),
 *   filtered by the {@link CandidatePolicy} (default `'public'`: loopback, LAN,
 *   CGNAT, ULA and link-local addresses are never announced, see docs/08), or
 *   exactly the configured `publicAddresses`;
 * * **server-reflexive** candidates: a STUN Binding request (RFC 8489, no
 *   authentication) from the endpoint's own shared socket to every configured
 *   STUN server; the XOR-MAPPED-ADDRESS is the socket's public address on the
 *   NAT (auto-detection of the public IP). Their `raddr`/`rport` are always
 *   blanked (`0.0.0.0 0`, like browsers) so the private base is never leaked.
 *
 * All sessions of an endpoint share one socket per family, so the srflx
 * candidates are per *endpoint*: gathered once at listen and refreshed lazily
 * (when a session is created and the last result is older than
 * `refreshMs`). Sessions created while a gathering is running get the new
 * candidates trickled (`RtcSession.onLocalCandidate` / `onGatheringComplete`).
 *
 * TURN (`turn:`/`turns:` servers) is not implemented: see docs/10 §7 for the
 * design (one allocation per endpoint, permissions per peer, ChannelData
 * demux on the shared socket); such entries are ignored.
 */
import { lookup } from 'node:dns';
import { randomBytes } from 'node:crypto';
import type { UdpIo } from './udp.js';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { STUN_HEADER, StunAttr, StunType, findAttr, readXorAddress, type StunMessage } from './stun.js';

// ---------------------------------------------------------------- address policy

/** Same classes as `classifyAddress` in src/net/ice.ts (kept local: src/rtc does not depend on src/net). */
export type AddressClass = 'public' | 'private' | 'linklocal' | 'loopback' | 'reserved' | 'invalid';

/** IPv4/IPv6 literal → bytes, or null. */
function ipBytes(address: string): Uint8Array | null {
  const a = address.split('%')[0]!;
  const fam = isIP(a);
  if (fam === 4) return Uint8Array.from(a.split('.').map(Number));
  if (fam !== 6) return null;
  const out = new Uint8Array(16);
  let s = a;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.', lastColon) > lastColon) {
    tail = s.slice(lastColon + 1).split('.').map(Number);
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const dbl = s.indexOf('::');
  const head = (dbl >= 0 ? s.slice(0, dbl) : s).split(':').filter((g) => g !== '');
  const rest = dbl >= 0 ? s.slice(dbl + 2).split(':').filter((g) => g !== '') : [];
  const groups = [...head, ...new Array<string>(8 - head.length - rest.length).fill('0'), ...rest].map((g) => parseInt(g, 16));
  for (let i = 0; i < 8; i++) {
    out[2 * i] = (groups[i]! >>> 8) & 0xff;
    out[2 * i + 1] = groups[i]! & 0xff;
  }
  if (tail.length === 4) out.set(tail, 12);
  return out;
}

export function classifyIp(address: string): AddressClass {
  const b = ipBytes(address);
  if (b === null) return 'invalid';
  if (b.length === 4) {
    const x = b[0]!;
    const y = b[1]!;
    if (x === 127) return 'loopback';
    if (x === 10 || (x === 172 && (y & 0xf0) === 16) || (x === 192 && y === 168) || (x === 100 && (y & 0xc0) === 64)) return 'private';
    if (x === 169 && y === 254) return 'linklocal';
    if (x === 0 || x >= 224) return 'reserved';
    return 'public';
  }
  let zero = true;
  for (let i = 0; i < 15; i++) if (b[i] !== 0) zero = false;
  if (zero && b[15] === 1) return 'loopback';
  if (zero && b[15] === 0) return 'reserved';
  // IPv4-mapped: classify the IPv4 part
  let mapped = b[10] === 0xff && b[11] === 0xff;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) mapped = false;
  if (mapped) return classifyIp(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  if ((b[0]! & 0xfe) === 0xfc) return 'private';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'linklocal';
  if (b[0] === 0xff) return 'reserved';
  return 'public';
}

/**
 * Which local addresses may be announced (mirrors `iceCandidatePolicy` of
 * `HostTransport`, src/net/ice.ts): `'public'` (default) only globally routable
 * ones; `'private'` also RFC 1918 / ULA / CGNAT / link-local; `'all'`
 * everything (loopback included: local tests); or a predicate.
 *
 * The same policy bounds where the agent sends connectivity checks: a remote
 * candidate is checked only if its address class could be announced by us
 * (or is the class of our own bind/announced addresses), so a crafted offer
 * cannot make the host probe its LAN or its own loopback services.
 */
export type CandidatePolicy = 'public' | 'private' | 'all' | ((candidate: { address: string; type: string }) => boolean);

export function policyAllows(policy: CandidatePolicy, address: string, type: string): boolean {
  const cls = classifyIp(address);
  if (cls === 'invalid' || cls === 'reserved') return false;
  if (typeof policy === 'function') {
    try {
      return policy({ address, type }) === true;
    } catch {
      return false;
    }
  }
  if (policy === 'all') return true;
  if (cls === 'public') return true;
  return policy === 'private' && (cls === 'private' || cls === 'linklocal');
}

// ---------------------------------------------------------------- ICE servers

export interface StunServerSpec {
  /** Host name or IP literal. */
  host: string;
  port: number;
}

/**
 * ICE server entries as accepted by `HostTransport` (`iceServers`): a URL
 * string (`stun:host:port`, `turn:…`), node-datachannel's object form or the
 * browser `RTCIceServer` form. Only STUN servers are used (TURN: not
 * implemented, ignored).
 */
export type IceServerInput =
  | string
  | { hostname: string; port: number; username?: string; password?: string; relayType?: string }
  | { urls: string | readonly string[]; username?: string; credential?: string };

const URL_RE = /^(stuns?|turns?):(?:[^@\s]*@)?(\[[^\]]+\]|[^:?\s/]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i;

/** The plain-UDP STUN servers of `list` (`stuns:`, TURN and malformed entries are skipped). */
export function stunServers(list: readonly IceServerInput[] | undefined): StunServerSpec[] {
  const out: StunServerSpec[] = [];
  const add = (url: string) => {
    const m = URL_RE.exec(url.trim());
    if (m === null || m[1]!.toLowerCase() !== 'stun') return;
    const host = m[2]!.replace(/^\[|\]$/g, '');
    const port = m[3] !== undefined ? Number(m[3]) : 3478;
    if (port <= 0 || port > 65535) return;
    if (!out.some((s) => s.host === host && s.port === port)) out.push({ host, port });
  };
  for (const s of list ?? []) {
    if (typeof s === 'string') add(s);
    else if ('urls' in s) for (const u of typeof s.urls === 'string' ? [s.urls] : s.urls) add(u);
    // node-datachannel object form is TURN only
  }
  return out;
}

// ---------------------------------------------------------------- candidates

/** RFC 8445 §5.1.2.1 candidate priority (component 1). */
export function candidatePriority(typePreference: number, localPreference: number): number {
  return (typePreference * 2 ** 24 + localPreference * 2 ** 8 + (256 - 1)) >>> 0;
}

export const TYPE_PREF = { host: 126, prflx: 110, srflx: 100, relay: 0 } as const;

export interface LocalCandidate {
  type: 'host' | 'srflx';
  address: string;
  port: number;
}

/** Candidate lines (no `a=`) for `cands` in preference order. */
export function formatCandidates(cands: readonly LocalCandidate[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    const prio = candidatePriority(TYPE_PREF[c.type], 65535 - i);
    const line = `candidate:${i + 1} 1 udp ${prio} ${c.address} ${c.port} typ ${c.type}`;
    // never reveal the private base of a reflexive candidate (browsers do the same)
    out.push(c.type === 'host' ? `${line} generation 0` : `${line} raddr ${isIP(c.address) === 6 ? '::' : '0.0.0.0'} rport 0 generation 0`);
  }
  return out;
}

/**
 * Host addresses for one bound socket: the bind address itself, or every
 * interface address of its family for a wildcard bind, filtered by `policy`.
 * IPv6 link-local addresses are never used (they need a zone id).
 */
export function hostAddresses(family: 4 | 6, bindAddress: string, policy: CandidatePolicy): string[] {
  const wildcard = bindAddress === '0.0.0.0' || bindAddress === '::';
  const out: string[] = [];
  const consider = (address: string) => {
    if (isIP(address) !== family || out.indexOf(address) >= 0) return;
    if (family === 6 && classifyIp(address) === 'linklocal') return;
    if (policyAllows(policy, address, 'host')) out.push(address);
  };
  if (!wildcard) {
    consider(bindAddress);
    return out;
  }
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] ?? []) {
      if (a.internal && policy !== 'all' && typeof policy !== 'function') continue;
      consider(a.address.split('%')[0]!);
    }
  }
  return out;
}

/** Any non-internal, non-link-local IPv6 interface address (decides whether to bind udp6 by default). */
export function hasGlobalIpv6(): boolean {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] ?? []) {
      if (!a.internal && isIP(a.address.split('%')[0]!) === 6 && classifyIp(a.address) !== 'linklocal') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- STUN transactions

/** Response to a STUN request we sent (the endpoint routes Binding responses by transaction id). */
export type TxnHandler = (m: StunMessage, sock: UdpIo, address: string, port: number) => void;

export interface TxnTable {
  register(txid: string, h: TxnHandler): void;
  unregister(txid: string): void;
}

/** Transaction id bytes → map key. */
export function txidKey(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset + 8, 12).toString('latin1');
}

/** Bare Binding request (header only, RFC 8489 §6: no attributes needed for a server-reflexive query). */
export function bareBindingRequest(): Buffer {
  const b = Buffer.alloc(STUN_HEADER);
  b[1] = StunType.BindingRequest;
  b.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(b, 8);
  return b;
}

/** XOR-MAPPED-ADDRESS (or legacy MAPPED-ADDRESS) of a success response, or null. */
export function mappedAddress(m: StunMessage): { address: string; port: number } | null {
  const tx = m.transactionId();
  let v = findAttr(m, StunAttr.XorMappedAddress);
  if (v >= 0) {
    const fam = m.buf[v + 1];
    if ((fam === 1 && v + 8 <= m.size) || (fam === 2 && v + 20 <= m.size)) {
      const r = readXorAddress(m.buf, v, tx);
      return isIP(r.address) !== 0 ? r : null;
    }
    return null;
  }
  v = findAttr(m, StunAttr.MappedAddress);
  if (v < 0) return null;
  const b = m.buf;
  const port = (b[v + 2]! << 8) | b[v + 3]!;
  if (b[v + 1] === 1 && v + 8 <= m.size) return { address: `${b[v + 4]}.${b[v + 5]}.${b[v + 6]}.${b[v + 7]}`, port };
  if (b[v + 1] === 2 && v + 20 <= m.size) {
    const g: string[] = [];
    for (let i = 0; i < 8; i++) g.push(((b[v + 4 + 2 * i]! << 8) | b[v + 5 + 2 * i]!).toString(16));
    return { address: g.join(':'), port };
  }
  return null;
}

// ---------------------------------------------------------------- gatherer

export interface GathererHost extends TxnTable {
  /** Bound sockets with their family and bind address. */
  readonly sockets: readonly { sock: UdpIo; family: 4 | 6; bindAddress: string }[];
  /** Sends a datagram (IP literal destination). */
  send(sock: UdpIo, buf: Buffer, address: string, port: number): void;
  now(): number;
}

export interface GathererOptions {
  /** Explicit public addresses: announced as-is as host candidates (no interface enumeration). */
  publicAddresses?: readonly string[];
  /** Advertised port of the host candidates (1:1 NAT). */
  publicPort?: number;
  /** The bound port (srflx dedup against host candidates). */
  port: number;
  stunServers: readonly StunServerSpec[];
  policy: CandidatePolicy;
  /** Re-query the STUN servers when a session is created and the last result is older (default 60 000 ms). */
  refreshMs?: number;
  /** Give up on a STUN server after this long (default 1500 ms; retransmits at 0, 250, 750 ms). */
  timeoutMs?: number;
  /** DNS lookup (tests). */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
}

/** Something waiting for a gathering round (a session created while it ran). */
export interface GatherWaiter {
  /** New candidate lines (not yet known to the waiter) and whether gathering is complete. */
  onGathered(lines: readonly string[]): void;
}

const RETRANSMIT_MS = [0, 250, 750];

function defaultLookup(host: string): Promise<{ address: string; family: number }[]> {
  if (isIP(host) !== 0) return Promise.resolve([{ address: host, family: isIP(host) }]);
  return new Promise((resolve) => {
    lookup(host, { all: true }, (err, addrs) => resolve(err ? [] : addrs.slice(0, 4)));
  });
}

export class Gatherer {
  private readonly host: GathererHost;
  private readonly o: GathererOptions;
  private readonly hostCands: LocalCandidate[] = [];
  private srflx: LocalCandidate[] = [];
  /** Current candidate lines (host then srflx). */
  private lines: string[] = [];
  private gathering = false;
  /** End of the last round (ms; 0 = never). */
  private lastDone = 0;
  private closed = false;
  private readonly waiters = new Set<GatherWaiter>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Rounds completed (diagnostics/tests). */
  rounds = 0;
  /** srflx addresses found in the last round (diagnostics: the auto-detected public addresses). */
  mapped: { address: string; port: number }[] = [];

  constructor(host: GathererHost, o: GathererOptions) {
    this.host = host;
    this.o = o;
    if (o.publicAddresses !== undefined && o.publicAddresses.length > 0) {
      const port = o.publicPort ?? o.port;
      for (const address of o.publicAddresses) this.hostCands.push({ type: 'host', address, port });
    } else {
      for (const s of host.sockets) {
        for (const address of hostAddresses(s.family, s.bindAddress, o.policy)) {
          this.hostCands.push({ type: 'host', address, port: o.publicPort ?? o.port });
        }
      }
    }
    this.rebuild();
  }

  /** Whether STUN servers are configured at all. */
  get enabled(): boolean {
    return this.o.stunServers.length > 0;
  }

  get isGathering(): boolean {
    return this.gathering;
  }

  /** Candidate lines known now. */
  candidateLines(): string[] {
    return this.lines.slice();
  }

  /**
   * Candidates for a new session: the current lines and whether they are
   * complete. Starts a refresh round when the last result is stale; register
   * the session with {@link wait} when not complete.
   */
  forSession(): { lines: string[]; complete: boolean } {
    if (this.enabled && !this.gathering && !this.closed) {
      const refresh = this.o.refreshMs ?? 60_000;
      if (this.lastDone === 0 || this.host.now() - this.lastDone > refresh) this.start();
    }
    return { lines: this.lines.slice(), complete: !this.gathering };
  }

  /** `w` gets the result of the running round (no-op when none runs). */
  wait(w: GatherWaiter): void {
    if (this.gathering) this.waiters.add(w);
  }

  /** Resolves when no round is running. */
  whenIdle(): Promise<void> {
    if (!this.gathering) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add({ onGathered: () => resolve() }));
  }

  /** A waiter that no longer cares (session closed). */
  forget(w: GatherWaiter): void {
    this.waiters.delete(w);
  }

  /** Starts a gathering round (no-op while one runs or without STUN servers). */
  start(): void {
    if (this.gathering || this.closed || !this.enabled) return;
    this.gathering = true;
    const found: LocalCandidate[] = [];
    const mapped: { address: string; port: number }[] = [];
    let pending = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.finishRound(found, mapped);
    };
    const doLookup = this.o.lookup ?? defaultLookup;
    pending = this.o.stunServers.length;
    const oneDone = () => {
      if (--pending === 0) finish();
    };
    for (const server of this.o.stunServers) {
      // a hanging resolver (offline host) must not keep the round open: same budget as a query
      let lookupTimer: NodeJS.Timeout | null = null;
      const lookupTimeout = new Promise<{ address: string; family: number }[]>((resolve) => {
        lookupTimer = setTimeout(() => resolve([]), this.o.timeoutMs ?? 1500);
        lookupTimer.unref?.();
      });
      Promise.race([doLookup(server.host), lookupTimeout])
        .finally(() => {
          if (lookupTimer !== null) clearTimeout(lookupTimer);
        })
        .then(
          (addrs) => {
            if (this.closed) return finish();
            for (const a of addrs) {
              const s = this.host.sockets.find((x) => x.family === a.family);
              if (s === undefined) continue;
              pending++;
              this.query(s.sock, a.address, server.port, (r) => {
                if (r !== null && isIP(r.address) !== 0 && r.port > 0) {
                  mapped.push(r);
                  if (!found.some((c) => c.address === r.address && c.port === r.port)) found.push({ type: 'srflx', address: r.address, port: r.port });
                }
                oneDone();
              });
            }
            oneDone();
          },
          () => oneDone(),
        );
    }
  }

  /** One Binding request with retransmissions; `done(null)` on timeout. */
  private query(sock: UdpIo, address: string, port: number, done: (r: { address: string; port: number } | null) => void): void {
    const req = bareBindingRequest();
    const key = txidKey(req);
    let over = false;
    const end = (r: { address: string; port: number } | null) => {
      if (over) return;
      over = true;
      this.host.unregister(key);
      for (const t of local) {
        clearTimeout(t);
        this.timers.delete(t);
      }
      done(r);
    };
    const local: NodeJS.Timeout[] = [];
    this.host.register(key, (m, rsock, raddr, rport) => {
      // the response must come from the server we asked, on the socket we used
      if (rsock !== sock || rport !== port || !sameIp(raddr, address)) return;
      if (m.type === StunType.BindingSuccess) end(mappedAddress(m));
      else end(null);
    });
    const arm = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        fn();
      }, ms);
      t.unref?.();
      this.timers.add(t);
      local.push(t);
    };
    for (const at of RETRANSMIT_MS) arm(at, () => !over && this.host.send(sock, req, address, port));
    arm(this.o.timeoutMs ?? 1500, () => end(null));
  }

  private finishRound(found: LocalCandidate[], mapped: { address: string; port: number }[]): void {
    this.gathering = false;
    this.lastDone = this.host.now();
    this.rounds++;
    if (this.closed) return;
    this.mapped = mapped;
    // a reflexive address equal to a host candidate (public interface, no NAT) is redundant
    const srflx = found.filter((c) => !this.hostCands.some((h) => sameIp(h.address, c.address) && h.port === c.port));
    // keep previously found srflx that this round missed (a lost reply): replaced on the next success
    if (srflx.length > 0 || this.srflx.length === 0) this.srflx = srflx;
    this.rebuild();
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const w of waiters) w.onGathered(this.lines);
  }

  private rebuild(): void {
    this.lines = formatCandidates([...this.hostCands, ...this.srflx]);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const waiters = [...this.waiters];
    this.waiters.clear();
    this.gathering = false;
    for (const w of waiters) w.onGathered(this.lines);
  }
}

function sameIp(a: string, b: string): boolean {
  if (a === b) return true;
  const x = ipBytes(a);
  const y = ipBytes(b);
  if (x === null || y === null || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

export { sameIp };
