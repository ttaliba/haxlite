/**
 * Host sequencer: the authoritative event pipeline of the official host,
 * without clock, timers or transport (those live in {@link HostRoom}).
 *
 * Official references (headless hash f066733d, names cited as `off:`):
 *   runner `Ma`  — frame `da`, events applied in the current frame `Ra`,
 *                  events of closed frames `od`, future queue `Xd` (`gb`),
 *                  `rg(n)` advance, `Cf(ev)` apply-or-queue;
 *   host   `Wa`  — `oc` host event, `Mh` client event, `Zd` heartbeat,
 *                  `Wh` CheckConsistency, `Nd`/`rf` event framing, `$h` snapshot,
 *                  `Ef` targeted event, input delay `Sb`;
 *   client `Za`  — per-connection lateness average `jf`, last assigned frame
 *                  `Id`, per-type rate limiters `Ie`, declared ping `ad`.
 *
 * Everything here is deterministic given the call sequence, which lets the
 * tests drive it side by side with the official `Wa` (test/host/sequencer.test.ts).
 */
import { Reader, Writer, deflateRaw } from '../codec/index.js';
import { TokenBucket } from '../net/rate-limit.js';
import { Channel, EventType, HostMsg, INPUT_DELAY_FRAMES, MAX_EVENT_FRAME_LEAD } from '../protocol.js';
import {
  CheckConsistencyEvent,
  EVENT_META,
  SetDiscPropertiesEvent,
  checkClientSender,
  createEvent,
  readRoomState,
  stepRoom,
  writeEvent,
  writeEventFrame,
  writeRoomState,
  type RoomEvent,
  type RoomState,
} from '../room/index.js';

/** Fixed-size moving average (official `$a`): ring of samples, running sum. */
export class MovingAverage {
  private readonly samples: Float64Array;
  private index = 0;
  private sum = 0;

  constructor(size: number) {
    this.samples = new Float64Array(size);
  }

  /** off `qg`. */
  push(v: number): void {
    const s = this.samples;
    this.sum -= s[this.index]!;
    s[this.index] = v;
    this.sum += v;
    if (++this.index >= s.length) this.index = 0;
  }

  /** off `ug`. */
  get mean(): number {
    return this.sum / this.samples.length;
  }
}

/** Per-connection sequencing state (official `Za`, minus the transport). */
export class SequencerClient {
  /** Player id of the connection (off `P`). */
  readonly playerId: number;
  /** Lateness of the last 15 `delay` events, each clamped to ±inputDelay (off `jf`). */
  readonly lateness = new MovingAverage(15);
  /** Last frame assigned to one of its `delay` events: keeps its inputs monotonic (off `Id`). */
  lastFrame = 0;
  /** Per-event-type token buckets, created on first use (off `Ie`). */
  readonly limiters: (TokenBucket | null)[] = [];
  /** Ping the client declares in its ping messages (off `ad`), broadcast by the Ping event. */
  ping = 0;

  constructor(playerId: number) {
    this.playerId = playerId;
    for (let i = 0; i < EVENT_META.length; i++) this.limiters.push(null);
  }
}

/** A client broke the protocol; the host must drop it ("Bad actor"). off `r.l(n)` inside `Jh`. */
export class ProtocolViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolViolation';
  }
}

/** Where the sequencer sends what it broadcasts. */
export interface SequencerSink {
  /**
   * Sends `data` to every client that already received its snapshot (official
   * `jd`: connections with `dd`), except the player ids in `skip` (non-null
   * only while private views exist). `data` is only valid during the call.
   */
  broadcast(data: Uint8Array, channel: number, skip?: ReadonlySet<number> | null): void;
  /** Sends `data` to one ready client (private views). `data` is only valid during the call. */
  sendTo?(playerId: number, data: Uint8Array, channel: number): void;
  /** Official `Ha.length > 0`: some connection exists (joined or still handshaking). */
  hasConnections(): boolean;
}

