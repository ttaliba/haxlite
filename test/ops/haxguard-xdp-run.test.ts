/**
 * ops/haxguard/haxguard_xdp.c run through BPF_PROG_TEST_RUN (test/ops/xdp_test_run.c).
 * Needs clang with the linux headers, a C compiler with libbpf and a privileged user able to load
 * BPF programs; the cases are skipped otherwise. Nothing is attached to an interface and no map is
 * pinned: the program is loaded, fed synthetic frames and released.
 * Loading BPF needs root (CAP_BPF), so an unprivileged `npx vitest run` skips every case here,
 * saying why; HAXLITE_REQUIRE_OPS=1 turns the skip into a failure (run it as root, docs/12 section 7).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { needs } from './ops-env.js';

const src = (name: string): string => fileURLToPath(new URL(`../../ops/haxguard/${name}`, import.meta.url));
const harness = fileURLToPath(new URL('./xdp_test_run.c', import.meta.url));

const XDP_DROP = 1;
const XDP_PASS = 2;

let tmp = '';
let results: Record<string, number> | null = null;
let why = '';

beforeAll(() => {
  const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
  tmp = mkdtempSync(join(tmpdir(), 'haxguard-xdp-'));
  const obj = join(tmp, 'haxguard_xdp.o');
  const bpf = spawnSync(
    'clang',
    ['-O2', '-g', '-target', 'bpf', `-I/usr/include/${arch}-linux-gnu`, '-c', src('haxguard_xdp.c'), '-o', obj],
    { encoding: 'utf8' },
  );
  if (bpf.error || /'asm\/types\.h' file not found/.test(bpf.stderr)) return void (why = 'no clang or linux headers');
  expect(bpf.stderr).toBe('');
  expect(bpf.status).toBe(0);
  const bin = join(tmp, 'xdp_test_run');
  const cc = spawnSync('cc', ['-O1', '-o', bin, harness, '-lbpf'], { encoding: 'utf8' });
  if (cc.error || /bpf\/(libbpf|bpf)\.h|cannot find -lbpf/.test(cc.stderr)) return void (why = 'no C compiler or libbpf');
  expect(cc.status, cc.stderr).toBe(0);
  const run = spawnSync(bin, [obj], { encoding: 'utf8' });
  if (run.status === 77) return void (why = `the kernel refuses to load BPF programs here (needs root or CAP_BPF; ${run.stderr.trim()})`);
  expect(run.status, run.stderr).toBe(0);
  results = Object.fromEntries(
    run.stdout
      .trim()
      .split('\n')
      .map((l) => l.split('=') as [string, string])
      .map(([k, v]) => [k, Number(v)]),
  );
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** What the harness printed; skips the case (fails it under HAXLITE_REQUIRE_OPS=1) when it could not run. */
function runResults(ctx: TestContext): Record<string, number> {
  needs(ctx, results ? null : why);
  return results!;
}

describe('ops/haxguard XDP sketch (BPF_PROG_TEST_RUN)', () => {
  it('a clock that runs behind another CPU does not refill the global buckets', (ctx) => {
    const results = runResults(ctx);
    // gbucket last_ns is 30 s ahead of the clock the packet reads, with no tokens left.
    expect(results.stun_global_clock_behind_of_50).toBe(0);
    expect(results.pending_global_clock_behind_of_50).toBe(0);
  });

  it('an idle global bucket still refills up to its burst and no further', (ctx) => {
    const results = runResults(ctx);
    // STUN_GLOBAL_BURST is 500; a few ms of refill at 2000/s may add a handful.
    expect(results.stun_global_idle_of_600).toBeGreaterThanOrEqual(500);
    expect(results.stun_global_idle_of_600).toBeLessThan(560);
  });

  it('judges only UDP to the room ports; fragments and malformed packets go first', (ctx) => {
    const results = runResults(ctx);
    expect(results.other_port_plain).toBe(XDP_PASS);
    // IP options do not change the verdict for a port that is not a room.
    expect(results.other_port_ip_options).toBe(XDP_PASS);
    expect(results.other_port_ip_options_max).toBe(XDP_PASS);
    expect(results.room_port_ip_options).toBe(XDP_DROP);
    // Malformed (IPv4 header under 20 B, UDP header cut short) goes to the kernel's own drop.
    expect(results.other_port_ihl_below_5).toBe(XDP_DROP);
    expect(results.other_port_truncated_udp).toBe(XDP_DROP);
    // UDP fragments are dropped whatever their port, as haxguard.nft does.
    expect(results.other_port_fragment).toBe(XDP_DROP);
    expect(results.other_port_fragment_tail).toBe(XDP_DROP);
    expect(results.room_port_fragment).toBe(XDP_DROP);
  });

  it('keeps the lanes: unknown non-STUN dropped, STUN burst per source, players and expiry', (ctx) => {
    const results = runResults(ctx);
    expect(results.unknown_non_stun).toBe(XDP_DROP);
    expect(results.stun_one_source_of_30).toBe(10);
    expect(results.active_expired_non_stun).toBe(XDP_DROP);
    expect(results.active_fresh_non_stun).toBe(XDP_PASS);
    expect(results.pending_bogon_non_stun).toBe(XDP_DROP);
    expect(results.vlan_unknown_non_stun).toBe(XDP_DROP);
  });
});
