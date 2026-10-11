/**
 * Seeded UDP impairment proxy for the interop harness: sits between the
 * browser and the WebRTC server on loopback and applies loss, delay, jitter,
 * reordering and duplication to every datagram (STUN, DTLS and SCTP alike).
 *
 *   browser ──▶ listen socket (advertised as the server's ICE candidate)
 *              └─ per browser source address: one upstream socket ──▶ target (real server)
 *
 * The server sees each browser 5-tuple as the proxy's upstream socket (a
 * peer-reflexive candidate), so the browser's own candidates must NOT be
 * given to the server (a full-ICE server could otherwise find a direct path).
 */
import dgram from 'node:dgram';
import { isIPv6 } from 'node:net';

export interface ImpairOptions {
  /** Drop probability per datagram, 0..1. */
  loss?: number;
  /** Base one-way delay (ms). */
  delayMs?: number;
  /** Extra uniform random delay in [0, jitterMs] per datagram (reorders naturally). */
  jitterMs?: number;
  /** Probability that a datagram is held back an extra `reorderDelayMs` (forced reordering). */
  reorder?: number;
  reorderDelayMs?: number;
  /** Probability that a datagram is delivered twice (second copy with its own delay). */
  duplicate?: number;
  /** PRNG seed (deterministic decisions for a given packet sequence). */
  seed?: number;
}

export interface ProxyStats {
  /** browser → server */
  up: DirStats;
  /** server → browser */
  down: DirStats;
  /** Distinct browser source addresses seen. */
  clients: number;
}
export interface DirStats {
  in: number;
  dropped: number;
  duplicated: number;
  reordered: number;
  out: number;
}

/** mulberry32: small fast seeded PRNG, [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Large kernel buffers so the proxy itself never adds loss on bursts (capped by net.core.[rw]mem_max). */
const SOCK_BUFS = { recvBufferSize: 4 << 20, sendBufferSize: 4 << 20 };

function newDir(): DirStats {
  return { in: 0, dropped: 0, duplicated: 0, reordered: 0, out: 0 };
}

/**
 * Impairment decision for one datagram: the delays (ms) of the copies to
 * deliver (empty = dropped). Pure given the PRNG; exported for unit tests.
 */
export function impairDecision(o: ImpairOptions, rnd: () => number, st: DirStats): number[] {
  st.in++;
  if ((o.loss ?? 0) > 0 && rnd() < o.loss!) {
    st.dropped++;
    return [];
  }
  const one = (): number => {
    let d = (o.delayMs ?? 0) + (o.jitterMs ?? 0) * rnd();
    if ((o.reorder ?? 0) > 0 && rnd() < o.reorder!) {
      d += o.reorderDelayMs ?? 20;
      st.reordered++;
    }
    return d;
  };
  const out = [one()];
  if ((o.duplicate ?? 0) > 0 && rnd() < o.duplicate!) {
    out.push(one());
    st.duplicated++;
  }
  return out;
}

export class UdpImpairProxy {
  private readonly listen: dgram.Socket;
  private readonly upstream = new Map<string, dgram.Socket>();
  private readonly rnd: () => number;
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;
  readonly stats: ProxyStats = { up: newDir(), down: newDir(), clients: 0 };
  /** Impairment can be changed on the fly (e.g. clean handshake, then loss). */
  impair: ImpairOptions;

  private constructor(
    private readonly target: { address: string; port: number },
    listen: dgram.Socket,
    impair: ImpairOptions,
  ) {
    this.listen = listen;
    this.impair = impair;
    this.rnd = mulberry32(impair.seed ?? 1);
    listen.on('message', (msg, rinfo) => this.fromClient(msg, rinfo));
    listen.on('error', () => {});
  }

  /** Starts a proxy towards `target`, listening on `listenAddress` (same family as the target by default). */
  static async start(
    target: { address: string; port: number },
    impair: ImpairOptions,
    listenAddress: string = isIPv6(target.address) ? '::1' : '127.0.0.1',
  ): Promise<UdpImpairProxy> {
    const sock = dgram.createSocket({ type: isIPv6(listenAddress) ? 'udp6' : 'udp4', ...SOCK_BUFS });
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(0, listenAddress, () => {
        sock.off('error', reject);
        resolve();
      });
    });
    return new UdpImpairProxy(target, sock, impair);
  }

  /** Address the browser must send to (advertise it as the server candidate). */
  get address(): { address: string; port: number } {
    const a = this.listen.address();
    return { address: a.address, port: a.port };
  }

  private schedule(delays: number[], fn: () => void, st: DirStats): void {
    for (const d of delays) {
      const go = () => {
        if (this.closed) return;
        st.out++;
        fn();
      };
      if (d <= 0) go();
      else {
        const t = setTimeout(() => {
          this.timers.delete(t);
          go();
        }, d);
        this.timers.add(t);
      }
    }
  }

  private fromClient(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (this.closed) return;
    const key = `${rinfo.address}|${rinfo.port}`;
    let up = this.upstream.get(key);
    if (up === undefined) {
      const sock = dgram.createSocket({ type: isIPv6(this.target.address) ? 'udp6' : 'udp4', ...SOCK_BUFS });
      up = sock;
      this.upstream.set(key, sock);
      this.stats.clients++;
      sock.on('error', () => {});
      sock.on('message', (m) => {
        const delays = impairDecision(this.impair, this.rnd, this.stats.down);
        this.schedule(delays, () => this.listen.send(m, rinfo.port, rinfo.address), this.stats.down);
      });
      sock.bind(0); // wildcard: the kernel picks the source address for the target's route
    }
    const u = up;
    const delays = impairDecision(this.impair, this.rnd, this.stats.up);
    this.schedule(delays, () => u.send(msg, this.target.port, this.target.address), this.stats.up);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    try {
      this.listen.close();
    } catch {}
    for (const s of this.upstream.values()) {
      try {
        s.close();
      } catch {}
    }
    this.upstream.clear();
  }
}
