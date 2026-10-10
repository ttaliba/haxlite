/**
 * node-haxball wired to a FakeMaster (TEST ONLY). node-haxball keeps its
 * backend config module-global, so use one master per test file (vitest runs
 * each file in its own process: `pool: 'forks'`).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FakeMaster } from './index.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function nestedDataChannel(sub = ''): Any {
  const dir = path.dirname(require.resolve('node-haxball'));
  return require(require.resolve(`node-datachannel${sub}`, { paths: [dir] }));
}

export interface NodeHaxballTestOptions {
  /**
   * Delay every data-channel send by this many ms (FIFO order preserved).
   * A node-haxball HOST sends the join challenge the instant channel 0 opens;
   * a node-haxball CLIENT (libdatachannel) drops messages that arrive before
   * all its channels report open, so host<->client over loopback loses the
   * challenge ~20% of the time. Delaying sends removes that race (haxlite's
   * own host does the equivalent with `challengeDelayMs`).
   */
  sendDelayMs?: number;
}

/** Initialises node-haxball pointing at `master` (HTTP + WS on 127.0.0.1). */
export function nodeHaxballFor(master: FakeMaster, opts: NodeHaxballTestOptions = {}): Any {
  let window: Any = null;
  const delay = opts.sendDelayMs ?? 0;
  if (delay > 0) {
    const poly = nestedDataChannel('/polyfill');
    class DelayedSendPeerConnection extends poly.RTCPeerConnection {
      createDataChannel(label: string, init: Any): Any {
        const dc = super.createDataChannel(label, init);
        const send = dc.send.bind(dc);
        dc.send = (data: Any) => {
          setTimeout(() => {
            if (dc.readyState === 'open') send(data);
          }, delay);
        };
        return dc;
      }
    }
    window = {
      RTCPeerConnection: DelayedSendPeerConnection,
      RTCIceCandidate: poly.RTCIceCandidate,
      RTCSessionDescription: poly.RTCSessionDescription,
    };
  }
  return (require('node-haxball') as (w: unknown, c: unknown) => Any)(window, master.nodeHaxballConfig);
}

/** node-haxball bundles its own node-datachannel copy; release its threads so the process can exit. */
export function cleanupNodeHaxball(): void {
  (nestedDataChannel() as { cleanup(): void }).cleanup();
}
