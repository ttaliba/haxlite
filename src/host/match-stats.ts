/**
 * Match statistics (haxlite; the official host has none): goals, assists,
 * own goals, kicks, passes, steals and ball possession, built on the touch
 * tracker ({@link TouchTracker}).
 *
 *  - a goal goes to the last player to touch the ball if they are on the
 *    scoring team (an own goal otherwise); the assist to the previous one if
 *    they are on the scoring team too;
 *  - a pass is a touch by a teammate of the previous toucher, a steal a touch
 *    by a rival;
 *  - possession: every tick of play counts for the team (and player) that
 *    touched the ball last.
 *
 * Players who leave keep their line (with the name and team they had).
 * Allocation-free per tick.
 */
import { GamePhase, TeamId } from '../protocol.js';
import type { Player, RoomState } from '../room/index.js';

export interface PlayerStats {
  id: number;
  name: string;
  /** Team of the player's last counted action. */
  team: TeamId;
  goals: number;
  assists: number;
  ownGoals: number;
  kicks: number;
  passes: number;
  steals: number;
  /** Ticks of play (1/60 s) with this player as the last to touch the ball. */
  possessionFrames: number;
}

export interface MatchStatsSnapshot {
  /** Ticks of play with each team in possession. */
  possessionFrames: { red: number; blue: number };
  /** Share of the possessed ticks, 0 to 1 (both 0 before anyone touched the ball). */
  possession: { red: number; blue: number };
  players: PlayerStats[];
}

export class MatchStats {
  private readonly players = new Map<number, PlayerStats>();
  private red = 0;
  private blue = 0;

  reset(): void {
    this.players.clear();
    this.red = this.blue = 0;
  }

  private line(p: Player): PlayerStats {
    let s = this.players.get(p.id);
    if (s === undefined) {
      s = { id: p.id, name: p.name ?? '', team: p.team, goals: 0, assists: 0, ownGoals: 0, kicks: 0, passes: 0, steals: 0, possessionFrames: 0 };
      this.players.set(p.id, s);
    }
    s.team = p.team;
    return s;
  }

  /** The touch hook: `p` started touching the ball, `previous` touched it before. */
  touch(p: Player, previous: Player | null): void {
    if (previous === null) return;
    if (previous.team === p.team) this.line(previous).passes++;
    else this.line(p).steals++;
  }

  kick(p: Player): void {
    this.line(p).kicks++;
  }

  /** `team` scored (the `onTeamGoal` hook); the touch tracker still holds the play. */
  goal(rs: RoomState, team: TeamId): void {
    const t = rs.touches;
    if (t === null || t.lastId === -1) return;
    const last = rs.players.find((p) => p.id === t.lastId);
    if (last === undefined) return;
    if (t.lastTeam !== team) {
      this.line(last).ownGoals++;
      return;
    }
    this.line(last).goals++;
    if (t.prevId === -1 || t.prevTeam !== team) return;
    const prev = rs.players.find((p) => p.id === t.prevId);
    if (prev !== undefined) this.line(prev).assists++;
  }

  /** Once per game tick (the `onGameTick` hook). */
  tick(rs: RoomState): void {
    const t = rs.touches;
    const gs = rs.gameState;
    if (t === null || t.lastId === -1 || gs === null || gs.phase !== GamePhase.Playing) return;
    if (t.lastTeam === TeamId.Red) this.red++;
    else if (t.lastTeam === TeamId.Blue) this.blue++;
    const s = this.players.get(t.lastId);
    if (s !== undefined) s.possessionFrames++;
    else {
      const p = rs.players.find((q) => q.id === t.lastId);
      if (p !== undefined) this.line(p).possessionFrames++;
    }
  }

  snapshot(): MatchStatsSnapshot {
    const total = this.red + this.blue;
    return {
      possessionFrames: { red: this.red, blue: this.blue },
      possession: { red: total === 0 ? 0 : this.red / total, blue: total === 0 ? 0 : this.blue / total },
      players: [...this.players.values()].map((s) => ({ ...s })),
    };
  }
}
