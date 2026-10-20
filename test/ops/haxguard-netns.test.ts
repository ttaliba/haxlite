/**
 * Behaviour of ops/haxguard/*.nft with real packets, inside throwaway user+network namespaces
 * (a veth pair between two of them; nothing touches the host's network or mount namespace).
 * Skipped, with the reason printed, when nft, ip or unprivileged namespaces are unavailable
 * (HAXLITE_REQUIRE_OPS=1 fails them instead).
 *
 * IPv6 is exercised with raw frames (test/ops/netns-v6.py, AF_PACKET + python3): the ingress hook
 * sees them like any other, so the ip6 rules run for real even on a kernel without IPv6. What that
 * does not cover is the kernel's own IPv6 stack (no v6 sockets, ND or ICMPv6) behind the hook.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { needs, why } from './ops-env.js';

const nft = (name: string): string => fileURLToPath(new URL(`../../ops/haxguard/${name}`, import.meta.url));
const gen = `'${process.execPath}' '${fileURLToPath(new URL('./netns-udp.mjs', import.meta.url))}'`;
const gen6 = `python3 '${fileURLToPath(new URL('./netns-v6.py', import.meta.url))}'`;

/** Runs `script` as root of a new user+net+mount namespace; /run is a private tmpfs so `ip netns` leaves nothing behind. */
const inNs = (script: string, mount = true) =>
  spawnSync('unshare', [mount ? '-rnm' : '-rn', 'sh', '-ec', mount ? `mount -t tmpfs none /run\n${script}` : script], {
    encoding: 'utf8',
    timeout: 60_000,
  });

const nftProbe = inNs('nft --version', false);
const noNft = nftProbe.status === 0 ? null : why('nft or unprivileged user+net namespaces (unshare -rn) unavailable', nftProbe);
const vethProbe = noNft ? null : inNs('ip netns add probe; ip -n probe link add va type veth peer name vb');
const noVeth = noNft ?? (vethProbe!.status === 0 ? null : why('ip netns and veth pairs are not usable in an unprivileged namespace', vethProbe!));
// AF_PACKET is what lets the IPv6 cases run on a kernel without AF_INET6.
const packetProbe = noVeth ? null : inNs(`python3 -c 'import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)'`, false);
const noPacket = noVeth ?? (packetProbe!.status === 0 ? null : why('python3 with AF_PACKET sockets is not usable in an unprivileged namespace', packetProbe!));

/** Two namespaces joined by a veth: hgS (198.51.100.1, runs the ruleset) and hgC (.2 .3 .4, the same /24). */
const TOPOLOGY = `
ip netns add hgS; ip netns add hgC
ip -n hgS link add eth0 type veth peer name peer0
ip -n hgS link set peer0 netns hgC
ip -n hgC link set peer0 name eth0
ip -n hgS addr add 198.51.100.1/24 dev eth0
for i in 2 3 4; do ip -n hgC addr add 198.51.100.$i/24 dev eth0; done
ip -n hgS link set eth0 up; ip -n hgC link set eth0 up
S="ip netns exec hgS"; C="ip netns exec hgC"
cnt() { $S nft list counter netdev haxguard "$1" | awk '/packets/ { print $2 }'; }
noports() { $S awk '/^Udp:/ { n++; if (n == 1) for (i = 1; i <= NF; i++) h[i] = $i; else for (i = 1; i <= NF; i++) if (h[i] == "NoPorts") print $i }' /proc/net/snmp; }
`;

/** The same pair without addresses: hgC injects IPv6 frames from peer0 (g6 <count> <base> [naddr [step]]) into hgS's eth0. */
const TOPOLOGY6 = `
ip netns add hgS; ip netns add hgC
ip -n hgS link add eth0 type veth peer name peer0
ip -n hgS link set peer0 netns hgC
ip -n hgS link set eth0 up; ip -n hgC link set peer0 up
S="ip netns exec hgS"; C="ip netns exec hgC"
cnt() { $S nft list counter netdev haxguard "$1" | awk '/packets/ { print $2 }'; }
MAC=$($S cat /sys/class/net/eth0/address)
g6() { $C ${gen6} peer0 $MAC 2001:db8:ffff::1 20001 "$@"; }
`;
/** Distance between the first addresses of two consecutive /64 prefixes. */
const PREFIX_STEP = 2n ** 64n;

