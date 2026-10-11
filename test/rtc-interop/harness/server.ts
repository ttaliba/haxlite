/**
 * Interop harness server: serves the test page, signals over a local
 * WebSocket like the official host does through the master (answer after
 * waiting ≤ 500 ms for gathering, then trickle), and runs a small app on the
 * three channels of each peer (pong on pings; in `bench` mode the HaxBall-
 * like host traffic of docs/04).
 *
 * The ICE path can be pinned to one address (`address`: 127.0.0.1 loopback,
 * the eth0 address, ::1…) and optionally routed through a
 * {@link UdpImpairProxy}: the server's candidate is then replaced by the
 * proxy's in the answer and the browser's candidates are not forwarded.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PeerLink } from '../../../src/net/peer-backend.js';
import { createBackend, type BackendHandle, type BackendKind } from './backends.js';
import { UdpImpairProxy, type ImpairOptions } from './udp-proxy.js';
import { HEADER, Kind, makeMsg, now, Recorder } from './wire.js';

export interface InteropServerOptions {
  backend: BackendKind;
  /** ICE address of the server (only candidates with this address are advertised). Default 127.0.0.1. */
  address?: string;
  /** Route ICE through an impairment proxy (null/undefined = direct). */
  impair?: ImpairOptions | null;
  /** HTTP/WS listen host/port. Default 127.0.0.1:0. */
  httpHost?: string;
  httpPort?: number;
  /** `test`: pong only. `bench`: HaxBall-like host traffic (heartbeats, event broadcast). */
  app?: 'test' | 'bench';
  /** Wait for the server's ICE gathering before answering (official host: 500 ms). */
  answerWaitMs?: number;
  /** haxlite-rtc ICE consent timeout (ms). */
  idleTimeoutMs?: number;
  /** Log signaling/peer events. */
  verbose?: boolean;
}

export interface CloseInfo {
  /** What the backend reported first: a channel index close or the connection state. */
  first: string;
  t: number;
}

export class ServerPeer {
  readonly rec = new Recorder();
  readonly open = [false, false, false];
  openedAt = 0;
  closed: CloseInfo | null = null;
  /** Bytes the server failed to send (send() returned false). */
  sendFailures = 0;
  readonly sendSeq = [0, 0, 0];
  /** Sends redirected to channel 0 because the requested channel was not open (official fallback). */
  fallbacks = 0;
  /** Open time of each channel (ms, `now()`), 0 = not yet. */
  readonly openAt = [0, 0, 0];
  proxy: UdpImpairProxy | null = null;
  remoteAddress: string | null = null;
  private openWaiters: (() => void)[] = [];
  private closeWaiters: (() => void)[] = [];
  /** Heartbeat bookkeeping (bench app). */
  lastHbFrame = 0;

  constructor(
    readonly id: number,
    readonly tag: string,
    public link: PeerLink | null,
  ) {}

  get isOpen(): boolean {
    return this.open[0] === true && this.closed === null;
  }

  send(ch: number, data: Uint8Array): boolean {
    const l = this.link;
    if (l === null || this.closed !== null) return false;
    // official host `Za.pb`: falls back to channel 0 when `ch` is not open
    const target = this.open[ch] ? ch : 0;
    if (target !== ch) this.fallbacks++;
    const ok = l.send(target, data);
    if (!ok) this.sendFailures++;
    return ok;
  }

  burst(ch: number, n: number, size: number): number {
    let ok = 0;
    for (let k = 0; k < n; k++) if (this.send(ch, makeMsg(Kind.Data, this.sendSeq[ch]!++, size))) ok++;
    return ok;
  }

  close(): void {
    const l = this.link;
    this.link = null;
    if (l !== null) l.close();
    this.markClosed('server-close');
  }

  markOpen(): void {
    if (this.openedAt === 0) this.openedAt = now();
    const w = this.openWaiters;
    this.openWaiters = [];
    for (const f of w) f();
  }

  markClosed(first: string): void {
    if (this.closed === null) this.closed = { first, t: now() };
    // keep the proxy a little longer: the close itself (SCTP ABORT/SHUTDOWN, DTLS
    // close_notify, retransmissions) must still reach the browser through it
    const px = this.proxy;
    if (px !== null) setTimeout(() => px.close(), 5_000).unref();
    const w = this.closeWaiters;
    this.closeWaiters = [];
    for (const f of w) f();
  }

