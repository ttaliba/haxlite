/**
 * One process-wide timer for every SctpAssociation that uses the default
 * clock and timers: a binary min-heap of per-association deadlines and a
 * single Node `setTimeout` armed for the earliest one.
 *
 * Why: an association re-arms its timer whenever a deadline moves (T3 is
 * pushed forward by every SACK, the delayed-SACK timer comes and goes), and
 * every `setTimeout` allocates a Timeout (+ async-hooks bookkeeping) and
 * costs a fire. With 20 peers that is ~100 Timeouts per second; with one
 * shared heap only the global earliest deadline arms the Node timer, and
 * moving an association's deadline is an O(log n) heap update with no
 * allocation. Deadlines are `performance.now()` milliseconds.
 */
import { freezeSctpClock, thawSctpClock } from './clock.js';

/** One association's slot in the heap (allocated once per association). */
export class TimerSlot {
  /** Absolute deadline (performance.now ms); meaningless while not queued. */
  at = 0;
  /** Heap index, -1 = not queued. */
  index = -1;
  readonly fire: () => void;
  constructor(fire: () => void) {
    this.fire = fire;
  }
}

/**
 * Slots due by this margin fire. 0: associations use a whole-millisecond
 * clock, so a slot fired before its deadline would only re-queue itself
 * (an early Node timer just re-arms instead).
 */
const EARLY_MS = 0;

class SharedTimers {
  private heap: TimerSlot[] = [];
  private n = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Deadline the Node timer is armed for (Infinity = not armed). */
  private armedAt = Infinity;
  private running = false;
  /** Due slots collected before their callbacks run (reused, never shrunk). */
  private due: TimerSlot[] = [];
  private readonly onTimeout = (): void => this.run();

  /** Queues `slot` for `at`, or moves it there if already queued. */
  set(slot: TimerSlot, at: number): void {
    const i = slot.index;
    if (i < 0) {
      slot.at = at;
      slot.index = this.n;
      this.heap[this.n++] = slot;
      this.up(slot.index);
    } else {
      const old = slot.at;
      slot.at = at;
      if (at < old) this.up(i);
      else if (at > old) this.down(i);
    }
    this.arm();
  }

  /** Removes `slot` (no-op when not queued). */
  clear(slot: TimerSlot): void {
    const i = slot.index;
    if (i < 0) return;
    slot.index = -1;
    const last = this.heap[--this.n]!;
    this.heap[this.n] = undefined as unknown as TimerSlot;
    if (last !== slot) {
      this.heap[i] = last;
      last.index = i;
      this.down(i);
      this.up(last.index);
    }
    // An emptied heap keeps its armed Node timer: in a game every SACK that
    // acks everything clears T3 and the next send queues it again, so
    // clearing here would build a new Timeout (~150 B + async-hooks ids) per
    // empty → non-empty transition (~100/s with 20 peers). The stale timer
    // (unref'd) fires once at most, finds nothing due and is not re-armed;
    // a deadline queued meanwhile at or after it just rides on it.
  }

  /** Queued slots (tests/diagnostics). */
  get size(): number {
    return this.n;
  }

  private arm(): void {
    if (this.running || this.n === 0) return;
    const at = this.heap[0]!.at;
    // an armed timer that fires early just re-arms: only an EARLIER deadline needs a new one
    if (this.timer !== null && this.armedAt <= at) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.armedAt = at;
    const d = at - performance.now();
    this.timer = setTimeout(this.onTimeout, d > 1 ? d : 1);
    this.timer.unref?.();
  }

  private run(): void {
    this.timer = null;
    this.armedAt = Infinity;
    this.running = true;
    const due = this.due;
    let k = 0;
    freezeSctpClock(); // the slots fired here share one clock read
    try {
      const limit = performance.now() + EARLY_MS;
      while (this.n > 0 && this.heap[0]!.at <= limit) {
        const s = this.heap[0]!;
        this.clear(s);
        due[k++] = s;
      }
      for (let i = 0; i < k; i++) {
        const s = due[i]!;
        due[i] = undefined as unknown as TimerSlot;
        try {
          s.fire();
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    } finally {
      for (let i = 0; i < k; i++) due[i] = undefined as unknown as TimerSlot;
      this.running = false;
      thawSctpClock();
      this.arm();
    }
  }

  private up(i: number): void {
    const h = this.heap;
    const s = h[i]!;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const ps = h[p]!;
      if (ps.at <= s.at) break;
      h[i] = ps;
      ps.index = i;
      i = p;
    }
    h[i] = s;
    s.index = i;
  }

  private down(i: number): void {
    const h = this.heap;
    const n = this.n;
    const s = h[i]!;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && h[r]!.at < h[l]!.at ? r : l;
      const cs = h[c]!;
      if (cs.at >= s.at) break;
      h[i] = cs;
      cs.index = i;
      i = c;
    }
    h[i] = s;
    s.index = i;
  }
}

/** The process-wide instance used by associations with default clock/timers. */
export const sharedTimers = new SharedTimers();
