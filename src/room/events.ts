/**
 * Room events (official "actions", ids 0..23 = registration order of the
 * headless `vb.Ci()`; docs/02 §3). Each class owns its payload codec
 * (`write`/`read`, byte-identical to the official `S`/`W`) and its
 * deterministic `apply` (official `apply`, including the permission checks,
 * which every peer evaluates identically).
 *
 * node-haxball extensions 24..26 are intentionally absent.
 */
import { CodecError, Reader, Writer, deflateRaw, inflateRaw } from '../codec/index.js';
import type { Disc, Stadium } from '../sim/types.js';
import { readStadium, writeStadium } from '../sim/index.js';
import { EventType, TeamId } from '../protocol.js';
import {
  destroyGame,
  getPlayer,
  isHostOrAdmin,
  PAUSED_TICKS,
  removeItem,
  setKickRateLimit,
  setPlayerTeam,
  startGame,
} from './rules.js';
import { readTeamColors, roomStateChecksum, roomStateChecksumBytes, toTeamId, writeTeamColors } from './state.js';
import { Player, RoomState, TeamColors } from './types.js';

// ----------------------------------------------------------------- metadata

/** Who may send an event type from a client connection (official per-class `tb`). */
export type EventSender =
  /** No filter. */
  | 'any'
  /** `tb` throws: a client sending it is a protocol violation -> disconnect. */
  | 'hostOnly'
  /** `tb` returns false for non-admins: silently dropped (payload skipped). */
  | 'adminOnly';

/** Static per-type configuration (official `Class.U = m.Z({...})`). */
export interface EventMeta {
  readonly type: EventType;
  readonly name: string;
  /**
   * off `delay` (nh `IM`): clients schedule it at `frame + inputDelay`; the
   * host clamps/smooths its frame (docs/04 §4). Only SendInput, PauseResumeGame.
   */
  readonly delay: boolean;
  /** off `ca` (nh `PM`): applied in client-side extrapolation. Only SendInput, PauseResumeGame. */
  readonly predictable: boolean;
  /** off `ue {je, ye}`: per-connection token bucket (burst, ms per token); exceeding it disconnects. */
  readonly rateLimit: { readonly burst: number; readonly intervalMs: number } | null;
  readonly sender: EventSender;
}

function meta(
  type: EventType,
  name: string,
  delay: boolean,
  sender: EventSender = 'any',
  rateLimit: EventMeta['rateLimit'] = null,
): EventMeta {
  return { type, name, delay, predictable: delay, rateLimit, sender };
}

/** Indexed by EventType. */
export const EVENT_META: readonly EventMeta[] = [
  meta(EventType.SendAnnouncement, 'SendAnnouncement', false, 'hostOnly'),
  meta(EventType.SendChatIndicator, 'SendChatIndicator', false),
  meta(EventType.CheckConsistency, 'CheckConsistency', false, 'hostOnly'),
  meta(EventType.SendInput, 'SendInput', true),
  meta(EventType.SendChat, 'SendChat', false, 'any', { burst: 10, intervalMs: 900 }),
  meta(EventType.JoinRoom, 'JoinRoom', false, 'hostOnly'),
  meta(EventType.KickBanPlayer, 'KickBanPlayer', false),
  meta(EventType.StartGame, 'StartGame', false),
  meta(EventType.StopGame, 'StopGame', false),
  meta(EventType.PauseResumeGame, 'PauseResumeGame', true),
  meta(EventType.SetGamePlayLimit, 'SetGamePlayLimit', false),
  meta(EventType.SetStadium, 'SetStadium', false, 'adminOnly', { burst: 10, intervalMs: 2000 }),
  meta(EventType.SetPlayerTeam, 'SetPlayerTeam', false),
  meta(EventType.SetTeamsLock, 'SetTeamsLock', false),
  meta(EventType.SetPlayerAdmin, 'SetPlayerAdmin', false),
  meta(EventType.AutoTeams, 'AutoTeams', false),
  meta(EventType.SetPlayerSync, 'SetPlayerSync', false, 'any', { burst: 2, intervalMs: 10000 }),
  meta(EventType.Ping, 'Ping', false, 'hostOnly'),
  meta(EventType.SetAvatar, 'SetAvatar', false),
  meta(EventType.SetTeamColors, 'SetTeamColors', false),
  meta(EventType.ReorderPlayers, 'ReorderPlayers', false, 'hostOnly'),
  meta(EventType.SetKickRateLimit, 'SetKickRateLimit', false),
  meta(EventType.SetHeadlessAvatar, 'SetHeadlessAvatar', false, 'hostOnly'),
  meta(EventType.SetDiscProperties, 'SetDiscProperties', false, 'hostOnly'),
];

/**
 * Host-side sender filter (official `tb(byId, state)`), evaluated BEFORE the
 * payload is decoded: 'accept', 'drop' (skip the rest of the message) or
 * 'kick' (protocol violation).
 */
