/**
 * classifyIp on IPv6 forms that reach an embedded IPv4 address (NAT64,
 * 6to4) or that are never real destinations (IPv4-compatible): the address
 * policy must not treat an internal IPv4 address as public through them.
 */
import { describe, expect, it } from 'vitest';
import { classifyIp } from '../../src/rtc/gather.js';
import { IceScheduler } from '../../src/rtc/ice-agent.js';
import type { UdpIo } from '../../src/rtc/udp.js';

describe('classifyIp: IPv6 with an embedded IPv4 address', () => {
  it('NAT64 (64:ff9b::/96) and 6to4 (2002::/16) keep the class of a non-public IPv4', () => {
    expect(classifyIp('64:ff9b::a00:1')).toBe('private'); // 10.0.0.1
    expect(classifyIp('64:ff9b::192.168.1.20')).toBe('private');
    expect(classifyIp('64:ff9b::7f00:1')).toBe('loopback');
    expect(classifyIp('64:ff9b::a9fe:a9fe')).toBe('linklocal'); // 169.254.169.254
    expect(classifyIp('2002:a00:1::1')).toBe('private');
    expect(classifyIp('2002:7f00:1::1')).toBe('loopback');
    expect(classifyIp('2002:e000:1::1')).toBe('reserved'); // 224.0.0.1
  });

  it('a public embedded IPv4 stays public; other global IPv6 is unchanged', () => {
    expect(classifyIp('64:ff9b::808:808')).toBe('public');
    expect(classifyIp('2002:808:808::1')).toBe('public');
    expect(classifyIp('64:ff9b:1::a00:1')).toBe('public'); // not the well-known /96
    expect(classifyIp('2001:db8::1')).toBe('public');
    expect(classifyIp('2606:4700::1111')).toBe('public');
    expect(classifyIp('::ffff:10.0.0.1')).toBe('private');
    expect(classifyIp('::1')).toBe('loopback');
    expect(classifyIp('::')).toBe('reserved');
  });

  it('IPv4-compatible addresses (::a.b.c.d) are reserved', () => {
    expect(classifyIp('::a00:1')).toBe('reserved');
    expect(classifyIp('::8.8.8.8')).toBe('reserved');
  });

  it("the default 'public' policy sends no checks to them", () => {
    const sched = new IceScheduler({
      send: () => {},
      now: () => 0,
      sockets: [{ sock: {} as UdpIo, family: 6, bindAddress: '::' }],
      policy: 'public',
    });
    try {
      for (const a of ['64:ff9b::a00:1', '2002:c0a8:101::1', '::a00:1', '64:ff9b::7f00:1']) expect(sched.socketFor(a)).toBeNull();
      expect(sched.socketFor('64:ff9b::808:808')).not.toBeNull();
    } finally {
      sched.close();
    }
  });
});
