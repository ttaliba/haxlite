import { describe, expect, it } from 'vitest';
import { GamePhase, TeamId } from '../../src/protocol.js';
import {
  JoinRoomEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
  TouchTracker,
  createRoomState,
  resetPositions,
  stepRoom,
  type Player,
  type RoomState,
} from '../../src/room/index.js';

function setup(): { rs: RoomState; p1: Player; p2: Player } {
  const rs = createRoomState();
  for (let i = 1; i <= 2; i++) {
    const j = JoinRoomEvent.create(i, 'p' + i, null, null);
    j.byId = 0;
    j.apply(rs);
    const t = SetPlayerTeamEvent.create(i, i === 1 ? TeamId.Red : TeamId.Blue);
    t.byId = 0;
    t.apply(rs);
  }
  rs.players[0]!.isAdmin = true;
  rs.scoreLimit = 0;
  rs.timeLimit = 0;
  const s = new StartGameEvent();
  s.byId = 0;
  s.apply(rs);
  rs.gameState!.phase = GamePhase.Playing;
  return { rs, p1: rs.players[0]!, p2: rs.players[1]! };
}

/** Ball at the centre, still; `p` just touching it from `side` (-1 left, +1 right) or parked far away (gap 0). */
function place(rs: RoomState, p: Player, side: number, gap = 0): void {
  const ball = rs.gameState!.world.discs[0]!;
  ball.x = 0;
  ball.y = 0;
  ball.xspeed = 0;
  ball.yspeed = 0;
  const d = p.disc!;
  d.x = side * (ball.radius + d.radius + gap);
  d.y = 0;
  d.xspeed = 0;
  d.yspeed = 0;
}

const away = (p: Player): void => {
  p.disc!.x = p.team === TeamId.Red ? -400 : 400;
  p.disc!.y = 200;
  p.disc!.xspeed = 0;
  p.disc!.yspeed = 0;
};

describe('TouchTracker', () => {
  it('is off by default and the tick leaves players alone', () => {
    const { rs, p1, p2 } = setup();
    expect(rs.touches).toBeNull();
    place(rs, p1, -1);
    away(p2);
    stepRoom(rs);
    expect(p1.touchState).toBe(0);
  });

  it('records the last and the previous different toucher, and only the start of contact', () => {
    const { rs, p1, p2 } = setup();
    rs.touches = new TouchTracker();
    rs.touches.reset(rs);
    const t = rs.touches;
    const calls: Array<[number, number | null]> = [];
    rs.hooks.onPlayerTouch = (p, prev) => calls.push([p.id, prev === null ? null : prev.id]);

    away(p1);
    away(p2);
    stepRoom(rs);
    expect(t.lastId).toBe(-1);

    place(rs, p1, -1);
    stepRoom(rs);
    expect([t.lastId, t.lastTeam, t.prevId]).toEqual([1, 1, -1]);
    expect(t.lastKick).toBe(false);
    stepRoom(rs); // still pressed against it: not a new touch
    place(rs, p1, -1);
    stepRoom(rs);
    expect(calls).toEqual([[1, null]]);

    away(p1);
    stepRoom(rs);
    place(rs, p2, 1);
    stepRoom(rs);
    expect([t.lastId, t.lastTeam, t.prevId, t.prevTeam]).toEqual([2, 2, 1, 1]);
    expect(calls).toEqual([
      [1, null],
      [2, 1],
    ]);

    // the same player coming back does not push themselves into `previous`
    away(p2);
    stepRoom(rs);
    place(rs, p2, 1);
    stepRoom(rs);
    expect([t.lastId, t.prevId]).toEqual([2, 1]);
    expect(calls.length).toBe(2);

    away(p2);
    stepRoom(rs);
    place(rs, p1, -1);
    stepRoom(rs);
    expect([t.lastId, t.prevId]).toEqual([1, 2]);
    expect(calls[2]).toEqual([1, 2]);
  });

  it('records a kick as a kick, once, and keeps it on the same player', () => {
    const { rs, p1, p2 } = setup();
    rs.touches = new TouchTracker();
    rs.touches.reset(rs);
    const t = rs.touches;
    let touches = 0;
    rs.hooks.onPlayerTouch = () => touches++;
    away(p1);
    place(rs, p2, 1, 2); // within kick reach (gap < 4) but not touching
    p2.input = 16;
    p2.isKicking = true;
    stepRoom(rs);
    expect([t.lastId, t.lastKick, touches]).toEqual([2, true, 1]);
    // the ball flies away from p2; p2's disc never "touches" again this tick
    expect(p2.touchState & 2).toBe(0);
  });

  it('a kick-range kick and the contact in the same tick count once', () => {
    const { rs, p1, p2 } = setup();
    rs.touches = new TouchTracker();
    rs.touches.reset(rs);
    const t = rs.touches;
    let touches = 0;
    rs.hooks.onPlayerTouch = () => touches++;
    away(p1);
    place(rs, p2, 1, 0); // touching AND in kick reach
    p2.input = 16;
    p2.isKicking = true;
    stepRoom(rs);
    expect([t.lastId, touches]).toEqual([2, 1]);
    expect(t.lastKick).toBe(true);
  });

  it('forgets everything at kick-off, ignores the after-goal phase, and can be switched off', () => {
    const { rs, p1, p2 } = setup();
    rs.touches = new TouchTracker();
    rs.touches.reset(rs);
    const t = rs.touches;
    away(p2);
    place(rs, p1, -1);
    stepRoom(rs);
    expect(t.lastId).toBe(1);

    resetPositions(rs, rs.gameState!);
    expect([t.lastId, t.prevId, p1.touchState]).toEqual([-1, -1, 0]);

    rs.gameState!.phase = GamePhase.AfterGoal;
    away(p1);
    place(rs, p2, 1);
    stepRoom(rs);
    expect(t.lastId).toBe(-1);

    rs.touches = null;
    rs.gameState!.phase = GamePhase.Playing;
    place(rs, p2, 1);
    stepRoom(rs); // no tracker: nothing to throw or to update
    expect(t.lastId).toBe(-1);
  });
});
