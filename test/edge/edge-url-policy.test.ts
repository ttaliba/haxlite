/**
 * Plaintext (`ws://`) policy of the Edge client (src/net/edge-client.ts):
 *  - loopback: accepted silently, WebSocket fallback on;
 *  - private / LAN destinations (RFC 1918, 100.64/10, link-local, ULA, mapped
 *    IPv4, single-label and .local/.internal/.lan/.home.arpa names): accepted
 *    with a one-line warning, WebSocket fallback on;
 *  - everything else (public): refused unless `allowInsecure: true`, then the
 *    WebSocket fallback defaults to off.
 * `wss://` is never restricted.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EdgePeerBackend, type EdgeOptions } from '../../src/net/edge-client.js';

const KEY = `fake:${randomBytes(24).toString('base64url')}`;

interface Made {
  backend: EdgePeerBackend;
  logs: string[];
}

function make(url: string, extra: Partial<EdgeOptions> = {}): Made {
  const logs: string[] = [];
  const backend = new EdgePeerBackend({ url, key: KEY, log: (m) => logs.push(m), ...extra });
  return { backend, logs };
}

const LOOPBACK = [
  'ws://127.0.0.1:8443/tunnel',
  'ws://127.1.2.3/t',
  'ws://localhost/t',
  'ws://localhost./t',
  'WS://LOCALHOST/t',
  'ws://[::1]:9/t',
  'ws://[::ffff:127.0.0.1]/t',
  'ws://2130706433/t',
  'ws://0x7f.1/t',
];

const PRIVATE = [
  // RFC 1918, shared address space (overlay networks), IPv4 link-local
  'ws://10.0.0.5:8443/tunnel',
  'ws://10.255.255.255/t',
  'ws://172.16.0.1/t',
  'ws://172.31.255.254/t',
  'ws://192.168.1.10/t',
  'ws://192.168.1/t',
  'ws://0xc0a80101/t',
  'ws://100.64.0.1/t',
  'ws://100.127.255.254/t',
  'ws://169.254.10.20/t',
  // IPv6: ULA, link-local, IPv4-mapped private
  'ws://[fd00::1]:8443/t',
  'ws://[fc00::1234]/t',
  'ws://[fdff:ffff:ffff::1]/t',
  'ws://[fe80::1]/t',
  'ws://[febf::1]/t',
  'ws://[::ffff:192.168.1.5]/t',
  'ws://[::ffff:10.0.0.1]/t',
  // names that never resolve on the public DNS
  'ws://edge/t',
  'ws://haxlite-edge:8443/tunnel',
  'ws://edge_1:8443/tunnel',
  'ws://edge.local/t',
  'ws://edge.internal:8443/t',
  'ws://EDGE.LAN/t',
  'ws://edge.lan./t',
  'ws://box.home.arpa/t',
  'ws://a.b.edge.internal/t',
];

const PUBLIC = [
  'ws://203.0.113.9:8443/tunnel',
  'ws://8.8.8.8/t',
  'ws://0.0.0.0/t',
  // just outside the private ranges
  'ws://9.255.255.255/t',
  'ws://11.0.0.1/t',
  'ws://172.15.255.255/t',
  'ws://172.32.0.1/t',
  'ws://192.167.255.255/t',
  'ws://192.169.0.1/t',
  'ws://169.253.255.255/t',
  'ws://169.255.0.1/t',
  'ws://100.63.255.255/t',
  'ws://100.128.0.1/t',
  // IPv6
  'ws://[2001:db8::1]/t',
  'ws://[::]/t',
  'ws://[::2]/t',
  'ws://[fbff::1]/t',
  'ws://[fe00::1]/t',
  'ws://[fe7f::1]/t',
  'ws://[fec0::1]/t',
  'ws://[::ffff:192.0.2.1]/t',
  'ws://[::ffff:172.32.0.1]/t',
  'ws://[64:ff9b::a00:1]/t',
  // names
  'ws://edge.example.com/t',
  'ws://example.com./t',
  'ws://local.example.com/t',
  'ws://edge.local.example.com/t',
  'ws://lan.com/t',
  'ws://edge.lanx/t',
  'ws://internal.net/t',
  'ws://127.0.0.1.example.com/t',
  'ws://localhost.example.com/t',
  'ws://10.0.0.1.example.com/t',
  // the connection goes to the host after '@': userinfo cannot dress a public host as a private one
  'ws://192.168.1.1@edge.example.com/t',
  'ws://127.0.0.1:80@203.0.113.9/t',
];

describe('edge ws:// policy: loopback', () => {
  it.each(LOOPBACK)('%s is accepted silently with the WebSocket fallback on', (url) => {
    const { backend, logs } = make(url);
    expect(logs).toEqual([]);
    expect(backend.fallbackWs).toBe(true);
  });

  it('allowInsecure changes nothing for loopback', () => {
    const { backend, logs } = make('ws://127.0.0.1/t', { allowInsecure: true });
    expect(logs).toEqual([]);
    expect(backend.fallbackWs).toBe(true);
  });
});

describe('edge ws:// policy: private and LAN destinations', () => {
  it.each(PRIVATE)('%s is accepted without allowInsecure, with a warning and the WebSocket fallback on', (url) => {
    const { backend, logs } = make(url);
    expect(logs.filter((l) => /without TLS/.test(l))).toHaveLength(1);
    expect(logs.length).toBe(1);
    expect(backend.fallbackWs).toBe(true);
  });

  it('fallbackWs stays an explicit choice and allowInsecure does not flip its default here', () => {
    expect(make('ws://10.0.0.5/t', { fallbackWs: false }).backend.fallbackWs).toBe(false);
    expect(make('ws://10.0.0.5/t', { fallbackWs: true }).backend.fallbackWs).toBe(true);
    expect(make('ws://edge:8443/t', { allowInsecure: true }).backend.fallbackWs).toBe(true);
  });

  it('warns about a short key secret, since a captured Auth is readable on the path', () => {
    const { logs } = make('ws://192.168.1.10/t', { key: 'k:short' });
    expect(logs.some((l) => /short edge key secret/.test(l))).toBe(true);
    const { logs: ok } = make('ws://192.168.1.10/t');
    expect(ok.some((l) => /short edge key secret/.test(l))).toBe(false);
  });
});

describe('edge ws:// policy: public destinations', () => {
  it.each(PUBLIC)('%s is refused without allowInsecure', (url) => {
    expect(() => make(url).backend, url).toThrow(/allowInsecure: true/);
  });

  it('the error names the host and says how to proceed', () => {
    let msg = '';
    try {
      make('ws://203.0.113.9:8443/tunnel');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('203.0.113.9');
    expect(msg).toContain('loopback');
    expect(msg).toContain('wss://');
    expect(msg).toContain('allowInsecure: true');
    expect(msg).toMatch(/fallbackWs/);
  });

  it('allowInsecure: true accepts it with a warning and the WebSocket fallback off by default', () => {
    for (const url of ['ws://203.0.113.9:8443/tunnel', 'ws://edge.example.com/t', 'ws://[2001:db8::1]/t']) {
      const { backend, logs } = make(url, { allowInsecure: true });
      expect(logs.some((l) => /without TLS/.test(l)), url).toBe(true);
      expect(backend.fallbackWs, url).toBe(false);
      expect(make(url, { allowInsecure: true, fallbackWs: true }).backend.fallbackWs, url).toBe(true);
    }
  });

  it('the "fallbackWs is off" errors say how to turn it on only when the url policy turned it off', () => {
    expect(make('ws://203.0.113.9/t', { allowInsecure: true }).backend.fallbackWsHint).toMatch(/fallbackWs: true/);
    expect(make('ws://203.0.113.9/t', { allowInsecure: true, fallbackWs: false }).backend.fallbackWsHint).toBe('');
    expect(make('ws://203.0.113.9/t', { allowInsecure: true, fallbackWs: true }).backend.fallbackWsHint).toBe('');
    expect(make('ws://127.0.0.1/t', { fallbackWs: false }).backend.fallbackWsHint).toBe('');
    expect(make('ws://10.0.0.5/t', { fallbackWs: false }).backend.fallbackWsHint).toBe('');
    expect(make('wss://edge.example.com/t', { fallbackWs: false }).backend.fallbackWsHint).toBe('');
  });

  it('only allowInsecure === true counts', () => {
    expect(() => make('ws://203.0.113.9/t', { allowInsecure: false })).toThrow(/allowInsecure: true/);
    expect(() => make('ws://203.0.113.9/t', { allowInsecure: 1 as unknown as boolean })).toThrow(/allowInsecure: true/);
  });

  it('warns about a short key secret', () => {
    const { logs } = make('ws://203.0.113.9/t', { key: 'k:short', allowInsecure: true });
    expect(logs.some((l) => /short edge key secret/.test(l))).toBe(true);
  });
});

describe('edge url scheme', () => {
  it('wss:// is accepted for any host without warnings and keeps the fallback on', () => {
    for (const url of ['wss://203.0.113.9:8443/tunnel', 'wss://edge.example.com/tunnel', 'wss://10.0.0.1/t', 'wss://[2001:db8::1]/t']) {
      const { backend, logs } = make(url);
      expect(logs, url).toEqual([]);
      expect(backend.fallbackWs, url).toBe(true);
    }
  });

  it('other schemes are refused', () => {
    expect(() => make('http://127.0.0.1/t')).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => make('127.0.0.1:8443/t')).toThrow(/ws:\/\/ or wss:\/\//);
  });
});
