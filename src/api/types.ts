/**
 * Public types of the HBInit-compatible API.
 *
 * The official shapes (RoomConfigObject, RoomObject, PlayerObject, …) follow
 * the official headless host documentation
 * (https://github.com/haxball/haxball-issues/wiki/Headless-Host) and the
 * official implementation (`F.fi`). The declarations are adapted from
 * haxball.js `src/types.ts` (mertushka/haxball.js, MIT License,
 * Copyright (c) mertushka) — rewritten, trimmed and extended with the
 * namespaced haxlite extensions.
 */
import type http from 'node:http';
import type {
  BanList,
  BanRecord,
  EdgeBackendStats,
  EdgeOptions,
  HostTransport,
  HostTransportOptions,
  JoinDecision,
  JoinRequest,
  RtcBackendOptions,
} from '../net/index.js';
import type { RtcEndpointStats } from '../rtc/index.js';
import type { HostRoom } from '../host/index.js';
import type { RoomEvent } from '../room/index.js';

/** 0 = spectators, 1 = red, 2 = blue. */
export type TeamID = 0 | 1 | 2;

/** Announcement styles accepted by {@link RoomObject.sendAnnouncement}. */
export type AnnouncementStyle = 'normal' | 'bold' | 'italic' | 'small' | 'small-bold' | 'small-italic';

/** Announcement sound: 0 none, 1 normal chat sound, 2 notification. */
export type AnnouncementSound = 0 | 1 | 2;

export interface GeoLocationConfig {
  /** Country code (lowercased, max 3 chars, else "Invalid country code"). */
  code: string;
  lat: number;
  lon: number;
}

/** `HBInit(config)`: every field is optional (official defaults in brackets). */
export interface RoomConfigObject {
  /** ["Headless Room"] */
  roomName?: string;
  /** Host player name ["Host"]; ignored with `noPlayer`. */
  playerName?: string;
  /** Room password [none]. */
  password?: string | null;
  /** [12], clamped to 2..30. Must be an integer. */
  maxPlayers?: number;
  /** List the room publicly [false]. */
  public?: boolean;
  /** Geolocation override [from the master's `api/geo`]. */
  geo?: GeoLocationConfig | null;
  /** Headless token from https://www.haxball.com/headlesstoken (expires after a few minutes). */
  token?: string | null;
  /** No host player [false]; host actions then report `byPlayer = null`. */
  noPlayer?: boolean;
  /** haxlite-only options (all optional; defaults reproduce the official host). */
  haxlite?: HaxliteConfig;
}

/** Disc properties (`getDiscProperties`), official field names (`bCoeff`). */
export interface DiscPropertiesObject {
  x: number;
  y: number;
  xspeed: number;
  yspeed: number;
  xgravity: number;
  ygravity: number;
  radius: number;
  bCoeff: number;
  invMass: number;
  damping: number;
  /** 0xRRGGBB, -1 = transparent. */
  color: number;
  cMask: number;
  cGroup: number;
}

/** `setDiscProperties` input: any subset; null/absent fields are left unchanged. */
export type DiscPropertiesUpdate = { [K in keyof DiscPropertiesObject]?: DiscPropertiesObject[K] | null };

export interface PlayerObject {
  /** Player name. */
  name: string;
  team: TeamID;
  /** Unique, never reused in this room. The host player is 0. */
  id: number;
  admin: boolean;
  /** Disc position, null when the player is not on the field. */
  position: { x: number; y: number } | null;
  /** Current input bitmask (see {@link InputFlagsObject}). */
  input: number;
}

/** `onPlayerJoin` argument: also carries `auth` and `conn` (only there). */
export interface PlayerJoinObject extends PlayerObject {
  /** Public id (https://www.haxball.com/playerauth); null if the identity proof failed. */
  auth: string | null;
  /** Connection id: uppercase hex of the IP as seen by the master. */
  conn: string;
}

export interface ScoresObject {
  red: number;
  blue: number;
  /** Seconds elapsed (does not advance while paused). */
  time: number;
  scoreLimit: number;
  /** Seconds (the API takes minutes in setTimeLimit; the official getter multiplies by 60). */
  timeLimit: number;
}

export interface CollisionFlagsObject {
  readonly ball: number;
  readonly red: number;
  readonly blue: number;
  readonly redKO: number;
  readonly blueKO: number;
  readonly wall: number;
  readonly kick: number;
  readonly score: number;
  readonly c0: number;
  readonly c1: number;
  readonly c2: number;
  readonly c3: number;
  readonly all: number;
}

