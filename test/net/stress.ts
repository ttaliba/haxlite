/**
 * Network-layer stress harness (TEST ONLY): one HostTransport behind the fake
 * master, `--clients` concurrent raw clients joining/leaving in a loop with
 * a mix of behaviors (normal play, abrupt disconnect mid-handshake, malformed
 * handshakes/offers, floods, silent peers, host kicks, broadcast to closing
 * channels). Runs two churn phases separated by full quiesce points and
 * checks: no crash, no leaked peers or native objects, heap/RSS flat between
 * the quiesce points, prompt process exit after shutdown.
 *
 *   node --experimental-strip-types --expose-gc --import ./scripts/ts-resolve.mjs \
 *        test/net/stress.ts [--seconds 180] [--clients 30] [--seed 1] [--quiet]
 *
 * Exit code 0 = all checks passed; prints one JSON summary line `RESULT {...}`.
 */
import { FakeMaster } from '../fake-master/index.js';
import { RawClient } from './raw-client.js';
import { HostTransport, liveWebRtcObjects, shutdownWebRtc, webRtcStats, type PeerCloseReason } from '../../src/net/index.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(a.slice(2), next);
      i++;
    } else args.set(a.slice(2), '1');
  }
}
const SECONDS = Number(args.get('seconds') ?? 180);
const CLIENTS = Number(args.get('clients') ?? 30);
const QUIET = args.has('quiet');
let seed = Number(args.get('seed') ?? 1) >>> 0;

/** mulberry32 */
function rand(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const gc = (globalThis as { gc?: () => void }).gc;
const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
const log = (...a: unknown[]) => {
  if (!QUIET) console.log(`[stress ${(performance.now() / 1000).toFixed(1)}s]`, ...a);
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<'timeout'>((r) => (t = setTimeout(() => r('timeout'), ms)))]).finally(() =>
    clearTimeout(t),
  );
}

const counters = {
  scenarios: {} as Record<string, number>,
  stuck: {} as Record<string, number>,
  joins: 0,
  closes: {} as Record<string, number>,
  hostKicks: 0,
  /** signaling rejections of 'normal' joins (room full while 30 slots churn) */
  rejected: 0,
  messagesIn: 0,
  errors: 0,
  errorSamples: [] as string[],
};

const master = await FakeMaster.start();
const t = new HostTransport({
  token: 'thr1.stress',
  masterUrl: master.httpBase,
  iceServers: [],
  iceCandidatePolicy: 'all',
  maxPlayers: 30,
  sweepIntervalMs: 250,
  peerIdleTimeoutMs: 4000,
  channelOpenTimeoutMs: 6000,
});
t.onError = (err) => {
  counters.errors++;
  if (counters.errorSamples.length < 5) counters.errorSamples.push(String(err.stack ?? err));
};
t.onPeerJoin = (peer) => {
  counters.joins++;
  t.send(peer, 0, new Uint8Array(randInt(1, 2000))); // "snapshot"
  if (rand() < 0.08) {
    counters.hostKicks++;
    const delay = randInt(0, 300);
    setTimeout(() => t.kick(peer, { reason: 'stress', ban: false }), delay);
  }
};
t.onPeerMessage = (peer, data, ch) => {
  counters.messagesIn++;
  if (rand() < 0.2) t.send(peer, ch, data); // echo
  if (rand() < 0.002) throw new Error('host callback bug (must not crash the transport)');
};
t.onPeerClose = (_peer, reason: PeerCloseReason) => {
  counters.closes[reason] = (counters.closes[reason] ?? 0) + 1;
};
const roomReady = master.waitForRoom();
t.start();
const roomId = (await roomReady).id;

// heartbeat-like broadcast: exercises sends to peers whose channels are closing
const bcast = new Uint8Array(40);
const bcastTimer = setInterval(() => t.broadcast(2, bcast), 50);

const live = new Set<RawClient>();
function join(opts: Partial<ConstructorParameters<typeof RawClient>[0]> = {}): RawClient {
  const c = new RawClient({ wsBase: master.wsBase, roomId, ...opts });
  live.add(c);
  return c;
}
function leave(c: RawClient): void {
  c.close();
  live.delete(c);
}

