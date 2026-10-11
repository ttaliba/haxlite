/**
 * haxlite Edge: every player backend × tunnel data plane combination still
 * works (the old node-datachannel paths stay behind their switches), and
 * data-plane negotiation degrades cleanly: an edge with tunnel v2 disabled
 * or refusing the legacy WebRTC tunnel puts the session on the WebSocket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { nodeHaxballFor } from '../fake-master/node-haxball.js';
import { E2E, shutdownAll, sleep, waitFor, type Any } from '../host/harness.js';
import type { EdgeServer, EdgeServerOptions } from '../../src/edge/index.js';
import type { EdgeDataPlane, EdgePeerBackend } from '../../src/net/edge-client.js';
import { EDGE_IP, edgeConfig, makeKey, selectedRemote, startEdge } from './harness.js';

let master: FakeMaster;
let nh: Any;
const clientPcs: Any[] = [];

beforeAll(async () => {
  master = await FakeMaster.start();
  nh = nodeHaxballFor(master, { onPeerConnection: (pc) => clientPcs.push(pc) });
});

afterAll(async () => {
  await master?.close();
  await shutdownAll();
});

async function play(edgeOpts: Partial<EdgeServerOptions>, requested: EdgeDataPlane, expected: EdgeDataPlane): Promise<EdgeServer> {
  const key = makeKey('legacy');
  const edge = await startEdge([key], edgeOpts);
  const e = await E2E.start({ shared: { master, nh }, transport: { edge: edgeConfig(edge, key, { dataPlane: requested }) } });
  try {
    expect((e.transport.backend as EdgePeerBackend).stats().dataPlane).toBe(expected);
    clientPcs.length = 0;
    const chats: string[] = [];
    e.host.state.hooks.onPlayerChatFilter = (p, m) => {
      chats.push(`${p.name}:${m}`);
      return true;
    };
    const a = await e.join('a');
    const b = await e.join('b');
    e.host.setPlayerTeam(1, 1);
    e.host.setPlayerTeam(2, 2);
    e.host.startGame();
    const f0 = e.host.frame;
    for (let i = 0; i < 20; i++) {
      a.room.setKeyState(i & 1 ? 16 : 2);
      b.room.setKeyState(i & 1 ? 4 : 8);
      if (i % 5 === 0) a.room.sendChat(`m${i}`);
      await sleep(40);
    }
    await waitFor(() => e.host.frame > f0 + 200, 10_000, 'frames');
    await waitFor(() => chats.length === 4, 5000, 'chats');
    expect(chats).toEqual(['a:m0', 'a:m5', 'a:m10', 'a:m15']);
    for (const c of [a, b]) {
      expect(c.closeError).toBeNull();
      expect(c.mismatches).toEqual([]);
    }
    for (const pc of clientPcs) expect(await selectedRemote(pc)).toBe(EDGE_IP);
    expect(e.errors).toEqual([]);
    b.room.leave();
    await waitFor(() => e.host.state.players.length === 2, 5000, 'leave');
  } finally {
    await e.close();
  }
  await waitFor(() => edge.stats().sessions === 0, 5000, 'session closed');
  await edge.close();
  return edge;
}

describe('player backend × tunnel data plane', () => {
  it('ndc players + UDP tunnel', async () => {
    await play({ playerBackend: 'ndc' }, 'udp', 'udp');
  }, 60_000);

  it('rtc players + legacy WebRTC tunnel', async () => {
    await play({ playerBackend: 'rtc' }, 'webrtc', 'webrtc');
  }, 60_000);

  it('rtc players + WebSocket data plane', async () => {
    await play({}, 'ws', 'ws');
  }, 60_000);

  it('edge with tunnel v2 disabled: a UDP-tunnel host gets the WebSocket data plane', async () => {
    const edge = await play({ tunnel: { udp: false } }, 'udp', 'ws');
    expect(edge.tunnelPort).toBeNull();
  }, 60_000);

  it('edge refusing the legacy WebRTC tunnel: the host gets the WebSocket data plane', async () => {
    await play({ tunnel: { allowWebRtc: false } }, 'webrtc', 'ws');
  }, 60_000);
});
