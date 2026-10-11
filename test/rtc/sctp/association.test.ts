/**
 * SctpAssociation between two instances over a simulated link (virtual
 * clock, seeded PRNG): handshake, channel semantics under loss / reordering
 * / duplication, fragmentation, PR-SCTP, stream reset, teardown.
 */
import { describe, expect, it } from 'vitest';
import { SctpAssociation } from '../../../src/rtc/sctp/index.js';
import { checkMsg, chunkTypes, connectPair, dataChunks, makePair, msg, msgId, type Peer } from './harness.js';

function byCh(p: Peer, ch: number): Uint8Array[] {
  return p.received.filter((r) => r.ch === ch).map((r) => r.data);
}

function noErrors(...peers: Peer[]): void {
  for (const p of peers) {
    expect(p.errors).toEqual([]);
    expect(p.sctp.stats().internalErrors).toBe(0);
  }
}

describe('handshake', () => {
  it('establishes (client → server) and exchanges messages on all 3 channels', () => {
    const p = makePair({ recordWire: true });
    expect(connectPair(p)).toBe(true);
    for (const ch of [0, 1, 2]) {
      expect(p.a.sctp.send(ch, msg(ch, 1))).toBe(true);
      expect(p.b.sctp.send(ch, msg(ch, 2))).toBe(true);
    }
    p.sim.run(1000);
    expect(byCh(p.b, 0).map(msgId)).toEqual([1]);
    expect(byCh(p.b, 1).map(msgId)).toEqual([1]);
    expect(byCh(p.b, 2).map(msgId)).toEqual([1]);
    expect(byCh(p.a, 0).map(msgId)).toEqual([2]);
    expect(byCh(p.a, 2).map(msgId)).toEqual([2]);
    expect(p.a.sctp.readyState).toBe('established');
    // INIT, COOKIE-ECHO from a; INIT-ACK, COOKIE-ACK from b.
    expect(chunkTypes(p.a.wire[0])).toEqual([1]);
    expect(chunkTypes(p.b.wire[0])).toEqual([2]);
    expect(chunkTypes(p.a.wire[1])).toEqual([10]);
    expect(chunkTypes(p.b.wire[1])[0]).toBe(11);
    noErrors(p.a, p.b);
  });

  it('survives a lossy handshake (INIT / COOKIE retransmission)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = makePair({ seed, link: { loss: 0.25, delay: 20, jitter: 20 } });
      expect(connectPair(p, 120_000)).toBe(true);
      noErrors(p.a, p.b);
    }
  });

  it('handles an INIT collision (both sides connect)', () => {
    const p = makePair({ link: { delay: 30 } });
    p.a.sctp.connect();
    p.b.sctp.connect();
    expect(p.sim.runUntil(() => p.a.opened && p.b.opened)).toBe(true);
    p.a.sctp.send(0, msg(0, 5));
    p.b.sctp.send(0, msg(0, 6));
    p.sim.run(1000);
    expect(byCh(p.b, 0).map(msgId)).toEqual([5]);
    expect(byCh(p.a, 0).map(msgId)).toEqual([6]);
    noErrors(p.a, p.b);
  });

  it('gives up after max INIT retransmissions', () => {
    const p = makePair();
    p.cutLink();
    p.a.sctp.connect();
    p.sim.run(600_000);
    expect(p.a.closed).toBe('init-timeout');
  });

  it('rejects a forged / expired cookie', () => {
    const p = makePair({ recordWire: true });
    expect(connectPair(p)).toBe(true);
    const echo = p.a.wire.find((w) => chunkTypes(w)[0] === 10)!;
    // A fresh server (different cookie key) must ignore it.
    const sent: Uint8Array[] = [];
    let opened = false;
    const s = new SctpAssociation({ send: (x) => sent.push(x.slice()), channels: [], maxMessageSize: 65536, onMessage() {}, onOpen: () => (opened = true), onClose() {} });
    s.input(echo);
    expect(opened).toBe(false);
    expect(sent.length).toBe(0);
  });
});

