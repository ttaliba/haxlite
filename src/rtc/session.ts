/**
 * One browser peer: ICE state (validated/nominated addresses, consent; the
 * full-ICE check list lives in an {@link IceAgent}, ice-agent.ts), the DTLS
 * server and the data-channel layer on top. Created and fed by
 * {@link RtcEndpoint} (endpoint.ts), which owns the socket(s) and the
 * demultiplexing maps.
 *
 * What makes a transport address **validated** (DTLS is routed from it and
 * may be sent to it):
 *
 * * Full ICE: one of OUR connectivity checks to it got an authenticated,
 *   symmetric success (RFC 8445 §7.2.5.3) — return routability. An
 *   authenticated Binding request alone proves nothing about its source:
 *   the key is our ICE password, which every joining client knows from its
 *   own answer, so a client could spoof a victim's address. Such a request
 *   is answered and triggers a check (§7.3.1.4); USE-CANDIDATE on it is
 *   remembered and takes effect once that check succeeds (§7.3.1.5), and
 *   DTLS that arrives from the address meanwhile is held (a few datagrams)
 *   instead of dropped, so the triggered check costs no extra round trip.
 * * ICE-lite (we send no checks): the authenticated request, as before —
 *   the address is NOT proven, which is why the endpoint turns the DTLS
 *   cookie exchange (HelloVerifyRequest) on by default there: flight 4 only
 *   goes to an address that echoed the cookie.
 *
 * DTLS handshake flights go to the address of the ClientHello that started
 * the handshake (always a validated one); application data to the nominated
 * pair, else the last validated DTLS source.
 */
import { createSecretKey, type KeyObject } from 'node:crypto';
import type { UdpIo } from './udp.js';
import { DtlsServer } from './dtls/server.js';
import type { OfferInfo } from './sdp.js';
import { parseCandidate, type ParsedCandidate } from './sdp.js';
import { StunMessage, buildBindingError, buildBindingSuccess, checkFingerprint, checkIntegrity } from './stun.js';
import { HAXBALL_CHANNELS, type RemoteAddress, type RtcSession, type RtcSessionState, type SctpAssociationLike, type SctpFactory } from './types.js';
import type { RtcCertificate } from './cert.js';
import { IceAgent, type IceAgentOwner, type IceScheduler } from './ice-agent.js';
import { sameIp, type GatherWaiter } from './gather.js';

/** A transport address that passed an authenticated Binding request for a session. */
export interface ValidatedAddress {
  session: RtcSessionImpl;
  sock: UdpIo;
  address: string;
  port: number;
  /** `address|port` (the DTLS server's peer key; bound into the HelloVerifyRequest cookie when that exchange is enabled). */
  key: string;
}

/** What a session needs from its endpoint. */
export interface SessionHost {
  readonly certificate: RtcCertificate;
  readonly dataLayer: SctpFactory;
  readonly mtu: number;
  readonly maxMessageSize: number;
  readonly sctpPort: number;
  /** Sends buf[0, length) (default: all of it) synchronously; counts it. */
  sendTo(dest: ValidatedAddress, buf: Buffer, length?: number): void;
  /** Shared scratch buffer (≥ size bytes) to seal one outgoing record into right before {@link sendTo}. */
  sendBuffer(size: number): Buffer;
  /** DTLS cipher suites in preference order (undefined: the DTLS default). */
  readonly suites: readonly number[] | undefined;
  /** Registers `dest` in the 5-tuple map (stealing it from another session if needed). */
  bindAddress(dest: ValidatedAddress): void;
  /** Releases `dest`'s 5-tuple from the DTLS demux if it still points at `dest`. */
  unbindAddress(dest: ValidatedAddress): void;
  /** Removes the session from every map. */
  unregister(session: RtcSessionImpl): void;
  /** Handshake/session outcome counters. */
  countHandshake(ok: boolean): void;
  now(): number;
  /** Full ICE (connectivity checks, consent checks); null = ICE-lite. */
  readonly ice: IceScheduler | null;
  /** DTLS cookie exchange (HelloVerifyRequest) before any handshake state. */
  readonly helloVerify: boolean;
  /**
   * Full ICE: DTLS from (address, port) — authenticated by a Binding request,
   * not validated yet — may be handed to this session ({@link RtcSessionImpl.holdDtls}).
   */
  holdAddress(session: RtcSessionImpl, address: string, port: number): void;
}

