/**
 * Game rules: room-level operations used by the events and the per-tick
 * GameState state machine (official `Ta` methods and class `Q`).
 *
 * Everything here mirrors the official headless (hash f066733d) operation by
 * operation, including floating point evaluation order. Minified names are
 * cited as `off:` for traceability only.
 */
import { Disc } from '../sim/types.js';
import type { Stadium } from '../sim/types.js';
import { copyDiscProps, createWorld, defaultStadium, goalCrossed, stepWorld } from '../sim/index.js';
import { GamePhase, TeamId } from '../protocol.js';
import { GameState, Player, RoomState, TEAMS } from './types.js';

/** Kick reach: a `kick` disc is kicked when the edge-to-edge gap is < 4. */
const KICK_REACH = 4;
/** cMask of player discs outside kick-off: ball|red|blue|wall. */
const PLAYER_CMASK = 39;
/** Collision flag bits used by the rules. */
const FLAG_KICK = 64;
const FLAG_SCORE = 128;
/** Input bits. */
const IN_UP = 1;
const IN_DOWN = 2;
const IN_LEFT = 4;
const IN_RIGHT = 8;
const IN_KICK = 16;
/** Seconds per tick, literal as in the official code. */
const TICK_SECONDS = 0.016666666666666666;
/** Ticks of the AfterGoal and Ending phases. */
const GOAL_TICKS = 150;
const ENDING_TICKS = 300;
/** pauseGameTickCounter value meaning "paused". */
export const PAUSED_TICKS = 120;

/**
 * Previous positions of `score` discs, saved before the physics step (official
 * static `Q.Se` (indices) / `Q.kf` (points), 256 entries).
 */
const MAX_SCORE_DISCS = 256;
const scoreDiscIndex = new Int32Array(MAX_SCORE_DISCS);
const scorePrevX = new Float64Array(MAX_SCORE_DISCS);
const scorePrevY = new Float64Array(MAX_SCORE_DISCS);
/** Players placed per team during a positions reset (official local `[0,0,0]`). */
const spawnCounts = new Int32Array(3);

// ------------------------------------------------------------------ helpers

/**
 * New room with the official defaults (Classic, limits 3/3, kick rate 2/0/1).
 * `stadium` defaults to the built-in Classic instance (official `w.Fd()[0]`).
 */
export function createRoomState(stadium?: Stadium): RoomState {
  const rs = new RoomState();
  rs.stadium = stadium ?? defaultStadium(0);
  return rs;
}

/** Player by id, or null (official `Ta.O`, linear scan of the list). */
export function getPlayer(rs: RoomState, id: number): Player | null {
  const players = rs.players;
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    if (p.id === id) return p;
  }
  return null;
}

/** True when `id` is the host (0) or an admin player (official `Ta.Aa`). */
export function isHostOrAdmin(rs: RoomState, id: number): boolean {
  if (id === 0) return true;
  const p = getPlayer(rs, id);
  return p !== null && p.isAdmin;
}

/** Removes the first occurrence of `item` (official `P.remove`). */
export function removeItem<T>(arr: T[], item: T): boolean {
  const i = arr.indexOf(item);
  if (i === -1) return false;
  arr.splice(i, 1);
  return true;
}

// --------------------------------------------------------- room operations

/**
 * Creates the game (official `Ta.ei`): clears player discs/numbers, builds
 * the GameState from the room and resets positions. No-op if a game exists.
 */
export function startGame(rs: RoomState, byPlayer: Player | null): void {
  if (rs.gameState !== null) return;
  const gs = new GameState();
  rs.gameState = gs;
  const players = rs.players;
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    p.disc = null;
    p.avatarNumber = 0;
  }
  initGameState(rs, gs);
  const h = rs.hooks.onGameStart;
  if (h !== null) h(byPlayer);
}