const parse = (out: string): Record<string, number> =>
  Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => l.split('=') as [string, string])
      .map(([k, v]) => [k, Number(v)]),
  );

describe('haxguard.nft with packets', () => {
  const load = `${TOPOLOGY}
$S nft -f '${nft('haxguard.nft')}'
$C ${gen} send 198.51.100.2 198.51.100.1 5000 1 32 > /dev/null   # resolves ARP; UDP to other ports passes
`;

  it('limits the unknown-STUN lane per source address, not per /24', (ctx) => {
    needs(ctx, noVeth);
    const r = inNs(`${load}
for ip in 198.51.100.2 198.51.100.3 198.51.100.4; do $C ${gen} send $ip 198.51.100.1 20001 15 0 stun > /dev/null; done
echo ok=$(cnt c_stun_ok)
echo over=$(cnt c_stun_over)
echo setfull=$(cnt c_stun_setfull)
$C ${gen} send 198.51.100.2 198.51.100.1 20001 200 0 stun > /dev/null
echo flood_ok=$(cnt c_stun_ok)
`);
    expect(r.status, r.stderr).toBe(0);
    const c = parse(r.stdout);
    // Each of the three neighbours gets its own burst of 10 (they shared 10 in total when keyed by /24).
    expect(c.ok).toBeGreaterThanOrEqual(30);
    expect(c.ok! + c.over!).toBe(45);
    expect(c.setfull).toBe(0);
    // One source flooding after that is still cut by its own bucket.
    expect(c.flood_ok! - c.ok!).toBeLessThan(50);
  });

  it('drops UDP fragments of any port but not whole datagrams to other ports', (ctx) => {
    needs(ctx, noVeth);
    const r = inNs(`${load}
a=$(noports)
$C ${gen} send 198.51.100.2 198.51.100.1 5000 1 100 > /dev/null
sleep 0.2
b=$(noports)
$C ${gen} send 198.51.100.2 198.51.100.1 5000 1 3000 > /dev/null
sleep 0.3
c=$(noports)
echo small=$((b - a))
echo big=$((c - b))
echo frags=$(cnt c_frag)
`);
    expect(r.status, r.stderr).toBe(0);
    const c = parse(r.stdout);
    expect(c.small).toBe(1);
    expect(c.big).toBe(0);
    expect(c.frags).toBeGreaterThanOrEqual(2);
  });

  it('drops everything from a banned address except the UDP to ports that are not rooms', (ctx) => {
    needs(ctx, noVeth);
    const r = inNs(`${load}
$S nft add element netdev haxguard deny4 { 198.51.100.2 timeout 1m }
a=$(noports)
$C ${gen} send 198.51.100.2 198.51.100.1 5000 5 32 > /dev/null
sleep 0.2
b=$(noports)
$C ${gen} send 198.51.100.2 198.51.100.1 20001 5 32 > /dev/null
echo other_port=$((b - a))
echo room_port=$(cnt c_deny)
echo banned_tcp=$($C ${gen} tcp 198.51.100.2 198.51.100.1 5001 300)
echo neighbour_tcp=$($C ${gen} tcp 198.51.100.3 198.51.100.1 5001 300)
echo tcp_deny=$(cnt c_deny)
`);
    expect(r.status, r.stderr).toBe(0);
    const got = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=') as [string, string]));
    // The UDP to a port that is not a room reaches the stack (the accept rule sits before deny), as the header says.
    expect(Number(got.other_port)).toBe(5);
    // The UDP to a room port and the TCP of that address are dropped by the deny rule; a neighbour's SYN gets its RST.
    expect(Number(got.room_port)).toBe(5);
    expect(got.banned_tcp).toContain('timeout');
    expect(got.neighbour_tcp).toContain('refused');
    expect(Number(got.tcp_deny)).toBeGreaterThan(5);
  });

  it('keeps the per-source STUN limit for sources already in a full stunrate4, and the global cap for new ones', (ctx) => {
    needs(ctx, noVeth);
    const r = inNs(`${TOPOLOGY}
for i in $(seq 10 30); do ip -n hgC addr add 198.51.100.$i/24 dev eth0; done
sed '/set stunrate[46] /s/size 65536/size 16/' '${nft('haxguard.nft')}' > /run/small.nft
echo small=$(grep -c 'size 16;' /run/small.nft)
$S nft -f /run/small.nft
$C ${gen} send 198.51.100.2 198.51.100.1 5000 1 32 > /dev/null
for i in $(seq 10 25); do $C ${gen} send 198.51.100.$i 198.51.100.1 20001 1 0 stun > /dev/null; done
echo filled_ok=$(cnt c_stun_ok)
echo filled_setfull=$(cnt c_stun_setfull)
$C ${gen} send 198.51.100.30 198.51.100.1 20001 100 0 stun > /dev/null
echo new_ok=$(cnt c_stun_ok)
echo new_setfull=$(cnt c_stun_setfull)
$C ${gen} send 198.51.100.10 198.51.100.1 20001 100 0 stun > /dev/null
echo known_ok=$(cnt c_stun_ok)
echo known_setfull=$(cnt c_stun_setfull)
echo known_over=$(cnt c_stun_over)
$C ${gen} send 198.51.100.30 198.51.100.1 20001 5000 0 stun > /dev/null
echo flood_setfull=$(cnt c_stun_setfull)
echo flood_over=$(cnt c_stun_over)
`);
    expect(r.status, r.stderr).toBe(0);
    const c = parse(r.stdout);
    expect(c.small).toBe(2);
    // 16 sources fit: each has its bucket and nothing is counted as unmetered.
    expect(c.filled_ok).toBe(16);
    expect(c.filled_setfull).toBe(0);
    // A 17th source does not fit: its 100 packets are unmetered per source and counted in c_stun_setfull.
    expect(c.new_ok! - c.filled_ok!).toBe(100);
    expect(c.new_setfull).toBe(100);
    // A source that is in the set keeps its burst of 10 (one token went to its filler packet).
    expect(c.known_ok! - c.new_ok!).toBeGreaterThanOrEqual(8);
    expect(c.known_ok! - c.new_ok!).toBeLessThan(20);
    expect(c.known_setfull).toBe(c.new_setfull);
    // The unmetered source is still cut by the global 2000/s budget (500 burst).
    expect(c.flood_setfull! - c.known_setfull!).toBe(5000);
    expect(c.flood_over! - c.known_over!).toBeGreaterThan(200);
  });

  it('limits the unknown-STUN lane per IPv6 /64, not per address', (ctx) => {
    needs(ctx, noPacket);
    const r = inNs(`${TOPOLOGY6}
$S nft -f '${nft('haxguard.nft')}'
g6 5 2001:db8:aaaa::1 400 > /dev/null
echo ok=$(cnt c_stun_ok)
echo over=$(cnt c_stun_over)
echo setfull=$(cnt c_stun_setfull)
g6 15 2001:db8:bbbb::1 > /dev/null
echo other_ok=$(cnt c_stun_ok)
g6 20 2001:db8:aaaa:0:dead:beef:0:1 > /dev/null
echo again_ok=$(cnt c_stun_ok)
`);
    expect(r.status, r.stderr).toBe(0);
    const c = parse(r.stdout);
    // 400 addresses of one /64 share one burst of 10; per address (the former default) they got 400 bursts
    // and only the global budget (500 + refill) stopped them.
    expect(c.ok! + c.over!).toBe(2000);
    expect(c.ok).toBeLessThanOrEqual(15);
    expect(c.setfull).toBe(0);
    // Another /64 keeps its own burst, and the first one stays used up whatever the low 64 bits are.
    expect(c.other_ok! - c.ok!).toBeGreaterThanOrEqual(10);
    expect(c.other_ok! - c.ok!).toBeLessThanOrEqual(13);
    expect(c.again_ok! - c.other_ok!).toBeLessThanOrEqual(3);
  });

  it('keeps the per-source STUN limit for prefixes already in a full stunrate6, and the global cap for new ones', (ctx) => {
    needs(ctx, noPacket);
    const r = inNs(`${TOPOLOGY6}
sed '/set stunrate[46] /s/size 65536/size 16/' '${nft('haxguard.nft')}' > /run/small.nft
echo small=$(grep -c 'size 16;' /run/small.nft)
$S nft -f /run/small.nft
g6 1 2001:db8:0:1::1 16 ${PREFIX_STEP} > /dev/null
echo filled_ok=$(cnt c_stun_ok)
echo filled_setfull=$(cnt c_stun_setfull)
g6 100 2001:db8:0:100::1 > /dev/null
echo new_ok=$(cnt c_stun_ok)
echo new_setfull=$(cnt c_stun_setfull)
g6 100 2001:db8:0:1::2 > /dev/null
echo known_ok=$(cnt c_stun_ok)
echo known_setfull=$(cnt c_stun_setfull)
echo known_over=$(cnt c_stun_over)
g6 5000 2001:db8:0:100::1 > /dev/null
echo flood_setfull=$(cnt c_stun_setfull)
echo flood_over=$(cnt c_stun_over)
`);
    expect(r.status, r.stderr).toBe(0);
    const c = parse(r.stdout);
    expect(c.small).toBe(2);
    expect(c.filled_ok).toBe(16);
    expect(c.filled_setfull).toBe(0);
    expect(c.new_ok! - c.filled_ok!).toBe(100);
    expect(c.new_setfull).toBe(100);
    // 2001:db8:0:1::2 shares the /64 (and the bucket) of the first filler.
    expect(c.known_ok! - c.new_ok!).toBeGreaterThanOrEqual(8);
    expect(c.known_ok! - c.new_ok!).toBeLessThan(20);
    expect(c.known_setfull).toBe(c.new_setfull);
    expect(c.flood_setfull! - c.known_setfull!).toBe(5000);
    expect(c.flood_over! - c.known_over!).toBeGreaterThan(200);
  });
});

