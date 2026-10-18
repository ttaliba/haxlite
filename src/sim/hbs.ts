/**
 * `.hbs` (JSON5) stadium parser, equivalent of the official
 * `w.kh` (headless f066733d) and its helpers (`tg` traits, `Ua` collision
 * flags, `Tc` colours, `qh` vertex, `ph` segment, `lh` goal, `ef` disc,
 * `nh` plane, `mh` joint, `oh` player physics).
 *
 * Semantics reproduced from the official code:
 *  - Type checks: numbers must be numbers, `v0/v1/d0/d1` integers, `vis` and
 *    `canBeStored` booleans, `name`/`trait` strings, flag lists arrays
 *    ("Cannot cast" errors). `null`/missing values pass the check.
 *  - A missing scalar that the official code stores as `undefined` ends up
 *    as NaN on the wire (`setFloat64(undefined)`), an explicit `null` as 0;
 *    we store exactly those numbers (what every client decodes).
 *  - Fields copied without a type check (disc pos/speed/gravity, goal
 *    p0/p1) are converted with `Number()` like `setFloat64` does.
 *  - An invalid colour (unparsable hex) is stored as NaN: it serializes as 0
 *    and still sets the segment colour flag, like the official `null`.
 *  - Errors inside one array item are reported as
 *    `Error in "<array>" index: <n>` where n = current length of the target
 *    array (for discs that count includes the ball, as officially).
 *  - Limits: more than 255 vertexes/segments/planes/goals/discs -> "Error";
 *    then derived geometry; then the validity test -> "Invalid stadium".
 */
import { createRequire } from 'node:module';
import { createDefaultBall } from './defaults.js';
import { applySegmentCurve, isValidStadium, prepareStadium } from './geometry.js';
import { Disc, Goal, Joint, Plane, PlayerPhysics, Segment, Stadium, Vertex } from './types.js';
import type { Point } from './types.js';

/** Error raised by {@link parseHbs}. `message` follows the official wording. */
export class HbsParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HbsParseError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** `json5` is loaded on the first text that is not plain JSON (most rooms never need it). */
let json5Parse: ((text: string) => Json) | null = null;
/**
 * JSON5 is a superset of JSON and, for plain JSON text, yields the same value
 * as `JSON.parse` (own `__proto__` keys included), so the native parser goes
 * first (~25x faster: 51 KB map 5.6 ms -> 0.23 ms) and json5 only sees texts
 * JSON rejects (comments, unquoted keys, trailing commas, hex…), reporting
 * the same SyntaxError as before for invalid input.
 */
function parseJson5(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    if (json5Parse === null) json5Parse = (createRequire(import.meta.url)('json5') as typeof import('json5')).parse;
    return json5Parse(text);
  }
}

const castError = (v: unknown, type: string): HbsParseError =>
  new HbsParseError(`Cannot cast ${describe(v)} to ${type}`);

function describe(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** off `q.m(v, Number)` then stored as a double: undefined -> NaN, null -> 0. */
function num(v: unknown): number {
  if (v == null) return Number(v);
  if (typeof v !== 'number') throw castError(v, 'Float');
  return v;
}

/** off `q.m(v, Int)`; returns null/undefined unchanged. */
function int(v: unknown): number | null | undefined {
  if (v == null) return v as null | undefined;
  if (typeof v !== 'number' || (v | 0) !== v) throw castError(v, 'Int');
  return v;
}

function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw castError(v, 'Bool');
  return v;
}

function arr(v: unknown): Json[] | null | undefined {
  if (v == null) return v as null | undefined;
  if (!Array.isArray(v)) throw castError(v, 'Array');
  return v;
}

function str(v: unknown): string | null | undefined {
  if (v == null) return v as null | undefined;
  if (typeof v !== 'string') throw castError(v, 'String');
  return v;
}

/** Number of a value copied without type check (`setFloat64(value)` = ToNumber). */
function rawNum(v: unknown): number {
  return Number(v);
}

/** off `w.Mb(obj, key)`: number or 0 when missing. */
function numOr0(obj: Json, key: string): number {
  const v = obj[key];
  return v != null ? num(v) : 0;
}

