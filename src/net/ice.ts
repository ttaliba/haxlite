/**
 * ICE candidate helpers.
 *
 * Signaling carries candidates as the JSON form of `RTCIceCandidate`
 * (`{candidate, sdpMid, sdpMLineIndex, usernameFragment?}`), exactly what the
 * browser's `JSON.stringify(candidate)` produces and what `new
 * RTCIceCandidate(json)` accepts on the client.
 */
import { parseIp } from './ip.js';

export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface ParsedCandidate {
  /** Connection address (field 4): an IP, or an mDNS `*.local` name for obfuscated host candidates. */
  address: string;
  /** `host`, `srflx`, `prflx` or `relay` (field 7). */
  type: string;
}

/**
 * Parses `candidate:<foundation> <component> <transport> <priority> <address>
 * <port> typ <type> ...` (`rb.Bh`: split on spaces, field 6 must be `typ`).
 * Accepts an optional `a=` prefix. Returns null if malformed.
 */
export function parseCandidate(candidate: string): ParsedCandidate | null {
  const parts = candidate.split(' ');
  if (parts[6] !== 'typ' || parts.length < 8) return null;
  return { address: parts[4]!, type: parts[7]! };
}

/** The srflx (public, as seen by STUN) address of a candidate, or null (`Aa.We`). */
export function srflxAddress(candidate: IceCandidateInit | null | undefined): string | null {
  if (candidate == null || typeof candidate.candidate !== 'string') return null;
  const p = parseCandidate(candidate.candidate);
  return p !== null && p.type === 'srflx' ? p.address : null;
}

/** `a=mid:` values of an SDP in m-line order (index = sdpMLineIndex). */
export function sdpMids(sdp: string): string[] {
  const mids: string[] = [];
  let section = -1;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      section++;
      mids[section] = String(section);
    } else if (line.startsWith('a=mid:') && section >= 0) {
      mids[section] = line.slice(6).trim();
    }
  }
  return mids;
}

/**
 * Makes the host the DTLS **server** (`a=setup:passive` in its answer) by
 * presenting the client's `a=setup:actpass` offer as `a=setup:active` to the
 * local WebRTC stack. The client still sees a valid exchange (actpass offer,
 * passive answer → the client is DTLS client, RFC 5763 §5).
 *
 * Why: libdatachannel answering an actpass offer picks `active` and sends its
 * ClientHello the instant ICE connects, which over a fast path happens
 * *before* the answer reaches the client through the master; the client drops
 * it and OpenSSL retransmits only after its 1 s initial DTLS timeout, so every
 * join paid ≈ +1 s (docs/07). As DTLS server the host just waits for the
 * client's ClientHello, sent once the client has the answer. Browsers and
 * libdatachannel clients both accept a passive answer (haxlite-rtc always
 * answers passive; an edge gets the rewritten offer too).
 */
export function preferDtlsServer(offerSdp: string): string {
  return offerSdp.indexOf('a=setup:actpass') >= 0 ? offerSdp.replace(/a=setup:actpass/g, 'a=setup:active') : offerSdp;
}

/** Strips the `a=` prefix libdatachannel may put on candidate lines. */
export function candidateLine(c: string): string {
  return c.startsWith('a=') ? c.slice(2) : c;
}

// ====================================================================== privacy filter

/**
 * Address class of a candidate's connection address:
 * `loopback` (127/8, ::1), `private` (RFC 1918, 100.64/10 CGNAT, fc00::/7 ULA),
 * `linklocal` (169.254/16, fe80::/10), `reserved` (0/8, ::, multicast, 240/4),
 * `mdns` (`*.local` obfuscated host names), `invalid` (anything else that is
 * not an IP literal) or `public`.
 */
export type AddressClass = 'public' | 'private' | 'linklocal' | 'loopback' | 'reserved' | 'mdns' | 'invalid';

export function classifyAddress(address: string): AddressClass {
  if (address.endsWith('.local')) return 'mdns';
  const b = parseIp(address);
  if (b === null) return 'invalid';
  if (b.length === 4) {
    const [a, c] = [b[0]!, b[1]!];
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && (c & 0xf0) === 16) || (a === 192 && c === 168) || (a === 100 && (c & 0xc0) === 64)) {
      return 'private';
    }
    if (a === 169 && c === 254) return 'linklocal';
    if (a === 0 || a >= 224) return 'reserved';
    return 'public';
  }
  let zero = true;
  for (let i = 0; i < 15; i++) if (b[i] !== 0) zero = false;
  if (zero && b[15] === 1) return 'loopback';
  if (zero && b[15] === 0) return 'reserved';
  if ((b[0]! & 0xfe) === 0xfc) return 'private';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'linklocal';
  if (b[0] === 0xff) return 'reserved';
  return 'public';
}

/**
 * Which of the host's own ICE candidates are sent to clients.
 *
 * * `'public'` (default): only globally routable addresses; LAN, link-local,
 *   loopback and mDNS host candidates are dropped and the `raddr` of
 *   srflx/relay candidates is blanked (`0.0.0.0 rport 0`, like browsers).
 *   Clients only need the srflx/public candidates; a client on the same
 *   LAN/host still connects through peer-reflexive candidates.
 * * `'private'`: also RFC 1918 / ULA / CGNAT / link-local (LAN deployments).
 * * `'all'`: everything libdatachannel gathers, loopback included (local tests).
 * * a predicate: custom decision per parsed candidate (relay candidates are
 *   always kept: their address is the configured TURN server).
 */
