import { createSecretKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  StunMessage,
  StunAttr,
  buildBindingError,
  buildBindingRequest,
  buildBindingSuccess,
  checkFingerprint,
  checkIntegrity,
  crc32,
  findAttr,
  isStun,
  parseStun,
  readXorAddress,
} from '../../src/rtc/stun.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// RFC 5769 §2.1 Sample Request (username "evtj:h6vY", password "VOkJxbRl1RmTxUk/WvJxBt")
const REQUEST = hex(`
  00 01 00 58 21 12 a4 42 b7 e7 a7 01 bc 34 d6 86 fa 87 df ae
  80 22 00 10 53 54 55 4e 20 74 65 73 74 20 63 6c 69 65 6e 74
  00 24 00 04 6e 00 01 ff
  80 29 00 08 93 2f f9 b1 51 26 3b 36
  00 06 00 09 65 76 74 6a 3a 68 36 76 59 20 20 20
  00 08 00 14 9a ea a7 0c bf d8 cb 56 78 1e f2 b5 b2 d3 f2 49 c1 b5 71 a2
  80 28 00 04 e5 7a 3b cf`);

// RFC 5769 §2.2 Sample IPv4 Response (192.0.2.1:32853)
const RESPONSE4 = hex(`
  01 01 00 3c 21 12 a4 42 b7 e7 a7 01 bc 34 d6 86 fa 87 df ae
  80 22 00 0b 74 65 73 74 20 76 65 63 74 6f 72 20
  00 20 00 08 00 01 a1 47 e1 12 a6 43
  00 08 00 14 2b 91 f5 99 fd 9e 90 c3 8c 74 89 f9 2a f9 ba 53 f0 6b e7 d7
  80 28 00 04 c0 7d 4c 96`);

// RFC 5769 §2.3 Sample IPv6 Response (2001:db8:1234:5678:11:2233:4455:6677 port 32853)
const RESPONSE6 = hex(`
  01 01 00 48 21 12 a4 42 b7 e7 a7 01 bc 34 d6 86 fa 87 df ae
  80 22 00 0b 74 65 73 74 20 76 65 63 74 6f 72 20
  00 20 00 14 00 02 a1 47 01 13 a9 fa a5 d3 f1 79 bc 25 f4 b5 be d2 b9 d9
  00 08 00 14 a3 82 95 4e 4b e6 7b f1 17 84 c9 7c 82 92 c2 75 bf e3 ed 41
  80 28 00 04 c8 fb 0b 4c`);

const PASSWORD = Buffer.from('VOkJxbRl1RmTxUk/WvJxBt');

