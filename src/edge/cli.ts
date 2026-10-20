/**
 * `haxlite-edge` command line (bin/haxlite-edge.js).
 *
 * ```
 * haxlite-edge [--config /etc/haxlite-edge/config.json]   run the edge
 * haxlite-edge genkey <id>                                 print a new API key
 * ```
 *
 * Signals: SIGHUP reloads the TLS certificate, SIGINT/SIGTERM close every
 * tunnel (hosts reconnect) and exit.
 */
import { generateEdgeKey, loadEdgeConfig } from './config.js';
import { EdgeServer } from './server.js';

const USAGE = `usage:
  haxlite-edge [--config <file.json>]   run the edge (env overrides: see docs/09-haxlite-edge.md)
  haxlite-edge genkey <id>              print a new API key "<id>:<secret>"`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === 'genkey') {
    const id = argv[1];
    if (!id) throw new Error(USAGE);
    const key = generateEdgeKey(id);
    const secret = key.slice(id.length + 1);
    process.stdout.write(
      `host config  : haxlite: { edge: { url: 'wss://<edge>:8443/tunnel', key: '${key}' } }\n` +
        `edge keys    : { "id": "${id}", "secret": "${secret}" }\n`,
    );
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const opts = loadEdgeConfig(argv);
  const log = (msg: string) => process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  const edge = await EdgeServer.start({ ...opts, log });
  log(
    `haxlite-edge listening on ${opts.tls ? 'wss' : 'ws'}://${opts.host}:${edge.address.port}${opts.path ?? '/tunnel'} ` +
      `(${opts.keys.length} key(s), players ${edge.stats().playerBackend}` +
      `${edge.playerPort !== null ? ` on UDP ${edge.playerPort}` : `, ports ${opts.webrtc?.portRange?.join('-') ?? 'any'}`}` +
      `, tunnel v2 ${edge.tunnelPort !== null ? `UDP ${edge.tunnelPort}` : 'off'})`,
  );
  if (!opts.tls) log('WARNING: no TLS configured; use wss:// in production (tls.certFile/keyFile)');
  if (opts.statsPath !== null && !opts.statsToken) log(`${opts.statsPath ?? '/stats'} has no token: it serves edge-wide aggregates only (stats.token for per-key stats)`);
  process.on('SIGHUP', () => {
    try {
      edge.reloadTls();
    } catch (err) {
      log(`TLS reload failed: ${(err as Error).message}`);
    }
  });
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: closing`);
    // shutdownWebRtc: releases node-datachannel's threads if (and only if) it was ever loaded
    void edge.close({ shutdownWebRtc: true }).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
