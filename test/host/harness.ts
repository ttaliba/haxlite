/**
 * E2E harness (TEST ONLY): haxlite HostRoom + HostTransport + FakeMaster with
 * node-haxball CLIENTS, fully offline.
 *
 * Convergence evidence collected:
 *  - host side: RoomState bytes right after every simulated step
 *    (`sequencer.onFrameStepped`, i.e. before the events of the new frame) and
 *    the set of frames that had events applied;
 *  - client side: every few ms each client's CONFIRMED state (`room.state`,
 *    serialized with node-haxball's own writer) at its `currentFrameNo`; when
 *    the host applied no event at that frame, the bytes must be identical;
 *  - the clients' own CheckConsistency verdicts (node-haxball calls
 *    `state.w1(desync)` for every CheckConsistency it applies; we wrap it) and
 *    every SetPlayerSync the host receives.
 */
import { FakeMaster, type FakeRoom } from '../fake-master/index.js';
import { cleanupNodeHaxball, nodeHaxballFor } from '../fake-master/node-haxball.js';
import { HostTransport, shutdownWebRtc } from '../../src/net/index.js';
import { Writer } from '../../src/codec/index.js';
import { EventType } from '../../src/protocol.js';
import { writeRoomState, type SetPlayerSyncEvent } from '../../src/room/index.js';
import { HostRoom, createHostRoomState, type HostRoomOptions } from '../../src/host/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms: number, what: string, poll = 10): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(poll);
  }
}

export interface ClientHandle {
  readonly name: string;
  room: Any;
  /** Close error (HBError) once the client is disconnected. */
  closeError: Any;
  readonly closed: Promise<Any>;
  /** CheckConsistency verdicts seen by this client (true = desync). */
  readonly checks: boolean[];
  /** Frames where the client's confirmed state matched the host's bytes. */
  compared: number;
  mismatches: { frame: number; host: string; client: string }[];
  lastSampledFrame: number;
  sampler: NodeJS.Timeout | null;
  cancel(): void;
}

export class E2E {
  master!: FakeMaster;
  nh: Any;
  transport!: HostTransport;
  host!: HostRoom;
  fakeRoom!: FakeRoom;
  /** Host state bytes right after stepping into frame F (before F's events). */
  readonly hostStates = new Map<number, Uint8Array>();
  readonly hostEventFrames = new Set<number>();
  readonly syncEvents: { byId: number; desync: boolean }[] = [];
  readonly clients: ClientHandle[] = [];
  readonly errors: unknown[] = [];
  private readonly w = new Writer(8192);

  private ownsMaster = true;

  /** One FakeMaster + node-haxball instance per test file (node-haxball config is module-global). */
  static async shared(): Promise<{ master: FakeMaster; nh: Any }> {
    const master = await FakeMaster.start();
    return { master, nh: nodeHaxballFor(master) };
  }

  static async start(
    opts: Partial<HostRoomOptions> & {
      transport?: Partial<ConstructorParameters<typeof HostTransport>[0]>;
      shared?: { master: FakeMaster; nh: Any };
    } = {},
  ): Promise<E2E> {
    const e = new E2E();
    if (opts.shared) {
      e.master = opts.shared.master;
      e.nh = opts.shared.nh;
      e.ownsMaster = false;
    } else {
      e.master = await FakeMaster.start();
      e.nh = nodeHaxballFor(e.master);
    }
    e.transport = new HostTransport({ token: 'thr1.test', masterUrl: e.master.httpBase, iceServers: [], public: true, ...opts.transport });
    const { transport: _t, shared: _s, ...hostOpts } = opts;
    e.host = new HostRoom({ state: createHostRoomState({ roomName: 'e2e', playerName: 'Host' }), ...hostOpts, transport: e.transport });
    e.host.onError = (err) => e.errors.push(err);
    e.host.sequencer.onFrameStepped = (f) => {
      if (e.host.state.gameState === null && e.clients.length === 0) return;
      e.w.reset();
      writeRoomState(e.w, e.host.state);
      e.hostStates.set(f, e.w.copyBytes());
    };
    e.host.onEventApplied = (ev) => {
      e.hostEventFrames.add(ev.frame);
      if (ev.type === EventType.SetPlayerSync) e.syncEvents.push({ byId: ev.byId, desync: (ev as SetPlayerSyncEvent).desync });
    };
    const room = e.master.waitForRoom();
    e.host.start();
    e.fakeRoom = await withTimeout(room, 10_000, 'room registration');
    return e;
  }

