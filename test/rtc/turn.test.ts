import { describe, expect, it } from 'vitest';
import { StunAttr, StunMessage, checkIntegrity, parseStun, findAttr, readXorAddress } from '../../src/rtc/stun.js';
import {
  TurnAttr,
  TurnRelay,
  TurnType,
  buildTurnMessage,
  longTermKey,
  parseChannelData,
  turnServers,
  writeChannelHeader,
  xorAddressValue,
  type TurnAuth,
} from '../../src/rtc/turn.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('TURN codec', () => {
  it('RFC 5769 §2.4: long-term MESSAGE-INTEGRITY', () => {
    const msg = hex(`
      00 01 00 60 21 12 a4 42 78 ad 34 33 c6 ad 72 c0 29 da 41 2e
      00 06 00 12 e3 83 9e e3 83 88 e3 83 aa e3 83 83 e3 82 af e3 82 b9 00 00
      00 15 00 1c 66 2f 2f 34 39 39 6b 39 35 34 64 36 4f 4c 33 34 6f 4c 39 46 53 54 76 79 36 34 73 41
      00 14 00 0b 65 78 61 6d 70 6c 65 2e 6f 72 67 00
      00 08 00 14 f6 70 24 65 6d d6 4a 3e 02 b8 e0 71 2e 85 c9 a2 8c a8 96 66`);
    const m = new StunMessage();
    expect(parseStun(msg, m)).toBe(true);
    const key = longTermKey('マトリックス', 'example.org', 'TheMatrIX');
    expect(checkIntegrity(m, key)).toBe(true);
    expect(checkIntegrity(m, longTermKey('マトリックス', 'example.org', 'wrong'))).toBe(false);
  });

  it('builds authenticated requests that verify with the long-term key', () => {
    const auth: TurnAuth = { username: 'u', realm: 'r', nonce: 'n', key: longTermKey('u', 'r', 'p') };
    const txid = Buffer.alloc(12, 3);
    const b = buildTurnMessage(TurnType.AllocateRequest, txid, [[TurnAttr.RequestedTransport, Uint8Array.of(17, 0, 0, 0)]], auth);
    const m = new StunMessage();
    expect(parseStun(b, m)).toBe(true);
    expect(m.type).toBe(TurnType.AllocateRequest);
    expect(checkIntegrity(m, auth.key)).toBe(true);
    expect(m.username()).toBe('u');
  });

  it('XOR-PEER-ADDRESS round trip', () => {
    const txid = Buffer.alloc(12, 9);
    const v = xorAddressValue('203.0.113.7', 50123, txid);
    expect(readXorAddress(v, 0, txid)).toEqual({ address: '203.0.113.7', port: 50123 });
  });

  it('ChannelData framing (padding after the payload tolerated)', () => {
    const b = Buffer.alloc(12);
    writeChannelHeader(b, 0x4001, 5);
    expect(parseChannelData(b)).toEqual({ channel: 0x4001, offset: 4, length: 5 });
    expect(parseChannelData(b.subarray(0, 8))).toBeNull(); // truncated
    writeChannelHeader(b, 0x3fff, 1);
    expect(parseChannelData(b)).toBeNull();
  });

  it('turnServers: URL, browser and node-datachannel forms; UDP only', () => {
    expect(
      turnServers([
        'stun:stun.l.google.com:19302',
        'turn:alice:s%40cret@turn.example.com:3479',
        'turns:turn.example.com:5349',
        'turn:turn.example.com:3478?transport=tcp',
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turn:turn.cloudflare.com:53?transport=udp',
            'turn:turn.cloudflare.com:80?transport=tcp',
            'turns:turn.cloudflare.com:443?transport=tcp',
          ],
          username: 'cf',
          credential: 'pw',
        },
        { hostname: '198.51.100.1', port: 3478, username: 'x', password: 'y', relayType: 'TurnUdp' },
        { hostname: '198.51.100.2', port: 3478, relayType: 'TurnTcp' },
      ]),
    ).toEqual([
      { host: 'turn.example.com', port: 3479, username: 'alice', credential: 's@cret' },
      { host: 'turn.cloudflare.com', port: 3478, username: 'cf', credential: 'pw' },
      { host: 'turn.cloudflare.com', port: 53, username: 'cf', credential: 'pw' },
      { host: '198.51.100.1', port: 3478, username: 'x', credential: 'y' },
    ]);
  });
});

// ---------------------------------------------------------------- TurnRelay against a scripted server

const SERVER = '192.0.2.10';
const RELAYED = { address: '192.0.2.10', port: 49152 };

class FakeServer {
  sent: Buffer[] = [];
  readonly key = longTermKey('user', 'realm', 'pass');
  relay!: TurnRelay;
  delivered: { msg: Buffer; address: string; port: number }[] = [];
  /** Auto-answer requests. */
  auto = true;
  permissions: string[][] = [];
  channels: { n: number; address: string; port: number }[] = [];
  sendInd = 0;
  channelData = 0;

