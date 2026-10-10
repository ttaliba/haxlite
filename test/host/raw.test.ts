/**
 * HostRoom wire behaviour checked byte by byte with a raw test client
 * (test/net/raw-client.ts): snapshot layout (msg 1), pong (msg 4), heartbeat
 * cadence (msg 3), event broadcast header (msg 2), targeted messages (msg 6),
 * Ping event, "Bad actor" handling (host-only event, rate limit, malformed),
 * admin-only drop, onBeforeOperation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { RawClient } from '../net/raw-client.js';
import { Reader, Writer, inflateRaw } from '../../src/codec/index.js';
import { HostTransport, generateIdentity, shutdownWebRtc } from '../../src/net/index.js';
import { EventType } from '../../src/protocol.js';
import {
  encodeEvent,
  readEventFrame,
  readRoomState,
  KickBanPlayerEvent,
  PingEvent,
  SendAnnouncementEvent,
  SendChatEvent,
  SendInputEvent,
  SetStadiumEvent,
  type RoomEvent,
} from '../../src/room/index.js';
import { defaultStadiums } from '../../src/sim/index.js';
import { HostRoom, createHostRoomState, type HostRoomOptions } from '../../src/host/index.js';
import { sleep, waitFor, withTimeout } from './harness.js';

let master: FakeMaster;
const hosts: HostRoom[] = [];
const raws: RawClient[] = [];

beforeAll(async () => {
  master = await FakeMaster.start();
});
afterAll(async () => {
  for (const r of raws) r.close();
  for (const h of hosts) h.stop();
  await master.close();
  await shutdownWebRtc();
});

async function startHost(opts: Partial<HostRoomOptions> = {}): Promise<{ host: HostRoom; roomId: string }> {
  const transport = new HostTransport({ token: 'thr1.test', masterUrl: master.httpBase, iceServers: [], public: true });
  const host = new HostRoom({ state: createHostRoomState({ roomName: 'raw' }), ...opts, transport });
  hosts.push(host);
  const room = master.waitForRoom();
  host.start();
  return { host, roomId: (await withTimeout(room, 10_000, 'room')).id };
}

async function rawJoin(roomId: string, name: string): Promise<RawClient> {
  const c = new RawClient({ wsBase: master.wsBase, roomId, identity: await generateIdentity(), info: { name, flag: 'uy', avatar: null } });
  raws.push(c);
  await withTimeout(c.waitMessages(1), 15_000, `${name} snapshot`);
  return c;
}

function clientEvent(requested: number, seq: number, ev: RoomEvent): Uint8Array {
  const w = new Writer(64);
  w.u8(1);
  w.u32(requested);
  w.u32(seq);
  w.bytes(encodeEvent(ev));
  return w.copyBytes();
}

/** Broadcast events (msg 2) received so far. */
function events(c: RawClient): RoomEvent[] {
  const out: RoomEvent[] = [];
  for (const [, m] of c.received) if (m[0] === 2) out.push(readEventFrame(new Reader(m, 1)));
  return out;
}

