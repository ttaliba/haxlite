/**
 * Contracts shared between the haxlite-rtc layers (see src/rtc/README.md).
 * The SCTP/data-channel layer (`src/rtc/sctp/`, R2) implements
 * {@link SctpAssociationLike}; {@link RtcSession} is the public per-peer API.
 */

/** One pre-negotiated data channel (HaxBall: ids 0/1/2, no DCEP). */
export interface DataChannelSpec {
  id: number;
  ordered: boolean;
  /** Partial reliability (RFC 3758): 0 = never retransmit. Absent = reliable. */
  maxRetransmits?: number;
}

/** HaxBall's channels (`kb.channels`): ro / ru / uu. */
export const HAXBALL_CHANNELS: readonly DataChannelSpec[] = [
  { id: 0, ordered: true },
  { id: 1, ordered: false },
  { id: 2, ordered: false, maxRetransmits: 0 },
];

export interface SctpAssociationOptions {
  /** Sends one SCTP packet as one DTLS record. Synchronous (the caller may reuse `packet` afterwards). */
  send(packet: Uint8Array): void;
  channels: DataChannelSpec[];
  /** Largest message we may send: the peer's a=max-message-size. */
  maxMessageSize: number;
  /** Largest message we accept: our a=max-message-size (262144). */
  maxReceiveMessageSize?: number;
  /** Our SCTP port (a=sctp-port of the answer, 5000). */
  localPort?: number;
  /** Peer SCTP port (a=sctp-port of the offer, default 5000). */
  remotePort?: number;
  /**
   * A complete user message. The receiver may keep `data` unless
   * {@link transientDelivery} is set.
   */
  onMessage(channelId: number, data: Uint8Array): void;
  /**
   * `onMessage` data may be a view into a scratch buffer of the association,
   * valid only during the callback (0 allocations per received message).
   * Data layers that do not know the option ignore it (and deliver fresh buffers).
   */
  transientDelivery?: boolean;
  /** Exceptions thrown by the callbacks above. */
  onError?(err: unknown): void;
  /** Association established: the channels are usable. */
  onOpen(): void;
  /** Association gone (ABORT, SHUTDOWN, failure). Called at most once, never after close(). */
  onClose(reason: string): void;
  /** One channel closed (the peer reset its stream, e.g. `dc.close()`), at most once per channel. */
  onChannelClose?(channelId: number): void;
}

export interface SctpAssociationLike {
  /** One decrypted DTLS application-data record (a view of the received datagram, not reused; may be kept). */
  input(packet: Uint8Array): void;
  /** Queues a user message; false when not open or over the buffer limit. */
  send(channelId: number, data: Uint8Array): boolean;
  /** Tears down (best-effort ABORT/SHUTDOWN). No callback afterwards. Idempotent. */
  close(): void;
  /** Bundles subsequent sends into as few packets as possible until {@link uncork} (nestable). */
  cork?(): void;
  /** Ends one {@link cork}; the outermost uncork flushes. */
  uncork?(): void;
}

export type SctpFactory = (opts: SctpAssociationOptions) => SctpAssociationLike;

export interface RemoteAddress {
  address: string;
  port: number;
}

/** One browser peer (created from its offer by `RtcEndpoint.createSession`). */
export interface RtcSession {
  /** The SDP answer (complete, includes our candidates and a=end-of-candidates). */
  readonly answerSdp: string;
  /** Our candidate lines, without the `a=` prefix. */
  readonly localCandidates: string[];
  /** mid of the data m-line (for trickle signaling of {@link localCandidates}). */
  readonly mid: string;
  /** Remote trickle candidate (with or without `a=`). Only a hint: ICE-lite answers peer-reflexive sources too. */
  addRemoteCandidate(candidate: string): void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  /**
   * One received message. `data` is valid only during the callback (it may
   * be a view into a reused buffer of the data layer): copy it to keep it.
   */
  onMessage?: (channelId: number, data: Uint8Array) => void;
  /**
   * One data channel was closed by the browser (`dc.close()` → SCTP stream
   * reset, RFC 8831 §6.7) while the session stays open. At most once per
   * channel; never after {@link onClose} or a local close().
   */
  onChannelClose?: (channelId: number) => void;
  /** Sends one message; false when not open or the data layer refused it. */
  send(channelId: number, data: Uint8Array): boolean;
  /**
   * Bundles the following {@link send}s (e.g. one game tick's messages) into
   * as few SCTP packets / DTLS records as possible until {@link uncork}.
   * Nestable; a no-op before the data layer exists. Always pair with uncork.
   */
  cork(): void;
  /** Ends one {@link cork}; the outermost uncork flushes the bundled data. */
  uncork(): void;
  /** Nominated (or, before nomination, last validated) remote address. */
  readonly remoteAddress: RemoteAddress | null;
  /** 'new' → 'connecting' (ICE validated) → 'dtls' (handshake done) → 'open' (SCTP up) → 'closed'. */
  readonly state: RtcSessionState;
  close(): void;
}

export type RtcSessionState = 'new' | 'connecting' | 'dtls' | 'open' | 'closed';
