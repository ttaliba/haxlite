/**
 * Sequencer vs the OFFICIAL host runner (`Wa extends Ma` from the headless
 * script, driven offline): identical call sequences (frame advances, client
 * messages from 3 connections with random requested frames, host events,
 * heartbeat/checksum cadence, join snapshots) must produce byte-identical
 * broadcasts (msg 2 frames/orders, msg 3 heartbeats, CheckConsistency),
 * identical counters (da/Ra/od), identical accept/kick decisions,
 * identical snapshots (inflated) and identical RoomState bytes.
 */
import { describe, expect, it } from 'vitest';
import { Reader, Writer, inflateRaw } from '../../src/codec/index.js';
import { EventType } from '../../src/protocol.js';
import {
  createRoomState,
  decodeEvent,
  encodeEvent,
  JoinRoomEvent,
  PauseResumeGameEvent,
  PingEvent,
  SendAnnouncementEvent,
  SendChatEvent,
  SendChatIndicatorEvent,
  SendInputEvent,
  SetAvatarEvent,
  SetPlayerAdminEvent,
  SetPlayerTeamEvent,
  StartGameEvent,
  StopGameEvent,
  writeRoomState,
  type RoomEvent,
} from '../../src/room/index.js';
import { MovingAverage, ProtocolViolation, Sequencer, SequencerClient } from '../../src/host/index.js';
import { officialInternals } from '../oracle/official.js';
import { prng } from '../oracle/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CHECKSUM_FRAMES = 60;
const HEARTBEAT_FRAMES = 7;

class OfficialHost {
  readonly x = officialInternals();
  readonly host: Any;
  readonly out: [number, Uint8Array][] = [];
  readonly clients = new Map<number, Any>();

  constructor(sb: number) {
    const { Wa, Ta } = this.x;
    const h = Object.create(Wa.prototype);
    Object.getPrototypeOf(Wa.prototype).Ba.call(h, new Ta()); // Ma.Ba: da, od, Ra, Xd, Kg, Be, Ca
    h.Sb = sb;
    h.Bg = CHECKSUM_FRAMES;
    h.Ha = [{}]; // one "connection" so oc/Zd/Wh broadcast
    h.yb = new Map();
    h.df = 0;
    h.cf = 0;
    h.jd = (w: Any, ch?: number) => this.out.push([ch ?? 0, Uint8Array.from(w.Db() as Uint8Array)]);
    this.host = h;
  }

  client(id: number): Any {
    let c = this.clients.get(id);
    if (!c) {
      c = new this.x.Za({ pb() {} });
      c.P = id;
      this.clients.set(id, c);
    }
    return c;
  }

  reader(bytes: Uint8Array): Any {
    return new this.x.L(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), false);
  }

  /** `Wa.Da` minus the clock. */
  periodic(): void {
    const h = this.host;
    if (HEARTBEAT_FRAMES <= h.da - h.df) h.Zd();
    if (h.da - h.cf >= h.Bg) {
      h.Zd();
      h.Wh();
    }
  }

  hostEvent(bytes: Uint8Array): void {
    const r = this.reader(bytes);
    const ev = this.x.m.Ji(r);
    ev.W(r);
    this.host.oc(ev);
  }

  /** Returns true if the official host would drop the client (exception). */
  clientMessage(id: number, body: Uint8Array): boolean {
    try {
      const r = this.reader(body);
      this.host.Mh(r, this.client(id));
      if (r.j.byteLength - r.a > 0) throw new Error('trailing');
      return false;
    } catch {
      return true;
    }
  }

  snapshotInner(playerId: number): Uint8Array {
    let sent: Uint8Array | null = null;
    this.host.$h({ P: playerId, pb: (w: Any) => (sent = Uint8Array.from(w.Db() as Uint8Array)) });
    return inflateRaw(sent!.subarray(1));
  }

  stateBytes(): Uint8Array {
    const w = this.x.A.aa();
    this.host.Ca.G(w);
    return Uint8Array.from(w.Db() as Uint8Array);
  }
}

function ourStateBytes(seq: Sequencer): Uint8Array {
  const w = new Writer(4096);
  writeRoomState(w, seq.rs);
  return w.copyBytes();
}

function clientBody(requested: number, seq: number, ev: RoomEvent): Uint8Array {
  const w = new Writer(64);
  w.u32(requested >>> 0);
  w.u32(seq);
  const e = encodeEvent(ev);
  w.bytes(e);
  return w.copyBytes();
}

