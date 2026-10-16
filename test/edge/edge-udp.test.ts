/**
 * haxlite Edge tunnel v2 (SCTP over AES-128-GCM UDP, src/net/edge-udp.ts +
 * src/edge/tunnel-udp.ts):
 *  - the datagram cipher (round trip, tampering, wrong key/direction, replay
 *    window, epoch ratchet) and the x25519 + HKDF key schedule;
 *  - two planes wired back to back over a lossy in-memory link (channel
 *    semantics: ro ordered, ru reliable, uu unreliable, ro lanes);
 *  - the control handshake against fake edges (AuthOk MAC forgery → fatal,
 *    a protocol-1 edge → WebSocket data plane) and raw clients against the
 *    real edge (bad v2 MAC, bad key share);
 *  - a live room through a recording UDP proxy: unknown connection ids,
 *    forged and replayed datagrams get no answer at all and never move the
 *    host's address, the foreign-source bucket caps AEAD work, NAT rebinding
 *    is followed, the key ratchet runs while playing.
 */
import dgram from 'node:dgram';
import { createCipheriv, getCiphers, hkdfSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import { FakeMaster } from '../fake-master/index.js';
import { nodeHaxballFor } from '../fake-master/node-haxball.js';
import { E2E, shutdownAll, sleep, waitFor, type Any } from '../host/harness.js';
import { EdgeError, EdgePeerBackend } from '../../src/net/edge-client.js';
import { AuthFlag, EdgeCloseCode, EdgeMsg, edgeAuthMacV2 } from '../../src/net/edge-protocol.js';
import {
  REPLAY_WINDOW,
  TunnelCipher,
  UdpTunnelPlane,
  UdpType,
  deriveTunnelSecrets,
  grantTunnelAead,
  grantedTunnelAead,
  preferredTunnelAead,
  tunnelAeadFlag,
  tunnelAeadRequest,
  type TunnelAead,
  udpConnId,
  x25519Generate,
  x25519Shared,
  type TunnelSecrets,
} from '../../src/net/edge-udp.js';
import type { EdgeServer } from '../../src/edge/index.js';
import { EDGE_IP, HOST_IP, edgeConfig, makeKey, startEdge } from './harness.js';

function secrets(): TunnelSecrets {
  return { h2e: randomBytes(32), e2h: randomBytes(32) };
}

const AEADS: TunnelAead[] = ['aes-128-gcm', 'chacha20-poly1305'];

function pair(s = secrets(), connId = 0x01020304, rekey?: number, aead?: TunnelAead): [TunnelCipher, TunnelCipher] {
  const o = { ...(rekey !== undefined ? { rekeyAfterPackets: rekey } : null), ...(aead !== undefined ? { aead } : null) };
  return [new TunnelCipher(connId, s.h2e, s.e2h, o), new TunnelCipher(connId, s.e2h, s.h2e, o)];
}

describe.each(AEADS)('tunnel v2 cipher (%s)', (aead) => {
  it('round trip, header layout, tampering, wrong direction, replay window', () => {
    const [host, edge] = pair(secrets(), 0x01020304, undefined, aead);
    expect(host.aead).toBe(aead);
    const d = host.seal(UdpType.Sctp, Buffer.from('hello'))!;
    expect(d.length).toBe(13 + 5 + 16);
    expect(d[0]).toBe(UdpType.Sctp);
    expect(udpConnId(d)).toBe(0x01020304);
    expect(d.readUInt16BE(5)).toBe(0); // epoch
    expect(d.readUIntBE(7, 6)).toBe(0); // seq
    expect(edge.open(d)?.toString()).toBe('hello');
    expect(edge.lastType).toBe(UdpType.Sctp);
    expect(edge.lastNewest).toBe(true);
    // replay
    expect(edge.open(d)).toBeNull();
    expect(edge.replayed).toBe(1);
    // the sender cannot open its own datagram (one key per direction: no reflection)
    const d2 = host.seal(UdpType.Ping, Buffer.alloc(8))!;
    expect(host.open(d2)).toBeNull();
    // every single-bit flip (header = AAD, ciphertext, tag) is rejected
    let rejected = 0;
    for (let i = 0; i < d2.length; i++) {
      const t = Buffer.from(d2);
      t[i]! ^= 0x10;
      if (edge.open(t) === null) rejected++;
    }
    expect(rejected).toBe(d2.length);
    expect(edge.open(d2)).not.toBeNull(); // the genuine one still passes once
    // another tunnel's keys
    const [other] = pair(secrets(), 0x01020304, undefined, aead);
    expect(edge.open(other.seal(UdpType.Sctp, Buffer.from('x'))!)).toBeNull();
    expect(edge.badMac).toBeGreaterThan(0);
    // reordering inside the window is fine, each datagram once; too old is dropped
    const many = Array.from({ length: REPLAY_WINDOW + 10 }, (_, i) => host.seal(UdpType.Sctp, Buffer.from([i & 0xff]))!);
    const newest = many[many.length - 1]!;
    expect(edge.open(newest)).not.toBeNull();
    expect(edge.open(many[many.length - 5]!)).not.toBeNull(); // late but within the window
    expect(edge.lastNewest).toBe(false);
    expect(edge.open(many[many.length - 5]!)).toBeNull();
    expect(edge.open(many[0]!)).toBeNull(); // outside the window
    // too short / truncated
    expect(edge.open(newest.subarray(0, 20))).toBeNull();
  });

  it('epoch ratchet: keys change every N datagrams, reordered previous-epoch datagrams still accepted', () => {
    const [host, edge] = pair(secrets(), 7, 4, aead);
    const out: Buffer[] = [];
    for (let i = 0; i < 20; i++) out.push(host.seal(UdpType.Sctp, Buffer.from([i]))!);
    expect(out.map((d) => d.readUInt16BE(5))).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    // epoch 1 arrives before the end of epoch 0
    const order = [0, 1, 4, 2, 3, 5, 6, 8, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    for (const i of order) expect(edge.open(out[i]!)?.[0], `datagram ${i}`).toBe(i);
    expect(edge.rekeys).toBe(4);
    expect(host.rekeys).toBe(4);
    // two epochs ahead (skipped key) or long gone: dropped
    const [h2, e2] = pair(secrets(), 7, 2, aead);
    const seq = Array.from({ length: 6 }, () => h2.seal(UdpType.Sctp, Buffer.from([1]))!);
    expect(e2.open(seq[4]!)).toBeNull(); // epoch 2 while the receiver is at 0
    expect(e2.open(seq[0]!)).not.toBeNull();
  });

});

describe('tunnel v2 cipher', () => {
  it('wire format matches an independent AES-128-GCM reference, also with the reused output buffer and a 48-bit seq', () => {
    const s = secrets();
    const [host, edge] = pair(s, 0xfedcba98, 2 ** 49); // no ratchet: epoch 0 throughout
    const key = Buffer.from(hkdfSync('sha256', s.h2e, Buffer.alloc(0), 'haxlite-tunnel/2 key', 16));
    const iv = Buffer.from(hkdfSync('sha256', s.h2e, Buffer.alloc(0), 'haxlite-tunnel/2 iv', 12));
    const reference = (type: number, seq: number, plain: Buffer): Buffer => {
      const h = Buffer.alloc(13);
      h[0] = type;
      h.writeUInt32BE(0xfedcba98, 1);
      h.writeUInt16BE(0, 5);
      h.writeUIntBE(seq, 7, 6);
      const nonce = Buffer.from(iv);
      for (let i = 6; i < 12; i++) nonce[i]! ^= h[i + 1]!;
      const c = createCipheriv('aes-128-gcm', key, nonce, { authTagLength: 16 });
      c.setAAD(h);
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([h, ct, c.getAuthTag()]);
    };
    let view: Buffer | null = null;
    for (const [seq, len] of [[0, 0], [1, 50], [0xffffffff, 300], [2 ** 40 + 0x123456789, 1200], [2 ** 48 - 2, 7]] as const) {
      (host as Any).seq = seq;
      const plain = randomBytes(len);
      const fresh = host.seal(UdpType.Sctp, plain)!;
      expect(fresh.equals(reference(UdpType.Sctp, seq, plain)), `seq ${seq}`).toBe(true);
      (host as Any).seq = seq;
      const reused = host.seal(UdpType.Sctp, plain, true)!;
      expect(reused.equals(fresh)).toBe(true);
      if (view !== null && view.length > 0) expect(reused.buffer).toBe(view.buffer); // one buffer, reused
      view = reused;
      expect(edge.open(Buffer.from(reused))?.equals(plain), `open seq ${seq}`).toBe(true);
    }
    // the transport kept it: a new buffer from then on
    host.releaseScratch();
    expect(host.seal(UdpType.Ping, Buffer.alloc(8), true)!.buffer).not.toBe(view!.buffer);
  });

  it.skipIf(!getCiphers().includes('chacha20-poly1305'))('ChaCha20-Poly1305: matches node:crypto both ways, opens in place, no allocation but the view', () => {
    const s = secrets();
    const [host, edge] = pair(s, 0x0badf00d, 2 ** 49, 'chacha20-poly1305');
    const key = Buffer.from(hkdfSync('sha256', s.h2e, Buffer.alloc(0), 'haxlite-tunnel/2 chacha20 key', 32));
    const iv = Buffer.from(hkdfSync('sha256', s.h2e, Buffer.alloc(0), 'haxlite-tunnel/2 iv', 12));
    const reference = (type: number, seq: number, plain: Buffer): Buffer => {
      const h = Buffer.alloc(13);
      h[0] = type;
      h.writeUInt32BE(0x0badf00d, 1);
      h.writeUIntBE(seq, 7, 6);
      const nonce = Buffer.from(iv);
      for (let i = 6; i < 12; i++) nonce[i]! ^= h[i + 1]!;
      const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      c.setAAD(h, { plaintextLength: plain.length });
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([h, ct, c.getAuthTag()]);
    };
    for (const [seq, len] of [[0, 0], [1, 1], [2, 63], [3, 64], [4, 65], [0xffffffff, 300], [2 ** 40 + 77, 1200]] as const) {
      (host as Any).seq = seq;
      const plain = randomBytes(len);
      const d = host.seal(UdpType.Sctp, plain, true)!;
      const ref = reference(UdpType.Sctp, seq, plain);
      expect(d.equals(ref), `seq ${seq} len ${len}`).toBe(true);
      // a datagram sealed by node:crypto opens here, in place
      const pt = edge.open(ref)!;
      expect(pt.equals(plain)).toBe(true);
      if (len > 0) {
        expect(pt.buffer).toBe(ref.buffer);
        expect(pt.byteOffset).toBe(ref.byteOffset + 13);
      }
    }
    // a failed open leaves the datagram untouched
    (host as Any).seq = 2 ** 40 + 100;
    const d = Buffer.from(host.seal(UdpType.Sctp, Buffer.from('abc'))!);
    const bad = Buffer.from(d);
    bad[d.length - 1]! ^= 1;
    const copy = Buffer.from(bad);
    expect(edge.open(bad)).toBeNull();
    expect(bad.equals(copy)).toBe(true);
    expect(edge.open(d)?.toString()).toBe('abc');
  });

  it('a host and an edge on different AEADs never open each other (AES-128-GCM vs ChaCha20-Poly1305)', () => {
    const s = secrets();
    const aes = new TunnelCipher(5, s.h2e, s.e2h);
    const chacha = new TunnelCipher(5, s.e2h, s.h2e, { aead: 'chacha20-poly1305' });
    expect(aes.aead).toBe('aes-128-gcm'); // the default: what every v2 peer speaks
    expect(chacha.open(aes.seal(UdpType.Sctp, Buffer.from('x'))!)).toBeNull();
    expect(aes.open(chacha.seal(UdpType.Sctp, Buffer.from('x'))!)).toBeNull();
    expect(aes.badMac + chacha.badMac).toBe(2);
    expect(() => new TunnelCipher(5, s.h2e, s.e2h, { aead: 'aes-256-gcm' as TunnelAead })).toThrow();
  });

  it('AEAD negotiation: ChaCha20-Poly1305 only when both ends prefer it; old peers stay on AES-128-GCM', () => {
    // host side: what to ask for
    expect(tunnelAeadRequest('aes-128-gcm')).toBe(0);
    expect(tunnelAeadRequest('chacha20-poly1305')).toBe(AuthFlag.ChaCha);
    expect(tunnelAeadRequest('auto')).toBe(preferredTunnelAead() === 'chacha20-poly1305' ? AuthFlag.ChaCha : 0);
    expect(preferredTunnelAead(false)).toBe('chacha20-poly1305'); // Node
    expect(preferredTunnelAead(true)).toBe('aes-128-gcm'); // Bun
    // edge side: a host that did not ask (every host before the flag) gets AES-128-GCM, whatever the edge prefers
    const old = AuthFlag.Udp | AuthFlag.RoLanes;
    for (const opt of ['auto', 'aes-128-gcm', 'chacha20-poly1305'] as const) expect(grantTunnelAead(old, opt)).toBe('aes-128-gcm');
    const asks = old | AuthFlag.ChaCha;
    expect(grantTunnelAead(asks, 'chacha20-poly1305')).toBe('chacha20-poly1305');
    expect(grantTunnelAead(asks, 'aes-128-gcm')).toBe('aes-128-gcm');
    expect(grantTunnelAead(asks, 'auto')).toBe(preferredTunnelAead());
    // host side: an edge before the flag echoes only Udp | RoLanes → AES-128-GCM
    expect(grantedTunnelAead(old)).toBe('aes-128-gcm');
    expect(grantedTunnelAead(old | tunnelAeadFlag('chacha20-poly1305'))).toBe('chacha20-poly1305');
    expect(tunnelAeadFlag('aes-128-gcm')).toBe(0);
    // the flag does not collide with the planes/lanes an old edge interprets
    expect(AuthFlag.ChaCha & (AuthFlag.WebRtc | AuthFlag.RoLanes | AuthFlag.Udp)).toBe(0);
  });

  it('plane: datagrams go into one reused buffer only while transmit() reports them released', () => {
    const s = secrets();
    for (const released of [true, false]) {
      const seen: Buffer[] = [];
      const plane = new UdpTunnelPlane({
        role: 'client',
        connId: 9,
        secrets: s,
        lanes: 1,
        transmit: (d) => {
          seen.push(d);
          return released ? true : undefined;
        },
        events: { onOpen: () => {}, onMessage: () => {}, onClose: () => {} },
      });
      plane.ping();
      plane.ping();
      plane.close();
      expect(seen.length).toBeGreaterThanOrEqual(4); // ping, INIT, ping, ping, ABORT, Close
      const ids = new Map<ArrayBufferLike, number>();
      const places = new Set(seen.slice(1).map((d) => `${ids.get(d.buffer) ?? ids.set(d.buffer, ids.size).size - 1}:${d.byteOffset}`));
      expect(places.size).toBe(released ? 1 : seen.length - 1);
    }
  });

  it('x25519 + HKDF: both ends derive the same keys; a low-order key share is refused', () => {
    const a = x25519Generate();
    const b = x25519Generate();
    const nonce = randomBytes(32);
    const sa = deriveTunnelSecrets(x25519Shared(a.privateKey, b.publicKey), 'api-secret-0123456789', nonce, a.publicKey, b.publicKey, 42);
    const sb = deriveTunnelSecrets(x25519Shared(b.privateKey, a.publicKey), 'api-secret-0123456789', nonce, a.publicKey, b.publicKey, 42);
    expect(sa.h2e.equals(sb.h2e)).toBe(true);
    expect(sa.e2h.equals(sb.e2h)).toBe(true);
    expect(sa.h2e.equals(sa.e2h)).toBe(false);
    // the API secret is mixed in: same ECDHE, other key → other traffic keys
    const sc = deriveTunnelSecrets(x25519Shared(a.privateKey, b.publicKey), 'another-secret-012345', nonce, a.publicKey, b.publicKey, 42);
    expect(sc.h2e.equals(sa.h2e)).toBe(false);
    expect(() => x25519Shared(a.privateKey, Buffer.alloc(32))).toThrow();
    expect(() => x25519Shared(a.privateKey, Buffer.alloc(31))).toThrow();
  });
});

describe('tunnel v2 plane (SCTP over the cipher)', () => {
  it.each(AEADS)('ro ordered, ru reliable, uu unreliable, ro lanes, over a 10 % lossy reordering link (%s)', async (aead) => {
    const s = secrets();
    let rnd = 12345;
    const random = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 4294967296);
    const got: { ch: number; v: number }[] = [];
    let opened = 0;
    let server: UdpTunnelPlane | null = null;
    const link = (to: () => UdpTunnelPlane | null) => (d: Buffer) => {
      if (random() < 0.1) return;
      const delay = random() < 0.1 ? 15 : 1;
      setTimeout(() => to()?.receive(d), delay);
    };
    const client = new UdpTunnelPlane({
      role: 'client',
      connId: 9,
      secrets: s,
      lanes: 4,
      aead,
      transmit: link(() => server),
      events: { onOpen: () => opened++, onMessage: () => {}, onClose: () => {} },
    });
    server = new UdpTunnelPlane({
      role: 'server',
      connId: 9,
      secrets: s,
      lanes: 4,
      aead,
      transmit: link(() => client),
      events: { onOpen: () => opened++, onMessage: (ch, d) => got.push({ ch, v: d[0]! | (d[1]! << 8) }), onClose: () => {} },
    });
    await waitFor(() => opened === 2, 10_000, 'association');
    const N = 300;
    for (let i = 0; i < N; i++) {
      for (const ch of [0, 1, 2, 3, 5]) expect(client.send(ch, Uint8Array.of(i & 0xff, i >> 8, ch))).toBe(true);
      if (i % 30 === 0) await sleep(5);
    }
    await waitFor(() => got.filter((g) => g.ch !== 2).length === 4 * N, 20_000, 'reliable channels');
    for (const ch of [0, 3, 5]) expect(got.filter((g) => g.ch === ch).map((g) => g.v)).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(new Set(got.filter((g) => g.ch === 1).map((g) => g.v)).size).toBe(N);
    const uu = got.filter((g) => g.ch === 2).length;
    expect(uu).toBeLessThan(N); // never retransmitted
    expect(uu).toBeGreaterThan(N * 0.5);
    expect(client.stats().sctp.retransmissions).toBeGreaterThan(0);
    client.close();
    server.close();
  });
});

// ------------------------------------------------------------------ handshake against fake edges

/** A fake edge control endpoint that runs `script` on every connection. */
async function fakeEdge(script: (ws: WebSocket, recv: () => Promise<Buffer>) => Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
  const wss = new WebSocketServer({ host: EDGE_IP, port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    const queue: Buffer[] = [];
    const waiters: ((b: Buffer) => void)[] = [];
    ws.on('message', (d: Buffer) => {
      const w = waiters.shift();
      if (w) w(d);
      else queue.push(d);
    });
    void script(ws, () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r)))).catch(() => ws.terminate());
  });
  const port = (wss.address() as Any).port as number;
  return { url: `ws://${EDGE_IP}:${port}/tunnel`, close: () => new Promise((r) => wss.close(() => r())) };
}

