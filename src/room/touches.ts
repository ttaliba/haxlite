/**
 * Last / previous player to touch the ball (haxlite extension; the official
 * host has no such thing). Opt-in: `RoomState.touches` is null unless a host
 * asks for it, and then the game tick pays a single null check.
 *
 * A "touch" is a player starting to touch a `kick` disc (the ball) or kicking
 * it. Contact is checked once per tick after the physics step, comparing each
 * player's disc with the `kick` discs; only the moment contact begins counts,
 * so two players pressed against the ball do not take turns. Kicks are
 * recorded where they happen, because the ball has already left the player by
 * the end of the tick.
 *
 * `previous` is always a different player than `last`, which is what an assist
 * needs: a player who keeps touching the ball does not push themselves out.
 * Contact is physical, so a push counts the same as a deliberate touch; `kick`
 * tells those apart.
 *
 * Runtime only: nothing here is serialized or part of the consistency checksum.
 * Allocation-free per tick (the kick-disc index list grows only if a stadium
 * has more than 8 `kick` discs).
 */
import type { GameState, Player, RoomState } from './types.js';

/** Bits of `Player.touchState`. */
const IN_CONTACT = 1;
const KICKED = 2;
/** A disc counts as touching up to this far past the sum of the radii (float fuzz after the collision push). */
const CONTACT_SLACK = 0.01;

export class TouchTracker {
  lastId = -1;
  lastTeam = 0;
  lastTime = 0;
  lastKick = false;
  prevId = -1;
  prevTeam = 0;
  prevTime = 0;
  prevKick = false;
  private kickIdx = new Int32Array(8);

  /** Forgets the touches and every player's contact state (new play, game over, or tracking switched on). */
  reset(rs: RoomState): void {
    this.lastId = this.prevId = -1;
    this.lastTeam = this.prevTeam = 0;
    this.lastTime = this.prevTime = 0;
    this.lastKick = this.prevKick = false;
    const players = rs.players;
    for (let i = 0; i < players.length; i++) players[i]!.touchState = 0;
  }

  /** `p` kicked a `kick` disc this tick (called from the kick branch, before the physics step). */
  kick(rs: RoomState, p: Player, time: number): void {
    p.touchState |= KICKED;
    this.record(rs, p, time, true);
  }

  /** Contact check; call right after the physics step while the phase is kick-off or playing. */
  contacts(rs: RoomState, gs: GameState): void {
    const discs = gs.world.discs;
    let kc = 0;
    for (let i = 0, n = discs.length; i < n; i++) {
      if ((discs[i]!.cGroup & 64) === 0) continue;
      if (kc === this.kickIdx.length) {
        const bigger = new Int32Array(kc * 2);
        bigger.set(this.kickIdx);
        this.kickIdx = bigger;
      }
      this.kickIdx[kc++] = i;
    }
    const players = rs.players;
    const time = gs.timeElapsed;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const me = p.disc;
      if (me === null) {
        p.touchState = 0;
        continue;
      }
      let touching = false;
      for (let k = 0; k < kc; k++) {
        const d = discs[this.kickIdx[k]!]!;
        if (d === me || (me.cMask & d.cGroup) === 0 || (me.cGroup & d.cMask) === 0) continue;
        const dx = d.x - me.x;
        const dy = d.y - me.y;
        const r = d.radius + me.radius + CONTACT_SLACK;
        if (dx * dx + dy * dy <= r * r) {
          touching = true;
          break;
        }
      }
      if (!touching) {
        p.touchState = 0;
        continue;
      }
      // a kick this tick was already recorded, with more information than a contact
      if (p.touchState === 0) this.record(rs, p, time, false);
      p.touchState = IN_CONTACT;
    }
  }

  private record(rs: RoomState, p: Player, time: number, kick: boolean): void {
    if (p.id === this.lastId) {
      this.lastTime = time;
      this.lastKick = kick;
      return;
    }
    const oldId = this.lastId;
    this.prevId = oldId;
    this.prevTeam = this.lastTeam;
    this.prevTime = this.lastTime;
    this.prevKick = this.lastKick;
    this.lastId = p.id;
    this.lastTeam = p.team;
    this.lastTime = time;
    this.lastKick = kick;
    const h = rs.hooks.onPlayerTouch;
    if (h === null) return;
    let previous: Player | null = null;
    if (oldId !== -1) {
      const players = rs.players;
      for (let i = 0; i < players.length; i++) {
        if (players[i]!.id === oldId) {
          previous = players[i]!;
          break;
        }
      }
    }
    h(p, previous);
  }
}