/** official `Q.eh`: copy limits + stadium, share static geometry, clone stadium discs, reset. */
function initGameState(rs: RoomState, gs: GameState): void {
  gs.scoreLimit = rs.scoreLimit;
  gs.timeLimit = rs.timeLimit;
  const stadium = rs.stadium!;
  gs.stadium = stadium;
  gs.world = createWorld(stadium); // shared geometry + cloned stadium discs
  resetPositions(rs, gs);
}

/** Destroys the game (StopGame / end of Ending phase): players lose disc and number. */
export function destroyGame(rs: RoomState): void {
  rs.gameState = null;
  const players = rs.players;
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    p.disc = null;
    p.avatarNumber = 0;
  }
}

/**
 * (Re)creates the disc of `player` with player physics at its join position
 * (official `Q.af`): last spawn point of the team, else `side·width, 0`.
 * Spectators lose their disc reference (the disc itself is not removed here).
 */
export function spawnPlayerDisc(gs: GameState, player: Player): void {
  if (player.team === TeamId.Spectators) {
    player.disc = null;
    return;
  }
  player.input = 0;
  let disc = player.disc;
  if (disc === null) {
    disc = new Disc();
    player.disc = disc;
    gs.world.discs.push(disc);
  }
  const stadium = gs.stadium!;
  const pp = stadium.playerPhysics;
  const team = TEAMS[player.team];
  disc.color = 0;
  disc.radius = pp.radius;
  disc.invMass = pp.invMass;
  disc.damping = pp.damping;
  disc.bCoef = pp.bCoef;
  disc.cMask = PLAYER_CMASK;
  disc.cGroup = team.cGroup | pp.cGroup;
  const spawns = player.team === TeamId.Red ? stadium.redSpawnPoints : stadium.blueSpawnPoints;
  if (spawns.length === 0) {
    disc.x = team.side * stadium.width;
    disc.y = 0;
  } else {
    const s = spawns[spawns.length - 1]!;
    disc.x = s.x;
    disc.y = s.y;
  }
  disc.xspeed = 0;
  disc.yspeed = 0;
  disc.xgravity = pp.gravityX;
  disc.ygravity = pp.gravityY;
}

/**
 * Kick-off reset (official `Q.bf`): phase 0, restore the ball (or all stadium
 * discs with `fullKickOffReset`), respawn every player in list order.
 */
export function resetPositions(rs: RoomState, gs: GameState): void {
  const players = rs.players;
  gs.phase = GamePhase.BeforeKickOff;
  const stadium = gs.stadium!;
  const sDiscs = stadium.discs;
  const wDiscs = gs.world.discs;
  const n = stadium.fullKickOffReset ? sDiscs.length : 1;
  for (let i = 0; i < n; i++) copyDiscProps(wDiscs[i]!, sDiscs[i]!);
  spawnCounts[0] = 0;
  spawnCounts[1] = 0;
  spawnCounts[2] = 0;
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    spawnPlayerDisc(gs, p);
    const teamId = p.team;
    if (teamId === TeamId.Spectators) continue;
    const disc = p.disc!;
    let k = spawnCounts[teamId]!;
    const spawns = teamId === TeamId.Red ? stadium.redSpawnPoints : stadium.blueSpawnPoints;
    let x: number;
    let y: number;
    if (spawns.length === 0) {
      let l = (k + 1) >> 1;
      if ((k & 1) === 0) l = -l; // k = 0 gives -0 (serialized as such)
      x = stadium.spawnDistance * TEAMS[teamId].side;
      y = 55 * l;
    } else {
      if (k >= spawns.length) k = spawns.length - 1;
      const s = spawns[k]!;
      x = s.x;
      y = s.y;
    }
    disc.x = x;
    disc.y = y;
    spawnCounts[teamId] = spawnCounts[teamId]! + 1;
    p.avatarNumber = spawnCounts[teamId]!;
  }
}

/**
 * Moves `player` to `team` (official `Ta.Ic`): moved to the END of the list;
 * with a running game the old disc is removed and a new one appended, and
 * the player gets the smallest free avatar number of its new team.
 */