  io = {
    send: (buf: Uint8Array, port: number, address: string): boolean => {
      expect(address).toBe(SERVER);
      expect(port).toBe(3478);
      const b = Buffer.from(buf);
      this.sent.push(b);
      if (this.auto) queueMicrotask(() => this.answer(b));
      return true;
    },
  };

  answer(b: Buffer): void {
    if (b[0]! >= 0x40) {
      this.channelData++;
      return;
    }
    const m = new StunMessage();
    if (!parseStun(b, m)) throw new Error('bad message');
    const txid = b.subarray(8, 20);
    if (m.type === TurnType.SendIndication) {
      this.sendInd++;
      return;
    }
    if (m.integrityOffset < 0) {
      this.reply(m.type | 0x0110, txid, [errorCode(401), [TurnAttr.Realm, Buffer.from('realm')], [TurnAttr.Nonce, Buffer.from('nonce1')]], false);
      return;
    }
    expect(checkIntegrity(m, this.key)).toBe(true);
    switch (m.type) {
      case TurnType.AllocateRequest:
        this.reply(TurnType.AllocateSuccess, txid, [
          [TurnAttr.XorRelayedAddress, xorAddressValue(RELAYED.address, RELAYED.port, txid)],
          [StunAttr.XorMappedAddress, xorAddressValue('198.51.100.20', 40000, txid)],
          [TurnAttr.Lifetime, Uint8Array.of(0, 0, 2, 0x58)],
        ]);
        break;
      case TurnType.CreatePermissionRequest: {
        const ips: string[] = [];
        let p = 20;
        while (p < m.size) {
          const t = b.readUInt16BE(p);
          const l = b.readUInt16BE(p + 2);
          if (t === TurnAttr.XorPeerAddress) ips.push(readXorAddress(b, p + 4, txid).address);
          p += 4 + ((l + 3) & ~3);
        }
        this.permissions.push(ips);
        this.reply(TurnType.CreatePermissionSuccess, txid, []);
        break;
      }
      case TurnType.ChannelBindRequest: {
        const v = findAttr(m, TurnAttr.ChannelNumber);
        const peer = readXorAddress(b, findAttr(m, TurnAttr.XorPeerAddress), txid);
        this.channels.push({ n: b.readUInt16BE(v), ...peer });
        this.reply(TurnType.ChannelBindSuccess, txid, []);
        break;
      }
      default:
        this.reply(m.type | 0x0100, txid, []);
    }
  }

  reply(type: number, txid: Uint8Array, attrs: [number, Uint8Array][], auth = true): void {
    const a = auth ? { username: 'user', realm: 'realm', nonce: 'nonce1', key: this.key } : null;
    // responses carry MESSAGE-INTEGRITY but not USERNAME/REALM/NONCE: build with them, it is only a test server
    this.relay.onServerPacket(buildTurnMessage(type, txid, attrs, a));
  }
}

