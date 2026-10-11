/**
 * Robustness: 100k mutated packets (valid checksum recomputed most of the
 * time, so the chunk parsers are reached) fed to established and listening
 * associations. input() must never throw and no internal error may occur.
 */
import { describe, expect, it } from 'vitest';
import { SctpAssociation } from '../../../src/rtc/sctp/index.js';
import { writeChecksum } from '../../../src/rtc/sctp/crc32c.js';
import { connectPair, makePair, msg, mulberry32, type Peer } from './harness.js';

/** Valid packets of every kind from a busy, lossy session (both directions). */
function corpus(): Uint8Array[] {
  const p = makePair({ seed: 77, recordWire: true, link: { loss: 0.15, dup: 0.05, delay: 20, jitter: 30 }, channels: [
    { id: 0, ordered: true },
    { id: 1, ordered: false },
    { id: 2, ordered: false, maxRetransmits: 0 },
    { id: 3, ordered: true, maxRetransmits: 0 },
  ] });
  connectPair(p);
  for (let i = 0; i < 300; i++) {
    p.sim.at(i * 5, () => {
      for (const ch of [0, 1, 2, 3]) {
        p.a.sctp.send(ch, msg(ch, i, i % 50 === 0 ? 3000 : 30 + i));
        p.b.sctp.send(ch, msg(ch, i, 40));
      }
    });
  }
  p.sim.run(5000);
  p.a.sctp.closeChannel(1);
  p.sim.run(5000);
  p.a.sctp.shutdown();
  p.sim.run(5000);
  return [...p.a.wire, ...p.b.wire];
}

const INTERESTING = [0, 1, 2, 3, 4, 0x7f, 0x80, 0xfe, 0xff];

function mutate(src: Uint8Array, rnd: () => number, other: Uint8Array): Uint8Array {
  let pkt = src.slice();
  const nMut = 1 + Math.floor(rnd() * 4);
  for (let m = 0; m < nMut; m++) {
    const r = rnd();
    const pos = 12 + Math.floor(rnd() * Math.max(1, pkt.length - 12));
    if (r < 0.25) {
      pkt[pos] ^= 1 << Math.floor(rnd() * 8);
    } else if (r < 0.45) {
      pkt[pos] = INTERESTING[Math.floor(rnd() * INTERESTING.length)];
    } else if (r < 0.55) {
      // chunk length / u16 fields
      const v = [0, 1, 3, 4, 5, 8, 15, 16, 17, 0xffff, pkt.length - 12, pkt.length - 11][Math.floor(rnd() * 12)];
      if (pos + 1 < pkt.length) {
        pkt[pos] = v >> 8;
        pkt[pos + 1] = v;
      }
    } else if (r < 0.62) {
      pkt = pkt.slice(0, 12 + Math.floor(rnd() * (pkt.length - 11)));
    } else if (r < 0.7) {
      const ext = new Uint8Array(pkt.length + 1 + Math.floor(rnd() * 64));
      ext.set(pkt);
      for (let k = pkt.length; k < ext.length; k++) ext[k] = Math.floor(rnd() * 256);
      pkt = ext;
    } else if (r < 0.78) {
      // splice chunks of another packet
      const tail = other.subarray(12 + Math.floor(rnd() * Math.max(1, other.length - 12)));
      const ext = new Uint8Array(Math.min(1500, pkt.length + tail.length));
      ext.set(pkt);
      ext.set(tail.subarray(0, ext.length - pkt.length), pkt.length);
      pkt = ext;
    } else if (r < 0.86) {
      // random u32 (TSN / cum ack / tags)
      if (pos + 3 < pkt.length) for (let k = 0; k < 4; k++) pkt[pos + k] = Math.floor(rnd() * 256);
    } else if (r < 0.93) {
      // chunk type
      pkt[12] = [0, 1, 2, 3, 4, 6, 7, 8, 10, 11, 14, 130, 192, 64, 0x3f, 0x7f, 0xbf, 0xff][Math.floor(rnd() * 18)];
    } else {
      for (let k = 12; k < pkt.length; k++) if (rnd() < 0.05) pkt[k] = Math.floor(rnd() * 256);
    }
  }
  return pkt;
}

function localTag(s: SctpAssociation): number {
  return (s as unknown as { localTag: number }).localTag;
}

interface Internals {
  rCum: number;
  tAcked: number;
  tSendNext: number;
}

