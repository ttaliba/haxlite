// Host process under test (plain JS on purpose: no TypeScript loader in the
// measured process). Forked by bench/net/run.ts; talks to it over IPC.
//
//   node bench/net/host-proc.mjs <impl> <master host:port> <rooms>
//
// impl = haxlite      → HostRoom + HostTransport from the compiled build
//                       (node_modules/.cache/haxlite-bench/dist, `npm run bench:build`)
//      = official     → haxball.js (the official headless script) with its
//                       api/host XHR redirected to the FakeMaster
//      = nodehaxball  → node-haxball Room.create with backend = FakeMaster
//
// Every implementation gets the same room config: public, noPlayer, maxPlayers
// 30, same geo, default stadium (Classic), score/time limit 0 (set before
// starting the game) and default network settings (incl. default STUN list).
//
// IPC in : {cmd:'game'} | {cmd:'measure-start', eld, sampleMs} | {cmd:'measure-stop'} | {cmd:'players'}
// IPC out: {type:'link', room, id, tCreate, tLink} | {type:'game', players} |
//          {type:'stats', …} | {type:'players', counts} | {type:'error', message}
import { createRequire } from 'node:module';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T_START = performance.now(); // ms since process start (performance.timeOrigin)
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const [impl, masterHostPort, roomsArg] = process.argv.slice(2);
const ROOMS = Number(roomsArg ?? 1);
const GEO = { code: 'ar', lat: -34.6, lon: -58.4 };
const MAX_PLAYERS = 30;

const send = (m) => process.send?.(m);
process.on('uncaughtException', (e) => send({ type: 'error', message: String(e?.stack ?? e) }));
process.on('unhandledRejection', (e) => send({ type: 'error', message: String(e?.stack ?? e) }));
// never outlive the orchestrator
process.on('disconnect', () => process.exit(0));

/**
 * libdatachannel-based clients (node-haxball) drop data-channel messages that
 * arrive before ALL their channels report open; the official and node-haxball
 * hosts send the join challenge the instant channel 0 opens, so ~20 % of
 * loopback joins hang. haxlite delays the challenge 40 ms (challengeDelayMs).
 * For the other hosts we wrap RTCPeerConnection so that, on each channel,
 * sends issued within 40 ms of the FIRST send are deferred to first+40 ms
 * (FIFO kept). Afterwards send() is called directly: steady-state cost is a
 * closure call and one comparison per message.
 */
function earlySendDelay(PeerConnection, delayMs = 40) {
  return class DelayedEarlySend extends PeerConnection {
    // node-haxball clients send their ICE candidates as "a=candidate:…" (SDP
    // line form); browsers send "candidate:…". libdatachannel accepts both,
    // @webrtc-node/webrtc (haxball.js) rejects the "a=" form and the join
    // fails. Normalise it (client quirk; no effect on host behaviour).
    addIceCandidate(c, ...rest) {
      if (c && typeof c.candidate === 'string' && c.candidate.startsWith('a=')) {
        c = { candidate: c.candidate.slice(2), sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment };
      }
      return super.addIceCandidate(c, ...rest);
    }
    createDataChannel(label, init) {
      const dc = super.createDataChannel(label, init);
      const raw = dc.send.bind(dc);
      let first = -1;
      let queue = null;
      dc.send = (data) => {
        if (first < 0) first = performance.now();
        if (queue === null && performance.now() - first >= delayMs) return raw(data);
        if (queue === null) {
          queue = [];
          setTimeout(() => {
            const q = queue;
            queue = null;
            for (const d of q) if (dc.readyState === 'open') raw(d);
          }, Math.max(0, first + delayMs - performance.now()));
        }
        queue.push(data);
      };
      return dc;
    }
  };
}

// ------------------------------------------------------------- adapters
// Each adapter: { id, players(): number[] (ids of connected clients),
//                 setTeam(id, team), startGame() }

