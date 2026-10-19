// Screenshots of a room using hidden players (scripts/hidden-bigmap-room.mjs by
// default) as seen by the REAL official HaxBall client (game-min.js,
// unmodified) in headless Chromium, fully offline (FakeMaster +
// test/rtc-interop/harness/official-client.ts).
//
// Runs the room script in this process (its `import 'haxlite'` is mapped to the
// TypeScript sources), joins official clients (A, B, C by default), places their
// discs host-side (setPlayerDiscProperties) and screenshots each player's tab.
//
//   HAXBALL_CLIENT_DIR=/path/to/client \
//   node --experimental-transform-types --no-warnings --import ./scripts/ts-resolve.mjs scripts/hidden-players-screenshots.ts
//
// Env:
//   OUT=docs/img/hidden-players  output directory
//   PREFIX=                      file name prefix
//   FILES='{"A":"01-a"}'         file names (without .png) per player instead of <PREFIX><name>
//   EXAMPLE=scripts/hidden-bigmap-room.mjs  room script to run
//   VIEW_MODE=-1                 the client's "Viewport Mode" (-1 Dynamic, 0 Restricted 840x410, 1..7 Full 1x..2.5x)
//   FRAME=1000x700               iframe/viewport size in CSS px (screenshots at 2x)
//   POS='{"A":[x,y],"B":[x,y],"C":[x,y]}'  disc positions (default: A [-160,40], B [120,70], C [175,-15])
//   ONLY=A,B,C                   which players to screenshot
//   PROPS='{"B":{"radius":0}}'   extra setPlayerDiscProperties per player
//   SPECTATE=C                   move these players to spectators after placing
//   WAIT=1500                    ms after placing the discs
//   NAMES=A,B,C                  players (one official client each)
//   KEYS='{"B":"ArrowRight,KeyX"}'  keys held in a tab during WAIT (SETTLE=ms after release)
//   CHECKSUM=600                 CheckConsistency interval (frames); the script reports SetPlayerSync events
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
import { EventType } from '../src/protocol.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT_DIR = process.env.HAXBALL_CLIENT_DIR ?? '';
if (!officialClientAvailable(CLIENT_DIR) || !chromiumAvailable()) {
  console.error('needs HAXBALL_CLIENT_DIR (official client files) and the Playwright Chromium build');
  process.exit(1);
}
const OUT = path.resolve(ROOT, process.env.OUT ?? 'docs/img/hidden-players');
const PREFIX = process.env.PREFIX ?? '';
const FILES: Record<string, string> = JSON.parse(process.env.FILES ?? '{}');
const EXAMPLE = path.resolve(ROOT, process.env.EXAMPLE ?? 'scripts/hidden-bigmap-room.mjs');
const VIEW_MODE = Number(process.env.VIEW_MODE ?? -1);
const [W, H] = (process.env.FRAME ?? '1000x700').split('x').map(Number) as [number, number];
const POS: Record<string, [number, number]> = { A: [-160, 40], B: [120, 70], C: [175, -15], ...JSON.parse(process.env.POS ?? '{}') };
const ONLY = (process.env.ONLY ?? 'A,B,C').split(',');
const PROPS: Record<string, object> = JSON.parse(process.env.PROPS ?? '{}');
const SPECTATE = (process.env.SPECTATE ?? '').split(',').filter(Boolean);
const NAMES = (process.env.NAMES ?? 'A,B,C').split(',');
/** Keys held in a player's tab while waiting (e.g. the hidden player moving and kicking). */
const KEYS: Record<string, string[]> = Object.fromEntries(
  Object.entries(JSON.parse(process.env.KEYS ?? '{}') as Record<string, string>).map(([k, v]) => [k, v.split(',')]),
);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// `import 'haxlite'` (the room script) → a shim over src/api that keeps the room for us
const shim = `data:text/javascript,${encodeURIComponent(
  `import { HBInit as h } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/api/index.ts')).href)};` +
    'export const HBInit = async (c) => (globalThis.__hiddenPlayersRoom = await h(c));',
)}`;
const hook = `data:text/javascript,${encodeURIComponent(
  'let shim; export function initialize(d) { shim = d; }' +
    'export async function resolve(s, c, n) { return s === "haxlite" ? { url: shim, shortCircuit: true } : n(s, c); }',
)}`;
register(hook, { data: shim });

const master = await FakeMaster.start();
process.env.HAXBALL_TOKEN = 'thr1.test';
process.env.HAXLITE_OPTIONS = JSON.stringify({
  masterUrl: master.httpBase,
  iceServers: [],
  transport: { iceCandidatePolicy: 'all' },
  checksumIntervalFrames: Number(process.env.CHECKSUM ?? 600),
});
await import(pathToFileURL(EXAMPLE).href);
const room = (globalThis as unknown as { __hiddenPlayersRoom: RoomObject }).__hiddenPlayersRoom;
// desync evidence: SetPlayerSync events (a client whose checksum differed) and CheckConsistency rounds
let syncEvents = 0;
let checks = 0;
room.haxlite.host.onEventApplied = (ev) => {
  if (ev.type === EventType.SetPlayerSync) syncEvents++;
};
const seq = room.haxlite.host.sequencer;
const checksum = seq.checksum.bind(seq);
seq.checksum = () => {
  if (seq.views.length > 0) checks++;
  checksum();
};
for (let i = 0; room.haxlite.roomLink === null && i < 200; i++) await sleep(50);
const roomId = room.haxlite.roomLink!.split('c=')[1]!.split('&')[0]!;

const browser = await launchChromium();
const log: string[] = [];
const tabs: { name: string; page: Page; frame: Frame }[] = [];
try {
  for (const name of NAMES) {
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
  // place everyone (host-side), still; the room script reacts on its next tick
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
  const held: [Page, string][] = [];
  for (const t of tabs) {
    for (const k of KEYS[t.name] ?? []) {
      await t.frame.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
      await t.page.keyboard.down(k);
      held.push([t.page, k]);
    }
  }
  await sleep(Number(process.env.WAIT ?? 1500));
  for (const [page, k] of held) await page.keyboard.up(k);
  if (held.length > 0) await sleep(Number(process.env.SETTLE ?? 0));
  mkdirSync(OUT, { recursive: true });
  for (const t of tabs) {
    if (!ONLY.includes(t.name)) continue;
    await t.frame.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    const file = path.join(OUT, `${FILES[t.name] ?? PREFIX + t.name}.png`);
    await t.page.screenshot({ path: file });
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
  for (const p of room.getPlayerList()) {
    const hidden = room.haxlite.getHiddenPlayersFor(p.id).map((id) => room.getPlayer(id)?.name);
    console.log(`${p.name}: ${JSON.stringify(p.position)} hides [${hidden.join(',')}]`);
  }
  const desync = room.haxlite.host.state.players.filter((p) => p.desync).map((p) => p.name);
  let notices = 0;
  for (const t of tabs) notices += ((await t.frame.content()).match(/desynchronized/g) ?? []).length;
  console.log(`checksum rounds with private views: ${checks}, SetPlayerSync events: ${syncEvents}, desync flags: [${desync.join(',')}], "desynchronized" notices: ${notices}`);
} finally {
  await browser.close();
  await room.haxlite.stop();
  await master.close();
}
process.exit(0);
