/**
 * Data-channel join handshake framing (docs/02 §2.5-2.6).
 *
 * host -> client: `[u8 0][varuint 8][8 bytes challenge]` (`Wa.Ah`)
 * client -> host: `[u8 0][varuint n][auth blob][varuint m][join info]` (`Wa.Lh`)
 * join info (`D.yh`): `string name` (<= 25), `string flag` (<= 3),
 *                     `nullableString avatar` (<= 2). Lengths are UTF-16 units.
 */
import { Reader, Writer } from '../codec/index.js';
import { JoinLimits } from './constants.js';

/** `[0][varuint len][challenge]`. */
export function encodeChallenge(challenge: Uint8Array): Uint8Array {
  const w = new Writer(2 + challenge.length);
  w.u8(0);
  w.varUint(challenge.length);
  w.bytes(challenge);
  return w.copyBytes();
}

export interface HandshakeMessage {
  /** Raw auth blob (empty when the client has no key). Zero-copy view. */
  authBlob: Uint8Array;
  /** Raw join info bytes. Zero-copy view. */
  info: Uint8Array;
}

/**
 * Parses the client's handshake (type byte included). Throws on malformed
 * input or trailing bytes (`if (0 < c.j.byteLength - c.a) throw r.l(2)`).
 */
export function parseHandshake(msg: Uint8Array): HandshakeMessage {
  const r = new Reader(msg);
  if (r.u8() !== 0) throw new Error('unexpected message type');
  const authBlob = r.bytes(r.varUint());
  const info = r.bytes(r.varUint());
  if (r.remaining > 0) throw new Error('trailing bytes');
  return { authBlob, info };
}

export interface JoinPlayerInfo {
  name: string;
  /** Country code as sent by the client (`country`/`flag`). */
  flag: string;
  avatar: string | null;
}

/**
 * Parses the join info with the official length checks (throws
 * 'name too long' / 'country too long' / 'avatar too long'). Bytes after the
 * avatar are ignored, as officially (the info has its own reader).
 */
export function parseJoinInfo(info: Uint8Array): JoinPlayerInfo {
  const r = new Reader(info);
  const name = r.string();
  if (name.length > JoinLimits.name) throw new Error('name too long');
  const flag = r.string();
  if (flag.length > JoinLimits.flag) throw new Error('country too long');
  const avatar = r.nullableString();
  if (avatar !== null && avatar.length > JoinLimits.avatar) throw new Error('avatar too long');
  return { name, flag, avatar };
}

/** Client-side encoder (tests/tools): `[0][varuint n][auth][varuint m][info]`. */
export function encodeHandshake(authBlob: Uint8Array | null, info: JoinPlayerInfo): Uint8Array {
  const iw = new Writer(64);
  iw.string(info.name);
  iw.string(info.flag);
  iw.nullableString(info.avatar);
  const infoBytes = iw.finish();
  const w = new Writer(16 + (authBlob?.length ?? 0) + infoBytes.length);
  w.u8(0);
  w.varUint(authBlob?.length ?? 0);
  if (authBlob) w.bytes(authBlob);
  w.varUint(infoBytes.length);
  w.bytes(infoBytes);
  return w.copyBytes();
}

/** Host -> client kick/ban notice `[5][u8 ban][string reason][string byName]` (`Wa.Mg`). */
export function encodeKick(reason: string, ban: boolean, byName: string | null): Uint8Array {
  const w = new Writer(16 + reason.length * 3 + (byName?.length ?? 0) * 3);
  w.u8(5);
  w.u8(ban ? 1 : 0);
  w.string(reason);
  w.string(byName ?? '');
  return w.copyBytes();
}
