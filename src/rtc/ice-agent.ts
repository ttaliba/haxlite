/**
 * Full ICE (RFC 8445) for haxlite-rtc, **controlled** role: the browser
 * always offers, so it is the controlling agent and nominates; we send our
 * own connectivity checks so that our NAT/firewall opens a pinhole towards
 * every remote candidate (and the browser learns our peer-reflexive address
 * when our server-reflexive one is unusable), we answer theirs, and once the
 * session is up we keep sending consent-freshness checks (RFC 7675).
 *
 * Two classes:
 *
 * * {@link IceScheduler}: one per endpoint. STUN transaction table (Binding
 *   responses are routed here by transaction id — gathering uses it too),
 *   pacing timer (only runs while some session has checks to send: no timer
 *   in steady state), a global token bucket for checks (amplification
 *   bound) and the rules for which remote addresses may be checked.
 * * {@link IceAgent}: one per session. The check list: one pair per
 *   (socket, remote candidate) — every local candidate of an endpoint shares
 *   one socket per family, so after RFC 8445 §6.1.2.4 pruning (srflx replaced
 *   by its base) a remote candidate gives exactly one pair. Pairs are ordered
 *   by the RFC 8445 §6.1.2.3 priority (we are D, the remote is G); with a
 *   single component and data stream all pairs start Waiting (no frozen
 *   foundations). Triggered checks (§7.3.1.4) for authenticated requests on
 *   pairs that have not succeeded, peer-reflexive remote candidates learned
 *   from them (§7.3.1.3), symmetric-address validation of responses
 *   (§7.2.5.2.1), MESSAGE-INTEGRITY with the remote password and FINGERPRINT
 *   on every response.
 *
 * TURN (turn.ts): with an allocation, every public IPv4 remote candidate
 * gets a second pair whose "socket" is the relay (a {@link PacketIo} that
 * wraps datagrams in ChannelData / Send indications), local type `relay`
 * in the pair priority, so it is checked after the direct pairs. The
 * relay's permission for the remote IP is requested when the pair is made.
 * Relay-only (`iceTransportPolicy: 'relay'`): no direct pairs at all.
 *
 * Nomination (RFC 8445 §7.3.1.5): a USE-CANDIDATE request nominates its
 * pair once OUR check on it has succeeded — at once when it already has,
 * otherwise when the triggered check it causes does. The request's
 * MESSAGE-INTEGRITY only proves the sender knows our password, which every
 * joining client does: its source address could be spoofed (session.ts).
 *
 * Deviation, deliberate and documented in docs/10:
 *
 * * **Role conflicts**: we never take the controlling role. A request with
 *   ICE-CONTROLLED is answered 487 whatever the tie-breakers (the peer then
 *   switches to controlling, §7.2.5.1); a 487 to one of our checks just
 *   retries it later. A peer that implements RFC 8445 converges; an ICE-lite
 *   peer (never a HaxBall client) cannot connect.
 */
import type { PacketIo, UdpIo } from './udp.js';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { classifyIp, policyAllows, candidatePriority, sameIp, txidKey, TYPE_PREF, type CandidatePolicy, type TxnHandler, type TxnTable, type AddressClass } from './gather.js';
import { StunAttr, StunType, buildBindingRequest, checkFingerprint, checkIntegrity, findAttr, type StunKey, type StunMessage } from './stun.js';
import type { ParsedCandidate } from './sdp.js';

/** Pacing of new checks per session (RFC 8445 Ta). */
export const CHECK_INTERVAL_MS = 20;
/** Transmissions of one check transaction (first + retransmissions) and the initial RTO. */
const TX_PER_CHECK = 5;
const INITIAL_RTO_MS = 200;
/** Caps: transmissions per pair, per session; pairs per session. */
const MAX_TX_PER_PAIR = 15;
const MAX_TX_PER_SESSION = 120;
export const MAX_PAIRS = 16;
/** With a TURN allocation (relay pairs next to the direct ones). */
const MAX_TX_PER_SESSION_RELAY = 180;
export const MAX_PAIRS_RELAY = 24;
/**
 * Once the session is connected, check transmissions (triggered checks for
 * NAT rebindings, and their retransmissions) draw from a refilling
 * allowance instead of the lifetime {@link MAX_TX_PER_SESSION}: per second
 * and burst, per session (the global budget of the scheduler still applies).
 */
