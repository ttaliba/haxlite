/**
 * SDP for a data-channel-only WebRTC session (RFC 8866 / JSEP RFC 8829,
 * RFC 8841 SCTP-over-DTLS, RFC 8839 ICE attributes, RFC 8122 fingerprints).
 *
 * We parse just what an answerer needs from a browser offer and write a
 * minimal answer: one m=application line, `a=setup:passive`, our
 * certificate fingerprint and our candidates (ICE-lite: host candidates for
 * the configured public addresses only; full ICE: the gatherer's host and
 * server-reflexive candidates, see gather.ts).
 */
import { isIP } from 'node:net';

export class RtcSdpError extends Error {
  override name = 'RtcSdpError';
}

export interface OfferInfo {
  iceUfrag: string;
  icePwd: string;
  /** Lower-case hash name as in a=fingerprint (`sha-256`, …). */
  fingerprintAlgorithm: string;
  /** Raw digest bytes. */
  fingerprint: Uint8Array;
  /** 'actpass' | 'active' (we refuse 'passive': we only implement the DTLS server). */
  setup: string;
  mid: string;
  /** Mids of `a=group:BUNDLE`, or null without one. */
  bundle: string[] | null;
  sctpPort: number;
  /** a=max-message-size (default 65536 per RFC 8841 when absent). */
  maxMessageSize: number;
  /** a=candidate values (without `a=`). */
  candidates: string[];
  iceLite: boolean;
}

const MAX_SDP = 64 * 1024;
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;
const HASHES: Record<string, number> = { 'sha-1': 20, 'sha-224': 28, 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 };

/** Parses a browser offer. Throws {@link RtcSdpError} when it cannot be answered. */
export function parseOffer(sdp: string): OfferInfo {
  if (typeof sdp !== 'string' || sdp.length === 0) throw new RtcSdpError('empty SDP');
  if (sdp.length > MAX_SDP) throw new RtcSdpError('SDP too large');
  const lines = sdp.split(/\r?\n/);
  // session-level attributes, then the first usable m=application section
  const session: string[] = [];
  let media: string[] | null = null;
  let inTarget = false;
  let mline: string | null = null;
  let sawMedia = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') continue;
    if (line.startsWith('m=')) {
      sawMedia = true;
      if (media === null && /^m=application \d+ (UDP\/DTLS\/SCTP|TCP\/DTLS\/SCTP) webrtc-datachannel$/.test(line)) {
        inTarget = true;
        media = [];
        mline = line;
      } else {
        inTarget = false;
      }
      continue;
    }
    if (!sawMedia) session.push(line);
    else if (inTarget) media!.push(line);
  }
  if (media === null || mline === null) throw new RtcSdpError('no m=application UDP/DTLS/SCTP webrtc-datachannel section');
  if (mline.split(' ')[1] === '0') throw new RtcSdpError('data m-line rejected (port 0)');

  const attr = (lines: string[], name: string): string | null => {
    const prefix = `a=${name}:`;
    for (const l of lines) if (l.startsWith(prefix)) return l.slice(prefix.length).trim();
    return null;
  };
  const flag = (lines: string[], name: string): boolean => lines.some((l) => l === `a=${name}`);
  const get = (name: string): string | null => attr(media!, name) ?? attr(session, name);

  const iceUfrag = get('ice-ufrag');
  const icePwd = get('ice-pwd');
  if (iceUfrag === null || iceUfrag.length < 4 || iceUfrag.length > 256 || !ICE_CHARS.test(iceUfrag)) {
    throw new RtcSdpError('missing/invalid a=ice-ufrag');
  }
  if (icePwd === null || icePwd.length < 22 || icePwd.length > 256 || !ICE_CHARS.test(icePwd)) {
    throw new RtcSdpError('missing/invalid a=ice-pwd');
  }

  const fpLine = get('fingerprint');
  if (fpLine === null) throw new RtcSdpError('missing a=fingerprint');
  const sp = fpLine.indexOf(' ');
  const alg = (sp < 0 ? '' : fpLine.slice(0, sp)).toLowerCase();
  const hex = sp < 0 ? '' : fpLine.slice(sp + 1).trim();
  const hashLen = HASHES[alg];
  if (hashLen === undefined) throw new RtcSdpError(`unsupported fingerprint hash ${alg}`);
  if (alg === 'sha-1') {
    // RFC 8122 allows it, but a 160-bit binding is not good enough for us.
    throw new RtcSdpError('sha-1 fingerprint refused');
  }
  const fingerprint = parseHexFingerprint(hex);
  if (fingerprint === null || fingerprint.length !== hashLen) throw new RtcSdpError('malformed a=fingerprint');

  const setup = (get('setup') ?? 'actpass').toLowerCase();
  if (setup !== 'actpass' && setup !== 'active') throw new RtcSdpError(`unsupported a=setup:${setup} (we are DTLS server only)`);

  const mid = attr(media, 'mid') ?? '0';
  if (!/^[\x21-\x7e]{1,32}$/.test(mid)) throw new RtcSdpError('invalid a=mid');

  let bundle: string[] | null = null;
  const group = attr(session, 'group');
  if (group !== null && group.startsWith('BUNDLE')) bundle = group.split(/\s+/).slice(1).filter((m) => m !== '');

  const sctpPortStr = attr(media, 'sctp-port');
  const sctpPort = sctpPortStr === null ? 5000 : Number(sctpPortStr);
  if (!Number.isInteger(sctpPort) || sctpPort <= 0 || sctpPort > 65535) throw new RtcSdpError('invalid a=sctp-port');

  const mmsStr = attr(media, 'max-message-size');
  let maxMessageSize = mmsStr === null ? 65536 : Number(mmsStr);
  if (!Number.isFinite(maxMessageSize) || maxMessageSize < 0) throw new RtcSdpError('invalid a=max-message-size');
  if (maxMessageSize === 0) maxMessageSize = Number.MAX_SAFE_INTEGER; // 0 = unlimited (RFC 8841 §6)

  const candidates: string[] = [];
  for (const l of media) if (l.startsWith('a=candidate:') && candidates.length < 64) candidates.push(l.slice(2));

  return {
    iceUfrag,
    icePwd,
    fingerprintAlgorithm: alg,
    fingerprint,
    setup,
    mid,
    bundle,
    sctpPort,
    maxMessageSize,
    candidates,
    iceLite: flag(session, 'ice-lite'),
  };
}

