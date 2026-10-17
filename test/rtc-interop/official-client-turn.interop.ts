/**
 * The official HaxBall web client (see official-client.interop.ts) joining a
 * haxlite room configured like a production room behind Cloudflare TURN:
 * `peerBackend: 'rtc'`, relay only, ICE servers from a Cloudflare
 * `generate-ice-servers` response (JSON file in `HAXLITE_TURN_ICE`).
 * Needs the network (Cloudflare) besides `HAXBALL_CLIENT_DIR` and Chromium.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { FakeMaster } from '../fake-master/index.js';
import { HBInit, type PlayerObject, type RoomObject } from '../../src/api/index.js';
import { shutdownWebRtc } from '../../src/net/index.js';
import { chromiumAvailable, launchChromium } from './harness/browser.js';
import { officialClientAvailable, officialContext, openRoomLink } from './harness/official-client.js';

const CLIENT_DIR = process.env.HAXBALL_CLIENT_DIR ?? '';
const ICE_FILE = process.env.HAXLITE_TURN_ICE ?? '';
const AVAILABLE = officialClientAvailable(CLIENT_DIR) && chromiumAvailable() && ICE_FILE !== '';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let master: FakeMaster;
let browser: Browser;

beforeAll(async () => {
  if (!AVAILABLE) return;
  master = await FakeMaster.start();
  browser = await launchChromium();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await master?.close();
  await shutdownWebRtc();
});

describe.skipIf(!AVAILABLE)('official HaxBall web client → haxlite host, relay only through TURN', () => {
  for (const which of ['first', 'second'] as const) it('joins through the relay (' + which + ' of two rooms in one process)', async () => {
    const iceServers = JSON.parse(readFileSync(ICE_FILE, 'utf8'));
    const log: string[] = [];
    const mk = (name: string) => HBInit({ roomName: name,
      noPlayer: true,
      maxPlayers: 4,
      token: 'thr1.test',
      haxlite: {
        masterUrl: master.httpBase,
        iceServers,
        shutdownWebRtcOnLastStop: false,
        peerBackend: 'rtc',
        rtc: { iceTransportPolicy: 'relay' },
      },
    });
    const rooms: RoomObject[] = [await mk('turn A'), await mk('turn B')];
    const room = which === 'first' ? rooms[0]! : rooms[1]!;
    const ctx = await officialContext(browser, master, CLIENT_DIR, log);
    const page = await ctx.newPage();
    page.on('console', (m) => log.push(`console.${m.type()} ${m.text()}`));
    try {
      const joins: PlayerObject[] = [];
      room.onPlayerJoin = (p) => joins.push(p);
      const roomId = room.haxlite.roomLink!.split('c=')[1]!.split('&')[0]!;
      const frame = await openRoomLink(page, roomId, 'Officer');
      const t0 = performance.now();
      while (joins.length === 0 && performance.now() - t0 < 30_000) await sleep(100);
      const backend = room.haxlite.transport.backend as unknown as { stats(): unknown };
      console.log('[turn] endpoint stats', JSON.stringify(backend.stats(), null, 1));
      if (joins.length === 0) {
        const body = await frame.evaluate('document.body.innerText').catch(() => '?');
        console.log('[turn] page:', String(body).slice(0, 400), '\nlog:', log.join('\n'));
      }
      expect(joins.length).toBe(1);
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
      for (const r of rooms) await r.haxlite.stop();
    }
  }, 120_000);
});
