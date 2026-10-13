/**
 * haxlite private visuals (room.haxlite.setDiscPropertiesFor), offline E2E
 * with real node-haxball clients: one viewer sees a visual-only disc
 * changed, the others see the room's, nobody gets a desync flag over many
 * CheckConsistency rounds, nobody stalls, players' physics are identical in
 * every world, and the private world ends on clear / game stop / leave.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SetDiscPropertiesEvent } from '../../src/room/index.js';
import { join, shutdownAll, sleep, startEnv, startRoom, waitFor, type Any, type Client, type Env } from './harness.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
});

// disc 0 ball, 1 static visual mask, 2 moving visual disc (gravity, bounces on walls only),
// 3 a normal (colliding) disc
const HBS = `{
  "name" : "Private view test", "width" : 400, "height" : 200, "spawnDistance" : 150,
  "bg" : { "type" : "grass", "width" : 350, "height" : 170, "kickOffRadius" : 60 },
  "vertexes" : [], "segments" : [], "goals" : [],
  "discs" : [
    { "radius" : 10, "invMass" : 1, "cGroup" : ["ball", "kick", "score"] },
    { "pos" : [0, 100], "radius" : 40, "invMass" : 0, "color" : "000000", "cGroup" : [], "cMask" : [] },
    { "pos" : [-100, -100], "speed" : [1, 0], "gravity" : [0, 0.05], "radius" : 8, "invMass" : 1, "damping" : 1, "bCoef" : 1, "cGroup" : [], "cMask" : ["wall"] },
    { "pos" : [100, -120], "radius" : 15, "invMass" : 0 }
  ],
  "planes" : [ { "normal" : [0, 1], "dist" : -170 }, { "normal" : [0, -1], "dist" : -170 },
               { "normal" : [1, 0], "dist" : -350 }, { "normal" : [-1, 0], "dist" : -350 } ],
  "traits" : {}, "playerPhysics" : {}, "ballPhysics" : "disc0"
}`;

const disc = (c: Client, i: number): Any => c.room.gameState?.physicsState?.discs?.[i] ?? null;
const pos = (d: Any) => (d === null ? null : [d.pos.x, d.pos.y]);

describe('room.haxlite private visuals', () => {
  it('one viewer sees a visual-only disc changed, no desync, no stall, same players physics', async () => {
    const { room } = await startRoom(env, { noPlayer: true, haxlite: { checksumIntervalFrames: 30 } });
    const errors: unknown[] = [];
    room.haxlite.onError = (e) => errors.push(e);
    const ended: number[] = [];
    room.haxlite.onPrivateViewEnd = (id) => ended.push(id);
    const roomId = room.haxlite.roomLink!.split('c=')[1]!.split('&')[0]!;
    const clients: Client[] = [];
    try {
      const a = await join(env, roomId, 'viewer');
      const b = await join(env, roomId, 'other');
      const c = await join(env, roomId, 'third');
      clients.push(a, b, c);
      const syncs: Any[] = [];
      let checks = 0;
      for (const cl of clients) {
        cl.room.onPlayerSyncChange = (id: number, v: boolean) => syncs.push([cl.name, id, v]);
      }
      // count the CheckConsistency rounds sent while a private view exists
      const seq = room.haxlite.host.sequencer;
      const checksum = seq.checksum.bind(seq);
      seq.checksum = () => {
        if (seq.views.length > 0) checks++;
        checksum();
      };
      const ids = clients.map((cl) => cl.room.currentPlayerId as number);
      room.setCustomStadium(HBS);
      room.setPlayerTeam(ids[0]!, 1);
      room.setPlayerTeam(ids[1]!, 2);
      room.setPlayerTeam(ids[2]!, 1);
      room.startGame();
      await waitFor(() => clients.every((cl) => disc(cl, 3) !== null), 5000, 'game in every client');

      // ---- validation: colliding disc, ball and player discs are rejected (reported, not sent)
      room.haxlite.setDiscPropertiesFor(ids[0]!, 3, { color: 0xff0000 });
      room.haxlite.setDiscPropertiesFor(ids[0]!, 0, { radius: 50 });
      room.haxlite.setDiscPropertiesFor(ids[0]!, 1, { cGroup: 1 });
      await sleep(50);
      expect(errors.map(String)).toEqual([
        expect.stringContaining('cGroup must be 0'),
        expect.stringContaining('disc 0'),
        expect.stringContaining('cGroup must be 0'),
      ]);
      expect(room.haxlite.hasPrivateView(ids[0]!)).toBe(false);
      errors.length = 0;

      // ---- private override: the mask moves over the field and turns red, the moving disc is pushed
      room.haxlite.setDiscPropertiesFor(ids[0]!, 1, { x: -150, y: 0, radius: 120, color: 0xff0000 });
      room.haxlite.setDiscPropertiesFor(ids[0]!, 2, { xspeed: -3, yspeed: -2 });
      await waitFor(() => disc(a, 1)?.radius === 120, 5000, 'viewer sees the mask');
      expect(room.haxlite.hasPrivateView(ids[0]!)).toBe(true);
      expect(room.haxlite.getDiscPropertiesFor(ids[0]!, 1)).toMatchObject({ x: -150, y: 0, radius: 120, color: 0xff0000 });
      expect(room.getDiscProperties(1)).toMatchObject({ x: 0, y: 100, radius: 40, color: 0 });

      // players move around (collide with each other and the ball) during several checksum rounds
      const before = checks;
      const frames0 = clients.map((cl) => cl.room.currentFrameNo as number);
      for (let k = 0; k < 12; k++) {
        a.room.setKeyState([8, 2, 4, 1][k % 4]! | (k % 3 === 0 ? 16 : 0));
        b.room.setKeyState([4, 1, 8, 2][k % 4]!);
        c.room.setKeyState([1, 8, 2, 4][k % 4]!);
        await sleep(250);
      }
      for (const cl of clients) cl.room.setKeyState(0);
      await sleep(600);
      expect(checks - before).toBeGreaterThanOrEqual(4); // >= 4 rounds while the view was active
      // nobody stalled: every confirmed frame advanced
      clients.forEach((cl, i) => expect(cl.room.currentFrameNo as number).toBeGreaterThan(frames0[i]! + 120));

      // the viewer sees its private discs, the others the room's
      expect(disc(a, 1)).toMatchObject({ radius: 120, color: 0xff0000 });
      expect(pos(disc(a, 1))).toEqual([-150, 0]);
      for (const cl of [b, c]) {
        expect(disc(cl, 1)).toMatchObject({ radius: 40, color: 0 });
        expect(pos(disc(cl, 1))).toEqual([0, 100]);
      }
      // the moving visual disc diverged for the viewer only; the host tracks it exactly
      expect(pos(disc(a, 2))).not.toEqual(pos(disc(b, 2)));
      expect(pos(disc(b, 2))).toEqual(pos(disc(c, 2)));
      // player and ball physics are identical in every world (same confirmed frame -> same positions)
      await waitFor(() => new Set(clients.map((cl) => cl.room.currentFrameNo)).size === 1, 5000, 'same confirmed frame');
      const snap = (cl: Client) => [0, 3, ...ids.map((id) => cl.room.getPlayer(id).disc)].map((d) => (typeof d === 'number' ? pos(disc(cl, d)) : pos(d)));
      expect(snap(a)).toEqual(snap(b));
      expect(snap(b)).toEqual(snap(c));

      // ---- clear: the viewer gets the room's values again
      room.haxlite.clearDiscOverrides(ids[0]!);
      await waitFor(() => disc(a, 1)?.radius === 40, 5000, 'mask restored');
      expect(pos(disc(a, 1))).toEqual([0, 100]);
      // the moving disc stays diverged (only overridden fields are restored) -> the view lives on
      expect(room.haxlite.hasPrivateView(ids[0]!)).toBe(true);

      // ---- game stop: worlds equal again -> the private view ends
      room.stopGame();
      await waitFor(() => !room.haxlite.hasPrivateView(ids[0]!), 5000, 'view ends on stop');
      expect(ended).toEqual([ids[0]!]);

      // ---- a second view on another player, then that player leaves
      room.startGame();
      await waitFor(() => clients.every((cl) => disc(cl, 1) !== null), 5000, 'game restarted');
      room.haxlite.setDiscPropertiesFor(ids[1]!, 1, { color: 0x00ff00 });
      await waitFor(() => disc(b, 1)?.color === 0x00ff00, 5000, 'second viewer');
      expect(disc(a, 1).color).toBe(0);
      await sleep(1200); // > 2 checksum rounds
      b.leave();
      await waitFor(() => !room.haxlite.hasPrivateView(ids[1]!), 5000, 'view dropped on leave');
      await sleep(600);

      expect(checks).toBeGreaterThanOrEqual(8);
      expect(syncs).toEqual([]);
      for (const cl of [a, c]) for (const p of cl.room.players as Any[]) expect(p.sync).toBe(false);
      expect(errors).toEqual([]);

      // ---- negative control: the same change sent out of sequence (raw msg 6, like node-haxball's
      // executeEventWithTarget) is NOT tracked -> the next CheckConsistency flags that client for everyone
      room.haxlite.host.emitTo(SetDiscPropertiesEvent.create(1, false, { color: 0x0000ff }), ids[2]!);
      await waitFor(() => syncs.length >= 2, 5000, 'desync reported');
      expect(syncs).toEqual(expect.arrayContaining([['viewer', ids[2]!, true], ['third', ids[2]!, true]]));
      expect(disc(c, 1).color).toBe(0x0000ff);
      expect(disc(a, 1).color).toBe(0);
    } finally {
      for (const cl of clients) cl.leave();
      await room.haxlite.stop();
    }
  }, 60_000);
});
