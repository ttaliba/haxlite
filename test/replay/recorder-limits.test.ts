/**
 * ReplayRecorder: capped event log (clean freeze instead of unbounded growth)
 * and the faster deflate of large synchronous stops/snapshots.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { KickBanPlayerEvent, SendChatEvent, createRoomState } from '../../src/room/index.js';
import type { RoomEvent } from '../../src/room/index.js';
import { REPLAY_HEADER_SIZE, REPLAY_MAX_BODY_BYTES, REPLAY_RECORD_MAX_BYTES, ReplayPlayer, ReplayRecorder, readReplay, replayBody } from '../../src/replay/index.js';

const rs = createRoomState();

/** What a joined non-admin can make the host record: a kick with a long reason. */
function kick(reason: string): RoomEvent {
  const ev = KickBanPlayerEvent.create(5, reason, false);
  ev.byId = 1;
  return ev;
}

function chat(text: string): RoomEvent {
  const ev = SendChatEvent.create(text);
  ev.byId = 1;
  return ev;
}

/** Size of the recording body right after `start` (the RoomState and the marker count). */
function baseLength(): number {
  const r = new ReplayRecorder();
  r.start(rs, 0);
  return r.bodyLength;
}

const FAST_LEVEL = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 2 : 1;
const deflateAt = (body: Uint8Array, level: number): Buffer => deflateRawSync(body, { level, memLevel: 8, windowBits: 15 });