async function haxliteFactory() {
  const dist = path.join(ROOT, 'node_modules/.cache/haxlite-bench/dist');
  const { HostRoom, createHostRoomState } = await import(pathToFileURL(path.join(dist, 'host/index.js')).href);
  const { HostTransport } = await import(pathToFileURL(path.join(dist, 'net/index.js')).href);
  return (i, onLink) => {
    const transport = new HostTransport({
      token: `thr1.bench${i}`,
      masterUrl: `http://${masterHostPort}/rs/`,
      public: true,
      maxPlayers: MAX_PLAYERS,
      roomInfo: { name: `bench ${i}`, flag: GEO.code, lat: GEO.lat, lon: GEO.lon },
    });
    const host = new HostRoom({ transport, state: createHostRoomState({ roomName: `bench ${i}`, noPlayer: true }) });
    host.onError = (e) => send({ type: 'error', message: `haxlite onError: ${e?.stack ?? e}` });
    host.onRoomLink = (link) => onLink(link);
    host.start();
    return {
      players: () => host.getPlayerList().map((p) => p.id),
      setTeam: (id, t) => host.setPlayerTeam(id, t),
      startGame: () => {
        host.setScoreLimit(0);
        host.setTimeLimit(0);
        host.startGame();
      },
    };
  };
}

async function officialFactory() {
  const hxRequire = createRequire(require.resolve('haxball.js'));
  // Redirect the official script's master HTTP calls (api/host, api/geo) to the
  // FakeMaster. The host WS URL comes from the api/host answer (ws://…/host).
  const XHR = hxRequire('xhr2');
  const open = XHR.prototype.open;
  XHR.prototype.open = function (method, url, ...rest) {
    return open.call(this, method, String(url).replace('https://www.haxball.com/rs/', `http://${masterHostPort}/rs/`), ...rest);
  };
  const webrtc = hxRequire('@webrtc-node/webrtc');
  const { default: HaxballJS } = await import('haxball.js');
  return async (i, onLink) => {
    // Each HaxballJS() evaluates a fresh copy of the headless script (one HBInit per copy).
    const HBInit = await HaxballJS({
      webrtc: {
        RTCPeerConnection: earlySendDelay(webrtc.RTCPeerConnection),
        RTCIceCandidate: webrtc.RTCIceCandidate,
        RTCSessionDescription: webrtc.RTCSessionDescription,
      },
    });
    const room = HBInit({ roomName: `bench ${i}`, maxPlayers: MAX_PLAYERS, public: true, noPlayer: true, token: `thr1.bench${i}`, geo: GEO });
    room.onRoomLink = (link) => onLink(link);
    return {
      players: () => room.getPlayerList().map((p) => p.id),
      setTeam: (id, t) => room.setPlayerTeam(id, t),
      startGame: () => {
        room.setScoreLimit(0);
        room.setTimeLimit(0);
        room.startGame();
      },
    };
  };
}

async function nodeHaxballFactory() {
  const nhDir = path.dirname(require.resolve('node-haxball'));
  const poly = require(require.resolve('node-datachannel/polyfill', { paths: [nhDir] }));
  const window = {
    RTCPeerConnection: earlySendDelay(poly.RTCPeerConnection),
    RTCIceCandidate: poly.RTCIceCandidate,
    RTCSessionDescription: poly.RTCSessionDescription,
  };
  const nh = require('node-haxball')(window, { backend: { hostname: masterHostPort, hostnameWs: masterHostPort, secure: false } });
  return (i, onLink) =>
    new Promise((resolve, reject) => {
      nh.Room.create(
        {
          name: `bench ${i}`,
          password: null,
          showInRoomList: true,
          maxPlayerCount: MAX_PLAYERS,
          noPlayer: true,
          token: `thr1.bench${i}`,
          geo: { lat: GEO.lat, lon: GEO.lon, flag: GEO.code },
        },
        {
          storage: { player_name: 'host', avatar: null },
          onOpen: (room) => {
            room.onAfterRoomLink = (link) => onLink(link);
            resolve({
              players: () => room.players.filter((p) => p.id !== 0).map((p) => p.id),
              setTeam: (id, t) => room.setPlayerTeam(id, t),
              startGame: () => {
                room.setScoreLimit(0);
                room.setTimeLimit(0);
                room.startGame();
              },
            });
          },
          onClose: (e) => {
            send({ type: 'error', message: `node-haxball host closed: ${String(e)}` });
            reject(e);
          },
        },
      );
    });
}

// ------------------------------------------------------------- measurement

let meas = null;

