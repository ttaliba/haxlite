// Screenshots of examples/among-us-vision.mjs as seen by the REAL official
// HaxBall client (game-min.js, unmodified) in headless Chromium, fully offline
// (FakeMaster + test/rtc-interop/harness/official-client.ts).
//
// Runs the example in this process (its `import 'haxlite'` is mapped to the
// TypeScript sources), joins three official clients as A, B, C, places their
// discs host-side (setPlayerDiscProperties) and screenshots each player's tab.
//
//   HAXBALL_CLIENT_DIR=/path/to/client \
//   node --experimental-transform-types --no-warnings --import ./scripts/ts-resolve.mjs scripts/among-us-screenshots.ts
//
// Env:
//   OUT=docs/img/among-us        output directory
//   PREFIX=                      file name prefix
//   FILES='{"A":"01-a"}'         file names (without .png) per player instead of <PREFIX><name>
//   EXAMPLE=examples/among-us-vision.mjs
//   VIEW_MODE=-1                 the client's "Viewport Mode" (-1 Dynamic, 0 Restricted 840x410, 1..7 Full 1x..2.5x)
//   FRAME=1000x700               iframe/viewport size in CSS px (screenshots at 2x)
//   POS='{"A":[x,y],"B":[x,y],"C":[x,y]}'  disc positions (default: A Cafeteria, B Electrical, C at the task)
//   ONLY=A,B,C                   which players to screenshot
//   PROPS='{"B":{"radius":0}}'   extra setPlayerDiscProperties per player
//   SPECTATE=C                   move these players to spectators after placing
//   WAIT=1500                    ms after placing the discs
//
// The client files are HaxBall's (all rights reserved) and are NOT in this
// repository (docs/10 §4.3).
import { mkdirSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Frame, Page } from 'playwright-core';
import { FakeMaster } from '../test/fake-master/index.js';
import { chromiumAvailable, launchChromium } from '../test/rtc-interop/harness/browser.js';
import { officialClientAvailable, officialContext, openRoomLink } from '../test/rtc-interop/harness/official-client.js';
import type { RoomObject } from '../src/api/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT_DIR = process.env.HAXBALL_CLIENT_DIR ?? '';
if (!officialClientAvailable(CLIENT_DIR) || !chromiumAvailable()) {
  console.error('needs HAXBALL_CLIENT_DIR (official client files) and the Playwright Chromium build');
  process.exit(1);
}
const OUT = path.resolve(ROOT, process.env.OUT ?? 'docs/img/among-us');
const PREFIX = process.env.PREFIX ?? '';
const FILES: Record<string, string> = JSON.parse(process.env.FILES ?? '{}');
const EXAMPLE = path.resolve(ROOT, process.env.EXAMPLE ?? 'examples/among-us-vision.mjs');
const VIEW_MODE = Number(process.env.VIEW_MODE ?? -1);
const [W, H] = (process.env.FRAME ?? '1000x700').split('x').map(Number) as [number, number];
const POS: Record<string, [number, number]> = { A: [-160, 40], B: [120, 70], C: [175, -15], ...JSON.parse(process.env.POS ?? '{}') };
const ONLY = (process.env.ONLY ?? 'A,B,C').split(',');
const PROPS: Record<string, object> = JSON.parse(process.env.PROPS ?? '{}');
const SPECTATE = (process.env.SPECTATE ?? '').split(',').filter(Boolean);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// `import 'haxlite'` (the example) → a shim over src/api that keeps the room for us
const shim = `data:text/javascript,${encodeURIComponent(
  `import { HBInit as h } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/api/index.ts')).href)};` +
    'export const HBInit = async (c) => (globalThis.__amongUsRoom = await h(c));',
)}`;
const hook = `data:text/javascript,${encodeURIComponent(
  'let shim; export function initialize(d) { shim = d; }' +
    'export async function resolve(s, c, n) { return s === "haxlite" ? { url: shim, shortCircuit: true } : n(s, c); }',
)}`;
register(hook, { data: shim });

const master = await FakeMaster.start();
process.env.HAXBALL_TOKEN = 'thr1.test';
process.env.HAXLITE_OPTIONS = JSON.stringify({ masterUrl: master.httpBase, iceServers: [], transport: { iceCandidatePolicy: 'all' } });
await import(pathToFileURL(EXAMPLE).href);
const room = (globalThis as unknown as { __amongUsRoom: RoomObject }).__amongUsRoom;
for (let i = 0; room.haxlite.roomLink === null && i < 200; i++) await sleep(50);
const roomId = room.haxlite.roomLink!.split('c=')[1]!.split('&')[0]!;

const browser = await launchChromium();
const log: string[] = [];
const tabs: { name: string; page: Page; frame: Frame }[] = [];
try {
  for (const name of ['A', 'B', 'C']) {
    const ctx = await officialContext(browser, master, CLIENT_DIR, log, {
      nickname: name,
      viewMode: VIEW_MODE,
      iframe: { width: W, height: H },
      context: { viewport: { width: W, height: H }, deviceScaleFactor: 2 },
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[${name}] page error: ${e.message}`));
    const frame = await openRoomLink(page, roomId, name);
    await frame.waitForSelector('.game-view', { timeout: 20_000 });
    tabs.push({ name, page, frame });
    for (let i = 0; !room.getPlayerList().some((p) => p.name === name && p.position !== null) && i < 200; i++) await sleep(50);
  }
  // place everyone (host-side), still; the example updates fog/marker on its next tick
  const place = () => {
    for (const p of room.getPlayerList()) {
      const at = POS[p.name];
      if (at) room.setPlayerDiscProperties(p.id, { x: at[0], y: at[1], xspeed: 0, yspeed: 0, ...PROPS[p.name] });
    }
  };
  place();
  await sleep(500);
  place();
  for (const p of room.getPlayerList()) if (SPECTATE.includes(p.name)) room.setPlayerTeam(p.id, 0);
  await sleep(Number(process.env.WAIT ?? 1500)); // C: task prompt + lit marker ("Task done!" after 3 s)
  mkdirSync(OUT, { recursive: true });
  for (const t of tabs) {
    if (!ONLY.includes(t.name)) continue;
    await t.frame.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    const file = path.join(OUT, `${FILES[t.name] ?? PREFIX + t.name}.png`);
    await t.page.screenshot({ path: file });
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
  for (const p of room.getPlayerList()) console.log(`${p.name}: ${JSON.stringify(p.position)}`);
} finally {
  await browser.close();
  await room.haxlite.stop();
  await master.close();
}
process.exit(0);
