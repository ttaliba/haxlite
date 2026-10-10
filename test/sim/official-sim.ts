/**
 * TEST-ONLY access to the official headless physics/stadium classes, built on
 * test/oracle/official.ts. The captured internals expose the Stadium class
 * (`w`) and the RoomState (`Ta`); the World (`Oa`) and live disc (`Ba`)
 * constructors are reached through a started game's instances.
 *
 * Minified names (official f066733d): Stadium `w` (`kh` parse, `G` write,
 * `Fd()` defaults, `Ed` default id, `A` discs, `v` vertexes, `Y` planes,
 * `J` segments, `Ta` joints); World `Oa` (`A` discs, `Da(dt)` step); Disc
 * `Ba`/`X` (`a` pos, `u` speed, `ma` gravity, `M` radius, `i` bCoef, `L`
 * invMass, `ga` damping, `T` color, `c` cMask, `o` cGroup; `th()` clone).
 */
import { OfficialRoom, officialInternals } from '../oracle/official.js';
import { encodeEvent } from '../oracle/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

function writerBytes(fn: (w: Any) => void): Uint8Array {
  const x = officialInternals();
  const w = x.A.aa();
  fn(w);
  return Uint8Array.from(w.Db() as Uint8Array);
}

/** Official parse (`new w().kh(text)`). Throws like the official parser. */
export function officialParseHbs(text: string): Any {
  const x = officialInternals();
  const s = new x.w();
  s.kh(text);
  return s;
}

/** Official binary stadium (`w.G`) of an official Stadium object, optionally forcing the 255 form. */
export function officialStadiumBytes(s: Any, forceCustom = false): Uint8Array {
  const saved = s.Ed;
  if (forceCustom) s.Ed = 255;
  try {
    return writerBytes((w) => s.G(w));
  } finally {
    s.Ed = saved;
  }
}

/** Official built-in stadium objects (`w.Fd()`). */
export function officialDefaults(): Any[] {
  return officialInternals().w.Fd();
}

/** Official static reader (`w.qa(reader)`). */
export function officialReadStadium(bytes: Uint8Array): Any {
  const x = officialInternals();
  const r = new x.L(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), false);
  return x.w.qa(r);
}

let ctors: { World: Any; Disc: Any } | null = null;

/** Constructors of the official World (`Oa`) and live disc (`Ba`). */
export function officialPhysicsCtors(): { World: Any; Disc: Any } {
  if (ctors) return ctors;
  const room = new OfficialRoom();
  room.applyEventBytes(encodeEvent('startGame'), 0);
  const gs = room.state.D;
  if (!gs) throw new Error('official game did not start');
  const world = gs.ia;
  ctors = { World: world.constructor, Disc: world.A[0].constructor };
  return ctors;
}

/** Official world for an official stadium: geometry by reference + cloned discs (like `Q.eh`). */
export function officialWorld(stadium: Any): Any {
  const { World } = officialPhysicsCtors();
  const world = new World();
  world.v = stadium.v;
  world.Y = stadium.Y;
  world.J = stadium.J;
  world.Ta = stadium.Ta;
  for (const d of stadium.A) world.A.push(d.th());
  return world;
}

/** New official live disc (`new Ba()`). */
export function officialDisc(): Any {
  return new (officialPhysicsCtors().Disc)();
}
