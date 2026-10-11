/**
 * Real Chromium against the haxlite Edge's player side (`npm run test:interop`,
 * or `RTC_INTEROP_BACKENDS=edge`): the harness page (a line-by-line copy of
 * the official client's WebRTC usage) negotiates through the harness
 * "host", whose peer backend is an {@link EdgePeerBackend}: offer → tunnel
 * (WebSocket control) → EdgeServer (players on haxlite-rtc) → answer back,
 * and every data-channel message crosses the tunnel v2 data plane (SCTP over
 * AES-GCM UDP). The harness's own backend is replaced, nothing else.
 */
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EdgeServer } from '../../src/edge/index.js';
import { EdgePeerBackend } from '../../src/net/edge-client.js';
import { chromiumAvailable, launchChromium, openHarnessPage } from './harness/browser.js';
import { InteropServer } from './harness/server.js';
import { PageClient, until } from './suite.js';

const want = process.env.RTC_INTEROP_BACKENDS?.split(',');
const skip = want && !want.includes('edge') ? 'not selected (RTC_INTEROP_BACKENDS)' : !chromiumAvailable() ? 'Chromium build not found' : null;
const KEY = { id: 'interop', secret: 'interop-secret-0123456789' };

describe.skipIf(skip !== null)(`edge (rtc players + tunnel v2) × Chromium${skip ? ` (skipped: ${skip})` : ''}`, () => {
  let browser: Browser;
  let srv: InteropServer;
  let edge: EdgeServer;
  let backend: EdgePeerBackend;
  let pc: PageClient;

  beforeAll(async () => {
    edge = await EdgeServer.start({
      host: '127.0.0.1',
      port: 0,
      keys: [KEY],
      webrtc: { bindAddress: '127.0.0.1', iceCandidatePolicy: 'all' },
      // the scenarios burst 300 messages per channel: lift the official flood bucket
      limits: { floodCapacity: 1_000_000, floodMsPerToken: 1 },
    });
    backend = new EdgePeerBackend({ url: edge.url(), key: `${KEY.id}:${KEY.secret}`, bindAddress: '127.0.0.3', fallbackWs: false });
    let ready = false;
    backend.start({ onReady: () => (ready = true), onDown: () => {}, onError: (e) => console.error(e) });
    expect(await until(() => ready, 10_000)).toBe(true);
    srv = await InteropServer.start({ backend: 'rtc', address: '127.0.0.1' });
    const own = srv.handle;
    await own.close(); // the harness's own RtcEndpoint is not used
    srv.handle = { kind: 'rtc', backend, close: async () => backend.stop(), stats: () => ({ edge: edge.stats(), tunnel: backend.stats() }) };
    browser = await launchChromium();
    pc = new PageClient(await openHarnessPage(browser, srv.url));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await srv?.close();
    await edge?.close();
  }, 60_000);

  it('connects through the edge and exchanges ro/ru/uu both ways', async () => {
    const [j] = await pc.connect(1);
    expect(j, `join failed: ${(await pc.errors()).join('; ')} / server: ${srv.errors.join('; ')}`).toBeTruthy();
    const p = await srv.peer(j!.tag);
    await p.whenOpen(10_000, true);
    const st0 = await pc.stats(j!.index);
    expect(st0.state.channels).toEqual(['open', 'open', 'open']);
    expect(st0.state.conn).toBe('connected');
    expect(p.remoteAddress).toBe('127.0.0.1'); // reported by the edge (haxlite-rtc nominated pair)
    expect(backend.stats().dataPlane).toBe('udp');
    const N = 300;
    for (const ch of [0, 1, 2]) {
      expect(p.burst(ch, N, 64)).toBe(N);
      expect(await pc.burst(j!.index, ch, N, 64)).toBe(N);
    }
    const ok = await until(async () => {
      const st = await pc.stats(j!.index);
      return [0, 1].every((ch) => st.rx.ch[ch]!.data >= N && p.rec.ch[ch]!.data >= N);
    }, 15_000);
    await new Promise((r) => setTimeout(r, 300));
    const st = await pc.stats(j!.index);
    expect(ok, `page ${JSON.stringify(st.rx.ch)} server ${JSON.stringify(p.rec.ch)}`).toBe(true);
    for (const [s, where] of [
      [st.rx.ch, 'browser←edge'],
      [p.rec.ch, 'host←edge'],
    ] as const) {
      expect(s[0]!.data, where).toBe(N);
      expect(s[0]!.reordered, where).toBe(0);
      expect(s[1]!.data, where).toBe(N);
      for (const c of s) {
        expect(c.corrupt, where).toBe(0);
        expect(c.dups, where).toBe(0);
      }
      expect(s[2]!.data, where).toBeGreaterThanOrEqual(N * 0.9);
    }
    expect(edge.stats().rtc!.open).toBe(1);
    await pc.close(j!.index);
    await p.whenClosed(15_000);
  }, 60_000);

  it('10 browsers at once, then the edge side closes them', async () => {
    const js = await pc.connect(10);
    expect(js.every((j) => j !== null), (await pc.errors()).join('; ')).toBe(true);
    const peers = await Promise.all(js.map((j) => srv.peer(j!.tag)));
    await Promise.all(peers.map((p) => p.whenOpen(15_000, true)));
    expect(edge.stats().peers).toBe(10);
    for (const p of peers) p.close(); // host → PeerClose → edge closes the player connection
    expect(await until(async () => (await Promise.all(js.map((j) => pc.stats(j!.index)))).every((s) => s.state.closeReason !== null), 15_000)).toBe(true);
    expect(await until(() => edge.stats().peers === 0, 5000)).toBe(true);
  }, 60_000);
});
