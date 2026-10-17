/**
 * haxlite-rtc: pure-TypeScript WebRTC data channels (full ICE in the
 * controlled role by default, or ICE-lite for servers with a public IP;
 * DTLS 1.2 server + SCTP). See src/rtc/README.md.
 */
export { RtcEndpoint, type RtcEndpointOptions, type RtcEndpointStats } from './endpoint.js';
export { TurnRelay, turnServers, type TurnServerSpec, type TurnStats, type TurnState } from './turn.js';
export { RtcCertificate } from './cert.js';
export { RtcSdpError, parseOffer, type OfferInfo } from './sdp.js';
export {
  HAXBALL_CHANNELS,
  type DataChannelSpec,
  type RemoteAddress,
  type RtcSession,
  type RtcSessionState,
  type SctpAssociationLike,
  type SctpAssociationOptions,
  type SctpFactory,
} from './types.js';
export { rawDataLayer } from './raw-layer.js';
export { acquireSharedEndpoint, sharedEndpointCount, type SharedEndpointLease } from './shared.js';
