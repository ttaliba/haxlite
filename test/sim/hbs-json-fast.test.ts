/**
 * parseHbs JSON fast path: plain-JSON text goes through `JSON.parse` and
 * json5 only sees what JSON rejects. The result must be the same Stadium
 * (and the same bytes) as through json5, and invalid text must still report
 * json5's SyntaxError.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { describe, expect, it } from 'vitest';
import { Writer } from '../../src/codec/index.js';
import { parseHbs, writeStadium } from '../../src/sim/index.js';
import type { Stadium } from '../../src/sim/index.js';
import { nh } from '../oracle/index.js';
import { ARENA_HBS, HAND, randomHbs } from './hbs-corpus.js';
import type { HbsCase } from './hbs-corpus.js';

const hex = (s: Stadium) => {
  const w = new Writer(8192);
  writeStadium(w, s);
  return Buffer.from(w.copyBytes()).toString('hex');
};

/** Same document, but not JSON any more (a leading comment): forces the json5 path. */
const viaJson5 = (hbs: string) => `// json5\n${hbs}`;

// Real maps from the bot's checkout when present (read-only, never committed).
// (repo root, or the main checkout when running from .claude/worktrees/<name>)
const mapsDirs = [fileURLToPath(new URL('../../sala/maps/', import.meta.url)), fileURLToPath(new URL('../../../../../sala/maps/', import.meta.url))].filter((d) => existsSync(d));
const REAL: HbsCase[] = mapsDirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith('.json') || f.endsWith('.hbs'))
    .map((f) => ({ name: `sala/maps/${f}`, hbs: readFileSync(d + f, 'utf8') })),
);

const EXPORTED: HbsCase[] = nh.Utils.getDefaultStadiums().map((s: { name: string }) => ({
  name: `exported ${s.name}`,
  hbs: nh.Utils.exportStadium(s) as string,
}));
const RANDOM: HbsCase[] = Array.from({ length: 40 }, (_, i) => ({ name: `random #${i}`, hbs: randomHbs(5000 + i) }));
// JSON re-serialization of the JSON5 corpus: plain JSON by construction.
const ASJSON: HbsCase[] = [...HAND, { name: 'arena', hbs: ARENA_HBS }].flatMap((c) => {
  try {
    return [{ name: `${c.name} as JSON`, hbs: JSON.stringify(JSON5.parse(c.hbs), null, 1) }];
  } catch {
    return [];
  }
});

const isJson = (t: string) => {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};
const JSON_CASES = [...EXPORTED, ...RANDOM, ...ASJSON, ...REAL].filter((c) => isJson(c.hbs));

describe('parseHbs: JSON.parse first, json5 only when it throws', () => {
  it('the corpus contains plain-JSON stadiums', () => {
    expect(JSON_CASES.length).toBeGreaterThan(20);
  });

  for (const c of JSON_CASES) {
    it(`same Stadium as through json5: ${c.name}`, () => {
      expect(JSON.parse(c.hbs)).toEqual(JSON5.parse(c.hbs));
      let fast: Stadium | null = null;
      let fastErr: unknown = null;
      try {
        fast = parseHbs(c.hbs);
      } catch (e) {
        fastErr = e;
      }
      let slow: Stadium | null = null;
      let slowErr: unknown = null;
      try {
        slow = parseHbs(viaJson5(c.hbs));
      } catch (e) {
        slowErr = e;
      }
      expect(String(fastErr)).toBe(String(slowErr));
      if (fast !== null) {
        expect(fast).toEqual(slow);
        expect(hex(fast)).toBe(hex(slow!));
      }
    });
  }

  it('JSON5-only syntax still parses (comments, unquoted keys, trailing commas, hex, leading +)', () => {
    const s = parseHbs(`{
      // comment
      name: 'J5', width: 0x1A4, height: 200, /* block */
      bg: { type: 'grass', },
      vertexes: [ { x: -1, y: +2, }, { x: .5, y: 3. }, ],
      spawnDistance: +170,
    }`);
    expect(s.name).toBe('J5');
    expect(s.width).toBe(420);
    expect(s.spawnDistance).toBe(170);
    expect(s.vertexes.map((v) => [v.x, v.y])).toEqual([
      [-1, 2],
      [0.5, 3],
    ]);
  });

  it('invalid text reports the same json5 SyntaxError as before', () => {
    for (const bad of ['{name: "x",', '{"a": 1}}', '', '{"a": undefined}', 'nope', '{"a":01}', '﻿{"a":']) {
      let expected: Error | null = null;
      try {
        JSON5.parse(bad);
      } catch (e) {
        expected = e as Error;
      }
      expect(expected, bad).not.toBeNull();
      let got: Error | null = null;
      try {
        parseHbs(bad);
      } catch (e) {
        got = e as Error;
      }
      expect(got?.constructor, bad).toBe(expected!.constructor);
      expect(got?.message, bad).toBe(expected!.message);
    }
  });

  it('own __proto__ keys: JSON.parse and json5 agree (no prototype pollution)', () => {
    const t = '{"__proto__": {"x": 1}, "name": "p"}';
    expect(Object.getPrototypeOf(JSON.parse(t))).toBe(Object.prototype);
    expect(Object.getPrototypeOf(JSON5.parse(t))).toBe(Object.prototype);
    expect(JSON.parse(t)).toEqual(JSON5.parse(t));
  });
});
