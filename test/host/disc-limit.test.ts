import { describe, expect, it } from 'vitest';
import { MAX_WORLD_DISCS, discLimitViolation } from '../../src/host/sequencer.js';
import { Reader, Writer } from '../../src/codec/index.js';
import { Sequencer, SequencerClient } from '../../src/host/index.js';
import {
  AutoTeamsEvent,
  createRoomState,
  encodeEvent,
  JoinRoomEvent,
  SetPlayerAdminEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
  type RoomEvent,
} from '../../src/room/index.js';
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
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(2, 1))).toMatch(/256 discs/);
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(2, 0))).toBeNull();
    const withDisc = room(200, [1], MAX_WORLD_DISCS);
    (withDisc.players[0] as { disc: unknown }).disc = {};
    expect(discLimitViolation(withDisc, SetPlayerTeamEvent.create(1, 2))).toBeNull();
    expect(discLimitViolation(room(200, [1, 0], 201), SetPlayerTeamEvent.create(2, 1))).toBeNull();
  });

  it('counts the two spectators AutoTeams moves when the teams are even', () => {
    // even teams, 2+ spectators: two discs
    expect(discLimitViolation(room(200, [1, 2, 0, 0], 253), new AutoTeamsEvent())).toBeNull();
    expect(discLimitViolation(room(200, [1, 2, 0, 0], 254), new AutoTeamsEvent())).toMatch(/256/);
    // uneven teams: one disc
    expect(discLimitViolation(room(200, [1, 0, 0], 254), new AutoTeamsEvent())).toBeNull();
    expect(discLimitViolation(room(200, [1, 0, 0], 255), new AutoTeamsEvent())).toMatch(/256/);
    // even teams and a single spectator, or no spectators: nothing moves
    expect(discLimitViolation(room(200, [1, 2, 0], 255), new AutoTeamsEvent())).toBeNull();
    expect(discLimitViolation(room(200, [1, 2], 255), new AutoTeamsEvent())).toBeNull();
  });

  it('counts what the events already queued for future frames could add', () => {
    // two spectators moved at cur+20 with 254 discs: the second one would make 256
    const rs = room(200, [1, 0, 0], 254);
    const first = SetPlayerTeamEvent.create(2, 1);
    expect(discLimitViolation(rs, first)).toBeNull();
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(3, 2), [first])).toMatch(/256/);
    // the same player again only switches team: nothing more
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(2, 2), [first])).toBeNull();
    // a queued AutoTeams may move two players by the time it applies
    expect(discLimitViolation(room(200, [1, 0, 0], 253), first, [new AutoTeamsEvent()])).toMatch(/256/);
    expect(discLimitViolation(room(200, [1, 0], 254), new AutoTeamsEvent(), [SetPlayerTeamEvent.create(2, 0)])).toMatch(/256/);
  });

  it('a queued StartGame counts the players later moved into a team', () => {
    // no game yet: SetPlayerTeam alone adds no disc, but the queued start will
    const rs = room(250, [1, 1, 2, 2, 0, 0], null);
    const start = new StartGameEvent();
    expect(discLimitViolation(rs, start)).toBeNull(); // 254
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(5, 1))).toBeNull();
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(5, 1), [start])).toBeNull(); // 255
    const move5 = SetPlayerTeamEvent.create(5, 1);
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(6, 2), [start, move5])).toMatch(/256/);
    // order does not matter: the start checked after the moves
    expect(discLimitViolation(rs, start, [move5, SetPlayerTeamEvent.create(6, 2)])).toMatch(/256/);
    expect(discLimitViolation(rs, new AutoTeamsEvent(), [start])).toMatch(/256/);
  });

  it('Sequencer: a client event is checked against the events queued before it', () => {
    const s = new Sequencer(createRoomState(), { broadcast() {}, hasConnections: () => false });
    for (let id = 1; id <= 3; id++) s.hostEvent(JoinRoomEvent.create(id, `p${id}`, 'uy', null));
    s.hostEvent(SetPlayerAdminEvent.create(1, true));
    s.hostEvent(SetPlayerTeamEvent.create(1, 1));
    s.hostEvent(new StartGameEvent());
    const discs = s.rs.gameState!.world.discs;
    while (discs.length < MAX_WORLD_DISCS - 1) discs.push(discs[0]!); // 254 (never stepped)
    const admin = new SequencerClient(1);
    const send = (ev: RoomEvent): RoomEvent | null => {
      const w = new Writer(64);
      w.u32(s.frame + 20);
      w.u32(0);
      w.bytes(encodeEvent(ev));
      return s.clientMessage(admin, new Reader(w.copyBytes()), 0);
    };
    expect(send(SetPlayerTeamEvent.create(2, 1))).not.toBeNull();
    expect(send(SetPlayerTeamEvent.create(3, 2))).toBeNull(); // would make 256 at cur+20
    expect(s.queue.length).toBe(1);
    s.advance(25);
    expect(discs.length).toBe(MAX_WORLD_DISCS);
  });
});
