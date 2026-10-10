/**
 * Several HBInit rooms in one process: independent state, callbacks, bans
 * and clients; stopping one leaves the other running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, withTimeout, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  shutdownAll();
});

describe('multiple rooms per process', () => {
  it('two rooms run side by side and stop independently', async () => {
    const A = await startRoom(env, { roomName: 'A', noPlayer: true });
    const B = await startRoom(env, { roomName: 'B', playerName: 'hostB' });
    expect(A.roomId).not.toBe(B.roomId);
    const joinsA: string[] = [];
    const joinsB: string[] = [];
    const chatA: string[] = [];
    const chatB: string[] = [];
    A.room.onPlayerJoin = (p) => {
      joinsA.push(p.name);
      A.room.setPlayerAdmin(p.id, true);
    };
    B.room.onPlayerJoin = (p) => joinsB.push(p.name);
    A.room.onPlayerChat = (p, m) => {
      chatA.push(`${p.name}:${m}`);
    };
    B.room.onPlayerChat = (p, m) => {
      chatB.push(`${p.name}:${m}`);
    };
    try {
      const a1 = await join(env, A.roomId, 'a1');
      const b1 = await join(env, B.roomId, 'b1');
      const a2 = await join(env, A.roomId, 'a2');
      expect(joinsA).toEqual(['a1', 'a2']);
      expect(joinsB).toEqual(['b1']);
      expect(A.room.getPlayerList().map((p) => [p.id, p.name, p.admin])).toEqual([
        [1, 'a1', true],
        [2, 'a2', true],
      ]);
      expect(B.room.getPlayerList().map((p) => [p.id, p.name, p.admin])).toEqual([
        [0, 'hostB', true],
        [1, 'b1', false],
      ]);
      a1.room.sendChat('hi A');
      b1.room.sendChat('hi B');
      await waitFor(() => chatA.length === 1 && chatB.length === 1, 5000, 'chats');
      expect(chatA).toEqual(['a1:hi A']);
      expect(chatB).toEqual(['b1:hi B']);
      // games are independent
      A.room.setPlayerTeam(1, 1);
      A.room.startGame();
      await waitFor(() => A.room.getScores() !== null, 5000, 'A started');
      expect(B.room.getScores()).toBeNull();
      // a ban in A does not affect B
      A.room.kickPlayer(2, 'bye', true);
      await withTimeout(a2.closed, 10_000, 'a2 banned');
      expect(A.room.haxlite.bans.list().length).toBe(1);
      expect(B.room.haxlite.bans.list().length).toBe(0);
      const b2 = await join(env, B.roomId, 'b2');
      expect(joinsB).toEqual(['b1', 'b2']);

      // stopping A leaves B fully functional
      await A.room.haxlite.stop();
      await withTimeout(a1.closed, 15_000, 'a1 disconnected by stop');
      b2.room.sendChat('still here');
      await waitFor(() => chatB.includes('b2:still here'), 5000, 'B alive');
      B.room.startGame();
      await waitFor(() => B.room.getScores() !== null, 5000, 'B started');
      await sleep(200);
      expect(B.room.getScores()!.time).toBe(0);
      b1.leave();
      b2.leave();
    } finally {
      await A.room.haxlite.stop();
      await B.room.haxlite.stop();
    }
  });
});
