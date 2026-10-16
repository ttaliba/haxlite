/**
 * HostRoom: the authoritative host engine (official headless `Wa` + the
 * glue of `HBInit`), on top of {@link HostTransport} and {@link Sequencer}.
 *
 *   clock      frame = ((now - start) * 0.06) | 0, every pending frame is
 *              simulated on each wake-up (official `Wa.Da`). Wake-ups come
 *              from ONE process-wide timer ({@link hostClock}) aligned to the
 *              next frame that has work: heartbeat / checksum (/ queued event
 *              without a game), the Ping event, and while a game runs at
 *              least every `maxWakeFrames`. No players and no game = no
 *              wake-ups at all. Every client message catches up first.
 *   messages   client msg 1 -> {@link Sequencer.clientMessage}, msg 2 -> pong
 *              (msg 4); any error -> "Bad actor" (KickBanPlayer broadcast + close).
 *   joins      JoinRoom event, then the snapshot (msg 1) to the new client.
 *   leaves     KickBanPlayer(id, null); kicks/bans send msg 5 to the target.
 *   actions    host events as player 0 (official `oc`), targeted msg 6 (`Ef`).
 *
 * Re-entrancy: room hooks run while the sequencer applies events / steps.
 * Any HostRoom action called from inside a hook is deferred until the current
 * apply/step loop finishes (the official HBInit defers every action to a
 * microtask; see README for parity notes).
 */
import { Reader, Writer } from '../codec/index.js';
import type { HostTransport, JoinInfo, Peer, PeerCloseReason } from '../net/index.js';
import { Channel, ClientMsg, EventType, TICKS_PER_MS, TeamId } from '../protocol.js';
import {
  JoinRoomEvent,
  KickBanPlayerEvent,
  PauseResumeGameEvent,
  PingEvent,
  ReorderPlayersEvent,
  SendAnnouncementEvent,
  SendChatEvent,
  SendInputEvent,
  SetDiscPropertiesEvent,
  SetGamePlayLimitEvent,
  SetHeadlessAvatarEvent,
  SetKickRateLimitEvent,
  SetPlayerAdminEvent,
  SetPlayerTeamEvent,
  SetStadiumEvent,
  SetTeamColorsEvent,
  SetTeamsLockEvent,
  StartGameEvent,
  StopGameEvent,
  TeamColors,
  DiscProp,
  PAUSED_TICKS,
  createRoomState,
  getPlayer,
  Player,
  type DiscPropName,
  type RoomEvent,
  type RoomState,
} from '../room/index.js';
import { defaultStadium, parseHbs, type Disc, type Stadium } from '../sim/index.js';
import { ReplayRecorder } from '../replay/index.js';
import { ClockEntry, hostClock } from './clock.js';
import {
  ProtocolViolation,
  Sequencer,
  SequencerClient,
  encodePong,
  encodeTargetedEvent,
  type BeforeOperationHook,
  type SequencerSink,
} from './sequencer.js';

/** Official defaults. */
export const HostDefaults = {
  /** off `Sb`. */
  inputDelayFrames: 2,
  /** off `7 <= da - df` in `Wa.Da`. */
  heartbeatFrames: 7,
  /** off `Bg`. */
  checksumIntervalFrames: 600,
  /** `setInterval(() => D.oc(da.V(D)), 3e3)`. */
  pingIntervalMs: 3000,
  /**
   * While a game runs, catch up at least every 4 frames (66.7 ms; the
   * official host runs every 50 ms = ~3 frames). With the default heartbeat
   * of 7 frames that is 2 wake-ups per heartbeat (~17/s, official 20/s).
   */
  maxWakeFrames: 4,
} as const;

export interface HostRoomOptions {
  transport: HostTransport;
  /** Initial state (e.g. from {@link createHostRoomState}). Default: empty Classic room. */
  state?: RoomState;
  /**
   * Input delay `Sb` in frames (default 2, official). Host-only knob,
   * compatible with official clients: the pong carries it, so clients
   * schedule their inputs `Sb` frames ahead. Higher = fewer late inputs on
   * jittery links, lower = less input lag.
   */
  inputDelayFrames?: number;
  /**
   * Frames between heartbeats (msg 3). Default 7 (official parity). Clients
   * only advance their confirmed state on heartbeats, so lower values (e.g. 2)
   * shorten their extrapolation window (smoother remote players) at the cost
   * of ~9 bytes per client per heartbeat.
   */
  heartbeatFrames?: number;
  /** Frames between CheckConsistency events (default 600 = 10 s, official). */
  checksumIntervalFrames?: number;
  /** Ping event period (default 3000 ms). Only runs while clients are connected. */
  pingIntervalMs?: number;
  /**
   * While a game runs, the host simulates at least every this many frames
   * even when no message arrives (default 4 = 66.7 ms; official ≈ 3). It
   * bounds how late per-frame hooks (`onGameTick`, `onTeamGoal`, …) fire and
   * how stale queries are between messages; frames are always simulated
   * one by one (batched like the official 50 ms loop), so the result is the
   * same. Lower = more wake-ups; `Infinity` = only at heartbeats/messages.
   */
  maxWakeFrames?: number;
  /** Clock (ms) for tests. Default `performance.now`. */
  now?: () => number;
}

/** A joined client (official `Za` + `yb` entry). */
export class HostConnection extends SequencerClient {
  readonly peer: Peer;
  /** Verified public key or null (`player.auth`). */
  readonly auth: string | null;
  /** `player.conn`. */
  readonly conn: string;
  /** Received its snapshot: gets broadcasts (off `dd`). */
  ready = false;
  /** Removed from the room's connection tables. */
  closed = false;

  constructor(playerId: number, peer: Peer, auth: string | null, conn: string) {
    super(playerId);
    this.peer = peer;
    this.auth = auth;
    this.conn = conn;
  }
}

/** HBInit `DiscPropertiesObject` shape. */
export interface DiscProperties {
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
  color: number;
  cMask: number;
  cGroup: number;
}

/** HBInit `ScoresObject` shape. `timeLimit` in seconds. */
export interface Scores {
  red: number;
  blue: number;
  time: number;
  scoreLimit: number;
  timeLimit: number;
}

export type DiscPropsInput = Partial<Record<DiscPropName | 'bCoeff', number | null>>;

/**
 * Initial room state as the official `HBInit` builds it: room name and,
 * unless `noPlayer`, the host player (id 0, admin, `flag` = geo code).
 */
export function createHostRoomState(
  opts: { roomName?: string; playerName?: string; noPlayer?: boolean; flag?: string | null; stadium?: Stadium } = {},
): RoomState {
  const rs = createRoomState(opts.stadium);
  rs.name = opts.roomName ?? 'Headless Room';
  if (!opts.noPlayer) {
    const p = new Player();
    p.name = opts.playerName ?? 'Host';
    p.isAdmin = true;
    p.flag = opts.flag ?? null;
    rs.players.push(p);
  }
  return rs;
}

function discProperties(d: Disc | null): DiscProperties | null {
  if (d === null) return null;
  return {
    x: d.x,
    y: d.y,
    xspeed: d.xspeed,
    yspeed: d.yspeed,
    xgravity: d.xgravity,
    ygravity: d.ygravity,
    radius: d.radius,
    bCoeff: d.bCoef,
    invMass: d.invMass,
    damping: d.damping,
    color: d.color,
    cMask: d.cMask,
    cGroup: d.cGroup,
  };
}

const DISC_FIELDS = Object.keys(DiscProp) as DiscPropName[];

