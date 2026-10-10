/**
 * Micro-benchmark of the physics world step (src/sim stepWorld) vs the
 * official World step (`Oa.Da`, evaluated from the official headless script
 * through the test oracle).
 *
 *   node --experimental-strip-types --import ./bench/ts-resolve.mjs bench/sim.bench.ts
 *
 * Scenarios: Classic + 8 player discs (13 discs), Huge + 25 player discs
 * (30 discs). Each tick every player disc gets a chase acceleration towards
 * the ball (like held input) so the world never comes to rest; the same
 * nudge code runs on both sides. Reports ns/tick (best of several rounds)
 * and the heap growth during the timed rounds of our step (≈0 = no
 * per-tick allocation).
 *
 * `--out <file.json>` appends this run (one process = one repetition) to a
 * JSON file: `{ info, runs: [...] }` (used by docs/07-benchmarks.md).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createWorld, defaultStadiums, Disc, stepWorld } from '../src/sim/index.js';
import type { World } from '../src/sim/index.js';
import { officialDefaults, officialDisc, officialWorld } from '../test/sim/official-sim.js';
import type { Any } from '../test/sim/official-sim.js';

const WARMUP = 20_000;
const TICKS = 200_000;
const ROUNDS = 5;

function ours(stadiumIndex: number, players: number): World {
  const st = defaultStadiums()[stadiumIndex]!;
  const w = createWorld(st);
  for (let p = 0; p < players; p++) {
    const d = new Disc();
    d.radius = 15;
    d.invMass = 0.5;
    d.damping = 0.96;
    d.bCoef = 0.5;
    d.cMask = 39;
    d.cGroup = p % 2 === 0 ? 2 : 4;
    d.color = 0;
    d.x = (p % 2 === 0 ? -1 : 1) * (100 + 20 * p);
    d.y = 55 * ((p >> 1) % 5) - 110;
    w.discs.push(d);
  }
  return w;
}

function official(stadiumIndex: number, players: number): Any {
  const w = officialWorld(officialDefaults()[stadiumIndex]);
  for (let p = 0; p < players; p++) {
    const d = officialDisc();
    d.M = 15;
    d.L = 0.5;
    d.ga = 0.96;
    d.i = 0.5;
    d.c = 39;
    d.o = p % 2 === 0 ? 2 : 4;
    d.T = 0;
    d.a.x = (p % 2 === 0 ? -1 : 1) * (100 + 20 * p);
    d.a.y = 55 * ((p >> 1) % 5) - 110;
    w.A.push(d);
  }
  return w;
}

function tickOurs(w: World, first: number): void {
  const discs = w.discs;
  const ball = discs[0]!;
  for (let i = first; i < discs.length; i++) {
    const d = discs[i]!;
    d.xspeed += ball.x > d.x ? 0.1 : -0.1;
    d.yspeed += ball.y > d.y ? 0.1 : -0.1;
  }
  stepWorld(w, 1);
}

function tickOfficial(w: Any, first: number): void {
  const discs = w.A;
  const ball = discs[0].a;
  for (let i = first; i < discs.length; i++) {
    const d = discs[i];
    d.u.x += ball.x > d.a.x ? 0.1 : -0.1;
    d.u.y += ball.y > d.a.y ? 0.1 : -0.1;
  }
  w.Da(1);
}

function measure<T>(world: T, first: number, tick: (w: T, first: number) => void): { ns: number; heapDelta: number } {
  for (let i = 0; i < WARMUP; i++) tick(world, first);
  let best = Infinity;
  let heapDelta = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const h0 = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < TICKS; i++) tick(world, first);
    const t1 = process.hrtime.bigint();
    heapDelta = Math.max(heapDelta, process.memoryUsage().heapUsed - h0);
    best = Math.min(best, Number(t1 - t0) / TICKS);
  }
  return { ns: best, heapDelta };
}

const scenarios: [string, number, number][] = [
  ['Classic, 8 players (13 discs)', 0, 8],
  ['Huge, 25 players (30 discs)', 9, 25],
];

console.log(`node ${process.version}; ${TICKS} ticks x ${ROUNDS} rounds (best), warm-up ${WARMUP}`);
const rows: { label: string; haxliteNs: number; officialNs: number; speedup: number; haxliteHeapGrowthKiB: number }[] = [];
for (const [label, idx, players] of scenarios) {
  const first = defaultStadiums()[idx]!.discs.length;
  const a = measure(ours(idx, players), first, tickOurs);
  const b = measure(official(idx, players), first, tickOfficial);
  rows.push({ label, haxliteNs: a.ns, officialNs: b.ns, speedup: b.ns / a.ns, haxliteHeapGrowthKiB: a.heapDelta / 1024 });
  console.log(
    `${label.padEnd(32)} haxlite ${a.ns.toFixed(0).padStart(6)} ns/tick   official ${b.ns.toFixed(0).padStart(6)} ns/tick   ` +
      `speed-up x${(b.ns / a.ns).toFixed(2)}   haxlite heap growth ${(a.heapDelta / 1024).toFixed(0)} KiB / ${TICKS} ticks`,
  );
}

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const file = process.argv[outIdx + 1]!;
  const doc = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { info: { node: process.version, cpu: os.cpus()[0]?.model, nproc: os.cpus().length, TICKS, ROUNDS, WARMUP }, runs: [] };
  doc.runs.push({ date: new Date().toISOString(), rows });
  writeFileSync(file, JSON.stringify(doc, null, 1));
}
