/**
 * ICE candidate helpers.
 *
 * Signaling carries candidates as the JSON form of `RTCIceCandidate`
 * (`{candidate, sdpMid, sdpMLineIndex, usernameFragment?}`), exactly what the
 * browser's `JSON.stringify(candidate)` produces and what `new
 * RTCIceCandidate(json)` accepts on the client.
 */

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

/** Strips the `a=` prefix libdatachannel may put on candidate lines. */
export function candidateLine(c: string): string {
  return c.startsWith('a=') ? c.slice(2) : c;
}
