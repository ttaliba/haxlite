/**
 * `.hbr2` reader/writer (official client replay loader off `$b`; node-haxball
 * `Replay.readAll` / `Replay.writeAll`).
 *
 * `readReplay` decodes the whole file eagerly: header, goal markers, the
 * initial RoomState (kept as raw bytes so it can be decoded again for every
 * rewind) and the event list with absolute frames (relative to the start of
 * the recording, i.e. frame 0 = the moment `start` was called). Because of
 * that, the inflated size and the event count are capped by default
 * ({@link ReplayReadOptions}): a few KB of deflated zeros would otherwise
 * become millions of event objects.
 */
import { CodecError, Reader, Writer, deflateRaw, inflateRaw } from '../codec/index.js';
import type { TeamId } from '../protocol.js';
import type { RoomEvent, RoomState } from '../room/index.js';
import { readEvent, readRoomState, writeEvent } from '../room/index.js';
import {
  REPLAY_HEADER_SIZE,
  REPLAY_MAGIC,
  REPLAY_MAX_BODY_BYTES,
  REPLAY_MAX_EVENTS,
  REPLAY_VERSION,
  ReplayFormatError,
  ReplayVersionError,
} from './format.js';

/** A goal marker: `team` owns the goal the ball entered (node-haxball `teamId`). */
export interface ReplayGoalMarker {
  frame: number;
  team: TeamId;
}

/** Decoded `.hbr2` contents. */
export class ReplayData {
  /** Header version (always 3 for files accepted by {@link readReplay}). */
  readonly version: number;
  /** Header total frame count (frame at stop − frame at start). */
  readonly totalFrames: number;
  /** Goal markers in file order (non-decreasing frames). */
  readonly goalMarkers: ReplayGoalMarker[];
  /**
   * Serialized initial RoomState (official `Ta.G` layout), exactly as stored
   * in the file. Decode with {@link initialState}.
   */
  readonly stateBytes: Uint8Array;
  /**
   * Recorded events in application order. `ev.frame` = frame (relative to
   * the start) the event was applied at, before that frame's tick;
   * `ev.byId` = issuer. `order`/`clientSeq` are not stored in replays (0).
   */
  readonly events: RoomEvent[];

  constructor(version: number, totalFrames: number, goalMarkers: ReplayGoalMarker[], stateBytes: Uint8Array, events: RoomEvent[]) {
    this.version = version;
    this.totalFrames = totalFrames;
    this.goalMarkers = goalMarkers;
    this.stateBytes = stateBytes;
    this.events = events;
  }

  /** A fresh RoomState decoded from {@link stateBytes} (hooks unset). */
  initialState(): RoomState {
    return readRoomState(new Reader(this.stateBytes));
  }
}

/** Limits for reading a `.hbr2`; raise them for long trusted files, keep them for anything else. */
export interface ReplayReadOptions {
  /**
   * Largest inflated body accepted, in bytes (`Infinity` = no limit).
   * Default {@link REPLAY_MAX_BODY_BYTES} (32 MiB). A larger body is a
   * {@link ReplayFormatError}.
   */
  maxBodyBytes?: number;
  /**
   * Most events decoded (`Infinity` = no limit). Default
   * {@link REPLAY_MAX_EVENTS} (2^21). More is a {@link ReplayFormatError}.
   */
  maxEvents?: number;
}

/** Inflate limit for a `maxBodyBytes` option: none for `Infinity`, clamped to what zlib takes, the default for invalid values. */
function inflateLimit(max: number | undefined): number | undefined {
  if (max === undefined || max !== max || max < 0) return REPLAY_MAX_BODY_BYTES;
  return max === Infinity ? undefined : Math.min(Math.floor(max), 0xffffffff);
}

/** Event limit for a `maxEvents` option (the default for invalid values). */
function eventLimit(max: number | undefined): number {
  return max === undefined || max !== max || max < 0 ? REPLAY_MAX_EVENTS : max;
}

function fail(what: string, err: unknown): never {
  if (err instanceof ReplayFormatError) throw err;
  const e = new ReplayFormatError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  (e as { cause?: unknown }).cause = err;
  throw e;
}

/**
 * Parses a `.hbr2` file. Throws {@link ReplayVersionError} for another format
 * version and {@link ReplayFormatError} for anything malformed or past the
 * limits in `opts`. The header's total frame count is not checked against the
 * events: the official recorder writes replays with an event-free tail.
 */
