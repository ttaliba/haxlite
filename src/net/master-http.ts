/**
 * Master server HTTP client (docs/01 §1.2): `POST api/host`, `GET api/geo`,
 * `GET api/list`. Responses use the `{data}` / `{error}` envelope (`T.Ih`).
 *
 * Uses node:http/https so an `agent` (e.g. an HTTP(S)/SOCKS proxy agent) can
 * be plugged in; the base URL is configurable for tests, proxies and custom
 * backends. node:http(s) is loaded on the first request that needs it.
 *
 * On Bun, without `agent` and without proxy environment variables, requests go
 * through the built-in `fetch` instead and node:http(s) is never loaded
 * (import of the package: ~13 ms and ~3.6 MB RSS less). Same method, URL,
 * body, our headers, timeout (`MasterError('network', 'timeout')`), no
 * redirects followed (a 3xx is an `http` error, as with node:http), same error
 * kinds. Differences: Bun's fetch adds `User-Agent: Bun/<v>` (override it with
 * `headers`), `Accept` (any type) and `Accept-Encoding` (the body is decompressed
 * transparently), network error messages are Bun's, and the timeout bounds the
 * whole request instead of socket inactivity. Bun's fetch would honour
 * HTTP(S)_PROXY / ALL_PROXY while node:http ignores them: when any is set, the
 * node:http path is used, so the master is reached exactly as before.
 */
import type { Agent } from 'node:http';
import { createRequire } from 'node:module';
import { DEFAULT_MASTER_URL } from './constants.js';
import { parseRoomList, type ListedRoom } from './room-info.js';

export interface MasterHttpOptions {
  /** Base URL ending in `/` (default `https://www.haxball.com/rs/`). */
  masterUrl?: string;
  /** Agent for proxies (`https-proxy-agent`, `socks-proxy-agent`…). */
  agent?: Agent;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Request timeout (default 15 s). */
  timeoutMs?: number;
}

export type MasterErrorKind =
  /** The token is invalid/expired: the master asks for a captcha instead. */
  | 'recaptcha'
  /** `{error: …}` envelope. */
  | 'master'
  /** Non-2xx status. */
  | 'http'
  /** Socket/DNS/timeout. */
  | 'network'
  /** Unparseable body or missing fields. */
  | 'invalid-response';

export class MasterError extends Error {
  override name = 'MasterError';
  readonly kind: MasterErrorKind;
  /** Captcha site key when `kind === 'recaptcha'`. */
  readonly sitekey: string | null;
  readonly status: number;

  constructor(kind: MasterErrorKind, message: string, opts: { sitekey?: string | null; status?: number } = {}) {
    super(message);
    this.kind = kind;
    this.sitekey = opts.sitekey ?? null;
    this.status = opts.status ?? 0;
  }
}

export type HostSession =
  | { action: 'connect'; url: string; token: string }
  | { action: 'recaptcha'; sitekey: string };

/**
 * `POST api/host` with `token=<headless token>&rcr=<captcha response>` (`Aa.be`).
 * Resolves with the WS url + signaling token, or with the captcha request the
 * master returns for invalid/expired tokens.
 */
export async function requestHostSession(token: string, rcr = '', opts: MasterHttpOptions = {}): Promise<HostSession> {
  const body = `token=${encodeURIComponent(token)}&rcr=${encodeURIComponent(rcr)}`;
  const data = (await requestJson('POST', 'api/host', opts, body, 'application/x-www-form-urlencoded')) as Record<string, unknown>;
  switch (data?.action) {
    case 'connect': {
      if (typeof data.url !== 'string' || typeof data.token !== 'string') {
        throw new MasterError('invalid-response', 'api/host: missing url/token');
      }
      return { action: 'connect', url: data.url, token: data.token };
    }
    case 'recaptcha': {
      if (typeof data.sitekey !== 'string') throw new MasterError('invalid-response', 'api/host: missing sitekey');
      return { action: 'recaptcha', sitekey: data.sitekey };
    }
    default:
      throw new MasterError('invalid-response', `api/host: unknown action ${String(data?.action)}`);
  }
}

export interface GeoLocation {
  /** Lowercased country code (`ia.Ue`: `code.toLowerCase()`). */
  flag: string;
  lat: number;
  lon: number;
}

