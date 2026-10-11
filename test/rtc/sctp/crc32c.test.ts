/** CRC32c: RFC 3720 Appendix B.4 vectors + a bitwise reference. */
import { describe, expect, it } from 'vitest';
import { crc32c, readChecksum, sctpChecksum, writeChecksum } from '../../../src/rtc/sctp/crc32c.js';
import { mulberry32 } from './harness.js';

function reference(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
  }
  return ~c >>> 0;
}

/** RFC 3720 lists the CRC bytes in transmission order (little-endian). */
const le = (b: number[]): number => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;

describe('crc32c', () => {
  it('RFC 3720 B.4 test vectors', () => {
    expect(crc32c(new Uint8Array(32))).toBe(le([0xaa, 0x36, 0x91, 0x8a]));
    expect(crc32c(new Uint8Array(32).fill(0xff))).toBe(le([0x43, 0xab, 0xa8, 0x62]));
    expect(crc32c(Uint8Array.from({ length: 32 }, (_, i) => i))).toBe(le([0x4e, 0x79, 0xdd, 0x46]));
    expect(crc32c(Uint8Array.from({ length: 32 }, (_, i) => 31 - i))).toBe(le([0x5c, 0xdb, 0x3f, 0x11]));
    const iscsi = Uint8Array.from([
      0x01, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00,
      0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x18, 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(crc32c(iscsi)).toBe(le([0x56, 0x3a, 0x96, 0xd9])); // 0xd9963a56
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
  });

  it('matches a bitwise reference for random lengths and offsets', () => {
    const rnd = mulberry32(7);
    for (let n = 0; n < 500; n++) {
      const len = Math.floor(rnd() * 300);
      const buf = Uint8Array.from({ length: len }, () => Math.floor(rnd() * 256));
      expect(crc32c(buf)).toBe(reference(buf));
      const s = Math.floor(rnd() * (len + 1));
      expect(crc32c(buf, s)).toBe(reference(buf.subarray(s)));
    }
  });

  it('SCTP checksum field: computed with zeroed field, stored little-endian', () => {
    const pkt = Uint8Array.from({ length: 64 }, (_, i) => (i * 31) & 0xff);
    writeChecksum(pkt, pkt.length);
    const stored = readChecksum(pkt);
    const z = pkt.slice();
    z.fill(0, 8, 12);
    expect(stored).toBe(reference(z));
    expect(sctpChecksum(pkt, pkt.length)).toBe(stored);
  });
});
