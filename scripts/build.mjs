// Package build: `tsc` (type-check + .d.ts + JS), then the JS is bundled by
// rolldown into one ESM file per entry point (dist/index.js, dist/edge/cli.js
// + one shared chunk) so `import 'haxlite'` loads 2 files instead of ~50
// (docs/07-benchmarks.md "Pasada de ligereza": ~20 ms less startup). The
// .d.ts tree is tsc's, with JSDoc only in src/api (what HBInit users read in
// their editor) and the root entry points: tsc runs a second time without
// comments for the rest (403 KB -> 170 KB of declarations, same types).
// Runtime deps stay external, except json5 (see below). The JS is minified
// (558 KB -> 270 KB, ~4 ms faster import); pass --no-minify to debug.
//
//   node scripts/build.mjs [--out <dir>]      (default: dist)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const out = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'dist');
const tmp = `${out}.tsc-tmp`;
const tmpBare = `${out}.dts-tmp`;
// Top-level directories whose declarations keep their JSDoc; root files always do.
const DOCS_DIRS = new Set(['api']);

rmSync(out, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
rmSync(tmpBare, { recursive: true, force: true });
const tsc = (outDir, ...extra) =>
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(ROOT, 'tsconfig.build.json'), '--outDir', outDir, ...extra], {
    stdio: 'inherit',
  });
tsc(tmp);
tsc(tmpBare, '--emitDeclarationOnly', '--removeComments');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });

// json5 is a devDependency: sim/hbs.ts loads its parser on demand with
// createRequire(...)('json5/lib/parse.js'), which a bundler cannot follow. Turn
// that call into a plain require so the parser (25 KB) is inlined as a lazily
// evaluated module (it runs on the first .hbs that is not plain JSON, as
// before), and keep json5's MIT notice in front of it.
const json5Dir = path.join(ROOT, 'node_modules/json5');
const json5Require = /createRequire\(import\.meta\.url\)\((['"])json5\/lib\/parse\.js\1\)/;
const json5Bundle = {
  name: 'haxlite-json5',
  transform(code, id) {
    const file = id.split(path.sep).join('/');
    if (file.endsWith('/sim/hbs.js')) {
      if (!json5Require.test(code)) this.error('sim/hbs.ts no longer loads json5/lib/parse.js with createRequire(import.meta.url)(...)');
      return code.replace(json5Require, "require('json5/lib/parse.js')");
    }
    if (file.endsWith('/node_modules/json5/lib/parse.js')) {
      const license = readFileSync(path.join(json5Dir, 'LICENSE.md'), 'utf8').trim();
      const version = JSON.parse(readFileSync(path.join(json5Dir, 'package.json'), 'utf8')).version;
      return `/*! json5 ${version} (lib/parse.js)\n\n${license}\n*/\n${code}`;
    }
  },
};

await build({
  input: { index: path.join(tmp, 'index.js'), 'edge/cli': path.join(tmp, 'edge/cli.js') },
  platform: 'node',
  plugins: [json5Bundle],
  external: (id) => id.startsWith('node:') || deps.some((d) => id === d || id.startsWith(`${d}/`)),
  logLevel: 'warn',
  output: { dir: out, format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'chunk-[hash].js', minify: !process.argv.includes('--no-minify') },
});

// ASCII-only output: V8 keeps every module's source text in the heap, and one
// non-Latin-1 character (e.g. an ellipsis in a message) makes it store the whole
// file as a two-byte string (2x memory). \uXXXX escapes mean the same in
// strings, templates, regexps and identifiers.
function asciiOnly(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) asciiOnly(file);
    else if (name.endsWith('.js')) {
      const code = readFileSync(file, 'utf8');
      // eslint-disable-next-line no-control-regex
      if (/[^\x00-\x7f]/.test(code)) {
        writeFileSync(file, code.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
      }
    }
  }
}
asciiOnly(out);

// keep tsc's declarations next to the bundle: commented for the root files and
// DOCS_DIRS, comment-free (tmpBare) for the rest
function copyDts(from, bare, to, top = '') {
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (statSync(src).isDirectory()) copyDts(src, path.join(bare, name), dst, top || name);
    else if (name.endsWith('.d.ts')) {
      mkdirSync(to, { recursive: true });
      copyFileSync(top === '' || DOCS_DIRS.has(top) ? src : path.join(bare, name), dst);
    }
  }
}
copyDts(tmp, tmpBare, out);
rmSync(tmp, { recursive: true, force: true });
rmSync(tmpBare, { recursive: true, force: true });
