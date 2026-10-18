/**
 * TEST-ONLY differential oracle built on node-haxball (devDependency).
 *
 * node-haxball (wxyz-abcd, v2.3.1) is a full reimplementation whose clients
 * interoperate with official rooms (they pass the official CheckConsistency
 * hash), so its simulation + RoomState serializer are bit-exact with the
 * official game for everything we compare. It is minified; this module is the
 * ONLY place allowed to touch its internals (minified names). How they were
 * found is documented next to each use and in docs/06 §6.
 *
 * NEVER import this from src/. Product code must not depend on it.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The node-haxball API instance (shared; creating it is ~50 ms). */
export const nh: Any = (require('node-haxball') as (w?: unknown, c?: unknown) => Any)();
const { Room, Utils, Impl, EventFactory } = nh;

// ---------------------------------------------------------------- low level

/** node-haxball StreamWriter (`Impl.Stream.Writer`, readable aliases exist). */
export function nhWriter(capacity = 1024): Any {
  return Impl.Stream.Writer.create(capacity);
}

/** node-haxball StreamReader over `bytes` (`new Reader(DataView, littleEndian)`). */
export function nhReader(bytes: Uint8Array, littleEndian = false): Any {
  return new Impl.Stream.Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), littleEndian);
}

function written(w: Any): Uint8Array {
  // `toUint8Array` is a zero-copy view in node-haxball; copy so callers own it.
  return Uint8Array.from(w.toUint8Array() as Uint8Array);
}

/** sha256 hex of bytes (stable state fingerprint for logs/snapshots). */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic PRNG (mulberry32) for reproducible random inputs in tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------- stadiums

/** Names of the built-in stadiums, index = defaultStadiumId (0 Classic … 9 Huge). */
export const DEFAULT_STADIUM_NAMES: readonly string[] = Utils.getDefaultStadiums().map((s: Any) => s.name as string);

/**
 * How to designate a stadium:
 *  - number: built-in index 0..9
 *  - string: built-in name ("Classic", "Big", …) — case-insensitive
 *  - { hbs }: .hbs (JSON5) text
 *  - { bytes }: official binary stadium (u8 id [+ body if 255])
 */
export type StadiumSpec = number | string | { hbs: string } | { bytes: Uint8Array };

/** Returns a node-haxball Stadium object (internal) for `spec`. */
export function nhStadium(spec: StadiumSpec): Any {
  if (typeof spec === 'number') {
    const s = Utils.getDefaultStadiums()[spec];
    if (!s) throw new Error(`no default stadium #${spec}`);
    return s;
  }
  if (typeof spec === 'string') {
    const i = DEFAULT_STADIUM_NAMES.findIndex((n) => n.toLowerCase() === spec.toLowerCase());
    if (i < 0) throw new Error(`unknown default stadium "${spec}"`);
    return Utils.getDefaultStadiums()[i];
  }
  if ('hbs' in spec) {
    const s = Utils.parseStadium(spec.hbs);
    if (!s) throw new Error('node-haxball could not parse the .hbs');
    return s;
  }
  // Static reader: `Impl.Stadium.Stadium.o(reader)` = `u8 id` then body or default.
  return Impl.Stadium.Stadium.o(nhReader(spec.bytes));
}

/**
 * Official binary form of a stadium (as inside RoomState / SetStadium before
 * deflate). Built-ins serialize as a single byte unless `forceCustom`, which
 * emits the full 255-form body of the built-in geometry (handy to diff
 * engineer A's default-stadium generator field by field).
 */
export function stadiumToBytes(spec: StadiumSpec, opts: { forceCustom?: boolean } = {}): Uint8Array {
  let s = nhStadium(spec);
  if (opts.forceCustom && s.defaultStadiumId !== 255) {
    s = s.copy();
    s.JI = 255; // `JI` = defaultStadiumId (getter is read-only); `l()` checks `Oi()` = JI != 255
  }
  const w = nhWriter(4096);
  s.l(w); // Stadium serializer (official `w.G`)
  return written(w);
}

/** Parses .hbs text with node-haxball and returns the official binary form. */
export function hbsToStadiumBytes(hbs: string): Uint8Array {
  return stadiumToBytes({ hbs });
}

/** Parses an official binary stadium and returns `{ bytes (re-serialized), hbs (export), name }`. */
export function parseStadiumBytes(bytes: Uint8Array): { bytes: Uint8Array; hbs: string; name: string } {
  const s = nhStadium({ bytes });
  return { bytes: stadiumToBytes({ bytes }), hbs: Utils.exportStadium(s), name: s.name };
}

