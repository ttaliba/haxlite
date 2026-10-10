// haxlite Edge overhead on loopback: message RTT and host CPU per player,
// direct haxlite host vs the same host behind a haxlite Edge (UDP data plane,
// and optionally the WebSocket fallback).
//
//   node --experimental-transform-types --no-warnings --import ./scripts/ts-resolve.mjs \
//        scripts/edge-latency.ts [--players 8] [--seconds 20] [--modes direct,edge,edge-ws] [--runs 1]
//
// Processes (so CPU is attributed correctly):
//   main   FakeMaster + node-haxball load clients (busy-player input model of
//          bench/net: a key change every 60–250 ms) + 1 RTT probe (raw client)
//   host   HostRoom + HostTransport (direct, or with `edge`), noPlayer room, game running
//   edge   EdgeServer (edge modes only), bound to 127.0.0.2; the host tunnel binds 127.0.0.3
//
// RTT: the probe sends the client Ping message `[2][f64 t][varuint 0]` every
// 50 ms, alternating channel 0 (ro) and 2 (uu); the host answers with the Pong
// `[4][f64 frame][f64 t]` on uu; RTT = arrival − t. Host CPU = process.cpuUsage()
// of the host process over the measurement window (all threads, incl.
// libdatachannel's), divided by the number of players (load clients + probe).
import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROLE = process.argv[2];
const EDGE_IP = '127.0.0.2';
const HOST_IP = '127.0.0.3';
const KEY = { id: 'bench', secret: 'bench-secret-0123456789abcdef' };

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

const send = (m: unknown) => process.send?.(m);

// ======================================================================= edge child
async function edgeMain(): Promise<void> {
  const { EdgeServer } = await import('../src/edge/index.js');
  process.on('disconnect', () => process.exit(0));
  const edge = await EdgeServer.start({
    host: EDGE_IP,
    port: 0,
    keys: [KEY],
    webrtc: { bindAddress: EDGE_IP, iceServers: [], iceCandidatePolicy: 'all' },
  });
  let cpu0 = process.cpuUsage();
  let t0 = performance.now();
  process.on('message', (m: { cmd: string }) => {
    if (m.cmd === 'measure-start') {
      cpu0 = process.cpuUsage();
      t0 = performance.now();
    } else if (m.cmd === 'measure-stop') {
      const c = process.cpuUsage(cpu0);
      send({ type: 'cpu', cpuMs: (c.user + c.system) / 1000, wallMs: performance.now() - t0, rssMb: process.memoryUsage().rss / 1048576, stats: edge.stats() });
    }
  });
  send({ type: 'edge', url: edge.url() });
}

// ======================================================================= host child
async function hostMain(): Promise<void> {
  const [masterUrl, edgeUrl, dataPlane] = process.argv.slice(3);
  const { HostTransport } = await import('../src/net/index.js');
  const { HostRoom, createHostRoomState } = await import('../src/host/index.js');
  process.on('disconnect', () => process.exit(0));
  const edge = edgeUrl && edgeUrl !== '-' ? { url: edgeUrl, key: `${KEY.id}:${KEY.secret}`, bindAddress: HOST_IP, dataPlane: dataPlane as 'webrtc' | 'ws' } : null;
  const transport = new HostTransport({
    token: 'thr1.bench',
    masterUrl,
    iceServers: [],
    iceCandidatePolicy: 'all',
    maxPlayers: 30,
    edge,
  });
  const host = new HostRoom({ transport, state: createHostRoomState({ roomName: 'bench', noPlayer: true }) });
  host.onError = (e) => send({ type: 'error', message: String(e) });
  host.onRoomLink = (link) => send({ type: 'link', roomId: link.split('c=')[1] });
  let cpu0 = process.cpuUsage();
  let t0 = performance.now();
  process.on('message', (m: { cmd: string }) => {
    if (m.cmd === 'game') {
      const ps = host.state.players;
      for (let i = 0; i < ps.length; i++) host.setPlayerTeam(ps[i]!.id, (i % 2) + 1);
      host.startGame();
      send({ type: 'game', players: ps.length });
    } else if (m.cmd === 'measure-start') {
      cpu0 = process.cpuUsage();
      t0 = performance.now();
    } else if (m.cmd === 'measure-stop') {
      const c = process.cpuUsage(cpu0);
      send({ type: 'cpu', cpuMs: (c.user + c.system) / 1000, wallMs: performance.now() - t0, rssMb: process.memoryUsage().rss / 1048576 });
    }
  });
  host.start();
}