type Scenario = (c: () => RawClient) => Promise<void>;
const scenarios: [string, number, Scenario][] = [
  [
    'normal',
    40,
    async () => {
      const c = join();
      const rejected = c.closed.then((code) => (code >= 4000 ? 'rejected' : new Promise<never>(() => {})));
      const r = await withTimeout(Promise.race([c.whenOpen().then(() => c.challenge), rejected]), 10_000);
      if (r === 'timeout') throw new Error('stuck');
      if (r === 'rejected') {
        counters.rejected++;
        leave(c);
        return;
      }
      const n = randInt(5, 40);
      for (let i = 0; i < n; i++) {
        c.send(randInt(0, 2), Uint8Array.of(randInt(1, 9), i & 255, 0, 0));
        await sleep(randInt(5, 60));
      }
      await sleep(randInt(0, 1500));
      leave(c);
    },
  ],
  [
    'abort-mid-handshake',
    20,
    async () => {
      const c = join();
      await sleep(randInt(0, 700));
      leave(c);
    },
  ],
  [
    'malformed-handshake',
    8,
    async () => {
      const c = join({ manualHandshake: true });
      if ((await withTimeout(c.challenge.then(() => c.whenOpen()), 10_000)) === 'timeout') throw new Error('stuck');
      const junk = new Uint8Array(randInt(0, 300));
      for (let i = 0; i < junk.length; i++) junk[i] = randInt(0, 255);
      if (rand() < 0.5) junk[0] = 0; // looks like a handshake
      c.send(randInt(0, 2), junk);
      await withTimeout(c.channelsClosed, 3000);
      leave(c);
    },
  ],
  [
    'bad-offer',
    5,
    async () => {
      const junk = new Uint8Array(randInt(0, 200));
      for (let i = 0; i < junk.length; i++) junk[i] = randInt(0, 255);
      const c = join({ rawPayload: junk });
      await withTimeout(c.closed, 5000);
      leave(c);
    },
  ],
  [
    'flood',
    8,
    async () => {
      const c = join();
      if ((await withTimeout(c.whenOpen().then(() => c.challenge), 10_000)) === 'timeout') throw new Error('stuck');
      await sleep(100);
      for (let i = 0; i < 400; i++) c.send(randInt(0, 2), Uint8Array.of(1, 2, 3));
      await withTimeout(c.channelsClosed, 3000);
      leave(c);
    },
  ],
  [
    'silent',
    4,
    async () => {
      const c = join({ manualHandshake: rand() < 0.5 });
      await withTimeout(c.channelsClosed, 8000); // idle timeout (4 s) closes it
      leave(c);
    },
  ],
  [
    'signaling-only',
    5,
    async () => {
      const c = join({ signalingOnly: true, version: rand() < 0.5 ? 8 : 9 });
      await sleep(randInt(0, 300));
      leave(c);
    },
  ],
];
const totalWeight = scenarios.reduce((s, x) => s + x[1], 0);
function pick(): [string, Scenario] {
  let r = rand() * totalWeight;
  for (const [name, w, fn] of scenarios) {
    r -= w;
    if (r < 0) return [name, fn];
  }
  return [scenarios[0]![0], scenarios[0]![2]];
}

async function slot(deadline: number): Promise<void> {
  while (performance.now() < deadline) {
    const [name, fn] = pick();
    counters.scenarios[name] = (counters.scenarios[name] ?? 0) + 1;
    try {
      const r = await withTimeout(
        fn(() => join()),
        20_000,
      );
      if (r === 'timeout') counters.stuck[name] = (counters.stuck[name] ?? 0) + 1;
    } catch {
      counters.stuck[name] = (counters.stuck[name] ?? 0) + 1;
    }
  }
}

interface Sample {
  heapMB: number;
  rssMB: number;
  external: number;
}
async function quiesce(label: string): Promise<Sample & { natives: ReturnType<typeof webRtcStats> }> {
  for (const c of [...live]) leave(c);
  const ok = await withTimeout(
    (async () => {
      for (;;) {
        const s = webRtcStats();
        if (t.connectionCount === 0 && t.pendingCount === 0 && t.peers.length === 0 && s.peerConnections === 0 && s.dataChannels === 0 && s.pendingCloses === 0) return;
        await sleep(100);
      }
    })(),
    15_000,
  );
  for (let i = 0; i < 4; i++) {
    gc?.();
    await sleep(100);
  }
  const m = process.memoryUsage();
  const natives = webRtcStats();
  if (natives.peerConnections + natives.dataChannels > 0) console.log(`${label}: still live: ${liveWebRtcObjects().join(', ')}`);
  log(`${label}: drained=${ok !== 'timeout'} connections=${t.connectionCount} pending=${t.pendingCount} natives=${JSON.stringify(natives)} heap=${mb(m.heapUsed)}MB rss=${mb(m.rss)}MB`);
  return { heapMB: mb(m.heapUsed), rssMB: mb(m.rss), external: mb(m.external), natives };
}

