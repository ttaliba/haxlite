/**
 * Event codecs 0..23 vs the oracles:
 *  - our bytes == node-haxball EventFactory bytes (official format) for random instances;
 *  - the OFFICIAL headless reader consumes exactly our bytes and its writer
 *    re-emits identical bytes;
 *  - decoding oracle bytes with our reader and re-encoding is the identity.
 */
import { describe, expect, it } from 'vitest';
import { Reader, inflateRaw } from '../../src/codec/index.js';
import { EventType, TeamId } from '../../src/protocol.js';
import {
  AutoTeamsEvent,
  CheckConsistencyEvent,
  EVENT_CLASSES,
  EVENT_META,
  JoinRoomEvent,
  KickBanPlayerEvent,
  PauseResumeGameEvent,
  PingEvent,
  ReorderPlayersEvent,
  RoomEvent,
  SendAnnouncementEvent,
  SendChatEvent,
  SendChatIndicatorEvent,
  SendInputEvent,
  SetAvatarEvent,
  SetDiscPropertiesEvent,
  SetGamePlayLimitEvent,
  SetHeadlessAvatarEvent,
  SetKickRateLimitEvent,
  SetPlayerAdminEvent,
  SetPlayerSyncEvent,
  SetPlayerTeamEvent,
  SetStadiumEvent,
  SetTeamColorsEvent,
  SetTeamsLockEvent,
  StartGameEvent,
  StopGameEvent,
  TeamColors,
  checkClientSender,
  decodeEvent,
  encodeEvent,
  readEventFrame,
  writeEventFrame,
  createRoomState,
  getPlayer,
} from '../../src/room/index.js';
import { Writer } from '../../src/codec/index.js';
import { defaultStadiums, parseHbs } from '../../src/sim/index.js';
import { encodeEvent as nhEncode, prng, stadiumToBytes } from '../oracle/index.js';
import type { EventFactoryName } from '../oracle/index.js';
import { hex, officialRoundTrip, pick, randInt32, randString, simReady } from './helpers.js';

type Case = { ev: RoomEvent; nh: [EventFactoryName, ...unknown[]] | null };
type Gen = (rnd: () => number) => Case;

const DISC_KEYS = ['x', 'y', 'xspeed', 'yspeed', 'xgravity', 'ygravity', 'radius', 'bCoef', 'invMass', 'damping', 'color', 'cMask', 'cGroup'] as const;

function randFloat(rnd: () => number): number {
  const k = rnd();
  if (k < 0.1) return 0;
  if (k < 0.2) return -0;
  if (k < 0.3) return pick(rnd, [1e-40, 3.4e38, 1e39, -1e39, Infinity, -Infinity, 0.1, 1 / 3]);
  return (rnd() - 0.5) * 2000 * rnd();
}

