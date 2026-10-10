// Cost of the host clock strategies alone (no game, no network), to size the
// fixed per-room overhead seen in docs/07-benchmarks.md:
//   frame   — haxlite HostRoom: one setTimeout re-armed for every 60 Hz frame
//             boundary (`Math.ceil(start + next/0.06 - now)`), i.e. 60 wake-ups/s
//   refresh — same schedule but re-using ONE Timeout via timeout.refresh()
//             when the delay is unchanged (suggested optimisation)
//   shared  — K rooms served by one process-wide 60 Hz timer (suggested)
//   interval50 — official headless: setInterval(fn, 50), 20 wake-ups/s
//
//   node bench/timer.bench.mjs [seconds=20] [rooms=1]
import { performance } from 'node:perf_hooks';

const SECONDS = Number(process.argv[2] ?? 20);
const ROOMS = Number(process.argv[3] ?? 1);
const TICKS_PER_MS = 0.06;
let sink = 0;
const work = () => {
  sink++;
};

function frameTimers(stop) {
  for (let r = 0; r < ROOMS; r++) {
    const start = performance.now();
    let frame = 0;
    let timer = null;
    const onTimer = () => {
      frame = ((performance.now() - start) * TICKS_PER_MS) | 0;
      work();
      if (stop.done) return;
      const delay = Math.ceil(start + (frame + 1) / TICKS_PER_MS - performance.now());
      timer = setTimeout(onTimer, delay > 0 ? delay : 0);
    };
    timer = setTimeout(onTimer, 0);
  }
}

function refreshTimers(stop) {
  for (let r = 0; r < ROOMS; r++) {
    const start = performance.now();
    let frame = 0;
    let timer = null;
    let lastDelay = -1;
    const onTimer = () => {
      frame = ((performance.now() - start) * TICKS_PER_MS) | 0;
      work();
      if (stop.done) return;
      let delay = Math.ceil(start + (frame + 1) / TICKS_PER_MS - performance.now());
      if (delay < 1) delay = 1;
      if (delay === lastDelay) timer.refresh();
      else {
        timer = setTimeout(onTimer, delay);
        lastDelay = delay;
      }
    };
    timer = setTimeout(onTimer, 1);
    lastDelay = 1;
  }
}

function sharedTimer(stop) {
  const start = performance.now();
  const rooms = Array.from({ length: ROOMS }, () => ({ frame: 0 }));
  const onTimer = () => {
    const frame = ((performance.now() - start) * TICKS_PER_MS) | 0;
    for (let i = 0; i < rooms.length; i++) {
      rooms[i].frame = frame;
      work();
    }
    if (stop.done) return;
    const delay = Math.ceil(start + (frame + 1) / TICKS_PER_MS - performance.now());
    setTimeout(onTimer, delay > 0 ? delay : 0);
  };
  setTimeout(onTimer, 0);
}

function interval50(stop) {
  for (let r = 0; r < ROOMS; r++) {
    const t = setInterval(() => {
      work();
      if (stop.done) clearInterval(t);
    }, 50);
  }
}

async function measure(name, fn) {
  const stop = { done: false };
  if (fn) fn(stop);
  await new Promise((r) => setTimeout(r, 1000)); // settle
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const s0 = sink;
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const c = process.cpuUsage(c0);
  const wall = performance.now() - t0;
  const calls = sink - s0;
  stop.done = true;
  await new Promise((r) => setTimeout(r, 200));
  const pct = ((c.user + c.system) / 1000 / wall) * 100;
  return { name, rooms: ROOMS, cpuPct: +pct.toFixed(3), wakeupsPerS: +((calls / wall) * 1000).toFixed(1) };
}

const out = [];
out.push(await measure('baseline (no timers)', null));
out.push(await measure('frame (setTimeout per frame)', frameTimers));
out.push(await measure('refresh (Timeout.refresh)', refreshTimers));
out.push(await measure('shared (one timer, all rooms)', sharedTimer));
out.push(await measure('interval50 (official)', interval50));
console.log(JSON.stringify({ node: process.version, seconds: SECONDS, rooms: ROOMS, results: out }));