export function setPlayerTeam(rs: RoomState, byPlayer: Player | null, player: Player, team: TeamId): void {
  if (player.team === team) return;
  player.team = team;
  removeItem(rs.players, player);
  rs.players.push(player);
  const gs = rs.gameState;
  if (gs !== null) {
    if (player.disc !== null) {
      removeItem(gs.world.discs, player.disc);
      player.disc = null;
    }
    spawnPlayerDisc(gs, player);
    const players = rs.players;
    let num = 0;
    let free = false;
    while (!free) {
      ++num;
      free = true;
      for (let i = 0; i < players.length; i++) {
        const o = players[i]!;
        if (o !== player && o.team === player.team && o.avatarNumber === num) {
          free = false;
          break;
        }
      }
    }
    player.avatarNumber = num;
  }
  const h = rs.hooks.onPlayerTeamChange;
  if (h !== null) h(byPlayer, player, team);
}

/** official `Ta.ai`: clamps and stores the kick rate limit. */
export function setKickRateLimit(rs: RoomState, byPlayer: Player | null, min: number, rate: number, burst: number): void {
  rs.kickRateMin = min < 0 ? 0 : min > 255 ? 255 : min;
  rs.kickRateRate = rate < 0 ? 0 : rate > 255 ? 255 : rate;
  if (burst < 0) burst = 0;
  else if (burst > 100) burst = 100;
  rs.kickRateMax = rs.kickRateRate * burst;
  const h = rs.hooks.onKickRateLimitSet;
  if (h !== null) h(byPlayer, rs.kickRateMin, rs.kickRateRate, burst);
}

// --------------------------------------------------------------------- tick

/** One 1/60 s tick of the room (official `Ta.Da(1)`). Allocation-free. */
export function stepRoom(rs: RoomState): void {
  const gs = rs.gameState;
  if (gs !== null) stepGame(rs, gs);
}

