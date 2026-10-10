/**
 * Differential harness: our room (src/room + src/sim) vs the OFFICIAL headless
 * code (test/oracle/official.ts), driven by identical event bytes. Event
 * bytes are produced by OUR encoders, so the official side also validates the
 * encoding.
 */
import { Writer } from '../../src/codec/index.js';
import { Input, TeamId } from '../../src/protocol.js';
import {
  AutoTeamsEvent,
  CheckConsistencyEvent,
  JoinRoomEvent,
  KickBanPlayerEvent,
  PauseResumeGameEvent,
  PingEvent,
  ReorderPlayersEvent,
  RoomEvent,
  RoomState,
  SendAnnouncementEvent,
  SendChatEvent,
  SendChatIndicatorEvent,
  SendInputEvent,
  SetAvatarEvent,
  SetDiscPropertiesEvent,
  SetGamePlayLimitEvent,
  SetHeadlessAvatarEvent,
  SetKickRateLimitEvent,
  SetPlayerAdminEvent,
  SetPlayerSyncEvent,
  SetPlayerTeamEvent,
  SetStadiumEvent,
  SetTeamColorsEvent,
  SetTeamsLockEvent,
  StartGameEvent,
  StopGameEvent,
  TeamColors,
  createRoomState,
  decodeEvent,
  encodeEvent,
  roomStateChecksum,
  stepRoom,
  writeRoomState,
} from '../../src/room/index.js';
import type { Stadium } from '../../src/sim/types.js';
import { OfficialRoom } from '../oracle/official.js';
import { hex } from './helpers.js';

/** Our side, with the same core API as OfficialRoom. */
export class OurRoom {
  rs: RoomState;
  frame = 0;
  private readonly w = new Writer(8192);
  constructor(rs?: RoomState) {
    this.rs = rs ?? createRoomState();
  }
  applyEventBytes(bytes: Uint8Array, byId = 0): this {
    decodeEvent(bytes, byId).apply(this.rs);
    return this;
  }
  step(n = 1): this {
    for (let i = 0; i < n; i++) {
      stepRoom(this.rs);
      this.frame++;
    }
    return this;
  }
  /** View valid until the next call. */
  stateBytesView(): Uint8Array {
    this.w.reset();
    writeRoomState(this.w, this.rs);
    return this.w.finish();
  }
  stateBytes(): Uint8Array {
    return this.stateBytesView().slice();
  }
  checksum(): number {
    return roomStateChecksum(this.rs);
  }
}

export interface Pair {
  ours: OurRoom;
  off: OfficialRoom;
}

export function applyBoth(p: Pair, ev: RoomEvent | Uint8Array, byId = 0): void {
  const bytes = ev instanceof Uint8Array ? ev : encodeEvent(ev);
  p.off.applyEventBytes(bytes, byId);
  p.ours.applyEventBytes(bytes, byId);
}

/** Compares full state bytes; throws a readable error on mismatch. */
export function compareBytes(p: Pair, label: string): void {
  const a = p.off.stateBytes();
  const b = p.ours.stateBytesView();
  if (Buffer.compare(a, b) !== 0) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    throw new Error(
      `${label}: state bytes differ at offset ${i} (official ${a.length} B, ours ${b.length} B)\n` +
        `official …${hex(a.subarray(Math.max(0, i - 16), i + 48))}\n` +
        `ours     …${hex(b.subarray(Math.max(0, i - 16), i + 48))}`,
    );
  }
}

/** Randomized timeline driver. Decides events from OUR state (identical to official while in sync). */
export interface DriverOptions {
  rnd: () => number;
  /** Stadium choices for SetStadium events (between games). */
  stadiums: Stadium[];
  /** Probability per tick of an "admin/other" event. */
  eventRate?: number;
  maxPlayers?: number;
}

export class RandomDriver {
  private nextId = 1;
  private readonly rnd: () => number;
  private readonly opt: Required<DriverOptions>;
  /** Count of events by type, for reporting. */
  readonly counts = new Array<number>(24).fill(0);

  constructor(opt: DriverOptions) {
    this.rnd = opt.rnd;
    this.opt = { eventRate: 0.02, maxPlayers: 8, ...opt };
  }

  private pickPlayerId(rs: RoomState): number {
    if (rs.players.length === 0) return 0;
    return rs.players[Math.floor(this.rnd() * rs.players.length)]!.id;
  }

  /** A random issuer: host (0), a player, or a nonexistent id. */
  private issuer(rs: RoomState): number {
    const k = this.rnd();
    if (k < 0.5) return 0;
    if (k < 0.95) return this.pickPlayerId(rs);
    return 999;
  }

