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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { FakeMaster } from '../fake-master/index.js';
import { HBInit, type PlayerObject, type RoomObject } from '../../src/api/index.js';
import { EventType } from '../../src/protocol.js';
import { shutdownWebRtc } from '../../src/net/index.js';
import { chromiumAvailable, launchChromium } from './harness/browser.js';

const CLIENT_DIR = process.env.HAXBALL_CLIENT_DIR ?? '';
const AVAILABLE = CLIENT_DIR !== '' && existsSync(path.join(CLIENT_DIR, 'game-min.js')) && chromiumAvailable();
/** Where the official site serves the client (`play` embeds `<STATIC>/game.html` in an iframe). */
const STATIC = '/H4mQWPXF/__cache_static__/g/';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};

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

/** A browser context where www.haxball.com / p2p.haxball.com are this test's FakeMaster + client files. */
async function officialContext(browser: Browser, master: FakeMaster, log: string[]): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try {
      if (location.hostname === 'www.haxball.com') localStorage.setItem('player_name', 'Officer');
    } catch {
      /* no storage */
    }
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== 'www.haxball.com') {
      log.push(`stub ${url.hostname}${url.pathname}`);
      await route.fulfill({ status: url.hostname === 'fonts.googleapis.com' ? 200 : 404, contentType: 'text/css', body: '' });
      return;
    }
    if (url.pathname.startsWith('/rs/')) {
      const r = await fetch(master.httpBase + url.pathname.slice(4) + url.search, {
        method: req.method(),
        headers: { 'content-type': req.headers()['content-type'] ?? 'application/x-www-form-urlencoded' },
        ...(req.method() === 'POST' ? { body: req.postData() ?? '' } : null),
      });
      log.push(`master ${req.method()} ${url.pathname} ${r.status}`);
      await route.fulfill({
        status: r.status,
        headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'access-control-allow-origin': '*' },
        body: Buffer.from(await r.arrayBuffer()),
      });
      return;
    }
    if (url.pathname.startsWith(STATIC)) {
      const rel = path.normalize(decodeURIComponent(url.pathname.slice(STATIC.length)));
      const file = path.join(CLIENT_DIR, rel);
      if (!rel.startsWith('..') && existsSync(file)) {
        await route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
        return;
      }
    }
    log.push(`404 ${url.pathname}`);
    await route.fulfill({ status: 404, body: '' });
  });
  await ctx.routeWebSocket(/^wss:\/\/p2p\.haxball\.com\//, (ws) => {
    const u = new URL(ws.url());
    log.push(`ws ${u.pathname}`);
    const up = new NodeWebSocket(master.wsBase + u.pathname.slice(1) + u.search, { headers: { origin: 'https://www.haxball.com' } });
    up.binaryType = 'nodebuffer';
    const queue: (string | Buffer)[] = [];
    ws.onMessage((m) => {
      if (up.readyState === NodeWebSocket.OPEN) up.send(m);
      else queue.push(m);
    });
    up.on('open', () => {
      for (const m of queue.splice(0)) up.send(m);
    });
    up.on('message', (data: Buffer, isBinary: boolean) => ws.send(isBinary ? data : data.toString('utf8')));
    up.on('close', (code) => {
      log.push(`ws closed by master ${code}`);
      void ws.close({ code: code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000 }).catch(() => {});
    });
    up.on('error', () => {});
    ws.onClose((code) => {
      try {
        up.close(code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000);
      } catch {
        /* gone */
      }
    });
  });
  return ctx;
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
          peerBackend: backend,
          rtc: { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] },
          transport: { iceCandidatePolicy: 'all' },
        },
      });
      const ctx = await officialContext(browser, master, log);
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
        room.haxlite.host.onEventApplied = (ev) => {
          if (ev.type === EventType.SetPlayerSync) desyncs.push((ev as unknown as { desync: boolean }).desync);
        };
        const roomId = room.haxlite.roomLink!.split('c=')[1]!.split('&')[0]!;

        page = await ctx.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        const t0 = performance.now();
        await page.goto(`https://www.haxball.com${STATIC}game.html?c=${roomId}`);
        const player = await until(() => joins[0], 30_000, `official client join (log: ${log.join(' | ')})`);
        const joinMs = performance.now() - t0;
        expect(player.name).toBe('Officer');
        expect(room.haxlite.getPlayerConnection(player.id)?.remoteAddress).toBe('127.0.0.1');

        // the client is in the room: game view with the player list
        await page.waitForSelector('.game-view', { timeout: 15_000 });
        await page.waitForFunction(
          () => [...document.querySelectorAll('.player-list-item [data-hook=name]')].some((e) => e.textContent === 'Officer'),
          undefined,
          { timeout: 15_000 },
        );

        // input: move to red, start, hold → for a while; the host must see inputs and the disc move
        room.setPlayerTeam(player.id, 1);
        room.startGame();
        await until(() => room.getPlayerDiscProperties(player.id), 5000, 'player disc');
        await sleep(300);
        const x0 = room.getPlayerDiscProperties(player.id)!.x;
        await page.focus('.game-view');
        await page.keyboard.down('ArrowRight');
        await sleep(600);
        await page.keyboard.up('ArrowRight');
        await until(() => inputs >= 2, 5000, 'input events at the host');
        const x1 = room.getPlayerDiscProperties(player.id)!.x;
        expect(x1).toBeGreaterThan(x0 + 20);

        // chat host → client (announcement) and client → host
        room.sendAnnouncement('hello official client', null, 0x00ff00);
        await page.waitForFunction(
          () => (document.querySelector('.chatbox-view .log-contents')?.textContent ?? '').includes('hello official client'),
          undefined,
          { timeout: 10_000 },
        );
        await page.fill('.chatbox-view input[data-hook=input]', 'hi from the official client');
        await page.press('.chatbox-view input[data-hook=input]', 'Enter');
        await until(() => chats.includes('Officer: hi from the official client'), 10_000, 'client chat at the host');

        // a few seconds of play with CheckConsistency (every 600 frames = 10 s by default): use the knob
        await page.focus('.game-view');
        for (let i = 0; i < 6; i++) {
          await page.keyboard.down(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
          await sleep(150);
          await page.keyboard.up(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
          await page.keyboard.press('x');
        }
        expect(desyncs.filter(Boolean)).toEqual([]);

        // kick: the official dialog with our reason
        room.kickPlayer(player.id, 'bye from haxlite', false);
        await page.waitForSelector('.disconnected-view', { timeout: 10_000 });
        const reason = await page.textContent('.disconnected-view [data-hook=reason]');
        expect(reason).toContain('You were kicked');
        expect(reason).toContain('bye from haxlite');
        expect(pageErrors).toEqual([]);
        // diagnostics for docs/10
        console.log(`[official-client ${backend}] page load → joined in ${joinMs.toFixed(0)} ms; inputs ${inputs}; checks ${desyncs.length}`);
      } finally {
        await page?.close().catch(() => {});
        await ctx.close().catch(() => {});
        await room.haxlite.stop();
      }
    }, 120_000);
  }
});
