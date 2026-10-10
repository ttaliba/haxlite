/**
 * RoomInfo (`ab.G`, little-endian) published with signaling message 7, and
 * the `/rs/api/list` container (docs/02 §7, docs/01 §1.3).
 */
import { Reader, Writer } from '../codec/index.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import { RoomInfoLimits } from './constants.js';

export interface RoomInfo {
  /** `pi` (u16 LE), 9. */
  version: number;
  /** `pa`, truncated to 40 UTF-16 units. */
  name: string;
  /** `ib`, country code, truncated to 3. */
  flag: string;
  /** `Sc` (f32 LE). */
  lat: number;
  /** `Uc` (f32 LE). */
  lon: number;
  /** `mb != null` (u8). */
  password: boolean;
  /** `xh` (u8). */
  maxPlayers: number;
  /** `ba` (u8). */
  players: number;
}

export function defaultRoomInfo(): RoomInfo {
  return {
    version: PROTOCOL_VERSION,
    name: 'Headless Room',
    flag: '',
    lat: 0,
    lon: 0,
    password: false,
    maxPlayers: 12,
    players: 0,
  };
}

/** Serializes a RoomInfo exactly like `ab.G` (truncation `ab.yg` included). */
export function encodeRoomInfo(info: RoomInfo, w: Writer = new Writer(64)): Uint8Array {
  w.reset();
  w.u16LE(info.version);
  w.stringU8(truncate(info.name, RoomInfoLimits.name));
  w.stringU8(truncate(info.flag, RoomInfoLimits.flag));
  w.f32LE(info.lat);
  w.f32LE(info.lon);
  w.u8(info.password ? 1 : 0);
  w.u8(info.maxPlayers);
  w.u8(info.players);
  return w.copyBytes();
}

export function decodeRoomInfo(bytes: Uint8Array): RoomInfo {
  const r = new Reader(bytes);
  const version = r.u16LE();
  const name = new TextDecoder().decode(r.bytes(r.u8()));
  const flag = new TextDecoder().decode(r.bytes(r.u8()));
  return {
    version,
    name,
    flag,
    lat: r.f32LE(),
    lon: r.f32LE(),
    password: r.u8() !== 0,
    maxPlayers: r.u8(),
    players: r.u8(),
  };
}

/** `R.rb(s, n)`: substring by UTF-16 units. */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

export interface ListedRoom {
  id: string;
  info: RoomInfo;
}

/** Parses `/rs/api/list`: `u8 0`, then `{u16 BE idLen, id, u16 BE dataLen, RoomInfo}*`. */
export function parseRoomList(bytes: Uint8Array): ListedRoom[] {
  const r = new Reader(bytes);
  r.u8();
  const out: ListedRoom[] = [];
  const dec = new TextDecoder();
  while (r.remaining > 0) {
    const id = dec.decode(r.bytes(r.u16()));
    const data = r.bytes(r.u16());
    out.push({ id, info: decodeRoomInfo(data) });
  }
  return out;
}

/** Builds a `/rs/api/list` payload (used by the fake master). */
export function encodeRoomList(rooms: readonly { id: string; info: Uint8Array }[]): Uint8Array {
  const w = new Writer(256);
  w.u8(0);
  const enc = new TextEncoder();
  for (const room of rooms) {
    const id = enc.encode(room.id);
    w.u16(id.length);
    w.bytes(id);
    w.u16(room.info.length);
    w.bytes(room.info);
  }
  return w.copyBytes();
}
