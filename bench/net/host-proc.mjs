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
// IPC in : {cmd:'game'} | {cmd:'measure-start', eld, sampleMs, stream} | {cmd:'measure-stop'} | {cmd:'players'}
//          {cmd:'auto-teams'} (soak: new players get a team, game kept running) | {cmd:'impair-stats'}
// IPC out: {type:'link', room, id, tCreate, tLink} | {type:'game', players} |
//          {type:'stats', …} | {type:'players', counts} | {type:'error', message} |
//          {type:'sample', …} (measure-start with stream: one per sampleMs) | {type:'impair-stats', …}
//
// Runtime: Node (default) or Bun (`bun bench/net/host-proc.mjs …`, run.ts --runtime bun).
// Under Bun there are no GC events (gcCount/gcMs = null), the event-loop lag
// comes from a 10 ms timer of our own (see eldMonitor) and `bun:jsc` heapStats
// are added to the stats. /proc metrics (threads, wake-ups, fds) are Linux only (null elsewhere).
//
// HAXLITE_BENCH_IMPAIR (join-impaired scenario, haxlite:rtc only) = JSON
// {rttMs, lossPct, jitterMs, stun:'cold'|'cached', outside, filtering}: the host's endpoint
// binds 127.0.0.1 and reaches clients and the STUN server only through the
// userspace NAT of test/rtc/nat-sim.ts, whose forwarding gets rttMs/2 of delay
// (± jitterMs) and lossPct % loss in each direction.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T_START = performance.now(); // ms since process start (performance.timeOrigin)
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IS_BUN = typeof globalThis.Bun !== 'undefined';
const JSC = IS_BUN ? await import('bun:jsc') : null;
const IMPAIR = process.env.HAXLITE_BENCH_IMPAIR ? JSON.parse(process.env.HAXLITE_BENCH_IMPAIR) : null;

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

/**
 * A/B variants (diagnostics, src/net tuning): impl `haxlite:<name>` — built-in
 * `haxlite:rtc` (peerBackend 'rtc') and `haxlite:ndc`, or from
 * `HAXLITE_BENCH_VARIANTS` = JSON `{ "<name>": { dist?, bundle?, transport?, sctp?, logger? } }`:
 * another compiled build (path relative to the repo; `bundle`: a `scripts/build.mjs --out` dir), extra HostTransport
 * options, node-datachannel `setSctpSettings(…)` and `initLogger(level)`.
 */
/** Built-in variants (overridable through HAXLITE_BENCH_VARIANTS). */
const BUILTIN_VARIANTS = {
  // peerBackend 'rtc' (haxlite-rtc) on loopback, the clients' only route to the host
  rtc: { transport: { peerBackend: 'rtc', rtcEndpoint: { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] } } },
  // explicit node-datachannel (same as plain `haxlite`)
  ndc: { transport: { peerBackend: 'ndc' } },
};

function variantOf(name) {
  if (!name.startsWith('haxlite:')) return {};
  const all = { ...BUILTIN_VARIANTS, ...JSON.parse(process.env.HAXLITE_BENCH_VARIANTS ?? '{}') };
  const v = all[name.slice('haxlite:'.length)];
  if (v === undefined) throw new Error(`unknown variant ${name}`);
  return v;
}

