/**
 * room.haxlite extensions, offline E2E: pre-WebRTC join hook (async),
 * IP/CIDR/auth bans, join rate limit, onBeforeOperation, netcode knobs,
 * player connection info.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventType } from '../../src/protocol.js';
import { SendChatIndicatorEvent, SetPlayerSyncEvent, type SendChatEvent } from '../../src/room/index.js';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, withTimeout, type Any, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

const rejectionsSince = (n: number) => env.master.rejections.slice(n).map((r) => r.code);

describe('room.haxlite extensions', () => {
  it('onJoinRequest (async), bans (ip / range / auth), onBeforeOperation, knobs', async () => {
    const { room, roomId } = await startRoom(env, { noPlayer: true });
    const joins: string[] = [];
    room.onPlayerJoin = (p) => joins.push(p.name);
    try {
      // ---- async pre-join hook: sees the IP before any WebRTC object exists
      const requests: Any[] = [];
      room.haxlite.onJoinRequest = async (req) => {
        requests.push(req);
        await sleep(20);
        return requests.length === 1 ? { reject: 4101 } : undefined;
      };
      let n = env.master.rejections.length;
      await expect(join(env, roomId, 'first')).rejects.toBeTruthy();
      expect(rejectionsSince(n)).toEqual([4101]);
      expect(requests[0]).toMatchObject({ ip: '127.0.0.1', version: 9, password: null });
      const a = await join(env, roomId, 'second');
      expect(joins).toEqual(['second']);
      room.haxlite.onJoinRequest = null;

      // ---- connection info
      const info = room.haxlite.getPlayerConnection(1)!;
      expect(info).toMatchObject({ ip: '127.0.0.1', conn: Buffer.from('127.0.0.1').toString('hex').toUpperCase() });
      expect(typeof info.auth).toBe('string');
      expect(room.haxlite.getPlayerConnection(0)).toBeNull();

      // ---- CIDR range ban (signaling time, 4102), then removal
      const rec = room.haxlite.bans.addRange('127.0.0.0/8', 'loopback');
      expect(room.haxlite.bans.isIpBanned('127.1.2.3')).toBe(true);
      n = env.master.rejections.length;
      await expect(join(env, roomId, 'ranged')).rejects.toBeTruthy();
      expect(rejectionsSince(n)).toEqual([4102]);
      // clearBans (official) keeps explicit haxlite bans
      room.clearBans();
      expect(room.haxlite.bans.list().map((b) => b.id)).toEqual([rec.id]);
      expect(room.haxlite.bans.remove(rec.id)).toBe(true);

      // ---- single IP ban
      const ipRec = room.haxlite.bans.addIp('127.0.0.1');
      n = env.master.rejections.length;
      await expect(join(env, roomId, 'ipbanned')).rejects.toBeTruthy();
      expect(rejectionsSince(n)).toEqual([4102]);
      room.haxlite.bans.remove(ipRec.id);

      // ---- auth ban: refused after the handshake, never joins
      const [authKey, authObj] = (await env.nh.Utils.generateAuth()) as [string, Any];
      room.haxlite.bans.addAuth(authKey.split('.')[1]!);
      // (node-haxball ignores the pre-snapshot kick notice, so the attempt just never opens)
      await expect(join(env, roomId, 'authbanned', { authObj, timeoutMs: 2500 })).rejects.toBeTruthy();
      expect(joins).toEqual(['second']);
      room.haxlite.bans.clear();
      expect(room.haxlite.bans.list()).toEqual([]);

      // ---- onBeforeOperation: drop chat containing "spam", rewrite "bad" -> "***"
      const seen: number[] = [];
      room.haxlite.onBeforeOperation = (ev, byId) => {
        if (ev.type !== EventType.SendChat) return true;
        seen.push(byId);
        const chat = ev as SendChatEvent;
        if (chat.message.includes('spam')) return false;
        chat.message = chat.message.replace('bad', '***');
        return true;
      };
      const chats: string[] = [];
      room.onPlayerChat = (_p, msg) => {
        chats.push(msg);
      };
      const b = await join(env, roomId, 'third');
      a.room.sendChat('buy spam');
      a.room.sendChat('bad word');
      await waitFor(() => b.chats.length >= 1, 5000, 'chat');
      await sleep(100);
      expect(b.chats).toEqual([[1, '*** word']]);
      expect(seen).toEqual([1, 1]);
      // onPlayerChat runs before onBeforeOperation (official filter first), so it saw both originals
      expect(chats).toEqual(['buy spam', 'bad word']);
      room.haxlite.onBeforeOperation = null;

      // ---- netcode knobs: live-tunable, validated; clients keep working
      expect(room.haxlite.inputDelayFrames).toBe(2);
      expect(room.haxlite.heartbeatFrames).toBe(7);
      expect(() => (room.haxlite.inputDelayFrames = 0)).toThrow(RangeError);
      expect(() => (room.haxlite.heartbeatFrames = 1.5)).toThrow(RangeError);
      room.haxlite.inputDelayFrames = 3;
      room.haxlite.heartbeatFrames = 2;
      room.setPlayerTeam(1, 1);
      room.setPlayerTeam(2, 2);
      room.startGame();
      await waitFor(() => a.room.gameState != null && b.room.gameState != null, 5000, 'game on clients');
      a.room.setKeyState(8);
      await sleep(500);
      a.room.setKeyState(0);
      room.pauseGame(true);
      await sleep(700);
      const hostX = room.getPlayerDiscProperties(1)!.x;
      const clientDisc = a.room.state.players.find((p: Any) => p.id === 1).disc;
      expect(Math.abs(clientDisc.pos.x - hostX)).toBeLessThan(1e-9);
      expect(room.haxlite.frame).toBeGreaterThan(0);

      // ---- setMaxPlayers: full room -> 4100
      room.haxlite.setMaxPlayers(2);
      n = env.master.rejections.length;
      await expect(join(env, roomId, 'overflow')).rejects.toBeTruthy();
      expect(rejectionsSince(n)).toEqual([4100]);
      a.leave();
      b.leave();
    } finally {
      await room.haxlite.stop();
    }
  });

  it('join rate limit per IP and allowNullAuth option are passed to the transport', async () => {
    const { room, roomId } = await startRoom(env, { haxlite: { joinRateLimit: { capacity: 1, msPerToken: 60_000 }, allowNullAuth: false } });
    try {
      const a = await join(env, roomId, 'one');
      const n = env.master.rejections.length;
      await expect(join(env, roomId, 'two')).rejects.toBeTruthy();
      expect(rejectionsSince(n)).toEqual([4104]);
      a.leave();
      await withTimeout(a.closed, 5000, 'leave');
    } finally {
      await room.haxlite.stop();
    }
  });

  it('getTeamColors reads the kit natively and onTeamColorsChange reports changes', async () => {
    const { room } = await startRoom(env);
    try {
      expect(room.haxlite.getTeamColors(0)).toBeNull();
      expect(room.haxlite.getTeamColors(1)).toEqual({ angle: 0, textColor: 0xffffff, colors: [0xe56e56] });
      expect(room.haxlite.getTeamColors(2)).toEqual({ angle: 0, textColor: 0xffffff, colors: [0x5689e5] });

      const changes: Any[] = [];
      room.haxlite.onTeamColorsChange = (team, colors, by) => changes.push([team, colors, by?.id ?? null]);
      room.setTeamColors(1, 90, 0x112233, [0xff0000, 0x00ff00, 0x0000ff]);
      await waitFor(() => changes.length >= 1, 5000, 'team colors');
      expect(room.haxlite.getTeamColors(1)).toEqual({ angle: 90, textColor: 0x112233, colors: [0xff0000, 0x00ff00, 0x0000ff] });
      expect(changes[0]).toEqual([1, { angle: 90, textColor: 0x112233, colors: [0xff0000, 0x00ff00, 0x0000ff] }, 0]);

      // what the getter returns is what the setter takes: swapping kits leaves no residue
      const red = room.haxlite.getTeamColors(1)!;
      const blue = room.haxlite.getTeamColors(2)!;
      room.setTeamColors(1, blue.angle, blue.textColor, blue.colors);
      room.setTeamColors(2, red.angle, red.textColor, red.colors);
      await waitFor(() => changes.length >= 3, 5000, 'swap');
      expect(room.haxlite.getTeamColors(1)).toEqual(blue);
      expect(room.haxlite.getTeamColors(2)).toEqual(red);

      // a returned object is a copy
      room.haxlite.getTeamColors(1)!.colors.push(0);
      expect(room.haxlite.getTeamColors(1)!.colors).toEqual(blue.colors);
    } finally {
      await room.haxlite.stop();
    }
  });

  it('getConnectionQuality measures a real client: pings, inputs, verdict, history', async () => {
    const { room, roomId } = await startRoom(env);
    try {
      expect(room.haxlite.getConnectionQuality(0)).toBeNull();
      expect(room.haxlite.getConnectionQuality(99)).toBeNull();
      const a = await join(env, roomId, 'alice');
      await waitFor(() => (room.haxlite.getConnectionQuality(1)?.totals.pings ?? 0) >= 2, 8000, 'pings');
      const q = room.haxlite.getConnectionQuality(1)!;
      expect(q.playerId).toBe(1);
      expect(q.totals.lostPings).toBe(0);
      expect(q.history.length).toBeGreaterThanOrEqual(1);
      expect(q.history.at(-1)).toMatchObject({ lostPings: 0, hostLag: expect.any(Number) });
      expect(JSON.parse(JSON.stringify(q))).toEqual(q); // plain data
      a.leave();
      await withTimeout(a.closed, 5000, 'leave');
      await waitFor(() => room.haxlite.getConnectionQuality(1) === null, 5000, 'gone');
    } finally {
      await room.haxlite.stop();
    }
  });

  it('getRoomSettings, getGameInfo and getPlayerInfo expose state the official API hides', async () => {
    const { room, roomId } = await startRoom(env, { roomName: 'Kit room' });
    try {
      expect(room.haxlite.getRoomSettings()).toEqual({ name: 'Kit room', teamsLocked: false, scoreLimit: 3, timeLimit: 3, stadium: 'Classic' });
      expect(room.haxlite.getGameInfo()).toBeNull();
      expect(room.haxlite.getPlayerInfo(99)).toBeNull();

      room.setTeamsLock(true);
      room.setScoreLimit(5);
      room.setTimeLimit(7);
      await waitFor(() => room.haxlite.getRoomSettings().teamsLocked, 5000, 'lock');
      expect(room.haxlite.getRoomSettings()).toMatchObject({ teamsLocked: true, scoreLimit: 5, timeLimit: 7 });

      const a = await join(env, roomId, 'alice');
      expect(room.haxlite.getPlayerInfo(1)).toMatchObject({ flag: expect.anything(), desync: false, avatar: null, headlessAvatar: null });
      room.setPlayerAvatar(1, 'ab');
      await waitFor(() => room.haxlite.getPlayerInfo(1)!.headlessAvatar === 'ab', 5000, 'avatar');
      room.setPlayerTeam(1, 1);
      room.startGame();
      await waitFor(() => room.haxlite.getGameInfo() !== null, 5000, 'game');
      expect(room.haxlite.getGameInfo()).toEqual({ phase: 'beforeKickOff', paused: false, kickOffTeam: 1 });
      room.pauseGame(true);
      await waitFor(() => room.haxlite.getGameInfo()?.paused === true, 5000, 'pause');
      room.stopGame();
      await waitFor(() => room.haxlite.getGameInfo() === null, 5000, 'stop');
      a.leave();
      await withTimeout(a.closed, 5000, 'leave');
    } finally {
      await room.haxlite.stop();
    }
  });

  it('getStadium reads the map as plain data; getKickRateLimit and getRecordingInfo read what was write-only', async () => {
    const { room } = await startRoom(env);
    try {
      const classic = room.haxlite.getStadium()!;
      expect(classic).toMatchObject({ name: 'Classic', builtInId: 0, cameraFollow: 'ball' });
      expect(classic.goals.map((g) => g.team).sort()).toEqual([1, 2]);
      expect(classic.discs.length).toBeGreaterThan(0);
      for (const sg of classic.segments) {
        expect(sg.v0).toBeLessThan(classic.vertexes.length);
        expect(sg.v1).toBeLessThan(classic.vertexes.length);
      }
      expect(JSON.parse(JSON.stringify(classic))).toEqual(classic); // plain, JSON-safe

      room.setCustomStadium(`{
        "name" : "Curvy", "width" : 300, "height" : 150, "spawnDistance" : 100,
        "bg" : { "type" : "hockey", "width" : 250, "height" : 120, "kickOffRadius" : 60 },
        "vertexes" : [ { "x" : -250, "y" : 120 }, { "x" : 250, "y" : 120 }, { "x" : 0, "y" : -120 } ],
        "segments" : [ { "v0" : 0, "v1" : 1, "curve" : 90 }, { "v0" : 1, "v1" : 2 } ],
        "goals" : [ { "p0" : [-250, -40], "p1" : [-250, 40], "team" : "red" }, { "p0" : [250, 40], "p1" : [250, -40], "team" : "blue" } ],
        "discs" : [ { "radius" : 10, "invMass" : 1, "cGroup" : ["ball", "kick", "score"] } ],
        "joints" : [ { "d0" : 0, "d1" : 0, "length" : 10, "strength" : "rigid" } ],
        "planes" : [ { "normal" : [0, 1], "dist" : -120 } ],
        "redSpawnPoints" : [ [-100, 0] ], "traits" : {}, "playerPhysics" : {}, "ballPhysics" : "disc0"
      }`);
      await waitFor(() => room.haxlite.getStadium()?.name === 'Curvy', 5000, 'stadium');
      const st = room.haxlite.getStadium()!;
      expect(st).toMatchObject({ builtInId: null, bg: { type: 'hockey', width: 250, kickOffRadius: 60 } });
      expect(st.goals).toEqual([
        { p0: [-250, -40], p1: [-250, 40], team: 1 },
        { p0: [250, 40], p1: [250, -40], team: 2 },
      ]);
      expect(st.segments[0]!.curve).toBeCloseTo(90, 5);
      expect(st.segments[1]!.curve).toBe(0);
      expect(st.joints[0]!.strength).toBe('rigid');
      expect(st.redSpawnPoints).toEqual([[-100, 0]]);
      expect(JSON.parse(JSON.stringify(st))).toEqual(st);

      expect(room.haxlite.getKickRateLimit()).toEqual({ min: 2, rate: 0, burst: 0, max: 1 });
      room.setKickRateLimit(3, 1, 2);
      await waitFor(() => room.haxlite.getKickRateLimit().min === 3, 5000, 'kick rate');
      expect(room.haxlite.getKickRateLimit()).toEqual({ min: 3, rate: 1, burst: 2, max: 2 });

      expect(room.haxlite.getRecordingInfo()).toEqual({ recording: false, frames: 0, events: 0, bytes: 0 });
      room.startRecording();
      expect(room.haxlite.getRecordingInfo()).toMatchObject({ recording: true, frames: expect.any(Number) });
      expect(room.haxlite.getRecordingInfo().bytes).toBeGreaterThan(0);
      room.stopRecording();
      expect(room.haxlite.getRecordingInfo().recording).toBe(false);
    } finally {
      await room.haxlite.stop();
    }
  });

  it('onChatIndicator, onPlayerDesyncChange and onTimeLimitReached reach room.haxlite', async () => {
    const { room, roomId } = await startRoom(env);
    try {
      const a = await join(env, roomId, 'alice');
      const log: Any[][] = [];
      room.haxlite.onChatIndicator = (p, typing) => log.push(['typing', p.name, typing]);
      room.haxlite.onPlayerDesyncChange = (p, desync) => log.push(['desync', p.name, desync]);
      room.haxlite.onTimeLimitReached = () => log.push(['time']);
      const state = room.haxlite.host.state;
      const fire = (e: Any) => {
        e.byId = 1;
        e.apply(state);
      };
      fire(SendChatIndicatorEvent.create(1));
      fire(SendChatIndicatorEvent.create(0));
      fire(SetPlayerSyncEvent.create(true));
      fire(SetPlayerSyncEvent.create(true)); // no change: no call
      expect(room.haxlite.getPlayerInfo(1)!.desync).toBe(true);
      fire(SetPlayerSyncEvent.create(false));
      expect(log).toEqual([
        ['typing', 'alice', true],
        ['typing', 'alice', false],
        ['desync', 'alice', true],
        ['desync', 'alice', false],
      ]);

      // time limit with an untied score: the hook fires right before the game ends
      room.setTimeLimit(1);
      room.setPlayerTeam(1, 1);
      await waitFor(() => room.getPlayer(1)?.team === 1, 5000, 'team');
      room.startGame();
      await waitFor(() => room.haxlite.host.state.gameState !== null, 5000, 'game');
      const gs = room.haxlite.host.state.gameState!;
      gs.phase = 1; // Playing: the clock only counts then
      gs.redScore = 1;
      gs.timeElapsed = 60;
      await waitFor(() => log.some((l) => l[0] === 'time'), 5000, 'time limit');
      a.leave();
      await withTimeout(a.closed, 5000, 'leave');
    } finally {
      await room.haxlite.stop();
    }
  });

  it('trackTouches is opt-in and getLastTouches / onPlayerTouch report the ball touches', async () => {
    const { room, roomId } = await startRoom(env);
    try {
      const a = await join(env, roomId, 'alice');
      expect(room.haxlite.trackTouches).toBe(false);
      expect(room.haxlite.getLastTouches()).toBeNull();
      room.haxlite.trackTouches = true;
      expect(room.haxlite.trackTouches).toBe(true);
      expect(room.haxlite.getLastTouches()).toEqual({ last: null, previous: null });

      const log: Any[][] = [];
      room.haxlite.onPlayerTouch = (p, prev) => log.push([p.name, prev === null ? null : prev.name]);
      room.setPlayerTeam(1, 1);
      await waitFor(() => room.getPlayer(1)?.team === 1, 5000, 'team');
      room.startGame();
      await waitFor(() => room.haxlite.host.state.gameState !== null, 5000, 'game');
      const gs = room.haxlite.host.state.gameState!;
      gs.phase = 1;
      const ball = gs.world.discs[0]!;
      const me = room.haxlite.host.state.players.find((p) => p.id === 1)!.disc!;
      ball.x = 0;
      ball.y = 0;
      ball.xspeed = ball.yspeed = 0;
      me.x = -(ball.radius + me.radius);
      me.y = 0;
      me.xspeed = me.yspeed = 0;
      await waitFor(() => log.length > 0, 5000, 'touch');
      expect(log[0]).toEqual(['alice', null]);
      expect(room.haxlite.getLastTouches()).toMatchObject({ last: { playerId: 1, team: 1, kick: false }, previous: null });

      room.haxlite.trackTouches = false;
      expect(room.haxlite.getLastTouches()).toBeNull();
      a.leave();
      await withTimeout(a.closed, 5000, 'leave');
    } finally {
      await room.haxlite.stop();
    }
  });
});
