/**
 * TEST-ONLY second oracle: the OFFICIAL headless host script (as embedded by
 * the `haxball.js` devDependency, source hash f066733d), evaluated offline
 * with a fake `window` so we can reach its internal classes.
 *
 * How: haxball.js ships the official minified script inside
 * `loadHeadless(environment)` in dist/index.mjs. We slice the script body
 * `(function(wa) { ... F.sh(); })(...)`, replace the start-up call `F.sh()`
 * (which would contact haxball.com) with a hook that hands us the classes we
 * need, and evaluate it with `new Function`. Nothing from it is copied into
 * the repo; this only runs inside tests.
 *
 * Minified names used (valid for this exact build only; re-check if
 * haxball.js is upgraded):
 *   Ta = RoomState (G = serialize, Da(dt) = tick, Ve() = checksum)
 *   L  = StreamReader, A = StreamWriter (A.aa() = new writer, Db() = bytes view)
 *   m  = event base (m.Ji(reader) = instance from type byte; ev.W(reader) = payload;
 *        ev.B = byId; ev.apply(roomState))
 *   vb = event registry (vb.Ci() registers ids 0..23)
 *   w  = Stadium (w.Fd() = built-in stadiums)
 *
 * Use it to confirm node-haxball == official for a scenario (see
 * cross-oracle.test.ts), or directly as the reference for physics/rules.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface OfficialInternals {
  Ta: Any;
  L: Any;
  A: Any;
  m: Any;
  vb: Any;
  w: Any;
}

let cached: OfficialInternals | null = null;

/** Loads (once) and returns the official internal classes. */
export function officialInternals(): OfficialInternals {
  if (cached) return cached;
  const file = require.resolve('haxball.js').replace(/index\.c?js$/, 'index.mjs');
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('(function(wa) {');
  const end = src.lastIndexOf('F.sh();');
  if (start < 0 || end < 0 || end < start) throw new Error('official headless script layout changed (haxball.js upgraded?)');
  const body = `${src.slice(start, end)}__capture({ Ta, L, A, m, vb, w });\n})(window);`;
  const fakeWindow = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    performance,
    crypto: globalThis.crypto,
    parent: {},
    document: { getElementById: () => null, createElement: () => ({}) },
    location: { search: '' },
  };
  class Unavailable {
    constructor() {
      throw new Error('network classes are not available in the offline official oracle');
    }
  }
  let captured: OfficialInternals | null = null;
  const run = new Function(
    'window', 'JSON5', 'pako', 'TextEncoder', 'performance', 'crypto', 'WebSocket', 'XMLHttpRequest',
    'RTCPeerConnection', 'RTCIceCandidate', 'RTCSessionDescription', '__capture', body,
  );
  run(
    fakeWindow, require('json5'), require('pako'), TextEncoder, performance, globalThis.crypto,
    Unavailable, Unavailable, Unavailable, Unavailable, Unavailable,
    (o: OfficialInternals) => {
      captured = o;
    },
  );
  if (!captured) throw new Error('failed to capture official internals');
  const internals: OfficialInternals = captured;
  internals.vb.Ci(); // register event classes (normally done by F.sh())
  cached = internals;
  return internals;
}

/** Offline room running the official game code. Same core API as OracleRoom. */
export class OfficialRoom {
  readonly state: Any;
  frame = 0;
  private readonly x: OfficialInternals;

  constructor() {
    this.x = officialInternals();
    this.state = new this.x.Ta();
  }

  /** Applies official event bytes (u8 type + payload) as player `byId`, at the current frame. */
  applyEventBytes(bytes: Uint8Array, byId = 0): this {
    const r = new this.x.L(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), false);
    const ev = this.x.m.Ji(r);
    ev.W(r);
    ev.B = byId;
    ev.apply(this.state);
    return this;
  }

  /** Advances `n` ticks (official `Ta.Da(1)` each). */
  step(n = 1): this {
    for (let i = 0; i < n; i++) {
      this.state.Da(1);
      this.frame++;
    }
    return this;
  }

  /** Official RoomState bytes. */
  stateBytes(): Uint8Array {
    const w = this.x.A.aa();
    this.state.G(w);
    return Uint8Array.from(w.Db() as Uint8Array);
  }

  /** Official consistency hash. */
  checksum(): number {
    return this.state.Ve() | 0;
  }
}
