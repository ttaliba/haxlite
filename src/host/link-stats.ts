/**
 * Connection quality measured by the host (not declared by the client).
 *
 * The official ping is whatever the client says (a 50-sample median of its own
 * RTT), so it neither shows spikes nor says who caused them. The host already
 * sees three things for free, which is all this module uses:
 *  - every Ping message (1 per second per player): its arrival time, the
 *    client's own clock (`echo`) and its declared ping;
 *  - every input event: whether it arrived after the frame it asked for;
 *  - every shared-clock wake-up: how late the host's own timer fired.
 *
 * What each one shows:
 *  - `hostLag`: the host process was late (event loop stall, GC, CPU). It hits
 *    every player of the process at once, and also inflates their numbers.
 *  - player side: ping messages that never arrived (`lostPings`), uplink
 *    jitter / delay above baseline (arrival time minus the client's send time,
 *    compared only with itself, so the two clocks need no sync) and inputs
 *    that came too late. A background browser tab or a bad Wi-Fi shows up here.
 * Numbers only: no verdict, the caller decides what is too much.
 *
 * Cost: a handful of arithmetic ops per Ping (1/s/player) and two integer
 * increments per input. Fixed typed arrays, no timers, no allocation until a
 * report is requested.
 */

/** Length of one history window. */
export const LINK_WINDOW_MS = 10_000;
/** Windows kept per player (30 x 10 s = 5 min). */
export const LINK_WINDOWS = 30;
/** The client sends one Ping per second; a longer gap means lost or delayed pings. */
const PING_PERIOD_MS = 1000;
const LOSS_GAP_MS = 1500;
/** Per-sample upward creep of the delay baseline (absorbs clock drift: 0.05 ms/s = 50 ppm). */
const BASE_CREEP_MS = 0.05;
const MAX_QUEUE_MS = 60_000;

/** One window of history (<= {@link LINK_WINDOW_MS}; the last one may still be open). */
export interface LinkSample {
  /** Milliseconds since the player joined, at the start of the window. */
  t: number;
  /** Declared ping at the end of the window (ms), 0 if no ping arrived. */
  ping: number;
  /** Worst uplink jitter in the window (ms). */
  jitter: number;
  /** Worst uplink delay above baseline in the window (ms). */
  uplinkDelay: number;
  /** Ping messages that did not arrive. */
  lostPings: number;
  inputs: number;
  /** Inputs that arrived after the frame they asked for. */
  lateInputs: number;
  /** Worst lateness of the host's own timer in the window (ms). */
  hostLag: number;
}

/** Result of `HostRoom.getLinkQuality`. */
export interface LinkQuality {
  playerId: number;
  /** Milliseconds since the player joined. */
  uptimeMs: number;
  /** Declared ping now (ms). */
  ping: number;
  /** Current uplink jitter (ms). */
  jitter: number;
  /** Current uplink delay above the best seen (ms). */
  uplinkDelay: number;
  /** Mean lateness of the last 15 inputs in frames (negative = arriving late). */
  inputLateness: number;
  totals: {
    pings: number;
    lostPings: number;
    inputs: number;
    lateInputs: number;
    /** Worst lateness of the host's timer while this player was connected (ms). */
    hostLag: number;
  };
  /** Oldest first; the last element is the window in progress. */
  history: LinkSample[];
}

/** Worst host timer lateness per window, shared by every connection of a room. */
export class HostLagTrack {
  private readonly idx = new Float64Array(LINK_WINDOWS).fill(-1);
  private readonly max = new Float64Array(LINK_WINDOWS);

  note(now: number, lag: number): void {
    const w = Math.floor(now / LINK_WINDOW_MS);
    const s = w % LINK_WINDOWS;
    if (this.idx[s] !== w) {
      this.idx[s] = w;
      this.max[s] = lag;
    } else if (lag > this.max[s]!) this.max[s] = lag;
  }

  /** Worst lag recorded in window number `w` (0 if none). */
  at(w: number): number {
    const s = w % LINK_WINDOWS;
    return this.idx[s] === w ? this.max[s]! : 0;
  }
}

/** Inputs seen by the sequencer for a connection (it only increments them). */
export interface InputCounters {
  inputCount: number;
  lateCount: number;
  lateness: { readonly mean: number };
}

const NO_LAG: HostLagTrack = new HostLagTrack();

export class LinkStats {
  private readonly joinedAt: number;
  private readonly host: HostLagTrack;
  private readonly inputs: InputCounters;

  // ---- running state
  private lastPingAt = 0;
  private haveDelay = false;
  private base = 0;
  private prevDelay = 0;
  private jitterNow = 0;
  private queueNow = 0;
  private pingNow = 0;

  // ---- session totals
  private pings = 0;
  private lost = 0;
  private hostLagMax = 0;

  // ---- open window
  private win: number;
  private wPing = 0;
  private wJitter = 0;
  private wQueue = 0;
  private wLost = 0;
  private inputs0 = 0;
  private late0 = 0;
  private wInputs = 0;
  private wLate = 0;
  private wStart: number;

