/**
 * haxlite-rtc's TURN client (RFC 8656) end to end, through the public
 * `RtcEndpoint` API (`iceServers` with `turn:` entries), against the
 * independent test server in turn-server.ts and libdatachannel
 * (node-datachannel) as the joining client.
 *
 * The scenario TURN exists for: the host behind a symmetric NAT **and** the
 * client behind a symmetric NAT (nat-sim.ts). Neither side can learn a
 * usable reflexive or peer-reflexive address of the other, so without a
 * relay there is no path (the control case); with the host's relay
 * candidate the client's checks reach the relay (the host installed a
 * permission for the client's IP), arrive at the host as Data indications /
 * ChannelData, and the host answers through the relay.
 */
import os from 'node:os';
import type { DataChannel, PeerConnection } from 'node-datachannel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { RtcEndpoint, type RtcEndpointOptions, type RtcSession } from '../../src/rtc/index.js';
import { closeNative, createDataChannel, createPeerConnection, shutdownWebRtc } from '../../src/net/webrtc.js';
import { FakeStunServer, UdpNat, type NatOptions } from './nat-sim.js';
import { turnServers } from '../../src/rtc/turn.js';
import { TurnServer, type TurnServerOptions } from './turn-server.js';

const PUBLIC = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

const SYMMETRIC: NatOptions = { mapping: 'address-port-dependent' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
  return true;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(async () => {
  await shutdownWebRtc();
});

async function turnServer(o: TurnServerOptions = {}): Promise<TurnServer> {
  const srv = await TurnServer.start({ verbose: process.env.TURN_VERBOSE === "1", ...o });
  cleanups.push(() => srv.close());
  return srv;
}

async function endpoint(o: RtcEndpointOptions): Promise<RtcEndpoint> {
  const ep = await RtcEndpoint.listen(o);
  cleanups.push(() => ep.close());
  await ep.whenGathered();
  return ep;
}

// ---------------------------------------------------------------- libdatachannel client (as in nat.test.ts)

interface Client {
  pc: PeerConnection;
  dcs: DataChannel[];
  open: Promise<void>;
  /** Messages received on the reliable channel. */
  messages: string[];
  ownCandidates: string[];
  /** Called for candidates gathered after {@link makeClient} returned (trickle). */
  onLateCandidate: ((c: string) => void) | null;
  offer: string;
}

async function makeClient(cfg: { iceServers?: string[]; bindAddress?: string }): Promise<Client> {
  const ownCandidates: string[] = [];
  let client: Client | null = null;
  let gathered!: () => void;
  const gatheredP = new Promise<void>((r) => {
    gathered = r;
    setTimeout(r, 2000);
  });
  const pc = createPeerConnection(
    'turn-client',
    { iceServers: cfg.iceServers ?? [], disableAutoNegotiation: true, ...(cfg.bindAddress ? { bindAddress: cfg.bindAddress } : null) },
    {
      onLocalCandidate: (c) => {
        const line = c.startsWith('a=') ? c.slice(2) : c;
        ownCandidates.push(line);
        client?.onLateCandidate?.(line);
      },
      onGatheringStateChange: (s) => s === 'complete' && gathered(),
    },
  );
  let opened = 0;
  let openRes!: () => void;
  const open = new Promise<void>((r) => (openRes = r));
  const messages: string[] = [];
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
        onMessage: (m) => i === 0 && messages.push(typeof m === 'string' ? m : Buffer.from(m as Buffer).toString()),
      }),
    );
  });
  cleanups.push(() => {
    for (const d of dcs) closeNative(d);
    closeNative(pc);
  });
  pc.setLocalDescription('offer');
  await gatheredP;
  const offer = pc.localDescription()!.sdp
    .split('\r\n')
    .filter((l) => !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates')
    .join('\r\n');
  client = { pc, dcs, open, messages, ownCandidates, onLateCandidate: null, offer };
  return client;
}