// ------------------------------------------------------------------- events

/** EventFactory function names (see node-haxball index.d.ts `EventFactory`). */
export type EventFactoryName =
  | 'checkConsistency' | 'sendAnnouncement' | 'sendChatIndicator' | 'sendInput' | 'sendChat'
  | 'joinRoom' | 'setHeadlessAvatar' | 'kickBanPlayer' | 'reorderPlayers' | 'startGame' | 'stopGame'
  | 'pauseResumeGame' | 'setScoreLimit' | 'setTimeLimit' | 'setStadium' | 'setPlayerTeam'
  | 'setTeamsLock' | 'setPlayerAdmin' | 'autoTeams' | 'setPlayerSync' | 'ping' | 'setAvatar'
  | 'setTeamColors' | 'setKickRateLimit' | 'setDiscProperties' | 'setPlayerDiscProperties';

/**
 * Builds a node-haxball event via EventFactory. Gotchas (node-haxball quirks):
 *  - sendChatIndicator(active) stores `active ? 0 : 1` (inverted!). Use {@link encodeEvent} with
 *    'sendChatIndicator' and pass the WIRE value negated, or build bytes yourself.
 *  - setStadium takes a node-haxball Stadium; pass a StadiumSpec, it is converted.
 *  - setTeamColors(teamId, {angle, text, inner}) — plain object accepted, converted.
 *  - setDiscProperties values are Math.fround-ed (official behaviour).
 */
export function makeEvent(name: EventFactoryName, ...args: Any[]): Any {
  if (name === 'setStadium') args = [nhStadium(args[0] as StadiumSpec)];
  if (name === 'setTeamColors' && args[1] && !(args[1] instanceof Impl.Core.TeamColors)) {
    const tc = new Impl.Core.TeamColors();
    tc.angle = args[1].angle ?? 0;
    tc.text = args[1].text ?? 0xffffff;
    tc.inner = [...(args[1].inner ?? [])];
    args = [args[0], tc];
  }
  if (name === 'checkConsistency' && args[0] instanceof Uint8Array) {
    args = [Uint8Array.from(args[0]).buffer];
  }
  const fn = EventFactory[name];
  if (typeof fn !== 'function') throw new Error(`unknown EventFactory.${name}`);
  const ev = fn(...args);
  if (!ev) throw new Error(`EventFactory.${name} returned nothing (bad args?)`);
  return ev;
}

/**
 * Official wire bytes of an event: `u8 type` + payload. Uses the event's
 * serializer `l(writer, true)`: the 2nd arg selects the OFFICIAL format
 * (false would append node-haxball-only extension fields to some events).
 */
export function encodeEventObject(ev: Any): Uint8Array {
  const w = nhWriter(256);
  w.writeUint8(ev.eventType);
  ev.l(w, true);
  return written(w);
}

/** `encodeEventObject(makeEvent(name, ...args))`. */
export function encodeEvent(name: EventFactoryName, ...args: Any[]): Uint8Array {
  return encodeEventObject(makeEvent(name, ...args));
}

/** Readable view of a decoded event: its eventType + all public getters. */
export interface DecodedEvent {
  type: number;
  fields: Record<string, unknown>;
  /** The node-haxball event object (apply it with OracleRoom.applyEventObject). */
  raw: Any;
  /** Bytes consumed. */
  length: number;
}

/** Decodes official event bytes (u8 type + payload) with node-haxball. */
export function decodeEvent(bytes: Uint8Array): DecodedEvent {
  const r = nhReader(bytes);
  const ev = EventFactory.createFromStream(r);
  return { type: ev.eventType, fields: publicFields(ev, ['eventType', 'byId']), raw: ev, length: r.offset };
}

function publicFields(obj: Any, skip: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let p = Object.getPrototypeOf(obj);
  while (p && p !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(p)) {
      if (n in out || skip.includes(n) || n === 'ext') continue;
      const d = Object.getOwnPropertyDescriptor(p, n);
      if (d?.get) out[n] = obj[n];
    }
    p = Object.getPrototypeOf(p);
  }
  return out;
}

// --------------------------------------------------------------------- room

export interface OraclePlayerSpec {
  id: number;
  name?: string;
  team?: 0 | 1 | 2;
  flag?: string | null;
  avatar?: string | null;
  admin?: boolean;
}