const CONNECTED_TX_RATE = 4;
const CONNECTED_TX_BURST = 10;
/** Consent freshness (RFC 7675 §5.1): one check every 5 s ± 20 %. */
const CONSENT_MIN_MS = 4000;
const CONSENT_JITTER_MS = 2000;

export interface BoundSocket {
  sock: UdpIo;
  family: 4 | 6;
  bindAddress: string;
}

/** A TURN allocation as the ICE agent sees it (turn.ts `TurnRelay`). */
export interface RelayIo extends PacketIo {
  /** Allocated: relay pairs may be formed. */
  readonly ready: boolean;
  /** Requests a permission for a remote IPv4 address. */
  permit(address: string): void;
}

export interface IceSchedulerOptions {
  /** Sends one datagram to an IP literal (synchronous, counted by the endpoint). */
  send(sock: PacketIo, buf: Buffer, address: string, port: number): void;
  now(): number;
  sockets: readonly BoundSocket[];
  /** Candidate policy of the endpoint (bounds the check destinations). */
  policy: CandidatePolicy;
  /** Address classes of our own announced/bound addresses (always checkable). */
  ownClasses?: readonly AddressClass[];
  /** Global check budget: tokens per second and bucket size (default 300/s, 150). */
  checkRate?: number;
  checkBurst?: number;
  /** TURN allocations (relay pairs for public IPv4 remote candidates). */
  relays?: readonly RelayIo[];
  /** Relay pairs only (`iceTransportPolicy: 'relay'`): never a direct pair. */
  relayOnly?: boolean;
}

export interface IceStats {
  /** Connectivity-check transmissions (incl. retransmissions). */
  checksSent: number;
  checksSucceeded: number;
  checksFailed: number;
  /** Check transmissions deferred by the global budget. */
  checksThrottled: number;
  consentSent: number;
  consentAnswered: number;
  /** Remote candidates ignored (mDNS, TCP, non-allowed address class, caps). */
  remoteIgnored: number;
}

/** Endpoint-wide ICE state: transaction table, pacing timer, check budget, destination rules. */
export class IceScheduler implements TxnTable {
  private readonly txns = new Map<string, TxnHandler>();
  private readonly active = new Set<IceAgent>();
  private timer: NodeJS.Timeout | null = null;
  private tokens: number;
  private refillAt: number;
  private readonly rate: number;
  private readonly burst: number;
  private closed = false;
  readonly o: IceSchedulerOptions;
  /** Pairs per session and check transmissions per session before connecting (higher with TURN). */
  readonly maxPairs: number;
  readonly maxTxPerSession: number;
  readonly stats: IceStats = { checksSent: 0, checksSucceeded: 0, checksFailed: 0, checksThrottled: 0, consentSent: 0, consentAnswered: 0, remoteIgnored: 0 };

  constructor(o: IceSchedulerOptions) {
    this.o = o;
    this.rate = o.checkRate ?? 300;
    this.burst = o.checkBurst ?? 150;
    this.tokens = this.burst;
    this.refillAt = o.now();
    const relay = (o.relays?.length ?? 0) > 0;
    this.maxPairs = relay ? MAX_PAIRS_RELAY : MAX_PAIRS;
    this.maxTxPerSession = relay ? MAX_TX_PER_SESSION_RELAY : MAX_TX_PER_SESSION;
  }

  /** Whether `sock` is one of the TURN allocations. */
  isRelay(sock: PacketIo): boolean {
    const r = this.o.relays;
    if (r === undefined) return false;
    for (let i = 0; i < r.length; i++) if (r[i] === sock) return true;
    return false;
  }

  /**
   * Whether the relays may send to `address`: IPv4 (relayed addresses are
   * IPv4) of a class the policy lets us check ({@link allowed}: with the
   * default policy, public addresses only — the TURN server is never asked to
   * reach private networks), whichever socket could reach it directly.
   */
  relayable(address: string): boolean {
    return isIP(address) === 4 && this.allowed(address);
  }

  register(txid: string, h: TxnHandler): void {
    this.txns.set(txid, h);
  }

  unregister(txid: string): void {
    this.txns.delete(txid);
  }

