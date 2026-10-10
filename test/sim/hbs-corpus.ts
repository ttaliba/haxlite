/**
 * .hbs corpus for the parser / physics differential tests.
 *  - HAND: hand-written stadiums covering every feature and the odd corners
 *    of the official parser (casts, nulls, traits, colours, curves...).
 *  - randomHbs(seed): random but valid stadiums (all features mixed).
 *  - BAD: inputs the official parser rejects.
 */
import { prng } from '../oracle/index.js';

export interface HbsCase {
  name: string;
  hbs: string;
}

/** The arena used by test/oracle/cross-oracle.test.ts (curves, bias, joints, gravity, spawn points, full reset). */
export const ARENA_HBS = `{
  "name": "haxlite test arena",
  "width": 300, "height": 160, "spawnDistance": 120, "kickOffReset": "full",
  "bg": { "type": "grass", "width": 260, "height": 130, "kickOffRadius": 60, "cornerRadius": 20 },
  "traits": { "wall": { "vis": true, "bCoef": 0.8, "cMask": ["ball", "red", "blue"] } },
  "vertexes": [
    { "x": -260, "y": -130, "trait": "wall" }, { "x": 260, "y": -130, "trait": "wall" },
    { "x": 260, "y": 130, "trait": "wall" }, { "x": -260, "y": 130, "trait": "wall" },
    { "x": -260, "y": -40 }, { "x": -260, "y": 40 }, { "x": 260, "y": -40 }, { "x": 260, "y": 40 }
  ],
  "segments": [
    { "v0": 0, "v1": 1, "trait": "wall", "curve": 20 },
    { "v0": 2, "v1": 3, "trait": "wall", "curve": -30, "bias": 10 },
    { "v0": 0, "v1": 4, "trait": "wall" }, { "v0": 5, "v1": 3, "trait": "wall" },
    { "v0": 1, "v1": 6, "trait": "wall", "curveF": 0.5 }, { "v0": 7, "v1": 2, "trait": "wall", "bias": -5 }
  ],
  "goals": [ { "p0": [-260, -40], "p1": [-260, 40], "team": "red" }, { "p0": [260, -40], "p1": [260, 40], "team": "blue" } ],
  "planes": [ { "normal": [0, 1], "dist": -160 }, { "normal": [0, -1], "dist": -160 }, { "normal": [1, 0], "dist": -300, "bCoef": 0.2 }, { "normal": [-1, 0], "dist": -300 } ],
  "discs": [
    { "pos": [0, 80], "radius": 6, "invMass": 2, "color": "FF00FF", "cGroup": ["ball", "kick"] },
    { "pos": [0, -80], "radius": 6, "invMass": 1, "gravity": [0, 0.01], "damping": 0.98 },
    { "pos": [-260, -40], "radius": 5, "invMass": 0 }, { "pos": [260, 40], "radius": 5, "invMass": 0 }
  ],
  "joints": [ { "d0": 1, "d1": 2, "length": [40, 90], "strength": 0.05 }, { "d0": 0, "d1": 1, "strength": "rigid" } ],
  "redSpawnPoints": [[-100, 0], [-100, 50]], "blueSpawnPoints": [[100, 0]],
  "playerPhysics": { "kickStrength": 6, "kickback": 1.5, "acceleration": 0.12, "radius": 14 },
  "ballPhysics": { "radius": 8, "bCoef": 0.6 }
}`;

