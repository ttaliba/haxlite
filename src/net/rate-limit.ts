/**
 * Token buckets.
 *
 * {@link TokenBucket} reproduces the official `Ra(capacity, msPerToken)`
 * exactly: whole tokens are added per elapsed `msPerToken` (the remainder is
 * carried), and when the bucket is full the reference time resets to `now`.
 * Used for the per-connection flood limit (`new Ra(100, 16)`) and by the host
 * for per-event limits (chat 10/900 ms, stadium 10/2000 ms, sync 2/10000 ms).
 */

/**
 * Throws a `RangeError` unless the bucket parameters are usable: `capacity` is
 * at least 1 (`Infinity` allowed) and `msPerToken` a finite number above 0.
 * A zero interval would make the bucket accept everything and NaN would make
 * it reject everything, so a bad value must fail where the limiter is built.
 */
export function assertBucketParams(capacity: number, msPerToken: number): void {
  if (!(capacity >= 1)) throw new RangeError(`token bucket capacity must be a number >= 1, got ${capacity}`);
  if (!(msPerToken > 0 && msPerToken < Infinity)) {
    throw new RangeError(`token bucket msPerToken must be a finite number > 0, got ${msPerToken}`);
  }
}

export class TokenBucket {
  // Numeric initializers on purpose: a bare declaration defines the field as
  // `undefined` first, which makes V8 store `last` (a double, updated on every
  // take) as a freshly boxed HeapNumber each time instead of in place.
  readonly capacity: number = 0;
  readonly msPerToken: number = 0;
  /** Tokens available (`vb`). */
  tokens = 0;
  /** Reference time of the last refill (`Rc`). */
  private last = 0;

  /** @throws RangeError when `capacity` or `msPerToken` is not usable (see {@link assertBucketParams}). */
  constructor(capacity: number, msPerToken: number, now: number = performance.now()) {
    assertBucketParams(capacity, msPerToken);
    this.capacity = capacity;
    this.msPerToken = msPerToken;
    this.tokens = capacity;
    this.last = now;
  }

  /** Takes `n` tokens if available (`Ra.Rf`). */
  take(now: number = performance.now(), n = 1): boolean {
    this.refill(now);
    if (n <= this.tokens) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** `Ra.Da`. */
  refill(now: number): void {
    const whole = Math.floor((now - this.last) / this.msPerToken);
    this.last += whole * this.msPerToken;
    this.tokens += whole;
    if (this.tokens >= this.capacity) {
      this.tokens = this.capacity;
      this.last = now;
    }
  }

  /** True when the bucket would be full at `now` (safe to forget). */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }
}

/**
 * Per-key (IP) join attempt limiter. Not present in the official host
 * (disabled by default in haxlite); call {@link prune} periodically to drop
 * idle keys so memory stays bounded.
 */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  readonly capacity: number;
  readonly msPerToken: number;

  /** @throws RangeError when `capacity` or `msPerToken` is not usable (see {@link assertBucketParams}). */
  constructor(capacity: number, msPerToken: number) {
    assertBucketParams(capacity, msPerToken);
    this.capacity = capacity;
    this.msPerToken = msPerToken;
  }

  take(key: string, now: number = performance.now()): boolean {
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = new TokenBucket(this.capacity, this.msPerToken, now);
      this.buckets.set(key, b);
    }
    return b.take(now);
  }

  /** Removes buckets that have fully refilled. */
  prune(now: number = performance.now()): void {
    for (const [k, b] of this.buckets) if (b.isFull(now)) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}
