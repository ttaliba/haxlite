/**
 * Allocation micro-benchmark of the host's data path above DTLS:
 * SctpAssociation + the rtc backend's RtcPeerLink / per-scope bundling, with
 * HaxBall-like traffic and no network (in-process "browsers").
 *
 *   flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings \
 *     --import ./bench/ts-resolve.mjs bench/rtc/sctp-host-alloc.ts [--peers 20] [--seconds 120] [--no-bundle]
 *     [--const-clock] [--depth 3] [--show-other] [--warmup-frames 20000]
 *
 * `--const-clock` gives the host associations an injected constant clock (and
 * so per-association timers): it isolates what the clock reads cost, since
 * every performance.now() call allocates a HeapNumber in Node.
 *
 * Traffic (official cadence, 60 Hz frames, simulated time): every client
 * sends an input on `ro` (13 B) with probability 8/60 per frame and a ping on
 * `uu` once per second; the host relays each input to every peer on `ru`
 * (event, 20 B) and answers pings on `uu` (pong, 17 B) from the message
 * callback, and sends a heartbeat on `uu` (9 B) to everyone every 7 frames.
 * Like HostRoom, each message callback and each frame runs inside the
 * backend's bundling scope (`--no-bundle`: every send in its own scope, i.e.
 * flushed at once as before the bundling pass).
 *
 * Host side = SctpAssociation with the options the session uses
 * (`transientDelivery`, default clock/timers → shared timer heap, CRC32c
 * since browsers do not negotiate zero checksum) behind RtcPeerBackend's
 * RtcPeerLink. Packets travel through a preallocated pool and are fed with
 * `input(buf, 0, len)` (no view), so the harness itself allocates nothing.
 *
 * Measured with V8's sampling heap profiler INCLUDING objects already
 * collected (= young-generation churn), split by the module of the
 * allocating frame: the simulated browsers run a separate copy of the
 * association module (`association.ts?client`), so allocations in src/
 * (association, timers, clock, rtc backend) are the host's. Reports host
 * bytes per host message / packet and the top allocation sites.
 */
import { Session } from 'node:inspector';
import { SctpAssociation } from '../../src/rtc/sctp/index.js';
// The simulated browsers use a SEPARATE instance of the association module
// (distinct URL), so allocation sites in it are told apart from the host's.
const { SctpAssociation: ClientAssociation } = (await import('../../src/rtc/sctp/association.ts?client' as string)) as typeof import('../../src/rtc/sctp/association.js');
import { RtcPeerBackend } from '../../src/net/rtc-backend.js';
import type { PeerLink, PeerLinkEvents } from '../../src/net/peer-backend.js';

const argv = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const PEERS = Number(flag('peers', '20'));
const SECONDS = Number(flag('seconds', '120'));
const BUNDLE = !argv.includes('--no-bundle');
const CHANNELS = [
  { id: 0, ordered: true },
  { id: 1, ordered: false },
  { id: 2, ordered: false, maxRetransmits: 0 },
];

// ------------------------------------------------------------------ packet pool (no allocation)
const POOL = 8192;
const pool = Array.from({ length: POOL }, () => new Uint8Array(1500));
let poolNext = 0;
const qTo = new Int32Array(POOL); // destination index: >= 0 host side of peer i, < 0 client side of peer ~i
const qSlot = new Int32Array(POOL);
const qLen = new Int32Array(POOL);
let qHead = 0;
let qTail = 0;
function enqueue(to: number, pkt: Uint8Array): void {
  const k = poolNext++ & (POOL - 1);
  pool[k]!.set(pkt);
  const i = qTail++ & (POOL - 1);
  qTo[i] = to;
  qSlot[i] = k;
  qLen[i] = pkt.length;
  if (qTail - qHead > POOL) throw new Error('queue overflow');
}

// ------------------------------------------------------------------ fake endpoint → RtcPeerLink
interface Peer {
  host: SctpAssociation;
  client: InstanceType<typeof ClientAssociation>;
  session: FakeSession;
  link: PeerLink | null;
}
class FakeSession {
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  onMessage?: (ch: number, data: Uint8Array) => void;
  onChannelClose?: (ch: number) => void;
  readonly answerSdp = 'v=0\r\n';
  readonly localCandidates: string[] = [];
  readonly mid = '0';
  readonly remoteAddress = { address: '127.0.0.1', port: 9 };
  state = 'open';
  sctp: SctpAssociation | null = null;
  addRemoteCandidate(): void {}
  send(ch: number, d: Uint8Array): boolean {
    return this.sctp!.send(ch, d);
  }
  cork(): void {
    this.sctp!.cork();
  }
  uncork(): void {
    this.sctp!.uncork();
  }
  close(): void {
    this.sctp!.close();
  }
}

