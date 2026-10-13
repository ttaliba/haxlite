import dgram, { type RemoteInfo, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { UdpIo } from '../../src/rtc/udp.js';

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

describe('UdpIo (direct UDPWrap send/receive)', () => {
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
      const got: [string, RemoteInfo][] = [];
      const errors: Error[] = [];
      const ioA = new UdpIo(a, (m, r) => got.push([m.toString(), r]), (e) => errors.push(e));
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
      expect(got[0]![1].port).toBe(b.address().port);
      expect(got[0]![1].address).toBe(host);
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
});
