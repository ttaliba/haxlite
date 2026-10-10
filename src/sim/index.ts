/**
 * src/sim — physics engine, stadiums, World (OWNER: engineer A).
 *
 * Contract other modules rely on (signatures may be refined by the owner, but
 * keep them pure functions over the shared model in ./types.ts):
 *   stepWorld(world, dt)            official `Oa.Da(dt)`; dt = 1 in the authoritative sim
 *   writeStadium(w, stadium)        official `w.G` (u8 id, then body if 255)
 *   readStadium(r)                  official static reader (u8 id -> default or body)
 *   parseHbs(text)                  official `w.kh` (JSON5 .hbs)
 *   defaultStadiums()               official `w.Fd()` (index = defaultStadiumId)
 *   writeDisc / writeWorld          92-byte disc layout; `u8 n` + discs (assigns disc.index)
 */
import type { Reader, Writer } from '../codec/index.js';
import type { Disc, Stadium, World } from './types.js';

export * from './types.js';

const notImplemented = (what: string): never => {
  throw new Error(`not implemented: sim.${what}`);
};

export function stepWorld(_world: World, _dt: number): void {
  notImplemented('stepWorld');
}
export function writeStadium(_w: Writer, _stadium: Stadium): void {
  notImplemented('writeStadium');
}
export function readStadium(_r: Reader): Stadium {
  return notImplemented('readStadium');
}
export function parseHbs(_text: string): Stadium {
  return notImplemented('parseHbs');
}
export function defaultStadiums(): readonly Stadium[] {
  return notImplemented('defaultStadiums');
}
export function writeDisc(_w: Writer, _disc: Disc): void {
  notImplemented('writeDisc');
}
export function writeWorld(_w: Writer, _world: World): void {
  notImplemented('writeWorld');
}
