/**
 * Protocol-wide constants (owner: foundation). Values come from docs/02..04
 * and the official headless script (hash f066733d). Only put here what more
 * than one module needs.
 */

/** Room protocol version announced/checked in the join handshake and RoomInfo. */
export const PROTOCOL_VERSION = 9;
/** `.hbr2` replay format version. */
export const REPLAY_VERSION = 3;

/** Simulation rate: 60 ticks per second, expressed as ticks per millisecond (official `0.06`). */
export const TICKS_PER_MS = 0.06;
/** Frames a "delay" event is scheduled ahead by the host (official `Sb = 2`). */
export const INPUT_DELAY_FRAMES = 2;
/** Host emits CheckConsistency every this many frames (10 s). */
export const CONSISTENCY_CHECK_INTERVAL_FRAMES = 600;
/** Max frames ahead of the current frame a client event may be scheduled. */
export const MAX_EVENT_FRAME_LEAD = 20;

/** Bits of the player input mask (SendInput payload / `player.input`). */
export const Input = {
  Up: 1,
  Down: 2,
  Left: 4,
  Right: 8,
  Kick: 16,
} as const;

/** Collision group/mask bits (`.hbs` names in comments). */
export const CollisionFlag = {
  Ball: 1, // "ball"
  Red: 2, // "red"
  Blue: 4, // "blue"
  RedKO: 8, // "redKO"
  BlueKO: 16, // "blueKO"
  Wall: 32, // "wall"
  Kick: 64, // "kick"
  Score: 128, // "score"
  C0: 1 << 28, // "c0"
  C1: 1 << 29, // "c1"
  C2: 1 << 30, // "c2"
  C3: 1 << 31, // "c3" (= -2147483648 as int32)
  All: 63, // "all" = ball|red|blue|redKO|blueKO|wall
} as const;

/** Team ids as serialized (u8/i8). */
export const TeamId = {
  Spectators: 0,
  Red: 1,
  Blue: 2,
} as const;
export type TeamId = (typeof TeamId)[keyof typeof TeamId];

/** GameState phase (`state` field, official `$a`). */
export const GamePhase = {
  BeforeKickOff: 0,
  Playing: 1,
  AfterGoal: 2,
  Ending: 3,
} as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

/**
 * Event (operation) type ids = official registration order (docs/02 §3.2).
 * 24..26 are node-haxball extensions and must never be sent to official clients.
 */
export const EventType = {
  SendAnnouncement: 0,
  SendChatIndicator: 1,
  CheckConsistency: 2,
  SendInput: 3,
  SendChat: 4,
  JoinRoom: 5,
  KickBanPlayer: 6,
  StartGame: 7,
  StopGame: 8,
  PauseResumeGame: 9,
  SetGamePlayLimit: 10,
  SetStadium: 11,
  SetPlayerTeam: 12,
  SetTeamsLock: 13,
  SetPlayerAdmin: 14,
  AutoTeams: 15,
  SetPlayerSync: 16,
  Ping: 17,
  SetAvatar: 18,
  SetTeamColors: 19,
  ReorderPlayers: 20,
  SetKickRateLimit: 21,
  SetHeadlessAvatar: 22,
  SetDiscProperties: 23,
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** WebRTC negotiated data channel ids. */
export const Channel = {
  /** "ro": reliable, ordered. Handshake, snapshot, client actions, kick, targeted messages. */
  ReliableOrdered: 0,
  /** "ru": reliable, unordered. Broadcast events (P2P msg 2). */
  ReliableUnordered: 1,
  /** "uu": unreliable (maxRetransmits 0), unordered. Frame sync (3), ping/pong. */
  Unreliable: 2,
} as const;

/** First byte of host -> client data channel messages. */
export const HostMsg = {
  Challenge: 0,
  InitialSnapshot: 1,
  Event: 2,
  FrameSync: 3,
  Pong: 4,
  Kicked: 5,
  TargetedEvent: 6,
} as const;

/** First byte of client -> host data channel messages. */
export const ClientMsg = {
  Handshake: 0,
  Event: 1,
  Ping: 2,
} as const;
