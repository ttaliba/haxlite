// Client load generator (separate process from the host under test, so client
// cost is never counted). node-haxball clients joined through the FakeMaster.
//
//   node bench/net/clients-proc.mjs <master host:port> <roomId:count,roomId:count,…> <seed>
//
// IPC in : {cmd:'drive'} | {cmd:'stop'}
// IPC out: {type:'joined', joined, failures, ms} | {type:'report', …} | {type:'error', message}
//
// Load model (identical for every host): each client changes its key state
// every 60–250 ms (uniform, ≈6.5 changes/s — a busy human player), picks one of
// 9 directions (incl. none), kick held 25 % of the time; each client sends a
// chat message with probability 1/200 per input change (≈1 every 30 s).
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const [masterHostPort, spec, seedArg] = process.argv.slice(2);
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

const nh = require('node-haxball')(null, { backend: { hostname: masterHostPort, hostnameWs: masterHostPort, secure: false } });
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

const t0 = performance.now();
let k = 0;
for (const t of targets) {
  for (let i = 0; i < t.n; i++) {
    const name = `bot${k++}`;
    let c = null;
    for (let attempt = 0; attempt < 4 && c === null; attempt++) {
      c = await joinOnce(t.id, name, 8000);
      if (c === null) failures++;
    }
    if (c === null) {
      send({ type: 'error', message: `could not join ${name} to ${t.id}` });
      continue;
    }
    clients.push(c);
  }
}
send({ type: 'joined', joined: clients.length, failures, ms: performance.now() - t0, joinMs: clients.map((c) => +c.joinMs.toFixed(1)) });

const DIRS = [0, 1, 2, 4, 8, 1 | 4, 1 | 8, 2 | 4, 2 | 8]; // none, up, down, left, right, diagonals
let running = false;
let cpu0 = null;
let tDrive = 0;

function drive(c) {
  if (!running || c.closed) return;
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

process.on('message', (msg) => {
  if (msg.cmd === 'drive') {
    running = true;
    cpu0 = process.cpuUsage();
    tDrive = performance.now();
    for (const c of clients) setTimeout(() => drive(c), Math.floor(rnd() * 200));
    send({ type: 'driving' });
  } else if (msg.cmd === 'stop') {
    running = false;
    const cpu = process.cpuUsage(cpu0 ?? undefined);
    const wall = performance.now() - tDrive;
    send({
      type: 'report',
      clients: clients.length,
      disconnected: clients.filter((c) => c.closed).length,
      inputs: clients.reduce((a, c) => a + c.inputs, 0),
      chats: clients.reduce((a, c) => a + c.chats, 0),
      // frames each client's room reached (sanity: game running for everyone)
      frames: clients.map((c) => c.room?.currentFrameNo ?? -1),
      cpuPct: ((cpu.user + cpu.system) / 1000 / wall) * 100,
      wallMs: wall,
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
