/**
 * src/codec — binary primitives shared by every module (owner: foundation).
 * Stable API; changes need coordination because sim/room/net all depend on it.
 */
export { CodecError } from './errors.js';
export { Writer } from './writer.js';
export { Reader } from './reader.js';
export {
  haxUtf8Length,
  encodeHaxUtf8,
  encodeHaxUtf8Into,
  decodeHaxUtf8,
  standardUtf8Encode,
} from './utf8.js';
export { deflateRaw, deflateRawAsync, inflateRaw, SIGNALING_INFLATE_LIMIT } from './compress.js';
export { xorInt32Words } from './checksum.js';

/** Number of bytes `v` takes as a HaxBall varuint (same thresholds as the official sizer). */
export function varUintSize(v: number): number {
  const a = v >>> 0;
  return a < 0x80 ? 1 : a < 0x4000 ? 2 : a < 0x200000 ? 3 : a < 0x10000000 ? 4 : 5;
}
