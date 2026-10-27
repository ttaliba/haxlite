/**
 * setDefaultStadium by name without building the ten built-in stadiums:
 * the name table matches `defaultStadiums()` and the applied stadium is the
 * shared instance; unknown names throw like official.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STADIUM_NAMES, HostRoom, createHostRoomState, defaultStadiumByName } from '../../src/host/index.js';
import { Disc, buildDefaultStadium, defaultStadiums } from '../../src/sim/index.js';
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

  it('a modified built-in stadium is refused (clients would load the original and desync)', () => {
    const transport = { connectionCount: 0, getRoomInfo: () => ({ players: 0 }), setRoomInfo() {} } as unknown as HostTransport;
    const host = new HostRoom({ transport, state: createHostRoomState({ noPlayer: true }), now: () => 0 });
    host.onError = (e) => {
      throw e;
    };
    host.setStadium(buildDefaultStadium(3)); // an unmodified copy is fine
    expect(host.state.stadium!.name).toBe('Big');
    const s = buildDefaultStadium(0);
    s.discs.push(new Disc());
    expect(() => host.setStadium(s)).toThrow('says it is built-in stadium 0 but differs from it');
    s.defaultStadiumId = 255; // sent whole: every client gets the extra disc
    host.setStadium(s);
    expect(host.state.stadium!.discs.length).toBe(defaultStadiums()[0]!.discs.length + 1);
  });
});
