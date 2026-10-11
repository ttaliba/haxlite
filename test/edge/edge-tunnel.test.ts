/**
 * haxlite Edge server robustness against a raw (possibly malicious) tunnel
 * client: auth handshake, quotas, slot validation, bad offers, garbage,
 * oversized strings. The edge must answer with the documented close codes /
 * PeerClosed reasons and never crash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import { EdgeServer, loadEdgeConfig, generateEdgeKey } from '../../src/edge/index.js';
import { EdgeCloseCode, EdgeMsg, EdgePeerClose, edgeAuthMac, shutdownWebRtc } from '../../src/net/index.js';
import { parseKeyList } from '../../src/edge/config.js';
import { makeKey, startEdge, type TestKey } from './harness.js';

const key = makeKey('raw');
const limited = { ...makeKey('limited'), maxSessions: 1 };
let edge: EdgeServer;

beforeAll(async () => {
  edge = await startEdge([key, limited], { limits: { maxPeersPerSession: 2, peerOpenCapacity: 3, maxSessionsPerKey: 2 } });
});

afterAll(async () => {
  await edge.close();
  await shutdownWebRtc();
});

class RawTunnel {
  readonly ws: WebSocket;
  readonly messages: Buffer[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (d: Buffer) => {
      this.messages.push(d);
      for (const w of this.waiters.splice(0)) w();
    });
    this.ws.on('error', () => {});
    this.closed = new Promise((r) =>
      this.ws.on('close', (code) => {
        this.closeCode = code;
        r(code);
      }),
    );
  }

  async next(type: number, ms = 5000): Promise<Reader> {
    const t0 = performance.now();
    for (;;) {
      const i = this.messages.findIndex((m) => m[0] === type);
      if (i >= 0) {
        const m = this.messages.splice(i, 1)[0]!;
        const r = new Reader(m);
        r.u8();
        return r;
      }
      if (performance.now() - t0 > ms) throw new Error(`no message ${type}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, 50);
      });
    }
  }

  send(build: (w: Writer) => void): void {
    const w = new Writer(256);
    build(w);
    this.ws.send(w.copyBytes());
  }

  async auth(k: TestKey, flags = 0, secret = k.secret): Promise<void> {
    const hello = await this.next(EdgeMsg.Hello);
    expect(hello.u8()).toBe(1);
    const nonce = hello.bytes(32);
    this.send((w) => {
      w.u8(EdgeMsg.Auth);
      w.u8(1);
      w.string(k.id);
      w.bytes(edgeAuthMac(secret, nonce));
      w.u8(flags);
    });
  }
}

describe('EdgeServer vs raw tunnel clients', () => {
  it('auth: wrong secret 4401, wrong version 4402, garbage 4400, no auth → timeout-free close', async () => {
    const bad = new RawTunnel(edge.url());
    await bad.auth(key, 0, 'not-the-secret-at-all');
    expect(await bad.closed).toBe(EdgeCloseCode.AuthFailed);

    const ver = new RawTunnel(edge.url());
    await ver.next(EdgeMsg.Hello);
    ver.send((w) => {
      w.u8(EdgeMsg.Auth);
      w.u8(99);
    });
    expect(await ver.closed).toBe(EdgeCloseCode.Version);

    const junk = new RawTunnel(edge.url());
    await junk.next(EdgeMsg.Hello);
    junk.ws.send(Buffer.from([0xee, 1, 2, 3]));
    expect(await junk.closed).toBe(EdgeCloseCode.Protocol);

    const pre = new RawTunnel(edge.url());
    await pre.next(EdgeMsg.Hello);
    pre.send((w) => {
      w.u8(EdgeMsg.PeerOpen);
      w.u16(1);
      w.string('v=0');
    });
    expect(await pre.closed).toBe(EdgeCloseCode.Protocol); // not authenticated

    const text = new RawTunnel(edge.url());
    await text.next(EdgeMsg.Hello);
    text.ws.send('hello'); // text frames are refused
    expect(await text.closed).toBe(EdgeCloseCode.Protocol);

    // wrong path: no upgrade at all
    const wrong = new WebSocket(edge.url().replace('/tunnel', '/nope'));
    wrong.on('error', () => {});
    await new Promise((r) => wrong.on('close', r));
    expect(edge.stats().sessions).toBe(0);
  });

  it('peer validation: bad offer, slot 0, duplicate slot, quotas, oversized strings', async () => {
    const t = new RawTunnel(edge.url());
    await t.auth(key, 0); // WebSocket data plane
    const ok = await t.next(EdgeMsg.AuthOk);
    expect(ok.u32()).toBeGreaterThan(0);
    expect(ok.u16()).toBe(2);
    const closedReason = async (): Promise<[number, number]> => {
      const r = await t.next(EdgeMsg.PeerClosed);
      return [r.u16(), r.u8()];
    };
    const open = (slot: number, sdp: string) =>
      t.send((w) => {
        w.u8(EdgeMsg.PeerOpen);
        w.u16(slot);
        w.string(sdp);
      });
    open(0, 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n');
    expect(await closedReason()).toEqual([0, EdgePeerClose.Limit]);
    open(5, 'v=0\r\n'); // no data channel section
    expect(await closedReason()).toEqual([5, EdgePeerClose.Failed]);
    open(6, 'v=0\r\nm=application garbage\r\n'); // libdatachannel rejects it
    expect(await closedReason()).toEqual([6, EdgePeerClose.Failed]);
    open(7, 'v=0\r\nm=application garbage\r\n');
    expect(await closedReason()).toEqual([7, EdgePeerClose.Failed]);
    // peer-open rate (capacity 3, all used) → Limit
    open(8, 'v=0\r\nm=application garbage\r\n');
    expect(await closedReason()).toEqual([8, EdgePeerClose.Limit]);
    // data / candidates / closes for unknown slots are ignored
    t.ws.send(Buffer.from([EdgeMsg.Data0, 0, 42, 1, 2, 3]));
    t.send((w) => {
      w.u8(EdgeMsg.PeerRemoteCandidate);
      w.u16(42);
      w.string('candidate:1 1 UDP 1 10.0.0.1 9 typ host');
      w.string('0');
    });
    t.send((w) => {
      w.u8(EdgeMsg.PeerClose);
      w.u16(42);
    });
    // app-level ping still answered: the session is alive
    t.send((w) => {
      w.u8(EdgeMsg.Ping);
      w.f64(123.5);
    });
    expect((await t.next(EdgeMsg.Pong)).f64()).toBe(123.5);
    // a string length beyond the limit closes the session
    t.send((w) => {
      w.u8(EdgeMsg.PeerOpen);
      w.u16(9);
      w.varUint(1_000_000);
    });
    expect(await t.closed).toBe(EdgeCloseCode.Protocol);
  });

  it('per-key session quota', async () => {
    const a = new RawTunnel(edge.url());
    await a.auth(limited);
    await a.next(EdgeMsg.AuthOk);
    const b = new RawTunnel(edge.url());
    await b.auth(limited);
    expect(await b.closed).toBe(EdgeCloseCode.Quota);
    a.ws.close();
    await a.closed;
  });

  it('config loader and key generation', () => {
    const k = generateEdgeKey('alice');
    expect(k).toMatch(/^alice:[A-Za-z0-9_-]{32}$/);
    expect(parseKeyList('a:0123456789abcdef0123\n# comment\nb:fedcba98765432100123')).toEqual([
      { id: 'a', secret: '0123456789abcdef0123' },
      { id: 'b', secret: 'fedcba98765432100123' },
    ]);
    const cfg = loadEdgeConfig([], {
      HAXLITE_EDGE_KEYS: 'h1:0123456789abcdef0123',
      HAXLITE_EDGE_PORT: '9443',
      HAXLITE_EDGE_BIND: '203.0.113.7',
      HAXLITE_EDGE_PORT_RANGE: '40000-40999',
      HAXLITE_EDGE_STATS_TOKEN: 'tok',
    });
    expect(cfg.port).toBe(9443);
    expect(cfg.keys).toEqual([{ id: 'h1', secret: '0123456789abcdef0123' }]);
    expect(cfg.webrtc).toEqual({ bindAddress: '203.0.113.7', portRange: [40000, 40999] });
    expect(cfg.statsToken).toBe('tok');
    expect(cfg.playerBackend).toBe('rtc'); // default: haxlite-rtc
    expect(cfg.tunnel).toEqual({});
    const cfg2 = loadEdgeConfig([], {
      HAXLITE_EDGE_KEYS: 'h1:0123456789abcdef0123',
      HAXLITE_EDGE_PLAYER_BACKEND: 'ndc',
      HAXLITE_EDGE_PUBLIC_ADDRESSES: '203.0.113.7, 2001:db8::7',
      HAXLITE_EDGE_TUNNEL_PORT: '9443',
    });
    expect(cfg2.playerBackend).toBe('ndc');
    expect(cfg2.webrtc!.publicAddresses).toEqual(['203.0.113.7', '2001:db8::7']);
    expect(cfg2.tunnel).toEqual({ port: 9443 });
    expect(loadEdgeConfig([], { HAXLITE_EDGE_KEYS: 'h1:0123456789abcdef0123', HAXLITE_EDGE_TUNNEL_PORT: 'off' }).tunnel).toEqual({ udp: false });
    expect(() => loadEdgeConfig([], { HAXLITE_EDGE_KEYS: 'h1:0123456789abcdef0123', HAXLITE_EDGE_PLAYER_BACKEND: 'x' })).toThrow(/player backend/);
    expect(() => loadEdgeConfig([], {})).toThrow(/no API keys/);
    expect(() => new EdgeServer({ keys: [{ id: 'x', secret: 'short' }] })).toThrow(/too short/);
  });
});
