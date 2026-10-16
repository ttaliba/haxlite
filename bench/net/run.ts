/**
 * Host resource benchmark orchestrator: haxlite vs the official headless host
 * (haxball.js) vs node-haxball as host, fully offline through the FakeMaster.
 *
 *   npm run bench:build                      # compile haxlite (src/) for the host process
 *   node --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts <scenario> [flags]
 *   bun bench/net/run.ts <scenario> [flags]  # the orchestrator under Bun works too
 *
 * Scenarios (see docs/07-benchmarks.md):
 *   startup   time from process start / room creation to "room link ready"
 *   idle      public room, 0 players (CPU %, RSS/heap, no event-loop monitor)
 *   game      N connected node-haxball clients playing a running game
 *   rooms     K rooms in one host process, 4 clients each
 *   soak      R rooms in one process (--rooms 4), C clients per room (--clients 4)
 *             joining and leaving continuously, for --minutes (360); one sample
 *             every --sample-s (60): RSS, heap, external, fds (Linux), internal
 *             Map/Set sizes; slope MB/h and fd drift
 *   fleet     P host processes (--procs 3) × R rooms (--rooms 4) × C clients
 *             (--clients 4), measured together; CPU/RSS summed over processes
 *   join-impaired  haxlite:rtc behind the userspace NAT of test/rtc/nat-sim.ts with
 *             --rtt 40 ms and --loss 0,1,3 % (each direction), --stun cold,cached:
 *             join latency p50/p99 of --joins 20 sequential clients
 *
 * Flags: --impl haxlite,official,nodehaxball  --reps 3  --warmup 15  --window 60
 *        --n 4,10,20 (game)  --k 1,5,10 (rooms)  --out bench/results/<scenario>.json
 *        --runtime node|bun  runtime of the HOST process (default node; clients
 *          and this orchestrator are not affected). Per implementation:
 *          `--impl haxlite:rtc@bun,haxlite:rtc@node` (a suffix wins over --runtime).
 *          Bun binary: $BUN_PATH, else `bun` on PATH (resolved to the real executable).
 *        --eld 0 (no lag)  --eld-window 10  --eld-method timer|native  --eld-mode separate|inline
 *          (lag in its own sub-window before the CPU window, same timer method on Node and Bun;
 *          see ELD below)
 *        --host-node-args "--cpu-prof --cpu-prof-dir=DIR" (diagnostics only, Node hosts)
 *        --max-foreign 100 --attempts 2 (re-run a repetition when other processes
 *        on the machine used more than this % of one core during the window; after
 *        `attempts` tries the least noisy one is kept and flagged `noisy`)
 *        soak: --rooms --clients --minutes --sample-s --stay-s 20,90 --pause-s 2,15
 *        fleet: --procs --rooms --clients (accept lists: --procs 1,3)
 *        join-impaired: --rtt --loss --jitter 0 --stun --joins --nat-outside 127.0.0.1
 *          --nat-filtering endpoint-independent (nat-sim NatFiltering)
 *
 * Speed (docs/07-benchmarks.md, "Duración del arnés"):
 *        --quick  development profile: 2 reps (startup 3), warm-up ≤ 3 s, window 10 s (idle 20),
 *          --n 4,10 --k 1,5, fleet/soak 2 × 2, soak 3 min, join-impaired 5 joins at loss 0,3;
 *          output in bench/results/dev/ and marked `info.publishable: false`. NOT PUBLISHABLE.
 *        --precision P  adaptive reps: after --reps, more interleaved reps for the configs whose
 *          key metric has a 95 % CI half-width > P % of its mean, up to --max-reps (2 × reps)
 *        --warmup-mode auto|fixed (auto: stop the warm-up at steady state, ≥ --min-warmup 6 s,
 *          ≤ --warmup)   --join-concurrency 4 (game, join-impaired: 1)   --settle-ms 250
 *        --parallel K  (idle, soak, join-impaired only) K configs at once, hosts pinned to their
 *          own cores on Linux   --pin  pin host / rest cores even without --parallel
 *
 * Process layout per repetition (each process fresh):
 *   this process ── FakeMaster (HTTP + signaling WS, 127.0.0.1)
 *   host-proc.mjs × procs   the host under test (plain JS, no TS loader); measures itself
 *   clients-proc.mjs × ceil(clients/10)   node-haxball clients (never counted)
 *
 * Machine-wide CPU (foreign load): /proc/stat on Linux, os.cpus() elsewhere.
 */
import { fork, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeMaster } from '../../test/fake-master/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const IS_BUN = typeof (globalThis as Any).Bun !== 'undefined';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const scenario = argv[0] ?? 'game';
/** --quick: development profile (small N, short windows, few reps). Never publishable. */
const QUICK = argv.includes('--quick');
/** `quick` is the default under --quick (an explicit flag always wins). */
function flag(name: string, def: string, quick?: string): string {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]!;
  return QUICK && quick !== undefined ? quick : def;
}
const list = (s: string) => s.split(',').filter(Boolean);
const nums = (s: string) => list(s).map(Number);
const DEFAULT_IMPL: Record<string, string> = { rooms: 'haxlite', soak: 'haxlite:rtc', fleet: 'haxlite:rtc', 'join-impaired': 'haxlite:rtc' };
const IMPLS = list(flag('impl', DEFAULT_IMPL[scenario] ?? 'haxlite,official,nodehaxball'));
const RUNTIME = flag('runtime', 'node');
if (RUNTIME !== 'node' && RUNTIME !== 'bun') throw new Error(`--runtime must be node or bun (got ${RUNTIME})`);
const DEFAULT_REPS: Record<string, string> = { startup: '10', soak: '1', 'join-impaired': '1' };
const QUICK_REPS: Record<string, string> = { startup: '3', soak: '1', 'join-impaired': '1' };
/** --reps: repetitions (the minimum when --precision is on). */
const REPS = Number(flag('reps', DEFAULT_REPS[scenario] ?? '3', QUICK_REPS[scenario] ?? '2'));
/**
 * --precision P (% , 0 = off): after --reps, keep adding interleaved repetitions to the
 * configurations whose key metric (startup: process start → link; join-impaired: join p50;
 * otherwise host CPU %) still has a 95 % CI half-width (Student t, of the mean) above P % of
 * the mean, up to --max-reps (default 2 × reps with precision, = reps without).
 */
const PRECISION = Number(flag('precision', '0').replace('%', ''));
const MAX_REPS = Math.max(REPS, Number(flag('max-reps', String(PRECISION > 0 ? Math.max(2 * REPS, REPS + 2) : REPS))));
/** --warmup: warm-up seconds (the cap with --warmup-mode auto). */
const WARMUP_S = Number(flag('warmup', scenario === 'idle' ? '10' : scenario === 'soak' ? '60' : '15', scenario === 'soak' ? '10' : '3'));
/**
 * --warmup-mode auto (default): the warm-up ends as soon as the host is in steady state
 * (two consecutive 3 s blocks of 1 s probes: CPU within 5 % or 0.25 points, RSS within 1 %),
 * never before --min-warmup (6 s) and never after --warmup. `fixed`: always --warmup.
 * soak (churn) is always fixed. The warm-up actually used is saved per run (`warmup`).
 */