export function checkClientSender(type: number, playerId: number, rs: RoomState): 'accept' | 'drop' | 'kick' {
  const m = EVENT_META[type];
  if (m === undefined) return 'kick';
  if (m.sender === 'hostOnly') return 'kick';
  if (m.sender === 'adminOnly') {
    const p = getPlayer(rs, playerId);
    return p !== null && p.isAdmin ? 'accept' : 'drop';
  }
  return 'accept';
}

/** Truncates to `max` UTF-16 code units (official `R.rb`). */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substr(0, max);
}

// --------------------------------------------------------------------- base

/** Base class of every event (official `m`). */
export abstract class RoomEvent {
  /** Issuer player id, 0 = host. off `B` · nh `byId`/`G`. Not part of the payload. */
  byId = 0;
  /** Frame the event is applied at (EventFrame header). off `eb`. */
  frame = 0;
  /** Index within the frame (EventFrame header). off `fb`. */
  order = 0;
  /** Client sequence number echoed in the EventFrame header (0 for host events). off `vi`. */
  clientSeq = 0;

  abstract get type(): EventType;
  /** Payload only (no type byte). off `S`. */
  abstract write(w: Writer): void;
  /** Payload only; throws on invalid data like the official reader. off `W`. */
  abstract read(r: Reader): void;
  /** Deterministic effect on the room. off `apply`. */
  abstract apply(rs: RoomState): void;
  /** Host-side acceptance hook before scheduling (official `fg`; only SendChat uses it). */
  validate(_rs: RoomState): boolean {
    return true;
  }
  get meta(): EventMeta {
    return EVENT_META[this.type]!;
  }
}

// ------------------------------------------------------------------- events

/** 0 — off `Z`. Host only. */
export class SendAnnouncementEvent extends RoomEvent {
  message = '';
  /** RGB, -1 = default. */
  color = -1;
  /** 0 normal, 1 bold, 2 italic, 3 small, 4 small-bold, 5 small-italic. */
  style = 0;
  /** 0 none, 1 chat, 2 highlight. */
  sound = 0;
  get type(): EventType {
    return EventType.SendAnnouncement;
  }
  static create(message: string, color: number, style: number, sound: number): SendAnnouncementEvent {
    const e = new SendAnnouncementEvent();
    e.message = message;
    e.color = color;
    e.style = style;
    e.sound = sound;
    return e;
  }
  write(w: Writer): void {
    w.string(truncate(this.message, 1000));
    w.i32(this.color);
    w.u8(this.style);
    w.u8(this.sound);
  }
  read(r: Reader): void {
    this.message = r.string();
    if (this.message.length > 1000) throw new CodecError('message too long');
    this.color = r.i32();
    this.style = r.u8();
    this.sound = r.u8();
  }
  apply(rs: RoomState): void {
    if (this.byId !== 0) return;
    const h = rs.hooks.onAnnouncement;
    if (h !== null) h(this.message, this.color, this.style, this.sound);
  }
}

/** 1 — off `Ca`. */
export class SendChatIndicatorEvent extends RoomEvent {
  /** u8 as sent by the client (the official client sends 0/1). */
  value = 0;
  get type(): EventType {
    return EventType.SendChatIndicator;
  }
  static create(value: number): SendChatIndicatorEvent {
    const e = new SendChatIndicatorEvent();
    e.value = value;
    return e;
  }
  write(w: Writer): void {
    w.u8(this.value);
  }
  read(r: Reader): void {
    this.value = r.u8();
  }
  apply(rs: RoomState): void {
    const p = getPlayer(rs, this.byId);
    const h = rs.hooks.onChatIndicator;
    if (p !== null && h !== null) h(p, this.value);
  }
}