const MAX_VALIDATED = 8;
const MAX_REMOTE_CANDIDATES = 32;
/** Full ICE: DTLS datagrams held per session while their source awaits our check, and their total size. */
const MAX_HELD = 4;
const MAX_HELD_BYTES = 6144;
/** Full ICE: unvalidated sources whose DTLS may be held, per session. */
const MAX_HOLD_ADDRESSES = 16;

export class RtcSessionImpl implements RtcSession, IceAgentOwner, GatherWaiter {
  /** The answer until DTLS connects (the peer had it then), null afterwards: ~0.5 KB less per live session. */
  private answer: string | null;
  readonly localCandidates: string[];
  readonly mid: string;
  readonly localUfrag: string;
  readonly remoteUfrag: string;
  /** Our ICE password as a secret key (STUN MESSAGE-INTEGRITY; a KeyObject: no per-check key import). */
  readonly integrityKey: KeyObject;
  /** USERNAME every Binding request must carry: "ourUfrag:theirUfrag". */
  private readonly expectedUsername: Buffer;
  readonly createdAt: number;

  onOpen?: () => void;
  onClose?: (reason: string) => void;
  onMessage?: (channelId: number, data: Uint8Array) => void;
  onChannelClose?: (channelId: number) => void;
  onLocalCandidate?: (candidate: string) => void;
  onGatheringComplete?: () => void;
  /** All our candidates are known (false while the endpoint's STUN gathering runs). */
  gatheringComplete = true;
  /** Remote ICE password as a secret key (MESSAGE-INTEGRITY of our checks and their responses). */
  readonly remoteKey: KeyObject;
  /** Full-ICE check list (null: ICE-lite). */
  readonly agent: IceAgent | null;

  state: RtcSessionState = 'new';
  /** Last authenticated Binding request (ms, endpoint clock); 0 = none yet. */
  lastConsent = 0;
  /** Remote trickle candidates (informational). */
  readonly remoteCandidates: ParsedCandidate[] = [];

  readonly validated: ValidatedAddress[] = [];
  private nominated: ValidatedAddress | null = null;
  /** Where application data goes: nominated pair, else the last validated source of DTLS (or of a successful check). */
  private dest: ValidatedAddress | null = null;
  /** Where handshake flights go: the validated source of the ClientHello that started the handshake. */
  private dtlsFrom: ValidatedAddress | null = null;
  /** Full ICE: the latest USE-CANDIDATE from a source our check has not validated yet (nominated once it succeeds). */
  private pendingNomination: { sock: UdpIo; address: string; port: number } | null = null;
  /** Full ICE: DTLS datagrams from sources awaiting our check (null: none). */
  private held: { sock: UdpIo; address: string; port: number; buf: Buffer }[] | null = null;
  private heldBytes = 0;
  /** Full ICE: `address|port` keys registered with {@link SessionHost.holdAddress} (the endpoint drops them on unregister). */
  readonly holdKeys: string[] = [];
  private readonly host: SessionHost;
  private readonly offer: OfferInfo;
  private readonly dtls: DtlsServer;
  private sctp: SctpAssociationLike | null = null;
  /** cork() calls not yet balanced, and the association they were applied to. */
  private corkDepth = 0;
  private corkedSctp: SctpAssociationLike | null = null;

