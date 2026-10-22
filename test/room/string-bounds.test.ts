/**
 * SendChat / SetAvatar reject an over-long string from its byte length,
 * before decoding it (a code unit takes at most 6 bytes); every string the
 * official client can send (<= 140 / <= 8 units, up to 3 bytes per unit)
 * still decodes.
 */
import { describe, expect, it } from 'vitest';
import { CodecError, Reader, Writer } from '../../src/codec/index.js';
import { SendChatEvent, SetAvatarEvent } from '../../src/room/index.js';

function stringPayload(byteLength: number, nullable: boolean): Reader {
  const w = new Writer(byteLength + 8);
  w.varUint(nullable ? byteLength + 1 : byteLength);
  for (let i = 0; i < byteLength; i++) w.u8(0x61);
  return new Reader(w.copyBytes());
}

describe('chat / avatar string bounds', () => {
  it('SendChat: a 256 KiB string is rejected without being decoded', () => {
    const r = stringPayload(256 << 10, false);
    expect(() => new SendChatEvent().read(r)).toThrow(new CodecError('message too long'));
    expect(r.pos).toBe(3);
  });

  it('SetAvatar: a 64 KiB string is rejected without being decoded', () => {
    const r = stringPayload(64 << 10, true);
    expect(() => new SetAvatarEvent().read(r)).toThrow(new CodecError('avatar too long'));
    expect(r.pos).toBe(3);
  });

  it('the longest official strings still decode; 141 / 9 units still fail', () => {
    const chat = '\u{1F600}'.repeat(70); // 140 units, 6 bytes per pair
    const w = new Writer(1024);
    SendChatEvent.create(chat).write(w);
    const ev = new SendChatEvent();
    ev.read(new Reader(w.copyBytes()));
    expect(ev.message).toBe(chat);
    expect(() => new SendChatEvent().read(stringPayload(141, false))).toThrow(new CodecError('message too long'));
    expect(() => new SendChatEvent().read(stringPayload(840, false))).toThrow(new CodecError('message too long'));

    for (const avatar of [null, '', 'ab', '\u{1F600}\u{1F600}\u{1F600}\u{1F600}']) {
      const aw = new Writer(64);
      aw.nullableString(avatar);
      const a = new SetAvatarEvent();
      a.read(new Reader(aw.copyBytes()));
      expect(a.avatar).toBe(avatar === null ? null : avatar.substr(0, 2));
    }
    expect(() => new SetAvatarEvent().read(stringPayload(9, true))).toThrow(new CodecError('avatar too long'));
    expect(() => new SetAvatarEvent().read(stringPayload(48, true))).toThrow(new CodecError('avatar too long'));
  });
});