  /** Setup: N players joined and placed in teams, game started. */
  setup(p: Pair, players: number, opts: { stadium?: Stadium; scoreLimit?: number; timeLimit?: number; kickRate?: [number, number, number] } = {}): void {
    if (opts.stadium) this.emit(p, SetStadiumEvent.create(opts.stadium), 0);
    if (opts.scoreLimit !== undefined) this.emit(p, SetGamePlayLimitEvent.create(0, opts.scoreLimit), 0);
    if (opts.timeLimit !== undefined) this.emit(p, SetGamePlayLimitEvent.create(1, opts.timeLimit), 0);
    if (opts.kickRate) this.emit(p, SetKickRateLimitEvent.create(...opts.kickRate), 0);
    for (let i = 0; i < players; i++) this.join(p, i % 2 === 0 ? TeamId.Red : TeamId.Blue);
    this.emit(p, new StartGameEvent(), 0);
  }

  emit(p: Pair, ev: RoomEvent, byId: number): void {
    this.counts[ev.type]!++;
    applyBoth(p, ev, byId);
  }

  private join(p: Pair, team: TeamId): void {
    const id = this.nextId++;
    const r = this.rnd();
    this.emit(p, JoinRoomEvent.create(id, `p${id}${r < 0.3 ? '😀' : ''}`, r < 0.5 ? 'es' : null, r < 0.2 ? 'XX' : null), 0);
    if (team !== TeamId.Spectators) this.emit(p, SetPlayerTeamEvent.create(id, team), 0);
  }

  /**
   * Inputs: "striker" bot for every player with a disc: get behind the ball
   * (relative to the opponent goal), run into it and kick when close; plus
   * random masks. Decisions read OUR state (identical to official while in sync).
   */
  inputs(p: Pair): void {
    const rs = p.ours.rs;
    const gs = rs.gameState;
    if (gs === null) return;
    const ball = gs.world.discs[0]!;
    for (const pl of rs.players) {
      const me = pl.disc;
      if (me === null || this.rnd() < 0.7) continue;
      let mask: number;
      if (this.rnd() < 0.1) {
        mask = Math.floor(this.rnd() * 32);
      } else {
        const dir = pl.team === TeamId.Red ? 1 : -1; // attacking direction
        const behind = (ball.x - me.x) * dir > 0;
        const tx = behind ? ball.x : ball.x - dir * 40;
        const ty = behind ? ball.y : ball.y + (me.y > ball.y ? 35 : -35);
        mask = (tx > me.x + 2 ? Input.Right : tx < me.x - 2 ? Input.Left : 0) | (ty > me.y + 2 ? Input.Down : ty < me.y - 2 ? Input.Up : 0);
        const dx = ball.x - me.x;
        const dy = ball.y - me.y;
        const near = Math.sqrt(dx * dx + dy * dy) < me.radius + ball.radius + 8;
        if ((near && behind && this.rnd() < 0.7) || this.rnd() < 0.05) mask |= pl.input & Input.Kick ? 0 : Input.Kick;
      }
      if (mask !== pl.input) this.emit(p, SendInputEvent.create(mask), pl.id);
    }
  }

