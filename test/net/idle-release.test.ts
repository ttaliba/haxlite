/**
 * Idle release of libdatachannel's native threads (`setWebRtcIdleRelease`):
 * once the last PeerConnection is confirmed closed, the safe teardown runs
 * after the delay; the next PeerConnection re-initialises the library.
 * Cycled to shake out crashes (the teardown is the dangerous call, see
 * src/net/webrtc.ts).
 */
import { readdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalPeerLink, setWebRtcIdleRelease, shutdownWebRtc, webRtcStats, type PeerLinkEvents } from '../../src/net/index.js';
import { closeNative, createDataChannel, createPeerConnection } from '../../src/net/webrtc.js';
import { waitFor } from '../host/harness.js';

const threads = () => (process.platform === 'linux' ? readdirSync('/proc/self/task').length : -1);

/**
 * Offerer (tracked by the crash-safe wrappers too, so the teardown never
 * meets an untracked native) ↔ haxlite LocalPeerLink, 3 negotiated channels;
 * one message each way.
 */
async function roundTrip(i: number): Promise<void> {
  let gatheredCb: () => void = () => {};
  const gathered = new Promise<void>((r) => (gatheredCb = r));
  const off = createPeerConnection(`idle-o${i}`, { iceServers: [], disableAutoNegotiation: true }, { onGatheringStateChange: (s) => s === 'complete' && gatheredCb() });
  let got: Uint8Array | null = null;
  const dcs = [0, 1, 2].map((id) =>
    createDataChannel(
      off,
      `c${id}`,
      { negotiated: true, id, unordered: id !== 0, ...(id === 2 ? { maxRetransmits: 0 } : {}) },
      { onMessage: id === 0 ? (m) => (got = m as Buffer) : undefined },
    ),
  );
  off.setLocalDescription('offer');
  await gathered;
  let open = 0;
  let echoed: Uint8Array | null = null;
  let link: LocalPeerLink | null = null;
  const ev: PeerLinkEvents = {
    onLocalDescription() {},
    onLocalCandidate() {},
    onGatheringComplete: () => off.setRemoteDescription(link!.native!.localDescription()!.sdp, 'answer'),
    onChannelOpen: () => void open++,
    onChannelClosed() {},
    onMessage: (_ch, data) => (echoed = data as Uint8Array),
    onConnectionState() {},
    onAbuse() {},
    onError: (e) => {
      throw e;
    },
  };
  link = new LocalPeerLink(`idle-a${i}`, { iceServers: [], disableAutoNegotiation: true }, off.localDescription()!.sdp, ev);
  await waitFor(() => open === 3 && dcs.every((d) => d.isOpen()), 10_000, 'channels open');
  expect(link.send(0, Uint8Array.of(1, 2, 3))).toBe(true);
  dcs[0]!.sendMessageBinary(Buffer.from([9]));
  await waitFor(() => got !== null && echoed !== null, 5000, 'messages');
  link.close();
  for (const d of dcs) closeNative(d);
  closeNative(off);
}

afterAll(async () => {
  setWebRtcIdleRelease(15_000);
  await shutdownWebRtc();
});

describe('WebRTC idle release', () => {
  it('releases the native threads when idle and re-initialises on demand (cycled)', async () => {
    setWebRtcIdleRelease(30);
    const base = threads();
    for (let i = 0; i < 12; i++) {
      const before = webRtcStats().releases;
      await roundTrip(i);
      if (i === 0 && base > 0) expect(threads()).toBeGreaterThan(base); // libdatachannel threads up
      await waitFor(() => webRtcStats().releases > before, 10_000, `idle release ${i}`);
      expect(webRtcStats().peerConnections).toBe(0);
    }
    // back to the thread count of a process that never used WebRTC (± Node's own)
    if (base > 0) await waitFor(() => threads() <= base + 1, 5000, 'threads gone');
  }, 120_000);

  it('a new PeerConnection cancels a pending release; null disables it', async () => {
    setWebRtcIdleRelease(400);
    const r0 = webRtcStats().releases;
    await roundTrip(100);
    await roundTrip(101); // within the delay: same native instance
    await waitFor(() => webRtcStats().releases === r0 + 1, 10_000, 'one release');
    setWebRtcIdleRelease(null);
    await roundTrip(102);
    await new Promise((r) => setTimeout(r, 600));
    expect(webRtcStats().releases).toBe(r0 + 1);
  }, 60_000);
});
