/**
 * haxlite Edge test helpers (TEST ONLY). The edge and the host are bound to
 * DIFFERENT loopback addresses (edge 127.0.0.2, host 127.0.0.3) so tests can
 * assert that nothing the clients receive mentions the host.
 */
import { randomBytes } from 'node:crypto';
import { inflateRaw, Reader } from '../../src/codec/index.js';
import { EdgeServer, type EdgeServerOptions } from '../../src/edge/index.js';
import { parseCandidate, type EdgeOptions, type IceCandidateInit } from '../../src/net/index.js';
import type { FakeMaster } from '../fake-master/index.js';

export const EDGE_IP = '127.0.0.2';
export const HOST_IP = '127.0.0.3';

export interface TestKey {
  id: string;
  secret: string;
  readonly key: string;
  maxSessions?: number;
}

export function makeKey(id: string): TestKey {
  const secret = randomBytes(24).toString('base64url');
  return { id, secret, key: `${id}:${secret}` };
}

export async function startEdge(keys: TestKey[], opts: Partial<EdgeServerOptions> = {}): Promise<EdgeServer> {
  return EdgeServer.start({
    host: EDGE_IP,
    port: 0,
    keys: keys.map((k) => ({ id: k.id, secret: k.secret, maxSessions: k.maxSessions })),
    webrtc: {
      bindAddress: EDGE_IP,
      iceServers: [],
      // loopback test: announce the edge's 127.0.0.2; remote policy stays at the
      // secure default ('public'): host/tunnel loopback candidates are dropped
      // and connections come up through peer-reflexive discovery
      iceCandidatePolicy: 'all',
      ...opts.webrtc,
    },
    log: process.env.EDGE_DEBUG ? (m) => console.log(`[edge] ${m}`) : undefined,
    ...opts,
  });
}

export function edgeConfig(edge: EdgeServer, key: TestKey, extra: Partial<EdgeOptions> = {}): EdgeOptions {
  return {
    url: edge.url(),
    key: key.key,
    bindAddress: HOST_IP,
    log: process.env.EDGE_DEBUG ? (m) => console.log(`[host] ${m}`) : undefined,
    ...extra,
  };
}

export interface ClientSignalingReport {
  answers: number;
  candidates: number;
  /** Every candidate address (answer SDP lines + candidate lists + trickled). */
  addresses: Set<string>;
  /** Every `c=` address of the answers. */
  connAddresses: Set<string>;
  /** Concatenated inflated text of everything (for substring checks). */
  text: string;
}

/** Decodes everything the master relayed to clients (`master.clientMessages`). */
export function inspectClientSignaling(master: FakeMaster): ClientSignalingReport {
  const rep: ClientSignalingReport = { answers: 0, candidates: 0, addresses: new Set(), connAddresses: new Set(), text: '' };
  const addCand = (line: string) => {
    const p = parseCandidate(line.startsWith('a=') ? line.slice(2) : line);
    if (p !== null) rep.addresses.add(p.address);
  };
  for (const m of master.clientMessages ?? []) {
    const bytes = inflateRaw(m.payload);
    rep.text += Buffer.from(bytes).toString('latin1') + '\n';
    const r = new Reader(bytes);
    if (m.type === 1) {
      rep.answers++;
      const sdp = r.string();
      for (const line of sdp.split(/\r?\n/)) {
        if (line.startsWith('a=candidate:')) addCand(line);
        if (line.startsWith('c=IN ')) rep.connAddresses.add(line.split(' ')[2]!);
      }
      for (const c of r.json<IceCandidateInit[]>()) {
        rep.candidates++;
        addCand(c.candidate);
      }
    } else if (m.type === 4) {
      const c = r.json<IceCandidateInit>();
      rep.candidates++;
      addCand(c.candidate);
    }
  }
  return rep;
}

/** Remote address of a client RTCPeerConnection's selected pair (node-datachannel polyfill getStats). */
export async function selectedRemote(pc: { getStats(): Promise<Map<string, { type: string; ip?: string }>> }): Promise<string | null> {
  const stats = await pc.getStats();
  for (const s of stats.values()) if (s.type === 'remote-candidate') return s.ip ?? null;
  return null;
}