/** official `Q.Da(1)`. */
function stepGame(rs: RoomState, gs: GameState): void {
  if (gs.pauseGameTickCounter > 0) {
    if (gs.pauseGameTickCounter < PAUSED_TICKS) gs.pauseGameTickCounter--;
    return;
  }
  const hooks = rs.hooks;
  if (hooks.onGameTick !== null) hooks.onGameTick();

  const players = rs.players;
  const discs = gs.world.discs;
  const pp = gs.stadium!.playerPhysics;
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    const me = p.disc;
    if (me === null) continue;
    if ((p.input & IN_KICK) === 0) p.isKicking = false;
    if (p.kickRateMinTickCounter > 0) p.kickRateMinTickCounter--;
    if (p.kickRateMaxTickCounter < rs.kickRateMax) p.kickRateMaxTickCounter++;
    if (p.isKicking && p.kickRateMinTickCounter <= 0 && p.kickRateMaxTickCounter >= 0) {
      let kicked = false;
      for (let j = 0; j < discs.length; j++) {
        const d = discs[j]!;
        if ((d.cGroup & FLAG_KICK) === 0 || d === me) continue;
        const dx = d.x - me.x;
        const dy = d.y - me.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist - d.radius - me.radius < KICK_REACH) {
          const nx = dx / dist;
          const ny = dy / dist;
          const strength = pp.kickStrength;
          const im = d.invMass;
          d.xspeed = d.xspeed + nx * strength * im;
          d.yspeed = d.yspeed + ny * strength * im;
          const back = -pp.kickback;
          const myIm = me.invMass;
          me.xspeed = me.xspeed + nx * back * myIm;
          me.yspeed = me.yspeed + ny * back * myIm;
          kicked = true;
        }
      }
      if (kicked) {
        if (hooks.onPlayerBallKick !== null) hooks.onPlayerBallKick(p);
        p.isKicking = false;
        p.kickRateMinTickCounter = rs.kickRateMin;
        p.kickRateMaxTickCounter -= rs.kickRateRate;
      }
    }
    const input = p.input;
    let dx = 0;
    let dy = 0;
    if ((input & IN_UP) !== 0) --dy;
    if ((input & IN_DOWN) !== 0) ++dy;
    if ((input & IN_LEFT) !== 0) --dx;
    if ((input & IN_RIGHT) !== 0) ++dx;
    if (dx !== 0 && dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len;
      dy /= len;
    }
    const acc = p.isKicking ? pp.kickingAcceleration : pp.acceleration;
    me.xspeed += dx * acc;
    me.yspeed += dy * acc;
    me.damping = p.isKicking ? pp.kickingDamping : pp.damping;
  }

  let scoreCount = 0;
  for (let i = 0, n = discs.length; i < n; i++) {
    const d = discs[i]!;
    if ((d.cGroup & FLAG_SCORE) !== 0) {
      scoreDiscIndex[scoreCount] = i;
      scorePrevX[scoreCount] = d.x;
      scorePrevY[scoreCount] = d.y;
      ++scoreCount;
    }
  }

  stepWorld(gs.world, 1);

  const phase = gs.phase;
  if (phase === GamePhase.BeforeKickOff) {
    const mask = PLAYER_CMASK | TEAMS[gs.goalConcedingTeam].koFlag;
    for (let i = 0; i < players.length; i++) {
      const d = players[i]!.disc;
      if (d !== null) d.cMask = mask;
    }
    const ball = discs[0]!;
    if (0 < ball.xspeed * ball.xspeed + ball.yspeed * ball.yspeed) gs.phase = GamePhase.Playing;
  } else if (phase === GamePhase.Playing) {
    gs.timeElapsed += TICK_SECONDS;
    for (let i = 0; i < players.length; i++) {
      const d = players[i]!.disc;
      if (d !== null) d.cMask = PLAYER_CMASK;
    }
    let owner: TeamId = TeamId.Spectators;
    const stadium = gs.stadium!;
    for (let i = 0; i < scoreCount; i++) {
      const d = discs[scoreDiscIndex[i]!]!;
      owner = goalCrossed(stadium, d.x, d.y, scorePrevX[i]!, scorePrevY[i]!) as TeamId;
      if (owner !== TeamId.Spectators) break;
    }
    if (owner !== TeamId.Spectators) {
      gs.phase = GamePhase.AfterGoal;
      gs.goalTickCounter = GOAL_TICKS;
      gs.goalConcedingTeam = owner;
      if (owner === TeamId.Red) gs.blueScore++;
      else gs.redScore++;
      if (hooks.onTeamGoal !== null) hooks.onTeamGoal(TEAMS[owner].rival);
      if (hooks.onGoalMarker !== null) hooks.onGoalMarker(owner);
    } else if (0 < gs.timeLimit && gs.timeElapsed >= 60 * gs.timeLimit && gs.redScore !== gs.blueScore) {
      if (hooks.onTimeLimitReached !== null) hooks.onTimeLimitReached();
      endGame(rs, gs);
    }
  } else if (phase === GamePhase.AfterGoal) {
    gs.goalTickCounter--;
    if (gs.goalTickCounter <= 0) {
      if (
        (0 < gs.scoreLimit && (gs.redScore >= gs.scoreLimit || gs.blueScore >= gs.scoreLimit)) ||
        (0 < gs.timeLimit && gs.timeElapsed >= 60 * gs.timeLimit && gs.redScore !== gs.blueScore)
      ) {
        endGame(rs, gs);
      } else {
        resetPositions(rs, gs);
        if (hooks.onPositionsReset !== null) hooks.onPositionsReset();
      }
    }
  } else if (phase === GamePhase.Ending) {
    gs.goalTickCounter--;
    if (gs.goalTickCounter <= 0 && rs.gameState !== null) {
      destroyGame(rs);
      if (hooks.onGameStop !== null) hooks.onGameStop(null);
    }
  }
}

/** official `Q.Jf`. */
function endGame(rs: RoomState, gs: GameState): void {
  gs.goalTickCounter = ENDING_TICKS;
  gs.phase = GamePhase.Ending;
  const h = rs.hooks.onTeamVictory;
  if (h !== null) h(gs.redScore > gs.blueScore ? TeamId.Red : TeamId.Blue);
}
