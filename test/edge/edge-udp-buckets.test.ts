/**
 * haxlite Edge tunnel v2: the per-connection buckets of src/edge/tunnel-udp.ts.
 * Datagrams from the tunnel's authenticated address draw from the `own`
 * bucket (2 s of `maxPps`), any other source from the small `foreign` one;
 * over either the datagram is dropped before any crypto and the tunnel stays.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveTunnelSecrets } from '../../src/net/edge-udp.js';
import { EdgeUdpServer } from '../../src/edge/tunnel-udp.js';

describe('tunnel v2 per-connection buckets', () => {
  it('own address: maxPps bucket; other sources: maxForeignPps bucket; the tunnel survives both', async () => {
    const udp = await EdgeUdpServer.listen('127.0.0.2', 0, { maxPps: 8, maxForeignPps: 1 }, false);
    try {
      const closed: string[] = [];
      const conn = udp.open((id) => deriveTunnelSecrets(randomBytes(32), 'secret-0123456789', randomBytes(32), randomBytes(32), randomBytes(32), id), 1, {
        onOpen: () => {},
        onMessage: () => {},
        onClose: (r) => closed.push(r),
      });
      conn.addr = { address: '127.0.0.3', port: 40000 };
      const junk = Buffer.alloc(64, 7);
      junk.writeUInt32BE(conn.connId, 0);
      const now = performance.now();
      const c = udp.counters;
      // own bucket: max(16, 2 × maxPps) = 16 burst
      for (let i = 0; i < 20; i++) conn.onDatagram(junk, '127.0.0.3', 40000, now);
      expect(c.rejected).toBe(16);
      expect(c.rateLimited).toBe(4);
      // foreign bucket: max(4, maxForeignPps) = 4 burst, independent of the own one
      for (let i = 0; i < 20; i++) conn.onDatagram(junk, '127.0.0.9', 40000, now);
      expect(c.rejected).toBe(20);
      expect(c.rateLimited).toBe(20);
      expect(conn.closed).toBe(false);
      expect(conn.addr).toEqual({ address: '127.0.0.3', port: 40000 });
      expect(closed).toEqual([]);
    } finally {
      await udp.close();
    }
  });
});