describe('STUN (RFC 5769 test vectors)', () => {
  it('crc32 matches the zlib definition', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('§2.1 request: parses, MESSAGE-INTEGRITY and FINGERPRINT verify', () => {
    const m = new StunMessage();
    expect(isStun(REQUEST)).toBe(true);
    expect(parseStun(REQUEST, m)).toBe(true);
    expect(m.type).toBe(0x0001);
    expect(m.username()).toBe('evtj:h6vY');
    expect(m.priority).toBe(0x6e0001ff);
    expect(m.controlled).toBe(true);
    expect(m.controlling).toBe(false);
    expect(m.tieHi).toBe(0x932ff9b1);
    expect(m.tieLo).toBe(0x51263b36);
    expect(checkFingerprint(m)).toBe(true);
    expect(checkIntegrity(m, PASSWORD)).toBe(true);
    expect(checkIntegrity(m, Buffer.from('VOkJxbRl1RmTxUk/WvJxBu'))).toBe(false);
  });

  it('§2.2 IPv4 response: integrity, fingerprint, XOR-MAPPED-ADDRESS', () => {
    const m = new StunMessage();
    expect(parseStun(RESPONSE4, m)).toBe(true);
    expect(m.type).toBe(0x0101);
    expect(checkFingerprint(m)).toBe(true);
    expect(checkIntegrity(m, PASSWORD)).toBe(true);
    const v = findAttr(m, StunAttr.XorMappedAddress);
    expect(readXorAddress(RESPONSE4, v, m.transactionId())).toEqual({ address: '192.0.2.1', port: 32853 });
  });

  it('§2.3 IPv6 response: integrity, fingerprint, XOR-MAPPED-ADDRESS', () => {
    const m = new StunMessage();
    expect(parseStun(RESPONSE6, m)).toBe(true);
    expect(checkFingerprint(m)).toBe(true);
    expect(checkIntegrity(m, PASSWORD)).toBe(true);
    const v = findAttr(m, StunAttr.XorMappedAddress);
    expect(readXorAddress(RESPONSE6, v, m.transactionId())).toEqual({
      address: '2001:db8:1234:5678:11:2233:4455:6677',
      port: 32853,
    });
  });

  it('builds responses whose XOR-MAPPED-ADDRESS bytes equal the vectors', () => {
    const txid = REQUEST.subarray(8, 20);
    const r4 = buildBindingSuccess(txid, '192.0.2.1', 32853, PASSWORD);
    expect(r4.subarray(20, 32).toString('hex')).toBe(RESPONSE4.subarray(36, 48).toString('hex'));
    const r6 = buildBindingSuccess(txid, '2001:db8:1234:5678:11:2233:4455:6677', 32853, PASSWORD);
    expect(r6.subarray(20, 44).toString('hex')).toBe(RESPONSE6.subarray(36, 60).toString('hex'));
    // v4-mapped IPv6 sources (dual-stack sockets) are reported as IPv4
    const rm = buildBindingSuccess(txid, '::ffff:192.0.2.1', 32853, PASSWORD);
    expect(rm.subarray(20, 32).toString('hex')).toBe(RESPONSE4.subarray(36, 48).toString('hex'));
    for (const r of [r4, r6, rm]) {
      const m = new StunMessage();
      expect(parseStun(r, m)).toBe(true);
      expect(checkFingerprint(m)).toBe(true);
      expect(checkIntegrity(m, PASSWORD)).toBe(true);
    }
  });

  it('a KeyObject key (sessions) gives the same MESSAGE-INTEGRITY as the raw password bytes', () => {
    const ko = createSecretKey(PASSWORD);
    const m = new StunMessage();
    for (const vec of [REQUEST, RESPONSE4, RESPONSE6]) {
      expect(parseStun(vec, m)).toBe(true);
      expect(checkIntegrity(m, ko)).toBe(true);
    }
    expect(parseStun(REQUEST, m)).toBe(true);
    expect(checkIntegrity(m, createSecretKey(Buffer.from('VOkJxbRl1RmTxUk/WvJxBu')))).toBe(false);
    const txid = REQUEST.subarray(8, 20);
    expect(buildBindingSuccess(txid, '192.0.2.1', 32853, ko)).toEqual(buildBindingSuccess(txid, '192.0.2.1', 32853, PASSWORD));
    expect(buildBindingError(txid, 487, 'Role Conflict', ko)).toEqual(buildBindingError(txid, 487, 'Role Conflict', PASSWORD));
    const req = { txid: Buffer.alloc(12, 9), username: 'abcd:efgh', priority: 1, useCandidate: true };
    expect(buildBindingRequest({ ...req, key: ko })).toEqual(buildBindingRequest({ ...req, key: PASSWORD }));
  });

  it('error responses carry ERROR-CODE and authenticate', () => {
    const txid = REQUEST.subarray(8, 20);
    const e = buildBindingError(txid, 487, 'Role Conflict', PASSWORD);
    const m = new StunMessage();
    expect(parseStun(e, m)).toBe(true);
    expect(m.type).toBe(0x0111);
    const v = findAttr(m, StunAttr.ErrorCode);
    expect(e[v + 2]! * 100 + e[v + 3]!).toBe(487);
    expect(checkIntegrity(m, PASSWORD)).toBe(true);
    expect(checkFingerprint(m)).toBe(true);
  });

  it('round-trips a browser-like request', () => {
    const req = buildBindingRequest({
      txid: Buffer.alloc(12, 9),
      username: 'abcd:efgh',
      key: PASSWORD,
      priority: 1845501695,
      useCandidate: true,
    });
    const m = new StunMessage();
    expect(parseStun(req, m)).toBe(true);
    expect(m.username()).toBe('abcd:efgh');
    expect(m.useCandidate).toBe(true);
    expect(m.controlling).toBe(true);
    expect(m.priority).toBe(1845501695);
    expect(checkIntegrity(m, PASSWORD)).toBe(true);
    expect(checkFingerprint(m)).toBe(true);
  });

  it('detects tampering and malformed messages', () => {
    const m = new StunMessage();
    const bad = Buffer.from(REQUEST);
    bad[30] = bad[30]! ^ 1; // flip a SOFTWARE byte
    expect(parseStun(bad, m)).toBe(true);
    expect(checkIntegrity(m, PASSWORD)).toBe(false);
    expect(checkFingerprint(m)).toBe(false);
    // truncated
    expect(parseStun(REQUEST.subarray(0, REQUEST.length - 4), m)).toBe(false);
    // wrong magic cookie
    const nc = Buffer.from(REQUEST);
    nc[4] = 0;
    expect(parseStun(nc, m)).toBe(false);
    // attribute after FINGERPRINT
    const after = Buffer.concat([REQUEST, hex('80 22 00 00')]);
    after.writeUInt16BE(REQUEST.readUInt16BE(2) + 4, 2);
    expect(parseStun(after, m)).toBe(false);
    // attribute length overflowing the message
    const ovf = Buffer.from(REQUEST);
    ovf.writeUInt16BE(0xff, 22);
    expect(parseStun(ovf, m)).toBe(false);
  });
});
