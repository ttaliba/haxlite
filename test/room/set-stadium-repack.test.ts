/**
 * A SetStadium payload deflated by the official client (pako) can fit the
 * u16 length while our own deflate of the same stadium does not. It is a
 * valid payload: it decodes, and the host drops the event (reported through
 * onError) instead of dropping the admin who sent it. Payloads that are
 * really invalid (deflate bomb, corrupt stream) still fail as codec errors.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CodecError, Reader, Writer, deflateRaw } from '../../src/codec/index.js';
import { Sequencer, SequencerClient } from '../../src/host/index.js';
import { JoinRoomEvent, STADIUM_PACKED_LIMIT, SetPlayerAdminEvent, SetStadiumEvent, createRoomState } from '../../src/room/index.js';
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

/** A stadium whose pako deflate (official client) fits the u16 and ours does not, with that payload. */
function pakoOnlyFit(): { stadium: Stadium; packed: Uint8Array; ours: number } {
  for (let u = 1600; u <= 1800; u += 5) {
    const stadium = parseHbs(JSON.stringify({ name: 'x', width: 10, height: 10, bg: {}, discs: [{}, {}] }));
    stadium.name = nameOf(u);
    const bytes = raw(stadium);
    const packed = pako.deflateRaw(bytes);
    const ours = deflateRaw(bytes).length;
    if (packed.length <= STADIUM_PACKED_LIMIT && ours > STADIUM_PACKED_LIMIT) return { stadium, packed, ours };
  }
  throw new Error('no stadium found that pako fits and our deflate does not');
}

function clientPayload(packed: Uint8Array): Uint8Array {
  const w = new Writer(packed.length + 2);
  w.u16(packed.length);
  w.bytes(packed);
  return w.copyBytes();
}

/** Client message 1 body: requested frame, client seq, type 11, payload. */
function clientMessage(payload: Uint8Array, seq: number): Uint8Array {
  const w = new Writer(payload.length + 9);
  w.u32(0);
  w.u32(seq);
  w.u8(11);
  w.bytes(payload);
  return w.copyBytes();
}

describe('SetStadium deflated tighter by the sender than by us', () => {
  const fit = pakoOnlyFit();

  it('decodes, and wireError reports that it cannot be sent on', () => {
    expect(fit.packed.length).toBeLessThanOrEqual(STADIUM_PACKED_LIMIT);
    expect(fit.ours).toBeGreaterThan(STADIUM_PACKED_LIMIT);
    const ev = new SetStadiumEvent();
    ev.read(new Reader(clientPayload(fit.packed)));
    expect(ev.stadium!.name).toBe(fit.stadium.name);
    expect(ev.wireError()).toMatch(/^Stadium too large: deflated \d+ > 65535$/);
    const w = new Writer(16);
    expect(() => ev.write(w)).toThrow(CodecError);
    expect(w.finish().length).toBe(0);
  });

  it('Sequencer: dropped and reported, the admin is not dropped and can set another stadium', () => {
    const sent: number[] = [];
    const errors: unknown[] = [];
    const seq = new Sequencer(createRoomState(), { broadcast: (d) => sent.push(d.length), hasConnections: () => true });
    seq.onError = (e) => errors.push(e);
    seq.hostEvent(JoinRoomEvent.create(1, 'admin', 'uy', null));
    seq.hostEvent(SetPlayerAdminEvent.create(1, true));
    const client = new SequencerClient(1);
    const before = seq.rs.stadium;
    const sentBefore = sent.length;
    expect(seq.clientMessage(client, new Reader(clientMessage(clientPayload(fit.packed), 1)), 0)).toBeNull();
    seq.advance(2);
    expect(seq.rs.stadium).toBe(before);
    expect(sent.length).toBe(sentBefore);
    expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringMatching(/^SetStadium from player 1 dropped: Stadium too large: deflated \d+ > 65535$/)]);

    const small = parseHbs(JSON.stringify({ name: 'small', width: 10, height: 10, bg: {}, discs: [{}, {}] }));
    const ok = seq.clientMessage(client, new Reader(clientMessage(clientPayload(pako.deflateRaw(raw(small))), 2)), 0);
    expect(ok).not.toBeNull();
    seq.advance(2);
    expect(seq.rs.stadium?.name).toBe('small');
    expect(sent.length).toBe(sentBefore + 1);
  });

  it('a corrupt deflate stream is still a codec error', () => {
    const bad = clientPayload(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
    expect(() => new SetStadiumEvent().read(new Reader(bad))).toThrow(CodecError);
  });
});