/** Collision flag list -> bitmask (off `w.Ua`). Unknown names are ignored. */
export function parseCollisionFlags(v: unknown): number {
  const list = arr(v) as Json[];
  let mask = 0;
  for (let i = 0; i < list.length; i++) {
    switch (list[i]) {
      case 'all': mask |= 63; break;
      case 'ball': mask |= 1; break;
      case 'blue': mask |= 4; break;
      case 'blueKO': mask |= 16; break;
      case 'c0': mask |= 268435456; break;
      case 'c1': mask |= 536870912; break;
      case 'c2': mask |= 1073741824; break;
      case 'c3': mask |= -2147483648; break;
      case 'kick': mask |= 64; break;
      case 'red': mask |= 2; break;
      case 'redKO': mask |= 8; break;
      case 'score': mask |= 128; break;
      case 'wall': mask |= 32; break;
    }
  }
  return mask;
}

/**
 * Colour (off `w.Tc`): "transparent" -> -1, "RRGGBB" -> parseInt('0x'+s)
 * (NaN when unparsable, see module doc), [r,g,b] -> (r<<16)+(g<<8)+b with
 * int32 coercion of each component. Anything else -> "Bad color".
 */
export function parseColor(v: unknown): number {
  if (v === 'transparent') return -1;
  if (typeof v === 'string') return parseInt('0x' + v);
  if (Array.isArray(v)) return ((v[0] | 0) << 16) + ((v[1] | 0) << 8) + (v[2] | 0);
  throw new HbsParseError('Bad color');
}

/** off `w.tg`: copy trait keys the object does not define (== null). */
function applyTrait(obj: Json, traits: Json): void {
  if (obj.trait != null) {
    const t = traits[str(obj.trait) as string];
    if (t != null) {
      for (const k in t) {
        if (k !== '__id__' && k !== 'hx__closures__' && Object.prototype.hasOwnProperty.call(t, k) && obj[k] == null) {
          obj[k] = t[k];
        }
      }
    }
  }
}

function parseVertex(o: Json): Vertex {
  const v = new Vertex();
  v.x = num(o.x);
  v.y = num(o.y);
  if (o.bCoef != null) v.bCoef = num(o.bCoef);
  if (o.cMask != null) v.cMask = parseCollisionFlags(o.cMask);
  if (o.cGroup != null) v.cGroup = parseCollisionFlags(o.cGroup);
  return v;
}

function parseSegment(o: Json, vertexes: Vertex[]): Segment {
  const i1 = int(o.v1);
  const i0 = int(o.v0);
  // Out-of-range indices give `undefined` vertices; the official code only
  // fails later (derived geometry), outside the per-item error wrapper.
  const s = new Segment(vertexes[i0 as number] as Vertex, vertexes[i1 as number] as Vertex);
  if (o.bias != null) s.bias = num(o.bias);
  if (o.bCoef != null) s.bCoef = num(o.bCoef);
  if (o.curveF != null) s.curveF = num(o.curveF);
  else if (o.curve != null) applySegmentCurve(s, num(o.curve));
  if (o.vis != null) s.vis = bool(o.vis);
  if (o.cMask != null) s.cMask = parseCollisionFlags(o.cMask);
  if (o.cGroup != null) s.cGroup = parseCollisionFlags(o.cGroup);
  if (o.color != null) s.color = parseColor(o.color);
  return s;
}

function parseGoal(o: Json): Goal {
  const g = new Goal();
  const p0 = arr(o.p0) as Json[];
  const p1 = arr(o.p1) as Json[];
  g.p0x = rawNum(p0[0]);
  g.p0y = rawNum(p0[1]);
  g.p1x = rawNum(p1[0]);
  g.p1y = rawNum(p1[1]);
  switch (o.team) {
    case 'blue': g.team = 2; break;
    case 'red': g.team = 1; break;
    default: throw new HbsParseError('Bad team value');
  }
  return g;
}

