// Package build: `tsc` (type-check + .d.ts + JS), then the JS is bundled by
// rolldown into one ESM file per entry point (dist/index.js, dist/edge/cli.js
// + one shared chunk) so `import 'haxlite'` loads 2 files instead of ~50
// (docs/07-benchmarks.md "Pasada de ligereza": ~20 ms less startup). The
// .d.ts tree is tsc's, with JSDoc only where a user reads it in their editor
// (src/api, the root entry points and DOC_MODULES below): tsc runs a second
// time without comments for the rest (434 KB -> 220 KB of declarations, same
// types).
// Runtime deps stay external, except json5 (see below). The JS is minified
// (558 KB -> 270 KB, ~4 ms faster import); pass --no-minify to debug.
//
//   node scripts/build.mjs [--out <dir>]      (default: dist)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import { parseSync } from 'rolldown/utils';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const out = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'dist');
const tmp = `${out}.tsc-tmp`;
const tmpBare = `${out}.dts-tmp`;
// Top-level directories whose declarations keep all their JSDoc; root files always do.
const DOCS_DIRS = new Set(['api']);
// Modules that declare what an operator configures or reads (docs/11: the
// `transport`, `edge` and `rtc` options, HostRoomOptions, Peer, BanList,
// replays, EdgeServerOptions). They keep their JSDoc, minus what `pruneDocs`
// drops. The other modules (rtc, sim, codec, room, the wire and tunnel
// protocols) are internals and ship bare. Every module costs its comments in
// the tarball (0.3-3 KB gzipped) and `npm pack` must stay 20 % under its 257 KB
// reference size, so list only what an operator reads.
const DOC_MODULES = new Set(
  [
    'net/transport', // HostTransportOptions, JoinRequest/JoinDecision/JoinInfo, Peer, PeerCloseReason
    'net/signaling', // HostSignalingOptions (extended by HostTransportOptions)
    'net/master-http', // MasterHttpOptions (idem), fetchGeo/fetchRoomList
    'net/rtc-backend', // RtcBackendOptions
    'net/edge-client', // EdgeOptions, EdgeBackendStats
    'net/bans', // BanList, BanRecord
    'host/host-room', // HostRoomOptions, HostDefaults
    'edge/server', // EdgeServerOptions and its limits and WebRTC options
    'edge/tunnel-udp', // EdgeTunnelOptions, EdgeTunnelStats
    'replay/format',
    'replay/reader', // ReplayReadOptions
    'replay/player', // ReplayPlayerOptions, ReplayPlayer.maxSeekMs
    'replay/recorder', // ReplayRecorderOptions, ReplayRecorder.maxBytes
  ].map((m) => `${m}.d.ts`),
);
// Class members of those modules that keep their docs: `Class` for all of its
// members (the classes docs/11 describes member by member), `Class.member` for
// one (a tunable of the class). In every other class (engine, backends, tunnel
// sessions) only the `@internal` marks stay.
const DOC_MEMBERS = new Set(['Peer', 'BanList', 'ReplayPlayer', 'ReplayRecorder.maxBytes', 'ReplayRecorder.truncated']);

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

// Drops the doc comments no editor shows from a commented declaration file:
// those before a statement that declares nothing (import, re-export), those on
// `private` members (consumers cannot reach them) and, in the classes outside
// DOC_MEMBERS, those on members (except `@internal` marks). Types are untouched.
const docMembersSeen = new Set();
function pruneDocs(file, text) {
  const { program, comments, errors } = parseSync(file, text, { lang: 'dts' });
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const cuts = [];
  const cut = (c) => {
    let [start, end] = [c.start, c.end];
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', end);
    if (/^\s*$/.test(text.slice(lineStart, start)) && /^\s*$/.test(text.slice(end, lineEnd < 0 ? text.length : lineEnd))) {
      start = lineStart;
      end = lineEnd < 0 ? text.length : lineEnd + 1;
    } else while (text[end] === ' ') end++;
    cuts.push([start, end]);
  };
  const docs = comments.filter((c) => c.type === 'Block' && c.value.startsWith('*'));
  const within = (node, c) => c.start >= node.start && c.end <= node.end;
  for (const c of docs) {
    if (program.body.some((s) => within(s, c))) continue;
    const next = program.body.find((s) => s.start >= c.end);
    if (next && (next.type === 'ImportDeclaration' || next.type === 'ExportAllDeclaration' || (next.type === 'ExportNamedDeclaration' && !next.declaration))) cut(c);
  }
  for (const stmt of program.body) {
    const decl = stmt.declaration ?? stmt;
    if (decl.type !== 'ClassDeclaration') continue;
    const name = decl.id?.name;
    const members = decl.body.body;
    for (const key of [name, ...members.map((m) => `${name}.${m.key?.name}`)]) if (DOC_MEMBERS.has(key)) docMembersSeen.add(key);
    for (const c of docs) {
      if (!within(decl.body, c) || members.some((m) => within(m, c))) continue;
      const member = members.find((m) => m.start >= c.end);
      if (!member) continue;
      const key = `${name}.${member.key?.name}`;
      const documented = DOC_MEMBERS.has(name) || DOC_MEMBERS.has(key) || c.value.includes('@internal');
      if (!documented || /^private\b/.test(text.slice(member.start, member.start + 8))) cut(c);
    }
  }
  let result = '';
  let at = 0;
  for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
    result += text.slice(at, start);
    at = end;
  }
  return result + text.slice(at);
}

// keep tsc's declarations next to the bundle: commented for the root files and
// DOCS_DIRS, pruned for DOC_MODULES, comment-free (tmpBare) for the rest
const docModulesSeen = new Set();
function copyDts(from, bare, to, top = '', rel = '') {
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const file = rel ? `${rel}/${name}` : name;
    if (statSync(src).isDirectory()) copyDts(src, path.join(bare, name), dst, top || name, file);
    else if (name.endsWith('.d.ts')) {
      mkdirSync(to, { recursive: true });
      if (DOC_MODULES.has(file)) {
        docModulesSeen.add(file);
        writeFileSync(dst, pruneDocs(file, readFileSync(src, 'utf8')));
      } else copyFileSync(top === '' || DOCS_DIRS.has(top) ? src : path.join(bare, name), dst);
    }
  }
}
copyDts(tmp, tmpBare, out);
// a renamed or moved module must not silently lose its docs
for (const [list, seen] of [[DOC_MODULES, docModulesSeen], [DOC_MEMBERS, docMembersSeen]]) {
  const missing = [...list].filter((n) => !seen.has(n));
  if (missing.length) throw new Error(`scripts/build.mjs: not found in the declarations: ${missing.join(', ')}`);
}
rmSync(tmp, { recursive: true, force: true });
rmSync(tmpBare, { recursive: true, force: true });