  /** A Binding success/error response: routed to its transaction. False when none matches. */
  onResponse(m: StunMessage, sock: PacketIo, address: string, port: number): boolean {
    const h = this.txns.get(txidKey(m.buf));
    if (h === undefined) return false;
    h(m, sock, address, port);
    return true;
  }

  /**
   * The socket to check `address` from, or null when we must not / cannot:
   * invalid, reserved (multicast, unspecified…), a class we would not
   * announce (loopback, LAN…) unless it is the class of our own addresses,
   * or unreachable from the bound address (loopback ⇄ non-loopback).
   */
  socketFor(address: string): UdpIo | null {
    if (!this.allowed(address)) return null;
    const fam = isIP(address);
    const cls = classifyIp(address);
    for (const s of this.o.sockets) {
      if (s.family !== fam) continue;
      const wildcard = s.bindAddress === '0.0.0.0' || s.bindAddress === '::';
      if (!wildcard && (classifyIp(s.bindAddress) === 'loopback') !== (cls === 'loopback')) continue;
      return s.sock;
    }
    return null;
  }

  /** Whether checks may be sent to `address` at all (its class; see {@link socketFor}). */
  allowed(address: string): boolean {
    if (isIP(address) === 0) return false;
    const cls = classifyIp(address);
    if (cls === 'invalid' || cls === 'reserved') return false;
    if (cls !== 'public' && !(this.o.ownClasses ?? []).includes(cls)) {
      if (cls === 'loopback' ? this.o.policy !== 'all' : !policyAllows(this.o.policy, address, 'remote')) return false;
    }
    return true;
  }

  /** One unit of the global check budget (false: try again on a later tick). */
  takeToken(): boolean {
    const now = this.o.now();
    if (now > this.refillAt) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.refillAt) * this.rate) / 1000);
      this.refillAt = now;
    }
    if (this.tokens < 1) {
      this.stats.checksThrottled++;
      return false;
    }
    this.tokens--;
    return true;
  }

  /** The agent has checks to send: tick it until it says it is done. */
  activate(a: IceAgent): void {
    if (this.closed) return;
    this.active.add(a);
    if (this.timer === null) {
      const t = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
      t.unref?.();
      this.timer = t;
      // first checks right away (offer candidates are known before the answer leaves)
      queueMicrotask(() => this.tick());
    }
  }

  deactivate(a: IceAgent): void {
    this.active.delete(a);
  }

  private tick(): void {
    const now = this.o.now();
    for (const a of this.active) {
      if (!a.tick(now)) this.active.delete(a);
    }
    if (this.active.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.active.clear();
    this.txns.clear();
  }
}

/** What an agent needs from its session. */
export interface IceAgentOwner {
  readonly localUfrag: string;
  readonly remoteUfrag: string;
  /** The remote ICE password (key of the MESSAGE-INTEGRITY of our checks and of their responses). */
  readonly remoteKey: StunKey;
  /** One of our checks on (sock, address, port) succeeded: the pair is valid (DTLS may flow there; `address` as the kernel reports it). */
  onCheckSucceeded(sock: PacketIo, address: string, port: number): void;
  /** One of our consent checks on the selected pair was answered (RFC 7675). */
  onConsent(): void;
  /** Our check on (sock, address, port) failed (timeout, error, non-symmetric, budget): it does not validate the address. */
  onCheckFailed?(sock: PacketIo, address: string, port: number): void;
}

const WAITING = 0;
const IN_PROGRESS = 1;
const SUCCEEDED = 2;
const FAILED = 3;

interface Pair {
  sock: PacketIo;
  address: string;
  port: number;
  /** Sort key: RFC 8445 §6.1.2.3 pair priority (as a double: only the order matters). */
  prio: number;
  state: number;
  /** Transmissions on this pair so far. */
  sent: number;
  /** In the triggered queue. */
  triggered: boolean;
  /** Learned from a request (peer-reflexive), not from a signaled candidate. */
  learned: boolean;
  /** Skipped by the ordinary check loop (evicted from the session's validated set): only a request triggers a check. */
  parked: boolean;
  tx: Transaction | null;
}

interface Transaction {
  key: string;
  buf: Buffer;
  /** Transmissions so far. */
  n: number;
  nextAt: number;
  rto: number;
}

