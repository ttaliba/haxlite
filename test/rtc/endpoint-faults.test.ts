/**
 * RtcEndpoint fault containment: a datagram or timer whose processing throws
 * (a bug in a protocol layer or a data-layer callback) costs that datagram or
 * that session, never the process (and with it every room on the endpoint).
 * The receive callbacks, the 1 Hz sweep, the ICE pacing timer, TURN
 * maintenance and the promises of the TURN pool all run outside any caller
 * that could catch.
 */
import { randomBytes } from 'node:crypto';
import dgram, { type Socket } from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtcEndpoint, rawDataLayer } from '../../src/rtc/index.js';
import { formatFingerprint } from '../../src/rtc/sdp.js';
import { buildBindingRequest } from '../../src/rtc/stun.js';
import { TurnRelay } from '../../src/rtc/turn.js';
import { IceScheduler, type IceAgent } from '../../src/rtc/ice-agent.js';
import type { UdpIo } from '../../src/rtc/udp.js';
import { ecClientCert } from './dtls-helpers.js';
import { TurnServer } from './turn-server.js';

const CLIENT_UFRAG = 'cLnT';
const CLIENT_PWD = 'clientpasswordclientpwd0';
const cert = ecClientCert('faults');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function offerSdp(candidates: string[] = []): string {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${CLIENT_UFRAG}`,
    `a=ice-pwd:${CLIENT_PWD}`,
    `a=fingerprint:sha-256 ${formatFingerprint(cert.sha256)}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    ...candidates.map((c) => `a=${c}`),
    '',
  ].join('\r\n');
}

function answerCreds(sdp: string): { ufrag: string; pwd: string } {
  return { ufrag: /a=ice-ufrag:(\S+)/.exec(sdp)![1]!, pwd: /a=ice-pwd:(\S+)/.exec(sdp)![1]! };
}

function nextMessage(s: Socket, ms = 500): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      s.off('message', on);
      resolve(null);
    }, ms);
    const on = (m: Buffer) => {
      clearTimeout(t);
      s.off('message', on);
      resolve(m);
    };
    s.on('message', on);
  });
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function udp(): Promise<Socket> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  cleanups.push(() => s.close());
  return s;
}

/** Internals the tests drive directly (the receive callback is the socket's, outside any try). */
interface EndpointInternals {
  ios: unknown[];
  onPacket(sock: unknown, msg: Buffer, address: string, port: number): void;
  onRelaySocketPacket(relay: unknown, msg: Buffer, address: string, port: number): void;
  byUfrag: Map<string, { handleDtls: (...a: unknown[]) => void; checkTimers: (...a: unknown[]) => void }>;
  pool: TurnRelay[];
  makeRelay: (io: { sock: Socket }, shared: boolean) => TurnRelay;
  spawnRelay(): void;
}

describe('RtcEndpoint: a throw while processing a datagram', () => {
  it('direct socket: the datagram is dropped and counted, the endpoint keeps answering', async () => {
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], iceLite: true, dataLayer: rawDataLayer });
    cleanups.push(() => ep.close());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = ep.createSession(offerSdp());
    const creds = answerCreds(session.answerSdp);
    const c = await udp();
    const binding = () =>
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695, useCandidate: true });
    c.send(binding(), ep.port, '127.0.0.1');
    expect(await nextMessage(c)).not.toBeNull();
    const internals = ep as unknown as EndpointInternals;
    const impl = internals.byUfrag.get(creds.ufrag)!;
    impl.handleDtls = () => {
      throw new RangeError('offset out of range');
    };
    const dtls = Buffer.from('16fefd000000000000000000000000', 'hex');
    expect(() => internals.onPacket(internals.ios[0], dtls, '127.0.0.1', c.address().port)).not.toThrow();
    expect(ep.stats().packetErrors).toBe(1);
    // the same through the real socket, then the endpoint still serves the session
    c.send(dtls, ep.port, '127.0.0.1');
    await sleep(50);
    expect(ep.stats().packetErrors).toBe(2);
    c.send(binding(), ep.port, '127.0.0.1');
    expect(await nextMessage(c)).not.toBeNull();
  });

  it("an allocation's own socket: a throw in the TURN layer is contained too", async () => {
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: ['turn:u:p@127.0.0.1:9'] });
    cleanups.push(() => ep.close());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const internals = ep as unknown as EndpointInternals;
    const relay = {
      serverAddress: '127.0.0.1',
      serverPort: 3478,
      onServerPacket(): boolean {
        throw new TypeError('bad attribute');
      },
    };
    expect(() => internals.onRelaySocketPacket(relay, Buffer.from([0x01, 0x01, 0, 0]), '127.0.0.1', 3478)).not.toThrow();
    expect(ep.stats().packetErrors).toBe(1);
  });
});

