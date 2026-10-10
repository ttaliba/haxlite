// Resolve hook so `node --experimental-strip-types` can run the repo's TS
// sources, whose imports use NodeNext-style `.js` specifiers for `.ts` files.
// Usage: node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/net-stress.ts
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!globalThis.__haxliteTsResolve) {
  globalThis.__haxliteTsResolve = true;
  register(import.meta.url);
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