function msg(build: (w: Writer) => void): Uint8Array {
  const w = new Writer(256);
  build(w);
  return w.copyBytes();
}

async function runBackend(b: EdgePeerBackend): Promise<{ ready: boolean; errors: Error[] }> {
  const st = { ready: false, errors: [] as Error[] };
  b.start({ onReady: () => (st.ready = true), onDown: () => {}, onError: (e) => st.errors.push(e) });
  await waitFor(() => st.ready || st.errors.length > 0, 5000, 'backend outcome');
  return st;
}

describe('tunnel v2 control handshake', () => {
  it('a forged AuthOk (edge without the key) is a fatal auth error', async () => {
    const key = makeKey('forge');
    const fake = await fakeEdge(async (ws, recv) => {
      const nonce = randomBytes(32);
      ws.send(msg((w) => (w.u8(EdgeMsg.Hello), w.u8(1), w.bytes(nonce), w.u8(2))));
      const auth = new Reader(await recv());
      expect(auth.u8()).toBe(EdgeMsg.Auth);
      expect(auth.u8()).toBe(2);
      auth.string();
      auth.bytes(32);
      const flags = auth.u8();
      expect(flags & AuthFlag.Udp).toBe(AuthFlag.Udp);
      ws.send(
        msg((w) => {
          w.u8(EdgeMsg.AuthOk);
          w.u32(1);
          w.u16(10);
          w.u8(AuthFlag.Udp);
          w.bytes(x25519Generate().publicKey);
          w.u32(5);
          w.u16(4000);
          w.string('');
          w.bytes(randomBytes(32)); // cannot compute the MAC without the secret
        }),
      );
    });
    const b = new EdgePeerBackend({ url: fake.url, key: key.key, bindAddress: HOST_IP, reconnectMinMs: 60_000 });
    try {
      const st = await runBackend(b);
      expect(st.ready).toBe(false);
      expect(st.errors[0]).toBeInstanceOf(EdgeError);
      expect((st.errors[0] as EdgeError).kind).toBe('auth');
      expect((st.errors[0] as EdgeError).fatal).toBe(true);
    } finally {
      b.stop();
      await fake.close();
    }
  });

  it('a protocol-1 edge: v1 Auth, the host runs on the WebSocket data plane', async () => {
    const key = makeKey('legacy');
    let authVersion = -1;
    let authFlags = -1;
    const fake = await fakeEdge(async (ws, recv) => {
      ws.send(msg((w) => (w.u8(EdgeMsg.Hello), w.u8(1), w.bytes(randomBytes(32))))); // no max-version byte
      const auth = new Reader(await recv());
      auth.u8();
      authVersion = auth.u8();
      auth.string();
      auth.bytes(32);
      authFlags = auth.u8();
      ws.send(msg((w) => (w.u8(EdgeMsg.AuthOk), w.u32(1), w.u16(10), w.u8(0))));
    });
    const b = new EdgePeerBackend({ url: fake.url, key: key.key, bindAddress: HOST_IP });
    try {
      const st = await runBackend(b);
      expect(st.errors).toEqual([]);
      expect(st.ready).toBe(true);
      expect(authVersion).toBe(1);
      expect(authFlags).toBe(0);
      expect(b.stats().dataPlane).toBe('ws');
    } finally {
      b.stop();
      await fake.close();
    }
  });
});

