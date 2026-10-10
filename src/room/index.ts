/**
 * src/room — RoomState, Player, GameState rules, events, state serialization,
 * checksum (OWNER: engineer B).
 *
 * Contract other modules rely on (owner may refine):
 *   writeRoomState(w, rs)        official `Ta.G` (exact bytes; verified vs oracle)
 *   readRoomState(r)             inverse (official browser client)
 *   roomStateChecksum(rs, w)     xorInt32Words(writeRoomState) — official `Ta.Ve`
 *   stepRoom(rs)                 one 1/60 s tick: official `Ta.Da(1)` -> `Q.Da(1)`
 *   events: encode/decode/apply for EventType 0..23 (src/protocol.ts)
 */
import type { Reader, Writer } from '../codec/index.js';
import type { RoomState } from './types.js';

export * from './types.js';

const notImplemented = (what: string): never => {
  throw new Error(`not implemented: room.${what}`);
};

export function writeRoomState(_w: Writer, _rs: RoomState): void {
  notImplemented('writeRoomState');
}
export function readRoomState(_r: Reader): RoomState {
  return notImplemented('readRoomState');
}
export function roomStateChecksum(_rs: RoomState, _scratch?: Writer): number {
  return notImplemented('roomStateChecksum');
}
export function stepRoom(_rs: RoomState): void {
  notImplemented('stepRoom');
}
