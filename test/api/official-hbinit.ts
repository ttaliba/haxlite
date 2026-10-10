/**
 * TEST ONLY: the official headless host (`headless-min.js` embedded in
 * haxball.js dist, hash f066733d) running for real against a FakeMaster:
 * the same technique as haxball.js `loadHeadless(createHeadlessEnvironment())`
 * (fake `window`, ws WebSocket with the html5 Origin, Node WebRTC), except
 *  - XMLHttpRequest is a tiny node:http implementation that rewrites
 *    `https://www.haxball.com/rs/` to the fake master,
 *  - the STUN server list (`za.Ld`) is emptied (offline),
 *  - every window timer is tracked so {@link OfficialHost.dispose} can stop
 *    the official 50 ms / 3 s intervals (the official room has no stop()).
 * WebRTC: node-datachannel's W3C polyfill, injected like haxball.js's
 * `config.webrtc` (its default `@webrtc-node/webrtc` never completed a
 * loopback connection without STUN here: clients failed with FailedHost).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const OFFICIAL_MASTER = 'https://www.haxball.com/rs/';
const SEND_DELAY_MS = 40;

export interface OfficialHost {
  /** The official `HBInit` function (synchronous, returns the room object). */
  HBInit: (config: Any) => Any;
  /** Stops every timer the official script armed and closes its sockets. */
  dispose(): void;
}

export async function loadOfficialHeadless(masterHttpBase: string): Promise<OfficialHost> {
  const file = require.resolve('haxball.js').replace(/index\.c?js$/, 'index.mjs');
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('(function(wa) {');
  const end = src.lastIndexOf('F.sh();');
  if (start < 0 || end < 0 || end < start) throw new Error('official headless script layout changed (haxball.js upgraded?)');
  const body = `${src.slice(start, end)}za.Ld = [];\nF.sh();\n})(window);`;

  const timeouts = new Set<NodeJS.Timeout>();
  const intervals = new Set<NodeJS.Timeout>();
  const sockets = new Set<WebSocket>();
  const peers = new Set<Any>();

  class FakeXHR {
    responseType = '';
    status = 0;
    response: unknown = null;
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private method = 'GET';
    private url = '';
    private headers: Record<string, string> = {};
    open(method: string, url: string): void {
      this.method = method;
      this.url = url.startsWith(OFFICIAL_MASTER) ? masterHttpBase + url.slice(OFFICIAL_MASTER.length) : url;
    }
    setRequestHeader(k: string, v: string): void {
      this.headers[k] = v;
    }
    send(body: string | null): void {
      const req = http.request(this.url, { method: this.method, headers: this.headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          this.status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            this.response = this.responseType === 'json' ? JSON.parse(text) : text;
          } catch {
            this.response = null;
          }
          this.onload?.();
        });
      });
      req.on('error', (e) => this.onerror?.(e));
      if (body != null) req.write(body);
      req.end();
    }
  }

  class HaxballWebSocket extends WebSocket {
    constructor(address: string) {
      super(address, { headers: { origin: 'https://html5.haxball.com' } });
      sockets.add(this);
      this.on('error', () => {});
    }
  }

  const webrtc = require('node-datachannel/polyfill');
  // The official host sends the join challenge the instant channel 0 opens;
  // node-haxball clients (libdatachannel) drop messages that arrive before all
  // their channels report open (see test/fake-master/node-haxball.ts). Delay
  // every send by the same amount (FIFO preserved), like haxlite's
  // `challengeDelayMs`, so official-host joins are not flaky.
  class TrackedPeerConnection extends webrtc.RTCPeerConnection {
    constructor(...args: Any[]) {
      super(...args);
      peers.add(this);
    }
    createDataChannel(label: string, init: Any): Any {
      const dc = super.createDataChannel(label, init);
      const send = dc.send.bind(dc);
      dc.send = (data: Any) => {
        const t: NodeJS.Timeout = setTimeout(() => {
          timeouts.delete(t);
          if (dc.readyState === 'open') send(data);
        }, SEND_DELAY_MS);
        timeouts.add(t);
      };
      return dc;
    }
  }

  let resolveInit!: (f: Any) => void;
  const ready = new Promise<Any>((r) => (resolveInit = r));
  const roomLinkElement = { innerHTML: '' };
  const recaptchaElement = { hidden: true };
  const fakeWindow = {
    parent: {
      set HBInit(v: Any) {
        resolveInit(v);
      },
      onHBLoaded: () => {},
    },
    document: {
      getElementById: (id: string) => (id === 'roomlink' ? roomLinkElement : id === 'recaptcha' ? recaptchaElement : null),
      createElement: () => ({ src: '', onerror: undefined }),
      head: {
        appendChild(el: Any) {
          queueMicrotask(() => el.onerror?.(new Error('reCAPTCHA is unavailable in the Node.js runtime')));
          return el;
        },
      },
    },
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    setTimeout: (fn: () => void, ms?: number) => {
      const t: NodeJS.Timeout = setTimeout(() => {
        timeouts.delete(t);
        fn();
      }, ms);
      timeouts.add(t);
      return t;
    },
    clearTimeout: (t: NodeJS.Timeout) => {
      timeouts.delete(t);
      clearTimeout(t);
    },
    setInterval: (fn: () => void, ms?: number) => {
      const t = setInterval(fn, ms);
      intervals.add(t);
      return t;
    },
    clearInterval: (t: NodeJS.Timeout) => {
      intervals.delete(t);
      clearInterval(t);
    },
    console,
  };
  const run = new Function(
    'window', 'WebSocket', 'XMLHttpRequest', 'JSON5', 'pako', 'RTCPeerConnection', 'RTCIceCandidate', 'RTCSessionDescription',
    'crypto', 'performance', 'TextEncoder', body,
  );
  run(
    fakeWindow, HaxballWebSocket, FakeXHR, require('json5'), require('pako'), TrackedPeerConnection, webrtc.RTCIceCandidate,
    webrtc.RTCSessionDescription, globalThis.crypto, globalThis.performance, TextEncoder,
  );
  const HBInit = await ready;
  return {
    HBInit,
    dispose() {
      for (const t of timeouts) clearTimeout(t);
      for (const t of intervals) clearInterval(t);
      timeouts.clear();
      intervals.clear();
      for (const ws of sockets) {
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
      }
      for (const pc of peers) {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