describe('RtcEndpoint: a throw in a timer or a promise callback', () => {
  it('the 1 Hz sweep: the faulty session is closed, the others still time out normally', async () => {
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], iceLite: true, dataLayer: rawDataLayer, handshakeTimeoutMs: 1500 });
    cleanups.push(() => ep.close());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = ep.createSession(offerSdp());
    const good = ep.createSession(offerSdp());
    const closed: string[] = [];
    bad.onClose = (r) => closed.push(`bad:${r}`);
    good.onClose = (r) => closed.push(`good:${r}`);
    const internals = ep as unknown as EndpointInternals;
    internals.byUfrag.get(answerCreds(bad.answerSdp).ufrag)!.checkTimers = () => {
      throw new Error('unexpected state');
    };
    await sleep(3200);
    expect(closed).toContain('bad:error');
    expect(closed).toContain('good:handshake-timeout');
  });

  it('a TURN pool allocation whose setup throws: no unhandled rejection, its socket is closed', async () => {
    const srv = await TurnServer.start();
    cleanups.push(() => srv.close());
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', candidatePolicy: 'all', iceServers: [srv.urlWithCredentials()] });
    cleanups.push(() => ep.close());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const internals = ep as unknown as EndpointInternals;
    const make = internals.makeRelay;
    let sock: Socket | null = null;
    internals.makeRelay = (io, shared) => {
      sock = io.sock;
      const r = make(io, shared);
      r.allocate = () => {
        throw new Error('allocate failed');
      };
      return r;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    cleanups.push(() => process.off('unhandledRejection', onUnhandled));
    const before = internals.pool.length;
    internals.spawnRelay();
    await sleep(200);
    expect(unhandled).toEqual([]);
    expect(sock).not.toBeNull();
    expect(() => sock!.address()).toThrow(); // closed
    expect(internals.pool.length).toBe(before);
  });

  it('TurnRelay: a throw after the server name resolves fails the attempt instead of rejecting unhandled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent: Buffer[] = [];
    const relay = new TurnRelay(
      {
        io: { family: 4, send: (b: Uint8Array) => (sent.push(Buffer.from(b)), true) } as never,
        family: 4,
        now: () => Date.now(),
        deliver: () => {},
        lookup: async () => ['127.0.0.1'],
      },
      [{ host: 'turn.example', port: 3478, username: 'u', credential: 'p' } as never],
    );
    cleanups.push(() => relay.close());
    (relay as unknown as { sendAllocate: () => void }).sendAllocate = () => {
      throw new Error('encode failed');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    cleanups.push(() => process.off('unhandledRejection', onUnhandled));
    let result: boolean | null = null;
    relay.allocate((ok) => (result = ok));
    await sleep(50);
    expect(unhandled).toEqual([]);
    expect(result).toBe(false);
    expect(relay.state).toBe('failed');
  });

  it('the ICE pacing timer: an agent whose tick throws is dropped, the others keep their checks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sched = new IceScheduler({
      send: () => {},
      now: () => Date.now(),
      sockets: [{ sock: {} as UdpIo, family: 4, bindAddress: '0.0.0.0' }],
      policy: 'public',
    });
    cleanups.push(() => sched.close());
    let badTicks = 0;
    let goodTicks = 0;
    const bad = {
      tick(): boolean {
        badTicks++;
        throw new Error('bad pair state');
      },
    };
    const good = {
      tick(): boolean {
        goodTicks++;
        return true;
      },
    };
    sched.activate(bad as unknown as IceAgent);
    sched.activate(good as unknown as IceAgent);
    await sleep(200);
    expect(badTicks).toBe(1);
    expect(goodTicks).toBeGreaterThan(3);
  });
});
