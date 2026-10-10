/**
 * End-to-end, fully offline: haxlite HostRoom (official defaults: Sb=2,
 * heartbeat 7 frames, CheckConsistency every 600) + HostTransport +
 * FakeMaster with node-haxball CLIENTS.
 *
 * 3 clients join, the host starts a game, clients send random inputs (move +
 * kick) and chat for > 3000 frames, the host pauses/resumes, changes disc
 * properties and colours, a 4th client joins mid-game. Every client's
 * confirmed state must equal the host's bytes at matching frames, every
 * CheckConsistency must pass (no SetPlayerSync desync). Then kick / admin-kick
 * / ban (rejoin rejected with 4102) / clearBan / leave flows, and the game
 * recorded by the host must replay to the host's final state.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { E2E, shutdownAll, sleep, waitFor, withTimeout, type Any, type ClientHandle } from './harness.js';
import { prng } from '../oracle/index.js';
import { Writer } from '../../src/codec/index.js';
import { Input } from '../../src/protocol.js';
import { roomStateChecksum, writeRoomState, type Player } from '../../src/room/index.js';
import { ReplayPlayer } from '../../src/replay/index.js';

afterAll(() => shutdownAll());

/** Random key presses until `stop()`. */
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

function stateBytes(rs: Parameters<typeof writeRoomState>[1]): Uint8Array {
  const w = new Writer(4096);
  writeRoomState(w, rs);
  return w.copyBytes();
}

