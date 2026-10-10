// WebRTC-only micro-benchmark of the host's native side (docs/07, «Pasada de
// ligereza — red»): N node-datachannel peers in a child process connect to
// haxlite's LocalPeerLink in this process, which relays traffic shaped like a
// running haxlite game. No master, no HostRoom: isolates libdatachannel +
// src/net send/receive cost so native settings (UDP mux, SCTP settings,
// logger) and send-path changes can be A/B tested in seconds.
//
//   node bench/net/natives.mjs [--n 20] [--seconds 20] [--warmup 3] [--mux 0|1]
//        [--sctp '{"delayedSackTime":…}'] [--logger Warning]
//        [--dist node_modules/.cache/haxlite-bench/dist] [--loss 0] [--json out.json]
//
// Traffic (per second, N clients): each client sends an input (6 B) on `ru`
// every U(60,250) ms → the host relays it to all N on `ru` (event broadcast,
// O(N²) like HostRoom); every 7 frames at 60 Hz the host sends an 8 B
// heartbeat to all N on `uu`; client 0 also sends a probe every 50 ms which
// comes back through the same relay (RTT p50/p99, lost probes).
//
// Output: host process CPU % (all threads), per-thread split, thread/fd
// count, messages relayed, client RTT. Wrap runs in
// `flock /tmp/haxlite-bench.lock …` on shared machines.
import { fork } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === 'client') await client();
else await host();

// ------------------------------------------------------------------ client process
async function client() {
  const require = createRequire(path.join(ROOT, 'package.json'));
  const { PeerConnection } = require('node-datachannel');
  const n = Number(flag('n', '20'));
  const peers = [];
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const stats = { rx: [0, 0, 0], tx: 0, rtt: [], probesSent: 0 };
  let driving = false;
  for (let i = 0; i < n; i++) {
    const pc = new PeerConnection(`c${i}`, { iceServers: [], disableAutoNegotiation: true });
    const dcs = [];
    for (let ch = 0; ch < 3; ch++) {
      const dc = pc.createDataChannel(['ro', 'ru', 'uu'][ch], {
        negotiated: true,
        id: ch,
        unordered: ch !== 0,
        ...(ch === 2 ? { maxRetransmits: 0 } : {}),
      });
      dc.onMessage((m) => {
        stats.rx[ch]++;
        if (i === 0 && ch === 1 && m.length >= 9 && m[0] === 0xee) stats.rtt.push(performance.now() - m.readDoubleLE(1));
      });
      dcs.push(dc);
    }
    const gathered = new Promise((r) => pc.onGatheringStateChange((s) => s === 'complete' && r()));
    pc.setLocalDescription('offer');
    await gathered;
    peers.push({ pc, dcs });
    process.send({ type: 'offer', i, sdp: pc.localDescription().sdp });
  }
  const input = Buffer.from([1, 2, 3, 4, 5, 6]);
  const probe = Buffer.alloc(9);
  probe[0] = 0xee;
  const drive = (i) => {
    if (!driving) return;
    try {
      peers[i].dcs[1].sendMessageBinary(input);
      stats.tx++;
    } catch {}
    setTimeout(() => drive(i), 60 + rand() * 190);
  };
  process.on('message', (m) => {
    if (m.type === 'answer') peers[m.i].pc.setRemoteDescription(m.sdp, 'answer');
    else if (m.type === 'drive') {
      driving = true;
      for (let i = 0; i < n; i++) drive(i);
      const tick = () => {
        if (!driving) return;
        probe.writeDoubleLE(performance.now(), 1);
        try {
          peers[0].dcs[1].sendMessageBinary(probe);
          stats.probesSent++;
        } catch {}
        setTimeout(tick, 50);
      };
      tick();
      stats.rx = [0, 0, 0];
      stats.rtt = [];
      stats.probesSent = 0;
      stats.tx = 0;
    } else if (m.type === 'reset') {
      stats.rx = [0, 0, 0];
      stats.rtt = [];
      stats.probesSent = 0;
      stats.tx = 0;
    } else if (m.type === 'stop') {
      driving = false;
      setTimeout(() => {
        const s = stats.rtt.sort((a, b) => a - b);
        const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
        process.send({ type: 'report', rx: stats.rx, tx: stats.tx, probes: stats.probesSent, probesBack: s.length, rttP50: q(0.5), rttP99: q(0.99) });
      }, 300);
    }
  });
  process.send({ type: 'offers-done' });
}

// ------------------------------------------------------------------ host process
function threadTicks() {
  const out = new Map();
  for (const tid of readdirSync('/proc/self/task')) {
    try {
      const st = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8');
      const name = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      out.set(tid, { name, ticks: Number(f[11]) + Number(f[12]) });
    } catch {}
  }
  return out;
}