describe('channel semantics over a lossy, reordering, duplicating link', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: ro in order, ru complete, uu no duplicates / no retransmissions`, () => {
      const p = makePair({ seed, link: { loss: 0.1, dup: 0.05, delay: 25, jitter: 30 }, recordWire: true });
      expect(connectPair(p)).toBe(true);
      const N = 600;
      let i = 0;
      // Interleaved traffic both ways at ~60 Hz with bursts.
      const tick = (): void => {
        for (let k = 0; k < 3 && i < N; k++, i++) {
          for (const ch of [0, 1, 2]) {
            expect(p.a.sctp.send(ch, msg(ch, i, 20 + ((i * 37) % 200)))).toBe(true);
            expect(p.b.sctp.send(ch, msg(ch, i, 20 + ((i * 53) % 200)))).toBe(true);
          }
        }
        if (i < N) p.sim.at(16, tick);
      };
      tick();
      p.sim.runUntil(() => i >= N && byCh(p.b, 0).length === N && byCh(p.b, 1).length === N && byCh(p.a, 0).length === N && byCh(p.a, 1).length === N, 300_000);
      p.sim.run(5000);
      for (const [rx, tx] of [
        [p.b, p.a],
        [p.a, p.b],
      ] as const) {
        const ro = byCh(rx, 0);
        expect(ro.map(msgId)).toEqual([...Array(N).keys()]);
        expect(ro.every((m) => checkMsg(0, m))).toBe(true);
        const ru = byCh(rx, 1);
        expect(ru.length).toBe(N);
        expect(new Set(ru.map(msgId)).size).toBe(N);
        expect(ru.every((m) => checkMsg(1, m))).toBe(true);
        const uu = byCh(rx, 2);
        const ids = uu.map(msgId);
        expect(new Set(ids).size).toBe(ids.length); // never duplicated
        expect(uu.every((m) => checkMsg(2, m))).toBe(true);
        expect(ids.length).toBeGreaterThan(N * 0.75); // ~10% loss
        expect(ids.length).toBeLessThan(N);
        // uu: every DATA chunk of stream 2 put on the wire exactly once.
        const tsns = tx.wire.flatMap(dataChunks).filter((c) => c.sid === 2).map((c) => c.tsn);
        expect(new Set(tsns).size).toBe(tsns.length);
        expect(tx.sctp.stats().abandonedMessages).toBeGreaterThan(0);
        expect(tx.sctp.stats().retransmissions).toBeGreaterThan(0);
        expect(tx.sctp.bufferedAmount).toBe(0);
        expect(held(rx)).toBe(0);
      }
      noErrors(p.a, p.b);
    });
  }

  it('is deterministic for a given seed', () => {
    const run = (): string => {
      const p = makePair({ seed: 42, link: { loss: 0.15, dup: 0.05, delay: 20, jitter: 40 } });
      connectPair(p);
      for (let i = 0; i < 200; i++) for (const ch of [0, 1, 2]) p.a.sctp.send(ch, msg(ch, i));
      p.sim.run(30_000);
      return JSON.stringify(p.b.received.map((r) => [r.ch, msgId(r.data)])) + JSON.stringify(p.a.sctp.stats());
    };
    expect(run()).toBe(run());
  });

  it('ordered PR-SCTP channel (ordered + maxRetransmits 0) never stalls: FORWARD-TSN skips SSNs', () => {
    const p = makePair({ seed: 9, link: { loss: 0.2, delay: 20, jitter: 10 }, channels: [{ id: 3, ordered: true, maxRetransmits: 0 }] });
    expect(connectPair(p)).toBe(true);
    for (let i = 0; i < 500; i++) p.sim.at(i * 10, () => p.a.sctp.send(3, msg(3, i)));
    p.sim.run(20_000);
    const ids = byCh(p.b, 3).map(msgId);
    expect(ids.length).toBeGreaterThan(300);
    for (let k = 1; k < ids.length; k++) expect(ids[k]).toBeGreaterThan(ids[k - 1]);
    expect(ids[ids.length - 1]).toBeGreaterThan(490);
    expect(p.a.sctp.stats().forwardTsnSent).toBeGreaterThan(0);
    expect(p.b.sctp.stats().forwardTsnReceived).toBeGreaterThan(0);
    expect(p.a.sctp.bufferedAmount).toBe(0);
    noErrors(p.a, p.b);
  });
});

function held(p: Peer): number {
  return (p.sctp as unknown as { heldBytes: number }).heldBytes;
}

describe('fragmentation', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: fragmented uu (maxRetransmits 0) messages under loss: intact or dropped, no leak`, () => {
      const p = makePair({ seed, link: { loss: 0.08, dup: 0.03, delay: 15, jitter: 25 } });
      expect(connectPair(p)).toBe(true);
      const N = 200;
      for (let i = 0; i < N; i++) {
        p.sim.at(i * 8, () => {
          p.a.sctp.send(2, msg(2, i, 1000 + ((i * 997) % 6000)));
          p.a.sctp.send(0, msg(0, i, 50));
        });
      }
      p.sim.run(30_000);
      const uu = byCh(p.b, 2);
      const ids = uu.map(msgId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(uu.every((m) => checkMsg(2, m))).toBe(true);
      expect(ids.length).toBeGreaterThan(N * 0.4);
      expect(ids.length).toBeLessThan(N);
      expect(byCh(p.b, 0).map(msgId)).toEqual([...Array(N).keys()]);
      expect(p.a.sctp.bufferedAmount).toBe(0);
      expect(held(p.b)).toBe(0); // no partial fragments left behind
      noErrors(p.a, p.b);
    });
  }

  for (const [ch, size] of [
    [0, 20_000],
    [1, 20_000],
    [0, 200_000],
    [1, 262_144],
    [2, 5_000],
  ] as const) {
    it(`ch ${ch}: ${size}-byte messages over a lossy link`, () => {
      const p = makePair({ seed: size + ch, link: { loss: ch === 2 ? 0 : 0.05, dup: 0.02, delay: 15, jitter: 20 } });
      expect(connectPair(p)).toBe(true);
      const n = size > 100_000 ? 4 : 10;
      for (let i = 0; i < n; i++) {
        expect(p.a.sctp.send(ch, msg(ch, i, size))).toBe(true);
        p.a.sctp.send(0, msg(0, 1000 + i, 40)); // small messages interleaved
      }
      p.sim.runUntil(() => byCh(p.b, ch).filter((m) => m.length === size).length === n, 600_000);
      const big = byCh(p.b, ch).filter((m) => m.length === size);
      expect(big.length).toBe(n);
      expect(big.every((m) => checkMsg(ch, m))).toBe(true);
      if (ch === 0) expect(big.map(msgId)).toEqual([...Array(n).keys()]);
      noErrors(p.a, p.b);
    });
  }

  it('fragments at the MTU and respects maxMessageSize', () => {
    const p = makePair({ recordWire: true, optsA: { maxMessageSize: 10_000 } });
    expect(connectPair(p)).toBe(true);
    expect(p.a.sctp.send(0, new Uint8Array(10_001))).toBe(false);
    expect(p.a.sctp.send(0, msg(0, 1, 10_000))).toBe(true);
    p.sim.run(2000);
    expect(byCh(p.b, 0).length).toBe(1);
    expect(p.a.wire.every((w) => w.length <= 1200)).toBe(true);
    const frags = p.a.wire.flatMap(dataChunks);
    expect(frags.length).toBe(Math.ceil(10_000 / 1172));
  });

  it('aborts when the peer exceeds our max receive message size', () => {
    const p = makePair({ optsB: { maxReceiveMessageSize: 4000 } });
    expect(connectPair(p)).toBe(true);
    p.a.sctp.send(0, new Uint8Array(5000));
    p.sim.run(2000);
    expect(p.b.closed).toBe('message-too-large');
    expect(p.a.closed).toBe('abort');
  });
});

