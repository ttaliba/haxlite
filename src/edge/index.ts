/**
 * src/edge — haxlite Edge: WebRTC gateway that hides the host's IP from
 * players. Players (official client, unmodified) connect to the edge
 * (haxlite-rtc by default: pure TypeScript, one UDP port); hosts connect OUT
 * to the edge through an authenticated tunnel (WebSocket control + tunnel v2
 * = SCTP over AES-GCM UDP, or the legacy PeerConnection, or the WebSocket).
 * No native addon unless `playerBackend: 'ndc'` or a legacy host asks for
 * it. Host side: `HostTransportOptions.edge` / `HBInit({haxlite: {edge}})`.
 * CLI: `bin/haxlite-edge.js` (see `cli.ts`). Docs: docs/09-haxlite-edge.md.
 */
export {
  EdgeServer,
  type EdgeKeyConfig,
  type EdgeKeyStats,
  type EdgeLimitsOptions,
  type EdgeServerOptions,
  type EdgeStats,
  type EdgeWebRtcOptions,
  type EdgeTunnelOptions,
  type EdgeTunnelStats,
  type EdgePlayerBackendKind,
} from './server.js';
export { loadEdgeConfig, generateEdgeKey, type EdgeConfigFile } from './config.js';