/** 2 — off `ma`. Host only; payload = 4-byte BE checksum. */
export class CheckConsistencyEvent extends RoomEvent {
  data: Uint8Array = new Uint8Array(0);
  get type(): EventType {
    return EventType.CheckConsistency;
  }
  /** Event carrying the current checksum of `rs` (official `Ta.Qg`). */
  static create(rs: RoomState): CheckConsistencyEvent {
    const e = new CheckConsistencyEvent();
    e.data = roomStateChecksumBytes(rs);
    return e;
  }
  write(w: Writer): void {
    w.varUint(this.data.length);
    w.bytes(this.data);
  }
  read(r: Reader): void {
    this.data = r.bytesCopy(r.varUint());
  }
  apply(rs: RoomState): void {
    const d = this.data;
    if (d.length < 4) throw new RangeError('Offset is outside the bounds of the DataView');
    const expected = (d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!;
    const h = rs.hooks.onConsistencyResult;
    if (h !== null) h(roomStateChecksum(rs) !== expected);
  }
}

/** 3 — off `Da`. delay + predictable. */
export class SendInputEvent extends RoomEvent {
  /** u32 bitmask (up 1, down 2, left 4, right 8, kick 16). */
  input = 0;
  get type(): EventType {
    return EventType.SendInput;
  }
  static create(input: number): SendInputEvent {
    const e = new SendInputEvent();
    e.input = input >>> 0;
    return e;
  }
  write(w: Writer): void {
    w.u32(this.input);
  }
  read(r: Reader): void {
    this.input = r.u32();
  }
  apply(rs: RoomState): void {
    const p = getPlayer(rs, this.byId);
    if (p === null) return;
    const previous = p.input;
    const input = this.input;
    if ((p.input & 16) === 0 && (input & 16) !== 0) p.isKicking = true;
    p.input = input;
    const h = rs.hooks.onPlayerInput;
    if (h !== null && p.disc !== null) h(p, previous);
  }
}

/** 4 — off `na`. Rate limited 10 / 900 ms. */
export class SendChatEvent extends RoomEvent {
  message = '';
  get type(): EventType {
    return EventType.SendChat;
  }
  static create(message: string): SendChatEvent {
    const e = new SendChatEvent();
    e.message = message;
    return e;
  }
  write(w: Writer): void {
    w.string(truncate(this.message, 140));
  }
  read(r: Reader): void {
    this.message = r.string();
    if (this.message.length > 140) throw new CodecError('message too long');
  }
  override validate(rs: RoomState): boolean {
    const f = rs.hooks.onPlayerChatFilter;
    if (f === null) return true;
    const p = getPlayer(rs, this.byId);
    return p === null ? false : f(p, this.message);
  }
  apply(rs: RoomState): void {
    const p = getPlayer(rs, this.byId);
    const h = rs.hooks.onPlayerChat;
    if (p !== null && h !== null) h(p, this.message);
  }
}

/** 5 — off `aa`. Host only. */
export class JoinRoomEvent extends RoomEvent {
  playerId = 0;
  name: string | null = null;
  flag: string | null = null;
  avatar: string | null = null;
  get type(): EventType {
    return EventType.JoinRoom;
  }
  static create(playerId: number, name: string | null, flag: string | null, avatar: string | null): JoinRoomEvent {
    const e = new JoinRoomEvent();
    e.playerId = playerId;
    e.name = name;
    e.flag = flag;
    e.avatar = avatar;
    return e;
  }
  write(w: Writer): void {
    w.i32(this.playerId);
    w.nullableString(this.name);
    w.nullableString(this.flag);
    w.nullableString(this.avatar);
  }
  read(r: Reader): void {
    this.playerId = r.i32();
    this.name = r.nullableString();
    this.flag = r.nullableString();
    this.avatar = r.nullableString();
  }
  apply(rs: RoomState): void {
    if (this.byId !== 0) return;
    const p = new Player();
    p.id = this.playerId;
    p.name = this.name;
    p.flag = this.flag;
    p.avatar = this.avatar;
    rs.players.push(p);
    const h = rs.hooks.onPlayerJoin;
    if (h !== null) h(p);
  }
}

/** 6 — off `S`. `reason === null` = voluntary leave. Admin (or host). */
export class KickBanPlayerEvent extends RoomEvent {
  playerId = 0;
  reason: string | null = null;
  ban = false;
  get type(): EventType {
    return EventType.KickBanPlayer;
  }
  static create(playerId: number, reason: string | null, ban: boolean): KickBanPlayerEvent {
    const e = new KickBanPlayerEvent();
    e.playerId = playerId;
    e.reason = reason;
    e.ban = ban;
    return e;
  }
  write(w: Writer): void {
    if (this.reason !== null) this.reason = truncate(this.reason, 100); // official mutates the field
    w.i32(this.playerId);
    w.nullableString(this.reason);
    w.u8(this.ban ? 1 : 0);
  }
  read(r: Reader): void {
    this.playerId = r.i32();
    this.reason = r.nullableString();
    this.ban = r.u8() !== 0;
    if (this.reason !== null && this.reason.length > 100) throw new CodecError('string too long');
  }
  apply(rs: RoomState): void {
    if (this.playerId === 0 || !isHostOrAdmin(rs, this.byId)) return;
    const p = getPlayer(rs, this.playerId);
    if (p === null) return;
    const by = getPlayer(rs, this.byId);
    removeItem(rs.players, p);
    if (rs.gameState !== null && p.disc !== null) removeItem(rs.gameState.world.discs, p.disc);
    const h = rs.hooks.onPlayerLeave;
    if (h !== null) h(p, this.reason, this.ban, by);
  }
}

/** 7 — off `oa`. */
export class StartGameEvent extends RoomEvent {
  get type(): EventType {
    return EventType.StartGame;
  }
  write(_w: Writer): void {}
  read(_r: Reader): void {}
  apply(rs: RoomState): void {
    if (isHostOrAdmin(rs, this.byId)) startGame(rs, getPlayer(rs, this.byId));
  }
}

/** 8 — off `pa`. */
export class StopGameEvent extends RoomEvent {
  get type(): EventType {
    return EventType.StopGame;
  }
  write(_w: Writer): void {}
  read(_r: Reader): void {}
  apply(rs: RoomState): void {
    if (!isHostOrAdmin(rs, this.byId)) return;
    const by = getPlayer(rs, this.byId);
    if (rs.gameState === null) return;
    destroyGame(rs);
    const h = rs.hooks.onGameStop;
    if (h !== null) h(by);
  }
}

/** 9 — off `qa`. delay + predictable. Pause = 120; resume sets 119 (counts down). */
export class PauseResumeGameEvent extends RoomEvent {
  paused = false;
  get type(): EventType {
    return EventType.PauseResumeGame;
  }
  static create(paused: boolean): PauseResumeGameEvent {
    const e = new PauseResumeGameEvent();
    e.paused = paused;
    return e;
  }
  write(w: Writer): void {
    w.u8(this.paused ? 1 : 0);
  }
  read(r: Reader): void {
    this.paused = r.u8() !== 0;
  }
  apply(rs: RoomState): void {
    const gs = rs.gameState;
    if (gs === null || !isHostOrAdmin(rs, this.byId)) return;
    const by = getPlayer(rs, this.byId);
    const wasFullyPaused = gs.pauseGameTickCounter === PAUSED_TICKS;
    const wasPaused = gs.pauseGameTickCounter > 0;
    if (this.paused) gs.pauseGameTickCounter = PAUSED_TICKS;
    else if (gs.pauseGameTickCounter === PAUSED_TICKS) gs.pauseGameTickCounter = PAUSED_TICKS - 1;
    const h = rs.hooks.onGamePauseChange;
    if (wasFullyPaused !== this.paused && h !== null) h(by, this.paused, wasPaused);
  }
}

/** 10 — off `U`. kind 0 = score limit, 1 = time limit (minutes); clamped to 0..99; only without a game. */
export class SetGamePlayLimitEvent extends RoomEvent {
  kind = 0;
  value = 0;
  get type(): EventType {
    return EventType.SetGamePlayLimit;
  }
  static create(kind: number, value: number): SetGamePlayLimitEvent {
    const e = new SetGamePlayLimitEvent();
    e.kind = kind;
    e.value = value;
    return e;
  }
  write(w: Writer): void {
    w.i32(this.kind);
    w.i32(this.value);
  }
  read(r: Reader): void {
    this.kind = r.i32();
    this.value = r.i32();
  }
  apply(rs: RoomState): void {
    if (!isHostOrAdmin(rs, this.byId) || rs.gameState !== null) return;
    const v = this.value;
    const clamped = v < 0 ? 0 : v > 99 ? 99 : v;
    if (this.kind === 0) rs.scoreLimit = clamped;
    else if (this.kind === 1) rs.timeLimit = clamped;
  }
}

/** 11 — off `V`. Payload: u16 n + deflateRaw(stadium). Admin-only filter, 10 / 2000 ms. */
export class SetStadiumEvent extends RoomEvent {
  stadium: Stadium | null = null;
  /**
   * Deflated stadium of the first {@link write}, reused by the next ones (the
   * broadcast and the replay recorder write the same event: ~270 µs each for a
   * 12 KB stadium). Nothing in haxlite mutates a Stadium once it is in an
   * event; one changed afterwards (by the caller) would desync clients anyway.
   * Keyed by the stadium object, so assigning `stadium` invalidates it.
   */
  private packed: Uint8Array | null = null;
  private packedFor: Stadium | null = null;
  get type(): EventType {
    return EventType.SetStadium;
  }
  static create(stadium: Stadium): SetStadiumEvent {
    const e = new SetStadiumEvent();
    e.stadium = stadium;
    return e;
  }
  write(w: Writer): void {
    let packed = this.packed;
    if (packed === null || this.packedFor !== this.stadium) {
      const tmp = new Writer(1024);
      writeStadium(tmp, this.stadium!);
      // exact-size copy: node:zlib's result can be a view over a 16 KB chunk
      packed = this.packed = deflateRaw(tmp.finish()).slice();
      this.packedFor = this.stadium;
    }
    w.u16(packed.length);
    w.bytes(packed);
  }
  read(r: Reader): void {
    const raw = inflateRaw(r.bytes(r.u16()));
    this.stadium = readStadium(new Reader(raw));
    this.packed = this.packedFor = null;
  }
  apply(rs: RoomState): void {
    if (!isHostOrAdmin(rs, this.byId)) return;
    const by = getPlayer(rs, this.byId);
    if (rs.gameState !== null) return;
    rs.stadium = this.stadium;
    const h = rs.hooks.onStadiumChange;
    if (h !== null) h(by, this.stadium!);
  }
}

/** 12 — off `ba`. Admin, or self when teams are unlocked and no game runs. */
export class SetPlayerTeamEvent extends RoomEvent {
  playerId = 0;
  team: TeamId = TeamId.Spectators;
  get type(): EventType {
    return EventType.SetPlayerTeam;
  }
  static create(playerId: number, team: TeamId): SetPlayerTeamEvent {
    const e = new SetPlayerTeamEvent();
    e.playerId = playerId;
    e.team = team;
    return e;
  }
  write(w: Writer): void {
    w.i32(this.playerId);
    w.u8(this.team);
  }
  read(r: Reader): void {
    this.playerId = r.i32();
    this.team = toTeamId(r.i8());
  }
  apply(rs: RoomState): void {
    const p = getPlayer(rs, this.playerId);
    if (p === null) return;
    const by = getPlayer(rs, this.byId);
    const allowed = isHostOrAdmin(rs, this.byId) || (p === by && !rs.teamsLocked && rs.gameState === null);
    if (allowed) setPlayerTeam(rs, by, p, this.team);
  }
}

/** 13 — off `ra`. */
export class SetTeamsLockEvent extends RoomEvent {
  locked = false;
  get type(): EventType {
    return EventType.SetTeamsLock;
  }
  static create(locked: boolean): SetTeamsLockEvent {
    const e = new SetTeamsLockEvent();
    e.locked = locked;
    return e;
  }
  write(w: Writer): void {
    w.u8(this.locked ? 1 : 0);
  }
  read(r: Reader): void {
    this.locked = r.u8() !== 0;
  }
  apply(rs: RoomState): void {
    if (!isHostOrAdmin(rs, this.byId)) return;
    const old = rs.teamsLocked;
    rs.teamsLocked = this.locked;
    const h = rs.hooks.onTeamsLockChange;
    if (old !== this.locked && h !== null) h(getPlayer(rs, this.byId), this.locked);
  }
}

/** 14 — off `ca`. */
export class SetPlayerAdminEvent extends RoomEvent {
  playerId = 0;
  isAdmin = false;
  get type(): EventType {
    return EventType.SetPlayerAdmin;
  }
  static create(playerId: number, isAdmin: boolean): SetPlayerAdminEvent {
    const e = new SetPlayerAdminEvent();
    e.playerId = playerId;
    e.isAdmin = isAdmin;
    return e;
  }
  write(w: Writer): void {
    w.i32(this.playerId);
    w.u8(this.isAdmin ? 1 : 0);
  }
  read(r: Reader): void {
    this.playerId = r.i32();
    this.isAdmin = r.u8() !== 0;
  }
  apply(rs: RoomState): void {
    if (!isHostOrAdmin(rs, this.byId)) return;
    const by = getPlayer(rs, this.byId);
    const p = getPlayer(rs, this.playerId);
    if (p === null || p.id === 0 || p.isAdmin === this.isAdmin) return;
    p.isAdmin = this.isAdmin;
    const h = rs.hooks.onPlayerAdminChange;
    if (h !== null) h(by, p);
  }
}

/** 15 — off `Ea`. Moves spectators to the team(s) with fewer players. */
export class AutoTeamsEvent extends RoomEvent {
  get type(): EventType {
    return EventType.AutoTeams;
  }
  write(_w: Writer): void {}
  read(_r: Reader): void {}
  apply(rs: RoomState): void {
    if (!isHostOrAdmin(rs, this.byId)) return;
    const by = getPlayer(rs, this.byId);
    const players = rs.players;
    const specs: Player[] = [];
    let red = 0;
    let blue = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.team === TeamId.Spectators) specs.push(p);
      if (p.team === TeamId.Red) ++red;
      else if (p.team === TeamId.Blue) ++blue;
    }
    const n = specs.length;
    if (n === 0) return;
    if (blue === red) {
      if (n >= 2) {
        setPlayerTeam(rs, by, specs[0]!, TeamId.Red);
        setPlayerTeam(rs, by, specs[1]!, TeamId.Blue);
      }
    } else {
      setPlayerTeam(rs, by, specs[0]!, blue > red ? TeamId.Red : TeamId.Blue);
    }
  }
}

