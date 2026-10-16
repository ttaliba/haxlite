/**
 * Allocation-light datagram I/O on a bound `node:dgram` socket, by talking
 * to the runtime's native socket under it the way `node:dgram` itself does.
 *
 * Why: with N = 20 players the endpoint sends ~2 600 and receives ~1 500
 * datagrams/s, and `node:dgram` builds garbage around every one of them —
 * `send()`: the buffer list, the `lookup` continuation, the rest-args array
 * of the async-id scope and a `SendWrap` with three properties (~260 B per
 * datagram, ~0.69 MB/s); the `'message'` path: `rinfo.size` (a property
 * store that grows the object) and the `EventEmitter` dispatch (~0.1 MB/s).
 * That young-generation churn was most of the host's GC.
 *
 * Node (libuv `UDPWrap`, `socket[kStateSymbol].handle`):
 * - Send: `handle.send(req, list, 1, port, ip, false)` with one reused
 *   `SendWrap` and one reused one-element list. Synchronous success returns
 *   `length + 1` (libuv `uv_udp_try_send`): nothing is retained. Only when
 *   the kernel queue is full (EAGAIN) does the C++ side adopt `req` (which
 *   keeps `list`, hence the buffer, alive until the send completes): then a
 *   fresh pair is made. `SendWrap` is not public: its constructor is taken
 *   from the first `req` that `dgram` itself passes to the handle.
 * - Receive: `handle.onmessage` (what `UDPWrap::OnRecv` calls) is pointed
 *   straight at the endpoint, skipping `dgram`'s `onMessage` + `emit`.
 *   The Buffer and the `rinfo` object are still made by the C++ side for
 *   every datagram (~290 B, ~0.44 MB/s at N = 20): not avoidable from JS.
 *
 * Bun (its dgram is a JS layer over a native `Bun.udpSocket`, kept in
 * `socket[kStateSymbol].handle.socket`; Bun's handle never calls `onmessage`):
 * - Send: `native.send(buf, port, ip)` (synchronous `sendto`, `true` when the
 *   kernel took it) instead of dgram's `send` → lookup → `handleSend`, which
 *   builds the same garbage as Node's plus two Buffer views per datagram.
 *   `false` (kernel queue full) hands the datagram to dgram, which queues it
 *   (keeping a view of the buffer) and resends it from the native `drain`
 *   callback; while dgram's queue is non-empty every send goes through it
 *   so that the order is kept.
 * - Receive: `native.reload({ socket: { data, drain, error } })` replaces
 *   dgram's handlers (the whole `socket` set: a bare `data` is ignored) —
 *   `data(sock, buf, port, address)` straight to the endpoint, no `rinfo`
 *   and no `emit`; `drain` and `error` do what dgram's own did.
 * - Batching ({@link beginUdpBatch}/{@link endUdpBatch}): the datagrams sent
 *   in between are copied into a per-socket ring and leave in one
 *   `sendMany` call (`sendmmsg(2)` on Linux: one syscall per batch).
 *   Measured on Windows, 2 × 100 k loopback datagrams of 200 B through
 *   UdpIo: 9.7–11.7 µs CPU per datagram (send + receive) with dgram's path,
 *   see the commit message for the native numbers.
 *
 * Everything is feature-detected; if a runtime's internals ever change shape
 * the plain `socket.send()` / `'message'` path is used instead.
 */
import type { RemoteInfo, Socket } from 'node:dgram';
import { isIP } from 'node:net';

/**
 * dgram `lookup` for IP literals: answers synchronously. Every address the
 * rtc endpoint and the edge tunnel bind or send to is an IP literal (validated
 * public/bind addresses, kernel-reported sources), so the default `dns.lookup`
 * only adds a `process.nextTick` hop and two closures per datagram — and makes
 * the send asynchronous, which would forbid reusing the send buffer.
 */
export function literalLookup(address: string, family: unknown, cb: (err: Error | null, address: string, family: number) => void): void {
  cb(null, address, typeof family === 'number' ? family : isIP(address));
}

/** The bits of Node's `UDPWrap` used here (src/udp_wrap.cc). */
interface UdpHandle {
  send(req: object, list: Uint8Array[], count: number, port: number, address: string, hasCallback: boolean): unknown;
  onmessage: ((nread: number, handle: UdpHandle, buf?: Buffer, rinfo?: RemoteInfo) => void) | null | undefined;
}