describe('payload edge cases', () => {
  it('empty messages (PPID 57/56) and string PPID', () => {
    const got: [number, number, number][] = [];
    const p = makePair({ optsB: { onMessage: (ch, d, ppid) => got.push([ch, d.length, ppid]) } });
    expect(connectPair(p)).toBe(true);
    p.a.sctp.send(0, new Uint8Array(0));
    p.a.sctp.send(1, new Uint8Array(0), 51);
    p.a.sctp.send(2, new TextEncoder().encode('hi'), 51);
    p.sim.run(1000);
    expect(got).toEqual([
      [0, 0, 57],
      [1, 0, 56],
      [2, 2, 51],
    ]);
  });

  it('send() refuses unknown channels and non-open associations', () => {
    const p = makePair();
    expect(p.a.sctp.send(0, msg(0, 1))).toBe(false);
    expect(connectPair(p)).toBe(true);
    expect(p.a.sctp.send(7, msg(0, 1))).toBe(false);
    expect(p.a.sctp.send(-1, msg(0, 1))).toBe(false);
  });

  it('caller may reuse its buffer right after send()', () => {
    const p = makePair({ link: { delay: 50 } });
    expect(connectPair(p)).toBe(true);
    const buf = new Uint8Array(100);
    // Fill cwnd so later messages are queued (not sent synchronously).
    for (let i = 0; i < 300; i++) {
      buf.set(msg(1, i, 100));
      p.a.sctp.send(1, buf);
      buf.fill(0xee);
    }
    p.sim.run(10_000);
    const r = byCh(p.b, 1);
    expect(r.length).toBe(300);
    expect(r.every((m) => checkMsg(1, m))).toBe(true);
  });

  it('send buffer limit makes send() return false', () => {
    const p = makePair({ optsA: { sendBufferLimit: 50_000 } });
    expect(connectPair(p)).toBe(true);
    p.cutLink();
    let ok = 0;
    for (let i = 0; i < 100; i++) if (p.a.sctp.send(0, new Uint8Array(1000))) ok++;
    expect(ok).toBe(50);
    expect(p.a.sctp.bufferedAmount).toBe(50_000);
  });

  it('bundles sends issued from onMessage with the SACK', () => {
    const p = makePair({ recordWire: true, optsB: { onMessage: (ch, d) => void p.b.sctp.send(ch, d) } });
    expect(connectPair(p)).toBe(true);
    const before = p.b.wire.length;
    p.a.sctp.send(0, msg(0, 1));
    p.sim.run(50);
    const echo = p.b.wire.slice(before);
    expect(echo.length).toBe(1);
    expect(chunkTypes(echo[0])).toEqual([3, 0]); // SACK + DATA in one packet
  });

  it('cork()/uncork() bundles many messages into few packets', () => {
    const p = makePair({ recordWire: true });
    expect(connectPair(p)).toBe(true);
    const before = p.a.wire.length;
    p.a.sctp.cork();
    for (let i = 0; i < 30; i++) p.a.sctp.send(1, msg(1, i, 30));
    p.a.sctp.uncork();
    expect(p.a.wire.length - before).toBe(2); // 30 × 48 B → 2 packets of ≤ 1200 B
    p.sim.run(1000);
    expect(byCh(p.b, 1).length).toBe(30);
  });
});

