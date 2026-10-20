/**
 * Deterministic replay player (official client `$b`, node-haxball
 * `Replay.read`): there are no intermediate snapshots in a `.hbr2`, so the
 * state at frame N is rebuilt by decoding the initial RoomState and
 * re-simulating: for each frame F < N, apply the events recorded at F (in
 * file order) and then run one tick (`stepRoom`). Seeking backwards restarts
 * from the initial state.
 *
 * "State at frame N" = after N ticks, with the events of frames < N applied
 * and the events of frame N NOT yet applied (exactly what the official player
 * shows). Events recorded at frame === totalFrames (applied by the host just
 * before stopping) are applied only by {@link applyCurrentFrameEvents}.
 *
 * Re-simulating costs real time, and the cost per tick is set by the file (its
 * stadium and players), not by its size: `seek`/`finish` stop with a
 * `RangeError` after a time budget and `seekAsync`/`finishAsync` give the
 * event loop back between slices. Use those for files you do not trust.
 */
import type { RoomEvent, RoomHooks, RoomState } from '../room/index.js';
import { stepRoom } from '../room/index.js';
import { ReplayData, readReplay } from './reader.js';
import type { ReplayReadOptions } from './reader.js';

/** Default {@link ReplayPlayer.maxSeekMs}. */
const DEFAULT_SEEK_MS = 2000;
/** Default {@link ReplayAsyncSeekOptions.sliceMs}. */
const DEFAULT_SLICE_MS = 8;

/** Options of the {@link ReplayPlayer} constructor; the read limits apply when it is given file bytes. */
export interface ReplayPlayerOptions extends ReplayReadOptions {
  /** Initial value of {@link ReplayPlayer.maxSeekMs}. */
  maxSeekMs?: number;
}

/** Options of {@link ReplayPlayer.seek} and {@link ReplayPlayer.finish}. */
export interface ReplaySeekOptions {
  /** Time budget in ms (`Infinity` = none). Default {@link ReplayPlayer.maxSeekMs}. */
  maxMs?: number;
}

/** Options of {@link ReplayPlayer.seekAsync} and {@link ReplayPlayer.finishAsync}. */
export interface ReplayAsyncSeekOptions {
  /** Longest stretch simulated before yielding to the event loop, in ms. Default 8. */
  sliceMs?: number;
  /** Aborts the seek: the promise rejects with `signal.reason`, the player stays where it got to. */
  signal?: AbortSignal;
}

export class ReplayPlayer {
  readonly data: ReplayData;
  /** Current room state (replaced by a fresh decode on every rewind). */
  rs: RoomState;
  /** Frame of {@link rs} (number of ticks simulated). */
  frame = 0;
  /** Index of the next event to apply. */
  private next = 0;
  /**
   * Called with the fresh RoomState after every (re)start, e.g. to install
   * `rs.hooks` (goal/chat/… callbacks fire while re-simulating).
   */
  onReset: ((rs: RoomState) => void) | null = null;
  /** Called after each recorded event is applied (official player hook `hc`). */
  onEvent: ((ev: RoomEvent, rs: RoomState) => void) | null = null;
  /**
   * Time budget in ms of one {@link seek} / {@link finish} call (`Infinity` =
   * none); past it the call throws a `RangeError`. The player stays at the
   * frame it reached and the next call continues from there.
   */
  maxSeekMs: number;

  constructor(replay: ReplayData | Uint8Array, opts: ReplayPlayerOptions = {}) {
    this.data = replay instanceof Uint8Array ? readReplay(replay, opts) : replay;
    this.rs = this.data.initialState();
    this.maxSeekMs = opts.maxSeekMs ?? DEFAULT_SEEK_MS;
  }

  get totalFrames(): number {
    return this.data.totalFrames;
  }

  /** Hooks of the current state (convenience; reset on rewind unless set via {@link onReset}). */
  get hooks(): RoomHooks {
    return this.rs.hooks;
  }

  /** True when every tick of the replay has been simulated. */
  get ended(): boolean {
    return this.frame >= this.data.totalFrames;
  }