/** 16 — off `Fa`. Sets the sender's desync flag. Rate limited 2 / 10 s. */
export class SetPlayerSyncEvent extends RoomEvent {
  desync = false;
  get type(): EventType {
    return EventType.SetPlayerSync;
  }
  static create(desync: boolean): SetPlayerSyncEvent {
    const e = new SetPlayerSyncEvent();
    e.desync = desync;
    return e;
  }
  write(w: Writer): void {
    w.u8(this.desync ? 1 : 0);
  }
  read(r: Reader): void {
    this.desync = r.u8() !== 0;
  }
  apply(rs: RoomState): void {
    const p = getPlayer(rs, this.byId);
    if (p === null || this.desync === p.desync) return;
    p.desync = this.desync;
    const h = rs.hooks.onPlayerDesyncChange;
    if (h !== null) h(p);
  }
}

/** 17 — off `da`. Host only, every 3 s: pings in player-list order. */
export class PingEvent extends RoomEvent {
  pings: number[] = [];
  get type(): EventType {
    return EventType.Ping;
  }
  static create(pings: number[]): PingEvent {
    const e = new PingEvent();
    e.pings = pings;
    return e;
  }
  /** Event with the current `player.ping` of every player, in list order (official `da.V`). */
  static fromRoom(rs: RoomState): PingEvent {
    const out: number[] = [];
    for (let i = 0; i < rs.players.length; i++) out.push(rs.players[i]!.ping);
    return PingEvent.create(out);
  }
  write(w: Writer): void {
    const p = this.pings;
    w.varUint(p.length);
    for (let i = 0; i < p.length; i++) w.varUint(p[i]!);
  }
  read(r: Reader): void {
    this.pings = [];
    const n = r.varUint();
    for (let i = 0; i < n; i++) this.pings.push(r.varUint());
  }
  apply(rs: RoomState): void {
    if (this.byId !== 0) return;
    const players = rs.players;
    for (let i = 0; i < players.length; i++) {
      if (i >= this.pings.length) break;
      players[i]!.ping = this.pings[i]!;
    }
  }
}