/**
 * Pre-broadcast hook for client events (node-haxball `onOperationReceived`
 * style). Runs after the frame is assigned and after the official `fg`
 * validation (chat filter). Return `false` to drop the event (not applied,
 * not broadcast); payload fields may be mutated. Throwing drops the client
 * ("Bad actor"). Do not change `frame`/`order`/`byId`.
 */
export type BeforeOperationHook = (ev: RoomEvent, byId: number, requestedFrame: number) => boolean | void;

export interface SequencerOptions {
  /** Input delay `Sb` in frames (official 2). */
  inputDelayFrames?: number;
}

/**
 * A client whose world differs from the room's (haxlite private views):
 * `rs` is an exact copy of that client's simulation, fed the same event
 * stream it receives (with its private events) and stepped in lockstep with
 * the room, so its CheckConsistency can carry the hash of ITS world.
 */
export class ViewerWorld {
  readonly playerId: number;
  readonly rs: RoomState;

  constructor(playerId: number, rs: RoomState) {
    this.playerId = playerId;
    this.rs = rs;
  }
}

/** Exact copy of a room state (the join snapshot's serialization round trip). */
export function cloneRoomState(rs: RoomState): RoomState {
  const w = new Writer(4096);
  writeRoomState(w, rs);
  return readRoomState(new Reader(w.finish()));
}

