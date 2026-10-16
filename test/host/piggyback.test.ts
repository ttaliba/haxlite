/**
 * Heartbeats on the absolute grid + piggyback (bundling backends). Periodic
 * heartbeats leave on grid frames ((gridBase + frame) % heartbeatFrames ===
 * 0; gridBase = 0 with an injected clock). After a client event is
 * broadcast inside a cork()/uncork() scope, a heartbeat whose grid point is
 * within floor((heartbeatFrames - 1) / 3) frames leaves in the same scope
 * and covers that grid point. Gaps stay within heartbeatFrames ± lead
 * (official host: 7..9 frames); without a bundling backend the cadence is
 * the exact grid. Deterministic: injected clock, explicit catch-ups.
 */
import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/codec/index.js';
import { encodeEvent, SendInputEvent } from '../../src/room/index.js';
import { HostRoom, createHostRoomState } from '../../src/host/index.js';
import type { HostTransport } from '../../src/net/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Sent {
  scope: number;
  data: Uint8Array;
}

function setup(bundling: boolean, heartbeatFrames = 7) {
  const sent: Sent[] = [];
  let scope = 0;
  let depth = 0;
  const roomInfo: Any = { players: 0 };
  const t: Any = {
    connectionCount: 0,
    bans: { remove() {}, clear() {} },
    start() {},
    stop() {},
    getRoomInfo: () => roomInfo,
    setRoomInfo: (i: Any) => Object.assign(roomInfo, i),
    send(_peer: Any, _channel: number, data: Uint8Array) {
      sent.push({ scope: depth > 0 ? scope : -1, data: data.slice() });
      return true;
    },
    broadcastTo(targets: Any[], channel: number, data: Uint8Array) {
      for (const x of targets) t.send(x.peer, channel, data);
    },
    kick: () => null,
    close() {},
  };
  if (bundling) {
    t.backend = {
      cork() {
        if (depth++ === 0) scope++;
      },
      uncork() {
        depth--;
      },
    };
  }
  let now = 0;
  const host = new HostRoom({ transport: t as HostTransport, state: createHostRoomState({ noPlayer: true }), heartbeatFrames, pingIntervalMs: 1e9, checksumIntervalFrames: 1e6, now: () => now });
  host.onError = (e) => {
    throw e;
  };
  host.start();
  const peer = { id: 1, state: 'joined', playerId: -1, userData: null };
  t.connectionCount = 1;
  t.onPeerJoin(peer, { name: 'a', flag: 'ar', avatar: null, auth: null, conn: '7F000001' });
  let seq = 0;
  return {
    host,
    sent,
    setFrame(f: number) {
      now = f / 0.06 + 0.001;
    },
    input(requested: number, input: number) {
      const w = new Writer(32);
      w.u8(1);
      w.u32(requested);
      w.u32(seq++);
      w.bytes(encodeEvent(SendInputEvent.create(input)));
      t.onPeerMessage(peer, w.copyBytes());
    },
  };
}

/** Heartbeats (msg 3): frame and the scope they left in. */
function heartbeats(sent: Sent[]): { frame: number; scope: number }[] {
  return sent.filter((s) => s.data[0] === 3).map((s) => ({ frame: new Reader(s.data, 1).u32(), scope: s.scope }));
}

function run(bundling: boolean, heartbeatFrames = 7) {
  const r = setup(bundling, heartbeatFrames);
  r.host.startGame();
  // a client input every 3rd frame (~20/s), clock catch-ups at every frame otherwise
  for (let f = 1; f <= 600; f++) {
    r.setFrame(f);
    if (f % 3 === 0) r.input(f + 2, f & 15);
    else r.host.update();
  }
  r.host.stop();
  const eventScopes = new Set(r.sent.filter((s) => s.data[0] === 2).map((s) => s.scope));
  const hb = heartbeats(r.sent);
  const gaps = hb.slice(1).map((h, i) => h.frame - hb[i]!.frame);
  const withEvent = hb.filter((h) => eventScopes.has(h.scope)).length;
  return { hb, gaps, withEvent };
}

describe('heartbeat grid + piggyback', () => {
  it('bundling backend: heartbeats ride with events up to 2 frames before their grid point', () => {
    const { hb, gaps, withEvent } = run(true);
    expect(hb.length).toBeGreaterThan(70);
    // on a grid point or up to floor((7 - 1) / 3) = 2 frames before one
    expect(hb.filter((h) => h.frame > 0 && ![0, 5, 6].includes(h.frame % 7))).toEqual([]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(7 + 2);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(7 - 2);
    // one heartbeat per grid period: the piggybacked one covers its grid point
    expect(hb.length).toBeLessThanOrEqual(Math.ceil(600 / 7) + 1);
    // with an event every 3 frames, every heartbeat rides with one
    expect(withEvent / hb.length).toBeGreaterThan(0.95);
  });

  it('heartbeatFrames 4: lead 1, gaps 3..5', () => {
    const { gaps } = run(true, 4);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3);
  });

  it('no bundling backend: exact grid cadence', () => {
    const { hb, gaps } = run(false);
    expect(gaps.filter((g) => g !== 7)).toEqual([]);
    expect(hb.filter((h) => h.frame % 7 !== 0)).toEqual([]);
  });
});