interface Connection {
  connected: boolean;
  session: RtcSession;
  client: Client;
  /** Every candidate line of ours the client was given (answer + trickle), before any NAT rewrite. */
  ourCandidates: string[];
  answer: string;
  /** Sends `n` messages from the client and waits for their echoes. */
  pingPong(n: number): Promise<boolean>;
}

/**
 * Connects a client to `ep`. `toHost` / `toClient` route candidate lines
 * (null drops one); `answerFilter` edits our answer before the client sees it.
 */
async function connect(
  ep: RtcEndpoint,
  client: Client,
  o: {
    toHost?: (line: string) => Promise<string | null> | string | null;
    toClient?: (line: string) => Promise<string | null> | string | null;
    answerFilter?: (sdp: string) => Promise<string> | string;
    /** The IP the signaling server saw (`createSession`'s `remoteIp`). */
    remoteIp?: string;
    timeoutMs?: number;
  } = {},
): Promise<Connection> {
  const session = ep.createSession(client.offer, o.remoteIp !== undefined ? { remoteIp: o.remoteIp } : undefined);
  cleanups.push(() => session.close());
  const ourCandidates = session.answerSdp
    .split('\r\n')
    .filter((l) => l.startsWith('a=candidate:'))
    .map((l) => l.slice(2));
  const toHost = async (c: string) => {
    const m = o.toHost ? await o.toHost(c) : c;
    if (m !== null) session.addRemoteCandidate(m);
  };
  for (const c of client.ownCandidates) await toHost(c);
  client.onLateCandidate = (c) => void toHost(c);
  const answer = session.answerSdp;
  session.onLocalCandidate = (c) => {
    ourCandidates.push(c.startsWith('a=') ? c.slice(2) : c);
    void Promise.resolve(o.toClient ? o.toClient(c) : c).then((m) => m && client.pc.addRemoteCandidate(m, session.mid));
  };
  const opened = new Promise<void>((r) => (session.onOpen = r));
  session.onMessage = (ch, data) => session.send(ch, Buffer.from(`echo:${Buffer.from(data).toString()}`));
  client.pc.setRemoteDescription(o.answerFilter ? await o.answerFilter(answer) : answer, 'answer');
  const connected = await Promise.race([Promise.all([opened, client.open]).then(() => true), sleep(o.timeoutMs ?? 10_000).then(() => false)]);
  const pingPong = async (n: number) => {
    const before = client.messages.length;
    for (let i = 0; i < n; i++) client.dcs[0]!.sendMessage(`m${i}`);
    return until(() => client.messages.length - before >= n, 5000);
  };
  return { connected, session, client, ourCandidates, answer, pingPong };
}

const relayLines = (lines: readonly string[]) => lines.filter((l) => / typ relay( |$)/.test(l));

/** Removes every candidate but the relay ones from an SDP. */
const relayOnlySdp = (sdp: string) =>
  sdp
    .split('\r\n')
    .filter((l) => !l.startsWith('a=candidate:') || / typ relay( |$)/.test(l))
    .join('\r\n');

// ---------------------------------------------------------------- tests

