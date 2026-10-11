/**
 * src/sim — physics engine, stadiums, World (OWNER: engineer A).
 *
 * Public contract (pure functions over the shared model in ./types.ts):
 *   stepWorld(world, dt)            official `Oa.Da(dt)`; dt = 1 in the authoritative sim
 *   createWorld(stadium)            physics half of `Q.eh`: geometry by reference + cloned stadium discs
 *   attachStadium(world, stadium)   (re)point world geometry at a stadium (after readWorld)
 *   copyDiscProps(dst, src)         `X.$e` (kick-off reset of stadium discs)
 *   cloneDisc(src)                  `X.th`
 *   goalCrossed(st, cx, cy, px, py) `w.Ag(cur, prev)` -> owner team id of the goal crossed, or 0
 *   writeStadium(w, s)/readStadium(r)  `w.G` / static `w.qa` (u8 id; body only when 255)
 *   writeStadiumBody/readStadiumBody   the 255-form body alone
 *   writeDisc/readDisc              92-byte disc layout (color as u32)
 *   writeWorld/readWorld            `u8 n` + discs (writeWorld assigns disc.index)
 *   parseHbs(text)                  `w.kh` (JSON5 .hbs)
 *   defaultStadiums()               `w.Fd()` (index = defaultStadiumId; shared, do not mutate)
 *   defaultStadium(id)              one shared built-in stadium (built lazily, same instance)
 *   buildDefaultStadium(id)         a private copy of built-in stadium `id`
 * See src/sim/README.md.
 */
export * from './types.js';
export { stepWorld, stepWorldReference, invalidateGeometryCache, createWorld, attachStadium, copyDiscProps, cloneDisc, goalCrossed } from './physics.js';
export { collideDiscs, collideDiscPlane, collideDiscSegment, collideDiscVertex, solveJoint } from './physics.js';
export {
  writeStadium,
  readStadium,
  writeStadiumBody,
  readStadiumBody,
  writeDisc,
  readDisc,
  writeWorld,
  readWorld,
  InvalidStadiumError,
} from './binary.js';
export { parseHbs, parseColor, parseCollisionFlags, HbsParseError } from './hbs.js';
export { defaultStadiums, defaultStadium, buildDefaultStadium, createDefaultBall, DEFAULT_STADIUM_COUNT } from './defaults.js';
export {
  applySegmentCurve,
  computeSegmentGeometry,
  prepareStadium,
  isValidStadium,
  CURVE_MIN_RAD,
  CURVE_MAX_RAD,
} from './geometry.js';
