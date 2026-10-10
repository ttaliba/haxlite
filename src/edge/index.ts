/**
 * src/edge — haxlite Edge: WebRTC gateway that hides the host's IP from
 * players. Players (official client, unmodified) connect to the edge; hosts
 * connect OUT to the edge through an authenticated tunnel (WebSocket control
 * + one PeerConnection or WebSocket data plane). Host side:
 * `HostTransportOptions.edge` / `HBInit({haxlite: {edge}})`. CLI:
 * `bin/haxlite-edge.js` (see `cli.ts`). Docs: docs/09-haxlite-edge.md.
 */
export {
  EdgeServer,
  type EdgeKeyConfig,
  type EdgeKeyStats,
  type EdgeLimitsOptions,
  type EdgeServerOptions,
  type EdgeStats,
  type EdgeWebRtcOptions,
} from './server.js';
export { loadEdgeConfig, generateEdgeKey, type EdgeConfigFile } from './config.js';
