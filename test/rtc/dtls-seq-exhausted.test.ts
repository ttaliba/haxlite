/**
 * The 48-bit DTLS write sequence never wraps within an epoch (a wrapped number
 * reuses the AEAD nonce under the same key): at the end of the space the
 * server stops sealing records and closes.
 */
import { describe, expect, it } from 'vitest';
import { RtcCertificate } from '../../src/rtc/cert.js';
import { DtlsServer } from '../../src/rtc/dtls/server.js';

const cert = RtcCertificate.generate();

interface Internals {
  state: string;
  writeEpoch: number;
  writeCipher: unknown;
  writeSeqHi: number[];
  writeSeqLo: number[];
}

/** A server forced into the connected state with a pass-through cipher. */
function connectedServer() {
  const seqs: [number, number][] = [];
  const closes: string[] = [];
  const s = new DtlsServer({
    certificate: cert,
    remoteFingerprint: { algorithm: 'sha-256', digest: new Uint8Array(32) },
    send: (d) => {
      const b = Buffer.from(d);
      seqs.push([b.readUInt16BE(5), b.readUInt32BE(7)]);
    },
    onConnected: () => {},
    onData: () => {},
    onClose: (r) => closes.push(r),
  });
  const i = s as unknown as Internals;
  i.state = 'connected';
  i.writeEpoch = 1;
  i.writeCipher = {
    overhead: 0,
    seal: (_t: number, _v: number, _e: number, _hi: number, _lo: number, data: Uint8Array, out: Uint8Array, off: number) => {
      out.set(data, off);
      return data.length;
    },
    wipe: () => {},
  };
  return { s, i, seqs, closes };
}

describe('DTLS write sequence exhaustion', () => {
  it('closes at the end of the 48-bit space instead of wrapping', async () => {
    const { s, i, seqs, closes } = connectedServer();
    i.writeSeqHi[1] = 0xffff;
    i.writeSeqLo[1] = 0xfffffffc;
    const data = new Uint8Array(4);
    const results = [s.send(data), s.send(data), s.send(data), s.send(data), s.send(data)];
    expect(results).toEqual([true, true, true, false, false]);
    expect(seqs).toEqual([
      [0xffff, 0xfffffffc],
      [0xffff, 0xfffffffd],
      [0xffff, 0xfffffffe],
    ]);
    expect(s.state).toBe('closed');
    await Promise.resolve();
    expect(closes).toEqual(['dtls-error:sequence-exhausted']);
    s.close();
    expect(seqs.length).toBe(3); // no close_notify with a reused number
  });

  it('carries the low word into the high word as before', () => {
    const { s, i, seqs } = connectedServer();
    i.writeSeqHi[1] = 0;
    i.writeSeqLo[1] = 0xffffffff;
    s.send(new Uint8Array(1));
    s.send(new Uint8Array(1));
    expect(seqs).toEqual([
      [0, 0xffffffff],
      [1, 0],
    ]);
    expect(s.state).toBe('connected');
  });
});
