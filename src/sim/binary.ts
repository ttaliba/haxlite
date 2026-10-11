/**
 * Binary (wire) form of stadiums, discs and the physics world.
 *
 * Layouts (big-endian), transcribed from the official serializers
 * (headless f066733d): Stadium `w.G`/`w.oi`/`w.qa`, Vertex `C.G`, Segment
 * `E.G`, Plane `K.G`, Goal `xa.G`, Disc `X.G`/`Ba.G`, Joint `Ha.G`,
 * PlayerPhysics `Qa.G`, World `Oa.G`. See docs/02 §5.3 and §4.4.
 */
import type { Reader, Writer } from '../codec/index.js';
import { DEFAULT_STADIUM_COUNT, defaultStadium } from './defaults.js';
import { isValidStadium, prepareStadium } from './geometry.js';
import { Disc, Goal, Joint, Plane, PlayerPhysics, Segment, Stadium, Vertex, World } from './types.js';
import type { Point } from './types.js';

/** Thrown when a decoded stadium fails the official validity test. */
export class InvalidStadiumError extends Error {
  constructor(message = 'Invalid stadium') {
    super(message);
    this.name = 'InvalidStadiumError';
  }
}

// ------------------------------------------------------------------ discs

/** 92-byte disc layout (off `X.G` / `Ba.G`). `color` is written as u32. */
export function writeDisc(w: Writer, d: Disc): void {
  w.f64(d.x);
  w.f64(d.y);
  w.f64(d.xspeed);
  w.f64(d.yspeed);
  w.f64(d.xgravity);
  w.f64(d.ygravity);
  w.f64(d.radius);
  w.f64(d.bCoef);
  w.f64(d.invMass);
  w.f64(d.damping);
  w.u32(d.color);
  w.i32(d.cMask);
  w.i32(d.cGroup);
}

/** Reads a disc into `d` (or a new Disc). Inverse of {@link writeDisc}. */
export function readDisc(r: Reader, d: Disc = new Disc()): Disc {
  d.x = r.f64();
  d.y = r.f64();
  d.xspeed = r.f64();
  d.yspeed = r.f64();
  d.xgravity = r.f64();
  d.ygravity = r.f64();
  d.radius = r.f64();
  d.bCoef = r.f64();
  d.invMass = r.f64();
  d.damping = r.f64();
  d.color = r.u32();
  d.cMask = r.i32();
  d.cGroup = r.i32();
  return d;
}

/**
 * World wire form (off `Oa.G`): `u8 n` + n discs. Assigns `disc.index` while
 * writing, like the official serializer (Player serialization relies on it).
 */
export function writeWorld(w: Writer, world: World): void {
  const discs = world.discs;
  w.u8(discs.length);
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i]!;
    d.index = i;
    writeDisc(w, d);
  }
}

/**
 * Reads the dynamic discs of a world (`u8 n` + n discs) into `world.discs`
 * (replacing them) and sets each `disc.index`. The static geometry is not
 * part of the wire form: attach it with `attachStadium(world, stadium)`.
 */
export function readWorld(r: Reader, world: World = new World()): World {
  const n = r.u8();
  const discs: Disc[] = [];
  for (let i = 0; i < n; i++) {
    const d = readDisc(r);
    d.index = i;
    discs.push(d);
  }
  world.discs = discs;
  return world;
}

// --------------------------------------------------------- stadium parts

function writePlayerPhysics(w: Writer, p: PlayerPhysics): void {
  w.f64(p.bCoef);
  w.f64(p.invMass);
  w.f64(p.damping);
  w.f64(p.acceleration);
  w.f64(p.kickingAcceleration);
  w.f64(p.kickingDamping);
  w.f64(p.kickStrength);
  w.f64(p.gravityX);
  w.f64(p.gravityY);
  w.i32(p.cGroup);
  w.f64(p.radius);
  w.f64(p.kickback);
}

