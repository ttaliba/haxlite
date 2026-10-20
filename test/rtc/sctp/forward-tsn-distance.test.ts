/**
 * The FORWARD-TSN stream-entry walk must cost what the pending map holds, not
 * the SSN distance between the stream cursor and the entry: a single pending
 * message far ahead of the cursor must not turn every entry into a ~32k-step
 * walk. Delivery order of pending messages stays by SSN from the cursor.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';

type Rcv = { localTag: number; rPending: (Map<number, number> | null)[]; rNextSsn: Uint16Array; rCum: number };

function packet(vtag: number, chunks: Uint8Array[]): Uint8Array {
  let n = 12;
  for (const c of chunks) n += (c.length + 3) & ~3;
  const p = new Uint8Array(n);
  const dv = new DataView(p.buffer);
  dv.setUint16(0, 5000);
  dv.setUint16(2, 5000);
  dv.setUint32(4, vtag >>> 0);
  dv.setUint32(8, 0); // zero checksum
  let o = 12;
  for (const c of chunks) {
    p.set(c, o);
    o += (c.length + 3) & ~3;
  }
  return p;
}

function data(tsn: number, sid: number, ssn: number, payload: Uint8Array): Uint8Array {
  const c = new Uint8Array(16 + payload.length);
  const dv = new DataView(c.buffer);
  c[0] = 0;
  c[1] = 3; // B|E, ordered
  dv.setUint16(2, c.length);
  dv.setUint32(4, tsn >>> 0);
  dv.setUint16(8, sid);
  dv.setUint16(10, ssn & 0xffff);
  dv.setUint32(12, 53); // binary
  c.set(payload, 16);
  return c;
}

function fwd(newCum: number, entries: [number, number][]): Uint8Array {
  const c = new Uint8Array(8 + 4 * entries.length);
  const dv = new DataView(c.buffer);
  c[0] = 192;
  dv.setUint16(2, c.length);
  dv.setUint32(4, newCum >>> 0);
  for (let i = 0; i < entries.length; i++) {
    dv.setUint16(8 + 4 * i, entries[i]![0]);
    dv.setUint16(10 + 4 * i, entries[i]![1] & 0xffff);
  }
  return c;
}

function countGets(fn: () => void): number {
  const orig = Map.prototype.get;
  let n = 0;
  // eslint-disable-next-line no-extend-native
  Map.prototype.get = function (this: Map<unknown, unknown>, k: unknown) {
    n++;
    return orig.call(this, k);
  };
  try {
    fn();
  } finally {
    // eslint-disable-next-line no-extend-native
    Map.prototype.get = orig;
  }
  return n;
}

describe('FORWARD-TSN walk cost', () => {
  it('is bounded by the pending map, not the SSN distance', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const rcv = p.b.sctp as unknown as Rcv;
    const N = 400;
    const FAR = 30000;
    const pl = new Uint8Array(4);
    // One far-ahead pending ordered message on each of N streams.
    let tsn = rcv.rCum;
    for (let i = 0; i < N; i += 40) {
      const chunks: Uint8Array[] = [];
      for (let j = i; j < Math.min(N, i + 40); j++) chunks.push(data((tsn = (tsn + 1) >>> 0), 10 + j, FAR, pl));
      p.b.sctp.input(packet(rcv.localTag, chunks));
    }
    expect(rcv.rCum).toBe(tsn);
    let pending = 0;
    for (let j = 0; j < N; j++) pending += rcv.rPending[10 + j]?.size ?? 0;
    expect(pending).toBe(N);

    // Each entry stops one short of the pending message.
    const entries: [number, number][] = [];
    for (let j = 0; j < N; j++) entries.push([10 + j, FAR - 1]);
    const gets = countGets(() => p.b.sctp.input(packet(rcv.localTag, [fwd((rcv.rCum + 1) >>> 0, entries)])));
    expect(gets).toBeLessThan(20 * N);
    // The pending message became in order and was consumed.
    for (let j = 0; j < N; j++) {
      expect(rcv.rNextSsn[10 + j]).toBe(FAR + 1);
      expect(rcv.rPending[10 + j]?.size ?? 0).toBe(0);
    }
    expect(p.b.sctp.stats().internalErrors).toBe(0);
  });

  it('bounds repeated entries for one stream with many far pending messages', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const rcv = p.b.sctp as unknown as Rcv;
    const pl = new Uint8Array(4);
    // 200 pending messages far ahead on stream 0.
    let tsn = rcv.rCum;
    for (let i = 0; i < 200; i += 40) {
      const chunks: Uint8Array[] = [];
      for (let j = i; j < i + 40; j++) chunks.push(data((tsn = (tsn + 1) >>> 0), 0, 30000 + j, pl));
      p.b.sctp.input(packet(rcv.localTag, chunks));
    }
    expect(rcv.rPending[0]?.size).toBe(200);
    // Entries that each advance the cursor by less than the map size never
    // reach the pending messages.
    const entries: [number, number][] = [];
    for (let j = 1; j <= 280; j++) entries.push([0, j * 100 - 1]);
    const gets = countGets(() => p.b.sctp.input(packet(rcv.localTag, [fwd((rcv.rCum + 1) >>> 0, entries)])));
    expect(gets).toBeLessThan(10_000);
    expect(p.b.sctp.stats().internalErrors).toBe(0);
  });

  it('delivers pending messages in SSN order from the cursor, across the wrap', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const rcv = p.b.sctp as unknown as Rcv;
    rcv.rNextSsn[0] = 65530;
    let tsn = rcv.rCum;
    // Pending (sid 0): 65534, 1, 3, 9 arrive out of order; payload byte = ssn tag.
    const order = [3, 65534, 9, 1];
    const chunks = order.map((s) => data((tsn = (tsn + 1) >>> 0), 0, s, new Uint8Array([s & 0xff, s >>> 8])));
    p.b.sctp.input(packet(rcv.localTag, chunks));
    expect(rcv.rPending[0]?.size).toBe(4);
    expect(p.b.received.length).toBe(0);
    // Skip up to ssn 2 (distance 8 >= map size 4): 65534 then 1 are released, 3 then drains.
    p.b.sctp.input(packet(rcv.localTag, [fwd((rcv.rCum + 1) >>> 0, [[0, 2]])]));
    const got = p.b.received.map((r) => r.data[0]! | (r.data[1]! << 8));
    expect(got).toEqual([65534, 1, 3]);
    expect(rcv.rNextSsn[0]).toBe(4);
    expect(rcv.rPending[0]?.size).toBe(1);
    // Skip 4..5: 9 stays pending.
    p.b.sctp.input(packet(rcv.localTag, [fwd((rcv.rCum + 1) >>> 0, [[0, 5]])]));
    expect(p.b.received.length).toBe(3);
    p.b.sctp.input(packet(rcv.localTag, [fwd((rcv.rCum + 1) >>> 0, [[0, 8]])]));
    expect(p.b.received.map((r) => r.data[0]! | (r.data[1]! << 8))).toEqual([65534, 1, 3, 9]);
    expect(rcv.rPending[0]?.size).toBe(0);
  });
});
