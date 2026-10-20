/**
 * Geometry filter cache under many distinct (cMask, cGroup) pairs: a stadium
 * may carry up to 255 discs with arbitrary i32 masks. The cached step must
 * stay bit-identical to the literal reference step and stop allocating once
 * every pair has been seen.
 */
import { describe, expect, it } from 'vitest';
import { Disc, createWorld, parseHbs, stepWorld, stepWorldReference } from '../../src/sim/index.js';
import type { World } from '../../src/sim/index.js';
import { prng } from '../oracle/index.js';

/** 255 vertexes / segments / planes with assorted masks. */
function busyStadiumHbs(): string {
  const vertexes: unknown[] = [];
  const segments: unknown[] = [];
  const planes: unknown[] = [];
  const masks = [['all'], ['ball'], ['red', 'blue'], ['c0'], ['wall', 'c1']];
  for (let i = 0; i < 255; i++) {
    vertexes.push({ x: (i % 16) * 30 - 240, y: Math.floor(i / 16) * 20 - 160, cMask: masks[i % masks.length], cGroup: ['wall'] });
    planes.push({ normal: [Math.cos(i), Math.sin(i)], dist: -400 - i, cMask: masks[(i + 1) % masks.length] });
  }
  for (let i = 0; i < 255; i++) segments.push({ v0: i, v1: (i + 1) % 255, cMask: masks[(i + 2) % masks.length] });
  return JSON.stringify({ name: 'masks', width: 400, height: 300, bg: { type: 'none' }, vertexes, segments, planes, discs: [] });
}

function fillDistinctMasks(world: World, seed: number, n: number): void {
  const rnd = prng(seed);
  for (let k = 0; k < n; k++) {
    const d = new Disc();
    d.x = (rnd() * 2 - 1) * 250; d.y = (rnd() * 2 - 1) * 150;
    d.xspeed = (rnd() * 2 - 1) * 3; d.yspeed = (rnd() * 2 - 1) * 3;
    d.radius = 6; d.invMass = 1; d.damping = 0.99; d.bCoef = 0.5;
    // distinct pair per disc; the low bits keep the collisions varied
    d.cMask = (k << 8) | (k % 64);
    d.cGroup = (k << 16) | (1 << (k % 6));
    world.discs.push(d);
  }
}

function snapshot(world: World): number[] {
  const out: number[] = [];
  for (const d of world.discs) out.push(d.x, d.y, d.xspeed, d.yspeed);
  return out;
}

function countInt32Arrays(fn: () => void): number {
  const Original = globalThis.Int32Array;
  let count = 0;
  globalThis.Int32Array = new Proxy(Original, {
    construct(target, args) {
      count++;
      return Reflect.construct(target, args);
    },
  });
  try {
    fn();
  } finally {
    globalThis.Int32Array = Original;
  }
  return count;
}

describe('geometry filter cache with many mask pairs', () => {
  it('200 distinct pairs: bit-identical to the reference step, no allocation after warm-up', () => {
    const st = parseHbs(busyStadiumHbs());
    const a = createWorld(st);
    const b = createWorld(st);
    fillDistinctMasks(a, 7, 200);
    fillDistinctMasks(b, 7, 200);
    for (let t = 0; t < 3; t++) { stepWorld(a, 1); stepWorldReference(b, 1); }
    const allocated = countInt32Arrays(() => {
      for (let t = 0; t < 20; t++) stepWorld(a, 1);
    });
    for (let t = 0; t < 20; t++) stepWorldReference(b, 1);
    expect(allocated).toBe(0);
    for (let t = 0; t < 300; t++) { stepWorld(a, 1); stepWorldReference(b, 1); }
    const sa = snapshot(a);
    const sb = snapshot(b);
    expect(sa.length).toBe(sb.length);
    for (let i = 0; i < sa.length; i++) if (!Object.is(sa[i], sb[i])) expect([i, sa[i]]).toEqual([i, sb[i]]);
  });
});
