/**
 * Input abuse detector (haxlite): counts each player's inputs and kick
 * presses per second of game frames and reports a player once per second
 * while they go over the limit. Official clients send an input only when a
 * key changes, so a human tops out around 15 to 20 per second; a macro
 * ("turbo kick") or a modified client goes well past that. Reports only: what
 * to do (warn, kick, ban) is up to the script.
 */
import type { Player } from '../room/index.js';

/** Kick bit of `Player.input`. */
const KICK = 16;
/** Frames per counting window (1 s). */
const WINDOW = 60;

export interface InputGuardLimits {
  /** Most inputs per second before reporting. Default 40. */
  maxInputsPerSecond?: number;
  /** Most kick presses (kick bit going on) per second before reporting. Default 15. */
  maxKicksPerSecond?: number;
}

export type InputAbuseKind = 'inputs' | 'kicks';

export class InputGuard {
  maxInputs: number;
  maxKicks: number;
  /** Called once per player, kind and window while over the limit. */
  onAbuse: ((p: Player, kind: InputAbuseKind, perSecond: number) => void) | null = null;
  /** playerId -> [windowStart, inputs, kicks, reported bits] */
  private readonly counts = new Map<number, Int32Array>();

  constructor(limits: InputGuardLimits = {}) {
    this.maxInputs = limits.maxInputsPerSecond ?? 40;
    this.maxKicks = limits.maxKicksPerSecond ?? 15;
  }

  /** The input hook: `p.input` is the new input, `prev` the one before, `frame` the host frame. */
  input(p: Player, prev: number, frame: number): void {
    let c = this.counts.get(p.id);
    if (c === undefined) this.counts.set(p.id, (c = new Int32Array(4)));
    if (frame - c[0]! >= WINDOW) {
      c[0] = frame;
      c[1] = c[2] = c[3] = 0;
    }
    c[1]!++;
    if ((p.input & KICK) !== 0 && (prev & KICK) === 0) c[2]!++;
    const cb = this.onAbuse;
    if (cb === null) return;
    if (c[1]! > this.maxInputs && (c[3]! & 1) === 0) {
      c[3]! |= 1;
      cb(p, 'inputs', c[1]!);
    }
    if (c[2]! > this.maxKicks && (c[3]! & 2) === 0) {
      c[3]! |= 2;
      cb(p, 'kicks', c[2]!);
    }
  }

  /** Forgets a player (on leave). */
  remove(playerId: number): void {
    this.counts.delete(playerId);
  }
}
