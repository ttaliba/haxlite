/**
 * Built-in stadiums: generated geometry must be byte-identical to the
 * official generator (`w.Fd()`, forced to the 255 form) and to node-haxball's
 * `stadiumToBytes(i, { forceCustom: true })`; the 1-byte form and the reader
 * round trip are checked too.
 */
import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/codec/index.js';
import {
  buildDefaultStadium,
  defaultStadiums,
  readStadium,
  writeStadium,
  writeStadiumBody,
} from '../../src/sim/index.js';
import type { Stadium } from '../../src/sim/index.js';
import { DEFAULT_STADIUM_NAMES, stadiumToBytes } from '../oracle/index.js';
import { officialDefaults, officialStadiumBytes } from './official-sim.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function forceCustomBytes(s: Stadium): Uint8Array {
  const w = new Writer(4096);
  w.u8(255);
  writeStadiumBody(w, s);
  return w.copyBytes();
}

describe('default stadiums', () => {
  it('has the official names in order', () => {
    expect(defaultStadiums().map((s) => s.name)).toEqual(DEFAULT_STADIUM_NAMES);
    expect(defaultStadiums().map((s) => s.defaultStadiumId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  for (let i = 0; i < 10; i++) {
    it(`#${i} geometry is byte-identical to the official generator and node-haxball`, () => {
      const ours = forceCustomBytes(defaultStadiums()[i]!);
      expect(hex(ours)).toBe(hex(officialStadiumBytes(officialDefaults()[i], true)));
      // node-haxball initialises bgGoalLine to 0, while the official grass
      // builder (`lb`) never assigns it (undefined -> NaN on the wire). Only
      // visible in this forced 255 form: built-ins travel as 1 byte.
      const nhView = buildDefaultStadium(i);
      if (Number.isNaN(nhView.bgGoalLine)) nhView.bgGoalLine = 0;
      expect(hex(forceCustomBytes(nhView))).toBe(hex(stadiumToBytes(i, { forceCustom: true })));
      // fresh copies are identical too
      expect(hex(forceCustomBytes(buildDefaultStadium(i)))).toBe(hex(ours));
    });

    it(`#${i} serializes as a single byte and reads back as the shared instance`, () => {
      const w = new Writer(16);
      writeStadium(w, defaultStadiums()[i]!);
      const b = w.copyBytes();
      expect(hex(b)).toBe(hex(stadiumToBytes(i)));
      expect(hex(b)).toBe(hex(officialStadiumBytes(officialDefaults()[i])));
      expect(readStadium(new Reader(b))).toBe(defaultStadiums()[i]);
    });

    it(`#${i} 255-form round-trips through readStadium`, () => {
      const bytes = forceCustomBytes(defaultStadiums()[i]!);
      const back = readStadium(new Reader(bytes));
      expect(back.defaultStadiumId).toBe(255);
      expect(hex(forceCustomBytes(back))).toBe(hex(bytes));
    });
  }
});
