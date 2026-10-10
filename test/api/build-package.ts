/**
 * TEST ONLY: builds the package (tsc -p tsconfig.build.json) into a private
 * directory under node_modules/.cache (so node-datachannel/ws/json5 resolve
 * from the repo's node_modules) with a package.json carrying the same
 * `exports` as the real one, and links it as `node_modules/haxlite` there, so
 * scripts placed in that directory can `import 'haxlite'` exactly like users.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export function buildPackage(name: string): string {
  const out = path.join(ROOT, 'node_modules', '.cache', name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, 'node_modules'), { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(ROOT, 'tsconfig.build.json'), '--outDir', path.join(out, 'dist')], {
    stdio: 'inherit',
  });
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(
    path.join(out, 'package.json'),
    JSON.stringify({ name: pkg.name, type: pkg.type, main: pkg.main, types: pkg.types, exports: pkg.exports }, null, 2),
  );
  symlinkSync(out, path.join(out, 'node_modules', 'haxlite'), 'dir');
  return out;
}

export function removePackage(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