export const HAND: HbsCase[] = [
  { name: 'arena', hbs: ARENA_HBS },
  { name: 'minimal', hbs: `{ name: "Min", width: 100, height: 80, bg: {} }` },
  {
    name: 'all-top-level',
    hbs: `{
      name: "Top ✓ 😀", width: 420.5, height: 200.25, maxViewWidth: 800.9, cameraFollow: "player",
      spawnDistance: 170, canBeStored: false, kickOffReset: "full",
      bg: { type: "hockey", width: 400, height: 180, kickOffRadius: 70, cornerRadius: 10, goalLine: 30, color: "123ABC" },
      playerPhysics: { bCoef: 0.4, invMass: 0.6, damping: 0.95, acceleration: 0.11, kickingAcceleration: 0.08,
        kickingDamping: 0.97, kickStrength: 4.5, gravity: [0.01, -0.02], cGroup: ["c0", "c3"], radius: 16, kickback: 2 },
      redSpawnPoints: [[-100, 0], [-100, -50.5], [null, 3], [4]], blueSpawnPoints: [[100, 0]],
    }`,
  },
  {
    name: 'curves',
    hbs: `{
      name: "Curves", width: 500, height: 300, bg: { type: "grass" },
      vertexes: [ {x:-200,y:-100}, {x:200,y:-100}, {x:200,y:100}, {x:-200,y:100}, {x:0,y:0}, {x:50,y:50} ],
      segments: [
        {v0:0,v1:1,curve:90}, {v0:1,v1:2,curve:-90}, {v0:2,v1:3,curve:180}, {v0:3,v1:0,curve:-180},
        {v0:0,v1:2,curve:5}, {v0:1,v1:3,curve:-5}, {v0:0,v1:4,curve:345}, {v0:4,v1:5,curve:-345},
        {v0:4,v1:1,curve:10}, {v0:4,v1:2,curve:340}, {v0:5,v1:0,curve:-400}, {v0:5,v1:1,curve:720},
        {v0:5,v1:2,curve:270}, {v0:5,v1:3,curve:-270}, {v0:2,v1:4,curve:30,bias:5}, {v0:3,v1:4,curve:-30,bias:-7},
        {v0:0,v1:5,curveF:0}, {v0:1,v1:5,curveF:-0.5}, {v0:2,v1:5,curveF:2.5,curve:45}, {v0:3,v1:5,curve:0},
        {v0:0,v1:3,curve:179.99}, {v0:1,v1:0,curve:1e-9}, {v0:4,v1:3,curve:-0}
      ],
    }`,
  },
  {
    name: 'colors-and-flags',
    hbs: `{
      name: "Colors", width: 300, height: 200, bg: { color: "transparent" },
      vertexes: [ {x:0,y:0,cMask:["all","kick","score","c0","c1","c2","c3"],cGroup:[]}, {x:10,y:0,cGroup:["red","blue","redKO","blueKO","wall","ball","nope"]},
                  {x:20,y:5,bCoef:0.3} ],
      segments: [
        {v0:0,v1:1,color:"FF0000"}, {v0:1,v1:2,color:"transparent"}, {v0:2,v1:0,color:[255,128,1]},
        {v0:0,v1:2,color:"zzz"}, {v0:1,v1:0,color:"000000"}, {v0:2,v1:1,color:"FFFFFFFF"}, {v0:0,v1:1,color:[300,-1,"7"]},
        {v0:1,v1:2,color:"12xyz"}, {v0:2,v1:0,vis:false,cMask:["ball"],cGroup:["wall","c2"]}
      ],
      discs: [ {color:"transparent"}, {color:"FFFFFF"}, {color:[1,2,3]}, {color:"bad"}, {color:"0"} ],
      joints: [ {d0:1,d1:2,color:"00FF00"}, {d0:2,d1:3,color:"transparent"}, {d0:3,d1:4,color:"nope"} ],
    }`,
  },
  {
    name: 'traits',
    hbs: `{
      name: "Traits", width: 300, height: 200, bg: {},
      traits: {
        t1: { bCoef: 0.25, cMask: ["ball"], cGroup: ["wall", "c1"], vis: false, color: "ABCDEF", curve: 60, bias: 3 },
        t2: { radius: 4, invMass: 0, damping: 1, color: "112233", pos: [7, 8], speed: [1, 2], gravity: [0, 0.5] },
        t3: { team: "red", p1: [5, 5] },
        t4: { dist: -50, bCoef: 0.1 },
        t5: { strength: 0.3, length: [5, 25] },
        empty: {}
      },
      vertexes: [ {x:-10,y:0,trait:"t1"}, {x:10,y:0,trait:"t1",bCoef:2}, {x:0,y:10,trait:"missing"}, {x:0,y:-10,trait:"empty",cMask:null} ],
      segments: [ {v0:0,v1:1,trait:"t1"}, {v0:1,v1:2,trait:"t1",curve:-20,vis:true}, {v0:2,v1:3,trait:"t1",curveF:1}, {v0:3,v1:0,trait:"t1",bias:null} ],
      goals: [ {p0:[0,0],trait:"t3"}, {p0:[1,1],p1:[2,2],team:"blue",trait:"t3"} ],
      discs: [ {trait:"t2"}, {trait:"t2",pos:[1,1],radius:9}, {trait:"t2",invMass:null} ],
      planes: [ {normal:[0,1],trait:"t4"}, {normal:[3,4],dist:1,trait:"t4"} ],
      joints: [ {d0:1,d1:2,trait:"t5"}, {d0:2,d1:3,trait:"t5",strength:"rigid"} ],
    }`,
  },
  {
    name: 'discs-planes-joints',
    hbs: `{
      name: "DPJ", width: 400, height: 250, bg: { type: "grass", width: 350, height: 200 },
      discs: [
        { pos: [10, 20], speed: [1.5, -2.5], gravity: [0, 0.05], radius: 12, bCoef: 0.9, invMass: 0.3, damping: 0.999, cMask: ["all"], cGroup: ["kick", "score", "ball"] },
        { pos: [-30, 40] }, { pos: [30, 40], invMass: 0 }, { pos: [0, -60], radius: 0 },
        { pos: ["5", "6"], speed: [null, 1] }, { pos: [1] }, { pos: 5 }
      ],
      planes: [ { normal: [0, 2], dist: -250 }, { normal: [-3, -4], dist: -300, bCoef: 0.5, cMask: ["ball"], cGroup: ["wall"] },
                { normal: [1], dist: -400 }, { normal: [null, -1], dist: null }, { normal: [1, 1] } ],
      joints: [
        { d0: 0, d1: 1 }, { d0: 1, d1: 2, length: 50 }, { d0: 2, d1: 3, length: [10, 80], strength: 0.2 },
        { d0: 3, d1: 4, length: [80, 10] }, { d0: 0, d1: 3, strength: "rigid", color: [10, 20, 30] },
        { d0: 4, d1: 5, length: null, strength: 1e9 }, { d1: 2 }, { d0: 7 , d1: 0 }, { d0: 0, d1: 0 }
      ],
    }`,
  },
  {
    name: 'ball-disc0',
    hbs: `{
      name: "Disc0", width: 300, height: 200, bg: {}, ballPhysics: "disc0",
      discs: [ { radius: 7, cGroup: ["ball"], invMass: 1.5 }, { pos: [50, 0] } ],
      joints: [ { d0: 0, d1: 1 } ]
    }`,
  },
  {
    name: 'ball-physics-object',
    hbs: `{
      name: "BallObj", width: 300, height: 200, bg: {},
      ballPhysics: { radius: 6.5, bCoef: 0.7, invMass: 1.2, damping: 0.995, color: "FFCC00", cMask: ["wall", "red"], cGroup: ["c0"], pos: [3, 4], speed: [1, 0], gravity: [0, 0.02] },
      discs: [ { pos: [20, 0] } ]
    }`,
  },
  { name: 'ball-physics-primitive', hbs: `{ name: "BP", width: 1, height: 1, bg: {}, ballPhysics: 7 }` },
  { name: 'ball-physics-null', hbs: `{ name: "BPN", width: 1, height: 1, bg: {}, ballPhysics: null }` },
  {
    name: 'nulls-and-missing',
    hbs: `{
      name: null, width: null, bg: { type: "other", width: null, color: null }, spawnDistance: null,
      vertexes: [ { x: null }, { y: 3 }, {} ],
      segments: [ { v0: 0, v1: 1, bCoef: null, vis: null, curve: null }, { v0: 1, v1: 2 } ],
      goals: [ { p0: [], p1: [null, 1], team: "red" } ],
      planes: [ { normal: [0, 1] } ],
      joints: null, redSpawnPoints: null,
      playerPhysics: { gravity: [1], radius: null },
      canBeStored: null, cameraFollow: "ball", kickOffReset: "partial", maxViewWidth: -3.7
    }`,
  },
  {
    name: 'big-but-legal',
    hbs: JSON.stringify({
      name: 'Big255',
      width: 1000,
      height: 1000,
      bg: { type: 'grass', width: 900, height: 900 },
      vertexes: Array.from({ length: 255 }, (_, i) => ({ x: Math.cos(i) * 500, y: Math.sin(i) * 500 })),
      segments: Array.from({ length: 255 }, (_, i) => ({ v0: i, v1: (i + 1) % 255, curve: (i % 7) * 30 - 90 })),
      planes: Array.from({ length: 255 }, (_, i) => ({ normal: [Math.cos(i), Math.sin(i)], dist: -900 })),
      goals: Array.from({ length: 255 }, (_, i) => ({ p0: [i, 0], p1: [i, 10], team: i % 2 ? 'red' : 'blue' })),
      discs: Array.from({ length: 254 }, (_, i) => ({ pos: [i, i] })),
      joints: Array.from({ length: 300 }, (_, i) => ({ d0: i % 255, d1: (i * 7) % 255 })),
      redSpawnPoints: Array.from({ length: 20 }, (_, i) => [i, -i]),
    }),
  },
];

