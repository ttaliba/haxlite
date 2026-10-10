// Runs the haxlite Edge from the TypeScript sources (no build needed):
//   npm run edge -- --config edge.json
//   HAXLITE_EDGE_KEYS=alice:<secret> npm run edge
//   npm run edge -- genkey alice
// Production: `npm run build` then `bin/haxlite-edge.js` (docs/09-haxlite-edge.md).
import { main } from '../src/edge/cli.js';

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