describe('ReplayRecorder maxBytes', () => {
  it('freezes at the cap: later events are not recorded and the replay ends there', () => {
    const base = baseLength();
    const rec = new ReplayRecorder(3, { maxBytes: base + 1500 });
    const frozen: number[] = [];
    rec.onTruncated = (frame) => frozen.push(frame);
    rec.start(rs, 100);
    const ev = kick('x'.repeat(100));
    for (let i = 0; i < 60; i++) rec.onEvent(ev, 100 + i);
    rec.onGoalMarker(1, 150);

    expect(rec.truncated).toBe(true);
    expect(frozen.length).toBe(1);
    const capFrame = frozen[0]!;
    expect(capFrame).toBeGreaterThan(100);
    expect(rec.recordedEvents).toBe(capFrame - 100); // one event per frame, all before the cap
    expect(rec.recordedGoalMarkers).toBe(0);
    expect(rec.isRecording).toBe(true);
    // at most one event past the cap, and nothing more after it
    expect(rec.bodyLength).toBeLessThan(base + 1500 + 200);
    const length = rec.bodyLength;
    rec.onEvent(ev, 170);
    expect(rec.bodyLength).toBe(length);
    expect(frozen.length).toBe(1);

    // the file stops at the frozen frame, whenever it was stopped
    const snap = readReplay(rec.snapshot(400));
    expect(snap.totalFrames).toBe(capFrame - 100);
    const file = rec.stop(500);
    const data = readReplay(file);
    expect(data.totalFrames).toBe(capFrame - 100);
    expect(data.events.length).toBe(capFrame - 100);
    expect(data.events.every((e) => e.frame <= data.totalFrames)).toBe(true);
    expect(new ReplayPlayer(file).finish().players.length).toBe(0);
    expect(rec.truncated).toBe(true); // still readable after stop

    // a new recording starts clean
    rec.start(rs, 600);
    expect(rec.truncated).toBe(false);
    rec.onEvent(kick('y'), 601);
    expect(rec.recordedEvents).toBe(1);
    expect(readReplay(rec.stop(610)).totalFrames).toBe(10);
  });

  it('below the cap the bytes are the same with or without a limit', () => {
    const run = (rec: ReplayRecorder): Uint8Array => {
      rec.start(rs, 7);
      for (let i = 0; i < 200; i++) rec.onEvent(i % 3 === 0 ? chat(`message ${i}`) : kick('r'.repeat(i % 50)), 7 + i);
      rec.onGoalMarker(2, 120);
      return rec.stop(300);
    };
    const a = run(new ReplayRecorder());
    const b = run(new ReplayRecorder(3, { maxBytes: Infinity }));
    const c = run(new ReplayRecorder(3, { maxBytes: 1e9 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(true);
    expect(readReplay(a).totalFrames).toBe(293);
  });

  it('an invalid maxBytes falls back to the default', () => {
    const rec = new ReplayRecorder(3, { maxBytes: NaN });
    expect(rec.maxBytes).toBe(REPLAY_RECORD_MAX_BYTES);
    rec.maxBytes = -5;
    expect(rec.maxBytes).toBe(REPLAY_RECORD_MAX_BYTES);
    rec.maxBytes = 12345;
    expect(rec.maxBytes).toBe(12345);
    expect(new ReplayRecorder().maxBytes).toBe(REPLAY_RECORD_MAX_BYTES);
  });

  it('caps a flood of kicks at the default and still writes a readable replay', () => {
    const rec = new ReplayRecorder();
    rec.start(rs, 0);
    // 311 bytes per event: 80 000 of them are ~25 MB
    const reasons = Array.from({ length: 64 }, (_, k) => String(k).padStart(4, '0') + '€'.repeat(96));
    const events = reasons.map(kick);
    for (let i = 0; i < 80_000; i++) rec.onEvent(events[i & 63]!, i);
    expect(rec.truncated).toBe(true);
    expect(rec.bodyLength).toBeLessThan(REPLAY_RECORD_MAX_BYTES + 1024);
    expect(rec.bodyLength).toBeGreaterThanOrEqual(REPLAY_RECORD_MAX_BYTES);
    const recorded = rec.recordedEvents;
    const file = rec.stop(80_000);
    // what we record always fits what we read by default
    expect(replayBody(file).length).toBeLessThan(REPLAY_MAX_BODY_BYTES);
    expect(readReplay(file).events.length).toBe(recorded);
  });
});

describe('ReplayRecorder synchronous deflate', () => {
  /** A recorder whose body is exactly `size` bytes (chat messages, the last one trimmed to fit). */
  function recorderOfSize(size: number): ReplayRecorder {
    const rec = new ReplayRecorder();
    rec.start(rs, 0);
    const filler = chat('lorem ipsum dolor sit amet '.repeat(4).slice(0, 100));
    let frame = 0;
    while (rec.bodyLength < size - 120) rec.onEvent(filler, frame++);
    // frame delta (1) + byId (2) + type (1) + length (1) + text
    rec.onEvent(chat('z'.repeat(size - rec.bodyLength - 5)), frame++);
    expect(rec.bodyLength).toBe(size);
    return rec;
  }

  it('up to 64 KiB the bytes are the level 6 ones; beyond, the fast level', async () => {
    for (const [size, level] of [
      [65536, 6],
      [65537, FAST_LEVEL],
    ] as const) {
      const rec = recorderOfSize(size);
      const body = (rec as unknown as { body(): Uint8Array }).body().slice();
      const snap = rec.snapshot(10);
      const file = rec.stop(10);
      expect(Buffer.from(snap.subarray(REPLAY_HEADER_SIZE)).equals(deflateAt(body, level))).toBe(true);
      expect(Buffer.from(file.subarray(REPLAY_HEADER_SIZE)).equals(deflateAt(body, level))).toBe(true);
      expect(replayBody(file)).toEqual(body);
    }
  });

  it('the async variants keep level 6 at any size, and read back the same', async () => {
    const rec = recorderOfSize(200_000);
    const body = (rec as unknown as { body(): Uint8Array }).body().slice();
    const sync = rec.snapshot(10);
    const async = await rec.snapshotAsync(10);
    const stopped = await rec.stopAsync(10);
    expect(Buffer.from(async.subarray(REPLAY_HEADER_SIZE)).equals(deflateAt(body, 6))).toBe(true);
    expect(Buffer.from(stopped).equals(Buffer.from(async))).toBe(true);
    expect(Buffer.from(sync.subarray(REPLAY_HEADER_SIZE)).equals(deflateAt(body, FAST_LEVEL))).toBe(true);
    expect(readReplay(sync).events.length).toBe(readReplay(async).events.length);
  });
});
