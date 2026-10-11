/**
 * Clean shutdown: a child process using the BUILT package (dist, via the
 * package `exports`) hosts a room, a node-haxball client joins, the room
 * stops (last room -> node-datachannel cleanup), a second room is created
 * afterwards in the same process (WebRTC re-initialises), and the process
 * must exit on its own, promptly, without process.exit(). In the `rtc`
 * project the rooms use haxlite-rtc: its UDP socket must not keep the process
 * alive either, and node-datachannel must never be loaded.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPackage, removePackage } from './build-package.js';
import { join, shutdownAll, startEnv, withTimeout, type Env } from './harness.js';
import { RTC_UNDER_TEST, testHaxliteBackend } from '../peer-backend-env.js';

let OUT = '';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
  OUT = buildPackage('haxlite-api-shutdown-test');
  writeFileSync(
    path.join(OUT, 'child.mjs'),
    `
import { HBInit } from 'haxlite';
import { createRequire } from 'node:module';
const masterUrl = process.argv[2];
const backend = JSON.parse(process.argv[3] ?? '{}');
async function once(n) {
  const room = await HBInit({ roomName: 'shutdown ' + n, noPlayer: true, token: 'thr1.test', haxlite: { masterUrl, iceServers: [], ...backend, transport: { iceCandidatePolicy: 'all' } } });
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
const ndcLoaded = Object.keys(createRequire(import.meta.url).cache).some((k) => k.includes('node-datachannel'));
console.log('ndc ' + ndcLoaded);
console.log('stopped ' + performance.now());
`,
  );
}, 60_000);

afterAll(async () => {
  await env.master.close();
  await shutdownAll();
  removePackage(OUT);
});

describe('clean shutdown', () => {
  it('the process exits by itself right after the last room stops (and rooms can be recreated)', async () => {
    const child = spawn(process.execPath, [path.join(OUT, 'child.mjs'), env.master.httpBase, JSON.stringify(testHaxliteBackend())], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = new Promise<{ code: number | null; at: number }>((resolve) =>
      child.on('exit', (code) => resolve({ code, at: performance.now() })),
    );
    let stoppedAt = 0;
    let ndcLoaded: string | null = null;
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
      } else if (line.startsWith('ndc ')) ndcLoaded = line.slice(4);
      else if (line.startsWith('stopped ')) stoppedAt = performance.now();
    });
    try {
      const { code, at } = await withTimeout(exited, 45_000, 'child exit');
      expect(code).toBe(0);
      expect(links.length).toBe(2);
      expect(stoppedAt).toBeGreaterThan(0);
      // nothing keeps the event loop alive once the last room stopped
      expect(at - stoppedAt).toBeLessThan(1500);
      expect(clients.length).toBe(2);
      // node-datachannel is loaded lazily: an rtc-only process never loads it (no native threads)
      expect(ndcLoaded).toBe(RTC_UNDER_TEST ? 'false' : 'true');
    } finally {
      child.kill('SIGKILL');
      for (const c of clients) c.leave();
    }
  });
});