// ------------------------------------------------------------------ the real edge

/** Recording, rebindable UDP relay between the host and the edge's tunnel port. */
class TunnelProxy {
  readonly listen: dgram.Socket;
  upstream: dgram.Socket | null = null;
  hostAddr: dgram.RemoteInfo | null = null;
  target = 0;
  readonly fromHost: Buffer[] = [];
  private constructor(listen: dgram.Socket) {
    this.listen = listen;
    listen.on('message', (m, r) => {
      this.hostAddr = r;
      this.fromHost.push(Buffer.from(m));
      if (this.fromHost.length > 200) this.fromHost.shift();
      this.up().send(m, this.target, EDGE_IP);
    });
  }
  static async start(): Promise<TunnelProxy> {
    const s = dgram.createSocket('udp4');
    await new Promise<void>((r) => s.bind(0, EDGE_IP, () => r()));
    return new TunnelProxy(s);
  }
  get port(): number {
    return this.listen.address().port;
  }
  private up(): dgram.Socket {
    if (this.upstream === null) {
      const u = dgram.createSocket('udp4');
      u.bind(0, '127.0.0.4');
      u.on('message', (m) => {
        if (this.upstream === u && this.hostAddr !== null) this.listen.send(m, this.hostAddr.port, this.hostAddr.address);
      });
      this.upstream = u;
    }
    return this.upstream;
  }
  /** NAT rebinding: the next datagram leaves from a new source port. */
  rebind(): void {
    const old = this.upstream;
    this.upstream = null;
    old?.close();
  }
  close(): void {
    this.listen.close();
    this.upstream?.close();
  }
}