function runScenario(sb: number, seed: number, ops: number): { accepted: number; dropped: number; late: number; kicks: number } {
  const rnd = prng(seed);
  const off = new OfficialHost(sb);
  const ourOut: [number, Uint8Array][] = [];
  const seq = new Sequencer(createRoomState(), {
    broadcast: (d, ch) => ourOut.push([ch, d.slice()]),
    hasConnections: () => true,
  }, { inputDelayFrames: sb });
  const ourClients = new Map<number, SequencerClient>();
  const clientSeq = new Map<number, number>();
  let kicks = 0;
  let accepted = 0;
  let dropped = 0;
  let late = 0;
  let chats = 0;

  const host = (ev: RoomEvent) => {
    const bytes = encodeEvent(ev);
    off.hostEvent(bytes);
    seq.hostEvent(decodeEvent(bytes));
  };
  const compare = (what: string) => {
    expect(ourOut.length, `${what}: broadcast count`).toBe(off.out.length);
    for (let i = 0; i < ourOut.length; i++) {
      expect(ourOut[i]![0], `${what}: channel #${i}`).toBe(off.out[i]![0]);
      expect(Buffer.from(ourOut[i]![1]).toString('hex'), `${what}: bytes #${i}`).toBe(Buffer.from(off.out[i]![1]).toString('hex'));
    }
    ourOut.length = 0;
    off.out.length = 0;
    const h = off.host;
    expect([seq.frame, seq.eventsInFrame, seq.eventCounter, seq.queue.length], what).toEqual([h.da, h.Ra, h.od, h.Xd.list.length]);
  };

  // three clients join
  for (let id = 1; id <= 3; id++) {
    host(JoinRoomEvent.create(id, `p${id}`, 'uy', null));
    ourClients.set(id, new SequencerClient(id));
    clientSeq.set(id, 1);
  }
  host(SetPlayerAdminEvent.create(1, true));
  host(SetPlayerTeamEvent.create(1, 1));
  host(SetPlayerTeamEvent.create(2, 2));
  host(SetPlayerTeamEvent.create(3, 1));
  host(new StartGameEvent());
  compare('setup');

  for (let op = 0; op < ops; op++) {
    const r = rnd();
    if (r < 0.3) {
      const n = Math.floor(rnd() * 4);
      off.host.rg(n);
      seq.advance(n);
      off.periodic();
      seq.periodic(HEARTBEAT_FRAMES, CHECKSUM_FRAMES);
      compare(`advance ${n} @op ${op}`);
    } else if (r < 0.85) {
      const id = 1 + Math.floor(rnd() * 3);
      const k = rnd();
      let ev: RoomEvent;
      let requested: number;
      const cur = seq.frame;
      // requested frames around "cur + Sb": early, on time, late, very late, far future, 0
      const pick = rnd();
      if (pick < 0.05) requested = 0;
      else if (pick < 0.1) requested = cur + 20 + Math.floor(rnd() * 30);
      else requested = Math.max(0, cur + sb + Math.floor(rnd() * 16) - 10);
      if (requested < cur + sb - sb - 3) late++;
      if (k < 0.7) ev = SendInputEvent.create(Math.floor(rnd() * 32));
      else if (k < 0.75) ev = PauseResumeGameEvent.create(rnd() < 0.5);
      else if (k < 0.8 && chats < 6) {
        chats++;
        ev = SendChatEvent.create(`hi ${op}`);
      } else if (k < 0.88) ev = SendChatIndicatorEvent.create(rnd() < 0.5 ? 1 : 0);
      else if (k < 0.95) ev = SetAvatarEvent.create(rnd() < 0.5 ? 'ab' : null);
      else if (k < 0.97) ev = SetPlayerTeamEvent.create(id, (1 + Math.floor(rnd() * 2)) as 1 | 2);
      else if (k < 0.985) {
        // host-only event from a client: both must reject (kick)
        ev = SendAnnouncementEvent.create('x', -1, 0, 0);
      } else ev = new StopGameEvent();
      const s = clientSeq.get(id)!;
      clientSeq.set(id, s + 1);
      const body = clientBody(requested, s, ev);
      const offKick = off.clientMessage(id, body);
      let ourKick = false;
      try {
        const rd = new Reader(body);
        const res = seq.clientMessage(ourClients.get(id)!, rd, performance.now());
        if (rd.remaining > 0) throw new ProtocolViolation('trailing');
        if (res !== null) accepted++;
        else dropped++;
      } catch {
        ourKick = true;
      }
      expect(ourKick, `kick decision op ${op}`).toBe(offKick);
      if (ourKick) kicks++;
      compare(`client ${id} ${ev.meta.name} req ${requested} @op ${op}`);
      // per-connection sequencing state
      const oc = off.client(id);
      expect(ourClients.get(id)!.lastFrame).toBe(oc.Id);
      expect(ourClients.get(id)!.lateness.mean).toBe(oc.jf.ug());
    } else if (r < 0.9) {
      host(PingEvent.create([0, 10, 20, 30]));
      compare(`ping @op ${op}`);
    } else if (r < 0.93) {
      host(PauseResumeGameEvent.create(rnd() < 0.5));
      compare(`host pause @op ${op}`);
    } else if (r < 0.95) {
      host(SendAnnouncementEvent.create(`a${op}`, 0xff00ff, 1, 2));
      compare(`announce @op ${op}`);
    } else if (r < 0.96 && seq.rs.gameState === null) {
      host(new StartGameEvent());
      compare(`start @op ${op}`);
    } else {
      const id = 1 + Math.floor(rnd() * 3);
      const ours = new Reader(seq.snapshot(id));
      expect(ours.u8()).toBe(1);
      expect(Buffer.from(inflateRaw(ours.bytes())).toString('hex'), `snapshot @op ${op}`).toBe(
        Buffer.from(off.snapshotInner(id)).toString('hex'),
      );
    }
    if (op % 50 === 0) expect(ourStateBytes(seq)).toEqual(off.stateBytes());
  }
  expect(ourStateBytes(seq)).toEqual(off.stateBytes());
  return { accepted, dropped, late, kicks };
}

