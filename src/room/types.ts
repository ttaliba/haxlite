/**
 * Shared model contract — room side (owner of behaviour: engineer B).
 * Same conventions as src/sim/types.ts: field order = official wire order;
 * `off:` official minified name, `nh:` node-haxball public / api.js name,
 * `bin:` wire type.
 */
import type { Disc, Stadium } from '../sim/types.js';
import { World } from '../sim/types.js';
import type { TouchTracker } from './touches.js';
import { GamePhase, TeamId } from '../protocol.js';

/**
 * Static team descriptor (official class `v`, instances `v.oa` spectators,
 * `v.fa` red, `v.ta` blue; nh `Team` / `IM`). Teams are referenced by id
 * (0/1/2) everywhere in the model; look the descriptor up in {@link TEAMS}.
 */
export interface TeamInfo {
  /** off `P` · nh `id` */
  readonly id: TeamId;
  /** Default colour. off `T`. */
  readonly color: number;
  /** Field side used for spawning: red -1, blue +1, spec 0. off `Re`. */
  readonly side: number;
  /** Kick-off barrier flag OR-ed into player cMask: red 8, blue 16, spec -1. off `ih`. */
  readonly koFlag: number;
  /** off `pa`. */
  readonly name: string;
  /** Collision group of the team's player discs: red 2, blue 4, spec 0. off `o`. */
  readonly cGroup: number;
  /** Opposing team id (spec -> spec). off `$c`. */
  readonly rival: TeamId;
}

export const TEAMS: readonly [TeamInfo, TeamInfo, TeamInfo] = [
  { id: TeamId.Spectators, color: 0xffffff, side: 0, koFlag: -1, name: 'Spectators', cGroup: 0, rival: TeamId.Spectators },
  { id: TeamId.Red, color: 0xe56e56, side: -1, koFlag: 8, name: 'Red', cGroup: 2, rival: TeamId.Blue },
  { id: TeamId.Blue, color: 0x5689e5, side: 1, koFlag: 16, name: 'Blue', cGroup: 4, rival: TeamId.Red },
];

/** Team colours. off `W` · nh `TeamColors`. Wire: u8 angle, i32 text, u8 n (<=3, else "too many"), n × i32. */
export class TeamColors {
  /** off `Ke` (left undefined by the official ctor -> serializes as 0) · nh `angle` · bin u8 (= 256·deg/360) */
  angle = 0;
  /** off `ce` · nh `text` · bin i32. Default 0xFFFFFF. */
  textColor = 0xffffff;
  /** off `Qa` · nh `inner` · bin u8 n + n×i32 (max 3) */
  colors: number[] = [];
}

/**
 * Player. off `Ka` · nh `Player` / `NG`.
 * Wire order below (official `Ka.S`). `ping`, `conn`, `auth` are host-side
 * metadata and are NOT serialized.
 */
export class Player {
  /** off `Eb` · nh `isAdmin` / `zE` · bin u8 */
  isAdmin = false;
  /** Number shown on the disc (1-based slot within the team, set on reset/join). off `Hb` · nh `avatarNumber` / `yE` · bin i32 */
  avatarNumber = 0;
  /** off `Gb` · nh `avatar` / `jM` · bin nullableString (<=2 chars) */
  avatar: string | null = null;
  /** off `Wf` · nh `headlessAvatar` / `OG` · bin nullableString (set by host API setPlayerAvatar) */
  headlessAvatar: string | null = null;
  /** "Desynchronized" flag set by SetPlayerSync. off `me` · nh `sync` / `fW` · bin u8 */
  desync = false;
  /** Country code. off `country` · nh `flag` / `QM` · bin nullableString */
  flag: string | null = null;
  /**
   * Unnamed i32 present in the wire format. off `Ai` · nh `la` (no public
   * name) · bin i32. Never read or written by game logic in the headless
   * host; always 0 there. Keep it and serialize it as-is.
   */
  reservedI32 = 0;
  /** off `pa` · nh `name` / `U` · bin nullableString. Official default "Player". */
  name: string | null = 'Player';
  /** Input bitmask (see protocol Input). off `kb` · nh `input` / `wM` · bin i32 */
  input = 0;
  /** off `na` · nh `id` / `M` · bin varuint */
  id = 0;
  /** off `Fb` · nh `isKicking` / `FE` · bin u8 */
  isKicking = false;
  /** Kick-rate token bucket. off `Xb` · nh `kickRateMaxTickCounter` / `rW` · bin i16 */
  kickRateMaxTickCounter = 0;
  /** Ticks until next kick allowed. off `vc` · nh `kickRateMinTickCounter` / `QW` · bin u8 */
  kickRateMinTickCounter = 0;
  /** off `ja` (Team) · nh `team` / `K` · bin u8 (0 spec, 1 red, 2 blue) */
  team: TeamId = TeamId.Spectators;
  /** off `N` · nh `disc` / `n` · bin i16 = `disc.index` or -1 when null */
  disc: Disc | null = null;

