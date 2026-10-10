/**
 * Clean shutdown: a child process using the BUILT package (dist, via the
 * package `exports`) hosts a room, a node-haxball client joins, the room
 * stops (last room -> node-datachannel cleanup), a second room is created
 * afterwards in the same process (WebRTC re-initialises), and the process
 * must exit on its own, promptly, without process.exit().
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPackage, removePackage } from './build-package.js';
import { join, shutdownAll, startEnv, withTimeout, type Env } from './harness.js';

let OUT = '';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
  OUT = buildPackage('haxlite-api-shutdown-test');
  writeFileSync(
    path.join(OUT, 'child.mjs'),
    `
import { HBInit } from 'haxlite';
const masterUrl = process.argv[2];
async function once(n) {
  const room = await HBInit({ roomName: 'shutdown ' + n, noPlayer: true, token: 'thr1.test', haxlite: { masterUrl, iceServers: [], transport: { iceCandidatePolicy: 'all' } } });
  const joined = new Promise((r) => (room.onPlayerJoin = r));
  console.log('link ' + room.haxlite.roomLink);
  await joined;
  room.setPlayerTeam(1, 1);
  room.startGame();
  await new Promise((r) => setTimeout(r, 300));
  await room.haxlite.stop();
}
await once(1);
await once(2);
console.log('stopped ' + performance.now());
`,
  );
}, 60_000);

afterAll(async () => {
  await env.master.close();
  shutdownAll();
  removePackage(OUT);
});

describe('clean shutdown', () => {
  it('the process exits by itself right after the last room stops (and rooms can be recreated)', async () => {
    const child = spawn(process.execPath, [path.join(OUT, 'child.mjs'), env.master.httpBase], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<{ code: number | null; at: number }>((resolve) =>
      child.on('exit', (code) => resolve({ code, at: performance.now() })),
    );
    let stoppedAt = 0;
    const links: string[] = [];
    const rl = createInterface({ input: child.stdout });
    const clients: { leave(): void }[] = [];
    rl.on('line', (line) => {
      if (line.startsWith('link ')) {
        links.push(line.slice(5));
        const id = line.slice(line.indexOf('c=') + 2);
        join(env, id, `p${links.length}`).then(
          (c) => clients.push(c),
          () => {},
        );
      } else if (line.startsWith('stopped ')) stoppedAt = performance.now();
    });
    try {
      const { code, at } = await withTimeout(exited, 45_000, 'child exit');
      expect(code).toBe(0);
      expect(links.length).toBe(2);
      expect(stoppedAt).toBeGreaterThan(0);
      // nothing keeps the event loop alive once the last room stopped
      expect(at - stoppedAt).toBeLessThan(1500);
      expect(clients.length).toBe(2);
    } finally {
      child.kill('SIGKILL');
      for (const c of clients) c.leave();
    }
  });
});
