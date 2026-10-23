/**
 * Peer backend under test (TEST ONLY). `HAXLITE_TEST_PEER_BACKEND=rtc` — set
 * by the `rtc` vitest project (vitest.config.ts) — runs the same host/API/
 * transport suites against haxlite-rtc (`peerBackend: 'rtc'`) on 127.0.0.1
 * instead of node-datachannel. The clients stay libdatachannel-based
 * (node-haxball, test/net/raw-client.ts): an independent WebRTC stack on the
 * other side.
 */
import type { HostTransportOptions } from '../src/net/index.js';

export const TEST_PEER_BACKEND: 'ndc' | 'rtc' = process.env.HAXLITE_TEST_PEER_BACKEND === 'rtc' ? 'rtc' : 'ndc';
export const RTC_UNDER_TEST = TEST_PEER_BACKEND === 'rtc';

/**
 * `HAXLITE_TEST_RTC_BATCH_FRAMES=1|2` runs the `rtc` suites with frame
 * batching on (`sendBatchFrames`); unset / 0: off (the default).
 */
const BATCH = Number(process.env.HAXLITE_TEST_RTC_BATCH_FRAMES ?? 0);
export const RTC_BATCH_FRAMES: 0 | 1 | 2 = BATCH === 1 || BATCH === 2 ? BATCH : 0;

/** Loopback haxlite-rtc settings: bind and announce 127.0.0.1 only. */
export const LOOPBACK_RTC: { address: string; publicAddresses: string[]; sendBatchFrames?: 0 | 1 | 2 } = {
  address: '127.0.0.1',
  publicAddresses: ['127.0.0.1'],
  ...(RTC_BATCH_FRAMES > 0 ? { sendBatchFrames: RTC_BATCH_FRAMES } : null),
};

/** HostTransport options selecting the backend under test ('ndc' explicitly: the library default is 'rtc'). */
export function testTransportBackend(): Partial<HostTransportOptions> {
  return RTC_UNDER_TEST ? { peerBackend: 'rtc', rtcEndpoint: { ...LOOPBACK_RTC } } : { peerBackend: 'ndc' };
}

/** HBInit `haxlite` options selecting the backend under test. */
export function testHaxliteBackend(): { peerBackend: 'ndc' | 'rtc'; rtc?: typeof LOOPBACK_RTC } {
  return RTC_UNDER_TEST ? { peerBackend: 'rtc', rtc: { ...LOOPBACK_RTC } } : { peerBackend: 'ndc' };
}
