/**
 * The legacy host↔edge PeerConnection (`NdcTunnelPlane`, src/net/edge-ndc.ts)
 * with the native bindings replaced by fakes: a construction that fails
 * halfway releases what it created, and a channel with a huge send queue
 * refuses frames instead of growing it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Any } from '../host/harness.js';

const native = vi.hoisted(() => ({
  closed: [] as unknown[],
  channels: [] as { dc: Any; handlers: Any }[],
  failAt: -1,
  buffered: 0,
  pc: { name: 'pc' } as Any,
}));

vi.mock('../../src/net/webrtc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/net/webrtc.js')>()),
  createPeerConnection: () => native.pc,
  createDataChannel: (_pc: unknown, label: string, _init: unknown, handlers: Any) => {
    if (native.channels.length === native.failAt) throw new Error('createDataChannel failed');
    const dc = { label, sent: 0, bufferedAmount: () => native.buffered, sendMessageBinary: () => (dc.sent++, true) };
    native.channels.push({ dc, handlers });
    return dc;
  },
  closeNative: (obj: unknown) => void native.closed.push(obj),
}));

const { NdcTunnelPlane } = await import('../../src/net/edge-ndc.js');

const events = () => ({ onOpen: () => {}, onMessage: () => {}, onClose: () => {}, onLocalCandidate: () => {}, onError: () => {} });

beforeEach(() => {
  native.closed.length = 0;
  native.channels.length = 0;
  native.failAt = -1;
  native.buffered = 0;
});

describe('NdcTunnelPlane', () => {
  it('a construction that fails creating a channel closes the channels and the PeerConnection it made', () => {
    native.failAt = 2;
    expect(() => new NdcTunnelPlane('t', { iceServers: [] }, 4, events())).toThrow(/createDataChannel failed/);
    expect(native.channels.length).toBe(2);
    expect(native.closed).toContain(native.pc);
    for (const c of native.channels) expect(native.closed).toContain(c.dc);
  });

  it('refuses frames while the channel has more than 8 MiB queued', () => {
    const plane = new NdcTunnelPlane('t', { iceServers: [] }, 1, events());
    for (const c of native.channels) c.handlers.onOpen();
    const frame = new Uint8Array(100);
    expect(plane.send(0, frame)).toBe(true);
    native.buffered = 8 * 1024 * 1024 + 1;
    expect(plane.send(0, frame)).toBe(false);
    expect(native.channels[0]!.dc.sent).toBe(1);
    native.buffered = 1024;
    expect(plane.send(0, frame)).toBe(true);
    plane.close();
  });
});
