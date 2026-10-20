/**
 * ops/haxguard configuration checks. The nft files are validated with `nft -c`
 * inside a throwaway user+network namespace (nothing is loaded into the host);
 * those cases are skipped when nft or unprivileged namespaces are unavailable.
 * The text checks pin the properties `nft -c` cannot see (a syntactically valid
 * ruleset can still blackhole the whole interface).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../ops/haxguard/', import.meta.url));
const file = (name: string): string => dir + name;
const read = (name: string): string => readFileSync(file(name), 'utf8');
const NFT_FILES = ['haxguard.nft', 'relay-only.nft', 'canary-counters.nft'];

const inNs = (script: string) => spawnSync('unshare', ['-rn', 'sh', '-c', script], { encoding: 'utf8' });
const hasNft = inNs('nft --version').status === 0;
const hasClang = spawnSync('clang', ['--version']).status === 0;

/** Bodies of every `set name { ... }` block (brace-balanced, comments stripped). */
function setBlocks(src: string): { name: string; body: string }[] {
  const text = src.replace(/#.*$/gm, '');
  const out: { name: string; body: string }[] = [];
  const re = /\bset\s+(\w+)\s*\{/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    out.push({ name: m[1]!, body: text.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** Rules (non-empty, non-comment lines) of `chain <name> { ... }` in a nft file. */
function chainRules(src: string, chain: string): string[] {
  const start = src.search(new RegExp(`chain\\s+${chain}\\s*\\{`));
  expect(start).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  for (; i < src.length && depth > 0; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
  return src
    .slice(open + 1, i - 1)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

describe('ops/haxguard nft files', () => {
  it.skipIf(!hasNft).each(NFT_FILES)('%s passes nft -c', (name) => {
    const r = inNs(`nft -c -f ${file(name)}`);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('sets holding prefix elements declare flags interval', () => {
    for (const name of NFT_FILES) {
      for (const set of setBlocks(read(name))) {
        if (/\d\/\d+|::\/\d+/.test(set.body)) expect(set.body, `${name}:${set.name}`).toMatch(/flags[^;\n]*\binterval\b/);
      }
    }
  });

  it.skipIf(!hasNft)('relay-only.nft reloads without duplicating rules', () => {
    const f = file('relay-only.nft');
    const r = inNs(`nft -f ${f} && nft -f ${f} && nft -f ${f} && nft list chain inet haxhost out`);
    expect(r.status).toBe(0);
    expect(r.stdout.match(/udp sport/g)).toHaveLength(3);
  });

  it('haxguard.nft drops only UDP to the room ports at the end of ingress', () => {
    const rules = chainRules(read('haxguard.nft'), 'ingress').filter((l) => !l.startsWith('type '));
    const last = rules[rules.length - 1]!;
    expect(last).toMatch(/^udp dport \$ROOM_PORTS\b.*\bdrop$/);
    // Every unconditional verdict would take TCP, ICMP and ARP/ND down with it.
    for (const rule of rules) expect(rule).not.toMatch(/^counter name \w+ drop$/);
  });

  it('haxguard.nft caps the pending lane and keys the unknown-STUN meter by prefix', () => {
    const src = read('haxguard.nft');
    expect(chainRules(src, 'pending_rate').join('\n')).toMatch(/limit rate over \d+\/second/);
    expect(chainRules(src, 'ingress').join('\n')).toMatch(/@pending4 jump pending_rate/);
    const stun = chainRules(src, 'stun_unknown').join('\n');
    expect(stun).toMatch(/add @stunrate4 \{ ip saddr & \$STUN_V4_MASK limit/);
    expect(stun).toMatch(/add @stunrate6 \{ ip6 saddr & \$STUN_V6_MASK limit/);
    // The per-source meter is evaluated before the shared budget.
    expect(stun.indexOf('add @stunrate4')).toBeLessThan(stun.indexOf('limit rate 2000/second'));
  });
});

describe('ops/haxguard XDP sketch', () => {
  it.skipIf(!hasClang)('compiles for bpf', () => {
    const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
    const r = spawnSync(
      'clang',
      ['-O2', '-g', '-target', 'bpf', `-I/usr/include/${arch}-linux-gnu`, '-c', file('haxguard_xdp.c'), '-o', '/dev/null'],
      { encoding: 'utf8' },
    );
    // Without the linux headers (asm/types.h) there is nothing to assert about the source.
    if (/'asm\/types\.h' file not found/.test(r.stderr)) return;
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('never treats a missing expiry as permanent and rate-limits the established lanes', () => {
    const src = read('haxguard_xdp.c');
    expect(src).not.toMatch(/expires_ns\s*==\s*0\s*\|\|/);
    expect(src).toMatch(/allow_src\(&actrate4/);
    expect(src).toMatch(/allow_global\(G_STUN/);
    expect(src).toMatch(/allow_global\(G_PENDING/);
  });
});