  constructor(
    host: SessionHost,
    offer: OfferInfo,
    localUfrag: string,
    localPwd: string,
    answerSdp: string,
    localCandidates: string[],
  ) {
    this.host = host;
    this.offer = offer;
    this.localUfrag = localUfrag;
    this.remoteUfrag = offer.iceUfrag;
    this.integrityKey = createSecretKey(Buffer.from(localPwd, 'latin1'));
    this.expectedUsername = Buffer.from(`${localUfrag}:${offer.iceUfrag}`, 'latin1');
    this.answer = answerSdp;
    this.localCandidates = localCandidates;
    this.mid = offer.mid;
    this.createdAt = host.now();
    this.remoteKey = createSecretKey(Buffer.from(offer.icePwd, 'latin1'));
    this.agent = host.ice !== null ? new IceAgent(host.ice, this) : null;
    for (const c of offer.candidates) this.addRemoteCandidate(c);
    this.dtls = new DtlsServer({
      certificate: host.certificate,
      remoteFingerprint: { algorithm: offer.fingerprintAlgorithm, digest: offer.fingerprint },
      mtu: host.mtu,
      ...(host.suites !== undefined ? { suites: host.suites } : null),
      ...(host.helloVerify ? { helloVerify: true } : null),
      send: (d, len) => {
        // handshake: only to the (validated) address the handshake came from, never to an unproven one
        const to = this.state === 'dtls' || this.state === 'open' ? this.dest : this.dtlsFrom;
        if (to !== null) this.host.sendTo(to, d, len);
      },
      sendBuffer: host.sendBuffer,
      onConnected: () => this.onDtlsConnected(),
      onData: (d, off, len) => {
        const s = this.sctp;
        if (s !== null) s.input(d, off, len);
      },
      onClose: (reason) => this.terminate(reason),
    });
  }

  /** See {@link RtcSession.answerSdp}: `''` once DTLS connected or the session closed. */
  get answerSdp(): string {
    return this.answer ?? '';
  }

  get remoteAddress(): RemoteAddress | null {
    const d = this.nominated ?? this.dest;
    return d === null ? null : { address: d.address, port: d.port };
  }

  /** DTLS records the session dropped (replayed / unauthenticated). */
  get dtlsDrops(): { replayed: number; bad: number } {
    return { replayed: this.dtls.replayed, bad: this.dtls.badRecords };
  }

  /** DTLS diagnostics: negotiated suite/group, whether the client offered DTLS 1.3. */
  get dtlsInfo(): { suite: string | null; group: number; clientOfferedDtls13: boolean } {
    return { suite: this.dtls.suite?.name ?? null, group: this.dtls.group, clientOfferedDtls13: this.dtls.clientOfferedDtls13 };
  }

  /** Negotiated DTLS cipher suite name (diagnostics). */
  get cipherSuite(): string | null {
    return this.dtls.suite?.name ?? null;
  }

  addRemoteCandidate(candidate: string): void {
    if (this.state === 'closed' || this.remoteCandidates.length >= MAX_REMOTE_CANDIDATES) return;
    const c = parseCandidate(candidate);
    if (c === null) return;
    this.remoteCandidates.push(c);
    if (this.agent !== null) this.agent.addRemote(c);
  }

  /** Gathering round finished (endpoint): trickles the candidates this session did not announce yet. */
  onGathered(lines: readonly string[]): void {
    if (this.state === 'closed' || this.gatheringComplete) return;
    for (const l of lines) {
      if (this.localCandidates.indexOf(l) >= 0) continue;
      this.localCandidates.push(l);
      callSafely(this.onLocalCandidate, l);
    }
    this.gatheringComplete = true;
    callSafely(this.onGatheringComplete, undefined);
  }

  /**
   * Our check on (sock, address, port) succeeded (full ICE): the address is
   * proven, DTLS may come from / go to there; a USE-CANDIDATE received from it
   * meanwhile nominates it now, and DTLS held for it is processed.
   */
  onCheckSucceeded(sock: UdpIo, address: string, port: number): void {
    if (this.state === 'closed') return;
    const v = this.validate(sock, address, port);
    this.lastConsent = this.host.now(); // a successful check is consent too (RFC 7675 §5.1)
    const p = this.pendingNomination;
    if (p !== null && p.port === port && p.sock === sock && sameIp(p.address, address)) {
      this.pendingNomination = null;
      this.nominated = v;
      this.dest = v;
    } else if (this.nominated === null && this.dest === null) this.dest = v;
    if (this.state === 'new') this.state = 'connecting';
    const held = this.held;
    if (held !== null) {
      for (let i = 0; i < held.length; ) {
        const h = held[i]!;
        if (h.port === port && h.sock === sock && sameIp(h.address, address)) {
          held.splice(i, 1);
          this.heldBytes -= h.buf.length;
          this.handleDtls(h.buf, v);
          if ((this.state as RtcSessionState) === 'closed') return; // the handshake may have failed
        } else i++;
      }
      if (held.length === 0 && this.held === held) this.held = null;
    }
  }

