/**
 * TEST ONLY: what a consumer gets from a package built by build-package.ts.
 *  - packBuilt: runs the real `npm pack` on the built dist plus the repo's package.json, bin/, README
 *    and LICENSE, staged in a temporary directory (the repo is not touched), so the size and the file
 *    list are the tarball's own;
 *  - stageConsumer: a project in the system temp directory, outside the repo, whose node_modules holds
 *    the unpacked tarball, what `npm install` would add next to it and the packages the caller names,
 *    copied from the repo's node_modules. Nothing else is reachable from it, so a type-check there
 *    cannot lean on a devDependency of the repo.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from './build-package.js';

export interface Packed {
  /** The tarball. */
  tgz: string;
  /** Its size in bytes. */
  size: number;
  /** Paths inside the tarball. */
  files: string[];
  /** Removes the staging directory and the tarball. */
  cleanup(): void;
}

/** `npm pack` of the package built into `buildDir` (see buildPackage). */
export function packBuilt(buildDir: string): Packed {
  const root = mkdtempSync(path.join(tmpdir(), 'haxlite-pack-'));
  try {
    const stage = path.join(root, 'pkg');
    mkdirSync(stage);
    mkdirSync(path.join(root, 'out'));
    cpSync(path.join(buildDir, 'dist'), path.join(stage, 'dist'), { recursive: true });
    cpSync(path.join(ROOT, 'bin'), path.join(stage, 'bin'), { recursive: true });
    for (const f of ['package.json', 'README.md', 'LICENSE']) copyFileSync(path.join(ROOT, f), path.join(stage, f));
    const out = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', path.join(root, 'out')], {
      cwd: stage,
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_loglevel: 'error' },
    });
    const [info] = JSON.parse(out) as Array<{ filename: string; size: number; files: Array<{ path: string }> }>;
    return {
      tgz: path.join(root, 'out', info!.filename),
      size: info!.size,
      files: info!.files.map((f) => f.path),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/** Copies a package of the repo's node_modules, and what it depends on, into `into`. */
function install(name: string, into: string): void {
  const dest = path.join(into, name);
  if (existsSync(dest)) return;
  const src = path.join(ROOT, 'node_modules', name);
  if (!existsSync(src)) throw new Error(`${name} is not installed in the repo's node_modules`);
  cpSync(src, dest, { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const dep of Object.keys(pkg.dependencies ?? {})) install(dep, into);
}

/**
 * A fresh project in the system temp directory with `packed` installed as node_modules/haxlite, its
 * dependencies and optionalDependencies (as `npm install` would bring them) and `extra` (what the
 * caller installs next to it), copied from the repo's node_modules. Returns its path.
 */
export function stageConsumer(packed: Packed, extra: readonly string[]): string {
  const proj = mkdtempSync(path.join(tmpdir(), 'haxlite-consumer-'));
  try {
    const nm = path.join(proj, 'node_modules');
    const pkgDir = path.join(nm, 'haxlite');
    mkdirSync(pkgDir, { recursive: true });
    execFileSync('tar', ['-xzf', packed.tgz, '-C', pkgDir, '--strip-components=1']);
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...extra]) install(name, nm);
    return proj;
  } catch (e) {
    rmSync(proj, { recursive: true, force: true });
    throw e;
  }
}
