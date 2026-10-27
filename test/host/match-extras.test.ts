/**
 * haxlite match extras: MatchStats and InputGuard.
 */
import { describe, expect, it } from 'vitest';
import { InputGuard, MatchStats } from '../../src/host/index.js';
import { TouchTracker } from '../../src/room/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const player = (id: number, team: number): Any => ({ id, team, name: `p${id}`, input: 0 });

describe('MatchStats', () => {
  it('goals, assists, own goals, passes, steals, possession', () => {
    const a = player(1, 1);
    const b = player(2, 1);
    const c = player(3, 2);
    const touches = new TouchTracker();
    const rs: Any = { players: [a, b, c], touches, gameState: { phase: 1 } };
    const s = new MatchStats();
    const touch = (p: Any, prev: Any) => {
      touches.prevId = touches.lastId;
      touches.prevTeam = touches.lastTeam;
      touches.lastId = p.id;
      touches.lastTeam = p.team;
      s.touch(p, prev);
    };
    touch(a, null);
    s.tick(rs);
    s.tick(rs);
    touch(b, a); // pass a -> b
    s.kick(b);
    s.tick(rs);
    s.goal(rs, 1); // b scores, a assists
    touch(c, b); // steal
    s.tick(rs);
    s.goal(rs, 1); // c (blue) put it in for red: own goal
    rs.gameState.phase = 2;
    s.tick(rs); // not counted after the goal
    const snap = s.snapshot();
    const by = (id: number) => snap.players.find((p) => p.id === id)!;
    expect(by(1)).toMatchObject({ passes: 1, assists: 1, goals: 0, possessionFrames: 2 });
    expect(by(2)).toMatchObject({ goals: 1, kicks: 1, possessionFrames: 1 });
    expect(by(3)).toMatchObject({ steals: 1, ownGoals: 1, possessionFrames: 1 });
    expect(snap.possessionFrames).toEqual({ red: 3, blue: 1 });
    expect(snap.possession.red).toBeCloseTo(0.75);
    s.reset();
    expect(s.snapshot().players).toEqual([]);
  });
});

describe('InputGuard', () => {
  it('reports once per kind and second over the limits', () => {
    const g = new InputGuard({ maxInputsPerSecond: 10, maxKicksPerSecond: 3 });
    const seen: [number, string, number][] = [];
    g.onAbuse = (p, kind, n) => seen.push([p.id, kind, n]);
    const p = player(7, 1);
    let prev = 0;
    for (let i = 0; i < 30; i++) {
      p.input = i % 2 === 0 ? 16 : 0; // kick on / off every input
      g.input(p, prev, i);
      prev = p.input;
    }
    expect(seen).toEqual([
      [7, 'kicks', 4],
      [7, 'inputs', 11],
    ]);
    // next second: counts start over
    seen.length = 0;
    for (let i = 0; i < 5; i++) g.input(p, 0, 60 + i);
    expect(seen).toEqual([]);
    const human = player(8, 1);
    for (let i = 0; i < 60; i += 8) g.input(human, 0, i);
    expect(seen).toEqual([]);
  });
});