  /** Back to frame 0 (fresh decode of the initial state). */
  reset(): void {
    this.rs = this.data.initialState();
    this.frame = 0;
    this.next = 0;
    if (this.onReset !== null) this.onReset(this.rs);
  }

  /** Applies the not-yet-applied events recorded at the current frame (no tick). */
  applyCurrentFrameEvents(): void {
    const events = this.data.events;
    const rs = this.rs;
    while (this.next < events.length) {
      const ev = events[this.next]!;
      if (ev.frame !== this.frame) break;
      ev.apply(rs);
      this.next++;
      if (this.onEvent !== null) this.onEvent(ev, rs);
    }
  }

  /** Simulates `n` frames (events of each frame, then its tick). Does not stop at totalFrames. */
  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.applyCurrentFrameEvents();
      stepRoom(this.rs);
      this.frame++;
    }
  }

  /**
   * Moves to `frame` (clamped to [0, totalFrames]), rewinding to the start
   * first when `frame` is behind the current position. Runs synchronously for
   * at most `opts.maxMs` (default {@link maxSeekMs}): past the budget it throws
   * a `RangeError` with the player at a consistent frame in between, after at
   * least one chunk of ticks, so repeated calls always advance.
   */
  seek(frame: number, opts: ReplaySeekOptions = {}): void {
    const target = this.clampFrame(frame);
    if (target < this.frame) this.reset();
    if (target > this.frame) {
      const budget = opts.maxMs ?? this.maxSeekMs;
      if (budget === Infinity) this.step(target - this.frame);
      else if (!this.advance(target, performance.now() + budget)) {
        throw new RangeError(`replay seek budget exceeded (${this.frame}/${target} frames)`);
      }
    }
  }

  /**
   * Plays to the end and applies the events stamped with the final frame:
   * the state the recording host had when it called `stop`. Same budget as
   * {@link seek}.
   */
  finish(opts: ReplaySeekOptions = {}): RoomState {
    this.seek(this.data.totalFrames, opts);
    this.applyCurrentFrameEvents();
    return this.rs;
  }

  /**
   * {@link seek} without a budget that yields to the event loop every
   * `opts.sliceMs` instead, so other work keeps running while a long replay
   * is re-simulated. Do not use the player until the promise settles.
   */
  async seekAsync(frame: number, opts: ReplayAsyncSeekOptions = {}): Promise<void> {
    const signal = opts.signal;
    const sliceMs = opts.sliceMs ?? DEFAULT_SLICE_MS;
    signal?.throwIfAborted();
    const target = this.clampFrame(frame);
    if (target < this.frame) this.reset();
    while (this.frame < target) {
      this.advance(target, performance.now() + sliceMs);
      if (this.frame >= target) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
  }

  /** {@link finish} on top of {@link seekAsync}. */
  async finishAsync(opts: ReplayAsyncSeekOptions = {}): Promise<RoomState> {
    await this.seekAsync(this.data.totalFrames, opts);
    this.applyCurrentFrameEvents();
    return this.rs;
  }

  /** `frame` as a whole frame number within [0, totalFrames]. */
  private clampFrame(frame: number): number {
    let target = Math.floor(frame);
    if (target < 0) target = 0;
    if (target > this.data.totalFrames) target = this.data.totalFrames;
    return target;
  }

  /**
   * Simulates towards `target` in chunks that adapt to about a millisecond,
   * reading the clock between them. Returns false when `deadline`
   * (`performance.now()` ms) arrived first; at least one chunk always runs.
   */
  private advance(target: number, deadline: number): boolean {
    let chunk = 32;
    let last = performance.now();
    while (this.frame < target) {
      const left = target - this.frame;
      this.step(left < chunk ? left : chunk);
      const now = performance.now();
      const took = now - last;
      last = now;
      if (this.frame >= target) break;
      if (!(now < deadline)) return false;
      if (took < 0.25) {
        if (chunk < 4096) chunk *= 2;
      } else if (took > 1 && chunk > 1) chunk >>= 1;
    }
    return true;
  }
}