const WARMUP_MODE = flag('warmup-mode', 'auto');
if (WARMUP_MODE !== 'auto' && WARMUP_MODE !== 'fixed') throw new Error(`--warmup-mode must be auto or fixed (got ${WARMUP_MODE})`);
const MIN_WARMUP_S = Number(flag('min-warmup', '6', '2'));
const WINDOW_S = Number(flag('window', scenario === 'idle' ? '200' : '60', scenario === 'idle' ? '20' : '10'));
const NS = nums(flag('n', '4,10,20', '4,10'));
const KS = nums(flag('k', '1,5,10', '1,5'));
const PROCS = nums(flag('procs', '3'));
const ROOMS_PER_PROC = nums(flag('rooms', '4', scenario === 'fleet' || scenario === 'soak' ? '2' : undefined));
const CLIENTS = nums(flag('clients', '4', scenario === 'fleet' || scenario === 'soak' ? '2' : undefined));
const SOAK_MIN = Number(flag('minutes', '360', '3'));
const SAMPLE_S = Number(flag('sample-s', '60', '15'));
const STAY_S = nums(flag('stay-s', '20,90'));
const PAUSE_S = nums(flag('pause-s', '2,15'));
const RTT = nums(flag('rtt', '40'));
const LOSS = nums(flag('loss', '0,1,3', '0,3'));
const JITTER = Number(flag('jitter', '0'));
const STUN = list(flag('stun', 'cold,cached'));
const JOINS = Number(flag('joins', '20', '5'));
const NAT_OUTSIDE = flag('nat-outside', '127.0.0.1');
const NAT_FILTERING = flag('nat-filtering', 'endpoint-independent');
const MAX_FOREIGN = Number(flag('max-foreign', '100'));
const ATTEMPTS = Number(flag('attempts', '2'));
/**
 * Event-loop lag (game, rooms, fleet, soak). The monitor is a 100 Hz timer in the measured
 * process (≈ 100 extra wake-ups/s and real CPU), so by default it runs in its OWN sub-window of
 * --eld-window seconds (10; --quick 3) right after the warm-up and BEFORE the CPU window, which
 * then runs with no monitor: CPU %, per-thread CPU and wake-ups never include it.
 *   --eld 0               no lag at all
 *   --eld-method timer    (default) the same setInterval(10 ms) monitor on Node and Bun: comparable
 *                native   Node's perf_hooks.monitorEventLoopDelay (Bun falls back to timer)
 *   --eld-mode separate   (default) sub-window as above
 *              inline     monitor inside the CPU window (the method before 16-10-2026; diagnostics:
 *                         it inflates CPU/wake-ups, more on Bun, whose monitor was a JS timer)
 * Every run records how its lag was measured in host.eld.{method, window, windowMs}.
 */
const ELD = flag('eld', '1') !== '0';
const ELD_WINDOW_S = Number(flag('eld-window', '10', '3'));
const ELD_METHOD = flag('eld-method', 'timer');
if (ELD_METHOD !== 'timer' && ELD_METHOD !== 'native') throw new Error(`--eld-method must be timer or native (got ${ELD_METHOD})`);
const ELD_MODE = flag('eld-mode', 'separate');
if (ELD_MODE !== 'separate' && ELD_MODE !== 'inline') throw new Error(`--eld-mode must be separate or inline (got ${ELD_MODE})`);
/**
 * --join-concurrency C: joins in flight per clients process (≤ 10 clients each). Default 4 for
 * rooms and fleet (set-up only); 1 (sequential, as before) for game, whose join p50/p90 is a
 * published row, and for join-impaired, whose metric is the latency of one isolated join.
 * Concurrent joins measure a slightly higher latency (+1–3 % p50 on loopback, more at p90 for
 * the hosts with a 2 s join); report.mjs marks the join columns of such runs. --quick: 4 (not join-impaired).
 */
const JOIN_CONCURRENCY = Number(
  flag('join-concurrency', scenario === 'game' || scenario === 'join-impaired' ? '1' : '4', scenario === 'join-impaired' ? '1' : '4'),
);
/** --settle-ms: pause after a repetition's processes have exited (they are awaited, ≤ 2.5 s). */
const SETTLE_MS = Number(flag('settle-ms', '250'));
/**
 * --parallel K: run up to K configurations of the same repetition at once. Only for the
 * scenarios whose metrics do not depend on CPU contention (idle: < 1 % of a core per host;
 * soak: memory slopes; join-impaired: join latency); refused elsewhere. On Linux with
 * `taskset`, every host gets its own core (see --pin); `machine.foreignPct` then includes the
 * sibling runs (an upper bound of the foreign load).
 */
const PARALLEL = Math.max(1, Number(flag('parallel', '1')));
const PARALLEL_OK = new Set(['idle', 'soak', 'join-impaired']);
if (PARALLEL > 1 && !PARALLEL_OK.has(scenario)) throw new Error(`--parallel is only valid for ${[...PARALLEL_OK].join(', ')} (it would skew the CPU of ${scenario})`);
/** --pin: pin hosts and the rest to separate cores with taskset (Linux; implied by --parallel > 1). */
const PIN_WANTED = argv.includes('--pin') || PARALLEL > 1;
const OUT = flag('out', path.join(ROOT, `bench/results/${QUICK ? 'dev/' : ''}${scenario}.json`));
const CLIENTS_PER_PROC = 10;
/** Extra node flags for the host process only, e.g. "--cpu-prof --cpu-prof-dir=/tmp/prof" (diagnostics). */
const HOST_NODE_ARGS = list(flag('host-node-args', '').replace(/ +/g, ','));

/** `haxlite:rtc@bun` → { impl: 'haxlite:rtc', runtime: 'bun' }. */
function splitImpl(s: string): { impl: string; runtime: 'node' | 'bun' } {
  const at = s.lastIndexOf('@');
  const rt = at > 0 ? s.slice(at + 1) : RUNTIME;
  if (rt !== 'node' && rt !== 'bun') throw new Error(`unknown runtime in ${s}`);
  return { impl: at > 0 ? s.slice(0, at) : s, runtime: rt };
}

