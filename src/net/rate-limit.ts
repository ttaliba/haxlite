/**
 * Token buckets.
 *
 * {@link TokenBucket} reproduces the official `Ra(capacity, msPerToken)`
 * exactly: whole tokens are added per elapsed `msPerToken` (the remainder is
 * carried), and when the bucket is full the reference time resets to `now`.
 * Used for the per-connection flood limit (`new Ra(100, 16)`) and by the host
 * for per-event limits (chat 10/900 ms, stadium 10/2000 ms, sync 2/10000 ms).
 */

export class TokenBucket {
  readonly capacity: number;
  readonly msPerToken: number;
  /** Tokens available (`vb`). */
  tokens: number;
  /** Reference time of the last refill (`Rc`). */
  private last: number;

  constructor(capacity: number, msPerToken: number, now: number = performance.now()) {
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

  constructor(capacity: number, msPerToken: number) {
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
