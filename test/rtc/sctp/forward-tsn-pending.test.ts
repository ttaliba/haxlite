/**
 * FORWARD-TSN must not rescan the whole pending-message map of a stream for
 * every entry. With many pending ordered messages and many stream entries the
 * old code built `[...m.keys()].filter().sort()` per entry (O(entries x map)).
 * The handler now walks SSNs from the stream cursor to the entry's SSN, so it
 * never spreads or sorts the map.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';

type Snd = { tOutSsn: Uint16Array };
type Rcv = { localTag: number; rPending: (Map<number, number> | null)[]; rNextSsn: Uint16Array; rCum: number };

function forwardTsn(vtag: number, newCum: number, startSsn: number, entries: number, sid = 0): Uint8Array {
  const clen = 8 + 4 * entries;
  const p = new Uint8Array(12 + clen);
  const dv = new DataView(p.buffer);
  dv.setUint16(0, 5000);
  dv.setUint16(2, 5000);
  dv.setUint32(4, vtag >>> 0);
  dv.setUint32(8, 0); // zero checksum
  p[12] = 192; // FORWARD-TSN
  dv.setUint16(14, clen);
  dv.setUint32(16, newCum >>> 0);
  let o = 20;
  for (let i = 0; i < entries; i++) {
    dv.setUint16(o, sid);
    dv.setUint16(o + 2, (startSsn + i) & 0xffff);
    o += 4;
  }
  return p;
}

describe('FORWARD-TSN with many pending messages', () => {
  it('does not spread/sort the pending map per entry', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const snd = p.a.sctp as unknown as Snd;
    const rcv = p.b.sctp as unknown as Rcv;
    // Ordered messages far ahead of the next expected SSN pile up as pending.
    snd.tOutSsn[0] = 20000;
    const payload = new Uint8Array(16);
    for (let i = 0; i < 300; i++) p.a.sctp.send(0, payload);
    p.sim.run(3000);
    const pendingBefore = rcv.rPending[0]?.size ?? 0;
    expect(pendingBefore).toBeGreaterThan(100);

    // The handler must not iterate the map's keys (filter/sort).
    const origKeys = Map.prototype.keys;
    let keyCalls = 0;
    // eslint-disable-next-line no-extend-native
    Map.prototype.keys = function (this: Map<unknown, unknown>) {
      keyCalls++;
      return origKeys.call(this);
    };
    try {
      let ssn = rcv.rNextSsn[0]!;
      for (let r = 0; r < 4; r++) {
        const newCum = (rcv.rCum + 1) >>> 0;
        p.b.sctp.input(forwardTsn(rcv.localTag, newCum, ssn, 1000));
        ssn = (ssn + 1000) & 0xffff;
      }
    } finally {
      // eslint-disable-next-line no-extend-native
      Map.prototype.keys = origKeys;
    }
    expect(keyCalls).toBe(0);
    expect(p.b.sctp.stats().malformed).toBe(0);
    expect(p.b.sctp.stats().internalErrors).toBe(0);
  });

  it('still delivers now-in-order pending messages a FORWARD-TSN unblocks', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const rcv = p.b.sctp as unknown as Rcv;
    const payload = new Uint8Array([7, 7, 7, 7]);
    // ssn 0 is withheld (simulated by sending it last); ssn 1..3 pile up pending.
    const snd = p.a.sctp as unknown as Snd;
    snd.tOutSsn[0] = 1;
    for (let i = 0; i < 3; i++) p.a.sctp.send(0, payload); // ssn 1,2,3
    p.sim.run(2000);
    expect(p.b.received.length).toBe(0); // all waiting on ssn 0
    expect(rcv.rPending[0]?.size).toBe(3);
    // FORWARD-TSN past ssn 0 (the abandoned message): deliver 1..3 in order.
    const newCum = (rcv.rCum + 1) >>> 0;
    p.b.sctp.input(forwardTsn(rcv.localTag, newCum, 0, 1));
    expect(p.b.received.length).toBe(3);
  });
});
