// haxlite-rtc vs node-datachannel: server cost and latency with real Chromium peers.
//
//   flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings \
//     --import ./bench/ts-resolve.mjs bench/rtc/run.ts [--backends ndc,rtc] [--peers 1,10,30] \
//     [--seconds 30] [--warmup 5] [--input-hz 8] [--per-page 10] [--out bench/results/rtc.json]
//
// For each backend × peer count: forks bench/rtc/server-proc.ts, bundled to
// plain JS with rolldown (the measured process; it loads only its backend), connects N PeerConnections from headless Chromium (10 per page by
// default, each one a transcription of the official client, see
// test/rtc-interop/harness/client.js) and runs HaxBall-like traffic (docs/04):
//   client: input on ro at --input-hz (Poisson; the official client sends an
//           input only when it changes), ping on uu every 1 s
//   server: every input re-broadcast to all N peers on ru (official `jd`),
//           pong on uu, heartbeat on uu every ≥ 7 frames (≈ 117 ms) from a 50 ms tick
// Measured on the server process: CPU % (utime+stime of all threads /
// wall), threads (/proc/<pid>/task), RSS, V8 heap, open fds; and latency
// p50/p99 in the browser: ping RTT (uu), input→own-event RTT (ro → ru) and
// heartbeat one-way delay (same clock on both ends).
import { fork, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { build } from 'rolldown';
import { rtcAvailable, type BackendKind } from '../../test/rtc-interop/harness/backends.js';
import { chromiumVersion, launchChromium, openHarnessPage } from '../../test/rtc-interop/harness/browser.js';
import { summarize } from '../../test/rtc-interop/harness/wire.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}
const BACKENDS = arg('backends', 'ndc,rtc').split(',') as BackendKind[];
const PEERS = arg('peers', '1,10,30').split(',').map(Number);
const SECONDS = Number(arg('seconds', '30'));
const WARMUP = Number(arg('warmup', '5'));
const INPUT_HZ = Number(arg('input-hz', '8'));
const PER_PAGE = Number(arg('per-page', '10'));
const ADDRESS = arg('address', '127.0.0.1');
const OUT = arg('out', '');

const CLK_TCK = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProcSample {
  t: number;
  ticks: number;
  rssKb: number;
  threads: number;
  fds: number;
}

function sampleProc(pid: number): ProcSample {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(f[11]) + Number(f[12]); // utime + stime (fields 14, 15)
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  const threads = readdirSync(`/proc/${pid}/task`).length;
  const fds = readdirSync(`/proc/${pid}/fd`).length;
  return { t: performance.now(), ticks, rssKb, threads, fds };
}

interface Server {
  child: ChildProcess;
  pid: number;
  url: string;
  ask<T>(cmd: string, reply: string): Promise<T>;
  errors: string[];
}

/** Bundles server-proc.ts (+ harness + src/net or src/rtc chunks) into plain ESM, runtime deps external. */
async function bundleServer(): Promise<string> {
  const out = path.join(ROOT, 'node_modules/.cache/haxlite-bench-rtc');
  rmSync(out, { recursive: true, force: true });
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
  await build({
    input: { 'server-proc': path.join(ROOT, 'bench/rtc/server-proc.ts') },
    platform: 'node',
    resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
    external: (id) => id.startsWith('node:') || deps.some((d) => id === d || id.startsWith(`${d}/`)),
    logLevel: 'warn',
    output: { dir: out, format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: 'chunk-[hash].mjs' },
  });
  // page assets: client.js as is, wire.ts pre-stripped (the server then never loads the TS stripper)
  const assets = path.join(out, 'assets');
  mkdirSync(assets, { recursive: true });
  const harness = path.join(ROOT, 'test/rtc-interop/harness');
  copyFileSync(path.join(harness, 'client.js'), path.join(assets, 'client.js'));
  writeFileSync(path.join(assets, 'wire.js'), stripTypeScriptTypes(readFileSync(path.join(harness, 'wire.ts'), 'utf8')));
  return path.join(out, 'server-proc.mjs');
}
const SERVER_BUNDLE = await bundleServer();
const ASSETS = path.join(path.dirname(SERVER_BUNDLE), 'assets');

async function startServer(kind: BackendKind): Promise<Server> {
  const child = fork(SERVER_BUNDLE, [kind, ADDRESS, ASSETS], {
    cwd: ROOT,
    execArgv: ['--no-warnings', '--expose-gc'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const errors: string[] = [];
  const waiters = new Map<string, ((m: unknown) => void)[]>();
  child.on('message', (m: { type: string; message?: string }) => {
    if (m.type === 'error') errors.push(m.message ?? '');
    const w = waiters.get(m.type);
    if (w?.length) w.shift()!(m);
  });
  const wait = <T>(type: string, ms = 30_000) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`server: no ${type}`)), ms);
      const list = waiters.get(type) ?? [];
      waiters.set(type, list);
      list.push((m) => {
        clearTimeout(t);
        resolve(m as T);
      });
    });
  const ready = await wait<{ url: string; pid: number }>('ready');
  return {
    child,
    pid: child.pid!,
    url: ready.url,
    errors,
    ask: <T>(cmd: string, reply: string) => {
      const p = wait<T>(reply);
      child.send({ cmd });
      return p;
    },
  };
}

