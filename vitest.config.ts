import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // The node-haxball oracle is CommonJS and has global state; keep files isolated.
    pool: 'forks',
    testTimeout: 60_000,
  },
});