/** Our priority as seen by the remote (PRIORITY attribute: a peer-reflexive candidate, §7.1.1). */
const PRFLX_PRIORITY = candidatePriority(TYPE_PREF.prflx, 65535);
/** Our side of the pair priority (every direct pair's local candidate is the socket's base host candidate). */
const LOCAL_PRIORITY = candidatePriority(TYPE_PREF.host, 65535);
/** Our side for a relay pair (the relayed candidate). */
const RELAY_PRIORITY = candidatePriority(TYPE_PREF.relay, 65535);

function pairPriority(remote: number, local = LOCAL_PRIORITY): number {
  // we are controlled: G = remote, D = local
  const g = remote;
  const d = local;
  return Math.min(g, d) * 2 ** 32 + Math.max(g, d) * 2 + (g > d ? 1 : 0);
}

export class IceAgent {
  private readonly s: IceScheduler;
  private readonly owner: IceAgentOwner;
  /** Check list, highest priority first. */
  readonly pairs: Pair[] = [];
  private readonly queue: Pair[] = [];
  private readonly username: string;
  private readonly tie: Buffer = randomBytes(8);
  private nextCheckAt = 0;
  /** Ordinary checks allowed (false once the session is connected). */
  private checking = true;
  private closed = false;
  private sentTotal = 0;
  /** Connected: transmissions allowed now (refilled at {@link CONNECTED_TX_RATE}) and when it was last refilled. */
  private allowance = CONNECTED_TX_BURST;
  private allowanceAt = 0;
  private consentKey: string | null = null;
  private nextConsentAt = 0;
  /** IP the signaling server saw the peer connect from: the relays get a permission for it too. */
  private hintIp: string | null = null;
  /**
   * The TURN allocations this session uses (its relay candidates): a subset of the scheduler's
   * relays when the endpoint spreads sessions over several allocations; null: all of them.
   */
  private readonly relays: RelayIo[] | null;

  constructor(scheduler: IceScheduler, owner: IceAgentOwner, relays?: readonly RelayIo[]) {
    this.s = scheduler;
    this.owner = owner;
    this.username = `${owner.remoteUfrag}:${owner.localUfrag}`;
    this.relays = relays !== undefined ? relays.slice() : null;
  }

  private myRelays(): readonly RelayIo[] | undefined {
    return this.relays ?? this.s.o.relays;
  }

  /** Also use `relay` (its candidate reached the peer later, e.g. at the end of a gathering round). */
  adoptRelay(relay: RelayIo): void {
    if (this.relays !== null && this.relays.indexOf(relay) < 0) this.relays.push(relay);
  }

  /** A remote candidate from the offer or trickled through signaling. */
  addRemote(c: ParsedCandidate): void {
    if (this.closed) return;
    const st = this.s.stats;
    if (c.transport !== 'udp' || c.component !== 1 || c.port <= 0) {
      st.remoteIgnored++;
      return;
    }
    const address = c.address;
    const sock = this.s.socketFor(address); // null for mDNS names, TCP-only families, non-allowed classes
    let added = false;
    if (sock !== null && this.s.o.relayOnly !== true && this.pairs.length < this.s.maxPairs) {
      if (this.find(sock, address, c.port) !== null) return;
      this.insert(sock, address, c.port, c.priority >>> 0);
      added = true;
    }
    if (this.addRelayPairs(address, c.port, c.priority >>> 0)) added = true;
    if (!added) {
      st.remoteIgnored++;
      return;
    }
    if (this.checking) this.s.activate(this);
  }

  /** Pairs on every ready relay for a remote candidate (and the relay's permission for its IP). */
  private addRelayPairs(address: string, port: number, priority: number): boolean {
    const relays = this.myRelays();
    if (relays === undefined || !this.s.relayable(address)) return false;
    let added = false;
    for (const r of relays) {
      if (!r.ready || this.pairs.length >= this.s.maxPairs || this.find(r, address, port) !== null) continue;
      r.permit(address);
      this.insert(r, address, port, priority, RELAY_PRIORITY);
      added = true;
    }
    return added;
  }

  /**
   * The IP the peer reached the signaling server from: a relay permission
   * for it up front (its NAT may use that address towards the TURN server
   * while its candidates show another one, or only mDNS names).
   */
  hintRemoteIp(address: string): void {
    if (this.closed || !this.s.relayable(address)) return;
    this.hintIp = address;
    const relays = this.myRelays();
    if (relays !== undefined) for (const r of relays) if (r.ready) r.permit(address);
  }