  // ---- closed windows (ring, indexed by window number % LINK_WINDOWS)
  private readonly rIdx = new Float64Array(LINK_WINDOWS).fill(-1);
  private readonly rPing = new Float64Array(LINK_WINDOWS);
  private readonly rJitter = new Float64Array(LINK_WINDOWS);
  private readonly rQueue = new Float64Array(LINK_WINDOWS);
  private readonly rLost = new Float64Array(LINK_WINDOWS);
  private readonly rInputs = new Float64Array(LINK_WINDOWS);
  private readonly rLate = new Float64Array(LINK_WINDOWS);
  private readonly rHost = new Float64Array(LINK_WINDOWS);

  constructor(now: number, inputs: InputCounters, host: HostLagTrack = NO_LAG) {
    this.joinedAt = now;
    this.host = host;
    this.inputs = inputs;
    this.win = Math.floor(now / LINK_WINDOW_MS);
    this.wStart = now;
  }

  /** A Ping message arrived. `echo` is the client's own `performance.now()` at send time. */
  onPing(now: number, echo: number, declared: number): void {
    this.roll(now);
    this.pings++;
    this.pingNow = declared;
    if (declared > this.wPing) this.wPing = declared;
    if (this.pings > 1) {
      const gap = now - this.lastPingAt;
      if (gap > LOSS_GAP_MS) {
        const lost = Math.round(gap / PING_PERIOD_MS) - 1;
        if (lost > 0) {
          this.lost += lost;
          this.wLost += lost;
        }
      }
    }
    this.lastPingAt = now;

    // one-way delay + unknown clock offset: only its variation means anything
    const d = now - echo;
    if (d !== d || d === Infinity || d === -Infinity) return; // NaN / non-finite from a bad client
    if (!this.haveDelay) {
      this.haveDelay = true;
      this.base = d;
      this.prevDelay = d;
      return;
    }
    this.base += BASE_CREEP_MS;
    if (d < this.base) this.base = d;
    let q = d - this.base;
    if (q > MAX_QUEUE_MS) q = MAX_QUEUE_MS;
    this.queueNow = q;
    if (q > this.wQueue) this.wQueue = q;
    const dj = d - this.prevDelay;
    this.jitterNow += ((dj < 0 ? -dj : dj) - this.jitterNow) / 16;
    if (this.jitterNow > this.wJitter) this.wJitter = this.jitterNow;
    this.prevDelay = d;
  }

  /** Closes the finished windows when `now` is in a later one. */
  private roll(now: number): void {
    const w = Math.floor(now / LINK_WINDOW_MS);
    if (w === this.win) return;
    this.closeWindow();
    this.win = w;
    this.wStart = w * LINK_WINDOW_MS;
  }

  private closeWindow(): void {
    const s = this.win % LINK_WINDOWS;
    const inputs = this.inputs.inputCount - this.inputs0;
    const late = this.inputs.lateCount - this.late0;
    this.inputs0 = this.inputs.inputCount;
    this.late0 = this.inputs.lateCount;
    const host = this.host.at(this.win);
    if (host > this.hostLagMax) this.hostLagMax = host;
    this.rIdx[s] = this.win;
    this.rPing[s] = this.wPing;
    this.rJitter[s] = this.wJitter;
    this.rQueue[s] = this.wQueue;
    this.rLost[s] = this.wLost;
    this.rInputs[s] = inputs;
    this.rLate[s] = late;
    this.rHost[s] = host;
    this.wPing = this.wJitter = this.wQueue = this.wLost = 0;
  }

  /** Builds the report. `now` must be the same clock `onPing` receives. */
  report(playerId: number, now: number): LinkQuality {
    this.roll(now);
    const history: LinkSample[] = [];
    const oldest = this.win - LINK_WINDOWS + 1;
    for (let w = oldest < 0 ? 0 : oldest; w < this.win; w++) {
      const s = w % LINK_WINDOWS;
      if (this.rIdx[s] !== w) continue;
      history.push(
        sample(
          Math.max(0, w * LINK_WINDOW_MS - this.joinedAt),
          this.rPing[s]!,
          this.rJitter[s]!,
          this.rQueue[s]!,
          this.rLost[s]!,
          this.rInputs[s]!,
          this.rLate[s]!,
          this.rHost[s]!,
        ),
      );
    }
    const openInputs = this.inputs.inputCount - this.inputs0;
    const openLate = this.inputs.lateCount - this.late0;
    const openHost = this.host.at(this.win);
    history.push(
      sample(this.wStart - this.joinedAt, this.wPing, this.wJitter, this.wQueue, this.wLost, openInputs, openLate, openHost),
    );

    return {
      playerId,
      uptimeMs: now - this.joinedAt,
      ping: this.pingNow,
      jitter: this.jitterNow,
      uplinkDelay: this.queueNow,
      inputLateness: this.inputs.lateness.mean,
      totals: {
        pings: this.pings,
        lostPings: this.lost,
        inputs: this.inputs.inputCount,
        lateInputs: this.inputs.lateCount,
        hostLag: openHost > this.hostLagMax ? openHost : this.hostLagMax,
      },
      history,
    };
  }
}

function sample(
  t: number,
  ping: number,
  jitter: number,
  uplinkDelay: number,
  lostPings: number,
  inputs: number,
  lateInputs: number,
  hostLag: number,
): LinkSample {
  return { t, ping, jitter, uplinkDelay, lostPings, inputs, lateInputs, hostLag };
}
