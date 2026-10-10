/**
 * Cross-check of the two oracles: node-haxball (sandbox) vs the OFFICIAL
 * headless code (evaluated offline). Same event bytes in, byte-identical
 * RoomState out, every frame. This is what justifies using node-haxball as
 * the day-to-day oracle; if this ever fails, the official one wins.
 */
import { describe, expect, it } from 'vitest';
import { Input } from '../../src/protocol.js';
import { OfficialRoom } from './official.js';
import { DEFAULT_STADIUM_NAMES, OracleRoom, encodeEvent, prng } from './index.js';

type Step = { frame: number; byId: number; bytes: Uint8Array };

/** Dynamic input source: called before each tick, may look at the (node-haxball) state. */
type Driver = (frame: number, room: OracleRoom) => Step[];

/**
 * Chase bot: every 5 frames each player runs towards the ball (30% random
 * mask, 30% kick), so kicks, goals, kick-offs and resets actually happen.
 */
function chaseBot(seed: number, players: number): Driver {
  const rnd = prng(seed);
  return (f, room) => {
    if (f % 5 !== 0) return [];
    const discs = room.discs();
    const ball = discs[0];
    if (!ball) return [];
    const out: Step[] = [];
    for (const p of room.dump().players) {
      if (p.id > players || p.discIndex < 0) continue;
      const me = discs[p.discIndex]!;
      const mask =
        rnd() < 0.3
          ? Math.floor(rnd() * 32)
          : (ball.x > me.x ? Input.Right : Input.Left) | (ball.y > me.y ? Input.Down : Input.Up) | (rnd() < 0.3 ? Input.Kick : 0);
      out.push({ frame: f, byId: p.id, bytes: encodeEvent('sendInput', mask) });
    }
    return out;
  };
}

/** Runs the same event list on both oracles, comparing state bytes after every tick. */
function crossRun(script: Step[], frames: number, setup: Step[] = [], driver?: Driver) {
  const nhRoom = OracleRoom.empty();
  const offRoom = new OfficialRoom();
  for (const s of setup) {
    nhRoom.applyEventBytes(s.bytes, s.byId);
    offRoom.applyEventBytes(s.bytes, s.byId);
  }
  expect(Buffer.from(offRoom.stateBytes()).toString('hex')).toBe(Buffer.from(nhRoom.stateBytes()).toString('hex'));
  let i = 0;
  for (let f = 0; f < frames; f++) {
    while (i < script.length && script[i]!.frame === f) {
      const s = script[i++]!;
      nhRoom.applyEventBytes(s.bytes, s.byId);
      offRoom.applyEventBytes(s.bytes, s.byId);
    }
    for (const s of driver?.(f, nhRoom) ?? []) {
      nhRoom.applyEventBytes(s.bytes, s.byId);
      offRoom.applyEventBytes(s.bytes, s.byId);
    }
    nhRoom.step();
    offRoom.step();
    const a = offRoom.stateBytes();
    const b = nhRoom.stateBytes();
    if (Buffer.compare(a, b) !== 0) {
      throw new Error(`oracles diverge at frame ${f + 1}: official ${Buffer.from(a).toString('hex')} vs node-haxball ${Buffer.from(b).toString('hex')}`);
    }
  }
  expect(offRoom.checksum()).toBe(nhRoom.checksum());
  return { nhRoom, offRoom };
}

function joinAll(n: number): Step[] {
  const out: Step[] = [];
  for (let id = 1; id <= n; id++) {
    out.push({ frame: 0, byId: 0, bytes: encodeEvent('joinRoom', id, `p${id}`, 'es', null, '', '') });
    out.push({ frame: 0, byId: 0, bytes: encodeEvent('setPlayerTeam', id, id % 2 === 1 ? 1 : 2) });
  }
  return out;
}

/** Pseudo-random inputs (players drift towards the opponent goal, random kicks). */
function botScript(seed: number, players: number, frames: number): Step[] {
  const rnd = prng(seed);
  const out: Step[] = [];
  for (let f = 0; f < frames; f += 1 + Math.floor(rnd() * 6)) {
    const id = 1 + Math.floor(rnd() * players);
    let mask = Math.floor(rnd() * 32);
    if (rnd() < 0.5) mask = (mask & Input.Kick) | (id % 2 === 1 ? Input.Right : Input.Left);
    out.push({ frame: f, byId: id, bytes: encodeEvent('sendInput', mask) });
  }
  return out;
}