  /** Random non-input events. */
  others(p: Pair): void {
    const rs = p.ours.rs;
    const rnd = this.rnd;
    // keep a game running most of the time
    if (rs.gameState === null && rnd() < 0.05) {
      if (rnd() < 0.3) this.emit(p, SetStadiumEvent.create(this.opt.stadiums[Math.floor(rnd() * this.opt.stadiums.length)]!), 0);
      this.emit(p, new StartGameEvent(), rnd() < 0.8 ? 0 : this.pickPlayerId(rs));
      return;
    }
    // resume quickly after a pause
    if (rs.gameState !== null && rs.gameState.pauseGameTickCounter === 120 && rnd() < 0.02) {
      this.emit(p, PauseResumeGameEvent.create(false), 0);
      return;
    }
    if (rnd() >= this.opt.eventRate) return;
    const by = this.issuer(rs);
    const target = this.pickPlayerId(rs);
    const k = Math.floor(rnd() * 26);
    switch (k) {
      case 0:
        this.emit(p, SendAnnouncementEvent.create('hi ' + k, -1, 1, 2), by);
        break;
      case 1:
        this.emit(p, SendChatIndicatorEvent.create(rnd() < 0.5 ? 0 : 1), target);
        break;
      case 2:
        this.emit(p, CheckConsistencyEvent.create(rs), 0);
        break;
      case 3:
        this.emit(p, SendChatEvent.create('gg'), target);
        break;
      case 4:
        if (rs.players.length < this.opt.maxPlayers) this.join(p, Math.floor(rnd() * 3) as TeamId);
        break;
      case 5:
        if (rs.players.length > 2) this.emit(p, KickBanPlayerEvent.create(target, rnd() < 0.5 ? null : 'bye', rnd() < 0.3), by);
        break;
      case 6:
        if (rnd() < 0.15) this.emit(p, new StopGameEvent(), by);
        break;
      case 7:
        this.emit(p, new StartGameEvent(), by);
        break;
      case 8:
        this.emit(p, PauseResumeGameEvent.create(rnd() < 0.3), by);
        break;
      case 9:
        this.emit(p, SetGamePlayLimitEvent.create(rnd() < 0.5 ? 0 : 1, Math.floor(rnd() * 6) - 1), by);
        break;
      case 10:
        this.emit(p, SetPlayerTeamEvent.create(target, Math.floor(rnd() * 3) as TeamId), rnd() < 0.5 ? by : target);
        break;
      case 11:
        this.emit(p, SetTeamsLockEvent.create(rnd() < 0.5), by);
        break;
      case 12:
        this.emit(p, SetPlayerAdminEvent.create(target, rnd() < 0.5), by);
        break;
      case 13:
        this.emit(p, new AutoTeamsEvent(), by);
        break;
      case 14:
        this.emit(p, SetPlayerSyncEvent.create(rnd() < 0.5), target);
        break;
      case 15:
        this.emit(p, PingEvent.create(rs.players.map(() => Math.floor(rnd() * 200))), 0);
        break;
      case 16:
        this.emit(p, SetAvatarEvent.create(rnd() < 0.3 ? null : 'a' + Math.floor(rnd() * 9)), target);
        break;
      case 17: {
        const tc = new TeamColors();
        tc.angle = Math.floor(rnd() * 256);
        tc.textColor = Math.floor(rnd() * 0xffffff);
        for (let i = 0, n = Math.floor(rnd() * 4); i < n; i++) tc.colors.push(Math.floor(rnd() * 0xffffff));
        this.emit(p, SetTeamColorsEvent.create(Math.floor(rnd() * 3) as TeamId, tc), by);
        break;
      }
      case 18:
        this.emit(p, ReorderPlayersEvent.create(rs.players.filter(() => rnd() < 0.4).map((x) => x.id), rnd() < 0.5), 0);
        break;
      case 19:
        this.emit(p, SetKickRateLimitEvent.create(Math.floor(rnd() * 6), Math.floor(rnd() * 12), Math.floor(rnd() * 5)), by);
        break;
      case 20:
        this.emit(p, SetHeadlessAvatarEvent.create(target, rnd() < 0.3 ? null : '⚽'), 0);
        break;
      case 21:
      case 22: {
        const gs = rs.gameState;
        if (gs === null) break;
        const props: Record<string, number> = {};
        if (rnd() < 0.6) props.xspeed = (rnd() - 0.5) * 8;
        if (rnd() < 0.6) props.yspeed = (rnd() - 0.5) * 8;
        if (rnd() < 0.3) props.x = (rnd() - 0.5) * 300;
        if (rnd() < 0.3) props.y = (rnd() - 0.5) * 150;
        if (rnd() < 0.2) props.radius = 5 + rnd() * 15;
        if (rnd() < 0.2) props.bCoef = rnd();
        if (rnd() < 0.2) props.invMass = rnd() * 2;
        if (rnd() < 0.2) props.damping = 0.9 + rnd() * 0.1;
        if (rnd() < 0.1) props.ygravity = (rnd() - 0.5) * 0.05;
        if (rnd() < 0.1) props.color = Math.floor(rnd() * 0xffffff);
        if (rnd() < 0.1) props.cMask = 63;
        if (rnd() < 0.05) props.cGroup = 193;
        if (k === 21) this.emit(p, SetDiscPropertiesEvent.create(Math.floor(rnd() * gs.world.discs.length), false, props), 0);
        else this.emit(p, SetDiscPropertiesEvent.create(target, true, props), 0);
        break;
      }
      case 23:
        if (rs.gameState === null) this.emit(p, SetStadiumEvent.create(this.opt.stadiums[Math.floor(rnd() * this.opt.stadiums.length)]!), by);
        break;
      case 24:
        // ensure enough players in teams
        if (rs.players.length < 3) this.join(p, rnd() < 0.5 ? TeamId.Red : TeamId.Blue);
        break;
      case 25:
        this.emit(p, SendInputEvent.create(Math.floor(rnd() * 4294967296)), target);
        break;
    }
  }
}

/** Runs `frames` ticks; checksum every tick, full bytes every `fullEvery` ticks. Returns ticks compared. */
export function runDiff(p: Pair, driver: RandomDriver, frames: number, fullEvery = 60, label = 'run'): number {
  for (let f = 0; f < frames; f++) {
    driver.inputs(p);
    driver.others(p);
    p.off.step();
    p.ours.step();
    const a = p.off.checksum();
    const b = p.ours.checksum();
    if (a !== b || f % fullEvery === 0) compareBytes(p, `${label} tick ${p.ours.frame}`);
  }
  compareBytes(p, `${label} end`);
  return frames;
}