  /** Channel 0 open (= the official "connected"); `all` waits for the three channels. */
  async whenOpen(timeoutMs = 15_000, all = false): Promise<void> {
    if (!this.open[0]) await waitFor(this.openWaiters, timeoutMs, `peer ${this.tag} open`);
    if (!all) return;
    const end = Date.now() + timeoutMs;
    while (!(this.open[1] && this.open[2])) {
      if (this.closed !== null || Date.now() > end) throw new Error(`peer ${this.tag}: channels ${this.open.join('/')} (closed: ${this.closed?.first})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  whenClosed(timeoutMs = 15_000): Promise<void> {
    if (this.closed !== null) return Promise.resolve();
    return waitFor(this.closeWaiters, timeoutMs, `peer ${this.tag} close`);
  }
}

function waitFor(list: (() => void)[], ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms);
    list.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

const HARNESS_DIR = new URL('./', import.meta.url);

function pageHtml(title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head><body>
<pre id="log">loading…</pre>
<script type="module">
import { Harness } from './client.js';
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
window.hx = new Harness(proto + '//' + location.host);
document.getElementById('log').textContent = 'ready';
window.hxReady = true;
</script></body></html>`;
}

/** Parses a candidate line (with or without `a=`): address, port, transport. */
export function parseCand(line: string): { address: string; port: number; transport: string } | null {
  const p = (line.startsWith('a=') ? line.slice(2) : line).split(' ');
  if (p.length < 8 || p[6] !== 'typ') return null;
  return { address: p[4]!, port: Number(p[5]), transport: p[2]!.toLowerCase() };
}

function rewriteCand(line: string, address: string, port: number): string {
  const p = (line.startsWith('a=') ? line.slice(2) : line).split(' ');
  p[4] = address;
  p[5] = String(port);
  return p.join(' ');
}

export class InteropServer {
  readonly peers = new Map<string, ServerPeer>();
  readonly errors: string[] = [];
  readonly opts: Required<Omit<InteropServerOptions, 'impair'>> & { impair: ImpairOptions | null };
  private http!: http.Server;
  private wss!: WebSocketServer;
  private nextId = 1;
  private peerWaiters = new Map<string, (() => void)[]>();
  private tick: NodeJS.Timeout | null = null;
  private readonly t0 = performance.now();
  private eventSeq = 0;
  private hbSeq = 0;
  handle!: BackendHandle;
  url = '';

  private constructor(o: InteropServerOptions) {
    this.opts = {
      backend: o.backend,
      address: o.address ?? '127.0.0.1',
      impair: o.impair ?? null,
      httpHost: o.httpHost ?? '127.0.0.1',
      httpPort: o.httpPort ?? 0,
      app: o.app ?? 'test',
      answerWaitMs: o.answerWaitMs ?? 500,
      idleTimeoutMs: o.idleTimeoutMs ?? 30_000,
      verbose: o.verbose ?? false,
    };
  }

  static async start(o: InteropServerOptions): Promise<InteropServer> {
    const s = new InteropServer(o);
    await s.init();
    return s;
  }

  private log(...a: unknown[]): void {
    if (this.opts.verbose) console.log('[interop]', ...a);
  }

  private async init(): Promise<void> {
    this.handle = await createBackend(this.opts.backend, { address: this.opts.address, idleTimeoutMs: this.opts.idleTimeoutMs });
    const wire = stripTypeScriptTypes(readFileSync(new URL('wire.ts', HARNESS_DIR), 'utf8'));
    const client = readFileSync(new URL('client.js', HARNESS_DIR), 'utf8');
    this.http = http.createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const js = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      };
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pageHtml(`haxlite-rtc interop (${this.opts.backend})`));
      } else if (path === '/client.js') js(client);
      else if (path === '/wire.js') js(wire);
      else if (path === '/selftest.html' || path === '/selftest.js') {
        try {
          const f = readFileSync(new URL('..' + path, HARNESS_DIR), 'utf8');
          res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
          res.end(f);
        } catch {
          res.writeHead(404).end();
        }
      } else res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws, req) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/client') this.onSignal(ws, u.searchParams.get('tag') ?? `anon-${this.nextId}`);
      else if (u.pathname === '/control') this.onControl(ws);
      else ws.close(4000);
    });
    await new Promise<void>((resolve) => this.http.listen(this.opts.httpPort, this.opts.httpHost, resolve));
    const a = this.http.address() as AddressInfo;
    const host = a.family === 'IPv6' ? `[${a.address}]` : a.address;
    this.url = `http://${host}:${a.port}`;
    this.tick = setInterval(() => this.onTick(), 50);
  }

  /** Signaling of one join attempt (official master `client` socket + host `la` logic). */
  private onSignal(ws: WebSocket, tag: string): void {
    let peer: ServerPeer | null = null;
    let answered = false;
    const localCands: { candidate: string; mid: string }[] = [];
    let gathered: () => void = () => {};
    const gatheredP = new Promise<void>((r) => (gathered = r));
    const o = this.opts;
    const keep = (line: string): boolean => {
      const c = parseCand(line);
      return c !== null && c.address === o.address && c.transport === 'udp';
    };
    const toJson = (c: { candidate: string; mid: string }) => ({
      candidate: c.candidate.startsWith('a=') ? c.candidate.slice(2) : c.candidate,
      sdpMid: c.mid,
      sdpMLineIndex: 0,
    });
    const send = (m: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };

    ws.on('message', (raw) => {
      let m: { t: string; sdp?: string; cands?: { candidate: string; sdpMid?: string }[]; c?: { candidate: string; sdpMid?: string } };
      try {
        m = JSON.parse(String(raw));
      } catch {
        ws.close(4000);
        return;
      }
      if (m.t === 'offer' && peer === null) {
        const id = this.nextId++;
        const p = new ServerPeer(id, tag, null);
        peer = p;
        const old = this.peers.get(tag);
        if (old !== undefined && old.closed === null) old.close();
        this.peers.set(tag, p);
        let answerSdp = '';
        try {
          p.link = this.handle.backend.createPeer(id, m.sdp ?? '', {
            onLocalDescription: (sdp) => (answerSdp = sdp),
            onLocalCandidate: (candidate, mid) => {
              if (!answered) localCands.push({ candidate, mid });
              else if (o.impair === null && keep(candidate)) send({ t: 'cand', c: toJson({ candidate, mid }) });
            },
            onGatheringComplete: () => gathered(),
            onChannelOpen: (i, addr) => {
              p.open[i] = true;
              p.openAt[i] = now();
              if (i === 0) {
                p.remoteAddress = addr;
                p.markOpen();
                this.log('open', tag, addr);
              }
            },
            onChannelClosed: (i) => {
              p.open[i] = false;
              if (p.closed === null) p.markClosed(`channel-${i}`);
            },
            onMessage: (i, data) => this.onPeerMessage(p, i, data),
            onConnectionState: (state) => {
              p.open[0] = p.open[1] = p.open[2] = false;
              if (p.closed === null) p.markClosed(`pc-${state}`);
            },
            onAbuse: () => {},
            onError: (err) => this.errors.push(`${tag}: ${err.message}`),
          });
        } catch (err) {
          this.errors.push(`${tag}: createPeer: ${(err as Error).message}`);
          ws.close(4000);
          return;
        }
        this.wakePeerWaiters(tag);
        if (o.impair === null) for (const c of m.cands ?? []) p.link?.addRemoteCandidate(c.candidate, c.sdpMid ?? '0');
        void (async () => {
          await Promise.race([gatheredP, new Promise((r) => setTimeout(r, o.answerWaitMs))]);
          let cands = localCands.filter((c) => keep(c.candidate));
          let sdp = answerSdp
            .split(/\r\n/)
            .filter((l) => !l.startsWith('a=candidate:') || (o.impair === null && keep(l)))
            .join('\r\n');
          if (o.impair !== null) {
            const real = cands.map((c) => parseCand(c.candidate)!)[0];
            if (real === undefined) {
              this.errors.push(`${tag}: no server candidate on ${o.address} to proxy`);
              ws.close(4000);
              return;
            }
            const proxy = await UdpImpairProxy.start({ address: real.address, port: real.port }, o.impair, o.address);
            p.proxy = proxy;
            if (p.closed !== null) proxy.close();
            const pa = proxy.address;
            cands = [{ candidate: rewriteCand(cands[0]!.candidate, pa.address, pa.port), mid: cands[0]!.mid }];
          }
          answered = true;
          this.log('answer', tag, cands.map((c) => c.candidate));
          send({ t: 'answer', sdp, cands: cands.map(toJson) });
        })();
      } else if (m.t === 'cand' && peer !== null && o.impair === null && m.c != null) {
        peer.link?.addRemoteCandidate(m.c.candidate, m.c.sdpMid ?? '0');
      }
    });
    ws.on('error', () => {});
  }

  /** Control socket of the self-test page: `{id, cmd, tag, ch, n, size}` → `{id, ok, result}`. */
  private onControl(ws: WebSocket): void {
    ws.on('message', async (raw) => {
      let m: { id: number; cmd: string; tag: string; ch?: number; n?: number; size?: number };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const reply = (result: unknown, ok = true) => ws.send(JSON.stringify({ id: m.id, ok, result }));
      const p = this.peers.get(m.tag);
      try {
        if (m.cmd === 'info') return reply({ backend: this.opts.backend, address: this.opts.address, impair: this.opts.impair });
        if (p === undefined) return reply('unknown peer', false);
        if (m.cmd === 'burst') return reply(p.burst(m.ch ?? 0, m.n ?? 1, m.size ?? 64));
        if (m.cmd === 'stats') return reply(this.peerStats(p));
        if (m.cmd === 'close') {
          p.close();
          return reply(true);
        }
        reply('unknown cmd', false);
      } catch (err) {
        reply(String(err), false);
      }
    });
  }

  peerStats(p: ServerPeer): unknown {
    return {
      tag: p.tag,
      open: p.open.slice(),
      closed: p.closed,
      sent: p.sendSeq.slice(),
      sendFailures: p.sendFailures,
      fallbacks: p.fallbacks,
      openAt: p.openAt.slice(),
      rx: p.rec.snapshot(false),
      proxy: p.proxy?.stats ?? null,
    };
  }

  private onPeerMessage(p: ServerPeer, ch: number, data: string | Uint8Array): void {
    const h = p.rec.record(ch, data);
    if (h === null) return;
    if (h.kind === Kind.Ping) {
      // official host: ping reply `[4][f64 tHost][f64 echo]` on uu
      const m = makeMsg(Kind.Pong, h.seq, HEADER + 8, h.ts);
      new DataView(m.buffer).setFloat64(HEADER, now());
      p.send(2, m);
    } else if (h.kind === Kind.Input && this.opts.app === 'bench' && typeof data !== 'string' && data.byteLength >= HEADER + 4) {
      // official host: validate, stamp a frame and re-broadcast the action to everyone on ru
      const origin = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(HEADER);
      const ev = makeMsg(Kind.Event, this.eventSeq++, HEADER + 12 + 6);
      const v = new DataView(ev.buffer);
      v.setUint32(HEADER, origin);
      v.setFloat64(HEADER + 4, h.ts);
      for (const q of this.peers.values()) if (q.isOpen) q.send(1, ev);
    }
  }

  /** 50 ms host tick (`Wa.Da`): heartbeat `[3][u32 frame][u32 n]` on uu every ≥ 7 frames. */
  private onTick(): void {
    if (this.opts.app !== 'bench') return;
    const frame = Math.floor((performance.now() - this.t0) * 0.06);
    let hb: Uint8Array | null = null;
    for (const p of this.peers.values()) {
      if (!p.isOpen || frame - p.lastHbFrame < 7) continue;
      p.lastHbFrame = frame;
      hb ??= makeMsg(Kind.Heartbeat, this.hbSeq++, HEADER + 4);
      p.send(2, hb);
    }
  }

  private wakePeerWaiters(tag: string): void {
    const w = this.peerWaiters.get(tag);
    if (w === undefined) return;
    this.peerWaiters.delete(tag);
    for (const f of w) f();
  }

  /** The server-side peer of `tag` once its offer arrived. */
  async peer(tag: string, timeoutMs = 15_000): Promise<ServerPeer> {
    const p = this.peers.get(tag);
    if (p !== undefined) return p;
    const list = this.peerWaiters.get(tag) ?? [];
    this.peerWaiters.set(tag, list);
    await waitFor(list, timeoutMs, `offer of ${tag}`);
    return this.peers.get(tag)!;
  }

  openPeers(): ServerPeer[] {
    return [...this.peers.values()].filter((p) => p.isOpen);
  }

  async close(): Promise<void> {
    if (this.tick !== null) clearInterval(this.tick);
    for (const p of this.peers.values()) {
      if (p.closed === null) p.close();
      p.proxy?.close();
    }
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
    await this.handle.close();
  }
}
