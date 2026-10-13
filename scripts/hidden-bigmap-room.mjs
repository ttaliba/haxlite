// Room for the "far off-screen" screenshots of hidden players
// (scripts/among-us-screenshots.ts with EXAMPLE=scripts/hidden-bigmap-room.mjs):
// a map much larger than any view, so every other player is off-screen and the
// official client would draw an edge arrow for each one. Every player is
// hidden from "A" (room.haxlite.hidePlayerFor) unless CONTROL=1.
import { HBInit } from 'haxlite';

const haxlite = process.env.HAXLITE_OPTIONS ? JSON.parse(process.env.HAXLITE_OPTIONS) : {};
const control = process.env.CONTROL === '1';
const W = 1500;
const H = 700;
const stadium = {
  name: 'Big map', width: W, height: H, spawnDistance: 300,
  bg: { type: 'grass', width: W - 20, height: H - 20, kickOffRadius: 80 },
  vertexes: [], segments: [], goals: [], joints: [],
  planes: [
    { normal: [0, 1], dist: -H }, { normal: [0, -1], dist: -H },
    { normal: [1, 0], dist: -W }, { normal: [-1, 0], dist: -W },
  ],
  discs: [{ pos: [0, 0], radius: 10, invMass: 1, cGroup: ['ball', 'kick', 'score'] }],
  traits: {}, playerPhysics: {}, ballPhysics: 'disc0',
};

const room = await HBInit({ roomName: 'hidden players, big map', maxPlayers: 10, public: false, noPlayer: true, token: process.env.HAXBALL_TOKEN, haxlite });
room.setCustomStadium(JSON.stringify(stadium));
room.onRoomLink = (link) => console.log(`Room link: ${link}`);
room.onPlayerJoin = (p) => {
  room.setPlayerTeam(p.id, p.name === 'B' ? 2 : 1);
  if (room.getScores() === null) room.startGame();
};
room.onGameTick = () => {
  if (control) return;
  const a = room.getPlayerList().find((p) => p.name === 'A');
  if (!a) return;
  for (const p of room.getPlayerList()) {
    if (p.id !== a.id && p.team !== 0 && !room.haxlite.isPlayerHiddenFor(a.id, p.id)) room.haxlite.hidePlayerFor(a.id, p.id);
  }
};
