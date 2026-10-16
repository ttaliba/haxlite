/**
 * Shared process-wide clock (src/host/clock.ts): wake-up counts with real
 * timers and a fake transport (no network).
 *  - idle room (no clients, no game): zero wake-ups;
 *  - game + clients: heartbeats keep their exact 7-frame spacing and the
 *    process wakes ~2 times per heartbeat (default maxWakeFrames 4: ~17/s,
 *    official host 20/s), or once per heartbeat with maxWakeFrames Infinity;
 *  - several rooms share ONE timer, the process-wide 60 Hz grid and the
 *    absolute heartbeat grid (they wake together);
 *  - a paused game only wakes for heartbeats;
 *  - frames are simulated one by one (onGameTick once per frame, in batches).
 */
import { describe, expect, it } from 'vitest';
import { HostRoom, createHostRoomState, type HostRoomOptions } from '../../src/host/index.js';
import { TIMER_SLACK_MS, hostClock } from '../../src/host/clock.js';
import { Reader } from '../../src/codec/index.js';
import type { HostTransport } from '../../src/net/index.js';
import { EventType } from '../../src/protocol.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Sent {
  at: number;
  channel: number;
  data: Uint8Array;
}

function fakeTransport(): { transport: HostTransport; sent: Sent[]; join(name: string): Any } {
  const sent: Sent[] = [];
  const roomInfo: Any = { players: 0 };
  let nextId = 1;
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
    send(_peer: Any, channel: number, data: Uint8Array) {
      sent.push({ at: performance.now(), channel, data: data.slice() });
      return true;
    },
    broadcastTo(targets: Any[], channel: number, data: Uint8Array) {
      for (const x of targets) t.send(x.peer, channel, data);
    },
    kick: () => null,
    close() {},
  };
  return {
    transport: t as HostTransport,
    sent,
    join(name: string) {
      const peer = { id: nextId++, state: 'joined', playerId: -1, userData: null };
      t.connectionCount++;
      t.onPeerJoin(peer, { name, flag: 'ar', avatar: null, auth: null, conn: '7F000001' });
      return peer;
    },
  };
}

function makeRoom(opts: Partial<HostRoomOptions> = {}) {
  const f = fakeTransport();
  const host = new HostRoom({ transport: f.transport, state: createHostRoomState({ noPlayer: true }), ...opts });
  host.onError = (e) => {
    throw e;
  };
  host.start();
  return { host, ...f };
}

/** Share of heartbeat frames on the room's absolute heartbeat grid (every 7 frames of the process grid). */
function onGridShare(host: HostRoom, hb: number[]): number {
  const base = (host as Any).gridBase as number;
  return hb.filter((f) => (base + f) % 7 === 0).length / hb.length;
}

/** Frames of the heartbeats (msg 3) sent to the first client. */
function heartbeatFrames(sent: Sent[]): number[] {
  return sent.filter((s) => s.data[0] === 3).map((s) => new Reader(s.data, 1).u32());
}

