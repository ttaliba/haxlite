/**
 * Offline fake HaxBall master server (TEST ONLY).
 *
 * Implements the master side of both signaling protocols plus the HTTP API so
 * hosts and clients (official-compatible: node-haxball, haxlite) can meet
 * without touching haxball.com:
 *
 *   POST /rs/api/host    token=…&rcr=…  -> {data:{action:'connect', url:'ws://…/host', token}}
 *                                          or {data:{action:'recaptcha', sitekey}} (invalid token)
 *   POST /rs/api/client  room=…&rcr=…   -> {data:{action:'connect', token}}
 *   GET  /rs/api/list | /rs/api/geo | /rs/api/notice
 *   WS   /host?token=…                  host signaling (docs/01 §2.2)
 *   WS   /client?id=<room>[&token=…]    client signaling (docs/01 §2.3)
 *
 * The routing mirrors what clients/hosts read (docs/02 §2.2-2.3): a client's
 * `[1] deflate(offer…)` reaches the host as `[1][u32 peerId][u8 n][conn] +
 * the same deflated bytes`; `[4]` likewise; the host's `[0][peer][code]`
 * closes the client socket with `code`; `[1]/[4]` go back as `[type] +
 * deflated bytes`. `conn` = the client IP as ASCII text (overridable with
 * {@link FakeMaster.clientIp} to simulate remote clients).
 *
 * Usage (node-haxball): `require('node-haxball')(null, { backend: { hostname:
 * '127.0.0.1:PORT', hostnameWs: '127.0.0.1:PORT', secure: false } })`.
 * Usage (haxlite): `new HostTransport({ masterUrl: master.httpBase, token: 'any' })`.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { Reader, Writer } from '../../src/codec/index.js';
import { decodeRoomInfo, encodeRoomList, type RoomInfo } from '../../src/net/room-info.js';

export interface FakeRoom {
  readonly id: string;
  readonly ws: WebSocket;
  readonly origin: string | undefined;
  readonly headlessToken: string;
  /** Last RoomInfo bytes received (message 7), null if private. */
  infoBytes: Uint8Array | null;
  info: RoomInfo | null;
  roomInfoMessages: number;
  keepAlives: number;
  /** WS pings received from the host. */
  pings: number;
  /**
   * Simulates a blackholed TCP link: while true the master ignores everything
   * the host sends (no pongs, no message handling) but keeps the socket open.
   */
  blackholed: boolean;
  requireRecaptcha: boolean;
  readonly peers: Map<number, FakeClient>;
}

export interface FakeClient {
  readonly peerId: number;
  readonly ws: WebSocket;
  readonly ip: string;
  hostDone: boolean;
  clientDone: boolean;
  /** Close code sent by the host (`[0][peer][code]`), if any. */
  rejectCode: number | null;
}

export interface FakeMasterOptions {
  port?: number;
  host?: string;
  /** Tokens rejected with a captcha request (default: 'invalid', 'expired' and ''). */
  isValidToken?: (token: string) => boolean;
  /** Send message 6 (new token) after the room link (default true). */
  sendNewToken?: boolean;
  log?: (msg: string) => void;
}

export class FakeMaster {
  readonly rooms = new Map<string, FakeRoom>();
  /** Every host/client WS upgrade, for assertions (path, origin). */
  readonly upgrades: { path: string; origin: string | undefined }[] = [];
  /** Every `[0][peer][code]` rejection received from hosts. */
  readonly rejections: { peerId: number; code: number }[] = [];
  /** POST api/host bodies received. */
  readonly hostRequests: { token: string; rcr: string }[] = [];
  /** IP reported as `conn` for the next client connections (default: socket address). */
  clientIp: ((req: http.IncomingMessage) => string) | null = null;
  /** Fixed room id for the next host connection (default random 11 chars). */
  nextRoomId: string | null = null;
  /**
   * Every host → client signaling message relayed (`[1]` answer / `[4]`
   * candidate, payload still deflated) when set to an array: lets tests check
   * exactly what clients receive (e.g. that no host address leaks).
   */
  clientMessages: { peerId: number; type: number; payload: Uint8Array }[] | null = null;
  /**
   * When true, host WS upgrades (`/host`) are accepted at the TCP level but
   * never answered (simulates a stalled handshake). Stalled sockets are
   * counted in {@link stalledUpgrades} and destroyed on {@link close}.
   */
  stallHostUpgrades = false;
  stalledUpgrades = 0;
  private readonly stalled = new Set<import('node:stream').Duplex>();

  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly wsTokens = new Map<string, string>(); // ws token -> headless token
  private readonly opts: FakeMasterOptions;
  private nextPeerId = 1;
  private roomWaiters: ((room: FakeRoom) => void)[] = [];
  port = 0;