function startMeasure({ eld = true, sampleMs = 1000 } = {}) {
  const h = eld ? monitorEventLoopDelay({ resolution: 10 }) : null;
  h?.enable();
  const gc = { count: 0, ms: 0 };
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gc.count++;
      gc.ms += e.duration;
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  const m = {
    h,
    obs,
    gc,
    t0: performance.now(),
    cpu0: process.cpuUsage(),
    mem0: process.memoryUsage(),
    samples: [],
    last: { t: performance.now(), cpu: process.cpuUsage() },
    timer: null,
  };
  m.timer = setInterval(() => {
    const t = performance.now();
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    const d = cpu.user - m.last.cpu.user + (cpu.system - m.last.cpu.system);
    m.samples.push({ t: t - m.t0, cpuPct: (d / 1000 / (t - m.last.t)) * 100, rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external });
    m.last = { t, cpu };
  }, sampleMs);
  meas = m;
}

function stopMeasure() {
  const m = meas;
  meas = null;
  clearInterval(m.timer);
  const t1 = performance.now();
  const cpu = process.cpuUsage(m.cpu0);
  const mem = process.memoryUsage();
  m.obs.disconnect();
  const wallMs = t1 - m.t0;
  const rss = m.samples.map((s) => s.rss).concat(mem.rss);
  const heap = m.samples.map((s) => s.heapUsed).concat(mem.heapUsed);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  let eld = null;
  if (m.h) {
    m.h.disable();
    // Histogram values are the interval between the monitor's 10 ms timer
    // callbacks; lag = value − 10 ms.
    const lag = (ns) => Math.max(0, ns / 1e6 - 10);
    eld = {
      p50: lag(m.h.percentile(50)),
      p90: lag(m.h.percentile(90)),
      p99: lag(m.h.percentile(99)),
      max: lag(m.h.max),
      mean: lag(m.h.mean),
      samples: m.h.count,
    };
  }
  return {
    wallMs,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    cpuPct: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
    rssStart: m.mem0.rss,
    rssEnd: mem.rss,
    rssMean: mean(rss),
    rssMax: Math.max(...rss),
    heapUsedStart: m.mem0.heapUsed,
    heapUsedEnd: mem.heapUsed,
    heapUsedMean: mean(heap),
    heapUsedMax: Math.max(...heap),
    heapTotalEnd: mem.heapTotal,
    externalEnd: mem.external,
    arrayBuffersEnd: mem.arrayBuffers,
    gcCount: m.gc.count,
    gcMs: m.gc.ms,
    eld,
    cpuPctSeries: m.samples.map((s) => +s.cpuPct.toFixed(3)),
  };
}

// ------------------------------------------------------------- main

const factories = { haxlite: haxliteFactory, official: officialFactory, nodehaxball: nodeHaxballFactory };
if (!factories[impl]) throw new Error(`unknown impl ${impl}`);
const T_IMPORT0 = performance.now();
const create = await factories[impl]();
const T_READY = performance.now();
const rooms = [];
for (let i = 0; i < ROOMS; i++) {
  const tCreate = performance.now();
  let linked = false;
  const onLink = (link) => {
    if (linked) return;
    linked = true;
    const tLink = performance.now();
    const id = new URL(link).searchParams.get('c');
    const cpu = process.cpuUsage();
    send({ type: 'link', room: i, id, link, tStart: T_START, tLoad: T_READY - T_IMPORT0, tCreate, tLink, cpuMs: (cpu.user + cpu.system) / 1000, rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed });
  };
  rooms.push(await create(i, onLink));
}

process.on('message', (msg) => {
  try {
    switch (msg.cmd) {
      case 'players':
        send({ type: 'players', counts: rooms.map((r) => r.players().length) });
        break;
      case 'game': {
        const counts = [];
        for (const r of rooms) {
          const ids = r.players();
          ids.forEach((id, k) => r.setTeam(id, k % 2 === 0 ? 1 : 2));
          r.startGame();
          counts.push(ids.length);
        }
        send({ type: 'game', players: counts });
        break;
      }
      case 'measure-start':
        startMeasure(msg);
        send({ type: 'measuring' });
        break;
      case 'measure-stop':
        send({ type: 'stats', stats: stopMeasure(), players: rooms.map((r) => r.players().length) });
        break;
      case 'exit':
        process.exit(0);
    }
  } catch (e) {
    send({ type: 'error', message: String(e?.stack ?? e) });
  }
});