/** 18 — off `Ga`. Sender's avatar; > 8 units rejected, truncated to 2. */
export class SetAvatarEvent extends RoomEvent {
  avatar: string | null = null;
  get type(): EventType {
    return EventType.SetAvatar;
  }
  static create(avatar: string | null): SetAvatarEvent {
    const e = new SetAvatarEvent();
    e.avatar = avatar;
    return e;
  }
  write(w: Writer): void {
    w.nullableString(this.avatar);
  }
  read(r: Reader): void {
    this.avatar = r.nullableString();
    if (this.avatar !== null) {
      if (this.avatar.length > 8) throw new CodecError('avatar too long');
      this.avatar = truncate(this.avatar, 2);
    }
  }
  apply(rs: RoomState): void {
    const p = getPlayer(rs, this.byId);
    if (p !== null) p.avatar = this.avatar;
  }
}

/** 19 — off `sa`. Replaces the team's colours object (spectators ignored). */
export class SetTeamColorsEvent extends RoomEvent {
  team: TeamId = TeamId.Spectators;
  colors = new TeamColors();
  get type(): EventType {
    return EventType.SetTeamColors;
  }
  static create(team: TeamId, colors: TeamColors): SetTeamColorsEvent {
    const e = new SetTeamColorsEvent();
    e.team = team;
    e.colors = colors;
    return e;
  }
  write(w: Writer): void {
    w.u8(this.team);
    writeTeamColors(w, this.colors);
  }
  read(r: Reader): void {
    this.team = toTeamId(r.i8());
    this.colors = readTeamColors(r);
  }
  apply(rs: RoomState): void {
    if (!isHostOrAdmin(rs, this.byId) || this.team === TeamId.Spectators) return;
    if (this.team === TeamId.Red) rs.redColors = this.colors;
    else rs.blueColors = this.colors;
  }
}

