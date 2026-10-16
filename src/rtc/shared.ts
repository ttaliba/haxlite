/**
 * Process-wide, refcounted {@link RtcEndpoint}s: every room of a process
 * that asks for the same endpoint configuration (port — 0 included —,
 * addresses, timeouts, certificate, cipher suites…) shares ONE endpoint, i.e.
 * one UDP socket per address family. Created lazily by the first lease,
 * closed when the last lease is released.
 *
 * Sessions are demultiplexed by ICE ufrag / validated 5-tuple, so rooms on
 * one socket are as isolated from each other as on separate sockets; what
 * they share is the socket, the DTLS certificate (authenticated per answer
 * by its SDP fingerprint only), `maxSessions` and the endpoint counters.
 */
import { RtcEndpoint, type RtcEndpointOptions } from './endpoint.js';

export interface SharedEndpointLease {
  /** The listening endpoint (rejects when it cannot listen; the lease is then void). */
  readonly ready: Promise<RtcEndpoint>;
  /**
   * Gives the lease back. Idempotent. The last lease closes the endpoint (one
   * macrotask later, so that the ABORT / close_notify just queued by the
   * leaving sessions reach the wire); the promise resolves once the socket(s)
   * are released (immediately when other leases remain).
   */
  release(): Promise<void>;
}

interface Entry {
  key: string;
  refs: number;
  ready: Promise<RtcEndpoint>;
}

const live = new Map<string, Entry>();
/** Endpoints being closed, by key: a new lease on the same key waits for the port to be free. */
const closing = new Map<string, Promise<void>>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function idOf(o: object): number {
  let id = objectIds.get(o);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(o, id);
  }
  return id;
}

/** Endpoints are shared only between identical configurations. */
export function sharedEndpointKey(o: RtcEndpointOptions): string {
  return JSON.stringify([
    o.port ?? 0,
    o.address ?? null,
    o.ipv6 === true,
    o.publicAddresses !== undefined ? [...o.publicAddresses] : null,
    o.iceLite === true,
    o.iceServers ?? null,
    typeof o.candidatePolicy === 'function' ? idOf(o.candidatePolicy) : (o.candidatePolicy ?? null),
    o.gatherRefreshMs ?? null,
    o.publicPort ?? null,
    o.certificate !== undefined ? Buffer.from(o.certificate.fingerprint).toString('hex') : null,
    o.certificateFile ?? null,
    o.idleTimeoutMs ?? null,
    o.handshakeTimeoutMs ?? null,
    o.maxSessions ?? null,
    o.dataLayer !== undefined ? idOf(o.dataLayer) : null,
    o.mtu ?? null,
    o.maxMessageSize ?? null,
    o.socketBufferSize ?? null,
    o.cipherSuites ?? null,
  ]);
}

/** Takes a lease on the process-wide endpoint for `opts` (listening on first use). */
export function acquireSharedEndpoint(opts: RtcEndpointOptions): SharedEndpointLease {
  const key = sharedEndpointKey(opts);
  let e = live.get(key);
  if (e === undefined) {
    const prev = closing.get(key);
    const entry: Entry = { key, refs: 0, ready: null as unknown as Promise<RtcEndpoint> };
    entry.ready = (prev ?? Promise.resolve()).then(() => RtcEndpoint.listen(opts));
    entry.ready.catch(() => {
      if (live.get(key) === entry) live.delete(key); // the next lease retries
    });
    live.set(key, entry);
    e = entry;
  }
  const entry = e;
  entry.refs++;
  let released = false;
  return {
    ready: entry.ready,
    release(): Promise<void> {
      if (released) return Promise.resolve();
      released = true;
      if (--entry.refs > 0) return Promise.resolve();
      if (live.get(key) === entry) live.delete(key);
      const done = entry.ready.then(
        (ep) => new Promise<void>((r) => setImmediate(r)).then(() => ep.close()),
        () => {},
      );
      closing.set(key, done);
      void done.then(() => {
        if (closing.get(key) === done) closing.delete(key);
      });
      return done;
    },
  };
}

/** Number of live shared endpoints (diagnostics / tests). */
export function sharedEndpointCount(): number {
  return live.size;
}