describe('turnServers (iceServers parsing)', () => {
  it('a Cloudflare TURN credential response: UDP TURN URLs in order, 3478 first; stun/tcp/turns skipped', () => {
    const cf = {
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turn:turn.cloudflare.com:53?transport=udp',
            'turn:turn.cloudflare.com:3478?transport=tcp',
            'turn:turn.cloudflare.com:80?transport=tcp',
            'turns:turn.cloudflare.com:5349?transport=tcp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'bc91b63e2b5d759f8eb9f3b58ac5e74ab4a64ecd7c06fb4e8b3a2e8f',
          credential: 'ebd71f1d3edbc2b0edae3cd5a6d82284aeb5c3b8fdaa9b8e3bf9cec683e0d45fe9f5b44e5145db3300f06c250a15b4a0',
        },
      ],
    };
    const s = turnServers(cf.iceServers);
    expect(s.map((x) => x.port)).toEqual([3478, 53]);
    expect(s.every((x) => x.host === 'turn.cloudflare.com' && x.username === cf.iceServers[1]!.username && x.credential === cf.iceServers[1]!.credential)).toBe(true);
  });

  it('URL credentials, IPv6 literals, node-datachannel objects', () => {
    const s = turnServers([
      'turn:u%40x:p%3Aw@[2001:db8::1]:3479',
      'turn:host.example',
      { hostname: '203.0.113.5', port: 3478, username: 'a', password: 'b', relayType: 'TurnUdp' },
      { hostname: '203.0.113.6', port: 443, username: 'a', password: 'b', relayType: 'TurnTls' },
      'stun:stun.l.google.com:19302',
    ]);
    expect(s).toEqual([
      { host: '2001:db8::1', port: 3479, username: 'u@x', credential: 'p:w' },
      { host: 'host.example', port: 3478, username: '', credential: '' },
      { host: '203.0.113.5', port: 3478, username: 'a', credential: 'b' },
    ]);
  });
});

