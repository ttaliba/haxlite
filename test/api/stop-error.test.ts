/**
 * `finishInit` stops the room with `void stop()`: a rejection there (e.g.
 * node-datachannel cleanup failing) must reach the room's error reporter
 * (`room.haxlite.onError`, else console.error) instead of becoming an
 * unhandled rejection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';

const boom = new Error('shutdownWebRtc failed');
vi.mock('../../src/net/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/net/index.js')>();
  return { ...mod, shutdownWebRtc: vi.fn(async () => Promise.reject(boom)) };
});

const { HBInit, InvalidRoomTokenError } = await import('../../src/api/index.js');

let master: FakeMaster;
beforeAll(async () => {
  master = await FakeMaster.start();
});
afterAll(async () => {
  await master.close();
});

describe('HBInit init failure', () => {
  it('a rejection from the internal stop() is reported, not left unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push(a));
    try {
      await expect(HBInit({ token: 'invalid', haxlite: { masterUrl: master.httpBase, iceServers: [] } })).rejects.toBeInstanceOf(
        InvalidRoomTokenError,
      );
      await vi.waitFor(() => expect(logged.some((a) => a[0] === '[haxlite]' && a[1] === boom)).toBe(true), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      spy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