function readPlayerPhysics(r: Reader, p: PlayerPhysics): void {
  p.bCoef = r.f64();
  p.invMass = r.f64();
  p.damping = r.f64();
  p.acceleration = r.f64();
  p.kickingAcceleration = r.f64();
  p.kickingDamping = r.f64();
  p.kickStrength = r.f64();
  p.gravityX = r.f64();
  p.gravityY = r.f64();
  p.cGroup = r.i32();
  p.radius = r.f64();
  p.kickback = r.f64();
}

function writeSegment(w: Writer, s: Segment): void {
  const at = w.pos;
  w.u8(0); // flags placeholder, patched below
  w.u8(s.v0.index);
  w.u8(s.v1.index);
  let flags = 0;
  if (0 != s.bias) {
    flags = 1;
    w.f64(s.bias);
  }
  if (s.curveF != Infinity) {
    flags |= 2;
    w.f64(s.curveF);
  }
  if (0 != s.color) {
    flags |= 4;
    w.i32(s.color);
  }
  if (s.vis) flags |= 8;
  w.setU8At(at, flags);
  w.f64(s.bCoef);
  w.i32(s.cMask);
  w.i32(s.cGroup);
}

function readSegment(r: Reader, vertexes: Vertex[]): Segment {
  const flags = r.u8();
  const v0 = vertexes[r.u8()];
  const v1 = vertexes[r.u8()];
  if (v0 === undefined || v1 === undefined) throw new InvalidStadiumError('Invalid stadium: segment vertex out of range');
  const s = new Segment(v0, v1);
  s.bias = 0 != (flags & 1) ? r.f64() : 0;
  s.curveF = 0 != (flags & 2) ? r.f64() : Infinity;
  s.color = 0 != (flags & 4) ? r.i32() : 0;
  s.vis = 0 != (flags & 8);
  s.bCoef = r.f64();
  s.cMask = r.i32();
  s.cGroup = r.i32();
  return s;
}

function writePoints(w: Writer, pts: Point[]): void {
  w.u8(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    w.f64(p.x);
    w.f64(p.y);
  }
}

function readPoints(r: Reader): Point[] {
  const out: Point[] = [];
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    const x = r.f64();
    const y = r.f64();
    out.push({ x, y });
  }
  return out;
}

// --------------------------------------------------------------- stadium

/**
 * Full stadium body (everything after the `u8 defaultStadiumId`), off `w.G`
 * minus the first byte. Assigns `vertex.index` while writing (segments
 * reference vertices by that index), as the official serializer does.
 */
export function writeStadiumBody(w: Writer, s: Stadium): void {
  w.nullableString(s.name);
  w.i32(s.bgType);
  w.f64(s.bgWidth);
  w.f64(s.bgHeight);
  w.f64(s.bgKickOffRadius);
  w.f64(s.bgCornerRadius);
  w.f64(s.bgGoalLine);
  w.i32(s.bgColor);
  w.f64(s.width);
  w.f64(s.height);
  w.f64(s.spawnDistance);
  writePlayerPhysics(w, s.playerPhysics);
  w.u16(s.maxViewWidth);
  w.u8(s.cameraFollow);
  w.u8(s.canBeStored ? 1 : 0);
  w.u8(s.fullKickOffReset ? 1 : 0);

  const vs = s.vertexes;
  w.u8(vs.length);
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!;
    v.index = i;
    w.f64(v.x);
    w.f64(v.y);
    w.f64(v.bCoef);
    w.i32(v.cMask);
    w.i32(v.cGroup);
  }

  const ss = s.segments;
  w.u8(ss.length);
  for (let i = 0; i < ss.length; i++) writeSegment(w, ss[i]!);

  const ps = s.planes;
  w.u8(ps.length);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    w.f64(p.normalX);
    w.f64(p.normalY);
    w.f64(p.dist);
    w.f64(p.bCoef);
    w.i32(p.cMask);
    w.i32(p.cGroup);
  }

  const gs = s.goals;
  w.u8(gs.length);
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i]!;
    w.f64(g.p0x);
    w.f64(g.p0y);
    w.f64(g.p1x);
    w.f64(g.p1y);
    w.u8(g.team);
  }

  const ds = s.discs;
  w.u8(ds.length);
  for (let i = 0; i < ds.length; i++) writeDisc(w, ds[i]!);

  const js = s.joints;
  w.u8(js.length);
  for (let i = 0; i < js.length; i++) {
    const j = js[i]!;
    w.u8(j.d0);
    w.u8(j.d1);
    w.f64(j.minLength);
    w.f64(j.maxLength);
    w.f64(j.strength);
    w.i32(j.color);
  }

  writePoints(w, s.redSpawnPoints);
  writePoints(w, s.blueSpawnPoints);
}

