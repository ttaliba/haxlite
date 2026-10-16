/**
 * IPv6 is opt-in (`ipv6: true`): without it the endpoint resolves STUN
 * servers to IPv4 only (no AAAA lookups), and the backends' address
 * helpers skip IPv6.
 */
import dgram from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { host: string; opts: { family?: number; all?: boolean } }[] = [];
vi.mock('node:dns', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:dns')>();
  const lookup = (host: string, opts: { family?: number; all?: boolean }, cb: (err: Error | null, addrs: unknown[]) => void) => {
    calls.push({ host, opts });
    cb(null, opts.family === 4 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]);
  };
  return { ...orig, lookup, default: { ...orig, lookup } };
});

const { RtcEndpoint, rawDataLayer } = await import('../../src/rtc/index.js');
const { resolvePublicAddresses, detectPublicAddresses } = await import('../../src/net/rtc-backend.js');
const { nativeRtcConfig, isIpv6Candidate } = await import('../../src/net/webrtc.js');

const ipv6Available = await new Promise<boolean>((resolve) => {
  const s = dgram.createSocket({ type: 'udp6', ipv6Only: true });
  s.on('error', () => resolve(false));
  s.bind(0, '::1', () => {
    s.close();
    resolve(true);
  });
});

describe('IPv6 opt-in', () => {
  let ep: Awaited<ReturnType<typeof RtcEndpoint.listen>> | null = null;
  afterEach(async () => {
    await ep?.close();
    ep = null;
    calls.length = 0;
  });

  it('without ipv6, STUN server names are resolved to IPv4 only', async () => {
    ep = await RtcEndpoint.listen({ address: '127.0.0.1', iceServers: ['stun:stun.example.test:3478'], gatherRefreshMs: 60_000, dataLayer: rawDataLayer });
    await ep.whenGathered();
    expect(calls).toEqual([{ host: 'stun.example.test', opts: { all: true, family: 4 } }]);
  });

  it.skipIf(!ipv6Available)('with ipv6 and a udp6 socket, both families are looked up', async () => {
    ep = await RtcEndpoint.listen({ address: '::', ipv6: true, iceServers: ['stun:stun.example.test:3478'], dataLayer: rawDataLayer });
    expect(ep.boundAddresses.map((b: { family: number }) => b.family).sort()).toEqual([4, 6]);
    await ep.whenGathered();
    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.family).toBeUndefined();
  });

  it("peerBackend 'rtc': public addresses (given or detected) are IPv4 unless ipv6", () => {
    expect(resolvePublicAddresses({ publicAddresses: ['2001:db8::1', '203.0.113.7'] })).toEqual(['203.0.113.7']);
    expect(resolvePublicAddresses({ publicAddresses: ['2001:db8::1', '203.0.113.7'], ipv6: true })).toEqual(['2001:db8::1', '203.0.113.7']);
    expect(() => resolvePublicAddresses({ publicAddresses: ['2001:db8::1'] })).toThrow(/ipv6/);
    for (const a of detectPublicAddresses()) expect(a).not.toContain(':');
  });

  it("peerBackend 'ndc': libdatachannel is bound to 0.0.0.0 and IPv6 candidates are recognised unless ipv6", () => {
    expect(nativeRtcConfig({ iceServers: [] })).toEqual({ iceServers: [], bindAddress: '0.0.0.0' });
    expect(nativeRtcConfig({ iceServers: [], ipv6: true })).toEqual({ iceServers: [] });
    expect(nativeRtcConfig({ iceServers: [], bindAddress: '10.0.0.2' })).toEqual({ iceServers: [], bindAddress: '10.0.0.2' });
    expect(isIpv6Candidate('candidate:1 1 UDP 2122317823 2001:db8::1 5000 typ host')).toBe(true);
    expect(isIpv6Candidate('a=candidate:2 1 UDP 1686052607 203.0.113.7 5000 typ srflx raddr 0.0.0.0 rport 0')).toBe(false);
    expect(isIpv6Candidate('candidate:3 1 udp 2113937151 0a1b2c3d.local 5000 typ host')).toBe(false);
  });
});
