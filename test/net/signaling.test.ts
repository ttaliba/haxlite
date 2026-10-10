/**
 * Host signaling against the fake master: api/host, Origin, room link,
 * RoomInfo publishing (public/private, 10 s batching), keep-alive, captcha
 * flag, token renewal (message 6) and the reconnect policy (4001 = stop).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { HostSignaling, HostTransport, MasterError, requestHostSession, fetchGeo, shutdownWebRtc } from '../../src/net/index.js';

let master: FakeMaster;
const stops: (() => void)[] = [];

beforeAll(async () => {
  master = await FakeMaster.start();
});
afterEach(() => {
  for (const s of stops.splice(0)) s();
});
afterAll(async () => {
  await master.close();
  shutdownWebRtc();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition timeout');
    await sleep(10);
  }
}

describe('master HTTP', () => {
  it('api/host connect + recaptcha for invalid tokens, api/geo', async () => {
    const ok = await requestHostSession('thr1.ok', '', { masterUrl: master.httpBase });
    expect(ok).toMatchObject({ action: 'connect', url: `${master.wsBase}host` });
    expect(await requestHostSession('expired', '', { masterUrl: master.httpBase })).toEqual({ action: 'recaptcha', sitekey: 'fake-sitekey' });
    expect(await fetchGeo({ masterUrl: master.httpBase })).toEqual({ flag: 'ar', lat: -34.6, lon: -58.4 });
    await expect(requestHostSession('x', '', { masterUrl: 'http://127.0.0.1:1/rs/' })).rejects.toBeInstanceOf(MasterError);
  });
});

describe('HostSignaling', () => {
  it('room id, origin, keep-alive, RoomInfo batching, captcha flag', async () => {
    const roomP = master.waitForRoom();
    let roomId: string | null = null;
    const s = new HostSignaling(
      { token: 'thr1.sig', masterUrl: master.httpBase, keepAliveMs: 30, roomInfoThrottleMs: 200, recaptchaDebounceMs: 50 },
      { onRoomId: (id) => (roomId = id) },
    );
    stops.push(() => s.stop());
    s.setRoomInfo(Uint8Array.of(1, 2, 3)); // before connecting: sent on open
    s.start();
    const room = await roomP;
    await until(() => roomId !== null);
    expect(roomId).toBe(room.id);
    expect(room.origin).toBe('https://html5.haxball.com');
    await until(() => room.roomInfoMessages === 1);
    expect([...room.infoBytes!]).toEqual([1, 2, 3]);
    await until(() => room.keepAlives >= 2);

    s.setRoomInfo(Uint8Array.of(1, 2, 3)); // unchanged: ignored
    s.setRoomInfo(Uint8Array.of(4)); // sent now, opens a 200 ms window
    s.setRoomInfo(Uint8Array.of(5)); // batched
    s.setRoomInfo(Uint8Array.of(6)); // batched (replaces 5)
    await until(() => room.roomInfoMessages === 2);
    expect([...room.infoBytes!]).toEqual([4]);
    await sleep(100);
    expect(room.roomInfoMessages).toBe(2);
    await until(() => room.roomInfoMessages === 3);
    expect([...room.infoBytes!]).toEqual([6]);

    s.setRequireRecaptcha(true);
    await until(() => room.requireRecaptcha);
    s.setRequireRecaptcha(false);
    s.setRequireRecaptcha(true); // net no change inside the debounce window
    await sleep(120);
    expect(room.requireRecaptcha).toBe(true);
    // token from message 6
    expect(s.token).toBe('thr1.sig-r');
  });

  it('reconnects after an unexpected close with the renewed token; 4001 stops', async () => {
    let roomP = master.waitForRoom();
    const disconnects: { code: number; willReconnect: boolean }[] = [];
    const ids: string[] = [];
    const s = new HostSignaling(
      { token: 'thr1.rc', masterUrl: master.httpBase, reconnectMinMs: 50, reconnectRangeMs: 50, random: () => 0.5 },
      { onDisconnect: (d) => disconnects.push(d), onRoomId: (id) => ids.push(id) },
    );
    stops.push(() => s.stop());
    s.start();
    const r1 = await roomP;
    roomP = master.waitForRoom();
    r1.ws.close(4000);
    const r2 = await roomP;
    expect(r2.headlessToken).toBe('thr1.rc-r');
    expect(disconnects).toEqual([{ code: 4000, willReconnect: true }]);
    await until(() => ids.length === 2);
    expect(ids).toEqual([r1.id, r2.id]);

    r2.ws.close(4001);
    await until(() => disconnects.length === 2);
    expect(disconnects[1]).toEqual({ code: 4001, willReconnect: false });
    await sleep(200);
    expect(master.rooms.size).toBe(0);
  });

  it('invalid token -> onRecaptcha; useRecaptchaToken retries with rcr', async () => {
    const before = master.hostRequests.length;
    let sitekey: string | null = null;
    const errors: Error[] = [];
    const s = new HostSignaling(
      { token: 'invalid', masterUrl: master.httpBase },
      { onRecaptcha: (k) => (sitekey = k), onError: (e) => errors.push(e) },
    );
    stops.push(() => s.stop());
    s.start();
    await until(() => sitekey !== null);
    expect(sitekey).toBe('fake-sitekey');
    expect(errors[0]).toBeInstanceOf(MasterError);
    expect((errors[0] as MasterError).kind).toBe('recaptcha');
    const roomP = master.waitForRoom();
    s.useRecaptchaToken('captcha-answer');
    await roomP;
    expect(master.hostRequests.slice(before)).toEqual([
      { token: 'invalid', rcr: '' },
      { token: 'invalid', rcr: 'captcha-answer' },
    ]);
  });
});

describe('HostTransport room publication', () => {
  it('private rooms never send message 7; public rooms publish RoomInfo with settings', async () => {
    let roomP = master.waitForRoom();
    const priv = new HostTransport({ token: 't', masterUrl: master.httpBase, iceServers: [], roomInfo: { name: 'secret' } });
    stops.push(() => priv.stop());
    priv.start();
    const pr = await roomP;
    priv.setRoomInfo({ players: 3 });
    priv.setPassword('x');
    await sleep(100);
    expect(pr.roomInfoMessages).toBe(0);
    expect(priv.roomLink).toBe(`https://www.haxball.com/play?c=${pr.id}&p=1`);

    roomP = master.waitForRoom();
    const pub = new HostTransport({
      token: 't',
      masterUrl: master.httpBase,
      iceServers: [],
      public: true,
      maxPlayers: 20,
      roomInfo: { name: 'n'.repeat(50), flag: 'arg', lat: 10.5, lon: -3.25 },
      roomInfoThrottleMs: 50,
    });
    stops.push(() => pub.stop());
    pub.start();
    const r = await roomP;
    await until(() => r.info !== null);
    expect(r.info).toEqual({ version: 9, name: 'n'.repeat(40), flag: 'arg', lat: 10.5, lon: -3.25, password: false, maxPlayers: 20, players: 0 });
    pub.setRoomInfo({ players: 4 });
    pub.setPassword('pw');
    await until(() => r.info?.players === 4 && r.info.password === true);
  });
});
