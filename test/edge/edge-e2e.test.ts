/**
 * End-to-end through a haxlite Edge, fully offline: FakeMaster + EdgeServer
 * (bound to 127.0.0.2) + haxlite HostRoom whose transport uses the edge
 * (tunnel bound to 127.0.0.3, no player-facing sockets) + node-haxball
 * clients.
 *
 * Same convergence checks as test/host/e2e.test.ts (> 3000 frames, late
 * joiner, byte-identical confirmed states, every CheckConsistency in sync),
 * plus chat, kick, ban (rejoin rejected with 4102), clearBan, and the IP
 * isolation evidence: every SDP answer and trickled candidate the clients
 * received names ONLY the edge (127.0.0.2), the host's 127.0.0.3 appears
 * nowhere, every client's selected ICE pair points at the edge, and the
 * host process never creates a player PeerConnection of its own.
 *
 * Runs twice: the defaults (players on haxlite-rtc, tunnel v2 = SCTP over
 * AES-GCM UDP) and the legacy stack (players on node-datachannel, WebRTC
 * tunnel).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { nodeHaxballFor } from '../fake-master/node-haxball.js';
import { E2E, shutdownAll, sleep, waitFor, withTimeout, type Any, type ClientHandle } from '../host/harness.js';
import { prng } from '../oracle/index.js';
import { Input } from '../../src/protocol.js';
import { EdgePeerBackend, liveWebRtcObjects, webRtcStats } from '../../src/net/index.js';
import type { Player } from '../../src/room/index.js';
import { EDGE_IP, HOST_IP, edgeConfig, inspectClientSignaling, makeKey, selectedRemote, startEdge } from './harness.js';

let master: FakeMaster;
const clientPcs: Any[] = [];
let nh: Any;
// node-haxball keeps its backend config module-global: one master for the file
beforeAll(async () => {
  master = await FakeMaster.start();
  nh = nodeHaxballFor(master, { onPeerConnection: (pc) => clientPcs.push(pc) });
});
afterAll(async () => {
  await master?.close();
  await shutdownAll();
});

const CONFIGS = [
  { players: 'rtc', plane: 'udp' },
  { players: 'ndc', plane: 'webrtc' },
] as const;

function drive(c: ClientHandle, seed: number, chat: boolean): { stop(): void; done: Promise<void> } {
  const rnd = prng(seed);
  let running = true;
  const done = (async () => {
    let n = 0;
    while (running && c.closeError === null) {
      const dir = [0, Input.Up, Input.Down, Input.Left, Input.Right, Input.Up | Input.Left, Input.Down | Input.Right][Math.floor(rnd() * 7)]!;
      const kick = rnd() < 0.3 ? Input.Kick : 0;
      c.room.setKeyState(dir | kick);
      if (chat && ++n % 25 === 0) c.room.sendChat(`${c.name} says ${n}`);
      await sleep(20 + Math.floor(rnd() * 110));
    }
  })();
  return { stop: () => (running = false), done };
}

describe.each(CONFIGS)('HostRoom behind a haxlite Edge with node-haxball clients (players $players, tunnel $plane)', ({ players, plane }) => {
  it('converges over > 3000 frames, late join, chat, kick/ban, IP isolation, clean shutdown', async () => {
    const key = makeKey('e2e');
    const edge = await startEdge([key], { playerBackend: players });
    master.clientMessages = [];
    clientPcs.length = 0;
    const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, key, { dataPlane: plane }) } });
    let localPcSeen = false;
    const pcWatch = setInterval(() => {
      if (liveWebRtcObjects().some((n) => /^haxlite-\d+/.test(n))) localPcSeen = true;
    }, 20);
    try {
      const host = e.host;
      const backend = e.transport.backend as EdgePeerBackend;
      expect(backend).toBeInstanceOf(EdgePeerBackend);
      expect(backend.stats().dataPlane).toBe(plane);
      expect(edge.stats().playerBackend).toBe(players);
      const joins: Player[] = [];
      const kicks: [string, string, boolean, string | null][] = [];
      const chats: string[] = [];
      host.onPlayerJoin = (p) => joins.push(p);
      host.onPlayerKicked = (p, reason, ban, by) => kicks.push([p.name ?? '', reason, ban, by?.name ?? null]);
      host.state.hooks.onPlayerChatFilter = (_p, msg) => {
        chats.push(msg);
        return true;
      };

      const alice = await e.join('alice', { avatar: 'A' });
      const bob = await e.join('bob', { flag: 'ar' });
      const carol = await e.join('carol');
      expect(joins.map((p) => [p.id, p.name])).toEqual([[1, 'alice'], [2, 'bob'], [3, 'carol']]);
      // conn/ip: the master's view of the client, unchanged by the edge
      expect(joins[0]!.conn).toBe(Buffer.from('127.0.0.1').toString('hex').toUpperCase());
      for (const c of [alice, bob, carol]) await waitFor(() => c.room.players.length === 4, 5000, 'player list');
      // the edge reports the player's selected remote address (as the edge sees it)
      for (const id of [1, 2, 3]) expect(host.getConnection(id)!.peer.remoteAddress).toMatch(/^127\./);

      host.setPlayerTeam(1, 1);
      host.setPlayerTeam(2, 2);
      host.setPlayerTeam(3, 1);
      host.startGame();
      const startFrame = host.frame;
      const drivers = [drive(alice, 11, true), drive(bob, 12, true), drive(carol, 13, false)];
      let dave: ClientHandle | null = null;
      let pausedOnce = false;
      while (host.frame < startFrame + 3100) {
        await sleep(100);
        const f = host.frame - startFrame;
        if (f > 600 && !pausedOnce) {
          pausedOnce = true;
          host.pauseGame(true);
          await sleep(300);
          host.pauseGame(false);
          host.sendAnnouncement('resumed', null, 0x00ff00, 1, 2);
          host.setDiscProperties(0, { xspeed: 2.5, yspeed: -1.5 });
        }
        if (f > 1500 && dave === null) {
          dave = await e.join('dave');
          host.setPlayerTeam(4, 2);
          drivers.push(drive(dave, 14, true));
        }
      }
      for (const d of drivers) d.stop();
      await Promise.all(drivers.map((d) => d.done));
      await sleep(500);

      // ---- convergence (same evidence as the direct E2E)
      const all = [alice, bob, carol, dave!];
      for (const c of all) {
        expect(c.closeError, c.name).toBeNull();
        expect(c.mismatches, c.name).toEqual([]);
        expect(Math.abs(c.room.currentFrameNo - host.frame), `${c.name} frame lag`).toBeLessThan(60);
      }
      for (const c of [alice, bob, carol]) {
        expect(c.compared, `${c.name} compared`).toBeGreaterThan(150);
        expect(c.checks.length, `${c.name} checks`).toBeGreaterThanOrEqual(5);
        expect(c.checks.every((d) => d === false), `${c.name} desync`).toBe(true);
      }
      expect(dave!.compared).toBeGreaterThan(50);
      expect(dave!.checks.length).toBeGreaterThanOrEqual(2);
      expect(dave!.checks.every((d) => d === false)).toBe(true);
      expect(e.syncEvents.filter((s) => s.desync)).toEqual([]);
      expect(e.errors).toEqual([]);
      expect(chats.length).toBeGreaterThan(10);
      expect(host.getPlayer(1)!.ping).toBeGreaterThanOrEqual(0);

      // ---- IP isolation: what the clients received names the edge only
      const rep = inspectClientSignaling(master);
      expect(rep.answers).toBe(4);
      expect(rep.addresses.size).toBeGreaterThan(0);
      expect([...rep.addresses]).toEqual([EDGE_IP]);
      for (const c of rep.connAddresses) expect(['0.0.0.0', EDGE_IP]).toContain(c);
      expect(rep.text).not.toContain(HOST_IP);
      // the clients' selected ICE pair points at the edge
      expect(clientPcs.length).toBe(4);
      for (const pc of clientPcs) expect(await selectedRemote(pc)).toBe(EDGE_IP);
      // the host never created a player PeerConnection itself
      expect(localPcSeen).toBe(false);
      const es = edge.stats();
      expect(es.sessions).toBe(1);
      expect(es.peers).toBe(4);
      expect(es.keys[0]!.messagesIn).toBeGreaterThan(500);
      expect(es.keys[0]!.messagesOut).toBeGreaterThan(500);

      // ---- kick by the host
      host.kickPlayer(2, 'bye', false);
      const bobErr = await withTimeout(bob.closed, 10_000, 'bob kicked');
      expect(bobErr.code).toBe(e.nh.Errors.ErrorCodes.KickedNow);
      expect(bobErr.params.slice(0, 3)).toEqual(['bye', false, 'Host']);

      // ---- kick by an admin client
      host.setPlayerAdmin(1, true);
      await waitFor(() => alice.room.players.find((p: Any) => p.id === 1)?.isAdmin === true, 5000, 'alice admin');
      alice.room.kickPlayer(3, 'admin kick', false);
      const carolErr = await withTimeout(carol.closed, 10_000, 'carol kicked');
      expect(carolErr.params.slice(0, 3)).toEqual(['admin kick', false, 'alice']);

      // ---- ban: rejoin rejected (4102) by the IPs the host knows (conn + srflx), clearBan
      host.kickPlayer(4, 'banned', true);
      const daveErr = await withTimeout(dave!.closed, 10_000, 'dave banned');
      expect(daveErr.params.slice(0, 2)).toEqual(['banned', true]);
      const before = master.rejections.length;
      await expect(e.join('dave2', { sample: false })).rejects.toBeTruthy();
      expect(master.rejections.slice(before).map((r) => r.code)).toEqual([4102]);
      host.clearBan(4);
      const dave3 = await e.join('dave3', { sample: false });
      await waitFor(() => host.getPlayer(5) !== null, 5000, 'dave3 joined');
      expect(kicks).toEqual([
        ['bob', 'bye', false, 'Host'],
        ['carol', 'admin kick', false, 'alice'],
        ['dave', 'banned', true, 'Host'],
      ]);
      dave3.room.leave();
      alice.room.leave();
      await waitFor(() => host.state.players.length === 1, 10_000, 'everyone left');
      await waitFor(() => edge.stats().peers === 0, 5000, 'edge released the players');
    } finally {
      clearInterval(pcWatch);
      await e.close();
    }
    // ---- clean shutdown: the tunnel session ends, the edge closes, no native leaks
    await waitFor(() => edge.stats().sessions === 0, 5000, 'tunnel closed');
    await edge.close();
    await waitFor(() => webRtcStats().peerConnections === 0, 5000, 'natives released');
  }, 240_000);
});
