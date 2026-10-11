// Real-world smoke test: opens a public room on haxball.com with haxlite.
//
//   HX_TOKEN=thr1.xxxx node examples/live-room.mjs
//
// Env:
//   HX_TOKEN        headless token from https://www.haxball.com/headlesstoken (required)
//   HX_BACKEND      'rtc' (own WebRTC, needs a public IP + open UDP port) or 'ndc' (default)
//   HX_PUBLIC_IP    public IP(s) to announce with 'rtc', comma separated (default: auto-detect)
//   HX_RTC_PORT     UDP port for 'rtc' (default 40000)
//   HX_EDGE_URL / HX_EDGE_KEY   host through a haxlite Edge instead (see docs/09-haxlite-edge.md)
import { HBInit } from 'haxlite';

const token = process.env.HX_TOKEN;
if (!token) throw new Error('set HX_TOKEN (https://www.haxball.com/headlesstoken)');
const backend = process.env.HX_BACKEND === 'rtc' ? 'rtc' : 'ndc';

const haxlite = { peerBackend: backend };
if (backend === 'rtc') {
  haxlite.rtc = { port: Number(process.env.HX_RTC_PORT ?? 40000) };
  if (process.env.HX_PUBLIC_IP) haxlite.rtc.publicAddresses = process.env.HX_PUBLIC_IP.split(',');
}
if (process.env.HX_EDGE_URL) haxlite.edge = { url: process.env.HX_EDGE_URL, key: process.env.HX_EDGE_KEY };

const room = await HBInit({ roomName: 'haxlite test', maxPlayers: 12, public: true, token, noPlayer: true, haxlite });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

room.onRoomLink = (link) => log('room link:', link);
room.onPlayerJoin = (p) => {
  const c = room.haxlite.getPlayerConnection?.(p.id);
  log(`join #${p.id} ${p.name} auth=${p.auth} conn=${p.conn}`, c?.remoteAddress ? `via ${c.remoteAddress}` : '');
  if (room.getPlayerList().filter((x) => x.admin).length === 0) room.setPlayerAdmin(p.id, true);
};
room.onPlayerLeave = (p) => log(`leave #${p.id} ${p.name}`);
room.onPlayerChat = (p, msg) => {
  if (msg === '!start') room.startGame();
  if (msg === '!stop') room.stopGame();
};
setInterval(() => {
  const s = backend === 'rtc' ? room.haxlite.rtcStats?.() : null;
  log(`players=${room.getPlayerList().length}`, s ? `rtc=${JSON.stringify(s)}` : '');
}, 30000).unref();

process.on('SIGINT', async () => {
  log('stopping…');
  await room.haxlite.stop();
  process.exit(0);
});
log(`room starting (backend=${backend})…`);
