/**
 * HostRoom / Sequencer robustness against misbehaving clients and operator
 * scripts (fake transport, no network):
 *  - queued events that cannot apply (AutoTeams from non-admins) do not use
 *    up the 255-disc budget of the world: the room's limit on players bounds
 *    what queued events can add;
 *  - player ids stay in 1..0xFFFF (u16 on the wire) and are reused without
 *    colliding with present players, bans or queued events;
 *  - a throwing onEventApplied / onFrameStepped neither re-applies an event,
 *    nor loses its broadcast, nor drops the client that sent it;
 *  - pingIntervalMs below 1 ms is refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_WORLD_DISCS, discLimitViolation } from '../../src/host/sequencer.js';
import { HostRoom, Sequencer, SequencerClient, createHostRoomState } from '../../src/host/index.js';
import { Reader, Writer } from '../../src/codec/index.js';
import {
  AutoTeamsEvent,
  createRoomState,
  encodeEvent,
  JoinRoomEvent,
  SendChatEvent,
  SetPlayerAdminEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
  type RoomEvent,
  type RoomState,
} from '../../src/room/index.js';
import type { HostTransport } from '../../src/net/index.js';
import { ClientMsg, EventType } from '../../src/protocol.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Just the fields discLimitViolation reads. */
function room(stadiumDiscs: number, teams: number[], worldDiscs: number | null): RoomState {
  return {
    stadium: { discs: new Array(stadiumDiscs).fill({}) },
    players: teams.map((team, i) => ({ id: i + 1, team, disc: null })),
    gameState: worldDiscs === null ? null : { world: { discs: new Array(worldDiscs).fill({}) } },
  } as unknown as RoomState;
}

function fakeTransport(maxPlayers: number) {
  const sent: { peer: Any; channel: number; data: Uint8Array }[] = [];
  const closed: Any[] = [];
  const roomInfo: Any = { players: 0, maxPlayers };
  let nextPeer = 1;
  const t: Any = {
    onPeerJoin: null,
    onPeerMessage: null,
    onPeerClose: null,
    onRoomLink: null,
    connectionCount: 0,
    bans: { remove() {}, clear() {} },
    start() {},
    stop() {},
    getRoomInfo: () => roomInfo,
    setRoomInfo: (i: Any) => Object.assign(roomInfo, i),
    send(peer: Any, channel: number, data: Uint8Array) {
      sent.push({ peer, channel, data: data.slice() });
      return true;
    },
    broadcastTo(targets: Any[], channel: number, data: Uint8Array) {
      for (const x of targets) t.send(x.peer, channel, data);
    },
    kick: () => null,
    close(peer: Any) {
      closed.push(peer);
    },
  };
  return {
    transport: t as HostTransport,
    sent,
    closed,
    join(name: string): Any {
      const peer = { id: nextPeer++, state: 'joined', playerId: -1, userData: null };
      t.connectionCount++;
      t.onPeerJoin(peer, { name, flag: 'ar', avatar: null, auth: null, conn: '7F000001' });
      return peer;
    },
    leave(peer: Any) {
      t.connectionCount--;
      t.onPeerClose(peer, 'closed');
    },
    message(peer: Any, frame: number, ev: RoomEvent) {
      const w = new Writer(64);
      w.u8(ClientMsg.Event);
      w.u32(frame);
      w.u32(0);
      w.bytes(encodeEvent(ev));
      t.onPeerMessage(peer, w.copyBytes());
    },
  };
}

const live: HostRoom[] = [];
afterEach(() => {
  for (const h of live.splice(0)) h.stop();
});

function makeRoom(maxPlayers = 12) {
  const f = fakeTransport(maxPlayers);
  const host = new HostRoom({ transport: f.transport, state: createHostRoomState({ noPlayer: true }) });
  const errors: unknown[] = [];
  host.onError = (e) => errors.push(e);
  live.push(host);
  host.start();
  return { host, errors, ...f };
}

