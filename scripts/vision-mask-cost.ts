// Candidate "vision mask that follows the viewer" (docs/04 §7.4, "Jugadores
// ocultos"): K huge cGroup-0 stadium discs (half-planes) tangent to a circle
// around each viewer, moved per viewer with setDiscPropertiesFor and dead
// reckoning (disc speed = the viewer's speed, damping 1), refreshed every R
// ticks. This script measures:
//   1. the wire cost with the real encoder (bytes per event, events/s, kB/s)
//      for P players;
//   2. how far the mask centre lags behind the viewer's own disc (which the
//      viewer's client predicts locally with zero lag), simulated with
//      haxlite's physics (Classic player physics). The model: the client shows
//      the last refresh it confirmed, extrapolated by its speed, and that
//      refresh left the host L ticks ago (one-way latency + heartbeat wait).
//      The viewer moves with random inputs that change every 10-40 ticks.
//
//   node --experimental-transform-types --no-warnings --import ./scripts/ts-resolve.mjs scripts/vision-mask-cost.ts
import { Writer } from '../src/codec/index.js';
import { HostMsg } from '../src/protocol.js';
import { SetDiscPropertiesEvent, SendInputEvent, writeEventFrame } from '../src/room/index.js';

const size = (ev: SetDiscPropertiesEvent | SendInputEvent) => {
  const w = new Writer(64);
  w.u8(HostMsg.Event);
  ev.frame = 123456;
  ev.order = 3;
  writeEventFrame(w, ev);
  return w.finish().length;
};
const move = size(SetDiscPropertiesEvent.create(1, false, { x: 1, y: 2, xspeed: 3, yspeed: 4 }));
const noop = size(SetDiscPropertiesEvent.create(0, false, {}));
const hide = size(SetDiscPropertiesEvent.create(1, true, { x: NaN, y: NaN, cGroup: 0 }));
const strip = size(SendInputEvent.create(8));
console.log(`bytes per message (app level, before SCTP/DTLS): move ${move}, no-op ${noop}, hide ${hide}, kick-strip SendInput ${strip}`);

console.log('\n1. wire cost of a following mask (every player is a viewer: no no-ops)');
console.log('players K-gon  refresh  events/s per client  kB/s per client  host upload kB/s');
for (const P of [10]) {
  for (const K of [6, 8, 12]) {
    for (const hz of [5, 10, 20]) {
      const perClient = K * hz;
      const kb = (perClient * move) / 1000;
      console.log(`${String(P).padStart(7)} ${String(K).padStart(5)} ${String(hz).padStart(6)} Hz ${String(perClient).padStart(19)} ${kb.toFixed(2).padStart(16)} ${(kb * P).toFixed(1).padStart(17)}`);
    }
  }
}
console.log('(hidePlayerFor for comparison: one hide or show per pair and per visibility change, 32 + 20·(P-1) bytes)');

// 2. lag of the mask centre behind the viewer's predicted disc
const ACC = 0.1;
const DAMP = 0.96;
function simulate(R: number, L: number, ticks = 120_000, seed = 1): { mean: number; p95: number; max: number } {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const xs: number[] = [];
  const ys: number[] = [];
  const vx: number[] = [];
  const vy: number[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  let change = 0;
  const err: number[] = [];
  for (let t = 0; t < ticks; t++) {
    if (t >= change) {
      dx = Math.floor(rnd() * 3) - 1;
      dy = Math.floor(rnd() * 3) - 1;
      change = t + 10 + Math.floor(rnd() * 30);
    }
    let ax = dx;
    let ay = dy;
    if (ax !== 0 && ay !== 0) {
      const l = Math.sqrt(2);
      ax /= l;
      ay /= l;
    }
    sx += ax * ACC;
    sy += ay * ACC;
    x += sx;
    y += sy;
    sx *= DAMP;
    sy *= DAMP;
    xs.push(x);
    ys.push(y);
    vx.push(sx);
    vy.push(sy);
    // latest refresh the client has: taken at a multiple of R, at least L ticks ago
    const r = Math.floor((t - L) / R) * R;
    if (r < 0) continue;
    const mx = xs[r]! + vx[r]! * (t - r);
    const my = ys[r]! + vy[r]! * (t - r);
    err.push(Math.hypot(mx - x, my - y));
  }
  err.sort((a, b) => a - b);
  return { mean: err.reduce((a, b) => a + b, 0) / err.length, p95: err[Math.floor(err.length * 0.95)]!, max: err[err.length - 1]! };
}
console.log('\n2. mask centre vs the viewer disc (world units; player radius 15, top speed ~2.4/tick)');
console.log('refresh  latency   mean   p95    max');
for (const hz of [5, 10, 20, 60]) {
  for (const ms of [50, 100, 200]) {
    const R = Math.round(60 / hz);
    const L = Math.round((ms / 1000) * 60);
    const e = simulate(R, L);
    console.log(`${String(hz).padStart(4)} Hz ${String(ms).padStart(6)} ms ${e.mean.toFixed(1).padStart(6)} ${e.p95.toFixed(1).padStart(6)} ${e.max.toFixed(1).padStart(6)}`);
  }
}
