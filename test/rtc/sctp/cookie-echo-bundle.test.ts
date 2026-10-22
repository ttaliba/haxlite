/**
 * Only the first chunk of a packet may be a COOKIE-ECHO (RFC 9260 §5.1), so
 * extra COOKIE-ECHO chunks bundled behind other chunks are ignored before the
 * cookie HMAC runs. A normal single COOKIE-ECHO handshake is unaffected (the
 * handshake suite covers that); here we check that a COOKIE-ECHO which is not
 * first does not establish or disturb an association.
 */
import { describe, expect, it } from 'vitest';
import { makePair, connectPair } from './harness.js';

type Inner = { localTag: number };

function u16(p: Uint8Array, o: number, v: number): void {
  p[o] = v >>> 8;
  p[o + 1] = v;
}

describe('COOKIE-ECHO bundling', () => {
  it('ignores a COOKIE-ECHO that is not the first chunk of the packet', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    const a = p.a.sctp as unknown as Inner;
    // A packet whose first chunk is a (minimal) HEARTBEAT, followed by a
    // bogus COOKIE-ECHO. The second chunk must be skipped entirely.
    const hbLen = 8;
    const cookieLen = 4 + 72;
    const total = 12 + hbLen + ((cookieLen + 3) & ~3);
    const pkt = new Uint8Array(total);
    const dv = new DataView(pkt.buffer);
    dv.setUint16(0, 5000);
    dv.setUint16(2, 5000);
    dv.setUint32(4, a.localTag >>> 0);
    dv.setUint32(8, 0); // zero checksum
    // HEARTBEAT first.
    pkt[12] = 4;
    u16(pkt, 14, hbLen);
    // COOKIE-ECHO second (garbage cookie): must be ignored, not HMAC'd.
    const co = 12 + hbLen;
    pkt[co] = 10; // COOKIE_ECHO
    u16(pkt, co + 2, cookieLen);
    pkt[co + 4] = 1;
    const errsBefore = p.a.sctp.stats().malformed;
    p.a.sctp.input(pkt);
    // The association is unchanged: still established, no close, no crash.
    expect(p.a.sctp.readyState).toBe('established');
    expect(p.a.closed).toBe(null);
    expect(p.a.sctp.stats().internalErrors).toBe(0);
    expect(p.a.sctp.stats().malformed).toBe(errsBefore);
  });
});