/** off `w.ef(obj, disc)`: applies the .hbs disc properties onto `d`. */
function applyDiscProps(o: Json, d: Disc): Disc {
  const pos = o.pos;
  const speed = o.speed;
  const gravity = o.gravity;
  if (pos != null) {
    d.x = rawNum(pos[0]);
    d.y = rawNum(pos[1]);
  }
  if (speed != null) {
    d.xspeed = rawNum(speed[0]);
    d.yspeed = rawNum(speed[1]);
  }
  if (gravity != null) {
    d.xgravity = rawNum(gravity[0]);
    d.ygravity = rawNum(gravity[1]);
  }
  if (o.radius != null) d.radius = num(o.radius);
  if (o.bCoef != null) d.bCoef = num(o.bCoef);
  if (o.invMass != null) d.invMass = num(o.invMass);
  if (o.damping != null) d.damping = num(o.damping);
  if (o.color != null) d.color = parseColor(o.color);
  if (o.cMask != null) d.cMask = parseCollisionFlags(o.cMask);
  if (o.cGroup != null) d.cGroup = parseCollisionFlags(o.cGroup);
  return d;
}

function parsePlane(o: Json): Plane {
  const p = new Plane();
  const n = arr(o.normal) as Json[];
  let x = num(n[0]);
  let y = num(n[1]);
  if (n[1] == null) y = 0;
  if (n[0] == null) x = 0;
  const len = Math.sqrt(x * x + y * y);
  p.normalX = x / len;
  p.normalY = y / len;
  p.dist = num(o.dist);
  if (o.bCoef != null) p.bCoef = num(o.bCoef);
  if (o.cMask != null) p.cMask = parseCollisionFlags(o.cMask);
  if (o.cGroup != null) p.cGroup = parseCollisionFlags(o.cGroup);
  return p;
}

function parseJoint(o: Json, discs: Disc[]): Joint {
  const j = new Joint();
  const d0 = int(o.d0);
  const d1 = int(o.d1);
  const color = o.color;
  const strength = o.strength;
  const length = o.length;
  // Same (loose) range test as the official code: null/undefined pass.
  if ((d0 as number) >= discs.length || 0 > (d0 as number)) throw new HbsParseError('null');
  if ((d1 as number) >= discs.length || 0 > (d1 as number)) throw new HbsParseError('null');
  // A missing index travels as u8 0 (what every client decodes).
  j.d0 = d0 == null ? 0 : d0;
  j.d1 = d1 == null ? 0 : d1;
  if (length == null) {
    const a = d0 == null ? undefined : discs[d0];
    const b = d1 == null ? undefined : discs[d1];
    if (a == null || b == null) {
      j.minLength = j.maxLength = 100;
    } else {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      j.minLength = j.maxLength = Math.sqrt(dx * dx + dy * dy);
    }
  } else if (Array.isArray(length)) {
    j.minLength = num(length[0]);
    j.maxLength = num(length[1]);
  } else {
    j.minLength = j.maxLength = num(length);
  }
  // eslint-disable-next-line eqeqeq
  j.strength = strength == null || strength == 'rigid' ? Infinity : num(strength);
  if (color != null) j.color = parseColor(color);
  return j;
}

function parsePlayerPhysics(o: Json): PlayerPhysics {
  const p = new PlayerPhysics();
  if (o.bCoef != null) p.bCoef = num(o.bCoef);
  if (o.invMass != null) p.invMass = num(o.invMass);
  if (o.damping != null) p.damping = num(o.damping);
  if (o.acceleration != null) p.acceleration = num(o.acceleration);
  if (o.kickingAcceleration != null) p.kickingAcceleration = num(o.kickingAcceleration);
  if (o.kickingDamping != null) p.kickingDamping = num(o.kickingDamping);
  if (o.kickStrength != null) p.kickStrength = num(o.kickStrength);
  const g = o.gravity;
  if (g != null) {
    const gy = num(g[1]);
    p.gravityX = num(g[0]);
    p.gravityY = gy;
  }
  if (o.cGroup != null) p.cGroup = parseCollisionFlags(o.cGroup);
  if (o.radius != null) p.radius = num(o.radius);
  if (o.kickback != null) p.kickback = num(o.kickback);
  return p;
}