  private constructor(opts: FakeMasterOptions) {
    this.opts = opts;
    this.server = http.createServer((req, res) => this.onHttp(req, res));
    // autoPong off: pongs are sent by hand so a room can be "blackholed".
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, autoPong: false });
    this.server.on('upgrade', (req, socket, head) => {
      if (this.stallHostUpgrades && (req.url ?? '').startsWith('/host')) {
        this.stalledUpgrades++;
        this.stalled.add(socket);
        socket.on('close', () => this.stalled.delete(socket));
        socket.on('error', () => {});
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onWs(ws, req));
    });
  }

  static async start(opts: FakeMasterOptions = {}): Promise<FakeMaster> {
    const m = new FakeMaster(opts);
    await new Promise<void>((resolve) => m.server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
    m.port = (m.server.address() as AddressInfo).port;
    return m;
  }

  get hostPort(): string {
    return `${this.opts.host ?? '127.0.0.1'}:${this.port}`;
  }

  /** `http://127.0.0.1:PORT/rs/` (haxlite `masterUrl`). */
  get httpBase(): string {
    return `http://${this.hostPort}/rs/`;
  }

  /** `ws://127.0.0.1:PORT/` (append `host` / `client`). */
  get wsBase(): string {
    return `ws://${this.hostPort}/`;
  }

  /** node-haxball config pointing at this master. */
  get nodeHaxballConfig(): { backend: { hostname: string; hostnameWs: string; secure: boolean } } {
    return { backend: { hostname: this.hostPort, hostnameWs: this.hostPort, secure: false } };
  }

  /** Resolves with the next room that registers (or the only existing one). */
  waitForRoom(): Promise<FakeRoom> {
    return new Promise((resolve) => this.roomWaiters.push(resolve));
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    for (const s of this.stalled) s.destroy();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  // ---------------------------------------------------------------- HTTP

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${this.hostPort}`);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const json = (data: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ data }));
      };
      switch (`${req.method} ${url.pathname}`) {
        case 'POST /rs/api/host': {
          const token = body.get('token') ?? '';
          const rcr = body.get('rcr') ?? '';
          this.hostRequests.push({ token, rcr });
          const valid = this.opts.isValidToken ?? ((t: string) => t !== '' && t !== 'invalid' && t !== 'expired');
          if (!valid(token) && rcr === '') {
            json({ action: 'recaptcha', sitekey: 'fake-sitekey' });
            return;
          }
          const wsToken = randomBytes(12).toString('base64url');
          this.wsTokens.set(wsToken, token);
          json({ action: 'connect', url: `${this.wsBase}host`, token: wsToken });
          return;
        }
        case 'POST /rs/api/client':
          json({ action: 'connect', token: `client-${randomBytes(6).toString('base64url')}` });
          return;
        case 'GET /rs/api/geo':
          json({ code: 'AR', lat: -34.6, lon: -58.4 });
          return;
        case 'GET /rs/api/notice':
          json({ content: '' });
          return;
        case 'GET /rs/api/list': {
          const rooms = [...this.rooms.values()].filter((r) => r.infoBytes !== null).map((r) => ({ id: r.id, info: r.infoBytes! }));
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from(encodeRoomList(rooms)));
          return;
        }
        default:
          res.writeHead(404);
          res.end();
      }
    });
  }

  // ---------------------------------------------------------------- WS

  private onWs(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? '/', `http://${this.hostPort}`);
    const origin = req.headers.origin;
    this.upgrades.push({ path: url.pathname, origin });
    ws.binaryType = 'nodebuffer';
    if (url.pathname !== '/host') ws.on('ping', (data) => ws.pong(data));
    if (url.pathname === '/host') this.onHostWs(ws, url, origin);
    else if (url.pathname === '/client') this.onClientWs(ws, url, req);
    else ws.close(4001);
  }

  private onHostWs(ws: WebSocket, url: URL, origin: string | undefined): void {
    const wsToken = url.searchParams.get('token') ?? '';
    const headlessToken = this.wsTokens.get(wsToken);
    if (headlessToken === undefined) {
      ws.close(4001);
      return;
    }
    this.wsTokens.delete(wsToken);
    const id = this.nextRoomId ?? randomBytes(8).toString('base64url').slice(0, 11);
    this.nextRoomId = null;
    const room: FakeRoom = {
      id,
      ws,
      origin,
      headlessToken,
      infoBytes: null,
      info: null,
      roomInfoMessages: 0,
      keepAlives: 0,
      pings: 0,
      blackholed: false,
      requireRecaptcha: false,
      peers: new Map(),
    };
    this.rooms.set(id, room);
    this.log(`host connected, room ${id}`);
    // [5][u8 len][roomId]
    const idBytes = new TextEncoder().encode(id);
    ws.send(Buffer.from([5, idBytes.length, ...idBytes]));
    if (this.opts.sendNewToken !== false) {
      // [6][token] — a fresh headless token for reconnects
      const newToken = new TextEncoder().encode(`${headlessToken}-r`);
      ws.send(Buffer.from([6, ...newToken]));
    }
    const waiters = this.roomWaiters;
    this.roomWaiters = [];
    for (const w of waiters) w(room);

    ws.on('ping', (data: Buffer) => {
      if (room.blackholed) return;
      room.pings++;
      ws.pong(data);
    });
    ws.on('message', (data: Buffer) => {
      if (room.blackholed) return;
      const msg = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (msg.length === 0) return;
      const r = new Reader(msg);
      switch (r.u8()) {
        case 0: {
          const peerId = r.u32();
          const client = room.peers.get(peerId);
          if (client === undefined) return;
          if (r.remaining >= 2) {
            const code = r.u16();
            client.rejectCode = code;
            this.log(`host rejected peer ${peerId} with ${code}`);
            room.peers.delete(peerId);
            this.rejections.push({ peerId, code });
            // WS close codes must be 1000/3000-4999: a parse error (0) can't be relayed as is.
            client.ws.close(code >= 3000 && code <= 4999 ? code : 1008);
          } else {
            client.hostDone = true;
            this.maybeFinish(room, client);
          }
          return;
        }
        case 1:
        case 4: {
          const type = msg[0]!;
          const peerId = r.u32();
          const client = room.peers.get(peerId);
          if (client === undefined || client.ws.readyState !== WebSocket.OPEN) return;
          const out = new Uint8Array(1 + r.remaining);
          out[0] = type;
          out.set(r.bytes(), 1);
          this.clientMessages?.push({ peerId, type, payload: out.slice(1) });
          client.ws.send(out);
          return;
        }
        case 7:
          room.roomInfoMessages++;
          room.infoBytes = msg.slice(1);
          try {
            room.info = decodeRoomInfo(room.infoBytes);
          } catch {
            room.info = null;
          }
          return;
        case 8:
          room.keepAlives++;
          return;
        case 9:
          room.requireRecaptcha = r.u8() !== 0;
          return;
      }
    });
    ws.on('close', () => {
      this.rooms.delete(id);
      for (const c of room.peers.values()) c.ws.close(4001);
      room.peers.clear();
    });
  }

  private onClientWs(ws: WebSocket, url: URL, req: http.IncomingMessage): void {
    const room = this.rooms.get(url.searchParams.get('id') ?? '');
    if (room === undefined) {
      ws.close(4001);
      return;
    }
    if (room.requireRecaptcha && !url.searchParams.get('token')) {
      ws.close(4004);
      return;
    }
    const ip = this.clientIp?.(req) ?? normalizeRemote(req.socket.remoteAddress ?? '127.0.0.1');
    const client: FakeClient = { peerId: this.nextPeerId++, ws, ip, hostDone: false, clientDone: false, rejectCode: null };
    room.peers.set(client.peerId, client);
    ws.on('message', (data: Buffer) => {
      const msg = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (msg.length === 0 || room.ws.readyState !== WebSocket.OPEN) return;
      const type = msg[0]!;
      if (type === 1) {
        // [1][u32 peerId][u8 n][conn = client IP text] + client's deflated payload
        const conn = new TextEncoder().encode(client.ip);
        const w = new Writer(16 + conn.length + msg.length);
        w.u8(1);
        w.u32(client.peerId);
        w.u8(conn.length);
        w.bytes(conn);
        w.bytes(msg.subarray(1));
        room.ws.send(w.copyBytes());
      } else if (type === 4) {
        const w = new Writer(8 + msg.length);
        w.u8(4);
        w.u32(client.peerId);
        w.bytes(msg.subarray(1));
        room.ws.send(w.copyBytes());
      } else if (type === 0) {
        client.clientDone = true;
        this.maybeFinish(room, client);
      }
    });
    ws.on('close', () => {
      room.peers.delete(client.peerId);
    });
  }

  /** Both sides finished signaling: release the client socket. */
  private maybeFinish(room: FakeRoom, client: FakeClient): void {
    if (client.hostDone && client.clientDone) {
      room.peers.delete(client.peerId);
      client.ws.close(1000);
    }
  }
}

function normalizeRemote(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}