  /**
   * Full ICE: a DTLS datagram from (sock, address, port), whose Binding
   * request authenticated but which our check has not validated yet. Kept
   * (a copy, bounded) until the check succeeds — usually the ClientHello,
   * racing our triggered check. Returns false when not kept.
   */
  holdDtls(msg: Buffer, sock: UdpIo, address: string, port: number): boolean {
    if (this.state === 'closed' || this.agent === null) return false;
    const held = (this.held ??= []);
    if (held.length >= MAX_HELD || this.heldBytes + msg.length > MAX_HELD_BYTES) return false;
    held.push({ sock, address, port, buf: Buffer.from(msg) });
    this.heldBytes += msg.length;
    return true;
  }

  /** Our consent check was answered (RFC 7675). */
  onConsent(): void {
    if (this.state !== 'closed') this.lastConsent = this.host.now();
  }

  // ------------------------------------------------------------ Binding requests

  /**
   * A Binding request whose USERNAME starts with our ufrag (the endpoint
   * already parsed it into `m`). Authenticates and answers it; ICE-lite: its
   * source becomes validated; full ICE: see the file comment.
   * Returns false when it was rejected (not authenticated / malformed).
   */
  handleBinding(m: StunMessage, sock: UdpIo, address: string, port: number): boolean {
    if (this.state === 'closed') return false;
    // USERNAME = "ourUfrag:theirUfrag" exactly
    const want = this.expectedUsername;
    if (m.usernameLength !== want.length) return false;
    const buf = m.buf;
    const off = m.usernameOffset;
    for (let i = 0; i < want.length; i++) if (buf[off + i] !== want[i]) return false;
    if (!checkFingerprint(m) || !checkIntegrity(m, this.integrityKey)) return false;
    if (m.unknownRequired >= 0) {
      // Authenticated but with comprehension-required attributes we do not know: 420.
      this.host.sendTo(this.tempDest(sock, address, port), buildBindingError(m.transactionId(), 420, 'Unknown Attribute', this.integrityKey));
      return false;
    }
    if (!m.controlling) {
      // We are lite, hence always controlled: a peer claiming controlled (or no role) is in conflict.
      if (m.controlled) {
        this.host.sendTo(this.tempDest(sock, address, port), buildBindingError(m.transactionId(), 487, 'Role Conflict', this.integrityKey));
      }
      return false;
    }
    if (this.agent !== null) {
      this.fullIceRequest(m, sock, address, port);
      return true;
    }
    const v = this.validate(sock, address, port);
    this.host.sendTo(v, buildBindingSuccess(m.transactionId(), address, port, this.integrityKey));
    this.lastConsent = this.host.now();
    if (m.useCandidate) this.nominated = v; // nomination; also how NAT rebinding moves the pair
    if (this.nominated !== null) this.dest = this.nominated;
    else if (this.dest === null) this.dest = v;
    if (this.state === 'new') this.state = 'connecting';
    return true;
  }

