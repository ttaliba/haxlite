/**
 * Full-room differential: our events + stepRoom (with engineer A's world
 * step) vs the OFFICIAL headless script, identical randomized timelines
 * (inputs incl. kick, team changes, start/stop/pause, chat, admin events,
 * setDiscProperties, joins/leaves, stadium changes). Checksum compared every
 * tick, full RoomState bytes every 60 ticks and on any checksum mismatch.
 */
import { describe, expect, it } from 'vitest';
import { defaultStadiums, parseHbs } from '../../src/sim/index.js';
import { OfficialRoom } from '../oracle/official.js';
import { prng } from '../oracle/index.js';
import { OurRoom, RandomDriver, applyBoth, compareBytes, runDiff } from './harness.js';
import { GamePhase, TeamId } from '../../src/protocol.js';
import {
  JoinRoomEvent,
  SetDiscPropertiesEvent,
  SetGamePlayLimitEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
} from '../../src/room/index.js';
import type { Pair } from './harness.js';
import { CUSTOM_HBS } from './fixtures.js';

const TICKS_PER_RUN = Number(process.env.HAXLITE_DIFF_TICKS ?? 5000);

function newPair(): Pair {
  return { ours: new OurRoom(), off: new OfficialRoom() };
}

describe('full room differential vs official headless', () => {
  const stadiums = defaultStadiums();
  const custom = parseHbs(CUSTOM_HBS);
  const runs: { name: string; stadium: number | 'custom'; players: number; scoreLimit: number; timeLimit: number; kickRate?: [number, number, number] }[] = [
    { name: 'Classic 4p, score 3', stadium: 0, players: 4, scoreLimit: 3, timeLimit: 3 },
    { name: 'Big 6p, no limits', stadium: 3, players: 6, scoreLimit: 0, timeLimit: 0 },
    { name: 'Rounded 2p, time 1 min (golden goal)', stadium: 4, players: 2, scoreLimit: 0, timeLimit: 1, kickRate: [3, 8, 3] },
    { name: 'Hockey 4p', stadium: 5, players: 4, scoreLimit: 2, timeLimit: 2 },
    { name: 'Huge 8p', stadium: 9, players: 8, scoreLimit: 5, timeLimit: 0, kickRate: [0, 1, 100] },
    { name: 'custom .hbs 3p (full kickoff reset, spawn points, joints, gravity)', stadium: 'custom', players: 3, scoreLimit: 2, timeLimit: 1, kickRate: [3, 10, 4] },
  ];
  let total = 0;
  runs.forEach((run, i) => {
    it(`${run.name}: ${TICKS_PER_RUN} ticks bit-exact`, () => {
      const p = newPair();
      compareBytes(p, 'fresh');
      const pool = run.stadium === 'custom' ? [custom, stadiums[0]!] : [stadiums[run.stadium]!, stadiums[(run.stadium + 1) % 10]!, custom];
      const driver = new RandomDriver({ rnd: prng(7000 + i), stadiums: pool, eventRate: 0.03 });
      driver.setup(p, run.players, {
        stadium: run.stadium === 'custom' ? custom : stadiums[run.stadium]!,
        scoreLimit: run.scoreLimit,
        timeLimit: run.timeLimit,
        ...(run.kickRate ? { kickRate: run.kickRate } : {}),
      });
      compareBytes(p, 'after setup');
      const stats = { goals: 0, kicks: 0, victories: 0, resets: 0, stops: 0, pauses: 0 };
      const h = p.ours.rs.hooks;
      h.onTeamGoal = () => stats.goals++;
      h.onPlayerBallKick = () => stats.kicks++;
      h.onTeamVictory = () => stats.victories++;
      h.onPositionsReset = () => stats.resets++;
      h.onGameStop = () => stats.stops++;
      h.onGamePauseChange = () => stats.pauses++;
      total += runDiff(p, driver, TICKS_PER_RUN, 60, run.name);
      if (process.env.HAXLITE_DIFF_VERBOSE) process.stderr.write(`${run.name} ${JSON.stringify(stats)} events ${driver.counts.join(',')}\n`);
      expect(stats.kicks).toBeGreaterThan(10);
      // the timeline must actually exercise the event set
      const used = driver.counts.filter((c) => c > 0).length;
      expect(used).toBeGreaterThanOrEqual(20);
    });
  });

  it('golden goal: tied at the time limit -> overtime -> goal -> Ending (300) -> game destroyed; every tick bit-exact', () => {
    const p = newPair();
    const events: number[] = [];
    const h = p.ours.rs.hooks;
    h.onTeamGoal = (t) => events.push(t);
    h.onTeamVictory = (t) => events.push(10 + t);
    h.onGameStop = () => events.push(99);
    applyBoth(p, SetGamePlayLimitEvent.create(1, 1)); // 1 minute
    applyBoth(p, SetGamePlayLimitEvent.create(0, 0));
    for (let id = 1; id <= 2; id++) {
      applyBoth(p, JoinRoomEvent.create(id, `p${id}`, null, null));
      applyBoth(p, SetPlayerTeamEvent.create(id, id as TeamId));
    }
    applyBoth(p, new StartGameEvent());
    // kick-off by nudging the ball, then keep it still away from the goals
    applyBoth(p, SetDiscPropertiesEvent.create(0, false, { xspeed: 0.5 }));
    let frame = 0;
    const tick = () => {
      p.off.step();
      p.ours.step();
      compareBytes(p, `golden goal tick ${++frame}`);
    };
    for (let i = 0; i < 10; i++) tick();
    applyBoth(p, SetDiscPropertiesEvent.create(0, false, { x: 0, y: 100, xspeed: 0, yspeed: 0 }));
    for (let i = 0; i < 3700; i++) tick();
    const gs = p.ours.rs.gameState!;
    expect(gs.phase).toBe(GamePhase.Playing);
    expect(gs.timeElapsed).toBeGreaterThan(60); // overtime: tied, game continues
    applyBoth(p, SetDiscPropertiesEvent.create(0, false, { x: 355, y: 0, xspeed: 6, yspeed: 0 }));
    for (let i = 0; i < 5; i++) tick();
    expect(p.ours.rs.gameState!.phase).toBe(GamePhase.AfterGoal);
    expect(p.ours.rs.gameState!.redScore).toBe(1);
    for (let i = 0; i < 150; i++) tick();
    expect(p.ours.rs.gameState!.phase).toBe(GamePhase.Ending);
    for (let i = 0; i < 300; i++) tick();
    expect(p.ours.rs.gameState).toBeNull();
    expect(events).toEqual([TeamId.Red, 10 + TeamId.Red, 99]);
    total += frame;
  });

  it('total ticks compared', () => {
    expect(total).toBeGreaterThanOrEqual(20000);
  });
});
