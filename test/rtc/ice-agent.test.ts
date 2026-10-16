/**
 * Full ICE (controlled role) of haxlite-rtc: gathering helpers, our
 * connectivity checks (format, retransmission, symmetric validation,
 * authentication of responses, role-conflict retry), triggered checks for
 * peer-reflexive sources, destination policy and amplification caps, STUN
 * gathering (srflx, trickle to sessions created meanwhile, timeouts).
 * Raw UDP sockets play the browser's ICE agent.
 */
import { randomBytes } from 'node:crypto';
import dgram, { type Socket } from 'node:dgram';
import type { UdpIo } from '../../src/rtc/udp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { RtcEndpoint, rawDataLayer, type RtcSession } from '../../src/rtc/index.js';
import { formatFingerprint } from '../../src/rtc/sdp.js';
import { StunMessage, StunType, buildBindingError, buildBindingRequest, buildBindingSuccess, checkFingerprint, checkIntegrity, parseStun } from '../../src/rtc/stun.js';
import { Gatherer, candidatePriority, classifyIp, formatCandidates, hostAddresses, policyAllows, stunServers } from '../../src/rtc/gather.js';
import { IceAgent, IceScheduler, MAX_PAIRS, _pairPriority } from '../../src/rtc/ice-agent.js';
import { parseCandidate } from '../../src/rtc/sdp.js';
import { clientHelloDatagram, ecClientCert } from './dtls-helpers.js';
import { FakeStunServer } from './nat-sim.js';

const CLIENT_UFRAG = 'cLnT';
const CLIENT_PWD = 'clientpasswordclientpwd0';
const cert = ecClientCert('ice');
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

const cand = (address: string, port: number, type = 'host', prio = 2122260223) => `candidate:1 1 udp ${prio} ${address} ${port} typ ${type} generation 0`;

function answerCreds(sdp: string): { ufrag: string; pwd: string } {
  return { ufrag: /a=ice-ufrag:(\S+)/.exec(sdp)![1]!, pwd: /a=ice-pwd:(\S+)/.exec(sdp)![1]! };
}

async function udp(address = '127.0.0.1'): Promise<Socket> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, address, () => r()));
  return s;
}

/** Collects datagrams received by `s`. */
function inbox(s: Socket): { msgs: { buf: Buffer; port: number }[]; next(ms?: number): Promise<{ buf: Buffer; port: number } | null> } {
  const msgs: { buf: Buffer; port: number }[] = [];
  let waiter: ((m: { buf: Buffer; port: number }) => void) | null = null;
  s.on('message', (buf, r) => {
    const m = { buf, port: r.port };
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(m);
    } else msgs.push(m);
  });
  return {
    msgs,
    next(ms = 1000) {
      const q = msgs.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          waiter = null;
          resolve(null);
        }, ms);
        waiter = (m) => {
          clearTimeout(t);
          resolve(m);
        };
      });
    },
  };
}

function parse(buf: Buffer): StunMessage {
  const m = new StunMessage();
  expect(parseStun(buf, m)).toBe(true);
  return m;
}