const GENERATORS: Record<number, Gen> = {
  [EventType.SendAnnouncement]: (rnd) => {
    const msg = rnd() < 0.1 ? 'y'.repeat(1000) : randString(rnd, 200);
    const color = randInt32(rnd);
    const style = Math.floor(rnd() * 6);
    const sound = Math.floor(rnd() * 3);
    return { ev: SendAnnouncementEvent.create(msg, color, style, sound), nh: ['sendAnnouncement', msg, color, style, sound] };
  },
  [EventType.SendChatIndicator]: (rnd) => {
    const v = rnd() < 0.5 ? 0 : 1;
    // node-haxball quirk: sendChatIndicator(active) stores `active ? 0 : 1`.
    return { ev: SendChatIndicatorEvent.create(v), nh: ['sendChatIndicator', v === 0] };
  },
  [EventType.CheckConsistency]: (rnd) => {
    const n = rnd() < 0.7 ? 4 : Math.floor(rnd() * 20);
    const data = new Uint8Array(n).map(() => Math.floor(rnd() * 256));
    const ev = new CheckConsistencyEvent();
    ev.data = data;
    return { ev, nh: ['checkConsistency', data] };
  },
  [EventType.SendInput]: (rnd) => {
    const v = rnd() < 0.8 ? Math.floor(rnd() * 32) : Math.floor(rnd() * 4294967296);
    return { ev: SendInputEvent.create(v), nh: ['sendInput', v] };
  },
  [EventType.SendChat]: (rnd) => {
    const msg = randString(rnd, 140);
    return { ev: SendChatEvent.create(msg), nh: ['sendChat', msg] };
  },
  [EventType.JoinRoom]: (rnd) => {
    const id = Math.floor(rnd() * 70000);
    const name = rnd() < 0.1 ? null : randString(rnd, 25);
    const flag = rnd() < 0.3 ? null : randString(rnd, 3);
    const avatar = rnd() < 0.3 ? null : randString(rnd, 2);
    return { ev: JoinRoomEvent.create(id, name, flag, avatar), nh: ['joinRoom', id, name, flag, avatar, '', ''] };
  },
  [EventType.KickBanPlayer]: (rnd) => {
    const id = Math.floor(rnd() * 1000);
    const reason = rnd() < 0.3 ? null : randString(rnd, 100);
    const ban = rnd() < 0.5;
    return { ev: KickBanPlayerEvent.create(id, reason, ban), nh: ['kickBanPlayer', id, reason, ban] };
  },
  [EventType.StartGame]: () => ({ ev: new StartGameEvent(), nh: ['startGame'] }),
  [EventType.StopGame]: () => ({ ev: new StopGameEvent(), nh: ['stopGame'] }),
  [EventType.PauseResumeGame]: (rnd) => {
    const p = rnd() < 0.5;
    return { ev: PauseResumeGameEvent.create(p), nh: ['pauseResumeGame', p] };
  },
  [EventType.SetGamePlayLimit]: (rnd) => {
    const kind = rnd() < 0.5 ? 0 : 1;
    const v = rnd() < 0.7 ? Math.floor(rnd() * 120) - 10 : randInt32(rnd);
    return { ev: SetGamePlayLimitEvent.create(kind, v), nh: [kind === 0 ? 'setScoreLimit' : 'setTimeLimit', v] };
  },
  [EventType.SetStadium]: (rnd) => {
    const idx = Math.floor(rnd() * 10);
    return { ev: SetStadiumEvent.create(defaultStadiums()[idx]!), nh: ['setStadium', idx] };
  },
  [EventType.SetPlayerTeam]: (rnd) => {
    const id = Math.floor(rnd() * 1000);
    const team = Math.floor(rnd() * 3) as TeamId;
    return { ev: SetPlayerTeamEvent.create(id, team), nh: ['setPlayerTeam', id, team] };
  },
  [EventType.SetTeamsLock]: (rnd) => {
    const v = rnd() < 0.5;
    return { ev: SetTeamsLockEvent.create(v), nh: ['setTeamsLock', v] };
  },
  [EventType.SetPlayerAdmin]: (rnd) => {
    const id = Math.floor(rnd() * 1000);
    const v = rnd() < 0.5;
    return { ev: SetPlayerAdminEvent.create(id, v), nh: ['setPlayerAdmin', id, v] };
  },
  [EventType.AutoTeams]: () => ({ ev: new AutoTeamsEvent(), nh: ['autoTeams'] }),
  [EventType.SetPlayerSync]: (rnd) => {
    const v = rnd() < 0.5;
    return { ev: SetPlayerSyncEvent.create(v), nh: ['setPlayerSync', v] };
  },
  [EventType.Ping]: (rnd) => {
    const n = Math.floor(rnd() * 30);
    const pings: number[] = [];
    for (let i = 0; i < n; i++) pings.push(rnd() < 0.8 ? Math.floor(rnd() * 400) : Math.floor(rnd() * 2147483647));
    return { ev: PingEvent.create(pings), nh: ['ping', pings] };
  },
  [EventType.SetAvatar]: (rnd) => {
    const a = rnd() < 0.2 ? null : randString(rnd, 2);
    return { ev: SetAvatarEvent.create(a), nh: ['setAvatar', a] };
  },
  [EventType.SetTeamColors]: (rnd) => {
    const team = (1 + Math.floor(rnd() * 2)) as TeamId;
    const tc = new TeamColors();
    tc.angle = Math.floor(rnd() * 256);
    tc.textColor = randInt32(rnd);
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) tc.colors.push(randInt32(rnd));
    return { ev: SetTeamColorsEvent.create(team, tc), nh: ['setTeamColors', team, { angle: tc.angle, text: tc.textColor, inner: tc.colors }] };
  },
  [EventType.ReorderPlayers]: (rnd) => {
    const n = Math.floor(rnd() * 50);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(Math.floor(rnd() * 60));
    const top = rnd() < 0.5;
    return { ev: ReorderPlayersEvent.create(ids, top), nh: ['reorderPlayers', ids, top] };
  },
  [EventType.SetKickRateLimit]: (rnd) => {
    const a = randInt32(rnd);
    const b = randInt32(rnd);
    const c = randInt32(rnd);
    return { ev: SetKickRateLimitEvent.create(a, b, c), nh: ['setKickRateLimit', a, b, c] };
  },
  [EventType.SetHeadlessAvatar]: (rnd) => {
    const id = Math.floor(rnd() * 1000);
    // node-haxball's factory does not truncate (official `ha.V` truncates to 2): keep <= 2 here.
    const a = rnd() < 0.2 ? null : randString(rnd, 2);
    return { ev: SetHeadlessAvatarEvent.create(id, a), nh: ['setHeadlessAvatar', id, a] };
  },
  [EventType.SetDiscProperties]: (rnd) => {
    const isPlayer = rnd() < 0.5;
    const id = Math.floor(rnd() * 300);
    const props: Record<string, number> = {};
    for (let i = 0; i < DISC_KEYS.length; i++) {
      if (rnd() < 0.5) continue;
      props[DISC_KEYS[i]!] = i < 10 ? randFloat(rnd) : randInt32(rnd);
    }
    const nhProps: Record<string, number> = { ...props };
    if ('bCoef' in nhProps) {
      nhProps.bCoeff = nhProps.bCoef!;
      delete nhProps.bCoef;
    }
    return {
      ev: SetDiscPropertiesEvent.create(id, isPlayer, props),
      nh: [isPlayer ? 'setPlayerDiscProperties' : 'setDiscProperties', id, nhProps],
    };
  },
};

