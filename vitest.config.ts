import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *  - `ndc`: every test (players on node-datachannel, the default backend);
 *  - `rtc`: the host/API/transport end-to-end suites again with
 *    `peerBackend: 'rtc'` (haxlite-rtc), selected by HAXLITE_TEST_PEER_BACKEND
 *    (test/peer-backend-env.ts). The clients are libdatachannel-based
 *    (node-haxball, test/net/raw-client.ts): an independent WebRTC
 *    implementation against ours.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // The node-haxball oracle is CommonJS and has global state; keep files isolated.
    pool: 'forks',
    testTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: { name: 'ndc', include: ['test/**/*.test.ts', 'src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'rtc',
          include: [
            'test/host/e2e*.test.ts',
            'test/api/hbinit.test.ts',
            'test/api/extensions.test.ts',
            'test/api/multi-room.test.ts',
            'test/api/parity.test.ts',
            'test/api/private-view.test.ts',
            'test/api/shutdown.test.ts',
            'test/net/transport.test.ts',
            'test/net/transport-e2e.test.ts',
          ],
          env: { HAXLITE_TEST_PEER_BACKEND: 'rtc' },
        },
      },
    ],
  },
});
