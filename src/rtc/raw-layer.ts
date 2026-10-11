/**
 * Test/diagnostic data layer without SCTP: each DTLS application-data
 * record is one message, framed as `[u8 channelId][payload]`. Opens as soon
 * as DTLS is connected. Not interoperable with browsers (they speak SCTP);
 * used to exercise the DTLS/ICE stack alone (e.g. against `openssl s_client`).
 */
import type { SctpAssociationLike, SctpAssociationOptions, SctpFactory } from './types.js';

class RawLayer implements SctpAssociationLike {
  private opts: SctpAssociationOptions | null;

  constructor(opts: SctpAssociationOptions) {
    this.opts = opts;
    queueMicrotask(() => this.opts?.onOpen());
  }

  input(packet: Uint8Array): void {
    const o = this.opts;
    if (o === null || packet.length === 0) return;
    o.onMessage(packet[0]!, packet.subarray(1));
  }

  send(channelId: number, data: Uint8Array): boolean {
    const o = this.opts;
    if (o === null || data.length + 1 > o.maxMessageSize) return false;
    const b = new Uint8Array(data.length + 1);
    b[0] = channelId;
    b.set(data, 1);
    o.send(b);
    return true;
  }

  close(): void {
    this.opts = null;
  }
}

export const rawDataLayer: SctpFactory = (opts) => new RawLayer(opts);
