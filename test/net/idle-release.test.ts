/**
 * Idle release of libdatachannel's native threads (`setWebRtcIdleRelease`):
 * once the last PeerConnection is confirmed closed, the safe teardown runs
 * after the delay; the next PeerConnection re-initialises the library.
 * Cycled to shake out crashes (the teardown is the dangerous call, see
 * src/net/webrtc.ts).
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DataChannel, PeerConnection } from 'node-datachannel';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalPeerLink, setWebRtcIdleRelease, shutdownWebRtc, webRtcStats, type PeerLinkEvents } from '../../src/net/index.js';
import { closeNative, createDataChannel, createPeerConnection } from '../../src/net/webrtc.js';
import { waitFor } from '../host/harness.js';

const threads = () => (process.platform === 'linux' ? readdirSync('/proc/self/task').length : -1);

/** The offer without its candidate lines, and those lines (no `a=`) with their mid. */
function splitCandidates(sdp: string): { sdp: string; candidates: string[]; mid: string } {
  const lines = sdp.split('\r\n');
  const mid = lines.find((l) => l.startsWith('a=mid:'))?.slice(6) ?? '0';
  const candidates = lines.filter((l) => l.startsWith('a=candidate:')).map((l) => l.slice(2));
  const rest = lines.filter((l) => !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates');
  return { sdp: rest.join('\r\n'), candidates, mid };
}

interface Session {
  off: PeerConnection;
  dcs: DataChannel[];
  link: LocalPeerLink;
  /** Channels open on the haxlite side. */
  open: () => number;
  /** First `failed` seen on either side, or null. */
  failed: () => string | null;
  got: () => Uint8Array | null;
  echoed: () => Uint8Array | null;
}

/**
 * Offerer (tracked by the crash-safe wrappers too, so the teardown never
 * meets an untracked native) ↔ haxlite LocalPeerLink, 3 negotiated channels.
 *
 * The offerer's candidates reach the link only after the offerer has applied
 * the answer (trickled, as a browser does). Handing them over inside the offer
 * lets the link start its ICE checks before the offerer has the answer; the
 * offerer's ICE then connects *inside* `setRemoteDescription` (libdatachannel
 * 0.24 hands the description to the ICE agent before storing it), and the
 * DTLS handshake, on another thread, checks the peer certificate against a
 * remote description that is not stored yet: "certificate verify failed",
 * both PeerConnections fail. A race of libdatachannel as the side that
 * receives the answer (browsers are not affected), seen in ~1 of 10 runs of
 * this file under CPU contention. `tamperAnswer` corrupts the fingerprint the
 * offerer sees (a DTLS failure on purpose).
 */
async function connect(i: number, tamperAnswer = false): Promise<Session> {
  let gatheredCb: () => void = () => {};
  const gathered = new Promise<void>((r) => (gatheredCb = r));
  let failed: string | null = null;
  const off = createPeerConnection(
    `idle-o${i}`,
    { iceServers: [], disableAutoNegotiation: true },
    {
      onGatheringStateChange: (s) => s === 'complete' && gatheredCb(),
      onStateChange: (s) => void (s === 'failed' && (failed ??= 'offerer failed')),
    },
  );
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
  const offer = splitCandidates(off.localDescription()!.sdp);
  let open = 0;
  let echoed: Uint8Array | null = null;
  let link: LocalPeerLink | null = null;
  const ev: PeerLinkEvents = {
    onLocalDescription() {},
    onLocalCandidate() {},
    // outside the native callback: no re-entering libdatachannel from its own thread-safe call
    onGatheringComplete: () =>
      setImmediate(() => {
        let answer = link!.native!.localDescription()!.sdp;
        if (tamperAnswer) answer = answer.replace(/(a=fingerprint:sha-256 )([0-9A-F])/, (_m, p: string, c: string) => p + (c === '0' ? '1' : '0'));
        off.setRemoteDescription(answer, 'answer');
        for (const c of offer.candidates) link!.addRemoteCandidate(c, offer.mid);
      }),
    onChannelOpen: () => void open++,
    onChannelClosed() {},
    onMessage: (_ch, data) => (echoed = data as Uint8Array),
    onConnectionState: (s) => void (s === 'failed' && (failed ??= 'haxlite side failed')),
    onAbuse() {},
    onError: (e) => {
      throw e;
    },
  };
  link = new LocalPeerLink(`idle-a${i}`, { iceServers: [], disableAutoNegotiation: true }, offer.sdp, ev);
  return { off, dcs, link, open: () => open, failed: () => failed, got: () => got, echoed: () => echoed };
}

/** One message each way, then everything closed through haxlite's wrappers. */
async function roundTrip(i: number): Promise<void> {
  const s = await connect(i);
  await waitFor(
    () => {
      const f = s.failed();
      if (f !== null) throw new Error(`connection ${i}: ${f}`); // at once, not after the timeout
      return s.open() === 3 && s.dcs.every((d) => d.isOpen());
    },
    10_000,
    'channels open',
  );
  expect(s.link.send(0, Uint8Array.of(1, 2, 3))).toBe(true);
  s.dcs[0]!.sendMessageBinary(Buffer.from([9]));
  await waitFor(() => s.got() !== null && s.echoed() !== null, 5000, 'messages');
  s.link.close();
  for (const d of s.dcs) closeNative(d);
  closeNative(s.off);
}

afterAll(async () => {
  setWebRtcIdleRelease(15_000);
  await shutdownWebRtc();
});

describe('WebRTC idle release', () => {
  it('releases the native threads when idle and re-initialises on demand (cycled)', async () => {
    setWebRtcIdleRelease(30);
    // node-datachannel is loaded lazily (src/net/webrtc.ts) and loading the addon alone starts
    // threads that stay for the process lifetime: measure the base with the addon loaded
    createRequire(import.meta.url)('node-datachannel');
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

  it('PeerConnections that close by themselves (failed DTLS) do not stall the release', async () => {
    // libdatachannel closes a failed PeerConnection on its own, and node-datachannel then keeps
    // the native object until the JS wrapper is closed or collected; cleanup() waits for every
    // native, so the release used to block the event loop for 10 s, fail ("cleanup timeout")
    // and switch the idle release off for good.
    setWebRtcIdleRelease(30);
    const r0 = webRtcStats().releases;
    const s = await connect(200, true);
    await waitFor(() => s.failed() !== null, 10_000, 'DTLS failure');
    const t0 = performance.now();
    await waitFor(() => webRtcStats().releases === r0 + 1, 10_000, 'release after the failure');
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(webRtcStats().peerConnections).toBe(0);
    expect(s.link.native).not.toBeNull(); // nobody called close(): the JS wrappers are still referenced here
    await roundTrip(201); // and the library comes back
  }, 60_000);
});
