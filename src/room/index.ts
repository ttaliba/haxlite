/**
 * src/room — RoomState, Player, GameState rules, events, state serialization,
 * checksum (OWNER: engineer B).
 *
 *   createRoomState(stadium?)    fresh room with official defaults (Classic, 3/3, kick rate 2/0/1)
 *   writeRoomState(w, rs)        official `Ta.G` (exact bytes; verified vs oracle)
 *   readRoomState(r)             inverse (official browser client)
 *   roomStateChecksum(rs, w?)    xor of int32 words of writeRoomState — official `Ta.Ve`
 *   stepRoom(rs)                 one 1/60 s tick: official `Ta.Da(1)` -> `Q.Da(1)`
 *   events: RoomEvent subclasses for EventType 0..23 with write/read/apply,
 *           writeEvent/readEvent (u8 type + payload), writeEventFrame/readEventFrame
 *           (host broadcast header), EVENT_META (delay/predictable/rateLimit/sender),
 *           checkClientSender (official `tb`).
 *   hooks: rs.hooks (RoomHooks) callback slots, null by default.
 */
export * from './types.js';
export * from './state.js';
export * from './rules.js';
export * from './events.js';