describe('haxlite-rtc TURN client (loopback, no NAT)', () => {
  it('turn:user:pass@host URL: one allocation per endpoint, a relay candidate in every answer', async () => {
    const srv = await turnServer();
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [srv.urlWithCredentials()] });
    await until(() => srv.allocations.size > 0, 3000);
    expect(srv.counters.allocations).toBe(1);
    expect(srv.counters.unauthorized).toBe(1); // first Allocate challenged, second authenticated
    expect(srv.counters.badIntegrity).toBe(0);
    const [relayed] = srv.relayedAddresses();
    const c1 = await makeClient({ bindAddress: '127.0.0.1' });
    const s1 = ep.createSession(c1.offer);
    cleanups.push(() => s1.close());
    const c2 = await makeClient({ bindAddress: '127.0.0.1' });
    const s2 = ep.createSession(c2.offer);
    cleanups.push(() => s2.close());
    for (const s of [s1, s2]) {
      const relay = relayLines(s.answerSdp.split('\r\n'));
      expect(relay).toHaveLength(1);
      const [addr, port] = relayed!.split(':');
      expect(relay[0]).toMatch(new RegExp(` udp \\d+ ${addr!.replace(/\./g, '\\.')} ${port} typ relay`));
    }
    // the relay is shared by every session of the endpoint
    expect(srv.counters.allocations).toBe(1);
  });

  it('RTCIceServer form {urls, username, credential}', async () => {
    const srv = await turnServer({ users: { alice: 's3cr3t' } });
    const ep = await endpoint({
      address: '127.0.0.1',
      candidatePolicy: 'all',
      iceServers: [{ urls: [`turn:127.0.0.1:${srv.port}?transport=udp`], username: 'alice', credential: 's3cr3t' }],
    });
    await until(() => srv.allocations.size > 0, 3000);
    expect(srv.counters.allocations).toBe(1);
    const c = await makeClient({ bindAddress: '127.0.0.1' });
    const s = ep.createSession(c.offer);
    cleanups.push(() => s.close());
    expect(relayLines(s.answerSdp.split('\r\n'))).toHaveLength(1);
  });

  it('a client that only gets our relay candidate connects through it (Data indications, then ChannelData)', async () => {
    const srv = await turnServer();
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [srv.urlWithCredentials()] });
    await until(() => srv.allocations.size > 0, 3000);
    const client = await makeClient({ bindAddress: '127.0.0.1' });
    // the client never learns a direct address of ours, and the host none of the client's
    // (so it sends no direct check that would teach the client a peer-reflexive one): the
    // permission comes from the IP the signaling server saw, the pair from the client's checks
    const conn = await connect(ep, client, {
      answerFilter: relayOnlySdp,
      toClient: (l) => (/ typ relay( |$)/.test(l) ? l : null),
      toHost: () => null,
      remoteIp: '127.0.0.1',
    });
    expect(conn.connected).toBe(true);
    expect(await conn.pingPong(5)).toBe(true);
    expect(client.messages).toContain('echo:m0');
    expect(srv.counters.permissions + srv.counters.channels).toBeGreaterThanOrEqual(1);
    expect(srv.counters.dataIndications + srv.counters.channelDataOut).toBeGreaterThan(0);
  });

  it('wrong credentials: no relay candidate, direct connectivity still works', async () => {
    const srv = await turnServer();
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [`turn:user:wrong@127.0.0.1:${srv.port}`] });
    await sleep(500);
    expect(srv.allocations.size).toBe(0);
    expect(srv.counters.unauthorized).toBeGreaterThanOrEqual(1);
    // the client gives up after a 401 to the authenticated request: no retry storm
    expect(srv.counters.requests).toBeLessThanOrEqual(4);
    const client = await makeClient({ bindAddress: '127.0.0.1' });
    const conn = await connect(ep, client);
    expect(relayLines(conn.ourCandidates)).toHaveLength(0);
    expect(conn.connected).toBe(true);
    expect(await conn.pingPong(1)).toBe(true);
  });

  it('unreachable TURN server: direct connectivity is not delayed by it', async () => {
    const srv = await turnServer();
    srv.silent = true;
    const t0 = Date.now();
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [srv.urlWithCredentials()] });
    cleanups.push(() => ep.close());
    const client = await makeClient({ bindAddress: '127.0.0.1' });
    const conn = await connect(ep, client, { timeoutMs: 8000 });
    expect(conn.connected).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('no TURN entry: nothing is allocated (a stun: URL to the same server only gets Binding requests)', async () => {
    const srv = await turnServer();
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [`stun:127.0.0.1:${srv.port}`] });
    expect(srv.counters.bindings).toBeGreaterThanOrEqual(1);
    expect(srv.counters.requests).toBe(srv.counters.bindings);
    expect(srv.counters.allocations).toBe(0);
    const c = await makeClient({ bindAddress: '127.0.0.1' });
    const s = ep.createSession(c.offer);
    cleanups.push(() => s.close());
    expect(relayLines(s.answerSdp.split('\r\n'))).toHaveLength(0);
  });

  it('allocation refresh before LIFETIME (and a 438 Stale Nonce on the way is retried)', async () => {
    // the server grants 3 s: the client must refresh well before
    const srv = await turnServer({ defaultLifetime: 3, maxLifetime: 3 });
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [srv.urlWithCredentials()] });
    await until(() => srv.allocations.size > 0, 3000);
    const [relayed] = srv.relayedAddresses();
    srv.staleNonce = true; // the next authenticated request (the first Refresh) gets 438
    await sleep(7000);
    expect(srv.counters.staleNonces).toBe(1);
    expect(srv.counters.refreshes).toBeGreaterThanOrEqual(2);
    expect(srv.allocations.size).toBe(1);
    expect(srv.relayedAddresses()).toEqual([relayed]); // same allocation, never re-made
    expect(srv.counters.allocations).toBe(1);
    const c = await makeClient({ bindAddress: '127.0.0.1' });
    const s = ep.createSession(c.offer);
    cleanups.push(() => s.close());
    expect(relayLines(s.answerSdp.split('\r\n'))[0]).toContain(` ${relayed!.split(':')[1]} typ relay`);
  }, 20_000);

  it('lost Allocate requests are retransmitted', async () => {
    const srv = await turnServer();
    srv.dropAllocates = 2;
    await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [srv.urlWithCredentials()] });
    expect(await until(() => srv.allocations.size === 1, 8000)).toBe(true);
    expect(srv.counters.droppedAllocates).toBe(2);
    expect(srv.counters.allocations).toBe(1);
  }, 15_000);

  it('falls back to the next TURN server when the first never answers', async () => {
    const dead = await turnServer();
    dead.silent = true;
    const srv = await turnServer();
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [dead.urlWithCredentials(), srv.urlWithCredentials()] });
    expect(await until(() => srv.allocations.size === 1, 10_000)).toBe(true);
    expect(dead.allocations.size).toBe(0);
    const c = await makeClient({ bindAddress: '127.0.0.1' });
    // the relay may be found after this session's gathering: wait for a fresh one
    await until(() => relayLines(ep.localCandidates).length === 1, 3000);
    const s = ep.createSession(c.offer);
    cleanups.push(() => s.close());
    expect(relayLines(s.answerSdp.split('\r\n'))[0]).toContain(` ${srv.relayedAddresses()[0]!.split(':')[1]} typ relay`);
  }, 20_000);

  it('Cloudflare-style list (stun + turn/turns over udp/tcp, several ports): only the UDP TURN URLs are used', async () => {
    const srv = await turnServer({ users: { 'g0a1b2c3': 'tok' } });
    const ep = await endpoint({
      address: '127.0.0.1',
      candidatePolicy: 'all',
      iceServers: [
        {
          urls: [
            `stun:127.0.0.1:${srv.port}`,
            `turn:127.0.0.1:${srv.port}?transport=udp`,
            `turn:127.0.0.1:${srv.port}?transport=tcp`,
            `turns:127.0.0.1:5349?transport=tcp`,
          ],
          username: 'g0a1b2c3',
          credential: 'tok',
        },
      ],
    });
    expect(await until(() => srv.allocations.size === 1, 3000)).toBe(true);
    expect(srv.counters.allocations).toBe(1);
    expect(relayLines(ep.localCandidates)).toHaveLength(1);
  });

  it('closing the endpoint releases the allocation (Refresh with LIFETIME 0)', async () => {
    const srv = await turnServer();
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [srv.urlWithCredentials()] });
    await ep.whenGathered();
    await until(() => srv.allocations.size > 0, 3000);
    expect(srv.allocations.size).toBe(1);
    await ep.close();
    expect(await until(() => srv.allocations.size === 0, 2000)).toBe(true);
    expect(srv.counters.deletes).toBe(1);
  });
});

