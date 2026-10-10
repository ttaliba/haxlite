/**
 * Shared process-wide clock (src/host/clock.ts): wake-up counts with real
 * timers and a fake transport (no network).
 *  - idle room (no clients, no game): zero wake-ups;
 *  - game + clients: heartbeats keep their exact 7-frame spacing and the
 *    process wakes ~2 times per heartbeat (default maxWakeFrames 4: ~17/s,
 *    official host 20/s), or once per heartbeat with maxWakeFrames Infinity;
 *  - several rooms share ONE timer;
 *  - frames are simulated one by one (onGameTick once per frame, in batches).
 */
import { describe, expect, it } from 'vitest';
import { HostRoom, createHostRoomState, type HostRoomOptions } from '../../src/host/index.js';
import { hostClock } from '../../src/host/clock.js';
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

/** Frames of the heartbeats (msg 3) sent to the first client. */
function heartbeatFrames(sent: Sent[]): number[] {
  return sent.filter((s) => s.data[0] === 3).map((s) => new Reader(s.data, 1).u32());
}

describe('shared host clock', () => {
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
    expect(gaps.every((g) => g === 7)).toBe(true);
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
    expect(hb.slice(1).every((f, i) => f - hb[i]! === 7)).toBe(true);
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
      expect(hb.slice(2).every((f, i) => f - hb[i + 1]! === 7)).toBe(true);
    }
    // only one Node timer is armed for the three rooms
    expect((hostClock as Any).timer).not.toBeNull();
    for (const r of rooms) r.host.stop();
    expect(hostClock.size).toBe(0);
    expect((hostClock as Any).timer).toBeNull();
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
