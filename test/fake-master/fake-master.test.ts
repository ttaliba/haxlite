/**
 * Validates the fake master with third-party endpoints only: a node-haxball
 * HOST and a node-haxball CLIENT meet through it, the client joins and sees
 * the room state (players, room name), and the room appears in api/list.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from './index.js';
import { fetchRoomList } from '../../src/net/master-http.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let master: FakeMaster;
let nh: Any;

beforeAll(async () => {
  master = await FakeMaster.start();
  // node-haxball keeps its config module-global: initialise it pointing at the fake master.
  nh = (require('node-haxball') as (w: unknown, c: unknown) => Any)(null, master.nodeHaxballConfig);
});

afterAll(async () => {
  await master?.close();
  // node-haxball uses its own nested node-datachannel copy.
  try {
    (require('node-haxball/node_modules/node-datachannel') as { cleanup(): void }).cleanup();
  } catch {
    /* not nested */
  }
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

describe('fake master with node-haxball host + client', () => {
  it('client joins a node-haxball room and sees its state', async () => {
    const roomPromise = master.waitForRoom();
    let hostRoom: Any = null;
    const linkPromise = new Promise<string>((resolve, reject) => {
      nh.Room.create(
        {
          name: 'fake master room',
          password: 'pw',
          showInRoomList: true,
          maxPlayerCount: 6,
          noPlayer: true,
          token: 'thr1.fake',
          geo: { lat: 1.5, lon: 2.5, flag: 'ar' },
        },
        {
          storage: { player_name: 'host', avatar: null },
          onOpen: (room: Any) => {
            hostRoom = room;
            room.onAfterRoomLink = (link: string) => resolve(link);
          },
          onClose: (e: unknown) => reject(new Error(`host closed: ${String(e)}`)),
        },
      );
    });
    const fakeRoom = await withTimeout(roomPromise, 10_000, 'room registration');
    const link = await withTimeout(linkPromise, 10_000, 'room link');
    expect(link).toContain(`play?c=${fakeRoom.id}`);
    // node-haxball overrides Origin with the configured backend host
    expect(fakeRoom.origin).toBe(`http://${master.hostPort}`);

    // RoomInfo (message 7) reached the master and is listed
    await withTimeout(
      (async () => {
        while (fakeRoom.info === null) await new Promise((r) => setTimeout(r, 20));
      })(),
      5_000,
      'room info',
    );
    expect(fakeRoom.info).toMatchObject({ version: 9, name: 'fake master room', flag: 'ar', password: true, maxPlayers: 6 });
    const list = await fetchRoomList({ masterUrl: master.httpBase });
    expect(list.map((r) => r.id)).toContain(fakeRoom.id);

    const [, authObj] = (await nh.Utils.generateAuth()) as [string, Any];
    let clientRoom: Any = null;
    const joined = new Promise<Any>((resolve, reject) => {
      nh.Room.join(
        { id: fakeRoom.id, password: 'pw', authObj },
        {
          storage: { player_name: 'joiner', avatar: 'J', geo: { lat: 0, lon: 0, flag: 'uy' } },
          onOpen: (room: Any) => {
            clientRoom = room;
            resolve(room);
          },
          onClose: (e: unknown) => reject(new Error(`client closed: ${String(e)}`)),
        },
      );
    });
    const room = await withTimeout(joined, 20_000, 'client join');
    const names = (room.players as Any[]).map((p) => p.name);
    expect(names).toContain('joiner');
    expect(room.name).toBe('fake master room');
    // the host sees the player with its auth and conn = hex("127.0.0.1")
    const hostPlayer = (hostRoom.players as Any[]).find((p) => p.name === 'joiner');
    expect(hostPlayer).toBeTruthy();
    expect(hostPlayer.auth).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hostPlayer.conn).toBe(Buffer.from('127.0.0.1').toString('hex').toUpperCase());

    clientRoom.leave();
    hostRoom.leave();
  });
});
