/**
 * The state behind room.haxlite.hidePlayerFor (docs/04 §7.4, "Jugadores
 * ocultos"): a player disc at position NaN with cGroup 0.
 *  - the CheckConsistency hash covers the f64 position bits (a NaN with
 *    another sign/payload gives another hash, so they must match the client's);
 *  - the NaN that the wire produces (float32 0x7fc00000) is the canonical
 *    0x7ff8000000000000 and stays so after any number of ticks (only
 *    `x + finite` touches it);
 *  - nothing else in the world is affected: the other discs evolve exactly
 *    as in a world without that player's collisions.
 */
import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/codec/index.js';
import { TeamId } from '../../src/protocol.js';
import {
  JoinRoomEvent,
  SendInputEvent,
  SetDiscPropertiesEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
  createRoomState,
  getPlayer,
  roomStateChecksum,
  stepRoom,
  type RoomState,
} from '../../src/room/index.js';

const bits = (x: number) => {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16);
};

function room(): RoomState {
  const rs = createRoomState();
  for (const id of [1, 2, 3]) {
    const j = JoinRoomEvent.create(id, `p${id}`, null, null);
    j.apply(rs);
    const t = SetPlayerTeamEvent.create(id, id === 2 ? TeamId.Blue : TeamId.Red);
    t.apply(rs);
  }
  new StartGameEvent().apply(rs);
  return rs;
}

function input(rs: RoomState, id: number, v: number): void {
  const e = SendInputEvent.create(v);
  e.byId = id;
  e.apply(rs);
}

/** The hide event exactly as the client decodes it (float32 on the wire). */
function hideOnWire(rs: RoomState, id: number): void {
  const w = new Writer(64);
  SetDiscPropertiesEvent.create(id, true, { x: NaN, y: NaN, cGroup: 0 }).write(w);
  const ev = new SetDiscPropertiesEvent();
  ev.read(new Reader(w.finish()));
  ev.apply(rs);
}

describe('hidden player disc (NaN position, cGroup 0)', () => {
  it('the checksum covers the NaN bits; the wire NaN is canonical and stays canonical', () => {
    const rs = room();
    hideOnWire(rs, 3);
    const d = getPlayer(rs, 3)!.disc!;
    expect(bits(d.x)).toBe('7ff8000000000000');
    for (let t = 0; t < 5000; t++) {
      input(rs, 3, [8, 8 | 16, 1, 2 | 16, 4][t % 5]!); // moving and kicking
      input(rs, 1, [4, 2, 8, 1][t % 4]!);
      stepRoom(rs);
    }
    expect(bits(d.x)).toBe('7ff8000000000000');
    expect(bits(d.y)).toBe('7ff8000000000000');
    expect(Number.isFinite(d.xspeed) && Number.isFinite(d.yspeed)).toBe(true);
    const h = roomStateChecksum(rs);
    // same state, a NaN with the sign bit set (what x86 makes for 0*Infinity or -NaN): another hash
    const f = new Float64Array(1);
    const u = new Uint32Array(f.buffer);
    f[0] = NaN;
    u[1] = 0xfff80000;
    d.x = f[0];
    expect(Number.isNaN(d.x)).toBe(true);
    expect(roomStateChecksum(rs)).not.toBe(h);
  });

  it('the hidden disc touches nothing: the others move as if it were not there', () => {
    // A: player 3 hidden; B: player 3 parked far away with cGroup 0 (no collisions at all)
    const a = room();
    const b = room();
    hideOnWire(a, 3);
    SetDiscPropertiesEvent.create(3, true, { x: 5000, y: 5000, cGroup: 0 }).apply(b);
    for (const rs of [a, b]) {
      // everyone on top of the ball / each other
      for (const id of [1, 2]) SetDiscPropertiesEvent.create(id, true, { x: id * 5, y: 0 }).apply(rs);
      SetDiscPropertiesEvent.create(0, false, { x: 0, y: 3 }).apply(rs);
    }
    for (let t = 0; t < 2000; t++) {
      for (const rs of [a, b]) {
        input(rs, 1, [8 | 16, 2, 4 | 16, 1][t % 4]!);
        input(rs, 2, [4, 1 | 16, 8, 2][t % 4]!);
        stepRoom(rs);
      }
    }
    const view = (rs: RoomState) => rs.gameState!.world.discs.filter((d) => d !== getPlayer(rs, 3)!.disc).map((d) => [d.x, d.y, d.xspeed, d.yspeed]);
    expect(view(a)).toEqual(view(b));
  });
});