/** SendInput of `playerId` without the kick bit (what a viewer that hides it receives). */
function stripKick(playerId: number, input: number): SendInputEvent {
  const e = SendInputEvent.create(input & ~16);
  e.byId = playerId;
  return e;
}

/** SetDiscProperties mask of the fields where `a` and `b` differ (floats by Object.is, ints as serialized). */
function discDiffMask(a: Disc, b: Disc): number {
  let m = 0;
  if (!Object.is(a.x, b.x)) m |= 1;
  if (!Object.is(a.y, b.y)) m |= 2;
  if (!Object.is(a.xspeed, b.xspeed)) m |= 4;
  if (!Object.is(a.yspeed, b.yspeed)) m |= 8;
  if (!Object.is(a.xgravity, b.xgravity)) m |= 16;
  if (!Object.is(a.ygravity, b.ygravity)) m |= 32;
  if (!Object.is(a.radius, b.radius)) m |= 64;
  if (!Object.is(a.bCoef, b.bCoef)) m |= 128;
  if (!Object.is(a.invMass, b.invMass)) m |= 256;
  if (!Object.is(a.damping, b.damping)) m |= 512;
  if (a.color >>> 0 !== b.color >>> 0) m |= 1024;
  if ((a.cMask | 0) !== (b.cMask | 0)) m |= 2048;
  if ((a.cGroup | 0) !== (b.cGroup | 0)) m |= 4096;
  return m;
}

/** Names of the built-in stadiums by `defaultStadiumId` (= `defaultStadiums()` order). */
export const DEFAULT_STADIUM_NAMES: readonly string[] = [
  'Classic', 'Easy', 'Small', 'Big', 'Rounded', 'Hockey', 'Big Hockey', 'Big Easy', 'Big Rounded', 'Huge',
];

/**
 * The shared built-in stadium called `name` (the `defaultStadiums()`
 * instance), or null. Builds only that one, not all ten.
 */
export function defaultStadiumByName(name: string): Stadium | null {
  const id = DEFAULT_STADIUM_NAMES.indexOf(name);
  return id < 0 ? null : defaultStadium(id);
}

function teamOf(v: number): TeamId {
  return v === 1 ? TeamId.Red : v === 2 ? TeamId.Blue : TeamId.Spectators;
}

export class HostRoom {
  readonly state: RoomState;
  readonly transport: HostTransport;
  readonly sequencer: Sequencer;
  readonly pingIntervalMs: number;
  /** Created on first use (its buffers are ~17 KB): see {@link recorder}. */
  private rec: ReplayRecorder | null = null;

  // ---------------------------------------------------------------- callbacks
  /** A player joined (after the JoinRoom event applied; `auth`/`conn` set). Official `onPlayerJoin`. */
  onPlayerJoin: ((player: Player) => void) | null = null;
  /** A player left or was kicked (fires first, like official `onPlayerLeave`). */
  onPlayerLeave: ((player: Player) => void) | null = null;
  /** After onPlayerLeave when the removal had a reason (kick/ban). Official `onPlayerKicked`. */
  onPlayerKicked: ((player: Player, reason: string, ban: boolean, byPlayer: Player | null) => void) | null = null;
  /** Official `onRoomLink`. */
  onRoomLink: ((link: string) => void) | null = null;
  /** A client was dropped for a protocol violation (diagnostics). */
  onBadActor: ((playerId: number, err: unknown) => void) | null = null;
  /** Exceptions from user callbacks / hooks (never thrown into the engine). */
  onError: ((err: unknown) => void) | null = null;
  /** Every event applied to the room, in order, with its frame (official `Ab`; recorder/tests). */
  onEventApplied: ((ev: RoomEvent) => void) | null = null;
  /**
   * A private view ended because the viewer's world became identical to the
   * room's again (game stop/start, stadium change, kick-off reset,
   * {@link clearDiscOverrides}…). Not called when the viewer leaves.
   */
  onPrivateViewEnd: ((viewerId: number) => void) | null = null;

  /** Per viewer: disc index -> SetDiscProperties mask of the fields it overrode (for clearDiscOverrides). */
  private readonly discOverrides = new Map<number, Map<number, number>>();
  /** Private disc updates waiting for the next flush (batched into shared slots). */
  private readonly pendingPrivate: { viewerId: number; ev: SetDiscPropertiesEvent; force: boolean; restore: boolean }[] = [];
  private privateFlushQueued = false;
  /** Per viewer: ids of the players hidden from it ({@link setPlayerHiddenFor}). */
  private readonly hiddenFor = new Map<number, Set<number>>();
  /** The game the hidden pairs belong to (they end with it). */
  private hiddenGame: RoomState['gameState'] = null;
  /** Viewers whose world is kept equal to the room's except for what they hide or override. */
  private readonly reconciling = new Set<number>();
  private readonly flushPrivateFn = (): void => this.flushPrivate();

  private readonly now: () => number;
  /** No injected clock: room time = performance.now(), the shared clock's time base. */
  private readonly realClock: boolean;
  /**
   * Room time of frame 0. With the real clock it sits on the process-wide
   * 60 Hz grid (`gridBase / TICKS_PER_MS`), so rooms due on the same frame
   * boundary share one wake-up of the shared clock.
   */
  private readonly startTime: number;
  /** Index of frame 0 on the process-wide frame grid (real clock), else 0. */
  private readonly gridBase: number;
  /** Connections by player id (official `yb`). */
  private readonly connections = new Map<number, HostConnection>();
  /** Connections that got their snapshot, in join order (broadcast targets). */
  private readonly ready: HostConnection[] = [];
  /** Ban record id by kicked player id (official `Cc`), for clearBan(playerId). */
  private readonly bansByPlayer = new Map<number, number>();
  /** off `wh`. */
  private nextPlayerId = 1;
  private running = false;
  private hbFrames: number;
  private csFrames: number;
  private wakeFrames: number;
  /** Registration in the shared clock (wake-up callback bound once). */
  private readonly clockEntry = new ClockEntry(() => this.onWake());
  /** Frame / ping time last handed to the clock (avoids re-arming when unchanged). */
  private wakeFrame = NaN;
  private wakePing = NaN;
  /** Room-clock ms of the next Ping event (Infinity while no client is ready). */
  private nextPingAt = Infinity;
  /** Room-clock ms the Ping event is nominally due (nextPingAt = that, rounded up to the grid). */
  private pingDue = Infinity;
  private readonly deferred: (() => void)[] = [];
  private flushing = false;
  private readonly pongWriter = new Writer(32);
  /** Reused for every client message (a nested message gets its own). */
  private readonly reader = new Reader(new Uint8Array(0));
  private readerBusy = false;
  /**
   * The peer backend's bundling scope (haxlite-rtc), or null: every wake-up,
   * client message and top-level action runs inside it, so all the messages
   * one peer gets from it (event, heartbeat, pong, SACK…) leave as one packet
   * when it ends — before control returns to the event loop.
   */
  private readonly bundle: { cork(): void; uncork(): void } | null;

