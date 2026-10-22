/**
 * src/replay — `.hbr2` replays (format version 3, docs/02 §6).
 *
 *   ReplayRecorder   start(rs, frame[, clock]) / onEvent(ev, frame) / onGoalMarker(team, frame) / stop(frame)
 *                    -> official `.hbr2` bytes (HBInit startRecording/stopRecording);
 *                    the event log is capped (`maxBytes`, `maxEvents`), the recording freezes at the cap
 *   readReplay       .hbr2 -> ReplayData {version, totalFrames, goalMarkers, stateBytes, events};
 *                    inflated size and event count are capped (`ReplayReadOptions`)
 *   writeReplay      ReplayData -> .hbr2
 *   ReplayPlayer     deterministic re-simulation with seek (src/room stepRoom + event apply);
 *                    seek/finish refuse more than `maxFrames` ticks per call and stop at a time
 *                    budget (`maxSeekMs`, 60 s by default); seekAsync/finishAsync yield to the
 *                    event loop and stop only on their `signal`
 *
 * Host integration contract: see src/replay/README.md.
 */
export * from './format.js';
export * from './recorder.js';
export * from './reader.js';
export * from './player.js';
