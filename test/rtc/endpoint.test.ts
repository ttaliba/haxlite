/**
 * RtcEndpoint: ICE-lite Binding handling (authentication, roles,
 * nomination, rebinding, consent), demultiplexing, timeouts, and a full
 * ICE + DTLS run with `openssl s_client` behind a UDP relay that plays the
 * browser's ICE agent.
 */
import { randomBytes } from 'node:crypto';
import dgram, { type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { RtcEndpoint, rawDataLayer, type RtcSession } from '../../src/rtc/index.js';
import { formatFingerprint } from '../../src/rtc/sdp.js';
import { StunAttr, StunMessage, buildBindingRequest, checkFingerprint, checkIntegrity, findAttr, parseStun, readXorAddress } from '../../src/rtc/stun.js';
import { ecClientCert, hasOpenssl } from './dtls-helpers.js';

const CLIENT_UFRAG = 'cLnT';
const CLIENT_PWD = 'clientpasswordclientpwd0';

function offerSdp(fingerprint: Uint8Array): string {
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
    `a=fingerprint:sha-256 ${formatFingerprint(fingerprint)}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}

function answerCreds(sdp: string): { ufrag: string; pwd: string } {
  return { ufrag: /a=ice-ufrag:(\S+)/.exec(sdp)![1]!, pwd: /a=ice-pwd:(\S+)/.exec(sdp)![1]! };
}

async function udp(): Promise<Socket> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  return s;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ipv6Available = await new Promise<boolean>((resolve) => {
  const s = dgram.createSocket({ type: 'udp6', ipv6Only: true });
  s.on('error', () => resolve(false));
  s.bind(0, '::1', () => {
    s.close();
    resolve(true);
  });
});

describe('RtcEndpoint ICE-lite', () => {
  let ep: RtcEndpoint | null = null;
  const sockets: Socket[] = [];
  afterEach(async () => {
    await ep?.close();
    ep = null;
    for (const s of sockets.splice(0)) s.close();
  });
  const client = async () => {
    const s = await udp();
    sockets.push(s);
    return s;
  };
  const cert = ecClientCert('ep');

  async function setup(opts: { idleTimeoutMs?: number; handshakeTimeoutMs?: number } = {}) {
    ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], dataLayer: rawDataLayer, ...opts });
    const session = ep.createSession(offerSdp(cert.sha256));
    return { ep, session, creds: answerCreds(session.answerSdp) };
  }

  function binding(creds: { ufrag: string; pwd: string }, o: Partial<Parameters<typeof buildBindingRequest>[0]> = {}) {
    return buildBindingRequest({
      txid: randomBytes(12),
      username: `${creds.ufrag}:${CLIENT_UFRAG}`,
      key: Buffer.from(creds.pwd),
      priority: 1845501695,
      ...o,
    });
  }

  it('answers an authenticated Binding request with XOR-MAPPED-ADDRESS, integrity and fingerprint', async () => {
    const { ep, session, creds } = await setup();
    const c = await client();
    const req = binding(creds);
    c.send(req, ep.port, '127.0.0.1');
    const res = await nextMessage(c);
    expect(res).not.toBeNull();
    const m = new StunMessage();
    expect(parseStun(res!, m)).toBe(true);
    expect(m.type).toBe(0x0101);
    expect(Buffer.from(m.transactionId())).toEqual(req.subarray(8, 20));
    expect(checkIntegrity(m, Buffer.from(creds.pwd))).toBe(true);
    expect(checkFingerprint(m)).toBe(true);
    expect(readXorAddress(res!, findAttr(m, StunAttr.XorMappedAddress), m.transactionId())).toEqual({
      address: '127.0.0.1',
      port: c.address().port,
    });
    expect(session.state).toBe('connecting');
    expect(session.remoteAddress).toEqual({ address: '127.0.0.1', port: c.address().port });
    expect(ep.stats().stunAuthenticated).toBe(1);
  });

  it('ignores bad MESSAGE-INTEGRITY, wrong usernames, missing FINGERPRINT and unknown ufrags', async () => {
    const { ep, session, creds } = await setup();
    const c = await client();
    const send = async (b: Buffer) => {
      c.send(b, ep.port, '127.0.0.1');
      return nextMessage(c, 200);
    };
    expect(await send(binding(creds, { key: Buffer.from('x'.repeat(24)) }))).toBeNull(); // wrong key
    const tampered = binding(creds);
    tampered[tampered.length - 30] = tampered[tampered.length - 30]! ^ 1; // inside the HMAC
    expect(await send(tampered)).toBeNull();
    expect(await send(binding(creds, { username: `${creds.ufrag}:other` }))).toBeNull(); // wrong remote ufrag
    expect(await send(binding({ ufrag: 'zzzzzzzz', pwd: creds.pwd }))).toBeNull(); // unknown session
    const noFp = binding(creds);
    const noFpCut = Buffer.from(noFp.subarray(0, noFp.length - 8));
    noFpCut.writeUInt16BE(noFpCut.length - 20, 2);
    expect(await send(noFpCut)).toBeNull();
    expect(await send(binding(creds, { controlling: false }))).toBeNull(); // no role attribute
    expect(session.state).toBe('new');
    expect(session.remoteAddress).toBeNull();
    expect(ep.stats().stunRejected).toBe(6);
    // nothing validated: DTLS from this address is dropped
    c.send(Buffer.from('16fefd000000000000000000000000', 'hex'), ep.port, '127.0.0.1');
    await sleep(50);
    expect(ep.stats().dtlsUnknownSource).toBe(1);
  });

  it('answers ICE-CONTROLLED with 487 Role Conflict (we are lite = controlled)', async () => {
    const { ep, session, creds } = await setup();
    const c = await client();
    c.send(binding(creds, { controlled: true }), ep.port, '127.0.0.1');
    const res = await nextMessage(c);
    const m = new StunMessage();
    expect(parseStun(res!, m)).toBe(true);
    expect(m.type).toBe(0x0111);
    const v = findAttr(m, StunAttr.ErrorCode);
    expect(res![v + 2]! * 100 + res![v + 3]!).toBe(487);
    expect(session.state).toBe('new');
  });

  it('USE-CANDIDATE nominates; NAT rebinding only through an authenticated binding', async () => {
    const { ep, session, creds } = await setup();
    const a = await client();
    const b = await client();
    a.send(binding(creds, { useCandidate: true }), ep.port, '127.0.0.1');
    await nextMessage(a);
    expect(session.remoteAddress?.port).toBe(a.address().port);
    // unauthenticated traffic from b changes nothing
    b.send(binding(creds, { useCandidate: true, key: Buffer.from('bad'.repeat(8)) }), ep.port, '127.0.0.1');
    b.send(Buffer.from('16fefd000000000000000000000000', 'hex'), ep.port, '127.0.0.1');
    await sleep(50);
    expect(session.remoteAddress?.port).toBe(a.address().port);
    // authenticated + USE-CANDIDATE from b: the pair moves (rebinding)
    b.send(binding(creds, { useCandidate: true }), ep.port, '127.0.0.1');
    expect(await nextMessage(b)).not.toBeNull();
    expect(session.remoteAddress?.port).toBe(b.address().port);
  });

  it('closes sessions that never connect (handshake timeout)', async () => {
    const { session } = await setup({ handshakeTimeoutMs: 300 });
    const reason = await new Promise<string>((r) => (session.onClose = r));
    expect(reason).toBe('handshake-timeout');
    expect(session.state).toBe('closed');
    expect(ep!.stats().sessions).toBe(0);
  });

  it('only advertises the configured public addresses', async () => {
    ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['203.0.113.9'], dataLayer: rawDataLayer });
    const s = ep.createSession(offerSdp(cert.sha256));
    const ips = new Set(s.answerSdp.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g));
    expect(ips).toEqual(new Set(['0.0.0.0', '203.0.113.9']));
    expect(s.localCandidates).toEqual([`candidate:1 1 udp 2130706431 203.0.113.9 ${ep.port} typ host generation 0`]);
    // full ICE by default (no a=ice-lite); iceLite: true restores the lite answer
    expect(s.answerSdp).not.toContain('a=ice-lite');
    expect(s.answerSdp).toContain('a=end-of-candidates');
    expect(s.answerSdp).toContain(`a=fingerprint:sha-256 ${formatFingerprint(ep.certificate.fingerprint)}`);
    await ep.close();
    ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['203.0.113.9'], iceLite: true, dataLayer: rawDataLayer });
    const lite = ep.createSession(offerSdp(cert.sha256));
    expect(lite.answerSdp).toContain('a=ice-lite');
    expect(lite.localCandidates).toEqual([`candidate:1 1 udp 2130706431 203.0.113.9 ${ep.port} typ host generation 0`]);
  });

  it('binds the wildcard of the public family when no address is given', async () => {
    ep = await RtcEndpoint.listen({ publicAddresses: ['127.0.0.1'], dataLayer: rawDataLayer });
    const session = ep.createSession(offerSdp(cert.sha256));
    const c = await client();
    c.send(binding(answerCreds(session.answerSdp)), ep.port, '127.0.0.1');
    expect(await nextMessage(c)).not.toBeNull();
  });

  it.skipIf(!ipv6Available)('IPv6 + IPv4 on the same port', async () => {
    ep = await RtcEndpoint.listen({ publicAddresses: ['::1', '127.0.0.1'], dataLayer: rawDataLayer });
    const session = ep.createSession(offerSdp(cert.sha256));
    expect(session.answerSdp).toContain(`a=candidate:1 1 udp 2130706431 ::1 ${ep.port} typ host`);
    const c6 = dgram.createSocket({ type: 'udp6', ipv6Only: true });
    await new Promise<void>((r) => c6.bind(0, '::1', () => r()));
    sockets.push(c6);
    c6.send(binding(answerCreds(session.answerSdp), { useCandidate: true }), ep.port, '::1');
    const res = await nextMessage(c6);
    const m = new StunMessage();
    expect(parseStun(res!, m)).toBe(true);
    expect(readXorAddress(res!, findAttr(m, StunAttr.XorMappedAddress), m.transactionId()).port).toBe(c6.address().port);
    expect(session.remoteAddress?.address).toBe('::1');
  });

  it('validates options', async () => {
    await expect(RtcEndpoint.listen({ publicAddresses: [] })).rejects.toThrow();
    await expect(RtcEndpoint.listen({ publicAddresses: ['example.com'], dataLayer: rawDataLayer })).rejects.toThrow();
    await expect(RtcEndpoint.listen({ iceLite: true, dataLayer: rawDataLayer })).rejects.toThrow(/iceLite/);
  });
});

/**
 * Relay that plays the browser's ICE agent for openssl: it validates its own
 * socket with authenticated Binding requests (USE-CANDIDATE, then periodic
 * consent) and forwards DTLS between openssl and the endpoint.
 */
async function iceRelay(endpointPort: number, creds: { ufrag: string; pwd: string }, consentMs: number | null) {
  const toEp = await udp();
  const forOpenssl = await udp();
  let opensslAddr: { port: number } | null = null;
  const bind = () =>
    toEp.send(
      buildBindingRequest({ txid: randomBytes(12), username: `${creds.ufrag}:${CLIENT_UFRAG}`, key: Buffer.from(creds.pwd), useCandidate: true }),
      endpointPort,
      '127.0.0.1',
    );
  toEp.on('message', (m) => {
    if (m[0]! >= 20 && m[0]! <= 63 && opensslAddr) forOpenssl.send(m, opensslAddr.port, '127.0.0.1');
  });
  forOpenssl.on('message', (m, r) => {
    opensslAddr = { port: r.port };
    toEp.send(m, endpointPort, '127.0.0.1');
  });
  bind();
  const timer = consentMs === null ? null : setInterval(bind, consentMs);
  return {
    port: forOpenssl.address().port,
    stopConsent: () => timer && clearInterval(timer),
    close: () => {
      if (timer) clearInterval(timer);
      toEp.close();
      forOpenssl.close();
    },
  };
}

describe.skipIf(!hasOpenssl)('RtcEndpoint full stack (ICE-lite + DTLS) with openssl', () => {
  const cert = ecClientCert('ep2');

  it('handshakes, echoes through the data layer, then expires without consent', async () => {
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], dataLayer: rawDataLayer, idleTimeoutMs: 1500 });
    const session: RtcSession = ep.createSession(offerSdp(cert.sha256));
    const relay = await iceRelay(ep.port, answerCreds(session.answerSdp), 300);
    const got: string[] = [];
    const opened = new Promise<void>((r) => (session.onOpen = r));
    session.onMessage = (ch, data) => {
      got.push(String.fromCharCode(ch) + Buffer.from(data).toString());
      session.send(ch, data); // raw layer: first byte is the "channel"
    };
    const closed = new Promise<string>((r) => (session.onClose = r));
    const { spawn } = await import('node:child_process');
    const p = spawn('openssl', ['s_client', '-dtls1_2', '-connect', `127.0.0.1:${relay.port}`, '-quiet', '-cert', cert.certFile, '-key', cert.keyFile]);
    let out = '';
    p.stdout.on('data', (b: Buffer) => (out += b.toString()));
    p.stderr.on('data', () => {});
    await opened;
    expect(session.state).toBe('open');
    p.stdin.write('ping\n');
    for (let i = 0; i < 100 && !out.includes('ping'); i++) await sleep(20);
    expect(got).toEqual(['ping\n']);
    expect(out).toContain('ping');
    expect(ep.stats().handshakesCompleted).toBe(1);
    // consent keeps it alive past idleTimeoutMs…
    await sleep(2200);
    expect(session.state).toBe('open');
    // …and its absence closes it
    relay.stopConsent();
    expect(await closed).toBe('timeout');
    p.kill('SIGKILL');
    relay.close();
    await ep.close();
  }, 20_000);

  it('endpoint close reports endpoint-closed to open sessions', async () => {
    const ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], dataLayer: rawDataLayer });
    const session = ep.createSession(offerSdp(cert.sha256));
    const relay = await iceRelay(ep.port, answerCreds(session.answerSdp), 1000);
    const opened = new Promise<void>((r) => (session.onOpen = r));
    const { spawn } = await import('node:child_process');
    const p = spawn('openssl', ['s_client', '-dtls1_2', '-connect', `127.0.0.1:${relay.port}`, '-quiet', '-cert', cert.certFile, '-key', cert.keyFile]);
    p.stdout.on('data', () => {});
    p.stderr.on('data', () => {});
    await opened;
    const reasons: string[] = [];
    session.onClose = (r) => reasons.push(r);
    await ep.close();
    expect(reasons).toEqual(['endpoint-closed']);
    expect(session.send(0, new Uint8Array(1))).toBe(false);
    p.kill('SIGKILL');
    relay.close();
  }, 20_000);
});