  constructor(opts: HostRoomOptions) {
    this.transport = opts.transport;
    const b = (opts.transport as Partial<HostTransport>).backend;
    this.bundle = b !== undefined && b.cork !== undefined && b.uncork !== undefined ? (b as { cork(): void; uncork(): void }) : null;
    this.state = opts.state ?? createHostRoomState();
    this.realClock = opts.now === undefined;
    this.now = opts.now ?? (() => performance.now());
    this.hbFrames = opts.heartbeatFrames ?? HostDefaults.heartbeatFrames;
    this.csFrames = opts.checksumIntervalFrames ?? HostDefaults.checksumIntervalFrames;
    this.wakeFrames = HostRoom.checkWakeFrames(opts.maxWakeFrames ?? HostDefaults.maxWakeFrames);
    this.pingIntervalMs = opts.pingIntervalMs ?? HostDefaults.pingIntervalMs;
    const sink: SequencerSink = {
      // one tunnel message for everyone when the players are behind a haxlite Edge
      broadcast: (data, channel, skip) => {
        if (skip == null || skip.size === 0) {
          this.transport.broadcastTo(this.ready, channel, data);
          return;
        }
        const list = this.ready.filter((c) => !skip.has(c.playerId));
        this.transport.broadcastTo(list, channel, data);
      },
      sendTo: (playerId, data, channel) => {
        const c = this.connections.get(playerId);
        if (c !== undefined && c.ready && !c.closed) this.transport.send(c.peer, channel, data);
      },
      hasConnections: () => this.transport.connectionCount > 0,
    };
    this.sequencer = new Sequencer(this.state, sink, {
      inputDelayFrames: opts.inputDelayFrames ?? HostDefaults.inputDelayFrames,
    });
    this.sequencer.onError = (err) => this.reportError(err);
    this.sequencer.onViewConverged = (id) => {
      this.discOverrides.delete(id);
      const cb = this.onPrivateViewEnd;
      if (cb !== null) this.callUser(() => cb(id));
    };
    // hidden players never kick in the viewer's world: some clients (node-haxball 2.3.1:
    // `!(dist - r - r >= 4)`) would kick from a NaN position and turn the ball into NaN
    this.sequencer.viewVariant = (ev, viewerId) => {
      if (ev.type !== EventType.SendInput || this.hiddenFor.size === 0) return null;
      const input = (ev as SendInputEvent).input;
      if ((input & 16) === 0 || this.hiddenFor.get(viewerId)?.has(ev.byId) !== true) return null;
      return stripKick(ev.byId, input);
    };
    this.sequencer.onEventApplied = (ev) => {
      // official `Ab`: the recorder serializes the event right after `apply`
      const rec = this.rec;
      if (rec !== null && rec.isRecording) rec.onEvent(ev, this.sequencer.frame);
      const cb = this.onEventApplied;
      if (cb !== null) cb(ev);
    };
    const t0 = this.now();
    // frame 0 starts on the last process-wide frame boundary (frame math
    // unchanged: the room is at frame 0 now and its first boundary comes in
    // < 1 frame); startTime never leaves the host (pongs carry frames)
    this.gridBase = this.realClock ? Math.floor(t0 * TICKS_PER_MS) : 0;
    this.startTime = this.realClock ? this.gridBase / TICKS_PER_MS : t0;
    this.installRoomHooks();
  }

  // ================================================================ lifecycle

