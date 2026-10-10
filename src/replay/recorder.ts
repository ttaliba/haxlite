/**
 * Replay recorder: produces the official `.hbr2` (version 3) byte layout.
 *
 * Clean-room equivalent of the official headless recorder (off `cb`, built by
 * `startRecording()`, finished by `stopRecording()`). Behaviour reproduced:
 *
 *  - at start, the whole RoomState is serialized into the event stream buffer
 *    (`writeRoomState`, the same layout as the join snapshot / checksum);
 *  - every event applied to the room afterwards is appended as
 *    `varuint (frame − previousEventFrame), u16 byId, u8 type, payload`. The
 *    payload is written AFTER the event has been applied (official hook
 *    `Ab`, fired right after `event.apply(roomState)`), whatever the outcome
 *    of `apply` (rejected admin actions are recorded too);
 *  - goal markers (RoomState hook off `zf`, our `rs.hooks.onGoalMarker`) are
 *    kept in a separate buffer as `varuint (frame − previousMarkerFrame),
 *    u8 goalOwnerTeam`, preceded by a u16 count patched at stop;
 *  - stop: `markers ++ events` is raw-deflated and prefixed with
 *    `"HBR2", u32 3, u32 (frameAtStop − frameAtStart)`.
 *
 * Frames are the host's absolute logical frame counter (official `da`): the
 * index of the tick currently being processed, i.e. events applied before
 * `stepRoom` of frame F, and goals detected during that `stepRoom`, both
 * carry frame F; the counter is incremented after the step.
 *
 * Cost: when not recording every entry point is a single boolean test. While
 * recording, an event costs a few buffer writes into a long-lived Writer
 * (amortized zero allocations; buffers are kept and reused by the next
 * recording). Only `stop()`/`snapshot()` allocate (deflate + output array).
 */
import { Writer, deflateRaw } from '../codec/index.js';
import type { TeamId } from '../protocol.js';
import type { RoomEvent, RoomState } from '../room/index.js';
import { writeEvent, writeRoomState } from '../room/index.js';
import { REPLAY_HEADER_SIZE, REPLAY_MAGIC, REPLAY_VERSION } from './format.js';

/** Anything exposing the host's current logical frame (e.g. the host engine itself). */
export interface FrameClock {
  readonly frame: number;
}

export class ReplayRecorder {
  /** u16 goal marker count (patched at stop) + markers. off `Jb` (initial capacity 1000). */
  private readonly markers = new Writer(1000);
  /** RoomState at start + event records. off `yc` (initial capacity 16384). */
  private readonly events = new Writer(16384);

  private active = false;
  private startFrame = 0;
  private lastEventFrame = 0;
  private lastMarkerFrame = 0;
  private markerCount = 0;
  private eventCount = 0;

  /** Room whose goal hook we installed (null when the host forwards goals itself). */
  private hookedRoom: RoomState | null = null;
  private clock: FrameClock | null = null;
  /** Hook that was in `rs.hooks.onGoalMarker` before {@link start}; chained and restored at stop. */
  private previousGoalHook: ((goalOwner: TeamId) => void) | null = null;
  /** Created once; installed into `rs.hooks.onGoalMarker` while recording with a clock. */
  private readonly goalHook = (goalOwner: TeamId): void => {
    this.onGoalMarker(goalOwner, this.clock!.frame);
    const prev = this.previousGoalHook;
    if (prev !== null) prev(goalOwner);
  };

  /** Format version written in the header (official recorder is built with 3). */
  constructor(readonly version: number = REPLAY_VERSION) {}

  /** True between {@link start} and {@link stop}. */
  get isRecording(): boolean {
    return this.active;
  }

  /** Frame passed to {@link start} of the current/last recording. */
  get firstFrame(): number {
    return this.startFrame;
  }

  /** Events recorded so far in the current/last recording. */
  get recordedEvents(): number {
    return this.eventCount;
  }

  /** Goal markers recorded so far in the current/last recording. */
  get recordedGoalMarkers(): number {
    return this.markerCount;
  }

  /** Uncompressed body size so far (markers + state + events), in bytes. */
  get bodyLength(): number {
    return this.markers.pos + this.events.pos;
  }

