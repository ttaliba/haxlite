/**
 * A stadium that can't travel in a SetStadium event (deflated body over the
 * u16 length, or a custom stadium with a list over 255 items) is refused
 * before the host applies it: the host state, the clients and a recording
 * in progress all stay on the previous stadium. HostRoom.setStadium /
 * setCustomStadium throw synchronously (like an invalid .hbs); a raw
 * emit() reports through onError.
 */
import { describe, expect, it } from 'vitest';
import { HostRoom, createHostRoomState } from '../../src/host/index.js';
import type { HostTransport } from '../../src/net/index.js';
import { EventType } from '../../src/protocol.js';
import { SetStadiumEvent, type RoomEvent } from '../../src/room/index.js';
import { ReplayPlayer } from '../../src/replay/index.js';
import { parseHbs } from '../../src/sim/index.js';

/** Deterministic, nearly incompressible base64 text. */
function noise(n: number, seed = 1): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = seed >>> 0;
  let s = '';
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    s += abc[(x >>> 0) & 63];
  }
  return s;
}

const hbs = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'small', width: 10, height: 10, bg: {}, discs: [{}, {}], ...extra });
const BIG_NAME = hbs({ name: noise(107_000) });
const JOINTS_256 = hbs({ joints: Array.from({ length: 256 }, () => ({ d0: 0, d1: 1 })) });
const JOINTS_255 = hbs({ joints: Array.from({ length: 255 }, () => ({ d0: 0, d1: 1 })) });

function setup() {
  const sent: Uint8Array[] = [];
  const transport = {
    connectionCount: 1,
    getRoomInfo: () => ({ players: 0, maxPlayers: 12 }),
    setRoomInfo() {},
    broadcastTo: (_list: unknown, _channel: unknown, data: Uint8Array) => void sent.push(data.slice()),
    send() {},
  } as unknown as HostTransport;
  const host = new HostRoom({ transport, state: createHostRoomState({ noPlayer: true }), now: () => 0 });
  const errors: unknown[] = [];
  host.onError = (e) => void errors.push(e);
  const applied: RoomEvent[] = [];
  host.onEventApplied = (ev) => void applied.push(ev);
  return { host, sent, errors, applied };
}

describe('SetStadium wire limit', () => {
  it('setCustomStadium: 107 KB name and 256 joints throw, nothing applied, sent or recorded', () => {
    const { host, sent, errors, applied } = setup();
    host.startRecording();
    const before = host.state.stadium;
    const sentBefore = sent.length;
    expect(() => host.setCustomStadium(BIG_NAME)).toThrow(/Stadium too large: deflated \d+ > 65535/);
    expect(() => host.setCustomStadium(JOINTS_256)).toThrow('Stadium has a list over 255 items');
    expect(() => host.setStadium(parseHbs(JOINTS_256))).toThrow('Stadium has a list over 255 items');
    expect(host.state.stadium).toBe(before);
    expect(sent.length).toBe(sentBefore);
    expect(applied.some((e) => e.type === EventType.SetStadium)).toBe(false);
    expect(errors).toEqual([]);

    // a legal stadium afterwards goes through, and the recording reads back
    host.setCustomStadium(JOINTS_255);
    expect(host.state.stadium?.joints.length).toBe(255);
    expect(sent.length).toBe(sentBefore + 1);
    const bytes = host.stopRecording()!;
    const player = new ReplayPlayer(bytes);
    expect(player.rs.stadium?.name).toBe(before?.name);
    expect(player.finish().stadium?.joints.length).toBe(255);
    expect(errors).toEqual([]);
  });

  it('emit(SetStadiumEvent) of an oversized stadium: reported through onError, not applied', () => {
    const { host, sent, errors, applied } = setup();
    host.startRecording();
    const before = host.state.stadium;
    const sentBefore = sent.length;
    host.emit(SetStadiumEvent.create(parseHbs(BIG_NAME)));
    expect(host.state.stadium).toBe(before);
    expect(sent.length).toBe(sentBefore);
    expect(applied.length).toBe(0);
    expect(errors.map((e) => (e as Error).message)).toEqual([expect.stringMatching(/^Stadium too large: deflated \d+ > 65535$/)]);
    const player = new ReplayPlayer(host.stopRecording()!);
    expect(player.data.events.length).toBe(0);
    expect(player.finish().stadium?.name).toBe(before?.name);
  });
});