  /** Wires the transport callbacks and starts it (signaling, room link, joins). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const t = this.transport;
    t.onPeerJoin = (peer, info) => this.handleJoin(peer, info);
    t.onPeerMessage = (peer, data) => this.handleMessage(peer, data);
    t.onPeerClose = (peer, reason) => this.handlePeerClose(peer, reason);
    t.onRoomLink = (link) => {
      const cb = this.onRoomLink;
      if (cb !== null) this.callUser(() => cb(link));
    };
    this.publishPlayerCount();
    hostClock.add(this.clockEntry);
    t.start();
    this.schedule();
  }

  /** Stops timers and the transport (clients are disconnected without notice). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    hostClock.remove(this.clockEntry);
    this.wakeFrame = this.wakePing = NaN;
    this.nextPingAt = Infinity;
    this.transport.stop();
    this.deferred.length = 0;
    this.rec?.cancel();
  }

  /** `.hbr2` recorder (one per room, reused; created on first use): see {@link startRecording}. */
  get recorder(): ReplayRecorder {
    return (this.rec ??= new ReplayRecorder());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Frames between heartbeats (msg 3). Live-tunable. */
  get heartbeatFrames(): number {
    return this.hbFrames;
  }
  set heartbeatFrames(v: number) {
    this.hbFrames = v;
    this.schedule();
  }

  /** Frames between CheckConsistency events. Live-tunable. */
  get checksumIntervalFrames(): number {
    return this.csFrames;
  }
  set checksumIntervalFrames(v: number) {
    this.csFrames = v;
    this.schedule();
  }

  /** Catch-up bound while a game runs (see {@link HostRoomOptions.maxWakeFrames}). Live-tunable. */
  get maxWakeFrames(): number {
    return this.wakeFrames;
  }
  set maxWakeFrames(v: number) {
    this.wakeFrames = HostRoom.checkWakeFrames(v);
    this.schedule();
  }

  private static checkWakeFrames(v: number): number {
    if (!(v >= 1)) throw new RangeError(`maxWakeFrames must be >= 1 (got ${v})`);
    return v === Infinity ? v : Math.floor(v);
  }

  /** Current frame (as of the last catch-up; call {@link update} to catch up now). */
  get frame(): number {
    return this.sequencer.frame;
  }

  /** Pre-broadcast hook for client events (see {@link BeforeOperationHook}). */
  get onBeforeOperation(): BeforeOperationHook | null {
    return this.sequencer.onBeforeOperation;
  }
  set onBeforeOperation(h: BeforeOperationHook | null) {
    this.sequencer.onBeforeOperation = h;
  }

  /** Input delay `Sb` (frames). Changing it affects new events and pongs only. */
  get inputDelayFrames(): number {
    return this.sequencer.inputDelayFrames;
  }
  set inputDelayFrames(v: number) {
    this.sequencer.inputDelayFrames = v;
  }

  /** Simulates every pending frame now (official `Wa.Da`). No-op inside hooks. */
  update(): void {
    this.run(this.catchUpFn);
  }

  /** Joined connection of a player (null for the host player / unknown ids). */
  getConnection(playerId: number): HostConnection | null {
    return this.connections.get(playerId) ?? null;
  }

  // ================================================================ recording

  /**
   * Starts a `.hbr2` recording from the current state (official
   * `startRecording`: a second call restarts it). Catches up first unless
   * called from inside a room hook.
   */
  startRecording(): void {
    if (!this.sequencer.busy) this.catchUp();
    this.recorder.start(this.state, this.sequencer.frame, this);
  }

  /** Stops the recording and returns the `.hbr2` bytes, or null if not recording. */
  stopRecording(): Uint8Array | null {
    if (this.rec === null || !this.rec.isRecording) return null;
    if (!this.sequencer.busy) this.catchUp();
    return this.recorder.stop(this.sequencer.frame);
  }

  // ================================================================ host actions

  /** Emits any event as the host (official `oc`). The event object is consumed. */
  emit(ev: RoomEvent): void {
    this.run(() => {
      this.catchUp();
      this.sequencer.hostEvent(ev);
    });
  }

  /**
   * Sends `ev` to one player only, outside the sequence (msg 6, official
   * `Ef`). Not applied on the host. Only meant for chat/announcements.
   */
  emitTo(ev: RoomEvent, playerId: number): void {
    this.run(() => {
      const c = this.connections.get(playerId);
      if (c !== undefined && !c.closed) this.transport.send(c.peer, Channel.ReliableOrdered, encodeTargetedEvent(ev));
    });
  }

  /** Chat as the host player; `targetId` sends it privately (msg 6). */
  sendChat(message: string, targetId: number | null = null): void {
    const ev = SendChatEvent.create(message);
    if (targetId !== null) this.emitTo(ev, targetId);
    else this.emit(ev);
  }

  /**
   * Announcement (official defaults: color -1, style 0 normal, sound 1).
   * `style`: 0 normal, 1 bold, 2 italic, 3 small, 4 small-bold, 5 small-italic.
   * `sound`: 0 none, 1 chat, 2 highlight.
   */
  sendAnnouncement(message: string, targetId: number | null = null, color = -1, style = 0, sound = 1): void {
    const ev = SendAnnouncementEvent.create(message, color, style, sound);
    if (targetId !== null) this.emitTo(ev, targetId);
    else this.emit(ev);
  }

  setPlayerAdmin(playerId: number, admin: boolean): void {
    this.emit(SetPlayerAdminEvent.create(playerId, admin));
  }

  /** `team`: 1 red, 2 blue, anything else spectators (official mapping). */
  setPlayerTeam(playerId: number, team: number): void {
    this.emit(SetPlayerTeamEvent.create(playerId, teamOf(team)));
  }

  /** Overrides the avatar shown for a player (SetHeadlessAvatar); null clears it. */
  setPlayerAvatar(playerId: number, avatar: string | null): void {
    this.emit(SetHeadlessAvatarEvent.create(playerId, avatar));
  }

  /** KickBanPlayer as the host (official: `reason` null -> ""). The target gets msg 5. */
  kickPlayer(playerId: number, reason: string | null = '', ban = false): void {
    this.emit(KickBanPlayerEvent.create(playerId, reason ?? '', ban));
  }

  /** Removes the ban created when `playerId` was banned (official `clearBan`). */
  clearBan(playerId: number): void {
    const rec = this.bansByPlayer.get(playerId);
    if (rec !== undefined) this.transport.bans.remove(rec);
    this.bansByPlayer.delete(playerId);
  }

  /** Clears every ban (official `clearBans`: the whole ban list). */
  clearBans(): void {
    this.transport.bans.clear();
    this.bansByPlayer.clear();
  }

  setScoreLimit(limit: number): void {
    this.emit(SetGamePlayLimitEvent.create(0, limit | 0));
  }

  /** Minutes. */
  setTimeLimit(limit: number): void {
    this.emit(SetGamePlayLimitEvent.create(1, limit | 0));
  }

  /** Any stadium object (only applied when no game is running, like official). */
  setStadium(stadium: Stadium): void {
    this.emit(SetStadiumEvent.create(stadium));
  }

  /** Parses `.hbs` text (throws the parse error, like official `setCustomStadium`). */
  setCustomStadium(hbs: string): void {
    this.setStadium(parseHbs(hbs));
  }

  /** Built-in stadium by name ("Classic", "Easy", …); throws "Stadium doesn't exist". */
  setDefaultStadium(name: string): void {
    const s = defaultStadiumByName(name);
    if (s === null) throw new Error("Stadium doesn't exist");
    this.setStadium(s);
  }

  setTeamsLock(locked: boolean): void {
    this.emit(SetTeamsLockEvent.create(locked));
  }

  /** Official `setTeamColors(team, angleDeg, textColor, colors[<=3])`. */
  setTeamColors(team: number, angle: number, textColor: number, colors: readonly number[]): void {
    const tc = new TeamColors();
    const n = colors.length < 3 ? colors.length : 3;
    for (let i = 0; i < n; i++) tc.colors.push(colors[i]! | 0);
    tc.textColor = textColor | 0;
    tc.angle = ((256 * angle) / 360) | 0;
    this.emit(SetTeamColorsEvent.create(teamOf(team), tc));
  }

  /** Official defaults: min 2, rate 0, burst 0. */
  setKickRateLimit(min = 2, rate = 0, burst = 0): void {
    this.emit(SetKickRateLimitEvent.create(min, rate, burst));
  }

  startGame(): void {
    this.emit(new StartGameEvent());
  }

  stopGame(): void {
    this.emit(new StopGameEvent());
  }

  /** PauseResumeGame (a `delay` event: applied `inputDelayFrames` later). */
  pauseGame(paused: boolean): void {
    this.emit(PauseResumeGameEvent.create(paused));
  }

  /** Disc by index in the world (needs a running game; ignored otherwise). Float fields are quantized to f32. */
  setDiscProperties(discIndex: number, props: DiscPropsInput): void {
    this.emit(SetDiscPropertiesEvent.create(discIndex, false, props));
  }

  setPlayerDiscProperties(playerId: number, props: DiscPropsInput): void {
    this.emit(SetDiscPropertiesEvent.create(playerId, true, props));
  }

  /** Moves the listed players to the top (or bottom) of the list (max 40, deduplicated). */
  reorderPlayers(playerIds: readonly number[], moveToTop: boolean): void {
    this.emit(ReorderPlayersEvent.create(playerIds, moveToTop));
  }

  setPassword(password: string | null): void {
    this.transport.setPassword(password);
  }

  setRequireRecaptcha(on: boolean): void {
    this.transport.setRequireRecaptcha(on);
  }

  /** Not runtime-changeable in the official API; haxlite extension (the API clamps 2..30 at init). */
  setMaxPlayers(n: number): void {
    this.transport.setMaxPlayers(n);
  }

  // ================================================================ private views (haxlite)

  /**
   * Changes disc `discIndex` ONLY in the world of `viewerId` (haxlite private
   * view; docs/04 §7.4). The change travels as a sequenced SetDiscProperties
   * in a slot where every other client gets a no-op, and from then on the
   * host simulates that viewer's world (a copy stepped in lockstep) so its
   * CheckConsistency carries the viewer's own hash: no desync flag, no
   * stall, nobody else sees anything.
   *
   * Validated when flushed (right after the current action / hook loop): a
   * running game, a non-player stadium disc other than disc 0 whose cGroup
   * is 0 in the room's and the viewer's world (and stays 0) and that no
   * joint uses. Such a disc can't touch, be kicked by or score against
   * anything, so the viewer's game plays exactly like everyone else's.
   * `force` skips that check: the private world then may diverge for real
   * (still protocol-consistent, but that viewer sees another game).
   * Errors are reported through {@link onError}; the update is skipped.
   */
  setDiscPropertiesFor(viewerId: number, discIndex: number, props: DiscPropsInput, force = false): void {
    this.queuePrivate(viewerId, SetDiscPropertiesEvent.create(discIndex, false, props), force, false);
  }

  /**
   * Sends `viewerId` the room's current values of every disc field it had
   * overridden. When its world then equals the room's (always, unless an
   * overridden value is not representable as float32 or the disc moved), the
   * private view ends; otherwise it stays (still consistent) until the next
   * game stop/start, stadium change or kick-off reset that makes them equal.
   */
  clearDiscOverrides(viewerId: number): void {
    const map = this.discOverrides.get(viewerId);
    if (map === undefined) return;
    const gs = this.state.gameState;
    for (const [index, mask] of map) {
      const d = gs?.world.discs[index];
      if (d == null) continue;
      const props: DiscPropsInput = {};
      const all = discProperties(d)!;
      for (const name of Object.keys(DiscProp) as DiscPropName[]) {
        if ((mask & (1 << DiscProp[name])) === 0) continue;
        props[name] = name === 'bCoef' ? all.bCoeff : all[name];
      }
      this.queuePrivate(viewerId, SetDiscPropertiesEvent.create(index, false, props), true, true);
    }
    map.clear();
  }

  /** True while `viewerId` has a private world (overrides sent and not yet converged). */
  hasPrivateView(viewerId: number): boolean {
    return this.sequencer.getView(viewerId) !== null;
  }

  /** A disc as `viewerId` sees it (its private world, else the room's). */
  getDiscPropertiesFor(viewerId: number, discIndex: number): DiscProperties | null {
    const v = this.sequencer.getView(viewerId);
    const gs = v !== null ? v.rs.gameState : this.state.gameState;
    if (gs === null) return null;
    return discProperties(gs.world.discs[discIndex] ?? null);
  }

  private queuePrivate(viewerId: number, ev: SetDiscPropertiesEvent, force: boolean, restore: boolean): void {
    this.pendingPrivate.push({ viewerId, ev, force, restore });
    if (this.privateFlushQueued || this.privateBatching > 0) return;
    this.privateFlushQueued = true;
    this.run(this.flushPrivateFn);
  }

  private privateBatching = 0;

  /**
   * Runs `fn` and sends every private update it queued
   * ({@link setDiscPropertiesFor}, {@link clearDiscOverrides}) together: the
   * k-th update of each viewer shares one slot, so the other clients get one
   * no-op per slot instead of one per update.
   */
  batchPrivate(fn: () => void): void {
    this.privateBatching++;
    try {
      fn();
    } finally {
      this.privateBatching--;
    }
    if (this.privateBatching === 0 && this.pendingPrivate.length > 0 && !this.privateFlushQueued) {
      this.privateFlushQueued = true;
      this.run(this.flushPrivateFn);
    }
  }

  /** Throws when `ev` could make the viewer's world play differently (see {@link setDiscPropertiesFor}). */
  private checkVisualOnly(viewerId: number, ev: SetDiscPropertiesEvent): void {
    const i = ev.targetId;
    const gs = this.state.gameState;
    if (gs === null) throw new Error(`setDiscPropertiesFor(${viewerId}, ${i}): no game running`);
    const d = gs.world.discs[i];
    if (d === undefined) throw new Error(`setDiscPropertiesFor(${viewerId}, ${i}): no such disc`);
    const where = `setDiscPropertiesFor(${viewerId}, ${i})`;
    if (i === 0) throw new Error(`${where}: disc 0 drives the kick-off and the camera; pass force to override it anyway`);
    const players = this.state.players;
    for (let k = 0; k < players.length; k++) {
      if (players[k]!.disc === d) throw new Error(`${where}: disc of player ${players[k]!.id}; pass force to override it anyway`);
    }
    const joints = gs.world.joints;
    for (let k = 0; k < joints.length; k++) {
      const j = joints[k]!;
      if (j.d0 === i || j.d1 === i) throw new Error(`${where}: disc is part of a joint; pass force to override it anyway`);
    }
    const own = this.sequencer.getView(viewerId)?.rs.gameState?.world.discs[i];
    const group = ev.has('cGroup') ? ev.values[DiscProp.cGroup]! : (own ?? d).cGroup;
    if (d.cGroup !== 0 || group !== 0) {
      throw new Error(`${where}: cGroup must be 0 in every world (it is ${d.cGroup} in the room, ${group} for the viewer); pass force to override it anyway`);
    }
  }

  /** Sends the queued private updates: the k-th update of every viewer shares slot k. */
  private flushPrivate(): void {
    this.privateFlushQueued = false;
    const pending = this.pendingPrivate.splice(0);
    if (pending.length === 0) return;
    this.catchUp();
    const seq = this.sequencer;
    const slots: Map<number, RoomEvent>[] = [];
    const slotOf = new Map<number, number>();
    for (const p of pending) {
      const c = this.connections.get(p.viewerId);
      if (c === undefined || !c.ready || c.closed) continue;
      if (this.state.gameState === null) continue; // nothing to override (restores included)
      if (!p.force) {
        try {
          this.checkVisualOnly(p.viewerId, p.ev);
        } catch (err) {
          this.reportError(err);
          continue;
        }
      }
      if (p.ev.mask === 0) continue;
      seq.ensureView(p.viewerId);
      if (!p.restore) {
        let map = this.discOverrides.get(p.viewerId);
        if (map === undefined) this.discOverrides.set(p.viewerId, (map = new Map()));
        map.set(p.ev.targetId, (map.get(p.ev.targetId) ?? 0) | p.ev.mask);
      }
      const k = slotOf.get(p.viewerId) ?? 0;
      slotOf.set(p.viewerId, k + 1);
      (slots[k] ??= new Map()).set(p.viewerId, p.ev);
    }
    for (const slot of slots) seq.privateSlot(slot);
    if (slots.length > 0 && pending.some((p) => p.restore)) seq.dropConvergedViews();
  }

  // ---------------------------------------------------------------- hidden players (haxlite)

  /**
   * Hides player `playerId` from `viewerId` only (haxlite; docs/04 §7.4,
   * "Jugadores ocultos"). In the viewer's world the player's disc gets
   * position NaN and cGroup 0. The official client then draws no disc, no
   * name, no avatar and no off-screen arrow for it: every canvas call with a
   * NaN coordinate is ignored and `900 < NaN` is false. The disc touches
   * nothing in that world. Everyone else, the player included, plays the
   * normal game. The host simulates the viewer's world (private view) and
   * re-hides the disc whenever it is respawned (kick-off reset, team change,
   * new disc). Whatever the hidden player changes in the room (pushing a
   * disc, kicking the ball) is copied into the viewer's world with a shared
   * SetDiscProperties: the room's values rounded to float32, for everyone.
   * `hidden = false` shows it again the same way; the private view ends once
   * both worlds are identical. Hidden pairs end with the game (stop or new
   * game) and when either player leaves. Errors go to {@link onError}.
   */
  setPlayerHiddenFor(viewerId: number, playerId: number, hidden: boolean): void {
    this.run(() => {
      const where = `${hidden ? 'hidePlayerFor' : 'showPlayerFor'}(${viewerId}, ${playerId})`;
      if (!hidden) {
        const set = this.hiddenFor.get(viewerId);
        if (set === undefined || !set.delete(playerId)) return;
        if (set.size === 0) this.hiddenFor.delete(viewerId);
        this.catchUp();
        this.syncHidden();
        return;
      }
      this.catchUp();
      const gs = this.state.gameState;
      if (gs === null) throw new Error(`${where}: no game running`);
      const c = this.connections.get(viewerId);
      if (c === undefined || !c.ready || c.closed) throw new Error(`${where}: viewer is not a connected player`);
      if (getPlayer(this.state, playerId) === null) throw new Error(`${where}: no such player`);
      if (viewerId === playerId) throw new Error(`${where}: a player can't be hidden from itself`);
      if (this.hiddenGame !== gs) {
        this.hiddenFor.clear();
        this.hiddenGame = gs;
      }
      let set = this.hiddenFor.get(viewerId);
      if (set === undefined) this.hiddenFor.set(viewerId, (set = new Set()));
      if (set.has(playerId)) return;
      set.add(playerId);
      this.reconciling.add(viewerId);
      this.syncHidden();
    });
  }

  /** True while `playerId` is hidden from `viewerId` ({@link setPlayerHiddenFor}). */
  isPlayerHiddenFor(viewerId: number, playerId: number): boolean {
    return this.hiddenFor.get(viewerId)?.has(playerId) === true;
  }

  /** Ids of the players hidden from `viewerId`. */
  getHiddenPlayersFor(viewerId: number): number[] {
    return [...(this.hiddenFor.get(viewerId) ?? [])];
  }

  private readonly syncHiddenFn = (): void => this.syncHidden();

  /**
   * Makes the hidden pairs true in the viewers' worlds at the current point
   * of the sequence (no frame is stepped in between):
   *  1. re-hides a disc that is visible again (new disc, kick-off reset, a
   *     global SetDiscProperties);
   *  2. copies into each reconciling viewer's world every disc that differs
   *     from the room's, except the ones that viewer hides or overrides.
   */
  private syncHidden(): void {
    const gs = this.state.gameState;
    if (gs === null || gs !== this.hiddenGame) {
      // the game ended (or a new one started): the pairs end with it
      this.hiddenFor.clear();
      this.hiddenGame = null;
      if (gs === null) this.reconciling.clear();
    }
    const seq = this.sequencer;
    // 1. hide: position NaN + cGroup 0 in the viewer's world; k-th update of each viewer in slot k
    const slots: Map<number, RoomEvent>[] = [];
    for (const [viewerId, set] of this.hiddenFor) {
      const c = this.connections.get(viewerId);
      if (c === undefined || !c.ready || c.closed) {
        this.hiddenFor.delete(viewerId);
        continue;
      }
      let k = 0;
      for (const pid of set) {
        if (getPlayer(this.state, pid) === null) {
          set.delete(pid);
          continue;
        }
        const own = seq.getView(viewerId)?.rs ?? this.state;
        const pl = getPlayer(own, pid);
        const d = pl?.disc;
        if (d == null) continue;
        if (d.x !== d.x && d.y !== d.y && d.cGroup === 0 && (pl!.input & 16) === 0) continue;
        seq.ensureView(viewerId);
        this.reconciling.add(viewerId);
        (slots[k++] ??= new Map()).set(viewerId, SetDiscPropertiesEvent.create(pid, true, { x: NaN, y: NaN, cGroup: 0 }));
        // no kick in the viewer's world (isKicking is cleared when the input has no kick bit)
        if ((pl!.input & 16) !== 0) (slots[k++] ??= new Map()).set(viewerId, stripKick(pid, pl!.input));
        // inputs with kick already sent unchanged, applied later: strip right after each one
        const late = seq.queue.filter(
          (q) => q.type === EventType.SendInput && q.byId === pid && ((q as SendInputEvent).input & 16) !== 0 && !seq.hasVariant(q, viewerId),
        );
        for (const q of late) seq.privateSlotAt(q.frame, new Map([[viewerId, stripKick(pid, (q as SendInputEvent).input)]]));
      }
      if (set.size === 0) this.hiddenFor.delete(viewerId);
    }
    for (const slot of slots) seq.privateSlot(slot);
    if (gs === null || this.reconciling.size === 0) return;

    // 2. reconcile: a disc that differs from the room's gets the room's values (f32) in every
    //    world that does not hide / override it; those get a no-op in the same slot
    let fix: number[] | null = null;
    for (const viewerId of this.reconciling) {
      const v = seq.getView(viewerId);
      if (v === null) {
        if (!this.hiddenFor.has(viewerId)) this.reconciling.delete(viewerId);
        continue;
      }
      const a = gs.world.discs;
      const b = v.rs.gameState?.world.discs;
      if (b === undefined || b.length !== a.length) continue;
      for (let i = 0; i < a.length; i++) {
        if (fix?.includes(i) || this.excludedFor(viewerId, i)) continue;
        if (discDiffMask(a[i]!, b[i]!) !== 0) (fix ??= []).push(i);
      }
    }
    if (fix === null) return;
    for (const i of fix) {
      const room = gs.world.discs[i]!;
      let mask = 0;
      const keep = new Map<number, RoomEvent>();
      for (const v of seq.views) {
        if (this.excludedFor(v.playerId, i)) {
          keep.set(v.playerId, SetDiscPropertiesEvent.create(0, false, {}));
          continue;
        }
        const d = v.rs.gameState?.world.discs[i];
        if (d !== undefined) mask |= discDiffMask(room, d);
      }
      const props: DiscPropsInput = {};
      for (const name of DISC_FIELDS) if ((mask & (1 << DiscProp[name])) !== 0) props[name] = room[name];
      seq.privateSlot(keep, SetDiscPropertiesEvent.create(i, false, props));
    }
  }

  /** Disc `index` of the viewer's world is hidden or overridden for it (left out of reconciling). */
  private excludedFor(viewerId: number, index: number): boolean {
    if (this.discOverrides.get(viewerId)?.has(index) === true) return true;
    const set = this.hiddenFor.get(viewerId);
    if (set === undefined) return false;
    const v = this.sequencer.getView(viewerId);
    if (v === null) return false;
    const d = v.rs.gameState?.world.discs[index];
    if (d === undefined) return false;
    for (const pid of set) if (getPlayer(v.rs, pid)?.disc === d) return true;
    return false;
  }

  // ================================================================ queries

  /** Players in list order (live model objects; do not mutate). */
  getPlayerList(): readonly Player[] {
    return this.state.players;
  }

  getPlayer(playerId: number): Player | null {
    return getPlayer(this.state, playerId);
  }

  /** Official `getScores` (null without a game; `timeLimit` in seconds). */
  getScores(): Scores | null {
    const gs = this.state.gameState;
    if (gs === null) return null;
    return { red: gs.redScore, blue: gs.blueScore, time: gs.timeElapsed, scoreLimit: gs.scoreLimit, timeLimit: 60 * gs.timeLimit };
  }

  getBallPosition(): { x: number; y: number } | null {
    const gs = this.state.gameState;
    if (gs === null) return null;
    const d = gs.world.discs[0];
    return d === undefined ? null : { x: d.x, y: d.y };
  }

  getDiscProperties(discIndex: number): DiscProperties | null {
    const gs = this.state.gameState;
    if (gs === null) return null;
    return discProperties(gs.world.discs[discIndex] ?? null);
  }

  getPlayerDiscProperties(playerId: number): DiscProperties | null {
    if (this.state.gameState === null) return null;
    const p = getPlayer(this.state, playerId);
    return p === null ? null : discProperties(p.disc);
  }

  getDiscCount(): number {
    const gs = this.state.gameState;
    return gs === null ? 0 : gs.world.discs.length;
  }

  // ================================================================ internals

  /** Runs `fn` now, or after the current apply/step loop when called from a room hook. */
  private run(fn: () => void): void {
    if (this.sequencer.busy) {
      this.deferred.push(fn);
      return;
    }
    const b = this.bundle;
    if (b !== null) b.cork();
    try {
      this.invoke(fn);
      this.settle();
    } finally {
      if (b !== null) b.uncork();
    }
  }

  /** After a top-level operation: run the actions deferred by hooks, then re-arm the clock. */
  private settle(): void {
    if (this.deferred.length > 0 && !this.flushing) {
      this.flushing = true;
      try {
        while (this.deferred.length > 0) this.invoke(this.deferred.shift()!);
      } finally {
        this.flushing = false;
      }
    }
    if ((this.hiddenFor.size > 0 || this.reconciling.size > 0) && !this.sequencer.busy) this.invoke(this.syncHiddenFn);
    this.schedule();
  }

  private invoke(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    const h = this.onError;
    if (h !== null) {
      try {
        h(err);
      } catch {
        /* ignore */
      }
    }
  }

  /** Calls a user callback, reporting (not propagating) its exceptions. */
  private callUser(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.reportError(err);
    }
  }