async function rawSocket(address = '127.0.0.5'): Promise<{ sock: dgram.Socket; got: Buffer[] }> {
  const sock = dgram.createSocket('udp4');
  const got: Buffer[] = [];
  sock.on('message', (m) => got.push(m));
  await new Promise<void>((r) => sock.bind(0, address, () => r()));
  return { sock, got };
}

describe('tunnel v2 against the real edge', () => {
  let master: FakeMaster;
  let nh: Any;
  let edge: EdgeServer;
  let proxy: TunnelProxy;
  const key = makeKey('udp');

  beforeAll(async () => {
    master = await FakeMaster.start();
    nh = nodeHaxballFor(master);
    proxy = await TunnelProxy.start();
    edge = await startEdge([key], { tunnel: { publicHost: EDGE_IP, publicPort: proxy.port, maxForeignPps: 10 } });
    proxy.target = edge.tunnelPort!;
  });

  afterAll(async () => {
    proxy?.close();
    await edge?.close();
    await master?.close();
    await shutdownAll();
  });

  it('raw control clients: bad v2 MAC → 4401, low-order key share → 4400', async () => {
    const attempt = async (mutate: (nonce: Uint8Array) => Uint8Array): Promise<number> => {
      const ws = new WebSocket(edge.url());
      ws.binaryType = 'nodebuffer';
      const hello = await new Promise<Buffer>((r) => ws.once('message', (d: Buffer) => r(d)));
      const r = new Reader(hello);
      expect(r.u8()).toBe(EdgeMsg.Hello);
      expect(r.u8()).toBe(1);
      const nonce = r.bytesCopy(32);
      expect(r.u8()).toBe(2);
      ws.send(mutate(nonce));
      return new Promise((res) => ws.on('close', (code) => res(code)));
    };
    const pub = x25519Generate().publicKey;
    const flags = AuthFlag.Udp;
    // MAC over other flags than the ones sent
    expect(
      await attempt((nonce) => msg((w) => (w.u8(EdgeMsg.Auth), w.u8(2), w.string(key.id), w.bytes(edgeAuthMacV2(key.secret, nonce, 0, pub)), w.u8(flags), w.bytes(pub)))),
    ).toBe(EdgeCloseCode.AuthFailed);
    // MAC over another public key
    expect(
      await attempt((nonce) =>
        msg((w) => (w.u8(EdgeMsg.Auth), w.u8(2), w.string(key.id), w.bytes(edgeAuthMacV2(key.secret, nonce, flags, randomBytes(32))), w.u8(flags), w.bytes(pub))),
      ),
    ).toBe(EdgeCloseCode.AuthFailed);
    // authentic but all-zero key share
    const zero = Buffer.alloc(32);
    expect(
      await attempt((nonce) => msg((w) => (w.u8(EdgeMsg.Auth), w.u8(2), w.string(key.id), w.bytes(edgeAuthMacV2(key.secret, nonce, flags, zero)), w.u8(flags), w.bytes(zero)))),
    ).toBe(EdgeCloseCode.Protocol);
    await waitFor(() => edge.stats().sessions === 0, 5000, 'sessions gone');
    expect(edge.stats().tunnel!.tunnels).toBe(0);
  });

  it('live room: no answer to forged/replayed/unknown datagrams, address never hijacked, NAT rebinding followed, key ratchet', async () => {
    const e = await E2E.start({
      shared: { master, nh },
      transport: { edge: edgeConfig(edge, key, { pingIntervalMs: 200, udpTuning: { rekeyAfterPackets: 16 } }) },
    });
    const raw = await rawSocket();
    try {
      const backend = e.transport.backend as EdgePeerBackend;
      expect(backend.stats().dataPlane).toBe('udp');
      const a = await e.join('a');
      const b = await e.join('b');
      e.host.setPlayerTeam(1, 1);
      e.host.setPlayerTeam(2, 2);
      e.host.startGame();
      let stop = false;
      const drive = (async () => {
        for (let i = 0; !stop; i++) {
          a.room.setKeyState(i & 1 ? 16 : 2);
          b.room.setKeyState(i & 1 ? 4 : 8);
          await sleep(25);
        }
      })();
      await sleep(800);
      const conns = (edge as Any).udp.conns as Map<number, Any>;
      expect(conns.size).toBe(1);
      const [connId, conn] = [...conns.entries()][0]!;
      const hostAddr = { ...conn.addr };
      const t0 = edge.stats().tunnel!;

      // unknown connection id: dropped without crypto, no answer
      for (let i = 0; i < 50; i++) {
        const d = randomBytes(60);
        d[0] = UdpType.Ping;
        d.writeUInt32BE((connId + 1 + i) >>> 0, 1);
        raw.sock.send(d, edge.tunnelPort!, EDGE_IP);
      }
      // forged datagrams with the right connection id: at most `maxForeignPps` AEAD attempts, no answer
      for (let i = 0; i < 200; i++) {
        const d = randomBytes(60);
        d[0] = UdpType.Ping;
        d.writeUInt32BE(connId, 1);
        raw.sock.send(d, edge.tunnelPort!, EDGE_IP);
      }
      // replays of genuine host datagrams, from another address and from the proxy's own
      const recorded = proxy.fromHost.slice(-50);
      for (const d of recorded) raw.sock.send(d, edge.tunnelPort!, EDGE_IP);
      await sleep(300);
      const t1 = edge.stats().tunnel!;
      expect(t1.unknownConn - t0.unknownConn).toBeGreaterThanOrEqual(50);
      expect(t1.rateLimited - t0.rateLimited).toBeGreaterThan(150);
      expect(t1.rejected - t0.rejected).toBeGreaterThan(0);
      expect(t1.migrations).toBe(t0.migrations);
      expect(raw.got.length).toBe(0); // the edge never sent a single byte to the attacker
      expect(conn.addr).toEqual(hostAddr);

      // NAT rebinding: the host's datagrams now come from another port; the edge follows
      proxy.rebind();
      await waitFor(() => edge.stats().tunnel!.migrations === t0.migrations + 1, 5000, 'migration');
      expect(conn.addr.port).not.toBe(hostAddr.port);
      await sleep(1500);
      stop = true;
      await drive;
      await sleep(300);
      for (const c of [a, b]) {
        expect(c.closeError).toBeNull();
        expect(c.mismatches).toEqual([]);
        expect(c.compared).toBeGreaterThan(2);
      }
      // the key ratchet ran in both directions while playing
      const us = backend.stats().udp!;
      expect(us.rekeys).toBeGreaterThan(4);
      expect(conn.plane.cipher.rekeys).toBeGreaterThan(4);
      expect(us.badMac).toBe(0);
      expect(backend.stats().rttMs).not.toBeNull();
      expect(e.errors).toEqual([]);
    } finally {
      raw.sock.close();
      await e.close();
    }
    await waitFor(() => edge.stats().tunnel!.tunnels === 0, 5000, 'tunnel released');
  }, 60_000);
});
