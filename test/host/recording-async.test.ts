/**
 * HostRoom.stopRecordingAsync (deflate off the event loop) gives the same
 * `.hbr2` bytes as stopRecording: two identical rooms on an injected clock,
 * one stopped each way.
 */
import { describe, expect, it } from 'vitest';
import { HostRoom, createHostRoomState } from '../../src/host/index.js';
import { ReplayPlayer } from '../../src/replay/index.js';
import type { HostTransport } from '../../src/net/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function fakeTransport(): { transport: HostTransport; join(name: string): void } {
  const roomInfo: Any = { players: 0 };
  let nextId = 1;
  const t: Any = {
    onPeerJoin: null,
    onPeerMessage: null,
    onPeerClose: null,
    onRoomLink: null,
    connectionCount: 0,
    bans: { remove() {}, clear() {} },
    start() {},
    stop() {},
    getRoomInfo: () => roomInfo,
    setRoomInfo: (i: Any) => Object.assign(roomInfo, i),
    send: () => true,
    broadcastTo() {},
    kick: () => null,
    close() {},
  };
  return {
    transport: t as HostTransport,
    join(name: string) {
      const peer = { id: nextId++, state: 'joined', playerId: -1, userData: null };
      t.connectionCount++;
      t.onPeerJoin(peer, { name, flag: 'ar', avatar: null, auth: null, conn: '7F000001' });
    },
  };
}

/** A room driven by an injected clock through the same script; returns it ready to be stopped. */
function scriptedRoom(): HostRoom {
  let t = 1000;
  const f = fakeTransport();
  const host = new HostRoom({ transport: f.transport, state: createHostRoomState({ noPlayer: true }), now: () => t });
  host.onError = (e) => {
    throw e;
  };
  host.start();
  const step = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      t += 1000 / 60;
      host.update();
    }
  };
  host.startRecording();
  f.join('a');
  f.join('b');
  step(10);
  host.setPlayerTeam(1, 1);
  host.setPlayerTeam(2, 2);
  host.startGame();
  step(300);
  host.sendChat('gg');
  step(30);
  return host;
}

describe('HostRoom.stopRecordingAsync', () => {
  it('same bytes as stopRecording; null when not recording', async () => {
    const a = scriptedRoom();
    const b = scriptedRoom();
    expect(b.frame).toBe(a.frame);
    const sync = a.stopRecording()!;
    const pending = b.stopRecordingAsync();
    expect(await b.stopRecordingAsync()).toBeNull(); // recording already stopped at the call
    const async = (await pending)!;
    expect(async).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(async).equals(Buffer.from(sync))).toBe(true);
    expect(new ReplayPlayer(async).finish().gameState).not.toBeNull();
    a.stop();
    b.stop();
  });
});
