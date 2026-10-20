/**
 * ReplayPlayer.seek/finish on a file whose total frame count is far beyond
 * what can be re-simulated: bounded by a time budget, with an async variant
 * that keeps the event loop alive. The simulation itself is untouched.
 */
import { describe, expect, it } from 'vitest';
import { Writer } from '../../src/codec/index.js';
import { Player, StartGameEvent, createRoomState, roomStateChecksum, startGame, writeRoomState } from '../../src/room/index.js';
import { REPLAY_PLAYER_MAX_SEEK_MS, ReplayData, ReplayPlayer, writeReplay } from '../../src/replay/index.js';

/** A started game with six players and no events: every tick costs a full physics step. */
function hostile(totalFrames: number): Uint8Array {
  const rs = createRoomState();
  for (let i = 1; i <= 6; i++) {
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

/** The state after `n` ticks, simulated with plain {@link ReplayPlayer.step}. */
function reference(file: Uint8Array, n: number): number {
  const p = new ReplayPlayer(file);
  p.step(n);
  return roomStateChecksum(p.rs);
}

describe('ReplayPlayer time budget', () => {
  it('finish() on a huge total frame count throws at the budget instead of blocking', () => {
    // 3 M ticks: seconds of simulation, and a 4.29 G-tick file is the same call
    const file = hostile(3_000_000);
    const p = new ReplayPlayer(file);
    expect(p.maxSeekMs).toBe(REPLAY_PLAYER_MAX_SEEK_MS); // finite by default, shorter on request
    const t0 = performance.now();
    expect(() => p.finish({ maxMs: 30 })).toThrow(RangeError);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(p.frame).toBeGreaterThan(0);
    expect(p.frame).toBeLessThan(3_000_000);
    expect(p.ended).toBe(false);
    // the state is the one after `frame` plain ticks
    expect(roomStateChecksum(p.rs)).toBe(reference(file, p.frame));
  });

  it('seek() clamps to the file and obeys the player budget; the next call continues', () => {
    const file = hostile(0xffffffff);
    const p = new ReplayPlayer(file, { maxSeekMs: 20 });
    expect(p.maxSeekMs).toBe(20);
    expect(() => p.seek(1e12)).toThrow(/budget/);
    const first = p.frame;
    expect(first).toBeGreaterThan(0);
    expect(() => p.seek(1e12)).toThrow(RangeError);
    expect(p.frame).toBeGreaterThan(first);
    // a zero budget still moves the player (one chunk per call)
    const before = p.frame;
    expect(() => p.seek(1e12, { maxMs: 0 })).toThrow(RangeError);
    expect(p.frame).toBeGreaterThan(before);
    expect(roomStateChecksum(p.rs)).toBe(reference(file, p.frame));
  });

  it('seeks that fit the budget land on the exact frame, forwards and back', () => {
    const file = hostile(5000);
    const p = new ReplayPlayer(file);
    p.seek(5000);
    expect(p.frame).toBe(5000);
    expect(roomStateChecksum(p.rs)).toBe(reference(file, 5000));
    p.seek(1234);
    expect(p.frame).toBe(1234);
    expect(roomStateChecksum(p.rs)).toBe(reference(file, 1234));
    p.seek(1e9, { maxMs: Infinity });
    expect(p.frame).toBe(5000);
    expect(p.ended).toBe(true);
  });

  it('finish() applies the events stamped with the final frame, sync and async', async () => {
    const start = new StartGameEvent();
    start.frame = 5;
    const w = new Writer(256);
    writeRoomState(w, createRoomState());
    const file = writeReplay(new ReplayData(3, 5, [], w.copyBytes(), [start]));
    expect(new ReplayPlayer(file).finish().gameState).not.toBeNull();
    const p = new ReplayPlayer(file);
    p.seek(5);
    expect(p.rs.gameState).toBeNull();
    expect((await p.finishAsync()).gameState).not.toBeNull();
  });
});

describe('ReplayPlayer.seekAsync', () => {
  it('reaches the same state as seek() while the event loop keeps turning', async () => {
    const file = hostile(300_000);
    const p = new ReplayPlayer(file);
    let turns = 0;
    let running = true;
    const spin = (): void => {
      if (!running) return;
      turns++;
      setImmediate(spin);
    };
    spin();
    await p.seekAsync(300_000, { sliceMs: 1 });
    running = false;
    expect(p.frame).toBe(300_000);
    expect(turns).toBeGreaterThan(10);
    const q = new ReplayPlayer(file);
    q.seek(300_000, { maxMs: Infinity });
    expect(roomStateChecksum(p.rs)).toBe(roomStateChecksum(q.rs));
    // and back
    await p.seekAsync(1000);
    expect(p.frame).toBe(1000);
    expect(roomStateChecksum(p.rs)).toBe(reference(file, 1000));
  });

  it('can be aborted and leaves the player consistent', async () => {
    const file = hostile(0xffffffff);
    const p = new ReplayPlayer(file);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(p.finishAsync({ sliceMs: 2, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(p.frame).toBeGreaterThan(0);
    expect(p.frame).toBeLessThan(0xffffffff);
    expect(roomStateChecksum(p.rs)).toBe(reference(file, p.frame));
    // an already aborted signal does not even start
    const frame = p.frame;
    await expect(p.seekAsync(frame + 100, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(p.frame).toBe(frame);
  });
});
