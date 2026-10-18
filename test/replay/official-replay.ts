/**
 * TEST-ONLY official replay oracles (minified names allowed here, docs/06 §4.4).
 *
 * 1. The official HEADLESS recorder (off `cb`, what HBInit `startRecording()` /
 *    `stopRecording()` use), from the same script `test/oracle/official.ts`
 *    evaluates (haxball.js dist/index.mjs, source hash f066733d). We load our
 *    own instance so we can also capture `cb` without touching the shared
 *    oracle. The recorder is attached to a minimal stand-in for the host
 *    sequencer (`Ma`): `{ da: frame, Ca: RoomState, Ab: afterEventHook }`,
 *    driven exactly like `Ma.rg` (apply event -> `Ab(ev)`; `Ca.Da(1)`; `da++`).
 *
 * 2. The official BROWSER CLIENT replay player (off `$b`, game-min.js, hash
 *    0349dd60), evaluated offline from `HAXBALL_CLIENT_JS` (default: the
 *    session scratchpad copy). It is not shipped in node_modules, so tests
 *    using it are skipped when the file is absent.
 *
 * Minified names (headless f066733d): Ta RoomState (G serialize, Da tick, Ve
 * checksum), L/A Reader/Writer (A.aa() new writer, Db() bytes), m event base
 * (m.Ji(reader) instance from type byte, W(reader) payload, B byId), vb event
 * registry (Ci), cb recorder (constructor(host, version), stop()).
 * Client 0349dd60: $b replay player (Y frame, T RoomState, Bf total frames,
 * pl goal markers {Dj: frame/total, kind}, ug next event, vg its frame, dm()
 * read next, Ji() rewind), va RoomState (ha serialize, A tick), A writer
 * (A.ka() new writer, Wb() bytes), Nc.xj() event registry.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const fakeWindow = (): Any => ({
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  performance,
  crypto: globalThis.crypto,
  parent: {},
  top: {},
  navigator: { userAgent: 'node' },
  document: { getElementById: () => null, createElement: () => ({}) },
  location: { search: '' },
});

class Unavailable {
  constructor() {
    throw new Error('network classes are not available offline');
  }
}

// --------------------------------------------------------------- headless

interface HeadlessInternals {
  Ta: Any;
  L: Any;
  A: Any;
  m: Any;
  vb: Any;
  cb: Any;
}
let headless: HeadlessInternals | null = null;

export function headlessInternals(): HeadlessInternals {
  if (headless) return headless;
  const file = require.resolve('haxball.js').replace(/index\.c?js$/, 'index.mjs');
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('(function(wa) {');
  const end = src.lastIndexOf('F.sh();');
  if (start < 0 || end < 0 || end < start) throw new Error('official headless script layout changed');
  const body = `${src.slice(start, end)}__capture({ Ta, L, A, m, vb, cb });\n})(window);`;
  let captured: HeadlessInternals | null = null;
  const run = new Function(
    'window', 'JSON5', 'pako', 'TextEncoder', 'performance', 'crypto', 'WebSocket', 'XMLHttpRequest',
    'RTCPeerConnection', 'RTCIceCandidate', 'RTCSessionDescription', '__capture', body,
  );
  run(
    fakeWindow(), require('json5'), require('pako'), TextEncoder, performance, globalThis.crypto,
    Unavailable, Unavailable, Unavailable, Unavailable, Unavailable,
    (o: HeadlessInternals) => {
      captured = o;
    },
  );
  if (!captured) throw new Error('failed to capture official headless internals');
  headless = captured as HeadlessInternals;
  headless.vb.Ci();
  return headless;
}

/**
 * Official headless RoomState + the official recorder, driven like the host
 * sequencer. Same core API as test/oracle OfficialRoom (applyEventBytes, step,
 * stateBytes, checksum, frame).
 */
export class OfficialRecordingRoom {
  private readonly x = headlessInternals();
  /** Stand-in for the host sequencer `Ma`: `da` frame, `Ca` RoomState, `Ab` after-apply hook. */
  readonly host: { da: number; Ca: Any; Ab: ((ev: Any) => void) | null } = { da: 0, Ca: new this.x.Ta(), Ab: null };
  private recorder: Any = null;

