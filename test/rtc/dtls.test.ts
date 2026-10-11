/**
 * DTLS 1.2 server: interop with the system `openssl s_client` (all suites,
 * both groups, EC and RSA client certificates, fragmentation), mandatory
 * client-certificate/fingerprint binding, cookies, anti-replay and record
 * authentication, plus the crypto primitives.
 */
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RtcCertificate } from '../../src/rtc/cert.js';
import { RecordCipher, ReplayWindow, SUITES, prf } from '../../src/rtc/dtls/crypto.js';
import { DtlsServer } from '../../src/rtc/dtls/server.js';
import {
  clientHelloDatagram,
  ecClientCert,
  hasOpenssl,
  parseRecords,
  rsaClientCert,
  runOpenssl,
  startDtlsHarness,
  type DtlsHarness,
} from './dtls-helpers.js';

describe('DTLS primitives', () => {
  it('TLS 1.2 PRF (P_SHA256) matches the reference construction', () => {
    // Independent HMAC chain for 100 bytes
    const secret = Buffer.from('9bbe436ba940f017b17652849a71db35', 'hex');
    const seed = Buffer.from('a0ba9f936cda311827a6f796ffd5198c', 'hex');
    const label = Buffer.from('test label');
    const ls = Buffer.concat([label, seed]);
    let a: Buffer = ls;
    const chunks: Buffer[] = [];
    while (Buffer.concat(chunks).length < 100) {
      a = createHmac('sha256', secret).update(a).digest();
      chunks.push(createHmac('sha256', secret).update(Buffer.concat([a, ls])).digest());
    }
    const expected = Buffer.concat(chunks).subarray(0, 100);
    expect(prf('sha256', secret, 'test label', seed, 100).equals(expected)).toBe(true);
    // Published vector (IETF TLS WG, "TLS 1.2 PRF test vectors", SHA-256): first 16 bytes
    expect(expected.subarray(0, 16).toString('hex')).toBe('e3f229ba727be17b8d122620557cd453');
  });

  it('replay window: new, duplicate, old and far-ahead sequence numbers', () => {
    const w = new ReplayWindow();
    expect(w.check(0)).toBe(true);
    w.mark(0);
    expect(w.check(0)).toBe(false);
    for (const s of [1, 2, 5, 3]) {
      expect(w.check(s)).toBe(true);
      w.mark(s);
      expect(w.check(s)).toBe(false);
    }
    expect(w.check(4)).toBe(true);
    w.mark(100);
    expect(w.check(36)).toBe(false); // 100 - 36 = 64: outside the window
    expect(w.check(37)).toBe(true);
    w.mark(37);
    expect(w.check(37)).toBe(false);
    expect(w.check(99)).toBe(true);
    w.mark(132); // shift of exactly 32
    expect(w.check(100)).toBe(false);
    expect(w.check(37)).toBe(false);
    expect(w.check(101)).toBe(true);
    w.mark(2 ** 40); // huge jump clears everything
    expect(w.check(2 ** 40 - 1)).toBe(true);
    expect(w.check(2 ** 40)).toBe(false);
  });

  it('record ciphers: seal/open round trip, tamper and wrong-seq rejection', () => {
    for (const suite of SUITES) {
      const key = Buffer.alloc(suite.keyLength, 7);
      const iv = Buffer.alloc(suite.ivLength, 3);
      const tx = new RecordCipher(suite, key, iv);
      const rx = new RecordCipher(suite, key, iv);
      const pt = Buffer.from('hello haxball');
      const out = Buffer.alloc(pt.length + tx.overhead);
      const n = tx.seal(23, 0xfefd, 1, 0, 42, pt, out, 0);
      expect(n).toBe(out.length);
      expect(rx.open(23, 0xfefd, 1, 0, 42, out)?.toString()).toBe('hello haxball');
      expect(rx.open(23, 0xfefd, 1, 0, 43, out)).toBeNull(); // AAD binds the sequence number
      expect(rx.open(22, 0xfefd, 1, 0, 42, out)).toBeNull(); // and the content type
      const bad = Buffer.from(out);
      bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
      expect(rx.open(23, 0xfefd, 1, 0, 42, bad)).toBeNull();
    }
  });

  it('self-signed certificate is valid X.509 (openssl-compatible, verifies itself)', () => {
    const c = RtcCertificate.generate();
    expect(c.x509.verify(c.x509.publicKey)).toBe(true);
    expect(c.x509.subject).toBe('CN=haxlite');
    expect(createHash('sha256').update(c.der).digest()).toEqual(Buffer.from(c.fingerprint));
    const back = RtcCertificate.fromPem(c.toPem().cert, c.toPem().key);
    expect(Buffer.from(back.fingerprint)).toEqual(Buffer.from(c.fingerprint));
  });
});

