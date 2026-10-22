/**
 * readReplay / replayBody on hostile or oversized input: bounded inflate and
 * bounded event count, with real (valid) replays unaffected.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Writer } from '../../src/codec/index.js';
import { StartGameEvent, createRoomState, writeRoomState } from '../../src/room/index.js';
import {
  REPLAY_HEADER_SIZE,
  REPLAY_MAGIC,
  REPLAY_MAX_BODY_BYTES,
  REPLAY_MAX_EVENTS,
  ReplayData,
  ReplayFormatError,
  ReplayPlayer,
  readReplay,
  replayBody,
  writeReplay,
} from '../../src/replay/index.js';

const MIB = 1024 * 1024;

/** Header + raw-deflated `body`. */
function fileOf(body: Uint8Array, totalFrames = 1): Uint8Array {
  const d = deflateRawSync(body, { level: 9 });
  const file = new Uint8Array(REPLAY_HEADER_SIZE + d.length);
  const h = new DataView(file.buffer);
  h.setUint32(0, REPLAY_MAGIC);
  h.setUint32(4, 3);
  h.setUint32(8, totalFrames);
  file.set(d, REPLAY_HEADER_SIZE);
  return file;
}

function stateBytes(): Uint8Array {
  const w = new Writer(1024);
  writeRoomState(w, createRoomState());
  return w.copyBytes();
}

/** A valid replay with `n` StartGame events, one per frame. */
function replayWith(n: number, totalFrames = n): Uint8Array {
  const events = Array.from({ length: n }, (_, i) => {
    const ev = new StartGameEvent();
    ev.frame = i;
    return ev;
  });
  return writeReplay(new ReplayData(3, totalFrames, [], stateBytes(), events));
}

describe('readReplay limits', () => {
  it('rejects an inflate bomb without decoding its events', () => {
    // 64 MiB of zeros: a ~64 KB file that used to decode into 6 M event objects
    const bomb = fileOf(new Uint8Array(64 * MIB));
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(() => readReplay(bomb)).toThrow(ReplayFormatError);
    expect(() => readReplay(bomb)).toThrow(/limit/);
    expect(() => replayBody(bomb)).toThrow(/limit/);
    expect(() => new ReplayPlayer(bomb)).toThrow(ReplayFormatError);
  });

  it('maxBodyBytes: exact size accepted, one byte less rejected; Infinity lifts it', () => {
    const file = replayWith(50);
    const size = replayBody(file).length;
    expect(readReplay(file, { maxBodyBytes: size }).events.length).toBe(50);
    expect(replayBody(file, size).length).toBe(size);
    expect(() => readReplay(file, { maxBodyBytes: size - 1 })).toThrow(/limit/);
    expect(() => replayBody(file, size - 1)).toThrow(/limit/);
    expect(readReplay(file, { maxBodyBytes: Infinity }).events.length).toBe(50);
    expect(readReplay(file, { maxBodyBytes: 1e15 }).events.length).toBe(50);
  });

  it('a body above the default cap needs an explicit maxBodyBytes', () => {
    const bomb = fileOf(new Uint8Array(REPLAY_MAX_BODY_BYTES + 1));
    expect(() => readReplay(bomb, { maxEvents: 1 })).toThrow(/limit/);
    // with the cap lifted the next limit (events) is the one that fires
    expect(() => readReplay(bomb, { maxBodyBytes: Infinity, maxEvents: 1 })).toThrow(/too many events/);
  });

  it('maxEvents: exactly N accepted, N + 1 rejected', () => {
    const file = replayWith(5);
    expect(readReplay(file, { maxEvents: 5 }).events.length).toBe(5);
    expect(() => readReplay(file, { maxEvents: 4 })).toThrow(/too many events/);
    expect(() => readReplay(file, { maxEvents: 4 })).toThrow(ReplayFormatError);
    expect(readReplay(replayWith(0), { maxEvents: 0 }).events.length).toBe(0);
    expect(() => new ReplayPlayer(file, { maxEvents: 4 })).toThrow(/too many events/);
    expect(new ReplayPlayer(file, { maxEvents: 5 }).data.events.length).toBe(5);
  });

  it('the default event cap applies', () => {
    // zero events are 11 bytes each; one more than the cap fits well under the body cap
    const body = new Uint8Array((REPLAY_MAX_EVENTS + 2) * 11 + 4096);
    expect(body.length).toBeLessThan(REPLAY_MAX_BODY_BYTES);
    expect(() => readReplay(fileOf(body))).toThrow(/too many events/);
  });

  it('does not tie the total frame count to the events', () => {
    // the official recorder writes replays whose tail has no events at all
    const tail = readReplay(replayWith(1, 216000));
    expect(tail.totalFrames).toBe(216000);
    expect(tail.events.length).toBe(1);
    const empty = readReplay(replayWith(0, 0xffffffff));
    expect(empty.totalFrames).toBe(0xffffffff);
    expect(empty.events.length).toBe(0);
  });
});