async function haxliteFactory() {
  const variant = variantOf(impl);
  const dist = path.resolve(ROOT, variant.dist ?? 'node_modules/.cache/haxlite-bench/dist');
  if (variant.sctp || variant.logger) {
    const ndc = createRequire(path.join(dist, 'x.js'))('node-datachannel');
    if (variant.logger) ndc.initLogger(variant.logger, () => {});
    if (variant.sctp) ndc.setSctpSettings(variant.sctp);
  }
  // Default: the shipped package bundle (minified, `npm run bench:build`), i.e. what users run.
  // A variant with an explicit `dist` (per-module tsc build) is loaded module by module.
  // A variant `bundle` (directory of another `scripts/build.mjs --out` build) is loaded instead (A/B of bundles).
  const bundle = path.resolve(ROOT, variant.bundle ?? 'node_modules/.cache/haxlite-bench/bundle', 'index.js');
  const mod =
    !variant.dist && existsSync(bundle)
      ? await import(pathToFileURL(bundle).href)
      : {
          ...(await import(pathToFileURL(path.join(dist, 'host/index.js')).href)),
          net: await import(pathToFileURL(path.join(dist, 'net/index.js')).href),
          ...(await import(pathToFileURL(path.join(dist, 'net/index.js')).href)),
        };
  const { HostRoom, createHostRoomState, HostTransport } = mod;
  return async (i, onLink) => {
    const imp = IMPAIR ? await impairedBackend(mod.net.RtcPeerBackend, i) : null;
    const transport = new HostTransport({
      token: `thr1.bench${i}`,
      masterUrl: `http://${masterHostPort}/rs/`,
      public: true,
      maxPlayers: MAX_PLAYERS,
      roomInfo: { name: `bench ${i}`, flag: GEO.code, lat: GEO.lat, lon: GEO.lon },
      ...variant.transport,
      ...(imp ? { backend: imp.backend } : null),
    });
    // HAXLITE_HOST_OPTS (diagnostics only, never set for the published results):
    // extra HostRoom options, e.g. '{"heartbeatFrames":9}'.
    const extra = process.env.HAXLITE_HOST_OPTS ? JSON.parse(process.env.HAXLITE_HOST_OPTS) : {};
    const host = new HostRoom({ transport, state: createHostRoomState({ roomName: `bench ${i}`, noPlayer: true }), ...extra });
    host.onError = (e) => send({ type: 'error', message: `haxlite onError: ${e?.stack ?? e}` });
    if (imp) {
      // The link is reported once the endpoint listens and the first STUN round is
      // done: no join pays the endpoint start-up; `cold` re-runs the round per session.
      let link = null;
      let ready = false;
      host.onRoomLink = (l) => (ready ? onLink(l) : (link = l));
      host.start();
      await imp.inner.whenListening();
      await imp.inner.endpoint.whenGathered();
      ready = true;
      if (link !== null) onLink(link);
    } else {
      host.onRoomLink = (link) => onLink(link);
      host.start();
    }
    return {
      players: () => host.getPlayerList().map((p) => p.id),
      // objects whose Map/Set sizes the soak scenario follows (see mapSizes)
      internals: () => ({ host, transport, backend: transport.backend, endpoint: transport.backend?.endpoint ?? imp?.inner.endpoint ?? null }),
      impairStats: imp ? () => imp.stats() : null,
      // haxlite-rtc endpoint counters (UDP datagrams in/out), null for other backends
      rtcStats: () => (imp ? imp.inner.stats() : (transport.backend?.stats?.() ?? null)),
      setTeam: (id, t) => host.setPlayerTeam(id, t),
      startGame: () => {
        host.setScoreLimit(0);
        host.setTimeLimit(0);
        host.startGame();
      },
    };
  };
}

/**
 * join-impaired: RtcPeerBackend (full ICE, bound to 127.0.0.1, STUN through the
 * NAT) wrapped like test/net/rtc-nat.test.ts (each remote candidate rewritten to
 * its NAT alias), with delay/loss injected into the NAT's forwarding.
 */
