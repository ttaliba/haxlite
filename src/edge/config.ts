/**
 * haxlite Edge configuration: JSON file (`--config` / `HAXLITE_EDGE_CONFIG`)
 * plus environment overrides. Reference: docs/09-haxlite-edge.md §5.
 *
 * ```json
 * {
 *   "listen": { "host": "0.0.0.0", "port": 8443, "path": "/tunnel" },
 *   "tls": { "certFile": "/etc/haxlite-edge/fullchain.pem", "keyFile": "/etc/haxlite-edge/privkey.pem" },
 *   "keys": [{ "id": "alice", "secret": "…", "maxSessions": 4, "maxPeers": 64 }],
 *   "keysFile": "/etc/haxlite-edge/keys.txt",
 *   "playerBackend": "rtc",
 *   "webrtc": { "bindAddress": "203.0.113.10", "port": 40000, "publicAddresses": ["203.0.113.10"] },
 *   "tunnel": { "port": 8443, "maxPps": 20000 },
 *   "limits": { "maxPeersPerSession": 40, "floodCapacity": 100, "floodMsPerToken": 16 },
 *   "stats": { "path": "/stats", "token": "…", "logIntervalMs": 60000 }
 * }
 * ```
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
// CJS require on purpose: the ESM facade of node:fs evaluates the lazy `fs.promises`
// getter (fs/promises, readline, fs streams…: ~10 ms of startup for every user of the package).
const { readFileSync } = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
import type { EdgeKeyConfig, EdgeLimitsOptions, EdgePlayerBackendKind, EdgeServerOptions, EdgeTunnelOptions, EdgeWebRtcOptions } from './server.js';

export interface EdgeConfigFile {
  listen?: { host?: string; port?: number; path?: string };
  tls?: { certFile: string; keyFile: string } | null;
  keys?: EdgeKeyConfig[];
  /** Extra keys: a JSON array of {@link EdgeKeyConfig} or one `id:secret` per line (`#` comments). */
  keysFile?: string;
  /** `'rtc'` (default, pure TypeScript) or `'ndc'` (node-datachannel). */
  playerBackend?: EdgePlayerBackendKind;
  webrtc?: EdgeWebRtcOptions;
  /** Tunnel v2 (UDP) settings. */
  tunnel?: EdgeTunnelOptions;
  limits?: EdgeLimitsOptions;
  stats?: { path?: string | null; token?: string | null; logIntervalMs?: number };
}

/** A new random API key `"<id>:<secret>"` (192-bit secret). */
export function generateEdgeKey(id: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) throw new Error('key id: 1-64 chars of [A-Za-z0-9_.-]');
  return `${id}:${randomBytes(24).toString('base64url')}`;
}

/** Parses `id:secret[,id:secret…]` or newline-separated lines. */
export function parseKeyList(text: string): EdgeKeyConfig[] {
  const out: EdgeKeyConfig[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) throw new Error(`bad key entry "${line.slice(0, 20)}..." (expected id:secret)`);
    out.push({ id: line.slice(0, i), secret: line.slice(i + 1) });
  }
  return out;
}

function readKeysFile(path: string): EdgeKeyConfig[] {
  const text = readFileSync(path, 'utf8');
  return text.trimStart().startsWith('[') ? (JSON.parse(text) as EdgeKeyConfig[]) : parseKeyList(text);
}

function portRange(v: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(v.trim());
  if (m === null) throw new Error(`bad port range "${v}" (expected 40000-40999)`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!(a > 0 && b >= a && b < 65536)) throw new Error(`bad port range "${v}"`);
  return [a, b];
}

/**
 * Builds {@link EdgeServerOptions} from `--config <file>` (or
 * `HAXLITE_EDGE_CONFIG`) and these environment variables (which win):
 *
 * | variable | meaning |
 * |---|---|
 * | `HAXLITE_EDGE_HOST` / `HAXLITE_EDGE_PORT` | listen address / port |
 * | `HAXLITE_EDGE_KEYS` | `id:secret,id2:secret2` |
 * | `HAXLITE_EDGE_KEYS_FILE` | keys file (see {@link EdgeConfigFile.keysFile}) |
 * | `HAXLITE_EDGE_TLS_CERT` / `HAXLITE_EDGE_TLS_KEY` | PEM paths (`wss://`) |
 * | `HAXLITE_EDGE_BIND` | WebRTC bind address |
 * | `HAXLITE_EDGE_PORT_RANGE` | WebRTC UDP range `40000-40999` (`'rtc'`: its first port) |
 * | `HAXLITE_EDGE_PLAYER_BACKEND` | `rtc` / `ndc` |
 * | `HAXLITE_EDGE_PUBLIC_ADDRESSES` | `'rtc'`: announced IPs, comma-separated |
 * | `HAXLITE_EDGE_TUNNEL_PORT` | tunnel v2 UDP port (`off` disables tunnel v2) |
 * | `HAXLITE_EDGE_STATS_TOKEN` | bearer token for `GET /stats` |
 * | `HAXLITE_EDGE_LOG_INTERVAL_MS` | stats log line period |
 */