  // ---- not serialized ----
  /** Last reported ping in ms (set by the Ping event). off `ad` · nh `ping`. */
  ping = 0;
  /** Connection id string shown by HBInit (hex of IP). nh `conn`. */
  conn = '';
  /** Public auth key if the identity proof verified, else null. nh `auth`. */
  auth: string | null = null;
  /** Contact / kick bits kept by {@link TouchTracker} (0 while tracking is off). nh `touchState`. */
  touchState = 0;
}

/**
 * Running game. off `Q` · nh `GameState` / `kM`.
 * Wire (official `Q.G`): World, i32 goalTickCounter, i32 phase, i32 redScore,
 * i32 blueScore, f64 timeElapsed, i32 pauseGameTickCounter, u8 goalConcedingTeam.
 */
export class GameState {
  /** off `ia` · nh `physicsState` / `q` · bin World */
  world = new World();
  /** 150 after a goal, 300 when ending; counts down. off `Cb` · nh `goalTickCounter` / `mE` · bin i32 */
  goalTickCounter = 0;
  /** off `$a` · nh `state` / `a` · bin i32 (GamePhase) */
  phase: GamePhase = GamePhase.BeforeKickOff;
  /** off `Bb` · nh `redScore` / `XE` · bin i32 */
  redScore = 0;
  /** off `xb` · nh `blueScore` / `LE` · bin i32 */
  blueScore = 0;
  /** Seconds (+= 1/60 per Playing tick, literal 0.016666666666666666). off `Nb` · nh `timeElapsed` / `dW` · bin f64 */
  timeElapsed = 0;
  /** 120 = paused; counts down to 0 after resume (set to 119). off `Xa` · nh `pauseGameTickCounter` / `fE` · bin i32 */
  pauseGameTickCounter = 0;
  /** Team that kicks off next (= team that conceded last). Starts red. off `Md` · nh `goalConcedingTeam` / `GG` · bin u8 */
  goalConcedingTeam: TeamId = TeamId.Red;

  // ---- not serialized (copied from RoomState / Stadium at game start) ----
  /** off `ab` · nh `scoreLimit` */
  scoreLimit = 0;
  /** Minutes. off `Na` · nh `timeLimit` */
  timeLimit = 0;
  /** off `ea` · nh `stadium` / `r` */
  stadium: Stadium | null = null;
}

/**
 * Callback slots fired from inside event `apply` and the game tick (official
 * RoomState callback fields; the headless wires them to HBInit `on*`).
 * Every slot is `null` by default and is tested with a single null check, so
 * an unset hook costs nothing. Hooks must not mutate the room synchronously
 * (the official host schedules every change as an event).
 */
