// Client load generator (separate process from the host under test, so client
// cost is never counted). node-haxball clients joined through the FakeMaster.
//
//   node bench/net/clients-proc.mjs <master host:port> <roomId:count,roomId:count,…> <seed> [options JSON]
//
// options: { churn?: { stayS: [min, max], pauseS: [min, max] }, joinConcurrency?: number }
//   churn (soak scenario): every client slot loops join → play for U(stayS) →
//   leave → wait U(pauseS) → join again, until 'stop'. Without churn the
//   clients join once, joinConcurrency at a time (default 1: sequentially; join
//   latency per client), and stay.
//
// IPC in : {cmd:'drive'} | {cmd:'window'} (restart the traffic/jitter counters) | {cmd:'stop'}
// IPC out: {type:'joined', joined, failures, ms, joinMs} | {type:'driving'} | {type:'report', …} | {type:'error', message}
//
// Load model (identical for every host): each client changes its key state
// every 60–250 ms (uniform, ≈6.5 changes/s — a busy human player), picks one of
// 9 directions (incl. none), kick held 25 % of the time; each client sends a
// chat message with probability 1/200 per input change (≈1 every 30 s).
//
// Traffic received from the host (every implementation alike): the data
// channels the clients create are wrapped to count messages and bytes per
// channel label, the inter-arrival gap of consecutive messages of one client
// on one channel, and on any channel (bounded 0.05 ms-bin histograms, p50/p99/p999). These are
// application-level messages (one SCTP message each), not UDP datagrams; the
// gaps include the client's own event-loop delay (libdatachannel delivers on
// a native thread, then the JS loop).
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const [masterHostPort, spec, seedArg, optsArg] = process.argv.slice(2);
const OPTS = optsArg ? JSON.parse(optsArg) : {};
const send = (m) => process.send?.(m);
process.on('uncaughtException', (e) => send({ type: 'error', message: String(e?.stack ?? e) }));
process.on('unhandledRejection', (e) => send({ type: 'error', message: String(e?.stack ?? e) }));
// never outlive the orchestrator
process.on('disconnect', () => process.exit(0));

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- received-traffic counters
const BIN_MS = 0.05;
const NBINS = 40_000; // 0..2 s, overflow in the last bin
class Hist {
  constructor() {
    this.bins = new Uint32Array(NBINS);
    this.n = 0;
    this.max = 0;
  }
  add(ms) {
    this.bins[Math.min(NBINS - 1, Math.floor(ms / BIN_MS))]++;
    this.n++;
    if (ms > this.max) this.max = ms;
  }
  /** Sparse form for IPC: [[bin, count], …] (the orchestrator merges processes). */
  sparse() {
    const out = [];
    for (let i = 0; i < NBINS; i++) if (this.bins[i] !== 0) out.push([i, this.bins[i]]);
    return { binMs: BIN_MS, n: this.n, max: this.max, bins: out };
  }
}
/** per channel label: { msgs, bytes, gaps: Hist } — reset by 'window' */
let traffic = new Map();
/** gap between consecutive messages of one client on ANY channel (what the player's view waits for) */
let anyGaps = new Hist();
let tWindow = performance.now();
function trafficOf(label) {
  let t = traffic.get(label);
  if (t === undefined) traffic.set(label, (t = { msgs: 0, bytes: 0, gaps: new Hist() }));
  return t;
}
const sizeOf = (d) => (typeof d === 'string' ? Buffer.byteLength(d) : (d?.byteLength ?? d?.length ?? 0));

function countingWindow() {
  const dir = path.dirname(require.resolve('node-haxball'));
  const poly = require(require.resolve('node-datachannel/polyfill', { paths: [dir] }));
  class CountingPeerConnection extends poly.RTCPeerConnection {
    /** Arrival of the last message on any channel of this connection (= this client). */
    lastAny = -1;
    createDataChannel(label, init) {
      const dc = super.createDataChannel(label, init);
      let last = -1;
      dc.addEventListener('message', (e) => {
        const now = performance.now();
        const t = trafficOf(label);
        t.msgs++;
        t.bytes += sizeOf(e.data);
        if (last >= 0 && last >= tWindow) t.gaps.add(now - last);
        last = now;
        if (this.lastAny >= 0 && this.lastAny >= tWindow) anyGaps.add(now - this.lastAny);
        this.lastAny = now;
      });
      return dc;
    }
  }
  return { RTCPeerConnection: CountingPeerConnection, RTCIceCandidate: poly.RTCIceCandidate, RTCSessionDescription: poly.RTCSessionDescription };
}

const nh = require('node-haxball')(countingWindow(), { backend: { hostname: masterHostPort, hostnameWs: masterHostPort, secure: false } });
const targets = spec.split(',').map((s) => {
  const [id, n] = s.split(':');
  return { id, n: Number(n) };
});
const rnd = prng(Number(seedArg ?? 1));
const clients = [];
let failures = 0;

function joinOnce(roomId, name, timeoutMs) {
  return new Promise(async (resolve) => {
    const [, authObj] = await nh.Utils.generateAuth();
    const c = { name, room: null, closed: false, inputs: 0, chats: 0, joinMs: NaN };
    const tJoin = performance.now(); // Room.join → onOpen: signaling + offer/answer + ICE/DTLS/SCTP + challenge

    let done = false;
    let j = null;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        j?.cancel();
      } catch {}
      resolve(null);
    }, timeoutMs);
    j = nh.Room.join(
      { id: roomId, password: null, authObj },
      {
        storage: { player_name: name, avatar: null, geo: { lat: 0, lon: 0, flag: 'uy' } },
        onOpen: (room) => {
          c.room = room;
          c.joinMs = performance.now() - tJoin;
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(c);
        },
        onClose: () => {
          c.closed = true;
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(null);
        },
      },
    );
  });
}

