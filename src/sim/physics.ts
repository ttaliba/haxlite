/**
 * Physics world step and world helpers.
 *
 * Transcription of the official World step `Oa.Da(dt)` and the
 * collision routines it calls (headless f066733d): disc-disc `Ba.Cg`,
 * disc-plane (inline), disc-segment `Ba.Dg`, disc-vertex (inline), joint
 * `Ha.Da`. Every floating-point expression keeps the official operand order
 * and temporaries; flat `x`/`y` fields replace the official `{x,y}` objects
 * without changing any arithmetic. No allocation happens in this file's
 * per-tick code.
 */
import type { Disc, Joint, Plane, Segment, Stadium, Vertex, World } from './types.js';
import { Disc as DiscClass, World as WorldClass } from './types.js';

/** Collision filter: both sides must accept each other (`0 != (a.cMask & b.cGroup) && 0 != (a.cGroup & b.cMask)`). */
function accepts(mask: number, group: number, otherMask: number, otherGroup: number): boolean {
  return 0 !== (otherMask & group) && 0 !== (otherGroup & mask);
}

/** Disc-disc collision, `a` = lower index (off `Ba.Cg`, this = a). */
export function collideDiscs(a: Disc, b: Disc): void {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  let r = b.radius + a.radius;
  let dist = dx * dx + dy * dy;
  if (0 < dist && dist <= r * r) {
    dist = Math.sqrt(dist);
    dx /= dist;
    dy /= dist;
    let ratio = a.invMass / (a.invMass + b.invMass);
    r -= dist;
    dist = r * ratio;
    a.x = a.x + dx * dist;
    a.y = a.y + dy * dist;
    r -= dist;
    b.x = b.x - dx * r;
    b.y = b.y - dy * r;
    r = dx * (a.xspeed - b.xspeed) + dy * (a.yspeed - b.yspeed);
    if (0 > r) {
      r *= a.bCoef * b.bCoef + 1;
      ratio *= r;
      a.xspeed = a.xspeed - dx * ratio;
      a.yspeed = a.yspeed - dy * ratio;
      ratio = r - ratio;
      b.xspeed = b.xspeed + dx * ratio;
      b.yspeed = b.yspeed + dy * ratio;
    }
  }
}

/** Disc-plane collision (inline in off `Oa.Da`). */
export function collideDiscPlane(d: Disc, p: Plane): void {
  let g = p.dist - (p.normalX * d.x + p.normalY * d.y) + d.radius;
  if (0 < g) {
    d.x = d.x + p.normalX * g;
    d.y = d.y + p.normalY * g;
    g = d.xspeed * p.normalX + d.yspeed * p.normalY;
    if (0 > g) {
      g *= d.bCoef * p.bCoef + 1;
      d.xspeed = d.xspeed - p.normalX * g;
      d.yspeed = d.yspeed - p.normalY * g;
    }
  }
}

/** Disc-segment collision, straight or curved, with bias (off `Ba.Dg`). */
export function collideDiscSegment(d: Disc, s: Segment): void {
  let nx: number;
  let ny: number;
  let g: number;
  if (0 !== 0 * s.curveF) {
    // straight
    const ax = s.v0.x;
    const ay = s.v0.y;
    const bx = s.v1.x;
    const by = s.v1.y;
    const ex = bx - ax;
    const ey = by - ay;
    const px = d.x - bx;
    const py = d.y - by;
    if (0 >= (d.x - ax) * ex + (d.y - ay) * ey || 0 <= px * ex + py * ey) return;
    nx = s.normalX;
    ny = s.normalY;
    g = nx * px + ny * py;
  } else {
    // curved
    nx = d.x - s.arcCenterX;
    ny = d.y - s.arcCenterY;
    if ((0 < s.v0NormalX * nx + s.v0NormalY * ny && 0 < s.v1NormalX * nx + s.v1NormalY * ny) === (0 >= s.curveF)) return;
    const len = Math.sqrt(nx * nx + ny * ny);
    if (0 === len) return;
    g = len - s.arcRadius;
    nx /= len;
    ny /= len;
  }
  let bias = s.bias;
  if (0 === bias) {
    if (0 > g) {
      g = -g;
      nx = -nx;
      ny = -ny;
    }
  } else {
    if (0 > bias) {
      bias = -bias;
      g = -g;
      nx = -nx;
      ny = -ny;
    }
    if (g < -bias) return;
  }
  if (g >= d.radius) return;
  g = d.radius - g;
  d.x = d.x + nx * g;
  d.y = d.y + ny * g;
  g = nx * d.xspeed + ny * d.yspeed;
  if (0 > g) {
    g *= d.bCoef * s.bCoef + 1;
    d.xspeed = d.xspeed - nx * g;
    d.yspeed = d.yspeed - ny * g;
  }
}

