/**
 * Physics differential test: our stepWorld vs the OFFICIAL World step
 * (`Oa.Da`) in isolation. Same stadium (official generator/parser on one
 * side, ours on the other), same extra "player" discs and the same
 * per-tick velocity nudges (chase acceleration, kicks, random impulses,
 * mask flips) applied to both; after every tick every field of every disc
 * must be bit-identical (Object.is, so -0 and NaN payload-agnostic NaN
 * equality are checked).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, defaultStadiums, parseHbs, stepWorld } from '../../src/sim/index.js';
import { Disc } from '../../src/sim/index.js';
import type { Stadium, World } from '../../src/sim/index.js';
import { prng } from '../oracle/index.js';
import { HAND, randomHbs } from './hbs-corpus.js';
import { officialDefaults, officialDisc, officialParseHbs, officialWorld } from './official-sim.js';
import type { Any } from './official-sim.js';

/** Official live-disc field accessors, in our field order. */
const FIELDS: [string, (d: Any) => number][] = [
  ['x', (d) => d.a.x], ['y', (d) => d.a.y], ['xspeed', (d) => d.u.x], ['yspeed', (d) => d.u.y],
  ['xgravity', (d) => d.ma.x], ['ygravity', (d) => d.ma.y], ['radius', (d) => d.M], ['bCoef', (d) => d.i],
  ['invMass', (d) => d.L], ['damping', (d) => d.ga], ['color', (d) => d.T], ['cMask', (d) => d.c], ['cGroup', (d) => d.o],
];