export interface InputFlagsObject {
  readonly up: 1;
  readonly down: 2;
  readonly left: 4;
  readonly right: 8;
  readonly kick: 16;
}

/**
 * The official room object. State-changing methods are applied in a
 * microtask (official: "All API functions that modify the game's state
 * execute asynchronously"); queries are synchronous.
 */
export interface RoomObject {
  sendChat(message: string, targetId?: number | null): void;
  setPlayerAdmin(playerId: number, admin: boolean): void;
  setPlayerTeam(playerId: number, team: TeamID): void;
  kickPlayer(playerId: number, reason?: string | null, ban?: boolean): void;
  /** Removes the ban created when `playerId` was banned. Synchronous. */
  clearBan(playerId: number): void;
  /** Clears the whole ban list (including haxlite IP/range/auth bans). Synchronous. */
  clearBans(): void;
  /** No effect while a game is running. */
  setScoreLimit(limit: number): void;
  /** Minutes. No effect while a game is running. */
  setTimeLimit(limitInMinutes: number): void;
  /** Parses `.hbs` text; throws synchronously on invalid stadiums. */
  setCustomStadium(stadiumFileContents: string): void;
  /** Built-in stadium by exact name; throws "Stadium doesn't exist". */
  setDefaultStadium(stadiumName: string): void;
  setTeamsLock(locked: boolean): void;
  /** `angle` in degrees, up to 3 colors. */
  setTeamColors(team: TeamID, angle: number, textColor: number, colors: readonly number[]): void;
  startGame(): void;
  stopGame(): void;
  pauseGame(pauseState: boolean): void;
  getPlayer(playerId: number): PlayerObject | null;
  getPlayerList(): PlayerObject[];
  getScores(): ScoresObject | null;
  getBallPosition(): { x: number; y: number } | null;
  /** Starts (or restarts) a `.hbr2` recording. */
  startRecording(): void;
  /** Stops the recording: `.hbr2` bytes, or null if not recording. */
  stopRecording(): Uint8Array | null;
  setPassword(pass: string | null): void;
  setRequireRecaptcha(required: boolean): void;
  reorderPlayers(playerIdList: readonly number[], moveToTop: boolean): void;
  sendAnnouncement(
    msg: string,
    targetId?: number | null,
    color?: number | null,
    style?: AnnouncementStyle | null,
    sound?: AnnouncementSound | null,
  ): void;
  setKickRateLimit(min?: number | null, rate?: number | null, burst?: number | null): void;
  setPlayerAvatar(playerId: number, avatar: string | null): void;
  setDiscProperties(discIndex: number, properties: DiscPropertiesUpdate): void;
  getDiscProperties(discIndex: number): DiscPropertiesObject | null;
  setPlayerDiscProperties(playerId: number, properties: DiscPropertiesUpdate): void;
  getPlayerDiscProperties(playerId: number): DiscPropertiesObject | null;
  getDiscCount(): number;
  readonly CollisionFlags: CollisionFlagsObject;
  readonly InputFlags: InputFlagsObject;

  // ---------------------------------------------------------------- callbacks
  onPlayerJoin?: ((player: PlayerJoinObject) => void) | null;
  onPlayerLeave?: ((player: PlayerObject) => void) | null;
  onTeamVictory?: ((scores: ScoresObject) => void) | null;
  /** Return `false` to drop the message (official test: `result != 0`). */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  onPlayerChat?: ((player: PlayerObject, message: string) => boolean | void) | null;
  onPlayerBallKick?: ((player: PlayerObject) => void) | null;
  /** `team` = scoring team. */
  onTeamGoal?: ((team: TeamID) => void) | null;
  onGameStart?: ((byPlayer: PlayerObject | null) => void) | null;
  onGameStop?: ((byPlayer: PlayerObject | null) => void) | null;
  onPlayerAdminChange?: ((changedPlayer: PlayerObject, byPlayer: PlayerObject | null) => void) | null;
  onPlayerTeamChange?: ((changedPlayer: PlayerObject, byPlayer: PlayerObject | null) => void) | null;
  /** Always after `onPlayerLeave`. */
  onPlayerKicked?: ((kickedPlayer: PlayerObject, reason: string, ban: boolean, byPlayer: PlayerObject | null) => void) | null;
  /** 60 times per second while a game runs unpaused. */
  onGameTick?: (() => void) | null;
  onGamePause?: ((byPlayer: PlayerObject | null) => void) | null;
  onGameUnpause?: ((byPlayer: PlayerObject | null) => void) | null;
  onPositionsReset?: (() => void) | null;
  onPlayerActivity?: ((player: PlayerObject) => void) | null;
  /** Called right after `onPlayerActivity` for input changes (`player.input` is the new one). */
  onPlayerInput?: ((player: PlayerObject, prevInput: number) => void) | null;
  onStadiumChange?: ((newStadiumName: string, byPlayer: PlayerObject | null) => void) | null;
  /**
   * Room link. haxlite: `await HBInit()` resolves once the link exists, so a
   * handler assigned afterwards still receives the current link (in a microtask).
   */
  onRoomLink?: ((url: string) => void) | null;
  onKickRateLimitSet?: ((min: number, rate: number, burst: number, byPlayer: PlayerObject | null) => void) | null;
  onTeamsLockChange?: ((locked: boolean, byPlayer: PlayerObject | null) => void) | null;

