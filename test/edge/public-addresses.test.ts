/**
 * Addresses an `'rtc'` edge announces: IPv6 is opt-in (`webrtc.ipv6`), like
 * for the host's backends; a machine (or list) with only IPv6 addresses is a
 * clear configuration error without it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Iface = { address: string; family: 'IPv4' | 'IPv6'; internal: boolean; scopeid?: number };
let ifaces: Record<string, Iface[]> = {};
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  const networkInterfaces = () => ifaces;
  return { ...orig, networkInterfaces, default: { ...orig, networkInterfaces } };
});

const { detectPublicAddresses, resolveEdgePublicAddresses } = await import('../../src/edge/players.js');

const V4: Iface = { address: '203.0.113.7', family: 'IPv4', internal: false };
const V6: Iface = { address: '2001:db8::7', family: 'IPv6', internal: false, scopeid: 0 };
const LL6: Iface = { address: 'fe80::1', family: 'IPv6', internal: false, scopeid: 2 };

describe('edge public addresses (IPv6 opt-in)', () => {
  afterEach(() => {
    ifaces = {};
  });

  it('detection skips IPv6 interface addresses unless ipv6', () => {
    ifaces = { eth0: [V4, V6, LL6] };
    expect(detectPublicAddresses(undefined, 'public')).toEqual(['203.0.113.7']);
    expect(detectPublicAddresses('::', 'public')).toEqual(['203.0.113.7']);
    expect(detectPublicAddresses(undefined, 'public', true)).toEqual(['203.0.113.7', '2001:db8::7']);
    expect(detectPublicAddresses('0.0.0.0', 'public', true)).toEqual(['203.0.113.7']);
    expect(resolveEdgePublicAddresses({}, 'public')).toEqual(['203.0.113.7']);
    expect(resolveEdgePublicAddresses({ ipv6: true }, 'public')).toEqual(['203.0.113.7', '2001:db8::7']);
  });

  it('only IPv6 found and ipv6 off → an error that names webrtc.ipv6', () => {
    ifaces = { eth0: [V6, LL6] };
    expect(() => resolveEdgePublicAddresses({}, 'public')).toThrow(/only has public IPv6 addresses.*webrtc\.ipv6: true/);
    expect(resolveEdgePublicAddresses({ ipv6: true }, 'public')).toEqual(['2001:db8::7']);
    ifaces = {};
    expect(() => resolveEdgePublicAddresses({}, 'public')).toThrow(/no public address to announce \(set webrtc\.publicAddresses or webrtc\.bindAddress\)$/);
  });

  it('explicit publicAddresses and bindAddress follow the same rule', () => {
    expect(resolveEdgePublicAddresses({ publicAddresses: ['2001:db8::1', '198.51.100.1'] }, 'public')).toEqual(['198.51.100.1']);
    expect(resolveEdgePublicAddresses({ publicAddresses: ['2001:db8::1', '198.51.100.1'], ipv6: true }, 'public')).toEqual(['2001:db8::1', '198.51.100.1']);
    expect(() => resolveEdgePublicAddresses({ publicAddresses: ['2001:db8::1'] }, 'public')).toThrow(/only IPv6 addresses.*webrtc\.ipv6/);
    expect(() => resolveEdgePublicAddresses({ bindAddress: '2001:db8::1' }, 'public')).toThrow(/is IPv6.*webrtc\.ipv6/);
    expect(resolveEdgePublicAddresses({ bindAddress: '2001:db8::1', ipv6: true }, 'public')).toEqual(['2001:db8::1']);
    expect(resolveEdgePublicAddresses({ bindAddress: '198.51.100.1' }, 'public')).toEqual(['198.51.100.1']);
  });
});