  private targetFrame(): number {
    return ((this.now() - this.startTime) * TICKS_PER_MS) | 0;
  }

  /** official `Wa.Da`: simulate pending frames, heartbeat / checksum cadence. */
  private catchUp(): void {
    const seq = this.sequencer;
    const n = this.targetFrame() - seq.frame;
    if (this.hiddenFor.size > 0 || this.reconciling.size > 0) {
      // hidden players: re-hide / reconcile after every frame (a kick-off reset respawns discs)
      for (let i = 0; i < n; i++) {
        seq.advance(1);
        this.syncHidden();
      }
    } else if (n > 0) seq.advance(n);
    this.periodic();
  }

  /**
   * Heartbeat / CheckConsistency cadence (official `Wa.Da` after `rg`, on
   * the absolute heartbeat grid): a heartbeat once the frame reaches the
   * next grid point not already covered ({@link nextHeartbeatFrame}), and
   * heartbeat + CheckConsistency every `checksumIntervalFrames`.
   */
  private periodic(): void {
    const seq = this.sequencer;
    if (seq.frame >= this.nextHeartbeatFrame()) seq.heartbeat();
    if (seq.frame - seq.lastChecksumFrame >= this.csFrames) {
      seq.heartbeat();
      seq.checksum();
    }
  }

