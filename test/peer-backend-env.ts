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

/** Loopback haxlite-rtc settings: bind and announce 127.0.0.1 only. */
export const LOOPBACK_RTC = { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] };

/** HostTransport options selecting the backend under test. */
export function testTransportBackend(): Partial<HostTransportOptions> {
  return RTC_UNDER_TEST ? { peerBackend: 'rtc', rtcEndpoint: { ...LOOPBACK_RTC } } : {};
}

/** HBInit `haxlite` options selecting the backend under test. */
export function testHaxliteBackend(): { peerBackend?: 'rtc'; rtc?: typeof LOOPBACK_RTC } {
  return RTC_UNDER_TEST ? { peerBackend: 'rtc', rtc: { ...LOOPBACK_RTC } } : {};
}