describe('disc limit: queued events that cannot apply', () => {
  it('the discs queued events can add are bounded by the most players the room can hold', () => {
    const rs = room(5, [1, 1, 1, 2, 2, 2, 0, 0, 0, 0], 11);
    const flood: RoomEvent[] = [];
    for (let i = 0; i < 122; i++) flood.push(new AutoTeamsEvent());
    const move = SetPlayerTeamEvent.create(7, 1);
    // unbounded: 122 queued AutoTeams "could" add 244 discs
    expect(discLimitViolation(rs, move, flood)).toMatch(/256 discs/);
    // a room of 12 players + the host: at most 13 player discs
    expect(discLimitViolation(rs, move, flood, 13)).toBeNull();
    expect(discLimitViolation(room(5, [1, 1, 2, 2, 0, 0], null), new StartGameEvent(), flood, 13)).toBeNull();
  });

  it('still refuses what real players could do', () => {
    // 254 discs with a running game: one more player in a team is 255, two are 256
    const rs = room(200, [1, 0, 0], 254);
    const first = SetPlayerTeamEvent.create(2, 1);
    expect(discLimitViolation(rs, first, [], 31)).toBeNull();
    expect(discLimitViolation(rs, SetPlayerTeamEvent.create(3, 2), [first], 31)).toMatch(/256/);
    expect(discLimitViolation(room(250, [1, 1, 2, 2, 1, 2], null), new StartGameEvent(), [], 31)).toMatch(/256/);
    // the current count wins over a lower limit (lowered at runtime)
    expect(discLimitViolation(room(250, [1, 1, 2, 2, 0, 0], null), new StartGameEvent(), [SetPlayerTeamEvent.create(5, 1), SetPlayerTeamEvent.create(6, 2)], 2)).toMatch(
      /256/,
    );
    // a full room: every player in a team on a stadium of 225 discs
    const players = new Array(30).fill(0);
    expect(discLimitViolation(room(225, players, null), new StartGameEvent(), [new AutoTeamsEvent()], 31)).toBeNull();
    expect(discLimitViolation(room(226, players, null), new StartGameEvent(), new Array(20).fill(new AutoTeamsEvent()), 31)).toMatch(/257/);
  });

  it('Sequencer.playerLimit: AutoTeams floods from non-admins do not block the admin or the host', () => {
    const s = new Sequencer(createRoomState(), { broadcast() {}, hasConnections: () => false });
    const errors: unknown[] = [];
    s.onError = (e) => errors.push(e);
    s.playerLimit = () => 13;
    for (let id = 1; id <= 10; id++) s.hostEvent(JoinRoomEvent.create(id, `p${id}`, 'uy', null));
    s.hostEvent(SetPlayerAdminEvent.create(1, true));
    for (let id = 1; id <= 6; id++) s.hostEvent(SetPlayerTeamEvent.create(id, id <= 3 ? 1 : 2));
    s.hostEvent(new StartGameEvent());
    expect(s.rs.gameState!.world.discs.length).toBe(11);
    const send = (by: number, ev: RoomEvent): RoomEvent | null => {
      const w = new Writer(64);
      w.u32(s.frame + 20);
      w.u32(0);
      w.bytes(encodeEvent(ev));
      return s.clientMessage(clients[by]!, new Reader(w.copyBytes()), 0);
    };
    const clients: SequencerClient[] = [];
    for (let id = 0; id <= 10; id++) clients.push(new SequencerClient(id));
    let accepted = 0;
    for (let i = 0; i < 70; i++) {
      if (send(9, new AutoTeamsEvent()) !== null) accepted++;
      if (send(10, new AutoTeamsEvent()) !== null) accepted++;
    }
    expect(accepted).toBe(140);
    expect(send(1, SetPlayerTeamEvent.create(7, 1))).not.toBeNull();
    s.hostEvent(SetPlayerTeamEvent.create(8, 2));
    expect(errors).toEqual([]);
    s.advance(21);
    expect(s.rs.players.find((p) => p.id === 7)!.team).toBe(1);
    expect(s.rs.players.find((p) => p.id === 8)!.team).toBe(2);
  });

  it('HostRoom bounds the count by the transport maxPlayers', () => {
    const { host, errors, join, message } = makeRoom(12);
    expect(host.sequencer.playerLimit!()).toBe(13);
    const peers: Any[] = [];
    for (let i = 1; i <= 10; i++) peers.push(join(`p${i}`));
    host.setPlayerAdmin(1, true);
    for (let id = 1; id <= 6; id++) host.setPlayerTeam(id, id <= 3 ? 1 : 2);
    host.startGame();
    for (let i = 0; i < 70; i++) {
      message(peers[8], host.frame + 20, new AutoTeamsEvent());
      message(peers[9], host.frame + 20, new AutoTeamsEvent());
    }
    message(peers[0], host.frame + 20, SetPlayerTeamEvent.create(7, 1));
    expect(host.sequencer.queue.filter((q) => q.type === EventType.SetPlayerTeam)).toHaveLength(1);
    host.setPlayerTeam(8, 2);
    expect(errors).toEqual([]);
    expect(host.getPlayer(8)!.team).toBe(2);
  });

  it('a real stadium of 245 discs is still guarded', () => {
    const s = new Sequencer(createRoomState(), { broadcast() {}, hasConnections: () => false });
    const errors: unknown[] = [];
    s.onError = (e) => errors.push(e);
    s.playerLimit = () => 31;
    for (let id = 1; id <= 12; id++) s.hostEvent(JoinRoomEvent.create(id, `p${id}`, 'uy', null));
    for (let id = 1; id <= 10; id++) s.hostEvent(SetPlayerTeamEvent.create(id, 1));
    s.hostEvent(new StartGameEvent());
    const discs = s.rs.gameState!.world.discs;
    while (discs.length < MAX_WORLD_DISCS) discs.push(discs[0]!); // 255 (never stepped)
    s.hostEvent(SetPlayerTeamEvent.create(11, 1));
    expect(String(errors[0])).toMatch(/256 discs/);
  });
});

