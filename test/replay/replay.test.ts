/**
 * Replay (.hbr2) differential tests.
 *
 * A randomized game (inputs incl. kicks, goals, joins/leaves, start/stop/
 * pause, stadium changes, admin events, SetDiscProperties…) is driven with
 * identical event bytes through
 *   - OUR room (src/room) + OUR ReplayRecorder, and
 *   - the OFFICIAL headless RoomState + the OFFICIAL recorder (`cb`),
 * both recording the same window of frames. Then:
 *   (b) header + inflated body of our file == the official recorder's;
 *   (a) our file is read by node-haxball (Replay.readAll + its replay player)
 *       and by the official browser client player (`$b`, when available):
 *       same metadata, and re-simulation reaches the same states;
 *   (c) our ReplayPlayer reproduces the same states (seek forward/back).
 */
import { describe, expect, it } from 'vitest';
import { inflateRaw, xorInt32Words } from '../../src/codec/index.js';
import { defaultStadiums, parseHbs } from '../../src/sim/index.js';
import { decodeEvent, roomStateChecksum } from '../../src/room/index.js';
import { ReplayPlayer, ReplayRecorder, readReplay, replayBody, writeReplay } from '../../src/replay/index.js';
import { OurRoom, RandomDriver, compareBytes } from '../room/harness.js';
import type { Pair } from '../room/harness.js';
import { CUSTOM_HBS } from '../room/fixtures.js';
import type { OfficialRoom } from '../oracle/official.js';
import { nh, nhWriter, prng } from '../oracle/index.js';
import { OfficialClientReplay, OfficialRecordingRoom, clientAvailable } from './official-replay.js';
import { hex } from '../room/helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FRAMES = Number(process.env.HAXLITE_REPLAY_FRAMES ?? 12000);
const CHECKPOINT_EVERY = 500;

/** Our room with the recorder wired like the host must do it (record after apply, at the current frame). */
class RecordingOurRoom extends OurRoom {
  readonly recorder = new ReplayRecorder();
  override applyEventBytes(bytes: Uint8Array, byId = 0): this {
    const ev = decodeEvent(bytes, byId);
    ev.apply(this.rs);
    this.recorder.onEvent(ev, this.frame);
    return this;
  }
}

interface Scenario {
  ours: Uint8Array;
  official: Uint8Array;
  frames: number;
  /** checksum of the recorded room at relative frame k (after k ticks, before frame k's events). */
  checkpoints: { frame: number; checksum: number; bytes: Uint8Array }[];
  finalState: Uint8Array;
  goals: number;
  events: number;
  goalMarkers: { frame: number; team: number }[];
}

function runScenario(seed: number, frames: number, opts: { stadium: 'custom' | number; players: number; scoreLimit: number; timeLimit: number }): Scenario {
  const ours = new RecordingOurRoom();
  const off = new OfficialRecordingRoom();
  const p: Pair = { ours, off: off as unknown as OfficialRoom };
  const stadiums = defaultStadiums();
  const custom = parseHbs(CUSTOM_HBS);
  const main = opts.stadium === 'custom' ? custom : stadiums[opts.stadium]!;
  const driver = new RandomDriver({ rnd: prng(seed), stadiums: [main, stadiums[1]!, custom], eventRate: 0.03 });
  driver.setup(p, opts.players, { stadium: main, scoreLimit: opts.scoreLimit, timeLimit: opts.timeLimit });

  const tick = (): void => {
    driver.inputs(p);
    driver.others(p);
    off.step();
    ours.step();
  };
  // warm-up so the recording starts mid-game at a non-zero host frame
  for (let i = 0; i < 137; i++) tick();
  compareBytes(p, 'before recording');

  const goalMarkers: { frame: number; team: number }[] = [];
  let goals = 0;
  ours.rs.hooks.onGoalMarker = (team) => goalMarkers.push({ frame: ours.frame, team });
  ours.rs.hooks.onTeamGoal = () => goals++;
  const startFrame = ours.frame;
  ours.recorder.start(ours.rs, ours.frame, ours); // chains the onGoalMarker hook above
  off.startRecording();

  const checkpoints: Scenario['checkpoints'] = [];
  for (let k = 0; k < frames; k++) {
    if (k % CHECKPOINT_EVERY === 0) {
      const bytes = ours.stateBytes();
      checkpoints.push({ frame: k, checksum: roomStateChecksum(ours.rs), bytes });
      if (off.checksum() !== ours.checksum()) compareBytes(p, `frame ${k}`);
    }
    tick();
  }
  compareBytes(p, 'at stop');
  const oursFile = ours.recorder.stop(ours.frame);
  const officialFile = off.stopRecording();
  return {
    ours: oursFile,
    official: officialFile,
    frames,
    checkpoints,
    finalState: ours.stateBytes(),
    goals,
    events: ours.recorder.recordedEvents,
    goalMarkers: goalMarkers.map((g) => ({ frame: g.frame - startFrame, team: g.team })),
  };
}

