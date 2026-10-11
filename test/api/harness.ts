/**
 * TEST ONLY: HBInit facade + FakeMaster + node-haxball clients, offline.
 * One FakeMaster/node-haxball per test file (node-haxball config is global).
 */
import { FakeMaster } from '../fake-master/index.js';
import { cleanupNodeHaxball, nodeHaxballFor } from '../fake-master/node-haxball.js';
import { HBInit, type RoomConfigObject, type RoomObject } from '../../src/api/index.js';
import { shutdownWebRtc } from '../../src/net/index.js';
import { testHaxliteBackend } from '../peer-backend-env.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

export async function waitFor(cond: () => boolean, ms: number, what: string, poll = 10): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(poll);
  }
}

export interface Client {
  readonly name: string;
  room: Any;
  closeError: Any;
  readonly closed: Promise<Any>;
  /** Chat messages received by this client: `[fromId, text]`. */
  readonly chats: [number, string][];
  readonly announcements: string[];
  leave(): void;
}

export interface Env {
  master: FakeMaster;
  nh: Any;
}

export async function startEnv(): Promise<Env> {
  const master = await FakeMaster.start();
  return { master, nh: nodeHaxballFor(master) };
}

/** HBInit pointed at the fake master (no STUN). */
export async function startRoom(env: Env, config: RoomConfigObject = {}): Promise<{ room: RoomObject; roomId: string }> {
  const room = await HBInit({
    token: 'thr1.test',
    ...config,
    haxlite: {
      masterUrl: env.master.httpBase,
      iceServers: [],
      shutdownWebRtcOnLastStop: false,
      ...testHaxliteBackend(),
      ...config.haxlite,
      // loopback test: the host must offer its 127.0.0.1 candidates
      transport: { iceCandidatePolicy: 'all', ...config.haxlite?.transport },
    },
  });
  const link = room.haxlite.roomLink!;
  return { room, roomId: link.slice(link.indexOf('c=') + 2).split('&')[0]! };
}

/** Joins a node-haxball client; resolves once it has the snapshot. */
export async function join(
  env: Env,
  roomId: string,
  name: string,
  opts: { authObj?: Any; password?: string | null; avatar?: string | null; flag?: string; timeoutMs?: number } = {},
): Promise<Client> {
  const authObj = opts.authObj ?? ((await env.nh.Utils.generateAuth()) as [string, Any])[1];
  let resolveClosed!: (e: Any) => void;
  let resolveOpen!: (room: Any) => void;
  let rejectOpen!: (e: Any) => void;
  const opened = new Promise<Any>((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });
  const c: Client = {
    name,
    room: null,
    closeError: null,
    closed: new Promise((r) => (resolveClosed = r)),
    chats: [],
    announcements: [],
    leave: () => {},
  };
  const j = env.nh.Room.join(
    { id: roomId, password: opts.password ?? null, authObj },
    {
      storage: { player_name: name, avatar: opts.avatar ?? null, geo: { lat: 0, lon: 0, flag: opts.flag ?? 'uy' } },
      onOpen: (room: Any) => {
        c.room = room;
        room.onPlayerChat = (id: number, msg: string) => {
          c.chats.push([id, msg]);
        };
        room.onAnnouncement = (msg: string) => {
          c.announcements.push(msg);
        };
        resolveOpen(room);
      },
      onClose: (err: Any) => {
        c.closeError = err ?? true;
        resolveClosed(err);
        rejectOpen(err ?? new Error('closed before open'));
      },
    },
  );
  c.leave = () => {
    try {
      j.cancel();
    } catch {
      /* gone */
    }
    try {
      c.room?.leave();
    } catch {
      /* gone */
    }
  };
  try {
    await withTimeout(opened, opts.timeoutMs ?? 30_000, `join ${name}`);
  } catch (err) {
    c.leave();
    throw err;
  }
  return c;
}

/** afterAll of every file. */
export async function shutdownAll(): Promise<void> {
  await shutdownWebRtc();
  cleanupNodeHaxball();
}

/** Records every official callback of `room` as `[name, ...args]` (args deep-copied). */
export function recordCallbacks(room: RoomObject, skip: readonly string[] = ['onGameTick', 'onPlayerActivity', 'onPlayerInput']): Any[][] {
  const log: Any[][] = [];
  const names = [
    'onPlayerJoin',
    'onPlayerLeave',
    'onTeamVictory',
    'onPlayerChat',
    'onPlayerBallKick',
    'onTeamGoal',
    'onGameStart',
    'onGameStop',
    'onPlayerAdminChange',
    'onPlayerTeamChange',
    'onPlayerKicked',
    'onGameTick',
    'onGamePause',
    'onGameUnpause',
    'onPositionsReset',
    'onPlayerActivity',
    'onPlayerInput',
    'onStadiumChange',
    'onKickRateLimitSet',
    'onTeamsLockChange',
  ];
  for (const n of names) {
    if (skip.includes(n)) continue;
    (room as Any)[n] = (...args: Any[]) => {
      log.push([n, ...JSON.parse(JSON.stringify(args))]);
    };
  }
  return log;
}