/** Moves TSN-like fields of DATA / SACK / FORWARD-TSN / SHUTDOWN chunks into the target's live windows. */
function rebase(pkt: Uint8Array, s: SctpAssociation, rnd: () => number): void {
  const st = s as unknown as Internals;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  let off = 12;
  while (off + 8 <= pkt.length) {
    const type = pkt[off];
    const len = dv.getUint16(off + 2);
    if (len < 4 || off + len > pkt.length) break;
    if (type === 0 || type === 192) dv.setUint32(off + 4, (st.rCum + Math.floor(rnd() * 40) - 4) >>> 0);
    else if (type === 3 || type === 7) {
      const span = (st.tSendNext - st.tAcked) >>> 0;
      dv.setUint32(off + 4, (st.tAcked + Math.floor(rnd() * (span + 2)) - 1) >>> 0);
    }
    off += (len + 3) & ~3;
  }
}

function retag(pkt: Uint8Array, tag: number): void {
  pkt[4] = tag >>> 24;
  pkt[5] = tag >>> 16;
  pkt[6] = tag >>> 8;
  pkt[7] = tag;
}

describe('fuzz', () => {
  it('100k mutated packets never throw nor corrupt internal state', () => {
    const base = corpus();
    expect(base.length).toBeGreaterThan(200);
    const rnd = mulberry32(12345);
    let pair = makePair({ seed: 1 });
    connectPair(pair);
    let restarts = 0;
    const listener = (): { s: SctpAssociation; errs: unknown[] } => {
      const errs: unknown[] = [];
      const s = new SctpAssociation({
        send() {},
        channels: [{ id: 0, ordered: true }],
        maxMessageSize: 65536,
        onMessage() {},
        onOpen() {},
        onClose() {},
        onError: (e) => errs.push(e),
      });
      return { s, errs };
    };
    let fresh = listener();
    const check = (...peers: Peer[]): void => {
      for (const p of peers) {
        expect(p.errors).toEqual([]);
        expect(p.sctp.stats().internalErrors).toBe(0);
      }
    };
    for (let n = 0; n < 100_000; n++) {
      const src = base[Math.floor(rnd() * base.length)];
      const other = base[Math.floor(rnd() * base.length)];
      const toFresh = rnd() < 0.15;
      const target = toFresh ? fresh.s : rnd() < 0.5 ? pair.b.sctp : pair.a.sctp;
      const based = src.slice();
      if (!toFresh && rnd() < 0.8) rebase(based, target, rnd);
      const pkt = rnd() < 0.15 ? based : mutate(based, rnd, other);
      if (!toFresh && rnd() < 0.9) retag(pkt, localTag(target));
      if (rnd() < 0.9) writeChecksum(pkt, pkt.length);
      else if (rnd() < 0.5) pkt.fill(0, 8, 12);
      expect(() => target.input(pkt)).not.toThrow();
      if (n % 64 === 0) {
        for (const ch of [0, 1, 2]) {
          pair.a.sctp.send(ch, msg(ch, n, n % 640 === 0 ? 4000 : 50));
          pair.b.sctp.send(ch, msg(ch, n, 60));
        }
        pair.sim.run(50);
      }
      if (n % 1000 === 999) {
        check(pair.a, pair.b);
        expect(fresh.errs).toEqual([]);
        expect(fresh.s.stats().internalErrors).toBe(0);
      }
      if (pair.a.sctp.readyState === 'closed' || pair.b.sctp.readyState === 'closed') {
        check(pair.a, pair.b);
        pair = makePair({ seed: n });
        connectPair(pair);
        restarts++;
      }
      if (rnd() < 0.001) fresh = listener();
    }
    check(pair.a, pair.b);
    // The associations stayed usable for most of the run.
    console.log("restarts", restarts, JSON.stringify(pair.b.sctp.stats()));
    const st = pair.b.sctp.stats();
    expect(st.dataChunksReceived + st.sacksReceived).toBeGreaterThan(0);
  });

  it('random garbage never throws', () => {
    const rnd = mulberry32(99);
    const p = makePair();
    connectPair(p);
    for (let n = 0; n < 20_000; n++) {
      const len = Math.floor(rnd() * 200);
      const pkt = new Uint8Array(len);
      for (let k = 0; k < len; k++) pkt[k] = Math.floor(rnd() * 256);
      if (len >= 12 && rnd() < 0.7) {
        retag(pkt, localTag(p.b.sctp));
        writeChecksum(pkt, len);
      }
      expect(() => p.b.sctp.input(pkt)).not.toThrow();
    }
    expect(p.b.sctp.stats().internalErrors).toBe(0);
    expect(p.b.errors).toEqual([]);
  });
});
