/**
 * What a ReplayRecorder writes with its default caps always reads back with
 * the default readReplay limits, whatever the events: payload-free events
 * (4 bytes: AutoTeams, StartGame, StopGame) would otherwise fit twice the
 * reader's event cap in the recorder's byte cap. The recorder also caps the
 * event count (`maxEvents`); the reader's limit errors name the option.
 */
import { describe, expect, it } from 'vitest';
import { deflateRaw } from '../../src/codec/index.js';
import { AutoTeamsEvent, SendChatIndicatorEvent, SendInputEvent, createRoomState } from '../../src/room/index.js';
import type { RoomEvent } from '../../src/room/index.js';
import {
  REPLAY_HEADER_SIZE,
  REPLAY_MAX_BODY_BYTES,
  REPLAY_MAX_EVENTS,
  REPLAY_RECORD_MAX_BYTES,
  ReplayRecorder,
  readReplay,
  replayBody,
} from '../../src/replay/index.js';

const rs = createRoomState();

/** Records `make(i)` at frame `frame(i)` with the default caps until the recording freezes. */
function recordUntilFrozen(make: (i: number) => RoomEvent, frame: (i: number) => number) {
  const rec = new ReplayRecorder();
  const froze: number[] = [];
  rec.onTruncated = (f) => froze.push(f);
  rec.start(rs, 0);
  let i = 0;
  while (!rec.truncated) rec.onEvent(make(i), frame(i++));
  const recorded = rec.recordedEvents;
  const bodyLength = rec.bodyLength;
  const file = rec.stop(frame(i));
  return { file, recorded, bodyLength, froze };
}

describe('recorder default caps fit the reader default limits', () => {
  it('payload-free events (4 bytes each, the smallest record): frozen at maxEvents, read back whole', () => {
    const auto = new AutoTeamsEvent();
    auto.byId = 7;
    const { file, recorded, bodyLength, froze } = recordUntilFrozen(
      () => auto,
      (i) => i >> 4,
    );
    expect(froze.length).toBe(1);
    expect(recorded).toBe(REPLAY_MAX_EVENTS);
    expect(bodyLength).toBeLessThan(REPLAY_RECORD_MAX_BYTES);
    const data = readReplay(file);
    expect(data.events.length).toBe(recorded);
    expect(data.totalFrames).toBe(froze[0]);
  });

  it('5-byte events and 8-byte inputs: whichever cap comes first, the default read accepts it', () => {
    const indicator = SendChatIndicatorEvent.create(1);
    indicator.byId = 3;
    const a = recordUntilFrozen(
      () => indicator,
      (i) => i,
    );
    expect(readReplay(a.file).events.length).toBe(a.recorded);
    const inputs = Array.from({ length: 32 }, (_, k) => {
      const ev = SendInputEvent.create(k);
      ev.byId = 2;
      return ev;
    });
    const b = recordUntilFrozen(
      (i) => inputs[i & 31]!,
      (i) => i * 200, // 2-byte frame deltas
    );
    expect(b.bodyLength).toBeGreaterThanOrEqual(REPLAY_RECORD_MAX_BYTES);
    expect(replayBody(b.file).length).toBeLessThan(REPLAY_MAX_BODY_BYTES);
    expect(readReplay(b.file).events.length).toBe(b.recorded);
  });

  it('maxEvents: option, setter and invalid values', () => {
    expect(new ReplayRecorder().maxEvents).toBe(REPLAY_MAX_EVENTS);
    const rec = new ReplayRecorder(3, { maxEvents: NaN });
    expect(rec.maxEvents).toBe(REPLAY_MAX_EVENTS);
    rec.maxEvents = -1;
    expect(rec.maxEvents).toBe(REPLAY_MAX_EVENTS);
    rec.maxEvents = 10;
    const froze: number[] = [];
    rec.onTruncated = (f) => froze.push(f);
    rec.start(rs, 100);
    const auto = new AutoTeamsEvent();
    for (let f = 100; f < 130; f++) rec.onEvent(auto, f);
    expect(rec.recordedEvents).toBe(10);
    expect(froze).toEqual([110]);
    const data = readReplay(rec.stop(200));
    expect(data.events.length).toBe(10);
    expect(data.totalFrames).toBe(10);
    expect(new ReplayRecorder(3, { maxEvents: Infinity }).maxEvents).toBe(Infinity);
  });
});

describe('readReplay limit errors name the option', () => {
  it('maxEvents and maxBodyBytes', () => {
    const rec = new ReplayRecorder();
    rec.start(rs, 0);
    const auto = new AutoTeamsEvent();
    for (let f = 0; f < 50; f++) rec.onEvent(auto, f);
    const file = rec.stop(50);
    expect(() => readReplay(file, { maxEvents: 20 })).toThrow('too many events (more than maxEvents = 20)');
    expect(() => readReplay(file, { maxBodyBytes: 100 })).toThrow(/^replay body larger than maxBodyBytes \(100\)/);
    // a corrupt body is still reported as such
    const bad = file.slice(0, REPLAY_HEADER_SIZE + 4);
    bad.set(deflateRaw(Uint8Array.of(1)).subarray(0, 1), REPLAY_HEADER_SIZE);
    expect(() => readReplay(bad)).toThrow(/^corrupt replay/);
  });
});
