// Manual interop server: open the printed /selftest.html URL in any browser
// (Firefox, Safari, Android/iOS on the same network…) and press «Probar».
//
//   node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs \
//     test/rtc-interop/manual-server.ts [ndc|rtc] [ICE address = first non-loopback IPv4] [http port = 8080]
//
// Everything the page checks is described in docs/10-haxlite-rtc.md.
import os from 'node:os';
import { InteropServer } from './harness/server.js';
import type { BackendKind } from './harness/backends.js';

const kind = (process.argv[2] ?? 'rtc') as BackendKind;
const address =
  process.argv[3] ??
  Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address ??
  '127.0.0.1';
const port = Number(process.argv[4] ?? 8080);
const srv = await InteropServer.start({ backend: kind, address, httpHost: '0.0.0.0', httpPort: port, verbose: true });
console.log(`backend ${kind}, ICE address ${address}`);
console.log(`open http://${address}:${port}/selftest.html in the browser under test (Ctrl+C to stop)`);
process.on('SIGINT', () => void srv.close().then(() => process.exit(0)));
