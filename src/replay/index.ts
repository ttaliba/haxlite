/**
 * src/replay — `.hbr2` replays (format version 3, docs/02 §6).
 *
 *   ReplayRecorder   start(rs, frame[, clock]) / onEvent(ev, frame) / onGoalMarker(team, frame) / stop(frame)
 *                    -> official `.hbr2` bytes (HBInit startRecording/stopRecording)
 *   readReplay       .hbr2 -> ReplayData {version, totalFrames, goalMarkers, stateBytes, events}
 *   writeReplay      ReplayData -> .hbr2
 *   ReplayPlayer     deterministic re-simulation with seek (src/room stepRoom + event apply)
 *
 * Host integration contract: see src/replay/README.md.
 */
export * from './format.js';
export * from './recorder.js';
export * from './reader.js';
export * from './player.js';
