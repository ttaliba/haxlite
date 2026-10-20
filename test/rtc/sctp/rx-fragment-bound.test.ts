/**
 * Held receive memory and reassembly work must stay bounded against hostile
 * fragment streams. In-order fragments (TSN = rCum+1) that never finish a
 * message were held without the receive-buffer check, growing far past the
 * advertised a_rwnd; and tryAssemble was walked for every held fragment,
 * giving quadratic cost in a long incomplete run. Legitimate fragmented
 * messages still reassemble.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';
import { SctpAssociation } from '../../../src/rtc/sctp/index.js';

type Rcv = { localTag: number; rCum: number; heldBytes: number; rxBufferSize: number; maxRecvMessage: number };

const F_B = 2;
const F_E = 1;

function dataPacket(vtag: number, tsn: number, sid: number, ssn: number, flags: number, payload: Uint8Array): Uint8Array {
  const clen = 16 + payload.length;
  const p = new Uint8Array(12 + ((clen + 3) & ~3));
  const dv = new DataView(p.buffer);
  dv.setUint16(0, 5000);
  dv.setUint16(2, 5000);
  dv.setUint32(4, vtag >>> 0);
  dv.setUint32(8, 0); // zero checksum
  p[12] = 0; // DATA
  p[13] = flags;
  dv.setUint16(14, clen);
  dv.setUint32(16, tsn >>> 0);
  dv.setUint16(20, sid);
  dv.setUint16(22, ssn);
  dv.setUint32(24, 53); // PPID binary
  p.set(payload, 28);
  return p;
}

describe('receive-side fragment bounds', () => {
  it('in-order fragments that never complete a message cannot grow held memory past the buffer', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const b = p.b.sctp as unknown as Rcv;
    const limit = b.rxBufferSize + b.maxRecvMessage;
    const chunk = new Uint8Array(16000);
    let tsn = (b.rCum + 1) >>> 0;
    // First the B fragment, then middle fragments; never an E. Each advances
    // rCum, so every one is the next in-order TSN.
    p.b.sctp.input(dataPacket(b.localTag, tsn, 0, 0, F_B, chunk));
    tsn = (tsn + 1) >>> 0;
    for (let i = 0; i < 300; i++) {
      p.b.sctp.input(dataPacket(b.localTag, tsn, 0, 0, 0, chunk));
      tsn = (tsn + 1) >>> 0;
    }
    expect(b.heldBytes).toBeLessThanOrEqual(limit);
    expect(p.b.received.length).toBe(0);
    expect(p.b.sctp.stats().internalErrors).toBe(0);
  });

  it('does not walk reassembly quadratically for a long in-order incomplete run', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const b = p.b.sctp as unknown as Rcv;
    // Count matches() calls across the run.
    const proto = SctpAssociation.prototype as unknown as { matches: (...a: unknown[]) => boolean };
    const orig = proto.matches;
    let calls = 0;
    proto.matches = function (this: unknown, ...a: unknown[]) {
      calls++;
      return orig.apply(this, a);
    };
    const n = 600;
    try {
      const chunk = new Uint8Array(2);
      let tsn = (b.rCum + 1) >>> 0;
      p.b.sctp.input(dataPacket(b.localTag, tsn, 0, 0, F_B, chunk));
      tsn = (tsn + 1) >>> 0;
      for (let i = 0; i < n; i++) {
        p.b.sctp.input(dataPacket(b.localTag, tsn, 0, 0, 0, chunk));
        tsn = (tsn + 1) >>> 0;
      }
    } finally {
      proto.matches = orig;
    }
    // Quadratic would be ~n^2/2 (~1.8e5). Gated walk is a small multiple of n.
    expect(calls).toBeLessThan(8 * n);
  });

  it('still reassembles a legitimate large in-order fragmented message', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const b = p.b.sctp as unknown as Rcv;
    const part = 1000;
    const nFrag = 20;
    let tsn = (b.rCum + 1) >>> 0;
    for (let i = 0; i < nFrag; i++) {
      const payload = new Uint8Array(part).fill(i + 1);
      const flags = (i === 0 ? F_B : 0) | (i === nFrag - 1 ? F_E : 0);
      p.b.sctp.input(dataPacket(b.localTag, tsn, 0, 0, flags, payload));
      tsn = (tsn + 1) >>> 0;
    }
    expect(p.b.received.length).toBe(1);
    expect(p.b.received[0]!.data.length).toBe(part * nFrag);
    expect(p.b.received[0]!.data[0]).toBe(1);
    expect(p.b.received[0]!.data[part * nFrag - 1]).toBe(nFrag);
  });
});
