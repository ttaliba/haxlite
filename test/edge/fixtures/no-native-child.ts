/**
 * Child process for edge-no-native.test.ts (TEST ONLY). Records every native
 * addon load (`process.dlopen`) and every resolution of a `node-datachannel`
 * specifier BEFORE importing anything of haxlite, then runs:
 *
 *   edge                       an EdgeServer with the defaults (players on haxlite-rtc, tunnel v2)
 *   host <masterUrl> <edgeUrl>  a full room (HBInit) hosted through that edge (UDP tunnel)
 *
 * Talks to the parent over IPC: sends its endpoint/room link, answers 'report'.
 */
import module, { createRequire } from 'node:module';

const dlopened: string[] = [];
const origDlopen = process.dlopen;
process.dlopen = function (this: unknown, m: { exports: unknown }, filename: string, ...rest: unknown[]) {
  dlopened.push(String(filename));
  return (origDlopen as (...a: unknown[]) => unknown).call(this, m, filename, ...rest);
} as typeof process.dlopen;
const resolved: string[] = [];
const hooks = (module as unknown as { registerHooks?: (h: unknown) => void }).registerHooks;
hooks?.({
  resolve(spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) {
    if (spec.includes('node-datachannel')) resolved.push(spec);
    return next(spec, ctx);
  },
});
const require = createRequire(import.meta.url);

function report(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    dlopened,
    resolved,
    hooks: hooks !== undefined,
    requireCache: Object.keys(require.cache).filter((k) => k.includes('datachannel')),
    ...extra,
  };
}

const send = (m: unknown) => process.send!(m);
const [mode, masterUrl, edgeUrl] = process.argv.slice(2);
const key = process.env.NN_KEY!;

if (mode === 'edge') {
  const { EdgeServer } = await import('../../../src/edge/index.js');
  const i = key.indexOf(':');
  const edge = await EdgeServer.start({
    host: '127.0.0.2',
    port: 0,
    keys: [{ id: key.slice(0, i), secret: key.slice(i + 1) }],
    playerBackend: process.env.NN_PLAYER_BACKEND === 'ndc' ? 'ndc' : 'rtc',
    webrtc: { bindAddress: '127.0.0.2', iceCandidatePolicy: 'all' },
  });
  send({ url: edge.url(), tunnelPort: edge.tunnelPort, playerPort: edge.playerPort });
  process.on('message', (m) => {
    if (m !== 'report') return;
    send(report({ stats: edge.stats() }));
    void edge.close({ shutdownWebRtc: true }).then(() => process.exit(0));
  });
} else {
  const { HBInit } = await import('../../../src/api/index.js');
  const room = await HBInit({
    roomName: 'no native',
    noPlayer: true,
    token: 'thr1.nonative',
    geo: { code: 'ar', lat: 0, lon: 0 },
    haxlite: { masterUrl, edge: { url: edgeUrl!, key, bindAddress: '127.0.0.3' } },
  });
  room.onPlayerJoin = (p) => send({ joined: p.name });
  room.onPlayerChat = (_p, msg) => {
    send({ chat: msg });
    return true;
  };
  send({ roomLink: room.haxlite.roomLink });
  process.on('message', (m) => {
    if (m !== 'report') return;
    send(report({ edgeStats: room.haxlite.edgeStats(), conn: room.haxlite.getPlayerConnection(1) }));
    void room.haxlite.stop().then(() => process.exit(0));
  });
}