  /** Joins a node-haxball client; resolves once it has the snapshot (onOpen). */
  async join(name: string, opts: { avatar?: string | null; flag?: string; authObj?: Any; sample?: boolean } = {}): Promise<ClientHandle> {
    const authObj = opts.authObj ?? ((await this.nh.Utils.generateAuth()) as [string, Any])[1];
    let resolveClosed!: (e: Any) => void;
    let resolveOpen!: (room: Any) => void;
    let rejectOpen!: (e: Any) => void;
    const opened = new Promise<Any>((res, rej) => {
      resolveOpen = res;
      rejectOpen = rej;
    });
    const h: ClientHandle = {
      name,
      room: null,
      closeError: null,
      closed: new Promise((r) => (resolveClosed = r)),
      checks: [],
      compared: 0,
      mismatches: [],
      lastSampledFrame: -1,
      sampler: null,
      cancel: () => {},
    };
    const j = this.nh.Room.join(
      { id: this.fakeRoom.id, password: null, authObj },
      {
        storage: { player_name: name, avatar: opts.avatar ?? null, geo: { lat: 0, lon: 0, flag: opts.flag ?? 'uy' } },
        onOpen: (room: Any) => {
          h.room = room;
          resolveOpen(room);
        },
        onClose: (err: Any) => {
          h.closeError = err;
          if (h.sampler !== null) clearInterval(h.sampler);
          h.sampler = null;
          resolveClosed(err);
          rejectOpen(err ?? new Error('closed before open'));
        },
      },
    );
    h.cancel = () => {
      try {
        j.cancel();
      } catch {
        /* gone */
      }
      try {
        h.room?.leave();
      } catch {
        /* gone */
      }
    };
    this.clients.push(h);
    const room = await withTimeout(opened, 30_000, `join ${name}`);
    // wrap the client's CheckConsistency verdict callback (node-haxball `RoomState.w1`)
    const state = room.state;
    const orig = state.w1;
    state.w1 = (desync: boolean, extra: Any) => {
      h.checks.push(desync);
      return orig?.call(state, desync, extra);
    };
    if (opts.sample !== false) h.sampler = setInterval(() => this.sample(h), 3);
    return h;
  }

  /** Compares the client's confirmed state with the host's at the same frame (when unambiguous). */
  sample(h: ClientHandle): void {
    const room = h.room;
    if (room === null || h.closeError !== null) return;
    const f = room.currentFrameNo as number;
    if (f === h.lastSampledFrame) return;
    h.lastSampledFrame = f;
    if (this.hostEventFrames.has(f)) return;
    const hostBytes = this.hostStates.get(f);
    if (hostBytes === undefined) return;
    const w = this.nh.Impl.Stream.Writer.create(4096);
    room.state.l(w);
    const clientBytes = w.toUint8Array() as Uint8Array;
    if (Buffer.compare(Buffer.from(clientBytes), Buffer.from(hostBytes)) === 0) h.compared++;
    else if (h.mismatches.length < 5) {
      h.mismatches.push({ frame: f, host: Buffer.from(hostBytes).toString('hex'), client: Buffer.from(clientBytes).toString('hex') });
    }
  }

  /** Player id of a client as seen by the host (by name). */
  idOf(h: ClientHandle): number {
    const p = this.host.state.players.find((pl) => pl.name === h.name);
    if (p === undefined) throw new Error(`no player ${h.name}`);
    return p.id;
  }

  async close(): Promise<void> {
    for (const c of this.clients) {
      if (c.sampler !== null) clearInterval(c.sampler);
      c.sampler = null;
      c.cancel();
    }
    this.host?.stop();
    if (this.ownsMaster) await this.master?.close();
  }
}

/** Call once per test file (afterAll). */
export function shutdownAll(): void {
  shutdownWebRtc();
  cleanupNodeHaxball();
}
