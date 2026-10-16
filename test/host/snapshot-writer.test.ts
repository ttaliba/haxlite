/**
 * Join snapshot (msg 1) written through a writer reused across joins:
 * the bytes are exactly those of a fresh writer (also when a later snapshot
 * is smaller than an earlier one) and every call returns a fresh array.
 */
import { describe, expect, it } from 'vitest';
import { Writer, inflateRaw } from '../../src/codec/index.js';
import { HostMsg, type TeamId } from '../../src/protocol.js';
import {
  JoinRoomEvent,
  SendChatEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
  StopGameEvent,
  writeEventFrame,
  writeRoomState,
} from '../../src/room/index.js';
import { Sequencer, createHostRoomState } from '../../src/host/index.js';

/** The snapshot body as the pre-reuse code built it (a new Writer per join). */
function reference(seq: Sequencer, playerId: number): Uint8Array {
  const w = new Writer(2048);
  w.u16(playerId);
  w.u32(seq.frame);
  w.u32(seq.eventCounter);
  w.varUint(seq.eventsInFrame);
  writeRoomState(w, seq.rs);
  for (const ev of seq.queue) writeEventFrame(w, ev);
  return w.copyBytes();
}

function body(snap: Uint8Array): Uint8Array {
  expect(snap[0]).toBe(HostMsg.InitialSnapshot);
  return inflateRaw(snap.subarray(1));
}

describe('Sequencer.snapshot with a reused writer', () => {
  it('same bytes as a fresh writer, fresh array per call, smaller after larger', () => {
    const seq = new Sequencer(createHostRoomState({ noPlayer: true }), { broadcast() {}, hasConnections: () => true });
    const snaps: Uint8Array[] = [];
    const check = (id: number) => {
      const s = seq.snapshot(id);
      expect(body(s)).toEqual(reference(seq, id));
      for (const prev of snaps) expect(prev.buffer).not.toBe(s.buffer);
      snaps.push(s);
      return s;
    };
    check(1);
    for (let i = 1; i <= 12; i++) {
      seq.hostEvent(JoinRoomEvent.create(i, `player ${i}`.repeat(2), 'ar', null));
      seq.hostEvent(SetPlayerTeamEvent.create(i, (1 + (i & 1)) as TeamId));
    }
    seq.hostEvent(new StartGameEvent());
    seq.advance(30);
    seq.hostEvent(SendChatEvent.create('queued')); // non-delay: applied now
    const big = check(13);
    const bigBody = body(big);
    // a delay event left in the queue travels with the snapshot
    const ev = SendChatEvent.create('x');
    ev.frame = seq.frame + 3;
    seq.submit(ev);
    check(14);
    seq.hostEvent(new StopGameEvent());
    seq.advance(5);
    const small = check(15);
    expect(body(small).length).toBeLessThan(bigBody.length);
    // the earlier result was not overwritten by the later calls
    expect(body(big)).toEqual(bigBody);
  });
});