/** Disc-vertex collision (inline in off `Oa.Da`). */
export function collideDiscVertex(d: Disc, v: Vertex): void {
  let dx = d.x - v.x;
  let dy = d.y - v.y;
  let dist = dx * dx + dy * dy;
  if (0 < dist && dist <= d.radius * d.radius) {
    dist = Math.sqrt(dist);
    dx /= dist;
    dy /= dist;
    dist = d.radius - dist;
    d.x = d.x + dx * dist;
    d.y = d.y + dy * dist;
    dist = dx * d.xspeed + dy * d.yspeed;
    if (0 > dist) {
      dist *= d.bCoef * v.bCoef + 1;
      d.xspeed = d.xspeed - dx * dist;
      d.yspeed = d.yspeed - dy * dist;
    }
  }
}

/** One joint relaxation (off `Ha.Da`). Missing discs -> no-op. */
export function solveJoint(j: Joint, discs: Disc[]): void {
  const i0 = j.d0;
  const i1 = j.d1;
  if (!(i0 >= 0 && i0 < discs.length && i1 >= 0 && i1 < discs.length)) return;
  const a = discs[i0]!;
  const b = discs[i1]!;
  let nx = a.x - b.x;
  let ny = a.y - b.y;
  let dist = Math.sqrt(nx * nx + ny * ny);
  if (0 >= dist) return;
  nx /= dist;
  ny /= dist;
  let ratio = a.invMass / (a.invMass + b.invMass);
  if (ratio !== ratio) ratio = 0.5;
  let target: number;
  let dir: number;
  if (j.minLength >= j.maxLength) {
    target = j.minLength;
    dir = 0;
  } else if (dist <= j.minLength) {
    target = j.minLength;
    dir = 1;
  } else if (dist >= j.maxLength) {
    target = j.maxLength;
    dir = -1;
  } else return;
  dist = target - dist;
  if (0 === 0 * j.strength) {
    // spring
    ratio = j.strength * dist * 0.5;
    nx *= ratio;
    ny *= ratio;
    let m = a.invMass;
    a.xspeed = a.xspeed + nx * m;
    a.yspeed = a.yspeed + ny * m;
    m = b.invMass;
    b.xspeed = b.xspeed + -nx * m;
    b.yspeed = b.yspeed + -ny * m;
  } else {
    // rigid
    target = dist * ratio;
    a.x = a.x + nx * target * 0.5;
    a.y = a.y + ny * target * 0.5;
    dist -= target;
    b.x = b.x - nx * dist * 0.5;
    b.y = b.y - ny * dist * 0.5;
    dist = nx * (a.xspeed - b.xspeed) + ny * (a.yspeed - b.yspeed);
    if (0 >= dist * dir) {
      ratio *= dist;
      a.xspeed = a.xspeed - nx * ratio;
      a.yspeed = a.yspeed - ny * ratio;
      ratio = dist - ratio;
      b.xspeed = b.xspeed + nx * ratio;
      b.yspeed = b.yspeed + ny * ratio;
    }
  }
}

// ------------------------------------------------- static-geometry filter

/**
 * Per-(cMask, cGroup) list of the static objects a disc can collide with, in
 * the original array order. Skipping objects that fail the mask test has no
 * side effect, so iterating this ordered subset is arithmetically identical
 * to the official full scan; it just avoids re-testing masks that cannot
 * match (e.g. player discs vs ball-only nets) every tick.
 */
class MaskFilter {
  cMask: number;
  cGroup: number;
  planes: Int32Array;
  segments: Int32Array;
  vertexes: Int32Array;
  constructor(cMask: number, cGroup: number, planes: Plane[], segments: Segment[], vertexes: Vertex[]) {
    this.cMask = cMask;
    this.cGroup = cGroup;
    this.planes = MaskFilter.select(cMask, cGroup, planes);
    this.segments = MaskFilter.select(cMask, cGroup, segments);
    this.vertexes = MaskFilter.select(cMask, cGroup, vertexes);
  }
  private static select(cMask: number, cGroup: number, list: { cMask: number; cGroup: number }[]): Int32Array {
    let n = 0;
    for (let i = 0; i < list.length; i++) if (accepts(cMask, cGroup, list[i]!.cMask, list[i]!.cGroup)) n++;
    const out = new Int32Array(n);
    n = 0;
    for (let i = 0; i < list.length; i++) if (accepts(cMask, cGroup, list[i]!.cMask, list[i]!.cGroup)) out[n++] = i;
    return out;
  }
}