export function loadEdgeConfig(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): EdgeServerOptions {
  let file = env.HAXLITE_EDGE_CONFIG;
  const ci = argv.indexOf('--config');
  if (ci >= 0) file = argv[ci + 1];
  const cfg: EdgeConfigFile = file ? (JSON.parse(readFileSync(file, 'utf8')) as EdgeConfigFile) : {};

  const keys: EdgeKeyConfig[] = [...(cfg.keys ?? [])];
  if (cfg.keysFile) keys.push(...readKeysFile(cfg.keysFile));
  if (env.HAXLITE_EDGE_KEYS_FILE) keys.push(...readKeysFile(env.HAXLITE_EDGE_KEYS_FILE));
  if (env.HAXLITE_EDGE_KEYS) keys.push(...parseKeyList(env.HAXLITE_EDGE_KEYS));
  if (keys.length === 0) throw new Error('no API keys configured (keys / keysFile / HAXLITE_EDGE_KEYS)');

  const webrtc: EdgeWebRtcOptions = { ...cfg.webrtc };
  if (env.HAXLITE_EDGE_BIND) webrtc.bindAddress = env.HAXLITE_EDGE_BIND;
  if (env.HAXLITE_EDGE_PORT_RANGE) webrtc.portRange = portRange(env.HAXLITE_EDGE_PORT_RANGE);
  if (env.HAXLITE_EDGE_PUBLIC_ADDRESSES) {
    webrtc.publicAddresses = env.HAXLITE_EDGE_PUBLIC_ADDRESSES.split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
  }
  const playerBackend = (env.HAXLITE_EDGE_PLAYER_BACKEND ?? cfg.playerBackend ?? 'rtc') as EdgePlayerBackendKind;
  if (playerBackend !== 'rtc' && playerBackend !== 'ndc') throw new Error(`bad player backend "${playerBackend}" (rtc | ndc)`);
  const tunnel: EdgeTunnelOptions = { ...cfg.tunnel };
  const tp = env.HAXLITE_EDGE_TUNNEL_PORT;
  if (tp !== undefined && tp !== '') {
    if (tp === 'off') tunnel.udp = false;
    else {
      const n = Number(tp);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`bad tunnel port ${tp}`);
      tunnel.port = n;
    }
  }

  let tls = cfg.tls ?? null;
  if (env.HAXLITE_EDGE_TLS_CERT || env.HAXLITE_EDGE_TLS_KEY) {
    if (!env.HAXLITE_EDGE_TLS_CERT || !env.HAXLITE_EDGE_TLS_KEY) throw new Error('set both HAXLITE_EDGE_TLS_CERT and HAXLITE_EDGE_TLS_KEY');
    tls = { certFile: env.HAXLITE_EDGE_TLS_CERT, keyFile: env.HAXLITE_EDGE_TLS_KEY };
  }

  const port = env.HAXLITE_EDGE_PORT ? Number(env.HAXLITE_EDGE_PORT) : (cfg.listen?.port ?? 8443);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad port ${port}`);
  const logEvery = env.HAXLITE_EDGE_LOG_INTERVAL_MS ? Number(env.HAXLITE_EDGE_LOG_INTERVAL_MS) : (cfg.stats?.logIntervalMs ?? 60_000);

  return {
    host: env.HAXLITE_EDGE_HOST ?? cfg.listen?.host ?? '0.0.0.0',
    port,
    path: cfg.listen?.path ?? '/tunnel',
    tls,
    keys,
    playerBackend,
    webrtc,
    tunnel,
    limits: cfg.limits ?? {},
    statsPath: cfg.stats?.path === undefined ? '/stats' : cfg.stats.path,
    statsToken: env.HAXLITE_EDGE_STATS_TOKEN ?? cfg.stats?.token ?? null,
    statsLogIntervalMs: logEvery,
  };
}
