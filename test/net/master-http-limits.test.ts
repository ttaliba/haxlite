/**
 * Master HTTP client against a hostile master: endless, trickling, oversized
 * and compressed bodies, and aborted requests. Responses are capped per
 * endpoint and `timeoutMs` bounds the whole exchange, on both the node:http
 * path (this process) and the Bun fetch path (a `bun` child, skipped without
 * bun). Both must give the same outcomes.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchGeo, fetchRoomList, requestHostSession } from '../../src/net/master-http.js';
import { defaultRoomInfo, encodeRoomInfo, encodeRoomList } from '../../src/net/room-info.js';

const JSON_CAP = 64 * 1024;
const HOST_JSON = '{"data":{"action":"connect","url":"wss://x/host","token":"t"}}';
const GEO_JSON = '{"data":{"code":"AR","lat":1.5,"lon":-2}}';
const pad = (json: string, size: number): string => json + ' '.repeat(size - json.length);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition timeout');
    await sleep(10);
  }
}

let active = 0; // responses the server is still writing (or holding open)
let bomb: Buffer;
let bigList: Buffer;
const block = Buffer.alloc(64 * 1024, 0x20);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  const m = /^\/rs\/([a-z0-9]+)\/api\/([a-z]+)$/.exec(req.url ?? '');
  const mode = m?.[1] ?? '';
  const api = m?.[2] ?? '';
  const track = (): void => {
    active++;
    res.on('close', () => active--);
  };
  const jsonOf = (size: number): string => pad(api === 'host' ? HOST_JSON : GEO_JSON, size);
  switch (mode) {
    case 'endless': {
      track();
      res.writeHead(200);
      const pump = (): void => {
        while (!res.destroyed && !res.writableEnded) {
          if (!res.write(block)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
      return;
    }
    case 'e500': {
      track();
      res.writeHead(500);
      const pump = (): void => {
        while (!res.destroyed && !res.writableEnded) {
          if (!res.write(block)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
      return;
    }
    case 'drip': {
      track();
      res.writeHead(200);
      res.flushHeaders();
      const t = setInterval(() => res.write(' '), 20);
      res.on('close', () => clearInterval(t));
      return;
    }
    case 'clen':
      track();
      res.writeHead(200, { 'Content-Length': String(1e9) });
      res.flushHeaders();
      return;
    case 'slow':
      track();
      return;
    case 'atcap':
      res.writeHead(200);
      res.end(jsonOf(JSON_CAP));
      return;
    case 'overcap':
      res.writeHead(200);
      res.end(jsonOf(JSON_CAP + 1));
      return;
    case 'biglist':
      res.writeHead(200);
      res.end(bigList);
      return;
    case 'gzip':
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end(bomb);
      return;
    default:
      res.writeHead(404);
      res.end();
  }
});

let base = '';
beforeAll(async () => {
  const inflated = Buffer.alloc(64 * 1024 * 1024, 0x20);
  inflated.write(GEO_JSON);
  bomb = gzipSync(inflated);
  const info = encodeRoomInfo(defaultRoomInfo());
  bigList = Buffer.from(encodeRoomList(Array.from({ length: 20_000 }, (_, i) => ({ id: `room${String(i).padStart(7, '0')}`, info }))));
  expect(bigList.length).toBeGreaterThan(JSON_CAP);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rs/`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

type Outcome = { ok: unknown; ms: number } | { err: { name: string; kind: string; status: number; message: string }; ms: number } | { pending: true; ms: number };

/** The same scenario, as source, for this process and for the bun child. */
const SCENARIO = `
async function scenario(M, base) {
  const run = async (f, wait = 5000) => {
    const t0 = Date.now();
    const out = await Promise.race([
      f().then((v) => ({ ok: v }), (e) => ({ err: { name: e.name, kind: e.kind, status: e.status, message: e.message } })),
      new Promise((r) => setTimeout(() => r({ pending: true }), wait)),
    ]);
    out.ms = Date.now() - t0;
    return out;
  };
  const at = (mode, timeoutMs = 3000) => ({ masterUrl: base + mode + '/', timeoutMs });
  const late = new AbortController();
  setTimeout(() => late.abort(), 50);
  const early = new AbortController();
  early.abort();
  return {
    endlessHost: await run(() => M.requestHostSession('t', '', at('endless'))),
    endlessGeo: await run(() => M.fetchGeo(at('endless'))),
    endlessList: await run(() => M.fetchRoomList(at('endless'))),
    declared: await run(() => M.fetchGeo(at('clen'))),
    drip: await run(() => M.fetchGeo(at('drip', 300))),
    e500: await run(() => M.fetchGeo(at('e500'))),
    atCapHost: await run(() => M.requestHostSession('t', '', at('atcap'))),
    atCapGeo: await run(() => M.fetchGeo(at('atcap'))),
    overCap: await run(() => M.fetchGeo(at('overcap'))),
    bigList: await run(() => M.fetchRoomList(at('biglist')).then((l) => l.length)),
    gzip: await run(() => M.fetchGeo(at('gzip'))),
    aborted: await run(() => M.fetchGeo({ ...at('slow'), signal: late.signal })),
    preAborted: await run(() => M.fetchGeo({ ...at('slow'), signal: early.signal })),
  };
}`;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const scenario = new Function(`${SCENARIO}; return scenario;`)() as (m: unknown, b: string) => Promise<Record<string, Outcome>>;