describe.skipIf(PUBLIC === undefined)('haxlite-rtc TURN behind symmetric NATs on both sides', () => {
  /**
   * Host behind `hostNat` (bound to 127.0.0.1, reaches STUN/TURN through
   * aliases), client behind its own symmetric NAT. The STUN and TURN servers
   * live on the "public" side (the machine's non-loopback address).
   */
  async function both(turn: boolean): Promise<{ conn: Connection; srv: TurnServer; hostNat: UdpNat; clientNat: UdpNat }> {
    const stun = await FakeStunServer.start(PUBLIC!);
    cleanups.push(() => stun.close());
    const srv = await turnServer({ address: PUBLIC! });
    const hostNat = new UdpNat({ insideAddress: '127.0.0.1', outsideAddress: PUBLIC!, ...SYMMETRIC });
    cleanups.push(() => hostNat.close());
    const clientNat = new UdpNat({ insideAddress: '127.0.0.1', outsideAddress: PUBLIC!, ...SYMMETRIC });
    cleanups.push(() => clientNat.close());
    const stunAlias = await hostNat.alias({ address: stun.address, port: stun.port });
    const turnAlias = await hostNat.alias({ address: srv.address, port: srv.port });
    const iceServers = [`stun:${stunAlias.address}:${stunAlias.port}`];
    if (turn) iceServers.push(`turn:user:pass@${turnAlias.address}:${turnAlias.port}`);
    // 'private': the "public" side is this machine's LAN address; loopback (our bind) is never announced
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'private', iceServers });
    if (turn) await until(() => srv.allocations.size > 0, 3000);
    const a = await clientNat.alias({ address: stun.address, port: stun.port });
    const client = await makeClient({ iceServers: [`stun:${a.address}:${a.port}`], bindAddress: '127.0.0.1' });
    const conn = await connect(ep, client, {
      // the client only exposes its (useless, symmetric) srflx; the host gets it as is: the relay
      // reaches it on the public side, and a direct check from the host is dropped by the client's NAT
      toHost: (l) => (/ typ srflx/.test(l) ? l : null),
      toClient: (l) => clientNat.rewriteCandidate(l),
      answerFilter: (sdp) => clientNat.rewriteSdp(sdp),
      timeoutMs: turn ? 15_000 : 6000,
    });
    return { conn, srv, hostNat, clientNat };
  }

  it('control: without TURN there is no path', async () => {
    const { conn } = await both(false);
    expect(conn.connected).toBe(false);
  }, 30_000);

  it('with TURN: connects through the relay, data flows both ways, steady state on ChannelData', async () => {
    const { conn, srv } = await both(true);
    expect(relayLines(conn.ourCandidates)).toHaveLength(1);
    // no private / loopback base address leaks in the relay candidate
    expect(relayLines(conn.ourCandidates)[0]).not.toContain('127.0.0.1');
    expect(conn.connected).toBe(true);
    expect(await conn.pingPong(1)).toBe(true);
    expect(conn.client.messages).toContain('echo:m0');
    // relayed traffic in both directions
    expect(srv.counters.permissions + srv.counters.channels).toBeGreaterThanOrEqual(1);
    expect(srv.counters.dataIndications + srv.counters.channelDataOut).toBeGreaterThan(0);
    expect(srv.counters.sendIndications + srv.counters.channelDataIn).toBeGreaterThan(0);
    // the chosen pair gets a channel: 4-byte ChannelData framing instead of 36+ byte indications
    expect(await until(() => srv.liveChannels() >= 1, 3000)).toBe(true);
    const before = { ...srv.counters };
    expect(await conn.pingPong(20)).toBe(true);
    const after = srv.counters;
    expect(after.channelDataIn - before.channelDataIn).toBeGreaterThanOrEqual(20);
    expect(after.channelDataOut - before.channelDataOut).toBeGreaterThanOrEqual(20);
    expect(after.sendIndications - before.sendIndications).toBeLessThanOrEqual(1);
    expect(after.dataIndications - before.dataIndications).toBeLessThanOrEqual(1);
    expect(srv.counters.droppedSendNoPermission).toBe(0);
  }, 30_000);
});