  /** haxlite extensions (not part of the official API). */
  readonly haxlite: HaxliteRoomExtensions;
}

/** Called when the master server demands a reCAPTCHA (token invalid/expired). */
export type RecaptchaHandler = (sitekey: string, useRecaptchaToken: (response: string) => void) => void;

/** haxlite-only `HBInit` options, under `config.haxlite`. */
export interface HaxliteConfig {
  /** Input delay `Sb` in frames [2]. See README "netcode knobs". */
  inputDelayFrames?: number;
  /** Frames between heartbeats [7]. */
  heartbeatFrames?: number;
  /** Frames between CheckConsistency events [600]. */
  checksumIntervalFrames?: number;
  /**
   * While a game runs, simulate at least every N frames even without
   * messages [4 = 66.7 ms; official ≈ 3]. Bounds the latency of per-frame
   * callbacks (onGameTick, onTeamGoal…) and the staleness of getters;
   * integer 1–600 or Infinity (only at heartbeats/messages).
   */
  maxWakeFrames?: number;
  /** Ping event period in ms [3000]. */
  pingIntervalMs?: number;

  /** Master base URL ending in `/` ["https://www.haxball.com/rs/"]. */
  masterUrl?: string;
  /** HTTP(S)/SOCKS proxy agent used for the master HTTP API *and* the signaling WebSocket. */
  agent?: http.Agent;
  /** Overrides the signaling WebSocket URL returned by the master. */
  wsUrl?: string;
  /**
   * STUN/TURN servers ["stun:stun.l.google.com:19302"]: URL strings
   * (`turn:user:pass@host:port`) or browser-style `{urls, username, credential}`.
   */
  iceServers?: HostTransportOptions['iceServers'];

  /** Let players whose identity proof fails join with `auth = null` [true, official]. */
  allowNullAuth?: boolean;
  /** Per-IP join attempt limit, e.g. `{capacity: 3, msPerToken: 10_000}` [off]. */
  joinRateLimit?: { capacity: number; msPerToken: number; code?: number } | null;
  /** Shared ban list (e.g. one list for several rooms) [a new one per room]. */
  bans?: BanList;
  /** Pre-WebRTC join hook (see {@link HaxliteRoomExtensions.onJoinRequest}). */
  onJoinRequest?: JoinRequestHandler | null;
  /**
   * Master demanded a reCAPTCHA. Without a handler `HBInit` rejects with
   * {@link InvalidRoomTokenError} (haxball.js behaviour).
   */
  onRecaptcha?: RecaptchaHandler | null;
  /** Resolve `HBInit` only once the room link exists [true]. `false` resolves right after start. */
  waitForLink?: boolean;
  /** Reject `HBInit` if no room link after this many ms [30000]. */
  initTimeoutMs?: number;
  /** Call node-datachannel `cleanup()` when the last room of the process stops [true]. */
  shutdownWebRtcOnLastStop?: boolean;
  /** Escape hatch: extra {@link HostTransportOptions} (timeouts, RTC port range, logging…). */
  transport?: Partial<HostTransportOptions>;
  /**
   * haxlite Edge: players connect to the edge, never to this machine (its IP
   * stays hidden). `{ url: 'wss://edge.example.com:8443/tunnel', key: 'id:secret' }`;
   * `fallbackWs` (default true) carries player traffic over the WebSocket when
   * UDP to the edge is blocked. `iceServers`/`transport.iceCandidatePolicy`/
   * `transport.portRange` are then ignored (the edge has its own). See docs/09.
   */
  edge?: EdgeOptions | null;
  /**
   * Player connection stack when there is no `edge` ['ndc']:
   * `'ndc'` node-datachannel (full ICE + STUN, works behind NAT);
   * `'rtc'` haxlite-rtc (pure TypeScript ICE-lite/DTLS/SCTP: one UDP port for
   * every player, no native threads, ≈ half the CPU per player) for servers
   * with a public IP — configure it with {@link rtc}. See docs/10.
   */
  peerBackend?: 'ndc' | 'rtc';
  /**
   * `peerBackend: 'rtc'` settings: `{ port: 40000, publicAddresses: ['203.0.113.7'] }`.
   * `publicAddresses` defaults to the machine's public interface addresses;
   * without one (NAT / cloud 1:1 NAT) it must be given, or HBInit rejects.
   * Rooms of one process with the same settings share one endpoint / UDP
   * socket (`shared: false` for a socket per room); `certificateFile` keeps
   * the DTLS identity on disk; `cipherSuites` sets the DTLS preference
   * (default ChaCha20-Poly1305, then AES-GCM). See docs/10.
   */
  rtc?: RtcBackendOptions | null;
}