export interface OracleRoomOptions {
  stadium?: StadiumSpec;
  players?: OraclePlayerSpec[];
  /** Start the game after adding players (default false). */
  start?: boolean;
  scoreLimit?: number;
  timeLimit?: number;
  teamsLocked?: boolean;
  kickRate?: { min: number; rate: number; burst: number };
}

/** Plain-JSON disc dump (all serialized fields). */
export interface DiscDump {
  x: number; y: number; xspeed: number; yspeed: number; xgravity: number; ygravity: number;
  radius: number; bCoef: number; invMass: number; damping: number; color: number; cMask: number; cGroup: number;
}

export interface PlayerDump {
  id: number; name: string | null; team: number; isAdmin: boolean; avatar: string | null;
  headlessAvatar: string | null; flag: string | null; desync: boolean; input: number; isKicking: boolean;
  kickRateMaxTickCounter: number; kickRateMinTickCounter: number; avatarNumber: number; discIndex: number;
}

export interface GameDump {
  phase: number; goalTickCounter: number; redScore: number; blueScore: number; timeElapsed: number;
  pauseGameTickCounter: number; goalConcedingTeam: number; discs: DiscDump[];
}

export interface StateDump {
  frame: number; name: string | null; teamsLocked: boolean; scoreLimit: number; timeLimit: number;
  kickRate: { min: number; rate: number; max: number };
  stadium: { id: number; name: string };
  players: PlayerDump[];
  game: GameDump | null;
}

/** One scripted action for {@link OracleRoom.runTimeline}. Applied BEFORE stepping `frame`. */
export type TimelineEntry =
  | { frame: number; input: number; playerId: number }
  | { frame: number; event: Uint8Array; byId?: number }
  | { frame: number; run: (room: OracleRoom) => void };

/**
 * Offline room driven by node-haxball's `Room.sandbox`.
 *
 * Semantics (match the official frame loop `Ma.rg`): events applied while at
 * frame F are applied before the physics step that turns F into F+1, i.e.
 * exactly like an event scheduled with `frameNo = F`.
 *
 * GOTCHA found while building this: node-haxball's `runSteps(n)` /
 * `RoomState.nM(n)` is NOT "n ticks": it is ONE tick with dt = n (the World
 * integrates `pos += v*n`). `step(n)` here therefore loops `runSteps(1)`.
 */
export class OracleRoom {
  readonly sandbox: Any;
  /** Number of ticks stepped so far (our own counter; sandbox frame counter is real-time based). */
  frame = 0;

  private constructor(sandbox: Any) {
    this.sandbox = sandbox;
  }