describe('shared host clock', () => {
  it('timer slack: 1 ms on Node (early fires), 0 on Bun', () => {
    expect(TIMER_SLACK_MS).toBe((process.versions as { bun?: string }).bun !== undefined ? 0 : 1);
  });

  it('idle room (no clients, no game): zero wake-ups', async () => {
    const { host } = makeRoom();
    const w0 = hostClock.wakeups;
    await sleep(300);
    expect(hostClock.wakeups - w0).toBe(0);
    host.stop();
    expect(hostClock.size).toBe(0);
  });

  it('game + 1 client: exact heartbeat frames, ~2 wake-ups per heartbeat (fewer than the official 20/s)', async () => {
    const { host, sent, join } = makeRoom();
    join('a');
    host.setPlayerTeam(1, 1);
    host.startGame();
    let ticks = 0;
    host.state.hooks.onGameTick = () => ticks++;
    await sleep(50);
    const w0 = hostClock.wakeups;
    const t0 = performance.now();
    const f0 = host.frame;
    ticks = 0;
    const n0 = sent.length;
    await sleep(1500);
    host.update();
    const perS = ((hostClock.wakeups - w0) * 1000) / (performance.now() - t0);
    const hb = heartbeatFrames(sent.slice(n0));
    host.stop();
    // ~8.6 heartbeats/s × 2 = ~17.1/s (+ the 3 s Ping event, rare early fires)
    expect(perS).toBeGreaterThan(14);
    expect(perS).toBeLessThan(20);
    const gaps = hb.slice(1).map((f, i) => f - hb[i]!);
    expect(gaps.length).toBeGreaterThan(10);
    // on the absolute grid unless a wake-up was more than a frame late (loaded machine; a late
    // heartbeat does not shift the next one)
    expect(onGridShare(host, hb)).toBeGreaterThan(0.8);
    // every frame simulated exactly once
    expect(ticks).toBe(host.frame - f0);
  });

  it('maxWakeFrames = Infinity: one wake-up per heartbeat', async () => {
    const { host, sent, join } = makeRoom({ maxWakeFrames: Infinity });
    join('a');
    host.startGame();
    await sleep(50);
    const w0 = hostClock.wakeups;
    const t0 = performance.now();
    const n0 = sent.length;
    await sleep(1500);
    const perS = ((hostClock.wakeups - w0) * 1000) / (performance.now() - t0);
    const hb = heartbeatFrames(sent.slice(n0));
    host.stop();
    expect(perS).toBeGreaterThan(7);
    expect(perS).toBeLessThan(10.5);
    expect(hb.length).toBeGreaterThan(10);
    expect(onGridShare(host, hb)).toBeGreaterThan(0.8);
  });

  it('game without clients still runs (bounded catch-up) and stops waking when the game stops', async () => {
    const { host } = makeRoom({ maxWakeFrames: 3 });
    let ticks = 0;
    host.state.hooks.onGameTick = () => ticks++;
    host.startGame();
    await sleep(300);
    expect(ticks).toBeGreaterThan(10); // ran without any message
    host.stopGame();
    await sleep(20);
    const w0 = hostClock.wakeups;
    await sleep(200);
    expect(hostClock.wakeups - w0).toBe(0);
    host.stop();
  });

  it('paused game: one wake-up per heartbeat; the unpause countdown runs without messages', async () => {
    const { host, sent, join } = makeRoom();
    join('a');
    host.setPlayerTeam(1, 1);
    host.startGame();
    let ticks = 0;
    host.state.hooks.onGameTick = () => ticks++;
    host.pauseGame(true);
    await sleep(100);
    host.update();
    expect(host.state.gameState!.pauseGameTickCounter).toBe(120);
    ticks = 0;
    const w0 = hostClock.wakeups;
    const t0 = performance.now();
    const n0 = sent.length;
    await sleep(1200);
    const perS = ((hostClock.wakeups - w0) * 1000) / (performance.now() - t0);
    // heartbeats only (~8.6/s) instead of ~17/s
    expect(perS).toBeGreaterThan(6);
    expect(perS).toBeLessThan(11);
    const hb = heartbeatFrames(sent.slice(n0));
    expect(onGridShare(host, hb)).toBeGreaterThan(0.8);
    expect(ticks).toBe(0);
    host.pauseGame(false); // queued Sb frames ahead: the clock must wake for it
    const f0 = host.frame;
    await sleep(2500); // 119 countdown frames (~2 s), then ticks again
    host.update();
    const gs = host.state.gameState!;
    expect(gs.pauseGameTickCounter).toBe(0);
    // unpause applied at f0 + 2, then 119 countdown steps; every later frame ticked once
    expect(ticks).toBe(host.frame - f0 - 2 - 119);
    host.stop();
  });

  it('paused game without clients: no wake-ups until the queued unpause', async () => {
    const { host } = makeRoom();
    let ticks = 0;
    host.state.hooks.onGameTick = () => ticks++;
    host.startGame();
    host.pauseGame(true);
    await sleep(100);
    const w0 = hostClock.wakeups;
    await sleep(300);
    expect(hostClock.wakeups - w0).toBe(0);
    host.pauseGame(false);
    await sleep(2400);
    expect(ticks).toBeGreaterThan(5); // ran again with no message and no update()
    host.stop();
  });

  it('real clock: frame 0 and every wake-up sit on the process-wide 60 Hz grid', async () => {
    const onGrid = (t: number) => Math.abs(t * 0.06 - Math.round(t * 0.06)) < 1e-6;
    const rooms = [makeRoom({ pingIntervalMs: 1000 })];
    await sleep(7);
    rooms.push(makeRoom({ pingIntervalMs: 1000 }));
    try {
      rooms.forEach((r) => {
        r.join('a');
        r.host.startGame();
        const start = (r.host as Any).startTime as number;
        expect(onGrid(start)).toBe(true);
        expect(r.host.frame).toBeLessThanOrEqual(1);
        expect(onGrid((r.host as Any).nextPingAt)).toBe(true);
      });
      // the rooms started on different boundaries (7 ms apart: same or next frame) but share the grid
      const at = () => rooms.map((r) => (r.host as Any).clockEntry.wakeAt as number);
      for (let i = 0; i < 20; i++) {
        for (const t of at()) expect(onGrid(t)).toBe(true);
        await sleep(9);
      }
      for (const r of rooms) expect(onGrid((r.host as Any).nextPingAt)).toBe(true);
    } finally {
      for (const r of rooms) r.host.stop();
    }
  });

  it('injected clock: frame 0 at construction time (no grid)', () => {
    let t = 1234.5;
    const { host } = makeRoom({ now: () => t });
    expect((host as Any).startTime).toBe(1234.5);
    t += 1000 / 60 - 0.01;
    host.update();
    expect(host.frame).toBe(0);
    t += 0.02;
    host.update();
    expect(host.frame).toBe(1);
    host.stop();
  });

  it('rooms created at different times heartbeat on the same grid frames and share the wake-ups', async () => {
    const rooms: ReturnType<typeof makeRoom>[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        const r = makeRoom();
        r.join('a');
        r.host.startGame();
        rooms.push(r);
        await sleep(5 + 3 * i);
      }
      await sleep(100);
      const w0 = hostClock.wakeups;
      const t0 = performance.now();
      const n0 = rooms.map((r) => r.sent.length);
      await sleep(1200);
      const perS = ((hostClock.wakeups - w0) * 1000) / (performance.now() - t0);
      // the five rooms wake together: ~17/s for the process, not 5 × 17
      expect(perS).toBeLessThan(21);
      rooms.forEach((r, i) => {
        const base = (r.host as Any).gridBase as number;
        const hb = heartbeatFrames(r.sent.slice(n0[i]));
        expect(hb.length).toBeGreaterThan(5);
        // on the process-wide heartbeat grid (later if a wake-up was more than a frame late)
        const on = hb.filter((f) => (base + f) % 7 === 0).length;
        expect(on / hb.length).toBeGreaterThan(0.8);
      });
    } finally {
      for (const r of rooms) r.host.stop();
    }
  });

  it('rooms share one timer and keep their own cadence', async () => {
    const rooms = [makeRoom(), makeRoom(), makeRoom()];
    for (const r of rooms) {
      r.join('a');
      r.host.startGame();
    }
    expect(hostClock.size).toBe(3);
    await sleep(600);
    for (const r of rooms) {
      const hb = heartbeatFrames(r.sent);
      expect(hb.length).toBeGreaterThan(3);
      expect(hb.slice(2).every((f, i) => f > hb[i + 1]!)).toBe(true);
    }
    // only one Node timer is armed for the three rooms
    expect((hostClock as Any).timer).not.toBeNull();
    for (const r of rooms) r.host.stop();
    expect(hostClock.size).toBe(0);
    expect((hostClock as Any).timer).toBeNull();
  });

  it('heartbeatFrames / checksumIntervalFrames: integers in range (option and setter)', () => {
    const f = fakeTransport();
    const mk = (o: Partial<HostRoomOptions>) => new HostRoom({ transport: f.transport, state: createHostRoomState({ noPlayer: true }), now: () => 0, ...o });
    for (const v of [0, -1, 1.5, NaN, Infinity, 601]) expect(() => mk({ heartbeatFrames: v })).toThrow(RangeError);
    for (const v of [0, 0.5, NaN, Infinity, 2 ** 20 + 1]) expect(() => mk({ checksumIntervalFrames: v })).toThrow(RangeError);
    const host = mk({ heartbeatFrames: 600, checksumIntervalFrames: 1 });
    for (const v of [0, 2.5, Infinity, 601]) expect(() => (host.heartbeatFrames = v)).toThrow(RangeError);
    expect(() => (host.checksumIntervalFrames = 0)).toThrow(RangeError);
    expect(host.heartbeatFrames).toBe(600);
    expect(host.checksumIntervalFrames).toBe(1);
    host.heartbeatFrames = 1;
    host.checksumIntervalFrames = 2 ** 20;
    expect([host.heartbeatFrames, host.checksumIntervalFrames]).toEqual([1, 2 ** 20]);
  });

  it('Ping event every pingIntervalMs while clients are connected', async () => {
    const { host, sent, join } = makeRoom({ pingIntervalMs: 100 });
    join('a');
    await sleep(450);
    host.stop();
    const pings = sent.filter((s) => s.data[0] === 2 && isPing(s.data));
    expect(pings.length).toBeGreaterThanOrEqual(3);
    expect(pings.length).toBeLessThanOrEqual(5);
  });
});

function isPing(m: Uint8Array): boolean {
  const r = new Reader(m, 1);
  r.u32();
  r.varUint();
  r.u16();
  r.u32();
  return r.u8() === EventType.Ping;
}