function checkCase(c: Case): void {
  const ours = encodeEvent(c.ev);
  expect(ours[0]).toBe(c.ev.type);
  // 1. node-haxball (official format) produces the same bytes.
  if (c.nh !== null) {
    const [name, ...args] = c.nh;
    const theirs = nhEncode(name, ...args);
    if (c.ev.type === EventType.SetStadium) {
      // deflate output may legitimately differ (zlib vs pako); compare inflated content.
      expect(hex(inflateRaw(ours.subarray(3)))).toBe(hex(inflateRaw(theirs.subarray(3))));
    } else {
      expect(hex(ours)).toBe(hex(theirs));
    }
    // decode their bytes with our reader -> re-encode identically
    const back = decodeEvent(theirs);
    if (c.ev.type !== EventType.SetStadium) expect(hex(encodeEvent(back))).toBe(hex(theirs));
  }
  // 2. official reader consumes exactly our bytes; official writer re-emits them.
  const off = officialRoundTrip(ours);
  expect(off.consumed).toBe(ours.length);
  if (c.ev.type === EventType.SetStadium) {
    expect(hex(inflateRaw(off.bytes.subarray(3)))).toBe(hex(inflateRaw(ours.subarray(3))));
  } else {
    expect(hex(off.bytes)).toBe(hex(ours));
  }
  // 3. our own round trip.
  const again = decodeEvent(ours);
  expect(again.type).toBe(c.ev.type);
  if (c.ev.type === EventType.SetStadium) {
    expect(hex(inflateRaw(encodeEvent(again).subarray(3)))).toBe(hex(inflateRaw(ours.subarray(3))));
  } else {
    expect(hex(encodeEvent(again))).toBe(hex(ours));
  }
}

