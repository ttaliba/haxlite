/**
 * RoomState serialization + checksum vs the oracles:
 *  - official bytes -> readRoomState -> writeRoomState == same bytes, checksum equal,
 *    across many scenarios (fresh, mid-game, after goals, paused, admin events,
 *    custom stadium, custom disc properties, ending phase, spectators, ...);
 *  - a room loaded from official bytes keeps simulating bit-exactly;
 *  - node-haxball loads OUR bytes and re-serializes them identically.
 */
import { describe, expect, it } from 'vitest';
import { Reader, Writer, xorInt32Words } from '../../src/codec/index.js';
import { GamePhase, Input, TeamId } from '../../src/protocol.js';
import {
  JoinRoomEvent,
  PauseResumeGameEvent,
  SetDiscPropertiesEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
  createRoomState,
  readRoomState,
  roomStateChecksum,
  writeRoomState,
  SendInputEvent,
} from '../../src/room/index.js';
import { defaultStadiums, parseHbs } from '../../src/sim/index.js';
import { OfficialRoom } from '../oracle/official.js';
import { OracleRoom, prng } from '../oracle/index.js';
import { OurRoom, RandomDriver, applyBoth, compareBytes, runDiff } from './harness.js';
import type { Pair } from './harness.js';
import { CUSTOM_HBS } from './fixtures.js';
import { hex } from './helpers.js';

function roundTrip(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  const rs = readRoomState(r);
  expect(r.remaining).toBe(0);
  const w = new Writer(256);
  writeRoomState(w, rs);
  return w.copyBytes();
}

/** Checks one official state: byte round trip + checksum + node-haxball agrees. */
function checkOfficialState(off: OfficialRoom, label: string): void {
  const bytes = off.stateBytes();
  const back = roundTrip(bytes);
  if (hex(back) !== hex(bytes)) throw new Error(`${label}: round trip differs`);
  const rs = readRoomState(new Reader(bytes));
  expect(roomStateChecksum(rs)).toBe(off.checksum());
  expect(roomStateChecksum(rs)).toBe(xorInt32Words(bytes));
}

