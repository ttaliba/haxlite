# src/replay — `.hbr2` replays (format v3)

Owner: engineer R. Depends on `codec`, `room` (and `sim` through `room`); never on `host`/`net`.

| Export | Purpose |
|---|---|
| `ReplayRecorder` | HBInit `startRecording()` / `stopRecording()` → official `.hbr2` bytes |
| `readReplay(bytes)` → `ReplayData` | header, goal markers, initial RoomState bytes, events (absolute frames) |
| `writeReplay(data)` | `ReplayData` → `.hbr2` (after editing/trimming) |
| `ReplayPlayer` | deterministic re-simulation: `seek(frame)`, `step(n)`, `finish()` |
| `replayBody`, `readReplayHeader` | tooling/tests: inflated body, header only |
| `ReplayFormatError`, `ReplayVersionError` | malformed file / version ≠ 3 |

## File layout (verified byte-for-byte against the official recorder)

```
"HBR2"  u32 version=3  u32 totalFrames (frameAtStop − frameAtStart)
deflateRaw(
  u16 goalMarkerCount, { varuint Δframe, u8 goalOwnerTeam }*      (Δ from previous marker; first from start)
  RoomState (writeRoomState, at start)
  { varuint Δframe, u16 byId, u8 type, payload }*                 (Δ from previous event; first from start)
)
```

All big-endian. The two Δ chains are independent. Replays carry no `order`/`clientSeq`.
Compressed bytes come from `node:zlib` and may differ from the official pako output; the
inflated body is identical (no hash covers compressed bytes; every reader inflates).

## Integration contract for the host (`src/host`) / HBInit facade

Terminology: **`frame`** = the host's absolute logical frame counter (official `Ma.da`): the
index of the tick being processed. Events scheduled for frame F are applied while
`frame === F`, then `stepRoom(rs)` runs (still `frame === F`), then `frame++`.
This is exactly the official `Ma.rg` loop (`apply → Ab(ev)` … `Ca.Da(1)`, `da++`).

1. **One recorder per room**, created once and reused (keeps its buffers):
   `readonly recorder = new ReplayRecorder();`

2. **`startRecording()`** (HBInit, returns nothing):
   ```ts
   this.recorder.start(this.rs, this.frame, this); // `this` exposes `get frame(): number`
   ```
   Snapshots the RoomState as it is now and takes over `rs.hooks.onGoalMarker`
   (chaining whatever was there, restoring it at stop). Calling it again while
   recording restarts the recording, like the official one. Do not reassign
   `rs.hooks.onGoalMarker` while recording; if the host prefers to own that slot, pass no
   clock (`start(rs, frame)`) and call `recorder.onGoalMarker(goalOwner, this.frame)` from
   its own hook instead (goalOwner = the hook's argument, the team that owns the goal).

3. **After EVERY event applied to the room state**, in application order, call
   ```ts
   ev.apply(rs);
   this.recorder.onEvent(ev, this.frame);   // ev.byId must be the issuer (0 = host)
   ```
   This covers both official apply paths: the per-frame queue drain (`Ma.rg`) and the
   immediate apply of an event that arrives for the current frame (`Ma.Cf`). Record
   **all** applied events, including host-generated `Ping`,
   `SetPlayerSync`, chat indicators, inputs, and events whose `apply` turns out to be a
   no-op (rejected admin action). Do **not** record events that never reach `apply`
   (dropped by `checkClientSender`/`validate`/rate limits), nor `CheckConsistency`:
   the official host only broadcasts it and never applies it, so the official recorder
   never sees it. Call it after `apply`
   because the official recorder serializes the event object after applying it.
   When not recording, `onEvent` is a single boolean test; the host may also skip the
   call with `if (recorder.isRecording)`.

4. **Each frame**: nothing to call. The total frame count is derived from the frame
   given to `start` and `stop`; goal frames come from the clock passed to `start`
   (read during `stepRoom`, i.e. the frame being ticked).

5. **`stopRecording()`** (HBInit, returns `Uint8Array | null`):
   ```ts
   return this.recorder.isRecording ? this.recorder.stop(this.frame) : null;
   ```
   The returned array is a fresh copy owned by the caller. `recorder.snapshot(frame)`
   returns the same file without stopping (autosave); `recorder.cancel()` drops it.

6. Room teardown: `recorder.cancel()` (restores the goal hook; no output).

### Replaying

`new ReplayPlayer(bytes).seek(n)` gives the state after `n` ticks, with the events of frames
`< n` applied (what the official player shows). `finish()` also applies the events stamped
with the final frame, i.e. the exact state the host had when it called `stop`.
Seeking backwards re-decodes the initial state and re-simulates (no intermediate snapshots
exist in the format). `player.onReset = (rs) => { rs.hooks.… = … }` installs callbacks
that fire during re-simulation; `player.onEvent` is called after each replayed event.

## Tests (`test/replay/`)

* `replay.test.ts` drives a randomized 12 000-frame game (inputs + kicks, goals, joins,
  kicks/bans, start/stop/pause, stadium changes, admin events, SetDiscProperties…)
  with identical event bytes through our room + `ReplayRecorder` and through the
  OFFICIAL headless RoomState + the OFFICIAL recorder (`cb`), then checks:
  (b) header and inflated body are byte-identical to the official recorder's;
  (a) node-haxball `Replay.readAll` and its replay player, and the official browser
  client player (`$b` from game-min.js, if `HAXBALL_CLIENT_JS` or the scratch copy exists;
  skipped otherwise), read our file and re-simulate to the same states;
  (c) our `ReplayPlayer` reproduces every 500-frame checkpoint (forward and after rewind)
  and the final state.
* `official-replay.ts`: test-only loaders for the official recorder and client player.
* `HAXLITE_REPLAY_FRAMES` overrides the scenario length.