/** Filter cache of one world, valid while its geometry arrays (identity + length) are unchanged. */
class GeometryCache {
  planes: Plane[] | null = null;
  segments: Segment[] | null = null;
  vertexes: Vertex[] | null = null;
  planeCount = -1;
  segmentCount = -1;
  vertexCount = -1;
  filters: MaskFilter[] = [];
}

/** Upper bound of distinct mask pairs kept per world (reset beyond it). */
const MAX_FILTERS = 64;
const geometryCaches = new WeakMap<World, GeometryCache>();

function geometryCache(world: World): GeometryCache {
  let c = geometryCaches.get(world);
  if (c === undefined) {
    c = new GeometryCache();
    geometryCaches.set(world, c);
  }
  if (
    c.planes !== world.planes || c.planeCount !== world.planes.length ||
    c.segments !== world.segments || c.segmentCount !== world.segments.length ||
    c.vertexes !== world.vertexes || c.vertexCount !== world.vertexes.length
  ) {
    c.planes = world.planes;
    c.segments = world.segments;
    c.vertexes = world.vertexes;
    c.planeCount = world.planes.length;
    c.segmentCount = world.segments.length;
    c.vertexCount = world.vertexes.length;
    c.filters.length = 0;
  }
  return c;
}

function maskFilter(c: GeometryCache, cMask: number, cGroup: number): MaskFilter {
  const fs = c.filters;
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i]!;
    if (f.cMask === cMask && f.cGroup === cGroup) return f;
  }
  if (fs.length >= MAX_FILTERS) fs.length = 0;
  const f = new MaskFilter(cMask, cGroup, c.planes!, c.segments!, c.vertexes!);
  fs.push(f);
  return f;
}

/**
 * Drops the cached static-geometry filters of `world`. Only needed if the
 * cMask/cGroup of a plane, segment or vertex is mutated IN PLACE while a game
 * runs (the official game never does; replacing the arrays is detected).
 */
export function invalidateGeometryCache(world: World): void {
  geometryCaches.delete(world);
}

// ------------------------------------------------------------------- step

/**
 * One physics step (off `Oa.Da(dt)`; the authoritative game uses dt = 1):
 *  1. integrate every disc: `pos += speed*dt; speed = (speed + gravity)*damping`;
 *  2. one sequential collision pass: for each disc i, discs j > i, then (only
 *     if invMass != 0) planes, segments, vertexes, all filtered by masks;
 *  3. joints, two passes.
 * No allocation per tick (the geometry filter cache only allocates when a
 * new (cMask, cGroup) pair or new geometry arrays show up).
 */
export function stepWorld(world: World, dt: number): void {
  const discs = world.discs;
  const n = discs.length;
  for (let i = 0; i < n; i++) {
    const d = discs[i]!;
    d.x = d.x + d.xspeed * dt;
    d.y = d.y + d.yspeed * dt;
    const damping = d.damping;
    d.xspeed = (d.xspeed + d.xgravity) * damping;
    d.yspeed = (d.yspeed + d.ygravity) * damping;
  }

  const cache = geometryCache(world);
  const planes = world.planes;
  const segments = world.segments;
  const vertexes = world.vertexes;
  for (let i = 0; i < n; i++) {
    const a = discs[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = discs[j]!;
      if (accepts(a.cMask, a.cGroup, b.cMask, b.cGroup)) collideDiscs(a, b);
    }
    if (0 !== a.invMass) {
      const f = maskFilter(cache, a.cMask, a.cGroup);
      const fp = f.planes;
      for (let k = 0; k < fp.length; k++) collideDiscPlane(a, planes[fp[k]!]!);
      const fs = f.segments;
      for (let k = 0; k < fs.length; k++) collideDiscSegment(a, segments[fs[k]!]!);
      const fv = f.vertexes;
      for (let k = 0; k < fv.length; k++) collideDiscVertex(a, vertexes[fv[k]!]!);
    }
  }

  const joints = world.joints;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < joints.length; k++) solveJoint(joints[k]!, discs);
  }
}

/**
 * Reference implementation of the step: a literal transcription of the
 * official loop (full mask scan of every static object). Same results as
 * {@link stepWorld}; kept for tests and as executable documentation.
 */
