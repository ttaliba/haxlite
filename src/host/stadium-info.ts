/**
 * Plain-data view of a {@link Stadium} for `getStadium()`: readable names
 * (`.hbs` style), copies instead of live model objects, JSON-safe (no
 * Infinity: a straight segment has `curve` 0 and a rigid joint `'rigid'`).
 */
import type { Stadium } from '../sim/index.js';

export interface StadiumDisc {
  x: number;
  y: number;
  xspeed: number;
  yspeed: number;
  xgravity: number;
  ygravity: number;
  radius: number;
  bCoeff: number;
  invMass: number;
  damping: number;
  color: number;
  cMask: number;
  cGroup: number;
}

/** A whole stadium as data. Collision masks are the raw numeric bitmasks (`CollisionFlags`). */
export interface StadiumObject {
  name: string | null;
  /** 0..9 for a built-in stadium, null for a custom one. */
  builtInId: number | null;
  /** Camera half-width / half-height. */
  width: number;
  height: number;
  spawnDistance: number;
  maxViewWidth: number;
  cameraFollow: 'ball' | 'player';
  canBeStored: boolean;
  fullKickOffReset: boolean;
  bg: {
    type: 'none' | 'grass' | 'hockey';
    width: number;
    height: number;
    kickOffRadius: number;
    cornerRadius: number;
    goalLine: number;
    color: number;
  };
  playerPhysics: {
    bCoeff: number;
    invMass: number;
    damping: number;
    acceleration: number;
    kickingAcceleration: number;
    kickingDamping: number;
    kickStrength: number;
    gravity: [number, number];
    cGroup: number;
    radius: number;
    kickback: number;
  };
  vertexes: { x: number; y: number; bCoeff: number; cMask: number; cGroup: number }[];
  /** `v0` / `v1` are indices into `vertexes`; `curve` in degrees (0 = straight). */
  segments: { v0: number; v1: number; curve: number; bias: number; color: number; vis: boolean; bCoeff: number; cMask: number; cGroup: number }[];
  planes: { normal: [number, number]; dist: number; bCoeff: number; cMask: number; cGroup: number }[];
  /** `team` is the team that defends the goal (1 red, 2 blue). */
  goals: { p0: [number, number]; p1: [number, number]; team: 1 | 2 }[];
  /** Disc 0 is the ball (unless the stadium says otherwise). */
  discs: StadiumDisc[];
  /** `d0` / `d1` index `discs`. */
  joints: { d0: number; d1: number; minLength: number; maxLength: number; strength: number | 'rigid'; color: number }[];
  redSpawnPoints: [number, number][];
  blueSpawnPoints: [number, number][];
}

const BG_TYPES = ['none', 'grass', 'hockey'] as const;

/** JSON-safe number: NaN / Infinity (fields a built-in stadium leaves unset) become 0, and -0 becomes 0. */
const num = (v: number): number => (Number.isFinite(v) ? v + 0 : 0);

export function stadiumObject(st: Stadium): StadiumObject {
  const pp = st.playerPhysics;
  return {
    name: st.name,
    builtInId: st.defaultStadiumId === 255 ? null : st.defaultStadiumId,
    width: st.width,
    height: st.height,
    spawnDistance: st.spawnDistance,
    maxViewWidth: st.maxViewWidth,
    cameraFollow: st.cameraFollow === 1 ? 'player' : 'ball',
    canBeStored: st.canBeStored,
    fullKickOffReset: st.fullKickOffReset,
    bg: {
      type: BG_TYPES[st.bgType] ?? 'none',
      width: num(st.bgWidth),
      height: num(st.bgHeight),
      kickOffRadius: num(st.bgKickOffRadius),
      cornerRadius: num(st.bgCornerRadius),
      goalLine: num(st.bgGoalLine),
      color: st.bgColor,
    },
    playerPhysics: {
      bCoeff: pp.bCoef,
      invMass: pp.invMass,
      damping: pp.damping,
      acceleration: pp.acceleration,
      kickingAcceleration: pp.kickingAcceleration,
      kickingDamping: pp.kickingDamping,
      kickStrength: pp.kickStrength,
      gravity: [pp.gravityX, pp.gravityY],
      cGroup: pp.cGroup,
      radius: pp.radius,
      kickback: pp.kickback,
    },
    vertexes: st.vertexes.map((v) => ({ x: v.x, y: v.y, bCoeff: v.bCoef, cMask: v.cMask, cGroup: v.cGroup })),
    segments: st.segments.map((s) => ({
      v0: s.v0.index,
      v1: s.v1.index,
      // curveF = 1 / tan(curve / 2)
      curve: num(Number.isFinite(s.curveF) ? (2 * Math.atan(1 / s.curveF) * 180) / Math.PI : 0),
      bias: num(s.bias),
      color: s.color,
      vis: s.vis,
      bCoeff: s.bCoef,
      cMask: s.cMask,
      cGroup: s.cGroup,
    })),
    planes: st.planes.map((p) => ({ normal: [p.normalX, p.normalY], dist: p.dist, bCoeff: p.bCoef, cMask: p.cMask, cGroup: p.cGroup })),
    goals: st.goals.map((g) => ({ p0: [g.p0x, g.p0y], p1: [g.p1x, g.p1y], team: g.team === 2 ? 2 : 1 })),
    discs: st.discs.map((d) => ({
      x: d.x,
      y: d.y,
      xspeed: d.xspeed,
      yspeed: d.yspeed,
      xgravity: d.xgravity,
      ygravity: d.ygravity,
      radius: d.radius,
      bCoeff: d.bCoef,
      invMass: d.invMass,
      damping: d.damping,
      color: d.color,
      cMask: d.cMask,
      cGroup: d.cGroup,
    })),
    joints: st.joints.map((j) => ({
      d0: j.d0,
      d1: j.d1,
      minLength: j.minLength,
      maxLength: j.maxLength,
      strength: Number.isFinite(j.strength) ? j.strength : 'rigid',
      color: j.color,
    })),
    redSpawnPoints: st.redSpawnPoints.map((p) => [p.x, p.y]),
    blueSpawnPoints: st.blueSpawnPoints.map((p) => [p.x, p.y]),
  };
}