/**
 * Stadium as it travels inside RoomState / SetStadium (off `w.G`):
 * `u8 defaultStadiumId`; the body follows only when it is 255 (custom).
 */
export function writeStadium(w: Writer, s: Stadium): void {
  w.u8(s.defaultStadiumId);
  if (s.defaultStadiumId === 255) writeStadiumBody(w, s);
}

/**
 * Reads a stadium body (after the id byte), off `w.oi`. Recomputes derived
 * segment geometry and validates (throws InvalidStadiumError like the
 * official reader).
 */
export function readStadiumBody(r: Reader): Stadium {
  const s = new Stadium();
  s.defaultStadiumId = 255;
  s.name = r.nullableString();
  s.bgType = r.i32();
  s.bgWidth = r.f64();
  s.bgHeight = r.f64();
  s.bgKickOffRadius = r.f64();
  s.bgCornerRadius = r.f64();
  s.bgGoalLine = r.f64();
  s.bgColor = r.i32();
  s.width = r.f64();
  s.height = r.f64();
  s.spawnDistance = r.f64();
  readPlayerPhysics(r, s.playerPhysics);
  s.maxViewWidth = r.u16();
  s.cameraFollow = r.u8();
  s.canBeStored = 0 != r.u8();
  s.fullKickOffReset = 0 != r.u8();

  let n = r.u8();
  for (let i = 0; i < n; i++) {
    const v = new Vertex();
    v.x = r.f64();
    v.y = r.f64();
    v.bCoef = r.f64();
    v.cMask = r.i32();
    v.cGroup = r.i32();
    v.index = i;
    s.vertexes.push(v);
  }
  n = r.u8();
  for (let i = 0; i < n; i++) s.segments.push(readSegment(r, s.vertexes));
  n = r.u8();
  for (let i = 0; i < n; i++) {
    const p = new Plane();
    p.normalX = r.f64();
    p.normalY = r.f64();
    p.dist = r.f64();
    p.bCoef = r.f64();
    p.cMask = r.i32();
    p.cGroup = r.i32();
    s.planes.push(p);
  }
  n = r.u8();
  for (let i = 0; i < n; i++) {
    const g = new Goal();
    g.p0x = r.f64();
    g.p0y = r.f64();
    g.p1x = r.f64();
    g.p1y = r.f64();
    const t = r.i8();
    g.team = t === 1 ? 1 : t === 2 ? 2 : 0;
    s.goals.push(g);
  }
  n = r.u8();
  for (let i = 0; i < n; i++) s.discs.push(readDisc(r));
  n = r.u8();
  for (let i = 0; i < n; i++) {
    const j = new Joint();
    j.d0 = r.u8();
    j.d1 = r.u8();
    j.minLength = r.f64();
    j.maxLength = r.f64();
    j.strength = r.f64();
    j.color = r.i32();
    s.joints.push(j);
  }
  s.redSpawnPoints = readPoints(r);
  s.blueSpawnPoints = readPoints(r);
  prepareStadium(s);
  if (!isValidStadium(s)) throw new InvalidStadiumError();
  return s;
}

/**
 * Reads a stadium (off static `w.qa`): `u8 id`; 255 -> body; otherwise the
 * SHARED built-in instance `defaultStadium(id)` (do not mutate it).
 */
export function readStadium(r: Reader): Stadium {
  const id = r.u8();
  if (id === 255) return readStadiumBody(r);
  if (id >= DEFAULT_STADIUM_COUNT) throw new InvalidStadiumError(`Invalid stadium: unknown default stadium id ${id}`);
  return defaultStadium(id);
}
