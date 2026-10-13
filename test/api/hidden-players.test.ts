/**
 * haxlite hidden players (room.haxlite.hidePlayerFor / showPlayerFor),
 * offline E2E with real node-haxball clients: the hidden player's disc is at
 * NaN (cGroup 0) in the viewer's world only, it keeps playing normally for
 * everyone else (pushes players, kicks the ball: copied into the viewer's
 * world), nobody gets a desync flag over many CheckConsistency rounds, nobody
 * stalls, a respawn is re-hidden, and showing it again re-converges the
 * viewer's world (the private view ends).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, type Any, type Client, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

const HBS = `{
  "name" : "Hidden players test", "width" : 400, "height" : 200, "spawnDistance" : 150,
  "bg" : { "type" : "grass", "width" : 350, "height" : 170, "kickOffRadius" : 60 },
  "vertexes" : [ { "x" : 0, "y" : -170 }, { "x" : 0, "y" : 170 } ],
  "segments" : [ { "v0" : 0, "v1" : 1, "curve" : 90, "bias" : -10, "cMask" : ["red"] } ],
  "goals" : [],
  "discs" : [ { "radius" : 10, "invMass" : 1, "cGroup" : ["ball", "kick", "score"] } ],
  "planes" : [ { "normal" : [0, 1], "dist" : -170 }, { "normal" : [0, -1], "dist" : -170 },
               { "normal" : [1, 0], "dist" : -350 }, { "normal" : [-1, 0], "dist" : -350 } ],
  "traits" : {}, "playerPhysics" : {}, "ballPhysics" : "disc0"
}`;

const discOf = (c: Client, id: number): Any => c.room.getPlayer(id)?.disc ?? null;
const pos = (d: Any) => (d == null ? null : [d.pos.x, d.pos.y]);
const ball = (c: Client) => pos(c.room.gameState?.physicsState?.discs?.[0]);

describe('room.haxlite hidden players', () => {
  it('hidden for one viewer, normal for the others, no desync, re-hidden on respawn, restore converges', async () => {
    const { room } = await startRoom(env, { noPlayer: true, haxlite: { checksumIntervalFrames: 30 } });
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => errors.push(e);
    const roomId = room.haxlite.roomLink!.split('c=')[1]!.split('&')[0]!;
    const clients: Client[] = [];
    try {
      const v = await join(env, roomId, 'viewer');
      const p = await join(env, roomId, 'hidden');
      const o = await join(env, roomId, 'other');
      clients.push(v, p, o);
      const syncs: Any[] = [];
      for (const cl of clients) cl.room.onPlayerSyncChange = (id: number, s: boolean) => syncs.push([cl.name, id, s]);
      const seq = room.haxlite.host.sequencer;
      let checks = 0;
      const checksum = seq.checksum.bind(seq);
      seq.checksum = () => {
        if (seq.views.length > 0) checks++;
        checksum();
      };
      // count the shared reconcile slots (what P changed in the room, copied into V's world)
      let reconciled = 0;
      const slot = seq.privateSlot.bind(seq);
      seq.privateSlot = (per, shared = null) => {
        if (shared !== null) reconciled++;
        slot(per, shared);
      };
      const [V, P, O] = clients.map((cl) => cl.room.currentPlayerId as number) as [number, number, number];
      room.setCustomStadium(HBS);
      room.setPlayerTeam(V, 1);
      room.setPlayerTeam(P, 1);
      room.setPlayerTeam(O, 2);
      room.startGame();
      await waitFor(() => clients.every((cl) => discOf(cl, O) !== null), 5000, 'game in every client');

      // ---- validation
      room.haxlite.hidePlayerFor(V, V);
      room.haxlite.hidePlayerFor(V, 999);
      await sleep(50);
      expect(errors.map(String)).toEqual([expect.stringContaining('from itself'), expect.stringContaining('no such player')]);
      errors.length = 0;

      // kick-off first (a ball moved by a hidden player starts the clock one tick later in V's world)
      room.setDiscProperties(0, { xspeed: 0.5 });
      await waitFor(() => (room.getScores()?.time ?? 0) > 0, 5000, 'kick-off');

      // ---- hide P from V: NaN in V's world only
      room.haxlite.hidePlayerFor(V, P);
      await waitFor(() => Number.isNaN(discOf(v, P)?.pos.x), 5000, 'P hidden for V');
      expect(room.haxlite.isPlayerHiddenFor(V, P)).toBe(true);
      expect(room.haxlite.getHiddenPlayersFor(V)).toEqual([P]);
      expect(room.haxlite.hasPrivateView(V)).toBe(true);
      for (const cl of [p, o]) expect(Number.isFinite(discOf(cl, P).pos.x)).toBe(true);
      expect(discOf(v, P).cGroup).toBe(0);
      expect(room.getPlayerDiscProperties(P)!.cGroup).not.toBe(0);

      // P plays: pushes O, kicks the ball, crosses the curved segment with negative bias (red only)
      room.setPlayerDiscProperties(P, { x: -40, y: 0, xspeed: 0, yspeed: 0 });
      room.setPlayerDiscProperties(O, { x: 40, y: 0, xspeed: 0, yspeed: 0 });
      room.setDiscProperties(0, { x: 0, y: 30, xspeed: 0, yspeed: 0 });
      const before = checks;
      const frames0 = clients.map((cl) => cl.room.currentFrameNo as number);
      for (let k = 0; k < 16; k++) {
        p.room.setKeyState([8, 8, 2, 16 | 4, 1, 8 | 16, 4, 2][k % 8]!);
        o.room.setKeyState([4, 1, 4, 2][k % 4]!);
        v.room.setKeyState([1, 8, 2, 4][k % 4]!);
        await sleep(250);
      }
      for (const cl of clients) cl.room.setKeyState(0);
      await sleep(800);
      expect(checks - before).toBeGreaterThanOrEqual(8);
      expect(reconciled).toBeGreaterThan(0);
      clients.forEach((cl, i) => expect(cl.room.currentFrameNo as number).toBeGreaterThan(frames0[i]! + 200));
      expect(Number.isNaN(discOf(v, P).pos.x)).toBe(true);
      expect(Number.isNaN(discOf(v, P).pos.y)).toBe(true);

      // everyone else's game is the room's; V's world equals it except P's disc
      await waitFor(() => new Set(clients.map((cl) => cl.room.currentFrameNo)).size === 1, 5000, 'same confirmed frame');
      const snap = (cl: Client, ids: number[]) => [ball(cl), ...ids.map((id) => pos(discOf(cl, id)))];
      expect(snap(p, [V, P, O])).toEqual(snap(o, [V, P, O]));
      expect(snap(v, [V, O])).toEqual(snap(o, [V, O]));

      // ---- respawn (team change) is re-hidden
      room.setPlayerTeam(P, 2);
      await waitFor(() => o.room.getPlayer(P)?.team?.id === 2 && discOf(o, P) !== null, 5000, 'P respawned blue');
      await sleep(300);
      expect(Number.isNaN(discOf(v, P).pos.x)).toBe(true);
      expect(Number.isFinite(discOf(o, P).pos.x)).toBe(true);

      // ---- show again: V gets P's real disc, the view converges
      room.haxlite.showPlayerFor(V, P);
      await waitFor(() => Number.isFinite(discOf(v, P)?.pos.x), 5000, 'P visible again for V');
      expect(room.haxlite.isPlayerHiddenFor(V, P)).toBe(false);
      await waitFor(() => !room.haxlite.hasPrivateView(V), 5000, 'view converged');
      await waitFor(() => new Set(clients.map((cl) => cl.room.currentFrameNo)).size === 1, 5000, 'same confirmed frame');
      expect(snap(v, [V, P, O])).toEqual(snap(o, [V, P, O]));

      // ---- pairs end with the game
      room.haxlite.hidePlayerFor(O, V);
      await waitFor(() => Number.isNaN(discOf(o, V)?.pos.x), 5000, 'V hidden for O');
      room.stopGame();
      await waitFor(() => !room.haxlite.hasPrivateView(O), 5000, 'view ends on stop');
      await sleep(100);
      expect(room.haxlite.isPlayerHiddenFor(O, V)).toBe(false);
      room.startGame();
      await waitFor(() => clients.every((cl) => discOf(cl, V) !== null), 5000, 'game restarted');
      await sleep(300);
      expect(Number.isFinite(discOf(o, V).pos.x)).toBe(true);

      // ---- viewer leaves while hiding someone
      room.haxlite.hidePlayerFor(O, P);
      await waitFor(() => Number.isNaN(discOf(o, P)?.pos.x), 5000, 'P hidden for O');
      await sleep(1200);
      o.leave();
      await waitFor(() => !room.haxlite.hasPrivateView(O), 5000, 'view dropped on leave');
      expect(room.haxlite.getHiddenPlayersFor(O)).toEqual([]);
      await sleep(600);

      expect(syncs).toEqual([]);
      for (const cl of [v, p]) for (const pl of cl.room.players as Any[]) expect(pl.sync).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      for (const cl of clients) cl.leave();
      await room.haxlite.stop();
    }
  }, 60_000);
});
