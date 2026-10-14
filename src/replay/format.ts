/**
 * `.hbr2` container constants (docs/02 §6).
 *
 * ```
 * "HBR2"                 4 raw ASCII bytes (= u32 BE 0x48425232)
 * u32 version            3
 * u32 totalFrames        frame at stop − frame at start
 * deflateRaw(body)       rest of the file
 *
 * body:
 *   u16 goalMarkerCount
 *   goalMarkerCount × { varuint frameDelta, u8 goalOwnerTeam }
 *   RoomState            (writeRoomState at start)
 *   { varuint frameDelta, u16 byId, u8 eventType, payload }*   until the end
 * ```
 *
 * All integers are big-endian. Both delta chains start at the recording's
 * first frame and are independent of each other.
 */
import { CodecError } from '../codec/index.js';
import { REPLAY_VERSION } from '../protocol.js';

export { REPLAY_VERSION };

/** "HBR2" read as a big-endian u32 (official reader check `!= 1212305970`). */
export const REPLAY_MAGIC = 0x48425232;

/** Size of the uncompressed header that precedes the deflated body. */
export const REPLAY_HEADER_SIZE = 12;

/** Malformed `.hbr2` (bad magic, truncated/corrupt body, unknown event). */
export class ReplayFormatError extends CodecError {
  override name = 'ReplayFormatError';
}

/**
 * The file is a valid `.hbr2` of another format version (official client:
 * "Incompatible replay version"). `version` is the one found in the file.
 */
export class ReplayVersionError extends ReplayFormatError {
  override name = 'ReplayVersionError';
  readonly version: number;
  constructor(version: number) {
    super(`unsupported replay version ${version} (expected ${REPLAY_VERSION})`);
    this.version = version;
  }
}
