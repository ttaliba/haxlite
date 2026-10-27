/**
 * src/api — HBInit-compatible public API: `HBInit(config)` → RoomObject
 * (official methods + on* callbacks) plus the namespaced `room.haxlite`
 * extensions. See README.md (sección haxlite) and src/host/README.md.
 */
export type {
  GameInfo,
  GamePhaseName,
  KickRateLimit,
  LastTouches,
  LinkQuality,
  LinkSample,
  InputAbuseKind,
  InputGuardLimits,
  MatchStatsSnapshot,
  PlayerStats,
  PlayerInfo,
  RecordingInfo,
  RoomSettings,
  StadiumDisc,
  StadiumObject,
  TouchInfo,
} from '../host/index.js';
export { HBInit, InvalidRoomTokenError, CollisionFlags, InputFlags } from './hbinit.js';
export type {
  AnnouncementSound,
  AnnouncementStyle,
  CollisionFlagsObject,
  DiscPropertiesObject,
  DiscPropertiesUpdate,
  GeoLocationConfig,
  HaxliteBans,
  HaxliteConfig,
  HaxliteRoomExtensions,
  InputFlagsObject,
  JoinRequestHandler,
  PlayerConnectionInfo,
  PlayerJoinObject,
  PlayerObject,
  RecaptchaHandler,
  RoomConfigObject,
  RoomObject,
  ScoresObject,
  TeamColorsObject,
  TeamID,
} from './types.js';
