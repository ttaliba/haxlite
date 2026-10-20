/**
 * HostRoom.onError coalesces runs of identical errors (a script that throws
 * on every tick): the first `errorRepeatBurst` are delivered, then one
 * RepeatedError per window counts the rest; distinct errors and the first of
 * each are delivered as they come. Also: setMaxPlayers refuses NaN.
 */
import { describe, expect, it } from 'vitest';
import { HostRoom, createHostRoomState, type HostRoomOptions } from '../../src/host/index.js';
import { RepeatedError } from '../../src/host/host-room.js';
import type { HostTransport } from '../../src/net/index.js';

function setup(opts: Partial<HostRoomOptions> = {}) {
  let t = 0;
  const maxPlayers: number[] = [];
  const transport = {
    connectionCount: 0,
    getRoomInfo: () => ({ players: 0, maxPlayers: 12 }),
    setRoomInfo() {},
    setMaxPlayers: (n: number) => void maxPlayers.push(n),
    start() {},
    stop() {},
  } as unknown as HostTransport;
  const host = new HostRoom({ transport, state: createHostRoomState({ noPlayer: true }), now: () => t, ...opts });
  const errors: unknown[] = [];
  host.onError = (e) => void errors.push(e);
  let message = 'boom';
  host.state.hooks.onTeamsLockChange = () => {
    throw new Error(message);
  };
  let locked = false;
  const fire = (n: number, msg = 'boom'): void => {
    message = msg;
    for (let i = 0; i < n; i++) host.setTeamsLock((locked = !locked));
  };
  return { host, errors, fire, maxPlayers, advance: (ms: number) => void (t += ms) };
}

const texts = (errors: unknown[]): string[] => errors.map((e) => (e as Error).message);

describe('HostRoom error coalescing', () => {
  it('a per-tick flood: burst delivered, then one summary per window; the run ends after a quiet window', () => {
    const { errors, fire, advance } = setup({ errorRepeatBurst: 3, errorRepeatWindowMs: 1000 });
    fire(10);
    expect(texts(errors)).toEqual(['boom', 'boom', 'boom']);
    advance(1000);
    fire(5); // the window ended: summary of the 7 held back, then the run stays coalesced
    expect(errors).toHaveLength(4);
    const sum = errors[3] as RepeatedError;
    expect(sum).toBeInstanceOf(RepeatedError);
    expect(sum.count).toBe(7);
    expect(sum.message).toBe('Error: boom (repeated 7 more times in 1000 ms)');
    expect((sum.cause as Error).message).toBe('boom');
    advance(1000);
    fire(0);
    advance(0);
    // a top-level action settles: the summary of the 5 comes without a new error
    fire(1, 'other');
    expect(texts(errors).slice(4)).toEqual(['Error: boom (repeated 5 more times in 1000 ms)', 'other']);
    advance(2000);
    fire(1, 'other');
    fire(1); // the boom run ended after its quiet window: delivered again
    expect(texts(errors).slice(6)).toEqual(['other', 'boom']);
  });

  it('distinct errors are never held back; Infinity delivers every one; stop() flushes', () => {
    const a = setup({ errorRepeatBurst: 2 });
    for (let i = 0; i < 20; i++) a.fire(1, `e${i}`);
    expect(texts(a.errors)).toEqual(Array.from({ length: 20 }, (_, i) => `e${i}`));
    a.fire(5, 'same');
    expect(a.errors).toHaveLength(22);
    a.host.start();
    a.host.stop();
    expect(texts(a.errors)[22]).toBe('Error: same (repeated 3 more times in 1000 ms)');

    const b = setup({ errorRepeatBurst: Infinity });
    b.fire(500);
    expect(b.errors).toHaveLength(500);
  });

  it('default: 60 identical errors pass before coalescing', () => {
    const { errors, fire } = setup();
    fire(100);
    expect(errors).toHaveLength(60);
    expect(() => setup({ errorRepeatBurst: 0 })).toThrow(RangeError);
    expect(() => setup({ errorRepeatWindowMs: NaN })).toThrow(RangeError);
  });

  it('setMaxPlayers: NaN, fractions and out-of-range values throw; integers pass', () => {
    const { host, maxPlayers } = setup();
    for (const bad of [NaN, 2.5, -1, 256, Infinity, '12' as unknown as number]) expect(() => host.setMaxPlayers(bad)).toThrow(RangeError);
    host.setMaxPlayers(0);
    host.setMaxPlayers(30);
    host.setMaxPlayers(255);
    expect(maxPlayers).toEqual([0, 30, 255]);
  });
});
