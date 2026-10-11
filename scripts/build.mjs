// Package build: `tsc` (type-check + .d.ts + JS), then the JS is bundled by
// rolldown into one ESM file per entry point (dist/index.js, dist/edge/cli.js
// + one shared chunk) so `import 'haxlite'` loads 2 files instead of ~50
// (docs/07-benchmarks.md "Pasada de ligereza": ~20 ms less startup). The
// .d.ts tree stays as tsc emits it. Runtime deps stay external.
//
//   node scripts/build.mjs [--out <dir>]      (default: dist)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const out = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'dist');
const tmp = `${out}.tsc-tmp`;

rmSync(out, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(ROOT, 'tsconfig.build.json'), '--outDir', tmp], {
  stdio: 'inherit',
});

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
await build({
  input: { index: path.join(tmp, 'index.js'), 'edge/cli': path.join(tmp, 'edge/cli.js') },
  platform: 'node',
  external: (id) => id.startsWith('node:') || deps.some((d) => id === d || id.startsWith(`${d}/`)),
  logLevel: 'warn',
  output: { dir: out, format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'chunk-[hash].js' },
});

// keep tsc's declarations next to the bundle
function copyDts(from, to) {
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (statSync(src).isDirectory()) copyDts(src, dst);
    else if (name.endsWith('.d.ts')) {
      mkdirSync(to, { recursive: true });
      copyFileSync(src, dst);
    }
  }
}
copyDts(tmp, out);
rmSync(tmp, { recursive: true, force: true });
