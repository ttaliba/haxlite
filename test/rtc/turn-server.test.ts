/**
 * The test TURN server (turn-server.ts) against an independent TURN client:
 * libdatachannel/libjuice (node-datachannel) with `iceTransportPolicy:
 * 'relay'` on both peers, so every byte goes through our allocations. This
 * validates the server before it is used to test haxlite-rtc's own client.
 */
import type { DataChannel, PeerConnection } from 'node-datachannel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeNative, createDataChannel, createPeerConnection, shutdownWebRtc } from '../../src/net/webrtc.js';
import { TurnServer } from './turn-server.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(async () => {
  await shutdownWebRtc();
});

interface Peer {
  pc: PeerConnection;
  dc: DataChannel;
  open: Promise<void>;
  received: Promise<string>;
}

function peer(name: string, iceServers: string[], others: () => Peer | undefined): Peer {
  let openRes!: () => void;
  const open = new Promise<void>((r) => (openRes = r));
  let recvRes!: (s: string) => void;
  const received = new Promise<string>((r) => (recvRes = r));
  const pc = createPeerConnection(
    name,
    { iceServers, iceTransportPolicy: 'relay', bindAddress: '127.0.0.1', disableAutoNegotiation: true } as never,
    {
      onLocalCandidate: (c, mid) => others()?.pc.addRemoteCandidate(c, mid),
    },
  );
  const dc = createDataChannel(pc, 'd', { negotiated: true, id: 0 }, {
    onOpen: () => openRes(),
    onMessage: (m) => recvRes(typeof m === 'string' ? m : Buffer.from(m as Buffer).toString()),
  });
  cleanups.push(() => {
    closeNative(dc);
    closeNative(pc);
  });
  return { pc, dc, open, received };
}

describe('test TURN server vs libdatachannel (relay-only)', () => {
  it('two relay-only peers connect and exchange data through it', async () => {
    const srv = await TurnServer.start({ verbose: !!process.env.TURN_VERBOSE });
    cleanups.push(() => srv.close());
    const url = srv.urlWithCredentials();
    let a!: Peer;
    let b!: Peer;
    a = peer('turn-a', [url], () => b);
    b = peer('turn-b', [url], () => a);
    a.pc.onLocalDescription((sdp, type) => b.pc.setRemoteDescription(sdp, type));
    b.pc.onLocalDescription((sdp, type) => a.pc.setRemoteDescription(sdp, type));
    a.pc.setLocalDescription('offer');
    // disableAutoNegotiation: b answers once the offer is in
    for (let t0 = Date.now(); b.pc.remoteDescription() === null && Date.now() - t0 < 5000; ) await sleep(20);
    b.pc.setLocalDescription('answer');
    const ok = await Promise.race([Promise.all([a.open, b.open]).then(() => true), sleep(15_000).then(() => false)]);
    expect(ok).toBe(true);
    a.dc.sendMessage('hello');
    b.dc.sendMessage('world');
    expect(await b.received).toBe('hello');
    expect(await a.received).toBe('world');
    const c = srv.counters;
    expect(c.unauthorized).toBeGreaterThanOrEqual(2); // the first Allocate of each peer is challenged
    expect(c.allocations).toBeGreaterThanOrEqual(2);
    // libjuice may pair its host base with the other's relay: at least one side needs a permission
    expect(c.permissions + c.channels).toBeGreaterThanOrEqual(1);
    expect(c.droppedSendNoPermission).toBe(0);
    expect(c.badIntegrity).toBe(0);
    // relayed data went through Send/Data indications or channels
    expect(c.sendIndications + c.channelDataIn).toBeGreaterThan(0);
    expect(c.dataIndications + c.channelDataOut).toBeGreaterThan(0);
  }, 30_000);

  it('rejects a wrong password (no allocation)', async () => {
    const srv = await TurnServer.start();
    cleanups.push(() => srv.close());
    const pc = createPeerConnection('turn-bad', { iceServers: [`turn:user:nope@127.0.0.1:${srv.port}`], iceTransportPolicy: 'relay', disableAutoNegotiation: true } as never, {});
    const dc = createDataChannel(pc, 'd', { negotiated: true, id: 0 }, {});
    cleanups.push(() => {
      closeNative(dc);
      closeNative(pc);
    });
    pc.setLocalDescription('offer');
    await sleep(1500);
    expect(srv.counters.unauthorized).toBeGreaterThanOrEqual(2);
    expect(srv.counters.allocations).toBe(0);
  });
});
