# src/replay — `.hbr2` replays (format v3)

Owner: engineer R. Depends on `codec`, `room` (and `sim` through `room`); never on `host`/`net`.

| Export | Purpose |
|---|---|
| `ReplayRecorder` | HBInit `startRecording()` / `stopRecording()` → official `.hbr2` bytes; the event log is capped (`maxBytes`, `maxEvents`) and the recording freezes at the cap |
| `readReplay(bytes, opts?)` → `ReplayData` | header, goal markers, initial RoomState bytes, events (absolute frames); capped by `ReplayReadOptions` (`maxBodyBytes`, `maxEvents`) |
| `writeReplay(data)` | `ReplayData` → `.hbr2` (after editing/trimming) |
| `ReplayPlayer` | deterministic re-simulation: `seek(frame)`, `step(n)`, `finish()`, and `seekAsync` / `finishAsync` that yield to the event loop; `ReplayPlayerOptions` = read caps + `maxSeekMs` (default 60 s) + `maxFrames` |
| `replayBody(bytes, maxBodyBytes?)`, `readReplayHeader` | tooling/tests: inflated body (same cap as `readReplay`), header only |
| `ReplayFormatError`, `ReplayVersionError` | malformed file / version ≠ 3 |

## Limits (hostile files and long matches)

| Constant / option | Default | Applies to |
|---|---|---|
| `REPLAY_MAX_BODY_BYTES` / `maxBodyBytes` | 32 MiB (33 554 432) | inflated body of `readReplay`, `replayBody` and `new ReplayPlayer(bytes)`; over it: `ReplayFormatError` `replay body larger than maxBodyBytes (N)` |
| `REPLAY_MAX_EVENTS` / `maxEvents` | 2^21 (2 097 152) | events `readReplay` decodes (`ReplayFormatError` `too many events (more than maxEvents = N)`) and events a `ReplayRecorder` holds |
| `REPLAY_RECORD_MAX_BYTES` / `ReplayRecorder.maxBytes` | 16 MiB (16 777 216) | event log of a recording (initial state plus events) |
| `REPLAY_PLAYER_MAX_FRAMES` / `ReplayPlayer.maxFrames` | 2^24 (16 777 216, about 77 h at 60 Hz) | most ticks one `seek` / `finish` call simulates (the target minus the current frame, or the target when it rewinds); applied when the call's budget is `REPLAY_PLAYER_MAX_SEEK_MS` or longer |
| `REPLAY_PLAYER_MAX_SEEK_MS` / `ReplayPlayer.maxSeekMs` / `seek(n, { maxMs })` | 60 000 ms (`Infinity` = no budget) | time budget of one synchronous `seek` / `finish` call; not applied to `seekAsync` / `finishAsync` |
| `sliceMs` of `seekAsync` / `finishAsync` | 8 ms | longest stretch simulated before yielding |

`Infinity` removes a cap; for the read and recorder caps an invalid value (negative, `NaN`) gives the default. The recorder caps are chosen so that a recording made with the defaults reads back with the default read caps. All of these are exported from the `replay` namespace.

## File layout (inflated body verified byte-for-byte against the official recorder)

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
`stop()` / `snapshot()` deflate at level 1 on Node (2 on Bun) when the body is over 64 KiB (`SYNC_FAST_BODY`; about 3 % larger files, a 10 to 100 times shorter stall) and at level 6 below it; `stopAsync()` / `snapshotAsync()` always use level 6, so above that size the compressed bytes of the two differ while the inflated body is the same.

## Integration contract for the host (`src/host`) / HBInit facade

Terminology: **`frame`** = the host's absolute logical frame counter (official `Ma.da`): the
index of the tick being processed. Events scheduled for frame F are applied while
`frame === F`, then `stepRoom(rs)` runs (still `frame === F`), then `frame++`.
This is exactly the official `Ma.rg` loop (`apply → Ab(ev)` … `Ca.Da(1)`, `da++`).