/** Pre-join decision: `undefined`/`true` accept, `false` reject (banned, 4102), a number = close code. */
export type JoinRequestHandler = (request: JoinRequest) => JoinDecision | Promise<JoinDecision>;

/** Connection details of a joined player (haxlite). */
export interface PlayerConnectionInfo {
  auth: string | null;
  conn: string;
  /** IP as seen by the master. */
  ip: string;
  /** Server-reflexive IPs from the player's ICE candidates (banned too by an official kick-ban). */
  srflxIps: readonly string[];
  /** Ping declared by the client (ms). */
  ping: number;
  /** Remote address of the selected ICE pair (as seen by this host, or by the edge). */
  remoteAddress: string | null;
}

/** Ban list operations exposed as `room.haxlite.bans`. */
export interface HaxliteBans {
  /** Bans one IP (v4/v6). Applies to future joins. */
  addIp(ip: string, note?: string | null): BanRecord;
  /** Bans a CIDR range (`203.0.113.0/24`, `2001:db8::/32`). */
  addRange(cidr: string, note?: string | null): BanRecord;
  /** Bans a public key (`player.auth`): rejected after the handshake, before joining. */
  addAuth(auth: string, note?: string | null): BanRecord;
  list(): BanRecord[];
  remove(id: number): boolean;
  clear(): void;
  isIpBanned(ip: string): boolean;
  isAuthBanned(auth: string | null): boolean;
}

/** `room.haxlite`: namespaced haxlite extensions. */
export interface HaxliteRoomExtensions {
  /** Input delay `Sb` (frames). Live-tunable. */
  inputDelayFrames: number;
  /** Heartbeat period (frames). Live-tunable. */
  heartbeatFrames: number;
  /** CheckConsistency period (frames). */
  checksumIntervalFrames: number;
  /** Catch-up bound while a game runs (frames, or Infinity). Live-tunable. */
  maxWakeFrames: number;
  /** Current room link (null until the master assigns it). */
  readonly roomLink: string | null;
  /** Current frame number of the host clock. */
  readonly frame: number;
  /** True after stop()/close(). */
  readonly stopped: boolean;
  readonly bans: HaxliteBans;

  /**
   * Called for every client event after frame assignment and the chat
   * filter, before it is applied/broadcast. Return `false` to drop it;
   * payload fields may be mutated; throwing kicks the sender ("Bad actor").
   * Called for inputs too: keep it cheap.
   */
  onBeforeOperation: ((event: RoomEvent, byPlayerId: number, requestedFrame: number) => boolean | void) | null;
  /** Pre-WebRTC join hook (async allowed). See {@link JoinRequestHandler}. */
  onJoinRequest: JoinRequestHandler | null;
  /** Master demanded a captcha after init (e.g. on reconnect). Answer with {@link useRecaptchaToken}. */
  onRecaptcha: ((sitekey: string) => void) | null;
  /** Errors thrown by room callbacks and transport errors. Default: `console.error`. */
  onError: ((err: unknown) => void) | null;
  /** Retries the master registration with a reCAPTCHA response. */
  useRecaptchaToken(response: string): void;

