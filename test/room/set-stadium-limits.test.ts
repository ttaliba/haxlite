/**
 * SetStadium size limits: the inflated payload is capped (deflate bombs)
 * and a stadium the wire cannot carry (deflated form over the u16 length,
 * a list over 255 items) is never written. Every stadium the wire can
 * describe still round-trips.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CodecError, Reader, Writer } from '../../src/codec/index.js';
import {
  STADIUM_INFLATE_LIMIT,
  STADIUM_PACKED_LIMIT,
  SetStadiumEvent,
  createRoomState,
  JoinRoomEvent,
  SetPlayerAdminEvent,
} from '../../src/room/index.js';
import { defaultStadiums, parseHbs, writeStadium } from '../../src/sim/index.js';
import type { Stadium } from '../../src/sim/index.js';
import { Sequencer, SequencerClient } from '../../src/host/index.js';
import { prng } from '../oracle/index.js';
import { HAND, randomHbs } from '../sim/hbs-corpus.js';

/** u16 length + deflate, as a client writes the payload. */
function payload(raw: Uint8Array, level = 6): Uint8Array {
  const packed = deflateRawSync(raw, { level });
  const w = new Writer(packed.length + 2);
  w.u16(packed.length);
  w.bytes(packed);
  return w.copyBytes();
}

function rawStadium(s: Stadium): Uint8Array {
  const w = new Writer(1024);
  writeStadium(w, s);
  return w.copyBytes();
}

function roundTrip(s: Stadium): Stadium {
  const w = new Writer(1024);
  SetStadiumEvent.create(s).write(w);
  const back = new SetStadiumEvent();
  back.read(new Reader(w.finish()));
  return back.stadium!;
}

/** The largest stadium the wire can describe: 255 items in every list, curved segments, a long name. */
function largestHbs(name: string): string {
  const vertexes: unknown[] = [];
  const segments: unknown[] = [];
  const goals: unknown[] = [];
  const discs: unknown[] = [];
  const planes: unknown[] = [];
  const joints: unknown[] = [];
  const red: number[][] = [];
  const blue: number[][] = [];
  for (let i = 0; i < 255; i++) {
    vertexes.push({ x: i * 1.1, y: -i * 2.3, bCoef: 0.1 * i, cMask: ['ball'], cGroup: ['wall'] });
    segments.push({ v0: i, v1: (i + 1) % 255, curve: (i % 90) + 1, bias: i / 3, vis: true, color: 'ABCDEF', cMask: ['red'] });
    goals.push({ p0: [i, -i], p1: [-i, i], team: i % 2 ? 'red' : 'blue' });
    planes.push({ normal: [Math.cos(i), Math.sin(i)], dist: -i * 7.7, bCoef: 0.3, cMask: ['blue'] });
    if (i < 254) discs.push({ pos: [i * 1.7, i * 0.3], speed: [0.1, 0.2], gravity: [0, 0.01], radius: 3.3, invMass: 0.7, damping: 0.98, color: '123456', cMask: ['all'], cGroup: ['c0'] });
    joints.push({ d0: i % 255, d1: (i + 7) % 255, length: [10.5, 20.25], strength: 0.25, color: '00FF00' });
    red.push([i * 3.3, -i * 1.1]);
    blue.push([-i * 3.3, i * 1.1]);
  }
  return JSON.stringify({
    name, width: 900.5, height: 400.25, maxViewWidth: 1200, cameraFollow: 'player', spawnDistance: 333.3,
    bg: { type: 'grass', width: 800, height: 350, kickOffRadius: 80, cornerRadius: 10, color: '718C5A', goalLine: 20 },
    vertexes, segments, goals, discs, planes, joints, redSpawnPoints: red, blueSpawnPoints: blue,
    playerPhysics: { bCoef: 0.6, invMass: 0.5, damping: 0.96, acceleration: 0.11, kickingAcceleration: 0.083, kickingDamping: 0.96, kickStrength: 5.5 },
  });
}

/** Random BMP text: every char takes 3 bytes on the wire and barely deflates. */
function randomText(seed: number, n: number): string {
  const rnd = prng(seed);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(0x800 + Math.floor(rnd() * 0xd000));
  return s;
}

describe('SetStadium inflate cap', () => {
  it('a deflate bomb is rejected as a codec error before inflating it all', () => {
    const bomb = payload(new Uint8Array(16 << 20), 9);
    expect(bomb.length).toBeLessThan(65536);
    const ev = new SetStadiumEvent();
    expect(() => ev.read(new Reader(bomb))).toThrow(new CodecError('Inflate size exceeds limit'));
  });

  it('a stadium with a giant (compressible) name is rejected', () => {
    const s = parseHbs(HAND[0]!.hbs);
    s.name = 'a'.repeat(STADIUM_INFLATE_LIMIT);
    const p = payload(rawStadium(s));
    expect(p.length).toBeLessThan(65536);
    expect(() => new SetStadiumEvent().read(new Reader(p))).toThrow(CodecError);
  });

  it('the largest describable stadium (and a long name) round-trips', () => {
    const s = parseHbs(largestHbs('n'.repeat(4000)));
    for (const k of ['vertexes', 'segments', 'goals', 'discs', 'planes', 'joints', 'redSpawnPoints', 'blueSpawnPoints'] as const) {
      expect(s[k].length).toBe(255);
    }
    const raw = rawStadium(s);
    expect(raw.length).toBeGreaterThan(65000);
    expect(raw.length).toBeLessThan(STADIUM_INFLATE_LIMIT / 3);
    expect(rawStadium(roundTrip(s))).toEqual(raw);
    // the same bytes sent by a client (official deflate level) are accepted too
    const ev = new SetStadiumEvent();
    ev.read(new Reader(payload(raw)));
    expect(rawStadium(ev.stadium!)).toEqual(raw);
    expect(ev.packedSize()).toBeLessThanOrEqual(STADIUM_PACKED_LIMIT);
  });

  it('every default stadium and the .hbs corpus still round-trip', () => {
    for (const s of defaultStadiums()) expect(rawStadium(roundTrip(s))).toEqual(rawStadium(s));
    // parsed stadiums: the decoded form is a fixed point (NaN fields re-encode differently once)
    const hbs = [...HAND.map((c) => c.hbs), ...Array.from({ length: 20 }, (_, i) => randomHbs(i + 1))];
    for (const text of hbs) {
      const s = parseHbs(text);
      if (s.joints.length > 255) continue; // big-but-legal: see 'list counts' below
      const once = roundTrip(s);
      expect(rawStadium(roundTrip(once))).toEqual(rawStadium(once));
    }
  });
});