describe('Sequencer vs official Wa (Mh/oc/rg/Cf/Zd/Wh/$h)', () => {
  for (const sb of [1, 2, 4]) {
    it(`Sb=${sb}: identical frames, orders, counters, broadcasts, snapshots, state`, () => {
      const res = runScenario(sb, 1000 + sb, 4000);
      expect(res.accepted).toBeGreaterThan(1000);
      expect(res.late).toBeGreaterThan(10);
      expect(res.kicks).toBeGreaterThan(5);
    });
  }
});

describe('assignClientFrame (official Mh arithmetic)', () => {
  const mk = (sb = 2) => {
    const s = new Sequencer(createRoomState(), { broadcast() {}, hasConnections: () => false }, { inputDelayFrames: sb });
    s.frame = 100;
    return s;
  };
  it('clamps to [cur, cur+20] for non-delay events', () => {
    const s = mk();
    const c = new SequencerClient(1);
    expect(s.assignClientFrame(c, false, 0)).toBe(100);
    expect(s.assignClientFrame(c, false, 105)).toBe(105);
    expect(s.assignClientFrame(c, false, 500)).toBe(120);
    expect(c.lastFrame).toBe(0); // non-delay events don't touch the per-client state
  });
  it('delay: on time kept; > Sb+3 late re-stamped at cur+Sb; monotonic per client', () => {
    const s = mk();
    const c = new SequencerClient(1);
    expect(s.assignClientFrame(c, true, 102)).toBe(102); // on time (cur+Sb)
    expect(s.assignClientFrame(c, true, 110)).toBe(110); // early: kept
    expect(s.assignClientFrame(c, true, 103)).toBe(110); // monotonic
    const c2 = new SequencerClient(2);
    expect(s.assignClientFrame(c2, true, 96)).toBe(102); // 6 late (> Sb+3): cur+Sb
    expect(s.assignClientFrame(c2, true, 101)).toBe(102); // monotonic
  });
  it('delay: chronic lateness (mean < -0.85) removes the early-frame shortcut', () => {
    const s = mk();
    const c = new SequencerClient(1);
    // 7 samples of -2 (clamped to -Sb): mean = -14/15 < -0.85 after the 7th
    for (let i = 0; i < 6; i++) expect(s.assignClientFrame(c, true, 100)).toBe(100);
    expect(c.lateness.mean).toBeCloseTo(-12 / 15);
    expect(s.assignClientFrame(c, true, 100)).toBe(102);
    expect(c.lateness.mean).toBeLessThan(-0.85);
  });
  it('MovingAverage = official $a', () => {
    const { Wa: _w } = officialInternals();
    const m = new MovingAverage(3);
    m.push(3);
    m.push(-1);
    expect(m.mean).toBe(2 / 3);
    m.push(1);
    m.push(2); // overwrites 3
    expect(m.mean).toBe(2 / 3);
  });
});

describe('Sequencer runner details', () => {
  it('idle fast path == frame-by-frame (counters, queued events applied at their frame)', () => {
    const mkSeq = () => new Sequencer(createRoomState(), { broadcast() {}, hasConnections: () => true });
    const a = mkSeq();
    const b = mkSeq();
    b.onFrameStepped = () => {}; // disables the fast path
    for (const s of [a, b]) {
      s.hostEvent(JoinRoomEvent.create(1, 'x', 'uy', null));
      s.hostEvent(PauseResumeGameEvent.create(true)); // delay event -> queued at +2
      expect(s.queue.length).toBe(1);
      s.advance(1000);
    }
    expect([a.frame, a.eventsInFrame, a.eventCounter, a.queue.length]).toEqual([b.frame, b.eventsInFrame, b.eventCounter, b.queue.length]);
    expect(a.eventCounter).toBe(2);
  });
  it('a hook that throws does not abort the loop', () => {
    const errors: unknown[] = [];
    const s = new Sequencer(createRoomState(), { broadcast() {}, hasConnections: () => false });
    s.onError = (e) => errors.push(e);
    s.rs.hooks.onPlayerJoin = () => {
      throw new Error('boom');
    };
    s.hostEvent(JoinRoomEvent.create(1, 'x', 'uy', null));
    s.hostEvent(JoinRoomEvent.create(2, 'y', 'uy', null));
    expect(s.rs.players.length).toBe(2);
    expect(s.eventsInFrame).toBe(2);
    expect(errors.length).toBe(2);
  });
  it('EventType sanity', () => {
    expect(EventType.SendInput).toBe(3);
  });
});