function expectHostile(r: Record<string, Outcome>, bun: boolean): void {
  const err = (o: Outcome) => ('err' in o ? o.err : null);
  for (const k of ['endlessHost', 'endlessGeo', 'endlessList', 'declared', 'overCap']) {
    expect(err(r[k]!), k).toMatchObject({ name: 'MasterError', kind: 'invalid-response' });
    expect(err(r[k]!)!.message, k).toMatch(/too large/);
    expect(r[k]!.ms, k).toBeLessThan(2500);
  }
  expect(err(r.drip!)).toMatchObject({ kind: 'network', message: 'timeout' }); // total deadline, not idle
  expect(r.drip!.ms).toBeGreaterThanOrEqual(250);
  expect(r.drip!.ms).toBeLessThan(2000);
  expect(err(r.e500!)).toMatchObject({ kind: 'http', status: 500 });
  expect(r.e500!.ms).toBeLessThan(2500);
  expect(r.atCapHost).toMatchObject({ ok: { action: 'connect', url: 'wss://x/host', token: 't' } });
  expect(r.atCapGeo).toMatchObject({ ok: { flag: 'ar', lat: 1.5, lon: -2 } });
  expect(r.bigList).toMatchObject({ ok: 20_000 });
  for (const k of ['aborted', 'preAborted']) {
    expect(err(r[k]!), k).toMatchObject({ name: 'MasterError', kind: 'network', message: 'aborted' });
    expect(r[k]!.ms, k).toBeLessThan(1500);
  }
  // A compressed body is never inflated: the Bun path refuses it, node:http (which never asks for one) cannot parse it.
  expect(err(r.gzip!)).toMatchObject({ kind: 'invalid-response' });
  if (bun) expect(err(r.gzip!)!.message).toMatch(/content-encoding|too large/);
}

const probe = spawnSync('bun -e "console.log(process.execPath)"', { encoding: 'utf8', shell: true });
const bunExe = probe.status === 0 ? probe.stdout.trim().split('\n').pop()!.trim() : '';

function runBun(): Promise<{ fetchCalls: number; res: Record<string, Outcome> }> {
  const mod = pathToFileURL(new URL('../../src/net/master-http.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href;
  const script = `
    ${SCENARIO}
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (...a) => { fetchCalls++; return realFetch(...a); };
    const M = await import(${JSON.stringify(mod)});
    const res = await scenario(M, ${JSON.stringify(base)});
    console.log(JSON.stringify({ fetchCalls, res }));
    process.exit(0);
  `;
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete env[k];
  return new Promise((resolve, reject) => {
    // async spawn: the server lives in this process
    const child = spawn(bunExe, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const t = setTimeout(() => child.kill(), 45_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`bun exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim().split('\n').pop()!));
    });
  });
}

describe('master HTTP client against a hostile master', () => {
  it('node:http path: capped bodies, total deadline, abort', async () => {
    const res = await scenario({ requestHostSession, fetchGeo, fetchRoomList }, base);
    expectHostile(res, false);
    await until(() => active === 0); // every endless / trickling / held response was torn down
  }, 60_000);

  it.skipIf(bunExe === '')('Bun fetch path: the same outcomes, compressed bodies refused', async () => {
    const { fetchCalls, res } = await runBun();
    expect(fetchCalls).toBe(13);
    expectHostile(res, true);
    await until(() => active === 0);
  }, 90_000);
});
