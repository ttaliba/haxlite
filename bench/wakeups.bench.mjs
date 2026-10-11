// Process wake-ups caused by the host clock (src/host/clock.ts), no network:
// K rooms × 1 fake client with a running game, real timers, for S seconds.
//   node bench/wakeups.bench.mjs <dist> [rooms=1] [seconds=10] [maxWakeFrames=4]
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.argv[2]);
const K = Number(process.argv[3] ?? 1);
const S = Number(process.argv[4] ?? 10);
const MW = process.argv[5] === undefined ? undefined : Number(process.argv[5]);
const { HostRoom, createHostRoomState } = await import(pathToFileURL(path.join(dist, 'host/index.js')).href);
let clock = null;
try {
  clock = (await import(pathToFileURL(path.join(dist, 'host/clock.js')).href)).hostClock;
} catch {
  /* baseline build: per-room setTimeout, counted below */
}
let timeouts = 0;
const st = globalThis.setTimeout;
const si = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...a) => st(() => (timeouts++, fn(...a)), ms);
globalThis.setInterval = (fn, ms, ...a) => si(() => (timeouts++, fn(...a)), ms);
const rooms = [];
for (let i = 0; i < K; i++) {
  const roomInfo = { players: 0 };
  const t = { connectionCount: 0, bans: {}, start() {}, stop() {}, getRoomInfo: () => roomInfo, setRoomInfo(x) { Object.assign(roomInfo, x); }, send() { return true; }, broadcastTo() {}, kick: () => null, close() {} };
  const opts = { transport: t, state: createHostRoomState({ noPlayer: true }) };
  if (MW !== undefined) opts.maxWakeFrames = MW;
  const host = new HostRoom(opts);
  host.start();
  t.connectionCount = 1;
  t.onPeerJoin({ id: 1, state: 'joined', playerId: -1, userData: null }, { name: 'a', flag: 'ar', avatar: null, auth: null, conn: '7F000001' });
  host.startGame();
  rooms.push(host);
  await new Promise((r) => st(r, 7)); // rooms created at different times (unaligned frame grids)
}
await new Promise((r) => st(r, 500));
const w0 = timeouts;
const c0 = process.cpuUsage();
const t0 = performance.now();
await new Promise((r) => st(r, S * 1000));
const dt = (performance.now() - t0) / 1000;
const cpu = process.cpuUsage(c0);
console.log(JSON.stringify({ dist: path.basename(dist), rooms: K, maxWakeFrames: MW ?? 'default', wakeupsPerS: +((timeouts - w0) / dt).toFixed(1), cpuPct: +(((cpu.user + cpu.system) / 1e3 / (dt * 1000)) * 100).toFixed(3) }));
for (const h of rooms) h.stop();
process.exit(0);
