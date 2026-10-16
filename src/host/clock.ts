/**
 * One process-wide wake-up timer shared by every {@link HostRoom}.
 *
 * Each room tells the clock the earliest time it has work (next heartbeat,
 * CheckConsistency, Ping event, catch-up bound while a game runs…), or
 * `Infinity` when it has none. The clock keeps ONE `setTimeout` armed for
 * the earliest of those times and, when it fires, wakes every room that is
 * due. Rooms with nothing to do cost nothing; K rooms cost one timer, and
 * rooms due in the same millisecond share one process wake-up.
 *
 * Times are `performance.now()` milliseconds. Rooms with an injected clock
 * convert their own delay to this time base before calling {@link set}.
 */
// The global `performance` (Node >= 16, Bun): no node:perf_hooks import at
// load time (Node loads its perf internals on the first performance.now()).

/**
 * Extra ms added to every timer (see {@link SharedClock} `armAt`). Node can
 * fire up to ~1 ms early; Bun keeps its timers on a sub-millisecond
 * monotonic clock and never fired early in our samples (0 of 1000, earliest
 * fire 0.014 ms after the target), so it needs none.
 */
export const TIMER_SLACK_MS = (process.versions as { bun?: string }).bun !== undefined ? 0 : 1;

/** What the clock knows about a room (one per HostRoom, allocated once). */
export class ClockEntry {
  /** Absolute `performance.now()` ms of the next wake-up, Infinity = none. */
  wakeAt = Infinity;
  /** Index in the clock's list, -1 when not registered. */
  index = -1;
  readonly wake: () => void;
  constructor(wake: () => void) {
    this.wake = wake;
  }
}

export class SharedClock {
  private readonly entries: ClockEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** `wakeAt` the timer is armed for (Infinity = not armed). */
  private armedAt = Infinity;
  private waking = false;
  /** Timer callbacks so far (diagnostics/tests: process wake-ups caused by rooms). */
  wakeups = 0;

  /** Rooms currently registered (running). */
  get size(): number {
    return this.entries.length;
  }

  /** Registers a running room (idempotent). */
  add(e: ClockEntry): void {
    if (e.index >= 0) return;
    e.index = this.entries.length;
    this.entries.push(e);
  }

  /** Unregisters a room (idempotent); disarms the timer when it was the last one due. */
  remove(e: ClockEntry): void {
    const i = e.index;
    if (i < 0) return;
    const list = this.entries;
    const last = list.pop()!;
    if (last !== e) {
      list[i] = last;
      last.index = i;
    }
    e.index = -1;
    e.wakeAt = Infinity;
    if (!this.waking) this.arm();
  }

  /** Sets when `e` wants to be woken (`Infinity` = no work). Allocation-free when unchanged. */
  set(e: ClockEntry, at: number): void {
    const old = e.wakeAt;
    if (old === at) return;
    e.wakeAt = at;
    if (e.index < 0 || this.waking) return;
    if (at < this.armedAt) this.armAt(at);
    else if (old === this.armedAt) this.arm(); // it was the earliest: rescan
  }

  /** Arms the timer for the earliest registered wake-up (or disarms it). */
  private arm(): void {
    const list = this.entries;
    let min = Infinity;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!.wakeAt;
      if (t < min) min = t;
    }
    this.armAt(min);
  }

  private armAt(at: number): void {
    if (at === this.armedAt && this.timer !== null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.armedAt = at;
    if (at === Infinity) return;
    // Integer delays keep Node on its shared per-duration timer lists. Node
    // counts timers on libuv's millisecond clock, which truncates (and may
    // use the coarse monotonic clock), so a timer can fire up to ~1 ms before
    // `at`; an early fire costs a second wake-up 1 ms later. TIMER_SLACK_MS
    // avoids that at the price of ~1 ms of extra latency (0 on Bun).
    const d = Math.ceil(at - performance.now()) + TIMER_SLACK_MS;
    this.timer = setTimeout(this.onTimer, d > 1 ? d : 1);
  }

  private readonly onTimer = (): void => {
    this.timer = null;
    this.armedAt = Infinity;
    this.wakeups++;
    this.waking = true;
    try {
      const now = performance.now();
      const list = this.entries;
      // a woken room may stop (swap-remove) or start others: walk by index,
      // re-checking the slot so a moved entry is not skipped
      for (let i = 0; i < list.length; ) {
        const e = list[i]!;
        if (e.wakeAt <= now) {
          e.wakeAt = Infinity;
          try {
            e.wake();
          } catch {
            /* rooms report their own errors */
          }
          if (list[i] !== e) continue;
        }
        i++;
      }
    } finally {
      this.waking = false;
      this.arm();
    }
  };
}

/** The clock every HostRoom uses. */
export const hostClock = new SharedClock();
