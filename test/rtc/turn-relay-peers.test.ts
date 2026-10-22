/**
 * TURN peer budget: an offer decides which remote addresses our relay pairs
 * (and so the allocation's permissions and peer addresses) point at. Some
 * servers (Cloudflare) relay for only ~10 distinct peer addresses per
 * allocation over its whole life, so one session must not be able to use
 * them up, and a burst of crafted offers must not multiply allocations.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { UdpIo } from '../../src/rtc/udp.js';
import { RtcEndpoint, type RtcSession } from '../../src/rtc/index.js';
import { formatFingerprint, parseCandidate } from '../../src/rtc/sdp.js';
import { IceAgent, IceScheduler, MAX_RELAY_PEERS, type RelayIo } from '../../src/rtc/ice-agent.js';
import { ecClientCert } from './dtls-helpers.js';
import { TurnServer } from './turn-server.js';

const CLIENT_PWD = 'clientpasswordclientpwd0';
const cert = ecClientCert('ice');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ufragSeq = 0;

function offerSdp(candidates: string[]): string {
  const ufrag = 'pb' + String(ufragSeq++).padStart(4, '0');
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${CLIENT_PWD}`,
    `a=fingerprint:sha-256 ${formatFingerprint(cert.sha256)}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    ...candidates.map((c) => `a=${c}`),
    '',
  ].join('\r\n');
}

const cand = (address: string, port: number, type = 'host', prio = 2122260223) => `candidate:1 1 udp ${prio} ${address} ${port} typ ${type} generation 0`;

/** `n` public candidates on distinct addresses (session `k`). */
function manyCandidates(k: number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(cand(`9.${1 + (k % 200)}.${i + 1}.1`, 20000 + i, 'host', 2122260223 - i));
  return out;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(policy: 'all' | 'relay') {
  const srv = await TurnServer.start({ maxPeerAddresses: 10 });
  cleanups.push(() => srv.close());
  const ep = await RtcEndpoint.listen({ address: '127.0.0.1', candidatePolicy: 'all', iceTransportPolicy: policy, iceServers: [srv.urlWithCredentials()] });
  cleanups.push(() => ep.close());
  await ep.whenGathered();
  return { srv, ep };
}

function peersPerAllocation(ep: RtcEndpoint): number[] {
  return ((ep as unknown as { pool: { peerAddresses: number }[] }).pool ?? []).map((r) => r.peerAddresses);
}

describe('relay peers per session', () => {
  for (const policy of ['relay', 'all'] as const) {
    it(`iceTransportPolicy '${policy}': an offer with 24 public candidates uses at most ${MAX_RELAY_PEERS} peer addresses of the allocation`, async () => {
      const { ep } = await setup(policy);
      const s = ep.createSession(offerSdp(manyCandidates(0, 24)), { remoteIp: '9.200.250.1' });
      cleanups.push(() => s.close());
      await sleep(600);
      const peers = peersPerAllocation(ep);
      expect(Math.max(...peers)).toBeLessThanOrEqual(MAX_RELAY_PEERS);
      // the hint IP and the candidates' IPs
      expect(ep.turn!.permissions).toBeLessThanOrEqual(MAX_RELAY_PEERS + 1);
      expect(ep.turn!.pool).toBe(1);
    });
  }

  it('16 crafted offers at once: permissions and allocations stay bounded', async () => {
    const { ep, srv } = await setup('relay');
    const sessions: RtcSession[] = [];
    for (let k = 0; k < 16; k++) {
      sessions.push(ep.createSession(offerSdp(manyCandidates(k, 24)), { remoteIp: `9.${1 + k}.250.1` }));
      await sleep(40);
    }
    cleanups.push(() => sessions.forEach((s) => s.close()));
    await sleep(600);
    const total = peersPerAllocation(ep).reduce((a, b) => a + b, 0);
    if (process.env.TURN_VERBOSE === '1') console.log('peers', peersPerAllocation(ep), 'turn', JSON.stringify(ep.turn));
    expect(total).toBeLessThanOrEqual(16 * MAX_RELAY_PEERS);
    expect(ep.turn!.permissions).toBeLessThanOrEqual(16 * (MAX_RELAY_PEERS + 1));
    expect(srv.allocations.size).toBe(ep.turn!.pool);
    // no allocation is pushed past the server's peer limit (10 here)
    expect(Math.max(...peersPerAllocation(ep))).toBeLessThanOrEqual(10);
    expect(ep.turn!.pool).toBeLessThanOrEqual(16);
  });
});

describe('IceAgent relay pairs (fake relay)', () => {
  function harness() {
    let t = 1_000_000;
    const sock = { tag: 'sock' } as unknown as UdpIo;
    const permits: string[] = [];
    const relay = {
      family: 4,
      ready: true,
      permit: (a: string) => permits.push(a),
      send: () => true,
    };
    const io = relay as unknown as RelayIo;
    const sched = new IceScheduler({
      send: () => {},
      now: () => t,
      sockets: [{ sock, family: 4, bindAddress: '0.0.0.0' }],
      policy: 'public',
      relays: [io],
    });
    const agent = new IceAgent(
      sched,
      { localUfrag: 'ours', remoteUfrag: 'cLnT', remoteKey: Buffer.from(CLIENT_PWD), onCheckSucceeded() {}, onConsent() {} },
      [io],
    );
    return { sock, relay, io, permits, sched, agent, advance: (ms: number) => (t += ms) };
  }

  it('signaled candidates past the cap get a direct pair only; distinct ports of one address count separately', () => {
    const h = harness();
    try {
      for (let i = 0; i < 8; i++) h.agent.addRemote(parseCandidate(cand('198.51.100.7', 5000 + i))!);
      const pairs = h.agent.describe();
      expect(pairs.filter((p) => p.relay).length).toBe(MAX_RELAY_PEERS);
      expect(pairs.filter((p) => !p.relay).length).toBe(8);
      // the same address again (e.g. re-trickled) is not a new peer
      h.agent.addRemote(parseCandidate(cand('198.51.100.7', 5000))!);
      expect(h.agent.describe().filter((p) => p.relay).length).toBe(MAX_RELAY_PEERS);
    } finally {
      h.agent.close();
      h.sched.close();
    }
  });

  it('the hint IP keeps its permission, and a request through the relay still learns a relay pair past the cap', () => {
    const h = harness();
    try {
      for (let i = 0; i < 10; i++) h.agent.addRemote(parseCandidate(cand(`198.51.100.${i + 1}`, 5000))!);
      h.agent.hintRemoteIp('203.0.113.9');
      expect(h.permits).toContain('203.0.113.9');
      h.agent.onRequest(h.io, '203.0.113.9', 6000, 1845501695);
      const learned = h.agent.describe().filter((p) => p.relay && p.address === '203.0.113.9');
      expect(learned.length).toBe(1);
    } finally {
      h.agent.close();
      h.sched.close();
    }
  });

  it('candidates known before the allocation is ready: their relay pairs come with relaysReady, within the same cap', () => {
    const h = harness();
    try {
      h.relay.ready = false;
      const remotes = [1, 2, 3].map((i) => parseCandidate(cand(`198.51.100.${i}`, 5000))!);
      for (const c of remotes) h.agent.addRemote(c);
      expect(h.agent.describe().filter((p) => p.relay).length).toBe(0);
      h.relay.ready = true;
      h.agent.relaysReady(remotes);
      h.agent.relaysReady(remotes); // again (another gathering round): nothing new
      expect(h.agent.describe().filter((p) => p.relay).length).toBe(3);
      for (let i = 4; i <= 8; i++) h.agent.addRemote(parseCandidate(cand(`198.51.100.${i}`, 5000))!);
      expect(h.agent.describe().filter((p) => p.relay).length).toBe(MAX_RELAY_PEERS);
    } finally {
      h.agent.close();
      h.sched.close();
    }
  });
});
