/**
 * ReplayPlayer defaults: seek/finish have no time budget (a legitimate
 * replay re-simulates to the end whatever the machine or its load), and a
 * header claiming more frames than {@link REPLAY_PLAYER_MAX_FRAMES} fails up
 * front instead of blocking. The time budget stays available on request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writer } from '../../src/codec/index.js';
import { Player, createRoomState, roomStateChecksum, startGame, writeRoomState } from '../../src/room/index.js';
import { REPLAY_PLAYER_MAX_FRAMES, ReplayData, ReplayPlayer, readReplay, writeReplay } from '../../src/replay/index.js';
import { parseHbs } from '../../src/sim/index.js';

/** A started game on a stadium with `discs` free discs and `players` players, no events. */
function file(totalFrames: number, discs = 0, players = 6): Uint8Array {
  const rs = createRoomState();
  if (discs > 0) {
    const ds: unknown[] = [{ radius: 10, invMass: 1 }];
    for (let i = 0; i < discs; i++) ds.push({ pos: [-300 + (i % 20) * 30, -100 + Math.floor(i / 20) * 30], radius: 5, invMass: 1, damping: 0.99 });
    rs.stadium = parseHbs(JSON.stringify({ name: 'heavy', width: 420, height: 200, bg: {}, discs: ds }));
  }
  for (let i = 1; i <= players; i++) {
    const p = new Player();
    p.id = i;
    p.team = ((i % 2) + 1) as 1 | 2;
    rs.players.push(p);
  }
  startGame(rs, null);
  const w = new Writer(1024);
  writeRoomState(w, rs);
  return writeReplay(new ReplayData(3, totalFrames, [], w.copyBytes(), []));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReplayPlayer defaults', () => {
  it('no time budget: a slow re-simulation (stalled clock) still reaches the end', () => {
    const bytes = file(20_000, 40, 8);
    const ref = new ReplayPlayer(bytes);
    ref.step(20_000);
    const p = new ReplayPlayer(bytes);
    expect(p.maxSeekMs).toBe(Infinity);
    expect(p.maxFrames).toBe(REPLAY_PLAYER_MAX_FRAMES);
    // every clock read is 10 s later: any time budget is long exhausted
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 10_000));
    p.seek(7_000);
    expect(p.frame).toBe(7_000);
    p.finish();
    expect(p.frame).toBe(20_000);
    expect(p.ended).toBe(true);
    // backwards (rewind and re-simulate) too
    p.seek(19_999);
    expect(p.frame).toBe(19_999);
    p.finish();
    vi.restoreAllMocks();
    expect(roomStateChecksum(p.rs)).toBe(roomStateChecksum(ref.rs));
  });

  it('a forged total frame count (2^32 - 1 in a few hundred bytes) fails at once, nothing simulated', () => {
    const bytes = file(0xffffffff);
    expect(bytes.length).toBeLessThan(1024);
    const p = new ReplayPlayer(bytes);
    const t0 = performance.now();
    expect(() => p.finish()).toThrow(RangeError);
    expect(() => p.seek(1e12)).toThrow(/maxFrames/);
    expect(() => new ReplayPlayer(readReplay(bytes)).finish()).toThrow(RangeError);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(p.frame).toBe(0);
    // the frames within the cap are still reachable
    p.seek(600);
    expect(p.frame).toBe(600);
    expect(() => p.seek(REPLAY_PLAYER_MAX_FRAMES + 1)).toThrow(RangeError);
    expect(p.frame).toBe(600);
  });

  it('maxFrames and maxSeekMs are options: raising the cap and opting into a budget', () => {
    const bytes = file(0xffffffff);
    // with a time budget the budget bounds the call, not maxFrames
    const p = new ReplayPlayer(bytes, { maxSeekMs: 10 });
    expect(() => p.finish()).toThrow(/budget/);
    expect(p.frame).toBeGreaterThan(0);
    expect(() => p.finish({ maxMs: Infinity })).toThrow(/maxFrames/);
    const q = new ReplayPlayer(bytes, { maxFrames: 1000 });
    q.seek(1000);
    expect(q.frame).toBe(1000);
    expect(() => q.seek(1001)).toThrow(RangeError);
    q.maxFrames = 2000;
    q.seek(1001);
    expect(q.frame).toBe(1001);
  });
});
