/**
 * Drives the REAL official HaxBall web client (`game.html` + `game-min.js` +
 * vendor scripts, unmodified, downloaded to `HAXBALL_CLIENT_DIR`) offline in
 * Chromium against a FakeMaster:
 *
 *  - `context.route` serves the client files under their real URL
 *    (`https://www.haxball.com/<static path>/game.html`), proxies
 *    `https://www.haxball.com/rs/api/*` to the FakeMaster and stubs every
 *    other host (Google Fonts, reCAPTCHA: never needed offline);
 *  - `/play` is a minimal top page embedding game.html in an iframe (the
 *    client refuses to run as the top window);
 *  - `context.routeWebSocket` bridges `wss://p2p.haxball.com/client?…` to the
 *    FakeMaster's client signaling WebSocket (close codes preserved).
 *
 * Used by `official-client.interop.ts` and `scripts/among-us-screenshots.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import type { Browser, BrowserContext, BrowserContextOptions, Frame, Page } from 'playwright-core';
import type { FakeMaster } from '../../fake-master/index.js';

/** Where the official site serves the client (`play` embeds `<STATIC>/game.html` in an iframe). */
export const STATIC = '/H4mQWPXF/__cache_static__/g/';

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

export function officialClientAvailable(dir: string): boolean {
  return dir !== '' && existsSync(path.join(dir, 'game-min.js'));
}

export interface OfficialContextOptions {
  /** Prefilled nickname (localStorage `player_name`). Default 'Officer'. */
  nickname?: string;
  /**
   * The client's "Viewport Mode" setting (localStorage `view_mode`): -1 Dynamic
   * (default), 0 Restricted 840x410, 1..8 Full 1x..2.5x zoom.
   */
  viewMode?: number;
  /** Size of the iframe holding game.html (CSS px). Default 1000×700. */
  iframe?: { width: number; height: number };
  /** Extra Playwright context options (viewport, deviceScaleFactor…). */
  context?: BrowserContextOptions;
}

/** A browser context where www.haxball.com / p2p.haxball.com are `master` + the client files in `clientDir`. */
export async function officialContext(
  browser: Browser,
  master: FakeMaster,
  clientDir: string,
  log: string[],
  o: OfficialContextOptions = {},
): Promise<BrowserContext> {
  const ctx = await browser.newContext(o.context);
  const nick = JSON.stringify(o.nickname ?? 'Officer');
  const view = o.viewMode === undefined ? '' : `localStorage.setItem('view_mode', '${o.viewMode | 0}');`;
  const frame = o.iframe ?? { width: 1000, height: 700 };
  // page-side code as strings: this file is type-checked without the DOM lib
  await ctx.addInitScript({
    content: `try { if (location.hostname === 'www.haxball.com') { localStorage.setItem('player_name', ${nick}); ${view} } } catch (e) {}`,
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
    if (url.pathname === '/play') {
      // the client refuses to start outside an iframe (`window.self != window.top`): a minimal
      // top page like haxball.com/play (ours, not the official markup) embedding game.html
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><body style="margin:0"><iframe src="${STATIC}game.html" style="width:${frame.width}px;height:${frame.height}px;border:0;display:block"></iframe></body></html>`,
      });
      return;
    }
    if (url.pathname.startsWith(STATIC)) {
      const rel = path.normalize(decodeURIComponent(url.pathname.slice(STATIC.length)));
      const file = path.join(clientDir, rel);
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

/**
 * Opens `https://www.haxball.com/play?c=<roomId>` like a shared room link and
 * confirms the "Choose nickname" dialog. Returns the game iframe.
 */
export async function openRoomLink(page: Page, roomId: string, nickname: string): Promise<Frame> {
  await page.goto(`https://www.haxball.com/play?c=${roomId}`);
  const frame = (await (await page.waitForSelector('iframe')).contentFrame())!;
  // the official client always starts with "Choose nickname" (prefilled from localStorage)
  await frame.waitForSelector('.choose-nickname-view input[data-hook=input]', { timeout: 15_000 });
  await frame.fill('.choose-nickname-view input[data-hook=input]', nickname);
  await frame.click('.choose-nickname-view button[data-hook=ok]');
  return frame;
}
