/**
 * Full stack behind a (simulated) NAT: haxlite HostTransport with
 * `peerBackend: 'rtc'` (full ICE, no publicAddresses, STUN for the srflx)
 * whose endpoint binds 127.0.0.1 and reaches the outside only through the
 * userspace NAT of test/rtc/nat-sim.ts, and real node-haxball CLIENTS
 * (libdatachannel) joining through the fake master — the clients of the
 * benchmark harness (bench/net/clients-proc.mjs).
 *
 * The NAT "routing" of the client's candidates is a thin PeerBackend wrapper
 * that hands the backend each remote candidate rewritten to its NAT alias.
 */
import os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { cleanupNodeHaxball, nodeHaxballFor } from '../fake-master/node-haxball.js';
import { HostTransport, RtcPeerBackend, shutdownWebRtc, type Peer } from '../../src/net/index.js';
import type { PeerBackend, PeerLink, PeerLinkEvents } from '../../src/net/peer-backend.js';
import { FakeStunServer, UdpNat } from '../rtc/nat-sim.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const PUBLIC = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

/** The inner backend sees the client's candidates through the NAT (rewritten to their aliases). */
class NatRoutedBackend implements PeerBackend {
  readonly kind = 'rtc-nat';
  constructor(
    readonly inner: RtcPeerBackend,
    private readonly nat: UdpNat,
  ) {}
  get prefiltered(): boolean {
    return this.inner.prefiltered;
  }
  get ready(): boolean {
    return this.inner.ready;
  }
  start(h: Parameters<PeerBackend['start']>[0]): void {
    this.inner.start(h);
  }
  stop(): void {
    this.inner.stop();
  }
  cork(): void {
    this.inner.cork();
  }
  uncork(): void {
    this.inner.uncork();
  }
  createPeer(id: number, offerSdp: string, ev: PeerLinkEvents): PeerLink {
    const link = this.inner.createPeer(id, offerSdp, ev);
    return {
      addRemoteCandidate: (c, mid) => void this.nat.rewriteCandidate(c).then((r) => r !== null && link.addRemoteCandidate(r, mid)),
      send: (i, d) => link.send(i, d),
      close: () => link.close(),
    };
  }
}

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

let master: FakeMaster | null = null;
afterAll(async () => {
  await master?.close();
  await shutdownWebRtc();
  cleanupNodeHaxball();
});

describe.skipIf(PUBLIC === undefined)("peerBackend 'rtc' behind a simulated NAT with node-haxball clients", () => {
  it('three node-haxball clients join through a port-restricted NAT (srflx + our checks)', async () => {
    master = await FakeMaster.start();
    const nh = nodeHaxballFor(master, { sendDelayMs: 0 });
    const stun = await FakeStunServer.start(PUBLIC!);
    const nat = new UdpNat({ insideAddress: '127.0.0.1', outsideAddress: PUBLIC! });
    const alias = await nat.alias({ address: stun.address, port: stun.port });
    const inner = new RtcPeerBackend({ address: '127.0.0.1', shared: false }, { iceServers: [`stun:${alias.address}:${alias.port}`] });
    const t = new HostTransport({ token: 'thr1.test', masterUrl: master.httpBase, public: true, backend: new NatRoutedBackend(inner, nat) });
    const joins: Any[] = [];
    try {
      const room = master.waitForRoom();
      t.start();
      const fakeRoom = await withTimeout(room, 10_000, 'room registration');
      await inner.whenListening();
      await inner.endpoint!.whenGathered();
      expect(inner.endpoint!.reflexiveAddresses[0]?.address).toBe(PUBLIC);
      // no host candidate at all: only the NAT's external address is announced
      expect(inner.endpoint!.localCandidates.every((c) => / typ srflx /.test(c))).toBe(true);
      const joined: Peer[] = [];
      t.onPeerJoin = (p) => joined.push(p);
      for (let i = 0; i < 3; i++) {
        const [, authObj] = (await nh.Utils.generateAuth()) as [string, Any];
        joins.push(
          nh.Room.join({ id: fakeRoom.id, password: null, authObj }, { storage: { player_name: `nat${i}`, avatar: null, geo: { lat: 0, lon: 0, flag: 'uy' } } }),
        );
      }
      await withTimeout(
        (async () => {
          while (joined.length < 3) await new Promise((r) => setTimeout(r, 20));
        })(),
        30_000,
        'three joins',
      );
      for (const p of joined) {
        expect(p.channelOpen).toEqual([true, true, true]);
        expect(t.send(p, 0, Uint8Array.of(1, 2, 3))).toBe(true);
      }
      const st = inner.stats()!;
      expect(st.open).toBe(3);
      expect(st.ice.checksSucceeded).toBeGreaterThanOrEqual(3);
      expect(nat.stats.in).toBeGreaterThan(30);
    } finally {
      for (const j of joins) {
        try {
          j.cancel();
        } catch {
          /* gone */
        }
      }
      t.stop();
      await inner.whenClosed();
      nat.close();
      stun.close();
    }
  }, 60_000);
});
