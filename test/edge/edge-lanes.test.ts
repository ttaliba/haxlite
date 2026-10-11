/**
 * haxlite Edge `ro` lanes (AuthFlag.RoLanes) and idle timers: per-player `ro`
 * order over several tunnel channels (chats, CheckConsistency multicasts,
 * kick notice + in-band close), interop with a host that does not ask for
 * lanes, and no housekeeping timers while there is nothing to sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { nodeHaxballFor } from '../fake-master/node-haxball.js';
import { E2E, shutdownAll, waitFor, withTimeout, type Any } from '../host/harness.js';
import { EdgeServer } from '../../src/edge/index.js';
import { EDGE_RO_LANES, EdgePeerBackend, HostTransport, roLaneChannel } from '../../src/net/index.js';
import { edgeConfig, makeKey, startEdge } from './harness.js';

let master: FakeMaster;
let nh: Any;
const key = makeKey('lanes');
let edge: EdgeServer;

beforeAll(async () => {
  master = await FakeMaster.start();
  nh = nodeHaxballFor(master);
  edge = await startEdge([key]);
});

afterAll(async () => {
  await edge?.close();
  await master?.close();
  await shutdownAll();
});

const backendOf = (e: E2E) => e.transport.backend as EdgePeerBackend;

describe('haxlite Edge ro lanes', () => {
  it('lane mapping', () => {
    expect(roLaneChannel(5, 1)).toBe(0);
    expect(roLaneChannel(EDGE_RO_LANES, EDGE_RO_LANES)).toBe(0);
    expect(roLaneChannel(1, EDGE_RO_LANES)).toBe(3);
    expect(roLaneChannel(EDGE_RO_LANES - 1, EDGE_RO_LANES)).toBe(EDGE_RO_LANES + 1);
  });

  for (const lanes of [true, false]) {
    it(`${lanes ? 'with' : 'without'} lanes: per-player ro order, game converges, kick notice arrives`, async () => {
      const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, key, { roLanes: lanes }) } });
      try {
        expect(backendOf(e).stats().roLanes).toBe(lanes ? EDGE_RO_LANES : 1);
        const chats: string[] = [];
        e.host.state.hooks.onPlayerChatFilter = (p, m) => {
          chats.push(`${p.name}:${m}`);
          return true;
        };
        const cs = [await e.join('a'), await e.join('b'), await e.join('c')];
        e.host.setPlayerTeam(1, 1);
        e.host.setPlayerTeam(2, 2);
        e.host.setPlayerTeam(3, 1);
        e.host.startGame();
        const f0 = e.host.frame;
        // client events (chat, inputs) travel on `ro`: interleave all three players
        for (let i = 0; i < 10; i++) {
          cs.forEach((c, k) => {
            c.room.sendChat(`m${i}`);
            c.room.setKeyState((i + k) & 1 ? 16 : 2);
          });
          await new Promise((r) => setTimeout(r, 30));
        }
        // > 1 CheckConsistency (ro multicast, split per lane)
        await waitFor(() => e.host.frame > f0 + 400, 15_000, 'frames');
        await waitFor(() => chats.length === 30, 5000, 'chats');
        for (const n of ['a', 'b', 'c']) {
          expect(chats.filter((c) => c.startsWith(`${n}:`))).toEqual(Array.from({ length: 10 }, (_, i) => `${n}:m${i}`));
        }
        for (const c of cs) {
          expect(c.closeError).toBeNull();
          expect(c.mismatches).toEqual([]);
          expect(c.compared).toBeGreaterThan(10);
        }
        // kick: notice on the player's ro lane, then the in-band PeerClose on the same lane
        e.host.kickPlayer(2, 'bye', false);
        const err = await withTimeout(cs[1]!.closed, 10_000, 'kicked');
        expect(err.code).toBe(e.nh.Errors.ErrorCodes.KickedNow);
        await waitFor(() => e.host.state.players.length === 3, 5000, 'host saw the kick');
        expect(e.errors).toEqual([]);
      } finally {
        await e.close();
      }
    }, 90_000);
  }
});

describe('idle timers', () => {
  it('HostTransport sweeps only while there is something to sweep; the edge keep-alive only with sessions', async () => {
    const t = new HostTransport({ token: 'thr1.idle', masterUrl: master.httpBase, iceServers: [] });
    const sweepTimer = () => (t as Any).sweepTimer as NodeJS.Timeout | null;
    let link: string | null = null;
    t.onRoomLink = (l) => (link = l);
    t.start();
    try {
      await waitFor(() => link !== null, 5000, 'room link');
      expect(sweepTimer()).toBeNull();
      // a negotiation arms it; once everything is gone the next sweep disarms it
      const e = await E2E.start({ shared: { master, nh }, transport: { sweepIntervalMs: 50 } });
      try {
        const c = await e.join('x');
        expect((e.transport as Any).sweepTimer).not.toBeNull();
        c.room.leave();
        await waitFor(() => (e.transport as Any).sweepTimer === null, 5000, 'sweep disarmed');
      } finally {
        await e.close();
      }
    } finally {
      t.stop();
    }
    // the shared edge had sessions (lane tests): its keep-alive stops with the last one
    await waitFor(() => edge.stats().sessions === 0, 5000, 'sessions closed');
    expect((edge as Any).keepAliveTimer).toBeNull();
    const fresh = await startEdge([makeKey('idle')]);
    try {
      expect((fresh as Any).keepAliveTimer).toBeNull();
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