  // ---- absolute heartbeat grid
  //
  // Periodic heartbeats leave on frames whose index on the process-wide
  // frame grid (gridBase + frame) is a multiple of heartbeatFrames, and the
  // in-game catch-ups, CheckConsistency and Ping wake-ups are placed on that
  // same grid, so every room of the process wakes on the same few frame
  // boundaries (~2 per heartbeat period) whatever their number.

  /** Position of room frame `f` inside its heartbeat period (0 = grid point). */
  private gridMod(f: number): number {
    return (this.gridBase + f) % this.hbFrames;
  }

  /** First heartbeat grid point after frame `f`. */
  private gridAfter(f: number): number {
    return f + this.hbFrames - this.gridMod(f);
  }

  /** First heartbeat grid point at or after frame `f`. */
  private gridCeil(f: number): number {
    const m = this.gridMod(f);
    return m === 0 ? f : f + this.hbFrames - m;
  }

  /**
   * Frame of the next periodic heartbeat: the first grid point more than
   * {@link heartbeatLead} frames after the last heartbeat (a heartbeat that
   * left up to that many frames early with a client event covers its grid
   * point). Gaps: heartbeatFrames, up to + lead with bundling.
   */
  private nextHeartbeatFrame(): number {
    return this.gridAfter(this.sequencer.lastHeartbeatFrame + this.heartbeatLead());
  }