1. **One recorder per room**, created once and reused (keeps its buffers while they
   stay at their initial size; a long recording's event log is released at stop):
   `readonly recorder = new ReplayRecorder();`
   The log is capped: `new ReplayRecorder(version, { maxBytes, maxEvents })` or the `maxBytes` / `maxEvents` properties (defaults 16 MiB and 2^21, `Infinity` = none). At the cap the recording **freezes**: later events and goals are not recorded, the file ends at the frame of the first event left out, `recorder.truncated` is true and `onTruncated(frame)` is called once (from inside `onEvent`). `HostRoom` reports it once per recording through `onError` and exposes `recordingTruncated`; from HBInit use `room.haxlite.host.recorder.maxBytes` / `.maxEvents` and `room.haxlite.recordingTruncated`. Below the cap the bytes are unchanged.

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
   `recorder.stopAsync(frame)` / `snapshotAsync(frame)` return the same inflated body but
   deflate on the libuv threadpool at level 6 (a 7.6 MB body: ~270 ms of event loop at level 6 -> ~3 ms);
   recording stops synchronously. `HostRoom.stopRecordingAsync()` and the HBInit
   `room.stopRecordingAsync()` (a haxlite extension: the official API only has the
   synchronous `stopRecording`) expose it.

6. Room teardown: `recorder.cancel()` (restores the goal hook; no output).

### Replaying

`new ReplayPlayer(bytes).seek(n)` gives the state after `n` ticks, with the events of frames
`< n` applied (what the official player shows). `finish()` also applies the events stamped
with the final frame, i.e. the exact state the host had when it called `stop`.
Seeking backwards re-decodes the initial state and re-simulates (no intermediate snapshots
exist in the format). `player.onReset = (rs) => { rs.hooks.… = … }` installs callbacks
that fire during re-simulation; `player.onEvent` is called after each replayed event.

Re-simulating costs real time, set by the file's stadium and players rather than by its size: a file of a few hundred bytes can claim 2^24 ticks of a 255-disc stadium (over an hour of CPU, per the comment in `player.ts`). `seek(n)` and `finish()` run to the target unless (a) the call would simulate more than `maxFrames` ticks (the target minus the current frame, or the target itself when it rewinds) and its budget is `REPLAY_PLAYER_MAX_SEEK_MS` or longer (the default, or `Infinity`): `RangeError` at once, `replay seek beyond maxFrames (N ticks to simulate > M); use seekAsync or a higher maxFrames`; or (b) the time budget runs out (`maxSeekMs`, default `REPLAY_PLAYER_MAX_SEEK_MS` = 60 000 ms; per call `seek(n, { maxMs })` / `finish({ maxMs })`; `Infinity` for files you trust): `RangeError` `replay seek budget exceeded (F/T frames)`, with the player at a consistent frame after at least one chunk of ticks, and the next call continues from there. A shorter explicit budget is incremental seeking: it runs until the budget whatever the target, and `maxFrames` does not apply. The default budget bounds what an untrusted file can block, not legitimate replays (the comment in `player.ts` gives about 20 s for 20 minutes on a 254-disc stadium), but a hostile file can still block the thread for up to about 60 s per synchronous call. `seekAsync(n, { sliceMs = 8, signal })` and `finishAsync({ sliceMs, signal })` simulate in slices and yield to the event loop in between, but have **no time budget and no `maxFrames`**: they stop only when `signal` aborts (the promise rejects with `signal.reason` and the player stays where it got to). For a file you do not trust, always pass `signal: AbortSignal.timeout(ms)` (or lower `maxSeekMs` / `maxMs` on the synchronous API); without it a file of a few hundred bytes keeps a CPU busy for as long as it claims. Do not use the player until the promise settles. `new ReplayPlayer(bytes, opts)` also takes the read caps (`maxBodyBytes`, `maxEvents`). A SetStadium that decodes but that our deflate cannot fit in the u16 length no longer fails the read: `SetStadiumEvent.read` accepts it and `wireError()` reports it.

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