/** Bun's native UDP socket (`Bun.udpSocket`), the bits used here. */
interface BunNativeSocket {
  send(data: Uint8Array, port: number, address: string): boolean;
  /** Flat `[data, port, address, …]` list; returns how many datagrams the kernel took. */
  sendMany(packets: readonly unknown[]): number;
  reload(handlers: { socket: BunSocketHandlers }): void;
}

interface BunSocketHandlers {
  data(sock: unknown, buf: Buffer, port: number, address: string): void;
  drain(sock: unknown): void;
  error(err: Error & { syscall?: string; errqueue?: boolean }): void;
}

/** Bun's dgram handle (a JS object): the native socket, dgram's send queue and its drain. */
interface BunDgramHandle {
  socket: BunNativeSocket | null | undefined;
  /** dgram's queue of datagrams the kernel refused (undefined when empty). */
  sendQueue: unknown;
  drain(): void;
}

type SendReq = { list?: Uint8Array[] };

const IS_BUN = typeof (process.versions as Record<string, string | undefined>).bun === 'string';

/** dgram's internal state (`socket[kStateSymbol]`), or null. */
function stateOf(sock: Socket): { handle?: unknown } | null {
  for (const sym of Object.getOwnPropertySymbols(sock)) {
    if (sym.description !== 'state symbol') continue;
    const state = (sock as unknown as Record<symbol, unknown>)[sym];
    if (state !== null && typeof state === 'object') return state as { handle?: unknown };
  }
  return null;
}

/** Node's `UDPWrap` of the socket, or null (Bun mimics the shape but never calls `onmessage`). */
function udpWrapOf(sock: Socket): UdpHandle | null {
  if (IS_BUN) return null;
  const h = stateOf(sock)?.handle as UdpHandle | null | undefined;
  if (h != null && typeof h === 'object' && typeof h.send === 'function' && 'onmessage' in h) return h;
  return null;
}

/** Bun's dgram handle with a usable native socket, or null. Shape-detected (also used by tests under Node). */
function bunHandleOf(sock: Socket): BunDgramHandle | null {
  const h = stateOf(sock)?.handle as Partial<BunDgramHandle> | null | undefined;
  if (h == null || typeof h !== 'object' || typeof h.drain !== 'function') return null;
  const n = h.socket;
  if (n == null || typeof n !== 'object') return null;
  if (typeof n.send !== 'function' || typeof n.sendMany !== 'function' || typeof n.reload !== 'function') return null;
  return h as BunDgramHandle;
}

/** Called with every received datagram (`buf` is the runtime's, owned by the callee). */
export type DatagramHandler = (msg: Buffer, address: string, port: number) => void;

/** Ring slot size: one DTLS record of an MTU-sized SCTP packet fits with room to spare. */
const BATCH_SLOT = 2048;
/** Datagrams per `sendMany` (a full ring is sent at once and reused). */
const BATCH_MAX = 64;

let batchDepth = 0;
/** UdpIo instances with datagrams waiting for {@link endUdpBatch}. */
const batchPending: UdpIo[] = [];

/**
 * Starts a send batch (nestable): until the matching {@link endUdpBatch},
 * datagrams sent through a UdpIo that supports `sendMany` (Bun) are copied
 * aside and sent together. No-op on Node.
 */
export function beginUdpBatch(): void {
  batchDepth++;
}

/** Ends a {@link beginUdpBatch} scope; the outermost one sends everything batched. Never throws. */
export function endUdpBatch(): void {
  if (batchDepth === 0 || --batchDepth > 0) return;
  for (let i = 0; i < batchPending.length; i++) {
    const io = batchPending[i]!;
    batchPending[i] = null as unknown as UdpIo;
    io.flushBatch();
  }
  batchPending.length = 0;
}

/** One bound socket's send/receive paths (see the file comment). */
export class UdpIo {
  readonly sock: Socket;
  /** Node's UDPWrap (direct path), or null. */
  private readonly handle: UdpHandle | null;
  /** `SendWrap` (captured from dgram's first send), null until then / if unavailable. */
  private Req: (new () => SendReq) | null = null;
  private req: SendReq | null = null;
  private list: Uint8Array[] = [];
  /** The capture was attempted (once). */
  private probed = false;
  /** Bun's dgram handle (native path), or null. */
  private readonly bun: BunDgramHandle | null = null;
  private readonly native: BunNativeSocket | null = null;
  /** Batch ring (Bun): slots, their last exact-length view, the flat sendMany list. */
  private slots: Buffer[] = [];
  private views: Buffer[] = [];
  private packets: unknown[] = [];
  private batched = 0;
  /** Datagrams that went through a direct (non-dgram) path (diagnostics / tests). */
  directSends = 0;
  /** `sendMany` calls made (diagnostics / tests). */
  batchSends = 0;