function parseSpawnPoint(o: Json): Point {
  let x = num(o[0]);
  let y = num(o[1]);
  if (o[1] == null) y = 0;
  if (o[0] == null) x = 0;
  return { x, y };
}

/**
 * Parses `.hbs` text into a custom Stadium (`defaultStadiumId = 255`), with
 * derived segment geometry computed. Throws HbsParseError (or a JSON5
 * SyntaxError) on invalid input, in the same situations as the official
 * parser.
 */
export function parseHbs(text: string): Stadium {
  const root: Json = parseJson5(text);
  const s = new Stadium();
  s.defaultStadiumId = 255;
  s.name = str(root.name) ?? null;
  s.width = num(root.width);
  s.height = num(root.height);
  s.maxViewWidth = numOr0(root, 'maxViewWidth') | 0;
  s.cameraFollow = root.cameraFollow === 'player' ? 1 : 0;
  s.spawnDistance = 200;
  if (root.spawnDistance != null) s.spawnDistance = num(root.spawnDistance);
  const bg: Json = root.bg;
  if (bg == null) throw new HbsParseError(`Cannot read properties of ${bg} (reading 'type')`);
  s.bgType = bg.type === 'grass' ? 1 : bg.type === 'hockey' ? 2 : 0;
  s.bgWidth = numOr0(bg, 'width');
  s.bgHeight = numOr0(bg, 'height');
  s.bgKickOffRadius = numOr0(bg, 'kickOffRadius');
  s.bgCornerRadius = numOr0(bg, 'cornerRadius');
  s.bgColor = 7441498;
  if (bg.color != null) s.bgColor = parseColor(bg.color);
  s.bgGoalLine = numOr0(bg, 'goalLine');
  s.canBeStored = root.canBeStored != null ? bool(root.canBeStored) : true;
  s.fullKickOffReset = root.kickOffReset === 'full';

  const traits: Json = root.traits;
  const ball = root.ballPhysics;
  if (ball !== 'disc0') {
    if (ball != null) {
      const d = applyDiscProps(ball, createDefaultBall());
      d.cGroup |= 192;
      s.discs.push(d);
    } else {
      s.discs.push(createDefaultBall());
    }
  }

  const each = <T>(target: T[], key: string, make: (o: Json) => T): void => {
    const list = arr(root[key]);
    if (list == null) return;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      try {
        applyTrait(item, traits);
        target.push(make(item));
      } catch (e) {
        throw new HbsParseError(`Error in "${key}" index: ${target.length}`, { cause: e });
      }
    }
  };
  each(s.vertexes, 'vertexes', parseVertex);
  each(s.segments, 'segments', (o) => parseSegment(o, s.vertexes));
  each(s.goals, 'goals', parseGoal);
  each(s.discs, 'discs', (o) => applyDiscProps(o, new Disc()));
  each(s.planes, 'planes', parsePlane);
  each(s.joints, 'joints', (o) => parseJoint(o, s.discs));
  each(s.redSpawnPoints, 'redSpawnPoints', parseSpawnPoint);
  each(s.blueSpawnPoints, 'blueSpawnPoints', parseSpawnPoint);
  if (root.playerPhysics != null) s.playerPhysics = parsePlayerPhysics(root.playerPhysics);

  if (
    255 < s.vertexes.length ||
    255 < s.segments.length ||
    255 < s.planes.length ||
    255 < s.goals.length ||
    255 < s.discs.length
  ) {
    throw new HbsParseError('Error');
  }
  for (let i = 0; i < s.segments.length; i++) {
    const g = s.segments[i]!;
    if (g.v0 === undefined || g.v1 === undefined) throw new HbsParseError(`Invalid stadium: segment ${i} references a missing vertex`);
  }
  for (let i = 0; i < s.vertexes.length; i++) s.vertexes[i]!.index = i;
  prepareStadium(s);
  if (!isValidStadium(s)) throw new HbsParseError('Invalid stadium');
  return s;
}
