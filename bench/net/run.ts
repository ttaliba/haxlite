/**
 * Host resource benchmark orchestrator: haxlite vs the official headless host
 * (haxball.js) vs node-haxball as host, fully offline through the FakeMaster.
 *
 *   npm run bench:build                      # compile haxlite (src/) for the host process
 *   node --experimental-transform-types --import ./bench/ts-resolve.mjs bench/net/run.ts <scenario> [flags]
 *
 * Scenarios (see docs/07-benchmarks.md):
 *   startup   time from process start / room creation to "room link ready"
 *   idle      public room, 0 players (CPU %, RSS/heap, no event-loop monitor)
 *   game      N connected node-haxball clients playing a running game
 *   rooms     K rooms in one host process, 4 clients each
 *
 * Flags: --impl haxlite,official,nodehaxball  --reps 3  --warmup 15  --window 60
 *        --n 4,10,20 (game)  --k 1,5,10 (rooms)  --out bench/results/<scenario>.json
 *        --eld 0 (no event-loop monitor: sizes its own CPU overhead)
 *        --host-node-args "--cpu-prof --cpu-prof-dir=DIR" (diagnostics only)
 *        --max-foreign 100 --attempts 2 (re-run a repetition when other processes
 *        on the machine used more than this % of one core during the window; after
 *        `attempts` tries the least noisy one is kept and flagged `noisy`)
 *
 * Process layout per repetition (each process fresh):
 *   this process ── FakeMaster (HTTP + signaling WS, 127.0.0.1)
 *   host-proc.mjs   the host under test (plain JS, no TS loader); measures itself
 *   clients-proc.mjs × ceil(clients/10)   node-haxball clients (never counted)
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeMaster } from '../../test/fake-master/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const scenario = argv[0] ?? 'game';
function flag(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
}
const list = (s: string) => s.split(',').filter(Boolean);
const IMPLS = list(flag('impl', scenario === 'rooms' ? 'haxlite' : 'haxlite,official,nodehaxball'));
const REPS = Number(flag('reps', scenario === 'startup' ? '10' : '3'));
const WARMUP_S = Number(flag('warmup', scenario === 'idle' ? '10' : '15'));
const WINDOW_S = Number(flag('window', scenario === 'idle' ? '200' : '60'));
const NS = list(flag('n', '4,10,20')).map(Number);
const KS = list(flag('k', '1,5,10')).map(Number);
const MAX_FOREIGN = Number(flag('max-foreign', '100'));
const ATTEMPTS = Number(flag('attempts', '2'));
/** --eld 0 disables the event-loop-delay monitor (its 10 ms timer costs CPU too; used to size that overhead). */
const ELD = flag('eld', '1') !== '0';
const OUT = flag('out', path.join(ROOT, `bench/results/${scenario}.json`));
const CLIENTS_PER_PROC = 10;
/** Extra node flags for the host process only, e.g. "--cpu-prof --cpu-prof-dir=/tmp/prof" (diagnostics). */
const HOST_NODE_ARGS = list(flag('host-node-args', '').replace(/ +/g, ','));