  /**
   * Full ICE, authenticated request: answered wherever it came from (a STUN
   * response no larger than the request), but its source is only trusted
   * once our own check to it succeeds (file comment). Consent: our consent
   * checks, and requests from validated addresses only.
   */
  private fullIceRequest(m: StunMessage, sock: UdpIo, address: string, port: number): void {
    const v = this.findValidated(sock, address, port);
    this.host.sendTo(v ?? this.tempDest(sock, address, port), buildBindingSuccess(m.transactionId(), address, port, this.integrityKey));
    if (v !== null) {
      this.lastConsent = this.host.now();
      this.host.bindAddress(v); // (re)claim the 5-tuple: proven by our check
      if (m.useCandidate) {
        this.pendingNomination = null;
        this.nominated = v; // nomination; also how NAT rebinding moves the pair (to a proven address)
        this.dest = v;
      }
    } else {
      if (m.useCandidate) this.pendingNomination = { sock, address, port };
      if (this.holdKeys.length < MAX_HOLD_ADDRESSES) this.host.holdAddress(this, address, port);
    }
    // peer-reflexive candidate + triggered check (ice-agent.ts); none once the pair succeeded
    (this.agent as IceAgent).onRequest(sock, address, port, m.priority);
  }

  /** Marks (sock, address, port) valid for this session and claims its 5-tuple for the DTLS demux. */
  private validate(sock: UdpIo, address: string, port: number): ValidatedAddress {
    let v = this.findValidated(sock, address, port);
    if (v === null) {
      v = { session: this, sock, address, port, key: `${address}|${port}` };
      if (this.validated.length >= MAX_VALIDATED) {
        // keep the nominated one, drop the oldest other
        const idx = this.validated.findIndex((x) => x !== this.nominated);
        const [old] = this.validated.splice(idx < 0 ? 0 : idx, 1);
        // its 5-tuple must not keep routing DTLS here (nor keep this session reachable after close)
        if (old !== undefined) {
          this.host.unbindAddress(old);
          this.dropped(old);
          if (this.dest === old) this.dest = null;
        }
      }
      this.validated.push(v);
    }
    // (Re)claim the 5-tuple: the latest authenticated session owns it.
    this.host.bindAddress(v);
    return v;
  }

  private tempDest(sock: UdpIo, address: string, port: number): ValidatedAddress {
    return { session: this, sock, address, port, key: '' };
  }

  private findValidated(sock: UdpIo, address: string, port: number): ValidatedAddress | null {
    for (const v of this.validated) if (v.port === port && v.address === address && v.sock === sock) return v;
    return null;
  }

  /** The endpoint dropped `v` from this session (another session claimed the 5-tuple). */
  forgetAddress(v: ValidatedAddress): void {
    const i = this.validated.indexOf(v);
    if (i >= 0) this.validated.splice(i, 1);
    this.dropped(v);
    if (this.nominated === v) this.nominated = null;
    if (this.dest === v) this.dest = this.nominated ?? this.validated[this.validated.length - 1] ?? null;
  }

  /** `v` is no longer validated: no handshake flight goes there; full ICE: a new request re-checks it. */
  private dropped(v: ValidatedAddress): void {
    if (this.dtlsFrom === v) this.dtlsFrom = null;
    if (this.agent !== null) this.agent.recheck(v.sock, v.address, v.port);
  }

  // ------------------------------------------------------------ DTLS / data

  /** A DTLS datagram from validated address `v`. */
  handleDtls(buf: Buffer, v: ValidatedAddress): void {
    if (this.state === 'closed') return;
    if (this.nominated === null) this.dest = v;
    // the handshake's address is that of the ClientHello starting it (with the cookie: the one that echoed it)
    if (this.dtls.state === 'listen' || this.dtlsFrom === null) this.dtlsFrom = v;
    this.dtls.handleDatagram(buf, v.key);
  }

