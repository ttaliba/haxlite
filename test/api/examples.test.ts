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
  for (const f of ['basic-room.mjs', 'moderation.mjs']) copyFileSync(path.join(ROOT, 'examples', f), path.join(OUT, f));
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
      expect(saved.bans[2]).toMatchObject({ id: 3, name: 'bob', reason: 'spamming', by: 'alice', ips: ['127.0.0.1'] });
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