const monitor = setInterval(() => {
  const m = process.memoryUsage();
  log(
    `joins=${counters.joins} connected=${t.connectionCount} pending=${t.pendingCount} natives=${JSON.stringify(webRtcStats())} heap=${mb(m.heapUsed)}MB rss=${mb(m.rss)}MB`,
  );
}, 5000);

const phaseMs = (SECONDS * 1000) / 3;
// phase 0 (warm-up: JIT, allocator pools, libdatachannel threads), then two measured phases
const samples: Sample[] = [];
const quiesceStats: ReturnType<typeof webRtcStats>[] = [];
for (let phase = 0; phase < 3; phase++) {
  const deadline = performance.now() + phaseMs;
  await Promise.all(Array.from({ length: CLIENTS }, () => slot(deadline)));
  const q = await quiesce(`quiesce ${phase}`);
  samples.push(q);
  quiesceStats.push(q.natives);
}
clearInterval(monitor);
clearInterval(bcastTimer);

const failures: string[] = [];
for (const [i, s] of quiesceStats.entries()) {
  if (s.peerConnections !== 0 || s.dataChannels !== 0) failures.push(`leaked natives at quiesce ${i}: ${JSON.stringify(s)}`);
}
if (t.connectionCount !== 0 || t.pendingCount !== 0 || t.peers.length !== 0) failures.push('leaked peers');
const heapGrowth = samples[2]!.heapMB - samples[1]!.heapMB;
const rssGrowth = samples[2]!.rssMB - samples[1]!.rssMB;
const heapLimit = Number(args.get('heap-limit-mb') ?? 8);
const rssLimit = Number(args.get('rss-limit-mb') ?? 64);
if (gc !== undefined && heapGrowth > heapLimit) failures.push(`heap grew ${heapGrowth} MB between quiesce points`);
if (rssGrowth > rssLimit) failures.push(`RSS grew ${rssGrowth} MB between quiesce points`);
if (counters.joins === 0) failures.push('nobody joined');

// teardown + prompt exit
t.stop();
await master.close();
const tShutdown = performance.now();
await shutdownWebRtc();
const shutdownMs = Math.round(performance.now() - tShutdown);
const after = webRtcStats();
if (after.peerConnections + after.dataChannels + after.orphanedDataChannels !== 0) {
  failures.push(`natives after shutdown: ${JSON.stringify(after)}`);
}
const orphans = quiesceStats.at(-1)!.orphanedDataChannels;
if (orphans > Math.max(3, after.created / 500)) failures.push(`too many orphaned DataChannels: ${orphans}`);

const result = {
  seconds: SECONDS,
  clients: CLIENTS,
  ...counters,
  natives: after,
  memory: samples,
  heapGrowthMB: heapGrowth,
  rssGrowthMB: rssGrowth,
  shutdownMs,
  failures,
};
console.log('RESULT ' + JSON.stringify(result));
console.log(
  `SUMMARY joins=${counters.joins} scenarios=${Object.values(counters.scenarios).reduce((a, b) => a + b, 0)} natives-created=${after.created} ` +
    `heap(q1→q2)=${samples[1]!.heapMB}→${samples[2]!.heapMB}MB rss(q1→q2)=${samples[1]!.rssMB}→${samples[2]!.rssMB}MB ` +
    `orphans=${orphans} stuck=${JSON.stringify(counters.stuck)} shutdownMs=${shutdownMs} failures=${failures.length}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;

// Must exit by itself: anything still holding the loop is a leak.
const exitDeadline = setTimeout(() => {
  console.log('EXIT-HANG ' + JSON.stringify(process.getActiveResourcesInfo()));
  process.exit(2);
}, 5000);
exitDeadline.unref();
const tEnd = performance.now();
process.on('exit', () => {
  console.log(`EXIT after ${Math.round(performance.now() - tEnd)} ms`);
});
