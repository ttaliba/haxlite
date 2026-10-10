/**
 * Shared model contract — physics / stadium side (owner of behaviour: engineer A).
 *
 * Field ORDER in every class below is the official binary serialization order,
 * so the serializer is a straight top-to-bottom walk. Each field documents:
 *   `off:`  official headless minified name (hash f066733d; names change per build)
 *   `nh:`   node-haxball public name (index.d.ts) / minified name in api.js
 *   `bin:`  wire type (big-endian) — `-` if not serialized.
 *
 * Representation choices (performance, see docs/06):
 *  - Flat numeric fields (`x`, `y`, `xspeed`...) instead of nested Point
 *    objects: one less pointer chase per access in the physics loop and the
 *    names match HBInit's DiscPropertiesObject. The official code nests
 *    `{x,y}` objects; that does not change any arithmetic.
 *  - Every field is initialised in the constructor in a fixed order so V8
 *    keeps one hidden class per type (monomorphic hot loops). Never add
 *    properties after construction; never `delete`.
 *  - Numbers are IEEE-754 doubles exactly like the official JS. Do not
 *    introduce Math.fround / typed-array float32 storage anywhere in the sim.
 *    The ONLY float32 rounding in the official game logic is in
 *    SetDiscProperties (event 23): the values are quantised to float32 before
 *    being applied (`Float32Array(1)` round trip on the host, `getFloat32` on
 *    receivers), so the stored doubles are float32-representable. Engineer B
 *    must reproduce that in the event, not here.
 */

/** Plain 2D point (only for non-hot data such as spawn points). */
export interface Point {
  x: number;
  y: number;
}

/**
 * Disc. Used both for stadium template discs (official class `X`, nh `Disc`/`FM`)
 * and live world discs (official `Ba`, nh `MovableDisc`). Same 92-byte layout.
 */
export class Disc {
  /** off `a.x` · nh `pos.x` / `h.x` · bin f64 */
  x = 0;
  /** off `a.y` · nh `pos.y` / `h.y` · bin f64 */
  y = 0;
  /** off `u.x` · nh `speed.x` / `A.x` · bin f64 */
  xspeed = 0;
  /** off `u.y` · nh `speed.y` / `A.y` · bin f64 */
  yspeed = 0;
  /** off `ma.x` · nh `gravity.x` / `_.x` · bin f64 */
  xgravity = 0;
  /** off `ma.y` · nh `gravity.y` / `_.y` · bin f64 */
  ygravity = 0;
  /** off `M` · nh `radius` / `z` · bin f64. Default 10. */
  radius = 10;
  /** off `i` · nh `bCoef` / `P` · bin f64. Default 0.5. */
  bCoef = 0.5;
  /** off `L` · nh `invMass` / `b` · bin f64. Default 1. 0 = immovable (skips static geometry). */
  invMass = 1;
  /** off `ga` · nh `damping` / `m` · bin f64. Default 0.99. */
  damping = 0.99;
  /**
   * off `T` · nh `color` / `N` · bin **u32** (written with setUint32, read
   * with getUint32: a -1 ("transparent") becomes 4294967295 after a round
   * trip; both serialize to the same bytes). Default 0xFFFFFF.
   */
  color = 0xffffff;
  /** off `c` · nh `cMask` / `k` · bin i32. Default 63. */
  cMask = 63;
  /** off `o` · nh `cGroup` / `f` · bin i32. Default 63 (ball template: 193). */
  cGroup = 63;

  /**
   * Index of this disc in `World.discs`. off `sf` · nh `fh` · bin - .
   * The official World serializer assigns it while writing the discs; the
   * Player serializer then writes `player.disc.index` (i16). Keep it in sync
   * whenever the discs array changes (or recompute on serialize like official).
   */
  index = 0;
}