async function impairedBackend(RtcPeerBackend, i) {
  if (!impl.startsWith('haxlite:rtc')) throw new Error('join-impaired needs impl haxlite:rtc');
  const { UdpNat, FakeStunServer } = await import(pathToFileURL(path.join(ROOT, 'test/rtc/nat-sim.ts')).href);
  const outside = IMPAIR.outside ?? '127.0.0.1';
  const stun = await FakeStunServer.start(outside);
  // Full-cone filtering by default: the clients' libdatachannel sockets send from
  // other addresses than the candidates they announce (LAN interfaces vs
  // loopback), which a port-restricted NAT on loopback would drop.
  const nat = new UdpNat({ insideAddress: '127.0.0.1', outsideAddress: outside, filtering: IMPAIR.filtering ?? 'endpoint-independent' });
  const imp = { delayed: 0, dropped: 0 };
  const oneWay = (IMPAIR.rttMs ?? 0) / 2;
  const jitter = IMPAIR.jitterMs ?? 0;
  const loss = (IMPAIR.lossPct ?? 0) / 100;
  // UdpNat's sockets call this.fromInside / this.fromOutside: instance overrides apply.
  for (const k of ['fromInside', 'fromOutside']) {
    const orig = nat[k].bind(nat);
    nat[k] = (a, msg, from) => {
      if (loss > 0 && Math.random() < loss) {
        imp.dropped++;
        return;
      }
      const d = oneWay + (jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0);
      if (d <= 0) return orig(a, msg, from);
      imp.delayed++;
      setTimeout(() => orig(a, msg, from), d);
    };
  }
  const alias = await nat.alias({ address: stun.address, port: stun.port });
  const inner = new RtcPeerBackend(
    { address: '127.0.0.1', shared: false, gatherRefreshMs: IMPAIR.stun === 'cold' ? 0 : 3_600_000 },
    { iceServers: [`stun:${alias.address}:${alias.port}`] },
  );
  const backend = {
    kind: 'rtc-nat',
    get prefiltered() {
      return inner.prefiltered;
    },
    get ready() {
      return inner.ready;
    },
    start: (h) => inner.start(h),
    stop: () => {
      inner.stop();
      nat.close();
      stun.close();
    },
    cork: () => inner.cork(),
    uncork: () => inner.uncork(),
    createPeer(id, offerSdp, ev) {
      const link = inner.createPeer(id, offerSdp, ev);
      return {
        addRemoteCandidate: (c, mid) => void nat.rewriteCandidate(c).then((r) => r !== null && link.addRemoteCandidate(r, mid)),
        send: (ch, d) => link.send(ch, d),
        close: () => link.close(),
      };
    },
  };
  const stats = () => ({
    room: i,
    stunRequests: stun.requests,
    nat: { ...nat.stats },
    impair: { ...imp },
    localCandidates: inner.endpoint?.localCandidates ?? [],
  });
  return { inner, backend, stats };
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

// HOST_CPU_PROFILE=<file.cpuprofile> (diagnostics only): V8 CPU profile of the
// main thread restricted to the measurement window.
const PROFILE = process.env.HOST_CPU_PROFILE ?? null;
// HOST_ALLOC_PROFILE=<file.heapprofile> (diagnostics only): sampling allocation
// profile of the window INCLUDING garbage (objects already collected), i.e. where
// the young-generation churn that drives the GC count comes from.
const ALLOC_PROFILE = process.env.HOST_ALLOC_PROFILE ?? null;
let profSession = null;
function profileStart() {
  if (!PROFILE && !ALLOC_PROFILE) return;
  profSession = new Session();
  profSession.connect();
  if (PROFILE) profSession.post('Profiler.enable', () => profSession.post('Profiler.start'));
  if (ALLOC_PROFILE) {
    profSession.post('HeapProfiler.enable', () =>
      profSession.post('HeapProfiler.startSampling', {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      }),
    );
  }
}
function profileStop() {
  // HOST_HEAP_SNAPSHOT=<file.heapsnapshot> (diagnostics only): heap at the end of the window
  if (process.env.HOST_HEAP_SNAPSHOT) require('node:v8').writeHeapSnapshot(process.env.HOST_HEAP_SNAPSHOT);
  if (!profSession) return;
  const s = profSession;
  profSession = null;
  let pending = (PROFILE ? 1 : 0) + (ALLOC_PROFILE ? 1 : 0);
  const done = () => {
    if (--pending === 0) s.disconnect();
  };
  if (PROFILE) {
    s.post('Profiler.stop', (err, res) => {
      if (!err) writeFileSync(PROFILE, JSON.stringify(res.profile));
      done();
    });
  }
  if (ALLOC_PROFILE) {
    s.post('HeapProfiler.stopSampling', (err, res) => {
      if (!err) writeFileSync(ALLOC_PROFILE, JSON.stringify(res.profile));
      done();
    });
  }
}

/**
 * Per-thread CPU ticks (Linux /proc/self/task/<tid>/stat, utime+stime, 1/100 s):
 * tells the JS main thread apart from libuv/V8 workers and the native WebRTC
 * threads (libdatachannel / usrsctp / juice). Read only at window start/end.
 */
function threadTicks() {
  const out = new Map();
  try {
    for (const tid of readdirSync('/proc/self/task')) {
      try {
        const st = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8');
        const name = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
        const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
        // context switches = wake-ups of this thread (voluntary: it blocked and was woken)
        let vcs = 0;
        let nvcs = 0;
        try {
          const status = readFileSync(`/proc/self/task/${tid}/status`, 'utf8');
          vcs = Number(/voluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1] ?? 0);
          nvcs = Number(/nonvoluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1] ?? 0);
        } catch {}
        out.set(tid, { name, ticks: Number(f[11]) + Number(f[12]), utime: Number(f[11]), stime: Number(f[12]), vcs, nvcs });
      } catch {}
    }
  } catch {}
  return out;
}

