/**
 * src/api — HBInit-compatible public API: `HBInit(config)` → RoomObject
 * (official methods + on* callbacks) plus the namespaced `room.haxlite`
 * extensions. See README.md (sección haxlite) and src/host/README.md.
 */
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
  TeamID,
} from './types.js';
