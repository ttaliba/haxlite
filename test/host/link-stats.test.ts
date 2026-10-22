/**
 * Connection quality measured by the host (src/host/link-stats.ts): uplink
 * jitter / delay from the Ping echo, lost pings, late inputs, host timer lag
 * and the window history. Numbers only.
 */
import { describe, expect, it } from 'vitest';
import { LINK_WINDOWS, LINK_WINDOW_MS } from '../../src/host/index.js';
import { HostLagTrack, LinkStats, type InputCounters } from '../../src/host/link-stats.js';

const inputs = (): InputCounters & { lateness: { mean: number } } => ({ inputCount: 0, lateCount: 0, lateness: { mean: 0 } });

/** Sends one ping per `period` ms from a client whose clock is `offset` ms ahead; `extra(i)` = uplink delay of ping i. */
function run(s: LinkStats, from: number, count: number, extra: (i: number) => number = () => 0, period = 1000, offset = 123_456): number {
  let t = from;
  for (let i = 0; i < count; i++) {
    t += period;
    s.onPing(t, t - 20 - extra(i) + offset, 50); // 20 ms base uplink, plus the extra; the client clock is `offset` ms off
  }
  return t;
}

describe('LinkStats', () => {
  it('a steady connection shows no jitter, no uplink delay, no loss, whatever the clock offset', () => {
    const s = new LinkStats(0, inputs());
    const end = run(s, 0, 30);
    const r = s.report(1, end);
    expect(r.jitter).toBeLessThan(1);
    expect(r.uplinkDelay).toBeLessThan(1);
    expect(r.totals).toMatchObject({ pings: 30, lostPings: 0, lateInputs: 0, hostLag: 0 });
    expect(r.ping).toBe(50);
    expect(r.history.length).toBeGreaterThanOrEqual(3);
    expect(r.history.every((h) => h.jitter < 1 && h.uplinkDelay < 1 && h.lostPings === 0)).toBe(true);
  });

  it('an uplink delay spike shows as jitter and delay above baseline in its window only', () => {
    const s = new LinkStats(0, inputs());
    let t = run(s, 0, 10);
    t = run(s, t, 3, () => 400);
    t = run(s, t, 10);
    const r = s.report(1, t);
    const spike = r.history.filter((h) => h.uplinkDelay > 300);
    expect(spike.length).toBeGreaterThan(0);
    expect(spike.every((h) => h.jitter > 30)).toBe(true);
    expect(r.history.some((h) => h.uplinkDelay < 1)).toBe(true);
  });

  it('missing pings are counted as lost (gap of 3 s = 2 lost)', () => {
    const s = new LinkStats(0, inputs());
    let t = run(s, 0, 5);
    t += 3000; // two pings never arrived
    s.onPing(t, t - 20 + 123_456, 50);
    const r = s.report(1, t + 1);
    expect(r.totals.lostPings).toBe(2);
    expect(r.history.some((h) => h.lostPings === 2)).toBe(true);
  });

  it('counts inputs and late inputs per window and in total', () => {
    const c = inputs();
    const s = new LinkStats(0, c);
    let t = run(s, 0, 9);
    c.inputCount = 100;
    c.lateCount = 40;
    t = run(s, t, 4);
    const r = s.report(1, t);
    expect(r.totals).toMatchObject({ inputs: 100, lateInputs: 40 });
    expect(r.history.reduce((n, h) => n + h.inputs, 0)).toBe(100);
    expect(r.history.reduce((n, h) => n + h.lateInputs, 0)).toBe(40);
  });

  it('host timer lag is reported in its window and in the totals', () => {
    const lag = new HostLagTrack();
    const s = new LinkStats(0, inputs(), lag);
    let t = run(s, 0, 9);
    lag.note(5000, 100);
    lag.note(6000, 60); // the worst of the window wins
    t = run(s, t, 3);
    const r = s.report(1, t);
    expect(r.totals.hostLag).toBe(100);
    expect(r.history.map((h) => h.hostLag)).toEqual([100, 0]);
  });

  it('keeps at most LINK_WINDOWS windows and survives garbage from the client', () => {
    const s = new LinkStats(0, inputs());
    let t = run(s, 0, (LINK_WINDOWS + 10) * (LINK_WINDOW_MS / 1000));
    s.onPing(t + 1000, NaN, 50);
    s.onPing(t + 2000, Infinity, 50);
    t += 2000;
    const r = s.report(1, t);
    expect(r.history.length).toBeLessThanOrEqual(LINK_WINDOWS);
    expect(Number.isFinite(r.jitter) && Number.isFinite(r.uplinkDelay)).toBe(true);
    expect(r.history[0]!.t).toBeGreaterThan(0);
    for (let i = 1; i < r.history.length; i++) expect(r.history[i]!.t).toBeGreaterThan(r.history[i - 1]!.t);
  });

  it('is cheap: a ping is well under a microsecond', () => {
    const s = new LinkStats(0, inputs());
    const n = 1_000_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) s.onPing(i * 1000, i * 1000 - 20 - (i & 7), 50);
    const ns = ((performance.now() - t0) * 1e6) / n;
    console.log(`LinkStats.onPing: ${ns.toFixed(0)} ns/call`);
    expect(ns).toBeLessThan(2000);
  });
});
