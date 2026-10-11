/**
 * Shared SCTP timer heap (src/rtc/sctp/timers.ts): ordering, moving and
 * clearing deadlines, re-arming from a callback; and an association on
 * default timers retransmitting through it (real clock).
 */
import { describe, expect, it } from 'vitest';
import { sharedTimers, TimerSlot } from '../../../src/rtc/sctp/timers.js';
import { SctpAssociation } from '../../../src/rtc/sctp/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('shared timer heap', () => {
  it('fires slots in deadline order, honours moves and clears', async () => {
    const order: string[] = [];
    const mk = (name: string) => new TimerSlot(() => order.push(name));
    const a = mk('a');
    const b = mk('b');
    const c = mk('c');
    const d = mk('d');
    const now = performance.now();
    sharedTimers.set(a, now + 40);
    sharedTimers.set(b, now + 10);
    sharedTimers.set(c, now + 20);
    sharedTimers.set(d, now + 5);
    sharedTimers.set(a, now + 15); // earlier
    sharedTimers.set(b, now + 30); // later
    sharedTimers.clear(d);
    sharedTimers.clear(d); // idempotent
    await sleep(80);
    expect(order).toEqual(['a', 'c', 'b']);
    expect([a.index, b.index, c.index, d.index]).toEqual([-1, -1, -1, -1]);
    expect(sharedTimers.size).toBe(0);
  });

  it('a callback may re-arm its own slot', async () => {
    let n = 0;
    const s: TimerSlot = new TimerSlot(() => {
      if (++n < 3) sharedTimers.set(s, performance.now() + 2);
    });
    sharedTimers.set(s, performance.now() + 1);
    await sleep(60);
    expect(n).toBe(3);
    expect(sharedTimers.size).toBe(0);
  });

  it('associations on default timers retransmit through it and leave nothing queued when closed', async () => {
    let dropFirst = true;
    let a: SctpAssociation;
    let b: SctpAssociation;
    const got: number[] = [];
    const mk = (peer: () => SctpAssociation, onMsg?: (d: Uint8Array) => void) =>
      new SctpAssociation({
        send: (pkt) => {
          const copy = pkt.slice();
          const isData = copy.length > 12 && copy[12] === 0;
          if (isData && dropFirst) {
            dropFirst = false; // lose the first DATA packet: T3 must retransmit it
            return;
          }
          setImmediate(() => peer().input(copy));
        },
        channels: [{ id: 0, ordered: true }],
        maxMessageSize: 65536,
        onMessage: (_ch, d) => onMsg?.(d),
        onOpen() {},
        onClose() {},
        rtoInitial: 100,
        rtoMin: 50,
        rtoMinVariance: 20,
      });
    a = mk(() => b);
    b = mk(
      () => a,
      (d) => got.push(d[0]!),
    );
    a.connect();
    for (let i = 0; i < 100 && a.readyState !== 'established'; i++) await sleep(5);
    expect(a.readyState).toBe('established');
    expect(a.send(0, new Uint8Array([42]))).toBe(true);
    for (let i = 0; i < 200 && got.length === 0; i++) await sleep(5);
    expect(got).toEqual([42]);
    expect(a.stats().retransmissions).toBeGreaterThan(0);
    a.close();
    b.close();
    expect(sharedTimers.size).toBe(0);
  });
});
