/**
 * Allocation-free datagram I/O on a bound `node:dgram` socket, by talking to
 * its libuv handle (`UDPWrap`) the way `node:dgram` itself does.
 *
 * Why: with N = 20 players the endpoint sends ~2 600 and receives ~1 500
 * datagrams/s, and `node:dgram` builds garbage around every one of them —
 * `send()`: the buffer list, the `lookup` continuation, the rest-args array
 * of the async-id scope and a `SendWrap` with three properties (~260 B per
 * datagram, ~0.69 MB/s); the `'message'` path: `rinfo.size` (a property
 * store that grows the object) and the `EventEmitter` dispatch (~0.1 MB/s).
 * That young-generation churn was most of the host's GC.
 *
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
 * Everything is feature-detected; if Node's internals ever change shape the
 * plain `socket.send()` / `'message'` path is used instead.
 */
import type { RemoteInfo, Socket } from 'node:dgram';

/** The bits of `UDPWrap` used here (src/udp_wrap.cc). */
interface UdpHandle {
  send(req: object, list: Uint8Array[], count: number, port: number, address: string, hasCallback: boolean): unknown;
  onmessage: ((nread: number, handle: UdpHandle, buf?: Buffer, rinfo?: RemoteInfo) => void) | null | undefined;
}

type SendReq = { list?: Uint8Array[] };

/** The socket's `UDPWrap` (dgram keeps it in `socket[kStateSymbol].handle`), or null. */
function handleOf(sock: Socket): UdpHandle | null {
  for (const sym of Object.getOwnPropertySymbols(sock)) {
    if (sym.description !== 'state symbol') continue;
    const state = (sock as unknown as Record<symbol, unknown>)[sym] as { handle?: unknown } | null;
    const h = state !== null && typeof state === 'object' ? (state.handle as UdpHandle | null | undefined) : null;
    if (h != null && typeof h === 'object' && typeof h.send === 'function' && 'onmessage' in h) return h;
  }
  return null;
}

export type DatagramHandler = (msg: Buffer, rinfo: RemoteInfo) => void;

/** One bound socket's send/receive paths (see the file comment). */
export class UdpIo {
  readonly sock: Socket;
  private readonly handle: UdpHandle | null;
  /** `SendWrap` (captured from dgram's first send), null until then / if unavailable. */
  private Req: (new () => SendReq) | null = null;
  private req: SendReq | null = null;
  private list: Uint8Array[] = [];
  /** The capture was attempted (once). */
  private probed = false;
  /** Datagrams that went through the direct path (diagnostics / tests). */
  directSends = 0;

  constructor(sock: Socket, onDatagram: DatagramHandler, onError: (err: Error) => void) {
    this.sock = sock;
    const h = handleOf(sock);
    this.handle = h;
    sock.on('error', onError);
    if (h !== null && typeof h.onmessage === 'function') {
      h.onmessage = (nread, _handle, buf, rinfo) => {
        if (nread < 0 || buf === undefined || rinfo === undefined) {
          // the rare recvmsg error: reported like dgram does, as an 'error' event
          (sock as unknown as { emit(e: string, err: Error): void }).emit('error', new Error(`recvmsg failed (${nread})`));
          return;
        }
        onDatagram(buf, rinfo);
      };
    } else {
      sock.on('message', onDatagram);
    }
  }

  /**
   * Sends one datagram. When this returns `true` the kernel already has a
   * copy (the buffer may be reused at once); `false` means it may still be
   * referenced (queued by libuv, or dgram's path) — the caller must not
   * overwrite it.
   */
  send(buf: Uint8Array, port: number, address: string): boolean {
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

  private newReq(): void {
    const req = new (this.Req as new () => SendReq)();
    const list: Uint8Array[] = [];
    req.list = list; // keeps the buffer alive if this request is ever queued
    this.req = req;
    this.list = list;
  }

  /**
   * dgram's own send. The first one also captures `SendWrap`: a one-shot
   * wrapper on the handle sees the `req` dgram builds (synchronously with the
   * endpoint's literal lookup, after the DNS hop otherwise) and removes itself.
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
    this.sock.send(buf, port, address);
    return this.sock.getSendQueueCount() === 0;
  }
}