describe("haxlite-rtc iceTransportPolicy: 'relay'", () => {
  it('the answer has only the relay candidate and the client connects through it', async () => {
    const srv = await turnServer();
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceTransportPolicy: 'relay', iceServers: [`stun:127.0.0.1:${srv.port}`, srv.urlWithCredentials()] });
    const client = await makeClient({ bindAddress: '127.0.0.1' });
    const conn = await connect(ep, client);
    expect(conn.ourCandidates.length).toBeGreaterThanOrEqual(1);
    expect(conn.ourCandidates.every((l) => / typ relay( |$)/.test(l))).toBe(true);
    // the bound port (our direct transport address) never appears
    if (process.env.TURN_VERBOSE === '1') console.log('ep', JSON.stringify(ep.stats()), conn.ourCandidates, client.ownCandidates);
    expect(conn.answer).not.toMatch(new RegExp(` ${ep.port} typ `));
    expect(conn.connected).toBe(true);
    expect(await conn.pingPong(3)).toBe(true);
    expect(srv.counters.dataIndications + srv.counters.channelDataOut).toBeGreaterThan(0);
    expect(ep.turn?.state).toBe('allocated');
  });

  it('needs a TURN server', async () => {
    await expect(RtcEndpoint.listen({ address: '127.0.0.1', iceTransportPolicy: 'relay', iceServers: ['stun:127.0.0.1:3478'] })).rejects.toThrow(/turn/i);
  });

  /**
   * CGNAT with non-paired address pooling: the client's mapping towards the
   * STUN server leaves from 127.0.0.2, the one towards our relay from
   * 127.0.0.3. The permission for its srflx IP does not cover the IP its
   * checks reach the relay from; the IP the signaling server saw (`remoteIp`)
   * does.
   */
  async function cgnat(remoteIp: string | undefined): Promise<{ conn: Connection; srv: TurnServer }> {
    const srv = await turnServer();
    const stun = await FakeStunServer.start('127.0.0.1');
    cleanups.push(() => stun.close());
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceTransportPolicy: 'relay', iceServers: [srv.urlWithCredentials()] });
    const nat = new UdpNat({ insideAddress: '127.0.0.1', mapping: 'address-port-dependent', outsidePool: ['127.0.0.2', '127.0.0.3'] });
    cleanups.push(() => nat.close());
    const a = await nat.alias({ address: stun.address, port: stun.port });
    const client = await makeClient({ iceServers: [`stun:${a.address}:${a.port}`], bindAddress: '127.0.0.1' });
    expect(client.ownCandidates.some((l) => / 127\.0\.0\.2 \d+ typ srflx/.test(l))).toBe(true);
    const session = ep.createSession(client.offer, remoteIp !== undefined ? { remoteIp } : undefined);
    cleanups.push(() => session.close());
    for (const c of client.ownCandidates) if (/ typ srflx/.test(c)) session.addRemoteCandidate(c);
    client.onLateCandidate = (c) => / typ srflx/.test(c) && session.addRemoteCandidate(c);
    const ourCandidates: string[] = [];
    session.onLocalCandidate = (c) => {
      ourCandidates.push(c);
      void nat.rewriteCandidate(c).then((m) => m && client.pc.addRemoteCandidate(m, session.mid));
    };
    const opened = new Promise<void>((r) => (session.onOpen = r));
    session.onMessage = (ch, data) => session.send(ch, Buffer.from(`echo:${Buffer.from(data).toString()}`));
    client.pc.setRemoteDescription(await nat.rewriteSdp(session.answerSdp), 'answer');
    const connected = await Promise.race([Promise.all([opened, client.open]).then(() => true), sleep(remoteIp ? 10_000 : 6000).then(() => false)]);
    const pingPong = async (n: number) => {
      const before = client.messages.length;
      for (let i = 0; i < n; i++) client.dcs[0]!.sendMessage(`m${i}`);
      return until(() => client.messages.length - before >= n, 5000);
    };
    return { conn: { connected, session, client, ourCandidates, answer: session.answerSdp, pingPong }, srv };
  }

  it('CGNAT control: a permission for the srflx IP only does not let the client in', async () => {
    const { conn, srv } = await cgnat(undefined);
    expect(conn.connected).toBe(false);
    expect(srv.counters.droppedNoPermission).toBeGreaterThan(0); // its checks from 127.0.0.3
  }, 20_000);

  it('CGNAT: the remoteIp hint installs a permission up front and the client connects', async () => {
    const { conn } = await cgnat('::ffff:127.0.0.3');
    expect(conn.connected).toBe(true);
    expect(await conn.pingPong(2)).toBe(true);
  }, 20_000);

  it('credential rotation: setIceServers with the new password keeps the relay working', async () => {
    const srv = await turnServer({ users: { user: 'old' }, defaultLifetime: 3, maxLifetime: 3 });
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceTransportPolicy: 'relay', iceServers: [`turn:user:old@127.0.0.1:${srv.port}`] });
    expect(await until(() => srv.allocations.size === 1, 3000)).toBe(true);
    const unauthorized0 = srv.counters.unauthorized;
    srv.setPassword('user', 'new');
    ep.setIceServers([{ urls: `turn:127.0.0.1:${srv.port}`, username: 'user', credential: 'new' }]);
    // the next refresh(es) must succeed with the new key (possibly after one 401 with the old one)
    await sleep(7000);
    expect(srv.allocations.size).toBe(1);
    expect(ep.turn?.state).toBe('allocated');
    expect(srv.counters.unauthorized - unauthorized0).toBeLessThanOrEqual(3);
    const client = await makeClient({ bindAddress: '127.0.0.1' });
    const conn = await connect(ep, client);
    expect(relayLines(conn.ourCandidates)).toHaveLength(1);
    expect(conn.answer).toContain(` ${srv.relayedAddresses()[0]!.split(':')[1]} typ relay`);
    expect(conn.connected).toBe(true);
    expect(await conn.pingPong(2)).toBe(true);
  }, 30_000);

  it('credential rotation without setIceServers: the allocation is lost when the server stops accepting the old key', async () => {
    const srv = await turnServer({ users: { user: 'old' }, defaultLifetime: 3, maxLifetime: 3 });
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [`turn:user:old@127.0.0.1:${srv.port}`] });
    expect(await until(() => srv.allocations.size === 1, 3000)).toBe(true);
    srv.setPassword('user', 'new');
    expect(await until(() => srv.allocations.size === 0, 8000)).toBe(true);
    // gives up without hammering the server
    await sleep(2000);
    expect(srv.counters.unauthorized).toBeLessThanOrEqual(8);
    expect(ep.turn?.state).not.toBe('allocated');
  }, 20_000);
});

