/**
 * Player ids (u16 on the wire) and the bans that remember them:
 *  - after the wrap from 0xFFFF to 1, the join snapshot and the event
 *    headers carry the real id;
 *  - when bans hold every free id, the id of the OLDEST ban is reused (the
 *    ban stays in the ban list, only clearBan(oldId) no longer finds it)
 *    instead of refusing every new player;
 *  - with no id at all the peer is closed, not left joined without a player;
 *  - a recording that freezes at the recorder's cap is reported once through
 *    onError and visible as `recordingTruncated`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Reader, Writer, inflateRaw } from '../../src/codec/index.js';
import { HostRoom, createHostRoomState } from '../../src/host/index.js';
import type { HostTransport } from '../../src/net/index.js';
import { ClientMsg, EventType, HostMsg } from '../../src/protocol.js';
import { encodeEvent, readEventFrame, readRoomState, SendChatEvent, type JoinRoomEvent, type RoomEvent } from '../../src/room/index.js';
import { readReplay } from '../../src/replay/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function makeRoom() {
  const sent: { peer: Any; data: Uint8Array }[] = [];
  const closed: Any[] = [];
  const removed: number[] = [];
  let nextBan = 100;
  const roomInfo: Any = { players: 0, maxPlayers: 30 };
  let nextPeer = 1;
  const t: Any = {
    onPeerJoin: null,
    onPeerMessage: null,
    onPeerClose: null,
    onRoomLink: null,
    connectionCount: 0,
    bans: { remove: (id: number) => removed.push(id), clear() {} },
    start() {},
    stop() {},
    getRoomInfo: () => roomInfo,
    setRoomInfo: (i: Any) => Object.assign(roomInfo, i),
    send(peer: Any, _channel: number, data: Uint8Array) {
      sent.push({ peer, data: data.slice() });
      return true;
    },
    broadcastTo(targets: Any[], channel: number, data: Uint8Array) {
      for (const x of targets) t.send(x.peer, channel, data);
    },
    kick: (_peer: Any, opts: Any) => (opts.ban ? { id: nextBan++ } : null),
    close(peer: Any) {
      closed.push(peer);
    },
  };
  const host = new HostRoom({ transport: t as HostTransport, state: createHostRoomState({ noPlayer: true }) });
  const errors: unknown[] = [];
  host.onError = (e) => errors.push(e);
  live.push(host);
  host.start();
  const join = (name: string): Any => {
    const peer = { id: nextPeer++, state: 'joined', playerId: -1, userData: null };
    t.connectionCount++;
    t.onPeerJoin(peer, { name, flag: 'ar', avatar: null, auth: null, conn: '7F000001' });
    return peer;
  };
  const message = (peer: Any, ev: RoomEvent): void => {
    const w = new Writer(64);
    w.u8(ClientMsg.Event);
    w.u32(host.frame);
    w.u32(0);
    w.bytes(encodeEvent(ev));
    t.onPeerMessage(peer, w.copyBytes());
  };
  return { host, sent, closed, removed, errors, join, message, bansByPlayer: (host as Any).bansByPlayer as Map<number, number> };
}

const live: HostRoom[] = [];
afterEach(() => {
  for (const h of live.splice(0)) h.stop();
});

/** Events (msg 2) sent to `peer`, decoded. */
function eventsTo(sent: { peer: Any; data: Uint8Array }[], peer: Any): RoomEvent[] {
  return sent.filter((s) => s.peer === peer && s.data[0] === HostMsg.Event).map((s) => readEventFrame(new Reader(s.data.subarray(1))));
}

