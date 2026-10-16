// Build of haxlite for the benchmark hosts, skipped when nothing it depends on changed.
//
//   node bench/build.mjs [--force]
//
// Produces what bench/net/host-proc.mjs loads:
//   node_modules/.cache/haxlite-bench/dist     per-module tsc output (variants with `dist`, info.haxliteBuildSha)
//   node_modules/.cache/haxlite-bench/bundle   the shipped minified bundle (scripts/build.mjs), the default
// The two builds are independent and run concurrently. A stamp with the SHA-256 of
// every input (src/**, tsconfig*.json, scripts/build.mjs, package.json, package-lock.json
// and the installed typescript / rolldown versions) is written next to them; when the
// stamp matches and both outputs exist the build is skipped (~3 s per invocation saved,
// more on slow disks). --force (or HAXLITE_BENCH_REBUILD=1) always rebuilds.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'node_modules/.cache/haxlite-bench');
const DIST = path.join(CACHE, 'dist');
const BUNDLE = path.join(CACHE, 'bundle');
const STAMP = path.join(CACHE, 'build-stamp.json');
const force = process.argv.includes('--force') || process.env.HAXLITE_BENCH_REBUILD === '1';

function inputsHash() {
  const h = createHash('sha256');
  const add = (f) => {
    const p = path.join(ROOT, f);
    h.update(f.replaceAll('\\', '/')).update('\0');
    h.update(existsSync(p) ? readFileSync(p) : Buffer.alloc(0)).update('\0');
  };
  const walk = (d) => {
    for (const e of readdirSync(path.join(ROOT, d), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = `${d}/${e.name}`;
      if (e.isDirectory()) walk(f);
      else add(f);
    }
  };
  walk('src');
  for (const f of ['tsconfig.json', 'tsconfig.build.json', 'scripts/build.mjs', 'package.json', 'package-lock.json']) add(f);
  for (const dep of ['typescript', 'rolldown']) add(`node_modules/${dep}/package.json`);
  return h.digest('hex');
}

const sha = inputsHash();
let stamp = null;
try {
  stamp = JSON.parse(readFileSync(STAMP, 'utf8'));
} catch {
  /* first build */
}
if (!force && stamp?.sha === sha && existsSync(path.join(DIST, 'index.js')) && existsSync(path.join(BUNDLE, 'index.js'))) {
  console.log(`bench build up to date (${sha.slice(0, 12)}, built ${stamp.date}); --force to rebuild`);
  process.exit(0);
}

const t0 = Date.now();
rmSync(STAMP, { force: true });
mkdirSync(CACHE, { recursive: true });
const run = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')}: exit ${code}`))));
  });
rmSync(DIST, { recursive: true, force: true });
await Promise.all([
  run([path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', DIST, '--declaration', 'false', '--sourceMap', 'false']),
  run([path.join(ROOT, 'scripts/build.mjs'), '--out', BUNDLE]),
]);
writeFileSync(STAMP, JSON.stringify({ sha, date: new Date().toISOString() }));
console.log(`bench build ${sha.slice(0, 12)} in ${Date.now() - t0} ms`);
