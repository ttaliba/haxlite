/**
 * haxlite Edge tunnel protocol (version 1), shared by the host side
 * (`edge-client.ts`) and the edge server (`src/edge`). See
 * docs/09-haxlite-edge.md.
 *
 * Control plane: one WebSocket per tunnel session (host → edge, outbound),
 * binary messages `[u8 type] …`. Strings are the codec's `string()` (varuint
 * length + UTF-8). The edge speaks first:
 *
 * ```
 * edge → host  Hello      [u8 version][32 B nonce]
 * host → edge  Auth       [u8 version][string keyId][32 B HMAC-SHA256(secret, "haxlite-edge/1" ‖ nonce)][u8 flags]
 * edge → host  AuthOk     [u32 sessionId][u16 maxPeers][u8 flags]
 * ```
 *
 * Data plane: either one PeerConnection host↔edge with three negotiated
 * channels mirroring `ro`/`ru`/`uu` (flag {@link AuthFlag.WebRtc}), or the
 * WebSocket itself (fallback, UDP blocked). Data frames on a tunnel data
 * channel are `[u16 slot][payload]` (the tunnel channel is the player
 * channel); slot 0 carries an in-band control message `[u16 0][u8 type] …`.
 * With {@link AuthFlag.RoLanes}, `ro` frames of slot `s` (and in-band
 * control about `s`) travel on tunnel channel {@link roLaneChannel}`(s)`;
 * tunnel channels ≥ 3 are `ro` lanes.
 * On the WebSocket data plane, data frames are `[u8 Data0+ch][u16 slot][payload]`
 * and in-band control messages are ordinary WS messages.
 *
 * Messages that must stay ordered with player data travel in-band on the
 * `ro` data plane: `PeerChannelOpen` / `PeerClosed` (edge → host, so the
 * host sees "channel open" before the first message of the player) and
 * `PeerClose` (host → edge, after a kick notice). Everything else uses the
 * WebSocket.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const EDGE_PROTOCOL_VERSION = 1;
/** Default WebSocket path of the edge's control endpoint. */
export const EDGE_DEFAULT_PATH = '/tunnel';
export const EDGE_NONCE_LENGTH = 32;
export const EDGE_MAC_LENGTH = 32;

export const EdgeMsg = {
  // ---- session (WS)
  Hello: 0x01,
  Auth: 0x02,
  AuthOk: 0x03,
  /** host → edge `[string sdp]`: offer of the data-plane PeerConnection. */
  TunnelOffer: 0x04,
  /** edge → host `[string sdp]`. */
  TunnelAnswer: 0x05,
  /** both ways `[string candidate][string mid]`. */
  TunnelCandidate: 0x06,
  // ---- player negotiation (WS)
  /** host → edge `[u16 slot][string offerSdp]`: create the player PeerConnection. */
  PeerOpen: 0x10,
  /** host → edge `[u16 slot][string candidate][string mid]`. */
  PeerRemoteCandidate: 0x11,
  /** host → edge `[u16 slot]` (in-band `ro`): close the player connection. */
  PeerClose: 0x12,
  /** edge → host `[u16 slot][string answerSdp]` (already filtered by the edge's policy). */
  PeerAnswer: 0x20,
  /** edge → host `[u16 slot][string candidate][string mid]`. */
  PeerLocalCandidate: 0x21,
  /** edge → host `[u16 slot]`: ICE gathering complete. */
  PeerGathered: 0x22,
  /** edge → host (in-band `ro`) `[u16 slot][u8 channel][string remoteAddress]`. */
  PeerChannelOpen: 0x30,
  /** edge → host (in-band `ro`) `[u16 slot][u8 reason]` ({@link EdgePeerClose}). */
  PeerClosed: 0x31,
  /** host → edge (data plane, channel = tunnel channel) `[u8 channel][u8 n][u16 slot × n][payload]`. */
  Multicast: 0x40,
  /** both ways `[f64 t]` / echo. */
  Ping: 0x50,
  Pong: 0x51,
  /** edge → host `[u16 code][string message]` (diagnostics; fatal ones are followed by a close). */
  Error: 0x60,
  /** WS data plane `[u16 slot][payload]` on player channel 0/1/2. */
  Data0: 0x70,
  Data1: 0x71,
  Data2: 0x72,
} as const;

