/**
 * Default SCTP clock: whole milliseconds of `performance.now()`, optionally
 * frozen for a synchronous batch.
 *
 * Every `performance.now()` (and `Date.now()`) call allocates a HeapNumber in
 * Node (~16–32 B), and a host flushing a bundling scope uncorks one
 * association per peer, each reading the clock. {@link freezeSctpClock} /
 * {@link thawSctpClock} (nestable) make every read inside the batch return
 * one value read at its start: the batch is synchronous and takes far less
 * than a millisecond, the resolution SCTP timers and RTT samples use anyway.
 * Whole milliseconds keep time fields small integers (unboxed Smis) until
 * ~12 days of process uptime.
 *
 * Tiny on purpose: the rtc backend imports it statically (also when the
 * process never loads the rest of src/rtc).
 */
let frozenAt = -1;
let depth = 0;

/** Current time in whole ms (the frozen value inside a batch). */
export function sctpNow(): number {
  return frozenAt >= 0 ? frozenAt : Math.floor(performance.now());
}

/**
 * Starts (or nests) a frozen-clock batch. Always pair with {@link thawSctpClock}.
 * `now` (performance.now() ms the caller already read, e.g. once per
 * received datagram) avoids a second clock read.
 */
export function freezeSctpClock(now?: number): void {
  if (depth++ === 0) frozenAt = Math.floor(now ?? performance.now());
}

/** Ends one {@link freezeSctpClock}; the outermost one unfreezes. */
export function thawSctpClock(): void {
  if (depth > 0 && --depth === 0) frozenAt = -1;
}