function countFds() {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

/**
 * Wake-ups per second over the window: voluntary context switches of every
 * thread (a thread that blocked in poll/epoll/futex/nanosleep and was woken),
 * plus involuntary ones, total and for the JS main thread.
 */
function wakeups(before, after, wallMs) {
  if (after.size === 0) return null; // no /proc (not Linux)
  let vcs = 0;
  let nvcs = 0;
  let mainVcs = 0;
  for (const [tid, t] of after) {
    const b = before.get(tid);
    const dv = t.vcs - (b?.vcs ?? 0);
    vcs += dv;
    nvcs += t.nvcs - (b?.nvcs ?? 0);
    if (tid === String(process.pid)) mainVcs = dv;
  }
  const perS = (x) => +((x / wallMs) * 1000).toFixed(2);
  return { voluntaryPerS: perS(vcs), involuntaryPerS: perS(nvcs), mainVoluntaryPerS: perS(mainVcs) };
}

/** CPU % of the JS main thread vs every other thread (libuv/V8 workers + native WebRTC threads). */
function cpuSplit(before, after, wallMs) {
  if (after.size === 0) return null;
  let main = 0;
  let other = 0;
  for (const [tid, t] of after) {
    const d = t.ticks - (before.get(tid)?.ticks ?? 0);
    if (tid === String(process.pid)) main += d;
    else other += d;
  }
  // ticks are 1/100 s (CLK_TCK); a thread that exited during the window is lost (rare)
  return { mainPct: +(((main * 10) / wallMs) * 100).toFixed(3), otherPct: +(((other * 10) / wallMs) * 100).toFixed(3) };
}

function threadBreakdown(before, after, wallMs) {
  if (after.size === 0) return null;
  const byName = {};
  for (const [tid, t] of after) {
    const d = t.ticks - (before.get(tid)?.ticks ?? 0);
    const key = tid === String(process.pid) ? 'main (JS)' : t.name.replace(/[0-9]+$/, '#');
    byName[key] = (byName[key] ?? 0) + d;
  }
  const pct = {};
  for (const [k, v] of Object.entries(byName)) if (v > 0) pct[k] = +((v * 10 / wallMs) * 100).toFixed(2);
  return pct;
}

/**
 * Event-loop lag monitor. Node: perf_hooks.monitorEventLoopDelay (10 ms
 * resolution; its values are the interval between the monitor's timer
 * callbacks, lag = value − 10 ms). Bun's monitorEventLoopDelay has different
 * semantics, so under Bun a 10 ms setInterval of our own measures the same
 * thing (lag = interval − 10 ms), into a bounded 0.01 ms-bin histogram.
 */
function eldMonitor() {
  if (!IS_BUN) {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const lag = (ns) => Math.max(0, ns / 1e6 - 10);
    return {
      stop() {
        h.disable();
        return { method: 'monitorEventLoopDelay', p50: lag(h.percentile(50)), p90: lag(h.percentile(90)), p99: lag(h.percentile(99)), max: lag(h.max), mean: lag(h.mean), samples: h.count };
      },
    };
  }
  const BIN = 0.01;
  const bins = new Uint32Array(200_000); // up to 2 s, overflow in the last bin
  let n = 0;
  let sum = 0;
  let max = 0;
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - last - 10);
    last = now;
    bins[Math.min(bins.length - 1, Math.floor(lag / BIN))]++;
    n++;
    sum += lag;
    if (lag > max) max = lag;
  }, 10);
  const pct = (q) => {
    let target = Math.ceil(n * q);
    for (let i = 0; i < bins.length; i++) if ((target -= bins[i]) <= 0) return i * BIN;
    return max;
  };
  return {
    stop() {
      clearInterval(t);
      return { method: 'setInterval-10ms', p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max, mean: n ? sum / n : NaN, samples: n };
    },
  };
}

