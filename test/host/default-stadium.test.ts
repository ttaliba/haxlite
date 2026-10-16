/**
 * setDefaultStadium by name without building the ten built-in stadiums:
 * the name table matches `defaultStadiums()` and the applied stadium is the
 * shared instance; unknown names throw like official.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STADIUM_NAMES, HostRoom, createHostRoomState, defaultStadiumByName } from '../../src/host/index.js';
import { defaultStadiums } from '../../src/sim/index.js';
import type { HostTransport } from '../../src/net/index.js';

describe('default stadiums by name', () => {
  it('name table = defaultStadiums() order; setDefaultStadium applies the shared instance', () => {
    expect(defaultStadiumByName('Huge')?.name).toBe('Huge');
    expect(defaultStadiumByName('nope')).toBeNull();
    const all = defaultStadiums();
    expect(all.map((s) => s.name as string)).toEqual(DEFAULT_STADIUM_NAMES);
    for (let i = 0; i < all.length; i++) expect(defaultStadiumByName(all[i]!.name as string)).toBe(all[i]);

    const transport = { connectionCount: 0, getRoomInfo: () => ({ players: 0 }), setRoomInfo() {} } as unknown as HostTransport;
    const host = new HostRoom({ transport, state: createHostRoomState({ noPlayer: true }), now: () => 0 });
    host.onError = (e) => {
      throw e;
    };
    host.setDefaultStadium('Big Hockey');
    expect(host.state.stadium).toBe(all[6]);
    expect(() => host.setDefaultStadium('classic')).toThrow("Stadium doesn't exist");
  });
});