describe('player ids (u16 on the wire)', () => {
  it('wrap from 0xFFFF to 1, skipping ids in use, banned or authors of queued events', () => {
    const { host, join, leave, message } = makeRoom(30);
    const a = join('a'); // 1
    const b = join('b'); // 2
    join('c'); // 3
    join('d'); // 4
    expect(host.getPlayerList().map((p) => p.id)).toEqual([1, 2, 3, 4]);
    (host as Any).bansByPlayer.set(3, 99); // 3 holds a ban (clearBan(3))
    // 2 queues an event and leaves: its id stays taken while the event is queued
    message(b, host.frame + 20, SendChatEvent.create('bye'));
    expect(host.sequencer.queue.some((q) => q.byId === 2)).toBe(true);
    leave(b);
    expect(host.getPlayer(2)).toBeNull();
    (host as Any).nextPlayerId = 0xfffe;
    join('e');
    join('f');
    join('g');
    const ids = host.getPlayerList().map((p) => p.id);
    expect(ids).toEqual([1, 3, 4, 0xfffe, 0xffff, 5]);
    for (const id of ids) expect(id).toBeLessThanOrEqual(0xffff);
    expect(new Set(ids).size).toBe(ids.length);
    // once the queued event is gone, 2 is free again
    leave(a);
    (host as Any).nextPlayerId = 1;
    const queued = host.sequencer.queue.length;
    expect(queued).toBeGreaterThan(0);
    host.sequencer.advance(25);
    join('h');
    expect(host.getPlayerList().map((p) => p.id)).toEqual([3, 4, 0xfffe, 0xffff, 5, 1]);
    join('i');
    expect(host.getPlayer(2)?.name).toBe('i');
  });

  it('the snapshot and event headers carry the real id after the wrap', () => {
    const { host, sent, join } = makeRoom(30);
    (host as Any).nextPlayerId = 0xffff;
    join('x');
    const y = join('y');
    expect(y.playerId).toBe(1);
    const snap = sent.filter((s) => s.peer === y && s.data[0] !== 3).at(-1)!;
    expect(snap).toBeDefined();
    expect(host.getPlayer(1)!.name).toBe('y');
    expect(host.getPlayer(0x10000)).toBeNull();
  });
});

describe('throwing engine callbacks', () => {
  it('onEventApplied: the event is applied once, broadcast, and its sender stays', () => {
    const { host, errors, sent, closed, join, message } = makeRoom(30);
    const p = join('p');
    const q = join('q');
    host.setPlayerAdmin(1, true);
    host.setPlayerTeam(1, 1);
    let applied = 0;
    host.onEventApplied = (ev) => {
      if (ev.type !== EventType.AutoTeams) return;
      applied++;
      throw new Error('operator bug');
    };
    const before = sent.filter((s) => s.peer === q).length;
    message(p, host.frame, new AutoTeamsEvent());
    host.update();
    host.sequencer.advance(5);
    expect(applied).toBe(1);
    expect(closed).toEqual([]);
    expect(host.getPlayer(1)).not.toBeNull();
    expect(host.getPlayer(2)!.team).toBe(2);
    expect(sent.filter((s) => s.peer === q).length).toBeGreaterThan(before);
    expect(String(errors[0])).toMatch(/operator bug/);
  });

  it('onEventApplied on a host event: still broadcast', () => {
    const { host, errors, sent, join } = makeRoom(30);
    const p = join('p');
    host.onEventApplied = () => {
      throw new Error('operator bug');
    };
    const before = sent.filter((s) => s.peer === p).length;
    host.sendChat('hello');
    expect(sent.filter((s) => s.peer === p).length).toBeGreaterThan(before);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('onFrameStepped: frames keep stepping', () => {
    const s = new Sequencer(createRoomState(), { broadcast() {}, hasConnections: () => false });
    const errors: unknown[] = [];
    s.onError = (e) => errors.push(e);
    let n = 0;
    s.onFrameStepped = () => {
      n++;
      throw new Error('x');
    };
    s.advance(10);
    expect(s.frame).toBe(10);
    expect(n).toBe(10);
    expect(errors).toHaveLength(10);
  });
});

describe('pingIntervalMs', () => {
  it('below 1 ms (or NaN) is refused: the next Ping would always be due', () => {
    const f = fakeTransport(12);
    for (const v of [0, -100, NaN, 0.5]) {
      expect(() => new HostRoom({ transport: f.transport, pingIntervalMs: v })).toThrow(RangeError);
    }
    expect(new HostRoom({ transport: f.transport, pingIntervalMs: 1 }).pingIntervalMs).toBe(1);
    expect(new HostRoom({ transport: f.transport, pingIntervalMs: Infinity }).pingIntervalMs).toBe(Infinity);
  });
});
