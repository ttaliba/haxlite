/**
 * Raw DEFLATE helpers (no zlib/gzip header), as used everywhere by HaxBall:
 * join snapshot (P2P msg 1), SetStadium payload, replays, signaling payloads.
 *
 * The official code uses pako (`pako.deflateRaw(data)` with default options:
 * level 6, windowBits 15, memLevel 8, default strategy). We use node:zlib with
 * the same parameters. NOTE: Node's bundled zlib (Chromium fork) does NOT
 * always produce the same compressed bytes as pako (~40% of payloads differ in
 * our measurements), but every output is a valid raw-deflate stream that pako
 * inflates to the same data. No hash/checksum in the protocol covers
 * compressed bytes (checksums are over the uncompressed RoomState), and
 * haxball.js runs the official headless host with exactly this zlib
 * substitution, so byte-identical compression is NOT required for interop.
 */
import { deflateRaw as deflateRawCb, deflateRawSync, inflateRawSync } from 'node:zlib';
import { CodecError } from './errors.js';

/** Max inflated size the official host accepts for signaling payloads (`new Uint8Array(51200)`). */
export const SIGNALING_INFLATE_LIMIT = 51200;

function view(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

interface BunDeflate {
  deflateSync(data: Uint8Array, opts: { level: number; memLevel: number; windowBits: number }): Uint8Array;
}
/**
 * On Bun, `Bun.deflateSync` (negative windowBits = raw) runs the same zlib as
 * Bun's node:zlib without its compatibility layer (12 KB stadium: 246 → 56
 * µs). Its output is byte-identical to Bun's `deflateRawSync` as long as the
 * result fits in ONE node:zlib output chunk (16 KB): node:zlib calls deflate()
 * once per 16 KB of output and, past the first chunk, block boundaries can
 * differ (measured: ~20% of 100 KB–3 MB inputs at level 6). So: Bun only for
 * inputs ≤ 64 KB, levels 1–9 (level 0 splits stored blocks differently), and
 * a result ≥ 16 KB is redone by node:zlib — same bytes as before everywhere
 * (test `compress-bun`). Join snapshots, stadiums and signaling payloads
 * take the fast path; replays use node:zlib.
 */
const bun = (globalThis as { Bun?: BunDeflate }).Bun;
const bunDeflateSync = bun !== undefined && typeof bun.deflateSync === 'function' ? bun.deflateSync.bind(bun) : null;
const BUN_MAX_INPUT = 65536;
const ZLIB_CHUNK = 16384;

/** Raw deflate with pako-equivalent defaults (level 6). */
export function deflateRaw(data: Uint8Array, level = 6): Uint8Array {
  if (bunDeflateSync !== null && level !== 0 && data.length <= BUN_MAX_INPUT) {
    const out = bunDeflateSync(data, { level, memLevel: 8, windowBits: -15 });
    if (out.length < ZLIB_CHUNK) return out;
  }
  return view(deflateRawSync(data, { level, memLevel: 8, windowBits: 15 }));
}

/**
 * {@link deflateRaw} on the libuv threadpool (node:zlib `deflateRaw`): same
 * parameters, same bytes as `deflateRawSync`, without blocking the event loop
 * (large replays). `data` must not be modified until the promise settles.
 * (Bun 1.4: identical at levels 0 and 2–9; its async level 1 differs from its
 * sync level 1 — still valid raw deflate.)
 */
export function deflateRawAsync(data: Uint8Array, level = 6): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    deflateRawCb(data, { level, memLevel: 8, windowBits: 15 }, (err, out) => (err ? reject(err) : resolve(view(out))));
  });
}

/**
 * Raw inflate. With `maxOutputLength`, throws CodecError("Inflate size exceeds
 * limit") when the output would exceed it (exactly `maxOutputLength` bytes is
 * accepted, like the official bounded inflater). Corrupt input throws
 * CodecError("Inflate error").
 */
export function inflateRaw(data: Uint8Array, maxOutputLength?: number): Uint8Array {
  try {
    return view(
      maxOutputLength === undefined
        ? inflateRawSync(data)
        : inflateRawSync(data, { maxOutputLength: Math.max(1, maxOutputLength) }),
    );
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new CodecError('Inflate size exceeds limit');
    }
    throw new CodecError('Inflate error');
  }
}