describe('zero checksum (RFC 9653)', () => {
  it('negotiated: established packets carry checksum 0; otherwise CRC32c', () => {
    for (const zc of [true, false]) {
      const p = makePair({ recordWire: true, optsB: { zeroChecksum: zc } });
      expect(connectPair(p)).toBe(true);
      p.a.sctp.send(0, msg(0, 1));
      p.sim.run(1000);
      const last = p.a.wire[p.a.wire.length - 1];
      const ck = last[8] | last[9] | last[10] | last[11];
      expect(ck === 0).toBe(zc);
      expect(p.a.sctp.stats().zeroChecksum).toBe(zc);
      expect(byCh(p.b, 0).length).toBe(1);
    }
  });

  it('drops packets with a bad checksum', () => {
    const p = makePair({ recordWire: true, opts: { zeroChecksum: false } });
    expect(connectPair(p)).toBe(true);
    p.a.sctp.send(0, msg(0, 1));
    const pkt = p.a.wire[p.a.wire.length - 1].slice();
    pkt[pkt.length - 1] ^= 1;
    const before = p.b.sctp.stats().checksumErrors;
    p.b.sctp.input(pkt);
    expect(p.b.sctp.stats().checksumErrors).toBe(before + 1);
  });
});

describe('teardown', () => {
  it('graceful shutdown after all data is acknowledged', () => {
    const p = makePair({ seed: 3, link: { loss: 0.1, delay: 20 } });
    expect(connectPair(p)).toBe(true);
    for (let i = 0; i < 100; i++) p.a.sctp.send(0, msg(0, i));
    p.a.sctp.shutdown();
    expect(p.a.sctp.send(0, msg(0, 999))).toBe(false);
    p.sim.run(60_000);
    expect(byCh(p.b, 0).map(msgId)).toEqual([...Array(100).keys()]);
    expect(p.a.closed).toBe('shutdown');
    expect(p.b.closed).toBe('shutdown');
    noErrors(p.a, p.b);
  });

  it('close() sends ABORT: peer reports abort, local side is silent', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    p.a.sctp.close();
    p.a.sctp.close();
    p.sim.run(1000);
    expect(p.a.closed).toBe(null);
    expect(p.b.closed).toBe('abort');
    expect(p.a.sctp.readyState).toBe('closed');
  });

  it('times out when the peer vanishes', () => {
    const p = makePair();
    expect(connectPair(p)).toBe(true);
    p.cutLink();
    p.a.sctp.send(0, msg(0, 1));
    p.sim.run(600_000);
    expect(p.a.closed).toBe('timeout');
  });
});

