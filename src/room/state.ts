/**
 * RoomState / GameState / Player / TeamColors binary codecs and the
 * consistency checksum. Layouts = official `Ta.G`, `Q.G`, `Ka.S`, `W.G`
 * (writers) and the browser client's readers (mirrored by node-haxball).
 */
import { Reader, Writer } from '../codec/index.js';
import type { Disc } from '../sim/types.js';
import { attachStadium, readStadium, readWorld, writeStadium, writeWorld } from '../sim/index.js';
import { CodecError } from '../codec/index.js';
import { GamePhase, TeamId } from '../protocol.js';
import { GameState, Player, RoomState, TeamColors } from './types.js';

/** Maps a serialized team byte to a TeamId (unknown values -> spectators, like the official readers). */
export function toTeamId(v: number): TeamId {
  return v === 1 ? TeamId.Red : v === 2 ? TeamId.Blue : TeamId.Spectators;
}

// --------------------------------------------------------------- TeamColors

/** official `W.G`: u8 angle, i32 text, u8 n, n × i32. */
export function writeTeamColors(w: Writer, tc: TeamColors): void {
  w.u8(tc.angle);
  w.i32(tc.textColor);
  const colors = tc.colors;
  w.u8(colors.length);
  for (let i = 0; i < colors.length; i++) w.i32(colors[i]!);
}

/** official `W.qa`: throws "too many" for more than 3 colours. */
export function readTeamColors(r: Reader, out: TeamColors = new TeamColors()): TeamColors {
  out.angle = r.u8();
  out.textColor = r.i32();
  const n = r.u8();
  if (n > 3) throw new CodecError('too many');
  out.colors = [];
  for (let i = 0; i < n; i++) out.colors.push(r.i32());
  return out;
}

// ------------------------------------------------------------------- Player

/** official `Ka.S`. `player.disc.index` must be current (assigned by the World writer). */
export function writePlayer(w: Writer, p: Player): void {
  w.u8(p.isAdmin ? 1 : 0);
  w.i32(p.avatarNumber);
  w.nullableString(p.avatar);
  w.nullableString(p.headlessAvatar);
  w.u8(p.desync ? 1 : 0);
  w.nullableString(p.flag);
  w.i32(p.reservedI32);
  w.nullableString(p.name);
  w.i32(p.input);
  w.varUint(p.id);
  w.u8(p.isKicking ? 1 : 0);
  w.i16(p.kickRateMaxTickCounter);
  w.u8(p.kickRateMinTickCounter);
  w.u8(p.team);
  w.i16(p.disc === null ? -1 : p.disc.index);
}

/** Inverse of {@link writePlayer}; the disc index is resolved against `discs`. */
export function readPlayer(r: Reader, discs: readonly Disc[] | null): Player {
  const p = new Player();
  p.isAdmin = r.u8() !== 0;
  p.avatarNumber = r.i32();
  p.avatar = r.nullableString();
  p.headlessAvatar = r.nullableString();
  p.desync = r.u8() !== 0;
  p.flag = r.nullableString();
  p.reservedI32 = r.i32();
  p.name = r.nullableString();
  p.input = r.i32();
  p.id = r.varUint();
  p.isKicking = r.u8() !== 0;
  p.kickRateMaxTickCounter = r.i16();
  p.kickRateMinTickCounter = r.u8();
  p.team = toTeamId(r.u8());
  const di = r.i16();
  p.disc = discs !== null && di >= 0 && di < discs.length ? discs[di]! : null;
  return p;
}

// --------------------------------------------------------------- GameState

/** official `Q.G`. */
export function writeGameState(w: Writer, gs: GameState): void {
  writeWorld(w, gs.world);
  w.i32(gs.goalTickCounter);
  w.i32(gs.phase);
  w.i32(gs.redScore);
  w.i32(gs.blueScore);
  w.f64(gs.timeElapsed);
  w.i32(gs.pauseGameTickCounter);
  w.u8(gs.goalConcedingTeam);
}