describe('SetStadium u16 length', () => {
  it('write throws instead of emitting a wrapped length, and writes nothing', () => {
    const s = parseHbs(HAND[0]!.hbs);
    s.name = randomText(3, 36_000);
    const ev = SetStadiumEvent.create(s);
    expect(ev.packedSize()).toBeGreaterThan(STADIUM_PACKED_LIMIT);
    expect(ev.wireError()).toMatch(/^Stadium too large: deflated \d+ > 65535$/);
    const w = new Writer(16);
    w.u8(0xaa);
    expect(() => ev.write(w)).toThrow(CodecError);
    expect(Array.from(w.finish())).toEqual([0xaa]);
  });

  it('a stadium that just fits is written and read back', () => {
    const s = parseHbs(HAND[0]!.hbs);
    s.name = randomText(4, 18_000);
    const ev = SetStadiumEvent.create(s);
    expect(ev.packedSize()).toBeGreaterThan(40_000);
    expect(ev.packedSize()).toBeLessThanOrEqual(STADIUM_PACKED_LIMIT);
    expect(ev.wireError()).toBeNull();
    expect(roundTrip(s).name).toBe(s.name);
  });
});

describe('SetStadium list counts (u8)', () => {
  const base = (extra: Record<string, unknown>): Stadium =>
    parseHbs(JSON.stringify({ name: 'x', width: 100, height: 100, bg: {}, discs: [{}, {}], ...extra }));
  const n = (k: number, f: (i: number) => unknown): unknown[] => Array.from({ length: k }, (_, i) => f(i));
  const joint = () => ({ d0: 1, d1: 2 });
  const point = (i: number) => [i, -i];

  it('255 joints / spawn points per team are written and read back', () => {
    const s = base({ joints: n(255, joint), redSpawnPoints: n(255, point), blueSpawnPoints: n(255, point) });
    expect(SetStadiumEvent.create(s).wireError()).toBeNull();
    const back = roundTrip(s);
    expect([back.joints.length, back.redSpawnPoints.length, back.blueSpawnPoints.length]).toEqual([255, 255, 255]);
  });

  it('more than 255 joints or spawn points: never written (the official parser still accepts them)', () => {
    for (const extra of [{ joints: n(256, joint) }, { redSpawnPoints: n(256, point) }, { blueSpawnPoints: n(300, point) }]) {
      const ev = SetStadiumEvent.create(base(extra));
      expect(ev.wireError()).toBe('Stadium has a list over 255 items');
      const w = new Writer(16);
      expect(() => ev.write(w)).toThrow(CodecError);
      expect(w.finish().length).toBe(0);
    }
  });

  it('default stadiums and the corpus within the limits have no wire error', () => {
    for (const s of defaultStadiums()) expect(SetStadiumEvent.create(s).wireError()).toBeNull();
    for (const c of HAND) {
      const s = parseHbs(c.hbs);
      if (s.joints.length <= 255) expect(SetStadiumEvent.create(s).wireError()).toBeNull();
    }
  });
});

describe('Sequencer: SetStadium bomb from an admin client', () => {
  it('fails like an invalid payload (codec error), nothing applied or broadcast', () => {
    const sent: number[] = [];
    const seq = new Sequencer(createRoomState(), { broadcast: (d) => sent.push(d.length), hasConnections: () => true });
    seq.hostEvent(JoinRoomEvent.create(1, 'admin', 'uy', null));
    seq.hostEvent(SetPlayerAdminEvent.create(1, true));
    const before = seq.rs.stadium;
    const sentBefore = sent.length;
    const s = parseHbs(HAND[0]!.hbs);
    s.name = 'a'.repeat(4 << 20);
    const p = payload(rawStadium(s), 9);
    const w = new Writer(p.length + 9);
    w.u32(0);
    w.u32(1);
    w.u8(11);
    w.bytes(p);
    const t0 = performance.now();
    expect(() => seq.clientMessage(new SequencerClient(1), new Reader(w.finish()), 0)).toThrow(CodecError);
    expect(performance.now() - t0).toBeLessThan(500);
    seq.advance(2);
    expect(seq.rs.stadium).toBe(before);
    expect(sent.length).toBe(sentBefore);
  });
});
