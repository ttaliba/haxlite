/**
 * Safe node-datachannel usage: native lifetime tracking, exception-proof
 * callbacks and process-level teardown. Every PeerConnection/DataChannel the
 * net layer creates goes through here.
 *
 * Two node-datachannel (0.33.x, libdatachannel 0.24.x) hazards kill the whole
 * process, so a single bad peer could take a full room down:
 *
 * 1. **A JS exception thrown from inside any native callback aborts the
 *    process** (`terminate called after throwing an instance of
 *    'Napi::Error'`, SIGABRT): the thread-safe-function trampoline calls the
 *    JS callback without a C++ try/catch. {@link guard} wraps every callback.
 *
 * 2. **Garbage-collecting a DataChannel JS wrapper before its native `closed`
 *    event has been delivered leaves a dangling pointer** in the binding's
 *    static `DataChannelWrapper::instances` set: `~DataChannelWrapper` only
 *    calls `doClose()`, and the instance is erased only by the `closed`
 *    thread-safe callback's cleanup, which a destroyed wrapper aborts. The
 *    next `cleanup()` (`CloseAll`/`CleanupAll`) then dereferences freed memory
 *    (SIGSEGV, or SIGABRT from `free()`). The window is a GC between
 *    `dc.close()` (or a remote close) and the next event-loop turn, so it hit
 *    ~1 in 10 full test runs (SIGSEGV, SIGABRT, or a deadlock inside
 *    `cleanup()` → `DataChannelWrapper::CleanupAll` → `~ThreadSafeCallback`).
 *    Worse, libdatachannel sometimes never emits `closed` at all for a
 *    channel closed from both ends at once (seen on the unreliable channel,
 *    ~1 per 1000 sessions), so its wrapper is *guaranteed* to dangle once
 *    collected. Fix: every wrapper is kept strongly reachable here until its
 *    native close is confirmed (DataChannel `closed`, PeerConnection state
 *    `closed`) — channels that never confirm stay referenced until
 *    `cleanup()` — and {@link shutdownWebRtc} waits for the PeerConnections
 *    before calling `cleanup()`.
 *
 * Closes are also deferred to `setImmediate` ({@link closeNative}) so the
 * library is never re-entered from inside one of its own callbacks.
 */
import {
  PeerConnection,
  cleanup,
  type DataChannel,
  type DataChannelInitConfig,
  type RtcConfig,
} from 'node-datachannel';

type ErrorSink = ((err: Error) => void) | null | undefined;

/** Wrappers whose native close has not been confirmed yet (kept strongly reachable). */
const livePcs = new Map<PeerConnection, string>();
const liveDcs = new Map<DataChannel, { name: string; pc: PeerConnection }>();
/** Wrappers whose close() was requested but not executed yet. */
const closeQueue: (PeerConnection | DataChannel)[] = [];
let closeScheduled = false;
let createdCount = 0;
let drainWaiters: (() => void)[] = [];

export interface WebRtcStats {
  /** PeerConnections created and not yet confirmed closed. */
  peerConnections: number;
  /** DataChannels not yet confirmed closed whose PeerConnection is still live. */
  dataChannels: number;
  /**
   * DataChannels whose PeerConnection is closed but whose own `closed` event
   * never came. libdatachannel loses it now and then (~1 in 1000 sessions,
   * always the unreliable channel, when both sides close at once); such a
   * wrapper must stay referenced until `cleanup()` (see the module comment),
   * so these are a tiny bounded leak, not live connections.
   */
  orphanedDataChannels: number;
  /** close() calls queued for the next `setImmediate`. */
  pendingCloses: number;
  /** Total natives created since load (PCs + DCs). */
  created: number;
}

/** Names of the natives not yet confirmed closed (diagnostics: `pc-name` / `pc-name/label [state]`). */
export function liveWebRtcObjects(): string[] {
  const out: string[] = [];
  for (const [pc, name] of livePcs) out.push(`${name} [${safeState(() => pc.state())}]`);
  for (const [dc, r] of liveDcs) {
    out.push(`${r.name} [${safeState(() => (dc.isOpen() ? 'open' : 'not open'))}${livePcs.has(r.pc) ? '' : ', orphaned'}]`);
  }
  return out;
}

function safeState(f: () => string): string {
  try {
    return f();
  } catch {
    return 'destroyed';
  }
}

/** Live native objects (leak tracking / diagnostics). */
export function webRtcStats(): WebRtcStats {
  let orphans = 0;
  for (const r of liveDcs.values()) if (!livePcs.has(r.pc)) orphans++;
  return {
    peerConnections: livePcs.size,
    dataChannels: liveDcs.size - orphans,
    orphanedDataChannels: orphans,
    pendingCloses: closeQueue.length,
    created: createdCount,
  };
}

function report(onError: ErrorSink, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    if (onError) onError(e);
    else console.error('[haxlite/net] error in WebRTC callback:', e);
  } catch {
    /* the error sink itself threw: nothing else to do, but never propagate */
  }
}

/**
 * Wraps a native callback so it can never throw back into node-datachannel
 * (which would abort the process).
 */
export function guard<A extends unknown[]>(fn: (...args: A) => void, onError: ErrorSink): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (err) {
      report(onError, err);
    }
  };
}

/**
 * {@link guard} for one-argument callbacks (the per-message hot path): same
 * guarantee without the rest-parameter array per call.
 */
