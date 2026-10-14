/**
 * "No native addon at runtime": an edge with the defaults (players on
 * haxlite-rtc, tunnel v2) and a room hosted through it (HBInit + UDP
 * tunnel), each in its own process, serve a real (libdatachannel-based)
 * node-haxball client, and neither process ever loads node-datachannel:
 * no `process.dlopen` at all, no `node-datachannel` resolution, nothing in
 * `require.cache`.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import { EdgeMsg, edgeAuthMac } from '../../src/net/edge-protocol.js';
import { FakeMaster } from '../fake-master/index.js';
import { nodeHaxballFor } from '../fake-master/node-haxball.js';
import { shutdownAll, waitFor, type Any } from '../host/harness.js';
import { makeKey } from './harness.js';

const CHILD = fileURLToPath(new URL('./fixtures/no-native-child.ts', import.meta.url));
const LOADER = fileURLToPath(new URL('../../scripts/ts-resolve.mjs', import.meta.url));

const children: ChildProcess[] = [];
afterAll(async () => {
  for (const c of children) c.kill();
  await shutdownAll();
});

interface Child {
  proc: ChildProcess;
  messages: Any[];
  /** `code/signal` once the child has exited (it never should before 'stop'). */
  exited: string | null;
}

function spawnChild(args: string[], key: string, env: Record<string, string> = {}): Child {
  // Type stripping only (src is erasable syntax, tsconfig.build.json): Node 26
  // no longer has --experimental-transform-types and exits on the bad option.
  const proc = fork(CHILD, args, {
    execArgv: ['--experimental-strip-types', '--no-warnings', '--import', LOADER],
    env: { ...process.env, NN_KEY: key, ...env },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  children.push(proc);
  const c: Child = { proc, messages: [], exited: null };
  proc.on('message', (m) => c.messages.push(m));
  proc.on('exit', (code, signal) => (c.exited = `${code}/${signal}`));
  return c;
}

/** Next IPC message matching `pred`; fails at once if the child dies first. */
async function next(c: Child, pred: (m: Any) => boolean, what: string): Promise<Any> {
  await waitFor(
    () => {
      if (c.messages.some(pred)) return true;
      if (c.exited !== null) throw new Error(`${what}: child exited (${c.exited}) before answering`);
      return false;
    },
    20_000,
    what,
    20,
  );
  return c.messages.find(pred);
}

describe('edge deployment without native addons', () => {
  it('edge (rtc players + tunnel v2) and host-via-edge never load node-datachannel', async () => {
    const key = makeKey('nonative');
    const edge = spawnChild(['edge'], key.key);
    const { url } = await next(edge, (m) => m.url !== undefined, 'edge up');
    const master = await FakeMaster.start();
    try {
      const nh = nodeHaxballFor(master);
      const host = spawnChild(['host', master.httpBase, url], key.key);
      const { roomLink } = await next(host, (m) => m.roomLink !== undefined, 'room up');
      const [, authObj] = (await nh.Utils.generateAuth()) as [string, Any];
      let open: Any = null;
      nh.Room.join(
        { id: roomLink.split('c=')[1], password: null, authObj },
        { storage: { player_name: 'native-free', avatar: null, geo: { lat: 0, lon: 0, flag: 'uy' } }, onOpen: (r: Any) => (open = r) },
      );
      await next(host, (m) => m.joined === 'native-free', 'joined');
      await waitFor(() => open !== null, 15_000, 'client open');
      open.sendChat('hello without addons');
      await next(host, (m) => m.chat === 'hello without addons', 'chat relayed');

      // both reports before either child stops: a host closing its edge session while the
      // edge's 'report' is still in flight made the edge report no session at all
      host.proc.send('report');
      edge.proc.send('report');
      const hr = await next(host, (m) => m.dlopened !== undefined, 'host report');
      const er = await next(edge, (m) => m.dlopened !== undefined, 'edge report');
      host.proc.send('stop');
      edge.proc.send('stop');
      for (const r of [er, hr]) {
        expect(r.dlopened).toEqual([]);
        expect(r.resolved).toEqual([]);
        expect(r.requireCache).toEqual([]);
      }
      expect(er.hooks).toBe(true); // the resolution trace was active
      expect(er.stats.playerBackend).toBe('rtc');
      expect(er.stats.webrtc).toBeNull();
      expect(er.stats.dataPlanes).toEqual({ udp: 1, webrtc: 0, ws: 0 });
      expect(er.stats.rtc.open).toBe(1);
      expect(hr.edgeStats.dataPlane).toBe('udp');
      expect(hr.conn.remoteAddress).toMatch(/^127\./);
      open.leave();
    } finally {
      await master.close();
    }
  }, 90_000);

  it('sanity: the same trap sees the addon when the edge runs playerBackend "ndc"', async () => {
    const key = makeKey('ndc');
    const edge = spawnChild(['edge'], key.key, { NN_PLAYER_BACKEND: 'ndc' });
    const { url } = await next(edge, (m) => m.url !== undefined, 'edge up');
    // one player negotiation (a PeerConnection is what loads the addon)
    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    const got: Buffer[] = [];
    ws.on('message', (d: Buffer) => got.push(d));
    await waitFor(() => got.length > 0, 5000, 'hello');
    const r = new Reader(got[0]!);
    r.u8();
    r.u8();
    const nonce = r.bytesCopy(32);
    const send = (f: (w: Writer) => void) => {
      const w = new Writer(256);
      f(w);
      ws.send(w.copyBytes());
    };
    send((w) => (w.u8(EdgeMsg.Auth), w.u8(1), w.string(key.id), w.bytes(edgeAuthMac(key.secret, nonce)), w.u8(0)));
    await waitFor(() => got.some((m) => m[0] === EdgeMsg.AuthOk), 5000, 'auth ok');
    send((w) => (w.u8(EdgeMsg.PeerOpen), w.u16(1), w.string('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n')));
    await waitFor(() => got.some((m) => m[0] === EdgeMsg.PeerClosed || m[0] === EdgeMsg.PeerAnswer), 5000, 'peer outcome');
    ws.close();
    edge.proc.send('report');
    const er = await next(edge, (m) => m.dlopened !== undefined, 'edge report');
    edge.proc.send('stop');
    expect(er.dlopened.some((f: string) => /datachannel/.test(f))).toBe(true);
    expect(er.resolved.length).toBeGreaterThan(0);
    expect(er.stats.playerBackend).toBe('ndc');
  }, 30_000);
});
