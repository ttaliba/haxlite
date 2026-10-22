#!/usr/bin/env python3
"""IPv6 traffic generator for the network-namespace checks in haxguard-netns.test.ts. Prints one JSON object.

  netns-v6.py <iface> <dst-mac> <dst> <dport> <count> <base> [naddr [step]]

Sends <count> STUN Binding Requests from each of <naddr> source addresses (default 1), the first one <base>
and every next one <step> (default 1) above the previous, out of <iface>, as raw Ethernet frames on an
AF_PACKET socket (a step of 2**64 gives one address per /64). The netdev ingress hook of the
peer sees them like any other frame, so the IPv6 rules run without the kernel needing IPv6 support
(a socket-level generator would need AF_INET6).
"""
import ipaddress
import json
import socket
import struct
import sys

STUN_COOKIE = 0x2112A442


def frame(src, dst, sport, dport, dmac, smac):
    stun = struct.pack('>HHI', 1, 0, STUN_COOKIE) + bytes(range(8, 20))
    udp_len = 8 + len(stun)
    udp = struct.pack('>HHHH', sport, dport, udp_len, 0) + stun
    ip6 = struct.pack('>IHBB', 0x60000000, udp_len, 17, 64) + src.packed + dst.packed
    return dmac + smac + b'\x86\xdd' + ip6 + udp


def main():
    iface, dmac, dst, dport, count, base = sys.argv[1:7]
    naddr = int(sys.argv[7]) if len(sys.argv) > 7 else 1
    step = int(sys.argv[8]) if len(sys.argv) > 8 else 1
    with open(f'/sys/class/net/{iface}/address') as f:
        smac = bytes.fromhex(f.read().strip().replace(':', ''))
    dmac = bytes.fromhex(dmac.replace(':', ''))
    dst = ipaddress.IPv6Address(dst)
    first = int(ipaddress.IPv6Address(base))
    sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
    sock.bind((iface, 0))
    sent = 0
    for i in range(naddr):
        pkt = frame(ipaddress.IPv6Address(first + i * step), dst, 40000 + i % 1000, int(dport), dmac, smac)
        for _ in range(int(count)):
            sock.send(pkt)
            sent += 1
    sock.close()
    print(json.dumps({'sent': sent}))


main()