function compare(ours: World, off: Any, tick: number, label: string): void {
  const a = ours.discs;
  const b = off.A as Any[];
  if (a.length !== b.length) throw new Error(`${label} tick ${tick}: disc count ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! as unknown as Record<string, number>;
    for (const [name, get] of FIELDS) {
      const ov = get(b[i]);
      if (!Object.is(d[name], ov)) {
        throw new Error(`${label}: tick ${tick} disc ${i} field ${name}: ours ${d[name]} official ${ov}`);
      }
    }
  }
}

interface Extra {
  x: number; y: number; xspeed: number; yspeed: number; radius: number; invMass: number; damping: number;
  bCoef: number; cMask: number; cGroup: number; ygravity: number;
}

function addDisc(ours: World, off: Any, e: Extra): void {
  const d = new Disc();
  d.x = e.x; d.y = e.y; d.xspeed = e.xspeed; d.yspeed = e.yspeed; d.ygravity = e.ygravity;
  d.radius = e.radius; d.invMass = e.invMass; d.damping = e.damping; d.bCoef = e.bCoef;
  d.cMask = e.cMask; d.cGroup = e.cGroup; d.color = 0;
  ours.discs.push(d);
  const o = officialDisc();
  o.a.x = e.x; o.a.y = e.y; o.u.x = e.xspeed; o.u.y = e.yspeed; o.ma.y = e.ygravity;
  o.M = e.radius; o.L = e.invMass; o.ga = e.damping; o.i = e.bCoef; o.c = e.cMask; o.o = e.cGroup; o.T = 0;
  off.A.push(o);
}

/** Adds the same velocity delta on both sides (`v = v + dv`, as the official input code does). */
function nudge(ours: World, off: Any, i: number, dvx: number, dvy: number): void {
  const d = ours.discs[i]!;
  d.xspeed += dvx;
  d.yspeed += dvy;
  const o = off.A[i];
  o.u.x += dvx;
  o.u.y += dvy;
}

/**
 * Runs `ticks` steps on both worlds. `players` extra discs chase disc 0 and
 * kick it when close (player-like), and random impulses keep everything
 * moving. Returns the number of disc-field comparisons done.
 */
function run(label: string, ourSt: Stadium, offSt: Any, seed: number, ticks: number, players: number, dt = 1): number {
  const rnd = prng(seed);
  const ours = createWorld(ourSt);
  const off = officialWorld(offSt);
  compare(ours, off, 0, label);
  const W = Number.isFinite(ourSt.width) && ourSt.width > 0 ? ourSt.width : 400;
  const H = Number.isFinite(ourSt.height) && ourSt.height > 0 ? ourSt.height : 200;
  for (let p = 0; p < players; p++) {
    const red = p % 2 === 0;
    addDisc(ours, off, {
      x: (rnd() * 2 - 1) * W * 0.9, y: (rnd() * 2 - 1) * H * 0.9,
      xspeed: (rnd() * 2 - 1) * 3, yspeed: (rnd() * 2 - 1) * 3,
      radius: rnd() < 0.8 ? 15 : 5 + rnd() * 20, invMass: rnd() < 0.8 ? 0.5 : 0.1 + rnd() * 2,
      damping: 0.96, bCoef: 0.5, cMask: 39, cGroup: red ? 2 : 4, ygravity: rnd() < 0.1 ? 0.01 : 0,
    });
  }
  // Random initial velocities for the stadium's own movable discs.
  for (let i = 0; i < ourSt.discs.length; i++) {
    if (ours.discs[i]!.invMass !== 0) nudge(ours, off, i, (rnd() * 2 - 1) * 6, (rnd() * 2 - 1) * 6);
  }
  const first = ourSt.discs.length;
  let comparisons = 0;
  for (let t = 1; t <= ticks; t++) {
    const ball = ours.discs[0]!;
    for (let p = first; p < ours.discs.length; p++) {
      const me = ours.discs[p]!;
      // chase input (diagonal normalised like the official input code)
      let dx = ball.x > me.x ? 1 : -1;
      let dy = ball.y > me.y ? 1 : -1;
      if (rnd() < 0.3) { dx = Math.floor(rnd() * 3) - 1; dy = Math.floor(rnd() * 3) - 1; }
      if (dx !== 0 && dy !== 0) { const f = Math.sqrt(dx * dx + dy * dy); dx /= f; dy /= f; }
      nudge(ours, off, p, dx * 0.1, dy * 0.1);
      // kick: same formula as the official kick (4 px edge distance)
      const kx = ball.x - me.x;
      const ky = ball.y - me.y;
      const dist = Math.sqrt(kx * kx + ky * ky);
      if (rnd() < 0.2 && 4 > dist - ball.radius - me.radius) {
        const nx = kx / dist;
        const ny = ky / dist;
        nudge(ours, off, 0, nx * 5 * ball.invMass, ny * 5 * ball.invMass);
      }
    }
    if (rnd() < 0.02) {
      const i = Math.floor(rnd() * ours.discs.length);
      nudge(ours, off, i, (rnd() * 2 - 1) * 8, (rnd() * 2 - 1) * 8);
    }
    if (rnd() < 0.01) {
      // kick-off style mask flip on a player disc (39 | redKO/blueKO)
      const i = first + Math.floor(rnd() * Math.max(1, players));
      if (i < ours.discs.length) {
        const m = 39 | (rnd() < 0.5 ? 8 : 16);
        ours.discs[i]!.cMask = m;
        off.A[i].c = m;
      }
    }
    stepWorld(ours, dt);
    off.Da(dt);
    compare(ours, off, t, label);
    comparisons += ours.discs.length * FIELDS.length;
  }
  return comparisons;
}

const TICKS = 5000;
let totalTicks = 0;
let totalComparisons = 0;

describe('stepWorld is bit-exact with the official World step', () => {
  const defaults = defaultStadiums();
  for (let i = 0; i < defaults.length; i++) {
    it(`default #${i} ${defaults[i]!.name}: 8 players, ${TICKS} ticks`, () => {
      totalComparisons += run(defaults[i]!.name!, defaults[i]!, officialDefaults()[i], 7 + i, TICKS, 8);
      totalTicks += TICKS;
    });
  }
  it(`Huge: 30 players, ${TICKS} ticks`, () => {
    totalComparisons += run('Huge30', defaults[9]!, officialDefaults()[9], 99, TICKS, 30);
    totalTicks += TICKS;
  });

  const customs = [
    // Uncast disc values (string/missing pos, null speed) stay as-is on the official HOST but are
    // numbers for every client (and for us): use numeric ones for physics.
    ...HAND.filter((h) => h.name !== 'big-but-legal' && h.name !== 'nulls-and-missing').map((h) => ({
      name: h.name,
      // A joint without d0 is skipped by the official host (index undefined)
      // but applied to disc 0 by clients (u8 0 on the wire) and by us.
      hbs: h.hbs
        .replace('{ pos: ["5", "6"], speed: [null, 1] }, { pos: [1] }, { pos: 5 }', '{ pos: [5, 6], speed: [0, 1] }, { pos: [1, 0] }, { pos: [0, 0] }')
        .replace('{ d1: 2 }, ', ''),
    })),
    ...Array.from({ length: 12 }, (_, i) => ({ name: `random #${i}`, hbs: randomHbs(5000 + i) })),
  ];
  for (const c of customs) {
    it(`custom ${c.name}: 6 players, ${TICKS} ticks`, () => {
      totalComparisons += run(c.name, parseHbs(c.hbs), officialParseHbs(c.hbs), 31, TICKS, 6);
      totalTicks += TICKS;
    });
  }
  it('custom big-but-legal (255 segments/planes/vertexes, 254 discs, 300 joints): 600 ticks', () => {
    const c = HAND.find((h) => h.name === 'big-but-legal')!;
    totalComparisons += run(c.name, parseHbs(c.hbs), officialParseHbs(c.hbs), 5, 600, 4);
    totalTicks += 600;
  });
  it('fractional dt (extrapolation path) on Classic and the arena', () => {
    totalComparisons += run('Classic dt=0.37', defaults[0]!, officialDefaults()[0], 3, 1000, 8, 0.37);
    const arena = HAND[0]!.hbs;
    totalComparisons += run('arena dt=1.5', parseHbs(arena), officialParseHbs(arena), 4, 1000, 6, 1.5);
    totalTicks += 2000;
  });
  it('summary', () => {
    expect(totalTicks).toBeGreaterThan(0);
    process.stdout.write(`[sim] physics: ${totalTicks} ticks compared bit-exact, ${totalComparisons} field comparisons\n`);
  });
});