describe('RoomState codec + checksum', () => {
  it('fresh room == official fresh RoomState (bytes and checksum)', () => {
    const rs = createRoomState();
    const w = new Writer();
    writeRoomState(w, rs);
    const off = new OfficialRoom();
    expect(hex(w.finish())).toBe(hex(off.stateBytes()));
    expect(roomStateChecksum(rs)).toBe(off.checksum());
    checkOfficialState(off, 'fresh');
  });

  it('first spawned player of each team has y = -0 on the wire', () => {
    const p: Pair = { ours: new OurRoom(), off: new OfficialRoom() };
    applyBoth(p, JoinRoomEvent.create(1, 'a', null, null));
    applyBoth(p, SetPlayerTeamEvent.create(1, TeamId.Red));
    applyBoth(p, new StartGameEvent());
    const d = p.ours.rs.players[0]!.disc!;
    expect(Object.is(d.y, -0)).toBe(true);
    compareBytes(p, '-0');
  });

  it('scenarios across 6 stadiums: official bytes round-trip byte-identically at 300 checkpoints', () => {
    const stadiums = defaultStadiums();
    const custom = parseHbs(CUSTOM_HBS);
    let checkpoints = 0;
    const phases = new Set<number>();
    let sawPaused = false;
    let sawNoGame = false;
    for (const [i, st] of [stadiums[0]!, stadiums[2]!, stadiums[5]!, stadiums[6]!, stadiums[8]!, custom].entries()) {
      const p: Pair = { ours: new OurRoom(), off: new OfficialRoom() };
      const driver = new RandomDriver({ rnd: prng(500 + i), stadiums: [st, custom], eventRate: 0.05 });
      driver.setup(p, 2 + i, { stadium: st, scoreLimit: 2, timeLimit: 1 });
      for (let k = 0; k < 50; k++) {
        runDiff(p, driver, 70, 1000, `scenario ${i}`);
        checkOfficialState(p.off, `scenario ${i} checkpoint ${k}`);
        checkpoints++;
        const gs = p.ours.rs.gameState;
        if (gs === null) sawNoGame = true;
        else {
          phases.add(gs.phase);
          if (gs.pauseGameTickCounter > 0) sawPaused = true;
        }
      }
    }
    expect(checkpoints).toBe(300);
    expect(phases.size).toBeGreaterThanOrEqual(3);
    expect(sawPaused).toBe(true);
    expect(sawNoGame).toBe(true);
  });

  it('custom disc properties (float32) + paused state round-trip and checksum', () => {
    const p: Pair = { ours: new OurRoom(), off: new OfficialRoom() };
    const driver = new RandomDriver({ rnd: prng(9), stadiums: [defaultStadiums()[0]!] });
    driver.setup(p, 4, {});
    applyBoth(p, SetDiscPropertiesEvent.create(0, false, { x: 1.1, y: -2.2, xspeed: 0.3, radius: 7.7, bCoef: 0.123, invMass: 1.5, damping: 0.97, color: -1, cMask: 0x7fffffff, cGroup: -2147483648, xgravity: 0.01, ygravity: -0.02, yspeed: 1e-30 }));
    applyBoth(p, SetDiscPropertiesEvent.create(2, true, { x: 50, invMass: 0 }));
    compareBytes(p, 'disc props');
    checkOfficialState(p.off, 'disc props');
    applyBoth(p, PauseResumeGameEvent.create(true));
    p.off.step(10);
    p.ours.step(10);
    compareBytes(p, 'paused');
    checkOfficialState(p.off, 'paused');
    expect(p.ours.rs.gameState!.pauseGameTickCounter).toBe(120);
  });

  it('a room loaded from official mid-game bytes keeps simulating bit-exactly (3 x 2000 ticks)', () => {
    const stadiums = defaultStadiums();
    for (const [i, st] of [stadiums[0]!, stadiums[4]!, parseHbs(CUSTOM_HBS)].entries()) {
      const off = new OfficialRoom();
      const warm: Pair = { ours: new OurRoom(), off };
      const driver = new RandomDriver({ rnd: prng(77 + i), stadiums: [st] });
      driver.setup(warm, 4, { stadium: st, scoreLimit: 0, timeLimit: 0 });
      runDiff(warm, driver, 900, 60, `warm ${i}`);
      // fresh OurRoom built only from the official bytes
      const loaded = new OurRoom(readRoomState(new Reader(off.stateBytes())));
      const p: Pair = { ours: loaded, off };
      compareBytes(p, `loaded ${i}`);
      runDiff(p, driver, 2000, 30, `loaded ${i}`);
    }
  });

  it('node-haxball loads OUR state bytes and re-serializes them identically', () => {
    const p: Pair = { ours: new OurRoom(), off: new OfficialRoom() };
    const driver = new RandomDriver({ rnd: prng(31), stadiums: [parseHbs(CUSTOM_HBS)] });
    driver.setup(p, 5, { stadium: parseHbs(CUSTOM_HBS) });
    for (let k = 0; k < 10; k++) {
      runDiff(p, driver, 200, 60, 'nh');
      const ours = p.ours.stateBytes();
      expect(hex(OracleRoom.fromStateBytes(ours).stateBytes())).toBe(hex(ours));
    }
  });

  it('player joining mid-game spawns at side*width (no spawn points) and gets the smallest free number', () => {
    const p: Pair = { ours: new OurRoom(), off: new OfficialRoom() };
    for (let id = 1; id <= 3; id++) {
      applyBoth(p, JoinRoomEvent.create(id, `p${id}`, null, null));
      applyBoth(p, SetPlayerTeamEvent.create(id, TeamId.Red));
    }
    applyBoth(p, new StartGameEvent());
    applyBoth(p, SetPlayerTeamEvent.create(2, TeamId.Spectators));
    applyBoth(p, JoinRoomEvent.create(4, 'late', null, null));
    applyBoth(p, SetPlayerTeamEvent.create(4, TeamId.Red));
    applyBoth(p, SendInputEvent.create(Input.Right | Input.Kick), 4);
    const late = p.ours.rs.players.find((x) => x.id === 4)!;
    expect(late.avatarNumber).toBe(2);
    expect(late.disc!.x).toBe(-420);
    for (let i = 0; i < 100; i++) {
      p.off.step();
      p.ours.step();
    }
    compareBytes(p, 'mid-game join');
    expect(p.ours.rs.gameState!.phase).toBe(GamePhase.BeforeKickOff);
  });
});
