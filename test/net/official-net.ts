/**
 * TEST-ONLY: the official headless script (haxball.js dist, hash f066733d)
 * evaluated offline, exposing the network-side classes used as oracles by
 * test/net (same technique as test/oracle/official.ts; minified names valid
 * for this build only):
 *   ab = RoomInfo (G(writer) serializes, LE), A = StreamWriter, L = StreamReader,
 *   Ra = token bucket (Rf() takes, uses window.performance.now()),
 *   rb = ICE candidate parser (Bh), ua = auth verification (ri(blob, challenge)),
 *   Aa = host signaling (We(candidate) = srflx IP).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface OfficialNet {
  ab: Any;
  A: Any;
  L: Any;
  Ra: Any;
  rb: Any;
  ua: Any;
  Aa: Any;
  /** Fake clock read by the official code (`window.performance.now()`). */
  clock: { now: number };
}

let cached: OfficialNet | null = null;

export function officialNet(): OfficialNet {
  if (cached) return cached;
  const file = require.resolve('haxball.js').replace(/index\.c?js$/, 'index.mjs');
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('(function(wa) {');
  const end = src.lastIndexOf('F.sh();');
  if (start < 0 || end < 0 || end < start) throw new Error('official headless script layout changed (haxball.js upgraded?)');
  const body = `${src.slice(start, end)}__capture({ ab, A, L, Ra, rb, ua, Aa });\n})(window);`;
  const clock = { now: 0 };
  const fakePerformance = { now: () => clock.now };
  const fakeWindow = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    performance: fakePerformance,
    crypto: globalThis.crypto,
    parent: {},
    document: { getElementById: () => null, createElement: () => ({}) },
    location: { search: '' },
  };
  class Unavailable {
    constructor() {
      throw new Error('not available offline');
    }
  }
  let captured: Omit<OfficialNet, 'clock'> | null = null;
  const run = new Function(
    'window', 'JSON5', 'pako', 'TextEncoder', 'performance', 'crypto', 'WebSocket', 'XMLHttpRequest',
    'RTCPeerConnection', 'RTCIceCandidate', 'RTCSessionDescription', '__capture', body,
  );
  run(
    fakeWindow, require('json5'), require('pako'), TextEncoder, fakePerformance, globalThis.crypto,
    Unavailable, Unavailable, Unavailable, Unavailable, Unavailable,
    (o: Omit<OfficialNet, 'clock'>) => {
      captured = o;
    },
  );
  if (!captured) throw new Error('failed to capture official internals');
  cached = { ...(captured as Omit<OfficialNet, 'clock'>), clock };
  return cached;
}
