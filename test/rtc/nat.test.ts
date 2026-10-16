/**
 * haxlite-rtc full ICE behind a (simulated) NAT, against libdatachannel
 * (node-datachannel / libjuice: the WebRTC stack of node-haxball and of the
 * `ndc` backend) as the joining client.
 *
 * The host's endpoint binds 127.0.0.1 only and announces no host candidate
 * (policy 'public' drops loopback): its only way out is the {@link UdpNat}
 * (port-restricted filtering unless stated), whose external sockets live on
 * the machine's non-loopback address (the "public" side). Its srflx
 * candidate comes from a {@link FakeStunServer} on that public side reached
 * through the NAT. The client's candidates reach the host rewritten to their
 * NAT aliases (= routed through the NAT, see nat-sim.ts).
 */
import os from 'node:os';
import type { DataChannel, PeerConnection } from 'node-datachannel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { RtcEndpoint, type RtcSession } from '../../src/rtc/index.js';
import { createDataChannel, createPeerConnection, closeNative, shutdownWebRtc } from '../../src/net/webrtc.js';
import { FakeStunServer, UdpNat, type NatOptions } from './nat-sim.js';

const PUBLIC = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  pc: PeerConnection;
  dcs: DataChannel[];
  open: Promise<void>;
  received: Promise<string>;
  ownCandidates: string[];
  offer: string;
}

