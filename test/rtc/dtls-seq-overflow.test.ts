/**
 * DTLS server record sequence numbers: a ClientHello's record sequence never
 * drives our write counter out of the 48-bit space, and a failing
 * retransmission ends the handshake instead of escaping to the event loop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtcCertificate } from '../../src/rtc/cert.js';
import { DtlsServer } from '../../src/rtc/dtls/server.js';
import { clientHelloDatagram, parseRecords } from './dtls-helpers.js';

const cert = RtcCertificate.generate();

function server(o: { helloVerify?: boolean } = {}) {
  const sent: Buffer[] = [];
  const closes: string[] = [];
  let failSend = false;
  const s = new DtlsServer({
    ...o,
    certificate: cert,
    remoteFingerprint: { algorithm: 'sha-256', digest: new Uint8Array(32) },
    send: (d) => {
      if (failSend) throw new Error('send failed');
      sent.push(Buffer.from(d));
    },
    onConnected: () => {},
    onData: () => {},
    onClose: (r) => closes.push(r),
    retransmitMs: 200,
  });
  return { s, sent, closes, breakSend: () => (failSend = true) };
}

/** ClientHello whose record header carries sequence number seqHi:seqLo. */
function hostileHello(seqHi: number, seqLo: number, o: Parameters<typeof clientHelloDatagram>[0] = {}): Buffer {
  const d = clientHelloDatagram({ ...o, recordSeq: seqLo }).datagram;
  d.writeUInt16BE(seqHi, 5);
  return d;
}

const epoch0Seqs = (sent: Buffer[]) => sent.flatMap((d) => parseRecords(d)).flatMap((r) => (r.epoch === 0 ? [r.seq] : []));

function expectIncreasing(seqs: number[]): void {
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
}

/** Cookie of the HelloVerifyRequest in `d`. */
function cookieOf(d: Buffer): Buffer {
  const f = parseRecords(d)[0]!.fragment;
  expect(f[0]).toBe(3);
  return Buffer.from(f.subarray(15, 15 + f[14]!));
}

describe('DTLS write record sequence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a ClientHello with record sequence 0xffff_fffffffa survives the retransmission timer', () => {
    vi.useFakeTimers();
    const { s, sent, closes } = server();
    s.handleDatagram(hostileHello(0xffff, 0xfffffffa), '1.2.3.4|5');
    expect(s.state).toBe('handshake');
    expect(() => vi.advanceTimersByTime(200 + 400 + 800)).not.toThrow(); // three retransmissions
    expect(s.state).toBe('handshake');
    expect(closes).toEqual([]);
    const seqs = epoch0Seqs(sent);
    expect(seqs.length).toBe(20); // flight 4 (5 records) + 3 retransmissions
    expect(seqs[0]).toBe(0); // our own numbering, not the peer's
    expectIncreasing(seqs);
    s.close();
  });

  it('the same ClientHello retransmitted by the peer does not throw out of handleDatagram', () => {
    vi.useFakeTimers();
    const { s, sent, closes } = server();
    const ch = hostileHello(0xffff, 0xfffffffa);
    s.handleDatagram(ch, 'p');
    vi.advanceTimersByTime(100); // under the retransmission timeout, past the peer rate limit
    const first = sent.length;
    expect(() => s.handleDatagram(ch, 'p')).not.toThrow();
    expect(sent.length).toBeGreaterThan(first);
    expect(s.state).toBe('handshake');
    expect(closes).toEqual([]);
    expectIncreasing(epoch0Seqs(sent));
    s.close();
  });

  it('helloVerify: flight 4 continues from the cookie ClientHello, a hostile sequence cannot overflow', () => {
    vi.useFakeTimers();
    // legitimate: HVR echoes record 0, flight 4 follows the second ClientHello's record 1
    const a = server({ helloVerify: true });
    const ch = clientHelloDatagram({ recordSeq: 0 });
    a.s.handleDatagram(ch.datagram, 'p');
    const cookie = cookieOf(a.sent[0]!);
    a.s.handleDatagram(clientHelloDatagram({ random: ch.random, cookie, messageSeq: 1, recordSeq: 1 }).datagram, 'p');
    expect(a.s.state).toBe('handshake');
    expect(epoch0Seqs(a.sent)).toEqual([0, 1, 2, 3, 4, 5]);
    a.s.close();

    for (const [hi, lo] of [
      [0xffff, 0xfffffffa],
      [0, 0xfffffffe],
    ] as const) {
      const b = server({ helloVerify: true });
      const ch1 = clientHelloDatagram();
      b.s.handleDatagram(ch1.datagram, 'p');
      const c = cookieOf(b.sent[0]!);
      const ch2 = hostileHello(hi, lo, { random: ch1.random, cookie: c, messageSeq: 1 });
      b.s.handleDatagram(ch2, 'p');
      expect(b.s.state).toBe('handshake');
      expect(() => vi.advanceTimersByTime(200 + 400 + 800)).not.toThrow();
      vi.advanceTimersByTime(300);
      expect(() => b.s.handleDatagram(ch2, 'p')).not.toThrow();
      expect(b.s.state).toBe('handshake');
      expect(b.closes).toEqual([]);
      const seqs = epoch0Seqs(b.sent.slice(1));
      expect(seqs.every((q) => q < 2 ** 48)).toBe(true);
      expectIncreasing(seqs);
      b.s.close();
    }
  });

  it('an error while retransmitting fails the handshake instead of escaping the timer', () => {
    vi.useFakeTimers();
    const { s, closes, breakSend } = server();
    s.handleDatagram(clientHelloDatagram().datagram, 'p');
    breakSend();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(s.state).toBe('closed');
    expect(closes).toEqual(['dtls-error:internal-send failed']);
    expect(vi.getTimerCount()).toBe(0); // not re-armed
  });

  it('an error in a peer-triggered retransmission does not throw out of handleDatagram', () => {
    vi.useFakeTimers();
    const { s, closes, breakSend } = server();
    const ch = clientHelloDatagram().datagram;
    s.handleDatagram(ch, 'p');
    vi.advanceTimersByTime(100);
    breakSend();
    expect(() => s.handleDatagram(ch, 'p')).not.toThrow();
    expect(s.state).toBe('closed');
    expect(closes).toEqual(['dtls-error:internal-send failed']);
  });
});