/** Inputs the official parser rejects (all must throw on both sides). */
export const BAD: HbsCase[] = [
  { name: 'no-bg', hbs: `{ name: "x", width: 1, height: 1 }` },
  { name: 'not-json5', hbs: `{ name: "x", ` },
  { name: 'name-number', hbs: `{ name: 5, width: 1, height: 1, bg: {} }` },
  { name: 'width-string', hbs: `{ name: "x", width: "1", height: 1, bg: {} }` },
  { name: 'bad-team', hbs: `{ name: "x", width: 1, height: 1, bg: {}, goals: [{ p0: [0,0], p1: [0,1], team: "green" }] }` },
  { name: 'color-number', hbs: `{ name: "x", width: 1, height: 1, bg: {}, discs: [{ color: 255 }] }` },
  { name: 'bg-color-number', hbs: `{ name: "x", width: 1, height: 1, bg: { color: 1 } }` },
  { name: 'vis-number', hbs: `{ name: "x", width: 1, height: 1, bg: {}, vertexes: [{x:0,y:0},{x:1,y:1}], segments: [{ v0: 0, v1: 1, vis: 1 }] }` },
  { name: 'v0-float', hbs: `{ name: "x", width: 1, height: 1, bg: {}, vertexes: [{x:0,y:0},{x:1,y:1}], segments: [{ v0: 0.5, v1: 1 }] }` },
  { name: 'v1-out-of-range', hbs: `{ name: "x", width: 1, height: 1, bg: {}, vertexes: [{x:0,y:0},{x:1,y:1}], segments: [{ v0: 0, v1: 2 }] }` },
  { name: 'joint-out-of-range', hbs: `{ name: "x", width: 1, height: 1, bg: {}, joints: [{ d0: 0, d1: 1 }] }` },
  { name: 'joint-negative', hbs: `{ name: "x", width: 1, height: 1, bg: {}, joints: [{ d0: -1, d1: 0 }] }` },
  { name: 'flags-not-array', hbs: `{ name: "x", width: 1, height: 1, bg: {}, vertexes: [{x:0,y:0,cMask:"all"}] }` },
  { name: 'vertexes-not-array', hbs: `{ name: "x", width: 1, height: 1, bg: {}, vertexes: {} }` },
  { name: 'null-vertex', hbs: `{ name: "x", width: 1, height: 1, bg: {}, vertexes: [null] }` },
  { name: 'trait-without-traits', hbs: `{ name: "x", width: 1, height: 1, bg: {}, vertexes: [{x:0,y:0,trait:"a"}] }` },
  { name: 'trait-not-string', hbs: `{ name: "x", width: 1, height: 1, bg: {}, traits: {}, vertexes: [{x:0,y:0,trait:1}] }` },
  { name: 'no-discs', hbs: `{ name: "x", width: 1, height: 1, bg: {}, ballPhysics: "disc0" }` },
  { name: 'negative-corner', hbs: `{ name: "x", width: 1, height: 1, bg: { cornerRadius: -1 } }` },
  { name: 'negative-ko', hbs: `{ name: "x", width: 1, height: 1, bg: { kickOffRadius: -0.5 } }` },
  { name: 'negative-player-radius', hbs: `{ name: "x", width: 1, height: 1, bg: {}, playerPhysics: { radius: -1 } }` },
  { name: 'too-many-vertexes', hbs: JSON.stringify({ name: 'x', width: 1, height: 1, bg: {}, vertexes: Array.from({ length: 256 }, () => ({ x: 0, y: 0 })) }) },
  { name: 'too-many-discs', hbs: JSON.stringify({ name: 'x', width: 1, height: 1, bg: {}, discs: Array.from({ length: 255 }, () => ({})) }) },
  { name: 'too-many-goals', hbs: JSON.stringify({ name: 'x', width: 1, height: 1, bg: {}, goals: Array.from({ length: 256 }, () => ({ p0: [0, 0], p1: [1, 1], team: 'red' })) }) },
  { name: 'can-be-stored-string', hbs: `{ name: "x", width: 1, height: 1, bg: {}, canBeStored: "yes" }` },
  { name: 'plane-no-normal', hbs: `{ name: "x", width: 1, height: 1, bg: {}, planes: [{ dist: 0 }] }` },
  { name: 'goal-no-p0', hbs: `{ name: "x", width: 1, height: 1, bg: {}, goals: [{ p1: [0,0], team: "red" }] }` },
  { name: 'spawn-null', hbs: `{ name: "x", width: 1, height: 1, bg: {}, redSpawnPoints: [null] }` },
  { name: 'radius-string', hbs: `{ name: "x", width: 1, height: 1, bg: {}, discs: [{ radius: "3" }] }` },
  { name: 'strength-bad', hbs: `{ name: "x", width: 1, height: 1, bg: {}, discs: [{}], joints: [{ d0: 0, d1: 1, strength: "soft" }] }` },
];

