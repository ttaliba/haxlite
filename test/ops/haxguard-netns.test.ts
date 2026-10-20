/**
 * Behaviour of ops/haxguard/*.nft with real packets, inside throwaway user+network namespaces
 * (a veth pair between two of them; nothing touches the host's network or mount namespace).
 * Skipped when nft, ip or unprivileged namespaces are unavailable.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const nft = (name: string): string => fileURLToPath(new URL(`../../ops/haxguard/${name}`, import.meta.url));
const gen = `'${process.execPath}' '${fileURLToPath(new URL('./netns-udp.mjs', import.meta.url))}'`;

/** Runs `script` as root of a new user+net+mount namespace; /run is a private tmpfs so `ip netns` leaves nothing behind. */
const inNs = (script: string, mount = true) =>
  spawnSync('unshare', [mount ? '-rnm' : '-rn', 'sh', '-ec', mount ? `mount -t tmpfs none /run\n${script}` : script], {
    encoding: 'utf8',
    timeout: 60_000,
  });

const hasNft = inNs('nft --version', false).status === 0;
const hasVeth = hasNft && inNs('ip netns add probe; ip -n probe link add va type veth peer name vb').status === 0;

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

const parse = (out: string): Record<string, number> =>
  Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => l.split('=') as [string, string])
      .map(([k, v]) => [k, Number(v)]),
  );

describe.skipIf(!hasVeth)('haxguard.nft with packets', () => {
  const load = `${TOPOLOGY}
$S nft -f '${nft('haxguard.nft')}'
$C ${gen} send 198.51.100.2 198.51.100.1 5000 1 32 > /dev/null   # resolves ARP; UDP to other ports passes
`;

  it('limits the unknown-STUN lane per source address, not per /24', () => {
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

  it('drops UDP fragments of any port but not whole datagrams to other ports', () => {
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
});

describe.skipIf(!hasNft)('relay-only.nft with packets', () => {
  const setup = `
ip link set lo up
nft -f '${nft('relay-only.nft')}'
sysctl -qw net.ipv4.ip_local_port_range="32768 60999"
`;
  const json = (s: string) => JSON.parse(s.trim().split('\n').pop()!) as { sent: number; errors: Record<string, number>; inRange?: number };

  it('blocks sockets auto-bound inside the relay range unless the range is reserved', () => {
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

  it('keeps blocking explicitly bound relay-range sockets once the range is reserved', () => {
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
