/**
 * A bug that throws from a timer-driven flush must not escape as an uncaught
 * exception (which the shared timer heap would rethrow, taking down the
 * process and every room on it). The association counts it, reports it to
 * onError and tears down only itself with reason 'internal-error'. The
 * ordinary input guard already contains such throws; this covers the timer
 * path.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';

describe('timer-driven internal failure containment', () => {
  it('a throwing flush fails only that association instead of crashing the process', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const a = p.a.sctp as unknown as { flushOnce: () => void; onTimer: () => void };
    a.flushOnce = () => {
      throw new Error('boom-internal');
    };
    // Drive the timer path (onTimer runs its handlers, then flushes).
    a.onTimer();
    expect(p.a.closed).toBe('internal-error');
    expect(p.a.sctp.stats().internalErrors).toBe(1);
    expect(p.a.errors.map(String).some((s) => s.includes('boom-internal'))).toBe(true);
    // The peer association is untouched.
    expect(p.b.opened).toBe(true);
    expect(p.b.closed).toBe(null);
  });
});