  /**
   * A relay became ready after the session's candidates arrived (relay-only
   * sessions wait for the allocation): pairs and permissions for them now.
   */
  relaysReady(remotes: readonly ParsedCandidate[]): void {
    if (this.closed) return;
    if (this.hintIp !== null) this.hintRemoteIp(this.hintIp);
    let added = false;
    for (const c of remotes) {
      if (c.transport !== 'udp' || c.component !== 1 || c.port <= 0) continue;
      if (this.addRelayPairs(c.address, c.port, c.priority >>> 0)) added = true;
    }
    if (added && this.checking) this.s.activate(this);
  }

  /**
   * An authenticated Binding request from (sock, address, port), already
   * answered by the session. Learns a peer-reflexive remote candidate and
   * queues a triggered check unless the pair already succeeded.
   */
  onRequest(sock: PacketIo, address: string, port: number, priority: number): void {
    if (this.closed) return;
    let p = this.find(sock, address, port);
    if (p === null) {
      if (this.pairs.length >= this.s.maxPairs && !this.evictForLearned()) return;
      p = this.insert(sock, address, port, priority >>> 0, this.s.isRelay(sock) ? RELAY_PRIORITY : LOCAL_PRIORITY);
      p.learned = true;
    }
    p.parked = false;
    const tx = p.tx;
    if (p.state === IN_PROGRESS && tx !== null) {
      // RFC 8445 §7.3.1.4: retransmit the in-progress check at once and reset its timer. Typical
      // case: our first check left before the peer had our answer (it could not answer it); the
      // peer's request says it has it now — waiting for the 200 ms RTO would delay the join.
      if (tx.n < TX_PER_CHECK) {
        if (p.sent < MAX_TX_PER_PAIR && (!this.checking || this.sentTotal < this.s.maxTxPerSession) && this.transmit(p, tx)) {
          tx.rto = INITIAL_RTO_MS;
          tx.nextAt = this.s.o.now() + INITIAL_RTO_MS;
        }
        return;
      }
      this.endTx(p); // its transmissions are used up: a new triggered check instead (below)
      p.state = WAITING;
    }
    if (p.state === SUCCEEDED || p.state === IN_PROGRESS || p.triggered) return;
    if (p.sent >= MAX_TX_PER_PAIR) return;
    p.state = WAITING;
    p.triggered = true;
    this.queue.push(p);
    this.s.activate(this);
  }

  /**
   * The session no longer trusts (sock, address, port) (its 5-tuple went to
   * another session, or it was evicted): a succeeded pair goes back to
   * Waiting so that the next request from there triggers a new check.
   */
  recheck(sock: PacketIo, address: string, port: number): void {
    const p = this.find(sock, address, port);
    if (p !== null && p.state === SUCCEEDED) p.state = WAITING;
  }

  /**
   * The session evicted (sock, address, port) from its validated set for
   * capacity: like {@link recheck}, but the ordinary check loop leaves it
   * alone (re-checking it would only evict another address in turn) — only
   * a new request from there triggers a check.
   */
  park(sock: PacketIo, address: string, port: number): void {
    const p = this.find(sock, address, port);
    if (p === null) return;
    p.parked = true;
    if (p.state === SUCCEEDED) p.state = WAITING;
  }

  /**
   * The check list is full and a request came from a new address: frees the
   * slot of a pair that is neither in progress, queued nor succeeded —
   * failed before waiting, signaled before learned, lowest priority first.
   * Otherwise (e.g. 16+ signaled candidates, the client behind a symmetric
   * NAT) the address the client really uses could never be checked, hence
   * never validated. False when every pair is in use.
   */
  private evictForLearned(): boolean {
    let best = -1;
    let bestRank = -1;
    for (let i = 0; i < this.pairs.length; i++) {
      const q = this.pairs[i]!;
      if (q.tx !== null || q.triggered || (q.state !== FAILED && q.state !== WAITING)) continue;
      const rank = (q.state === FAILED ? 2 : 0) + (q.learned ? 0 : 1);
      if (rank >= bestRank) {
        // the list is sorted by priority: on a tie the later (lower-priority) pair goes
        best = i;
        bestRank = rank;
      }
    }
    if (best < 0) return false;
    this.pairs.splice(best, 1);
    return true;
  }