// ------------------------------------------------------------------ runtimes
let bunPath: string | null = null;
/** The real Bun executable (on Windows `bun` on PATH is a .cmd shim that fork() cannot start). */
function bunExecutable(): string {
  if (bunPath !== null) return bunPath;
  if (process.env.BUN_PATH) return (bunPath = process.env.BUN_PATH);
  if (IS_BUN) return (bunPath = process.execPath);
  try {
    bunPath = execSync('bun -e "console.log(process.execPath)"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('Bun not found: install it or set BUN_PATH');
  }
  return bunPath;
}
function runtimeVersion(rt: 'node' | 'bun'): string {
  if (rt === 'node') return IS_BUN ? 'node (see info.node)' : process.version;
  try {
    return `bun ${execFileSync(bunExecutable(), ['--version'], { encoding: 'utf8' }).trim()}`;
  } catch {
    return 'bun (unknown)';
  }
}
const TS_LOADER = pathToFileURL(path.join(ROOT, 'bench/ts-resolve.mjs')).href;

// ------------------------------------------------------------------ core pinning (Linux, taskset)
const NCPU = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const HAS_TASKSET = ((): boolean => {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('taskset', ['-p', String(process.pid)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const PIN = PIN_WANTED && HAS_TASKSET && NCPU >= 2;
if (PIN_WANTED && !PIN) console.log(`(--pin/--parallel: no taskset or < 2 CPUs here, processes are not pinned)`);
/**
 * Core layout when pinning (`info.cores`): host processes on cores 0 … H−1, one core each
 * (H = parallel × host processes per run, capped so that ≥ 1 core is left; hosts beyond H
 * share round-robin), and everything else — this orchestrator, the FakeMaster, the client
 * processes — on cores H … NCPU−1. 4 vCPU: `--parallel 2` → hosts 0 and 1, rest 2–3;
 * `--parallel 3` → hosts 0, 1, 2, rest 3; `--pin` alone → host 0, rest 1–3.
 */
function coreLayout(hostsPerRun: number): { hostCores: number; rest: string } {
  const h = Math.max(1, Math.min(PARALLEL * hostsPerRun, NCPU - 1));
  return { hostCores: h, rest: h === NCPU - 1 ? String(h) : `${h}-${NCPU - 1}` };
}
const hostCore = (slot: number, p: number, hostsPerRun: number) => String((slot * hostsPerRun + p) % coreLayout(hostsPerRun).hostCores);
let pinnedSelfTo = '';
/** The orchestrator (and the FakeMaster in it) runs on the `rest` cores. */
function pinSelf(rest: string): void {
  if (!PIN || pinnedSelfTo === rest) return;
  execFileSync('taskset', ['-a', '-cp', rest, String(process.pid)], { stdio: 'ignore' });
  pinnedSelfTo = rest;
}

// ------------------------------------------------------------------ child helper
class Child {
  readonly msgs: Any[] = [];
  readonly errors: string[] = [];
  readonly tail: string[] = [];
  readonly name: string;
  readonly proc: ChildProcess;
  private waiters: (() => void)[] = [];
  /** Called for every message (soak: streamed samples). */
  onMessage: ((m: Any) => void) | null = null;
  exited = false;
  /** Resolves when the process has exited. */
  readonly exitP: Promise<void>;
  constructor(name: string, proc: ChildProcess) {
    this.name = name;
    this.proc = proc;
    this.exitP = new Promise<void>((r) => proc.once('exit', () => r()));
    proc.on('message', (m: Any) => {
      if (m?.type === 'error') this.errors.push(m.message);
      this.msgs.push(m);
      this.onMessage?.(m);
      for (const w of this.waiters.splice(0)) w();
    });
    const keep = (d: Buffer) => {
      for (const line of d.toString().split('\n')) if (line.trim()) this.tail.push(line.slice(0, 300));
      if (this.tail.length > 40) this.tail.splice(0, this.tail.length - 40);
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    proc.on('error', (e) => this.errors.push(`${name}: ${e.message}`));
    proc.on('exit', (code) => {
      this.exited = true;
      this.errors.push(`${name} exited (${code})`);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  static spawn(
    name: string,
    script: string,
    args: string[],
    o: { execArgv?: string[]; runtime?: 'node' | 'bun'; env?: Record<string, string>; tsLoader?: boolean; cores?: string } = {},
  ): Child {
    const bun = o.runtime === 'bun';
    // execArgv: [] → no TypeScript loader in the children (unless tsLoader: join-impaired imports test/rtc/nat-sim.ts).
    const execArgv = bun ? [] : [...(o.tsLoader ? ['--no-warnings', '--import', TS_LOADER] : []), ...(o.execArgv ?? [])];
    // fork() a Bun child: Bun speaks Node's IPC channel (NODE_CHANNEL_FD), also on Windows.
    // A Bun orchestrator forking a Node child: execPath must then be node.
    const execPath = bun ? bunExecutable() : IS_BUN ? 'node' : process.execPath;
    // Pinned: `taskset -c <cores> <runtime> …` execs the runtime in the same process (same
    // pid, IPC fd inherited), so every thread it ever creates inherits the mask.
    const pinned = PIN && o.cores !== undefined;
    const proc = fork(path.join(HERE, script), args, {
      execArgv: pinned ? ['-c', o.cores!, execPath, ...execArgv] : execArgv,
      execPath: pinned ? 'taskset' : execPath,
      env: o.env ? { ...process.env, ...o.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    return new Child(name, proc);
  }
  send(m: Any): void {
    if (!this.exited) this.proc.send(m);
  }
  /** Waits for `count` messages of `type` (counting from the start). */
  async wait(type: string, timeoutMs: number, count = 1): Promise<Any[]> {
    const t0 = Date.now();
    for (;;) {
      const got = this.msgs.filter((m) => m.type === type);
      if (got.length >= count) return got;
      if (this.exited) throw new Error(`${this.name} exited while waiting for ${type}: ${this.errors.join(' | ')} ${this.tail.join('\n')}`);
      const left = timeoutMs - (Date.now() - t0);
      if (left <= 0) throw new Error(`${this.name}: timeout waiting for ${type} ×${count}: ${this.errors.join(' | ')}\n${this.tail.join('\n')}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
  async request(cmd: Any, type: string, timeoutMs = 30_000): Promise<Any> {
    const before = this.msgs.filter((m) => m.type === type).length;
    this.send(cmd);
    const got = await this.wait(type, timeoutMs, before + 1);
    return got[before];
  }
  kill(): void {
    this.send({ cmd: 'exit' });
    setTimeout(() => this.proc.kill('SIGKILL'), 2000).unref();
  }
}

// ------------------------------------------------------------------ system CPU (to detect foreign load)
const HAS_PROC_STAT = existsSync('/proc/stat');
/** Busy CPU time of the whole machine so far, in ms (all cores). */
function sysBusyMs(): number {
  if (HAS_PROC_STAT) {
    const cpu = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
    const idle = cpu[3]! + cpu[4]!;
    const total = cpu.reduce((a, b) => a + b, 0);
    return (total - idle) * 10; // USER_HZ = 100
  }
  // Windows / macOS: per-core times in ms (coarser, but the same meaning)
  let busy = 0;
  for (const c of os.cpus()) busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
  return busy;
}

// ------------------------------------------------------------------ one repetition
interface RunSpec {
  impl: string;
  runtime: 'node' | 'bun';
  /** host processes (fleet; 1 otherwise) */
  procs: number;
  rooms: number;
  clientsPerRoom: number;
  /** warm-up: the cap with warmupMode 'auto' (steady-state detection), the duration with 'fixed' */
  warmupS: number;
  warmupMode: 'auto' | 'fixed';
  minWarmupS: number;
  windowS: number;
  /** joins in flight per clients process */
  joinConcurrency: number;
  /** measure event-loop lag (how: eldMode / eldMethod / eldWindowS) */
  eld: boolean;
  eldMode: 'separate' | 'inline';
  eldMethod: 'timer' | 'native';
  eldWindowS: number;
  sampleMs: number;
  seed: number;
  /** soak: clients join/leave continuously; samples streamed every sampleMs */
  churn?: { stayS: number[]; pauseS: number[] } | null;
  /** join-impaired */
  impair?: { rttMs: number; lossPct: number; jitterMs: number; stun: string; outside: string; filtering: string } | null;
}

/** Sums the per-process stats of a fleet into one `host`-shaped record (CPU/memory/GC add up). */
function aggregateHosts(all: Any[]): Any {
  if (all.length === 1) return all[0];
  const sum = (f: (s: Any) => number | null | undefined) => {
    const xs = all.map(f);
    return xs.some((x) => x === null || x === undefined) ? null : (xs as number[]).reduce((a, b) => a + b, 0);
  };
  const max = (f: (s: Any) => number) => Math.max(...all.map(f));
  const r1 = (x: number | null) => (x === null ? null : +x.toFixed(1));
  const out: Any = {
    runtime: all[0].runtime,
    processes: all.length,
    wallMs: max((s) => s.wallMs),
    cpuUserMs: sum((s) => s.cpuUserMs),
    cpuSystemMs: sum((s) => s.cpuSystemMs),
    cpuPct: sum((s) => s.cpuPct),
    rssStart: sum((s) => s.rssStart),
    rssEnd: sum((s) => s.rssEnd),
    rssMean: sum((s) => s.rssMean),
    rssMax: sum((s) => s.rssMax), // upper bound: per-process maxima need not coincide
    heapUsedStart: sum((s) => s.heapUsedStart),
    heapUsedEnd: sum((s) => s.heapUsedEnd),
    heapUsedMean: sum((s) => s.heapUsedMean),
    heapUsedMax: sum((s) => s.heapUsedMax),
    heapTotalEnd: sum((s) => s.heapTotalEnd),
    externalEnd: sum((s) => s.externalEnd),
    gcCount: sum((s) => s.gcCount),
    gcMs: sum((s) => s.gcMs),
    // event-loop lag: the worst process
    eld: all.every((s) => s.eld)
      ? { method: all[0].eld.method, window: all[0].eld.window, windowMs: max((s) => s.eld.windowMs ?? 0), p50: max((s) => s.eld.p50), p90: max((s) => s.eld.p90), p99: max((s) => s.eld.p99), max: max((s) => s.eld.max), mean: max((s) => s.eld.mean), worstOf: all.length }
      : null,
    cpuSplit: all.every((s) => s.cpuSplit) ? { mainPct: sum((s) => s.cpuSplit.mainPct), otherPct: sum((s) => s.cpuSplit.otherPct) } : null,
    wakeups: all.every((s) => s.wakeups) ? { voluntaryPerS: sum((s) => s.wakeups.voluntaryPerS), involuntaryPerS: sum((s) => s.wakeups.involuntaryPerS), mainVoluntaryPerS: sum((s) => s.wakeups.mainVoluntaryPerS) } : null,
    threadCount: sum((s) => s.threadCount),
    fdCount: sum((s) => s.fdCount),
    rtc: all.every((s) => s.rtc)
      ? { packetsInPerS: r1(sum((s) => s.rtc.packetsInPerS)), packetsOutPerS: r1(sum((s) => s.rtc.packetsOutPerS)), bytesInPerS: r1(sum((s) => s.rtc.bytesInPerS)), bytesOutPerS: r1(sum((s) => s.rtc.bytesOutPerS)) }
      : null,
  };
  return out;
}

/** Merges the clients' sparse gap histograms / message counters into per-label totals. */
function mergeTraffic(reports: Any[]): Any {
  const by: Record<string, { msgs: number; bytes: number; binMs: number; n: number; max: number; bins: Map<number, number> }> = {};
  let wallMs = 0;
  for (const r of reports) {
    const t = r.traffic;
    if (!t) continue;
    wallMs = Math.max(wallMs, t.wallMs);
    for (const [label, x] of Object.entries<Any>(t.byLabel)) {
      const m = (by[label] ??= { msgs: 0, bytes: 0, binMs: x.gaps.binMs, n: 0, max: 0, bins: new Map() });
      m.msgs += x.msgs;
      m.bytes += x.bytes;
      m.n += x.gaps.n;
      m.max = Math.max(m.max, x.gaps.max);
      for (const [b, c] of x.gaps.bins) m.bins.set(b, (m.bins.get(b) ?? 0) + c);
    }
  }
  const out: Any = { wallMs, byLabel: {} };
  for (const [label, m] of Object.entries(by)) out.byLabel[label] = { msgs: m.msgs, bytes: m.bytes, gaps: histPct(m.bins, m.n, m.max, m.binMs) };
  // headline: gap between consecutive messages of one client on any channel, pooled over the clients
  const any = new Map<number, number>();
  let anyN = 0;
  let anyMax = 0;
  let binMs = 0.05;
  for (const r of reports) {
    const g = r.traffic?.anyGaps;
    if (!g) continue;
    binMs = g.binMs;
    anyN += g.n;
    anyMax = Math.max(anyMax, g.max);
    for (const [b, c] of g.bins) any.set(b, (any.get(b) ?? 0) + c);
  }
  out.gapsAll = histPct(any, anyN, anyMax, binMs);
  out.msgs = Object.values(by).reduce((a, m) => a + m.msgs, 0);
  out.bytes = Object.values(by).reduce((a, m) => a + m.bytes, 0);
  return out;
}
function histPct(bins: Map<number, number>, n: number, max: number, binMs: number): Any {
  const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  const q = (p: number) => {
    let target = Math.ceil(n * p);
    // the clients' last bin (≥ 2 s) collects the overflow: report the true maximum there
    for (const [b, c] of sorted) if ((target -= c) <= 0) return (b + 1) * binMs >= 2000 ? +max.toFixed(3) : +((b + 0.5) * binMs).toFixed(3);
    return max;
  };
  return { n, p50: q(0.5), p99: q(0.99), p999: q(0.999), max: +max.toFixed(3) };
}

/** Linear regression slope of y over x (least squares). */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

/** Soak series → slopes (per hour) and drifts, per host process. */
function soakSummary(samples: Any[]): Any {
  if (samples.length < 2) return { samples: samples.length };
  const h = samples.map((s) => s.t / 3_600_000);
  const sl = (f: (s: Any) => number) => +slope(h, samples.map(f)).toFixed(3);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const fds = samples.map((s) => s.fds).filter((x) => x !== null);
  const mapsDrift: Record<string, number> = {};
  for (const k of Object.keys(last.maps ?? {})) mapsDrift[k] = (last.maps[k] ?? 0) - (first.maps?.[k] ?? 0);
  return {
    samples: samples.length,
    hours: +(h[h.length - 1]! - h[0]!).toFixed(3),
    rssSlopeMBph: sl((s) => s.rss / MB),
    heapUsedSlopeMBph: sl((s) => s.heapUsed / MB),
    heapTotalSlopeMBph: sl((s) => s.heapTotal / MB),
    externalSlopeMBph: sl((s) => s.external / MB),
    rssStartMB: +(first.rss / MB).toFixed(1),
    rssEndMB: +(last.rss / MB).toFixed(1),
    fdStart: fds.length ? fds[0] : null,
    fdEnd: fds.length ? fds[fds.length - 1] : null,
    fdDrift: fds.length ? fds[fds.length - 1] - fds[0] : null,
    fdSlopePerH: fds.length >= 2 ? +slope(h.filter((_, i) => samples[i].fds !== null), fds).toFixed(2) : null,
    mapsDrift,
  };
}

/**
 * Warm-up. 'fixed': sleeps warmupS. 'auto': probes every host once per second (process CPU
 * and RSS, summed over the hosts) and stops at the first moment, after minWarmupS, when the
 * last two 3 s blocks agree — CPU % within 5 % (or 0.25 points of a core, the resolution of
 * 1 s probes at low load) and RSS over the last block within 1 % — or at warmupS otherwise.
 */
async function warmUp(hosts: Child[], spec: RunSpec): Promise<Any> {
  const capMs = spec.warmupS * 1000;
  if (capMs <= 0) return { mode: 'none', ms: 0 };
  if (spec.warmupMode === 'fixed' || spec.churn || spec.minWarmupS >= spec.warmupS) {
    await sleep(capMs);
    return { mode: 'fixed', ms: capMs };
  }
  const B = 3;
  const t0 = performance.now();
  const pts: { t: number; cpu: number; rss: number }[] = [];
  for (;;) {
    const ps = await Promise.all(hosts.map((h) => h.request({ cmd: 'probe' }, 'probe', 10_000)));
    const t = performance.now();
    pts.push({ t, cpu: ps.reduce((a, p) => a + p.cpuMs, 0), rss: ps.reduce((a, p) => a + p.rss, 0) });
    const el = t - t0;
    const n = pts.length;
    if (el >= spec.minWarmupS * 1000 && n >= 2 * B + 1) {
      const pct = (a: number, b: number) => ((pts[b]!.cpu - pts[a]!.cpu) / (pts[b]!.t - pts[a]!.t)) * 100;
      const cpuA = pct(n - 1 - 2 * B, n - 1 - B);
      const cpuB = pct(n - 1 - B, n - 1);
      const cpuOk = Math.abs(cpuB - cpuA) <= Math.max(0.05 * Math.max(cpuA, cpuB), 0.25);
      const rssOk = Math.abs(pts[n - 1]!.rss - pts[n - 1 - B]!.rss) <= 0.01 * pts[n - 1 - B]!.rss;
      if (cpuOk && rssOk) return { mode: 'auto', ms: Math.round(el), steady: true, cpuPctBlocks: [+cpuA.toFixed(3), +cpuB.toFixed(3)] };
    }
    if (el >= capMs) return { mode: 'auto', ms: Math.round(el), steady: false };
    await sleep(Math.min(1000, capMs - el));
  }
}

async function runOnce(spec: RunSpec, onProgress: (partial: Any) => void, slot = 0): Promise<Any> {
  const layout = coreLayout(spec.procs);
  pinSelf(layout.rest);
  const master = await FakeMaster.start();
  const children: Child[] = [];
  const result: Any = { ...spec };
  if (PIN) result.cores = { hosts: Array.from({ length: spec.procs }, (_, p) => hostCore(slot, p, spec.procs)), rest: layout.rest };
  try {
    const tFork = performance.now();
    const sysFork = sysBusyMs();
    const selfFork = process.cpuUsage();
    const env: Record<string, string> = spec.impair ? { HAXLITE_BENCH_IMPAIR: JSON.stringify(spec.impair) } : {};
    const hosts: Child[] = [];
    for (let p = 0; p < spec.procs; p++) {
      hosts.push(
        Child.spawn(`host${p}`, 'host-proc.mjs', [spec.impl, master.hostPort, String(spec.rooms)], {
          runtime: spec.runtime,
          execArgv: HOST_NODE_ARGS,
          env,
          tsLoader: !!spec.impair,
          cores: hostCore(slot, p, spec.procs),
        }),
      );
    }
    children.push(...hosts);
    const linksPer = await Promise.all(hosts.map((h) => h.wait('link', 60_000, spec.rooms)));
    const tLinked = performance.now();
    const sysLinked = sysBusyMs();
    const selfLinked = process.cpuUsage(selfFork);
    const links = linksPer[0]!;
    const hostsCpuAtLink = linksPer.reduce((a, ls) => a + Math.max(...ls.map((l: Any) => l.cpuMs)), 0);
    result.startup = {
      forkToLinkMs: tLinked - tFork, // only meaningful for rooms = 1
      links: links.map((l: Any) => ({ room: l.room, tStart: l.tStart, tLoad: l.tLoad, tCreate: l.tCreate, tLink: l.tLink, createToLinkMs: l.tLink - l.tCreate, cpuMs: l.cpuMs, rss: l.rss, heapUsed: l.heapUsed })),
      // other processes' CPU between fork and the last link (% of one core)
      foreignPct: Math.max(0, ((sysLinked - sysFork - hostsCpuAtLink - (selfLinked.user + selfLinked.system) / 1000) / (tLinked - tFork)) * 100),
    };
    // room ids of every process, process by process
    const ids: string[] = linksPer.flatMap((ls) => [...ls].sort((a, b) => a.room - b.room).map((l: Any) => l.id));

    let clients: Child[] = [];
    if (spec.clientsPerRoom > 0) {
      // Split the clients into processes of ≤ 10 (a room may span processes).
      const groups: string[][] = [[]];
      let inGroup = 0;
      for (const id of ids) {
        let left = spec.clientsPerRoom;
        while (left > 0) {
          if (inGroup === CLIENTS_PER_PROC) {
            groups.push([]);
            inGroup = 0;
          }
          const n = Math.min(left, CLIENTS_PER_PROC - inGroup);
          groups[groups.length - 1]!.push(`${id}:${n}`);
          inGroup += n;
          left -= n;
        }
      }
      const copts = JSON.stringify({ ...(spec.churn ? { churn: spec.churn } : null), joinConcurrency: spec.joinConcurrency });
      clients = groups.map((g, i) => Child.spawn(`clients${i}`, 'clients-proc.mjs', [master.hostPort, g.join(','), String(spec.seed * 100 + i + 1), copts], { cores: layout.rest }));
      children.push(...clients);
      const joined = await Promise.all(clients.map((c) => c.wait('joined', 240_000 + (spec.impair ? JOINS * 32_000 : 0))));
      result.join = joined.map((j) => j[0]);
      if (spec.impair) {
        // join-impaired: only the join latency matters
        result.impairStats = await Promise.all(hosts.map((h) => h.request({ cmd: 'impair-stats' }, 'impair-stats')));
        result.errors = children.flatMap((c) => c.errors.filter((e) => !e.includes('exited')).map((e) => `${c.name}: ${e.slice(0, 500)}`));
        result.valid = hosts.every((h) => h.errors.length === 0);
        return result;
      }
      const expected = spec.rooms * spec.clientsPerRoom * spec.procs;
      const total = result.join.reduce((a: number, j: Any) => a + j.joined, 0);
      if (total !== expected) throw new Error(`only ${total}/${expected} clients joined`);
      if (spec.churn) {
        // soak: teams are given as players arrive, the game runs from the start
        await Promise.all(hosts.map((h) => h.request({ cmd: 'auto-teams' }, 'auto-teams')));
      } else {
        // the host must see everybody before teams are assigned
        const t0 = Date.now();
        for (;;) {
          const ps = await Promise.all(hosts.map((h) => h.request({ cmd: 'players' }, 'players')));
          if (ps.every((p) => p.counts.every((c: number) => c === spec.clientsPerRoom))) break;
          if (Date.now() - t0 > 20_000) throw new Error(`hosts see ${ps.map((p) => p.counts).join(' / ')} players`);
          await sleep(200);
        }
        result.game = await Promise.all(hosts.map((h) => h.request({ cmd: 'game' }, 'game')));
      }
      await Promise.all(clients.map((c) => c.request({ cmd: 'drive' }, 'driving')));
    }

    result.warmup = await warmUp(hosts, spec);
    // Lag sub-window: the monitor runs here, alone, never during the CPU window below.
    let lagPer: Any[] | null = null;
    if (spec.eld && spec.eldMode === 'separate' && spec.eldWindowS > 0) {
      await Promise.all(hosts.map((h) => h.request({ cmd: 'lag-start', method: spec.eldMethod }, 'lag-started')));
      await sleep(spec.eldWindowS * 1000);
      lagPer = (await Promise.all(hosts.map((h) => h.request({ cmd: 'lag-stop' }, 'lag')))).map((m) => m.eld);
    }
    const load0 = os.loadavg();
    const sys0 = sysBusyMs();
    const self0 = process.cpuUsage();
    if (spec.churn) {
      result.series = hosts.map(() => [] as Any[]);
      hosts.forEach((h, p) => {
        h.onMessage = (m) => {
          if (m.type !== 'sample') return;
          const { type: _t, ...s } = m;
          result.series[p].push(s);
          result.soak = result.series.map(soakSummary);
          onProgress(result);
        };
      });
    }
    await Promise.all([
      ...hosts.map((h) => h.request({ cmd: 'measure-start', eld: spec.eld && spec.eldMode === 'inline', eldMethod: spec.eldMethod, sampleMs: spec.sampleMs, stream: !!spec.churn }, 'measuring')),
      ...clients.map((c) => c.request({ cmd: 'window' }, 'window')),
    ]);
    const tw0 = performance.now();
    await sleep(spec.windowS * 1000);
    const stopped = await Promise.all(hosts.map((h) => h.request({ cmd: 'measure-stop' }, 'stats')));
    const reports = await Promise.all(clients.map((c) => c.request({ cmd: 'stop' }, 'report')));
    const windowMs = performance.now() - tw0;
    const sys1 = sysBusyMs();
    const self = process.cpuUsage(self0);
    const lags = lagPer;
    if (lags) stopped.forEach((s, p) => (s.stats.eld = lags[p] ?? null));
    result.hosts = stopped.length > 1 ? stopped.map((s) => s.stats) : undefined;
    result.host = aggregateHosts(stopped.map((s) => s.stats));
    result.hostPlayersAtEnd = stopped.flatMap((s) => s.players);
    result.clients = reports.map(({ frames, traffic: _t, ...r }: Any) => ({ ...r, minFrame: Math.min(...frames), maxFrame: Math.max(...frames) }));
    result.traffic = mergeTraffic(reports);
    // Per-player egress of the host: UDP level (haxlite-rtc endpoint counters) and
    // application level (messages/bytes the clients received), divided by the players.
    // churn: the mean number of connected players over the samples
    const series: Any[] = spec.churn ? (result.series as Any[][]).flat() : [];
    const players = spec.churn
      ? series.reduce((a, s) => a + s.players.reduce((x: number, y: number) => x + y, 0), 0) / Math.max(1, series.length / spec.procs) || 1
      : (result.hostPlayersAtEnd as number[]).reduce((a, b) => a + b, 0) || spec.procs * spec.rooms * spec.clientsPerRoom;
    const tw = result.traffic.wallMs || windowMs;
    result.egressPerPlayer = {
      players: +players.toFixed(2),
      udpBytesPerS: result.host.rtc ? +(result.host.rtc.bytesOutPerS / players).toFixed(1) : null,
      udpPacketsPerS: result.host.rtc ? +(result.host.rtc.packetsOutPerS / players).toFixed(2) : null,
      appBytesPerS: +((result.traffic.bytes / players / tw) * 1000).toFixed(1),
      appMsgsPerS: +((result.traffic.msgs / players / tw) * 1000).toFixed(2),
    };
    if (spec.churn) result.soak = result.series.map(soakSummary);
    // Everything that ran on the machine during the window minus our own processes
    // (host, clients, this orchestrator incl. the FakeMaster) = foreign load.
    const sysBusyPct = ((sys1 - sys0) / windowMs) * 100; // % of ONE core
    const oursPct = result.host.cpuPct + reports.reduce((a: number, r: Any) => a + r.cpuPct, 0) + ((self.user + self.system) / 1000 / windowMs) * 100;
    result.machine = { loadavgStart: load0, loadavgEnd: os.loadavg(), sysBusyPct, foreignPct: Math.max(0, sysBusyPct - oursPct) };
    const disconnected = result.clients.reduce((a: number, r: Any) => a + r.disconnected, 0);
    result.valid = spec.churn
      ? hosts.every((h) => h.errors.length === 0)
      : disconnected === 0 && (result.hostPlayersAtEnd as number[]).every((c) => c === spec.clientsPerRoom) && hosts.every((h) => h.errors.length === 0);
    result.errors = children.flatMap((c) => c.errors.filter((e) => !e.includes('exited')).map((e) => `${c.name}: ${e.slice(0, 500)}`));
    return result;
  } finally {
    // Wait for the processes to be gone (they exit on 'exit'; SIGKILL after 2 s) instead of
    // fixed sleeps, then a short settle (--settle-ms) before the next repetition.
    for (const c of children) c.kill();
    await Promise.race([Promise.all(children.map((c) => c.exitP)), sleep(2500)]);
    await master.close();
    await sleep(SETTLE_MS);
  }
}

async function runWithRetry(spec: RunSpec, onProgress: (partial: Any) => void, slot = 0): Promise<Any> {
  const discarded: Any[] = [];
  const foreignOf = (d: Any) => (spec.windowS <= 1 || spec.impair ? d.startup.foreignPct : d.machine.foreignPct);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let r: Any;
    try {
      r = await runOnce(spec, onProgress, slot);
    } catch (e) {
      r = { ...spec, failed: String((e as Error).message ?? e).slice(0, 2000) };
      console.log(`    failed: ${r.failed.split('\n')[0]}`);
      discarded.push(r);
      continue;
    }
    // soak: hours of data are never thrown away for noise; join-impaired measures latency, not CPU
    if (!spec.churn && !spec.impair && foreignOf(r) > MAX_FOREIGN) {
      console.log(`    noisy (foreign load ${foreignOf(r).toFixed(0)} % of a core), repeating`);
      discarded.push({ ...r, discardedAsNoisy: true });
      await sleep(5_000);
      continue;
    }
    r.discarded = discarded;
    return r;
  }
  // Machine never got quiet enough: keep the least noisy valid attempt, flagged.
  const noisy = discarded.filter((d) => d.discardedAsNoisy);
  if (noisy.length > 0) {
    const best = noisy.reduce((a, b) => (foreignOf(b) < foreignOf(a) ? b : a));
    console.log(`    keeping least noisy attempt (foreign ${foreignOf(best).toFixed(0)} %)`);
    return { ...best, discardedAsNoisy: false, noisy: true, discarded: discarded.filter((d) => d !== best) };
  }
  return { ...spec, failed: 'too many failed attempts', discarded };
}

// ------------------------------------------------------------------ summary helpers
/** Student t quantile 0.975 for 1 … 30 degrees of freedom (normal beyond). */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
/**
 * median / min / max over the repetitions, plus the mean and the half-width of its 95 %
 * confidence interval (Student t; `ci95Pct` = half-width as % of the mean; null with n < 2).
 */
function stat(xs: number[]): { median: number; min: number; max: number; n: number; mean: number; ci95: number | null; ci95Pct: number | null } {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = s.length;
  const median = n === 0 ? NaN : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  const mean = n === 0 ? NaN : s.reduce((a, b) => a + b, 0) / n;
  let ci95: number | null = null;
  let ci95Pct: number | null = null;
  if (n >= 2) {
    const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
    ci95 = (T975[n - 2] ?? 1.96) * (sd / Math.sqrt(n));
    ci95Pct = mean !== 0 ? (ci95 / Math.abs(mean)) * 100 : ci95 === 0 ? 0 : Infinity;
  }
  return { median, min: s[0] ?? NaN, max: s[n - 1] ?? NaN, n, mean, ci95, ci95Pct };
}
const MB = 1024 * 1024;
function joinTimes(r: Any): number[] {
  return (r.join ?? []).flatMap((j: Any) => j.joinMs ?? []);
}
function quantile(xs: number[], q: number): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (i - lo);
}
/** null (metric not available on this runtime / OS) → NaN, so stat() skips it. */
const num = (x: Any) => (x === null || x === undefined ? NaN : Number(x));
/** The metric --precision and the end-of-run noise report look at. */
const KEY_METRIC: { name: string; of: (r: Any) => number } =
  scenario === 'startup'
    ? { name: 'processStartToLinkMs', of: (r) => r.startup.links[0].tLink }
    : scenario === 'join-impaired'
      ? { name: 'joinP50Ms', of: (r) => quantile(joinTimes(r), 0.5) }
      : { name: 'cpuPct', of: (r) => r.host.cpuPct };
function summarize(runs: Any[]): Any {
  const ok = runs.filter((r) => !r.failed);
  const pick = (f: (r: Any) => number) => stat(ok.map((r) => num(f(r))));
  const key = { metric: KEY_METRIC.name, ...pick(KEY_METRIC.of) };
  const warmupMs = pick((r) => r.warmup?.ms);
  if (ok[0]?.impair) {
    return {
      key,
      reps: ok.length,
      failed: runs.length - ok.length,
      joinP50Ms: pick((r) => quantile(joinTimes(r), 0.5)),
      joinP90Ms: pick((r) => quantile(joinTimes(r), 0.9)),
      joinP99Ms: pick((r) => quantile(joinTimes(r), 0.99)),
      joinMaxMs: pick((r) => Math.max(...joinTimes(r))),
      joined: pick((r) => r.join.reduce((a: number, j: Any) => a + j.joined, 0)),
      joinFailures: pick((r) => r.join.reduce((a: number, j: Any) => a + j.failures, 0)),
      stunRequests: pick((r) => r.impairStats.reduce((a: number, h: Any) => a + h.rooms.reduce((b: number, x: Any) => b + (x?.stunRequests ?? 0), 0), 0)),
      allValid: ok.every((r) => r.valid),
    };
  }
  const ms = (r: Any) => r.host.wallMs;
  return {
    key,
    warmupMs,
    reps: ok.length,
    failed: runs.length - ok.length,
    cpuPct: pick((r) => r.host.cpuPct),
    rssMeanMB: pick((r) => r.host.rssMean / MB),
    rssMaxMB: pick((r) => r.host.rssMax / MB),
    rssGrowthMB: pick((r) => (r.host.rssEnd - r.host.rssStart) / MB),
    heapUsedMeanMB: pick((r) => r.host.heapUsedMean / MB),
    heapUsedMaxMB: pick((r) => r.host.heapUsedMax / MB),
    gcPerMin: pick((r) => (r.host.gcCount === null ? NaN : (r.host.gcCount / ms(r)) * 60_000)),
    gcMsPerMin: pick((r) => (r.host.gcMs === null ? NaN : (r.host.gcMs / ms(r)) * 60_000)),
    eldP50: pick((r) => r.host.eld?.p50),
    eldP99: pick((r) => r.host.eld?.p99),
    eldMax: pick((r) => r.host.eld?.max),
    eldHow: [...new Set(ok.map((r) => lagHow(r.host.eld)))].join('; '),
    createToLinkMs: pick((r) => r.startup.links[0].createToLinkMs),
    processStartToLinkMs: pick((r) => r.startup.links[0].tLink),
    forkToLinkMs: pick((r) => r.startup.forkToLinkMs),
    loadMs: pick((r) => r.startup.links[0].tLoad),
    cpuToLinkMs: pick((r) => r.startup.links[0].cpuMs),
    rssAtLinkMB: pick((r) => r.startup.links[0].rss / MB),
    heapAtLinkMB: pick((r) => r.startup.links[0].heapUsed / MB),
    clientsCpuPct: pick((r) => r.clients?.reduce((a: number, c: Any) => a + c.cpuPct, 0)),
    mainThreadCpuPct: pick((r) => r.host.cpuSplit?.mainPct),
    otherThreadsCpuPct: pick((r) => r.host.cpuSplit?.otherPct),
    threadCount: pick((r) => r.host.threadCount),
    fdCount: pick((r) => r.host.fdCount),
    wakeupsPerS: pick((r) => r.host.wakeups?.voluntaryPerS),
    mainWakeupsPerS: pick((r) => r.host.wakeups?.mainVoluntaryPerS),
    // per-client Room.join → onOpen (successful attempt), median / p90 over the clients of a rep
    joinP50Ms: pick((r) => quantile(joinTimes(r), 0.5)),
    joinP90Ms: pick((r) => quantile(joinTimes(r), 0.9)),
    joinFailures: pick((r) => r.join?.reduce((a: number, j: Any) => a + j.failures, 0)),
    // per-player egress (UDP: haxlite-rtc only; app: every host, measured by the clients)
    udpBytesPerSPerPlayer: pick((r) => r.egressPerPlayer?.udpBytesPerS),
    udpPacketsPerSPerPlayer: pick((r) => r.egressPerPlayer?.udpPacketsPerS),
    appBytesPerSPerPlayer: pick((r) => r.egressPerPlayer?.appBytesPerS),
    appMsgsPerSPerPlayer: pick((r) => r.egressPerPlayer?.appMsgsPerS),
    // inter-arrival gap of consecutive messages at a client (all channels pooled)
    gapP50Ms: pick((r) => r.traffic?.gapsAll?.p50),
    gapP99Ms: pick((r) => r.traffic?.gapsAll?.p99),
    gapP999Ms: pick((r) => r.traffic?.gapsAll?.p999),
    rssSlopeMBph: pick((r) => r.soak?.[0]?.rssSlopeMBph),
    heapUsedSlopeMBph: pick((r) => r.soak?.[0]?.heapUsedSlopeMBph),
    fdDrift: pick((r) => r.soak?.[0]?.fdDrift),
    foreignPct: pick((r) => r.machine.foreignPct),
    noisyReps: ok.filter((r) => r.noisy).length,
    allValid: ok.every((r) => r.valid),
  };
}

function info(): Any {
  let commit = '';
  let srcDirty = '';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
    const diff = execSync('git diff HEAD -- src', { cwd: ROOT });
    srcDirty = diff.length ? createHash('sha256').update(diff).digest('hex').slice(0, 12) : '';
  } catch {
    /* not a git checkout */
  }
  // Hash of the compiled haxlite actually measured (src may change after the build).
  const dist = path.join(ROOT, 'node_modules/.cache/haxlite-bench/dist');
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else h.update(e.name).update(readFileSync(f));
    }
  };
  let buildSha = '';
  try {
    walk(dist);
    buildSha = h.digest('hex').slice(0, 12);
  } catch {
    /* not built */
  }
  const req = createRequire(path.join(ROOT, 'package.json'));
  const pkg = (p: string, from?: string) => {
    try {
      const r = from ? createRequire(req.resolve(`${from}/package.json`)) : req;
      return JSON.parse(readFileSync(r.resolve(`${p}/package.json`), 'utf8')).version;
    } catch {
      return null;
    }
  };
  const runtimes = [...new Set(IMPLS.map((i) => splitImpl(i).runtime))];
  return {
    date: new Date().toISOString(),
    node: IS_BUN ? null : process.version,
    v8: IS_BUN ? null : process.versions.v8,
    orchestrator: IS_BUN ? `bun ${(globalThis as Any).Bun.version}` : `node ${process.version}`,
    hostRuntimes: Object.fromEntries(runtimes.map((rt) => [rt, runtimeVersion(rt)])),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    nproc: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / MB),
    commit,
    srcDiffSha: srcDirty || null,
    haxliteBuildSha: buildSha,
    versions: {
      'haxball.js': pkg('haxball.js'),
      'node-haxball': pkg('node-haxball'),
      'node-datachannel': pkg('node-datachannel'),
      'node-haxball/node-datachannel': pkg('node-datachannel', 'node-haxball'),
      '@webrtc-node/webrtc': pkg('@webrtc-node/webrtc', 'haxball.js') ?? pkg('@webrtc-node/webrtc'),
    },
    cpuMHz: os.cpus()[0]?.speed,
    command: `${IS_BUN ? 'bun' : 'node --import ./bench/ts-resolve.mjs'} bench/net/run.ts ${argv.join(' ')}`,
    profile: QUICK ? 'quick' : 'default',
    publishable: !QUICK,
    cores: PIN ? { nproc: NCPU, ...coreLayout(scenario === 'fleet' ? Math.max(...PROCS) : 1) } : null,
    params: {
      ELD, ELD_WINDOW_S, ELD_METHOD, ELD_MODE, IMPLS, RUNTIME, REPS, WARMUP_S, WINDOW_S, NS, KS, MAX_FOREIGN, ATTEMPTS, CLIENTS_PER_PROC, HOST_NODE_ARGS,
      PROCS, ROOMS_PER_PROC, CLIENTS, SOAK_MIN, SAMPLE_S, STAY_S, PAUSE_S, RTT, LOSS, JITTER, STUN, JOINS, NAT_OUTSIDE, NAT_FILTERING,
      QUICK, PRECISION, MAX_REPS, WARMUP_MODE, MIN_WARMUP_S, JOIN_CONCURRENCY, SETTLE_MS, PARALLEL, PIN,
    },
  };
}

// ------------------------------------------------------------------ scenarios
const MB_ = (x: number) => (x / MB).toFixed(1);
/** How a run's lag was measured: method + window (results before 16-10-2026 have no `window`: inside the CPU window). */
function lagHow(eld: Any): string {
  if (!eld) return 'off';
  const m = eld.method === 'setInterval-10ms' ? 'timer 10 ms' : 'native';
  return eld.window === 'separate' ? `${m}, own ${((eld.windowMs ?? 0) / 1000).toFixed(0)} s sub-window` : `${m}, inside CPU window`;
}
function logRun(run: Any, prefix = ''): void {
  if (run.impair) {
    const xs = joinTimes(run);
    const st = run.impairStats?.[0]?.rooms?.[0];
    console.log(
      `${prefix}    joined ${xs.length}/${JOINS}  join p50 ${quantile(xs, 0.5).toFixed(0)} p99 ${quantile(xs, 0.99).toFixed(0)} max ${Math.max(...xs).toFixed(0)} ms  ` +
        `failures ${run.join.reduce((a: number, j: Any) => a + j.failures, 0)}  stun requests ${st?.stunRequests}  nat dropped ${st?.impair?.dropped}  valid ${run.valid}`,
    );
    return;
  }
  const h = run.host;
  const e = run.egressPerPlayer;
  console.log(
    `${prefix}    ${h.runtime ?? ''} cpu ${h.cpuPct.toFixed(2)} %  rss ${MB_(h.rssMean)} MB  heap ${MB_(h.heapUsedMean)} MB  ` +
      (h.eld ? `lag p50 ${h.eld.p50.toFixed(2)} p99 ${h.eld.p99.toFixed(2)} max ${h.eld.max.toFixed(1)} ms (${lagHow(h.eld)})  ` : '') +
      (h.cpuSplit ? `js ${h.cpuSplit.mainPct.toFixed(2)} other ${h.cpuSplit.otherPct.toFixed(2)}  thr ${h.threadCount} fd ${h.fdCount}  wake ${h.wakeups?.voluntaryPerS}/s  ` : '') +
      (h.gcCount !== null ? `gc ${((h.gcCount / h.wallMs) * 60_000).toFixed(1)}/min ${((h.gcMs / h.wallMs) * 60_000).toFixed(1)} ms/min  ` : 'gc n/a  ') +
      (h.rtc ? `udp in ${h.rtc.packetsInPerS}/s out ${h.rtc.packetsOutPerS}/s  ` : '') +
      (e && run.clientsPerRoom > 0 ? `per player: app ${e.appMsgsPerS} msg/s ${e.appBytesPerS} B/s${e.udpBytesPerS !== null ? `, udp ${e.udpPacketsPerS} pkt/s ${e.udpBytesPerS} B/s` : ''}  gap p50 ${run.traffic.gapsAll.p50} p99 ${run.traffic.gapsAll.p99} p999 ${run.traffic.gapsAll.p999} ms  ` : '') +
      (run.soak ? `soak rss ${run.soak[0].rssSlopeMBph} MB/h heap ${run.soak[0].heapUsedSlopeMBph} MB/h fd drift ${run.soak[0].fdDrift}  ` : '') +
      (run.warmup?.mode === 'auto' ? `warm-up ${(run.warmup.ms / 1000).toFixed(1)} s${run.warmup.steady ? '' : ' (cap)'}  ` : '') +
      `link ${run.startup.links[0].createToLinkMs.toFixed(0)} ms  foreign ${run.machine.foreignPct.toFixed(0)} %  valid ${run.valid}`,
  );
}

async function main(): Promise<void> {
  const out: Any = { scenario, info: info(), configs: [] };
  const save = () => {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 1));
  };
  const t0 = Date.now();
  if (QUICK) console.log('*** --quick: development profile (few reps, short windows, small N): NOT PUBLISHABLE ***');
  const configs: { label: string; spec: Omit<RunSpec, 'seed'> }[] = [];
  const base = (implRt: string) => ({
    ...splitImpl(implRt),
    procs: 1,
    warmupMode: WARMUP_MODE as 'auto' | 'fixed',
    minWarmupS: MIN_WARMUP_S,
    joinConcurrency: JOIN_CONCURRENCY,
    eldMode: ELD_MODE as 'separate' | 'inline',
    eldMethod: ELD_METHOD as 'timer' | 'native',
    eldWindowS: ELD_WINDOW_S,
  });
  if (scenario === 'startup') {
    // The startup metrics are taken at the room link; the 0.25 s window after it only gives
    // the `host` record its shape (before: 1 s, which no startup table uses).
    for (const i of IMPLS) configs.push({ label: i, spec: { ...base(i), rooms: 1, clientsPerRoom: 0, warmupS: 0, windowS: 0.25, eld: false, sampleMs: 1000 } });
  } else if (scenario === 'idle') {
    for (const i of IMPLS) configs.push({ label: i, spec: { ...base(i), rooms: 1, clientsPerRoom: 0, warmupS: WARMUP_S, windowS: WINDOW_S, eld: false, sampleMs: 5000 } });
  } else if (scenario === 'game') {
    for (const n of NS) for (const i of IMPLS) configs.push({ label: `${i} N=${n}`, spec: { ...base(i), rooms: 1, clientsPerRoom: n, warmupS: WARMUP_S, windowS: WINDOW_S, eld: ELD, sampleMs: 1000 } });
  } else if (scenario === 'rooms') {
    for (const k of KS) for (const i of IMPLS) configs.push({ label: `${i} K=${k}`, spec: { ...base(i), rooms: k, clientsPerRoom: 4, warmupS: WARMUP_S, windowS: WINDOW_S, eld: ELD, sampleMs: 1000 } });
  } else if (scenario === 'soak') {
    for (const r of ROOMS_PER_PROC)
      for (const c of CLIENTS)
        for (const i of IMPLS)
          configs.push({
            label: `${i} R=${r} C=${c} ${SOAK_MIN} min`,
            spec: { ...base(i), rooms: r, clientsPerRoom: c, warmupS: WARMUP_S, windowS: SOAK_MIN * 60, eld: ELD, sampleMs: SAMPLE_S * 1000, churn: { stayS: STAY_S, pauseS: PAUSE_S } },
          });
  } else if (scenario === 'fleet') {
    for (const p of PROCS)
      for (const r of ROOMS_PER_PROC)
        for (const c of CLIENTS)
          for (const i of IMPLS)
            configs.push({ label: `${i} P=${p} R=${r} C=${c}`, spec: { ...base(i), procs: p, rooms: r, clientsPerRoom: c, warmupS: WARMUP_S, windowS: WINDOW_S, eld: ELD, sampleMs: 1000 } });
  } else if (scenario === 'join-impaired') {
    for (const rtt of RTT)
      for (const loss of LOSS)
        for (const stun of STUN)
          for (const i of IMPLS)
            configs.push({
              label: `${i} rtt=${rtt} loss=${loss}% stun=${stun}`,
              spec: { ...base(i), rooms: 1, clientsPerRoom: JOINS, warmupS: 0, windowS: 0, eld: false, sampleMs: 1000, impair: { rttMs: rtt, lossPct: loss, jitterMs: JITTER, stun, outside: NAT_OUTSIDE, filtering: NAT_FILTERING } },
            });
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
  // Repetitions are interleaved (rep 1 of every config, then rep 2, …) so slow
  // drifts of the machine affect all implementations alike. With --precision, the rounds
  // after --reps only include the configs whose key metric is not yet precise enough.
  type Res = { label: string; spec: Omit<RunSpec, 'seed'>; runs: Any[]; summary: Any };
  const results: Res[] = configs.map((c) => ({ label: c.label, spec: c.spec, runs: [] as Any[], summary: null as Any }));
  out.configs = results;
  const repsLabel = MAX_REPS > REPS ? `${REPS}–${MAX_REPS}` : `${REPS}`;
  const needsMore = (r: Res): boolean => {
    const done = r.runs.length;
    if (done < REPS) return true;
    if (done >= MAX_REPS || PRECISION <= 0) return false;
    const k = r.summary?.key;
    return !(k && k.n >= 3 && k.ci95Pct !== null && k.ci95Pct <= PRECISION);
  };
  const doRun = async (r: Res, slot: number): Promise<void> => {
    const rep = r.runs.length;
    const prefix = PARALLEL > 1 ? `[${r.label}] ` : '';
    console.log(`[${scenario}] ${r.label} rep ${rep + 1}/${repsLabel}${PARALLEL > 1 ? ` (slot ${slot})` : ''}`);
    // soak: the partial run is saved at every sample (hours-long runs survive a crash)
    r.runs.push({ partial: true });
    let lastLog = Date.now();
    const run = await runWithRetry(
      { ...r.spec, seed: rep + 1 },
      (partial) => {
        r.runs[rep] = { ...partial, partial: true };
        if (Date.now() - lastLog > 600_000) {
          lastLog = Date.now();
          const s = partial.soak?.[0];
          console.log(`${prefix}    … ${s?.samples} samples, ${s?.hours} h: rss ${s?.rssEndMB} MB (${s?.rssSlopeMBph} MB/h), fd drift ${s?.fdDrift}`);
        }
        save();
      },
      slot,
    );
    r.runs[rep] = run;
    r.summary = summarize(r.runs);
    if (!run.failed) logRun(run, prefix);
    save();
  };
  for (let round = 0; ; round++) {
    const todo = results.filter(needsMore);
    if (todo.length === 0) break;
    if (round >= REPS) console.log(`[${scenario}] --precision ${PRECISION} %: ${todo.length} config(s) need another repetition`);
    if (PARALLEL === 1) {
      for (const r of todo) await doRun(r, 0);
    } else {
      // rotate the order every round so that a config does not always share the machine with the same neighbours
      const rot = round % todo.length;
      const order = [...todo.slice(rot), ...todo.slice(0, rot)];
      for (let i = 0; i < order.length; i += PARALLEL) await Promise.all(order.slice(i, i + PARALLEL).map((r, slot) => doRun(r, slot)));
    }
  }
  out.info.wallS = Math.round((Date.now() - t0) / 1000);
  save();
  // Noise report: the key metric of every config, mean ± 95 % CI half-width.
  console.log(`[${scenario}] ${KEY_METRIC.name}: median, mean ± 95 % CI (n)${QUICK ? '   [--quick: NOT PUBLISHABLE]' : ''}`);
  for (const r of results) {
    const k = r.summary?.key;
    if (!k || k.n === 0) continue;
    const d = KEY_METRIC.name === 'cpuPct' ? 3 : 1;
    const ci = k.ci95 === null ? 'n/a' : `${k.ci95.toFixed(d)} (${k.ci95Pct.toFixed(1)} %)`;
    console.log(`    ${r.label.padEnd(36)} ${k.median.toFixed(d)}   ${k.mean.toFixed(d)} ± ${ci}  (n=${k.n})`);
  }
  console.log(`wrote ${path.relative(ROOT, OUT)} in ${out.info.wallS} s`);
  process.exit(0);
}
await main();