export function guard1<T>(fn: (arg: T) => void, onError: ErrorSink): (arg: T) => void {
  return (arg: T) => {
    try {
      fn(arg);
    } catch (err) {
      report(onError, err);
    }
  };
}

/** Every PeerConnection confirmed closed (remaining DataChannels are orphans). */
function released(): void {
  if (livePcs.size === 0 && closeQueue.length === 0 && drainWaiters.length > 0) {
    const w = drainWaiters;
    drainWaiters = [];
    for (const f of w) f();
  }
}

/**
 * Drops our strong reference one turn later, after the binding's own cleanup
 * for the `closed` callback (it runs right after the JS callback returns).
 */
function releaseLater<T>(set: Map<T, unknown>, obj: T): void {
  setImmediate(() => {
    set.delete(obj);
    released();
  });
}

export interface PeerConnectionHandlers {
  onStateChange?: (state: string) => void;
  onLocalCandidate?: (candidate: string, mid: string) => void;
  onGatheringStateChange?: (state: string) => void;
  onError?: ErrorSink;
}

/** `new PeerConnection` + guarded callbacks + lifetime tracking. Throws like the constructor. */
export function createPeerConnection(name: string, config: RtcConfig, h: PeerConnectionHandlers): PeerConnection {
  const pc = new PeerConnection(name, config);
  createdCount++;
  livePcs.set(pc, name);
  try {
    const onState = h.onStateChange;
    pc.onStateChange(
      guard((state: string) => {
        if (state === 'closed') releaseLater(livePcs, pc);
        onState?.(state);
      }, h.onError),
    );
    if (h.onLocalCandidate) pc.onLocalCandidate(guard(h.onLocalCandidate, h.onError));
    if (h.onGatheringStateChange) pc.onGatheringStateChange(guard(h.onGatheringStateChange, h.onError));
  } catch (err) {
    closeNative(pc);
    throw err;
  }
  return pc;
}

export interface DataChannelHandlers {
  onOpen?: () => void;
  onClosed?: () => void;
  onMessage?: (msg: string | Buffer | ArrayBuffer) => void;
  onError?: ErrorSink;
}

/** `pc.createDataChannel` + guarded callbacks + lifetime tracking. Throws like the original. */
export function createDataChannel(
  pc: PeerConnection,
  label: string,
  init: DataChannelInitConfig,
  h: DataChannelHandlers,
): DataChannel {
  const dc = pc.createDataChannel(label, init);
  createdCount++;
  liveDcs.set(dc, { name: `${livePcs.get(pc) ?? '?'}/${label}`, pc });
  const onClosed = h.onClosed;
  // `closed` first: it is what releases the wrapper.
  dc.onClosed(
    guard(() => {
      releaseLater(liveDcs, dc);
      onClosed?.();
    }, h.onError),
  );
  if (h.onOpen) dc.onOpen(guard(h.onOpen, h.onError));
  if (h.onMessage) dc.onMessage(guard1(h.onMessage, h.onError));
  return dc;
}

/**
 * Closes a PeerConnection/DataChannel on the next `setImmediate`, never from
 * inside a native callback. Idempotent; the wrapper stays referenced until
 * the native side confirms the close.
 */
export function closeNative(obj: PeerConnection | DataChannel): void {
  closeQueue.push(obj);
  if (closeScheduled) return;
  closeScheduled = true;
  setImmediate(runCloses);
}

function runCloses(): void {
  closeScheduled = false;
  // DataChannels before their PeerConnection keeps libdatachannel's teardown ordered.
  const batch = closeQueue.splice(0);
  for (let pass = 0; pass < 2; pass++) {
    for (const obj of batch) {
      if ((pass === 0) === (obj instanceof PeerConnection)) continue;
      try {
        obj.close();
      } catch {
        /* already closed / destroyed */
      }
    }
  }
  released();
}

let shutdownPromise: Promise<void> | null = null;

/**
 * Process-level node-datachannel teardown. libdatachannel keeps worker
 * threads alive; call this once when the process is done with WebRTC (after
 * every HostTransport has been stopped) so Node can exit.
 *
 * Waits (up to `timeoutMs`) until every PeerConnection has confirmed its
 * close, then calls node-datachannel's `cleanup()` while every DataChannel
 * wrapper that did not confirm its own close is still referenced (calling it
 * with collectable wrappers is what used to crash). If new natives are created while waiting
 * (a room was started again), the cleanup is skipped. Safe to call several
 * times and without awaiting.
 */
export function shutdownWebRtc(timeoutMs = 5_000): Promise<void> {
  if (shutdownPromise !== null) return shutdownPromise;
  const p = doShutdown(timeoutMs).finally(() => {
    shutdownPromise = null;
  });
  shutdownPromise = p;
  return p;
}

async function doShutdown(timeoutMs: number): Promise<void> {
  const generation = createdCount;
  if (livePcs.size > 0 || closeQueue.length > 0) {
    // ask every live native to close (normally the transports already did)
    for (const dc of liveDcs.keys()) closeNative(dc);
    for (const pc of livePcs.keys()) closeNative(pc);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
      drainWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (createdCount !== generation) return; // WebRTC in use again
  try {
    cleanup();
  } catch (err) {
    report(null, err);
  }
  // After cleanup() the binding no longer references any wrapper: safe to let them go.
  livePcs.clear();
  liveDcs.clear();
  released();
}
