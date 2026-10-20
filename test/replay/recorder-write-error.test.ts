/**
 * ReplayRecorder.onEvent with an event whose payload can't be encoded (a
 * SetStadium over the wire limit throws CodecError): the error propagates,
 * nothing of that event stays in the log and the recording reads back.
 */
import { describe, expect, it } from 'vitest';
import { CodecError } from '../../src/codec/index.js';
import { SendChatEvent, SetStadiumEvent, createRoomState } from '../../src/room/index.js';
import { ReplayPlayer, ReplayRecorder } from '../../src/replay/index.js';
import { parseHbs } from '../../src/sim/index.js';

describe('ReplayRecorder event that fails to encode', () => {
  it('leaves the log as it was before the event', () => {
    const rs = createRoomState();
    const rec = new ReplayRecorder();
    rec.start(rs, 0);
    const chat = (text: string, frame: number): void => {
      const ev = SendChatEvent.create(text);
      ev.byId = 0;
      rec.onEvent(ev, frame);
    };
    chat('a', 1);
    const length = rec.bodyLength;
    const joints = Array.from({ length: 256 }, () => ({ d0: 0, d1: 1 }));
    const bad = SetStadiumEvent.create(parseHbs(JSON.stringify({ name: 'x', width: 10, height: 10, bg: {}, discs: [{}, {}], joints })));
    expect(() => rec.onEvent(bad, 5)).toThrow(CodecError);
    expect(rec.bodyLength).toBe(length);
    chat('b', 9);
    const player = new ReplayPlayer(rec.stop(12));
    expect(player.data.events.map((e) => [e.frame, (e as SendChatEvent).message])).toEqual([
      [1, 'a'],
      [9, 'b'],
    ]);
  });
});
