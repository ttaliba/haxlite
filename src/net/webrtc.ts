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
 *    ~1 in 10 test runs. Fix: every wrapper is kept strongly reachable here
 *    until its native close is confirmed (DataChannel `closed`, PeerConnection
 *    state `closed`), and {@link shutdownWebRtc} waits for that before calling
 *    `cleanup()`.
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
const livePcs = new Set<PeerConnection>();
const liveDcs = new Set<DataChannel>();
/** Wrappers whose close() was requested but not executed yet. */
const closeQueue: (PeerConnection | DataChannel)[] = [];
let closeScheduled = false;
let createdCount = 0;
let drainWaiters: (() => void)[] = [];

export interface WebRtcStats {
  /** PeerConnections created and not yet confirmed closed. */
  peerConnections: number;
  /** DataChannels created and not yet confirmed closed. */
  dataChannels: number;
  /** close() calls queued for the next `setImmediate`. */
  pendingCloses: number;
  /** Total natives created since load (PCs + DCs). */
  created: number;
}

/** Live native objects (leak tracking / diagnostics). */
export function webRtcStats(): WebRtcStats {
  return { peerConnections: livePcs.size, dataChannels: liveDcs.size, pendingCloses: closeQueue.length, created: createdCount };
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

function released(): void {
  if (livePcs.size === 0 && liveDcs.size === 0 && closeQueue.length === 0 && drainWaiters.length > 0) {
    const w = drainWaiters;
    drainWaiters = [];
    for (const f of w) f();
  }
}

/**
 * Drops our strong reference one turn later, after the binding's own cleanup
 * for the `closed` callback (it runs right after the JS callback returns).
 */
function releaseLater<T>(set: Set<T>, obj: T): void {
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
  livePcs.add(pc);
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
  liveDcs.add(dc);
  const onClosed = h.onClosed;
  // `closed` first: it is what releases the wrapper.
  dc.onClosed(
    guard(() => {
      releaseLater(liveDcs, dc);
      onClosed?.();
    }, h.onError),
  );
  if (h.onOpen) dc.onOpen(guard(h.onOpen, h.onError));
  if (h.onMessage) dc.onMessage(guard(h.onMessage, h.onError));
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
 * Waits (up to `timeoutMs`) until every PeerConnection/DataChannel has
 * confirmed its close, then calls node-datachannel's `cleanup()` (calling it
 * earlier is what used to crash). If new natives are created while waiting
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
  if (livePcs.size > 0 || liveDcs.size > 0 || closeQueue.length > 0) {
    // ask every live native to close (normally the transports already did)
    for (const dc of liveDcs) closeNative(dc);
    for (const pc of livePcs) closeNative(pc);
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