/** Stadium vertex. off `C` · nh `Vertex`/`aM`. */
export class Vertex {
  /** off `a.x` · nh `pos.x` · bin f64 */
  x = 0;
  /** off `a.y` · nh `pos.y` · bin f64 */
  y = 0;
  /** off `i` · nh `bCoef` / `P` · bin f64. Default 1. */
  bCoef = 1;
  /** off `c` · nh `cMask` / `k` · bin i32. Default 63. */
  cMask = 63;
  /** off `o` · nh `cGroup` / `f` · bin i32. Default 32 (wall). */
  cGroup = 32;
  /**
   * Position in `Stadium.vertexes`. off `Lc` · nh `M` · bin - (assigned by the
   * stadium serializer/parser; segments serialize `v0.index`/`v1.index` as u8).
   */
  index = 0;
}

/**
 * Stadium segment. off `E` · nh `Segment`/`$M`.
 * Wire layout: `u8 flags` (bit0 bias!=0, bit1 curveF!=+Infinity, bit2 color!=0,
 * bit3 vis), `u8 v0.index`, `u8 v1.index`, [f64 bias], [f64 curveF],
 * [i32 color], f64 bCoef, i32 cMask, i32 cGroup. The flags byte is written as
 * a placeholder first and patched (Writer.setU8At).
 */
export class Segment {
  /** off `F` · nh `v0` / `F` · bin u8 (vertex index) */
  v0: Vertex;
  /** off `K` · nh `v1` / `MM` · bin u8 (vertex index) */
  v1: Vertex;
  /** off `wb` · nh `bias` / `yM` · bin f64 if flags&1 (else 0). */
  bias = 0;
  /**
   * off `Ia` · nh `curveF` / `zM` · bin f64 if flags&2 (else +Infinity).
   * = 1/tan(curve/2) (NOT radians). +Infinity = straight. The official
   * "is curved" test is `0 == 0 * curveF` (i.e. finite), while the serializer
   * flag test is `curveF != Infinity`.
   */
  curveF = Infinity;
  /** off `T` · nh `color` / `N` · bin i32 if flags&4 (else 0). */
  color = 0;
  /** off `va` · nh `vis` / `JM` · bin flags&8. Default true. */
  vis = true;
  /** off `i` · nh `bCoef` / `P` · bin f64. Default 1. */
  bCoef = 1;
  /** off `c` · nh `cMask` / `k` · bin i32. Default 63. */
  cMask = 63;
  /** off `o` · nh `cGroup` / `f` · bin i32. Default 32. */
  cGroup = 32;

  // ---- derived geometry (official `Pb()`, nh `CE()`), never serialized ----
  /** Straight only: unit normal. off `X` · nh `eM`. NaN when curved. */
  normalX = NaN;
  normalY = NaN;
  /** Curved only: arc centre. off `fc` · nh `KI`. NaN when straight. */
  arcCenterX = NaN;
  arcCenterY = NaN;
  /** Curved only: arc radius. off `Pe` · nh `H5`. */
  arcRadius = 0;
  /** Curved only: tangent-side normals at v0 / v1. off `kd` / `ld` · nh `Na` / `Ja`. */
  v0NormalX = NaN;
  v0NormalY = NaN;
  v1NormalX = NaN;
  v1NormalY = NaN;

  constructor(v0: Vertex, v1: Vertex) {
    this.v0 = v0;
    this.v1 = v1;
  }
}

/** Infinite plane `normal·p = dist`. off `K` · nh `Plane`/`NM`. */
export class Plane {
  /** off `X.x` · nh `normal.x` / `eM.x` · bin f64 (normalised at parse time) */
  normalX = 0;
  /** off `X.y` · nh `normal.y` / `eM.y` · bin f64 */
  normalY = 0;
  /** off `la` · nh `dist` / `aM` · bin f64 */
  dist = 0;
  /** off `i` · nh `bCoef` / `P` · bin f64. Default 1. */
  bCoef = 1;
  /** off `c` · nh `cMask` / `k` · bin i32. Default 63. */
  cMask = 63;
  /** off `o` · nh `cGroup` / `f` · bin i32. Default 32. */
  cGroup = 32;
}

