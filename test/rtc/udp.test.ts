import dgram, { type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { UdpIo, beginUdpBatch, endUdpBatch } from '../../src/rtc/udp.js';

const bound = (type: 'udp4' | 'udp6' = 'udp4'): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
    s.once('error', reject);
    s.bind(0, type === 'udp4' ? '127.0.0.1' : '::1', () => resolve(s));
  });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ipv6 = await bound('udp6').then(
  (s) => (s.close(), true),
  () => false,
);

const IS_BUN = typeof (process.versions as Record<string, string | undefined>).bun === 'string';

describe.runIf(IS_BUN)('UdpIo on Bun (real sockets: native send, reload, sendMany)', () => {
  const open: Socket[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  for (const type of ['udp4', 'udp6'] as const) {
    it.skipIf(type === 'udp6' && !ipv6)(`${type}: direct and batched sends, direct receive`, async () => {
      const a = await bound(type);
      const b = await bound(type);
      open.push(a, b);
      const host = type === 'udp4' ? '127.0.0.1' : '::1';
      const got: [string, string, number][] = [];
      const errors: Error[] = [];
      const ioA = new UdpIo(a, () => {}, (e) => errors.push(e));
      const ioB = new UdpIo(b, (m, address, port) => got.push([m.toString(), address, port]), (e) => errors.push(e));
      expect(ioA.batches).toBe(true);
      let emitted = 0;
      b.on('message', () => emitted++);
      const buf = Buffer.alloc(64);
      for (let i = 0; i < 10; i++) expect(ioA.send(buf.subarray(0, buf.write(`d${i}`)), b.address().port, host)).toBe(true);
      beginUdpBatch();
      for (let i = 10; i < 200; i++) expect(ioA.send(buf.subarray(0, buf.write(`d${i}`)), b.address().port, host)).toBe(true);
      endUdpBatch();
      expect(ioA.batchSends).toBe(3); // 64 + 64 + 62
      const t0 = Date.now();
      while (got.length < 200 && Date.now() - t0 < 2000) await tick(10);
      expect(got.map((g) => g[0])).toEqual(Array.from({ length: 200 }, (_, i) => `d${i}`));
      expect(got[0]![1]).toBe(host);
      expect(got[0]![2]).toBe(a.address().port);
      expect(emitted).toBe(0);
      expect(errors).toEqual([]);
    });
  }
});

describe.skipIf(IS_BUN)('UdpIo (direct UDPWrap send/receive)', () => {
  const open: Socket[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  for (const type of ['udp4', 'udp6'] as const) {
    it.skipIf(type === 'udp6' && !ipv6)(`${type}: sends through the reused SendWrap and receives through handle.onmessage`, async () => {
      const a = await bound(type);
      const b = await bound(type);
      open.push(a, b);
      const host = type === 'udp4' ? '127.0.0.1' : '::1';
      const got: [string, string, number][] = [];
      const errors: Error[] = [];
      const ioA = new UdpIo(a, (m, address, port) => got.push([m.toString(), address, port]), (e) => errors.push(e));
      const fromB: string[] = [];
      b.on('message', (m) => fromB.push(m.toString()));
      // dgram's 'message' is bypassed on the wrapped socket
      let emitted = 0;
      a.on('message', () => emitted++);

      const buf = Buffer.alloc(64);
      // the first send goes through dgram (default lookup: async) and captures SendWrap
      ioA.send(Buffer.from('msg 0'), b.address().port, host);
      await tick();
      for (let i = 1; i < 50; i++) {
        const n = buf.write(`msg ${i}`);
        // the buffer is reused at once whenever send() says the kernel has it
        expect(ioA.send(buf.subarray(0, n), b.address().port, host)).toBe(true);
      }
      expect(ioA.directSends).toBe(49);
      b.send('pong', a.address().port, host);
      await tick(100);
      expect(fromB).toEqual(Array.from({ length: 50 }, (_, i) => `msg ${i}`));
      expect(got.map((g) => g[0])).toEqual(['pong']);
      expect(got[0]![2]).toBe(b.address().port);
      expect(got[0]![1]).toBe(host);
      expect(emitted).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  it('drops sends after the socket is closed without throwing', async () => {
    const a = await bound();
    const b = await bound();
    open.push(b);
    const io = new UdpIo(a, () => {}, () => {});
    io.send(Buffer.from('x'), b.address().port, '127.0.0.1');
    await tick();
    io.send(Buffer.from('x'), b.address().port, '127.0.0.1');
    expect(io.directSends).toBe(1);
    a.close();
    expect(() => io.send(Buffer.from('y'), b.address().port, '127.0.0.1')).not.toThrow();
  });

  it('makes a fresh SendWrap when libuv queues a send (EAGAIN) and falls back to dgram on surprises', () => {
    // fake socket shaped like node:dgram's (state under a 'state symbol' key)
    class FakeReq {
      list?: Uint8Array[];
    }
    const calls: { req: FakeReq; list: Uint8Array[] }[] = [];
    let result: unknown = 6;
    const handle = {
      onmessage: () => {},
      send(req: FakeReq, list: Uint8Array[]) {
        calls.push({ req, list });
        return result;
      },
    };
    let dgramSends = 0;
    const sock = {
      [Symbol('state symbol')]: { handle },
      on() {},
      send(buf: Uint8Array) {
        dgramSends++;
        handle.send(new FakeReq(), [buf]);
      },
      getSendQueueCount: () => 0,
    } as unknown as Socket;
    const io = new UdpIo(sock, () => {}, () => {});
    const b = Buffer.from('hello');
    expect(io.send(b, 1, '127.0.0.1')).toBe(true); // through dgram: captures FakeReq
    expect(io.send(b, 1, '127.0.0.1')).toBe(true); // direct, synchronous
    const r1 = calls[1]!.req;
    expect(r1).toBeInstanceOf(FakeReq);
    expect(r1.list).toBe(calls[1]!.list);
    expect(io.send(b, 1, '127.0.0.1')).toBe(true);
    expect(calls[2]!.req).toBe(r1); // reused
    result = 0; // queued: req/list now belong to the pending send
    expect(io.send(b, 1, '127.0.0.1')).toBe(false);
    expect(calls[3]!.req).toBe(r1);
    expect(r1.list![0]).toBe(b);
    result = 6;
    expect(io.send(b, 1, '127.0.0.1')).toBe(true);
    expect(calls[4]!.req).not.toBe(r1);
    expect(calls[4]!.list).not.toBe(calls[3]!.list);
    expect(io.directSends).toBe(4);
    result = undefined; // unknown shape: back to dgram for good (this datagram is not resent)
    io.send(b, 1, '127.0.0.1');
    io.send(b, 1, '127.0.0.1');
    expect(dgramSends).toBe(2);
    expect(io.directSends).toBe(4);
  });
});

/**
 * A socket shaped like Bun's node:dgram: `socket[kStateSymbol].handle` is a JS
 * object holding the native `Bun.udpSocket` (`send`, `sendMany`, `reload`),
 * dgram's send queue and its `drain`. Lets the Bun path run under Node.
 */
function fakeBunSocket(opts: { reloadThrows?: boolean } = {}) {
  type Handlers = {
    data(s: unknown, buf: Buffer, port: number, address: string, flags?: unknown): void;
    drain(s: unknown): void;
    error(err: Error & { syscall?: string; errqueue?: boolean }): void;
  };
  const log = {
    sends: [] as [string, number, string][],
    many: [] as [string, number, string][][],
    dgramSends: [] as { bytes: string; buf: Uint8Array }[],
    drains: 0,
    accept: true,
    acceptMany: Infinity,
    closed: false,
    handlers: null as Handlers | null,
  };
  const native = {
    send(data: Uint8Array, port: number, address: string) {
      if (log.closed) throw new Error('Socket is closed');
      if (!log.accept) return false;
      log.sends.push([Buffer.from(data).toString(), port, address]);
      return true;
    },
    sendMany(p: unknown[]) {
      if (log.closed) throw new Error('Socket is closed');
      expect(p.length % 3).toBe(0);
      const n = Math.min(p.length / 3, log.acceptMany);
      const batch: [string, number, string][] = [];
      for (let i = 0; i < n; i++) batch.push([Buffer.from(p[3 * i] as Uint8Array).toString(), p[3 * i + 1] as number, p[3 * i + 2] as string]);
      log.many.push(batch);
      return n;
    },
    reload(h: { socket: Handlers }) {
      if (opts.reloadThrows) throw new Error('nope');
      expect(typeof h.socket.data).toBe('function');
      expect(typeof h.socket.drain).toBe('function');
      expect(typeof h.socket.error).toBe('function');
      log.handlers = h.socket;
    },
  };
  const handle = {
    socket: native,
    sendQueue: undefined as unknown,
    drain() {
      log.drains++;
    },
  };
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const sock = {
    [Symbol('state symbol')]: { handle },
    on(ev: string, f: (...a: unknown[]) => void) {
      (listeners[ev] ??= []).push(f);
      return sock;
    },
    emit(ev: string, ...a: unknown[]) {
      for (const f of listeners[ev] ?? []) f(...a);
      return true;
    },
    send(buf: Uint8Array) {
      log.dgramSends.push({ bytes: Buffer.from(buf).toString(), buf });
      handle.sendQueue = [buf];
    },
    getSendQueueCount: () => (handle.sendQueue === undefined ? 0 : 1),
  };
  return { sock: sock as unknown as Socket, log, handle, listeners };
}

describe('UdpIo (Bun native socket, shape-faked)', () => {
  it('receives through reload({ socket }) without rinfo or emit, keeping drain and error', () => {
    const { sock, log, listeners } = fakeBunSocket();
    const got: [string, string, number][] = [];
    const errors: Error[] = [];
    const io = new UdpIo(sock, (m, address, port) => got.push([m.toString(), address, port]), (e) => errors.push(e));
    expect(io.batches).toBe(true);
    expect(listeners.message).toBeUndefined();
    log.handlers!.data(null, Buffer.from('hi'), 4000, '::1', { ipv6: true });
    expect(got).toEqual([['hi', '::1', 4000]]);
    log.handlers!.drain(null);
    expect(log.drains).toBe(1);
    // ICMP error-queue reports are not errors; other recv errors are reported as recvmsg
    log.handlers!.error(Object.assign(new Error('x'), { syscall: 'recv', errqueue: true }));
    expect(errors).toEqual([]);
    log.handlers!.error(Object.assign(new Error('y'), { syscall: 'recv' }));
    log.handlers!.error(new Error('z'));
    expect(errors.map((e) => [(e as { syscall?: string }).syscall, e.message])).toEqual([
      ['recvmsg', 'y'],
      [undefined, 'z'],
    ]);
  });

  it('falls back to the dgram message event when reload is not usable', () => {
    const { sock, listeners } = fakeBunSocket({ reloadThrows: true });
    const got: [string, string, number][] = [];
    const io = new UdpIo(sock, (m, address, port) => got.push([m.toString(), address, port]), () => {});
    expect(io.batches).toBe(false);
    listeners.message![0]!(Buffer.from('m'), { address: '10.0.0.1', port: 9, family: 'IPv4', size: 1 });
    expect(got).toEqual([['m', '10.0.0.1', 9]]);
  });

  it('sends through native.send; refused (backpressure) or behind a queue: dgram', () => {
    const { sock, log, handle } = fakeBunSocket();
    const io = new UdpIo(sock, () => {}, () => {});
    expect(io.send(Buffer.from('a'), 1, '127.0.0.1')).toBe(true);
    expect(log.sends).toEqual([['a', 1, '127.0.0.1']]);
    expect(io.directSends).toBe(1);
    log.accept = false;
    const b = Buffer.from('b');
    expect(io.send(b, 2, '::1')).toBe(false); // dgram queued a view: the caller must not reuse b
    expect(log.dgramSends.map((d) => d.bytes)).toEqual(['b']);
    log.accept = true;
    // dgram's queue is not empty: keep the order behind it
    expect(io.send(Buffer.from('c'), 3, '127.0.0.1')).toBe(false);
    expect(log.dgramSends.map((d) => d.bytes)).toEqual(['b', 'c']);
    handle.sendQueue = undefined; // drained
    expect(io.send(Buffer.from('d'), 4, '127.0.0.1')).toBe(true);
    expect(log.sends.map((s) => s[0])).toEqual(['a', 'd']);
    log.closed = true;
    expect(() => io.send(Buffer.from('e'), 5, '127.0.0.1')).not.toThrow();
  });

  it('batches into one sendMany with a private copy of every datagram', () => {
    const { sock, log } = fakeBunSocket();
    const io = new UdpIo(sock, () => {}, () => {});
    const scratch = Buffer.alloc(16);
    const put = (s: string) => scratch.subarray(0, scratch.write(s));
    beginUdpBatch();
    beginUdpBatch(); // nested: only the outermost end sends
    expect(io.send(put('first'), 1, '127.0.0.1')).toBe(true);
    expect(io.send(put('2nd'), 2, '::1')).toBe(true); // scratch overwritten at once
    expect(io.send(put('third!'), 3, '127.0.0.1')).toBe(true);
    endUdpBatch();
    expect(log.many).toEqual([]);
    endUdpBatch();
    expect(log.many).toEqual([
      [
        ['first', 1, '127.0.0.1'],
        ['2nd', 2, '::1'],
        ['third!', 3, '127.0.0.1'],
      ],
    ]);
    expect(io.batchSends).toBe(1);
    // a lone datagram goes through send; outside a batch, sends are immediate
    beginUdpBatch();
    io.send(put('solo'), 4, '127.0.0.1');
    expect(log.sends).toEqual([]);
    endUdpBatch();
    expect(log.sends).toEqual([['solo', 4, '127.0.0.1']]);
    io.send(put('now'), 5, '127.0.0.1');
    expect(log.sends.length).toBe(2);
    endUdpBatch(); // unbalanced end: harmless
    expect(log.many.length).toBe(1);
  });

  it('a full ring is sent mid-batch; oversized datagrams bypass it; a refused tail goes to dgram as copies', () => {
    const { sock, log } = fakeBunSocket();
    const io = new UdpIo(sock, () => {}, () => {});
    beginUdpBatch();
    for (let i = 0; i < 70; i++) io.send(Buffer.from(`d${i}`), 1000 + i, '127.0.0.1');
    expect(log.many.length).toBe(1); // 64 at once
    expect(log.many[0]!.length).toBe(64);
    const big = Buffer.alloc(4000, 1);
    io.send(big, 1, '127.0.0.1'); // larger than a ring slot: sent directly, after what is batched
    expect(log.sends.length).toBe(1);
    expect(log.many.length).toBe(2);
    expect(log.many[1]!.map((d) => d[0])).toEqual(['d64', 'd65', 'd66', 'd67', 'd68', 'd69']);
    endUdpBatch();
    expect(log.many.length).toBe(2);

    log.acceptMany = 1; // the kernel takes one, the rest go to dgram's queue
    beginUdpBatch();
    io.send(Buffer.from('x'), 1, '127.0.0.1');
    io.send(Buffer.from('y'), 2, '127.0.0.1');
    io.send(Buffer.from('z'), 3, '127.0.0.1');
    endUdpBatch();
    expect(log.many[2]!.map((d) => d[0])).toEqual(['x']);
    expect(log.dgramSends.map((d) => d.bytes)).toEqual(['y', 'z']);
    // copies: the ring slots are reused by the next batch, which queues behind dgram's queue
    beginUdpBatch();
    io.send(Buffer.from('w'), 4, '127.0.0.1');
    endUdpBatch();
    expect(log.dgramSends.map((d) => Buffer.from(d.buf).toString())).toEqual(['y', 'z', 'w']);
  });

  it('a closed socket drops the batch without throwing', () => {
    const { sock, log } = fakeBunSocket();
    const io = new UdpIo(sock, () => {}, () => {});
    beginUdpBatch();
    io.send(Buffer.from('a'), 1, '127.0.0.1');
    io.send(Buffer.from('b'), 1, '127.0.0.1');
    log.closed = true;
    expect(() => endUdpBatch()).not.toThrow();
    expect(log.many).toEqual([]);
  });
});
