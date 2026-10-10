/**
 * haxlite Edge: tunnel behaviours (offline, FakeMaster + EdgeServer + host +
 * node-haxball clients): bad key, WebSocket data plane, two hosts on one
 * edge, tunnel drop + reconnect, edge flood limiter, stats endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { nodeHaxballFor } from '../fake-master/node-haxball.js';
import { E2E, shutdownAll, waitFor, withTimeout, type Any } from '../host/harness.js';
import { EdgeServer } from '../../src/edge/index.js';
import { EdgeError, EdgePeerBackend, HostTransport } from '../../src/net/index.js';
import { HBInit } from '../../src/api/index.js';
import { EDGE_IP, HOST_IP, edgeConfig, inspectClientSignaling, makeKey, selectedRemote, startEdge } from './harness.js';

let master: FakeMaster;
let nh: Any;
const clientPcs: Any[] = [];
const keyA = makeKey('alice');
const keyB = makeKey('bob');
let edge: EdgeServer;

beforeAll(async () => {
  master = await FakeMaster.start();
  master.clientMessages = [];
  nh = nodeHaxballFor(master, { onPeerConnection: (pc) => clientPcs.push(pc) });
  edge = await startEdge([keyA, keyB], { limits: { maxSessionsPerKey: 3 } });
});

afterAll(async () => {
  await edge?.close();
  await master?.close();
  await shutdownAll();
});

function backendOf(e: E2E): EdgePeerBackend {
  return e.transport.backend as EdgePeerBackend;
}

describe('haxlite Edge tunnel', () => {
  it('rejects a bad key (fatal EdgeError, no room registered)', async () => {
    const t = new HostTransport({
      token: 'thr1.test',
      masterUrl: master.httpBase,
      edge: edgeConfig(edge, { ...keyA, key: `${keyA.id}:wrong-secret-0123456789` }),
    });
    const errors: Error[] = [];
    t.onError = (e) => errors.push(e);
    const roomsBefore = master.rooms.size;
    t.start();
    try {
      await waitFor(() => errors.length > 0, 5000, 'auth error');
      expect(errors[0]).toBeInstanceOf(EdgeError);
      expect((errors[0] as EdgeError).kind).toBe('auth');
      expect((errors[0] as EdgeError).fatal).toBe(true);
      expect(master.rooms.size).toBe(roomsBefore); // signaling never started
      expect(edge.stats().authFailures).toBeGreaterThanOrEqual(1);
      // unknown key id: same failure
      const t2 = new HostTransport({ token: 'x', masterUrl: master.httpBase, edge: edgeConfig(edge, makeKey('mallory')) });
      const errs2: Error[] = [];
      t2.onError = (e) => errs2.push(e);
      t2.start();
      await waitFor(() => errs2.length > 0, 5000, 'auth error 2');
      expect((errs2[0] as EdgeError).kind).toBe('auth');
      t2.stop();
    } finally {
      t.stop();
    }
    // HBInit rejects at once on a fatal edge error
    await expect(
      HBInit({ token: 'thr1.test', geo: { code: 'ar', lat: 0, lon: 0 }, haxlite: { masterUrl: master.httpBase, shutdownWebRtcOnLastStop: false, edge: edgeConfig(edge, { ...keyB, key: 'bob:nope-nope-nope-nope' }) } }),
    ).rejects.toThrow(/rejected the key/);
  });

  it('HBInit with haxlite.edge: room works through the edge, edgeStats()', async () => {
    const room = await HBInit({
      roomName: 'edge room',
      noPlayer: true,
      token: 'thr1.test',
      geo: { code: 'ar', lat: 0, lon: 0 },
      haxlite: { masterUrl: master.httpBase, shutdownWebRtcOnLastStop: false, edge: edgeConfig(edge, keyB) },
    });
    try {
      const joined: Any[] = [];
      room.onPlayerJoin = (p) => joined.push(p);
      const roomId = room.haxlite.roomLink!.split('c=')[1]!;
      const [, authObj] = (await nh.Utils.generateAuth()) as [string, Any];
      let open: Any = null;
      nh.Room.join(
        { id: roomId, password: null, authObj },
        { storage: { player_name: 'viaHBInit', avatar: null, geo: { lat: 0, lon: 0, flag: 'uy' } }, onOpen: (r: Any) => (open = r) },
      );
      await waitFor(() => open !== null && joined.length === 1, 15_000, 'HBInit join');
      expect(joined[0].name).toBe('viaHBInit');
      const info = room.haxlite.getPlayerConnection(joined[0].id)!;
      expect(info.remoteAddress).toMatch(/^127\./);
      const st = room.haxlite.edgeStats()!;
      expect(st.state).toBe('ready');
      expect(st.dataPlane).toBe('webrtc');
      expect(st.peers).toBe(1);
      expect(st.rttMs === null || st.rttMs >= 0).toBe(true);
      open.leave();
    } finally {
      await room.haxlite.stop();
    }
  }, 60_000);

  it('falls back to the WebSocket data plane when the UDP tunnel does not come up', async () => {
    const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, keyA, { dataPlaneTimeoutMs: 1 }) } });
    try {
      expect(backendOf(e).stats().dataPlane).toBe('ws');
      const c = await e.join('fallback');
      await waitFor(() => e.host.state.players.length === 2, 5000, 'joined');
      expect(c.closeError).toBeNull();
      expect(e.errors).toEqual([]);
    } finally {
      await e.close();
    }
  }, 60_000);

  it('WebSocket data plane: join, play, chat, leave', async () => {
    const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, keyA, { dataPlane: 'ws' }) } });
    try {
      expect(backendOf(e).stats().dataPlane).toBe('ws');
      const chats: string[] = [];
      e.host.state.hooks.onPlayerChatFilter = (_p, m) => {
        chats.push(m);
        return true;
      };
      const a = await e.join('wsA');
      const b = await e.join('wsB');
      e.host.setPlayerTeam(1, 1);
      e.host.setPlayerTeam(2, 2);
      e.host.startGame();
      const f0 = e.host.frame;
      a.room.sendChat('hello over ws');
      for (let i = 0; i < 20; i++) {
        a.room.setKeyState(i & 1 ? 16 : 1);
        b.room.setKeyState(i & 1 ? 4 : 8);
        await new Promise((r) => setTimeout(r, 50));
      }
      await waitFor(() => e.host.frame > f0 + 120, 10_000, 'frames');
      await new Promise((r) => setTimeout(r, 300));
      expect(chats).toContain('hello over ws');
      for (const c of [a, b]) {
        expect(c.closeError).toBeNull();
        expect(c.mismatches).toEqual([]);
        expect(c.compared).toBeGreaterThan(10);
      }
      const conn = e.host.getConnection(1)!;
      expect(conn.peer.remoteAddress).not.toBeNull();
      expect(backendOf(e).stats().messagesIn).toBeGreaterThan(20);
      b.room.leave();
      await waitFor(() => e.host.state.players.length === 2, 5000, 'leave');
    } finally {
      await e.close();
    }
  }, 60_000);

  it('two hosts (two keys) on one edge, isolated', async () => {
    const e1 = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, keyA) } });
    const e2 = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, keyB) } });
    try {
      expect(backendOf(e1).stats().dataPlane).toBe('webrtc');
      expect(backendOf(e2).stats().dataPlane).toBe('webrtc');
      const c1 = await e1.join('one');
      const c2 = await e2.join('two');
      await waitFor(() => c1.room.players.length === 2 && c2.room.players.length === 2, 5000, 'lists');
      expect(e1.host.state.players.map((p) => p.name)).toEqual(['Host', 'one']);
      expect(e2.host.state.players.map((p) => p.name)).toEqual(['Host', 'two']);
      c1.room.sendChat('room one only');
      await new Promise((r) => setTimeout(r, 300));
      const stats = edge.stats();
      const ka = stats.keys.find((k) => k.id === 'alice')!;
      const kb = stats.keys.find((k) => k.id === 'bob')!;
      expect(ka.sessions).toBe(1);
      expect(kb.sessions).toBe(1);
      expect(ka.peers).toBe(1);
      expect(kb.peers).toBe(1);
      expect(stats.sessions).toBe(2);
      // the stats endpoint serves the same JSON
      const res = await fetch(`http://${EDGE_IP}:${edge.address.port}/stats`);
      const json = (await res.json()) as Any;
      expect(json.sessions).toBe(2);
      expect(c1.closeError).toBeNull();
      expect(c2.closeError).toBeNull();
    } finally {
      await e1.close();
      await e2.close();
    }
    await waitFor(() => edge.stats().sessions === 0, 5000, 'sessions closed');
  }, 60_000);

  it('tunnel drop: players are lost, the tunnel reconnects quickly, new joins work', async () => {
    const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, keyA, { reconnectMinMs: 100 }) } });
    const states: string[] = [];
    e.transport.onBackendState = (s) => states.push(s);
    const leaves: string[] = [];
    e.host.onPlayerLeave = (p) => leaves.push(p.name ?? '');
    try {
      const a = await e.join('dropA');
      await waitFor(() => e.host.state.players.length === 2, 5000, 'joined');
      // kill the tunnel from the edge side (as a crash/network cut would)
      const sessions = (edge as Any).sessions as Set<Any>;
      expect(sessions.size).toBe(1);
      const t0 = performance.now();
      for (const s of sessions) (s as Any).ws.terminate();
      await waitFor(() => leaves.includes('dropA'), 5000, 'player dropped');
      expect(states[0]).toBe('down');
      await waitFor(() => states.includes('ready'), 5000, 'reconnected');
      const reconnectMs = performance.now() - t0;
      expect(reconnectMs).toBeLessThan(3000);
      await withTimeout(a.closed, 15_000, 'client noticed');
      expect(backendOf(e).stats().sessions).toBe(2);
      const b = await e.join('dropB');
      await waitFor(() => e.host.state.players.some((p) => p.name === 'dropB'), 5000, 'new join');
      expect(b.closeError).toBeNull();
      expect(e.errors).toEqual([]);
    } finally {
      await e.close();
    }
  }, 60_000);

  it('edge-side flood limiter: the host kicks with "Bad actor"', async () => {
    const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, keyA) } });
    try {
      const kicks: [string, string][] = [];
      e.host.onPlayerKicked = (p, reason) => kicks.push([p.name ?? '', reason]);
      const victim = await e.join('flooder', { sample: false });
      const other = await e.join('bystander', { sample: false });
      await waitFor(() => other.room.players.length === 3, 5000, 'list');
      // 300 messages at once: the edge's bucket (100) runs out
      for (let i = 0; i < 300; i++) victim.room.sendChat(`spam ${i}`);
      await waitFor(() => kicks.length > 0, 10_000, 'bad actor');
      expect(kicks[0]).toEqual(['flooder', 'Bad actor']);
      expect(edge.stats().keys.find((k) => k.id === 'alice')!.floods).toBeGreaterThanOrEqual(1);
      await waitFor(() => other.room.players.length === 2, 5000, 'bystander sees the kick');
      expect(other.closeError).toBeNull();
    } finally {
      await e.close();
    }
  }, 60_000);

  it('only edge addresses reach clients; clients talk to the edge', async () => {
    master.clientMessages = [];
    clientPcs.length = 0;
    const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, keyA) } });
    try {
      await e.join('iso');
      const rep = inspectClientSignaling(master);
      expect(rep.answers).toBe(1);
      expect([...rep.addresses]).toEqual([EDGE_IP]);
      expect(rep.text).not.toContain(HOST_IP);
      expect(clientPcs.length).toBe(1);
      expect(await selectedRemote(clientPcs[0])).toBe(EDGE_IP);
    } finally {
      await e.close();
    }
  }, 60_000);
});
