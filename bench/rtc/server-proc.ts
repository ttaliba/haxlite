// WebRTC server process under test for bench/rtc/run.ts (forked; IPC).
//
//   node --experimental-transform-types --import ./bench/ts-resolve.mjs bench/rtc/server-proc.ts <ndc|rtc> <address>
//
// Runs the interop harness server in `bench` app mode: HaxBall-like host
// traffic (pong on uu, input → event broadcast to everyone on ru, 50 ms
// tick with a heartbeat on uu every ≥ 7 frames; docs/04 §4.3).
//
// IPC out: {type:'ready', url} | {type:'mem', …process.memoryUsage(), peers, backend} | {type:'error', message}
// IPC in : {cmd:'mem'} | {cmd:'gc'}
import { InteropServer } from '../../test/rtc-interop/harness/server.js';
import type { BackendKind } from '../../test/rtc-interop/harness/backends.js';

const [kind, address] = process.argv.slice(2) as [BackendKind, string];
const send = (m: unknown) => process.send?.(m);
process.on('uncaughtException', (e) => send({ type: 'error', message: String((e as Error)?.stack ?? e) }));
process.on('unhandledRejection', (e) => send({ type: 'error', message: String((e as Error)?.stack ?? e) }));
process.on('disconnect', () => process.exit(0));

const srv = await InteropServer.start({ backend: kind, address: address ?? '127.0.0.1', app: 'bench' });
process.on('message', (m: { cmd: string }) => {
  if (m.cmd === 'mem') {
    send({ type: 'mem', ...process.memoryUsage(), peers: srv.openPeers().length, errors: srv.errors.length, backend: srv.handle.stats() });
  } else if (m.cmd === 'gc') {
    (globalThis as { gc?: () => void }).gc?.();
    send({ type: 'gc' });
  }
});
send({ type: 'ready', url: srv.url, pid: process.pid });