  /** The session is connected (DTLS up): no new ordinary checks; triggered ones and consent go on. */
  connected(now: number): void {
    this.checking = false;
    this.allowance = CONNECTED_TX_BURST;
    this.allowanceAt = now;
    this.nextConsentAt = now + CONSENT_MIN_MS + Math.random() * CONSENT_JITTER_MS;
  }

  /** Scheduler tick: retransmissions, then at most one new check. Returns whether more ticks are needed. */
  tick(now: number): boolean {
    if (this.closed) return false;
    let busy = false;
    for (const p of this.pairs) {
      const tx = p.tx;
      if (tx === null) continue;
      busy = true;
      if (now < tx.nextAt) continue;
      if (tx.n >= TX_PER_CHECK) {
        this.endTx(p);
        this.fail(p);
        continue;
      }
      if (!this.transmit(p, tx)) continue;
      tx.rto *= 2;
      tx.nextAt = now + tx.rto;
    }
    if (now >= this.nextCheckAt && (!this.checking || this.sentTotal < this.s.maxTxPerSession)) {
      let p: Pair | null = null;
      while (this.queue.length > 0) {
        const q = this.queue.shift()!;
        q.triggered = false;
        if (q.state === WAITING && q.tx === null) {
          p = q;
          break;
        }
      }
      if (p === null && this.checking) {
        for (const q of this.pairs) {
          if (q.state === WAITING && q.tx === null && !q.parked) {
            p = q;
            break;
          }
        }
      }
      if (p !== null) {
        if (this.startCheck(p, now)) this.nextCheckAt = now + CHECK_INTERVAL_MS;
        else if (!p.triggered) {
          p.triggered = true; // throttled: retry first on the next tick
          this.queue.unshift(p);
        }
        busy = true;
      }
    }
    if (busy) return true;
    if (this.checking && this.sentTotal >= this.s.maxTxPerSession) {
      // budget spent before connecting: nothing queued can leave; stop ticking (a request reactivates us)
      for (const q of this.queue) q.triggered = false;
      this.queue.length = 0;
      return false;
    }
    if (this.queue.length > 0) return true;
    if (!this.checking) return false;
    return this.pairs.some((q) => q.state === WAITING && !q.parked);
  }

  private startCheck(p: Pair, now: number): boolean {
    if (p.sent >= MAX_TX_PER_PAIR) {
      this.fail(p);
      return true;
    }
    const buf = buildBindingRequest({
      txid: randomBytes(12),
      username: this.username,
      key: this.owner.remoteKey,
      priority: PRFLX_PRIORITY,
      controlled: true,
      tieBreaker: this.tie,
    });
    const tx: Transaction = { key: txidKey(buf), buf, n: 0, nextAt: now + INITIAL_RTO_MS, rto: INITIAL_RTO_MS };
    if (!this.transmit(p, tx)) return false;
    p.state = IN_PROGRESS;
    p.tx = tx;
    this.s.register(tx.key, (m, sock, address, port) => this.onCheckResponse(p, tx, m, sock, address, port));
    return true;
  }

  private transmit(p: Pair, tx: Transaction): boolean {
    if (!this.checking) {
      // connected: a refilling allowance, so that NAT rebindings stay checkable for the whole session
      const now = this.s.o.now();
      if (now > this.allowanceAt) {
        this.allowance = Math.min(CONNECTED_TX_BURST, this.allowance + ((now - this.allowanceAt) * CONNECTED_TX_RATE) / 1000);
        this.allowanceAt = now;
      }
      if (this.allowance < 1) return false;
    }
    if (!this.s.takeToken()) return false;
    if (!this.checking) this.allowance--;
    tx.n++;
    p.sent++;
    this.sentTotal++;
    this.s.stats.checksSent++;
    this.s.o.send(p.sock, tx.buf, p.address, p.port);
    return true;
  }

  private endTx(p: Pair): void {
    const tx = p.tx;
    if (tx === null) return;
    p.tx = null;
    this.s.unregister(tx.key);
  }