  /** Connection details of a joined player (null for the host player / unknown ids). */
  getPlayerConnection(playerId: number): PlayerConnectionInfo | null;
  /** Changes the capacity at runtime (not possible officially). */
  setMaxPlayers(n: number): void;

  /**
   * Private visuals: changes disc `discIndex` ONLY for player `viewerId`
   * (e.g. a fog / vision mask, a task marker). Deferred like the official
   * setters. Must be a "visual-only" stadium disc: not disc 0, not a player
   * disc, in no joint, cGroup 0 in every world (nothing can touch, kick or
   * score with it), so the viewer's game plays exactly like everyone
   * else's; otherwise the update is rejected through `onError`, unless
   * `opts.force` (then that viewer may really see another game). The host
   * simulates the viewer's world and sends it its own CheckConsistency hash:
   * no desync flag, nobody else sees anything. Overrides vanish when the
   * worlds become equal again: game stop/start, stadium change, a kick-off
   * reset that resets the disc, or {@link clearDiscOverrides}; and when the
   * viewer leaves. docs/04 §7.4.
   */
  setDiscPropertiesFor(viewerId: number, discIndex: number, properties: DiscPropertiesUpdate, opts?: { force?: boolean }): void;
  /** Restores, for `viewerId`, the room's values of every disc field it had overridden (deferred). */
  clearDiscOverrides(viewerId: number): void;
  /** A disc as `viewerId` currently sees it (its private world, else the room's). */
  getDiscPropertiesFor(viewerId: number, discIndex: number): DiscPropertiesObject | null;
  /**
   * Hidden players: makes player `playerId` completely invisible to
   * `viewerId` only (no disc, name, avatar or off-screen arrow in the
   * official client) while it keeps playing normally for everyone else.
   * In the viewer's world the disc gets position NaN and cGroup 0; the host
   * simulates that world and sends it its own CheckConsistency hash, so
   * nobody desyncs. Re-hidden automatically after a respawn (kick-off reset,
   * team change). What the hidden player does to other discs in the room is
   * copied to the viewer's world (shared SetDiscProperties, float32).
   * Deferred like the official setters; errors go to `onError`. Pairs end
   * with the game and when either player leaves. Not a security boundary:
   * the room state still reaches every client. docs/04 §7.4.
   */
  hidePlayerFor(viewerId: number, playerId: number): void;
  /** Undoes {@link hidePlayerFor}: the viewer gets the player's real disc back (deferred). */
  showPlayerFor(viewerId: number, playerId: number): void;
  /** `hidden ? hidePlayerFor : showPlayerFor`. */
  setPlayerHiddenFor(viewerId: number, playerId: number, hidden: boolean): void;
  /** True while `playerId` is hidden from `viewerId` (after the deferred call ran). */
  isPlayerHiddenFor(viewerId: number, playerId: number): boolean;
  /** Ids of the players hidden from `viewerId`. */
  getHiddenPlayersFor(viewerId: number): number[];
  /** True while `viewerId` has a private world (overrides applied and not yet converged). */
  hasPrivateView(viewerId: number): boolean;
  /** A private view ended because the viewer's world became identical to the room's again. */
  onPrivateViewEnd: ((viewerId: number) => void) | null;
  /** Edge tunnel statistics (state, data plane, RTT, peers, bytes), null without `haxlite.edge`. */
  edgeStats(): EdgeBackendStats | null;
  /** haxlite-rtc endpoint counters (sessions, packets, bytes, handshakes; of the whole shared endpoint), null unless `peerBackend: 'rtc'`. */
  rtcStats(): RtcEndpointStats | null;
  /** UDP port players connect to with `peerBackend: 'rtc'` (null otherwise / until listening). */
  readonly rtcPort: number | null;
  /**
   * Edge tunnel availability: `'down'` = tunnel lost (every player was
   * disconnected; joins refused until it reconnects), `'ready'` = (re)connected.
   */
  onBackendState: ((state: 'ready' | 'down', err: Error | null) => void) | null;

  /** Stops the room: timers, signaling, every peer. Idempotent. */
  stop(): Promise<void>;
  /** Alias of {@link stop}. */
  close(): Promise<void>;

  /** Power users: the engine and transport behind this room. */
  readonly host: HostRoom;
  readonly transport: HostTransport;
}