function firstDiff(a: Uint8Array, b: Uint8Array): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `differ at ${i} (lengths ${a.length} vs ${b.length})\nA …${hex(a.subarray(Math.max(0, i - 16), i + 32))}\nB …${hex(b.subarray(Math.max(0, i - 16), i + 32))}`;
}

function expectSameBytes(a: Uint8Array, b: Uint8Array, label: string): void {
  if (Buffer.compare(a, b) !== 0) throw new Error(`${label}: ${firstDiff(a, b)}`);
}

/** node-haxball's asynchronous replay player, pumped synchronously to `frame`. Returns [frame reached, state bytes]. */
function nhReplayTo(bytes: Uint8Array, frame: number): { frame: number; state: Uint8Array } {
  let raf: (() => void) | null = null;
  const reader = nh.Replay.read(
    Uint8Array.from(bytes),
    {},
    {
      requestAnimationFrame: (cb: () => void) => {
        raf = cb;
        return 1;
      },
      cancelAnimationFrame: () => {
        raf = null;
      },
    },
  );
  let reached = false;
  reader.onDestinationTimeReached = () => {
    reached = true;
  };
  reader.setCurrentFrameNo(frame);
  for (let guard = 0; !reached && guard < 100000 && raf !== null; guard++) (raf as () => void)();
  const w = nhWriter(8192);
  reader.state.l(w);
  const state = Uint8Array.from(w.toUint8Array() as Uint8Array);
  const reachedFrame = reader.getCurrentFrameNo() as number;
  reader.destroy();
  return { frame: reachedFrame, state };
}

const SCENARIOS = [
  { name: 'Classic 4p, score 3 / 3 min', seed: 9101, stadium: 0, players: 4, scoreLimit: 3, timeLimit: 3 },
  { name: 'custom .hbs 3p (joints, gravity, full kickoff reset)', seed: 9202, stadium: 'custom' as const, players: 3, scoreLimit: 0, timeLimit: 0 },
];

describe('replay recorder vs official recorder and readers', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      let s: Scenario;
      const get = (): Scenario => (s ??= runScenario(sc.seed, FRAMES, sc));

      it(`(b) ${FRAMES} frames: header and inflated body byte-identical to the official recorder`, () => {
        const r = get();
        expect(r.events).toBeGreaterThan(1000);
        expect(r.goals).toBeGreaterThan(0);
        expectSameBytes(r.ours.subarray(0, 12), r.official.subarray(0, 12), 'header');
        expectSameBytes(replayBody(r.ours), replayBody(r.official), 'inflated body');
        // the official recorder's file goes through our reader too
        expect(readReplay(r.official).events.length).toBe(r.events);
      });

      it('(c) our reader + ReplayPlayer reproduce every checkpoint and the final state', () => {
        const r = get();
        const data = readReplay(r.ours);
        expect(data.version).toBe(3);
        expect(data.totalFrames).toBe(r.frames);
        expect(data.events.length).toBe(r.events);
        expect(data.goalMarkers).toEqual(r.goalMarkers);
        expectSameBytes(data.stateBytes, r.checkpoints[0]!.bytes, 'initial state');
        const player = new ReplayPlayer(data);
        for (const cp of r.checkpoints) {
          player.seek(cp.frame);
          expect(player.frame).toBe(cp.frame);
          expect(roomStateChecksum(player.rs)).toBe(cp.checksum);
        }
        // rewind (re-simulates from the start) and go forward again
        const mid = r.checkpoints[Math.floor(r.checkpoints.length / 2)]!;
        player.seek(mid.frame);
        expect(roomStateChecksum(player.rs)).toBe(mid.checksum);
        player.seek(r.frames);
        expect(player.ended).toBe(true);
        expectSameBytes(new OurRoom(player.rs).stateBytes(), r.finalState, 'final state (ReplayPlayer)');
        // writeReplay(readReplay(x)) re-encodes the same body
        expectSameBytes(replayBody(writeReplay(data)), replayBody(r.ours), 'writeReplay round trip');
      });

      it('(a) node-haxball Replay.readAll + its replay player accept our file and reach the same states', () => {
        const r = get();
        const data = nh.Replay.readAll(Uint8Array.from(r.ours));
        expect(data.version).toBe(3);
        expect(data.totalFrames).toBe(r.frames);
        expect(data.events.length).toBe(r.events);
        expect(data.goalMarkers.map((g: Any) => ({ frame: g.frameNo, team: g.teamId }))).toEqual(r.goalMarkers);
        const ours = new ReplayPlayer(r.ours);
        for (const target of [r.checkpoints[3]!.frame, r.frames]) {
          const got = nhReplayTo(r.ours, target);
          expect(Math.abs(got.frame - target)).toBeLessThanOrEqual(1); // nh converts frames to ms and back
          ours.seek(got.frame);
          expectSameBytes(got.state, new OurRoom(ours.rs).stateBytes(), `node-haxball player at frame ${got.frame}`);
        }
      });

      it.skipIf(!clientAvailable)('(a) official browser client replay player ($b) reaches the same states', () => {
        const r = get();
        const client = new OfficialClientReplay(r.ours);
        expect(client.totalFrames).toBe(r.frames);
        expect(client.goalMarkers()).toEqual(r.goalMarkers);
        for (const cp of r.checkpoints) {
          client.stepTo(cp.frame);
          const bytes = client.stateBytes();
          if (xorInt32Words(bytes) !== cp.checksum) expectSameBytes(bytes, cp.bytes, `client player at frame ${cp.frame}`);
        }
        client.stepTo(r.frames);
        expectSameBytes(client.stateBytes(), r.finalState, 'final state (official client player)');
      });
    });
  }
});