  get frame(): number {
    return this.host.da;
  }

  applyEventBytes(bytes: Uint8Array, byId = 0): this {
    const r = new this.x.L(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), false);
    const ev = this.x.m.Ji(r);
    ev.W(r);
    ev.B = byId;
    ev.eb = this.host.da;
    ev.apply(this.host.Ca);
    if (this.host.Ab !== null) this.host.Ab(ev);
    return this;
  }

  step(n = 1): this {
    for (let i = 0; i < n; i++) {
      this.host.Ca.Da(1);
      this.host.da++;
    }
    return this;
  }

  stateBytes(): Uint8Array {
    const w = this.x.A.aa();
    this.host.Ca.G(w);
    return Uint8Array.from(w.Db() as Uint8Array);
  }

  checksum(): number {
    return this.host.Ca.Ve() | 0;
  }

  /** HBInit `startRecording()`: `new cb(host, 3)`. */
  startRecording(): void {
    this.recorder = new this.x.cb(this.host, 3);
  }

  /** HBInit `stopRecording()`. */
  stopRecording(): Uint8Array {
    const out = Uint8Array.from(this.recorder.stop() as Uint8Array);
    this.recorder = null;
    return out;
  }
}

// ----------------------------------------------------------------- client

const DEFAULT_CLIENT_JS = 'game-min.js';

export const CLIENT_JS_PATH = process.env.HAXBALL_CLIENT_JS ?? DEFAULT_CLIENT_JS;
export const clientAvailable = existsSync(CLIENT_JS_PATH);

interface ClientInternals {
  $b: Any;
  va: Any;
  A: Any;
  Nc: Any;
}
let client: ClientInternals | null = null;

export function clientInternals(): ClientInternals {
  if (client) return client;
  const src = readFileSync(CLIENT_JS_PATH, 'utf8');
  const head = "'use strict';(function(pa){";
  const start = src.indexOf(head);
  const end = src.lastIndexOf('B.$p()})(');
  if (start < 0 || end < 0 || end < start) throw new Error('official client script layout changed');
  const body = `${src.slice(start + "'use strict';".length, end)}__capture({ $b, va, A, Nc }); })(window);`;
  let captured: ClientInternals | null = null;
  const run = new Function('window', 'JSON5', 'pako', '__capture', `"use strict";${body}`);
  run(fakeWindow(), require('json5'), require('pako'), (o: ClientInternals) => {
    captured = o;
  });
  if (!captured) throw new Error('failed to capture official client internals');
  client = captured as ClientInternals;
  client.Nc.xj(); // register event classes (normally done at startup by B.$p)
  return client;
}

/** The official browser replay player (`new $b(bytes, new va, 3)`), stepped deterministically. */
export class OfficialClientReplay {
  private readonly x = clientInternals();
  readonly player: Any;

  constructor(bytes: Uint8Array) {
    this.player = new this.x.$b(Uint8Array.from(bytes), new this.x.va(), 3);
  }

  get frame(): number {
    return this.player.Y;
  }
  get totalFrames(): number {
    return this.player.Bf;
  }
  /** Goal markers as the player keeps them: `{ frame, team }` (stored as frame/total fraction). */
  goalMarkers(): { frame: number; team: number }[] {
    return (this.player.pl as { Dj: number; kind: number }[]).map((g) => ({
      frame: Math.round(g.Dj * this.player.Bf),
      team: g.kind,
    }));
  }

  /** The body of the official `$b.A()` frame loop, without its wall-clock pacing. */
  stepTo(frame: number): void {
    const p = this.player;
    while (p.Y < frame) {
      while (p.ug != null && p.vg === p.Y) {
        p.ug.apply(p.T);
        p.dm();
      }
      p.Y++;
      p.T.A(1);
    }
  }

  stateBytes(): Uint8Array {
    const w = this.x.A.ka();
    this.player.T.ha(w);
    return Uint8Array.from(w.Wb() as Uint8Array);
  }
}