  /**
   * Starts recording: snapshots `rs` (as it is right now, i.e. after every
   * event already applied at `frame`) and remembers `frame` as frame 0 of the
   * replay.
   *
   * With `clock`, the recorder also installs itself in
   * `rs.hooks.onGoalMarker` (like the official `RoomState.Hf(fn)`), reads
   * the goal frame from `clock.frame`, chains any hook that was there and
   * restores it at stop. Without `clock`, the caller must forward goals with
   * {@link onGoalMarker}.
   *
   * Calling it while recording discards the current recording and starts a
   * new one (official behaviour of a second `startRecording()`).
   */
  start(rs: RoomState, frame: number, clock: FrameClock | null = null): void {
    // Official `startRecording()` while recording simply replaces the recorder
    // (the previous recording is lost): mirror that.
    if (this.active) this.unhook();
    this.active = true;
    this.startFrame = frame;
    this.lastEventFrame = frame;
    this.lastMarkerFrame = frame;
    this.markerCount = 0;
    this.eventCount = 0;
    this.markers.reset();
    this.markers.u16(0);
    this.events.reset();
    writeRoomState(this.events, rs);
    if (clock !== null) {
      this.clock = clock;
      this.hookedRoom = rs;
      this.previousGoalHook = rs.hooks.onGoalMarker;
      rs.hooks.onGoalMarker = this.goalHook;
    }
  }

  /**
   * Records `ev` (its `byId`, type and payload) as applied at `frame`. Call it
   * right AFTER `ev.apply(rs)`, for every event applied to the room, in
   * application order. No-op when not recording.
   */
  onEvent(ev: RoomEvent, frame: number): void {
    if (!this.active) return;
    const w = this.events;
    w.varUint(frame - this.lastEventFrame);
    this.lastEventFrame = frame;
    w.u16(ev.byId);
    writeEvent(w, ev);
    this.eventCount++;
  }

  /**
   * Records a goal marker at `frame`; `goalOwner` = team owning the goal the
   * ball entered (the argument of `rs.hooks.onGoalMarker`). No-op when not
   * recording.
   */
  onGoalMarker(goalOwner: TeamId, frame: number): void {
    if (!this.active) return;
    const w = this.markers;
    w.varUint(frame - this.lastMarkerFrame);
    this.lastMarkerFrame = frame;
    w.u8(goalOwner);
    this.markerCount++;
  }

  /**
   * Stops recording and returns the `.hbr2` file (fresh array, owned by the
   * caller). `frame` = host frame at the moment of the call; the header's
   * total frame count is `frame − startFrame`. Throws if not recording.
   */
  stop(frame: number): Uint8Array {
    if (!this.active) throw new Error('ReplayRecorder: not recording');
    const file = this.build(frame);
    this.active = false;
    this.unhook();
    return file;
  }

  /**
   * The `.hbr2` the recording would produce if stopped at `frame`, without
   * stopping it (periodic autosave / streaming of long matches).
   */
  snapshot(frame: number): Uint8Array {
    if (!this.active) throw new Error('ReplayRecorder: not recording');
    return this.build(frame);
  }

  /** Abandons the current recording (no output); restores the goal hook. */
  cancel(): void {
    this.active = false;
    this.unhook();
  }

  private unhook(): void {
    const rs = this.hookedRoom;
    if (rs !== null) {
      if (rs.hooks.onGoalMarker === this.goalHook) rs.hooks.onGoalMarker = this.previousGoalHook;
      this.hookedRoom = null;
    }
    this.clock = null;
    this.previousGoalHook = null;
  }

  private build(frame: number): Uint8Array {
    const markers = this.markers;
    markers.setU16At(0, this.markerCount);
    // body = markers ++ events, deflated in one go (official `Jb.qb(yc.Db())`).
    const markerLen = markers.pos;
    markers.bytes(this.events.finish());
    const deflated = deflateRaw(markers.finish());
    markers.pos = markerLen; // keep appending markers after a snapshot
    const file = new Uint8Array(REPLAY_HEADER_SIZE + deflated.length);
    const header = new DataView(file.buffer);
    header.setUint32(0, REPLAY_MAGIC); // "HBR2"
    header.setUint32(4, this.version);
    header.setUint32(8, frame - this.startFrame);
    file.set(deflated, REPLAY_HEADER_SIZE);
    return file;
  }
}