export function stepWorldReference(world: World, dt: number): void {
  const discs = world.discs;
  const n = discs.length;
  for (let i = 0; i < n; i++) {
    const d = discs[i]!;
    d.x = d.x + d.xspeed * dt;
    d.y = d.y + d.yspeed * dt;
    const damping = d.damping;
    d.xspeed = (d.xspeed + d.xgravity) * damping;
    d.yspeed = (d.yspeed + d.ygravity) * damping;
  }
  const planes = world.planes;
  const segments = world.segments;
  const vertexes = world.vertexes;
  for (let i = 0; i < n; i++) {
    const a = discs[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = discs[j]!;
      if (accepts(a.cMask, a.cGroup, b.cMask, b.cGroup)) collideDiscs(a, b);
    }
    if (0 !== a.invMass) {
      for (let k = 0; k < planes.length; k++) {
        const p = planes[k]!;
        if (accepts(a.cMask, a.cGroup, p.cMask, p.cGroup)) collideDiscPlane(a, p);
      }
      for (let k = 0; k < segments.length; k++) {
        const s = segments[k]!;
        if (accepts(a.cMask, a.cGroup, s.cMask, s.cGroup)) collideDiscSegment(a, s);
      }
      for (let k = 0; k < vertexes.length; k++) {
        const v = vertexes[k]!;
        if (accepts(a.cMask, a.cGroup, v.cMask, v.cGroup)) collideDiscVertex(a, v);
      }
    }
  }
  const joints = world.joints;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < joints.length; k++) solveJoint(joints[k]!, discs);
  }
}

// ---------------------------------------------------------- world helpers

/** Copies every disc property (pos, speed, gravity, radius, bCoef, invMass, damping, color, masks) from `src` into `dst` (off `X.$e`). */
export function copyDiscProps(dst: Disc, src: Disc): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.xspeed = src.xspeed;
  dst.yspeed = src.yspeed;
  dst.xgravity = src.xgravity;
  dst.ygravity = src.ygravity;
  dst.radius = src.radius;
  dst.bCoef = src.bCoef;
  dst.invMass = src.invMass;
  dst.damping = src.damping;
  dst.color = src.color;
  dst.cMask = src.cMask;
  dst.cGroup = src.cGroup;
}

/** New live disc cloned from a stadium template disc (off `X.th`). `index` = 0. */
export function cloneDisc(src: Disc): Disc {
  const d = new DiscClass();
  copyDiscProps(d, src);
  return d;
}

/**
 * Points the world's static geometry at the stadium's arrays (shared by
 * reference, like the official `Q.eh`): vertexes, planes, segments, joints.
 */
export function attachStadium(world: World, stadium: Stadium): void {
  world.vertexes = stadium.vertexes;
  world.planes = stadium.planes;
  world.segments = stadium.segments;
  world.joints = stadium.joints;
}

/**
 * Game-start world (the physics half of off `Q.eh`): geometry shared with the
 * stadium and the stadium discs cloned in order (ball first). Player discs
 * are appended by the room logic.
 */
export function createWorld(stadium: Stadium): World {
  const world = new WorldClass();
  attachStadium(world, stadium);
  const src = stadium.discs;
  for (let i = 0; i < src.length; i++) {
    const d = cloneDisc(src[i]!);
    d.index = i;
    world.discs.push(d);
  }
  return world;
}

/**
 * Goal-line crossing test (off `w.Ag(cur, prev)`): returns the team id that
 * OWNS the first goal crossed by the move prev -> cur (1 red, 2 blue), or 0.
 * Note the official argument order: current position first.
 */
export function goalCrossed(stadium: Stadium, curX: number, curY: number, prevX: number, prevY: number): number {
  const goals = stadium.goals;
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i]!;
    const p0x = goal.p0x;
    const p0y = goal.p0y;
    const p1x = goal.p1x;
    const p1y = goal.p1y;
    let gx = prevX - curX;
    const gy = prevY - curY;
    let crossed: boolean;
    if ((0 < -(p0y - curY) * gx + (p0x - curX) * gy) === (0 < -(p1y - curY) * gx + (p1x - curX) * gy)) {
      crossed = false;
    } else {
      gx = p1x - p0x;
      const fy = p1y - p0y;
      crossed = !((0 < -(curY - p0y) * gx + (curX - p0x) * fy) === (0 < -(prevY - p0y) * gx + (prevX - p0x) * fy));
    }
    if (crossed) return goal.team;
  }
  return 0;
}
