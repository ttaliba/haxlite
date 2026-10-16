/**
 * One browser peer: ICE state (validated/nominated addresses, consent; the
 * full-ICE check list lives in an {@link IceAgent}, ice-agent.ts), the DTLS
 * server and the data-channel layer on top. Created and fed by
 * {@link RtcEndpoint} (endpoint.ts), which owns the socket(s) and the
 * demultiplexing maps.
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
import type { GatherWaiter } from './gather.js';

/** A transport address that passed an authenticated Binding request for a session. */
export interface ValidatedAddress {
  session: RtcSessionImpl;
  sock: UdpIo;
  address: string;
  port: number;
  /** `address|port` (bound into the DTLS cookie). */
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
}

const MAX_VALIDATED = 8;
const MAX_REMOTE_CANDIDATES = 32;

export class RtcSessionImpl implements RtcSession, IceAgentOwner, GatherWaiter {
  readonly answerSdp: string;
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
  /** Where DTLS goes: nominated pair, else the last validated source of DTLS/STUN. */
  private dest: ValidatedAddress | null = null;
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
    this.answerSdp = answerSdp;
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
      send: (d, len) => {
        const dest = this.dest;
        if (dest !== null) this.host.sendTo(dest, d, len);
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

  /** Our check on (sock, address, port) succeeded (full ICE): DTLS may come from / go to there. */
  onCheckSucceeded(sock: UdpIo, address: string, port: number): void {
    if (this.state === 'closed') return;
    const v = this.validate(sock, address, port);
    if (this.nominated === null && this.dest === null) this.dest = v;
    if (this.state === 'new') this.state = 'connecting';
  }

  /** Our consent check was answered (RFC 7675). */
  onConsent(): void {
    if (this.state !== 'closed') this.lastConsent = this.host.now();
  }

  // ------------------------------------------------------------ ICE-lite

  /**
   * A Binding request whose USERNAME starts with our ufrag (the endpoint
   * already parsed it into `m`). Validates and answers it.
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
    const v = this.validate(sock, address, port);
    this.host.sendTo(v, buildBindingSuccess(m.transactionId(), address, port, this.integrityKey));
    this.lastConsent = this.host.now();
    if (m.useCandidate) this.nominated = v; // nomination; also how NAT rebinding moves the pair
    if (this.nominated !== null) this.dest = this.nominated;
    else if (this.dest === null) this.dest = v;
    if (this.state === 'new') this.state = 'connecting';
    // full ICE: peer-reflexive candidate + triggered check (ice-agent.ts)
    if (this.agent !== null) this.agent.onRequest(sock, address, port, m.priority);
    return true;
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
    if (this.nominated === v) this.nominated = null;
    if (this.dest === v) this.dest = this.nominated ?? this.validated[this.validated.length - 1] ?? null;
  }

  // ------------------------------------------------------------ DTLS / data

  /** A DTLS datagram from validated address `v`. */
  handleDtls(buf: Buffer, v: ValidatedAddress): void {
    if (this.state === 'closed') return;
    if (this.nominated === null) this.dest = v;
    this.dtls.handleDatagram(buf, v.key);
  }

  private onDtlsConnected(): void {
    if (this.state === 'closed') return;
    this.state = 'dtls';
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
    this.host.unregister(this);
    this.validated.length = 0;
    this.nominated = null;
    this.dest = null;
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