/** libdatachannel offerer with HaxBall's three negotiated channels; resolves once gathering is done (≤ 2 s). */
async function makeClient(cfg: { iceServers?: string[]; bindAddress?: string }): Promise<Client> {
  const ownCandidates: string[] = [];
  let gathered!: () => void;
  const gatheredP = new Promise<void>((r) => {
    gathered = r;
    setTimeout(r, 2000);
  });
  const pc = createPeerConnection(
    'nat-client',
    { iceServers: cfg.iceServers ?? [], disableAutoNegotiation: true, ...(cfg.bindAddress ? { bindAddress: cfg.bindAddress } : null) },
    {
      onLocalCandidate: (c) => ownCandidates.push(c.startsWith('a=') ? c.slice(2) : c),
      onGatheringStateChange: (s) => s === 'complete' && gathered(),
    },
  );
  let opened = 0;
  let openRes!: () => void;
  const open = new Promise<void>((r) => (openRes = r));
  let recvRes!: (s: string) => void;
  const received = new Promise<string>((r) => (recvRes = r));
  const dcs: DataChannel[] = [];
  const specs = [
    { label: 'ro', unordered: false },
    { label: 'ru', unordered: true },
    { label: 'uu', unordered: true, maxRetransmits: 0 },
  ];
  specs.forEach((sp, i) => {
    dcs.push(
      createDataChannel(pc, sp.label, { negotiated: true, id: i, unordered: sp.unordered, ...(sp.maxRetransmits === 0 ? { maxRetransmits: 0 } : null) }, {
        onOpen: () => {
          if (++opened === 3) openRes();
        },
        onMessage: (m) => i === 0 && recvRes(typeof m === 'string' ? m : Buffer.from(m as Buffer).toString()),
      }),
    );
  });
  pc.setLocalDescription('offer');
  await gatheredP;
  const offer = pc.localDescription()!.sdp
    .split('\r\n')
    .filter((l) => !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates')
    .join('\r\n');
  return { pc, dcs, open, received, ownCandidates, offer };
}

interface Scenario {
  /** Host-side NAT. */
  hostNat: NatOptions;
  /** Client behind its own NAT too (port-restricted, endpoint-independent mapping). */
  clientNat?: NatOptions;
  /** Forward the client's candidates to the host (false: the host cannot send checks anywhere). */
  forwardCandidates?: boolean;
  timeoutMs?: number;
}

interface Result {
  connected: boolean;
  session: RtcSession;
  ep: RtcEndpoint;
  hostNat: UdpNat;
  answer: string;
  echo: string | null;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(async () => {
  await shutdownWebRtc();
});

async function run(sc: Scenario): Promise<Result> {
  const stun = await FakeStunServer.start(PUBLIC!);
  cleanups.push(() => stun.close());
  const hostNat = new UdpNat({ insideAddress: '127.0.0.1', outsideAddress: PUBLIC!, ...sc.hostNat });
  cleanups.push(() => hostNat.close());
  const stunAlias = await hostNat.alias({ address: stun.address, port: stun.port });
  const ep = await RtcEndpoint.listen({ address: '127.0.0.1', iceServers: [`stun:${stunAlias.address}:${stunAlias.port}`] });
  cleanups.push(() => ep.close());
  await ep.whenGathered();

  // client side: direct, or behind its own NAT (inside 127.0.0.1, outside = public address)
  let clientNat: UdpNat | null = null;
  let clientIce: string[] = [];
  if (sc.clientNat !== undefined) {
    clientNat = new UdpNat({ insideAddress: '127.0.0.1', outsideAddress: PUBLIC!, ...sc.clientNat });
    cleanups.push(() => clientNat!.close());
    const a = await clientNat.alias({ address: stun.address, port: stun.port });
    clientIce = [`stun:${a.address}:${a.port}`];
  }
  const client = await makeClient({ iceServers: clientIce, ...(clientNat ? { bindAddress: '127.0.0.1' } : null) });
  cleanups.push(() => {
    for (const d of client.dcs) closeNative(d);
    closeNative(client.pc);
  });

  // what the host sees of the client's candidates (through its NAT); a NATed client only exposes its srflx
  const toHost = async (line: string): Promise<string | null> => {
    if (sc.forwardCandidates === false) return null;
    if (clientNat !== null && !/ typ srflx/.test(line)) return null;
    return hostNat.rewriteCandidate(line);
  };
  // what the client sees of ours (through its own NAT, if any)
  const toClient = async (line: string): Promise<string | null> => (clientNat !== null ? clientNat.rewriteCandidate(line) : line);

  const session = ep.createSession(client.offer);
  cleanups.push(() => session.close());
  for (const c of client.ownCandidates) {
    const m = await toHost(c);
    if (m !== null) session.addRemoteCandidate(m);
  }
  const hostAnswer = session.answerSdp; // released once DTLS connects
  let answer = hostAnswer;
  if (clientNat !== null) answer = await clientNat.rewriteSdp(answer);
  session.onLocalCandidate = (c) => void toClient(c).then((m) => m && client.pc.addRemoteCandidate(m, session.mid));
  const opened = new Promise<void>((r) => (session.onOpen = r));
  let echo: string | null = null;
  session.onMessage = (ch, data) => {
    echo = Buffer.from(data).toString();
    session.send(ch, Buffer.from(`echo:${echo}`));
  };
  client.pc.setRemoteDescription(answer, 'answer');
  const timeout = sc.timeoutMs ?? 10_000;
  const connected = await Promise.race([Promise.all([opened, client.open]).then(() => true), sleep(timeout).then(() => false)]);
  let reply: string | null = null;
  if (connected) {
    client.dcs[0]!.sendMessage('ping');
    reply = await Promise.race([client.received, sleep(3000).then(() => null)]);
  }
  return { connected, session, ep, hostNat, answer: hostAnswer, echo: reply };
}

describe.skipIf(PUBLIC === undefined)('haxlite-rtc full ICE behind a simulated NAT (libdatachannel client)', () => {
  it('port-restricted NAT: srflx from STUN, our checks open the pinhole, data flows', async () => {
    const r = await run({ hostNat: {} });
    // the only candidate is the NAT's external address learned via STUN; no host/private address leaks
    expect(r.answer).not.toContain('127.0.0.1');
    expect(r.answer).not.toContain('a=ice-lite');
    expect(r.answer).toMatch(new RegExp(`a=candidate:\\S+ 1 udp \\d+ ${PUBLIC!.replace(/\./g, '\\.')} \\d+ typ srflx raddr 0\\.0\\.0\\.0 rport 0`));
    expect(r.ep.reflexiveAddresses[0]?.address).toBe(PUBLIC);
    expect(r.connected).toBe(true);
    expect(r.echo).toBe('echo:ping');
    const st = r.ep.stats();
    expect(st.ice.checksSent).toBeGreaterThan(0);
    expect(st.ice.checksSucceeded).toBeGreaterThan(0);
  });

  it('control: without our checks (no remote candidates) the same NAT blocks the client', async () => {
    const r = await run({ hostNat: {}, forwardCandidates: false, timeoutMs: 6000 });
    expect(r.connected).toBe(false);
    expect(r.hostNat.stats.dropped).toBeGreaterThan(0); // the client's checks to our srflx were unsolicited
  });

  it('symmetric NAT (address+port-dependent mapping): the client learns our peer-reflexive address from our checks', async () => {
    const r = await run({ hostNat: { mapping: 'address-port-dependent' } });
    expect(r.connected).toBe(true);
    expect(r.echo).toBe('echo:ping');
    expect(r.hostNat.stats.mappings).toBeGreaterThanOrEqual(2); // one towards STUN, one towards the client
  });

  it('both sides behind port-restricted NATs (hole punching through both)', async () => {
    const r = await run({ hostNat: {}, clientNat: {} });
    expect(r.connected).toBe(true);
    expect(r.echo).toBe('echo:ping');
  });

  it('consent freshness: our consent checks are answered once open', async () => {
    const r = await run({ hostNat: {} });
    expect(r.connected).toBe(true);
    await sleep(6500);
    const st = r.ep.stats();
    expect(st.ice.consentSent).toBeGreaterThanOrEqual(1);
    expect(st.ice.consentAnswered).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
