/**
 * .hbs parser: our parseHbs + writeStadium must produce the same bytes as the
 * OFFICIAL parser (`w.kh` + `w.G`) for every stadium of the corpus, and
 * (where node-haxball agrees with the official one) as node-haxball's
 * `hbsToStadiumBytes`. Invalid inputs must be rejected in the same cases.
 */
import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/codec/index.js';
import { parseHbs, readStadium, writeStadium } from '../../src/sim/index.js';
import type { Stadium } from '../../src/sim/index.js';
import { hbsToStadiumBytes, nh } from '../oracle/index.js';
import { BAD, HAND, randomHbs } from './hbs-corpus.js';
import type { HbsCase } from './hbs-corpus.js';
import { officialParseHbs, officialReadStadium, officialStadiumBytes } from './official-sim.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function ourBytes(s: Stadium): Uint8Array {
  const w = new Writer(8192);
  writeStadium(w, s);
  return w.copyBytes();
}

/** Default stadiums exported to .hbs by node-haxball (uses ballPhysics "disc0" and every field). */
const EXPORTED: HbsCase[] = nh.Utils.getDefaultStadiums().map((s: { name: string }) => ({
  name: `exported ${s.name}`,
  hbs: nh.Utils.exportStadium(s) as string,
}));

const RANDOM: HbsCase[] = Array.from({ length: 80 }, (_, i) => ({ name: `random #${i}`, hbs: randomHbs(1000 + i) }));

describe('parseHbs vs the official parser', () => {
  for (const c of [...HAND, ...EXPORTED, ...RANDOM]) {
    it(c.name, () => {
      const official = hex(officialStadiumBytes(officialParseHbs(c.hbs)));
      const st = parseHbs(c.hbs);
      const ours = ourBytes(st);
      expect(hex(ours)).toBe(official);
      // binary round trip (what every client sees) == official reader + writer.
      // Not always idempotent: an invalid colour reads back as 0 (flag lost),
      // more than 255 joints wraps the u8 count.
      let officialBack: string;
      try {
        officialBack = hex(officialStadiumBytes(officialReadStadium(ours)));
      } catch {
        officialBack = '<throws>';
      }
      let oursBack: string;
      try {
        oursBack = hex(ourBytes(readStadium(new Reader(ours))));
      } catch {
        oursBack = '<throws>';
      }
      expect(oursBack).toBe(officialBack);
    });
  }
});

describe('parseHbs vs node-haxball', () => {
  // node-haxball's parser is stricter than the official one (e.g. it rejects
  // a stadium without "vertexes"/"segments"/... arrays). When it accepts a
  // stadium, its bytes must equal ours.
  for (const c of [...HAND, ...EXPORTED, ...RANDOM]) {
    it(c.name, () => {
      let nhBytes: Uint8Array | null = null;
      try {
        nhBytes = hbsToStadiumBytes(c.hbs);
      } catch {
        nhBytes = null;
      }
      if (nhBytes === null) return;
      expect(hex(ourBytes(parseHbs(c.hbs)))).toBe(hex(nhBytes));
    });
  }
});

describe('invalid .hbs is rejected like the official parser', () => {
  for (const c of BAD) {
    it(c.name, () => {
      let officialError: unknown = null;
      try {
        officialParseHbs(c.hbs);
      } catch (e) {
        officialError = e;
      }
      expect(officialError, 'official parser should reject').not.toBeNull();
      let ourError: unknown = null;
      try {
        parseHbs(c.hbs);
      } catch (e) {
        ourError = e;
      }
      expect(ourError, 'parseHbs should reject').not.toBeNull();
      const om = String((officialError as Error).message ?? officialError);
      const m = String((ourError as Error).message);
      // Same wording for the official explicit errors.
      if (/^Error in "/.test(om) || om === 'Error' || om === 'Bad color' || om === 'Bad team value') expect(m).toBe(om);
    });
  }
});
