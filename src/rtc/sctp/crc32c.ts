/**
 * CRC32c (Castagnoli, reflected polynomial 0x82F63B78) as used by SCTP
 * (RFC 9260 Appendix A / RFC 3309). Slice-by-8 table implementation: eight
 * 256-entry tables, 8 bytes per loop iteration, no allocations.
 *
 * SCTP stores the final value in the common header least-significant byte
 * first (i.e. little-endian), see {@link writeChecksum}.
 *
 * Speed (Node 22, `test/rtc/sctp/bench.ts`): about 0.6–1 B/ns on HaxBall's
 * 28–100-byte packets, i.e. ≈ 35 % of an SCTP message round trip when the
 * peer does not negotiate RFC 9653 zero checksum (Chromium 141). Measured and
 * rejected (docs/10 §6.1): slicing-by-16 (one 16 KiB table or 16 separate
 * tables), 32-bit word reads through an `Int32Array` alias of aligned send
 * buffers, a single-pass verification (field zeroed and restored), and a
 * WebAssembly slicing-by-16 (clang; with or without copying the packet into
 * linear memory): none beat this within run-to-run noise at these sizes —
 * the typed-array loads, not the slicing width, bound a JS table CRC, and the
 * WASM call + copy costs as much as the CRC of a small packet.
 */

const T = new Int32Array(8 * 256);
(() => {
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    T[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = T[n];
    for (let k = 1; k < 8; k++) {
      c = T[c & 0xff] ^ (c >>> 8);
      T[k * 256 + n] = c;
    }
  }
})();

/**
 * Feeds `buf[start..end)` into a running (pre-inverted) CRC state. Start with
 * `0xffffffff` (as int: `-1`) and finish with {@link crc32cFinish}.
 */
export function crc32cUpdate(crc: number, buf: Uint8Array, start: number, end: number): number {
  let i = start | 0;
  let c = crc | 0;
  const end8 = (end - 8) | 0;
  // int32-only arithmetic (| / >> with masks) keeps V8 on its fast path.
  while (i <= end8) {
    const lo = c ^ (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24));
    c =
      T[1792 | (lo & 0xff)] ^
      T[1536 | ((lo >> 8) & 0xff)] ^
      T[1280 | ((lo >> 16) & 0xff)] ^
      T[1024 | ((lo >> 24) & 0xff)] ^
      T[768 | buf[i + 4]] ^
      T[512 | buf[i + 5]] ^
      T[256 | buf[i + 6]] ^
      T[buf[i + 7]];
    i = (i + 8) | 0;
  }
  while (i < end) c = T[(c ^ buf[i++]) & 0xff] ^ (c >>> 8);
  return c;
}

export function crc32cFinish(crc: number): number {
  return ~crc >>> 0;
}

/** CRC32c of `buf[start..end)`. */
export function crc32c(buf: Uint8Array, start = 0, end = buf.length): number {
  return crc32cFinish(crc32cUpdate(-1, buf, start, end));
}

const ZERO4 = new Uint8Array(4);

/**
 * SCTP packet checksum of `pkt[base..base+len)`, computed as if bytes 8..11
 * of the packet were zero (the packet is not modified).
 */
export function sctpChecksum(pkt: Uint8Array, len: number, base = 0): number {
  let c = crc32cUpdate(-1, pkt, base, base + 8);
  c = crc32cUpdate(c, ZERO4, 0, 4);
  c = crc32cUpdate(c, pkt, base + 12, base + len);
  return crc32cFinish(c);
}

/** Computes and stores the checksum of `pkt[0..len)` at offset 8 (little-endian, as SCTP requires). */
export function writeChecksum(pkt: Uint8Array, len: number): void {
  pkt[8] = 0;
  pkt[9] = 0;
  pkt[10] = 0;
  pkt[11] = 0;
  const c = crc32cFinish(crc32cUpdate(-1, pkt, 0, len));
  pkt[8] = c & 0xff;
  pkt[9] = (c >>> 8) & 0xff;
  pkt[10] = (c >>> 16) & 0xff;
  pkt[11] = c >>> 24;
}

/** Stored checksum of a packet starting at `base` (little-endian at offset 8). */
export function readChecksum(pkt: Uint8Array, base = 0): number {
  return (pkt[base + 8] | (pkt[base + 9] << 8) | (pkt[base + 10] << 16) | (pkt[base + 11] << 24)) >>> 0;
}
