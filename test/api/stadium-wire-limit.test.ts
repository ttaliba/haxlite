/**
 * HBInit validation errors (offline E2E: FakeMaster + node-haxball):
 * setCustomStadium refuses, synchronously and before anything is applied, a
 * stadium the clients can't receive (deflated over the SetStadium u16, or a
 * list over 255); maxPlayers / setMaxPlayers refuse NaN; the error
 * coalescing knobs are validated before any network I/O.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HBInit } from '../../src/api/index.js';
import { ReplayPlayer } from '../../src/replay/index.js';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, type Client, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

/** Deterministic, nearly incompressible base64 text. */
function noise(n: number): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = 7;
  let s = '';
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    s += abc[(x >>> 0) & 63];
  }
  return s;
}

const hbs = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'small', width: 10, height: 10, bg: {}, discs: [{}, {}], ...extra });

describe('setCustomStadium wire limit', () => {
  it('107 KB name / 256 joints: throws, host and clients keep the stadium, the recording stays valid', async () => {
    const { room, roomId } = await startRoom(env, { noPlayer: true });
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => void errors.push(e);
    let c: Client | null = null;
    try {
      c = await join(env, roomId, 'bob');
      room.startRecording();
      const host = room.haxlite.host;
      const before = host.state.stadium;
      expect(() => room.setCustomStadium(hbs({ name: noise(107_000) }))).toThrow(/^Stadium too large: deflated \d+ > 65535$/);
      const joints = Array.from({ length: 256 }, () => ({ d0: 0, d1: 1 }));
      expect(() => room.setCustomStadium(hbs({ joints }))).toThrow('Stadium has a list over 255 items');
      await sleep(30);
      expect(host.state.stadium).toBe(before);

      room.setCustomStadium(hbs({ name: 'after' }));
      await waitFor(() => c!.room.stadium?.name === 'after', 5000, 'client stadium');
      expect(host.state.stadium?.name).toBe('after');
      const player = new ReplayPlayer(room.stopRecording()!);
      expect(player.finish().stadium?.name).toBe('after');
      expect(c.closeError).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      c?.leave();
      await room.haxlite.stop();
    }
  });
});

describe('maxPlayers and error coalescing knobs', () => {
  it('NaN or non-integer maxPlayers fail like the official cast; setMaxPlayers too', async () => {
    for (const bad of [NaN, 2.5, '12']) {
      await expect(HBInit({ token: 'x', maxPlayers: bad as number })).rejects.toThrow(/Cannot cast .* to Int/);
    }
    await expect(HBInit({ token: 'x', haxlite: { errorRepeatBurst: 0 } })).rejects.toThrow(RangeError);
    await expect(HBInit({ token: 'x', haxlite: { errorRepeatWindowMs: Infinity } })).rejects.toThrow(RangeError);
    const { room } = await startRoom(env, { noPlayer: true, maxPlayers: 5 });
    try {
      expect(() => room.haxlite.setMaxPlayers(NaN)).toThrow(/Cannot cast NaN to Int/);
      expect(room.haxlite.transport.getRoomInfo().maxPlayers).toBe(5);
      room.haxlite.setMaxPlayers(40);
      expect(room.haxlite.transport.getRoomInfo().maxPlayers).toBe(30);
    } finally {
      await room.haxlite.stop();
    }
  });
});