  private onCheckResponse(p: Pair, tx: Transaction, m: StunMessage, sock: PacketIo, address: string, port: number): void {
    if (this.closed || p.tx !== tx) return;
    // authenticate first: a forged response must not end the transaction
    if (!checkFingerprint(m) || !checkIntegrity(m, this.owner.remoteKey)) return;
    this.endTx(p);
    if (sock !== p.sock || port !== p.port || !sameIp(address, p.address)) {
      this.fail(p); // non-symmetric (RFC 8445 §7.2.5.2.1)
      return;
    }
    if (m.type === StunType.BindingSuccess) {
      p.state = SUCCEEDED;
      this.s.stats.checksSucceeded++;
      this.owner.onCheckSucceeded(p.sock, address, p.port);
      return;
    }
    if (errorCode(m) === 487) {
      // role conflict: we stay controlled (see the header); the peer switches on our 487s
      p.state = WAITING;
      if (!p.triggered && p.sent < MAX_TX_PER_PAIR) {
        p.triggered = true;
        this.queue.push(p);
        this.s.activate(this);
      }
      return;
    }
    this.fail(p);
  }

  private fail(p: Pair): void {
    p.state = FAILED;
    this.s.stats.checksFailed++;
    this.owner.onCheckFailed?.(p.sock, p.address, p.port);
  }

  /**
   * Consent freshness (endpoint 1 Hz sweep, open sessions): one Binding
   * request on the selected pair every 5 s ± 20 %; an authenticated,
   * symmetric success refreshes consent (`owner.onConsent`).
   */
  consentTick(now: number, sock: PacketIo | null, address: string, port: number): void {
    if (this.closed || this.checking || sock === null || now < this.nextConsentAt) return;
    this.nextConsentAt = now + CONSENT_MIN_MS + Math.random() * CONSENT_JITTER_MS;
    if (this.consentKey !== null) this.s.unregister(this.consentKey); // unanswered: forget it
    const buf = buildBindingRequest({
      txid: randomBytes(12),
      username: this.username,
      key: this.owner.remoteKey,
      priority: PRFLX_PRIORITY,
      controlled: true,
      tieBreaker: this.tie,
    });
    const key = txidKey(buf);
    this.consentKey = key;
    this.s.register(key, (m, rsock, raddr, rport) => {
      if (this.closed || this.consentKey !== key) return;
      if (!checkFingerprint(m) || !checkIntegrity(m, this.owner.remoteKey)) return;
      this.s.unregister(key);
      this.consentKey = null;
      if (m.type !== StunType.BindingSuccess || rsock !== sock || rport !== port || !sameIp(raddr, address)) return;
      this.s.stats.consentAnswered++;
      this.owner.onConsent();
    });
    this.s.stats.consentSent++;
    this.s.o.send(sock, buf, address, port);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pairs) this.endTx(p);
    if (this.consentKey !== null) this.s.unregister(this.consentKey);
    this.consentKey = null;
    this.queue.length = 0;
    this.s.deactivate(this);
  }

  /** Pair states (tests/diagnostics). */
  describe(): { address: string; port: number; state: 'waiting' | 'in-progress' | 'succeeded' | 'failed'; sent: number }[] {
    const names = ['waiting', 'in-progress', 'succeeded', 'failed'] as const;
    return this.pairs.map((p) => ({ address: p.address, port: p.port, state: names[p.state]!, sent: p.sent }));
  }

  private find(sock: PacketIo, address: string, port: number): Pair | null {
    for (const p of this.pairs) if (p.port === port && p.sock === sock && sameIp(p.address, address)) return p;
    return null;
  }

  private insert(sock: PacketIo, address: string, port: number, remotePriority: number, localPriority = LOCAL_PRIORITY): Pair {
    const p: Pair = { sock, address, port, prio: pairPriority(remotePriority, localPriority), state: WAITING, sent: 0, triggered: false, learned: false, parked: false, tx: null };
    let i = 0;
    while (i < this.pairs.length && this.pairs[i]!.prio >= p.prio) i++;
    this.pairs.splice(i, 0, p);
    return p;
  }
}

function errorCode(m: StunMessage): number {
  const v = findAttr(m, StunAttr.ErrorCode);
  if (v < 0 || v + 4 > m.size) return 0;
  return (m.buf[v + 2]! & 7) * 100 + m.buf[v + 3]!;
}

export { pairPriority as _pairPriority, PRFLX_PRIORITY };
