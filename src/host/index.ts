/**
 * src/host — the authoritative host engine (sequencer / netcode): 60 Hz
 * frame clock with catch-up, client event scheduling (official `Wa.Mh`),
 * host events (`oc`), heartbeats (msg 3), join snapshot (msg 1),
 * CheckConsistency, pings, kicks/bans, host actions and `.hbr2` recording.
 * See src/host/README.md (facade contract) and docs/04.
 */
export {
  DEFAULT_STADIUM_NAMES,
  HostConnection,
  HostDefaults,
  HostRoom,
  createHostRoomState,
  defaultStadiumByName,
  type DiscProperties,
  type DiscPropsInput,
  type GameInfo,
  type KickRateLimit,
  type GamePhaseName,
  type PlayerInfo,
  type LastTouches,
  type RecordingInfo,
  type RoomSettings,
  type TouchInfo,
  type HostRoomOptions,
  type Scores,
  type TeamColorsInfo,
} from './host-room.js';
export { stadiumObject, type StadiumDisc, type StadiumObject } from './stadium-info.js';
export {
  LINK_WINDOWS,
  LINK_WINDOW_MS,
  LinkStats,
  type LinkQuality,
  type LinkSample,
} from './link-stats.js';
export {
  MovingAverage,
  ProtocolViolation,
  Sequencer,
  SequencerClient,
  encodePong,
  encodeTargetedEvent,
  type BeforeOperationHook,
  type SequencerOptions,
  type SequencerSink,
} from './sequencer.js';
