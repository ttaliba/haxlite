/**
 * A client SetStadium that our deflate cannot fit back in the u16 length is
 * dropped before onBeforeOperation sees it: an operator hook (quota, log,
 * cooldown) never approves a stadium change that is then discarded. A hook
 * that edits the stadium still gets its edit broadcast, and one that makes
 * it unsendable gets it dropped and reported.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Reader, Writer, deflateRaw } from '../../src/codec/index.js';
import { Sequencer, SequencerClient } from '../../src/host/index.js';
import { EventType } from '../../src/protocol.js';
import { JoinRoomEvent, STADIUM_PACKED_LIMIT, SetPlayerAdminEvent, SetStadiumEvent, createRoomState } from '../../src/room/index.js';
import type { RoomEvent } from '../../src/room/index.js';
import { parseHbs, writeStadium } from '../../src/sim/index.js';
import type { Stadium } from '../../src/sim/index.js';

const require = createRequire(import.meta.url);
/** The official client's deflate. */
const pako = require('pako') as { deflateRaw(d: Uint8Array): Uint8Array };

function xorshift(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-like noise, then 150 000 chars drawn from 50 repeated words, then random BMP text. */
function nameOf(unicode: number): string {
  let r = xorshift(3);
  let s = '';
  for (let i = 0; i < 68_000; i++) s += ABC[Math.floor(r() * 64)];
  r = xorshift(9);
  const words: string[] = [];
  for (let i = 0; i < 50; i++) {
    let w = 'QQQ';
    for (let j = 0; j < 40; j++) w += ABC[Math.floor(r() * 64)];
    words.push(w);
  }
  let tail = '';
  while (tail.length < 150_000) tail += words[Math.floor(r() * words.length)];
  s += tail.slice(0, 150_000);
  r = xorshift(11);
  for (let i = 0; i < unicode; i++) s += String.fromCharCode(0x800 + Math.floor(r() * 0xd000));
  return s;
}

function raw(s: Stadium): Uint8Array {
  const w = new Writer(1024);
  writeStadium(w, s);
  return w.copyBytes();
}

function small(name: string): Stadium {
  return parseHbs(JSON.stringify({ name, width: 10, height: 10, bg: {}, discs: [{}, {}] }));
}

/** A stadium whose pako deflate (official client) fits the u16 and ours does not, with that payload. */
function pakoOnlyFit(): { stadium: Stadium; packed: Uint8Array } {
  for (let u = 1600; u <= 1800; u += 5) {
    const stadium = small('x');
    stadium.name = nameOf(u);
    const bytes = raw(stadium);
    const packed = pako.deflateRaw(bytes);
    if (packed.length <= STADIUM_PACKED_LIMIT && deflateRaw(bytes).length > STADIUM_PACKED_LIMIT) return { stadium, packed };
  }
  throw new Error('no stadium found that pako fits and our deflate does not');
}

/** Client message 1 body: requested frame, client seq, type 11, u16 length + deflated stadium. */
function clientMessage(packed: Uint8Array, seq: number): Reader {
  const w = new Writer(packed.length + 11);
  w.u32(0);
  w.u32(seq);
  w.u8(EventType.SetStadium);
  w.u16(packed.length);
  w.bytes(packed);
  return new Reader(w.copyBytes());
}

function setup(): { seq: Sequencer; client: SequencerClient; errors: string[]; sent: number[] } {
  const sent: number[] = [];
  const errors: string[] = [];
  const seq = new Sequencer(createRoomState(), { broadcast: (d) => sent.push(d.length), hasConnections: () => true });
  seq.onError = (e) => errors.push((e as Error).message);
  seq.hostEvent(JoinRoomEvent.create(1, 'admin', 'uy', null));
  seq.hostEvent(SetPlayerAdminEvent.create(1, true));
  return { seq, client: new SequencerClient(1), errors, sent };
}

/** The stadium the event carries on the wire (what the broadcast sends). */
function onWire(ev: RoomEvent): Stadium {
  const w = new Writer(1024);
  ev.write(w);
  const back = new SetStadiumEvent();
  back.read(new Reader(w.copyBytes()));
  return back.stadium!;
}

describe('client SetStadium: wire limits before onBeforeOperation', () => {
  const fit = pakoOnlyFit();

  it('an unsendable stadium never reaches the hook; it is reported and the admin stays', () => {
    const { seq, client, errors, sent } = setup();
    const seen: number[] = [];
    seq.onBeforeOperation = (ev, byId) => {
      seen.push(ev.type, byId);
      return true;
    };
    const before = seq.rs.stadium;
    const sentBefore = sent.length;
    expect(seq.clientMessage(client, clientMessage(fit.packed, 1), 0)).toBeNull();
    seq.advance(2);
    expect(seen).toEqual([]);
    expect(seq.rs.stadium).toBe(before);
    expect(sent.length).toBe(sentBefore);
    expect(errors).toEqual([expect.stringMatching(/^SetStadium from player 1 dropped: Stadium too large: deflated \d+ > 65535$/)]);
    // the next stadium of the same admin reaches the hook and is applied
    const ev = seq.clientMessage(client, clientMessage(pako.deflateRaw(raw(small('next'))), 2), 0);
    expect(ev).not.toBeNull();
    expect(seen).toEqual([EventType.SetStadium, 1]);
    seq.advance(2);
    expect(seq.rs.stadium?.name).toBe('next');
    expect(errors.length).toBe(1);
  });

  it('a stadium the hook edits in place is sent with the edit', () => {
    const { seq, client, errors } = setup();
    seq.onBeforeOperation = (ev) => {
      if (ev instanceof SetStadiumEvent) ev.stadium!.name = 'renamed by the operator';
    };
    const ev = seq.clientMessage(client, clientMessage(pako.deflateRaw(raw(small('original'))), 1), 0);
    expect(ev).not.toBeNull();
    expect(onWire(ev!).name).toBe('renamed by the operator');
    seq.advance(2);
    expect(seq.rs.stadium?.name).toBe('renamed by the operator');
    expect(errors).toEqual([]);
  });

  it('a stadium the hook makes unsendable is dropped and reported after it', () => {
    const { seq, client, errors, sent } = setup();
    let calls = 0;
    seq.onBeforeOperation = (ev) => {
      calls++;
      if (ev instanceof SetStadiumEvent) ev.stadium = fit.stadium;
    };
    const before = seq.rs.stadium;
    const sentBefore = sent.length;
    expect(seq.clientMessage(client, clientMessage(pako.deflateRaw(raw(small('original'))), 1), 0)).toBeNull();
    seq.advance(2);
    expect(calls).toBe(1);
    expect(seq.rs.stadium).toBe(before);
    expect(sent.length).toBe(sentBefore);
    expect(errors).toEqual([expect.stringMatching(/^SetStadium from player 1 dropped: Stadium too large/)]);
  });
});
