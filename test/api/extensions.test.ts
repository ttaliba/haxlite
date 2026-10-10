/**
 * room.haxlite extensions, offline E2E: pre-WebRTC join hook (async),
 * IP/CIDR/auth bans, join rate limit, onBeforeOperation, netcode knobs,
 * player connection info.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventType } from '../../src/protocol.js';
import type { SendChatEvent } from '../../src/room/index.js';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, withTimeout, type Any, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  shutdownAll();
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
});
