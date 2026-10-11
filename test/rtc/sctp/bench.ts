/**
 * SctpAssociation micro-benchmark: ns per message (send + receive + the SACK
 * traffic it causes) between two in-process associations, 30-byte messages.
 *
 *   flock /tmp/haxlite-bench.lock node --experimental-strip-types --no-warnings \
 *     --import ./scripts/ts-resolve.mjs test/rtc/sctp/bench.ts [N]
 *
 * Allocation estimate: run one variant (`bench.ts N <variant>`) with
 * `--trace-gc --min-semi-space-size=16 --max-semi-space-size=16` and divide
 * (scavenges × 16 MiB) by the message count (warm-up included).
 */
import { SctpAssociation } from '../../../src/rtc/sctp/index.js';

const N = Number(process.argv[2] ?? 1_000_000);

/** Packet queue: typed-array ring of (pool slot, length), so the harness allocates nothing. */
interface Link {
  slot: Int32Array;
  len: Int32Array;
  head: number;
  tail: number;
}
const RING = 1024;
const newLink = (): Link => ({ slot: new Int32Array(RING), len: new Int32Array(RING), head: 0, tail: 0 });

function setup(zeroCopy: boolean, zeroChecksum: boolean) {
  let now = 0;
  let timerCb: (() => void) | null = null;
  let timerAt = Infinity;
  const POOL = 256;
  const pool = Array.from({ length: POOL }, () => new Uint8Array(1500));
  const views: Uint8Array[][] = pool.map(() => []);
  let slot = 0;
  const ab = newLink();
  const ba = newLink();
  let received = 0;
  const mk = (out: Link) =>
    new SctpAssociation({
      send: (pkt) => {
        const k = slot++ & (POOL - 1);
        pool[k].set(pkt);
        const i = out.tail++ & (RING - 1);
        out.slot[i] = k;
        out.len[i] = pkt.length;
      },
      channels: [
        { id: 0, ordered: true },
        { id: 1, ordered: false },
        { id: 2, ordered: false, maxRetransmits: 0 },
      ],
      maxMessageSize: 262144,
      onMessage: () => {
        received++;
      },
      onOpen() {},
      onClose() {},
      now: () => now,
      setTimer: (cb, ms) => {
        // Single-slot timer is enough here: both associations re-arm lazily.
        if (now + ms < timerAt) {
          timerAt = now + ms;
          timerCb = cb;
        }
        return 1;
      },
      clearTimer: () => {},
      zeroCopyDelivery: zeroCopy,
      zeroChecksum,
    });
  const a = mk(ab);
  const b = mk(ba);
  const deliver = (l: Link, to: SctpAssociation): boolean => {
    if (l.head === l.tail) return false;
    const i = l.head++ & (RING - 1);
    const k = l.slot[i];
    const len = l.len[i];
    const v = (views[k][len] ??= pool[k].subarray(0, len));
    to.input(v);
    return true;
  };
  const pump = (): void => {
    while (deliver(ab, b) || deliver(ba, a));
  };
  const tick = (dt: number): void => {
    now += dt;
    if (now >= timerAt && timerCb !== null) {
      const cb = timerCb;
      timerCb = null;
      timerAt = Infinity;
      cb();
      pump();
    }
  };
  a.connect();
  pump();
  return { a, b, pump, tick, get received() { return received; } };
}

function bench(name: string, ch: number, batch: number, zeroCopy: boolean, zeroChecksum = true): void {
  const env = setup(zeroCopy, zeroChecksum);
  const data = new Uint8Array(30).fill(7);
  const run = (n: number): number => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i += batch) {
      if (batch > 1) env.a.cork();
      for (let k = 0; k < batch; k++) env.a.send(ch, data);
      if (batch > 1) env.a.uncork();
      env.pump();
      env.tick(0.05);
    }
    return Number(process.hrtime.bigint() - t0);
  };
  run(Math.min(N, 200_000)); // warm-up
  const before = env.received;
  const ns = run(N);
  const got = env.received - before;
  const st = env.a.stats();
  console.log(
    `${name.padEnd(34)} ${(ns / N).toFixed(1).padStart(7)} ns/msg  delivered ${got}/${N}  pkts a→b ${st.packetsSent}  sacks b→a ${env.b.stats().sacksSent}`,
  );
}

const ONLY = process.argv[3] === undefined ? -1 : Number(process.argv[3]);
const VARIANTS: [string, number, number, boolean, boolean?][] = [
  ['uu (ch2) 1 msg/flush, zero-copy', 2, 1, true],
  ['ru (ch1) 1 msg/flush, zero-copy', 1, 1, true],
  ['ro (ch0) 1 msg/flush, zero-copy', 0, 1, true],
  ['ro (ch0) 1 msg/flush, copy', 0, 1, false],
  ['ro (ch0) corked 10 msgs/flush', 0, 10, true],
  ['ro (ch0) 1 msg/flush, CRC32c (Chromium)', 0, 1, true, false],
];
console.log(`node ${process.version}, ${N} messages of 30 B per run`);
VARIANTS.forEach((v, i) => {
  if (ONLY < 0 || ONLY === i) bench(...v);
});
