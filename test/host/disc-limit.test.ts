import { describe, expect, it } from 'vitest';
import { MAX_WORLD_DISCS, discLimitViolation } from '../../src/host/sequencer.js';
import { SetPlayerTeamEvent, StartGameEvent } from '../../src/room/index.js';
import type { RoomState } from '../../src/room/index.js';

/** Just the fields discLimitViolation reads. */
function room(stadiumDiscs: number, teams: number[], worldDiscs: number | null): RoomState {
  return {
    stadium: { discs: new Array(stadiumDiscs).fill({}) },
    players: teams.map((team, i) => ({ id: i + 1, team, disc: null })),
    gameState: worldDiscs === null ? null : { world: { discs: new Array(worldDiscs).fill({}) } },
  } as unknown as RoomState;
}

describe('world disc limit (u8 count on the wire)', () => {
  it('refuses a game start that would put more than 255 discs in the world', () => {
    expect(discLimitViolation(room(250, [1, 1, 2, 2, 0], null), new StartGameEvent())).toBeNull();
    expect(discLimitViolation(room(250, [1, 1, 2, 2, 1, 2], null), new StartGameEvent())).toMatch(/256/);
  });

  it('refuses moving a spectator into a team when the world is full; team swaps are fine', () => {
    const rs = room(200, [1, 0], MAX_WORLD_DISCS);
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(2, 1))).toMatch(/255 discs/);
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(2, 0))).toBeNull();
    const withDisc = room(200, [1], MAX_WORLD_DISCS);
    (withDisc.players[0] as { disc: unknown }).disc = {};
    expect(discLimitViolation(withDisc, SetPlayerTeamEvent.create(1, 2))).toBeNull();
    expect(discLimitViolation(room(200, [1, 0], 201), SetPlayerTeamEvent.create(2, 1))).toBeNull();
  });
});
