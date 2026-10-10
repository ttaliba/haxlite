/**
 * Shared model contract (single import point). Data only: classes with fields
 * in official wire order + defaults. Behaviour lives in the owning modules:
 *  - src/sim  (engineer A): physics step, stadium parse/serialize, default stadiums
 *  - src/room (engineer B): rules, events, RoomState/Player/GameState codecs, checksum
 */
export * from './sim/types.js';
export * from './room/types.js';
export * from './protocol.js';