const peers: Peer[] = [];
let pending: FakeSession | null = null;
const fakeEndpoint = { createSession: () => pending! };
const backend = new RtcPeerBackend({ endpoint: fakeEndpoint as never });

const EVENT = new Uint8Array(20).fill(2);
const HEARTBEAT = new Uint8Array(9).fill(3);
const PONG = new Uint8Array(17).fill(4);
const INPUT = new Uint8Array(13).fill(1);
const PING = new Uint8Array(12).fill(5);
let hostMsgs = 0;
let clientRecv = 0;

/** One send; without bundling it is flushed at once (a one-send scope), as before the bundling pass. */
function hostSend(k: number, ch: number, msg: Uint8Array): void {
  if (BUNDLE) {
    peers[k]!.link!.send(ch, msg);
    return;
  }
  backend.cork!();
  peers[k]!.link!.send(ch, msg);
  backend.uncork!();
}

function hostOnMessage(i: number, ch: number, data: Uint8Array): void {
  if (BUNDLE) backend.cork!();
  try {
    if (ch === 0 && data[0] === 1) {
      for (let k = 0; k < peers.length; k++) hostSend(k, 1, EVENT);
      hostMsgs += peers.length;
    } else if (ch === 2) {
      hostSend(i, 2, PONG);
      hostMsgs++;
    }
  } finally {
    if (BUNDLE) backend.uncork!();
  }
}

for (let i = 0; i < PEERS; i++) {
  const session = new FakeSession();
  const host = new SctpAssociation({
    send: (pkt) => enqueue(~i, pkt),
    channels: CHANNELS,
    maxMessageSize: 262144,
    onMessage: (ch, d) => session.onMessage?.(ch, d),
    onOpen: () => session.onOpen?.(),
    onClose: (r) => session.onClose?.(r),
    transientDelivery: true,
    ...(argv.includes('--const-clock') ? { now: () => 1000 } : {}),
  });
  session.sctp = host;
  const client = new ClientAssociation({
    send: (pkt) => enqueue(i, pkt),
    channels: CHANNELS,
    maxMessageSize: 262144,
    onMessage: () => {
      clientRecv++;
    },
    onOpen() {},
    onClose() {},
    zeroChecksum: false, // browsers: CRC32c both ways
    transientDelivery: true,
    // own clock (and so own timers): the shared clock module's reads stay the host's
    now: () => performance.now(),
  });
  const p: Peer = { host, client, session, link: null };
  peers.push(p);
  pending = session;
  const ev: PeerLinkEvents = {
    onLocalDescription() {},
    onLocalCandidate() {},
    onGatheringComplete() {},
    onChannelOpen() {},
    onChannelClosed() {},
    onMessage: (ch, data) => hostOnMessage(i, ch, data as Uint8Array),
    onConnectionState() {},
    onAbuse() {},
    onError(e) {
      throw e;
    },
  };
  p.link = backend.createPeer(i, 'offer', ev);
}

function pump(): void {
  while (qHead !== qTail) {
    const i = qHead++ & (POOL - 1);
    const to = qTo[i]!;
    if (to >= 0) toHost(to, pool[qSlot[i]!]!, qLen[i]!);
    else toClient(~to, pool[qSlot[i]!]!, qLen[i]!);
  }
}
function toHost(i: number, buf: Uint8Array, len: number): void {
  peers[i]!.host.input(buf, 0, len);
}
function toClient(i: number, buf: Uint8Array, len: number): void {
  peers[i]!.client.input(buf, 0, len);
}

// deterministic PRNG
let seed = 12345;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};

