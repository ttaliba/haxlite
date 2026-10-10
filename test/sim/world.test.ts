/**
 * World / disc wire form vs the official serializer (`Oa.G`), goal-line test
 * vs the official `w.Ag`, the cached step vs the literal reference step, and
 * geometry-cache invalidation.
 */
import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/codec/index.js';
import {
  Disc,
  createWorld,
  defaultStadiums,
  goalCrossed,
  invalidateGeometryCache,
  parseHbs,
  readWorld,
  stepWorld,
  stepWorldReference,
  writeWorld,
} from '../../src/sim/index.js';
import type { World } from '../../src/sim/index.js';
import { officialInternals } from '../oracle/official.js';
import { prng } from '../oracle/index.js';
import { ARENA_HBS } from './hbs-corpus.js';
import { officialDefaults, officialDisc, officialParseHbs, officialWorld } from './official-sim.js';
import type { Any } from './official-sim.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function officialWorldBytes(world: Any): Uint8Array {
  const x = officialInternals();
  const w = x.A.aa();
  world.G(w);
  return Uint8Array.from(w.Db() as Uint8Array);
}

describe('world wire form', () => {
  it('matches the official World serializer (incl. -0, NaN, transparent colour) and assigns disc.index', () => {
    const ours = createWorld(defaultStadiums()[0]!);
    const off = officialWorld(officialDefaults()[0]);
    const specs = [
      { x: -277.5, y: -0, color: -1 },
      { x: 277.5, y: 55, color: 0x5689e5 },
      { x: NaN, y: Infinity, color: 0xffffffff },
    ];
    for (const s of specs) {
      const d = new Disc();
      d.x = s.x; d.y = s.y; d.color = s.color; d.cMask = 39 | 8; d.cGroup = 2; d.radius = 15; d.invMass = 0.5; d.damping = 0.96;
      ours.discs.push(d);
      const o = officialDisc();
      o.a.x = s.x; o.a.y = s.y; o.T = s.color; o.c = 39 | 8; o.o = 2; o.M = 15; o.L = 0.5; o.ga = 0.96;
      off.A.push(o);
    }
    const w = new Writer(64);
    writeWorld(w, ours);
    const bytes = w.copyBytes();
    expect(hex(bytes)).toBe(hex(officialWorldBytes(off)));
    expect(ours.discs.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(bytes.length).toBe(1 + 92 * 8);

    const back = readWorld(new Reader(bytes));
    expect(back.discs.length).toBe(8);
    expect(Object.is(back.discs[5]!.y, -0)).toBe(true);
    expect(back.discs[5]!.color).toBe(0xffffffff); // u32 round trip of -1
    const w2 = new Writer(64);
    writeWorld(w2, back);
    expect(hex(w2.copyBytes())).toBe(hex(bytes));
  });
});

describe('goalCrossed == official w.Ag', () => {
  it('random moves across random goals (incl. built-in goals)', () => {
    const rnd = prng(77);
    const stadiums: [ReturnType<typeof parseHbs>, Any][] = [
      [defaultStadiums()[0]!, officialDefaults()[0]],
      [defaultStadiums()[5]!, officialDefaults()[5]],
      [parseHbs(ARENA_HBS), officialParseHbs(ARENA_HBS)],
    ];
    let hits = 0;
    for (const [ours, off] of stadiums) {
      for (let i = 0; i < 20000; i++) {
        const cx = (rnd() * 2 - 1) * 450;
        const cy = (rnd() * 2 - 1) * 120;
        const px = rnd() < 0.5 ? cx + (rnd() * 2 - 1) * 30 : -cx;
        const py = rnd() < 0.1 ? cy : cy + (rnd() * 2 - 1) * 30;
        const team = off.Ag({ x: cx, y: cy }, { x: px, y: py }).P;
        expect(goalCrossed(ours, cx, cy, px, py)).toBe(team);
        if (team !== 0) hits++;
      }
    }
    expect(hits).toBeGreaterThan(100);
  });
});

function fill(world: World, seed: number, n: number): void {
  const rnd = prng(seed);
  for (let p = 0; p < n; p++) {
    const d = new Disc();
    d.x = (rnd() * 2 - 1) * 300; d.y = (rnd() * 2 - 1) * 150;
    d.xspeed = (rnd() * 2 - 1) * 4; d.yspeed = (rnd() * 2 - 1) * 4;
    d.radius = 15; d.invMass = 0.5; d.damping = 0.96; d.cMask = 39; d.cGroup = p % 2 ? 4 : 2;
    world.discs.push(d);
  }
}

function snapshot(world: World): number[] {
  const out: number[] = [];
  for (const d of world.discs) out.push(d.x, d.y, d.xspeed, d.yspeed);
  return out;
}

describe('cached stepWorld == literal reference step', () => {
  it('every default stadium, 2000 ticks, with kick-off mask flips', () => {
    for (let s = 0; s < 10; s++) {
      const a = createWorld(defaultStadiums()[s]!);
      const b = createWorld(defaultStadiums()[s]!);
      fill(a, s, 10);
      fill(b, s, 10);
      for (let t = 0; t < 2000; t++) {
        if (t % 300 === 0) {
          const m = t % 600 === 0 ? 39 | 8 : 39;
          for (let i = 5; i < a.discs.length; i++) { a.discs[i]!.cMask = m; b.discs[i]!.cMask = m; }
        }
        stepWorld(a, 1);
        stepWorldReference(b, 1);
      }
      expect(snapshot(a)).toEqual(snapshot(b));
    }
  });

  it('notices replaced geometry arrays and honours invalidateGeometryCache after in-place mask edits', () => {
    const st = parseHbs(ARENA_HBS);
    const a = createWorld(st);
    const b = createWorld(st);
    fill(a, 1, 6);
    fill(b, 1, 6);
    for (let t = 0; t < 200; t++) { stepWorld(a, 1); stepWorldReference(b, 1); }
    // replace arrays (e.g. a different stadium's geometry)
    const other = defaultStadiums()[3]!;
    for (const w of [a, b]) { w.planes = other.planes; w.segments = other.segments; w.vertexes = other.vertexes; }
    for (let t = 0; t < 200; t++) { stepWorld(a, 1); stepWorldReference(b, 1); }
    expect(snapshot(a)).toEqual(snapshot(b));
    // in-place mask edit on a private copy of the geometry
    const priv = parseHbs(ARENA_HBS);
    for (const w of [a, b]) { w.planes = priv.planes; w.segments = priv.segments; w.vertexes = priv.vertexes; }
    for (let t = 0; t < 50; t++) { stepWorld(a, 1); stepWorldReference(b, 1); }
    for (const p of priv.planes) p.cMask = 0;
    invalidateGeometryCache(a);
    for (let t = 0; t < 300; t++) { stepWorld(a, 1); stepWorldReference(b, 1); }
    expect(snapshot(a)).toEqual(snapshot(b));
  });
});