// ======================================================================= orchestrator
function child(role: string, args: string[]): ChildProcess {
  return fork(fileURLToPath(import.meta.url), [role, ...args], {
    execArgv: ['--experimental-transform-types', '--no-warnings', '--import', './scripts/ts-resolve.mjs'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

function next<T>(cp: ChildProcess, type: string, ms = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    const on = (m: { type: string; message?: string }) => {
      if (m.type === 'error') console.error(`[child] ${m.message}`);
      if (m.type !== type) return;
      clearTimeout(t);
      cp.off('message', on);
      resolve(m as T);
    };
    cp.on('message', on);
  });
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

interface Result {
  mode: string;
  players: number;
  samples: { ro: number; uu: number };
  rttRo: { p50: number; p99: number; mean: number };
  rttUu: { p50: number; p99: number; mean: number };
  hostCpuPctPerPlayer: number;
  hostCpuPct: number;
  hostRssMb: number;
  edgeCpuPct: number | null;
  edgeCpuPctPerPlayer: number | null;
  lost: number;
}

async function runMode(mode: string, players: number, seconds: number, seed: number): Promise<Result> {
  const { FakeMaster } = await import('../test/fake-master/index.js');
  const { RawClient } = await import('../test/net/raw-client.js');
  const { Writer } = await import('../src/codec/index.js');
  const require = createRequire(import.meta.url);
  const master = await FakeMaster.start();
  let edgeProc: ChildProcess | null = null;
  let edgeUrl = '-';
  if (mode !== 'direct') {
    edgeProc = child('edge', []);
    edgeUrl = (await next<{ url: string }>(edgeProc, 'edge')).url;
  }
  const hostProc = child('host', [master.httpBase, edgeUrl, mode === 'edge-ws' ? 'ws' : 'webrtc']);
  const { roomId } = await next<{ roomId: string }>(hostProc, 'link');

  // load clients (node-haxball)
  const nh = require('node-haxball')(null, master.nodeHaxballConfig);
  const rnd = prng(seed);
  const rooms: { room: { setKeyState(k: number): void; leave(): void } | null; closed: boolean }[] = [];
  for (let i = 0; i < players; i++) {
    const [, authObj] = (await nh.Utils.generateAuth()) as [string, unknown];
    const c = { room: null as never, closed: false };
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`join bot${i} timed out`)), 15_000);
      nh.Room.join(
        { id: roomId, password: null, authObj },
        {
          storage: { player_name: `bot${i}`, avatar: null, geo: { lat: 0, lon: 0, flag: 'uy' } },
          onOpen: (room: never) => {
            c.room = room;
            clearTimeout(t);
            resolve();
          },
          onClose: () => {
            c.closed = true;
            clearTimeout(t);
            reject(new Error(`bot${i} closed`));
          },
        },
      );
    });
    rooms.push(c);
  }

  // RTT probe (raw client)
  const probe = new RawClient({ wsBase: master.wsBase, roomId, identity: null, info: { name: 'probe', flag: 'uy', avatar: null } });
  const rttRo: number[] = [];
  const rttUu: number[] = [];
  const sentOn = new Map<number, number>();
  let gotSnapshot = false;
  (probe.received as unknown as { push: (x: [number, Uint8Array]) => number }).push = ([, bytes]) => {
    const now = performance.now();
    if (bytes[0] === 1) gotSnapshot = true;
    if (bytes[0] === 4 && bytes.length >= 17) {
      const echo = new DataView(bytes.buffer, bytes.byteOffset + 9, 8).getFloat64(0);
      const ch = sentOn.get(echo);
      if (ch !== undefined) {
        sentOn.delete(echo);
        (ch === 0 ? rttRo : rttUu).push(now - echo);
      }
    }
    return 0;
  };
  const t0 = performance.now();
  while (!gotSnapshot) {
    if (performance.now() - t0 > 15_000) throw new Error('probe join timed out');
    await new Promise((r) => setTimeout(r, 20));
  }

  hostProc.send({ cmd: 'game' });
  await next(hostProc, 'game');
  let running = true;
  const DIRS = [0, 1, 2, 4, 8, 5, 9, 6, 10];
  const drive = (c: (typeof rooms)[number]) => {
    if (!running || c.closed || c.room === null) return;
    c.room.setKeyState(DIRS[Math.floor(rnd() * DIRS.length)]! | (rnd() < 0.25 ? 16 : 0));
    setTimeout(() => drive(c), 60 + Math.floor(rnd() * 190));
  };
  for (const c of rooms) setTimeout(() => drive(c), Math.floor(rnd() * 200));
  await new Promise((r) => setTimeout(r, 3000)); // warm-up

  hostProc.send({ cmd: 'measure-start' });
  edgeProc?.send({ cmd: 'measure-start' });
  const w = new Writer(32);
  let n = 0;
  const pinger = setInterval(() => {
    const ch = n++ % 2 === 0 ? 0 : 2;
    const t = performance.now();
    sentOn.set(t, ch);
    w.reset();
    w.u8(2);
    w.f64(t);
    w.varUint(0);
    probe.send(ch, w.copyBytes());
  }, 50);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(pinger);
  const hostCpu = next<{ cpuMs: number; wallMs: number; rssMb: number }>(hostProc, 'cpu');
  hostProc.send({ cmd: 'measure-stop' });
  const edgeCpu = edgeProc ? next<{ cpuMs: number; wallMs: number }>(edgeProc, 'cpu') : null;
  edgeProc?.send({ cmd: 'measure-stop' });
  const hc = await hostCpu;
  const ec = edgeCpu ? await edgeCpu : null;
  await new Promise((r) => setTimeout(r, 200));
  running = false;

  const total = players + 1;
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { p50: +pct(s, 50).toFixed(3), p99: +pct(s, 99).toFixed(3), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) };
  };
  const res: Result = {
    mode,
    players: total,
    samples: { ro: rttRo.length, uu: rttUu.length },
    rttRo: stat(rttRo),
    rttUu: stat(rttUu),
    hostCpuPct: +((hc.cpuMs / hc.wallMs) * 100).toFixed(2),
    hostCpuPctPerPlayer: +((hc.cpuMs / hc.wallMs) * 100 / total).toFixed(3),
    hostRssMb: Math.round(hc.rssMb),
    edgeCpuPct: ec ? +((ec.cpuMs / ec.wallMs) * 100).toFixed(2) : null,
    edgeCpuPctPerPlayer: ec ? +((ec.cpuMs / ec.wallMs) * 100 / total).toFixed(3) : null,
    lost: sentOn.size,
  };

  for (const c of rooms) {
    try {
      c.room?.leave();
    } catch {
      /* gone */
    }
  }
  probe.close();
  hostProc.kill();
  edgeProc?.kill();
  await master.close();
  return res;
}

