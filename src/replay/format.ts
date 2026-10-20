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

/**
 * Default cap on the inflated body {@link readReplay} accepts (32 MiB: a match
 * logs about 8 MB per hour, so this is several hours). Raise it per call for
 * longer trusted files.
 */
export const REPLAY_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Default cap on the events {@link readReplay} decodes (2^21, about two hours
 * of play). Events are decoded eagerly into objects, so this bounds the heap
 * (~100 B per event) independently of the body cap.
 */
export const REPLAY_MAX_EVENTS = 2097152;

/**
 * Default cap on the event log of a recording ({@link ReplayRecorder}), in
 * bytes: 16 MiB, i.e. about two hours of a regular match.
 */
export const REPLAY_RECORD_MAX_BYTES = 16 * 1024 * 1024;

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
