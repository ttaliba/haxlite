/**
 * A session whose datagrams keep throwing is closed with reason 'error'
 * instead of lingering half-updated until its idle timeout; other sessions
 * are untouched, and a teardown step that throws still unregisters it.
 */
import { randomBytes } from 'node:crypto';
import dgram, { type Socket } from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtcEndpoint, rawDataLayer } from '../../src/rtc/index.js';
import { formatFingerprint } from '../../src/rtc/sdp.js';
import { buildBindingRequest } from '../../src/rtc/stun.js';
import { ecClientCert } from './dtls-helpers.js';

const CLIENT_UFRAG = 'cLnT';
const CLIENT_PWD = 'clientpasswordclientpwd0';
const cert = ecClientCert('session-errors');

function offerSdp(): string {
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
    '',
  ].join('\r\n');
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

interface Internals {
  ios: unknown[];
  onPacket(sock: unknown, msg: Buffer, address: string, port: number): void;
  byUfrag: Map<string, { handleDtls: (...a: unknown[]) => void; dtls: { close: () => void } }>;
}

/** An ICE-lite session whose source (a local UDP socket) is validated by a binding. */
async function validatedSession(ep: RtcEndpoint) {
  const session = ep.createSession(offerSdp());
  const ufrag = /a=ice-ufrag:(\S+)/.exec(session.answerSdp)![1]!;
  const pwd = /a=ice-pwd:(\S+)/.exec(session.answerSdp)![1]!;
  const c = dgram.createSocket('udp4');
  await new Promise<void>((r) => c.bind(0, '127.0.0.1', () => r()));
  cleanups.push(() => c.close());
  c.send(buildBindingRequest({ txid: randomBytes(12), username: `${ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(pwd), priority: 1845501695, useCandidate: true }), ep.port, '127.0.0.1');
  expect(await nextMessage(c)).not.toBeNull();
  const closed: string[] = [];
  session.onClose = (r) => closed.push(r);
  return { session, ufrag, port: c.address().port, closed };
}

const DTLS = Buffer.from('16fefd000000000000000000000000', 'hex');

async function endpoint(): Promise<{ ep: RtcEndpoint; internals: Internals }> {
  const ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], iceLite: true, dataLayer: rawDataLayer });
  cleanups.push(() => ep.close());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { ep, internals: ep as unknown as Internals };
}

describe('RtcEndpoint: a session whose datagrams keep throwing', () => {
  it('is closed with reason error after consecutive failures; another session is untouched', async () => {
    const { ep, internals } = await endpoint();
    const bad = await validatedSession(ep);
    const good = await validatedSession(ep);
    internals.byUfrag.get(bad.ufrag)!.handleDtls = () => {
      throw new RangeError('offset out of range');
    };
    let goodPackets = 0;
    internals.byUfrag.get(good.ufrag)!.handleDtls = () => {
      goodPackets++;
    };
    for (let i = 0; i < 4; i++) {
      internals.onPacket(internals.ios[0], DTLS, '127.0.0.1', bad.port);
      internals.onPacket(internals.ios[0], DTLS, '127.0.0.1', good.port);
    }
    expect(bad.closed).toEqual([]);
    internals.onPacket(internals.ios[0], DTLS, '127.0.0.1', bad.port);
    expect(bad.closed).toEqual(['error']);
    expect(internals.byUfrag.has(bad.ufrag)).toBe(false);
    expect(ep.stats().packetErrors).toBe(5);
    // its source no longer reaches anything
    internals.onPacket(internals.ios[0], DTLS, '127.0.0.1', bad.port);
    expect(ep.stats().packetErrors).toBe(5);
    expect(good.closed).toEqual([]);
    expect(internals.byUfrag.has(good.ufrag)).toBe(true);
    internals.onPacket(internals.ios[0], DTLS, '127.0.0.1', good.port);
    expect(goodPackets).toBe(5);
  });

  it('a datagram processed normally resets the count', async () => {
    const { ep, internals } = await endpoint();
    const s = await validatedSession(ep);
    let fail = true;
    internals.byUfrag.get(s.ufrag)!.handleDtls = () => {
      if (fail) throw new Error('flaky');
    };
    for (let round = 0; round < 3; round++) {
      fail = true;
      for (let i = 0; i < 4; i++) internals.onPacket(internals.ios[0], DTLS, '127.0.0.1', s.port);
      fail = false;
      internals.onPacket(internals.ios[0], DTLS, '127.0.0.1', s.port);
    }
    expect(s.closed).toEqual([]);
    expect(ep.stats().packetErrors).toBe(12);
  });

  it('a teardown step that throws still unregisters the session', async () => {
    const { ep, internals } = await endpoint();
    const s = await validatedSession(ep);
    internals.byUfrag.get(s.ufrag)!.dtls.close = () => {
      throw new Error('close failed');
    };
    expect(internals.byUfrag.has(s.ufrag)).toBe(true);
    expect(() => s.session.close()).not.toThrow();
    expect(internals.byUfrag.has(s.ufrag)).toBe(false);
  });
});
