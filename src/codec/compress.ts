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
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { CodecError } from './errors.js';

/** Max inflated size the official host accepts for signaling payloads (`new Uint8Array(51200)`). */
export const SIGNALING_INFLATE_LIMIT = 51200;

function view(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Raw deflate with pako-equivalent defaults (level 6). */
export function deflateRaw(data: Uint8Array, level = 6): Uint8Array {
  return view(deflateRawSync(data, { level, memLevel: 8, windowBits: 15 }));
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