describe('gathering helpers', () => {
  it('parses STUN servers from every accepted form, skipping TURN / stuns / garbage', () => {
    expect(
      stunServers([
        'stun:stun.l.google.com:19302',
        'stun:[2001:db8::1]:3478',
        'stun:example.org',
        'turn:u:p@turn.example.org:3478',
        { urls: ['stun:a.example:1000', 'turn:b.example'], username: 'u', credential: 'p' },
        { hostname: 'turn.example', port: 3478, relayType: 'TurnUdp' },
        'stuns:secure.example:5349',
        'garbage',
        'stun:stun.l.google.com:19302',
      ]),
    ).toEqual([
      { host: 'stun.l.google.com', port: 19302 },
      { host: '2001:db8::1', port: 3478 },
      { host: 'example.org', port: 3478 },
      { host: 'a.example', port: 1000 },
    ]);
  });

  it('classifies addresses and applies candidate policies like iceCandidatePolicy', () => {
    expect(['8.8.8.8', '10.1.2.3', '192.168.0.1', '172.20.0.1', '100.64.1.1', '127.0.0.1', '169.254.1.1', '224.0.0.1', '0.0.0.0'].map(classifyIp)).toEqual([
      'public',
      'private',
      'private',
      'private',
      'private',
      'loopback',
      'linklocal',
      'reserved',
      'reserved',
    ]);
    expect(['2001:db8::1', 'fd00::1', 'fe80::1', '::1', '::', 'ff02::1', '::ffff:10.0.0.1', 'host.local'].map(classifyIp)).toEqual([
      'public',
      'private',
      'linklocal',
      'loopback',
      'reserved',
      'reserved',
      'private',
      'invalid',
    ]);
    expect(policyAllows('public', '10.0.0.1', 'host')).toBe(false);
    expect(policyAllows('private', '10.0.0.1', 'host')).toBe(true);
    expect(policyAllows('private', '127.0.0.1', 'host')).toBe(false);
    expect(policyAllows('all', '127.0.0.1', 'host')).toBe(true);
    expect(policyAllows('all', '224.0.0.1', 'host')).toBe(false);
    expect(policyAllows(({ address }) => address.startsWith('10.'), '10.0.0.1', 'host')).toBe(true);
    expect(
      policyAllows(
        () => {
          throw new Error('x');
        },
        '8.8.8.8',
        'host',
      ),
    ).toBe(false);
  });

  it('formats host and srflx candidates (raddr of srflx always blanked) with RFC 8445 priorities', () => {
    expect(
      formatCandidates([
        { type: 'host', address: '203.0.113.7', port: 4000 },
        { type: 'srflx', address: '198.51.100.9', port: 5555 },
        { type: 'srflx', address: '2001:db8::9', port: 5556 },
      ]),
    ).toEqual([
      'candidate:1 1 udp 2130706431 203.0.113.7 4000 typ host generation 0',
      `candidate:2 1 udp ${candidatePriority(100, 65534)} 198.51.100.9 5555 typ srflx raddr 0.0.0.0 rport 0 generation 0`,
      `candidate:3 1 udp ${candidatePriority(100, 65533)} 2001:db8::9 5556 typ srflx raddr :: rport 0 generation 0`,
    ]);
    expect(candidatePriority(126, 65535)).toBe(2130706431);
    expect(hostAddresses(4, '127.0.0.1', 'public')).toEqual([]);
    expect(hostAddresses(4, '127.0.0.1', 'all')).toEqual(['127.0.0.1']);
    expect(hostAddresses(4, '0.0.0.0', 'all')).toContain('127.0.0.1');
    expect(hostAddresses(4, '0.0.0.0', 'public')).not.toContain('127.0.0.1');
  });

  it('a hanging DNS lookup does not keep a gathering round open', async () => {
    const sock = await udp();
    try {
      const g = new Gatherer(
        { sockets: [{ sock: sock as unknown as UdpIo /* identity only */, family: 4, bindAddress: '127.0.0.1' }], send: () => {}, now: () => Date.now(), register: () => {}, unregister: () => {} },
        { port: sock.address().port, stunServers: [{ host: 'stun.invalid', port: 3478 }], policy: 'all', timeoutMs: 200, lookup: () => new Promise(() => {}) },
      );
      const t0 = Date.now();
      g.start();
      expect(g.isGathering).toBe(true);
      await g.whenIdle();
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(g.candidateLines()).toEqual([`candidate:1 1 udp 2130706431 127.0.0.1 ${sock.address().port} typ host generation 0`]);
      g.close();
    } finally {
      sock.close();
    }
  });

  it('pair priority (we are controlled: G = remote, D = local) orders by the remote candidate', () => {
    const host = _pairPriority(candidatePriority(126, 65535));
    const srflx = _pairPriority(candidatePriority(100, 65535));
    const prflx = _pairPriority(candidatePriority(110, 65535));
    expect(host).toBeGreaterThan(prflx);
    expect(prflx).toBeGreaterThan(srflx);
  });
});