  private onDtlsConnected(): void {
    if (this.state === 'closed') return;
    this.state = 'dtls';
    this.answer = null; // the peer completed DTLS with our fingerprint: it has the answer
    this.host.countHandshake(true);
    if (this.agent !== null) this.agent.connected(this.host.now());
    try {
      this.sctp = this.host.dataLayer({
        send: (packet) => {
          this.dtls.send(packet);
        },
        channels: HAXBALL_CHANNELS.map((c) => ({ ...c })),
        maxMessageSize: this.offer.maxMessageSize,
        maxReceiveMessageSize: this.host.maxMessageSize,
        // onMessage data is only valid during the callback (documented on RtcSession.onMessage)
        transientDelivery: true,
        onError: reportError,
        localPort: this.host.sctpPort,
        remotePort: this.offer.sctpPort,
        onMessage: (channelId, data) => {
          const cb = this.onMessage;
          if (cb === undefined || this.state !== 'open') return;
          try {
            cb(channelId, data);
          } catch (err) {
            reportError(err);
          }
        },
        onOpen: () => {
          if (this.state !== 'dtls') return;
          this.state = 'open';
          const cb = this.onOpen;
          if (cb !== undefined) {
            try {
              cb();
            } catch (err) {
              reportError(err);
            }
          }
        },
        onClose: (reason) => this.terminate(`sctp:${reason}`),
        onChannelClose: (channelId) => {
          const cb = this.onChannelClose;
          // not while tearing down (teardown nulls `sctp` before closing it)
          if (cb === undefined || this.state !== 'open' || this.sctp === null) return;
          try {
            cb(channelId);
          } catch (err) {
            reportError(err);
          }
        },
      });
    } catch (err) {
      reportError(err);
      this.terminate('sctp:init-failed');
    }
  }

  send(channelId: number, data: Uint8Array): boolean {
    if (this.state !== 'open') return false;
    const s = this.sctp;
    return s !== null && s.send(channelId, data);
  }

  /** Corks the SCTP association (see {@link RtcSession.cork}); balanced by {@link uncork}. */
  cork(): void {
    const s = this.sctp;
    if (s === null || s.cork === undefined) return;
    this.corkedSctp = s;
    this.corkDepth++;
    s.cork();
  }

  uncork(): void {
    if (this.corkDepth === 0) return;
    this.corkDepth--;
    const s = this.corkedSctp;
    if (this.corkDepth === 0) this.corkedSctp = null;
    // the association may have been torn down meanwhile: still balance its counter (harmless after close)
    if (s !== null && s.uncork !== undefined) s.uncork();
  }

  // ------------------------------------------------------------ lifecycle

  /** Endpoint sweep: closes on handshake timeout / consent expiry. */
  checkTimers(now: number, handshakeTimeoutMs: number, idleTimeoutMs: number): void {
    if (this.state === 'closed') return;
    if (this.state !== 'open' && now - this.createdAt > handshakeTimeoutMs) {
      this.terminate('handshake-timeout');
      return;
    }
    if (this.state === 'open' && now - this.lastConsent > idleTimeoutMs) {
      this.terminate('timeout');
      return;
    }
    const a = this.agent;
    if (a !== null && this.state === 'open') {
      const d = this.nominated ?? this.dest;
      if (d !== null) a.consentTick(now, d.sock, d.address, d.port);
    }
  }

  /** Closes and reports `reason` (remote/timeout/error paths). */
  terminate(reason: string): void {
    if (this.state === 'closed') return;
    const wasConnected = this.state === 'dtls' || this.state === 'open';
    if (!wasConnected) this.host.countHandshake(false);
    this.teardown();
    const cb = this.onClose;
    if (cb !== undefined) {
      try {
        cb(reason);
      } catch (err) {
        reportError(err);
      }
    }
  }

  close(): void {
    if (this.state === 'closed') return;
    this.teardown();
  }

  private teardown(): void {
    const sctp = this.sctp;
    this.sctp = null;
    if (sctp !== null) {
      try {
        sctp.close(); // may still send an ABORT through dtls
      } catch (err) {
        reportError(err);
      }
    }
    this.dtls.close();
    if (this.agent !== null) this.agent.close();
    this.state = 'closed';
    this.answer = null;
    this.host.unregister(this);
    this.validated.length = 0;
    this.nominated = null;
    this.dest = null;
    this.dtlsFrom = null;
    this.pendingNomination = null;
    this.held = null;
    this.heldBytes = 0;
  }
}

function callSafely<T>(cb: ((v: T) => void) | undefined, v: T): void {
  if (cb === undefined) return;
  try {
    cb(v);
  } catch (err) {
    reportError(err);
  }
}

function reportError(err: unknown): void {
  try {
    console.error('[haxlite/rtc] error in session callback:', err);
  } catch {
    /* never propagate */
  }
}
