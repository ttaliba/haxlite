/**
 * Operator callbacks that throw or return a rejected Promise (offline E2E:
 * FakeMaster + node-haxball). Whatever they do goes to room.haxlite.onError
 * (else console.error): it never becomes an unhandled rejection or an
 * uncaught exception (which would end the process and every room in it),
 * and the frame or event the callback ran in completes as on the clients.
 * A throwing (synchronous) onPlayerChat still drops the sender, like the
 * official host.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomObject } from '../../src/api/index.js';
import { HostRoom } from '../../src/host/index.js';
import { AutoTeamsEvent } from '../../src/room/index.js';
import { hostClock } from '../../src/host/clock.js';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, type Client, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

const unhandled: unknown[] = [];
const uncaught: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);
const onUncaught = (e: unknown) => uncaught.push(e);
beforeEach(() => {
  unhandled.length = uncaught.length = 0;
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtException', onUncaught);
});

const fail = (what: string) => async (): Promise<void> => {
  await sleep(1);
  throw new Error(what);
};
const messages = (errors: unknown[]) => errors.map((e) => (e instanceof Error ? e.message : String(e)));

describe('async callbacks that reject', () => {
  it('chat, join, game start and every tick: reported, the room and the sender carry on', async () => {
    const { room, roomId } = await startRoom(env, { noPlayer: true });
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => void errors.push(e);
    let c: Client | null = null;
    try {
      room.onPlayerJoin = fail('join');
      // the public types say `void | boolean`: scripts declare async callbacks anyway
      room.onPlayerChat = (async (_p: unknown, msg: string) => {
        msg.split(' ')[1]!.toLowerCase(); // TypeError for "!x"
      }) as never;
      c = await join(env, roomId, 'bob');
      c.room.sendChat('!x');
      await waitFor(() => c!.chats.some(([, m]) => m === '!x'), 5000, 'chat broadcast');
      room.onGameStart = fail('start');
      let ticks = 0;
      room.onGameTick = async () => {
        ticks++;
        throw new Error('tick');
      };
      room.startGame();
      await waitFor(() => ticks >= 30, 5000, 'ticks');
      room.onGameTick = null;
      await sleep(50);
      const m = messages(errors);
      expect(m).toContain('join');
      expect(m.some((x) => /toLowerCase/.test(x))).toBe(true);
      expect(m).toContain('start');
      expect(m.filter((x) => x === 'tick').length).toBeGreaterThanOrEqual(30);
      expect(c.closeError).toBeNull();
      expect(room.getPlayerList().map((p) => p.name)).toEqual(['bob']);
      expect(unhandled).toEqual([]);
    } finally {
      c?.leave();
      await room.haxlite.stop();
    }
  });

  it('an async onError that rejects goes to the console, not back to onError', async () => {
    const { room } = await startRoom(env, { noPlayer: true });
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a));
    let calls = 0;
    try {
      room.haxlite.onError = async () => {
        calls++;
        throw new Error('onError failed');
      };
      room.onGameStart = fail('start');
      room.startGame();
      await waitFor(() => logged.length > 0, 5000, 'console.error');
      await sleep(50);
      expect(calls).toBe(1);
      expect(logged[0]![0]).toBe('[haxlite]');
      expect((logged[0]![1] as Error).message).toBe('onError failed');
      expect(unhandled).toEqual([]);
    } finally {
      spy.mockRestore();
      await room.haxlite.stop();
    }
  });

  it('haxlite callbacks: onBeforeOperation (the getter returns the same function), onPrivateViewEnd', async () => {
    const { room } = await startRoom(env, { noPlayer: true });
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => void errors.push(e);
    try {
      const before = (async () => {
        throw new Error('before');
      }) as never;
      room.haxlite.onBeforeOperation = before;
      expect(room.haxlite.onBeforeOperation).toBe(before);
      // a Promise allows the event (only `false` refuses it)
      expect(room.haxlite.host.onBeforeOperation!({} as never, 1, 0)).not.toBe(false);
      const end = fail('view end');
      room.haxlite.onPrivateViewEnd = end;
      expect(room.haxlite.onPrivateViewEnd).toBe(end);
      room.haxlite.host.onPrivateViewEnd!(1);
      room.haxlite.onPrivateViewEnd = null;
      expect(room.haxlite.onPrivateViewEnd).toBeNull();
      expect(room.haxlite.host.onPrivateViewEnd).toBeNull();
      await waitFor(() => errors.length >= 2, 5000, 'errors');
      expect(messages(errors).sort()).toEqual(['before', 'view end']);
      expect(unhandled).toEqual([]);
    } finally {
      await room.haxlite.stop();
    }
  });
});

describe('callbacks that throw inside a frame or an event', () => {
  it('onGameTick throwing every tick: the host still simulates (the ball moves)', async () => {
    const { room } = await startRoom(env, { noPlayer: true });
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => void errors.push(e);
    try {
      room.onGameTick = () => {
        throw new Error('tick');
      };
      room.startGame();
      room.setDiscProperties(0, { xspeed: 3 });
      await sleep(300);
      expect(room.getBallPosition()!.x).toBeGreaterThan(10);
      expect(errors.length).toBeGreaterThan(5);
    } finally {
      await room.haxlite.stop();
    }
  });

  it('onPlayerTeamChange throwing in AutoTeams: every player still moves', async () => {
    const { room, roomId } = await startRoom(env, {});
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => void errors.push(e);
    let c: Client | null = null;
    try {
      c = await join(env, roomId, 'bob');
      room.onPlayerTeamChange = () => {
        throw new Error('team');
      };
      room.haxlite.host.sequencer.hostEvent(new AutoTeamsEvent());
      const teams = room.getPlayerList().map((p) => p.team);
      expect(teams.sort()).toEqual([1, 2]);
      expect(messages(errors)).toEqual(['team', 'team']);
    } finally {
      c?.leave();
      await room.haxlite.stop();
    }
  });

  it('a synchronous onPlayerChat exception still drops the sender (official "Bad actor")', async () => {
    const { room, roomId } = await startRoom(env, { noPlayer: true });
    let c: Client | null = null;
    try {
      const kicked: string[] = [];
      room.onPlayerKicked = (_p, reason) => void kicked.push(reason);
      room.onPlayerChat = () => {
        throw new Error('chat');
      };
      c = await join(env, roomId, 'bob');
      c.room.sendChat('hi');
      await waitFor(() => kicked.length > 0, 5000, 'kick');
      expect(kicked).toEqual(['Bad actor']);
    } finally {
      c?.leave();
      await room.haxlite.stop();
    }
  });
});

describe('deferred setters and config', () => {
  it('a setter whose argument fails when applied reports it (no uncaught exception)', async () => {
    const { room } = await startRoom(env, { noPlayer: true });
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => void errors.push(e);
    try {
      room.setScoreLimit(10n as unknown as number);
      room.setTeamColors(1, 0, 0, [1n as unknown as number]);
      await sleep(20);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBeInstanceOf(TypeError);
      expect(uncaught).toEqual([]);
      room.setScoreLimit(5); // later actions still apply
      await sleep(20);
      room.startGame();
      await sleep(20);
      expect(room.getScores()!.scoreLimit).toBe(5);
    } finally {
      await room.haxlite.stop();
    }
  });

  it('pingIntervalMs below 1 ms is refused', async () => {
    for (const v of [0, -100, NaN]) {
      await expect(startRoom(env, { haxlite: { pingIntervalMs: v } })).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('a failing start releases the room; stop() returns the same Promise every time', async () => {
    const boom = new Error('start failed');
    const start = HostRoom.prototype.start;
    const spy = vi.spyOn(HostRoom.prototype, 'start').mockImplementationOnce(function (this: HostRoom) {
      start.call(this);
      throw boom;
    });
    try {
      await expect(startRoom(env, { noPlayer: true })).rejects.toBe(boom);
      expect(hostClock.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const { room }: { room: RoomObject } = await startRoom(env, { noPlayer: true });
    const a = room.haxlite.stop();
    const b = room.haxlite.stop();
    expect(b).toBe(a);
    await a;
    expect(unhandled).toEqual([]);
  });
});

