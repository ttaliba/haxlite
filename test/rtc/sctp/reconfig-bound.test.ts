/**
 * A RE-CONFIG chunk must process at most RFC 6525's two request parameters.
 * A forged chunk with many empty Outgoing-SSN-Reset parameters otherwise
 * advanced the request cursor once per parameter and rescanned every stream
 * for each one. A single conforming reset still works.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';

type Rcv = { localTag: number; peerReqExpected: number; rNextSsn: Uint16Array; rCum: number };

const PT_OUT_RESET = 13;

function reconfig(vtag: number, params: Array<{ seq: number; lastTsn: number; sids: number[] }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const pr of params) {
    const pl = 16 + 2 * pr.sids.length;
    const b = new Uint8Array((pl + 3) & ~3);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, PT_OUT_RESET);
    dv.setUint16(2, pl);
    dv.setUint32(4, pr.seq >>> 0); // request seq
    dv.setUint32(8, 0); // response seq
    dv.setUint32(12, pr.lastTsn >>> 0);
    for (let i = 0; i < pr.sids.length; i++) dv.setUint16(16 + 2 * i, pr.sids[i]!);
    parts.push(b);
  }
  let body = 0;
  for (const pt of parts) body += pt.length;
  const clen = 4 + body;
  const p = new Uint8Array(12 + ((clen + 3) & ~3));
  const dv = new DataView(p.buffer);
  dv.setUint16(0, 5000);
  dv.setUint16(2, 5000);
  dv.setUint32(4, vtag >>> 0);
  dv.setUint32(8, 0); // zero checksum
  p[12] = 130; // RE-CONFIG
  dv.setUint16(14, clen);
  let o = 16;
  for (const pt of parts) {
    p.set(pt, o);
    o += pt.length;
  }
  return p;
}

describe('RE-CONFIG request budget', () => {
  it('ignores request parameters beyond the per-chunk limit', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const b = p.b.sctp as unknown as Rcv;
    const start = b.peerReqExpected >>> 0;
    // 1000 empty resets, each with the next consecutive request seq.
    const params = [];
    for (let i = 0; i < 1000; i++) params.push({ seq: (start + i) >>> 0, lastTsn: 0, sids: [] as number[] });
    p.b.sctp.input(reconfig(b.localTag, params));
    const advanced = (b.peerReqExpected - start) >>> 0;
    expect(advanced).toBeLessThanOrEqual(2);
    expect(p.b.sctp.stats().internalErrors).toBe(0);
  });

  it('still performs a single conforming stream reset', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const b = p.b.sctp as unknown as Rcv;
    const start = b.peerReqExpected >>> 0;
    // Advance SSN state on stream 0 so a reset is observable.
    b.rNextSsn[0] = 5;
    p.b.sctp.input(reconfig(b.localTag, [{ seq: start, lastTsn: b.rCum >>> 0, sids: [0] }]));
    expect((b.peerReqExpected - start) >>> 0).toBe(1);
    expect(b.rNextSsn[0]).toBe(0); // reset performed
    expect(p.b.channelClosed).toContain(0);
  });
});