/** `bun:jsc` heap figures (Bun only; JSC has no V8-style heap spaces nor GC events). */
function jscHeap() {
  if (!JSC) return null;
  const h = JSC.heapStats();
  const m = JSC.memoryUsage?.();
  return { heapSize: h.heapSize, heapCapacity: h.heapCapacity, extraMemorySize: h.extraMemorySize, objectCount: h.objectCount, mallocCurrent: m?.current ?? null };
}

/**
 * Sizes of the Map/Set fields (and arrays) of each room's host, transport,
 * backend and endpoint (only what the build exposes; the bundle keeps property
 * names), summed over rooms; a shared endpoint is counted once. For the soak
 * scenario: a size that grows with churn is a leak.
 */
function mapSizes() {
  const out = {};
  const seen = new Set();
  for (const r of rooms) {
    const objs = r.internals?.();
    if (!objs) continue;
    for (const [name, o] of Object.entries(objs)) {
      if (!o || typeof o !== 'object' || seen.has(o)) continue;
      seen.add(o);
      for (const k of Object.keys(o)) {
        let v;
        try {
          v = o[k];
        } catch {
          continue;
        }
        const size = v instanceof Map || v instanceof Set ? v.size : Array.isArray(v) ? v.length : null;
        if (size !== null) out[`${name}.${k}`] = (out[`${name}.${k}`] ?? 0) + size;
      }
    }
  }
  return out;
}

function startMeasure({ eld = true, sampleMs = 1000, stream = false } = {}) {
  const h = eld ? eldMonitor() : null;
  // GC events: Node only (Bun's PerformanceObserver accepts 'gc' but never reports any)
  const gc = IS_BUN ? null : { count: 0, ms: 0 };
  let obs = null;
  if (gc) {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        gc.count++;
        gc.ms += e.duration;
      }
    });
    obs.observe({ entryTypes: ['gc'] });
  }
  const m = {
    h,
    obs,
    gc,
    t0: performance.now(),
    cpu0: process.cpuUsage(),
    threads0: threadTicks(),
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
    const s = { t: t - m.t0, cpuPct: (d / 1000 / (t - m.last.t)) * 100, rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external };
    m.samples.push(s);
    m.last = { t, cpu };
    if (stream) {
      // soak: the long-run series goes to the orchestrator as it is taken (saved progressively)
      send({
        type: 'sample',
        ...s,
        arrayBuffers: mem.arrayBuffers,
        fds: countFds(),
        players: rooms.map((r) => r.players().length),
        maps: mapSizes(),
        rtc: rtcTotals(true),
        jsc: jscHeap(),
        gcCount: gc?.count ?? null,
      });
    }
  }, sampleMs);
  meas = m;
}