/** Auth flags (`Auth` from the host = requested; `AuthOk` from the edge = granted). */
export const AuthFlag = {
  /** Data plane over a host↔edge PeerConnection (else over this WebSocket). */
  WebRtc: 1,
  /**
   * `ro` lanes: player `ro` traffic is spread over {@link EDGE_RO_LANES}
   * ordered tunnel channels by slot (`slot % lanes`) instead of one, so a
   * packet lost on the host↔edge path only delays the `ro` messages of the
   * players sharing its lane (head-of-line blocking), not everybody's.
   * Per-player order is kept: all of a slot's `ro` frames and its in-band
   * control use the same lane. Only granted with {@link WebRtc}; an edge
   * that does not echo it keeps the single `ro` channel (interoperable both ways).
   */
  RoLanes: 2,
} as const;

/** Ordered tunnel channels carrying player `ro` traffic when {@link AuthFlag.RoLanes} is granted. */
export const EDGE_RO_LANES = 16;

/**
 * Tunnel data-channel id of a slot's `ro` traffic: lane 0 is channel 0,
 * lane `k > 0` is channel `2 + k` (after `ru` = 1 and `uu` = 2).
 */
export function roLaneChannel(slot: number, lanes: number): number {
  const lane = slot % lanes;
  return lane === 0 ? 0 : 2 + lane;
}

/** Why the edge closed a player connection (`PeerClosed`). */
export const EdgePeerClose = {
  /** Remote close / PeerConnection closed. */
  Closed: 0,
  /** Negotiation or PeerConnection failed (also: bad offer). */
  Failed: 1,
  /** Edge flood limiter: the host should kick with "Bad actor". */
  Flood: 2,
  /** Edge quota (per session / per key peers) or invalid slot. */
  Limit: 3,
  /** The player sent a text (non-binary) message: the host should kick with "Bad actor". */
  Protocol: 4,
} as const;

/** WebSocket close codes used by the edge. */
export const EdgeCloseCode = {
  Protocol: 4400,
  AuthFailed: 4401,
  Version: 4402,
  /** Too many sessions for this key / edge full. */
  Quota: 4429,
  Timeout: 4408,
  /** The edge is shutting down. */
  Shutdown: 4503,
} as const;

/** Input bounds checked by both sides. */
export const EdgeLimits = {
  maxSdp: 16_384,
  maxCandidate: 1_024,
  maxMid: 64,
  maxKeyId: 128,
  /** Remote candidates accepted per player connection. */
  maxRemoteCandidates: 32,
  /** Max player payload (bytes). */
  maxPayload: 262_144,
  /** Max WS message (payload + headers). */
  maxWsMessage: 262_144 + 64,
} as const;

/** Host-side API key: `"<keyId>:<secret>"`. */
export function parseEdgeKey(key: string): { id: string; secret: string } {
  const i = key.indexOf(':');
  if (i <= 0 || i === key.length - 1) throw new Error('edge key must be "<keyId>:<secret>"');
  const id = key.slice(0, i);
  if (id.length > EdgeLimits.maxKeyId) throw new Error('edge key id too long');
  return { id, secret: key.slice(i + 1) };
}

/** `HMAC-SHA256(secret, "haxlite-edge/1" ‖ nonce)`. */
export function edgeAuthMac(secret: string, nonce: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(`haxlite-edge/${EDGE_PROTOCOL_VERSION}`).update(nonce).digest();
}

/** Constant-time comparison of two MACs. */
export function edgeMacEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