describe('ids after the wrap', () => {
  it('the snapshot and the event headers carry the real id', () => {
    const { host, sent, join, message } = makeRoom();
    (host as Any).nextPlayerId = 0xffff;
    const x = join('x');
    const y = join('y');
    expect([x.playerId, y.playerId]).toEqual([0xffff, 1]);

    // y's snapshot: own id, and the room with both players under their real ids
    const snap = sent.find((s) => s.peer === y && s.data[0] === HostMsg.InitialSnapshot)!;
    const r = new Reader(inflateRaw(snap.data.subarray(1)));
    expect(r.u16()).toBe(1);
    r.u32();
    r.u32();
    r.varUint();
    const rs = readRoomState(r);
    expect(rs.players.map((p) => [p.id, p.name])).toEqual([
      [0xffff, 'x'],
      [1, 'y'],
    ]);

    // x sees y's JoinRoom with id 1, and y's chat with byId 1
    message(y, SendChatEvent.create('hi'));
    const seen = eventsTo(sent, x);
    const joinEv = seen.find((e) => e.type === EventType.JoinRoom) as JoinRoomEvent;
    expect([joinEv.byId, joinEv.playerId, joinEv.name]).toEqual([0, 1, 'y']);
    const chat = seen.find((e) => e.type === EventType.SendChat)!;
    expect(chat.byId).toBe(1);
  });
});

describe('ids held by bans', () => {
  it('a full id space reuses the ids of the oldest bans; the bans stay in force', () => {
    const { host, closed, removed, errors, join, bansByPlayer } = makeRoom();
    const a = join('a');
    const b = join('b');
    const c = join('c');
    const d = join('d');
    host.kickPlayer(a.playerId, 'x', true);
    host.kickPlayer(c.playerId, 'x', true);
    host.kickPlayer(b.playerId, 'x', true);
    expect([...bansByPlayer]).toEqual([
      [1, 100],
      [3, 101],
      [2, 102],
    ]);
    // every other id but d's is banned too (newer bans)
    for (let id = 5; id <= 0xffff; id++) bansByPlayer.set(id, 1000 + id);
    expect(bansByPlayer.size + 1).toBe(0xffff);

    const t0 = performance.now();
    const v1 = join('v1');
    const v2 = join('v2');
    const v3 = join('v3');
    const v4 = join('v4');
    const ms = performance.now() - t0;
    expect([v1.playerId, v2.playerId, v3.playerId, v4.playerId]).toEqual([1, 3, 2, 5]);
    expect(host.getPlayerList().map((p) => p.name)).toEqual(['d', 'v1', 'v2', 'v3', 'v4']);
    expect(bansByPlayer.has(1) || bansByPlayer.has(2) || bansByPlayer.has(3) || bansByPlayer.has(5)).toBe(false);
    expect(bansByPlayer.size).toBe(0xffff - 5);
    // the ban records themselves were not lifted; clearBan(oldId) now finds nothing
    expect(removed).toEqual([]);
    host.clearBan(1);
    expect(removed).toEqual([]);
    host.clearBan(6);
    expect(removed).toEqual([1006]);
    expect(closed).toEqual([]);
    expect(errors).toEqual([]);
    expect(d.playerId).toBe(4);
    expect(ms).toBeLessThan(2000);
  });

  it('no id left at all: the peer is closed and the error reported', () => {
    const { host, closed, errors, join } = makeRoom();
    (host as Any).idFree = () => false;
    const p = join('p');
    expect(closed).toEqual([p]);
    expect(p.playerId).toBe(-1);
    expect(host.getPlayerList()).toEqual([]);
    expect(errors.map((e) => (e as Error).message)).toEqual(['no free player id']);
  });
});

describe('recording frozen at the recorder cap', () => {
  it('reported once through onError, exposed as recordingTruncated, the replay still reads', () => {
    const { host, errors } = makeRoom();
    expect(host.recordingTruncated).toBe(false);
    host.startRecording();
    host.recorder.maxEvents = 5;
    for (let i = 0; i < 20; i++) host.sendChat(`m${i}`);
    expect(host.recordingTruncated).toBe(true);
    expect(errors.length).toBe(1);
    expect(String((errors[0] as Error).message)).toMatch(/^replay recording truncated at frame \d+ \(recorder\.maxBytes \d+ \/ maxEvents 5 reached\)/);
    const data = readReplay(host.stopRecording()!);
    expect(data.events.length).toBe(5);
    expect(host.recordingTruncated).toBe(true);
    // a new recording starts clean and reports its own truncation
    host.startRecording();
    expect(host.recordingTruncated).toBe(false);
    for (let i = 0; i < 20; i++) host.sendChat(`n${i}`);
    expect(errors.length).toBe(2);
  });
});