function stopMeasure() {
  const m = meas;
  meas = null;
  clearInterval(m.timer);
  const t1 = performance.now();
  const cpu = process.cpuUsage(m.cpu0);
  const threads1 = threadTicks();
  const mem = process.memoryUsage();
  m.obs?.disconnect();
  const wallMs = t1 - m.t0;
  const rss = m.samples.map((s) => s.rss).concat(mem.rss);
  const heap = m.samples.map((s) => s.heapUsed).concat(mem.heapUsed);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  return {
    runtime: IS_BUN ? `bun ${globalThis.Bun.version}` : `node ${process.version}`,
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
    gcCount: m.gc?.count ?? null,
    gcMs: m.gc?.ms ?? null,
    eld: m.h?.stop() ?? null,
    jsc: jscHeap(),
    threadsPct: threadBreakdown(m.threads0, threads1, wallMs),
    cpuSplit: cpuSplit(m.threads0, threads1, wallMs),
    wakeups: wakeups(m.threads0, threads1, wallMs),
    threadCount: threads1.size || null,
    fdCount: countFds(),
    cpuPctSeries: m.samples.map((s) => +s.cpuPct.toFixed(3)),
  };
}

// ------------------------------------------------------------- main

/** Summed haxlite-rtc endpoint counters of every room (null when no room uses peerBackend 'rtc'); a shared endpoint is counted once. */
function rtcTotals(withSessions = false) {
  let out = null;
  const seen = new Set();
  for (const r of rooms) {
    const st = r.rtcStats?.();
    if (!st) continue;
    // rooms sharing one endpoint return the same counters: count them once
    const ep = r.internals?.().endpoint ?? st;
    if (seen.has(ep)) continue;
    seen.add(ep);
    out ??= { packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0, ...(withSessions ? { sessions: 0, open: 0 } : null) };
    out.packetsIn += st.packetsIn;
    out.packetsOut += st.packetsOut;
    out.bytesIn += st.bytesIn ?? 0;
    out.bytesOut += st.bytesOut;
    if (withSessions) {
      out.sessions += st.sessions ?? 0;
      out.open += st.open ?? 0;
    }
  }
  return out;
}

const factories = { haxlite: haxliteFactory, official: officialFactory, nodehaxball: nodeHaxballFactory };
const factory = factories[impl.split(':')[0]];
if (!factory) throw new Error(`unknown impl ${impl}`);
const T_IMPORT0 = performance.now();
const create = await factory();
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

/** soak: every player gets a team on arrival (alternating), the game keeps running with score/time limit 0. */
let autoTeams = null;
function startAutoTeams() {
  if (autoTeams) return;
  const assigned = rooms.map(() => new Set());
  const tick = () => {
    rooms.forEach((r, k) => {
      const ids = r.players();
      const live = new Set(ids);
      for (const id of assigned[k]) if (!live.has(id)) assigned[k].delete(id);
      for (const id of ids) {
        if (assigned[k].has(id)) continue;
        r.setTeam(id, assigned[k].size % 2 === 0 ? 1 : 2);
        assigned[k].add(id);
      }
    });
  };
  for (const r of rooms) r.startGame();
  tick();
  autoTeams = setInterval(tick, 500);
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
      case 'auto-teams':
        startAutoTeams();
        send({ type: 'auto-teams' });
        break;
      case 'impair-stats':
        send({ type: 'impair-stats', rooms: rooms.map((r) => r.impairStats?.() ?? null), rtc: rtcTotals(true) });
        break;
      case 'measure-start':
        profileStart();
        startMeasure(msg);
        meas.rtc0 = rtcTotals();
        send({ type: 'measuring' });
        break;
      case 'measure-stop': {
        const rtc0 = meas?.rtc0 ?? null;
        const stats = stopMeasure();
        const rtc1 = rtcTotals();
        if (rtc0 !== null && rtc1 !== null) {
          const perS = (k) => +(((rtc1[k] - rtc0[k]) / stats.wallMs) * 1000).toFixed(1);
          stats.rtc = { packetsInPerS: perS('packetsIn'), packetsOutPerS: perS('packetsOut'), bytesInPerS: perS('bytesIn'), bytesOutPerS: perS('bytesOut') };
        }
        stats.maps = mapSizes();
        send({ type: 'stats', stats, players: rooms.map((r) => r.players().length) });
        profileStop();
        break;
      }
      case 'exit':
        process.exit(0);
    }
  } catch (e) {
    send({ type: 'error', message: String(e?.stack ?? e) });
  }
});