describe('relay-only.nft with packets', () => {
  const setup = `
ip link set lo up
nft -f '${nft('relay-only.nft')}'
sysctl -qw net.ipv4.ip_local_port_range="32768 60999"
`;
  const json = (s: string) => JSON.parse(s.trim().split('\n').pop()!) as { sent: number; errors: Record<string, number>; inRange?: number };

  it('blocks sockets auto-bound inside the relay range unless the range is reserved', (ctx) => {
    needs(ctx, noNft);
    const open = inNs(`${setup}${gen} ephemeral 1000 127.0.0.1 9`, false);
    expect(open.status, open.stderr).toBe(0);
    const before = json(open.stdout);
    // About 3.5 % of the ephemeral ports fall in 40000-40999 and every one of them loses its traffic.
    expect(before.inRange).toBeGreaterThan(0);
    expect(before.errors.EPERM).toBe(before.inRange);

    const reserved = inNs(
      `${setup}sysctl -qw net.ipv4.ip_local_reserved_ports=40000-40999\n${gen} ephemeral 1000 127.0.0.1 9`,
      false,
    );
    expect(reserved.status, reserved.stderr).toBe(0);
    const after = json(reserved.stdout);
    expect(after.inRange).toBe(0);
    expect(after.sent).toBe(1000);
    expect(after.errors).toEqual({});
  });

  it('keeps blocking explicitly bound relay-range sockets once the range is reserved', (ctx) => {
    needs(ctx, noNft);
    const r = inNs(
      `${setup}sysctl -qw net.ipv4.ip_local_reserved_ports=40000-40999
echo in=$(${gen} bound 40500 127.0.0.1 9)
echo out=$(${gen} bound 50500 127.0.0.1 9)`,
      false,
    );
    expect(r.status, r.stderr).toBe(0);
    const [inLine, outLine] = r.stdout.trim().split('\n') as [string, string];
    expect(json(inLine.slice(3)).errors).toEqual({ EPERM: 1 });
    expect(json(outLine.slice(4)).errors).toEqual({});
  });

  it('declares the ephemeral-range requirement in its header', () => {
    const head = readFileSync(nft('relay-only.nft'), 'utf8').split('\ndefine RELAY_PORTS')[0]!;
    expect(head).toContain('net.ipv4.ip_local_reserved_ports=40000-40999');
    expect(head).toContain('ip_local_port_range');
  });
});