  /**
   * Frames ahead of its grid point that a heartbeat may leave with a client
   * event: floor((heartbeatFrames - 1) / 3), 2 by default, with a bundling
   * backend (it rides in the event's packet); 0 otherwise.
   */
  private heartbeatLead(): number {
    return this.bundle !== null ? ((this.hbFrames - 1) / 3) | 0 : 0;
  }

  /** Pre-bound so wake-ups allocate nothing. */
  private readonly catchUpFn = (): void => this.catchUp();
  private readonly pingFn = (): void => this.broadcastPings();

  /** Shared clock callback: Ping event if due, else catch up. */
  private onWake(): void {
    this.wakeFrame = NaN; // always hand the clock a fresh wake-up time
    if (!this.running) return;
    const now = this.now();
    if (now >= this.nextPingAt) {
      // setInterval-like cadence; never fire twice in a row after a stall
      let next = this.pingDue + this.pingIntervalMs;
      if (next <= now) next = now + this.pingIntervalMs;
      this.pingDue = next;
      this.nextPingAt = this.onGrid(next);
      this.run(this.pingFn);
    } else {
      this.run(this.catchUpFn);
    }
  }

  /**
   * Next frame with work, or Infinity: with ready clients the next heartbeat
   * and CheckConsistency (and, without a game or with a fully paused one,
   * the next queued event); with a running game, at least every
   * `maxWakeFrames` (spread evenly inside each heartbeat period so
   * heartbeats keep their exact frames).
   */
  private nextWakeFrame(): number {
    const seq = this.sequencer;
    const frame = seq.frame;
    const hb = this.hbFrames;
    const clients = this.ready.length > 0;
    let next = Infinity;
    if (clients) {
      next = this.nextHeartbeatFrame();
      const cs = this.gridCeil(seq.lastChecksumFrame + this.csFrames);
      if (cs < next) next = cs;
    }
    const gs = this.state.gameState;
    // a fully paused game runs no per-frame hooks: no catch-up bound (frames
    // are still stepped one by one on the next catch-up); the unpause
    // countdown (counter < PAUSED_TICKS) keeps it
    if (gs !== null && gs.pauseGameTickCounter !== PAUSED_TICKS) {
      const mw = this.wakeFrames;
      if (mw < hb) {
        // k catch-up points per heartbeat period (grid point + ceil(i * hb / k),
        // shared by every room): the LAST one within maxWakeFrames of the
        // frame just caught up, so a room caught up by a message skips points
        const base = frame - this.gridMod(frame);
        const k = Math.ceil(hb / mw);
        const limit = frame + mw;
        let f = limit; // unreachable fallback: points are <= ceil(hb / k) <= mw apart
        for (let i = 1; ; i++) {
          const p = base + Math.floor(i / k) * hb + Math.ceil(((i % k) * hb) / k);
          if (p > limit) break;
          if (p > frame) f = p;
        }
        if (f < next) next = f;
      } else if (!clients) {
        const f = this.gridAfter(frame);
        if (f < next) next = f;
      }
    } else if ((clients || gs !== null) && seq.queue.length > 0) {
      // without a game: the next queued event; paused: also without clients
      // (a queued unpause must start the countdown without waiting for a message)
      const q = seq.queue[0]!.frame;
      if (q < next) next = q;
    }
    return next <= frame ? frame + 1 : next;
  }

  /** Tells the shared clock when this room next has work (nothing when idle). */
  private schedule(): void {
    if (!this.running) return;
    const frame = this.nextWakeFrame();
    const ping = this.nextPingAt;
    if (frame === this.wakeFrame && ping === this.wakePing) return;
    this.wakeFrame = frame;
    this.wakePing = ping;
    if (frame === Infinity && ping === Infinity) {
      hostClock.set(this.clockEntry, Infinity);
      return;
    }
    if (this.realClock) {
      // room time is the clock's time base (no clock read); the same frame
      // boundary is the same double in every room, so they wake together
      const at = (this.gridBase + frame) / TICKS_PER_MS;
      hostClock.set(this.clockEntry, ping < at ? ping : at);
      return;
    }
    const now = this.now();
    let delay = this.startTime + frame / TICKS_PER_MS - now;
    const pingDelay = ping - now;
    if (pingDelay < delay) delay = pingDelay;
    // exact boundary: the clock rounds up and adds its own slack
    hostClock.set(this.clockEntry, performance.now() + (delay > 0 ? delay : 0));
  }

  /**
   * Room time `t` rounded up to a heartbeat grid point (real clock), so the
   * Ping event shares the wake-up of the heartbeats due then. The
   * 1e-6-frame tolerance keeps a boundary computed with rounding error
   * (`k / 0.06 + 3000`) from moving to the next one.
   */
  private onGrid(t: number): number {
    if (!this.realClock || t === Infinity) return t;
    const f = this.gridCeil(Math.ceil(t * TICKS_PER_MS - 1e-6) - this.gridBase);
    return (this.gridBase + f) / TICKS_PER_MS;
  }

