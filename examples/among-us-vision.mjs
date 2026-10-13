// "Among Us"-style private visuals on haxlite: every player sees a fog over
// the rooms they are NOT in (other players inside are hidden: the official
// client draws stadium discs on top of player discs) and a task marker that
// lights up only for them. Nobody else sees another player's fog/marker, and
// the room never desyncs (room.haxlite.setDiscPropertiesFor, docs/04 §7.4).
//
//   npm install haxlite            (or `npm run build` inside this repo)
//   HAXBALL_TOKEN=thr1.xxxx node examples/among-us-vision.mjs
//
// Limits: fog shapes are circles (stadium discs), updates reach a player
// ~1 RTT later, and the official client still draws the off-screen arrows of
// players outside the camera. Spectators see the room's world (no fog).
import { HBInit } from 'haxlite';

const token = process.env.HAXBALL_TOKEN;
if (!token) {
  console.error('Set HAXBALL_TOKEN (https://www.haxball.com/headlesstoken)');
  process.exit(1);
}
const haxlite = process.env.HAXLITE_OPTIONS ? JSON.parse(process.env.HAXLITE_OPTIONS) : {};

// Two square rooms (left / right) joined by a corridor. Discs 1-2: one fog per
// room; disc 3: task marker. All "visual-only": cGroup 0 (nothing collides
// with them, nothing kicks them). Hidden = parked outside the field.
const HIDDEN = { x: 0, y: 5000 };
const ROOMS = [
  { name: 'Cafeteria', x: -200, y: 0, fog: 1 },
  { name: 'Electrical', x: 200, y: 0, fog: 2 },
];
const TASK = { disc: 3, x: 280, y: -80, room: 1 };
const visual = (x, y, radius, color) => ({ pos: [x, y], radius, color, invMass: 0, cGroup: [], cMask: [] });
const stadium = {
  name: 'Among Us vision', width: 360, height: 160, spawnDistance: 200,
  bg: { type: 'none', color: '1f1f1f' },
  vertexes: [], segments: [], goals: [], joints: [],
  planes: [
    { normal: [0, 1], dist: -140 }, { normal: [0, -1], dist: -140 },
    { normal: [1, 0], dist: -340 }, { normal: [-1, 0], dist: -340 },
  ],
  discs: [
    { pos: [0, 0], radius: 6, invMass: 1, cGroup: ['ball'] }, // disc 0 (kept for HaxBall)
    visual(HIDDEN.x, HIDDEN.y, 185, '101010'),
    visual(HIDDEN.x, HIDDEN.y, 185, '101010'),
    visual(TASK.x, TASK.y, 12, '555555'),
  ],
  traits: {}, playerPhysics: {}, ballPhysics: 'disc0',
};

const room = await HBInit({ roomName: 'haxlite among us (vision demo)', maxPlayers: 10, public: false, noPlayer: true, token, haxlite });
room.setCustomStadium(JSON.stringify(stadium));
room.setTimeLimit(0);
room.setScoreLimit(0);
room.onRoomLink = (link) => console.log(`Room link: ${link}`);

/** Per player: index of the room they are in (-1 corridor), task progress. Reset when the game (re)starts. */
const state = new Map();
const roomAt = (x) => (x < -75 ? 0 : x > 75 ? 1 : -1);

room.onPlayerJoin = (p) => {
  room.setPlayerTeam(p.id, 1);
  if (room.getScores() === null) room.startGame();
};
room.onPlayerLeave = (p) => state.delete(p.id); // its overrides are dropped by haxlite
room.onGameStart = () => state.clear(); // a new game = new worlds: overrides were dropped

room.onGameTick = () => {
  for (const p of room.getPlayerList()) {
    if (p.team === 0 || p.position === null) continue;
    let s = state.get(p.id);
    if (s === undefined) state.set(p.id, (s = { room: undefined, near: false, progress: 0, done: false }));

    // fog: cover every room the player is not in (only when that changes)
    const r = roomAt(p.position.x);
    if (r !== s.room) {
      s.room = r;
      for (let i = 0; i < ROOMS.length; i++) {
        const fog = ROOMS[i];
        const at = i === r ? HIDDEN : fog;
        room.haxlite.setDiscPropertiesFor(p.id, fog.fog, { x: at.x, y: at.y });
      }
    }

    // task: private marker + private prompt, completed after 3 s next to it
    if (s.done) continue;
    const near = Math.hypot(p.position.x - TASK.x, p.position.y - TASK.y) < 40;
    if (near !== s.near) {
      s.near = near;
      s.progress = 0;
      room.haxlite.setDiscPropertiesFor(p.id, TASK.disc, { color: near ? 0xffd700 : 0x555555 });
      if (near) room.sendAnnouncement('Task: fix wiring - stay here 3 s', p.id, 0xffd700, 'bold', 2);
    } else if (near && ++s.progress === 180) {
      s.done = true;
      room.haxlite.setDiscPropertiesFor(p.id, TASK.disc, { color: 0x2ecc40 });
      room.sendAnnouncement('Task done!', p.id, 0x2ecc40, 'bold', 1);
    }
  }
};

process.once('SIGINT', async () => {
  console.log('closing room…');
  await room.haxlite.stop();
});