async function orchestrate(): Promise<void> {
  const players = Number(arg('players', '8'));
  const seconds = Number(arg('seconds', '20'));
  const runs = Number(arg('runs', '1'));
  const modes = arg('modes', 'direct,edge,edge-ws').split(',');
  const results: Result[] = [];
  for (let r = 0; r < runs; r++) {
    for (const mode of modes) {
      const res = await runMode(mode, players, seconds, 1000 + r);
      results.push(res);
      console.log(JSON.stringify(res));
    }
  }
  console.log('\nmode     players  RTT ro p50/p99 (ms)  RTT uu p50/p99 (ms)  host CPU %/player  host CPU %  edge CPU %/player');
  for (const r of results) {
    console.log(
      `${r.mode.padEnd(8)} ${String(r.players).padStart(7)}  ${`${r.rttRo.p50} / ${r.rttRo.p99}`.padEnd(20)} ${`${r.rttUu.p50} / ${r.rttUu.p99}`.padEnd(20)} ${String(r.hostCpuPctPerPlayer).padEnd(18)} ${String(r.hostCpuPct).padEnd(11)} ${r.edgeCpuPctPerPlayer ?? '-'}`,
    );
  }
  const { cleanupNodeHaxball } = await import('../test/fake-master/node-haxball.js');
  const { shutdownWebRtc } = await import('../src/net/index.js');
  await shutdownWebRtc();
  cleanupNodeHaxball();
  process.exit(0);
}

if (ROLE === 'edge') void edgeMain();
else if (ROLE === 'host') void hostMain();
else
  void orchestrate().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