  /** Empty sandbox room (state = official fresh RoomState: Classic, limits 3/3, no players). */
  static empty(): OracleRoom {
    // RAF stubs: the sandbox never advances on its own; we step manually.
    const sb = Room.sandbox({}, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
    sb.setSimulationSpeed(0); // speed 0 => runSteps() is honoured
    return new OracleRoom(sb);
  }

  static create(opts: OracleRoomOptions = {}): OracleRoom {
    const room = OracleRoom.empty();
    if (opts.stadium !== undefined) room.setStadium(opts.stadium);
    if (opts.scoreLimit !== undefined) room.setScoreLimit(opts.scoreLimit);
    if (opts.timeLimit !== undefined) room.setTimeLimit(opts.timeLimit);
    if (opts.teamsLocked !== undefined) room.setTeamsLock(opts.teamsLocked);
    if (opts.kickRate) room.setKickRateLimit(opts.kickRate.min, opts.kickRate.rate, opts.kickRate.burst);
    for (const p of opts.players ?? []) {
      room.join(p.id, p.name ?? `p${p.id}`, p.flag ?? null, p.avatar ?? null);
      if (p.admin) room.setAdmin(p.id, true);
      if (p.team) room.setTeam(p.id, p.team);
    }
    if (opts.start) room.startGame();
    return room;
  }

  /**
   * Builds a room whose state is deserialized from official RoomState bytes
   * (node-haxball `RoomState.o(reader)`, constructor reached via `state.oG.pE`).
   * Use it to load a state produced by OUR serializer and keep simulating in
   * the oracle (differential stepping from an arbitrary state).
   */
  static fromStateBytes(bytes: Uint8Array): OracleRoom {
    const room = OracleRoom.empty();
    const proto = room.sandbox.state;
    const st = new proto.oG.pE(proto.oG); // `oG` = API-internal namespace, `pE` = RoomState class
    st.o(nhReader(bytes)); // RoomState deserializer (official browser client counterpart)
    room.sandbox.useSnapshot(st); // copies `st` into the sandbox
    return room;
  }

  /** The live node-haxball RoomState (internal object). */
  get state(): Any {
    return this.sandbox.state;
  }

  // ------------------------------------------------------------- events

  /** Applies a node-haxball event object immediately (at the current frame). */
  applyEventObject(ev: Any, byId = 0): this {
    ev.G = byId; // `G` = byId field of every event (public setter `byId` exists too)
    this.sandbox.applyEvent(ev); // sandbox `u()`: filterEvents -> ev.T(state)
    return this;
  }

  /** Decodes official event bytes (u8 type + payload) and applies them as player `byId`. */
  applyEventBytes(bytes: Uint8Array, byId = 0): this {
    return this.applyEventObject(decodeEvent(bytes).raw, byId);
  }

  /** `makeEvent` + apply. */
  apply(name: EventFactoryName, byId: number, ...args: Any[]): this {
    return this.applyEventObject(makeEvent(name, ...args), byId);
  }

  join(id: number, name: string, flag: string | null = null, avatar: string | null = null, conn = `conn${id}`, auth: string | null = null): this {
    return this.apply('joinRoom', 0, id, name, flag, avatar, conn, auth);
  }
  /** Player leaves (KickBanPlayer with reason null, as the official host does). */
  leave(id: number): this {
    return this.apply('kickBanPlayer', 0, id, null, false);
  }
  kick(id: number, reason: string, ban = false, byId = 0): this {
    return this.apply('kickBanPlayer', byId, id, reason, ban);
  }
  /** Sets player `id`'s input mask (SendInput by that player). Kick = bit 16 rising edge. */
  input(id: number, mask: number): this {
    return this.apply('sendInput', id, mask);
  }
  chat(id: number, text: string): this {
    return this.apply('sendChat', id, text);
  }
  announce(text: string, color = -1, style = 0, sound = 1): this {
    return this.apply('sendAnnouncement', 0, text, color, style, sound);
  }
  setTeam(playerId: number, team: 0 | 1 | 2, byId = 0): this {
    return this.apply('setPlayerTeam', byId, playerId, team);
  }
  setAdmin(playerId: number, value: boolean, byId = 0): this {
    return this.apply('setPlayerAdmin', byId, playerId, value);
  }
  startGame(byId = 0): this {
    return this.apply('startGame', byId);
  }
  stopGame(byId = 0): this {
    return this.apply('stopGame', byId);
  }
  pause(paused: boolean, byId = 0): this {
    return this.apply('pauseResumeGame', byId, paused);
  }
  setScoreLimit(v: number, byId = 0): this {
    return this.apply('setScoreLimit', byId, v);
  }
  setTimeLimit(v: number, byId = 0): this {
    return this.apply('setTimeLimit', byId, v);
  }
  setTeamsLock(v: boolean, byId = 0): this {
    return this.apply('setTeamsLock', byId, v);
  }
  setKickRateLimit(min: number, rate: number, burst: number, byId = 0): this {
    return this.apply('setKickRateLimit', byId, min, rate, burst);
  }
  setStadium(spec: StadiumSpec, byId = 0): this {
    return this.apply('setStadium', byId, spec);
  }
  setAvatar(playerId: number, avatar: string | null): this {
    return this.apply('setAvatar', playerId, avatar);
  }
  setHeadlessAvatar(playerId: number, avatar: string | null): this {
    return this.apply('setHeadlessAvatar', 0, playerId, avatar);
  }
  setTeamColors(team: 1 | 2, colors: { angle?: number; text?: number; inner?: number[] }, byId = 0): this {
    return this.apply('setTeamColors', byId, team, colors);
  }
  reorderPlayers(ids: number[], moveToTop: boolean): this {
    return this.apply('reorderPlayers', 0, ids, moveToTop);
  }
  autoTeams(byId = 0): this {
    return this.apply('autoTeams', byId);
  }
  setPlayerSync(playerId: number, desync: boolean): this {
    return this.apply('setPlayerSync', playerId, desync);
  }
  /** Host-only SetDiscProperties on world disc `index` (HBInit names: x, y, xspeed, …, bCoeff, cMask…). */
  setDiscProperties(index: number, props: Record<string, number>): this {
    return this.apply('setDiscProperties', 0, index, props);
  }
  setPlayerDiscProperties(playerId: number, props: Record<string, number>): this {
    return this.apply('setPlayerDiscProperties', 0, playerId, props);
  }

  // -------------------------------------------------------------- stepping

  /** Advances `n` ticks (each = official `RoomState.Da(1)`). */
  step(n = 1): this {
    for (let i = 0; i < n; i++) {
      this.sandbox.runSteps(1);
      this.frame++;
    }
    return this;
  }

  /** Steps until `frame === untilFrame`, applying timeline entries when their frame is reached. */
  runTimeline(timeline: readonly TimelineEntry[], untilFrame: number): this {
    const sorted = [...timeline].sort((a, b) => a.frame - b.frame);
    let i = 0;
    while (this.frame < untilFrame || (i < sorted.length && sorted[i]!.frame === this.frame)) {
      while (i < sorted.length && sorted[i]!.frame <= this.frame) {
        const e = sorted[i++]!;
        if ('input' in e) this.input(e.playerId, e.input);
        else if ('event' in e) this.applyEventBytes(e.event, e.byId ?? 0);
        else e.run(this);
      }
      if (this.frame >= untilFrame) break;
      this.step(1);
    }
    return this;
  }

  // -------------------------------------------------------------- extraction

  /** Official RoomState bytes (`Ta.G` / node `RoomState.l(writer)`): what snapshots & checksums use. */
  stateBytes(): Uint8Array {
    const w = nhWriter(4096);
    this.state.l(w);
    return written(w);
  }

  /** Official consistency hash (int32) computed by node-haxball (`RoomState.r1()`). */
  checksum(): number {
    return this.state.r1() | 0;
  }

  /** sha256 of {@link stateBytes}. */
  hash(): string {
    return sha256(this.stateBytes());
  }

  /** Dynamic discs of the running game (empty if no game). */
  discs(): DiscDump[] {
    const gs = this.sandbox.gameState;
    if (!gs) return [];
    return gs.physicsState.discs.map(dumpDisc);
  }

  /** Readable JSON dump of the full room state (same information as the bytes). */
  dump(): StateDump {
    const st = this.state;
    const gs = this.sandbox.gameState;
    const discs: Any[] = gs ? gs.physicsState.discs : [];
    return {
      frame: this.frame,
      name: st.name,
      teamsLocked: !!st.teamsLocked,
      scoreLimit: st.scoreLimit,
      timeLimit: st.timeLimit,
      kickRate: { min: st.kickRate_min, rate: st.kickRate_rate, max: st.kickRate_max },
      stadium: { id: st.stadium.defaultStadiumId, name: st.stadium.name },
      players: st.players.map((p: Any) => ({
        id: p.id,
        name: p.name,
        team: p.team.id,
        isAdmin: !!p.isAdmin,
        avatar: p.avatar,
        headlessAvatar: p.headlessAvatar,
        flag: p.flag,
        desync: !!p.sync,
        input: p.input,
        isKicking: !!p.isKicking,
        kickRateMaxTickCounter: p.kickRateMaxTickCounter,
        kickRateMinTickCounter: p.kickRateMinTickCounter,
        avatarNumber: p.avatarNumber,
        discIndex: p.disc ? discs.indexOf(p.disc) : -1,
      })),
      game: gs
        ? {
            phase: gs.state,
            goalTickCounter: gs.goalTickCounter,
            redScore: gs.redScore,
            blueScore: gs.blueScore,
            timeElapsed: gs.timeElapsed,
            pauseGameTickCounter: gs.pauseGameTickCounter,
            goalConcedingTeam: gs.goalConcedingTeam.id,
            discs: discs.map(dumpDisc),
          }
        : null,
    };
  }

  /** Deep copy of the current state (node-haxball `takeSnapshot`). */
  snapshot(): Any {
    return this.sandbox.takeSnapshot();
  }

  /** Restores a snapshot from {@link snapshot}. Does not change `frame`. */
  restore(snap: Any): this {
    this.sandbox.useSnapshot(snap);
    return this;
  }
}

function dumpDisc(d: Any): DiscDump {
  return {
    x: d.pos.x,
    y: d.pos.y,
    xspeed: d.speed.x,
    yspeed: d.speed.y,
    xgravity: d.gravity.x,
    ygravity: d.gravity.y,
    radius: d.radius,
    bCoef: d.bCoef,
    invMass: d.invMass,
    damping: d.damping,
    color: d.color,
    cMask: d.cMask,
    cGroup: d.cGroup,
  };
}
