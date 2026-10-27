/**
 * room.haxlite match extras through HBInit: the stats and input guard switches.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shutdownAll, startEnv, startRoom, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

describe('room.haxlite match extras', () => {
  it('trackStats / getStats and inputGuard switches', async () => {
    const { room } = await startRoom(env, { noPlayer: true });
    const x = room.haxlite;

    expect(x.getStats()).toBeNull();
    x.trackStats = true;
    expect(x.trackTouches).toBe(true);
    expect(x.getStats()).toEqual({ possessionFrames: { red: 0, blue: 0 }, possession: { red: 0, blue: 0 }, players: [] });
    x.trackStats = false;
    expect(x.getStats()).toBeNull();

    expect(x.inputGuard).toBeNull();
    x.inputGuard = { maxKicksPerSecond: 12 };
    expect(x.inputGuard).toEqual({ maxInputsPerSecond: 40, maxKicksPerSecond: 12 });
    x.inputGuard = null;
    expect(x.inputGuard).toBeNull();

    await room.haxlite.stop();
  });
});
