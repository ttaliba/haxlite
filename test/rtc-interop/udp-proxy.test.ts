// Fast checks of the interop harness's UDP impairment proxy (no browser).
import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { impairDecision, mulberry32, UdpImpairProxy, type ImpairOptions } from './harness/udp-proxy.js';

const dir = () => ({ in: 0, dropped: 0, duplicated: 0, reordered: 0, out: 0 });

describe('impairDecision', () => {
  it('is deterministic for a seed and close to the configured rates', () => {
    const o: ImpairOptions = { loss: 0.05, delayMs: 5, jitterMs: 30, reorder: 0.02, reorderDelayMs: 25, duplicate: 0.01 };
    const run = (seed: number) => {
      const r = mulberry32(seed);
      const st = dir();
      const delays: number[][] = [];
      for (let i = 0; i < 20_000; i++) delays.push(impairDecision(o, r, st));
      return { st, delays };
    };
    const a = run(42);
    const b = run(42);
    expect(a.delays).toEqual(b.delays);
    expect(a.st.dropped / a.st.in).toBeGreaterThan(0.04);
    expect(a.st.dropped / a.st.in).toBeLessThan(0.06);
    expect(a.st.duplicated / a.st.in).toBeGreaterThan(0.005);
    expect(a.st.duplicated / a.st.in).toBeLessThan(0.015);
    const flat = a.delays.flat();
    expect(Math.min(...flat)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...flat)).toBeLessThanOrEqual(5 + 30 + 25);
    expect(run(43).delays).not.toEqual(a.delays);
  });

  it('passes everything untouched with no impairment', () => {
    const st = dir();
    const r = mulberry32(1);
    for (let i = 0; i < 100; i++) expect(impairDecision({}, r, st)).toEqual([0]);
    expect(st.dropped).toBe(0);
  });
});

describe('UdpImpairProxy', () => {
  const socks: dgram.Socket[] = [];
  let proxy: UdpImpairProxy | null = null;
  afterEach(() => {
    proxy?.close();
    for (const s of socks.splice(0)) s.close();
  });

  async function bound(): Promise<dgram.Socket> {
    const s = dgram.createSocket('udp4');
    socks.push(s);
    await new Promise<void>((r) => s.bind(0, '127.0.0.1', r));
    return s;
  }

  it('relays both ways per client address and applies loss', async () => {
    const server = await bound();
    server.on('message', (m, ri) => server.send(m, ri.port, ri.address)); // echo
    proxy = await UdpImpairProxy.start({ address: '127.0.0.1', port: server.address().port }, { loss: 0.2, seed: 9 });
    const client = await bound();
    const got: number[] = [];
    client.on('message', (m) => got.push(m.readUInt32BE(0)));
    const N = 500;
    for (let i = 0; i < N; i++) {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(i);
      client.send(b, proxy.address.port, proxy.address.address);
      if (i % 50 === 49) await new Promise((r) => setTimeout(r, 5)); // stay under the kernel buffers
    }
    await new Promise((r) => setTimeout(r, 300));
    const st = proxy.stats;
    expect(st.clients).toBe(1);
    expect(st.up.in).toBe(N);
    expect(st.up.out).toBe(N - st.up.dropped);
    expect(st.down.in).toBe(st.up.out);
    expect(got.length).toBe(st.down.out);
    // two passes at 20 % loss ≈ 64 % survive
    expect(got.length / N).toBeGreaterThan(0.5);
    expect(got.length / N).toBeLessThan(0.78);
    expect(new Set(got).size).toBe(got.length);
  });
});
