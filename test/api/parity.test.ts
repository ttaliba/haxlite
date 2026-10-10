/**
 * Parity: the SAME room script and client-driven scenario run against the
 * official headless HBInit (the real `headless-min.js` via
 * ./official-hbinit.ts, with the FakeMaster) and against haxlite's HBInit.
 * The sequence of callback invocations, their arguments, the microtask
 * probe and the getter results must be identical.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Input } from '../../src/protocol.js';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, withTimeout, type Any, type Client, type Env } from './harness.js';
import { loadOfficialHeadless, type OfficialHost } from './official-hbinit.js';

const require = createRequire(import.meta.url);
let env: Env;
let official: OfficialHost;
let auths: Any[];
beforeAll(async () => {
  env = await startEnv();
  official = await loadOfficialHeadless(env.master.httpBase);
  auths = [];
  for (let i = 0; i < 3; i++) auths.push(((await env.nh.Utils.generateAuth()) as [string, Any])[1]);
}, 60_000);
afterAll(async () => {
  official?.dispose();
  await env.master.close();
  shutdownAll();
});

const HBS = `{
  "name" : "Tiny test", "width" : 300, "height" : 150, "spawnDistance" : 100,
  "bg" : { "type" : "grass", "width" : 250, "height" : 120, "kickOffRadius" : 60 },
  "vertexes" : [ { "x" : -250, "y" : 120 }, { "x" : 250, "y" : 120 } ],
  "segments" : [ { "v0" : 0, "v1" : 1 } ],
  "goals" : [ { "p0" : [-250, -40], "p1" : [-250, 40], "team" : "red" }, { "p0" : [250, 40], "p1" : [250, -40], "team" : "blue" } ],
  "discs" : [ { "radius" : 10, "invMass" : 1, "cGroup" : ["ball", "kick", "score"] } ],
  "planes" : [ { "normal" : [0, 1], "dist" : -120 }, { "normal" : [0, -1], "dist" : -120 } ],
  "traits" : {}, "playerPhysics" : {}, "ballPhysics" : "disc0"
}`;

const CALLBACKS = [
  'onPlayerJoin', 'onPlayerLeave', 'onTeamVictory', 'onPlayerBallKick', 'onTeamGoal', 'onGameStart', 'onGameStop',
  'onPlayerAdminChange', 'onPlayerTeamChange', 'onPlayerKicked', 'onGamePause', 'onGameUnpause', 'onPositionsReset',
  'onPlayerActivity', 'onPlayerInput', 'onStadiumChange', 'onKickRateLimitSet', 'onTeamsLockChange',
];

const copy = (v: unknown): Any => (v === undefined ? '<undefined>' : JSON.parse(JSON.stringify(v)));

/** The room script + scenario. `room` is an official or haxlite RoomObject; returns the observable trace. */
async function scenario(room: Any, roomId: string): Promise<Any[][]> {
  const log: Any[][] = [];
  const count = (name: string) => log.filter((l) => l[0] === name).length;
  const until = (name: string, n: number, what = name) => waitFor(() => count(name) >= n, 10_000, what);
  let ticks = 0;
  const clients: Client[] = [];
  for (const n of CALLBACKS) {
    room[n] = (...args: unknown[]) => {
      log.push([n, ...args.map(copy)]);
    };
  }
  room.onGameTick = () => ticks++;
  // classic script: admin to the first player, microtask probe
  room.onPlayerJoin = (p: Any) => {
    log.push(['onPlayerJoin', copy(p)]);
    if (p.id === 1) {
      room.setPlayerAdmin(p.id, true);
      const sync = room.getPlayer(p.id).admin;
      queueMicrotask(() => log.push(['probe', sync, room.getPlayer(p.id).admin]));
    }
  };
  room.onPlayerChat = (p: Any, msg: string) => {
    log.push(['onPlayerChat', copy(p), msg]);
    return msg !== 'secret';
  };
  try {
    const alice = await join(env, roomId, 'alice', { authObj: auths[0], avatar: 'A', flag: 'ar' });
    clients.push(alice);
    await until('probe', 1);
    await until('onPlayerAdminChange', 1);
    const bob = await join(env, roomId, 'bob', { authObj: auths[1] });
    clients.push(bob);
    await until('onPlayerJoin', 2);

    // chat filter
    alice.room.sendChat('hello');
    alice.room.sendChat('secret');
    alice.room.sendChat('after');
    await waitFor(() => bob.chats.some(([, m]) => m === 'after'), 10_000, 'chat');
    await sleep(100);
    log.push(['bob received', copy(bob.chats)]);
    room.sendChat('host says');
    room.sendAnnouncement('for bob', 2, 0x00ff00, 'small-bold', 0);
    await waitFor(() => bob.announcements.length > 0 && bob.chats.length > 2, 10_000, 'host chat');
    log.push(['bob received', copy(bob.chats), copy(bob.announcements)]);

    // teams
    alice.room.setPlayerTeam(2, 2);
    await until('onPlayerTeamChange', 1);
    room.setPlayerTeam(1, 1);
    await until('onPlayerTeamChange', 2);

    // settings + stadiums (validation throws synchronously)
    room.setTeamsLock(true);
    room.setKickRateLimit(3, 1, 2);
    room.setScoreLimit(1);
    room.setTimeLimit(2);
    for (const bad of [() => room.setDefaultStadium('Nope'), () => room.setCustomStadium('{ not json')]) {
      try {
        bad();
        log.push(['no throw']);
      } catch (e) {
        log.push(['threw', e instanceof Error]);
      }
    }
    room.setCustomStadium(HBS);
    await until('onStadiumChange', 1);
    room.setDefaultStadium('Classic');
    await until('onStadiumChange', 2);
    log.push(['getters (no game)', copy(room.getScores()), copy(room.getBallPosition()), room.getDiscCount(), copy(room.getDiscProperties(0))]);

    // game started by the admin client
    alice.room.startGame();
    await until('onGameStart', 1);
    await waitFor(() => ticks > 20, 10_000, 'ticks');
    log.push([
      'getters (game)',
      copy(room.getScores()),
      copy(room.getBallPosition()),
      room.getDiscCount(),
      copy(room.getDiscProperties(0)),
      copy(room.getPlayerDiscProperties(1)),
      copy(room.getPlayerDiscProperties(0)),
      copy(room.getPlayerList()),
    ]);

    // inputs (activity + input)
    alice.room.setKeyState(Input.Kick);
    await until('onPlayerInput', 1);
    alice.room.setKeyState(0);
    await until('onPlayerInput', 2);

    // pause / unpause by the host
    room.pauseGame(true);
    await until('onGamePause', 1);
    room.pauseGame(false);
    await until('onGameUnpause', 1);
    const t0 = ticks;
    await waitFor(() => ticks > t0 + 10, 10_000, 'resume');

    // goal -> victory (score limit 1) -> stop
    room.setDiscProperties(0, { x: 360, y: 0, xspeed: 8, yspeed: 0 });
    await until('onGameStop', 1);
    log.push(['getters (after)', copy(room.getScores()), copy(room.getPlayerList())]);

    // second game by the host: ball kick, goal -> positions reset, stop
    room.setScoreLimit(0);
    room.startGame();
    await until('onGameStart', 2);
    await waitFor(() => ticks > t0 + 40, 10_000, 'ticks 2');
    const a = room.getPlayerDiscProperties(1);
    room.setDiscProperties(0, { x: a.x + 25.5, y: a.y, xspeed: 0, yspeed: 0 });
    await sleep(100);
    alice.room.setKeyState(Input.Kick);
    await until('onPlayerBallKick', 1);
    alice.room.setKeyState(0);
    await until('onPlayerInput', 4);
    room.setDiscProperties(0, { x: -360, y: 0, xspeed: -8, yspeed: 0 });
    await until('onPositionsReset', 1);
    log.push(['getters (reset)', copy(room.getScores()?.red), copy(room.getScores()?.blue), copy(room.getBallPosition())]);
    room.stopGame();
    await until('onGameStop', 2);

    // kicks: host, admin client; leave
    room.kickPlayer(2, 'bye', false);
    await until('onPlayerKicked', 1);
    const carol = await join(env, roomId, 'carol', { authObj: auths[2] });
    clients.push(carol);
    await until('onPlayerJoin', 3);
    alice.room.kickPlayer(3, 'admin kick', false);
    await until('onPlayerKicked', 2);
    alice.leave();
    await until('onPlayerLeave', 3);
    log.push(['final', copy(room.getPlayerList())]);
    return log;
  } finally {
    for (const c of clients) c.leave();
  }
}