describe('HostRoom E2E with node-haxball clients (official defaults)', () => {
  it('converges over > 3000 frames, late join, kick/ban flows, replay', async () => {
    const e = await E2E.start();
    try {
      const host = e.host;
      const joins: Player[] = [];
      const leaves: string[] = [];
      const kicks: [string, string, boolean, string | null][] = [];
      const chats: string[] = [];
      host.onPlayerJoin = (p) => joins.push(p);
      host.onPlayerLeave = (p) => leaves.push(p.name ?? '');
      host.onPlayerKicked = (p, reason, ban, by) => kicks.push([p.name ?? '', reason, ban, by?.name ?? null]);
      host.state.hooks.onPlayerChatFilter = (_p, msg) => {
        chats.push(msg);
        return !msg.endsWith('says 50'); // drop one message (official onPlayerChat returning false)
      };
      const links: string[] = [];
      host.onRoomLink = (l) => links.push(l);

      const [authKey, authObj] = (await e.nh.Utils.generateAuth()) as [string, Any];
      const alice = await e.join('alice', { authObj, avatar: 'A' });
      const bob = await e.join('bob', { flag: 'ar' });
      const carol = await e.join('carol');
      expect(links[0]).toBe(`https://www.haxball.com/play?c=${e.fakeRoom.id}`);
      expect(joins.map((p) => [p.id, p.name])).toEqual([[1, 'alice'], [2, 'bob'], [3, 'carol']]);
      expect(joins[0]!.auth).toBe(authKey.split('.')[1]);
      expect(joins[0]!.conn).toBe(Buffer.from('127.0.0.1').toString('hex').toUpperCase());
      expect(joins[0]!.avatar).toBe('A');
      expect(joins[1]!.flag).toBe('ar');
      // every client sees the same player list
      for (const c of [alice, bob, carol]) {
        await waitFor(() => c.room.players.length === 4, 5000, 'player list');
      }

      host.setPlayerTeam(1, 1);
      host.setPlayerTeam(2, 2);
      host.setPlayerTeam(3, 1);
      host.setTeamColors(1, 60, 0xffffff, [0xff0000, 0x00ff00]);
      host.setKickRateLimit(2, 10, 3);
      host.startGame();
      host.startRecording();
      const startFrame = host.frame;
      expect(host.state.gameState).not.toBeNull();

      const drivers = [drive(alice, 1, true), drive(bob, 2, true), drive(carol, 3, false)];
      let dave: ClientHandle | null = null;
      let pausedOnce = false;
      while (host.frame < startFrame + 3100) {
        await sleep(100);
        const f = host.frame - startFrame;
        if (f > 600 && !pausedOnce) {
          pausedOnce = true;
          host.pauseGame(true);
          await sleep(500);
          host.pauseGame(false);
          host.sendAnnouncement('resumed', null, 0x00ff00, 1, 2);
          host.setDiscProperties(0, { xspeed: 3.3, yspeed: -1.7, color: 0x123456 });
          host.setPlayerDiscProperties(1, { radius: 18.5 });
        }
        if (f > 1500 && dave === null) {
          dave = await e.join('dave');
          host.setPlayerTeam(4, 2);
          drivers.push(drive(dave, 4, true));
        }
      }
      for (const d of drivers) d.stop();
      await Promise.all(drivers.map((d) => d.done));
      // let every client confirm the last frames
      await sleep(500);
      const replay = host.stopRecording()!;
      const finalBytes = stateBytes(host.state);
      const finalChecksum = roomStateChecksum(host.state);

      // ---- convergence evidence
      const all = [alice, bob, carol, dave!];
      for (const c of all) {
        expect(c.closeError, c.name).toBeNull();
        expect(c.mismatches, c.name).toEqual([]);
        expect(Math.abs(c.room.currentFrameNo - host.frame), `${c.name} frame lag`).toBeLessThan(60);
      }
      for (const c of [alice, bob, carol]) {
        expect(c.compared, `${c.name} compared`).toBeGreaterThan(150);
        // >= 5 consistency checks evaluated (600-frame period over > 3000 frames), all in sync
        expect(c.checks.length, `${c.name} checks`).toBeGreaterThanOrEqual(5);
        expect(c.checks.every((d) => d === false), `${c.name} desync`).toBe(true);
      }
      expect(dave!.compared).toBeGreaterThan(50);
      expect(dave!.checks.length).toBeGreaterThanOrEqual(2);
      expect(dave!.checks.every((d) => d === false)).toBe(true);
      expect(e.syncEvents.filter((s) => s.desync)).toEqual([]);
      expect(host.state.players.every((p) => !p.desync)).toBe(true);
      expect(e.errors).toEqual([]);
      // chat: seen by the host filter, one dropped; clients' chat reached the room
      expect(chats.length).toBeGreaterThan(10);
      // pings broadcast every 3 s with the client-declared value
      expect(host.getPlayer(1)!.ping).toBeGreaterThanOrEqual(0);
      expect(alice.room.players.find((p: Any) => p.id === 2)).toBeTruthy();

      // ---- replay of the hosted game reproduces the host's final state
      const player = new ReplayPlayer(replay);
      expect(player.totalFrames).toBeGreaterThan(3000);
      const replayed = player.finish();
      expect(roomStateChecksum(replayed)).toBe(finalChecksum);
      expect(Buffer.from(stateBytes(replayed)).equals(Buffer.from(finalBytes))).toBe(true);

      // ---- kick by the host
      host.kickPlayer(2, 'bye', false);
      const bobErr = await withTimeout(bob.closed, 10_000, 'bob kicked');
      expect(bobErr.code).toBe(e.nh.Errors.ErrorCodes.KickedNow);
      expect(bobErr.params.slice(0, 3)).toEqual(['bye', false, 'Host']);

      // ---- kick by an admin client (goes through the sequencer)
      host.setPlayerAdmin(1, true);
      await waitFor(() => alice.room.players.find((p: Any) => p.id === 1)?.isAdmin === true, 5000, 'alice admin');
      alice.room.kickPlayer(3, 'admin kick', false);
      const carolErr = await withTimeout(carol.closed, 10_000, 'carol kicked');
      expect(carolErr.params.slice(0, 3)).toEqual(['admin kick', false, 'alice']);

      // ---- ban, rejoin rejected (4102), clearBan, rejoin accepted
      host.kickPlayer(4, 'banned', true);
      const daveErr = await withTimeout(dave!.closed, 10_000, 'dave banned');
      expect(daveErr.params.slice(0, 2)).toEqual(['banned', true]);
      const before = e.master.rejections.length;
      await expect(e.join('dave2', { sample: false })).rejects.toBeTruthy();
      expect(e.master.rejections.slice(before).map((r) => r.code)).toEqual([4102]);
      host.clearBan(4);
      const dave3 = await e.join('dave3', { sample: false });
      await waitFor(() => host.getPlayer(5) !== null, 5000, 'dave3 joined');
      expect(host.getPlayer(5)!.name).toBe('dave3');

      expect(kicks).toEqual([
        ['bob', 'bye', false, 'Host'],
        ['carol', 'admin kick', false, 'alice'],
        ['dave', 'banned', true, 'Host'],
      ]);

      // ---- voluntary leave
      dave3.room.leave();
      alice.room.leave();
      await waitFor(() => host.state.players.length === 1, 10_000, 'everyone left');
      expect(leaves.slice(0, 3)).toEqual(['bob', 'carol', 'dave']);
      expect([...leaves.slice(3)].sort()).toEqual(['alice', 'dave3']);

      // ---- idle: no players + no game = no timers
      host.stopGame();
      await sleep(100);
      const internals = host as Any;
      expect(internals.timer).toBeNull();
      expect(internals.pingTimer).toBeNull();
      const f0 = host.frame;
      await sleep(200);
      expect(host.frame).toBe(f0); // nothing ran
      host.update();
      expect(host.frame).toBeGreaterThanOrEqual(f0 + 11); // catch-up on demand
    } finally {
      await e.close();
    }
  }, 240_000);
});
