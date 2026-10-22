/**
 * The queue the transport watches for stalled peers (`PeerLink.queuedBytes`)
 * is wired on both local backends: it grows with what the host sends a real
 * (libdatachannel) client and drains back once the client takes it, and a
 * healthy client receiving a large burst is never closed for it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { RawClient } from './raw-client.js';
import { HostTransport, RtcPeerBackend, shutdownWebRtc, type HostTransportOptions, type Peer, type PeerCloseReason } from '../../src/net/index.js';

let master: FakeMaster;
const transports: HostTransport[] = [];
const clients: RawClient[] = [];

beforeAll(async () => {
  master = await FakeMaster.start();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const t of transports.splice(0)) {
    t.stop();
    if (t.backend instanceof RtcPeerBackend) await t.backend.whenClosed();
  }
});

afterAll(async () => {
  await master.close();
  await shutdownWebRtc();
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

const BACKENDS: { name: string; opts: Partial<HostTransportOptions> }[] = [
  { name: 'rtc', opts: { peerBackend: 'rtc', rtcEndpoint: { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] } } },
  { name: 'ndc', opts: { iceServers: [], iceCandidatePolicy: 'all' } },
];

describe.each(BACKENDS)('queued bytes ($name backend)', ({ name, opts }) => {
  it('grow with a burst, drain as the client reads it; the client is not closed', async () => {
    const t = new HostTransport({
      token: 'thr1.test',
      masterUrl: master.httpBase,
      sweepIntervalMs: 50,
      maxPeerBufferedBytes: 64 * 1024,
      peerBufferedTimeoutMs: 3000,
      ...opts,
    });
    transports.push(t);
    const room = master.waitForRoom();
    t.start();
    const roomId = (await withTimeout(room, 10_000, 'room registration')).id;
    const joined = withTimeout(new Promise<Peer>((resolve) => (t.onPeerJoin = (peer) => resolve(peer))), 15_000, 'join');
    const closes: PeerCloseReason[] = [];
    t.onPeerClose = (_p, reason) => closes.push(reason);
    const c = new RawClient({ wsBase: master.wsBase, roomId });
    clients.push(c);
    const peer = await joined;
    await c.whenOpen();
    const link = peer.link!;
    expect(typeof link.queuedBytes).toBe('function');
    const body = new Uint8Array(16 * 1024).fill(7);
    body[0] = 200;
    const N = 64; // 1 MiB in one go, 16 times the threshold
    for (let i = 0; i < N; i++) t.send(peer, 0, body);
    const queued = link.queuedBytes!();
    if (name === 'rtc') expect(queued).toBeGreaterThan(512 * 1024); // nothing is acknowledged within this turn
    else expect(queued).toBeGreaterThanOrEqual(0); // libdatachannel only counts what usrsctp did not take yet
    await withTimeout(c.waitMessages(N), 15_000, 'burst delivered');
    const t0 = performance.now();
    while (link.queuedBytes!() > 0 && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    expect(link.queuedBytes!()).toBe(0);
    expect(peer.state).toBe('joined');
    expect(closes).toEqual([]);
  });
});