/** 20 — off `ea`. Host only: moves the listed players to the top/bottom of the list. */
export class ReorderPlayersEvent extends RoomEvent {
  moveToTop = false;
  playerIds: number[] = [];
  get type(): EventType {
    return EventType.ReorderPlayers;
  }
  /** Deduplicates (first occurrence) and keeps at most 40 ids (official `ea.V`). */
  static create(playerIds: readonly number[], moveToTop: boolean): ReorderPlayersEvent {
    const e = new ReorderPlayersEvent();
    const seen = new Set<number>();
    for (const id of playerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      e.playerIds.push(id);
      if (e.playerIds.length >= 40) break;
    }
    e.moveToTop = moveToTop;
    return e;
  }
  write(w: Writer): void {
    w.u8(this.moveToTop ? 1 : 0);
    const ids = this.playerIds;
    w.u8(ids.length);
    for (let i = 0; i < ids.length; i++) w.i32(ids[i]!);
  }
  read(r: Reader): void {
    this.moveToTop = r.u8() !== 0;
    const n = r.u8();
    this.playerIds = [];
    for (let i = 0; i < n; i++) this.playerIds.push(r.i32());
  }
  apply(rs: RoomState): void {
    if (this.byId !== 0) return;
    const byId = new Map<number, Player>();
    for (const p of rs.players) byId.set(p.id, p);
    const moved: Player[] = [];
    for (const id of this.playerIds) {
      const p = byId.get(id);
      if (p !== undefined) {
        byId.delete(id);
        moved.push(p);
      }
    }
    const rest = [...byId.values()];
    rs.players = this.moveToTop ? moved.concat(rest) : rest.concat(moved);
  }
}