describe('HostRoom wire protocol (raw client)', () => {
  it('snapshot layout, pong, heartbeats, broadcast header, targeted msg, Ping event', async () => {
    const { host, roomId } = await startHost({ heartbeatFrames: 3, pingIntervalMs: 300 });
    const a = await rawJoin(roomId, 'alice');
    // ---- msg 1: [1] deflate(u16 id, u32 frame, u32 counter, varuint Ra, RoomState, events*)
    const [ch, snap] = a.received[0]!;
    expect(ch).toBe(0);
    expect(snap[0]).toBe(1);
    const r = new Reader(inflateRaw(snap.subarray(1)));
    expect(r.u16()).toBe(1);
    const frame = r.u32();
    const counter = r.u32();
    const inFrame = r.varUint();
    const rs = readRoomState(r);
    expect(r.remaining).toBe(0); // no queued events
    expect(frame).toBeLessThanOrEqual(host.frame);
    expect(inFrame).toBeGreaterThanOrEqual(1); // the JoinRoom event itself
    expect(counter).toBeGreaterThanOrEqual(0);
    expect(rs.players.map((p) => [p.id, p.name, p.isAdmin])).toEqual([[0, 'Host', true], [1, 'alice', false]]);
    expect(rs.name).toBe('raw');

    // ---- msg 2 ping -> msg 4 pong: [4][f64 hostFrame + Sb][f64 echo]
    const pw = new Writer(16);
    pw.u8(2);
    pw.f64(1234.5);
    pw.varUint(77);
    const n0 = a.received.length;
    a.send(2, pw.copyBytes());
    await waitFor(() => a.received.slice(n0).some(([, m]) => m[0] === 4), 5000, 'pong');
    const pong = new Reader(a.received.slice(n0).find(([, m]) => m[0] === 4)![1], 1);
    const hostFrame = pong.f64();
    expect(pong.f64()).toBe(1234.5);
    expect(hostFrame).toBeGreaterThan(host.frame - 5);
    expect(hostFrame).toBeLessThan(host.frame + 2 + 5);
    expect(Number.isInteger(hostFrame)).toBe(false); // float frame like official

    // ---- Ping event carries the declared ping, in player-list order
    await waitFor(() => events(a).some((ev) => ev.type === EventType.Ping && (ev as PingEvent).pings[1] === 77), 5000, 'ping event');
    expect(host.getPlayer(1)!.ping).toBe(77);

    // ---- heartbeats (msg 3 on uu) every 3 frames with no game
    await sleep(300);
    const hb = a.received.filter(([, m]) => m[0] === 3).map(([c2, m]) => [c2, new Reader(m, 1).u32()]);
    expect(hb.length).toBeGreaterThan(10);
    expect(hb.every(([c2]) => c2 === 2)).toBe(true);
    // strictly increasing; periodic ones every 3 frames (host events such as the Ping event
    // also trigger one immediately, official `oc` -> `Zd`, so shorter gaps are legitimate)
    const gaps = hb.slice(1).map(([, f], i) => f! - hb[i]![1]!);
    expect(gaps.every((g) => g >= 1)).toBe(true);
    expect(gaps.filter((g) => g <= 3).length / gaps.length).toBeGreaterThan(0.7);

    // ---- client event broadcast (msg 2 on ru) with the official header, author included
    const before = events(a).length;
    a.send(0, clientEvent(host.frame + 2, 42, SendInputEvent.create(8)));
    await waitFor(() => events(a).length > before && events(a).some((ev) => ev.type === EventType.SendInput), 5000, 'echo');
    const echo = events(a).find((ev) => ev.type === EventType.SendInput)!;
    expect([echo.byId, echo.clientSeq, (echo as SendInputEvent).input]).toEqual([1, 42, 8]);
    // a delay event is applied when the host reaches its frame
    await waitFor(() => host.getPlayer(1)!.input === 8, 2000, 'input applied');

    // ---- targeted (msg 6): [6][u8 type][payload], only to that client
    const b = await rawJoin(roomId, 'bob');
    host.sendChat('psst', 2);
    host.sendAnnouncement('only bob', 2, 0xff0000, 1, 2);
    await waitFor(() => b.received.filter(([, m]) => m[0] === 6).length === 2, 5000, 'targeted');
    const t = b.received.filter(([, m]) => m[0] === 6).map(([c2, m]) => [c2, Buffer.from(m).toString('hex')]);
    expect(t).toEqual([
      [0, Buffer.from([6, ...encodeEvent(SendChatEvent.create('psst'))]).toString('hex')],
      [0, Buffer.from([6, ...encodeEvent(SendAnnouncementEvent.create('only bob', 0xff0000, 1, 2))]).toString('hex')],
    ]);
    expect(a.received.some(([, m]) => m[0] === 6)).toBe(false);
  }, 60_000);

  it('Bad actor: host-only event, rate limit, malformed message; admin-only events dropped silently', async () => {
    const { host, roomId } = await startHost();
    const bad: number[] = [];
    host.onBadActor = (id) => bad.push(id);
    const watcher = await rawJoin(roomId, 'watcher');
    const kicks = () => events(watcher).filter((ev) => ev.type === EventType.KickBanPlayer) as KickBanPlayerEvent[];

    // admin-only SetStadium from a non-admin: dropped, no kick, nothing broadcast
    const x = await rawJoin(roomId, 'x');
    x.send(0, clientEvent(0, 1, SetStadiumEvent.create(defaultStadiums()[2]!)));
    await sleep(300);
    expect(host.getPlayer(2)).not.toBeNull();
    expect(events(watcher).some((ev) => ev.type === EventType.SetStadium)).toBe(false);

    // host-only event -> "Bad actor"
    x.send(0, clientEvent(0, 2, SendAnnouncementEvent.create('hax', -1, 0, 0)));
    await waitFor(() => kicks().length === 1, 5000, 'bad actor 1');
    expect([kicks()[0]!.playerId, kicks()[0]!.reason, kicks()[0]!.ban]).toEqual([2, 'Bad actor', false]);
    await withTimeout(x.channelsClosed, 5000, 'x closed');

    // chat rate limit (10 burst, 1 per 900 ms) -> 11th message kicks
    const y = await rawJoin(roomId, 'y');
    for (let i = 0; i < 11; i++) y.send(0, clientEvent(0, 10 + i, SendChatEvent.create(`spam ${i}`)));
    await waitFor(() => kicks().length === 2, 5000, 'bad actor 2');
    expect(kicks()[1]!.playerId).toBe(3);
    expect(events(watcher).filter((ev) => ev.type === EventType.SendChat && ev.byId === 3).length).toBe(10);

    // malformed (unknown message type / trailing bytes)
    const z = await rawJoin(roomId, 'z');
    z.send(0, Uint8Array.of(9, 1, 2));
    await waitFor(() => kicks().length === 3, 5000, 'bad actor 3');
    expect(bad).toEqual([2, 3, 4]);
    expect(host.state.players.map((p) => p.name)).toEqual(['Host', 'watcher']);
  }, 60_000);

  it('onBeforeOperation can rewrite or drop client events before broadcast', async () => {
    const { host, roomId } = await startHost();
    host.onBeforeOperation = (ev) => {
      if (ev.type !== EventType.SendChat) return true;
      const chat = ev as SendChatEvent;
      if (chat.message === 'drop me') return false;
      chat.message = chat.message.toUpperCase();
      return true;
    };
    const a = await rawJoin(roomId, 'a');
    a.send(0, clientEvent(0, 1, SendChatEvent.create('drop me')));
    a.send(0, clientEvent(0, 2, SendChatEvent.create('hello')));
    await waitFor(() => events(a).some((ev) => ev.type === EventType.SendChat), 5000, 'chat');
    await sleep(200);
    const chats = events(a).filter((ev) => ev.type === EventType.SendChat) as SendChatEvent[];
    expect(chats.map((c) => [c.message, c.clientSeq])).toEqual([['HELLO', 2]]);
  }, 60_000);

  it('a late joiner gets queued future events in its snapshot', async () => {
    const { host, roomId } = await startHost({ inputDelayFrames: 30 }); // host pause lands 30 frames later
    const a = await rawJoin(roomId, 'a');
    host.startGame();
    host.pauseGame(true);
    const b = await rawJoin(roomId, 'b');
    const r = new Reader(inflateRaw(b.received[0]![1].subarray(1)));
    r.u16();
    const frame = r.u32();
    r.u32();
    r.varUint();
    readRoomState(r);
    const queued: RoomEvent[] = [];
    while (r.remaining > 0) queued.push(readEventFrame(r));
    expect(queued.map((ev) => ev.type)).toEqual([EventType.PauseResumeGame]);
    expect(queued[0]!.frame).toBeGreaterThan(frame);
    expect(queued[0]!.byId).toBe(0);
    void a;
  }, 60_000);
});
