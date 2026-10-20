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
 * `headers`) and `Accept` (any type), network error messages are Bun's, and the
 * timeout bounds the whole request instead of socket inactivity. Bun's fetch
 * would honour HTTP(S)_PROXY / ALL_PROXY while node:http ignores them: when any
 * is set, the node:http path is used, so the master is reached exactly as before.
 *
 * Responses are untrusted input: the body is capped per endpoint (see
 * {@link JSON_BODY} / {@link LIST_BODY}; over the cap is an `invalid-response`
 * error) and `timeoutMs` also bounds the whole exchange, so neither an endless
 * nor a trickling body can hold memory or the caller. On Bun the request asks
 * for `Accept-Encoding: identity` and turns decompression off, so a compressed
 * reply is refused rather than inflated beyond the cap.
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
  /**
   * Request timeout (default 15 s): socket inactivity and also the total time
   * of the exchange (the room list gets twice that).
   */
  timeoutMs?: number;
  /** Aborts the request in flight; it then rejects with `MasterError('network', 'aborted')`. */
  signal?: AbortSignal;
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
  const res = await request('GET', 'api/list', opts, undefined, undefined, LIST_BODY);
  return parseRoomList(res.body);
}

// ------------------------------------------------------------------ plumbing

interface RawResponse {
  status: number;
  body: Uint8Array;
}

/** Cap on a response body and the factor of `timeoutMs` allowed for the whole exchange. */
interface BodyLimit {
  maxBytes: number;
  deadlineFactor: number;
}
/** `api/host` / `api/geo`: JSON of a few hundred bytes. */
const JSON_BODY: BodyLimit = { maxBytes: 64 * 1024, deadlineFactor: 1 };
/** `api/list`: ~100 bytes per public room, the only sizeable transfer. */
const LIST_BODY: BodyLimit = { maxBytes: 8 * 1024 * 1024, deadlineFactor: 2 };

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

function request(
  method: string,
  path: string,
  opts: MasterHttpOptions,
  body?: string,
  contentType?: string,
  limit: BodyLimit = JSON_BODY,
): Promise<RawResponse> {
  const url = new URL(path, opts.masterUrl ?? DEFAULT_MASTER_URL);
  const headers: Record<string, string> = { ...opts.headers };
  if (contentType) headers['Content-Type'] = contentType;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  if (useFetch(opts)) return requestFetch(method, path, url, headers, timeoutMs, limit, opts.signal, body);
  if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
  const mod = nodeHttp(url.protocol === 'https:');
  return new Promise<RawResponse>((resolve, reject) => {
    let total: NodeJS.Timeout | undefined;
    const ok = (value: RawResponse): void => {
      clearTimeout(total);
      resolve(value);
    };
    // The first outcome wins, so the error kind does not depend on which event follows the destroy.
    const ko = (err: MasterError): void => {
      clearTimeout(total);
      reject(err);
    };
    const abort = (err: MasterError): void => {
      ko(err);
      req.destroy();
    };
    const req = mod.request(url, { method, headers, agent: opts.agent, signal: opts.signal }, (res) => {
      res.on('error', (e) => ko(netError(e, opts.signal)));
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        abort(new MasterError('http', `${path}: status ${status}`, { status }));
        return;
      }
      if (Number(res.headers['content-length']) > limit.maxBytes) {
        abort(tooLarge(path));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit.maxBytes) {
          chunks.length = 0;
          abort(tooLarge(path));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => ok({ status, body: new Uint8Array(Buffer.concat(chunks)) }));
    });
    // Socket inactivity, plus a deadline for the whole exchange (a trickling body never idles).
    req.setTimeout(timeoutMs, () => abort(timeoutError()));
    if (timeoutMs > 0) total = setTimeout(() => abort(timeoutError()), timeoutMs * limit.deadlineFactor);
    req.on('error', (e) => ko(netError(e, opts.signal)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Bun: the same request through the built-in fetch (see the header comment). */
async function requestFetch(
  method: string,
  path: string,
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  limit: BodyLimit,
  signal: AbortSignal | undefined,
  body?: string,
): Promise<RawResponse> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs * limit.deadlineFactor);
  const onAbort = (): void => ac.abort();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const fail = (e: unknown): MasterError =>
    timedOut ? timeoutError() : netError(e instanceof Error ? e : new Error(String(e)), signal);
  let done = false;
  try {
    let res: Response;
    try {
      // Compressed replies are refused instead of inflated: the cap below counts what the
      // application receives, and a tiny gzip body can inflate to gigabytes.
      const init = { method, headers: { ...headers, 'Accept-Encoding': 'identity' }, body, redirect: 'manual', signal: ac.signal, decompress: false };
      res = await fetch(url, init as RequestInit);
    } catch (e) {
      throw fail(e);
    }
    const status = res.status;
    if (status < 200 || status >= 300) throw new MasterError('http', `${path}: status ${status}`, { status });
    const encoding = res.headers.get('content-encoding');
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      throw new MasterError('invalid-response', `${path}: unsupported content-encoding`);
    }
    if (Number(res.headers.get('content-length')) > limit.maxBytes) throw tooLarge(path);
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader !== undefined) {
      const chunk = await reader.read().catch((e: unknown) => {
        throw fail(e);
      });
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit.maxBytes) throw tooLarge(path);
      parts.push(chunk.value);
    }
    done = true;
    return { status, body: parts.length === 1 ? parts[0]! : concatBytes(parts, size) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (!done) ac.abort(); // release the connection (and any unread body) on every failure
  }
}

function concatBytes(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const tooLarge = (path: string): MasterError => new MasterError('invalid-response', `${path}: response too large`);
const timeoutError = (): MasterError => new MasterError('network', 'timeout');
const netError = (e: Error, signal: AbortSignal | undefined): MasterError =>
  e instanceof MasterError ? e : new MasterError('network', signal?.aborted ? 'aborted' : e.message);