/** 21 — off `fa`. min/rate clamped 0..255, burst 0..100; max = rate·burst. */
export class SetKickRateLimitEvent extends RoomEvent {
  min = 2;
  rate = 0;
  burst = 0;
  get type(): EventType {
    return EventType.SetKickRateLimit;
  }
  static create(min: number, rate: number, burst: number): SetKickRateLimitEvent {
    const e = new SetKickRateLimitEvent();
    e.min = min;
    e.rate = rate;
    e.burst = burst;
    return e;
  }
  write(w: Writer): void {
    w.i32(this.min);
    w.i32(this.rate);
    w.i32(this.burst);
  }
  read(r: Reader): void {
    this.min = r.i32();
    this.rate = r.i32();
    this.burst = r.i32();
  }
  apply(rs: RoomState): void {
    if (isHostOrAdmin(rs, this.byId)) setKickRateLimit(rs, getPlayer(rs, this.byId), this.min, this.rate, this.burst);
  }
}

/** 22 — off `ha`. Host only. Payload order: avatar, then player id. */
export class SetHeadlessAvatarEvent extends RoomEvent {
  avatar: string | null = null;
  playerId = 0;
  get type(): EventType {
    return EventType.SetHeadlessAvatar;
  }
  static create(playerId: number, avatar: string | null): SetHeadlessAvatarEvent {
    const e = new SetHeadlessAvatarEvent();
    e.avatar = avatar !== null ? truncate(avatar, 2) : null;
    e.playerId = playerId;
    return e;
  }
  write(w: Writer): void {
    w.nullableString(this.avatar);
    w.i32(this.playerId);
  }
  read(r: Reader): void {
    this.avatar = r.nullableString();
    this.playerId = r.i32();
    if (this.avatar !== null) this.avatar = truncate(this.avatar, 2);
  }
  apply(rs: RoomState): void {
    const p = getPlayer(rs, this.playerId);
    if (p !== null && this.byId === 0) p.headlessAvatar = this.avatar;
  }
}

/** Bits / value slots of {@link SetDiscPropertiesEvent} (order = wire order = Disc field order). */
export const DiscProp = {
  x: 0,
  y: 1,
  xspeed: 2,
  yspeed: 3,
  xgravity: 4,
  ygravity: 5,
  radius: 6,
  bCoef: 7,
  invMass: 8,
  damping: 9,
  color: 10,
  cMask: 11,
  cGroup: 12,
} as const;
export type DiscPropName = keyof typeof DiscProp;
const DISC_PROP_NAMES = Object.keys(DiscProp) as DiscPropName[];

/**
 * 23 — off `M`. Host only. Sets disc fields present in `mask` (bits 0..9:
 * float32 values, bits 10..12: int32). Host-created values are quantised to
 * float32 / int32 exactly as official (`Float32Array`/`Int32Array` round trip).
 */
export class SetDiscPropertiesEvent extends RoomEvent {
  /** Player id if `isPlayer`, else index into `World.discs`. */
  targetId = 0;
  isPlayer = false;
  /** 13-bit presence mask. */
  mask = 0;
  /** Values by {@link DiscProp} slot (only slots present in `mask` are meaningful). */
  readonly values = new Float64Array(13);
  get type(): EventType {
    return EventType.SetDiscProperties;
  }
  /** Official `M.dg`: `props` uses HBInit names (`bCoeff` is accepted as an alias of bCoef). */
  static create(
    targetId: number,
    isPlayer: boolean,
    props: Partial<Record<DiscPropName | 'bCoeff', number | null>>,
  ): SetDiscPropertiesEvent {
    const e = new SetDiscPropertiesEvent();
    e.targetId = targetId;
    e.isPlayer = isPlayer;
    const src = props as Record<string, number | null | undefined>;
    for (let i = 0; i < 13; i++) {
      const name = DISC_PROP_NAMES[i]!;
      const v = name === 'bCoef' ? (src.bCoeff ?? src.bCoef) : src[name];
      if (v == null) continue;
      e.mask |= 1 << i;
      e.values[i] = i < 10 ? Math.fround(v) : v | 0;
    }
    return e;
  }
  has(prop: DiscPropName): boolean {
    return (this.mask & (1 << DiscProp[prop])) !== 0;
  }
  write(w: Writer): void {
    w.i32(this.targetId);
    w.u8(this.isPlayer ? 1 : 0);
    const mask = this.mask & 0x1fff;
    w.u16(mask);
    const v = this.values;
    for (let i = 0; i < 10; i++) if ((mask & (1 << i)) !== 0) w.f32(v[i]!);
    for (let i = 10; i < 13; i++) if ((mask & (1 << i)) !== 0) w.i32(v[i]!);
  }
  read(r: Reader): void {
    this.targetId = r.i32();
    this.isPlayer = r.u8() !== 0;
    const mask = r.u16() & 0x1fff;
    this.mask = mask;
    const v = this.values;
    v.fill(0);
    for (let i = 0; i < 10; i++) if ((mask & (1 << i)) !== 0) v[i] = r.f32();
    for (let i = 10; i < 13; i++) if ((mask & (1 << i)) !== 0) v[i] = r.i32();
  }
  apply(rs: RoomState): void {
    if (this.byId !== 0) return;
    const gs = rs.gameState;
    if (gs === null) return;
    let d: Disc | null | undefined;
    if (this.isPlayer) {
      const p = getPlayer(rs, this.targetId);
      if (p === null) return;
      d = p.disc;
    } else {
      d = gs.world.discs[this.targetId];
    }
    if (d == null) return;
    const m = this.mask;
    const v = this.values;
    if ((m & 1) !== 0) d.x = v[0]!;
    if ((m & 2) !== 0) d.y = v[1]!;
    if ((m & 4) !== 0) d.xspeed = v[2]!;
    if ((m & 8) !== 0) d.yspeed = v[3]!;
    if ((m & 16) !== 0) d.xgravity = v[4]!;
    if ((m & 32) !== 0) d.ygravity = v[5]!;
    if ((m & 64) !== 0) d.radius = v[6]!;
    if ((m & 128) !== 0) d.bCoef = v[7]!;
    if ((m & 256) !== 0) d.invMass = v[8]!;
    if ((m & 512) !== 0) d.damping = v[9]!;
    if ((m & 1024) !== 0) d.color = v[10]!;
    if ((m & 2048) !== 0) d.cMask = v[11]!;
    if ((m & 4096) !== 0) d.cGroup = v[12]!;
  }
}