// ------------------------------------------------------------------ child helper
class Child {
  readonly msgs: Any[] = [];
  readonly errors: string[] = [];
  readonly tail: string[] = [];
  private waiters: (() => void)[] = [];
  exited = false;
  constructor(
    readonly name: string,
    readonly proc: ChildProcess,
  ) {
    proc.on('message', (m: Any) => {
      if (m?.type === 'error') this.errors.push(m.message);
      this.msgs.push(m);
      for (const w of this.waiters.splice(0)) w();
    });
    const keep = (d: Buffer) => {
      for (const line of d.toString().split('\n')) if (line.trim()) this.tail.push(line.slice(0, 300));
      if (this.tail.length > 40) this.tail.splice(0, this.tail.length - 40);
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    proc.on('exit', (code) => {
      this.exited = true;
      this.errors.push(`${name} exited (${code})`);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  static spawn(name: string, script: string, args: string[], execArgv: string[] = []): Child {
    // execArgv: [] → no TypeScript loader in the children.
    return new Child(name, fork(path.join(HERE, script), args, { execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
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
function procStat(): { busy: number; total: number } {
  const cpu = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
  const idle = cpu[3]! + cpu[4]!;
  const total = cpu.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}
const CLK_TCK = 100;

// ------------------------------------------------------------------ one repetition
interface RunSpec {
  impl: string;
  rooms: number;
  clientsPerRoom: number;
  warmupS: number;
  windowS: number;
  eld: boolean;
  sampleMs: number;
  seed: number;
}

async function runOnce(spec: RunSpec): Promise<Any> {
  const master = await FakeMaster.start();
  const children: Child[] = [];
  const result: Any = { ...spec };
  try {
    const tFork = performance.now();
    const sysFork = procStat();
    const selfFork = process.cpuUsage();
    const host = Child.spawn('host', 'host-proc.mjs', [spec.impl, master.hostPort, String(spec.rooms)], HOST_NODE_ARGS);
    children.push(host);
    const links = await host.wait('link', 60_000, spec.rooms);
    const tLinked = performance.now();
    const sysLinked = procStat();
    const selfLinked = process.cpuUsage(selfFork);
    result.startup = {
      forkToLinkMs: performance.now() - tFork, // only meaningful for rooms = 1
      links: links.map((l) => ({ room: l.room, tStart: l.tStart, tLoad: l.tLoad, tCreate: l.tCreate, tLink: l.tLink, createToLinkMs: l.tLink - l.tCreate, cpuMs: l.cpuMs, rss: l.rss, heapUsed: l.heapUsed })),
      // other processes' CPU between fork and the last link (% of one core)
      foreignPct: Math.max(
        0,
        (((sysLinked.busy - sysFork.busy) * (1000 / CLK_TCK) - links[links.length - 1].cpuMs - (selfLinked.user + selfLinked.system) / 1000) / (tLinked - tFork)) * 100,
      ),
    };
    const ids: string[] = links.sort((a, b) => a.room - b.room).map((l) => l.id);

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
      clients = groups.map((g, i) => Child.spawn(`clients${i}`, 'clients-proc.mjs', [master.hostPort, g.join(','), String(spec.seed * 100 + i + 1)]));
      children.push(...clients);
      const joined = await Promise.all(clients.map((c) => c.wait('joined', 240_000)));
      result.join = joined.map((j) => j[0]);
      const expected = spec.rooms * spec.clientsPerRoom;
      const total = result.join.reduce((a: number, j: Any) => a + j.joined, 0);
      if (total !== expected) throw new Error(`only ${total}/${expected} clients joined`);
      // the host must see everybody before teams are assigned
      const t0 = Date.now();
      for (;;) {
        const p = await host.request({ cmd: 'players' }, 'players');
        if (p.counts.every((c: number) => c === spec.clientsPerRoom)) break;
        if (Date.now() - t0 > 20_000) throw new Error(`host sees ${p.counts} players`);
        await sleep(200);
      }
      result.game = await host.request({ cmd: 'game' }, 'game');
      await Promise.all(clients.map((c) => c.request({ cmd: 'drive' }, 'driving')));
    }

    await sleep(spec.warmupS * 1000);
    const load0 = os.loadavg();
    const sys0 = procStat();
    const self0 = process.cpuUsage();
    await host.request({ cmd: 'measure-start', eld: spec.eld, sampleMs: spec.sampleMs }, 'measuring');
    await sleep(spec.windowS * 1000);
    const stats = await host.request({ cmd: 'measure-stop' }, 'stats');
    const reports = await Promise.all(clients.map((c) => c.request({ cmd: 'stop' }, 'report')));
    const sys1 = procStat();
    const self = process.cpuUsage(self0);
    result.host = stats.stats;
    result.hostPlayersAtEnd = stats.players;
    result.clients = reports.map(({ frames, ...r }: Any) => ({ ...r, minFrame: Math.min(...frames), maxFrame: Math.max(...frames) }));
    // Everything that ran on the machine during the window minus our own processes
    // (host, clients, this orchestrator incl. the FakeMaster) = foreign load.
    const sysBusyPct = ((sys1.busy - sys0.busy) / CLK_TCK / (spec.windowS + 0.0)) * 100; // % of ONE core
    const oursPct = stats.stats.cpuPct + reports.reduce((a: number, r: Any) => a + r.cpuPct, 0) + ((self.user + self.system) / 1000 / (spec.windowS * 1000)) * 100;
    result.machine = { loadavgStart: load0, loadavgEnd: os.loadavg(), sysBusyPct, foreignPct: Math.max(0, sysBusyPct - oursPct) };
    const disconnected = result.clients.reduce((a: number, r: Any) => a + r.disconnected, 0);
    result.valid =
      disconnected === 0 && (stats.players as number[]).every((c) => c === spec.clientsPerRoom) && host.errors.length === 0;
    result.errors = children.flatMap((c) => c.errors.filter((e) => !e.includes('exited')).map((e) => `${c.name}: ${e.slice(0, 500)}`));
    return result;
  } finally {
    for (const c of children) c.kill();
    await sleep(500);
    await master.close();
    await sleep(1500);
  }
}

async function runWithRetry(spec: RunSpec): Promise<Any> {
  const discarded: Any[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let r: Any;
    try {
      r = await runOnce(spec);
    } catch (e) {
      r = { ...spec, failed: String((e as Error).message ?? e).slice(0, 2000) };
      console.log(`    failed: ${r.failed.split('\n')[0]}`);
      discarded.push(r);
      continue;
    }
    const foreign = spec.windowS <= 1 ? r.startup.foreignPct : r.machine.foreignPct;
    if (foreign > MAX_FOREIGN) {
      console.log(`    noisy (foreign load ${foreign.toFixed(0)} % of a core), repeating`);
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
    const foreignOf = (d: Any) => (spec.windowS <= 1 ? d.startup.foreignPct : d.machine.foreignPct);
    const best = noisy.reduce((a, b) => (foreignOf(b) < foreignOf(a) ? b : a));
    console.log(`    keeping least noisy attempt (foreign ${foreignOf(best).toFixed(0)} %)`);
    return { ...best, discardedAsNoisy: false, noisy: true, discarded: discarded.filter((d) => d !== best) };
  }
  return { ...spec, failed: 'too many failed attempts', discarded };
}

// ------------------------------------------------------------------ summary helpers
function stat(xs: number[]): { median: number; min: number; max: number; n: number } {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = s.length;
  const median = n === 0 ? NaN : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  return { median, min: s[0] ?? NaN, max: s[n - 1] ?? NaN, n };
}
const MB = 1024 * 1024;
function summarize(runs: Any[]): Any {
  const ok = runs.filter((r) => !r.failed);
  const pick = (f: (r: Any) => number) => stat(ok.map(f));
  return {
    reps: ok.length,
    failed: runs.length - ok.length,
    cpuPct: pick((r) => r.host.cpuPct),
    rssMeanMB: pick((r) => r.host.rssMean / MB),
    rssMaxMB: pick((r) => r.host.rssMax / MB),
    rssGrowthMB: pick((r) => (r.host.rssEnd - r.host.rssStart) / MB),
    heapUsedMeanMB: pick((r) => r.host.heapUsedMean / MB),
    heapUsedMaxMB: pick((r) => r.host.heapUsedMax / MB),
    gcPerMin: pick((r) => (r.host.gcCount / r.host.wallMs) * 60_000),
    gcMsPerMin: pick((r) => (r.host.gcMs / r.host.wallMs) * 60_000),
    eldP50: pick((r) => r.host.eld?.p50 ?? NaN),
    eldP99: pick((r) => r.host.eld?.p99 ?? NaN),
    eldMax: pick((r) => r.host.eld?.max ?? NaN),
    createToLinkMs: pick((r) => r.startup.links[0].createToLinkMs),
    processStartToLinkMs: pick((r) => r.startup.links[0].tLink),
    forkToLinkMs: pick((r) => r.startup.forkToLinkMs),
    loadMs: pick((r) => r.startup.links[0].tLoad),
    cpuToLinkMs: pick((r) => r.startup.links[0].cpuMs),
    rssAtLinkMB: pick((r) => r.startup.links[0].rss / MB),
    heapAtLinkMB: pick((r) => r.startup.links[0].heapUsed / MB),
    clientsCpuPct: pick((r) => r.clients?.reduce((a: number, c: Any) => a + c.cpuPct, 0) ?? NaN),
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
  const pkg = (p: string) => JSON.parse(readFileSync(path.join(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version;
  return {
    date: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    nproc: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / MB),
    commit,
    srcDiffSha: srcDirty || null,
    haxliteBuildSha: buildSha,
    versions: { 'haxball.js': pkg('haxball.js'), 'node-haxball': pkg('node-haxball'), 'node-datachannel': pkg('node-datachannel'), '@webrtc-node/webrtc': pkg('@webrtc-node/webrtc') },
    command: `node --experimental-transform-types --import ./bench/ts-resolve.mjs bench/net/run.ts ${argv.join(' ')}`,
    params: { ELD, IMPLS, REPS, WARMUP_S, WINDOW_S, NS, KS, MAX_FOREIGN, ATTEMPTS, CLIENTS_PER_PROC, HOST_NODE_ARGS },
  };
}

// ------------------------------------------------------------------ scenarios
async function main(): Promise<void> {
  const out: Any = { scenario, info: info(), configs: [] };
  const save = () => {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 1));
  };
  const configs: { label: string; spec: Omit<RunSpec, 'seed'> }[] = [];
  if (scenario === 'startup') {
    for (const impl of IMPLS) configs.push({ label: impl, spec: { impl, rooms: 1, clientsPerRoom: 0, warmupS: 0, windowS: 1, eld: false, sampleMs: 1000 } });
  } else if (scenario === 'idle') {
    for (const impl of IMPLS) configs.push({ label: impl, spec: { impl, rooms: 1, clientsPerRoom: 0, warmupS: WARMUP_S, windowS: WINDOW_S, eld: false, sampleMs: 5000 } });
  } else if (scenario === 'game') {
    for (const n of NS) for (const impl of IMPLS) configs.push({ label: `${impl} N=${n}`, spec: { impl, rooms: 1, clientsPerRoom: n, warmupS: WARMUP_S, windowS: WINDOW_S, eld: ELD, sampleMs: 1000 } });
  } else if (scenario === 'rooms') {
    for (const k of KS) for (const impl of IMPLS) configs.push({ label: `${impl} K=${k}`, spec: { impl, rooms: k, clientsPerRoom: 4, warmupS: WARMUP_S, windowS: WINDOW_S, eld: ELD, sampleMs: 1000 } });
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
  // Repetitions are interleaved (rep 1 of every config, then rep 2, …) so slow
  // drifts of the machine affect all implementations alike.
  const results = configs.map((c) => ({ label: c.label, spec: c.spec, runs: [] as Any[], summary: null as Any }));
  out.configs = results;
  for (let rep = 0; rep < REPS; rep++) {
    for (const r of results) {
      console.log(`[${scenario}] ${r.label} rep ${rep + 1}/${REPS}`);
      const run = await runWithRetry({ ...r.spec, seed: rep + 1 });
      r.runs.push(run);
      r.summary = summarize(r.runs);
      if (!run.failed) {
        const h = run.host;
        console.log(
          `    cpu ${h.cpuPct.toFixed(2)} %  rss ${(h.rssMean / MB).toFixed(1)} MB  heap ${(h.heapUsedMean / MB).toFixed(1)} MB  ` +
            (h.eld ? `lag p50 ${h.eld.p50.toFixed(2)} p99 ${h.eld.p99.toFixed(2)} max ${h.eld.max.toFixed(1)} ms  ` : '') +
            `link ${run.startup.links[0].createToLinkMs.toFixed(0)} ms  foreign ${run.machine.foreignPct.toFixed(0)} %  valid ${run.valid}`,
        );
      }
      save();
    }
  }
  save();
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
  process.exit(0);
}

await main();
