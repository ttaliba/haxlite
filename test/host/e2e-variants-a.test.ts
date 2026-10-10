/** Netcode knobs with real node-haxball clients (see variant.ts). */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { E2E, shutdownAll, type Any } from './harness.js';
import { runVariant } from './variant.js';

let shared: { master: Any; nh: Any };
beforeAll(async () => {
  shared = await E2E.shared();
});
afterAll(async () => {
  await shared?.master.close();
  await shutdownAll();
});

describe('HostRoom netcode knobs', () => {
  for (const [sb, hb] of [[1, 2], [2, 2]] as const) {
    it(`inputDelayFrames=${sb}, heartbeatFrames=${hb}: clients converge, no desync`, async () => {
      await runVariant(shared, { inputDelayFrames: sb, heartbeatFrames: hb });
    }, 120_000);
  }
});
