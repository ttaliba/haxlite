/**
 * Package contents, checked on the BUILT package (scripts/build.mjs) the way a
 * consumer gets it:
 *  - declarations keep their JSDoc in src/api, the root entry points and the
 *    operator modules (dts-jsdoc.test.ts); the internals (rtc, sim, codec,
 *    room, the wire protocols) ship comment-free (same types, a third of the bytes);
 *  - json5's parser is bundled into dist (json5 is a devDependency), loaded
 *    lazily like before, and its MIT notice travels with it.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writer } from '../../src/codec/index.js';
import { parseHbs, writeStadium } from '../../src/sim/index.js';
import { ARENA_HBS, BAD, HAND } from '../sim/hbs-corpus.js';
import { ROOT, buildPackage, removePackage } from './build-package.js';

let OUT = '';
let DIST = '';
beforeAll(() => {
  OUT = buildPackage('haxlite-packaging-test');
  DIST = path.join(OUT, 'dist');
}, 120_000);
afterAll(() => removePackage(OUT));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}

const hasComment = (text: string) => /\/\*|^\s*\/\//m.test(text);

describe('declarations', () => {
  it('keep their JSDoc in api/ and the root files, ship the internals comment-free', () => {
    const read = (rel: string) => readFileSync(path.join(DIST, rel), 'utf8');
    // what HBInit users read in their editor
    expect(read('api/hbinit.d.ts')).toContain('Creates a headless room (official `HBInit`, Promise-returning).');
    expect(read('api/types.d.ts')).toContain('/** `HBInit(config)`: every field is optional (official defaults in brackets). */');
    expect(read('index.d.ts')).toContain('haxlite public entry point.');
    expect(read('protocol.d.ts')).toMatch(/\/\*\*/);
    // the advanced modules: the declarations are there, the comments of the internals are not
    const advanced = walk(DIST)
      .filter((f) => f.endsWith('.d.ts'))
      .map((f) => path.relative(DIST, f))
      .filter((rel) => rel.includes(path.sep) && !rel.startsWith(`api${path.sep}`));
    expect(advanced.length).toBeGreaterThan(60);
    expect(advanced).toContain(path.join('net', 'transport.d.ts'));
    expect(read('net/transport.d.ts')).toContain('export declare class HostTransport');
    const internals = advanced.filter((rel) => /^(rtc|sim|codec|room)[\\/]/.test(rel) || /^(host[\\/]sequencer|net[\\/]edge-(protocol|udp|ndc)|net[\\/]peer-backend)\.d\.ts$/.test(rel));
    expect(internals.length).toBeGreaterThan(40);
    expect(internals.filter((rel) => hasComment(read(rel)))).toEqual([]);
  });

  it('still describe the whole public API (consumer type-check, skipLibCheck off)', () => {
    writeFileSync(
      path.join(OUT, 'consumer.ts'),
      `import { HBInit, HostRoom, net, sim, type HostRoomOptions, type PlayerObject, type RoomObject } from 'haxlite';
const opts: HostRoomOptions | undefined = undefined;
const t: typeof net.HostTransport = net.HostTransport;
const step: typeof sim.stepWorld = sim.stepWorld;
export async function f(): Promise<[RoomObject, PlayerObject[], typeof HostRoom, typeof opts, typeof t, typeof step]> {
  const room = await HBInit({ roomName: 'x', noPlayer: true });
  return [room, room.getPlayerList(), HostRoom, opts, t, step];
}
`,
    );
    writeFileSync(
      path.join(OUT, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] },
        files: ['consumer.ts'],
      }),
    );
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(OUT, 'tsconfig.json')], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 60_000);
});

describe('json5', () => {
  it('is a devDependency: the package does not declare it and dist does not import it', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    expect(pkg.devDependencies?.json5).toBeDefined();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) expect(pkg[field]?.json5, field).toBeUndefined();
    const js = walk(DIST).filter((f) => f.endsWith('.js'));
    for (const f of js) expect(readFileSync(f, 'utf8'), path.relative(DIST, f)).not.toMatch(/['"`]json5(\/[^'"`]*)?['"`]/);
  });

  it('keeps its MIT notice next to the bundled parser', () => {
    const js = walk(DIST)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(f, 'utf8'));
    const withNotice = js.filter((t) => t.includes('Aseem Kishore') && t.includes('Permission is hereby granted'));
    expect(withNotice).toHaveLength(1);
    expect(withNotice[0]).toMatch(/\/\*! json5 \d+\.\d+\.\d+/);
  });

  it('the bundled parser reads .hbs text with json5 syntax, and fails like json5, without json5 installed', () => {
    const cases = [{ name: 'arena', hbs: ARENA_HBS }, ...HAND, ...BAD].map((c) => ({ name: c.name, hbs: `// json5\n${c.hbs}` }));
    writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(cases));
    writeFileSync(
      path.join(OUT, 'block-json5.cjs'),
      `const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'json5' || request.startsWith('json5/')) throw Object.assign(new Error('Cannot find module ' + request), { code: 'MODULE_NOT_FOUND' });
  return resolve.call(this, request, ...rest);
};
`,
    );
    writeFileSync(
      path.join(OUT, 'child.mjs'),
      `import { codec, sim } from 'haxlite';
import { parseHbs } from 'haxlite';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
let blocked = false;
try {
  createRequire(import.meta.url)('json5');
} catch {
  blocked = true;
}
const out = [];
for (const c of JSON.parse(readFileSync(process.argv[2], 'utf8'))) {
  try {
    const w = new codec.Writer(8192);
    sim.writeStadium(w, parseHbs(c.hbs));
    out.push(Buffer.from(w.copyBytes()).toString('hex'));
  } catch (e) {
    out.push(e.name + ': ' + e.message);
  }
}
process.stdout.write(JSON.stringify({ blocked, out }));
`,
    );
    const r = spawnSync(process.execPath, ['--require', path.join(OUT, 'block-json5.cjs'), path.join(OUT, 'child.mjs'), path.join(OUT, 'cases.json')], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    expect(r.stderr).toBe('');
    const got = JSON.parse(r.stdout) as { blocked: boolean; out: string[] };
    expect(got.blocked).toBe(true);
    expect(got.out).toHaveLength(cases.length);
    // same outcome as the sources (json5 from node_modules): same bytes, same error text
    const expected = cases.map((c) => {
      try {
        const w = new Writer(8192);
        writeStadium(w, parseHbs(c.hbs));
        return Buffer.from(w.copyBytes()).toString('hex');
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    });
    cases.forEach((c, i) => expect(got.out[i], c.name).toBe(expected[i]));
    expect(got.out.filter((o) => /^[0-9a-f]+$/.test(o)).length).toBeGreaterThan(10);
    expect(got.out.some((o) => o.startsWith('SyntaxError: JSON5: '))).toBe(true);
  }, 60_000);
});