export class RoomHooks {
  /** Start of every unpaused game tick. off `Og`. */
  onGameTick: (() => void) | null = null;
  /** A player kicked at least one `kick` disc this tick. off `wf`. */
  onPlayerBallKick: ((player: Player) => void) | null = null;
  /** Goal scored; `team` = SCORING team. off `Mf` (called with `goalOwner.rival`). */
  onTeamGoal: ((team: TeamId) => void) | null = null;
  /** Goal scored; `goalOwner` = team that owns the goal crossed (replay goal marker). off `zf`. */
  onGoalMarker: ((goalOwner: TeamId) => void) | null = null;
  /** Time limit reached with untied score (right before the game ends). off `ji`. */
  onTimeLimitReached: (() => void) | null = null;
  /** Positions reset after a goal (kick-off). off `xf`. */
  onPositionsReset: (() => void) | null = null;
  /** Game entered the 300-tick Ending phase. off `Nf`. */
  onTeamVictory: ((winner: TeamId) => void) | null = null;
  /** off `Kf`. `byPlayer` null when issued by the host (id 0). */
  onGameStart: ((byPlayer: Player | null) => void) | null = null;
  /** off `md`. `byPlayer` null when issued by the host or when the Ending phase finished. */
  onGameStop: ((byPlayer: Player | null) => void) | null = null;
  /** off `Ch`: (by, paused, wasPausedOrResuming = pauseGameTickCounter > 0 before). */
  onGamePauseChange: ((byPlayer: Player | null, paused: boolean, wasPaused: boolean) => void) | null = null;
  /** off `Eh`. */
  onPlayerJoin: ((player: Player) => void) | null = null;
  /** Player removed (leave if `reason === null`, else kick/ban). off `Fh`. */
  onPlayerLeave: ((player: Player, reason: string | null, ban: boolean, byPlayer: Player | null) => void) | null = null;
  /** Chat message applied. off `Li`. */
  onPlayerChat: ((player: Player, message: string) => void) | null = null;
  /** Host-side validation before accepting a SendChat (false = drop). off `uf` (via event `fg`). */
  onPlayerChatFilter: ((player: Player, message: string) => boolean) | null = null;
  /** off `Ni`. */
  onChatIndicator: ((player: Player, value: number) => void) | null = null;
  /** SendInput applied to a player that has a disc. off `vf`. */
  onPlayerInput: ((player: Player, previousInput: number) => void) | null = null;
  /** off `Gh`. */
  onPlayerTeamChange: ((byPlayer: Player | null, player: Player, team: TeamId) => void) | null = null;
  /** off `tf`. */
  onPlayerAdminChange: ((byPlayer: Player | null, player: Player) => void) | null = null;
  /** SetPlayerSync changed a player's desync flag. off `Mi`. */
  onPlayerDesyncChange: ((player: Player) => void) | null = null;
  /** CheckConsistency applied: `desynced` = local checksum differs. off `Ki`. */
  onConsistencyResult: ((desynced: boolean) => void) | null = null;
  /** off `Oi`. */
  onAnnouncement: ((message: string, color: number, style: number, sound: number) => void) | null = null;
  /** off `If`. */
  onStadiumChange: ((byPlayer: Player | null, stadium: Stadium) => void) | null = null;
  /** off `hh`: (by, min, rate, burst-after-clamp). */
  onKickRateLimitSet: ((byPlayer: Player | null, min: number, rate: number, burst: number) => void) | null = null;
  /** off `ii`. */
  onTeamsLockChange: ((byPlayer: Player | null, locked: boolean) => void) | null = null;
  /** SetTeamColors applied to a team (haxlite; the official host has no such callback). */
  onTeamColorsChange: ((byPlayer: Player | null, team: TeamId, colors: TeamColors) => void) | null = null;
  /** A different player than before started touching or kicked a `kick` disc; needs {@link RoomState.touches} (haxlite). */
  onPlayerTouch: ((player: Player, previous: Player | null) => void) | null = null;
}

/**
 * Whole room state. off `Ta` · nh `RoomState` / `pE`.
 * Wire (official `Ta.G`): see field order. The consistency checksum is
 * xorInt32Words(serialize(roomState)).
 */
export class RoomState {
  /** off `Wd` · nh `name` / `U` · bin nullableString */
  name: string | null = '';
  /** off `nd` · nh `teamsLocked` / `vW` · bin u8 */
  teamsLocked = false;
  /** off `ab` · nh `scoreLimit` / `BM` · bin i32. Default 3. */
  scoreLimit = 3;
  /** Minutes. off `Na` · nh `timeLimit` / `KM` · bin i32. Default 3. */
  timeLimit = 3;
  /** = rate × burst. off `Od` · nh `kickRate_max` / `aG` · bin i16. Default 1. */
  kickRateMax = 1;
  /** off `hc` · nh `kickRate_rate` / `wW` · bin u8. Default 0. */
  kickRateRate = 0;
  /** off `Yc` · nh `kickRate_min` / `RW` · bin u8. Default 2. */
  kickRateMin = 2;
  /** off `ea` · nh `stadium` / `r` · bin Stadium (default: built-in Classic, id 0) */
  stadium: Stadium | null = null;
  /** off `D` · nh `gameState` / `i` · bin u8 present + GameState */
  gameState: GameState | null = null;
  /** List order matters (physics order, ReorderPlayers). off `ba` · nh `players` / `t` · bin u8 n + n×Player */
  players: Player[] = [];
  /** off `tc[1]` · nh `teamColors[1]` / `aW[1]` · bin TeamColors (default colours [0xE56E56]) */
  redColors = new TeamColors();
  /** off `tc[2]` · nh `teamColors[2]` / `aW[2]` · bin TeamColors (default colours [0x5689E5]) */
  blueColors = new TeamColors();

  // ---- not serialized ----
  /** Callback slots (see {@link RoomHooks}). */
  hooks = new RoomHooks();
  /** Last / previous toucher of the ball; null (the default) = not tracked, no cost. See {@link TouchTracker}. */
  touches: TouchTracker | null = null;

  constructor() {
    this.redColors.colors.push(TEAMS[1].color);
    this.blueColors.colors.push(TEAMS[2].color);
  }
}
