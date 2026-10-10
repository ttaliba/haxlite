/**
 * src/net — networking (OWNER: engineer C): master server HTTP (/rs/api/host,
 * RoomInfo publish), signaling WebSocket (host side, deflated payloads),
 * WebRTC transport via node-datachannel (3 negotiated channels ro/ru/uu),
 * join handshake + ECDSA P-256 identity (node:crypto webcrypto), bans,
 * flood/token-bucket limits. See docs/01, docs/02 §2, docs/04.
 * No game logic here: deliver decoded messages to src/host.
 *
 * Entry point for the host: {@link HostTransport}.
 */
export {
  HostTransport,
  Peer,
  type HostTransportOptions,
  type JoinDecision,
  type JoinInfo,
  type JoinRequest,
  type PeerCloseReason,
  type PeerState,
} from './transport.js';
export { HostSignaling, type HostSignalingHandlers, type HostSignalingOptions, type SignalingOffer } from './signaling.js';
export {
  MasterError,
  fetchGeo,
  fetchRoomList,
  requestHostSession,
  type GeoLocation,
  type HostSession,
  type MasterErrorKind,
  type MasterHttpOptions,
} from './master-http.js';
export { BanList, type BanKind, type BanRecord } from './bans.js';
export { TokenBucket, KeyedRateLimiter } from './rate-limit.js';
export {
  CHALLENGE_LENGTH,
  createAuthBlob,
  createChallenge,
  generateIdentity,
  identityFromKey,
  identityToKey,
  verifyAuthBlob,
  type PlayerIdentity,
} from './auth.js';
export {
  encodeChallenge,
  encodeHandshake,
  encodeKick,
  parseHandshake,
  parseJoinInfo,
  type HandshakeMessage,
  type JoinPlayerInfo,
} from './handshake.js';
export {
  decodeRoomInfo,
  defaultRoomInfo,
  encodeRoomInfo,
  encodeRoomList,
  parseRoomList,
  type ListedRoom,
  type RoomInfo,
} from './room-info.js';
export { IpRange, bytesToConn, canonicalIp, connBytesToText, connToText, formatIp, parseIp } from './ip.js';
export {
  candidateLine,
  classifyAddress,
  filterCandidate,
  filterSdp,
  parseCandidate,
  sdpMids,
  srflxAddress,
  toNativeIceServers,
  type AddressClass,
  type BrowserIceServer,
  type IceCandidateInit,
  type IceCandidatePolicy,
  type IceServerConfig,
  type NativeIceServer,
  type ParsedCandidate,
} from './ice.js';
export * from './constants.js';
export { shutdownWebRtc, webRtcStats, type WebRtcStats } from './webrtc.js';