const DIRS = [0, 1, 2, 4, 8, 1 | 4, 1 | 8, 2 | 4, 2 | 8]; // none, up, down, left, right, diagonals
let running = false;
let cpu0 = null;
let tDrive = 0;

function drive(c) {
  if (!running || c.closed || c.left) return;
  const dir = DIRS[Math.floor(rnd() * DIRS.length)];
  const kick = rnd() < 0.25 ? 16 : 0;
  try {
    c.room.setKeyState(dir | kick);
    c.inputs++;
    if (rnd() < 1 / 200) {
      c.room.sendChat(`${c.name} gg ${c.chats}`);
      c.chats++;
    }
  } catch (e) {
    send({ type: 'error', message: `input: ${e}` });
  }
  setTimeout(() => drive(c), 60 + Math.floor(rnd() * 190));
}

// ------------------------------------------------------------- churn (soak)
const churn = OPTS.churn ?? null;
const churnStats = { joins: 0, leaves: 0, failures: 0, joinMs: new Hist(), droppedByHost: 0 };
const uniform = ([a, b]) => (a + rnd() * (b - a)) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let k = 0;

async function churnSlot(roomId) {
  while (running) {
    const c = await joinOnce(roomId, `bot${k++}`, 8000);
    if (c === null) {
      churnStats.failures++;
      await sleep(1000);
      continue;
    }
    churnStats.joins++;
    churnStats.joinMs.add(c.joinMs);
    clients.push(c);
    drive(c);
    const tEnd = performance.now() + uniform(churn.stayS);
    while (running && !c.closed && performance.now() < tEnd) await sleep(250);
    clients.splice(clients.indexOf(c), 1);
    if (c.closed) churnStats.droppedByHost++;
    c.left = true;
    try {
      c.room.leave();
    } catch {}
    churnStats.leaves++;
    if (running) await sleep(uniform(churn.pauseS));
  }
}

// ------------------------------------------------------------- start-up
const t0 = performance.now();
if (churn) {
  // slots start in 'drive'; nothing to join up front
  send({ type: 'joined', joined: targets.reduce((a, t) => a + t.n, 0), failures: 0, ms: 0, joinMs: [] });
} else {
  // Joins run `joinConcurrency` at a time (default 1 = one after another). A join is
  // ~1 s of client-side waiting (node-haxball's own ICE gathering before its offer,
  // docs/07 "Dónde se iban los ~2 s de entrada"), not host work, so a few at once cut
  // the set-up time; joinMs is still per client (Room.join → onOpen of the attempt that got in).
  const slots = [];
  for (const t of targets) for (let i = 0; i < t.n; i++) slots.push({ id: t.id, name: `bot${k++}` });
  const ordered = new Array(slots.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < slots.length) {
      const idx = next++;
      const { id, name } = slots[idx];
      let c = null;
      for (let attempt = 0; attempt < 4 && c === null; attempt++) {
        c = await joinOnce(id, name, 8000);
        if (c === null) failures++;
      }
      if (c === null) send({ type: 'error', message: `could not join ${name} to ${id}` });
      ordered[idx] = c;
    }
  };
  const conc = Math.max(1, Math.min(slots.length, Number(OPTS.joinConcurrency ?? 1)));
  await Promise.all(Array.from({ length: conc }, worker));
  for (const c of ordered) if (c !== null) clients.push(c);
  send({ type: 'joined', joined: clients.length, failures, ms: performance.now() - t0, joinMs: clients.map((c) => +c.joinMs.toFixed(1)), concurrency: conc });
}

function trafficReport() {
  const wall = performance.now() - tWindow;
  const out = {};
  for (const [label, t] of traffic) out[label] = { msgs: t.msgs, bytes: t.bytes, gaps: t.gaps.sparse() };
  return { wallMs: wall, byLabel: out, anyGaps: anyGaps.sparse() };
}

process.on('message', (msg) => {
  if (msg.cmd === 'drive') {
    running = true;
    cpu0 = process.cpuUsage();
    tDrive = performance.now();
    if (churn) {
      for (const t of targets) for (let i = 0; i < t.n; i++) setTimeout(() => void churnSlot(t.id), Math.floor(rnd() * 2000));
    } else {
      for (const c of clients) setTimeout(() => drive(c), Math.floor(rnd() * 200));
    }
    send({ type: 'driving' });
  } else if (msg.cmd === 'window') {
    traffic = new Map();
    anyGaps = new Hist();
    tWindow = performance.now();
    send({ type: 'window' });
  } else if (msg.cmd === 'stop') {
    running = false;
    const cpu = process.cpuUsage(cpu0 ?? undefined);
    const wall = performance.now() - tDrive;
    send({
      type: 'report',
      clients: clients.length,
      disconnected: churn ? churnStats.droppedByHost : clients.filter((c) => c.closed).length,
      inputs: clients.reduce((a, c) => a + c.inputs, 0),
      chats: clients.reduce((a, c) => a + c.chats, 0),
      // frames each client's room reached (sanity: game running for everyone)
      frames: clients.map((c) => c.room?.currentFrameNo ?? -1),
      cpuPct: ((cpu.user + cpu.system) / 1000 / wall) * 100,
      wallMs: wall,
      traffic: trafficReport(),
      churn: churn ? { joins: churnStats.joins, leaves: churnStats.leaves, failures: churnStats.failures, droppedByHost: churnStats.droppedByHost, joinMs: churnStats.joinMs.sparse() } : null,
    });
  } else if (msg.cmd === 'exit') {
    for (const c of clients) {
      try {
        c.room.leave();
      } catch {}
    }
    process.exit(0);
  }
});
