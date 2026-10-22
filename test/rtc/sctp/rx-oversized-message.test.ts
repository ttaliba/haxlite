/**
 * A message larger than the receive buffer plus maxReceiveMessageSize fills
 * the buffer before it can complete. It must fail the association with
 * 'message-too-large' (as a smaller oversized message does on completion)
 * instead of silently dropping its in-order fragments until the peer gives
 * up. A buffer full of deliverable data only drops, as before.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';

type Rcv = { localTag: number; rCum: number; heldBytes: number };

const F_B = 2;
const F_E = 1;
const F_U = 4;

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

describe('oversized message past the receive buffer', () => {
  it('fails with message-too-large once its fragments fill the buffer', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const b = p.b.sctp as unknown as Rcv;
    const chunk = new Uint8Array(16000);
    let tsn = (b.rCum + 1) >>> 0;
    p.b.sctp.input(dataPacket(b.localTag, tsn, 0, 0, F_B, chunk));
    tsn = (tsn + 1) >>> 0;
    // 2 MiB worth of middle fragments, all in order; never an E.
    let sent = 1;
    for (let i = 0; i < 130 && p.b.closed === null; i++, sent++) {
      p.b.sctp.input(dataPacket(b.localTag, tsn, 0, 0, 0, chunk));
      tsn = (tsn + 1) >>> 0;
    }
    expect(p.b.closed).toBe('message-too-large');
    // Fails as soon as the buffer is full: (1 MiB + 256 KiB) / 16000 fragments.
    expect(sent).toBeLessThanOrEqual(Math.ceil(((1 << 20) + 262144) / 16000) + 1);
    p.sim.run(1000);
    expect(p.a.closed).toBe('abort');
  });

  it('only drops while the full buffer holds deliverable data', () => {
    const p = makePair({ optsB: { receiveBufferSize: 65536, maxReceiveMessageSize: 16384 } });
    expect(connectPair(p)).toBe(true);
    const b = p.b.sctp as unknown as Rcv;
    let tsn = (b.rCum + 1) >>> 0;
    // Complete ordered messages ssn 1..10 wait for ssn 0: 80000 bytes held.
    for (let s = 1; s <= 10; s++) {
      p.b.sctp.input(dataPacket(b.localTag, tsn, 0, s, F_B | F_E, new Uint8Array(8000)));
      tsn = (tsn + 1) >>> 0;
    }
    expect(b.heldBytes).toBe(80000);
    // A small unordered message starts, then its next fragment no longer fits.
    p.b.sctp.input(dataPacket(b.localTag, tsn, 1, 0, F_U | F_B, new Uint8Array(100)));
    tsn = (tsn + 1) >>> 0;
    const cum = b.rCum;
    p.b.sctp.input(dataPacket(b.localTag, tsn, 1, 0, F_U, new Uint8Array(4000)));
    expect(b.rCum).toBe(cum);
    expect(p.b.closed).toBeNull();
    expect(p.b.sctp.stats().internalErrors).toBe(0);
  });
});
