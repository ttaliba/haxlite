/**
 * The start-up `haxlite.onRecaptcha` handler (offline: FakeMaster asks for a
 * captcha on token 'expired'): a rejection that arrives after the room is up
 * goes to onError instead of vanishing, and a handler that throws or rejects
 * with null/undefined fails the init instead of passing for success.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HBInit } from '../../src/api/index.js';
import { shutdownAll, startEnv, waitFor, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

const config = (onRecaptcha: (sitekey: string, use: (response: string) => void) => unknown) => ({
  token: 'expired',
  haxlite: { masterUrl: env.master.httpBase, iceServers: [], shutdownWebRtcOnLastStop: false, onRecaptcha: onRecaptcha as never },
});

describe('start-up onRecaptcha', () => {
  it('a rejection after the room is up goes to onError', async () => {
    let fail!: (err: unknown) => void;
    const late = new Promise<void>((_, reject) => (fail = reject));
    const room = await HBInit(
      config(async (_key, use) => {
        use('captcha-response');
        await late; // e.g. logging the solve somewhere after the link arrived
      }),
    );
    try {
      const errors: unknown[] = [];
      room.haxlite.onError = (e) => void errors.push(e);
      expect(room.haxlite.roomLink).not.toBeNull();
      const err = new Error('log failed');
      fail(err);
      await waitFor(() => errors.length > 0, 2000, 'late rejection reported');
      expect(errors).toEqual([err]);
      // (and the recording state HBInit exposes)
      expect(room.haxlite.recordingTruncated).toBe(false);
    } finally {
      await room.haxlite.stop();
    }
  });

  it('throwing or rejecting with null / undefined fails the init', async () => {
    await expect(
      HBInit(
        config(() => {
          throw null;
        }),
      ),
    ).rejects.toThrow(/onRecaptcha failed: null/);
    await expect(HBInit(config(() => Promise.reject(undefined)))).rejects.toThrow(/onRecaptcha failed: undefined/);
    const err = new Error('solver down');
    await expect(HBInit(config(() => Promise.reject(err)))).rejects.toBe(err);
  });
});