// ----------------------------------------------------------------- registry

type EventCtor = new () => RoomEvent;

/** Constructors indexed by EventType (official registration order). */
export const EVENT_CLASSES: readonly EventCtor[] = [
  SendAnnouncementEvent,
  SendChatIndicatorEvent,
  CheckConsistencyEvent,
  SendInputEvent,
  SendChatEvent,
  JoinRoomEvent,
  KickBanPlayerEvent,
  StartGameEvent,
  StopGameEvent,
  PauseResumeGameEvent,
  SetGamePlayLimitEvent,
  SetStadiumEvent,
  SetPlayerTeamEvent,
  SetTeamsLockEvent,
  SetPlayerAdminEvent,
  AutoTeamsEvent,
  SetPlayerSyncEvent,
  PingEvent,
  SetAvatarEvent,
  SetTeamColorsEvent,
  ReorderPlayersEvent,
  SetKickRateLimitEvent,
  SetHeadlessAvatarEvent,
  SetDiscPropertiesEvent,
];

/** Empty instance of event `type`; throws CodecError for unknown types (official: disconnect). */
export function createEvent(type: number): RoomEvent {
  const C = EVENT_CLASSES[type];
  if (C === undefined) throw new CodecError(`unknown event type ${type}`);
  return new C();
}

/** `u8 type` + payload (official `m.te`). */
export function writeEvent(w: Writer, ev: RoomEvent): void {
  w.u8(ev.type);
  ev.write(w);
}

/** Reads `u8 type` + payload (official `m.Ji` + `W`). */
export function readEvent(r: Reader): RoomEvent {
  const ev = createEvent(r.u8());
  ev.read(r);
  return ev;
}

/** Convenience: event bytes (`u8 type` + payload) in a fresh array. */
export function encodeEvent(ev: RoomEvent): Uint8Array {
  const w = new Writer(64);
  writeEvent(w, ev);
  return w.copyBytes();
}

/** Convenience: decodes `u8 type` + payload; throws if bytes remain. */
export function decodeEvent(bytes: Uint8Array, byId = 0): RoomEvent {
  const r = new Reader(bytes);
  const ev = readEvent(r);
  if (r.remaining > 0) throw new CodecError('trailing bytes after event');
  ev.byId = byId;
  return ev;
}

/**
 * EventFrame header + event as broadcast by the host (P2P msg 2 body / items
 * of the join snapshot, official `Wa.rf`): u32 frame, varuint order, u16
 * byId, u32 clientSeq, u8 type, payload.
 */
export function writeEventFrame(w: Writer, ev: RoomEvent): void {
  w.u32(ev.frame);
  w.varUint(ev.order);
  w.u16(ev.byId);
  w.u32(ev.clientSeq);
  writeEvent(w, ev);
}

/** Inverse of {@link writeEventFrame} (what a client reads). */
export function readEventFrame(r: Reader): RoomEvent {
  const frame = r.u32();
  const order = r.varUint();
  const byId = r.u16();
  const clientSeq = r.u32();
  const ev = readEvent(r);
  ev.frame = frame;
  ev.order = order;
  ev.byId = byId;
  ev.clientSeq = clientSeq;
  return ev;
}