describe('parity with the official headless HBInit', () => {
  it('same callbacks, arguments, order, microtask semantics and getters', async () => {
    // ---- official
    const waiter = env.master.waitForRoom();
    const officialRoom = official.HBInit({ roomName: 'parity', playerName: 'Host', token: 'thr1.test', maxPlayers: 8 });
    const links: string[] = [];
    officialRoom.onRoomLink = (l: string) => links.push(l);
    const fake = await withTimeout(waiter, 15_000, 'official room registration');
    await waitFor(() => links.length > 0, 10_000, 'official room link');
    expect(links[0]).toBe(`https://www.haxball.com/play?c=${fake.id}`);
    const officialTrace = await scenario(officialRoom, fake.id);
    official.dispose();

    // ---- haxlite
    const { room, roomId } = await startRoom(env, { roomName: 'parity', playerName: 'Host', maxPlayers: 8 });
    let ourTrace: Any[][];
    try {
      ourTrace = await scenario(room, roomId);
    } finally {
      await room.haxlite.stop();
    }

    if (process.env.PARITY_DUMP) require('node:fs').writeFileSync(process.env.PARITY_DUMP, JSON.stringify({ officialTrace, ourTrace }, null, 1));
    expect(officialTrace.length).toBeGreaterThan(30);
    expect(ourTrace).toEqual(officialTrace);
  });
});
