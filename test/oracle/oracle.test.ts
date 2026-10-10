/**
 * Smoke tests proving the node-haxball oracle works and documenting its use.
 */
import { describe, expect, it } from 'vitest';
import { Reader, xorInt32Words } from '../../src/codec/index.js';
import { EventType, Input } from '../../src/protocol.js';
import {
  DEFAULT_STADIUM_NAMES,
  OracleRoom,
  decodeEvent,
  encodeEvent,
  hbsToStadiumBytes,
  parseStadiumBytes,
  prng,
  stadiumToBytes,
} from './index.js';

describe('oracle: room simulation', () => {
  it('runs 600 frames of random inputs on Classic, deterministically', () => {
    const run = () => {
      const room = OracleRoom.create({
        stadium: 'Classic',
        players: [
          { id: 1, name: 'r1', team: 1 },
          { id: 2, name: 'b1', team: 2 },
          { id: 3, name: 'r2', team: 1 },
          { id: 4, name: 'b2', team: 2 },
        ],
        start: true,
      });
      const rnd = prng(1234);
      for (let f = 0; f < 600; f++) {
        if (f % 7 === 0) {
          // Random inputs biased towards chasing the ball, so goals/kicks happen.
          const discs = room.discs();
          const ball = discs[0]!;
          for (let id = 1; id <= 4; id++) {
            const me = discs[4 + id]!;
            let mask = (rnd() * 32) | 0;
            if (rnd() < 0.7) {
              mask &= Input.Kick;
              mask |= ball.x > me.x ? Input.Right : Input.Left;
              mask |= ball.y > me.y ? Input.Down : Input.Up;
            }
            room.input(id, mask);
          }
        }
        room.step();
      }
      return room;
    };
    const a = run();
    const b = run();
    const bytes = a.stateBytes();
    const hash = a.hash();
    console.log(`[oracle] Classic 600f random: ${bytes.length} bytes, checksum ${a.checksum()}, sha256 ${hash}`);
    console.log('[oracle] ball', a.discs()[0]);
    expect(a.frame).toBe(600);
    expect(hash).toBe(b.hash());
    // The oracle's own checksum equals the XOR of the serialized words (our codec helper).
    expect(xorInt32Words(bytes)).toBe(a.checksum());
    const dump = a.dump();
    expect(dump.game).not.toBeNull();
    expect(dump.players.map((p) => p.discIndex)).toEqual([5, 6, 7, 8]); // Classic: ball + 4 posts first
    expect(dump.game!.discs).toHaveLength(9);
    expect(dump.game!.timeElapsed).toBeGreaterThan(0); // someone touched the ball => Playing phase
  });

  it('applies scripted inputs at exact frames and kicks the ball', () => {
    const room = OracleRoom.create({ players: [{ id: 1, name: 'r', team: 1 }], start: true });
    // Red spawns at (-277.5, 0); ball at origin. Run right, press kick (rising edge) later.
    room.runTimeline(
      [
        { frame: 0, playerId: 1, input: Input.Right },
        { frame: 105, playerId: 1, input: Input.Right | Input.Kick },
      ],
      200,
    );
    const d = room.dump();
    expect(d.frame).toBe(200);
    expect(d.game!.phase).toBe(1); // ball moved => Playing
    expect(d.game!.discs[0]!.x).toBeGreaterThan(50);
  });

  it('serialized fresh state matches the official default RoomState layout', () => {
    const room = OracleRoom.empty();
    const r = new Reader(room.stateBytes());
    expect(r.nullableString()).toBe(''); // name
    expect(r.u8()).toBe(0); // teamsLocked
    expect(r.i32()).toBe(3); // scoreLimit
    expect(r.i32()).toBe(3); // timeLimit
    expect(r.i16()).toBe(1); // kickRate max
    expect(r.u8()).toBe(0); // kickRate rate
    expect(r.u8()).toBe(2); // kickRate min
    expect(r.u8()).toBe(0); // stadium: default #0 Classic
    expect(r.u8()).toBe(0); // no game
    expect(r.u8()).toBe(0); // 0 players
    expect([r.u8(), r.i32(), r.u8(), r.i32()]).toEqual([0, 0xffffff, 1, 0xe56e56]); // red colors
    expect([r.u8(), r.i32(), r.u8(), r.i32()]).toEqual([0, 0xffffff, 1, 0x5689e5]); // blue colors
    expect(r.remaining).toBe(0);
  });

  it('round-trips a mid-game state through bytes and keeps simulating identically', () => {
    const room = OracleRoom.create({
      players: [
        { id: 1, name: 'a', team: 1 },
        { id: 2, name: 'b', team: 2 },
      ],
      start: true,
    });
    room.input(1, Input.Right | Input.Down).input(2, Input.Left).step(120);
    const copy = OracleRoom.fromStateBytes(room.stateBytes());
    expect(copy.stateBytes()).toEqual(room.stateBytes());
    room.step(300);
    copy.step(300);
    expect(copy.hash()).toBe(room.hash());
  });

  it('keeps -0 (first spawn y = 55 * -0), which is visible in the serialized bytes', () => {
    const room = OracleRoom.create({ players: [{ id: 1, name: 'a', team: 1 }], start: true });
    const me = room.discs()[room.dump().players[0]!.discIndex]!;
    expect(me.x).toBe(-277.5);
    expect(Object.is(me.y, -0)).toBe(true);
    expect(Buffer.from(room.stateBytes()).toString('hex')).toContain('c071580000000000' + '8000000000000000');
  });

  it('supports admin events, chat, pause and setDiscProperties', () => {
    const room = OracleRoom.create({ players: [{ id: 1, name: 'a', team: 1 }], start: true });
    room.chat(1, 'hola 😀').setDiscProperties(0, { x: 10.1, yspeed: 1, color: 0xff0000 });
    const ball = room.discs()[0]!;
    expect(ball.x).toBe(Math.fround(10.1)); // official float32 quantisation
    expect(ball.color).toBe(0xff0000);
    room.pause(true).step(10);
    expect(room.dump().game!.pauseGameTickCounter).toBe(120);
    room.stopGame();
    expect(room.dump().game).toBeNull();
  });
});

