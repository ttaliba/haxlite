/**
 * Short run of the network stress harness (test/net/stress.ts) in a child
 * process: churn with malformed/aborted/flooding clients must not crash the
 * process, leak peers or native objects, and the process must exit by itself
 * right after shutdown. Longer runs: see the header of stress.ts.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

it('stress smoke: churn, no crash, no leaks, prompt exit', async () => {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--expose-gc',
      '--import',
      './scripts/ts-resolve.mjs',
      'test/net/stress.ts',
      '--seconds',
      '9',
      '--clients',
      '12',
      '--quiet',
      '--seed',
      String((Date.now() & 0xffff) + 1),
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.on('exit', (c, s) => resolve([c, s])),
  );
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  expect(signal, out).toBeNull();
  expect(line, out).toBeDefined();
  const result = JSON.parse(line!.slice(7)) as { failures: string[]; joins: number; natives: { peerConnections: number } };
  expect(result.failures, out).toEqual([]);
  expect(result.joins).toBeGreaterThan(0);
  expect(out).toMatch(/EXIT after \d+ ms/);
  expect(code, out).toBe(0);
}, 90_000);
