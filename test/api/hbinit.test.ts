/**
 * HBInit facade, offline E2E: FakeMaster + node-haxball clients.
 * Callback shapes/order, onPlayerChat filtering, getters, stadiums,
 * recording, kicks/bans, microtask semantics, recaptcha flow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HBInit, InvalidRoomTokenError, type RoomObject } from '../../src/api/index.js';
import { Input } from '../../src/protocol.js';
import { ReplayPlayer } from '../../src/replay/index.js';
import { join, recordCallbacks, shutdownAll, sleep, startEnv, startRoom, waitFor, withTimeout, type Any, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

const HBS = `{
  "name" : "Tiny test",
  "width" : 300, "height" : 150,
  "spawnDistance" : 100,
  "bg" : { "type" : "grass", "width" : 250, "height" : 120, "kickOffRadius" : 60 },
  "vertexes" : [ { "x" : -250, "y" : 120 }, { "x" : 250, "y" : 120 } ],
  "segments" : [ { "v0" : 0, "v1" : 1 } ],
  "goals" : [ { "p0" : [-250, -40], "p1" : [-250, 40], "team" : "red" }, { "p0" : [250, 40], "p1" : [250, -40], "team" : "blue" } ],
  "discs" : [ { "radius" : 10, "invMass" : 1, "cGroup" : ["ball", "kick", "score"] } ],
  "planes" : [ { "normal" : [0, 1], "dist" : -120 }, { "normal" : [0, -1], "dist" : -120 } ],
  "traits" : {},
  "playerPhysics" : {},
  "ballPhysics" : "disc0"
}`;

const nameOf = (o: Any) => (o == null ? null : o.name);

describe('HBInit facade (official API)', () => {
  it('room creation, link, room info, geo, config casts', async () => {
    await expect(HBInit({ maxPlayers: 3.5, haxlite: { masterUrl: env.master.httpBase } })).rejects.toThrow(/Cannot cast/);
    await expect(HBInit({ geo: { code: 'ABCD', lat: 0, lon: 0 } })).rejects.toThrow('Invalid country code');
    const waiter = env.master.waitForRoom();
    const { room, roomId } = await startRoom(env, {
      roomName: 'api test',
      maxPlayers: 40,
      public: true,
      haxlite: { transport: { roomInfoThrottleMs: 100 } },
    });
    try {
      const fake = await waiter;
      expect(fake.id).toBe(roomId);
      expect(room.haxlite.roomLink).toBe(`https://www.haxball.com/play?c=${roomId}`);
      // a handler set after `await HBInit` still gets the link, also when the
      // script wraps it in the same tick (try/catch wrapper over every on*)
      const links: string[] = [];
      room.onRoomLink = (l) => links.push(`raw:${l}`);
      const original = room.onRoomLink;
      room.onRoomLink = (l) => {
        links.push('wrapped');
        original(l);
      };
      await sleep(0);
      expect(links).toEqual(['wrapped', `raw:${room.haxlite.roomLink}`]);
      // RoomInfo: name, geo from api/geo (fake: AR), clamped maxPlayers, host player not counted
      await waitFor(() => fake.info !== null, 5000, 'room info');
      expect(fake.info).toMatchObject({ name: 'api test', flag: 'ar', maxPlayers: 30, players: 0, password: false });
      expect(room.getPlayerList()).toEqual([{ name: 'Host', team: 0, id: 0, admin: true, position: null, input: 0 }]);
      room.setPassword('pw');
      await waitFor(() => fake.info?.password === true, 5000, 'password published');
      expect(() => room.setPassword(5 as Any)).toThrow(/Cannot cast/);
    } finally {
      await room.haxlite.stop();
    }
    expect(room.haxlite.stopped).toBe(true);
  });

  it('invalid token rejects with InvalidRoomTokenError; recaptcha flow with useRecaptchaToken', async () => {
    await expect(HBInit({ token: 'invalid', haxlite: { masterUrl: env.master.httpBase, iceServers: [] } })).rejects.toBeInstanceOf(
      InvalidRoomTokenError,
    );
    const seen: string[] = [];
    const room = await HBInit({
      token: 'expired',
      haxlite: {
        masterUrl: env.master.httpBase,
        iceServers: [],
        shutdownWebRtcOnLastStop: false,
        onRecaptcha: (sitekey, use) => {
          seen.push(sitekey);
          use('captcha-response');
        },
      },
    });
    expect(seen).toEqual(['fake-sitekey']);
    expect(env.master.hostRequests.at(-1)).toEqual({ token: 'expired', rcr: 'captcha-response' });
    expect(room.haxlite.roomLink).toMatch(/^https:\/\/www\.haxball\.com\/play\?c=/);
    await room.haxlite.stop();
  });

  it('callbacks: shapes, order and microtask semantics through a full client-driven session', async () => {
    const { room, roomId } = await startRoom(env, { roomName: 'cb', playerName: 'Host' });
    const log = recordCallbacks(room);
    const ticks = { n: 0 };
    room.onGameTick = () => ticks.n++;
    const activity: string[] = [];
    room.onPlayerActivity = (p) => activity.push(`act:${p.name}`);
    room.onPlayerInput = (p, prev) => activity.push(`in:${p.name}:${prev}->${p.input}`);
    const parity: Any[] = [];
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => errors.push(e);
    try {
      // ---- join: admin to the first player (classic script), microtask semantics
      const joinLog = log as Any[];
      room.onPlayerJoin = (p) => {
        joinLog.push(['onPlayerJoin', JSON.parse(JSON.stringify(p))]);
        if (p.id === 1) {
          room.setPlayerAdmin(p.id, true);
          parity.push(['sync', room.getPlayer(p.id)!.admin]);
          queueMicrotask(() => parity.push(['micro', room.getPlayer(p.id)!.admin]));
        }
      };
      const [authKey, authObj] = (await env.nh.Utils.generateAuth()) as [string, Any];
      const alice = await join(env, roomId, 'alice', { authObj, avatar: 'A', flag: 'ar' });
      await waitFor(() => alice.room.players.find((p: Any) => p.id === 1)?.isAdmin === true, 5000, 'alice admin');
      expect(parity).toEqual([
        ['sync', false],
        ['micro', true],
      ]);
      const bob = await join(env, roomId, 'bob');
      const conn = Buffer.from('127.0.0.1').toString('hex').toUpperCase();
      expect(log.slice(0, 3)).toEqual([
        ['onPlayerJoin', { name: 'alice', team: 0, id: 1, admin: false, position: null, input: 0, auth: authKey.split('.')[1], conn }],
        [
          'onPlayerAdminChange',
          { name: 'alice', team: 0, id: 1, admin: true, position: null, input: 0 },
          { name: 'Host', team: 0, id: 0, admin: true, position: null, input: 0 },
        ],
        ['onPlayerJoin', expect.objectContaining({ name: 'bob', id: 2, admin: false, conn })],
      ]);
      expect(Object.keys(log[0]![1])).toEqual(['name', 'team', 'id', 'admin', 'position', 'input', 'auth', 'conn']);
      const conn1 = room.haxlite.getPlayerConnection(1)!;
      expect(conn1).toMatchObject({ auth: authKey.split('.')[1], conn, ip: '127.0.0.1' });
      log.length = 0;

      // ---- chat: filter returning false drops the message for everybody
      room.onPlayerChat = (p, msg) => {
        log.push(['onPlayerChat', p.name, msg]);
        return msg !== 'secret';
      };
      alice.room.sendChat('hello');
      alice.room.sendChat('secret');
      alice.room.sendChat('after');
      await waitFor(() => bob.chats.some(([, m]) => m === 'after'), 5000, 'bob gets chat');
      await sleep(100);
      expect(bob.chats).toEqual([
        [1, 'hello'],
        [1, 'after'],
      ]);
      expect(alice.chats.map(([, m]) => m)).toEqual(['hello', 'after']);
      expect(log).toEqual([
        ['onPlayerChat', 'alice', 'hello'],
        ['onPlayerChat', 'alice', 'secret'],
        ['onPlayerChat', 'alice', 'after'],
      ]);
      log.length = 0;
      // host chat + private announcement
      room.sendChat('from host');
      room.sendAnnouncement('only bob', 2, 0xff0000, 'bold', 2);
      await waitFor(() => bob.chats.some(([, m]) => m === 'from host') && bob.announcements.includes('only bob'), 5000, 'host msgs');
      await sleep(100);
      expect(alice.announcements).toEqual([]);
      expect(log).toEqual([]); // the host's own chat does not go through onPlayerChat

      // ---- teams: by an admin client and by the host
      alice.room.setPlayerTeam(2, 2);
      await waitFor(() => log.length >= 1, 5000, 'team change by alice');
      room.setPlayerTeam(1, 1);
      await waitFor(() => log.length >= 2, 5000, 'team change by host');
      expect(log).toEqual([
        ['onPlayerTeamChange', expect.objectContaining({ name: 'bob', team: 2 }), expect.objectContaining({ name: 'alice', id: 1 })],
        ['onPlayerTeamChange', expect.objectContaining({ name: 'alice', team: 1 }), expect.objectContaining({ name: 'Host', id: 0 })],
      ]);
      log.length = 0;

      // ---- settings
      room.setTeamsLock(true);
      room.setKickRateLimit(3, 1, 2);
      room.setScoreLimit(1);
      room.setTimeLimit(2);
      expect(() => room.setDefaultStadium('Nope')).toThrow("Stadium doesn't exist");
      expect(() => room.setCustomStadium('{ not json')).toThrow();
      room.setCustomStadium(HBS);
      await waitFor(() => log.length >= 3, 5000, 'settings');
      expect(log).toEqual([
        ['onTeamsLockChange', true, expect.objectContaining({ id: 0 })],
        ['onKickRateLimitSet', 3, 1, 2, expect.objectContaining({ id: 0 })],
        ['onStadiumChange', 'Tiny test', expect.objectContaining({ id: 0 })],
      ]);
      await waitFor(() => alice.room.stadium?.name === 'Tiny test', 5000, 'client stadium');
      log.length = 0;
      room.setDefaultStadium('Classic');
      await waitFor(() => log.length >= 1, 5000, 'classic');
      log.length = 0;

      // ---- game start by an admin client; getters
      expect(room.getScores()).toBeNull();
      expect(room.getBallPosition()).toBeNull();
      expect(room.getDiscCount()).toBe(0);
      expect(room.getDiscProperties(0)).toBeNull();
      room.startRecording();
      alice.room.startGame();
      await waitFor(() => ticks.n > 30, 5000, 'game ticks');
      expect(log[0]).toEqual(['onGameStart', expect.objectContaining({ name: 'alice', id: 1, admin: true })]);
      const scores = room.getScores()!;
      expect(Object.keys(scores)).toEqual(['red', 'blue', 'time', 'scoreLimit', 'timeLimit']);
      expect(scores).toMatchObject({ red: 0, blue: 0, scoreLimit: 1, timeLimit: 120 });
      expect(scores.time).toBe(0); // kick-off: the clock starts with the first touch
      expect(room.getBallPosition()).toEqual({ x: 0, y: 0 });
      const pa = room.getPlayer(1)!;
      expect(pa.position).not.toBeNull();
      expect(room.getPlayer(0)!.position).toBeNull();
      expect(room.getPlayer(99)).toBeNull();
      const dp = room.getPlayerDiscProperties(1)!;
      expect(Object.keys(dp)).toEqual([
        'x', 'y', 'xspeed', 'yspeed', 'xgravity', 'ygravity', 'radius', 'bCoeff', 'invMass', 'damping', 'color', 'cMask', 'cGroup',
      ]);
      expect(room.getDiscCount()).toBeGreaterThan(2);
      expect(room.getDiscProperties(0)).toMatchObject({ radius: 10, x: 0, y: 0 });
      expect(room.getPlayerDiscProperties(0)).toBeNull();
      expect((room.getDiscProperties(0)!.cGroup & room.CollisionFlags.ball) !== 0).toBe(true);
      log.length = 0;

      // ---- input activity + ball kick: put the ball next to alice and kick
      const aliceDisc = room.getPlayerDiscProperties(1)!;
      room.setDiscProperties(0, { x: aliceDisc.x + 24, y: aliceDisc.y, xspeed: 0, yspeed: 0 });
      await sleep(50);
      alice.room.setKeyState(Input.Kick);
      await waitFor(() => log.some((l) => l[0] === 'onPlayerBallKick'), 5000, 'ball kick');
      alice.room.setKeyState(0);
      expect(log.find((l) => l[0] === 'onPlayerBallKick')).toEqual(['onPlayerBallKick', expect.objectContaining({ name: 'alice', input: Input.Kick })]);
      await waitFor(() => activity.length >= 4, 5000, 'activity');
      await waitFor(() => room.getScores()!.time > 0, 5000, 'clock running');
      expect(activity.slice(0, 4)).toEqual(['act:alice', `in:alice:0->${Input.Kick}`, 'act:alice', `in:alice:${Input.Kick}->0`]);
      log.length = 0;

      // ---- pause / unpause by the host
      room.pauseGame(true);
      await waitFor(() => log.length >= 1, 5000, 'pause');
      const t0 = ticks.n;
      await sleep(150);
      expect(ticks.n).toBe(t0); // no ticks while paused
      room.pauseGame(false);
      await waitFor(() => log.length >= 2, 5000, 'unpause');
      expect(log).toEqual([
        ['onGamePause', expect.objectContaining({ id: 0 })],
        ['onGameUnpause', expect.objectContaining({ id: 0 })],
      ]);
      await waitFor(() => ticks.n > t0 + 10, 5000, 'ticks resume');
      log.length = 0;

      // ---- goal -> victory (score limit 1) -> stop
      room.setDiscProperties(0, { x: 360, y: 0, xspeed: 8, yspeed: 0 });
      await waitFor(() => log.some((l) => l[0] === 'onGameStop'), 10_000, 'game end');
      expect(log.map((l) => l[0])).toEqual(['onTeamGoal', 'onTeamVictory', 'onGameStop']);
      expect(log[0]).toEqual(['onTeamGoal', 1]);
      expect(log[1]![1]).toMatchObject({ red: 1, blue: 0, scoreLimit: 1, timeLimit: 120 });
      expect(log[2]).toEqual(['onGameStop', null]);
      expect(room.getScores()).toBeNull();
      const replay = room.stopRecording()!;
      expect(room.stopRecording()).toBeNull();
      // node-haxball reads our replay; our player re-simulates it
      const data = env.nh.Replay.readAll(Uint8Array.from(replay));
      expect(data.version).toBe(3);
      expect(data.totalFrames).toBeGreaterThan(100);
      expect(data.goalMarkers.length).toBe(1);
      expect(new ReplayPlayer(replay).finish().gameState).toBeNull();
      log.length = 0;

      // ---- positions reset after a goal (no score limit)
      room.setScoreLimit(0);
      room.startGame();
      await waitFor(() => log.length >= 1, 5000, 'start');
      room.setDiscProperties(0, { x: -360, y: 0, xspeed: -8, yspeed: 0 });
      await waitFor(() => log.some((l) => l[0] === 'onPositionsReset'), 10_000, 'reset');
      expect(log.map((l) => l[0])).toEqual(['onGameStart', 'onTeamGoal', 'onPositionsReset']);
      expect(log[0]).toEqual(['onGameStart', expect.objectContaining({ id: 0 })]);
      expect(log[1]).toEqual(['onTeamGoal', 2]);
      room.stopGame();
      await waitFor(() => log.length >= 4, 5000, 'stop');
      expect(log[3]).toEqual(['onGameStop', expect.objectContaining({ id: 0 })]);
      log.length = 0;

      // ---- kicks: by the host (leave then kicked), by an admin client, ban + clearBans
      const carol = await join(env, roomId, 'carol');
      const dave = await join(env, roomId, 'dave');
      log.length = 0;
      room.kickPlayer(2, 'bye');
      await withTimeout(bob.closed, 10_000, 'bob kicked');
      alice.room.kickPlayer(3, 'admin kick', false);
      await withTimeout(carol.closed, 10_000, 'carol kicked');
      room.kickPlayer(4, 'banned', true);
      await withTimeout(dave.closed, 10_000, 'dave banned');
      await waitFor(() => log.length >= 6, 5000, 'kick callbacks');
      expect(log.map((l) => [l[0], nameOf(l[1]), l[2], l[3], nameOf(l[4])])).toEqual([
        ['onPlayerLeave', 'bob', undefined, undefined, null],
        ['onPlayerKicked', 'bob', 'bye', false, 'Host'],
        ['onPlayerLeave', 'carol', undefined, undefined, null],
        ['onPlayerKicked', 'carol', 'admin kick', false, 'alice'],
        ['onPlayerLeave', 'dave', undefined, undefined, null],
        ['onPlayerKicked', 'dave', 'banned', true, 'Host'],
      ]);
      expect(room.haxlite.bans.list().map((b) => b.kind)).toEqual(['peer']);
      await expect(join(env, roomId, 'dave2')).rejects.toBeTruthy();
      room.clearBans();
      expect(room.haxlite.bans.list()).toEqual([]);
      const dave3 = await join(env, roomId, 'dave3');
      log.length = 0;

      // ---- voluntary leave: onPlayerLeave only
      dave3.leave();
      await waitFor(() => log.length >= 1, 10_000, 'leave');
      expect(log).toEqual([['onPlayerLeave', expect.objectContaining({ name: 'dave3', id: 5 })]]);
      await sleep(100);
      expect(log.length).toBe(1);
      expect(room.getPlayerList().map((p) => p.name)).toEqual(['Host', 'alice']);
      expect(errors).toEqual([]);
      alice.leave();
    } finally {
      await room.haxlite.stop();
    }
  });
});

export type { RoomObject };