describe('oracle: stadiums', () => {
  it('knows the 10 built-in stadiums', () => {
    expect(DEFAULT_STADIUM_NAMES).toEqual([
      'Classic', 'Easy', 'Small', 'Big', 'Rounded', 'Hockey', 'Big Hockey', 'Big Easy', 'Big Rounded', 'Huge',
    ]);
    expect(stadiumToBytes('Big')).toEqual(Uint8Array.of(3));
  });

  it('serializes built-ins in custom form and parses them back', () => {
    for (let i = 0; i < 10; i++) {
      const bytes = stadiumToBytes(i, { forceCustom: true });
      expect(bytes[0]).toBe(255);
      const parsed = parseStadiumBytes(bytes);
      expect(parsed.bytes).toEqual(bytes);
      expect(parsed.name).toBe(DEFAULT_STADIUM_NAMES[i]);
      // .hbs export -> parse -> same binary (except the exporter uses ballPhysics "disc0")
      expect(hbsToStadiumBytes(parsed.hbs)[0]).toBe(255);
    }
  });
});

describe('oracle: events', () => {
  it('encodes and decodes official event bytes', () => {
    const chat = encodeEvent('sendChat', 'hé😀');
    // type 4, varuint len 10, "h", "é"(2), surrogates as 2x3 bytes (CESU-8 style)
    expect(Buffer.from(chat).toString('hex')).toBe('040968c3a9eda0bdedb880');
    const dec = decodeEvent(chat);
    expect(dec.type).toBe(EventType.SendChat);
    expect(dec.length).toBe(chat.length);
    expect(Object.values(dec.fields)).toContain('hé😀');

    expect(Buffer.from(encodeEvent('sendInput', 31)).toString('hex')).toBe('030000001f');
    expect(Buffer.from(encodeEvent('setPlayerTeam', 7, 2)).toString('hex')).toBe('0c0000000702');
    const sdp = encodeEvent('setDiscProperties', 0, { x: 1.5, cMask: 63 });
    expect(Buffer.from(sdp).toString('hex')).toBe('1700000000000801' + '3fc00000' + '0000003f');
  });

  it('applies event bytes produced elsewhere (e.g. by our encoder) to the oracle room', () => {
    const room = OracleRoom.create({ players: [{ id: 1, name: 'a', team: 0 }] });
    room.applyEventBytes(encodeEvent('setPlayerTeam', 1, 2), 0);
    expect(room.dump().players[0]!.team).toBe(2);
  });
});