/** Goal line (no physics). off `xa` · nh `Goal`/`tE`. */
export class Goal {
  /** off `F.x` · nh `p0[0]` / `$E.x` · bin f64 */
  p0x = 0;
  /** off `F.y` · nh `p0[1]` · bin f64 */
  p0y = 0;
  /** off `K.x` · nh `p1[0]` / `UE.x` · bin f64 */
  p1x = 0;
  /** off `K.y` · nh `p1[1]` · bin f64 */
  p1y = 0;
  /**
   * Team that OWNS (defends) this goal: 1 red, 2 blue. off `sc` (Team) · nh
   * `team` / `K` · bin i8 (written as u8, read as int8; unknown -> spectators).
   */
  team = 0;
}

/** Joint between two discs. off `Ha` · nh `Joint`/`lE`. */
export class Joint {
  /** off `Jc` · nh `d0` / `VM` · bin u8 (index into World.discs) */
  d0 = 0;
  /** off `Kc` · nh `d1` / `xM` · bin u8 */
  d1 = 0;
  /** off `La` · nh `minLength` / `sM` · bin f64. Default 100. */
  minLength = 100;
  /** off `Va` · nh `maxLength` / `_M` · bin f64. Default 100. */
  maxLength = 100;
  /** off `rc` · nh `strength` / `YE` · bin f64. +Infinity = rigid (default). */
  strength = Infinity;
  /** off `T` · nh `color` / `N` · bin i32. Default 0. */
  color = 0;
}

/** Player disc physics parameters. off `Qa` · nh `PlayerPhysics`/`jG`. */
export class PlayerPhysics {
  /** off `i` · nh `bCoef` / `P` · bin f64. Default 0.5. */
  bCoef = 0.5;
  /** off `L` · nh `invMass` / `b` · bin f64. Default 0.5. */
  invMass = 0.5;
  /** off `ga` · nh `damping` / `m` · bin f64. Default 0.96. */
  damping = 0.96;
  /** off `Ac` · nh `acceleration` / `VW` · bin f64. Default 0.1. */
  acceleration = 0.1;
  /** off `Pc` · nh `kickingAcceleration` / `xW` · bin f64. Default 0.07. */
  kickingAcceleration = 0.07;
  /** off `Qc` · nh `kickingDamping` / `FW` · bin f64. Default 0.96. */
  kickingDamping = 0.96;
  /** off `Nc` · nh `kickStrength` / `pW` · bin f64. Default 5. */
  kickStrength = 5;
  /** off `ma.x` · nh `gravity.x` / `_.x` · bin f64 */
  gravityX = 0;
  /** off `ma.y` · nh `gravity.y` / `_.y` · bin f64 */
  gravityY = 0;
  /** off `o` · nh `cGroup` / `f` · bin i32. Default 0 (OR-ed with team cGroup). */
  cGroup = 0;
  /** off `M` · nh `radius` / `z` · bin f64. Default 15. */
  radius = 15;
  /** off `Oc` · nh `kickback` / `uW` · bin f64. Default 0. */
  kickback = 0;
}

/** Background type as serialized (i32). */
export const BgType = { None: 0, Grass: 1, Hockey: 2 } as const;

/**
 * Stadium. off `w` · nh `Stadium` (`_` in api.js).
 * Wire: `u8 defaultStadiumId`; if != 255 nothing else follows (each peer
 * rebuilds default stadium #id locally). If 255, the fields below follow in
 * this exact order. `traits` from .hbs are applied at parse time and never
 * serialized.
 */
