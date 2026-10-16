/**
 * Master HTTP client: on Bun (no agent, no proxy env) requests go through
 * `fetch`; everywhere else through node:http(s). Both must give the same
 * results and error kinds against a local server (never the real master).
 * The Bun half runs in a `bun` child process and is skipped without bun.
 */
import { spawnSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MasterError, fetchGeo, fetchRoomList, requestHostSession } from '../../src/net/master-http.js';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
const seen: Seen[] = [];
const json = (res: ServerResponse, v: unknown, gzip = false): void => {
  const raw = Buffer.from(JSON.stringify(v));
  if (gzip) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(gzipSync(raw));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(raw);
  }
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const u = req.url!;
    const gz = /gzip/.test(String(req.headers['accept-encoding'] ?? ''));
    if (u === '/rs/api/host') {
      const p = new URLSearchParams(body);
      json(res, { data: { action: 'connect', url: `wss://x/${p.get('token')}`, token: `${p.get('rcr')}|${req.headers['content-type']}|${req.headers['x-extra']}` } });
    } else if (u === '/rs/api/geo') json(res, { data: { code: 'AR', lat: 1.5, lon: -2 } }, gz);
    else if (u === '/rs/api/list') {
      res.writeHead(200);
      res.end(Buffer.from([0]));
    } else if (u === '/rs/e500/api/geo') {
      res.writeHead(500);
      res.end('oops');
    } else if (u === '/rs/redir/api/geo') {
      res.writeHead(302, { Location: '/rs/api/geo' });
      res.end();
    } else if (u === '/rs/bad/api/geo') {
      res.writeHead(200);
      res.end('nope');
    } else if (u === '/rs/merr/api/geo') json(res, { error: 'bad token' });
    else if (u === '/rs/slow/api/geo') {
      /* never answers */
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});

let base = '';
let deadBase = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rs/`;
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  deadBase = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/rs/`;
  await new Promise<void>((r) => dead.close(() => r()));
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

type Outcome = { ok: unknown } | { err: { name: string; kind: string; status: number; message: string } };

/** The same scenario, as source, for this process and for the bun child. */
const SCENARIO = `
async function scenario(M, base, deadBase) {
  const o = { headers: { 'X-Extra': 'e1' }, timeoutMs: 400 };
  const run = async (f) => { try { return { ok: await f() }; } catch (e) { return { err: { name: e.name, kind: e.kind, status: e.status, message: e.message } }; } };
  return {
    host: await run(() => M.requestHostSession('tok en', 'r&c', { ...o, masterUrl: base })),
    geo: await run(() => M.fetchGeo({ ...o, masterUrl: base })),
    list: await run(() => M.fetchRoomList({ ...o, masterUrl: base })),
    e500: await run(() => M.fetchGeo({ ...o, masterUrl: base + 'e500/' })),
    redir: await run(() => M.fetchGeo({ ...o, masterUrl: base + 'redir/' })),
    bad: await run(() => M.fetchGeo({ ...o, masterUrl: base + 'bad/' })),
    merr: await run(() => M.fetchGeo({ ...o, masterUrl: base + 'merr/' })),
    slow: await run(() => M.fetchGeo({ ...o, masterUrl: base + 'slow/' })),
    refused: await run(() => M.fetchGeo({ ...o, masterUrl: deadBase })),
  };
}`;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const scenario = new Function(`${SCENARIO}; return scenario;`)() as (m: unknown, b: string, d: string) => Promise<Record<string, Outcome>>;

/** Network error messages are runtime-specific; everything else must match. */
function normalize(r: Record<string, Outcome>): Record<string, Outcome> {
  const out: Record<string, Outcome> = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = 'err' in v && v.err.kind === 'network' && v.err.message !== 'timeout' ? { err: { ...v.err, message: '<network>' } } : v;
  }
  return out;
}

const probe = spawnSync('bun -e "console.log(process.execPath)"', { encoding: 'utf8', shell: true });
const bunExe = probe.status === 0 ? probe.stdout.trim().split('\n').pop()!.trim() : '';

function runBun(env: NodeJS.ProcessEnv): Promise<{ fetchCalls: number; res: Record<string, Outcome> }> {
  const mod = pathToFileURL(new URL('../../src/net/master-http.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;
  const script = `
    ${SCENARIO}
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (...a) => { fetchCalls++; return realFetch(...a); };
    const M = await import(${JSON.stringify(mod)});
    const res = await scenario(M, ${JSON.stringify(base)}, ${JSON.stringify(deadBase)});
    console.log(JSON.stringify({ fetchCalls, res }));
    process.exit(0);
  `;
  return new Promise((resolve, reject) => {
    // async spawn: the server lives in this process
    const child = spawn(bunExe, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const t = setTimeout(() => child.kill(), 30_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`bun exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim().split('\n').pop()!));
    });
  });
}

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete env[k];
  return env;
};

describe('master HTTP client: node:http and Bun fetch paths agree', () => {
  let nodeRes: Record<string, Outcome>;

  it('node:http path (this runtime)', async () => {
    seen.length = 0;
    nodeRes = await scenario({ requestHostSession, fetchGeo, fetchRoomList }, base, deadBase);
    expect(nodeRes.host).toEqual({ ok: { action: 'connect', url: 'wss://x/tok en', token: 'r&c|application/x-www-form-urlencoded|e1' } });
    expect(nodeRes.geo).toEqual({ ok: { flag: 'ar', lat: 1.5, lon: -2 } });
    expect(nodeRes.list).toEqual({ ok: [] });
    expect(nodeRes.e500).toEqual({ err: { name: 'MasterError', kind: 'http', status: 500, message: 'api/geo: status 500' } });
    expect(nodeRes.redir).toEqual({ err: { name: 'MasterError', kind: 'http', status: 302, message: 'api/geo: status 302' } });
    expect(nodeRes.bad).toEqual({ err: { name: 'MasterError', kind: 'invalid-response', status: 0, message: 'api/geo: invalid JSON' } });
    expect(nodeRes.merr).toEqual({ err: { name: 'MasterError', kind: 'master', status: 0, message: 'api/geo: bad token' } });
    expect(nodeRes.slow).toEqual({ err: { name: 'MasterError', kind: 'network', status: 0, message: 'timeout' } });
    expect((nodeRes.refused as { err: MasterError }).err.kind).toBe('network');
    const host = seen.find((s) => s.url === '/rs/api/host')!;
    expect(host.method).toBe('POST');
    expect(host.body).toBe('token=tok%20en&rcr=r%26c');
  });

  it.skipIf(bunExe === '')('Bun: fetch path, same results; node:http path when a proxy env var is set', async () => {
    seen.length = 0;
    const viaFetch = await runBun(cleanEnv());
    expect(viaFetch.fetchCalls).toBe(9);
    expect(normalize(viaFetch.res)).toEqual(normalize(nodeRes));
    const host = seen.find((s) => s.url === '/rs/api/host')!;
    expect(host.body).toBe('token=tok%20en&rcr=r%26c');
    expect(host.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(host.headers['content-length']).toBe(String('token=tok%20en&rcr=r%26c'.length));
    expect(host.headers['x-extra']).toBe('e1');

    // HTTP_PROXY pointing nowhere: Bun's fetch would use it, node:http ignores it.
    const viaHttp = await runBun({ ...cleanEnv(), HTTP_PROXY: 'http://127.0.0.1:9' });
    expect(viaHttp.fetchCalls).toBe(0);
    expect(normalize(viaHttp.res)).toEqual(normalize(nodeRes));
  }, 60_000);
});