const CUSTOM_HBS = `{
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

describe('node-haxball and the official headless code agree bit-for-bit', () => {
  it('fresh RoomState', () => {
    expect(new OfficialRoom().stateBytes()).toEqual(OracleRoom.empty().stateBytes());
  });

  it('Classic, 4 chasing players, 5000 frames: kicks, goals, resets', () => {
    const setup = [...joinAll(4), { frame: 0, byId: 0, bytes: encodeEvent('setScoreLimit', 0) }, { frame: 0, byId: 0, bytes: encodeEvent('startGame') }];
    const { nhRoom } = crossRun([], 5000, setup, chaseBot(3, 4));
    const game = nhRoom.dump().game!;
    expect(game.redScore + game.blueScore).toBeGreaterThan(0);
  });

  for (let s = 0; s < DEFAULT_STADIUM_NAMES.length; s++) {
    it(`built-in stadium ${s} (${DEFAULT_STADIUM_NAMES[s]}), 2v2, 1200 frames`, () => {
      const setup = [
        { frame: 0, byId: 0, bytes: encodeEvent('setStadium', s) },
        ...joinAll(4),
        { frame: 0, byId: 0, bytes: encodeEvent('startGame') },
      ];
      crossRun(botScript(100 + s, 4, 400), 1200, setup, chaseBot(100 + s, 4));
    });
  }

  it('custom .hbs (curves, bias, joints, gravity, spawn points, full kickoff reset) + admin events', () => {
    const setup = [
      { frame: 0, byId: 0, bytes: encodeEvent('setStadium', { hbs: CUSTOM_HBS }) },
      { frame: 0, byId: 0, bytes: encodeEvent('setKickRateLimit', 3, 10, 4) },
      { frame: 0, byId: 0, bytes: encodeEvent('setScoreLimit', 2) },
      { frame: 0, byId: 0, bytes: encodeEvent('setTimeLimit', 1) },
      ...joinAll(3),
      { frame: 0, byId: 0, bytes: encodeEvent('startGame') },
    ];
    const script: Step[] = [
      ...botScript(5, 3, 2000),
      { frame: 50, byId: 0, bytes: encodeEvent('setDiscProperties', 0, { x: 10, y: -20, xspeed: 3.3, radius: 9.7 }) },
      { frame: 60, byId: 0, bytes: encodeEvent('setPlayerDiscProperties', 2, { xspeed: -4, cMask: 63 }) },
      { frame: 300, byId: 0, bytes: encodeEvent('pauseResumeGame', true) },
      { frame: 340, byId: 0, bytes: encodeEvent('pauseResumeGame', false) },
      { frame: 500, byId: 0, bytes: encodeEvent('joinRoom', 9, 'late', null, null, '', '') },
      { frame: 501, byId: 0, bytes: encodeEvent('setPlayerTeam', 9, 2) },
      { frame: 700, byId: 0, bytes: encodeEvent('setPlayerTeam', 1, 2) },
      { frame: 900, byId: 0, bytes: encodeEvent('reorderPlayers', [3, 9], true) },
      { frame: 1000, byId: 0, bytes: encodeEvent('kickBanPlayer', 2, null, false) },
      { frame: 1100, byId: 0, bytes: encodeEvent('setTeamColors', 1, { angle: 30, text: 0x123456, inner: [1, 2, 3] }) },
      { frame: 1200, byId: 0, bytes: encodeEvent('setHeadlessAvatar', 3, 'ab') },
      { frame: 1300, byId: 3, bytes: encodeEvent('setAvatar', 'zz') },
      { frame: 1400, byId: 0, bytes: encodeEvent('setPlayerAdmin', 3, true) },
      { frame: 1500, byId: 0, bytes: encodeEvent('ping', [10, 20, 30]) },
    ].sort((a, b) => a.frame - b.frame);
    const { nhRoom } = crossRun(script, 4000, setup, chaseBot(11, 3));
    expect(nhRoom.dump().stadium.name).toBe('haxlite test arena');
  });
});