describe.skipIf(!hasOpenssl)('DTLS server ↔ openssl s_client -dtls1_2', () => {
  let h: DtlsHarness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });
  const ec = ecClientCert();
  const certArgs = (c = ec) => ['-cert', c.certFile, '-key', c.keyFile];

  it('default handshake: x25519 + ChaCha20-Poly1305 (our first preference), echo works', async () => {
    h = await startDtlsHarness({ fingerprint: ec.sha256 });
    const r = await runOpenssl(h.port, certArgs(), ['hello', 'world']);
    expect(r.echoed).toBe(true);
    const srv = h.events.connected[0]!;
    expect(srv.suite?.name).toBe('TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256');
    expect(srv.group).toBe(29);
    expect(h.events.data).toEqual(['hello\n', 'world\n']);
  }, 20_000);

  it('server preference AES-128-GCM first (configurable), echo works', async () => {
    h = await startDtlsHarness({ fingerprint: ec.sha256, suites: [0xc02b, 0xcca9] });
    const r = await runOpenssl(h.port, certArgs(), ['hello']);
    expect(r.echoed).toBe(true);
    expect(h.events.connected[0]!.suite?.name).toBe('TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256');
  }, 20_000);

  it('client without ChaCha20 gets AES-128-GCM', async () => {
    h = await startDtlsHarness({ fingerprint: ec.sha256 });
    const r = await runOpenssl(h.port, [...certArgs(), '-cipher', 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384'], ['x']);
    expect(r.echoed).toBe(true);
    expect(h.events.connected[0]!.suite?.name).toBe('TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256');
  }, 20_000);

  it.each([
    ['ECDHE-ECDSA-AES256-GCM-SHA384', 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384'],
    ['ECDHE-ECDSA-CHACHA20-POLY1305', 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256'],
  ])('cipher %s', async (cipher, name) => {
    h = await startDtlsHarness({ fingerprint: ec.sha256 });
    const r = await runOpenssl(h.port, [...certArgs(), '-cipher', cipher], ['x']);
    expect(r.echoed).toBe(true);
    expect(h.events.connected[0]!.suite?.name).toBe(name);
  }, 20_000);

  it('secp256r1 key exchange', async () => {
    h = await startDtlsHarness({ fingerprint: ec.sha256 });
    const r = await runOpenssl(h.port, [...certArgs(), '-groups', 'P-256'], ['p256']);
    expect(r.echoed).toBe(true);
    expect(h.events.connected[0]!.group).toBe(23);
  }, 20_000);

  it('RSA client certificate + fragmented flights (small MTU both ways)', async () => {
    const rsa = rsaClientCert();
    h = await startDtlsHarness({ fingerprint: rsa.sha256, mtu: 256 });
    const r = await runOpenssl(h.port, [...certArgs(rsa), '-mtu', '300'], ['frag']);
    expect(r.echoed).toBe(true);
    expect(h.events.connected).toHaveLength(1);
  }, 20_000);

  it('rejects a client certificate that does not match the SDP fingerprint', async () => {
    const other = ecClientCert('other');
    h = await startDtlsHarness({ fingerprint: other.sha256 });
    const r = await runOpenssl(h.port, certArgs(), ['nope'], 4000);
    expect(r.echoed).toBe(false);
    expect(h.events.connected).toHaveLength(0);
    expect(h.events.closes).toEqual(['dtls-error:fingerprint-mismatch']);
    expect(r.output).toMatch(/bad certificate/i);
  }, 20_000);

  it('rejects a client without a certificate', async () => {
    h = await startDtlsHarness({ fingerprint: ec.sha256 });
    const r = await runOpenssl(h.port, [], ['nope'], 4000);
    expect(r.echoed).toBe(false);
    expect(h.events.closes).toEqual(['dtls-error:no-client-certificate']);
  }, 20_000);

  it('fingerprint with sha-384/sha-512 hash names', async () => {
    const d = createHash('sha512').update(ec.der).digest();
    h = await startDtlsHarness({ fingerprint: d, algorithm: 'sha-512' });
    const r = await runOpenssl(h.port, certArgs(), ['s512']);
    expect(r.echoed).toBe(true);
  }, 20_000);

  const RECORD_SUITES: [string, number[] | undefined][] = [
    ['ChaCha20-Poly1305 (JS, in place)', undefined],
    ['AES-128-GCM (node:crypto)', [0xc02b]],
  ];

  it.each(RECORD_SUITES)('drops replayed records (every client datagram delivered twice) — %s', async (_n, suites) => {
    h = await startDtlsHarness({ fingerprint: ec.sha256, mangle: (d) => [d, d], ...(suites ? { suites } : {}) });
    const r = await runOpenssl(h.port, certArgs(), ['one', 'two', 'three']);
    expect(r.echoed).toBe(true);
    expect(h.events.data).toEqual(['one\n', 'two\n', 'three\n']); // each exactly once
    const srv = h.events.connected[0]!;
    expect(srv.replayed).toBeGreaterThanOrEqual(4); // Finished + 3 data records (at least)
  }, 20_000);

  it.each(RECORD_SUITES)('drops records that do not authenticate — %s', async (_n, suites) => {
    let corrupted = 0;
    h = await startDtlsHarness({
      fingerprint: ec.sha256,
      ...(suites ? { suites } : {}),
      mangle: (d) => {
        if (d[0] === 23 && corrupted === 0) {
          corrupted++;
          const bad = Buffer.from(d);
          bad[bad.length - 1] = bad[bad.length - 1]! ^ 0x55;
          return [bad, d]; // the corrupted copy is dropped, the genuine one accepted
        }
        return [d];
      },
    });
    const r = await runOpenssl(h.port, certArgs(), ['a', 'b']);
    expect(r.echoed).toBe(true);
    expect(h.events.data).toEqual(['a\n', 'b\n']);
    expect(h.events.connected[0]!.badRecords).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('survives loss of handshake datagrams (retransmission)', async () => {
    let n = 0;
    h = await startDtlsHarness({
      fingerprint: ec.sha256,
      // drop the 2nd and 3rd client datagrams (the cookie ClientHello, then its retransmission)
      mangle: (d) => (++n === 2 || n === 3 ? [] : [d]),
    });
    const r = await runOpenssl(h.port, certArgs(), ['late'], 15_000);
    expect(r.echoed).toBe(true);
  }, 30_000);
});

describe('DTLS cookie exchange and negotiation (hand-built ClientHello)', () => {
  const cert = RtcCertificate.generate();
  function server() {
    const sent: Buffer[] = [];
    const closes: string[] = [];
    const s = new DtlsServer({
      certificate: cert,
      remoteFingerprint: { algorithm: 'sha-256', digest: new Uint8Array(32) },
      send: (d) => sent.push(d),
      onConnected: () => {},
      onData: () => {},
      onClose: (r) => closes.push(r),
    });
    return { s, sent, closes };
  }
  /** Handshake message types in the records of `d`. */
  const hsTypes = (d: Buffer) => parseRecords(d).flatMap((r) => (r.type === 22 && r.epoch === 0 ? [r.fragment[0]] : []));
  const cookieOf = (d: Buffer) => {
    const rec = parseRecords(d)[0]!;
    expect(rec.type).toBe(22);
    expect(rec.version).toBe(0xfeff); // HVR uses DTLS 1.0 record version
    const f = rec.fragment;
    expect(f[0]).toBe(3); // HelloVerifyRequest
    expect(f.readUInt16BE(12)).toBe(0xfeff);
    return f.subarray(15, 15 + f[14]!);
  };

  it('requires a valid cookie before allocating any state', () => {
    const { s, sent } = server();
    const ch = clientHelloDatagram({ recordSeq: 7 });
    s.handleDatagram(ch.datagram, '1.2.3.4|5');
    expect(sent).toHaveLength(1);
    expect(parseRecords(sent[0]!)[0]!.seq).toBe(7); // HVR echoes the ClientHello record sequence
    const cookie = cookieOf(sent[0]!);
    expect(cookie.length).toBe(32);
    expect(s.state).toBe('listen');

    // forged cookie → another HVR, still stateless
    const forged = Buffer.from(cookie);
    forged[0] = forged[0]! ^ 1;
    s.handleDatagram(clientHelloDatagram({ random: ch.random, cookie: forged, messageSeq: 1 }).datagram, '1.2.3.4|5');
    expect(sent).toHaveLength(2);
    expect(hsTypes(sent[1]!)).toEqual([3]);
    expect(s.state).toBe('listen');

    // the right cookie from another address → HVR (cookie is bound to the transport address)
    s.handleDatagram(clientHelloDatagram({ random: ch.random, cookie, messageSeq: 1 }).datagram, '1.2.3.4|6');
    expect(hsTypes(sent[2]!)).toEqual([3]);
    expect(s.state).toBe('listen');

    // the right cookie with a different client random → HVR
    s.handleDatagram(clientHelloDatagram({ cookie, messageSeq: 1 }).datagram, '1.2.3.4|5');
    expect(hsTypes(sent[3]!)).toEqual([3]);

    // correct → flight 4 (ServerHello … ServerHelloDone)
    s.handleDatagram(clientHelloDatagram({ random: ch.random, cookie, messageSeq: 1 }).datagram, '1.2.3.4|5');
    expect(s.state).toBe('handshake');
    expect(sent.slice(4).flatMap(hsTypes)).toEqual([2, 11, 12, 13, 14]);
    s.close();
  });

  /** Runs the cookie round trip and returns what the server sent for the second ClientHello. */
  function negotiate(o: Parameters<typeof clientHelloDatagram>[0]) {
    const x = server();
    const ch = clientHelloDatagram(o);
    x.s.handleDatagram(ch.datagram, 'p');
    const cookie = cookieOf(x.sent[0]!);
    x.s.handleDatagram(clientHelloDatagram({ ...o, random: ch.random, cookie, messageSeq: 1 }).datagram, 'p');
    return { ...x, reply: x.sent.slice(1) };
  }
  const alertOf = (d: Buffer) => {
    const r = parseRecords(d)[0]!;
    expect(r.type).toBe(21);
    return [r.fragment[0], r.fragment[1]];
  };

  it('requires extended_master_secret', () => {
    const { reply, closes } = negotiate({ ems: false });
    expect(alertOf(reply[0]!)).toEqual([2, 40]); // fatal handshake_failure
    expect(closes).toEqual(['dtls-error:extended-master-secret-required']);
  });

  it('refuses unsupported suites, groups, signature algorithms and versions', () => {
    expect(negotiate({ suites: [0xc02f] }).closes).toEqual(['dtls-error:no-common-cipher-suite']);
    expect(negotiate({ groups: [24] }).closes).toEqual(['dtls-error:no-common-group']);
    expect(negotiate({ sigAlgs: [0x0804] }).closes).toEqual(['dtls-error:no-ecdsa-sha256']);
    const v10 = negotiate({ version: 0xfeff });
    expect(alertOf(v10.reply[0]!)).toEqual([2, 70]);
    expect(negotiate({ supportedVersions: [0xfefc] }).closes).toEqual(['dtls-error:protocol-version']);
  });

  it('answers a DTLS 1.3-capable ClientHello with DTLS 1.2', () => {
    const { s, reply } = negotiate({ supportedVersions: [0xfefc, 0xfefd] });
    expect(s.state).toBe('handshake');
    expect(s.clientOfferedDtls13).toBe(true);
    const sh = parseRecords(reply[0]!)[0]!.fragment;
    expect(sh[0]).toBe(2);
    expect(sh.readUInt16BE(12)).toBe(0xfefd); // server_version
    // no DTLS 1.3 downgrade sentinel ("DOWNGRD") in the server random (we are not 1.3-capable)
    expect(sh.subarray(14 + 24, 14 + 31).toString('latin1')).not.toBe('DOWNGRD');
    s.close();
  });

  it('reassembles a fragmented ClientHello (large DTLS 1.3/PQ hellos), in any order', () => {
    const { s, sent } = server();
    const whole = clientHelloDatagram({ recordSeq: 3 });
    const fragment = (d: Buffer, cut: number) => {
      // split the single handshake message of record `d` into two records at body offset `cut`
      const hs = d.subarray(13);
      const len = (hs[1]! << 16) | (hs[2]! << 8) | hs[3]!;
      const body = hs.subarray(12);
      const rec = (off: number, n: number, seq: number) => {
        const h = Buffer.from(hs.subarray(0, 12));
        h.writeUIntBE(off, 6, 3);
        h.writeUIntBE(n, 9, 3);
        const frag = Buffer.concat([h, body.subarray(off, off + n)]);
        const r = Buffer.alloc(13);
        r[0] = 22;
        r.writeUInt16BE(0xfefd, 1);
        r.writeUInt32BE(seq, 7);
        r.writeUInt16BE(frag.length, 11);
        return Buffer.concat([r, frag]);
      };
      return [rec(0, cut, 3), rec(cut, len - cut, 4)];
    };
    const [a, b] = fragment(whole.datagram, 40);
    s.handleDatagram(b!, 'p'); // second half first
    expect(sent).toHaveLength(0);
    s.handleDatagram(a!, 'p');
    expect(sent).toHaveLength(1);
    const cookie = cookieOf(sent[0]!);
    const second = clientHelloDatagram({ random: whole.random, cookie, messageSeq: 1 });
    for (const f of fragment(second.datagram, 70)) s.handleDatagram(f, 'p');
    expect(s.state).toBe('handshake');
    s.close();
  });

  it('ignores garbage without answering', () => {
    const { s, sent } = server();
    s.handleDatagram(Buffer.from('17fefd0000000000000000000400000000', 'hex'), 'p'); // app data epoch 0
    s.handleDatagram(Buffer.from('16fefd00000000000000000005010000', 'hex'), 'p'); // truncated
    s.handleDatagram(Buffer.alloc(50, 0x16), 'p');
    s.handleDatagram(clientHelloDatagram().datagram.subarray(0, 40), 'p');
    expect(sent).toHaveLength(0);
    expect(s.state).toBe('listen');
    expect(s.badRecords).toBeGreaterThan(0);
  });
});