describe('ReplayRecorder unit behaviour', () => {
  it('is a no-op when not recording, and reusable across recordings', () => {
    const room = new RecordingOurRoom();
    const rec = room.recorder;
    expect(rec.isRecording).toBe(false);
    rec.onEvent(decodeEvent(new Uint8Array([7])), 5); // StartGame, ignored
    rec.onGoalMarker(1, 5);
    expect(rec.recordedEvents).toBe(0);
    expect(() => rec.stop(0)).toThrow();

    rec.start(room.rs, 990);
    rec.onGoalMarker(1, 995);
    rec.start(room.rs, 1000); // restart discards the previous recording (official behaviour)
    const empty = rec.stop(1000);
    const d = readReplay(empty);
    expect(d.totalFrames).toBe(0);
    expect(d.events.length).toBe(0);
    expect(d.goalMarkers.length).toBe(0);
    expect(nh.Replay.readAll(Uint8Array.from(empty)).totalFrames).toBe(0);
    // header layout
    expect(hex(empty.subarray(0, 12))).toBe('48425232' + '00000003' + '00000000');

    rec.start(room.rs, 50);
    room.frame = 50;
    room.applyEventBytes(new Uint8Array([7]), 0); // StartGame at frame 50
    room.step(10);
    const second = readReplay(rec.stop(room.frame));
    expect(second.totalFrames).toBe(10);
    expect(second.events.map((e) => [e.frame, e.type, e.byId])).toEqual([[0, 7, 0]]);
  });

  it('installs/chains/restores the goal hook with a clock; snapshot() does not stop', () => {
    const room = new OurRoom();
    const rec = new ReplayRecorder();
    const seen: number[] = [];
    const prev = (t: number): void => {
      seen.push(t);
    };
    room.rs.hooks.onGoalMarker = prev;
    const clock = { frame: 7 };
    rec.start(room.rs, 3, clock);
    expect(room.rs.hooks.onGoalMarker).not.toBe(prev);
    room.rs.hooks.onGoalMarker!(2);
    clock.frame = 20;
    room.rs.hooks.onGoalMarker!(1);
    expect(seen).toEqual([2, 1]);
    const snap = readReplay(rec.snapshot(25));
    expect(snap.goalMarkers).toEqual([
      { frame: 4, team: 2 },
      { frame: 17, team: 1 },
    ]);
    expect(rec.isRecording).toBe(true);
    rec.onGoalMarker(2, 30);
    const done = readReplay(rec.stop(31));
    expect(done.totalFrames).toBe(28);
    expect(done.goalMarkers.map((g) => g.frame)).toEqual([4, 17, 27]);
    expect(room.rs.hooks.onGoalMarker).toBe(prev);
  });

  it('ReplayPlayer.finish() applies events stamped with the final frame', () => {
    const room = new RecordingOurRoom();
    room.recorder.start(room.rs, 0);
    room.step(5);
    room.applyEventBytes(new Uint8Array([7]), 0); // StartGame at frame 5 == stop frame
    const file = room.recorder.stop(room.frame);
    const player = new ReplayPlayer(file);
    player.seek(5);
    expect(player.rs.gameState).toBeNull();
    expect(player.finish().gameState).not.toBeNull();
    expectSameBytes(new OurRoom(player.rs).stateBytes(), room.stateBytes(), 'state at stop');
  });

  it('rejects bad magic, other versions and corrupt bodies', () => {
    const room = new OurRoom();
    const rec = new ReplayRecorder();
    rec.start(room.rs, 0);
    const good = rec.stop(0);
    const badMagic = good.slice();
    badMagic[0] = 0x41;
    expect(() => readReplay(badMagic)).toThrow(/magic/);
    const v2 = good.slice();
    v2[7] = 2;
    expect(() => readReplay(v2)).toThrow(/version 2/);
    expect(() => readReplay(good.subarray(0, 8))).toThrow(/truncated/);
    const corrupt = good.slice(0, good.length - 3);
    expect(() => readReplay(corrupt)).toThrow();
    // body: inflated layout starts with the u16 marker count then the RoomState
    const body = inflateRaw(good.subarray(12));
    expect(body[0]).toBe(0);
    expect(body[1]).toBe(0);
    expectSameBytes(body.subarray(2), room.stateBytes(), 'body state');
  });
});
