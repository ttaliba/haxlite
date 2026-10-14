/**
 * The examples in examples/ run unmodified against the built package
 * (`import 'haxlite'`) and the FakeMaster, driven by node-haxball clients;
 * SIGINT stops the room and the process exits on its own.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, buildPackage, removePackage } from './build-package.js';
import { join, shutdownAll, sleep, startEnv, waitFor, withTimeout, type Any, type Client, type Env } from './harness.js';

let env: Env;
let OUT = '';
beforeAll(async () => {
  env = await startEnv();
  OUT = buildPackage('haxlite-api-examples-test');
  for (const f of ['basic-room.mjs', 'moderation.mjs', 'among-us-vision.mjs']) copyFileSync(path.join(ROOT, 'examples', f), path.join(OUT, f));
}, 60_000);
afterAll(async () => {
  await env.master.close();
  await shutdownAll();
  removePackage(OUT);
});

interface Running {
  child: ChildProcess;
  lines: string[];
  roomId: Promise<string>;
  exited: Promise<number | null>;
}

function run(script: string, extraEnv: Record<string, string>): Running {
  const child = spawn(process.execPath, [path.join(OUT, script)], {
    cwd: OUT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      HAXBALL_TOKEN: 'thr1.test',
      HAXLITE_OPTIONS: JSON.stringify({ masterUrl: env.master.httpBase, iceServers: [], transport: { iceCandidatePolicy: 'all' } }),
      ...extraEnv,
    },
  });
  const lines: string[] = [];
  let gotId!: (id: string) => void;
  const roomId = new Promise<string>((r) => (gotId = r));
  createInterface({ input: child.stdout! }).on('line', (line) => {
    lines.push(line);
    const m = /^Room link: .*c=([^&]+)/.exec(line);
    if (m) gotId(m[1]!);
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, lines, roomId: withTimeout(roomId, 20_000, `${script} room link`), exited };
}

async function interrupt(r: Running): Promise<number | null> {
  r.child.kill('SIGINT');
  return withTimeout(r.exited, 5000, 'example exit after SIGINT');
}

const playerOf = (c: Client, id: number): Any => c.room.players.find((p: Any) => p.id === id);

describe('examples', () => {
  it('basic-room.mjs: admin, auto teams, auto start, !bb, clean SIGINT exit', async () => {
    const r = run('basic-room.mjs', {});
    const clients: Client[] = [];
    try {
      const roomId = await r.roomId;
      const alice = await join(env, roomId, 'alice');
      clients.push(alice);
      await waitFor(() => playerOf(alice, 1)?.isAdmin === true && playerOf(alice, 1)?.team?.id === 1, 5000, 'alice admin + red');
      const bob = await join(env, roomId, 'bob');
      clients.push(bob);
      await waitFor(() => playerOf(bob, 2)?.team?.id === 2 && bob.room.gameState != null, 5000, 'bob blue + game started');
      expect(alice.announcements.some((a) => a.startsWith('Welcome alice'))).toBe(true);
      bob.room.sendChat('!bb');
      const err = await withTimeout(bob.closed, 10_000, 'bob left with !bb');
      expect(err.params?.[0]).toBe('Bye!');
      expect(alice.chats.some(([, m]) => m === '!bb')).toBe(false); // commands are hidden
      expect(r.lines.some((l) => l === 'alice joined (auth ' + playerAuth(r, 'alice') + ', conn 3132372E302E302E31)')).toBe(true);
      expect(await interrupt(r)).toBe(0);
    } finally {
      for (const c of clients) c.leave();
      r.child.kill('SIGKILL');
    }
  });

  it('among-us-vision.mjs: per-player fog, hidden players and ghosts, task marker, no desync', async () => {
    const opts = { masterUrl: env.master.httpBase, iceServers: [], transport: { iceCandidatePolicy: 'all' }, checksumIntervalFrames: 30 };
    const r = run('among-us-vision.mjs', { HAXLITE_OPTIONS: JSON.stringify(opts) });
    const clients: Client[] = [];
    const disc = (c: Client, i: number): Any => c.room.gameState?.physicsState?.discs?.[i] ?? null;
    const at = (c: Client, i: number) => [disc(c, i)?.pos.x, disc(c, i)?.pos.y];
    /** Player `id` as `c` sees it: null (no disc), 'hidden' (NaN) or [x, y]. */
    const sees = (c: Client, id: number): Any => {
      const d = c.room.getPlayer(id)?.disc;
      return d == null ? null : Number.isNaN(d.pos.x) && Number.isNaN(d.pos.y) ? 'hidden' : [d.pos.x, d.pos.y];
    };
    const visible = (c: Client, id: number) => Array.isArray(sees(c, id));
    const steer = (c: Client, target: () => { x: number; y: number }, done: () => boolean, what: string) => {
      const t = setInterval(() => {
        const me = c.room.getPlayer(c.room.currentPlayerId)?.disc?.pos;
        if (!me) return;
        const to = target();
        const dx = to.x - me.x;
        const dy = to.y - me.y;
        c.room.setKeyState((dy < -10 ? 1 : dy > 10 ? 2 : 0) | (dx < -10 ? 4 : dx > 10 ? 8 : 0));
      }, 50);
      return waitFor(done, 10_000, what).finally(() => {
        clearInterval(t);
        c.room.setKeyState(0);
      });
    };
    try {
      const roomId = await r.roomId;
      const alice = await join(env, roomId, 'alice');
      const bob = await join(env, roomId, 'bob');
      const carol = await join(env, roomId, 'carol');
      clients.push(alice, bob, carol);
      const [A, B, C] = clients.map((c) => c.room.currentPlayerId as number) as [number, number, number];
      const syncs: Any[] = [];
      for (const c of clients) c.room.onPlayerSyncChange = (id: number, v: boolean) => syncs.push([c.name, id, v]);
      // all spawn in the Cafeteria (left): each sees the Electrical fog (disc 2), not the Cafeteria one, and everyone
      await waitFor(() => clients.every((c) => at(c, 2)[0] === 10040 && at(c, 1)[1] === 50000), 10_000, 'initial fog');
      await sleep(300);
      for (const c of clients) for (const id of [A, B, C]) expect(visible(c, id)).toBe(true);

      // alice walks right into Electrical: her fog flips, she and the others stop seeing each other
      await steer(alice, () => ({ x: 200, y: 0 }), () => at(alice, 1)[0] === -10040 && at(alice, 2)[1] === 50000, 'alice fog flipped');
      expect(at(bob, 2)).toEqual([10040, 0]);
      expect(at(bob, 1)).toEqual([0, 50000]);
      await waitFor(
        () => sees(bob, A) === 'hidden' && sees(carol, A) === 'hidden' && sees(alice, B) === 'hidden' && sees(alice, C) === 'hidden',
        5000,
        'alice hidden',
      );
      expect(visible(bob, C) && visible(carol, B)).toBe(true);

      // she reaches the task marker: lit only for her, private prompt only for her
      await steer(alice, () => ({ x: 175, y: -50 }), () => disc(alice, 3)?.color === 0xffd700, 'task marker lit');
      expect(disc(bob, 3).color).toBe(0x555555);
      // the prompt is a msg 6 on another channel: no ordering with the sequenced marker update
      await waitFor(() => alice.announcements.includes('Task: fix wiring - stay here 3 s'), 5000, 'private prompt');
      expect(bob.announcements).not.toContain('Task: fix wiring - stay here 3 s');

      // carol kills bob: bob becomes a ghost, invisible to the living; he sees everyone (no fog)
      const bobAt = () => carol.room.getPlayer(B).disc.pos;
      const carolAt = () => carol.room.getPlayer(C).disc.pos;
      await steer(carol, bobAt, () => Math.hypot(carolAt().x - bobAt().x, carolAt().y - bobAt().y) < 45, 'carol next to bob');
      carol.room.sendChat('!kill');
      await waitFor(() => sees(carol, B) === 'hidden' && sees(alice, B) === 'hidden', 5000, 'bob hidden from the living');
      await waitFor(() => visible(bob, A) && visible(bob, C) && at(bob, 1)[1] === 50000 && at(bob, 2)[1] === 50000, 5000, 'the ghost sees all');
      expect(carol.announcements).toContain('You killed bob');
      expect(bob.announcements).toContain('You are a ghost: only other ghosts can see you');
      expect(alice.chats.some(([, m]) => m === '!kill')).toBe(false);
      // bob walks through the wall into Electrical (ghosts are c0: walls don't stop them), still hidden
      await steer(bob, () => ({ x: 120, y: 90 }), () => (bob.room.getPlayer(B)?.disc?.pos.x ?? 0) > 60, 'ghost through the wall');
      await sleep(200);
      expect(sees(alice, B)).toBe('hidden');
      expect(sees(carol, B)).toBe('hidden');

      await sleep(1200); // >= one CheckConsistency round with private worlds
      expect(syncs).toEqual([]);
      expect(await interrupt(r)).toBe(0);
    } finally {
      for (const c of clients) c.leave();
      r.child.kill('SIGKILL');
    }
  });

  it('moderation.mjs: persistent bans, re-ban on rejoin, quarantine, mute, ban/unban', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'haxlite-mod-'));
    const file = path.join(dir, 'moderation.json');
    const [aliceKey, aliceAuth] = (await env.nh.Utils.generateAuth()) as [string, Any];
    const [eveKey, eveAuth] = (await env.nh.Utils.generateAuth()) as [string, Any];
    const alicePub = aliceKey.split('.')[1]!;
    const evePub = eveKey.split('.')[1]!;
    writeFileSync(
      file,
      JSON.stringify({
        nextBanId: 3,
        bans: [
          { id: 1, name: 'eve', auth: evePub, ips: ['10.9.9.9'], cidr: null, reason: 'cheating', by: 'admin', at: 0 },
          { id: 2, name: '203.0.113.0/24', auth: null, ips: [], cidr: '203.0.113.0/24', reason: 'range', by: 'admin', at: 0 },
        ],
        known: {},
      }),
    );
    const r = run('moderation.mjs', { MODERATION_FILE: file, ADMIN_AUTHS: alicePub, QUARANTINE_MS: '6000' });
    const clients: Client[] = [];
    try {
      const roomId = await r.roomId;
      // stored CIDR ban applies at signaling time
      env.master.clientIp = () => '203.0.113.7';
      let n = env.master.rejections.length;
      await expect(join(env, roomId, 'ranged', { timeoutMs: 10_000 })).rejects.toBeTruthy();
      expect(env.master.rejections.slice(n).map((x) => x.code)).toEqual([4102]);
      env.master.clientIp = null;

      const alice = await join(env, roomId, 'alice', { authObj: aliceAuth });
      const aliceJoined = performance.now(); // >= the host's first-seen timestamp
      clients.push(alice);
      await waitFor(() => playerOf(alice, 1)?.isAdmin === true, 5000, 'alice admin by auth');
      const bob = await join(env, roomId, 'bob');
      clients.push(bob);
      // quarantine: new auths cannot chat yet
      alice.room.sendChat('too early');
      await waitFor(() => alice.announcements.includes('New players cannot chat yet.'), 5000, 'quarantine notice');
      await sleep(Math.max(0, aliceJoined + 6100 - performance.now()));
      alice.room.sendChat('now ok');
      await waitFor(() => bob.chats.some(([, m]) => m === 'now ok'), 5000, 'chat after quarantine');
      expect(bob.chats.some(([, m]) => m === 'too early')).toBe(false);
      // mute / unmute bob
      alice.room.sendChat('!mute 2');
      await waitFor(() => alice.announcements.includes('Player 2 muted.'), 5000, 'muted');
      bob.room.sendChat('muted msg');
      await waitFor(() => bob.announcements.includes('You are muted.'), 5000, 'mute notice');
      expect(alice.chats.some(([, m]) => m === 'muted msg')).toBe(false);
      // !ban bob -> persisted with auth + IP, native ban for the session; then unban
      alice.room.sendChat('!ban 2 spamming');
      const bobErr = await withTimeout(bob.closed, 10_000, 'bob banned');
      expect(bobErr.params?.slice(0, 2)).toEqual(['spamming', true]);
      await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).bans.length === 3, 5000, 'ban saved');
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(saved.bans[2]).toMatchObject({ id: 3, name: 'bob', reason: 'spamming', by: 'alice' });
      // conn IP first; a client that reaches a STUN server (e.g. on CI) adds its srflx IP too
      expect(saved.bans[2].ips[0]).toBe('127.0.0.1');
      n = env.master.rejections.length;
      await expect(join(env, roomId, 'bob2', { timeoutMs: 10_000 })).rejects.toBeTruthy();
      expect(env.master.rejections.slice(n).map((x) => x.code)).toEqual([4102]);
      alice.room.sendChat('!unban 3');
      await waitFor(() => alice.announcements.some((a) => a.startsWith('Ban #3 (bob) removed')), 5000, 'unban');
      // a banned auth coming back from a new IP is kicked with a native ban and the IP is stored
      const eve = await join(env, roomId, 'eve', { authObj: eveAuth }).catch(() => null);
      if (eve !== null) {
        clients.push(eve);
        const eveErr = await withTimeout(eve.closed, 10_000, 'eve re-banned');
        expect(eveErr.params?.slice(0, 2)).toEqual(['Banned: cheating', true]);
      }
      await waitFor(() => JSON.parse(readFileSync(file, 'utf8')).bans[0].ips.includes('127.0.0.1'), 5000, 'eve ip saved');
      expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).known)).toContain(alicePub);
      expect(await interrupt(r)).toBe(0);
    } finally {
      env.master.clientIp = null;
      for (const c of clients) c.leave();
      r.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The auth the example printed for a player (any value: just checks the log format). */
function playerAuth(r: Running, name: string): string {
  const line = r.lines.find((l) => l.startsWith(`${name} joined (auth `)) ?? '';
  return line.slice(`${name} joined (auth `.length).split(',')[0]!;
}