describe('RtcEndpoint full ICE (controlled agent)', () => {
  let ep: RtcEndpoint | null = null;
  const closers: (() => void)[] = [];
  afterEach(async () => {
    await ep?.close();
    ep = null;
    for (const c of closers.splice(0)) c();
  });
  const client = async (address = '127.0.0.1') => {
    const s = await udp(address);
    closers.push(() => s.close());
    return { s, box: inbox(s), port: s.address().port };
  };

  async function setup(o: Partial<Parameters<typeof RtcEndpoint.listen>[0]> = {}) {
    ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], dataLayer: rawDataLayer, ...o });
    return ep;
  }

  function expectCheck(buf: Buffer, ourUfrag: string): StunMessage {
    const m = parse(buf);
    expect(m.type).toBe(StunType.BindingRequest);
    expect(m.username()).toBe(`${CLIENT_UFRAG}:${ourUfrag}`);
    expect(checkFingerprint(m)).toBe(true);
    expect(checkIntegrity(m, Buffer.from(CLIENT_PWD))).toBe(true);
    expect(m.controlled).toBe(true);
    expect(m.controlling).toBe(false);
    expect(m.useCandidate).toBe(false);
    expect(m.priority).toBe(candidatePriority(110, 65535));
    return m;
  }

  it('sends authenticated checks to the offer candidates; a symmetric success validates the pair', async () => {
    const e = await setup();
    const c = await client();
    const s = e.createSession(offerSdp([cand('127.0.0.1', c.port)]));
    const ourUfrag = answerCreds(s.answerSdp).ufrag;
    const got = await c.box.next();
    expect(got).not.toBeNull();
    const m = expectCheck(got!.buf, ourUfrag);
    expect(got!.port).toBe(e.port);
    // answer it (integrity with the client's own password, as the browser does)
    c.s.send(buildBindingSuccess(m.transactionId(), '127.0.0.1', e.port, Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
    await sleep(50);
    expect(s.state).toBe('connecting');
    expect(s.remoteAddress).toEqual({ address: '127.0.0.1', port: c.port });
    expect(e.stats().ice.checksSucceeded).toBe(1);
    expect(e.stats().stunResponses).toBe(1);
    // DTLS from the validated address now reaches the session (not counted as unknown source)
    c.s.send(Buffer.from('16fefd000000000000000000000000', 'hex'), e.port, '127.0.0.1');
    await sleep(30);
    expect(e.stats().dtlsUnknownSource).toBe(0);
  });

  it('retransmits an unanswered check (bounded) and then gives up', async () => {
    const e = await setup();
    const c = await client();
    e.createSession(offerSdp([cand('127.0.0.1', c.port)]));
    await sleep(3800); // 0, 200, 600, 1400, 3000 ms → fails at 6.2 s
    const txids = new Set(c.box.msgs.map((x) => x.buf.subarray(8, 20).toString('hex')));
    expect(c.box.msgs.length).toBe(5);
    expect(txids.size).toBe(1); // same transaction
    await sleep(3000);
    expect(c.box.msgs.length).toBe(5);
    expect(e.stats().ice.checksFailed).toBe(1);
  }, 15_000);

  it('ignores forged (unauthenticated) responses and fails non-symmetric ones', async () => {
    const e = await setup();
    const c = await client();
    const other = await client();
    const s = e.createSession(offerSdp([cand('127.0.0.1', c.port)]));
    const m = parse((await c.box.next())!.buf);
    // wrong key: ignored, the check stays in progress
    c.s.send(buildBindingSuccess(m.transactionId(), '127.0.0.1', e.port, Buffer.from('x'.repeat(24))), e.port, '127.0.0.1');
    await sleep(30);
    expect(s.state).toBe('new');
    expect(e.stats().ice.checksSucceeded).toBe(0);
    // authentic but from another port: non-symmetric → failed, nothing validated
    other.s.send(buildBindingSuccess(m.transactionId(), '127.0.0.1', e.port, Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
    await sleep(30);
    expect(s.state).toBe('new');
    expect(s.remoteAddress).toBeNull();
    expect(e.stats().ice.checksFailed).toBe(1);
  });

  it('487 Role Conflict to our check: we stay controlled and retry (triggered)', async () => {
    const e = await setup();
    const c = await client();
    e.createSession(offerSdp([cand('127.0.0.1', c.port)]));
    const m1 = parse((await c.box.next())!.buf);
    c.s.send(buildBindingError(m1.transactionId(), 487, 'Role Conflict', Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
    const r2 = await c.box.next(500);
    expect(r2).not.toBeNull();
    const m2 = parse(r2!.buf);
    expect(Buffer.from(m2.transactionId())).not.toEqual(Buffer.from(m1.transactionId()));
    expect(m2.controlled).toBe(true);
  });

  it('authenticated request from an unknown source: success response + triggered check back (peer-reflexive)', async () => {
    const e = await setup();
    const s = e.createSession(offerSdp());
    const creds = answerCreds(s.answerSdp);
    const c = await client();
    c.s.send(
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695 }),
      e.port,
      '127.0.0.1',
    );
    const first = parse((await c.box.next())!.buf);
    expect(first.type).toBe(StunType.BindingSuccess);
    const trig = await c.box.next();
    expect(trig).not.toBeNull();
    expectCheck(trig!.buf, creds.ufrag);
    // a second request on the same pair (check in progress) retransmits that check at once
    // (RFC 8445 §7.3.1.4: same transaction, no new one), then nothing until its RTO
    c.s.send(
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695 }),
      e.port,
      '127.0.0.1',
    );
    expect(parse((await c.box.next())!.buf).type).toBe(StunType.BindingSuccess);
    const re = await c.box.next(100);
    expect(re).not.toBeNull();
    expect(re!.buf.subarray(8, 20)).toEqual(trig!.buf.subarray(8, 20));
    expect(await c.box.next(150)).toBeNull();
  });

  it('only checks addresses the policy allows (no LAN/loopback/multicast/mDNS probing from a crafted offer)', async () => {
    // wildcard bind + explicit public address: loopback and private remote candidates are not ours to probe
    const e = await setup({ address: '0.0.0.0', publicAddresses: ['203.0.113.7'] });
    const c = await client();
    e.createSession(
      offerSdp([
        cand('127.0.0.1', c.port),
        cand('10.0.0.5', 9999),
        cand('192.168.1.10', 9999),
        cand('224.0.0.251', 5353),
        cand('0.0.0.0', 9),
        cand('abcd-1234.local', 5000),
        'candidate:1 1 tcp 2122260223 8.8.8.8 9 typ host tcptype active',
        cand('8.8.8.8', 0),
      ]),
    );
    await sleep(100);
    expect(c.box.msgs.length).toBe(0);
    expect(e.stats().ice.remoteIgnored).toBe(8);
    expect(e.stats().ice.checksSent).toBe(0);
  });

  it('caps pairs and transmissions per session (amplification bound)', async () => {
    const e = await setup();
    const socks = await Promise.all(Array.from({ length: 24 }, () => client()));
    const s: RtcSession = e.createSession(offerSdp(socks.slice(0, 20).map((x) => cand('127.0.0.1', x.port))));
    for (const x of socks.slice(20)) s.addRemoteCandidate(cand('127.0.0.1', x.port));
    await sleep(7000);
    const counts = socks.map((x) => x.box.msgs.length);
    const total = counts.reduce((a, b) => a + b, 0);
    expect(counts.filter((n) => n > 0).length).toBe(MAX_PAIRS);
    expect(Math.max(...counts)).toBeLessThanOrEqual(5);
    expect(total).toBeLessThanOrEqual(120);
    expect(e.stats().ice.remoteIgnored).toBe(24 - MAX_PAIRS);
  }, 15_000);

  it('spoofed source: an authenticated request + USE-CANDIDATE validates nothing and gets no DTLS until our check there succeeds', async () => {
    // `victim` plays a spoofed source: a request with valid MESSAGE-INTEGRITY (any joining client
    // knows our password from its answer) arrives "from" it, but it never answers our checks.
    const e = await setup();
    const s = e.createSession(offerSdp());
    const creds = answerCreds(s.answerSdp);
    const victim = await client();
    const req = () =>
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695, useCandidate: true });
    victim.s.send(req(), e.port, '127.0.0.1');
    expect(parse((await victim.box.next())!.buf).type).toBe(StunType.BindingSuccess); // answered (no amplification)
    const check = parse((await victim.box.next())!.buf); // our triggered check
    expect(check.type).toBe(StunType.BindingRequest);
    expect(s.state).toBe('new');
    expect(s.remoteAddress).toBeNull(); // neither validated nor nominated
    const demux = (e as unknown as { byAddress: Map<string, unknown> }).byAddress;
    expect(demux.size).toBe(0);
    // a ClientHello "from" it: held, not answered (flight 4 would be ~1 KB, retransmitted)
    victim.s.send(clientHelloDatagram().datagram, e.port, '127.0.0.1');
    victim.s.send(req(), e.port, '127.0.0.1'); // a renewed request does not change that
    await sleep(1500);
    const dtls = () => victim.box.msgs.filter((m) => m.buf[0]! >= 20 && m.buf[0]! <= 63);
    expect(dtls()).toEqual([]);
    expect(e.stats().dtlsHeld).toBe(1);
    expect(e.stats().handshakesCompleted + e.stats().handshakesFailed).toBe(0);
    expect(s.state).toBe('new');
    // the real owner of the address answers our check (retransmitted at its request): proven → nominated,
    // the held ClientHello is answered
    victim.box.msgs.length = 0;
    victim.s.send(req(), e.port, '127.0.0.1');
    let retx: StunMessage | null = null;
    for (let i = 0; i < 5 && retx === null; i++) {
      const m = await victim.box.next(1000);
      if (m !== null && m.buf[0]! < 4) {
        const p = parse(m.buf);
        if (p.type === StunType.BindingRequest) retx = p;
      }
    }
    expect(retx).not.toBeNull();
    victim.s.send(buildBindingSuccess(retx!.transactionId(), '127.0.0.1', e.port, Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
    await sleep(100);
    expect(s.state).toBe('connecting');
    expect(s.remoteAddress).toEqual({ address: '127.0.0.1', port: victim.port });
    expect(dtls().length).toBeGreaterThan(0); // flight 4 now, to the proven address
    expect(e.stats().dtlsUnknownSource).toBe(0);
    s.close();
  }, 15_000);

  it('a request from an unproven address cannot steal a proven 5-tuple or move the nomination there', async () => {
    const e = await setup();
    const a = await client();
    const spoofed = await client();
    const s = e.createSession(offerSdp([cand('127.0.0.1', a.port)]));
    const creds = answerCreds(s.answerSdp);
    const m = parse((await a.box.next())!.buf);
    a.s.send(buildBindingSuccess(m.transactionId(), '127.0.0.1', e.port, Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
    await sleep(30);
    const req = () =>
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695, useCandidate: true });
    a.s.send(req(), e.port, '127.0.0.1');
    await sleep(30);
    expect(s.remoteAddress).toEqual({ address: '127.0.0.1', port: a.port }); // proven + nominated at once
    spoofed.s.send(req(), e.port, '127.0.0.1');
    await sleep(100);
    expect(s.remoteAddress).toEqual({ address: '127.0.0.1', port: a.port }); // nomination stays on the proven pair
    // DTLS "from" the unproven source never reaches the DTLS server
    spoofed.s.send(clientHelloDatagram().datagram, e.port, '127.0.0.1');
    await sleep(100);
    expect(spoofed.box.msgs.filter((x) => x.buf[0]! >= 20 && x.buf[0]! <= 63)).toEqual([]);
    // once the check to it succeeds, the pending USE-CANDIDATE takes effect (RFC 8445 §7.3.1.5: rebinding)
    const check = spoofed.box.msgs.map((x) => parse(x.buf)).find((x) => x.type === StunType.BindingRequest)!;
    spoofed.s.send(buildBindingSuccess(check.transactionId(), '127.0.0.1', e.port, Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
    await sleep(50);
    expect(s.remoteAddress).toEqual({ address: '127.0.0.1', port: spoofed.port });
  });

  it('held DTLS from an address whose check fails is released (slots and hold registration); holds also expire', async () => {
    const e = await setup();
    const s = e.createSession(offerSdp());
    const creds = answerCreds(s.answerSdp);
    const victim = await client(); // never answers our checks
    victim.s.send(
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695 }),
      e.port,
      '127.0.0.1',
    );
    await sleep(50);
    victim.s.send(clientHelloDatagram().datagram, e.port, '127.0.0.1');
    await sleep(50);
    const impl = s as unknown as { held: unknown[] | null; holdKeys: string[]; holdDtls(m: Buffer, sock: unknown, a: string, p: number): boolean; checkTimers(now: number, h: number, i: number): void };
    const holds = (e as unknown as { holds: Map<string, unknown> }).holds;
    expect(e.stats().dtlsHeld).toBe(1);
    expect(impl.held?.length).toBe(1);
    expect(impl.holdKeys).toEqual([`127.0.0.1|${victim.port}`]);
    await sleep(6500); // 0, 200, 600, 1400, 3000 → failed at 6.2 s
    expect(e.stats().ice.checksFailed).toBe(1);
    expect(impl.held).toBeNull();
    expect(impl.holdKeys).toEqual([]);
    expect(holds.size).toBe(0);
    // expiry: a datagram held longer than a few seconds is dropped by the sweep, and frees its slot
    const sock = (e as unknown as { ios: unknown[] }).ios[0];
    for (let i = 0; i < 4; i++) expect(impl.holdDtls(Buffer.alloc(100, 22), sock, '127.0.0.1', 40000 + i)).toBe(true);
    expect(impl.holdDtls(Buffer.alloc(100, 22), sock, '127.0.0.1', 40010)).toBe(false); // full
    impl.checkTimers(Date.now() + 5500, 1e9, 1e9);
    expect(impl.held).toBeNull();
    expect(impl.holdDtls(Buffer.alloc(100, 22), sock, '127.0.0.1', 40010)).toBe(true);
    s.close();
  }, 15_000);

  it('evicting a validated address for capacity: no re-check churn, and never the handshake address', async () => {
    const e = await setup();
    // clients that answer every check of ours
    const responders = await Promise.all(Array.from({ length: 11 }, () => client()));
    const checksTo = new Map<number, number>();
    for (const r of responders) {
      r.s.on('message', (buf) => {
        if (buf[0]! >= 4) return;
        const m = parse(buf);
        if (m.type !== StunType.BindingRequest) return;
        checksTo.set(r.port, (checksTo.get(r.port) ?? 0) + 1);
        r.s.send(buildBindingSuccess(m.transactionId(), '127.0.0.1', e.port, Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
      });
    }
    const [a, ...rest] = responders;
    const s = e.createSession(offerSdp([cand('127.0.0.1', a!.port)]));
    await sleep(100);
    expect(s.remoteAddress).toEqual({ address: '127.0.0.1', port: a!.port });
    // the handshake starts from `a`: it is the address of the flights
    a!.s.send(clientHelloDatagram().datagram, e.port, '127.0.0.1');
    await sleep(50);
    const impl = s as unknown as { validated: { port: number }[]; dtlsFrom: { port: number } | null };
    expect(impl.dtlsFrom?.port).toBe(a!.port);
    // ten more validated addresses: two evictions (cap 8), never `a`
    for (const r of rest) s.addRemoteCandidate(cand('127.0.0.1', r.port));
    await sleep(1500);
    expect(e.stats().ice.checksSucceeded).toBe(11);
    expect(impl.validated.length).toBe(8);
    expect(impl.validated.some((v) => v.port === a!.port)).toBe(true);
    expect(impl.dtlsFrom?.port).toBe(a!.port);
    // each address was checked once: the evicted ones are not re-checked by the ordinary loop
    for (const r of responders) expect(checksTo.get(r.port)).toBe(1);
    // ...but a new request from an evicted one triggers a check (and validates it again)
    const creds = answerCreds(s.answerSdp);
    const evicted = rest.find((r) => !impl.validated.some((v) => v.port === r.port))!;
    expect(evicted).toBeDefined();
    evicted.s.send(
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695 }),
      e.port,
      '127.0.0.1',
    );
    await sleep(150);
    expect(checksTo.get(evicted.port)).toBe(2);
    expect(impl.validated.some((v) => v.port === evicted.port)).toBe(true);
    expect(impl.dtlsFrom?.port).toBe(a!.port);
    s.close();
  });

  it('a request from a new address when the check list is full still gets a check (peer-reflexive replaces a waiting pair)', async () => {
    const e = await setup();
    const dead = await Promise.all(Array.from({ length: MAX_PAIRS }, () => client()));
    const s = e.createSession(offerSdp(dead.map((x) => cand('127.0.0.1', x.port))));
    const creds = answerCreds(s.answerSdp);
    const real = await client();
    real.s.send(
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), priority: 1845501695, useCandidate: true }),
      e.port,
      '127.0.0.1',
    );
    expect(parse((await real.box.next())!.buf).type).toBe(StunType.BindingSuccess);
    const check = await real.box.next(500);
    expect(check).not.toBeNull();
    const m = expectCheck(check!.buf, creds.ufrag);
    const agent = (s as unknown as { agent: IceAgent }).agent;
    expect(agent.describe().length).toBe(MAX_PAIRS);
    expect(agent.describe().some((p) => p.port === real.port)).toBe(true);
    real.s.send(buildBindingSuccess(m.transactionId(), '127.0.0.1', e.port, Buffer.from(CLIENT_PWD)), e.port, '127.0.0.1');
    await sleep(50);
    expect(s.remoteAddress).toEqual({ address: '127.0.0.1', port: real.port }); // validated and nominated
    s.close();
  });

  it('ICE-lite sends no checks at all', async () => {
    const e = await setup({ iceLite: true });
    const c = await client();
    const s = e.createSession(offerSdp([cand('127.0.0.1', c.port)]));
    expect(s.answerSdp).toContain('a=ice-lite');
    await sleep(300);
    expect(c.box.msgs.length).toBe(0);
  });

  it('gathers srflx from STUN; sessions created meanwhile get it trickled, later ones in the answer', async () => {
    const stun = await FakeStunServer.start('127.0.0.1');
    closers.push(() => stun.close());
    const e = await setup({ publicAddresses: undefined, iceServers: [stun.url], candidatePolicy: 'public' });
    // created while the first round runs (it started at listen)
    const s1 = e.createSession(offerSdp());
    expect(s1.gatheringComplete).toBe(false);
    expect(s1.answerSdp).not.toContain('a=end-of-candidates');
    const trickled: string[] = [];
    s1.onLocalCandidate = (c) => trickled.push(c);
    const done = new Promise<void>((r) => (s1.onGatheringComplete = r));
    await done;
    expect(trickled).toEqual([`candidate:1 1 udp ${candidatePriority(100, 65535)} 127.0.0.1 ${e.port} typ srflx raddr 0.0.0.0 rport 0 generation 0`]);
    expect(s1.localCandidates).toEqual(trickled);
    expect(e.reflexiveAddresses).toEqual([{ address: '127.0.0.1', port: e.port }]);
    expect(e.stats().reflexive).toEqual([`127.0.0.1:${e.port}`]);
    // fresh result: the next session has it in its answer, complete at once (no extra STUN query)
    const before = stun.requests;
    const s2 = e.createSession(offerSdp());
    expect(s2.gatheringComplete).toBe(true);
    expect(s2.answerSdp).toContain(`127.0.0.1 ${e.port} typ srflx raddr 0.0.0.0 rport 0`);
    expect(s2.answerSdp).toContain('a=end-of-candidates');
    expect(stun.requests).toBe(before);
  });

  it('an unreachable STUN server: gathering completes after its timeout without srflx', async () => {
    const dead = await udp(); // never answers
    closers.push(() => dead.close());
    const e = await setup({ publicAddresses: undefined, iceServers: [`stun:127.0.0.1:${dead.address().port}`] });
    const s = e.createSession(offerSdp());
    expect(s.gatheringComplete).toBe(false);
    const t0 = Date.now();
    await new Promise<void>((r) => (s.onGatheringComplete = r));
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(s.localCandidates).toEqual([]);
    expect(s.answerSdp).toContain('m=application 9 ');
  });

  it('refreshes a stale srflx at the next session (gatherRefreshMs)', async () => {
    const stun = await FakeStunServer.start('127.0.0.1');
    closers.push(() => stun.close());
    const e = await setup({ publicAddresses: undefined, iceServers: [stun.url], gatherRefreshMs: 100 });
    await e.whenGathered();
    const n = stun.requests;
    expect(n).toBeGreaterThan(0);
    await sleep(150);
    const s = e.createSession(offerSdp());
    // the cached result is in the answer at once; the refresh runs in the background
    expect(e.refreshingCandidates).toBe(true);
    expect(s.answerSdp).toContain(`127.0.0.1 ${e.port} typ srflx raddr 0.0.0.0 rport 0`);
    expect(s.gatheringComplete).toBe(false); // a changed srflx would be trickled
    const trickled: string[] = [];
    s.onLocalCandidate = (c) => trickled.push(c);
    const done = new Promise<void>((r) => (s.onGatheringComplete = r));
    await e.whenGathered();
    await done;
    expect(trickled).toEqual([]); // same reflexive address: nothing new
    expect(e.refreshingCandidates).toBe(false);
    expect(stun.requests).toBeGreaterThan(n);
  });

  it('a refresh that finds a different srflx trickles it to the sessions answered meanwhile', async () => {
    const stun = await FakeStunServer.start('127.0.0.1');
    closers.push(() => stun.close());
    const e = await setup({ publicAddresses: undefined, iceServers: [stun.url], gatherRefreshMs: 100 });
    await e.whenGathered();
    await sleep(150);
    stun.portOffset = 7; // the NAT's mapping changed
    const oldSrflx = `candidate:1 1 udp ${candidatePriority(100, 65535)} 127.0.0.1 ${e.port} typ srflx raddr 0.0.0.0 rport 0 generation 0`;
    const s1 = e.createSession(offerSdp()); // starts the refresh
    const s2 = e.createSession(offerSdp()); // while it runs
    const got = new Map<RtcSession, string[]>();
    const done: Promise<void>[] = [];
    for (const s of [s1, s2]) {
      expect(s.localCandidates).toEqual([oldSrflx]); // answered at once with the previous result
      expect(s.answerSdp).toContain(oldSrflx);
      expect(s.answerSdp).not.toContain('a=end-of-candidates');
      got.set(s, []);
      s.onLocalCandidate = (c) => got.get(s)!.push(c);
      done.push(new Promise<void>((r) => (s.onGatheringComplete = r)));
    }
    await Promise.all(done);
    const newSrflx = `candidate:1 1 udp ${candidatePriority(100, 65535)} 127.0.0.1 ${e.port + 7} typ srflx raddr 0.0.0.0 rport 0 generation 0`;
    expect(got.get(s1)).toEqual([newSrflx]);
    expect(got.get(s2)).toEqual([newSrflx]);
    // later sessions get the new one in the answer, complete
    const s3 = e.createSession(offerSdp());
    expect(s3.gatheringComplete).toBe(true);
    expect(s3.localCandidates).toEqual([newSrflx]);
  });

  it('a stale result whose refresh gets no reply: sessions answer at once with the cached srflx, completed by the timeout', async () => {
    const stun = await FakeStunServer.start('127.0.0.1');
    closers.push(() => stun.close());
    const e = await setup({ publicAddresses: undefined, iceServers: [stun.url], gatherRefreshMs: 100 });
    await e.whenGathered();
    await sleep(150);
    stun.silent = true;
    const n = stun.requests;
    const srflx = `127.0.0.1 ${e.port} typ srflx raddr 0.0.0.0 rport 0`;
    const s1 = e.createSession(offerSdp()); // starts the refresh
    const s2 = e.createSession(offerSdp()); // while the refresh runs
    for (const s of [s1, s2]) {
      expect(s.gatheringComplete).toBe(false);
      expect(s.answerSdp).toContain(srflx);
      expect(s.answerSdp).not.toContain('a=end-of-candidates');
    }
    let late = 0;
    let completed = 0;
    s1.onLocalCandidate = () => late++;
    s1.onGatheringComplete = () => completed++;
    await sleep(50);
    expect(stun.requests).toBeGreaterThan(n); // the refresh did go out
    await e.whenGathered(); // times out without a reply
    expect(late).toBe(0); // nothing new to trickle
    expect(completed).toBe(1);
    expect(s1.gatheringComplete).toBe(true);
    // the lost reply keeps the previous srflx
    expect(e.createSession(offerSdp()).answerSdp).toContain(srflx);
  });
});

