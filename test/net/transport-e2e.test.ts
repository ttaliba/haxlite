/**
 * End-to-end: haxlite HostTransport (signaling + WebRTC + handshake) with a
 * node-haxball CLIENT, all offline through the fake master. The game
 * snapshot is not implemented yet, so assertions stop at the verified join.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { cleanupNodeHaxball, nodeHaxballFor } from '../fake-master/node-haxball.js';
import { HostTransport, shutdownWebRtc, type JoinInfo, type Peer, type PeerCloseReason } from '../../src/net/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let master: FakeMaster;
let nh: Any;
const transports: HostTransport[] = [];
const joins: { cancel(): void }[] = [];

beforeAll(async () => {
  master = await FakeMaster.start();
  nh = nodeHaxballFor(master);
});

afterEach(() => {
  for (const j of joins.splice(0)) {
    try {
      j.cancel();
    } catch {
      /* already gone */
    }
  }
  for (const t of transports.splice(0)) t.stop();
});

afterAll(async () => {
  await master?.close();
  shutdownWebRtc();
  cleanupNodeHaxball();
});

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

async function startHost(opts: Partial<ConstructorParameters<typeof HostTransport>[0]> = {}) {
  const t = new HostTransport({ token: 'thr1.test', masterUrl: master.httpBase, iceServers: [], public: true, ...opts });
  transports.push(t);
  const room = master.waitForRoom();
  const link = new Promise<string>((resolve) => (t.onRoomLink = (l) => resolve(l)));
  t.start();
  const fakeRoom = await withTimeout(room, 10_000, 'room registration');
  return { t, fakeRoom, link: await withTimeout(link, 5_000, 'room link') };
}

/** Joins with a node-haxball client; resolves with the close error (if the join fails). */
function nhJoin(roomId: string, opts: { password?: string | null; authObj?: Any; name?: string; avatar?: string | null } = {}) {
  let closeReason: Any = null;
  const closed = new Promise<Any>(async (resolve) => {
    const authObj = opts.authObj ?? ((await nh.Utils.generateAuth()) as [string, Any])[1];
    const j = nh.Room.join(
      { id: roomId, password: opts.password ?? null, authObj },
      {
        storage: { player_name: opts.name ?? 'joiner', avatar: opts.avatar ?? null, geo: { lat: 0, lon: 0, flag: 'uy' } },
        onClose: (e: Any) => {
          closeReason = e;
          resolve(e);
        },
      },
    );
    joins.push(j);
  });
  return { closed, get reason() { return closeReason; } };
}

describe('HostTransport + node-haxball client', () => {
  it('publishes the room, links, keeps origin; client connects, gets challenge, auth verifies', async () => {
    const { t, fakeRoom, link } = await startHost({ password: 'secret', roomInfo: { name: 'haxlite e2e', flag: 'ar', lat: 1, lon: 2 } });
    expect(link).toBe(`https://www.haxball.com/play?c=${fakeRoom.id}&p=1`);
    expect(fakeRoom.origin).toBe('https://html5.haxball.com');
    expect(master.hostRequests.at(-1)).toEqual({ token: 'thr1.test', rcr: '' });
    await withTimeout(
      (async () => {
        while (fakeRoom.info === null) await new Promise((r) => setTimeout(r, 20));
      })(),
      5_000,
      'roominfo',
    );
    expect(fakeRoom.info).toMatchObject({ version: 9, name: 'haxlite e2e', flag: 'ar', password: true, maxPlayers: 12, players: 0 });

    const [authKey, authObj] = (await nh.Utils.generateAuth()) as [string, Any];
    const expectedAuth = authKey.split('.')[1];
    const joined = new Promise<{ peer: Peer; info: JoinInfo }>((resolve) => (t.onPeerJoin = (peer, info) => resolve({ peer, info })));
    nhJoin(fakeRoom.id, { password: 'secret', authObj, name: 'Ñandú 😀', avatar: 'J' });
    const { peer, info } = await withTimeout(joined, 20_000, 'peer join');
    expect(info).toMatchObject({ name: 'Ñandú 😀', avatar: 'J', auth: expectedAuth, ip: '127.0.0.1' });
    expect(info.conn).toBe(Buffer.from('127.0.0.1').toString('hex').toUpperCase());
    expect(peer.state).toBe('joined');
    expect(t.peers).toEqual([peer]);
    expect(t.pendingCount).toBe(0);
    // the three negotiated channels are open
    expect(peer.channelOpen).toEqual([true, true, true]);

    // client -> host traffic is delivered once joined: wait for anything (node-haxball
    // client sends nothing until it gets the snapshot), so check sending works instead.
    expect(t.send(peer, 2, Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(true);

    const closed = new Promise<PeerCloseReason>((resolve) => (t.onPeerClose = (_p, r) => resolve(r)));
    t.close(peer, 'host');
    expect(await closed).toBe('host');
    expect(t.peers.length).toBe(0);
  });

  it('rejects a wrong password with 4101 (no WebRTC peer created)', async () => {
    const { t, fakeRoom } = await startHost({ password: 'right' });
    const rejected: number[] = [];
    t.onJoinRejected = (_r, code) => rejected.push(code);
    const j = nhJoin(fakeRoom.id, { password: 'wrong' });
    await withTimeout(j.closed, 10_000, 'client close');
    expect(rejected).toEqual([4101]);
    expect(t.pendingCount).toBe(0);
    expect(j.reason?.code).toBe(nh.Errors.ErrorCodes.WrongPassword);
  });

  it('rejects a banned conn IP (4102) and a banned range (4102)', async () => {
    const { t, fakeRoom } = await startHost();
    const rejected: number[] = [];
    t.onJoinRejected = (_r, code) => rejected.push(code);
    t.bans.addIp('127.0.0.1');
    const r1 = await withTimeout(nhJoin(fakeRoom.id).closed, 10_000, 'close 1');
    t.bans.clear();
    master.clientIp = () => '2001:db8::42';
    t.bans.addRange('2001:db8::/32');
    const r2 = await withTimeout(nhJoin(fakeRoom.id).closed, 10_000, 'close 2');
    master.clientIp = null;
    expect(rejected).toEqual([4102, 4102]);
    expect([r1?.code, r2?.code]).toEqual([nh.Errors.ErrorCodes.BannedBefore, nh.Errors.ErrorCodes.BannedBefore]);
  });

  it('rejects when full (4100) and an onJoinRequest hook decides before WebRTC', async () => {
    const { t, fakeRoom } = await startHost({
      maxPlayers: 0,
    });
    const rejected: number[] = [];
    t.onJoinRejected = (_r, code) => rejected.push(code);
    const r = await withTimeout(nhJoin(fakeRoom.id).closed, 10_000, 'close full');
    expect(rejected).toEqual([4100]);
    expect(r?.code).toBe(nh.Errors.ErrorCodes.RoomFull);

    const seen: string[] = [];
    const { t: t2, fakeRoom: room2 } = await startHost({
      onJoinRequest: async (req) => {
        seen.push(req.ip);
        await new Promise((r) => setTimeout(r, 30));
        return { reject: 4102 };
      },
    });
    const rejected2: number[] = [];
    t2.onJoinRejected = (_r, code) => rejected2.push(code);
    await withTimeout(nhJoin(room2.id).closed, 10_000, 'close hook');
    expect(seen).toEqual(['127.0.0.1']);
    expect(rejected2).toEqual([4102]);
  });
});