/** `AB:CD:…` → bytes (null when malformed). */
export function parseHexFingerprint(hex: string): Uint8Array | null {
  const parts = hex.split(':');
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!/^[0-9A-Fa-f]{2}$/.test(p)) return null;
    out[i] = parseInt(p, 16);
  }
  return out;
}

/** bytes → `AB:CD:…` (upper case, as browsers write it). */
export function formatFingerprint(digest: Uint8Array): string {
  let s = '';
  for (let i = 0; i < digest.length; i++) {
    if (i > 0) s += ':';
    s += digest[i]!.toString(16).toUpperCase().padStart(2, '0');
  }
  return s;
}

export interface HostCandidate {
  address: string;
  port: number;
}

/**
 * Host candidate lines (no `a=`). Priority per RFC 8445 §5.1.2.1: type
 * preference 126 (host), local preference decreasing with the list order,
 * component 1.
 */
export function hostCandidates(addresses: readonly HostCandidate[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i]!;
    if (isIP(a.address) === 0) throw new RtcSdpError(`not an IP literal: ${a.address}`);
    const localPref = 65535 - i;
    const priority = (126 * 2 ** 24 + localPref * 2 ** 8 + (256 - 1)) >>> 0;
    out.push(`candidate:${i + 1} 1 udp ${priority} ${a.address} ${a.port} typ host generation 0`);
  }
  return out;
}

export interface AnswerParams {
  offer: OfferInfo;
  iceUfrag: string;
  icePwd: string;
  /** sha-256 digest of our certificate. */
  fingerprint: Uint8Array;
  candidates: readonly HostCandidate[];
  /**
   * Candidate lines (no `a=`) written instead of host candidates for
   * {@link candidates} (full ICE: host + srflx from the gatherer).
   */
  candidateLines?: readonly string[];
  /** Write `a=ice-lite` (default true). */
  iceLite?: boolean;
  /** Write `a=end-of-candidates` (default true; false while gathering is still running). */
  endOfCandidates?: boolean;
  sctpPort: number;
  maxMessageSize: number;
  /** o= session id (decimal digits). */
  sessionId: string;
}

/** The answer (CRLF line endings, trailing CRLF). */
export function buildAnswer(p: AnswerParams): string {
  const o = p.offer;
  let first: HostCandidate | undefined = p.candidates[0];
  if (p.candidateLines !== undefined) {
    const c = p.candidateLines.length > 0 ? parseCandidate(p.candidateLines[0]!) : null;
    first = c === null ? undefined : { address: c.address, port: c.port };
  }
  const v6 = first !== undefined && isIP(first.address) === 6;
  const cLine = first === undefined ? 'c=IN IP4 0.0.0.0' : `c=IN ${v6 ? 'IP6' : 'IP4'} ${first.address}`;
  const lines = [
    'v=0',
    `o=- ${p.sessionId} 2 IN IP4 0.0.0.0`,
    's=-',
    't=0 0',
  ];
  if (o.bundle !== null && o.bundle.includes(o.mid)) lines.push(`a=group:BUNDLE ${o.mid}`);
  if (p.iceLite !== false) lines.push('a=ice-lite');
  lines.push('a=msid-semantic: WMS');
  lines.push(
    `m=application ${first === undefined ? 9 : first.port} UDP/DTLS/SCTP webrtc-datachannel`,
    cLine,
    `a=mid:${o.mid}`,
    `a=ice-ufrag:${p.iceUfrag}`,
    `a=ice-pwd:${p.icePwd}`,
    `a=fingerprint:sha-256 ${formatFingerprint(p.fingerprint)}`,
    'a=setup:passive',
    `a=sctp-port:${p.sctpPort}`,
    `a=max-message-size:${p.maxMessageSize}`,
  );
  for (const c of p.candidateLines ?? hostCandidates(p.candidates)) lines.push(`a=${c}`);
  if (p.endOfCandidates !== false) lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

export interface ParsedCandidate {
  foundation: string;
  component: number;
  transport: string;
  priority: number;
  address: string;
  port: number;
  type: string;
}

/** Parses `candidate:…` (with or without `a=`); null when malformed. */
export function parseCandidate(line: string): ParsedCandidate | null {
  let s = line.trim();
  if (s.startsWith('a=')) s = s.slice(2);
  if (!s.startsWith('candidate:')) return null;
  const f = s.slice(10).split(/\s+/);
  if (f.length < 8 || f[6] !== 'typ') return null;
  const port = Number(f[5]);
  const component = Number(f[1]);
  const priority = Number(f[3]);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(component)) return null;
  return {
    foundation: f[0]!,
    component,
    transport: f[2]!.toLowerCase(),
    priority,
    address: f[4]!,
    port,
    type: f[7]!,
  };
}
