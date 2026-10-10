/**
 * Shared scenario for the netcode-knob variants (TEST ONLY): 2 node-haxball
 * clients play ~900 frames against a HostRoom with the given input delay /
 * heartbeat period and a 60-frame CheckConsistency period; a third client
 * joins mid-game. Asserts byte-identical confirmed states and no desync.
 */
import { expect } from 'vitest';
import { E2E, sleep, type Any, type ClientHandle } from './harness.js';
import { prng } from '../oracle/index.js';
import { Input } from '../../src/protocol.js';

export async function runVariant(
  shared: { master: Any; nh: Any },
  cfg: { inputDelayFrames: number; heartbeatFrames: number; frames?: number },
): Promise<void> {
  const e = await E2E.start({ shared, inputDelayFrames: cfg.inputDelayFrames, heartbeatFrames: cfg.heartbeatFrames, checksumIntervalFrames: 60 });
  try {
    const host = e.host;
    const a = await e.join('a');
    const b = await e.join('b');
    host.setPlayerTeam(1, 1);
    host.setPlayerTeam(2, 2);
    host.startGame();
    const start = host.frame;
    const total = cfg.frames ?? 900;
    const rnd = prng(cfg.inputDelayFrames * 10 + cfg.heartbeatFrames);
    const clients: ClientHandle[] = [a, b];
    let c: ClientHandle | null = null;
    while (host.frame < start + total) {
      for (const cl of clients) {
        const dir = [Input.Up, Input.Down, Input.Left, Input.Right, 0][Math.floor(rnd() * 5)]!;
        cl.room.setKeyState(dir | (rnd() < 0.3 ? Input.Kick : 0));
      }
      if (c === null && host.frame > start + total / 2) {
        c = await e.join('c');
        host.setPlayerTeam(3, 2);
        clients.push(c);
      }
      await sleep(15 + Math.floor(rnd() * 60));
    }
    await sleep(400);
    for (const cl of clients) {
      expect(cl.closeError, cl.name).toBeNull();
      expect(cl.mismatches, cl.name).toEqual([]);
      expect(cl.compared, `${cl.name} compared`).toBeGreaterThan(cl === c ? 20 : 60);
      expect(cl.checks.length, `${cl.name} checks`).toBeGreaterThanOrEqual(cl === c ? 3 : 10);
      expect(cl.checks.every((d) => d === false), `${cl.name} desync`).toBe(true);
    }
    expect(e.syncEvents.filter((s) => s.desync)).toEqual([]);
    expect(e.errors).toEqual([]);
  } finally {
    await e.close();
  }
}