describe('IceAgent (manual clock)', () => {
  const CHECK_TIMEOUT = 6200;
  function harness() {
    let t = 1_000_000;
    const sock = { tag: 'sock' } as unknown as UdpIo;
    const sent: { address: string; port: number; buf: Buffer }[] = [];
    const sched = new IceScheduler({
      send: (_s, buf, address, port) => sent.push({ address, port, buf: Buffer.from(buf) }),
      now: () => t,
      sockets: [{ sock, family: 4, bindAddress: '0.0.0.0' }],
      policy: 'public',
    });
    const failed: number[] = [];
    const agent = new IceAgent(sched, {
      localUfrag: 'ours',
      remoteUfrag: CLIENT_UFRAG,
      remoteKey: Buffer.from(CLIENT_PWD),
      onCheckSucceeded() {},
      onConsent() {},
      onCheckFailed(_s, _a, port) {
        failed.push(port);
      },
    });
    const run = (ms: number) => {
      for (let i = 0; i < ms; i += 20) {
        t += 20;
        agent.tick(t);
      }
    };
    return { sock, sent, sched, agent, failed, run, now: () => t };
  }

  it('full check list: a peer-reflexive address replaces a failed signaled pair, never an in-progress one', () => {
    const h = harness();
    try {
      for (let i = 0; i < MAX_PAIRS; i++) h.agent.addRemote(parseCandidate(cand(`198.51.100.${i + 1}`, 5000))!);
      h.run(400); // all 16 checks in progress
      expect(h.agent.describe().every((p) => p.state === 'in-progress')).toBe(true);
      h.agent.onRequest(h.sock, '203.0.113.9', 6000, 1845501695);
      expect(h.agent.describe().some((p) => p.port === 6000)).toBe(false); // nothing replaceable
      h.run(CHECK_TIMEOUT + 200);
      expect(h.agent.describe().every((p) => p.state === 'failed')).toBe(true);
      expect(h.failed.length).toBe(MAX_PAIRS); // the owner is told of every failure
      h.sent.length = 0;
      h.agent.onRequest(h.sock, '203.0.113.9', 6000, 1845501695);
      const pairs = h.agent.describe();
      expect(pairs.length).toBe(MAX_PAIRS);
      expect(pairs.some((p) => p.address === '198.51.100.16')).toBe(false); // the lowest-priority failed one went
      h.run(40);
      expect(h.sent.map((x) => x.port)).toEqual([6000]); // triggered check to the new address
    } finally {
      h.agent.close();
      h.sched.close();
    }
  });

  it('a parked (capacity-evicted) pair is not re-checked by the ordinary loop, only after a request', () => {
    const h = harness();
    try {
      h.agent.addRemote(parseCandidate(cand('198.51.100.1', 5000))!);
      h.run(40);
      expect(h.sent.length).toBe(1);
      const m = parse(h.sent[0]!.buf);
      // a symmetric authenticated success
      h.sched.onResponse(parse(buildBindingSuccess(m.transactionId(), '192.0.2.1', 3478, Buffer.from(CLIENT_PWD))), h.sock, '198.51.100.1', 5000);
      expect(h.agent.describe()[0]!.state).toBe('succeeded');
      h.agent.park(h.sock, '198.51.100.1', 5000);
      h.sent.length = 0;
      h.run(1000);
      expect(h.sent.length).toBe(0);
      h.agent.onRequest(h.sock, '198.51.100.1', 5000, 1845501695);
      h.run(40);
      expect(h.sent.length).toBe(1);
    } finally {
      h.agent.close();
      h.sched.close();
    }
  });

  it('after connecting, triggered checks use a refilling allowance (the lifetime budget no longer blocks rebindings)', () => {
    const h = harness();
    try {
      (h.agent as unknown as { sentTotal: number }).sentTotal = 1000; // pre-connection budget long spent
      h.agent.connected(h.now());
      // a NAT rebinding: a request from a new address must be checked
      h.agent.onRequest(h.sock, '203.0.113.50', 7000, 1845501695);
      h.run(40);
      expect(h.sent.map((x) => x.port)).toEqual([7000]);
      // a flood of new sources is rate-limited: burst 10, then ~4 transmissions per second
      for (let i = 0; i < 40; i++) h.agent.onRequest(h.sock, `203.0.113.${100 + i}`, 7000, 1845501695);
      h.run(1000);
      expect(h.sent.length).toBeGreaterThan(10);
      expect(h.sent.length).toBeLessThanOrEqual(10 + 4 + 1);
      h.run(5000);
      expect(h.sent.length).toBeLessThanOrEqual(10 + 4 * 6 + 1);
      expect(h.sent.length).toBeGreaterThan(20);
      // once those checks are over and the allowance refilled, a later rebinding is checked at once again
      h.run(40000);
      h.sent.length = 0;
      h.agent.onRequest(h.sock, '203.0.113.51', 7001, 1845501695);
      h.run(20);
      expect(h.sent.some((x) => x.port === 7001)).toBe(true);
    } finally {
      h.agent.close();
      h.sched.close();
    }
  });
});
