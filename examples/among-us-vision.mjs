// "Among Us"-style private visuals on haxlite. Every player:
//   - sees a fog over the rooms they are NOT in (a private stadium disc);
//   - does NOT see the living players outside their own area: no disc, no
//     name, no avatar and no off-screen arrow, at any zoom
//     (room.haxlite.hidePlayerFor);
//   - once dead (ghost), is invisible to the living but visible to the other
//     ghosts, walks through walls and sees everything (no fog);
//   - sees a task marker that lights up only for them.
// Nobody else sees another player's fog, marker or hidden players, and the
// room never desyncs (docs/04 §7.4). Screenshots in the real client:
// docs/img/among-us/.
//
//   npm install haxlite            (or `npm run build` inside this repo)
//   HAXBALL_TOKEN=thr1.xxxx node examples/among-us-vision.mjs
//
// Chat: "!kill" kills the nearest living player within 60 units (demo, anyone
// can kill). "!revive" brings everyone back to life.
//
// How hiding works. In the hidden player's disc, in the viewer's world only,
// the position becomes NaN and cGroup 0. The official client skips every
// drawing call with a NaN coordinate, and its off-screen arrow test
// (`900 < d²`) is false for NaN. The host simulates that world and sends that
// client its own checksum. A modified client still receives the real state of
// every player (the room state reaches everyone): this hides players from
// the official client, it does not stop cheating.
//
// Collisions. Living players are cGroup c1: they don't collide with each other,
// and walls and borders stop them. Ghosts are cGroup c0: only the borders stop
// them. Hidden players then never touch anything the viewer sees, so the
// viewer's game is exactly the room's.
//
// Visibility updates reach a player ~1 RTT late. A player walking into your
// area is shown 30 units before the doorway, still under the fog, so they
// don't pop in mid-room.
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
const MARGIN = 30; // a player is shown this far before entering your area (under the fog)
const FOG_R = 10000; // a fog this big is a half-plane: x < -DOOR or x > DOOR
const HIDDEN = { x: 0, y: 50000 };
const ROOMS = [
  { name: 'Cafeteria', x: -DOOR - FOG_R, y: 0, fog: 1 },
  { name: 'Electrical', x: DOOR + FOG_R, y: 0, fog: 2 },
];
const TASK = { disc: 3, x: 175, y: -50, room: 1 };
const LIVING = 1 << 29; // c1
const GHOST = 1 << 28; // c0
const visual = (x, y, radius, color) => ({ pos: [x, y], radius, color, invMass: 0, cGroup: [], cMask: [] });
// segments [x0, y0, x1, y1]: walls between the rooms and the corridor (doorway
// at |y| < 40) stop the living only; the outer border is drawn only
const walls = [[-DOOR, -H, -DOOR, -40], [-DOOR, 40, -DOOR, H], [DOOR, -H, DOOR, -40], [DOOR, 40, DOOR, H]];
const border = [[-W, -H, W, -H], [W, -H, W, H], [W, H, -W, H], [-W, H, -W, -H]];
const stadium = {
  name: 'Among Us vision', width: W, height: H, spawnDistance: 160,
  bg: { type: 'none', color: '1f1f1f' },
  vertexes: [...walls, ...border].flatMap(([x0, y0, x1, y1]) => [{ x: x0, y: y0 }, { x: x1, y: y1 }]),
  segments: [
    ...walls.map((_, i) => ({ v0: 2 * i, v1: 2 * i + 1, color: '555555', cMask: ['c1'] })),
    ...border.map((_, i) => ({ v0: 2 * (walls.length + i), v1: 2 * (walls.length + i) + 1, color: '555555', cMask: [], cGroup: [] })),
  ],
  goals: [], joints: [],
  // the planes keep everyone (living c1, ghosts c0) inside the map
  planes: [
    { normal: [0, 1], dist: -H, cMask: ['all', 'c0', 'c1'] }, { normal: [0, -1], dist: -H, cMask: ['all', 'c0', 'c1'] },
    { normal: [1, 0], dist: -W, cMask: ['all', 'c0', 'c1'] }, { normal: [-1, 0], dist: -W, cMask: ['all', 'c0', 'c1'] },
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

/** Per player: area (-1 corridor, 0 Cafeteria, 1 Electrical), ghost, task progress. Reset when the game (re)starts. */
const state = new Map();
const areaAt = (x) => (x < -DOOR ? 0 : x > DOOR ? 1 : -1);
/** Does area `a` (extended by MARGIN into its neighbours) contain x? */
const near = (a, x) => (a === 0 ? x < -DOOR + MARGIN : a === 1 ? x > DOOR - MARGIN : x > -DOOR - MARGIN && x < DOOR + MARGIN);
/** Hidden pairs as sent ("viewer:player"), to call hidePlayerFor/showPlayerFor only on changes. */
const hidden = new Set();

room.onPlayerJoin = (p) => {
  room.setPlayerTeam(p.id, 1);
  if (room.getScores() === null) room.startGame();
};
room.onPlayerLeave = (p) => state.delete(p.id); // its hidden pairs and overrides are dropped by haxlite
room.onGameStart = () => {
  for (const [id, s] of state) if (s.ghost) room.setPlayerAvatar(id, null);
  state.clear(); // a new game = new worlds: overrides and hidden pairs were dropped
  hidden.clear();
};

room.onPlayerChat = (p, msg) => {
  if (msg === '!revive') {
    for (const [id, s] of state) {
      if (s.ghost) room.setPlayerAvatar(id, null);
      s.ghost = false;
    }
    room.sendAnnouncement('Everyone is alive again');
    return false;
  }
  if (msg !== '!kill') return true;
  const me = state.get(p.id);
  if (!me || me.ghost || p.position === null) return false;
  let victim = null;
  let best = 60;
  for (const q of room.getPlayerList()) {
    const s = state.get(q.id);
    if (q.id === p.id || !s || s.ghost || q.position === null) continue;
    const d = Math.hypot(q.position.x - p.position.x, q.position.y - p.position.y);
    if (d < best) [victim, best] = [q, d];
  }
  if (victim === null) {
    room.sendAnnouncement('Nobody to kill here', p.id, 0xff4136);
    return false;
  }
  state.get(victim.id).ghost = true;
  room.setPlayerAvatar(victim.id, '👻'); // only the other ghosts see it
  room.sendAnnouncement(`You killed ${victim.name}`, p.id, 0xff4136, 'bold');
  room.sendAnnouncement('You are a ghost: only other ghosts can see you', victim.id, 0xaaaaaa, 'bold');
  return false; // nobody else reads the command
};

room.onGameTick = () => {
  const players = room.getPlayerList().filter((p) => p.team !== 0 && p.position !== null);
  for (const p of players) {
    let s = state.get(p.id);
    if (s === undefined) state.set(p.id, (s = { area: undefined, ghost: false, fogFor: undefined, near: false, progress: 0, done: false }));
    s.area = areaAt(p.position.x);
    // collision group (reset by every respawn): living c1, ghosts c0
    const group = s.ghost ? GHOST : LIVING;
    if (room.getPlayerDiscProperties(p.id).cGroup !== group) room.setPlayerDiscProperties(p.id, { cGroup: group });
    // fog: cover every room the player is not in (ghosts: no fog); only when that changes
    const fogFor = s.ghost ? 'ghost' : s.area;
    if (fogFor !== s.fogFor) {
      s.fogFor = fogFor;
      for (let i = 0; i < ROOMS.length; i++) {
        const at = s.ghost || i === s.area ? HIDDEN : ROOMS[i];
        room.haxlite.setDiscPropertiesFor(p.id, ROOMS[i].fog, { x: at.x, y: at.y });
      }
    }
  }
  // who sees whom: ghosts see everyone; the living see the living near their area
  for (const v of players) {
    const sv = state.get(v.id);
    for (const p of players) {
      if (p.id === v.id) continue;
      const sp = state.get(p.id);
      const visible = sv.ghost || (!sp.ghost && near(sv.area, p.position.x));
      const key = `${v.id}:${p.id}`;
      if (visible === !hidden.has(key)) continue;
      if (visible) hidden.delete(key);
      else hidden.add(key);
      room.haxlite.setPlayerHiddenFor(v.id, p.id, !visible);
    }
  }
  // task: private marker + private prompt, completed after 3 s next to it (the living only)
  for (const p of players) {
    const s = state.get(p.id);
    if (s.done || s.ghost) continue;
    const close = Math.hypot(p.position.x - TASK.x, p.position.y - TASK.y) < 40;
    if (close !== s.near) {
      s.near = close;
      s.progress = 0;
      room.haxlite.setDiscPropertiesFor(p.id, TASK.disc, { color: close ? 0xffd700 : 0x555555 });
      if (close) room.sendAnnouncement('Task: fix wiring - stay here 3 s', p.id, 0xffd700, 'bold', 2);
    } else if (close && ++s.progress === 180) {
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