describe('stream reset (RE-CONFIG)', () => {
  it('closeChannel resets both directions; other channels keep working', () => {
    const p = makePair({ seed: 5, link: { loss: 0.1, delay: 20 } });
    expect(connectPair(p)).toBe(true);
    for (let i = 0; i < 20; i++) p.a.sctp.send(1, msg(1, i));
    p.a.sctp.closeChannel(1);
    expect(p.a.sctp.send(1, msg(1, 99))).toBe(false);
    p.sim.run(20_000);
    expect(byCh(p.b, 1).length).toBe(20); // data before the reset is delivered
    expect(p.b.channelClosed).toEqual([1]);
    expect(p.a.channelClosed).toEqual([1]);
    expect(p.b.sctp.send(1, msg(1, 1))).toBe(false);
    p.a.sctp.send(0, msg(0, 7));
    p.b.sctp.send(2, msg(2, 8));
    p.sim.run(2000);
    expect(byCh(p.b, 0).map(msgId)).toEqual([7]);
    expect(byCh(p.a, 2).map(msgId)).toEqual([8]);
    noErrors(p.a, p.b);
  });

  it('DCEP OPEN for an unknown id is rejected (stream reset) or accepted with acceptDcep', () => {
    for (const accept of [false, true]) {
      const opened: [number, string][] = [];
      const p = makePair({ optsB: { acceptDcep: accept, onChannelOpen: (id, label) => opened.push([id, label]) } });
      expect(connectPair(p)).toBe(true);
      // DATA_CHANNEL_OPEN: reliable ordered, label "x", on stream 5 (sent raw via an internal enqueue)
      const open = new Uint8Array([0x03, 0x00, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0x78]);
      (p.a.sctp as unknown as { enqueue(s: number, d: Uint8Array, ppid: number, o: boolean, m: number): boolean }).enqueue(5, open, 50, true, -1);
      p.sim.run(5000);
      if (accept) {
        expect(opened).toEqual([[5, 'x']]);
        expect(p.b.sctp.send(5, msg(5, 1))).toBe(true);
      } else {
        expect(opened).toEqual([]);
        expect(p.b.sctp.send(5, msg(5, 1))).toBe(false);
      }
      noErrors(p.a, p.b);
    }
  });
});

describe('congestion / timers', () => {
  it('slow start grows cwnd with bulk traffic and T3 collapses it', () => {
    const p = makePair({ link: { delay: 20 } });
    expect(connectPair(p)).toBe(true);
    const c0 = p.a.sctp.stats().cwnd;
    for (let i = 0; i < 400; i++) p.a.sctp.send(1, new Uint8Array(1000));
    p.sim.run(5000);
    expect(p.a.sctp.stats().cwnd).toBeGreaterThan(c0);
    p.cutLink();
    p.a.sctp.send(1, new Uint8Array(1000));
    p.sim.run(2000);
    expect(p.a.sctp.stats().t3Expirations).toBeGreaterThan(0);
    expect(p.a.sctp.stats().cwnd).toBe(1200);
  });

  it('RTT estimate converges and idle associations hold no timers', () => {
    const p = makePair({ link: { delay: 40 } });
    expect(connectPair(p)).toBe(true);
    for (let i = 0; i < 50; i++) p.sim.at(i * 20, () => p.a.sctp.send(0, msg(0, i)));
    p.sim.run(5000);
    const s = p.a.sctp.stats();
    expect(s.srtt).toBeGreaterThanOrEqual(80);
    expect(s.srtt).toBeLessThan(300);
    // Nothing outstanding: no more events once idle.
    p.sim.run(1000);
    expect(p.sim.step()).toBe(false);
  });
});
