// Host message path in isolation (no network): HostRoom + a fake transport,
// N joined clients, a running game, each client sending SendInput events
// (msg 1) that are sequenced and broadcast to all N clients (msg 2), plus
// the periodic heartbeats. Measures CPU per message and bytes allocated per
// message by haxlite's own code (the fake transport and the driver allocate
// nothing per message: one reused input buffer per client, sends are no-ops).
//
//   node bench/host-msg.bench.mjs [dist=node_modules/.cache/haxlite-bench/dist] [clients=20] [messages=2e6]
//
// "bytes/msg" = V8 new-space bytes allocated per message, from
// v8.getHeapSpaceStatistics() around GC-free batches of 1000 messages
// (median of the batches). Also reports scavenges per 1000 messages over the
// whole run (PerformanceObserver 'gc').
import path from 'node:path';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(ROOT, process.argv[2] ?? 'node_modules/.cache/haxlite-bench/dist');
const N = Number(process.argv[3] ?? 20);
const MESSAGES = Number(process.argv[4] ?? 2e6);
const { HostRoom, createHostRoomState } = await import(pathToFileURL(path.join(dist, 'host/index.js')).href);

// ---------------------------------------------------------------- fake transport
let sent = 0;
let sentBytes = 0;
const roomInfo = { players: 0 };
const transport = {
  onPeerJoin: null,
  onPeerMessage: null,
  onPeerClose: null,
  onRoomLink: null,
  onError: null,
  connectionCount: 0,
  bans: { remove() {}, clear() {} },
  start() {},
  stop() {},
  getRoomInfo: () => roomInfo,
  setRoomInfo(i) {
    Object.assign(roomInfo, i);
  },
  send(peer, channel, data) {
    sent++;
    sentBytes += data.length;
    return true;
  },
  broadcastTo(targets, channel, data) {
    for (let i = 0; i < targets.length; i++) this.send(targets[i].peer, channel, data);
  },
  kick() {
    return null;
  },
  close() {},
  setPassword() {},
  setRequireRecaptcha() {},
  setMaxPlayers() {},
};

// virtual clock: 60 frames per `PER_FRAME` messages (≈ 20 clients × 6.5 inputs/s)
let now = 0;
const host = new HostRoom({ transport, state: createHostRoomState({ roomName: 'bench', noPlayer: true }), now: () => now });
host.onError = (e) => {
  throw e;
};
host.start();
const peers = [];
for (let i = 0; i < N; i++) {
  const peer = { id: i + 1, state: 'joined', playerId: -1, userData: null };
  transport.connectionCount++;
  transport.onPeerJoin(peer, { name: `p${i}`, flag: 'ar', avatar: null, auth: null, conn: '7F000001' });
  peers.push(peer);
}
for (const p of peers) host.setPlayerTeam(p.playerId, (p.playerId & 1) + 1);
host.setScoreLimit(0);
host.setTimeLimit(0);
host.startGame();

// one reusable msg-1 buffer per client: [1][u32 frame][u32 seq][u8 3 = SendInput][u32 input]
const bufs = peers.map(() => new Uint8Array(14));
const views = bufs.map((b) => new DataView(b.buffer));
const seqs = new Uint32Array(N);
const MSGS_PER_FRAME = Math.max(1, Math.round((N * 6.5) / 60));
function drive(count, startIndex) {
  for (let k = 0; k < count; k++) {
    const m = startIndex + k;
    const i = m % N;
    const v = views[i];
    v.setUint8(0, 1);
    v.setUint32(1, host.frame + 2);
    v.setUint32(5, ++seqs[i]);
    v.setUint8(9, 3);
    v.setUint32(10, (m >>> 3) & 31);
    transport.onPeerMessage(peers[i], bufs[i], 0);
    if (m % MSGS_PER_FRAME === 0) now += 1000 / 60;
  }
}

// warm-up
drive(200_000, 0);
let gcs = 0;
const obs = new PerformanceObserver((l) => {
  for (const e of l.getEntries()) if (e.detail?.kind === 1 || e.kind === 1) gcs++;
});
obs.observe({ entryTypes: ['gc'] });

const newSpace = () => v8.getHeapSpaceStatistics().find((s) => s.space_name === 'new_space').space_used_size;
const perBatch = [];
const BATCH = 1000;
let idx = 200_000;
// HEAP_PROF=<file>: sampling heap profile of everything allocated in the window
// (garbage included), for attributing the bytes/msg.
let session = null;
if (process.env.HEAP_PROF) {
  const { Session } = await import('node:inspector');
  session = new Session();
  session.connect();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  session.postAsync = post;
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
}
const c0 = process.cpuUsage();
const t0 = performance.now();
const sent0 = sent;
for (let b = 0; b < MESSAGES / BATCH; b++) {
  const before = newSpace();
  drive(BATCH, idx);
  idx += BATCH;
  const after = newSpace();
  if (after >= before) perBatch.push((after - before) / BATCH);
}
const t1 = performance.now();
const cpu = process.cpuUsage(c0);
await new Promise((r) => setTimeout(r, 50));
obs.disconnect();
if (session !== null) {
  const { profile } = await session.postAsync('HeapProfiler.stopSampling');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.HEAP_PROF, JSON.stringify(profile));
}
perBatch.sort((a, b) => a - b);
const med = perBatch[perBatch.length >> 1];
console.log(
  JSON.stringify({
    dist: path.relative(ROOT, dist),
    clients: N,
    messages: MESSAGES,
    nsPerMsg: +(((t1 - t0) * 1e6) / MESSAGES).toFixed(1),
    cpuNsPerMsg: +(((cpu.user + cpu.system) * 1e3) / MESSAGES).toFixed(1),
    sendsPerMsg: +((sent - sent0) / MESSAGES).toFixed(2),
    bytesPerMsg: med,
    scavengesPer1kMsgs: +((gcs * 1000) / MESSAGES).toFixed(3),
    frame: host.frame,
    heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2),
  }),
);
host.stop();
process.exit(0);