/** Random valid stadium exercising every feature (deterministic per seed). */
export function randomHbs(seed: number): string {
  const rnd = prng(seed);
  const r = (a: number, b: number) => a + (b - a) * rnd();
  const ri = (a: number, b: number) => Math.floor(r(a, b + 1));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const maybe = <T>(p: number, v: () => T): T | undefined => (rnd() < p ? v() : undefined);
  const FLAGS = ['ball', 'red', 'blue', 'redKO', 'blueKO', 'wall', 'kick', 'score', 'c0', 'c1', 'c2', 'c3', 'all'];
  const flags = () => Array.from({ length: ri(0, 3) }, () => pick(FLAGS));
  const color = () => pick<unknown>(['transparent', 'FF8800', '00ff00', [ri(0, 255), ri(0, 255), ri(0, 255)], ri(0, 0xffffff).toString(16).padStart(6, '0')]);

  const W = r(200, 800);
  const H = r(120, 400);
  const nv = ri(2, 40);
  const vertexes = Array.from({ length: nv }, () => ({
    x: r(-W, W), y: r(-H, H),
    bCoef: maybe(0.3, () => r(0, 1.5)), cMask: maybe(0.3, flags), cGroup: maybe(0.3, flags), trait: maybe(0.2, () => pick(['wallT', 'netT', 'nope'])),
  }));
  const segments = Array.from({ length: ri(0, 40) }, () => {
    const s: Record<string, unknown> = { v0: ri(0, nv - 1), v1: ri(0, nv - 1) };
    const c = rnd();
    if (c < 0.35) s['curve'] = r(-400, 400);
    else if (c < 0.45) s['curveF'] = r(-3, 3);
    else if (c < 0.5) s['curve'] = pick([90, -90, 180, -180, 10, 340, -10, -340, 0]);
    if (rnd() < 0.3) s['bias'] = r(-20, 20);
    if (rnd() < 0.2) s['vis'] = rnd() < 0.5;
    if (rnd() < 0.3) s['color'] = color();
    if (rnd() < 0.3) s['bCoef'] = r(0, 2);
    if (rnd() < 0.3) s['cMask'] = flags();
    if (rnd() < 0.3) s['cGroup'] = flags();
    if (rnd() < 0.2) s['trait'] = pick(['wallT', 'netT']);
    return s;
  });
  const discs = Array.from({ length: ri(0, 12) }, () => ({
    pos: [r(-W, W), r(-H, H)], speed: maybe(0.4, () => [r(-3, 3), r(-3, 3)]), gravity: maybe(0.2, () => [r(-0.05, 0.05), r(-0.05, 0.05)]),
    radius: maybe(0.6, () => r(1, 30)), bCoef: maybe(0.4, () => r(0, 1.2)), invMass: maybe(0.5, () => pick([0, r(0.05, 3)])),
    damping: maybe(0.4, () => r(0.9, 1)), color: maybe(0.3, color), cMask: maybe(0.3, flags), cGroup: maybe(0.3, flags),
  }));
  const ballDisc0 = discs.length > 0 && rnd() < 0.2;
  const nd = discs.length + (ballDisc0 ? 0 : 1);
  const joints = nd < 2 ? [] : Array.from({ length: ri(0, 6) }, () => ({
    d0: ri(0, nd - 1), d1: ri(0, nd - 1),
    length: pick<unknown>([undefined, null, r(5, 200), [r(5, 100), r(50, 200)]]),
    strength: pick<unknown>([undefined, 'rigid', r(0.01, 1)]), color: maybe(0.3, color),
  }));
  const planes = Array.from({ length: ri(0, 8) }, () => ({
    normal: [r(-1, 1), r(-1, 1)], dist: r(-W, 0), bCoef: maybe(0.4, () => r(0, 1.5)), cMask: maybe(0.3, flags), cGroup: maybe(0.3, flags),
  }));
  const goals = Array.from({ length: ri(0, 4) }, () => ({ p0: [r(-W, W), r(-H, H)], p1: [r(-W, W), r(-H, H)], team: pick(['red', 'blue']) }));
  const spawn = () => Array.from({ length: ri(0, 4) }, () => [r(-W, W), r(-H, H)]);
  const st = {
    name: `rnd ${seed}`, width: W, height: H,
    maxViewWidth: maybe(0.3, () => r(0, 1500)), cameraFollow: maybe(0.3, () => pick(['player', 'ball'])),
    spawnDistance: maybe(0.5, () => r(50, 400)), canBeStored: maybe(0.3, () => rnd() < 0.5), kickOffReset: maybe(0.4, () => pick(['full', 'partial'])),
    bg: { type: pick(['grass', 'hockey', 'none']), width: r(100, W), height: r(80, H), kickOffRadius: r(0, 100), cornerRadius: r(0, 50), goalLine: maybe(0.3, () => r(0, 50)), color: maybe(0.3, color) },
    traits: { wallT: { bCoef: 0.3, vis: false, cMask: ['ball'], curve: 45 }, netT: { color: 'C0C0C0', bias: 4 } },
    playerPhysics: maybe(0.5, () => ({
      bCoef: r(0, 1), invMass: r(0.1, 2), damping: r(0.9, 1), acceleration: r(0.05, 0.2), kickingAcceleration: r(0.03, 0.1),
      kickingDamping: r(0.9, 1), kickStrength: r(2, 10), gravity: [r(-0.02, 0.02), r(-0.02, 0.02)], cGroup: flags(), radius: r(5, 25), kickback: r(0, 3),
    })),
    ballPhysics: ballDisc0 ? 'disc0' : maybe(0.4, () => ({ radius: r(4, 15), bCoef: r(0, 1), invMass: r(0.2, 2), damping: r(0.95, 1), color: color(), cMask: flags(), cGroup: flags() })),
    vertexes, segments, discs, joints, planes, goals,
    redSpawnPoints: maybe(0.5, spawn), blueSpawnPoints: maybe(0.5, spawn),
  };
  return JSON.stringify(st);
}
