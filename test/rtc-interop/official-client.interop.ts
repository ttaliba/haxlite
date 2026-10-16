/**
 * The REAL official HaxBall web client (`game.html` + `game-min.js` +
 * vendor scripts, unmodified) in headless Chromium, joining a room hosted by
 * haxlite (HBInit) with each peer backend, fully offline:
 *
 *  - Playwright `context.route` serves the client files from
 *    `HAXBALL_CLIENT_DIR` under their real URL
 *    (`https://www.haxball.com/<static path>/game.html?c=<room id>`; the page
 *    is the top window, so it reads `?c=` itself), proxies
 *    `https://www.haxball.com/rs/api/*` to the FakeMaster and stubs every
 *    other host (Google Fonts, reCAPTCHA: never needed offline);
 *  - `context.routeWebSocket` bridges `wss://p2p.haxball.com/client?…` to the
 *    FakeMaster's client signaling WebSocket (close codes preserved);
 *  - WebRTC is real: Chromium ⇄ haxlite (node-datachannel or haxlite-rtc) on
 *    127.0.0.1.
 *
 * Asserts: the client reaches the game (host `onPlayerJoin`, the client's
 * game view lists the player), its keyboard input reaches the host and moves
 * its disc, chat flows both ways, CheckConsistency never reports a desync,
 * and a kick shows the official "You were kicked" dialog with our reason.
 *
 * The client files are HaxBall's (all rights reserved) and are NOT in this
 * repository. To run: download them once (docs/10 §4.3) and
 *
 *   HAXBALL_CLIENT_DIR=/path/to/client npm run test:interop -- official-client
 *
 * Without `HAXBALL_CLIENT_DIR` (or without Chromium) the suite is skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { FakeMaster } from '../fake-master/index.js';
import { HBInit, type PlayerObject, type RoomObject } from '../../src/api/index.js';
import { EventType } from '../../src/protocol.js';
import { shutdownWebRtc } from '../../src/net/index.js';
import { chromiumAvailable, launchChromium } from './harness/browser.js';
import { officialClientAvailable, officialContext, openRoomLink } from './harness/official-client.js';

const CLIENT_DIR = process.env.HAXBALL_CLIENT_DIR ?? '';
const AVAILABLE = officialClientAvailable(CLIENT_DIR) && chromiumAvailable();
const BATCH_FRAMES = ((n) => (n === 1 || n === 2 ? n : 0))(Number(process.env.HAXLITE_TEST_RTC_BATCH_FRAMES ?? 0));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = f();
    if (v !== null && v !== undefined && v !== false) return v;
    if (performance.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
}

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

describe.skipIf(!AVAILABLE)('official HaxBall web client (game-min.js) in Chromium → haxlite host', () => {
  for (const backend of ['ndc', 'rtc'] as const) {
    it(`joins, gets the game, sends input, chats both ways, no desync, kick dialog (peerBackend ${backend})`, async () => {
      const log: string[] = [];
      const room: RoomObject = await HBInit({
        roomName: `official ${backend}`,
        noPlayer: true,
        maxPlayers: 4,
        token: 'thr1.test',
        haxlite: {
          masterUrl: master.httpBase,
          iceServers: [],
          shutdownWebRtcOnLastStop: false,
          checksumIntervalFrames: 60, // CheckConsistency every second (official: 10 s)
          peerBackend: backend,
          // HAXLITE_TEST_RTC_BATCH_FRAMES=1|2: with frame batching (sendBatchFrames)
          rtc: { address: '127.0.0.1', publicAddresses: ['127.0.0.1'], ...(BATCH_FRAMES > 0 ? { sendBatchFrames: BATCH_FRAMES } : null) },
          transport: { iceCandidatePolicy: 'all' },
        },
      });
      const ctx = await officialContext(browser, master, CLIENT_DIR, log);
      let page: Page | null = null;
      try {
        const joins: PlayerObject[] = [];
        const chats: string[] = [];
        let inputs = 0;
        const desyncs: boolean[] = [];
        room.onPlayerJoin = (p) => joins.push(p);
        room.onPlayerChat = (p, msg) => {
          chats.push(`${p.name}: ${msg}`);
        };
        room.onPlayerInput = () => inputs++;
        let checks = 0;
        const seq = room.haxlite.host.sequencer;
        const checksum = seq.checksum.bind(seq);
        seq.checksum = () => {
          checks++;
          checksum();
        };
        room.haxlite.host.onEventApplied = (ev) => {
          if (ev.type === EventType.SetPlayerSync) desyncs.push((ev as unknown as { desync: boolean }).desync);
        };
        const roomId = room.haxlite.roomLink!.split('c=')[1]!.split('&')[0]!;

        page = await ctx.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        page.on('console', (m) => log.push(`console.${m.type()} ${m.text()}`));
        const t0 = performance.now();
        // like a shared room link: https://www.haxball.com/play?c=<id> (the game reads window.top's ?c=)
        const frame = await openRoomLink(page, roomId, 'Officer');
        let player: PlayerObject;
        try {
          player = await until(() => joins[0], 30_000, 'official client join');
        } catch (err) {
          const body = await frame.evaluate('document.body.innerText').catch(() => '?');
          throw new Error(`${(err as Error).message}; page: ${String(body).slice(0, 300)}; errors: ${pageErrors.join(' / ')}; log: ${log.join(' | ')}`);
        }
        const joinMs = performance.now() - t0;
        expect(player.name).toBe('Officer');
        // rtc announces only 127.0.0.1; ndc (iceCandidatePolicy 'all') also offers the LAN address
        const remote = room.haxlite.getPlayerConnection(player.id)?.remoteAddress ?? null;
        if (backend === 'rtc') expect(remote).toBe('127.0.0.1');
        else expect(remote).not.toBeNull();

        // the client is in the room: game view with the player list
        await frame.waitForSelector('.game-view', { timeout: 15_000 });
        await frame.waitForFunction(
          "[...document.querySelectorAll('.player-list-item [data-hook=name]')].some((e) => e.textContent === 'Officer')",
          undefined,
          { timeout: 15_000 },
        );

        // input: move to red, start, hold → for a while; the host must see inputs and the disc move
        room.setPlayerTeam(player.id, 1);
        room.startGame();
        await until(() => room.getPlayerDiscProperties(player.id), 5000, 'player disc');
        await sleep(300);
        const x0 = room.getPlayerDiscProperties(player.id)!.x;
        await frame.focus('.game-view');
        await page.keyboard.down('ArrowRight');
        await sleep(600);
        await page.keyboard.up('ArrowRight');
        await until(() => inputs >= 2, 5000, 'input events at the host');
        const x1 = room.getPlayerDiscProperties(player.id)!.x;
        expect(x1).toBeGreaterThan(x0 + 20);

        // chat host → client (announcement) and client → host
        room.sendAnnouncement('hello official client', null, 0x00ff00);
        await frame.waitForFunction(
          "(document.querySelector('.chatbox-view .log-contents')?.textContent ?? '').includes('hello official client')",
          undefined,
          { timeout: 10_000 },
        );
        await frame.fill('.chatbox-view input[data-hook=input]', 'hi from the official client');
        await frame.press('.chatbox-view input[data-hook=input]', 'Enter');
        await until(() => chats.includes('Officer: hi from the official client'), 10_000, 'client chat at the host');

        // a few seconds of play with CheckConsistency (every 600 frames = 10 s by default): use the knob
        await frame.focus('.game-view');
        for (let i = 0; i < 6; i++) {
          await page.keyboard.down(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
          await sleep(150);
          await page.keyboard.up(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
          await page.keyboard.press('x');
        }
        await sleep(1500);
        // CheckConsistency was sent several times while playing and the client never reported a desync
        expect(checks).toBeGreaterThanOrEqual(3);
        expect(desyncs.filter(Boolean)).toEqual([]);

        // kick: the official dialog with our reason
        room.kickPlayer(player.id, 'bye from haxlite', false);
        await frame.waitForSelector('.disconnected-view', { timeout: 10_000 });
        const reason = await frame.textContent('.disconnected-view [data-hook=reason]');
        expect(reason).toContain('You were kicked');
        expect(reason).toContain('bye from haxlite');
        expect(pageErrors).toEqual([]);
        // diagnostics for docs/10
        console.log(`[official-client ${backend}] page load → joined in ${joinMs.toFixed(0)} ms; inputs ${inputs}; CheckConsistency ${checks}; desync reports ${desyncs.filter(Boolean).length}`);
      } finally {
        await page?.close().catch(() => {});
        await ctx.close().catch(() => {});
        await room.haxlite.stop();
      }
    }, 120_000);
  }
});