  /** Starts / stops the 3 s Ping event with the first / last ready client. */
  private updatePingTimer(): void {
    if (this.running && this.ready.length > 0) {
      if (this.nextPingAt === Infinity) {
        this.pingDue = this.now() + this.pingIntervalMs;
        this.nextPingAt = this.onGrid(this.pingDue);
      }
    } else {
      this.nextPingAt = Infinity;
    }
  }

  /** Ping event with each player's declared ping, in list order (official `da.V`). */
  private broadcastPings(): void {
    this.catchUp();
    const players = this.state.players;
    const pings: number[] = [];
    for (let i = 0; i < players.length; i++) {
      const c = this.connections.get(players[i]!.id);
      pings.push(c === undefined ? 0 : c.ping);
    }
    this.sequencer.hostEvent(PingEvent.create(pings));
  }

  /** RoomInfo player count (official `b()`: players minus the host player). */
  private publishPlayerCount(): void {
    const players = this.state.players;
    let n = 0;
    for (let i = 0; i < players.length; i++) if (players[i]!.id !== 0) n++;
    if (this.transport.getRoomInfo().players !== n) this.transport.setRoomInfo({ players: n });
  }

  /** Hooks the host needs; the facade must use HostRoom.onPlayerJoin/Leave/Kicked instead. */
  private installRoomHooks(): void {
    const hooks = this.state.hooks;
    hooks.onPlayerJoin = (p) => {
      const c = this.connections.get(p.id);
      if (c !== undefined) {
        p.auth = c.auth;
        p.conn = c.conn;
      }
      const cb = this.onPlayerJoin;
      if (cb !== null) this.callUser(() => cb(p));
    };
    // official `y.Fh`
    hooks.onPlayerLeave = (p, reason, ban, by) => {
      this.publishPlayerCount();
      const leave = this.onPlayerLeave;
      if (leave !== null) this.callUser(() => leave(p));
      if (reason === null) return;
      const c = this.connections.get(p.id);
      if (c !== undefined) this.kickConnection(c, reason, ban, by !== null ? by.name : null);
      const kicked = this.onPlayerKicked;
      if (kicked !== null) this.callUser(() => kicked(p, reason, ban, by));
    };
  }

  /** official `Wa.Mg`: ban (conn + srflx IPs), msg 5 to the target, close. */
  private kickConnection(c: HostConnection, reason: string, ban: boolean, byName: string | null): void {
    this.dropConnection(c);
    const rec = this.transport.kick(c.peer, { reason, ban, byName });
    if (rec !== null) this.bansByPlayer.set(c.playerId, rec.id);
  }

  private dropConnection(c: HostConnection): void {
    if (c.closed) return;
    c.closed = true;
    c.ready = false;
    if (this.connections.get(c.playerId) === c) this.connections.delete(c.playerId);
    this.sequencer.dropView(c.playerId);
    this.discOverrides.delete(c.playerId);
    this.hiddenFor.delete(c.playerId);
    this.reconciling.delete(c.playerId);
    const i = this.ready.indexOf(c);
    if (i >= 0) this.ready.splice(i, 1);
    this.updatePingTimer();
  }

  // ---------------------------------------------------------------- transport events

  /** official `Wa.Lh` (after verification) + `D.yh`. */
  private handleJoin(peer: Peer, info: JoinInfo): void {
    this.run(() => {
      if (peer.state !== 'joined' || !this.running) return;
      this.catchUp();
      const id = this.nextPlayerId++;
      const c = new HostConnection(id, peer, info.auth, info.conn);
      peer.playerId = id;
      peer.userData = c;
      this.connections.set(id, c);
      this.sequencer.hostEvent(JoinRoomEvent.create(id, info.name, info.flag, info.avatar));
      this.publishPlayerCount();
      if (c.closed) return; // kicked from inside onPlayerJoin
      c.ready = true;
      this.ready.push(c);
      this.transport.send(peer, Channel.ReliableOrdered, this.sequencer.snapshot(id));
      this.updatePingTimer();
    });
  }

  private connectionOf(peer: Peer): HostConnection | null {
    const c = peer.userData;
    return c instanceof HostConnection ? c : null;
  }

  /** official `Wa.Jh` (allocation-free: no closure, reused reader). */
  private handleMessage(peer: Peer, data: Uint8Array): void {
    const c = this.connectionOf(peer);
    if (c === null || c.closed) return;
    if (this.sequencer.busy) {
      // `data` may be a transient view (haxlite-rtc backend): copy what outlives the call
      const copy = data.slice();
      this.deferred.push(() => this.processMessage(c, copy));
      return;
    }
    const b = this.bundle;
    if (b !== null) b.cork();
    try {
      this.processMessage(c, data);
      this.settle();
    } finally {
      if (b !== null) b.uncork();
    }
  }

  private processMessage(c: HostConnection, data: Uint8Array): void {
    try {
      if (c.closed) return;
      this.catchUp();
      const nested = this.readerBusy;
      const r = nested ? new Reader(data) : this.reader.reset(data);
      this.readerBusy = true;
      try {
        const type = r.u8();
        let broadcast = false;
        if (type === ClientMsg.Event) broadcast = this.sequencer.clientMessage(c, r, this.now()) !== null;
        else if (type === ClientMsg.Ping) this.handlePing(c, r);
        else throw new ProtocolViolation(`unexpected message type ${type}`);
        if (r.remaining > 0) throw new ProtocolViolation('trailing bytes');
        // bundling backend: an imminent heartbeat rides along with the event just broadcast
        if (broadcast && this.bundle !== null) {
          const seq = this.sequencer;
          if (this.nextHeartbeatFrame() - seq.frame <= this.heartbeatLead()) seq.heartbeat();
        }
      } catch (err) {
        this.badActor(c, err);
      } finally {
        this.readerBusy = nested;
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  /** official `Wa.Kh`: store the declared ping, answer with the host frame (+ Sb) and the echo. */
  private handlePing(c: HostConnection, r: Reader): void {
    const echo = r.f64();
    c.ping = r.varUint();
    if (r.remaining > 0) throw new ProtocolViolation('trailing bytes');
    const hostFrame = (this.now() - this.startTime) * TICKS_PER_MS + this.sequencer.inputDelayFrames;
    this.transport.send(c.peer, Channel.Unreliable, encodePong(this.pongWriter, hostFrame, echo));
  }

  /** official `Wa.Xe` + `D.lf`: drop and broadcast KickBanPlayer(id, "Bad actor"). */
  private badActor(c: HostConnection, err: unknown): void {
    const cb = this.onBadActor;
    if (cb !== null) this.callUser(() => cb(c.playerId, err));
    const wasReady = c.ready;
    this.dropConnection(c);
    if (wasReady && getPlayer(this.state, c.playerId) !== null) {
      this.sequencer.hostEvent(KickBanPlayerEvent.create(c.playerId, 'Bad actor', false));
    }
    this.transport.close(c.peer, 'protocol');
  }

  /** official `Ya.cb` -> `nf` (leave, `zh`) or `Xe` for flood/protocol errors. */
  private handlePeerClose(peer: Peer, reason: PeerCloseReason): void {
    const c = this.connectionOf(peer);
    if (c === null || c.closed) return;
    const wasReady = c.ready;
    this.dropConnection(c);
    if (!this.running) return;
    const bad = reason === 'flood' || reason === 'protocol';
    this.run(() => {
      this.catchUp();
      if (getPlayer(this.state, c.playerId) === null) return;
      if (bad && !wasReady) return;
      this.sequencer.hostEvent(KickBanPlayerEvent.create(c.playerId, bad ? 'Bad actor' : null, false));
    });
  }
}
