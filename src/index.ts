/**
 * haxlite public entry point.
 *
 *   import { HBInit } from 'haxlite';
 *   const room = await HBInit({ roomName: 'My room', token, noPlayer: true });
 *
 * Power users also get the engine (HostRoom), the transport (HostTransport),
 * replays, stadium parsing and the shared model, plus each module as a
 * namespace (`codec`, `sim`, `room`, `net`, `host`, `replay`).
 */

// ---- HBInit-compatible API
export * from './api/index.js';

// ---- engine and transport
export { HostRoom, HostDefaults, createHostRoomState, type HostRoomOptions, type Scores, type DiscProperties } from './host/index.js';
export {
  HostTransport,
  BanList,
  MasterError,
  shutdownWebRtc,
  fetchGeo,
  fetchRoomList,
  type BanRecord,
  type BanKind,
  type HostTransportOptions,
  type JoinDecision,
  type JoinRequest,
  type JoinInfo,
  type ListedRoom,
  type RoomInfo,
  EdgeError,
  type EdgeOptions,
  type EdgeBackendStats,
} from './net/index.js';

// ---- haxlite Edge (WebRTC gateway that hides the host's IP, docs/09)
export { EdgeServer, type EdgeServerOptions, type EdgeKeyConfig, type EdgeStats } from './edge/index.js';

// ---- replays (.hbr2)
export { readReplay, writeReplay, ReplayData, ReplayPlayer, ReplayRecorder } from './replay/index.js';

// ---- stadiums
export { parseHbs, HbsParseError, defaultStadiums, buildDefaultStadium } from './sim/index.js';

// ---- shared model (Player, RoomState, Stadium, Disc, … + protocol constants)
export * from './model.js';

// ---- modules as namespaces
export * as codec from './codec/index.js';
export * as sim from './sim/index.js';
export * as room from './room/index.js';
export * as net from './net/index.js';
export * as host from './host/index.js';
export * as replay from './replay/index.js';
export * as edge from './edge/index.js';
