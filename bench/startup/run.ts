/**
 * Cold-start benchmark of a basic HBInit room: fresh `node` process →
 * `import` of the package entry → `HBInit` → room link (FakeMaster, offline).
 * Entries are interleaved so machine drift affects all alike.
 *
 *   node --no-warnings --import ./bench/ts-resolve.mjs \
 *     bench/startup/run.ts <reps> <label=entry.js> [<label=entry.js> …] [-- node flags…]
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import { FakeMaster } from '../../test/fake-master/index.js';

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const nodeArgs = dd >= 0 ? argv.slice(dd + 1) : [];
const args = dd >= 0 ? argv.slice(0, dd) : argv;
const reps = Number(args[0]);
const entries = args.slice(1).map((s) => {
  const i = s.indexOf('=');
  return { label: s.slice(0, i), entry: path.resolve(s.slice(i + 1)) };
});
const child = path.join(import.meta.dirname, 'child.mjs');
const master = await FakeMaster.start();
const results: Record<string, Record<string, number>[]> = {};
for (let r = 0; r < reps; r++) {
  for (const { label, entry } of entries) {
    const res = await new Promise<Record<string, number>>((resolve, reject) => {
      const p = fork(child, [entry, master.httpBase], { execArgv: nodeArgs, stdio: 'inherit' });
      p.once('message', (m) => resolve(m as Record<string, number>));
      p.once('exit', (code) => code !== 0 && reject(new Error(`${label}: exit ${code}`)));
    });
    (results[label] ??= []).push(res);
  }
}
await master.close();
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const out: Record<string, Record<string, number>> = {};
for (const [label, rs] of Object.entries(results)) {
  out[label] = {};
  for (const k of Object.keys(rs[0]!)) if (typeof rs[0]![k] === 'number') out[label]![k] = +med(rs.map((x) => x[k]!)).toFixed(1);
}
console.log(JSON.stringify({ reps, nodeArgs, median: out }, null, 1));
