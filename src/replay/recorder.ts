/**
 * Replay recorder: produces the official `.hbr2` (version 3) byte layout.
 *
 * Equivalent of the official headless recorder (off `cb`, built by
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
 * (amortized zero allocations) and one size comparison. Only
 * `stop()`/`snapshot()` allocate: one exact-size transient body (markers ++
 * events) for the deflate, plus the output file. At stop, writers that grew
 * past their initial capacity are dropped (a 1 h match leaves ~8 MB of event
 * log behind otherwise); small ones are kept for the next recording.
 * `stopAsync()`/`snapshotAsync()` deflate on the libuv threadpool instead of
 * the event loop (same bytes, level 6).
 *
 * The synchronous `stop()`/`snapshot()` block the event loop for the whole
 * deflate, so bodies past 64 KiB use a fast level there (about 3% larger
 * files, a 10 to 100 times shorter stall); smaller ones keep level 6.
 *
 * The event log is capped ({@link ReplayRecorder.maxBytes}): events can come
 * from any connected player, valid or not, and are all recorded. Past the cap
 * the recording freezes where it is instead of growing without bound.
 */
import { Writer, deflateRaw } from '../codec/index.js';
import { deflateRawAsync } from '../codec/compress.js';
import type { TeamId } from '../protocol.js';
import type { RoomEvent, RoomState } from '../room/index.js';
import { writeEvent, writeRoomState } from '../room/index.js';
import { REPLAY_HEADER_SIZE, REPLAY_MAGIC, REPLAY_RECORD_MAX_BYTES, REPLAY_VERSION } from './format.js';

/** Initial writer capacities (official `Jb` / `yc`); writers that grew past them are dropped at stop. */
const MARKERS_CAPACITY = 1000;
const EVENTS_CAPACITY = 16384;

/**
 * Bodies larger than this are deflated at {@link FAST_LEVEL} by the
 * synchronous `stop()`/`snapshot()` (same threshold as the Bun fast path in
 * `deflateRaw`); up to it, level 6 gives the bytes of the official recorder.
 */
const SYNC_FAST_BODY = 65536;
/** Fastest sensible level: node:zlib's level 1 is the quickest and ~3% bigger than 6; Bun's level 1 is 50% bigger, its level 2 is not. */
const FAST_LEVEL = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 2 : 1;

/** Options of the {@link ReplayRecorder} constructor. */
export interface ReplayRecorderOptions {
  /** Initial value of {@link ReplayRecorder.maxBytes}. */
  maxBytes?: number;
}

/** Anything exposing the host's current logical frame (e.g. the host engine itself). */
export interface FrameClock {
  readonly frame: number;
}

/** Deflate level of the synchronous stop/snapshot for a body of `length` bytes. */
function syncLevel(length: number): number {
  return length > SYNC_FAST_BODY ? FAST_LEVEL : 6;
}

export class ReplayRecorder {
  /** u16 goal marker count (patched at stop) + markers. off `Jb` (initial capacity 1000). Null until the first start / after a large recording stops. */
  private markers: Writer | null = null;
  /** RoomState at start + event records. off `yc` (initial capacity 16384). Null until the first start / after a large recording stops. */
  private events: Writer | null = null;
  /** {@link bodyLength} of the last recording once it stopped. */
  private finalBodyLength = 0;

  private active = false;
  /** Recording and not frozen: the only state in which events and markers are written. */
  private open = false;
  /** Frame the recording froze at, once {@link truncated}; the replay ends there. */
  private capFrame = 0;
  private frozen = false;
  private limit: number;
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
  readonly version: number;
  /**
   * Called once when the recording freezes at the {@link maxBytes} cap, with
   * the frame it froze at (the replay ends there). It runs from inside
   * {@link onEvent}, after the recording is already frozen.
   */
  onTruncated: ((frame: number) => void) | null = null;

  constructor(version: number = REPLAY_VERSION, opts: ReplayRecorderOptions = {}) {
    this.version = version;
    this.limit = REPLAY_RECORD_MAX_BYTES;
    if (opts.maxBytes !== undefined) this.maxBytes = opts.maxBytes;
  }

  /**
   * Cap on the event log (the RoomState at start plus the events), in bytes;
   * `Infinity` = none. Default {@link REPLAY_RECORD_MAX_BYTES} (16 MiB, about
   * two hours of a regular match). Once the log reaches it the recording
   * freezes: later events and goals are not recorded, the file ends at the
   * frame of the first event left out and {@link truncated} is set. The log
   * can exceed the cap by one event. Takes effect on the next event, so it
   * may also be changed while recording; invalid values give the default.
   */
  get maxBytes(): number {
    return this.limit;
  }
  set maxBytes(bytes: number) {
    this.limit = bytes >= 0 ? bytes : REPLAY_RECORD_MAX_BYTES;
  }