async function host() {
  const n = Number(flag('n', '20'));
  const seconds = Number(flag('seconds', '20'));
  const warmup = Number(flag('warmup', '3'));
  const dist = path.resolve(ROOT, flag('dist', 'node_modules/.cache/haxlite-bench/dist'));
  const require = createRequire(path.join(dist, 'x.js'));
  const ndc = require('node-datachannel');
  const logger = flag('logger', '');
  if (logger) ndc.initLogger(logger);
  const sctp = flag('sctp', '');
  if (sctp) ndc.setSctpSettings(JSON.parse(sctp));
  const { LocalPeerLink } = await import(pathToFileURL(path.join(dist, 'net/peer-backend.js')).href);
  const { shutdownWebRtc } = await import(pathToFileURL(path.join(dist, 'net/webrtc.js')).href);
  const rtc = { iceServers: [], disableAutoNegotiation: true, ...(flag('mux', '0') === '1' ? { enableIceUdpMux: true } : null), ...JSON.parse(flag('rtc', '{}')) };
  const loss = Number(flag('loss', '0'));

  const links = [];
  const open = [];
  let relayed = 0;
  const child = fork(fileURLToPath(import.meta.url), ['client', '--n', String(n)], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const allOpen = new Promise((resolve) => {
    let opened = 0;
    child.on('message', (m) => {
      if (m.type !== 'offer') return;
      const i = m.i;
      let link = null;
      const ev = {
        onLocalDescription() {},
        onLocalCandidate() {},
        onGatheringComplete() {
          child.send({ type: 'answer', i, sdp: link.native.localDescription().sdp });
        },
        onChannelOpen(ch) {
          open[i][ch] = true;
          if (open[i].every(Boolean) && ++opened === n) resolve();
        },
        onChannelClosed() {},
        onMessage(ch, data) {
          if (ch !== 1) return;
          if (loss > 0 && Math.random() < loss) return;
          for (let k = 0; k < links.length; k++) links[k].send(1, data);
          relayed += links.length;
        },
        onConnectionState() {},
        onAbuse() {},
        onError(e) {
          console.error('host link error', e);
        },
      };
      open[i] = [false, false, false];
      link = new LocalPeerLink(`h${i}`, rtc, m.sdp, ev);
      links[i] = link;
    });
  });
  const t0 = performance.now();
  await allOpen;
  const connectMs = performance.now() - t0;
  // heartbeats: setTimeout chain at 60 Hz, one 8 B message to all every 7 frames
  const hb = Buffer.alloc(8, 7);
  let frame = 0;
  let running = true;
  let next = performance.now();
  const tick = () => {
    if (!running) return;
    frame++;
    if (frame % 7 === 0) for (let k = 0; k < links.length; k++) links[k].send(2, hb);
    next += 1000 / 60;
    setTimeout(tick, Math.max(0, next - performance.now()));
  };
  tick();
  child.send({ type: 'drive' });
  await sleep(warmup * 1000);
  child.send({ type: 'reset' });
  relayed = 0;
  const th0 = threadTicks();
  const cpu0 = process.cpuUsage();
  const w0 = performance.now();
  await sleep(seconds * 1000);
  const cpu = process.cpuUsage(cpu0);
  const wall = performance.now() - w0;
  const th1 = threadTicks();
  const fds = readdirSync('/proc/self/fd').length;
  const relayedInWindow = relayed;
  running = false;
  child.send({ type: 'stop' });
  const report = await new Promise((r) => child.on('message', (m) => m.type === 'report' && r(m)));
  const byName = {};
  for (const [tid, t] of th1) {
    const d = t.ticks - (th0.get(tid)?.ticks ?? 0);
    const key = tid === String(process.pid) ? 'main' : t.name.replace(/[0-9]+$/, '#');
    byName[key] = (byName[key] ?? 0) + d;
  }
  const threadsPct = {};
  for (const [k, v] of Object.entries(byName)) if (v > 0) threadsPct[k] = +((v * 10 * 100) / wall).toFixed(2);
  const out = {
    n,
    seconds,
    mux: rtc.enableIceUdpMux === true,
    sctp: sctp || null,
    logger: logger || null,
    dist: path.relative(ROOT, dist),
    connectMs: Math.round(connectMs),
    cpuPct: +(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(2),
    userPct: +((cpu.user / 1000 / wall) * 100).toFixed(2),
    sysPct: +((cpu.system / 1000 / wall) * 100).toFixed(2),
    threadsPct,
    threads: th1.size,
    fds,
    relayedPerSec: Math.round(relayedInWindow / (wall / 1000)),
    client: report,
  };
  console.log(JSON.stringify(out));
  const json = flag('json', '');
  if (json) writeFileSync(json, JSON.stringify(out, null, 1));
  for (const l of links) l.close();
  child.kill();
  await shutdownWebRtc(3000);
  process.exit(0);
}