describe('per-allocation peer limit (Cloudflare: ~10 distinct peer addresses per allocation)', () => {
  const LIMIT = 10;

  async function joinMany(ep: RtcEndpoint, n: number, timeoutMs: number): Promise<boolean[]> {
    const results: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const client = await makeClient({ bindAddress: '127.0.0.1' });
      const conn = await connect(ep, client, { remoteIp: '127.0.0.1', timeoutMs });
      results.push(conn.connected && (await conn.pingPong(2)));
      conn.session.close(); // the player leaves: its address still counts against that allocation
    }
    return results;
  }

  it('control: one allocation for everyone stops relaying after the limit', async () => {
    const srv = await turnServer({ maxPeerAddresses: LIMIT });
    const ep = await endpoint({
      address: '127.0.0.1',
      candidatePolicy: 'all',
      iceTransportPolicy: 'relay',
      iceServers: [srv.urlWithCredentials()],
      turnPeersPerAllocation: 1000,
      maxTurnAllocations: 1,
    });
    const results = await joinMany(ep, LIMIT + 3, 4000);
    expect(results.slice(0, LIMIT - 1).every(Boolean)).toBe(true);
    expect(results.slice(LIMIT + 1).some((ok) => !ok)).toBe(true);
    expect(srv.counters.droppedPeerLimit).toBeGreaterThan(0);
  }, 120_000);

  it('40 clients join one relay-only endpoint in a row: sessions are spread over a pool of allocations', async () => {
    const srv = await turnServer({ maxPeerAddresses: LIMIT });
    const ep = await endpoint({ address: '127.0.0.1', candidatePolicy: 'all', iceTransportPolicy: 'relay', iceServers: [srv.urlWithCredentials()] });
    const results = await joinMany(ep, 40, 8000);
    const failed = results.map((ok, i) => (ok ? -1 : i)).filter((i) => i >= 0);
    if (process.env.TURN_VERBOSE === '1') console.log('turn', JSON.stringify(ep.turn), 'server', JSON.stringify(srv.counters));
    expect(failed).toEqual([]);
    expect(ep.turn!.pool).toBeGreaterThan(1);
    // exhausted allocations are deleted once their sessions are gone (pool stays small)
    await until(() => ep.turn!.pool <= 3, 3000);
    expect(ep.turn!.pool).toBeLessThanOrEqual(3);
    expect(srv.allocations.size).toBe(ep.turn!.pool);
  }, 300_000);
});