export class Stadium {
  /** off `Ed` · nh `defaultStadiumId` / `JI` · bin u8. 255 = custom; 0..9 = built-in. */
  defaultStadiumId = 255;
  /** off `pa` · nh `name` / `U` · bin nullableString */
  name: string | null = '';
  /** off `Fc` · nh `bgType` / `nE` · bin i32 (0 none, 1 grass, 2 hockey) */
  bgType = 0;
  /** off `Gc` · nh `bgWidth` / `NW` · bin f64 */
  bgWidth = 0;
  /** off `Ec` · nh `bgHeight` / `JW` · bin f64 */
  bgHeight = 0;
  /** off `cc` · nh `bgKickOffRadius` / `DW` · bin f64 */
  bgKickOffRadius = 0;
  /** off `bc` · nh `bgCornerRadius` / `jW` · bin f64 */
  bgCornerRadius = 0;
  /** off `yd` · nh `bgGoalLine` / `BW` · bin f64 */
  bgGoalLine = 0;
  /** off `Dc` · nh `bgColor` / `oW` · bin i32. .hbs default 0x718C5A. */
  bgColor = 0x718c5a;
  /** off `dc` · nh `width` / `EW` · bin f64 (camera half-width; also mid-game join x) */
  width = 0;
  /** off `Hc` · nh `height` / `lW` · bin f64 */
  height = 0;
  /** off `Ma` · nh `spawnDistance` / `kE` · bin f64. .hbs default 200. */
  spawnDistance = 200;
  /** off `Ob` · nh `playerPhysics` / `MW` · bin PlayerPhysics */
  playerPhysics = new PlayerPhysics();
  /** off `Pd` · nh `maxViewWidth` / `MG` · bin u16 */
  maxViewWidth = 0;
  /** off `Ad` · nh `cameraFollow` / `EG` · bin u8 (1 = "player") */
  cameraFollow = 0;
  /** off `Bd` · nh `canBeStored` / `YG` · bin u8 bool. Default true. */
  canBeStored = true;
  /** off `ed` · nh `fullKickOffReset` / `OW` · bin u8 bool. Default false. */
  fullKickOffReset = false;
  /** off `v` · nh `vertices` / `w` · bin u8 n + n×Vertex */
  vertexes: Vertex[] = [];
  /** off `J` · nh `segments` / `O` · bin u8 n + n×Segment */
  segments: Segment[] = [];
  /** off `Y` · nh `planes` / `L` · bin u8 n + n×Plane */
  planes: Plane[] = [];
  /** off `Sa` · nh `goals` / `OM` · bin u8 n + n×Goal */
  goals: Goal[] = [];
  /** off `A` · nh `discs` / `D` · bin u8 n + n×Disc (disc 0 is the ball unless ballPhysics:"disc0") */
  discs: Disc[] = [];
  /** off `Ta` · nh `joints` / `$M` · bin u8 n + n×Joint */
  joints: Joint[] = [];
  /** off `Rb` · nh `redSpawnPoints` / `aE` · bin u8 n + n×(f64 x, f64 y) */
  redSpawnPoints: Point[] = [];
  /** off `Lb` · nh `blueSpawnPoints` / `IE` · bin u8 n + n×(f64 x, f64 y) */
  blueSpawnPoints: Point[] = [];
}

/**
 * Physics world of a running game. off `Oa` · nh `physicsState` (`q` in GameState).
 * Wire (inside GameState): `u8 n` + n × Disc — only the dynamic discs; the
 * static geometry below is shared by reference with the Stadium (official
 * `eh()` copies the array references, and clones the stadium discs).
 */
export class World {
  /** off `A` · nh `discs` / `D` · bin u8 n + n×Disc. Order: stadium discs (ball first), then player discs in creation order. */
  discs: Disc[] = [];
  /** off `v` · nh `vertices` · bin - (ref to stadium.vertexes) */
  vertexes: Vertex[] = [];
  /** off `Y` · nh `planes` · bin - (ref to stadium.planes) */
  planes: Plane[] = [];
  /** off `J` · nh `segments` · bin - (ref to stadium.segments) */
  segments: Segment[] = [];
  /** off `Ta` · nh `joints` · bin - (ref to stadium.joints) */
  joints: Joint[] = [];
}
