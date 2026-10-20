/**
 * Host signaling against a misbehaving master: unusable WS url/token in the
 * api/host answer, oversized frames and tokens on the signaling socket, and
 * an api/host request in flight when the host stops. None of these may end
 * the process (unhandled rejection) or make the host retain unbounded data;
 * a failed attempt goes through the normal error + reconnect path.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { HostSignaling, MasterError, shutdownWebRtc } from '../../src/net/index.js';
import { WebSocketServer } from '../../src/net/ws.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition timeout');
    await sleep(10);
  }
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});
afterAll(async () => {
  await shutdownWebRtc();
});

/** Minimal master whose api/host answer is whatever `answer` returns. */
async function hostileMaster(answer: () => unknown): Promise<{ base: string; hits: () => number; server: Server }> {
  let hits = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: answer() }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stops.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rs/`, hits: () => hits, server };
}

describe('unusable ws url / token in the api/host answer', () => {
  const cases: [string, { url: string; token: string }, boolean][] = [
    ['token with a fragment', { url: 'ws://127.0.0.1:9/host', token: 'abc#def' }, false],
    ['unparseable url', { url: 'not a url', token: 'x' }, false],
    ['non-ws scheme', { url: 'ftp://127.0.0.1/', token: 'x' }, true],
    ['http scheme', { url: 'http://127.0.0.1:9/host', token: 'x' }, true],
    ['unix socket scheme', { url: 'ws+unix:/tmp/haxlite-missing.sock:/host', token: 'x' }, true],
  ];

  it.each(cases)('%s: reported and retried, the process survives', async (_name, answer, refusedByScheme) => {
    const m = await hostileMaster(() => ({ action: 'connect', ...answer }));
    const errors: Error[] = [];
    const disconnects: { code: number; willReconnect: boolean }[] = [];
    const s = new HostSignaling(
      { token: 't', masterUrl: m.base, reconnectMinMs: 20, reconnectRangeMs: 0 },
      { onError: (e) => errors.push(e), onDisconnect: (d) => disconnects.push(d) },
    );
    stops.push(() => s.stop());
    s.start();
    await until(() => m.hits() >= 3);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(disconnects[0]).toEqual({ code: 1006, willReconnect: true });
    expect(s.isOpen).toBe(false);
    // the master's url is never dialled unless it is a ws(s) one
    if (refusedByScheme) expect(errors.every((e) => e instanceof MasterError && e.kind === 'invalid-response')).toBe(true);
  });

  it('a throwing onError handler cannot turn the failure into an unhandled rejection or stop the retries', async () => {
    const m = await hostileMaster(() => ({ action: 'connect', url: 'not a url', token: 'x' }));
    let calls = 0;
    const s = new HostSignaling(
      { token: 't', masterUrl: m.base, reconnectMinMs: 20, reconnectRangeMs: 0 },
      {
        onError: () => {
          calls++;
          throw new Error('handler bug');
        },
      },
    );
    stops.push(() => s.stop());
    s.start();
    await until(() => m.hits() >= 3);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('wsUrl (operator override) is not restricted by the scheme check on the master url', async () => {
    const wsServer = createServer();
    const wss = new WebSocketServer({ server: wsServer });
    let connections = 0;
    wss.on('connection', () => connections++);
    await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', r));
    stops.push(() => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      wsServer.close();
    });
    const m = await hostileMaster(() => ({ action: 'connect', url: 'ftp://nowhere/', token: 'x' }));
    let opened = 0;
    const s = new HostSignaling(
      { token: 't', masterUrl: m.base, wsUrl: `ws://127.0.0.1:${(wsServer.address() as AddressInfo).port}/host` },
      { onOpen: () => opened++ },
    );
    stops.push(() => s.stop());
    s.start();
    await until(() => opened === 1);
    expect(connections).toBe(1);
  });
});

describe('signaling socket limits', () => {
  let master: FakeMaster;
  beforeAll(async () => {
    master = await FakeMaster.start();
  });
  afterAll(async () => {
    await master.close();
  });

  /** Host connected to the fake master, waiting for the master's token renewal (message 6). */
  async function connected(tag: string, onError: (e: Error) => void, onDisconnect: (d: { code: number; willReconnect: boolean }) => void) {
    const roomP = master.waitForRoom();
    const s = new HostSignaling(
      { token: `thr1.${tag}`, masterUrl: master.httpBase, reconnectMinMs: 30, reconnectRangeMs: 0 },
      { onError, onDisconnect },
    );
    stops.push(() => s.stop());
    s.start();
    const room = await roomP;
    await until(() => s.token === `thr1.${tag}-r`);
    return { s, room };
  }

  it('a frame over the signaling limit drops the link and reconnects; frames of realistic size pass', async () => {
    const errors: Error[] = [];
    const disconnects: { code: number; willReconnect: boolean }[] = [];
    const { s, room } = await connected('mp', (e) => errors.push(e), (d) => disconnects.push(d));

    // unknown message type: ignored, but still received whole by the socket
    room.ws.send(Buffer.alloc(100 * 1024, 0xff));
    await sleep(100);
    expect(disconnects).toEqual([]);
    expect(s.isOpen).toBe(true);

    const next = master.waitForRoom();
    room.ws.send(Buffer.alloc(300 * 1024, 0xff));
    await until(() => disconnects.length === 1);
    expect(disconnects[0]).toEqual({ code: 1006, willReconnect: true });
    expect(errors.some((e) => /payload/i.test(e.message))).toBe(true);
    await next; // back through the normal path
    await until(() => s.isOpen);
  });

  it('message 6 renews the token; an oversized token is ignored and reported', async () => {
    const errors: Error[] = [];
    const { s, room } = await connected('tk', (e) => errors.push(e), () => {});
    const token = (len: number, ch = 'a') => Buffer.concat([Buffer.of(6), Buffer.from(ch.repeat(len))]);

    room.ws.send(token(4096));
    await until(() => s.token === 'a'.repeat(4096));
    expect(errors).toEqual([]);

    room.ws.send(token(4097, 'b'));
    await until(() => errors.length === 1);
    expect(s.token).toBe('a'.repeat(4096));
    expect(s.isOpen).toBe(true);

    room.ws.send(token(10, 'c'));
    await until(() => s.token === 'c'.repeat(10));
  });
});

describe('api/host request in flight', () => {
  it('stop() aborts it instead of leaving it running until the request timeout', async () => {
    let closed = false;
    let seen = false;
    const server = createServer((req, res) => {
      seen = true;
      res.on('close', () => (closed = true));
      req.resume(); // never answers
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    stops.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const errors: Error[] = [];
    const s = new HostSignaling(
      { token: 't', masterUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rs/`, timeoutMs: 30_000 },
      { onError: (e) => errors.push(e) },
    );
    s.start();
    await until(() => seen);
    s.stop();
    await until(() => closed, 1000);
    await sleep(50);
    expect(errors).toEqual([]); // a stopped host reports nothing
  });
});
