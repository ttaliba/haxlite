// Basic haxlite room: a classic HBInit script (admin to the first player,
// automatic teams, chat commands) running on haxlite instead of the official
// headless page.
//
//   npm install haxlite            (or `npm run build` inside this repo)
//   HAXBALL_TOKEN=thr1.xxxx node examples/basic-room.mjs
//
// Get a token at https://www.haxball.com/headlesstoken (it expires after a
// few minutes, so create the room right after copying it).
import { HBInit } from 'haxlite';

const token = process.env.HAXBALL_TOKEN;
if (!token) {
  console.error('Set HAXBALL_TOKEN (https://www.haxball.com/headlesstoken)');
  process.exit(1);
}
// Optional extra haxlite options as JSON (custom master, ICE servers, netcode knobs…).
const haxlite = process.env.HAXLITE_OPTIONS ? JSON.parse(process.env.HAXLITE_OPTIONS) : {};

const room = await HBInit({
  roomName: 'haxlite 3v3',
  maxPlayers: 16,
  public: true,
  noPlayer: true, // recommended: the host has no player
  token,
  haxlite,
});

room.setDefaultStadium('Big');
room.setScoreLimit(5);
room.setTimeLimit(0);

room.onRoomLink = (link) => console.log(`Room link: ${link}`);

// ---------------------------------------------------------------- admins

/** If there are no admins left in the room give admin to one of the remaining players. */
function updateAdmins() {
  const players = room.getPlayerList();
  if (players.length === 0) return;
  if (players.some((p) => p.admin)) return;
  room.setPlayerAdmin(players[0].id, true);
}

// ---------------------------------------------------------------- teams

const RED = 1;
const BLUE = 2;
const MAX_PER_TEAM = 3;

function teamSizes() {
  const sizes = [0, 0, 0];
  for (const p of room.getPlayerList()) sizes[p.team]++;
  return sizes;
}

/** Puts a spectator in the smaller team (if there is room) and starts the game when both teams have players. */
function autoTeam(player) {
  const sizes = teamSizes();
  const team = sizes[RED] <= sizes[BLUE] ? RED : BLUE;
  if (sizes[team] >= MAX_PER_TEAM) return;
  room.setPlayerTeam(player.id, team);
  sizes[team]++;
  if (room.getScores() === null && sizes[RED] > 0 && sizes[BLUE] > 0) room.startGame();
}

// ---------------------------------------------------------------- events

room.onPlayerJoin = (player) => {
  console.log(`${player.name} joined (auth ${player.auth}, conn ${player.conn})`);
  room.sendAnnouncement(`Welcome ${player.name}! Type !help for commands.`, player.id, 0x7fdbff, 'bold', 1);
  updateAdmins();
  autoTeam(player);
};

room.onPlayerLeave = (player) => {
  console.log(`${player.name} left`);
  updateAdmins();
};

let swapAfterGame = false;

room.onTeamVictory = (scores) => {
  swapAfterGame = true;
  const winner = scores.red > scores.blue ? 'Red' : 'Blue';
  room.sendAnnouncement(`${winner} wins ${scores.red}-${scores.blue} (${Math.round(scores.time)} s)`, null, 0xffd700, 'bold', 2);
};

room.onGameStop = () => {
  if (!swapAfterGame) return;
  // after a victory: swap teams and play again
  swapAfterGame = false;
  for (const p of room.getPlayerList()) if (p.team !== 0) room.setPlayerTeam(p.id, p.team === RED ? BLUE : RED);
  room.startGame();
};

const commands = {
  '!help': (player) => room.sendAnnouncement('Commands: !bb, !afk, !swap (admin), !rr (admin)', player.id),
  '!bb': (player) => room.kickPlayer(player.id, 'Bye!', false),
  '!afk': (player) => room.setPlayerTeam(player.id, 0),
  '!swap': (player) => {
    if (!player.admin || room.getScores() !== null) return;
    for (const p of room.getPlayerList()) if (p.team !== 0) room.setPlayerTeam(p.id, p.team === RED ? BLUE : RED);
  },
  '!rr': (player) => {
    if (!player.admin) return;
    room.stopGame();
    room.startGame();
  },
};

room.onPlayerChat = (player, message) => {
  const cmd = commands[message.trim().toLowerCase()];
  if (cmd === undefined) return true;
  cmd(player);
  return false; // commands are not shown to the other players
};

// ---------------------------------------------------------------- shutdown

process.once('SIGINT', async () => {
  console.log('closing room…');
  await room.haxlite.stop(); // the process exits on its own once the last room stops
});
