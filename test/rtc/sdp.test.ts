import { describe, expect, it } from 'vitest';
import { RtcSdpError, buildAnswer, formatFingerprint, parseCandidate, parseOffer } from '../../src/rtc/sdp.js';

/** Captured from Chromium 141 (Playwright chromium-1194): HaxBall-style negotiated channels. */
export const CHROME_OFFER = [
  'v=0',
  'o=- 8733133226796603598 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:mjWA',
  'a=ice-pwd:jDvGnjN/APunijQV3g1CgdVg',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 6C:C0:92:06:D6:23:35:1F:67:6A:36:2F:89:3E:6D:C8:AE:66:FA:7C:87:F4:FD:F5:E7:EF:55:32:ED:52:F4:20',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

/** Firefox shape: fingerprint at session level, hex ufrag/pwd, huge max-message-size, candidates inline. */
export const FIREFOX_OFFER = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 7710052215259647220 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=fingerprint:sha-256 F9:5C:2B:7D:1A:0E:93:4C:44:6B:12:D0:7F:3A:9E:58:21:CB:E5:66:0D:4F:B3:8A:75:19:C2:E4:3B:A0:5D:71',
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 9a1c1b2e-7f3d-4c1a-9b8e-2f6d5c4b3a21.local 54321 typ host',
  'a=candidate:1 1 UDP 1686052863 198.51.100.20 54321 typ srflx raddr 0.0.0.0 rport 0',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:d7bab7b6a0a5ec5e8d8b5a6ad1a7c5e3',
  'a=ice-ufrag:1c2b3a4d',
  'a=mid:0',
  'a=setup:actpass',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');

const OUR_FP = new Uint8Array(32).map((_, i) => i);

function answerFor(offerSdp: string, candidates = [{ address: '203.0.113.7', port: 40000 }]) {
  const offer = parseOffer(offerSdp);
  return {
    offer,
    sdp: buildAnswer({
      offer,
      iceUfrag: 'AbCdEfGh',
      icePwd: 'abcdefghijklmnopqrstuvwx',
      fingerprint: OUR_FP,
      candidates,
      sctpPort: 5000,
      maxMessageSize: 262144,
      sessionId: '1234567890',
    }),
  };
}

describe('SDP', () => {
  it('parses a Chromium offer', () => {
    const o = parseOffer(CHROME_OFFER);
    expect(o.iceUfrag).toBe('mjWA');
    expect(o.icePwd).toBe('jDvGnjN/APunijQV3g1CgdVg');
    expect(o.fingerprintAlgorithm).toBe('sha-256');
    expect(formatFingerprint(o.fingerprint)).toBe(
      '6C:C0:92:06:D6:23:35:1F:67:6A:36:2F:89:3E:6D:C8:AE:66:FA:7C:87:F4:FD:F5:E7:EF:55:32:ED:52:F4:20',
    );
    expect(o.setup).toBe('actpass');
    expect(o.mid).toBe('0');
    expect(o.bundle).toEqual(['0']);
    expect(o.sctpPort).toBe(5000);
    expect(o.maxMessageSize).toBe(262144);
    expect(o.candidates).toEqual([]);
  });

  it('parses a Firefox offer (session-level fingerprint, inline candidates)', () => {
    const o = parseOffer(FIREFOX_OFFER);
    expect(o.iceUfrag).toBe('1c2b3a4d');
    expect(o.icePwd).toBe('d7bab7b6a0a5ec5e8d8b5a6ad1a7c5e3');
    expect(o.fingerprint.length).toBe(32);
    expect(o.maxMessageSize).toBe(1073741823);
    expect(o.candidates).toHaveLength(2);
    expect(parseCandidate(o.candidates[1]!)).toMatchObject({ address: '198.51.100.20', port: 54321, type: 'srflx', transport: 'udp' });
  });

  it('accepts LF-only line endings', () => {
    expect(parseOffer(CHROME_OFFER.replace(/\r\n/g, '\n')).iceUfrag).toBe('mjWA');
  });

  it('writes a minimal ICE-lite passive answer with only the public candidates', () => {
    for (const offerSdp of [CHROME_OFFER, FIREFOX_OFFER]) {
      const { sdp } = answerFor(offerSdp);
      const lines = sdp.split('\r\n');
      expect(sdp.endsWith('\r\n')).toBe(true);
      expect(lines[0]).toBe('v=0');
      expect(lines).toContain('a=group:BUNDLE 0');
      expect(lines).toContain('a=ice-lite');
      expect(lines).toContain('m=application 40000 UDP/DTLS/SCTP webrtc-datachannel');
      expect(lines).toContain('c=IN IP4 203.0.113.7');
      expect(lines).toContain('a=mid:0');
      expect(lines).toContain('a=ice-ufrag:AbCdEfGh');
      expect(lines).toContain('a=ice-pwd:abcdefghijklmnopqrstuvwx');
      expect(lines).toContain(`a=fingerprint:sha-256 ${formatFingerprint(OUR_FP)}`);
      expect(lines).toContain('a=setup:passive');
      expect(lines).toContain('a=sctp-port:5000');
      expect(lines).toContain('a=max-message-size:262144');
      expect(lines).toContain('a=candidate:1 1 udp 2130706431 203.0.113.7 40000 typ host generation 0');
      expect(lines).toContain('a=end-of-candidates');
      // no address other than the configured public one anywhere
      const ips = sdp.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
      expect(new Set(ips)).toEqual(new Set(['0.0.0.0', '203.0.113.7']));
      // round trip: the answer parses with our own parser (setup passive is refused as an offer, so patch it)
      const back = parseOffer(sdp.replace('a=setup:passive', 'a=setup:active'));
      expect(back.iceUfrag).toBe('AbCdEfGh');
      expect(back.fingerprint).toEqual(OUR_FP);
      expect(back.iceLite).toBe(true);
    }
  });

  it('IPv6 and dual-stack candidates', () => {
    const { sdp } = answerFor(CHROME_OFFER, [
      { address: '2001:db8::7', port: 40000 },
      { address: '203.0.113.7', port: 40000 },
    ]);
    expect(sdp).toContain('c=IN IP6 2001:db8::7');
    expect(sdp).toContain('a=candidate:1 1 udp 2130706431 2001:db8::7 40000 typ host generation 0');
    expect(sdp).toContain('a=candidate:2 1 udp 2130706175 203.0.113.7 40000 typ host generation 0');
  });

  it('rejects offers it cannot answer', () => {
    const bad = (sdp: string) => expect(() => parseOffer(sdp)).toThrow(RtcSdpError);
    bad('');
    bad(CHROME_OFFER.replace(/a=fingerprint:.*\r\n/, ''));
    bad(CHROME_OFFER.replace('a=fingerprint:sha-256', 'a=fingerprint:sha-1'));
    bad(CHROME_OFFER.replace('a=fingerprint:sha-256 6C', 'a=fingerprint:sha-256 6'));
    bad(CHROME_OFFER.replace('a=fingerprint:sha-256', 'a=fingerprint:md5'));
    bad(CHROME_OFFER.replace('a=setup:actpass', 'a=setup:passive'));
    bad(CHROME_OFFER.replace('a=ice-ufrag:mjWA', 'a=ice-ufrag:mj'));
    bad(CHROME_OFFER.replace('a=ice-ufrag:mjWA', 'a=ice-ufrag:mj:A'));
    bad(CHROME_OFFER.replace('a=ice-pwd:jDvGnjN/APunijQV3g1CgdVg', 'a=ice-pwd:short'));
    bad(CHROME_OFFER.replace('UDP/DTLS/SCTP webrtc-datachannel', 'UDP/TLS/RTP/SAVPF 111'));
    bad(CHROME_OFFER.replace('m=application 9', 'm=application 0'));
    bad(CHROME_OFFER.replace('a=sctp-port:5000', 'a=sctp-port:99999'));
    bad('x'.repeat(70_000));
  });

  it('setup:active offers are accepted (we stay DTLS server)', () => {
    expect(parseOffer(CHROME_OFFER.replace('a=setup:actpass', 'a=setup:active')).setup).toBe('active');
  });

  it('parses candidates with and without a=', () => {
    const c = 'candidate:842163049 1 udp 1677729535 198.51.100.9 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag mjWA network-cost 999';
    expect(parseCandidate(c)).toMatchObject({ foundation: '842163049', component: 1, priority: 1677729535, address: '198.51.100.9', port: 61234, type: 'srflx' });
    expect(parseCandidate(`a=${c}`)).not.toBeNull();
    expect(parseCandidate('candidate:1 1 udp')).toBeNull();
    expect(parseCandidate('garbage')).toBeNull();
  });
});