function errorCode(code: number): [number, Uint8Array] {
  return [StunAttr.ErrorCode, Uint8Array.of(0, 0, Math.floor(code / 100), code % 100)];
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeRelay(srv: FakeServer): TurnRelay {
  const relay = new TurnRelay(
    {
      io: srv.io,
      family: 4,
      now: () => Date.now(),
      deliver: (_r, msg, address, port) => srv.delivered.push({ msg: Buffer.from(msg), address, port }),
      lookup: async () => [SERVER],
    },
    [{ host: 'turn.test', port: 3478, username: 'user', credential: 'pass' }],
  );
  srv.relay = relay;
  return relay;
}

describe('TurnRelay', () => {
  it('allocates (401 → authenticated Allocate), coalesces permissions, binds a channel at the first DTLS datagram', async () => {
    const srv = new FakeServer();
    const relay = makeRelay(srv);
    const ok = await new Promise<boolean>((resolve) => relay.allocate(resolve));
    expect(ok).toBe(true);
    expect(relay.relayed).toEqual(RELAYED);
    expect(relay.mapped).toEqual({ address: '198.51.100.20', port: 40000 });

    // the signaling IP and two candidates in the same turn: one CreatePermission
    relay.permit('203.0.113.1');
    relay.permit('203.0.113.2');
    relay.send(Buffer.from([0, 1, 0, 0]), 5000, '203.0.113.2'); // a check before the permission: queued
    await tick();
    expect(srv.permissions).toEqual([['203.0.113.1', '203.0.113.2']]);
    expect(srv.sendInd).toBe(1); // the queued check left once the permission was installed

    // DTLS: a channel is bound, later datagrams use ChannelData
    relay.send(Buffer.from([22, 254, 253, 0]), 5000, '203.0.113.2');
    await tick();
    expect(srv.channels).toEqual([{ n: 0x4000, address: '203.0.113.2', port: 5000 }]);
    relay.send(Buffer.from([23, 254, 253, 1]), 5000, '203.0.113.2');
    await tick();
    expect(srv.channelData).toBe(1);
    expect(srv.sendInd).toBe(2); // the queued check and the first DTLS datagram (sent while the channel was binding)
    expect(relay.stats().channels).toBe(1);

    // inbound: ChannelData and Data indication are unwrapped with the peer as source
    const cd = Buffer.alloc(8);
    writeChannelHeader(cd, 0x4000, 3);
    cd.set([23, 1, 2], 4);
    expect(relay.onServerPacket(cd)).toBe(true);
    const txid = Buffer.alloc(12, 1);
    const di = buildTurnMessage(TurnType.DataIndication, txid, [
      [TurnAttr.XorPeerAddress, xorAddressValue('203.0.113.1', 6000, txid)],
      [TurnAttr.Data, Uint8Array.of(0, 1, 0, 0)],
    ], null);
    expect(relay.onServerPacket(di)).toBe(true);
    expect(srv.delivered.map((d) => [d.address, d.port, [...d.msg]])).toEqual([
      ['203.0.113.2', 5000, [23, 1, 2]],
      ['203.0.113.1', 6000, [0, 1, 0, 0]],
    ]);
    // a Binding response from the server (it doubles as STUN) is not TURN
    const bind = buildTurnMessage(0x0101, txid, [], null);
    expect(relay.onServerPacket(bind)).toBe(false);
    relay.close();
    expect(relay.state).toBe('closed');
  });

  it('falls back to the next server when an Allocate times out', async () => {
    const srv = new FakeServer();
    srv.auto = false;
    const asked: string[] = [];
    const relay = new TurnRelay(
      {
        io: srv.io,
        family: 4,
        now: () => Date.now(),
        deliver: () => {},
        lookup: async (h) => {
          asked.push(h);
          return [SERVER];
        },
      },
      [
        { host: 'a', port: 3478, username: 'user', credential: 'pass' },
        { host: 'b', port: 3478, username: 'user', credential: 'pass' },
      ],
    );
    srv.relay = relay;
    const ok = await new Promise<boolean>((resolve) => relay.allocate(resolve));
    expect(ok).toBe(false);
    expect(asked).toEqual(['a', 'b']);
    relay.close();
  }, 10_000);

  it('keeps the permission of a peer whose traffic only flows as ChannelData (no drop after ~8 min)', async () => {
    const srv = new FakeServer();
    let clock = 1_000_000;
    const relay = new TurnRelay(
      {
        io: srv.io,
        family: 4,
        now: () => clock,
        deliver: (_r, msg, address, port) => srv.delivered.push({ msg: Buffer.from(msg), address, port }),
        lookup: async () => [SERVER],
      },
      [{ host: 'turn.test', port: 3478, username: 'user', credential: 'pass' }],
    );
    srv.relay = relay;
    expect(await new Promise<boolean>((resolve) => relay.allocate(resolve))).toBe(true);
    const peer = '203.0.113.7';
    relay.permit(peer);
    await tick();
    relay.send(Buffer.from([22, 254, 253, 0]), 5000, peer); // DTLS: binds a channel
    await tick();
    expect(srv.channels).toEqual([{ n: 0x4000, address: peer, port: 5000 }]);
    const maintain = () => (relay as unknown as { maintain(): void }).maintain();
    const inbound = () => {
      const cd = Buffer.alloc(8);
      writeChannelHeader(cd, 0x4000, 3);
      cd.set([23, 1, 2], 4);
      relay.onServerPacket(cd);
    };
    // 15 minutes of play: traffic both ways every 15 s, only as ChannelData
    const before = srv.delivered.length;
    for (let t = 0; t < 60; t++) {
      clock += 15_000;
      relay.send(Buffer.from([23, 254, 253, 1]), 5000, peer);
      inbound();
      maintain();
      await tick();
    }
    expect(srv.delivered.length - before).toBe(60); // every inbound datagram reached the endpoint
    expect(relay.stats().permissions).toBe(1);
    expect(relay.stats().channels).toBe(1);
    expect(srv.channels.every((c) => c.n === 0x4000)).toBe(true); // rebinds keep the same number

    // idle long enough to be forgotten (the server keeps the binding a while): its ChannelData is
    // still delivered, and when it is used again it gets the same number back (a new one: 400)
    for (let t = 0; t < 40; t++) {
      clock += 15_000;
      maintain();
    }
    expect(relay.stats().channels).toBe(0);
    const n0 = srv.delivered.length;
    inbound();
    expect(srv.delivered.length).toBe(n0 + 1);
    expect(srv.delivered[n0]!.address).toBe(peer);
    relay.send(Buffer.from([22, 254, 253, 0]), 5000, peer);
    await tick();
    relay.send(Buffer.from([22, 254, 253, 0]), 5000, peer);
    await tick();
    expect(srv.channels.at(-1)).toEqual({ n: 0x4000, address: peer, port: 5000 });
    relay.close();
  });
});
