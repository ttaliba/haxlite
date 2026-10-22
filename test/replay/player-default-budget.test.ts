/**
 * ReplayPlayer.seek/finish with the default options on a file that claims
 * as many frames as maxFrames allows on a heavy stadium (hours of CPU in a
 * few hundred bytes): the default time budget stops it. maxFrames bounds the
 * ticks a call simulates, not the frame it aims at.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writer } from '../../src/codec/index.js';
import { Player, StartGameEvent, createRoomState, roomStateChecksum, startGame, writeRoomState } from '../../src/room/index.js';
import { REPLAY_PLAYER_MAX_FRAMES, REPLAY_PLAYER_MAX_SEEK_MS, ReplayData, ReplayPlayer, writeReplay } from '../../src/replay/index.js';
import type { RoomEvent } from '../../src/room/index.js';
import { parseHbs } from '../../src/sim/index.js';

/** A started game on a stadium with `discs` free discs and `players` players. */
function file(totalFrames: number, discs: number, players: number, events: RoomEvent[] = []): Uint8Array {
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
  const w = new Writer(1 << 14);
  writeRoomState(w, rs);
  return writeReplay(new ReplayData(3, totalFrames, [], w.copyBytes(), events));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReplayPlayer default time budget', () => {
  it('is finite by default and can be lifted', () => {
    const bytes = file(100, 0, 2);
    expect(REPLAY_PLAYER_MAX_SEEK_MS).toBe(60_000);
    expect(new ReplayPlayer(bytes).maxSeekMs).toBe(REPLAY_PLAYER_MAX_SEEK_MS);
    expect(new ReplayPlayer(bytes, { maxSeekMs: Infinity }).maxSeekMs).toBe(Infinity);
  });

  it('a heavy stadium claiming maxFrames frames stops at the budget instead of blocking for an hour', () => {
    const bytes = file(REPLAY_PLAYER_MAX_FRAMES, 240, 6);
    expect(bytes.length).toBeLessThan(2048);
    const p = new ReplayPlayer(bytes);
    // checked first: without a finite default the call below would block for over an hour
    expect(Number.isFinite(p.maxSeekMs)).toBe(true);
    // every clock read is 2 s later: the 60 s budget runs out after a few dozen chunks
    let t = 0;
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      reads++;
      return (t += 2000);
    });
    expect(() => p.finish()).toThrow(/budget exceeded/);
    vi.restoreAllMocks();
    expect(reads).toBeLessThan(40);
    expect(p.frame).toBeGreaterThan(0);
    expect(p.frame).toBeLessThan(1000);
    expect(p.ended).toBe(false);
    // the cap is on the ticks of one call, so the next call continues from there
    const f = p.frame;
    t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 2000));
    expect(() => p.seek(REPLAY_PLAYER_MAX_FRAMES)).toThrow(/budget exceeded/);
    expect(p.frame).toBeGreaterThan(f);
  });
});

describe('ReplayPlayer.maxFrames bounds the ticks of a call', () => {
  it('a one-tick seek past maxFrames after seekAsync, and finish after finishAsync', async () => {
    const start = new StartGameEvent();
    start.frame = 3000;
    const bytes = file(3000, 0, 2, [start]);
    const p = new ReplayPlayer(bytes, { maxFrames: 1000 });
    await p.seekAsync(2500);
    expect(p.frame).toBe(2500);
    p.seek(p.frame + 1);
    expect(p.frame).toBe(2501);
    p.seek(3000);
    expect(p.frame).toBe(3000);
    await p.seekAsync(2000);
    await p.finishAsync();
    // nothing left to simulate: finish() returns and applies the final-frame events
    const q = new ReplayPlayer(bytes, { maxFrames: 1000 });
    await q.seekAsync(3000);
    let applied = 0;
    q.onEvent = () => applied++;
    expect(() => q.finish()).not.toThrow();
    expect(applied).toBe(1);
    expect(roomStateChecksum(q.rs)).toBe(roomStateChecksum(p.rs));
  });

  it('counts from the current frame forwards and from 0 on a rewind', () => {
    const bytes = file(5000, 0, 2);
    const p = new ReplayPlayer(bytes, { maxFrames: 1000 });
    p.seek(1000);
    p.seek(2000);
    expect(p.frame).toBe(2000);
    expect(() => p.seek(3001)).toThrow(/maxFrames/);
    expect(p.frame).toBe(2000);
    // a rewind re-simulates from frame 0
    p.seek(1000);
    expect(p.frame).toBe(1000);
    p.seek(1500);
    expect(() => p.seek(1001)).toThrow(/maxFrames/);
    expect(p.frame).toBe(1500);
  });
});