describe('event codecs 0..23 vs oracles', () => {
  it('registry: 24 official types, in registration order', () => {
    expect(EVENT_CLASSES.length).toBe(24);
    expect(EVENT_META.length).toBe(24);
    for (let t = 0; t < 24; t++) {
      expect(new EVENT_CLASSES[t]!().type).toBe(t);
      expect(EVENT_META[t]!.type).toBe(t);
    }
  });

  for (let t = 0; t < 24; t++) {
    const needsSim = t === EventType.SetStadium;
    it.skipIf(needsSim && !simReady())(`type ${t} (${EVENT_META[t]!.name}): 300 random instances`, () => {
      const rnd = prng(1000 + t);
      const n = needsSim ? 40 : 300;
      for (let i = 0; i < n; i++) checkCase(GENERATORS[t]!(rnd));
    });
  }

  it.skipIf(!simReady())('SetStadium with custom stadiums (.hbs) matches after inflate', () => {
    const hbs = `{"name":"t","bg":{"type":"hockey"},"width":300,"height":160,"spawnDistance":120,"vertexes":[{"x":-10,"y":0},{"x":10,"y":5}],
      "segments":[{"v0":0,"v1":1,"curve":45,"bias":3,"color":"FF0000"}],"goals":[{"p0":[-5,-5],"p1":[-5,5],"team":"red"}],
      "discs":[{"pos":[1,2],"radius":3}],"planes":[{"normal":[0,1],"dist":-100}],"joints":[{"d0":0,"d1":1,"strength":0.5}],
      "redSpawnPoints":[[1,1]],"blueSpawnPoints":[],"playerPhysics":{"kickback":2}}`;
    const ev = SetStadiumEvent.create(parseHbs(hbs));
    const ours = encodeEvent(ev);
    expect(hex(inflateRaw(ours.subarray(3)))).toBe(hex(stadiumToBytes({ hbs })));
    checkCase({ ev, nh: null });
  });

  it('SetStadium: the deflated stadium is computed once per stadium object and reused', () => {
    const [a, b] = defaultStadiums();
    const ev = SetStadiumEvent.create(a!);
    const first = encodeEvent(ev);
    const fresh = encodeEvent(SetStadiumEvent.create(a!));
    expect(hex(first)).toBe(hex(fresh));
    // second write: same bytes, from the cache (same backing array)
    const w1 = new Writer();
    ev.write(w1);
    const w2 = new Writer();
    ev.write(w2);
    expect(hex(w2.finish())).toBe(hex(w1.finish()));
    expect((ev as unknown as { packed: Uint8Array }).packed.byteLength).toBe(w1.length - 2);
    expect((ev as unknown as { packed: Uint8Array }).packed.buffer.byteLength).toBe(w1.length - 2);
    // assigning another stadium invalidates the cache
    ev.stadium = b!;
    expect(hex(encodeEvent(ev))).toBe(hex(encodeEvent(SetStadiumEvent.create(b!))));
    // a decoded event re-encodes its own stadium
    const back = decodeEvent(first) as SetStadiumEvent;
    expect(hex(encodeEvent(back))).toBe(hex(first));
  });

  it('readers reject what the official reader rejects', () => {
    // chat > 140 units
    const w = new Writer();
    w.u8(EventType.SendChat);
    w.string('z'.repeat(141));
    expect(() => decodeEvent(w.copyBytes())).toThrow();
    expect(() => officialRoundTrip(w.copyBytes())).toThrow();
    // announcement > 1000
    const w2 = new Writer();
    w2.u8(EventType.SendAnnouncement);
    w2.string('z'.repeat(1001));
    w2.i32(0);
    w2.u8(0);
    w2.u8(0);
    expect(() => decodeEvent(w2.copyBytes())).toThrow();
    expect(() => officialRoundTrip(w2.copyBytes())).toThrow();
    // avatar > 8
    const w3 = new Writer();
    w3.u8(EventType.SetAvatar);
    w3.nullableString('123456789');
    expect(() => decodeEvent(w3.copyBytes())).toThrow();
    expect(() => officialRoundTrip(w3.copyBytes())).toThrow();
    // avatar 3..8 accepted and truncated to 2
    const w4 = new Writer();
    w4.u8(EventType.SetAvatar);
    w4.nullableString('abcdef');
    const ev4 = decodeEvent(w4.copyBytes()) as SetAvatarEvent;
    expect(ev4.avatar).toBe('ab');
    expect(hex(encodeEvent(ev4))).toBe(hex(officialRoundTrip(w4.copyBytes()).bytes));
    // kick reason > 100
    const w5 = new Writer();
    w5.u8(EventType.KickBanPlayer);
    w5.i32(3);
    w5.nullableString('r'.repeat(101));
    w5.u8(1);
    expect(() => decodeEvent(w5.copyBytes())).toThrow();
    expect(() => officialRoundTrip(w5.copyBytes())).toThrow();
    // team colours > 3
    const w6 = new Writer();
    w6.u8(EventType.SetTeamColors);
    w6.u8(1);
    w6.u8(0);
    w6.i32(0);
    w6.u8(4);
    for (let i = 0; i < 4; i++) w6.i32(i);
    expect(() => decodeEvent(w6.copyBytes())).toThrow();
    expect(() => officialRoundTrip(w6.copyBytes())).toThrow();
    // unknown event type
    expect(() => decodeEvent(new Uint8Array([24]))).toThrow();
  });

  it('write-side truncation matches official (announcement 1000, chat 140, kick reason 100)', () => {
    const cases: RoomEvent[] = [
      SendAnnouncementEvent.create('😀'.repeat(700), 1, 2, 1),
      SendChatEvent.create('ab😀'.repeat(60)),
      KickBanPlayerEvent.create(7, 'q😀'.repeat(80), true),
    ];
    for (const ev of cases) {
      const ours = encodeEvent(ev);
      const off = officialRoundTrip(ours);
      expect(off.consumed).toBe(ours.length);
      expect(hex(off.bytes)).toBe(hex(ours));
    }
    expect((decodeEvent(encodeEvent(cases[1]!)) as SendChatEvent).message.length).toBe(140);
  });

  it('SetDiscProperties: float32 quantisation, 13-bit mask, high mask bits ignored', () => {
    const ev = SetDiscPropertiesEvent.create(3, false, { x: 0.1, radius: 1e39, cGroup: 2 ** 31 + 5, color: -1 });
    expect(ev.values[0]).toBe(Math.fround(0.1));
    expect(ev.values[6]).toBe(Infinity);
    expect(ev.values[12]).toBe((2 ** 31 + 5) | 0);
    expect(ev.mask).toBe(1 | 64 | 1024 | 4096);
    const w = new Writer();
    w.u8(EventType.SetDiscProperties);
    w.i32(1);
    w.u8(0);
    w.u16(0xe001); // bits 13..15 set: ignored by the official reader, dropped on re-encode
    w.f32(2.5);
    const bytes = w.copyBytes();
    const dec = decodeEvent(bytes) as SetDiscPropertiesEvent;
    expect(dec.mask).toBe(1);
    expect(hex(encodeEvent(dec))).toBe(hex(officialRoundTrip(bytes).bytes));
  });

  it('EventFrame header (u32 frame, varuint order, u16 byId, u32 clientSeq) round-trips', () => {
    const ev = SendInputEvent.create(17);
    ev.frame = 123456;
    ev.order = 300;
    ev.byId = 42;
    ev.clientSeq = 0xfffffffe;
    const w = new Writer();
    writeEventFrame(w, ev);
    const bytes = w.copyBytes();
    expect(hex(bytes)).toBe('0001e240' + 'ac02' + '002a' + 'fffffffe' + '03' + '00000011');
    const back = readEventFrame(new Reader(bytes));
    expect([back.frame, back.order, back.byId, back.clientSeq, back.type]).toEqual([123456, 300, 42, 0xfffffffe, 3]);
  });

  it('metadata matches the official per-class config', () => {
    const delayed = EVENT_META.filter((m) => m.delay).map((m) => m.type);
    expect(delayed).toEqual([EventType.SendInput, EventType.PauseResumeGame]);
    expect(EVENT_META.filter((m) => m.predictable).map((m) => m.type)).toEqual(delayed);
    expect(EVENT_META[EventType.SendChat]!.rateLimit).toEqual({ burst: 10, intervalMs: 900 });
    expect(EVENT_META[EventType.SetStadium]!.rateLimit).toEqual({ burst: 10, intervalMs: 2000 });
    expect(EVENT_META[EventType.SetPlayerSync]!.rateLimit).toEqual({ burst: 2, intervalMs: 10000 });
    const hostOnly = EVENT_META.filter((m) => m.sender === 'hostOnly').map((m) => m.type);
    expect(hostOnly).toEqual([0, 2, 5, 17, 20, 22, 23]);
  });

  it.skipIf(!simReady())('checkClientSender: host-only kicks, SetStadium needs admin', () => {
    const rs = createRoomState();
    const j = JoinRoomEvent.create(5, 'a', null, null);
    j.apply(rs);
    expect(checkClientSender(EventType.SendInput, 5, rs)).toBe('accept');
    expect(checkClientSender(EventType.Ping, 5, rs)).toBe('kick');
    expect(checkClientSender(EventType.SetStadium, 5, rs)).toBe('drop');
    getPlayer(rs, 5)!.isAdmin = true;
    expect(checkClientSender(EventType.SetStadium, 5, rs)).toBe('accept');
    expect(checkClientSender(99, 5, rs)).toBe('kick');
  });
});