  /** True once the current/last recording froze at the {@link maxBytes} cap (it keeps recording nothing until stopped). */
  get truncated(): boolean {
    return this.frozen;
  }

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
    return this.active ? this.markers!.pos + this.events!.pos : this.finalBodyLength;
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
    this.open = true;
    this.frozen = false;
    this.startFrame = frame;
    this.lastEventFrame = frame;
    this.lastMarkerFrame = frame;
    this.markerCount = 0;
    this.eventCount = 0;
    const markers = (this.markers ??= new Writer(MARKERS_CAPACITY)).reset();
    markers.u16(0);
    const events = (this.events ??= new Writer(EVENTS_CAPACITY)).reset();
    writeRoomState(events, rs);
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
   * application order. No-op when not recording. An event that fails to
   * encode rethrows and leaves nothing in the log.
   */
  onEvent(ev: RoomEvent, frame: number): void {
    if (!this.open) return;
    const w = this.events!;
    const start = w.pos;
    if (start >= this.limit) {
      this.freeze(frame);
      return;
    }
    try {
      w.varUint(frame - this.lastEventFrame);
      w.u16(ev.byId);
      writeEvent(w, ev);
    } catch (err) {
      w.pos = start;
      throw err;
    }
    this.lastEventFrame = frame;
    this.eventCount++;
  }

  /**
   * Records a goal marker at `frame`; `goalOwner` = team owning the goal the
   * ball entered (the argument of `rs.hooks.onGoalMarker`). No-op when not
   * recording.
   */
  onGoalMarker(goalOwner: TeamId, frame: number): void {
    if (!this.open) return;
    const w = this.markers!;
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
    const total = this.endFrame(frame) - this.startFrame;
    const body = this.body();
    this.end();
    return this.file(total, deflateRaw(body, syncLevel(body.length)));
  }

  /**
   * {@link stop}, deflating on the libuv threadpool (node:zlib) instead of the
   * event loop: same bytes. Recording stops synchronously (events after this
   * call are not recorded, a new {@link start} may follow at once); only the
   * compression is deferred. Throws (synchronously) if not recording.
   */
  stopAsync(frame: number): Promise<Uint8Array> {
    if (!this.active) throw new Error('ReplayRecorder: not recording');
    const total = this.endFrame(frame) - this.startFrame;
    const body = this.body();
    this.end();
    return deflateRawAsync(body).then((d) => this.file(total, d));
  }

  /**
   * The `.hbr2` the recording would produce if stopped at `frame`, without
   * stopping it (periodic autosave / streaming of long matches).
   */
  snapshot(frame: number): Uint8Array {
    if (!this.active) throw new Error('ReplayRecorder: not recording');
    const body = this.body();
    return this.file(this.endFrame(frame) - this.startFrame, deflateRaw(body, syncLevel(body.length)));
  }

  /** {@link snapshot}, deflating on the libuv threadpool (level 6 at any size). */
  snapshotAsync(frame: number): Promise<Uint8Array> {
    if (!this.active) throw new Error('ReplayRecorder: not recording');
    const total = this.endFrame(frame) - this.startFrame;
    return deflateRawAsync(this.body()).then((d) => this.file(total, d));
  }

  /** Abandons the current recording (no output); restores the goal hook. */
  cancel(): void {
    if (this.active) this.end();
    else this.unhook();
  }

  /** Cap reached at `frame`: nothing more is recorded and the replay ends there. */
  private freeze(frame: number): void {
    this.open = false;
    this.frozen = true;
    this.capFrame = frame;
    const cb = this.onTruncated;
    if (cb !== null) cb(frame);
  }

  /** Frame the replay ends at for a stop/snapshot called at `frame`. */
  private endFrame(frame: number): number {
    return this.frozen ? this.capFrame : frame;
  }

  /** Recording over: restores the goal hook, drops writers that grew. */
  private end(): void {
    this.finalBodyLength = this.markers!.pos + this.events!.pos;
    this.active = false;
    this.open = false;
    this.unhook();
    if (this.markers!.capacity > MARKERS_CAPACITY) this.markers = null;
    if (this.events!.capacity > EVENTS_CAPACITY) this.events = null;
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

  /**
   * `markers ++ events` (official `Jb.qb(yc.Db())`, deflated in one go) in one
   * exact-size transient array, with the marker count patched in.
   */
  private body(): Uint8Array {
    const markers = this.markers!;
    const events = this.events!;
    markers.setU16At(0, this.markerCount);
    const m = markers.finish();
    const body = new Uint8Array(m.length + events.pos);
    body.set(m);
    body.set(events.finish(), m.length);
    return body;
  }

  /** Header (`"HBR2"`, version, total frames) + deflated body. */
  private file(totalFrames: number, deflated: Uint8Array): Uint8Array {
    const file = new Uint8Array(REPLAY_HEADER_SIZE + deflated.length);
    const header = new DataView(file.buffer);
    header.setUint32(0, REPLAY_MAGIC); // "HBR2"
    header.setUint32(4, this.version);
    header.setUint32(8, totalFrames);
    file.set(deflated, REPLAY_HEADER_SIZE);
    return file;
  }
}