  constructor(sock: Socket, onDatagram: DatagramHandler, onError: (err: Error) => void) {
    this.sock = sock;
    sock.on('error', onError);
    const emitError = (err: Error) => (sock as unknown as { emit(e: string, err: Error): void }).emit('error', err);
    const bun = bunHandleOf(sock);
    if (bun !== null) {
      const native = bun.socket as BunNativeSocket;
      try {
        native.reload({
          socket: {
            data: (_s, buf, port, address) => onDatagram(buf, address, port),
            drain: () => bun.drain(),
            error: (err) => {
              // as dgram: recv errors become recvmsg errors, ICMP error-queue reports are not errors
              if (err?.syscall === 'recv') {
                if (err.errqueue === true) return;
                err.syscall = 'recvmsg';
              }
              emitError(err);
            },
          },
        });
        this.bun = bun;
        this.native = native;
      } catch {
        /* unexpected shape: dgram's own path below */
      }
    }
    if (this.bun !== null) {
      this.handle = null;
      return;
    }
    const h = udpWrapOf(sock);
    this.handle = h;
    if (h !== null && typeof h.onmessage === 'function') {
      h.onmessage = (nread, _handle, buf, rinfo) => {
        if (nread < 0 || buf === undefined || rinfo === undefined) {
          // the rare recvmsg error: reported like dgram does, as an 'error' event
          emitError(new Error(`recvmsg failed (${nread})`));
          return;
        }
        onDatagram(buf, rinfo.address, rinfo.port);
      };
    } else {
      sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => onDatagram(msg, rinfo.address, rinfo.port));
    }
  }

  /** Whether this socket can batch sends ({@link beginUdpBatch}). */
  get batches(): boolean {
    return this.native !== null;
  }

  /**
   * Sends one datagram. When this returns `true` the kernel already has a
   * copy, or this object made its own (the buffer may be reused at once);
   * `false` means it may still be referenced (queued by libuv, or dgram's
   * path) — the caller must not overwrite it.
   */
  send(buf: Uint8Array, port: number, address: string): boolean {
    const native = this.native;
    if (native !== null) {
      if (batchDepth > 0) {
        if (buf.length <= BATCH_SLOT) return this.enqueue(buf, port, address);
        this.flushBatch(); // larger than a slot (rare): sent at once, after what is batched
      }
      return this.bunSend(native, buf, port, address);
    }
    const req = this.req;
    if (req !== null) {
      const list = this.list;
      list[0] = buf;
      const r = (this.handle as UdpHandle).send(req, list, 1, port, address, false);
      if (typeof r === 'number') {
        this.directSends++;
        if (r >= 1) return true; // sent synchronously (length + 1)
        if (r === 0) {
          // EAGAIN: the C++ side adopted req (→ list → buf) until the send completes
          this.newReq();
          return false;
        }
        return true; // error (closed socket, EMSGSIZE…): dropped, like dgram without a callback
      }
      this.req = null; // unexpected: back to dgram for good
      this.Req = null;
      return this.sock.getSendQueueCount() === 0;
    }
    return this.slowSend(buf, port, address);
  }

  private bunSend(native: BunNativeSocket, buf: Uint8Array, port: number, address: string): boolean {
    // dgram has datagrams queued (kernel queue was full): keep the order, queue behind them
    if ((this.bun as BunDgramHandle).sendQueue !== undefined) return this.slowSend(buf, port, address);
    let ok: boolean;
    try {
      ok = native.send(buf, port, address);
    } catch {
      return true; // closed socket / unsendable: dropped, like dgram without a callback
    }
    this.directSends++;
    // kernel queue full: dgram queues it (keeping a view of buf) and resends it on drain
    return ok || this.slowSend(buf, port, address);
  }

  /** Copies the datagram into the batch ring (Bun, inside a batch). */
  private enqueue(buf: Uint8Array, port: number, address: string): boolean {
    let i = this.batched;
    if (i === BATCH_MAX) {
      this.flushBatch();
      i = 0;
    }
    if (i === 0) batchPending.push(this);
    let slot = this.slots[i];
    if (slot === undefined) slot = this.slots[i] = Buffer.allocUnsafeSlow(BATCH_SLOT);
    slot.set(buf);
    const len = buf.length;
    let view = this.views[i];
    if (view === undefined || view.length !== len) view = this.views[i] = slot.subarray(0, len);
    const p = this.packets;
    const k = 3 * i;
    p[k] = view;
    p[k + 1] = port;
    p[k + 2] = address;
    this.batched = i + 1;
    return true;
  }

  /** Sends what {@link enqueue} collected (one `sendMany`). Called by {@link endUdpBatch}; never throws. */
  flushBatch(): void {
    const n = this.batched;
    if (n === 0) return;
    this.batched = 0;
    const native = this.native as BunNativeSocket;
    const p = this.packets;
    let sent = 0;
    if ((this.bun as BunDgramHandle).sendQueue === undefined) {
      try {
        if (n === 1) {
          sent = native.send(p[0] as Buffer, p[1] as number, p[2] as string) ? 1 : 0;
          this.directSends++;
        } else {
          if (p.length !== 3 * n) p.length = 3 * n;
          const r = native.sendMany(p);
          sent = typeof r === 'number' && r >= 0 ? Math.min(r, n) : 0;
          this.directSends += n;
          this.batchSends++;
        }
      } catch {
        // sendMany throws when the FIRST datagram fails (EACCES, EPERM, ENETUNREACH… for that
        // peer): one by one instead, so that one bad destination does not drop the whole batch
        // (and, being first again next time, every batch). A closed socket drops them all.
        if (n === 1) return;
        let queued = false;
        for (let i = 0; i < n; i++) {
          const buf = p[3 * i] as Buffer;
          const port = p[3 * i + 1] as number;
          const address = p[3 * i + 2] as string;
          if (!queued) {
            try {
              if (native.send(buf, port, address)) continue;
            } catch {
              continue; // this one is unsendable: dropped, like dgram without a callback
            }
            queued = true; // kernel queue full: this one and the rest go to dgram's queue, in order
          }
          this.slowSend(Buffer.from(buf), port, address);
        }
        return;
      }
    }
    // what the kernel refused goes to dgram's queue, as copies (the ring is reused by the next batch)
    for (let i = sent; i < n; i++) this.slowSend(Buffer.from(p[3 * i] as Buffer), p[3 * i + 1] as number, p[3 * i + 2] as string);
  }

  private newReq(): void {
    const req = new (this.Req as new () => SendReq)();
    const list: Uint8Array[] = [];
    req.list = list; // keeps the buffer alive if this request is ever queued
    this.req = req;
    this.list = list;
  }

  /**
   * dgram's own send. On Node the first one also captures `SendWrap`: a
   * one-shot wrapper on the handle sees the `req` dgram builds
   * (synchronously with the endpoint's literal lookup, after the DNS hop
   * otherwise) and removes itself.
   */
  private slowSend(buf: Uint8Array, port: number, address: string): boolean {
    const h = this.handle;
    if (h !== null && !this.probed) {
      this.probed = true;
      const own = Object.prototype.hasOwnProperty.call(h, 'send');
      const orig = h.send;
      const capture = (Req: unknown) => {
        if (typeof Req !== 'function' || Req === Object) return;
        try {
          this.Req = Req as new () => SendReq;
          this.newReq();
        } catch {
          this.Req = null;
          this.req = null;
        }
      };
      h.send = function (this: UdpHandle, req: object, ...rest: unknown[]) {
        if (own) h.send = orig;
        else delete (h as Partial<UdpHandle>).send;
        capture((req as { constructor?: unknown }).constructor);
        return (orig as (...a: unknown[]) => unknown).call(this, req, ...rest);
      };
    }
    try {
      this.sock.send(buf, port, address);
    } catch {
      return true; // closed socket: dropped
    }
    // Node: dgram may still hold buf (lookup hop, or a request libuv queued), so it is never
    // reported free; this path only runs for the probe send and when SendWrap is unavailable
    return IS_BUN && this.sock.getSendQueueCount() === 0;
  }
}
