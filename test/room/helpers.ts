/**
 * Shared helpers for the room tests: official-oracle event round trip,
 * random value pools and a check for whether engineer A's sim is wired.
 */
import { defaultStadiums } from '../../src/sim/index.js';
import { officialInternals } from '../oracle/official.js';

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** True once src/sim exports a working defaultStadiums()/readStadium()/stepWorld(). */
export function simReady(): boolean {
  try {
    return defaultStadiums().length === 10;
  } catch {
    return false;
  }
}

/**
 * Decodes event bytes (u8 type + payload) with the OFFICIAL headless classes
 * and re-encodes them with the official writer (`m.te`). Returns the official
 * bytes and the number of bytes the official reader consumed.
 */
export function officialRoundTrip(bytes: Uint8Array): { bytes: Uint8Array; consumed: number } {
  const x = officialInternals();
  const r = new x.L(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), false);
  const ev = x.m.Ji(r);
  ev.W(r);
  const consumed = r.a as number; // `a` = reader cursor
  const w = x.A.aa();
  x.m.te(ev, w);
  return { bytes: Uint8Array.from(w.Db() as Uint8Array), consumed };
}

const STRING_POOL = [
  '',
  'a',
  'hola',
  'Ñandú ünïcödé',
  '😀 emoji 🎉',
  '中文字符',
  'x'.repeat(25),
  '\u0000nul',
  'lone \ud800 surrogate',
];

export function randString(rnd: () => number, maxLen = 40): string {
  if (rnd() < 0.5) {
    const s = STRING_POOL[Math.floor(rnd() * STRING_POOL.length)]!;
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }
  const n = Math.floor(rnd() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < n; i++) {
    const k = rnd();
    s += k < 0.7 ? String.fromCharCode(32 + Math.floor(rnd() * 95)) : k < 0.9 ? String.fromCharCode(0xa0 + Math.floor(rnd() * 0x700)) : '😀';
  }
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function randInt32(rnd: () => number): number {
  const k = rnd();
  if (k < 0.2) return Math.floor(rnd() * 10);
  if (k < 0.4) return [0, -1, 1, 2147483647, -2147483648, 255, 256, 65535, 65536][Math.floor(rnd() * 9)]!;
  return (Math.floor(rnd() * 4294967296) | 0);
}

export function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}