/** Byte equality of the serialized states (= same world, same checksum). */
export function sameRoomState(a: RoomState, b: RoomState): boolean {
  const wa = new Writer(4096);
  writeRoomState(wa, a);
  const wb = new Writer(4096);
  writeRoomState(wb, b);
  const x = wa.finish();
  const y = wb.finish();
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

export class Sequencer {
  readonly rs: RoomState;
  private readonly sink: SequencerSink;

  /** Current frame (off `da`). */
  frame = 0;
  /** Events applied (or reserved) in the current frame (off `Ra`). */
  eventsInFrame = 0;
  /** Events of all closed frames (off `od`): the counter sent in heartbeats/snapshots. */
  eventCounter = 0;
  /** Accepted events scheduled for future frames, sorted by (frame, order) (off `Xd.list`). */
  readonly queue: RoomEvent[] = [];
  /** off `Sb`. */
  inputDelayFrames: number;
  /** Extra frames for the host's own `delay` events (off `Kg`, always 0 in the headless). */
  handicapFrames = 0;
  /** Frame of the last heartbeat sent (off `df`). */
  lastHeartbeatFrame = 0;
  /** Frame of the last CheckConsistency (off `cf`). */
  lastChecksumFrame = 0;

  /** Called after each event is applied (official `Ab`, used by the recorder). */
  onEventApplied: ((ev: RoomEvent) => void) | null = null;
  /** Debug/test: called after each simulated step with the new frame (disables the idle fast path). */
  onFrameStepped: ((frame: number) => void) | null = null;
  onBeforeOperation: BeforeOperationHook | null = null;
  /** Exceptions thrown by room hooks while applying events or stepping (they never abort the loop). */
  onError: ((err: unknown) => void) | null = null;

  /**
   * Private views (clients whose world differs from the room's), in creation
   * order. Empty in normal operation: every path below checks the length first.
   */
  readonly views: ViewerWorld[] = [];
  /** Player ids of {@link views} (the `skip` set of broadcasts that have per-view variants). */
  private readonly viewIds = new Set<number>();
  /** Called when a view is dropped because its world became identical to the room's again. */
  onViewConverged: ((playerId: number) => void) | null = null;

  private depth = 0;
  private readonly out = new Writer(256);

  constructor(rs: RoomState, sink: SequencerSink, opts: SequencerOptions = {}) {
    this.rs = rs;
    this.sink = sink;
    this.inputDelayFrames = opts.inputDelayFrames ?? INPUT_DELAY_FRAMES;
  }

  /** True while events are being applied or frames simulated (room hooks are running). */
  get busy(): boolean {
    return this.depth > 0;
  }

  // ================================================================ runner (`Ma`)

  /**
   * Simulates `n` frames (official `Ma.rg`): before each step, the queued
   * events of the current frame; after the last step, the queued events of
   * the new frame whose order is consecutive. Frames without a game and
   * without events are skipped in O(1) (stepping them is a no-op).
   */
  advance(n: number): void {
    if (n <= 0) return;
    const list = this.queue;
    const rs = this.rs;
    const count = list.length;
    let c = 0;
    let e = 0;
    this.depth++;
    try {
      while (e < n) {
        if (rs.gameState === null && this.onFrameStepped === null && (this.views.length === 0 || this.viewsIdle())) {
          const next = c < count ? list[c]!.frame : Infinity;
          if (next > this.frame) {
            const skip = Math.min(next - this.frame, n - e);
            this.eventCounter += this.eventsInFrame;
            this.eventsInFrame = 0;
            this.frame += skip;
            e += skip;
            continue;
          }
        }
        ++e;
        while (c < count) {
          const ev = list[c]!;
          if (ev.frame !== this.frame) break;
          this.applyEvent(ev);
          ++c;
        }
        try {
          stepRoom(rs);
        } catch (err) {
          this.reportError(err);
        }
        if (this.views.length > 0) this.stepViews();
        this.eventCounter += this.eventsInFrame;
        this.eventsInFrame = 0;
        this.frame++;
        if (this.onFrameStepped !== null) this.onFrameStepped(this.frame);
      }
      while (c < count) {
        const ev = list[c]!;
        if (ev.frame !== this.frame || ev.order !== this.eventsInFrame) break;
        this.applyEvent(ev);
        ++c;
      }
    } finally {
      if (c > 0) dropFirst(list, c);
      this.depth--;
    }
  }

  /**
   * Applies `ev` now if it belongs to the current frame, else queues it
   * (official `Ma.Cf`). Stamps `ev.order`.
   */
  submit(ev: RoomEvent): void {
    if (ev.frame === this.frame && ev.order <= this.eventsInFrame) {
      ev.order = this.eventsInFrame;
      this.depth++;
      try {
        this.applyEvent(ev);
      } finally {
        this.depth--;
      }
    } else {
      this.insert(ev);
    }
  }

  /** Sorted insert by (frame, order); a taken order is bumped to the next free one (official `gb.Di`). */
  private insert(ev: RoomEvent): void {
    const list = this.queue;
    const frame = ev.frame;
    let order = ev.order;
    let at = 0;
    for (let i = 0; i < list.length; i++) {
      const q = list[i]!;
      if (q.frame > frame) break;
      if (q.frame === frame) {
        if (q.order > order) break;
        if (q.order === order) ++order;
      }
      ++at;
    }
    ev.order = order;
    // in-place insert (splice would allocate its result array)
    let i = list.length;
    list.push(ev);
    for (; i > at; i--) list[i] = list[i - 1]!;
    list[at] = ev;
  }

  private applyEvent(ev: RoomEvent): void {
    try {
      ev.apply(this.rs);
    } catch (err) {
      this.reportError(err);
    }
    if (this.views.length > 0) this.applyToViews(ev);
    if (this.onEventApplied !== null) this.onEventApplied(ev);
    this.eventsInFrame++;
  }

  // ================================================================ private views (haxlite)

  /** Sequenced events reach every view unchanged: apply them to each view's world too. */
  private applyToViews(ev: RoomEvent): void {
    const views = this.views;
    for (let i = 0; i < views.length; i++) {
      try {
        ev.apply(views[i]!.rs);
      } catch (err) {
        this.reportError(err);
      }
    }
    // StopGame / StartGame / SetStadium normally make the worlds identical again
    const t = ev.type;
    if (t === EventType.StopGame || t === EventType.StartGame || t === EventType.SetStadium) this.dropConvergedViews();
  }

  private stepViews(): void {
    const views = this.views;
    for (let i = 0; i < views.length; i++) {
      try {
        stepRoom(views[i]!.rs);
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  private viewsIdle(): boolean {
    const views = this.views;
    for (let i = 0; i < views.length; i++) if (views[i]!.rs.gameState !== null) return false;
    return true;
  }

  /** The view of `playerId`, or null. */
  getView(playerId: number): ViewerWorld | null {
    const views = this.views;
    for (let i = 0; i < views.length; i++) if (views[i]!.playerId === playerId) return views[i]!;
    return null;
  }

  /**
   * Starts tracking `playerId`'s world separately: a copy of the room state
   * at the current point of the sequence. Every queued event was already
   * sent to that client unchanged, so the copy applies the same ones.
   */
  ensureView(playerId: number): ViewerWorld {
    let v = this.getView(playerId);
    if (v === null) {
      v = new ViewerWorld(playerId, cloneRoomState(this.rs));
      this.views.push(v);
      this.viewIds.add(playerId);
    }
    return v;
  }

  /** Forgets a view (its client left). */
  dropView(playerId: number): void {
    const views = this.views;
    for (let i = 0; i < views.length; i++) {
      if (views[i]!.playerId !== playerId) continue;
      views.splice(i, 1);
      this.viewIds.delete(playerId);
      return;
    }
  }

  /** Drops every view whose world is byte-identical to the room's again ({@link onViewConverged}). */
  dropConvergedViews(): void {
    const views = this.views;
    for (let i = views.length - 1; i >= 0; i--) {
      const v = views[i]!;
      if (!sameRoomState(v.rs, this.rs)) continue;
      views.splice(i, 1);
      this.viewIds.delete(v.playerId);
      const cb = this.onViewConverged;
      if (cb !== null) {
        try {
          cb(v.playerId);
        } catch (err) {
          this.reportError(err);
        }
      }
    }
  }

  /**
   * A private slot: ONE sequenced host event at the current frame whose
   * content differs per client. Each viewer in `perViewer` (it must have a
   * view) gets its own event, applied to its world at this exact point;
   * every other client gets a no-op (SetDiscProperties with an empty mask).
   * Frame, order and event counters are identical for everyone, so
   * heartbeats and completeness checks are unaffected. The room's own state
   * is not touched (like CheckConsistency, the slot only takes an order).
   */
  privateSlot(perViewer: ReadonlyMap<number, RoomEvent>): void {
    const frame = this.frame;
    const order = this.eventsInFrame++;
    const noop = SetDiscPropertiesEvent.create(0, false, {});
    noop.frame = frame;
    noop.order = order;
    noop.byId = 0;
    noop.clientSeq = 0;
    const skip = new Set<number>();
    for (const [playerId, ev] of perViewer) {
      const v = this.getView(playerId);
      if (v === null) continue;
      ev.frame = frame;
      ev.order = order;
      ev.byId = 0;
      ev.clientSeq = 0;
      try {
        ev.apply(v.rs);
      } catch (err) {
        this.reportError(err);
      }
      skip.add(playerId);
      this.sendEvent(playerId, ev, Channel.ReliableUnordered);
    }
    this.broadcastEvent(noop, Channel.ReliableUnordered, skip);
    this.heartbeat();
  }

  private reportError(err: unknown): void {
    if (this.onError !== null) this.onError(err);
  }

  // ================================================================ host (`Wa`)

  /**
   * Host's own event (official `Wa.oc`): `byId = 0`, frame = current frame
   * (+ input delay + handicap for `delay` events), apply/queue, heartbeat,
   * then broadcast on `ru` when any connection exists.
   */
  hostEvent(ev: RoomEvent): void {
    ev.byId = 0;
    ev.clientSeq = 0;
    ev.order = 0;
    ev.frame = ev.meta.delay ? this.frame + this.inputDelayFrames + this.handicapFrames : this.frame;
    this.submit(ev);
    this.heartbeat();
    if (this.sink.hasConnections()) this.broadcastEvent(ev, Channel.ReliableUnordered);
  }

  /**
   * Frame for a client event (the arithmetic of official `Wa.Mh`):
   * clamp(requested, cur, cur+20); for `delay` events, a request more than
   * `Sb+3` frames late is moved to `cur+Sb`, otherwise its lateness (clamped
   * to ±Sb) feeds the 15-sample average; a chronically late client (average
   * < -0.85) gets no early frames; frames are monotonic per client.
   */
  assignClientFrame(client: SequencerClient, delay: boolean, requested: number): number {
    const cur = this.frame;
    const sb = this.inputDelayFrames;
    const target = cur + sb;
    const max = cur + MAX_EVENT_FRAME_LEAD;
    let f = requested < cur ? cur : requested > max ? max : requested;
    const lateness = requested - target;
    if (delay) {
      if (lateness < -sb - 3) f = target;
      else client.lateness.push(lateness < -sb ? -sb : lateness > sb ? sb : lateness);
      if (f < target && client.lateness.mean < -0.85) f = target;
      if (f < client.lastFrame) f = client.lastFrame;
      client.lastFrame = f;
    }
    return f;
  }

  /**
   * Client message 1 (official `Wa.Mh`), `r` positioned after the message
   * type byte: `u32 requestedFrame, u32 clientSeq, u8 type, payload`.
   * Order of checks = official: per-type rate limit, sender filter (`tb`:
   * host-only types throw, admin-only types are skipped silently), payload,
   * frame, `fg` validation (chat filter), {@link onBeforeOperation}, then
   * apply/queue and broadcast to every client (author included) on `ru`.
   * Throws {@link ProtocolViolation} (or a codec error) when the client must
   * be dropped.
   */
  clientMessage(client: SequencerClient, r: Reader, now: number): RoomEvent | null {
    const requested = r.u32();
    const clientSeq = r.u32();
    const type = r.u8();
    const ev = createEvent(type);
    const meta = EVENT_META[type]!;
    const limit = meta.rateLimit;
    if (limit !== null) {
      let bucket = client.limiters[type] ?? null;
      if (bucket === null) {
        bucket = new TokenBucket(limit.burst, limit.intervalMs, now);
        client.limiters[type] = bucket;
      }
      if (!bucket.take(now)) throw new ProtocolViolation(`rate limit exceeded (${meta.name})`);
    }
    const sender = checkClientSender(type, client.playerId, this.rs);
    if (sender === 'kick') throw new ProtocolViolation(`host-only event ${meta.name}`);
    if (sender === 'drop') {
      r.bytes(r.remaining);
      return null;
    }
    ev.read(r);
    ev.frame = this.assignClientFrame(client, meta.delay, requested);
    ev.order = 0;
    ev.clientSeq = clientSeq;
    ev.byId = client.playerId;
    if (!ev.validate(this.rs)) return null;
    const hook = this.onBeforeOperation;
    if (hook !== null && hook(ev, client.playerId, requested) === false) return null;
    this.submit(ev);
    this.broadcastEvent(ev, Channel.ReliableUnordered);
    return ev;
  }

  /** Message 3 `[u32 frame][u32 eventCounter]` on `uu` (official `Wa.Zd`). */
  heartbeat(): void {
    if (this.frame - this.lastHeartbeatFrame <= 0 || !this.sink.hasConnections()) return;
    const w = this.out.reset();
    w.u8(HostMsg.FrameSync);
    w.u32(this.frame);
    w.u32(this.eventCounter);
    this.sink.broadcast(w.finishShared(), Channel.Unreliable);
    this.lastHeartbeatFrame = this.frame;
  }

  /**
   * CheckConsistency (official `Wa.Wh`): stamped at the current frame with
   * the next order, carries the hash of the state at that exact point; not
   * applied on the host, broadcast on `ro`.
   */
  checksum(): void {
    this.lastChecksumFrame = this.frame;
    if (!this.sink.hasConnections()) return;
    if (this.views.length > 0) this.dropConvergedViews();
    const ev = CheckConsistencyEvent.create(this.rs);
    ev.frame = this.frame;
    ev.order = this.eventsInFrame++;
    ev.byId = 0;
    ev.clientSeq = 0;
    const views = this.views;
    if (views.length === 0) {
      this.broadcastEvent(ev, Channel.ReliableOrdered);
      return;
    }
    // same frame/order for everyone; a private view gets the hash of ITS world
    this.broadcastEvent(ev, Channel.ReliableOrdered, this.viewIds);
    for (let i = 0; i < views.length; i++) {
      const v = views[i]!;
      const own = CheckConsistencyEvent.create(v.rs);
      own.frame = ev.frame;
      own.order = ev.order;
      own.byId = 0;
      own.clientSeq = 0;
      this.sendEvent(v.playerId, own, Channel.ReliableOrdered);
    }
  }

  /**
   * Clock-driven housekeeping (official `Wa.Da` after `rg`): heartbeat when
   * `heartbeatFrames` passed since the last one; heartbeat + CheckConsistency
   * every `checksumFrames`.
   */
  periodic(heartbeatFrames: number, checksumFrames: number): void {
    if (this.frame - this.lastHeartbeatFrame >= heartbeatFrames) this.heartbeat();
    if (this.frame - this.lastChecksumFrame >= checksumFrames) {
      this.heartbeat();
      this.checksum();
    }
  }

  /**
   * Join snapshot, message 1 (official `Wa.$h`): `[1] deflateRaw(u16 playerId,
   * u32 frame, u32 eventCounter, varuint eventsInFrame, RoomState, EventFrame*)`
   * with every queued future event. Returns a fresh array.
   */
  snapshot(playerId: number): Uint8Array {
    const inner = new Writer(2048);
    inner.u16(playerId);
    inner.u32(this.frame);
    inner.u32(this.eventCounter);
    inner.varUint(this.eventsInFrame);
    writeRoomState(inner, this.rs);
    const list = this.queue;
    for (let i = 0; i < list.length; i++) writeEventFrame(inner, list[i]!);
    const packed = deflateRaw(inner.finish());
    const out = new Uint8Array(packed.length + 1);
    out[0] = HostMsg.InitialSnapshot;
    out.set(packed, 1);
    return out;
  }

  /** Message 2 `[2] EventFrame` (official `Nd` + `rf`), broadcast on `channel`. */
  private broadcastEvent(ev: RoomEvent, channel: number, skip: ReadonlySet<number> | null = null): void {
    const w = this.out.reset();
    w.u8(HostMsg.Event);
    writeEventFrame(w, ev);
    this.sink.broadcast(w.finishShared(), channel, skip);
  }

  /** Message 2 to one client (private views). */
  private sendEvent(playerId: number, ev: RoomEvent, channel: number): void {
    const w = this.out.reset();
    w.u8(HostMsg.Event);
    writeEventFrame(w, ev);
    this.sink.sendTo?.(playerId, w.finishShared(), channel);
  }
}

/** Removes the first `n` items in place (splice would allocate its result array). */
function dropFirst<T>(list: T[], n: number): void {
  const len = list.length;
  for (let i = n; i < len; i++) list[i - n] = list[i]!;
  list.length = len - n;
}

/** Message 6 `[6][u8 type][payload]`: an event for one client, outside the sequence (official `Ef`). */
export function encodeTargetedEvent(ev: RoomEvent): Uint8Array {
  ev.byId = 0;
  const w = new Writer(64);
  w.u8(HostMsg.TargetedEvent);
  writeEvent(w, ev);
  return w.copyBytes();
}

/** Message 4 `[4][f64 hostFrame + Sb][f64 echo]` (official `Kh`). */
export function encodePong(w: Writer, hostFrame: number, echo: number): Uint8Array {
  w.reset();
  w.u8(HostMsg.Pong);
  w.f64(hostFrame);
  w.f64(echo);
  return w.finishShared();
}
