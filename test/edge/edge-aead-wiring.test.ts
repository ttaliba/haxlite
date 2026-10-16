// Tunnel v2 AEAD negotiation through the real control handshake (needs the
// server.ts / edge-client.ts wiring of AuthFlag.ChaCha).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { nodeHaxballFor } from '../fake-master/node-haxball.js';
import { E2E, sleep, type Any } from '../host/harness.js';
import type { EdgePeerBackend } from '../../src/net/edge-client.js';
import { edgeConfig, makeKey, startEdge } from './harness.js';

describe('tunnel v2 AEAD negotiation (real edge + room)', () => {
  let master: FakeMaster;
  let nh: Any;
  beforeAll(async () => {
    master = await FakeMaster.start();
    nh = nodeHaxballFor(master);
  });
  afterAll(async () => {
    await master?.close();
  });

  const cases = [
    { host: undefined, edge: undefined, want: 'chacha20-poly1305' }, // both auto on Node
    { host: 'aes-128-gcm', edge: undefined, want: 'aes-128-gcm' }, // host does not ask (= every older host)
    { host: 'chacha20-poly1305', edge: 'aes-128-gcm', want: 'aes-128-gcm' }, // edge does not grant (= every older edge)
    { host: 'chacha20-poly1305', edge: 'chacha20-poly1305', want: 'chacha20-poly1305' },
  ] as const;
  for (const c of cases) {
    it(`host ${c.host ?? 'auto'} / edge ${c.edge ?? 'auto'} → ${c.want}, game traffic flows`, async () => {
      const key = makeKey('aead');
      const edge = await startEdge([key], { tunnel: { ...(c.edge ? { aead: c.edge } : null) } });
      const e = await E2E.start({
        shared: { master, nh },
        transport: { edge: edgeConfig(edge, key, { ...(c.host ? { tunnelAead: c.host } : null) }) },
      });
      try {
        const backend = e.transport.backend as EdgePeerBackend;
        expect(backend.stats().dataPlane).toBe('udp');
        const conns = (edge as Any).udp.conns as Map<number, Any>;
        const conn = [...conns.values()][0]!;
        expect(conn.plane.cipher.aead).toBe(c.want);
        const a = await e.join('a');
        for (let i = 0; i < 20; i++) {
          a.room.setKeyState(i & 1 ? 16 : 2);
          await sleep(20);
        }
        await sleep(300);
        expect(a.closeError).toBeNull();
        expect(backend.stats().udp!.badMac).toBe(0);
        expect(conn.plane.cipher.badMac).toBe(0);
        expect(e.errors).toEqual([]);
      } finally {
        await e.close();
        await edge.close();
      }
    }, 30_000);
  }
});
