// "Among Us"-style private visuals on haxlite: every player sees a fog over
// the rooms they are NOT in (other players inside are hidden: the official
// client draws stadium discs on top of player discs and their names) and a
// task marker that lights up only for them. Nobody else sees another player's
// fog/marker, and the room never desyncs (room.haxlite.setDiscPropertiesFor,
// docs/04 §7.4). Screenshots in the real client: docs/img/among-us/.
//
//   npm install haxlite            (or `npm run build` inside this repo)
//   HAXBALL_TOKEN=thr1.xxxx node examples/among-us-vision.mjs
//
// Off-screen arrows. The official client draws, for every player with a disc
// (any team, teammates or not; spectators have none) and for the ball, a small
// arrow in the team colour at the edge of the screen when the disc centre is
// more than ~5 units outside the camera view (game-min.js `wr`/`Jk`, docs/04
// §7.4). Radius, colour or visibility of the disc do not matter, and no room
// or client setting turns them off. Two things keep them from leaking here:
//   1. The whole map fits on screen: disc centres stay within ±245 × ±115
//      (a view of 480 × 230 world units) and `width`/`height` (the camera
//      bounds) match, so the camera stays centred, nothing is off-screen and
//      no arrow is drawn. Checked in the real client with a 1000×700 game
//      area: "Viewport Mode" Dynamic (the default), Restricted and Full 1x-2x.
//   2. Arrows are drawn BELOW stadium discs, and each fog is a huge disc
//      (radius 10000): a half-plane covering everything past its doorway, also
//      off the map. If a player zooms in (settings, or number keys 0-7 in game)
//      until the map no longer fits, an arrow pointing into a fogged room is
//      drawn on that side's screen edge, under the fog, as long as that edge is
//      past the doorway: a view at least W + DOOR + 25 = 325 units wide (Full
//      2.5x from ~815 px). Narrower than that the arrows show: the room cannot
//      know or limit the client's zoom.
// Moving a "dead" player to spectators removes its disc and its arrow.
//
// Limits: fog shapes are circles (stadium discs), updates reach a player
// ~1 RTT later. Spectators see the room's world (no fog).
import { HBInit } from 'haxlite';

const token = process.env.HAXBALL_TOKEN;
if (!token) {
  console.error('Set HAXBALL_TOKEN (https://www.haxball.com/headlesstoken)');
  process.exit(1);
}
const haxlite = process.env.HAXLITE_OPTIONS ? JSON.parse(process.env.HAXLITE_OPTIONS) : {};

// Two rooms (left / right) joined by a corridor (|x| < 40) with doorways.
// Discs 1-2: one fog per room; disc 3: task marker. All "visual-only":
// cGroup 0 (nothing collides with them, nothing kicks them). Hidden = parked
// far outside the field.
const W = 260; // half width (planes); player centres reach ±245
const H = 130; // half height; player centres reach ±115
const DOOR = 40; // corridor half width
const FOG_R = 10000; // a fog this big is a half-plane: x < -DOOR or x > DOOR
const HIDDEN = { x: 0, y: 50000 };
const ROOMS = [
  { name: 'Cafeteria', x: -DOOR - FOG_R, y: 0, fog: 1 },
  { name: 'Electrical', x: DOOR + FOG_R, y: 0, fog: 2 },
];
const TASK = { disc: 3, x: 175, y: -50, room: 1 };
const visual = (x, y, radius, color) => ({ pos: [x, y], radius, color, invMass: 0, cGroup: [], cMask: [] });
// segments [x0, y0, x1, y1]: walls between the rooms and the corridor (doorway
// at |y| < 40) and the outer border, drawn only (the planes keep players in)
const walls = [[-DOOR, -H, -DOOR, -40], [-DOOR, 40, -DOOR, H], [DOOR, -H, DOOR, -40], [DOOR, 40, DOOR, H]];
const border = [[-W, -H, W, -H], [W, -H, W, H], [W, H, -W, H], [-W, H, -W, -H]];
const stadium = {
  name: 'Among Us vision', width: W, height: H, spawnDistance: 160,
  bg: { type: 'none', color: '1f1f1f' },
  vertexes: [...walls, ...border].flatMap(([x0, y0, x1, y1]) => [{ x: x0, y: y0 }, { x: x1, y: y1 }]),
  segments: [
    ...walls.map((_, i) => ({ v0: 2 * i, v1: 2 * i + 1, color: '555555' })),
    ...border.map((_, i) => ({ v0: 2 * (walls.length + i), v1: 2 * (walls.length + i) + 1, color: '555555', cMask: [], cGroup: [] })),
  ],
  goals: [], joints: [],
  planes: [
    { normal: [0, 1], dist: -H }, { normal: [0, -1], dist: -H },
    { normal: [1, 0], dist: -W }, { normal: [-1, 0], dist: -W },
  ],
  discs: [
    { pos: [0, 0], radius: 6, invMass: 1, cGroup: ['ball'] }, // disc 0 (kept for HaxBall)
    visual(HIDDEN.x, HIDDEN.y, FOG_R, '101010'),
    visual(HIDDEN.x, HIDDEN.y, FOG_R, '101010'),
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
const roomAt = (x) => (x < -DOOR ? 0 : x > DOOR ? 1 : -1);

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