function clientFrame(frame: number): void {
  for (let i = 0; i < peers.length; i++) {
    const c = peers[i]!.client;
    if (rnd() < 8 / 60) c.send(0, INPUT);
    if ((frame + i * 3) % 60 === 0) c.send(2, PING);
  }
}
function hostFrame(frame: number): void {
  if (frame % 7 !== 0) return;
  if (BUNDLE) backend.cork!();
  try {
    for (let k = 0; k < peers.length; k++) hostSend(k, 2, HEARTBEAT);
    hostMsgs += peers.length;
  } finally {
    if (BUNDLE) backend.uncork!();
  }
}

// ------------------------------------------------------------------ run
for (const p of peers) p.client.connect();
pump();
if (!peers.every((p) => p.host.readyState === 'established')) throw new Error('not established');

const tick = () => new Promise<void>((r) => setImmediate(r));
async function frames(n: number, from: number): Promise<void> {
  for (let f = from; f < from + n; f++) {
    clientFrame(f);
    pump();
    hostFrame(f);
    pump();
    if ((f & 63) === 0) await tick(); // let the (real-time) SCTP timers run
  }
}

const FRAMES = SECONDS * 60;
const WARM = Number(flag('warmup-frames', '20000'));
await frames(WARM, 0); // warm-up (JIT tiers up)

const session = new Session();
session.connect();
const post = <T>(m: string, p?: object) => new Promise<T>((res, rej) => session.post(m, p ?? {}, (e, v) => (e ? rej(e) : res(v as T))));
const st0 = peers.map((p) => p.host.stats());
const msgs0 = hostMsgs;
await post('HeapProfiler.enable');
await post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
const t0 = performance.now();
await frames(FRAMES, WARM);
const wall = performance.now() - t0;
const { profile } = await post<{ profile: { head: Node } }>('HeapProfiler.stopSampling');
session.disconnect();

interface Node {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: Node[];
}
const side = { host: 0, client: 0, other: 0 };
const sites = new Map<string, number>();
const otherSites = new Map<string, number>();
const DEPTH = Number(flag('depth', '3'));
const walk = (n: Node, stack: string[], who: 'other'): void => {
  const fn = n.callFrame.functionName || '(anon)';
  // side = module of the allocating frame: the client copy (?client), src/ (host), else harness
  const url = n.callFrame.url;
  const w: keyof typeof side = url.includes('?client') ? 'client' : url.includes('/src/') ? 'host' : who;
  const name = `${fn} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
  const st = [name, ...stack].slice(0, DEPTH);
  if (n.selfSize > 0) {
    side[w] += n.selfSize;
    const m = w === 'host' ? sites : w === 'other' ? otherSites : null;
    if (m !== null) {
      const k = st.join(' <- ');
      m.set(k, (m.get(k) ?? 0) + n.selfSize);
    }
  }
  for (const c of n.children) walk(c, st, 'other');
};
walk(profile.head, [], 'other');

const sum = (k: 'packetsSent' | 'packetsReceived' | 'messagesSent', a: typeof st0) => a.reduce((x, s) => x + s[k], 0);
const st1 = peers.map((p) => p.host.stats());
const sent = hostMsgs - msgs0;
const pktOut = sum('packetsSent', st1) - sum('packetsSent', st0);
const pktIn = sum('packetsReceived', st1) - sum('packetsReceived', st0);
console.log(`peers ${PEERS}  ${SECONDS} s simulated (${FRAMES} frames) in ${(wall / 1000).toFixed(1)} s  bundling ${BUNDLE ? 'on' : 'off'}`);
console.log(`host: ${sent} messages out, ${pktOut} packets out (${(sent / pktOut).toFixed(2)} msg/pkt), ${pktIn} packets in; clients received ${clientRecv}`);
console.log(
  `host allocations: ${(side.host / 1024).toFixed(1)} KiB = ${(side.host / sent).toFixed(2)} B/message, ${(side.host / pktOut).toFixed(2)} B/packet out, ${((side.host / SECONDS) / 1024).toFixed(2)} KiB per simulated second`,
);
console.log(`(simulated browsers: ${(side.client / 1024).toFixed(1)} KiB; harness/other: ${(side.other / 1024).toFixed(1)} KiB)`);
for (const [k, v] of [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(v / 1024).toFixed(1).padStart(8)} KiB  ${k}`);
if (argv.includes('--show-other')) {
  console.log('harness/other sites:');
  for (const [k, v] of [...otherSites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(v / 1024).toFixed(1).padStart(8)} KiB  ${k}`);
}
for (const p of peers) {
  p.link!.close();
  p.client.close();
}
