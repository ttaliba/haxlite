#!/usr/bin/env node
// haxlite Edge: WebRTC gateway that hides haxlite hosts' IPs (docs/09-haxlite-edge.md).
// Requires `npm run build` (runs dist/edge/cli.js).
import { main } from '../dist/edge/cli.js';

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