/** `GET api/geo` (`ia.Sg`). */
export async function fetchGeo(opts: MasterHttpOptions = {}): Promise<GeoLocation> {
  const d = (await requestJson('GET', 'api/geo', opts)) as { code?: unknown; lat?: unknown; lon?: unknown };
  if (typeof d?.code !== 'string' || typeof d.lat !== 'number' || typeof d.lon !== 'number') {
    throw new MasterError('invalid-response', 'api/geo: bad payload');
  }
  return { flag: d.code.toLowerCase(), lat: d.lat, lon: d.lon };
}

/** `GET api/list` (binary). */
export async function fetchRoomList(opts: MasterHttpOptions = {}): Promise<ListedRoom[]> {
  const res = await request('GET', 'api/list', opts);
  return parseRoomList(res.body);
}

// ------------------------------------------------------------------ plumbing

interface RawResponse {
  status: number;
  body: Uint8Array;
}

async function requestJson(
  method: string,
  path: string,
  opts: MasterHttpOptions,
  body?: string,
  contentType?: string,
): Promise<unknown> {
  const res = await request(method, path, opts, body, contentType);
  let json: { data?: unknown; error?: unknown };
  try {
    json = JSON.parse(new TextDecoder().decode(res.body)) as typeof json;
  } catch {
    throw new MasterError('invalid-response', `${path}: invalid JSON`);
  }
  if (json == null || typeof json !== 'object') throw new MasterError('invalid-response', `${path}: empty response`);
  if (json.error != null) throw new MasterError('master', `${path}: ${String(json.error)}`);
  return json.data;
}

// CJS require on purpose: the ESM facade of node:http(s) evaluates the lazy
// `WebSocket`/`CloseEvent`/`MessageEvent` getters, loading undici (~35 ms of startup).
let httpMod: typeof import('node:http') | null = null;
let httpsMod: typeof import('node:https') | null = null;
function nodeHttp(secure: boolean): typeof import('node:http') | typeof import('node:https') {
  const require = createRequire(import.meta.url);
  if (secure) return (httpsMod ??= require('node:https') as typeof import('node:https'));
  return (httpMod ??= require('node:http') as typeof import('node:http'));
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
function useFetch(opts: MasterHttpOptions): boolean {
  if (!isBun || opts.agent !== undefined || typeof globalThis.fetch !== 'function') return false;
  const env = process.env;
  for (const k of PROXY_ENV) if (env[k]) return false;
  return true;
}

function request(method: string, path: string, opts: MasterHttpOptions, body?: string, contentType?: string): Promise<RawResponse> {
  const url = new URL(path, opts.masterUrl ?? DEFAULT_MASTER_URL);
  const headers: Record<string, string> = { ...opts.headers };
  if (contentType) headers['Content-Type'] = contentType;
  if (useFetch(opts)) return requestFetch(method, path, url, headers, opts.timeoutMs ?? 15_000, body);
  if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
  const mod = nodeHttp(url.protocol === 'https:');
  return new Promise<RawResponse>((resolve, reject) => {
    const req = mod.request(url, { method, headers, agent: opts.agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', (e) => reject(new MasterError('network', e.message)));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new MasterError('http', `${path}: status ${status}`, { status }));
          return;
        }
        resolve({ status, body: new Uint8Array(Buffer.concat(chunks)) });
      });
    });
    req.setTimeout(opts.timeoutMs ?? 15_000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e instanceof MasterError ? e : new MasterError('network', e.message)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Bun: the same request through the built-in fetch (see the header comment). */
async function requestFetch(method: string, path: string, url: URL, headers: Record<string, string>, timeoutMs: number, body?: string): Promise<RawResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const fail = (e: unknown): MasterError => new MasterError('network', ac.signal.aborted ? 'timeout' : String((e as Error)?.message ?? e));
  try {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, redirect: 'manual', signal: ac.signal });
    } catch (e) {
      throw fail(e);
    }
    let data: ArrayBuffer;
    try {
      data = await res.arrayBuffer();
    } catch (e) {
      throw fail(e);
    }
    const status = res.status;
    if (status < 200 || status >= 300) throw new MasterError('http', `${path}: status ${status}`, { status });
    return { status, body: new Uint8Array(data) };
  } finally {
    clearTimeout(timer);
  }
}
