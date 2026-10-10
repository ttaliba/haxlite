/**
 * The RoomState consistency hash (official `RoomState.checksum`, node-haxball
 * `r1`): XOR of every complete big-endian int32 word of the serialized state,
 * starting at offset 0; trailing 1..3 bytes are ignored. Result is an int32.
 * Sent by the host as the 4-byte payload of CheckConsistency (event 2).
 */
export function xorInt32Words(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 4;
  let h = 0;
  for (let p = 0; p <= end; p += 4) h ^= view.getInt32(p);
  return h;
}
