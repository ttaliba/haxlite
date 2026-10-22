/**
 * Token bucket parameter validation: a zero/NaN refill interval used to turn
 * the limiter into "accept everything" / "reject everything".
 */
import { describe, expect, it } from 'vitest';
import { KeyedRateLimiter, TokenBucket } from '../../src/net/rate-limit.js';

/** Messages accepted out of `n` sent every `gapMs` starting at `t0`. */
function accepted(b: TokenBucket, n: number, gapMs: number, t0: number): number {
  let ok = 0;
  for (let i = 0; i < n; i++) if (b.take(t0 + i * gapMs)) ok++;
  return ok;
}

describe('TokenBucket parameters', () => {
  const badInterval = [0, -1, -0, NaN, Infinity, -Infinity];
  const badCapacity = [0, -1, 0.5, NaN, -Infinity];

  it('rejects an unusable msPerToken', () => {
    for (const ms of badInterval) {
      expect(() => new TokenBucket(100, ms, 0), String(ms)).toThrow(RangeError);
      expect(() => new KeyedRateLimiter(100, ms), String(ms)).toThrow(RangeError);
    }
  });

  it('rejects an unusable capacity', () => {
    for (const cap of badCapacity) {
      expect(() => new TokenBucket(cap, 16, 0), String(cap)).toThrow(RangeError);
      expect(() => new KeyedRateLimiter(cap, 16), String(cap)).toThrow(RangeError);
    }
  });

  it('names the offending value', () => {
    expect(() => new TokenBucket(100, 0, 0)).toThrow(/msPerToken.*0/);
    expect(() => new TokenBucket(NaN, 16, 0)).toThrow(/capacity.*NaN/);
  });

  it('fails when the limiter is built, not on the first key', () => {
    expect(() => new KeyedRateLimiter(3, 0)).toThrow(RangeError);
  });

  it('keeps limiting at a valid rate (flood bucket 100 / 16 ms at 10 kmsg/s)', () => {
    const b = new TokenBucket(100, 16, 0);
    const ok = accepted(b, 5000, 0.1, 0.05);
    // 100 burst + one token per 16 ms over 500 ms
    expect(ok).toBeGreaterThanOrEqual(100);
    expect(ok).toBeLessThan(140);
  });

  it('accepts what used to be valid', () => {
    expect(new TokenBucket(1, 0.001, 0).capacity).toBe(1);
    expect(new TokenBucket(1e6, 1, 0).tokens).toBe(1e6);
    expect(new TokenBucket(Infinity, 16, 0).take(0)).toBe(true);
    const k = new KeyedRateLimiter(2, 100);
    expect([k.take('a', 0), k.take('a', 0), k.take('a', 0)]).toEqual([true, true, false]);
  });
});