export function readReplay(bytes: Uint8Array, opts: ReplayReadOptions = {}): ReplayData {
  const { version, totalFrames } = readReplayHeader(bytes);
  const maxEvents = eventLimit(opts.maxEvents);

  const maxBody = inflateLimit(opts.maxBodyBytes);
  let body: Uint8Array;
  try {
    body = inflateRaw(bytes.subarray(REPLAY_HEADER_SIZE), maxBody);
  } catch (err) {
    if (maxBody !== undefined && err instanceof CodecError && err.message === 'Inflate size exceeds limit') {
      fail(`replay body larger than maxBodyBytes (${maxBody})`, err);
    }
    fail('corrupt replay body', err);
  }
  const r = new Reader(body);

  const goalMarkers: ReplayGoalMarker[] = [];
  let stateBytes: Uint8Array;
  try {
    const count = r.u16();
    let frame = 0;
    for (let i = 0; i < count; i++) {
      frame += r.varUint();
      goalMarkers.push({ frame, team: r.u8() as TeamId });
    }
    const stateStart = r.pos;
    readRoomState(r); // validates and finds the end of the state
    stateBytes = body.slice(stateStart, r.pos);
  } catch (err) {
    fail('corrupt replay state', err);
  }

  const events: RoomEvent[] = [];
  let frame = 0;
  try {
    while (r.remaining > 0) {
      if (events.length >= maxEvents) throw new ReplayFormatError(`too many events (more than maxEvents = ${maxEvents})`);
      frame += r.varUint();
      const byId = r.u16();
      const ev = readEvent(r);
      ev.byId = byId;
      ev.frame = frame;
      events.push(ev);
    }
  } catch (err) {
    fail(`corrupt replay event #${events.length}`, err);
  }
  return new ReplayData(version, totalFrames, goalMarkers, stateBytes, events);
}

/**
 * Encodes `data` back into a `.hbr2` (same layout the recorder produces).
 * Event and marker frames must be non-decreasing. Useful after editing or
 * trimming a decoded replay.
 */
export function writeReplay(data: ReplayData): Uint8Array {
  const w = new Writer(data.stateBytes.length + 16 * data.events.length + 64);
  const markers = data.goalMarkers;
  w.u16(markers.length);
  let last = 0;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    if (m.frame < last) throw new CodecError('goal markers must be in frame order');
    w.varUint(m.frame - last);
    last = m.frame;
    w.u8(m.team);
  }
  w.bytes(data.stateBytes);
  last = 0;
  const events = data.events;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.frame < last) throw new CodecError('events must be in frame order');
    w.varUint(ev.frame - last);
    last = ev.frame;
    w.u16(ev.byId);
    writeEvent(w, ev);
  }
  const deflated = deflateRaw(w.finish());
  const file = new Uint8Array(REPLAY_HEADER_SIZE + deflated.length);
  const header = new DataView(file.buffer);
  header.setUint32(0, REPLAY_MAGIC);
  header.setUint32(4, data.version);
  header.setUint32(8, data.totalFrames);
  file.set(deflated, REPLAY_HEADER_SIZE);
  return file;
}

/**
 * Inflated body of a `.hbr2` (markers + state + events), after header checks.
 * For tests/tooling. `maxBodyBytes` as in {@link ReplayReadOptions}.
 */
export function replayBody(bytes: Uint8Array, maxBodyBytes?: number): Uint8Array {
  const data = readReplayHeader(bytes);
  try {
    return inflateRaw(bytes.subarray(REPLAY_HEADER_SIZE), inflateLimit(maxBodyBytes));
  } catch (err) {
    fail(`corrupt replay body (version ${data.version})`, err);
  }
}

/** Header fields only (no inflate). */
export function readReplayHeader(bytes: Uint8Array): { version: number; totalFrames: number } {
  if (bytes.length < REPLAY_HEADER_SIZE) throw new ReplayFormatError('truncated replay header');
  const r = new Reader(bytes);
  if (r.u32() !== REPLAY_MAGIC) throw new ReplayFormatError('not a HaxBall replay (bad magic)');
  const version = r.u32();
  if (version !== REPLAY_VERSION) throw new ReplayVersionError(version);
  return { version, totalFrames: r.u32() };
}