type Hx = {
  connect(n: number, o?: object): Promise<({ index: number } | null)[]>;
  startBench(o: object): void;
  stopBench(): void;
  benchLatency(raw: boolean): { raw: { ping: number[]; input: number[]; oneWay: number[] } };
  closedCount(): number;
  errors: string[];
};

interface RunResult {
  backend: BackendKind;
  peers: number;
  connected: number;
  closedDuringRun: number;
  cpuPct: number;
  threadsIdle: number;
  threads: number;
  rssIdleMb: number;
  rssMb: number;
  rssMaxMb: number;
  heapUsedMb: number;
  fdsIdle: number;
  fds: number;
  latency: { ping: ReturnType<typeof summarize>; input: ReturnType<typeof summarize>; oneWay: ReturnType<typeof summarize> };
  serverErrors: number;
  backendStats: unknown;
}

async function runOne(browser: Browser, kind: BackendKind, n: number): Promise<RunResult> {
  const srv = await startServer(kind);
  await sleep(1000);
  const idle = sampleProc(srv.pid);
  const pages = [];
  for (let k = 0; k < Math.ceil(n / PER_PAGE); k++) pages.push(await openHarnessPage(browser, srv.url));
  let connected = 0;
  const joins = await Promise.all(
    pages.map((pg, k) =>
      pg.evaluate((m) => (globalThis as unknown as { hx: Hx }).hx.connect(m, { inactivityMs: Infinity }), Math.min(PER_PAGE, n - k * PER_PAGE)),
    ),
  );
  for (const j of joins) connected += j.filter((x) => x !== null).length;
  for (const pg of pages) await pg.evaluate((hz) => (globalThis as unknown as { hx: Hx }).hx.startBench({ inputHz: hz }), INPUT_HZ);
  await sleep(WARMUP * 1000);
  // restart to drop the warmup samples (startBench resets them)
  for (const pg of pages) await pg.evaluate((hz) => (globalThis as unknown as { hx: Hx }).hx.startBench({ inputHz: hz }), INPUT_HZ);
  const s0 = sampleProc(srv.pid);
  let rssMax = s0.rssKb;
  let threadsMax = s0.threads;
  let fdsMax = s0.fds;
  const rss: number[] = [];
  const end = performance.now() + SECONDS * 1000;
  while (performance.now() < end) {
    await sleep(1000);
    const s = sampleProc(srv.pid);
    rss.push(s.rssKb);
    rssMax = Math.max(rssMax, s.rssKb);
    threadsMax = Math.max(threadsMax, s.threads);
    fdsMax = Math.max(fdsMax, s.fds);
  }
  const s1 = sampleProc(srv.pid);
  const mem = await srv.ask<{ heapUsed: number; backend: unknown }>('mem', 'mem');
  for (const pg of pages) await pg.evaluate(() => (globalThis as unknown as { hx: Hx }).hx.stopBench());
  const all = { ping: [] as number[], input: [] as number[], oneWay: [] as number[] };
  let closed = 0;
  for (const pg of pages) {
    const l = await pg.evaluate(() => (globalThis as unknown as { hx: Hx }).hx.benchLatency(true));
    for (const k of ['ping', 'input', 'oneWay'] as const) for (const x of l.raw[k]) all[k].push(x);
    closed += await pg.evaluate(() => (globalThis as unknown as { hx: Hx }).hx.closedCount());
  }
  for (const pg of pages) await pg.close();
  srv.child.kill('SIGKILL');
  const wall = (s1.t - s0.t) / 1000;
  const mb = (kb: number) => Math.round(kb / 102.4) / 10;
  return {
    backend: kind,
    peers: n,
    connected,
    closedDuringRun: closed,
    cpuPct: Math.round(((s1.ticks - s0.ticks) / CLK_TCK / wall) * 1000) / 10,
    threadsIdle: idle.threads,
    threads: threadsMax,
    rssIdleMb: mb(idle.rssKb),
    rssMb: mb(rss.reduce((a, b) => a + b, 0) / Math.max(1, rss.length)),
    rssMaxMb: mb(rssMax),
    heapUsedMb: Math.round(mem.heapUsed / 1e5) / 10,
    fdsIdle: idle.fds,
    fds: fdsMax,
    latency: { ping: summarize(all.ping), input: summarize(all.input), oneWay: summarize(all.oneWay) },
    serverErrors: srv.errors.length,
    backendStats: mem.backend,
  };
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

const browser = await launchChromium();
const version = await chromiumVersion(browser);
const results: RunResult[] = [];
for (const n of PEERS) {
  for (const kind of BACKENDS) {
    if (kind === 'rtc' && !rtcAvailable()) {
      console.error('skip rtc: src/rtc/index.ts not present');
      continue;
    }
    const r = await runOne(browser, kind, n);
    results.push(r);
    console.error(
      `${kind} N=${n}: conn ${r.connected}/${n} cpu ${r.cpuPct}% thr ${r.threadsIdle}→${r.threads} rss ${r.rssIdleMb}→${r.rssMb} MB heap ${r.heapUsedMb} MB fds ${r.fdsIdle}→${r.fds} ` +
        `ping p50/p99 ${f1(r.latency.ping.p50)}/${f1(r.latency.ping.p99)} input ${f1(r.latency.input.p50)}/${f1(r.latency.input.p99)} oneWay ${f1(r.latency.oneWay.p50)}/${f1(r.latency.oneWay.p99)} ms`,
    );
    await sleep(2000);
  }
}
await browser.close();

console.log(`\nChromium ${version}, ${SECONDS} s window, input ${INPUT_HZ} Hz/client, ${PER_PAGE} PCs/page\n`);
console.log('| backend | peers | conectados | CPU % | hilos (reposo→carga) | RSS MB (reposo→carga) | heap MB | fds | ping RTT p50/p99 ms | input→evento p50/p99 ms | heartbeat 1-vía p50/p99 ms |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of results)
  console.log(
    `| ${r.backend} | ${r.peers} | ${r.connected} | ${r.cpuPct} | ${r.threadsIdle}→${r.threads} | ${r.rssIdleMb}→${r.rssMb} | ${r.heapUsedMb} | ${r.fdsIdle}→${r.fds} | ${f1(r.latency.ping.p50)}/${f1(r.latency.ping.p99)} | ${f1(r.latency.input.p50)}/${f1(r.latency.input.p99)} | ${f1(r.latency.oneWay.p50)}/${f1(r.latency.oneWay.p99)} |`,
  );
if (OUT) writeFileSync(path.resolve(ROOT, OUT), JSON.stringify({ chromium: version, seconds: SECONDS, inputHz: INPUT_HZ, perPage: PER_PAGE, date: new Date().toISOString(), results }, null, 1));
process.exit(0);
