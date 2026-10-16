// Loader hooks so plain `node` can run the benchmark's TypeScript (bench/net/run.ts,
// test/fake-master, test/rtc/nat-sim.ts):
//   * resolve: NodeNext-style `.js` specifiers that name a `.ts` file;
//   * load: repo `.ts` files (outside node_modules) are transpiled with oxc
//     (rolldown/experimental `transformSync`, a devDependency), which also
//     handles what Node's type stripping refuses (parameter properties, enums).
//     Node 26 removed --experimental-transform-types; without rolldown the hook
//     falls back to Node's own stripping (erasable syntax only).
// Usage: node --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts startup
// (Bun runs the same files natively: `bun bench/net/run.ts startup`.)
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!globalThis.__haxliteTsResolve) {
  globalThis.__haxliteTsResolve = true;
  register(import.meta.url);
}

let transformSync;
try {
  ({ transformSync } = await import('rolldown/experimental'));
} catch {
  transformSync = null;
}

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('.') || specifier.startsWith('/')) && specifier.endsWith('.js') && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      const ts = new URL(url.href.slice(0, -3) + '.ts');
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (transformSync && url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/')) {
    const file = fileURLToPath(url);
    const r = transformSync(file, readFileSync(file, 'utf8'), { sourcemap: false });
    if (r.errors?.length) throw new Error(`${file}: ${r.errors.map((e) => e.message ?? String(e)).join('; ')}`);
    return { format: 'module', source: r.code, shortCircuit: true };
  }
  return next(url, context);
}
