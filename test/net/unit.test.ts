/**
 * Unit + differential tests for src/net building blocks. Differential
 * oracles: the official headless classes (test/net/official-net.ts) and
 * node-haxball where relevant.
 */
import { describe, expect, it } from 'vitest';
import {
  BanList,
  IpRange,
  KeyedRateLimiter,
  TokenBucket,
  bytesToConn,
  canonicalIp,
  classifyAddress,
  connToText,
  createAuthBlob,
  createChallenge,
  decodeRoomInfo,
  encodeChallenge,
  encodeHandshake,
  encodeKick,
  encodeRoomInfo,
  encodeRoomList,
  filterCandidate,
  filterSdp,
  generateIdentity,
  identityFromKey,
  identityToKey,
  parseCandidate,
  parseHandshake,
  parseIp,
  parseJoinInfo,
  parseRoomList,
  sdpMids,
  srflxAddress,
  toNativeIceServers,
  verifyAuthBlob,
  type RoomInfo,
} from '../../src/net/index.js';
import { Reader } from '../../src/codec/index.js';
import { passiveDtlsOffer } from '../../src/net/peer-backend.js';
import { officialNet } from './official-net.js';

describe('ip', () => {
  it('parses and canonicalises IPv4/IPv6', () => {
    expect(canonicalIp('127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(canonicalIp('[fe80::1%eth0]')).toBe('fe80::1');
    expect(canonicalIp('2001:db8:0:1:0:0:0:1')).toBe('2001:db8:0:1::1');
    expect(canonicalIp('::')).toBe('::');
    expect(canonicalIp('1::')).toBe('1::');
    expect(canonicalIp('::1.2.3.4')).toBe('::102:304');
    for (const bad of ['', '1.2.3', '1.2.3.256', '01.2.3.4', '1::2::3', '12345::', 'abc.local', 'g::1', '1:2:3:4:5:6:7:8:9']) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it('CIDR ranges', () => {
    const r = IpRange.parse('10.0.0.0/8')!;
    expect(r.contains(parseIp('10.255.1.2')!)).toBe(true);
    expect(r.contains(parseIp('11.0.0.1')!)).toBe(false);
    expect(r.contains(parseIp('::ffff:10.0.0.1')!)).toBe(true);
    const r6 = IpRange.parse('2001:db8::/33')!;
    expect(r6.contains(parseIp('2001:db8:7fff::1')!)).toBe(true);
    expect(r6.contains(parseIp('2001:db8:8000::1')!)).toBe(false);
    expect(IpRange.parse('192.168.1.77/20')!.toString()).toBe('192.168.0.0/20');
    expect(IpRange.parse('::ffff:10.0.0.0/104')!.toString()).toBe('10.0.0.0/8');
    expect(IpRange.parse('0.0.0.0/0')!.contains(parseIp('8.8.8.8')!)).toBe(true);
    expect(IpRange.parse('1.2.3.4/33')).toBeNull();
    expect(IpRange.parse('1.2.3.4/x')).toBeNull();
  });

  it('conn hex (R.yi)', () => {
    const bytes = new TextEncoder().encode('127.0.0.1');
    expect(bytesToConn(bytes)).toBe('3132372E302E302E31');
    expect(connToText('3132372E302E302E31')).toBe('127.0.0.1');
  });
});

describe('BanList', () => {
  it('peer/ip/range/auth records with reference counting', () => {
    const b = new BanList();
    const a = b.addPeer(['1.2.3.4', '5.6.7.8', '1.2.3.4', 'host.local'], 'AUTH');
    const c = b.addIp('::ffff:1.2.3.4');
    expect(a.ips).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(b.isAuthBanned('AUTH')).toBe(true);
    expect(b.isIpBanned('1.2.3.4')).toBe(true);
    b.remove(a.id);
    expect(b.isIpBanned('1.2.3.4')).toBe(true); // still listed by `c`
    expect(b.isIpBanned('5.6.7.8')).toBe(false);
    expect(b.isAuthBanned('AUTH')).toBe(false);
    b.remove(c.id);
    expect(b.isIpBanned('1.2.3.4')).toBe(false);
    const r = b.addRange('2001:db8::/32');
    expect(b.isIpBanned('2001:db8:1::1')).toBe(true);
    expect(b.isIpBanned('not-an-ip')).toBe(false);
    expect(b.list().map((x) => x.kind)).toEqual(['range']);
    b.remove(r.id);
    expect(b.isIpBanned('2001:db8:1::1')).toBe(false);
    b.addAuth('K');
    expect(b.isAuthBanned('K')).toBe(true);
    expect(b.isAuthBanned(null)).toBe(false);
    b.clear();
    expect(b.size).toBe(0);
    expect(() => b.addIp('nope')).toThrow();
    expect(() => b.addRange('1.2.3.4/40')).toThrow();
  });
});

describe('TokenBucket', () => {
  it('matches the official Ra(100, 16) step by step', () => {
    const off = officialNet();
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const [cap, ms] of [
      [100, 16],
      [10, 900],
      [2, 10000],
    ] as const) {
      off.clock.now = 1000;
      const theirs = new off.Ra(cap, ms);
      const ours = new TokenBucket(cap, ms, 1000);
      let t = 1000;
      for (let i = 0; i < 5000; i++) {
        t += rnd() < 0.7 ? rnd() * ms * 0.5 : rnd() * ms * 30;
        off.clock.now = t;
        expect(ours.take(t)).toBe(theirs.Rf());
        expect(ours.tokens).toBe(theirs.vb);
      }
    }
  });

  it('keyed limiter prunes refilled keys', () => {
    const k = new KeyedRateLimiter(2, 100);
    expect([k.take('a', 0), k.take('a', 0), k.take('a', 0), k.take('b', 0)]).toEqual([true, true, false, true]);
    k.prune(50);
    expect(k.size).toBe(2);
    k.prune(1000);
    expect(k.size).toBe(0);
  });
});

describe('ICE candidates', () => {
  it('parse like rb.Bh / Aa.We', () => {
    const off = officialNet();
    const cases = [
      'candidate:842163049 1 udp 1677729535 203.0.113.5 41234 typ srflx raddr 0.0.0.0 rport 0 generation 0',
      'candidate:1 1 UDP 2122252543 192.168.1.2 50000 typ host',
      'candidate:2 1 udp 2113937151 3b0c4a1e-6f0f-4a8b-9b8e-6b9f0f3c2b1a.local 54321 typ host generation 0',
      'a=candidate:1 1 UDP 1686052607 2001:db8::5 3478 typ srflx raddr :: rport 0',
      'garbage',
      '',
    ];
    for (const c of cases) {
      let theirs: string | null = null;
      try {
        theirs = off.Aa.We({ candidate: c });
      } catch {
        theirs = null;
      }
      expect(srflxAddress({ candidate: c }), c).toBe(theirs);
    }
    expect(parseCandidate(cases[1]!)).toEqual({ address: '192.168.1.2', type: 'host' });
    expect(sdpMids('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\nm=audio 9\r\n')).toEqual(['data', '1']);
  });

  it('classifies candidate addresses', () => {
    const cases: [string, string][] = [
      ['127.0.0.1', 'loopback'],
      ['::1', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['172.32.0.1', 'public'],
      ['192.168.1.20', 'private'],
      ['100.64.0.1', 'private'],
      ['100.128.0.1', 'public'],
      ['fd12:3456::1', 'private'],
      ['fc00::1', 'private'],
      ['169.254.10.1', 'linklocal'],
      ['fe80::1%eth0', 'linklocal'],
      ['0.0.0.0', 'reserved'],
      ['::', 'reserved'],
      ['224.0.0.1', 'reserved'],
      ['ff02::1', 'reserved'],
      ['::ffff:192.168.0.1', 'private'],
      ['8.8.8.8', 'public'],
      ['2001:4860::8888', 'public'],
      ['3b0c4a1e-6f0f-4a8b-9b8e-6b9f0f3c2b1a.local', 'mdns'],
      ['example.com', 'invalid'],
    ];
    for (const [ip, cls] of cases) expect(classifyAddress(ip), ip).toBe(cls);
  });

  it('filters local candidates and SDP by policy (privacy)', () => {
    const host = (ip: string) => `candidate:1 1 UDP 2122252543 ${ip} 50000 typ host`;
    const srflxWithBase = 'candidate:2 1 UDP 1686052607 203.0.113.9 50001 typ srflx raddr 192.168.1.2 rport 50000';
    const relay = 'candidate:3 1 UDP 16777215 10.0.0.7 3478 typ relay raddr 192.168.1.2 rport 50000';
    // default 'public'
    expect(filterCandidate(host('192.168.1.2'), 'public')).toBeNull();
    expect(filterCandidate(host('127.0.0.1'), 'public')).toBeNull();
    expect(filterCandidate(host('fe80::1'), 'public')).toBeNull();
    expect(filterCandidate(host('abc.local'), 'public')).toBeNull();
    expect(filterCandidate(host('198.51.100.4'), 'public')).toBe(host('198.51.100.4'));
    expect(filterCandidate(srflxWithBase, 'public')).toBe(
      'candidate:2 1 UDP 1686052607 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0',
    );
    expect(filterCandidate(relay, 'public')).toBe('candidate:3 1 UDP 16777215 10.0.0.7 3478 typ relay raddr 0.0.0.0 rport 0');
    expect(filterCandidate('garbage', 'public')).toBeNull();
    // 'private' (LAN), 'all', predicate
    expect(filterCandidate(host('192.168.1.2'), 'private')).toBe(host('192.168.1.2'));
    expect(filterCandidate(host('127.0.0.1'), 'private')).toBeNull();
    expect(filterCandidate(srflxWithBase, 'private')).toBe(srflxWithBase);
    expect(filterCandidate(host('127.0.0.1'), 'all')).toBe(host('127.0.0.1'));
    expect(filterCandidate(host('192.0.2.1'), (c) => c.address !== '192.0.2.1')).toBeNull();

    const sdp = [
      'v=0',
      'o=rtc 1 0 IN IP4 127.0.0.1',
      'm=application 44311 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 192.168.1.2',
      'a=mid:0',
      'a=candidate:1 1 UDP 2114977791 192.168.1.2 44311 typ host',
      'a=candidate:2 1 UDP 1686052607 203.0.113.9 44311 typ srflx raddr 192.168.1.2 rport 44311',
      '',
    ].join('\r\n');
    expect(filterSdp(sdp, 'public')).toBe(
      [
        'v=0',
        'o=rtc 1 0 IN IP4 127.0.0.1',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        'a=mid:0',
        'a=candidate:2 1 UDP 1686052607 203.0.113.9 44311 typ srflx raddr 0.0.0.0 rport 0',
        '',
      ].join('\r\n'),
    );
    expect(filterSdp(sdp, 'private')).toBe(sdp);
    expect(filterSdp(sdp, 'all')).toBe(sdp);
  });

  it('normalizes ICE servers (libdatachannel URLs, objects, browser RTCIceServer)', () => {
    expect(
      toNativeIceServers([
        'stun:stun.l.google.com:19302',
        { hostname: 'turn.example.org', port: 3478, username: 'u', password: 'p', relayType: 'TurnUdp' },
        { urls: ['stun:stun.example.org', 'turn:turn.example.org:3479?transport=tcp'], username: 'us:er', credential: 'p@ss/w' },
        { urls: 'turns:[2001:db8::1]', username: 'a', credential: 'b' },
      ]),
    ).toEqual([
      'stun:stun.l.google.com:19302',
      { hostname: 'turn.example.org', port: 3478, username: 'u', password: 'p', relayType: 'TurnUdp' },
      'stun:stun.example.org',
      { hostname: 'turn.example.org', port: 3479, username: 'us:er', password: 'p@ss/w', relayType: 'TurnTcp' },
      { hostname: '2001:db8::1', port: 5349, username: 'a', password: 'b', relayType: 'TurnTls' },
    ]);
    expect(() => toNativeIceServers([{ urls: 'http://nope' }])).toThrow(/invalid ICE server url/);
  });
});

describe('DTLS role', () => {
  it('an actpass offer is presented as active so libdatachannel answers passive; other roles untouched', () => {
    const offer = 'v=0\r\na=setup:actpass\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=setup:actpass\r\n';
    expect(passiveDtlsOffer(offer)).toBe(offer.replaceAll('actpass', 'active'));
    const active = 'v=0\r\na=setup:active\r\n';
    expect(passiveDtlsOffer(active)).toBe(active);
    const passive = 'v=0\r\na=setup:passive\r\n';
    expect(passiveDtlsOffer(passive)).toBe(passive);
  });
});

describe('RoomInfo', () => {
  const infos: RoomInfo[] = [
    { version: 9, name: 'Headless Room', flag: 'ar', lat: -34.6, lon: -58.38, password: false, maxPlayers: 12, players: 0 },
    { version: 9, name: 'Sala 😀 ñandú '.repeat(5), flag: 'br', lat: 0.1, lon: 179.9, password: true, maxPlayers: 30, players: 29 },
    { version: 9, name: 'x'.repeat(39) + '😀', flag: 'gb-eng', lat: 51.5, lon: -0.12, password: true, maxPlayers: 2, players: 1 },
  ];

  it('byte-identical to the official ab.G (LE, truncation, UTF-8)', () => {
    const { ab, A } = officialNet();
    for (const info of infos) {
      const o = new ab();
      o.pi = info.version;
      o.pa = info.name;
      o.ib = info.flag;
      o.Sc = info.lat;
      o.Uc = info.lon;
      o.mb = info.password;
      o.xh = info.maxPlayers;
      o.ba = info.players;
      const w = A.aa(16);
      o.G(w);
      const theirs = Uint8Array.from(w.Db() as Uint8Array);
      expect(encodeRoomInfo(info)).toEqual(theirs);
    }
  });

  it('decode + room list round trip', () => {
    const bytes = encodeRoomInfo(infos[0]!);
    const back = decodeRoomInfo(bytes);
    expect(back).toMatchObject({ version: 9, name: 'Headless Room', flag: 'ar', players: 0, maxPlayers: 12 });
    expect(back.lat).toBeCloseTo(-34.6, 4);
    const list = encodeRoomList([
      { id: 'AbCdEfGhIjK', info: bytes },
      { id: 'zzzzzzzzzzz', info: encodeRoomInfo(infos[1]!) },
    ]);
    const parsed = parseRoomList(list);
    expect(parsed.map((r) => r.id)).toEqual(['AbCdEfGhIjK', 'zzzzzzzzzzz']);
    expect(parsed[1]!.info.players).toBe(29);
  });
});

describe('auth', () => {
  it('our blobs verify with the official ua.ri and with ours; tampering fails', async () => {
    const { ua } = officialNet();
    const id = await generateIdentity();
    const challenge = createChallenge();
    expect(challenge.length).toBe(8);
    const blob = await createAuthBlob(id, challenge);
    expect(await ua.ri(blob, challenge)).toBe(id.x);
    expect(await verifyAuthBlob(blob, challenge)).toBe(id.x);
    // wrong challenge (replay)
    await expect(verifyAuthBlob(blob, createChallenge())).rejects.toThrow();
    await expect(ua.ri(blob, createChallenge())).rejects.toBeDefined();
    // tampered signature / payload
    const bad = blob.slice();
    bad[bad.length - 3]! ^= 1;
    await expect(verifyAuthBlob(bad, challenge)).rejects.toThrow();
    const bad2 = blob.slice();
    bad2[5]! ^= 1; // inside x
    await expect(verifyAuthBlob(bad2, challenge)).rejects.toThrow();
    // empty blob (client without key)
    await expect(verifyAuthBlob(new Uint8Array(0), challenge)).rejects.toThrow();
    // idkey round trip
    const again = await identityFromKey(identityToKey(id));
    expect(await verifyAuthBlob(await createAuthBlob(again, challenge), challenge)).toBe(id.x);
    await expect(identityFromKey('idkey.a.b')).rejects.toThrow('Invalid id format');
  });
});

describe('handshake framing', () => {
  it('challenge, handshake, join info limits, kick', () => {
    expect([...encodeChallenge(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))]).toEqual([0, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
    const hs = encodeHandshake(Uint8Array.of(9, 9), { name: 'Pelé ⚽', flag: 'br', avatar: '10' });
    const parsed = parseHandshake(hs);
    expect([...parsed.authBlob]).toEqual([9, 9]);
    expect(parseJoinInfo(parsed.info)).toEqual({ name: 'Pelé ⚽', flag: 'br', avatar: '10' });
    expect(() => parseHandshake(Uint8Array.of(...hs, 0))).toThrow('trailing');
    expect(() => parseHandshake(Uint8Array.of(1, 0, 0))).toThrow();
    const info = (name: string, flag: string, avatar: string | null) => parseHandshake(encodeHandshake(null, { name, flag, avatar })).info;
    expect(parseJoinInfo(info('x'.repeat(25), 'abc', '😀')).name.length).toBe(25); // emoji = 2 UTF-16 units: allowed
    expect(() => parseJoinInfo(info('x'.repeat(26), 'ab', null))).toThrow('name too long');
    expect(() => parseJoinInfo(info('x', 'abcd', null))).toThrow('country too long');
    expect(() => parseJoinInfo(info('x', 'ab', 'abc'))).toThrow('avatar too long');
    // trailing bytes inside the info block are ignored (official uses a separate reader)
    expect(parseJoinInfo(Uint8Array.of(...info('a', 'b', null), 7, 7))).toEqual({ name: 'a', flag: 'b', avatar: null });
    const k = new Reader(encodeKick('bye', true, null));
    expect([k.u8(), k.u8(), k.string(), k.string()]).toEqual([5, 1, 'bye', '']);
  });
});
