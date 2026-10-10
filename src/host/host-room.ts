/**
 * HostRoom: the authoritative host engine (official headless `Wa` + the
 * glue of `HBInit`), on top of {@link HostTransport} and {@link Sequencer}.
 *
 *   clock      frame = ((now - start) * 0.06) | 0, every pending frame is
 *              simulated on each wake-up (official `Wa.Da`). Wake-ups are
 *              timers aligned to the next frame that has work: every frame
 *              while a game runs, else the next heartbeat / checksum / queued
 *              event. No players and no game = no timers at all.
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
import { Channel, ClientMsg, TICKS_PER_MS, TeamId } from '../protocol.js';
import {
  JoinRoomEvent,
  KickBanPlayerEvent,
  PauseResumeGameEvent,
  PingEvent,
  ReorderPlayersEvent,
  SendAnnouncementEvent,
  SendChatEvent,
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
  createRoomState,
  getPlayer,
  Player,
  type DiscPropName,
  type RoomEvent,
  type RoomState,
} from '../room/index.js';
import { defaultStadiums, parseHbs, type Disc, type Stadium } from '../sim/index.js';
import { ReplayRecorder } from '../replay/index.js';
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

function teamOf(v: number): TeamId {
  return v === 1 ? TeamId.Red : v === 2 ? TeamId.Blue : TeamId.Spectators;
}

export class HostRoom {
  readonly state: RoomState;
  readonly transport: HostTransport;
  readonly sequencer: Sequencer;
  heartbeatFrames: number;
  checksumIntervalFrames: number;
  readonly pingIntervalMs: number;
  /** `.hbr2` recorder (one per room, reused): see {@link startRecording}. */
  readonly recorder = new ReplayRecorder();

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

  private readonly now: () => number;
  private readonly startTime: number;
  /** Connections by player id (official `yb`). */
  private readonly connections = new Map<number, HostConnection>();
  /** Connections that got their snapshot, in join order (broadcast targets). */
  private readonly ready: HostConnection[] = [];
  /** Ban record id by kicked player id (official `Cc`), for clearBan(playerId). */
  private readonly bansByPlayer = new Map<number, number>();
  /** off `wh`. */
  private nextPlayerId = 1;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private timerFrame = -1;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly deferred: (() => void)[] = [];
  private flushing = false;
  private readonly pongWriter = new Writer(32);

  constructor(opts: HostRoomOptions) {
    this.transport = opts.transport;
    this.state = opts.state ?? createHostRoomState();
    this.now = opts.now ?? (() => performance.now());
    this.heartbeatFrames = opts.heartbeatFrames ?? HostDefaults.heartbeatFrames;
    this.checksumIntervalFrames = opts.checksumIntervalFrames ?? HostDefaults.checksumIntervalFrames;
    this.pingIntervalMs = opts.pingIntervalMs ?? HostDefaults.pingIntervalMs;
    const sink: SequencerSink = {
      broadcast: (data, channel) => {
        const list = this.ready;
        for (let i = 0; i < list.length; i++) this.transport.send(list[i]!.peer, channel, data);
      },
      hasConnections: () => this.transport.connectionCount > 0,
    };
    this.sequencer = new Sequencer(this.state, sink, {
      inputDelayFrames: opts.inputDelayFrames ?? HostDefaults.inputDelayFrames,
    });
    this.sequencer.onError = (err) => this.reportError(err);
    this.sequencer.onEventApplied = (ev) => {
      // official `Ab`: the recorder serializes the event right after `apply`
      if (this.recorder.isRecording) this.recorder.onEvent(ev, this.sequencer.frame);
      const cb = this.onEventApplied;
      if (cb !== null) cb(ev);
    };
    this.startTime = this.now();
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
    t.start();
    this.schedule();
  }

  /** Stops timers and the transport (clients are disconnected without notice). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.transport.stop();
    this.deferred.length = 0;
    this.recorder.cancel();
  }

  get isRunning(): boolean {
    return this.running;
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
    if (!this.recorder.isRecording) return null;
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
    const s = defaultStadiums().find((st) => st.name === name);
    if (s === undefined) throw new Error("Stadium doesn't exist");
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
    this.invoke(fn);
    if (this.deferred.length > 0 && !this.flushing) {
      this.flushing = true;
      try {
        while (this.deferred.length > 0) this.invoke(this.deferred.shift()!);
      } finally {
        this.flushing = false;
      }
    }
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
    if (n > 0) seq.advance(n);
    seq.periodic(this.heartbeatFrames, this.checksumIntervalFrames);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerFrame = -1;
  }

  /** Pre-bound so the per-frame timer allocates nothing. */
  private readonly catchUpFn = (): void => this.catchUp();

  private readonly onTimer = (): void => {
    this.timer = null;
    this.timerFrame = -1;
    this.run(this.catchUpFn);
  };

  /** Arms one timer for the next frame with work (none when idle). */
  private schedule(): void {
    if (!this.running) return;
    const seq = this.sequencer;
    const hasGame = this.state.gameState !== null;
    if (!hasGame && this.ready.length === 0) {
      this.clearTimer();
      return;
    }
    let next: number;
    if (hasGame) {
      next = seq.frame + 1;
    } else {
      next = seq.lastHeartbeatFrame + this.heartbeatFrames;
      const cs = seq.lastChecksumFrame + this.checksumIntervalFrames;
      if (cs < next) next = cs;
      if (seq.queue.length > 0 && seq.queue[0]!.frame < next) next = seq.queue[0]!.frame;
      if (next <= seq.frame) next = seq.frame + 1;
    }
    if (this.timer !== null && this.timerFrame === next) return;
    this.clearTimer();
    this.timerFrame = next;
    const delay = Math.ceil(this.startTime + next / TICKS_PER_MS - this.now());
    this.timer = setTimeout(this.onTimer, delay > 0 ? delay : 0);
  }

  private updatePingTimer(): void {
    const want = this.running && this.ready.length > 0;
    if (want && this.pingTimer === null) {
      this.pingTimer = setInterval(() => this.run(() => this.broadcastPings()), this.pingIntervalMs);
    } else if (!want && this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
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

  /** official `Wa.Jh`. */
  private handleMessage(peer: Peer, data: Uint8Array): void {
    const c = this.connectionOf(peer);
    if (c === null || c.closed) return;
    this.run(() => {
      if (c.closed) return;
      this.catchUp();
      try {
        const r = new Reader(data);
        const type = r.u8();
        if (type === ClientMsg.Event) this.sequencer.clientMessage(c, r, this.now());
        else if (type === ClientMsg.Ping) this.handlePing(c, r);
        else throw new ProtocolViolation(`unexpected message type ${type}`);
        if (r.remaining > 0) throw new ProtocolViolation('trailing bytes');
      } catch (err) {
        this.badActor(c, err);
      }
    });
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