export type IceCandidatePolicy = 'public' | 'private' | 'all' | ((candidate: ParsedCandidate) => boolean);

function addressAllowed(policy: IceCandidatePolicy, address: string, type: string): boolean {
  if (policy === 'all') return true;
  if (typeof policy === 'function') return policy({ address, type });
  const cls = classifyAddress(address);
  if (cls === 'public') return true;
  return policy === 'private' && (cls === 'private' || cls === 'linklocal');
}

/**
 * Applies `policy` to one candidate line (with or without `a=`/`candidate:`
 * prefixes kept as given). Returns null to drop it, or the line with a
 * blanked `raddr`/`rport` when the related address must not be exposed.
 */
export function filterCandidate(line: string, policy: IceCandidatePolicy): string | null {
  if (policy === 'all') return line;
  const parts = line.split(' ');
  if (parts[6] !== 'typ' || parts.length < 8) return null;
  const type = parts[7]!;
  if (type !== 'relay' && !addressAllowed(policy, parts[4]!, type)) return null;
  for (let i = 8; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'raddr' && !addressAllowed(policy, parts[i + 1]!, 'raddr')) {
      parts[i + 1] = parts[i + 1]!.indexOf(':') >= 0 ? '::' : '0.0.0.0';
      if (parts[i + 2] === 'rport') parts[i + 3] = '0';
      return parts.join(' ');
    }
  }
  return line;
}

/**
 * Applies `policy` to a local SDP: filters `a=candidate:` lines and replaces a
 * non-allowed connection address (`c=`) with the unspecified address and the
 * media port with 9 (what browsers send when they only trickle candidates).
 */
export function filterSdp(sdp: string, policy: IceCandidatePolicy): string {
  if (policy === 'all') return sdp;
  const eol = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  let hiddenConn = false;
  for (const line of lines) {
    if (line.startsWith('a=candidate:')) {
      const kept = filterCandidate(line.slice(2), policy);
      if (kept !== null) out.push('a=' + kept);
    } else if (line.startsWith('c=IN ')) {
      const p = line.split(' ');
      if (p.length >= 3 && !addressAllowed(policy, p[2]!, 'host')) {
        p[2] = p[1] === 'IP6' ? '::' : '0.0.0.0';
        hiddenConn = true;
        out.push(p.join(' '));
      } else out.push(line);
    } else out.push(line);
  }
  if (hiddenConn) {
    for (let i = 0; i < out.length; i++) {
      const l = out[i]!;
      if (l.startsWith('m=')) {
        const p = l.split(' ');
        if (p.length >= 3) {
          p[1] = '9';
          out[i] = p.join(' ');
        }
      }
    }
  }
  return out.join(eol);
}

// ====================================================================== ICE servers

/** node-datachannel's object form of an ICE server. */
export interface NativeIceServer {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: 'TurnUdp' | 'TurnTcp' | 'TurnTls';
}

/** Browser `RTCIceServer` form (`{urls, username, credential}`). */
export interface BrowserIceServer {
  urls: string | readonly string[];
  username?: string;
  credential?: string;
}

/**
 * An ICE server: a libdatachannel URL string (`stun:host:port`,
 * `turn:user:pass@host:port?transport=tcp`, `turns:…`), node-datachannel's
 * object form, or the browser `RTCIceServer` form.
 */
export type IceServerConfig = string | NativeIceServer | BrowserIceServer;

/**
 * Converts {@link IceServerConfig}s to what node-datachannel accepts. TURN
 * URLs of browser-style entries become objects so credentials need no URL
 * escaping. Throws on a malformed browser-style URL.
 */
export function toNativeIceServers(servers: readonly IceServerConfig[]): (string | NativeIceServer)[] {
  const out: (string | NativeIceServer)[] = [];
  for (const s of servers) {
    if (typeof s === 'string' || !('urls' in s)) {
      out.push(typeof s === 'string' ? s : { ...s });
      continue;
    }
    const urls = typeof s.urls === 'string' ? [s.urls] : s.urls;
    for (const url of urls) {
      const m = /^(stuns?|turns?):(\[[^\]]+\]|[^:?\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url.trim());
      if (m === null) throw new Error(`invalid ICE server url: ${url}`);
      const scheme = m[1]!.toLowerCase();
      const host = m[2]!.replace(/^\[|\]$/g, '');
      if (scheme === 'stun' || scheme === 'stuns') {
        out.push(url.trim());
        continue;
      }
      const tls = scheme === 'turns';
      const tcp = (m[4] ?? '').toLowerCase() === 'tcp';
      out.push({
        hostname: host,
        port: m[3] !== undefined ? Number(m[3]) : tls ? 5349 : 3478,
        username: s.username ?? '',
        password: s.credential ?? '',
        relayType: tls ? 'TurnTls' : tcp ? 'TurnTcp' : 'TurnUdp',
      });
    }
  }
  return out;
}
