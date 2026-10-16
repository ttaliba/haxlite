/**
 * deflateRaw: on Bun it uses `Bun.deflateSync`, which must give the same
 * bytes as node:zlib `deflateRawSync` (what it replaces); deflateRawAsync
 * (threadpool) must give the same bytes as the sync path, on both runtimes.
 * The Bun half runs in a `bun` child process and is skipped when bun is not
 * on PATH.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateRaw, deflateRawAsync, inflateRaw } from '../../src/codec/compress.js';

/** Deterministic inputs: empty, tiny, zeros, noise, text-like, structured binary, large. */
const INPUTS_SRC = `
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) & 0xff;
  const bytes = (n, f) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = f(i); return a; };
  const words = 'kick ball goal red blue team admin stadium vertex segment plane disc '.split(' ');
  const text = (n) => { let s = ''; while (s.length < n) s += words[rnd() % words.length] + (rnd() % 7 ? ' ' : '\\n'); return new TextEncoder().encode(s.slice(0, n)); };
  const INPUTS = [
    new Uint8Array(0),
    new Uint8Array([7]),
    bytes(70000, () => 0),
    bytes(3000, rnd),
    text(600),
    text(12000),
    bytes(20000, (i) => ((i * 7) ^ (i >> 4)) & 0x3f),
    bytes(300000, (i) => (i % 97 < 40 ? rnd() & 0x0f : i & 0xff)),
  ];
`;
const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, -1];

function nodeRef(data: Uint8Array, level: number): Buffer {
  return deflateRawSync(data, { level, memLevel: 8, windowBits: 15 });
}

describe('deflateRaw / deflateRawAsync', () => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const INPUTS = new Function(`${INPUTS_SRC}; return INPUTS;`)() as Uint8Array[];

  it('sync = node:zlib deflateRawSync and round-trips (this runtime)', () => {
    for (const inp of INPUTS) {
      for (const level of [0, ...LEVELS]) {
        const out = deflateRaw(inp, level);
        expect(Buffer.from(inflateRaw(out)).equals(Buffer.from(inp))).toBe(true);
        expect(Buffer.from(out).equals(nodeRef(inp, level)), `len ${inp.length} level ${level}`).toBe(true);
      }
    }
  });

  it('async = sync, byte for byte', async () => {
    for (const inp of INPUTS) {
      for (const level of [0, 1, 6, 9]) {
        const a = await deflateRawAsync(inp, level);
        expect(Buffer.from(a).equals(nodeRef(inp, level)), `len ${inp.length} level ${level}`).toBe(true);
      }
    }
  });

  // The real executable (on Windows `bun` on PATH may be an npm .cmd shim).
  const probe = spawnSync('bun -e "console.log(process.execPath)"', { encoding: 'utf8', shell: true });
  const bunExe = probe.status === 0 ? probe.stdout.trim().split('\n').pop()!.trim() : '';
  const hasBun = bunExe !== '';
  it.skipIf(!hasBun)('on Bun: Bun.deflateSync path = node:zlib deflateRawSync (levels 0-9), async = sync', () => {
    const mod = pathToFileURL(new URL('../../src/codec/compress.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;
    const script = `
      import { deflateRawSync, inflateRawSync } from 'node:zlib';
      const { deflateRaw, deflateRawAsync } = await import(${JSON.stringify(mod)});
      ${INPUTS_SRC}
      // Random inputs around the 64 KB input / 16 KB output thresholds, level 6.
      for (let k = 0; k < 60; k++) {
        const size = 1 + ((rnd() << 8 | rnd()) * 2) % 80000, mask = [1, 7, 63, 255][k % 4], q = 2 + rnd();
        INPUTS.push(bytes(size, (i) => (k % 3 === 0 ? rnd() & mask : k % 3 === 1 ? (i % q < q / 3 ? rnd() & mask : (i * 13) & 0xff) : (rnd() & mask) + 97)));
      }
      const bad = []; let checked = 0;
      for (const [n, inp] of INPUTS.entries()) for (const level of n < 8 ? [0, ${LEVELS.join(',')}] : [6]) {
        const ours = Buffer.from(deflateRaw(inp, level));
        const ref = deflateRawSync(inp, { level, memLevel: 8, windowBits: 15 });
        checked++;
        if (!ours.equals(ref)) bad.push('sync len ' + inp.length + ' level ' + level);
        // Bun 1.4's async level 1 differs from its sync level 1 (not used by haxlite).
        if (level !== 1 && !Buffer.from(await deflateRawAsync(inp, level)).equals(ref)) bad.push('async len ' + inp.length + ' level ' + level);
        if (!inflateRawSync(ours).equals(Buffer.from(inp))) bad.push('inflate len ' + inp.length + ' level ' + level);
      }
      console.log(JSON.stringify({ bun: typeof Bun !== 'undefined', checked, bad }));
    `;
    const r = spawnSync(bunExe, ['-e', script], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { bun: boolean; checked: number; bad: string[] };
    expect(res.bun).toBe(true);
    expect(res.checked).toBe(8 * 11 + 60);
    expect(res.bad).toEqual([]);
  });
});
