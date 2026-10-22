/**
 * RtcEndpoint.listen refuses numeric options that would silently disable a
 * limit or a timer (NaN, 0, Infinity, out-of-range ports) before binding.
 */
import { describe, expect, it } from 'vitest';
import { RtcEndpoint, type RtcEndpointOptions } from '../../src/rtc/index.js';

const base: RtcEndpointOptions = { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] };

describe('RtcEndpoint option validation', () => {
  it('rejects unusable numbers with a RangeError', async () => {
    const bad: Partial<RtcEndpointOptions>[] = [
      { port: -1 },
      { port: 65536 },
      { port: 1.5 },
      { publicPort: 0 },
      { publicPort: Number.NaN },
      { maxSessions: Number.NaN },
      { maxSessions: 0 },
      { maxSessions: Infinity },
      { maxTurnAllocations: Number.NaN },
      { maxTurnAllocations: 0 },
      { maxTurnAllocations: Infinity },
      { turnPeersPerAllocation: Number.NaN },
      { turnPeersPerAllocation: 0 },
      { idleTimeoutMs: Number.NaN },
      { idleTimeoutMs: 0 },
      { idleTimeoutMs: Infinity },
      { handshakeTimeoutMs: Number.NaN },
      { handshakeTimeoutMs: -5 },
      { gatherRefreshMs: Number.NaN },
      { gatherRefreshMs: -1 },
    ];
    for (const o of bad) await expect(RtcEndpoint.listen({ ...base, ...o }), JSON.stringify(o)).rejects.toThrow(RangeError);
  });

  it('accepts the defaults and valid edge values', async () => {
    const ok: Partial<RtcEndpointOptions>[] = [
      {},
      { port: 0, maxSessions: 1, idleTimeoutMs: 1500, handshakeTimeoutMs: 1, gatherRefreshMs: 0 },
      { publicPort: 65535, maxTurnAllocations: 1, turnPeersPerAllocation: Infinity, gatherRefreshMs: Infinity },
    ];
    for (const o of ok) {
      const ep = await RtcEndpoint.listen({ ...base, ...o });
      ep.close();
    }
  });
});