/** Inverse of {@link writeGameState}; limits and stadium come from the room (as the client does). */
export function readGameState(r: Reader, rs: RoomState): GameState {
  const gs = new GameState();
  readWorld(r, gs.world);
  gs.goalTickCounter = r.i32();
  gs.phase = r.i32() as GamePhase;
  gs.redScore = r.i32();
  gs.blueScore = r.i32();
  gs.timeElapsed = r.f64();
  gs.pauseGameTickCounter = r.i32();
  gs.goalConcedingTeam = toTeamId(r.u8());
  gs.scoreLimit = rs.scoreLimit;
  gs.timeLimit = rs.timeLimit;
  const stadium = rs.stadium!;
  gs.stadium = stadium;
  attachStadium(gs.world, stadium);
  return gs;
}

// --------------------------------------------------------------- RoomState

/** official `Ta.G`: the snapshot / checksum layout. */
export function writeRoomState(w: Writer, rs: RoomState): void {
  w.nullableString(rs.name);
  w.u8(rs.teamsLocked ? 1 : 0);
  w.i32(rs.scoreLimit);
  w.i32(rs.timeLimit);
  w.i16(rs.kickRateMax);
  w.u8(rs.kickRateRate);
  w.u8(rs.kickRateMin);
  writeStadium(w, rs.stadium!);
  const gs = rs.gameState;
  w.u8(gs !== null ? 1 : 0);
  if (gs !== null) writeGameState(w, gs);
  const players = rs.players;
  w.u8(players.length);
  for (let i = 0; i < players.length; i++) writePlayer(w, players[i]!);
  writeTeamColors(w, rs.redColors);
  writeTeamColors(w, rs.blueColors);
}

/** Reads an official RoomState (as the browser client does when joining). */
export function readRoomState(r: Reader): RoomState {
  const rs = new RoomState();
  rs.name = r.nullableString();
  rs.teamsLocked = r.u8() !== 0;
  rs.scoreLimit = r.i32();
  rs.timeLimit = r.i32();
  rs.kickRateMax = r.i16();
  rs.kickRateRate = r.u8();
  rs.kickRateMin = r.u8();
  rs.stadium = readStadium(r);
  rs.gameState = r.u8() !== 0 ? readGameState(r, rs) : null;
  const discs = rs.gameState !== null ? rs.gameState.world.discs : null;
  const n = r.u8();
  for (let i = 0; i < n; i++) rs.players.push(readPlayer(r, discs));
  readTeamColors(r, rs.redColors);
  readTeamColors(r, rs.blueColors);
  return rs;
}

// ------------------------------------------------------------------ checksum

const checksumWriter = new Writer(4096);
/** Full-capacity view of the last scratch writer's buffer (re-taken only when the buffer grows). */
let viewWriter: Writer | null = null;
let viewCapacity = -1;
let fullView: Uint8Array = new Uint8Array(0);

/**
 * Consistency hash (official `Ta.Ve`): XOR of every complete big-endian
 * int32 word of the serialized RoomState. Allocation-free once the scratch
 * writer (module-level by default) has grown to the state size.
 */
export function roomStateChecksum(rs: RoomState, scratch: Writer = checksumWriter): number {
  scratch.reset();
  writeRoomState(scratch, rs);
  const len = scratch.pos;
  if (scratch !== viewWriter || scratch.capacity !== viewCapacity) {
    // finish() returns a fresh subarray; take one spanning the whole buffer and reuse it.
    scratch.pos = scratch.capacity;
    fullView = scratch.finish();
    scratch.pos = len;
    viewWriter = scratch;
    viewCapacity = scratch.capacity;
  }
  const b = fullView;
  const end = len - 4;
  let h = 0;
  for (let p = 0; p <= end; p += 4) h ^= (b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!;
  return h;
}

/** 4-byte big-endian checksum, the CheckConsistency payload (official `Ta.Qg`). */
export function roomStateChecksumBytes(rs: RoomState): Uint8Array {
  const h = roomStateChecksum(rs);
  return new Uint8Array([(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255]);
}
