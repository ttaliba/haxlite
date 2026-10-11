import { defineConfig } from 'vitest/config';

// Real-browser interop suite (Chromium via playwright-core): `npm run test:interop`.
// Kept out of `npm test` (slow: ~minutes, 40 s idle tests, launches browsers).
export default defineConfig({
  test: {
    root: new URL('../..', import.meta.url).pathname,
    include: ['test/rtc-interop/**/*.interop.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
