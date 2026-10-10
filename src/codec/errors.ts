/**
 * Error thrown by the codec when input bytes are malformed or a value cannot
 * be encoded. The official client/host throw on the same conditions (the host
 * then drops the offending connection), so callers on the network path should
 * treat any CodecError as "protocol violation".
 */
export class CodecError extends Error {
  override name = 'CodecError';
}
