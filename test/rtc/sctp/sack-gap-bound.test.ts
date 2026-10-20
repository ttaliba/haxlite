/**
 * A SACK whose gap-ack blocks overlap must not make processAck walk the whole
 * outstanding range once per block. Well-formed blocks are disjoint, so the
 * union they can cover is bounded by the outstanding TSNs; the gap loop is
 * capped at that budget. A conforming peer (ascending, non-overlapping blocks)
 * is unaffected.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';

type Inner = {
  localTag: number;
  tAcked: number;
  tSendNext: number;
  cwnd: number;
  peerRwnd: number;
  txFlags: Uint16Array;
};

function sackPacket(vtag: number, cum: number, arwnd: number, blocks: Array<[number, number]>): Uint8Array {
  const clen = 16 + 4 * blocks.length;
  const p = new Uint8Array(12 + clen);
  const dv = new DataView(p.buffer);
  dv.setUint16(0, 5000);
  dv.setUint16(2, 5000);
  dv.setUint32(4, vtag >>> 0);
  dv.setUint32(8, 0); // zero checksum (accepted by default)
  p[12] = 3; // SACK
  dv.setUint16(14, clen);
  dv.setUint32(16, cum >>> 0);
  dv.setUint32(20, arwnd >>> 0);
  dv.setUint16(24, blocks.length);
  let o = 28;
  for (const [s, e] of blocks) {
    dv.setUint16(o, s);
    dv.setUint16(o + 2, e);
    o += 4;
  }
  return p;
}

describe('SACK gap-block work budget', () => {
  it('overlapping gap blocks touch each outstanding TSN at most a bounded number of times', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const a = p.a.sctp as unknown as Inner;
    // Open the windows so the host keeps many TSNs outstanding, and stop the
    // sim so the peer never acks them.
    a.cwnd = 1 << 20;
    a.peerRwnd = 1 << 20;
    const payload = new Uint8Array(16);
    const M = 2000;
    for (let i = 0; i < M; i++) p.a.sctp.send(0, payload);
    const S = (a.tSendNext - a.tAcked) >>> 0;
    expect(S).toBeGreaterThan(M - 2);

    // Count index reads of the tx-record flag ring during processAck.
    let gets = 0;
    const real = a.txFlags;
    a.txFlags = new Proxy(real, {
      get(t, k) {
        if (typeof k === 'string' && (k as unknown as number) >= 0) gets++;
        return Reflect.get(t, k);
      },
      set(t, k, v) {
        return Reflect.set(t, k, v);
      },
    }) as unknown as Uint16Array;

    const G = 500;
    const end = Math.min(S, 65534);
    const blocks: Array<[number, number]> = [];
    for (let g = 0; g < G; g++) blocks.push([1, end]); // all overlapping [1, S]
    p.a.sctp.input(sackPacket(a.localTag, a.tAcked >>> 0, 1 << 20, blocks));
    a.txFlags = real;

    // Unbounded would be ~G*S (~1e6). Bounded is a small multiple of S.
    expect(gets).toBeLessThan(8 * S);
    expect(p.a.sctp.stats().malformed).toBe(0);
  });

  it('a conforming SACK (ascending, non-overlapping blocks) still acks the gapped TSNs', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const a = p.a.sctp as unknown as Inner;
    a.cwnd = 1 << 20;
    a.peerRwnd = 1 << 20;
    const payload = new Uint8Array(16);
    for (let i = 0; i < 10; i++) p.a.sctp.send(0, payload);
    const flightBefore = p.a.sctp.stats().flightSize;
    expect(flightBefore).toBeGreaterThan(0);
    // Ack TSNs 3,4 and 6,7 relative to cum (two disjoint ascending blocks).
    p.a.sctp.input(sackPacket(a.localTag, a.tAcked >>> 0, 1 << 20, [[3, 4], [6, 7]]));
    // Four chunks left flight via gap acks.
    expect(p.a.sctp.stats().flightSize).toBeLessThan(flightBefore);
    expect(p.a.sctp.stats().malformed).toBe(0);
  });
});
