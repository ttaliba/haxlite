/**
 * `HBInit(config)`: the official headless RoomObject on top of
 * {@link HostRoom} + {@link HostTransport}.
 *
 * Parity notes (official `F.fi`, see src/host/README.md):
 *  - every state-changing method builds its arguments synchronously and
 *    applies them in a microtask, in call order (official
 *    `Promise.resolve().then(() => oc(event))`), so e.g.
 *    `setPlayerAdmin(id, true); getPlayer(id).admin` is still `false`;
 *  - validation errors (`.hbs` parse, unknown default stadium, bad casts)
 *    are thrown synchronously;
 *  - clearBan/clearBans/setPassword/setRequireRecaptcha/start-stopRecording
 *    and every query are synchronous;
 *  - callbacks receive fresh plain objects with the official shapes and
 *    key order; `byPlayer` is null for actions of a host without player.
 *
 * Unlike the official (synchronous) `HBInit`, this one returns a Promise: it
 * fetches the geolocation like the official script does at load time and,
 * by default, resolves once the master has assigned the room link.
 */
import {
  EdgeError,
  EdgePeerBackend,
  HostTransport,
  MasterError,
  RtcPeerBackend,
  fetchGeo,
  shutdownWebRtc,
  type BanList,
  type HostTransportOptions,
  type JoinRequest,
} from '../net/index.js';
import { HostRoom, createHostRoomState, defaultStadiumByName, type DiscPropsInput } from '../host/index.js';
import type { Player } from '../room/index.js';
import { parseHbs, type Stadium } from '../sim/index.js';
import type {
  AnnouncementSound,
  AnnouncementStyle,
  CollisionFlagsObject,
  DiscPropertiesObject,
  DiscPropertiesUpdate,
  HaxliteBans,
  HaxliteConfig,
  HaxliteRoomExtensions,
  InputFlagsObject,
  JoinRequestHandler,
  PlayerConnectionInfo,
  PlayerJoinObject,
  PlayerObject,
  RoomConfigObject,
  RoomObject,
  ScoresObject,
  TeamID,
} from './types.js';

/** Thrown (rejected) when the master asks for a captcha and no `haxlite.onRecaptcha` handler is set. */
export class InvalidRoomTokenError extends Error {
  readonly sitekey: string | null;
  constructor(sitekey: string | null = null) {
    super('Invalid room token. Generate a new token at https://www.haxball.com/headlesstoken.');
    this.name = 'InvalidRoomTokenError';
    this.sitekey = sitekey;
  }
}

/** Official `CollisionFlags` constants. */
export const CollisionFlags: CollisionFlagsObject = Object.freeze({
  ball: 1,
  red: 2,
  blue: 4,
  redKO: 8,
  blueKO: 16,
  wall: 32,
  kick: 64,
  score: 128,
  c0: 268435456,
  c1: 536870912,
  c2: 1073741824,
  c3: -2147483648,
  all: 63,
});

/** Official `InputFlags` constants. */
export const InputFlags: InputFlagsObject = Object.freeze({ up: 1, down: 2, left: 4, right: 8, kick: 16 });

const ANNOUNCEMENT_STYLES: Readonly<Record<string, number>> = {
  bold: 1,
  italic: 2,
  small: 3,
  'small-bold': 4,
  'small-italic': 5,
};

/** Rooms started and not stopped in this process (for node-datachannel cleanup). */
let liveRooms = 0;

// ------------------------------------------------------------------ conversions

/** Official `f(player)`: `{name, team, id, admin, position, input}`. */
function playerObject(p: Player | null): PlayerObject | null {
  if (p === null) return null;
  const d = p.disc;
  return {
    name: p.name as string,
    team: p.team as TeamID,
    id: p.id,
    admin: p.isAdmin,
    position: d === null ? null : { x: d.x, y: d.y },
    input: p.input,
  };
}

function playerJoinObject(p: Player): PlayerJoinObject {
  const o = playerObject(p) as PlayerJoinObject;
  o.auth = p.auth;
  o.conn = p.conn;
  return o;
}

/** Official `1 == team ? red : 2 == team ? blue : spectators` (loose equality). */
function teamArg(team: unknown): TeamID {
  // eslint-disable-next-line eqeqeq
  return team == 1 ? 1 : team == 2 ? 2 : 0;
}

/** Official `q.m(v, String)`: null passes, non-strings throw. */
function castString(v: unknown, fallback: string | null): string | null {
  if (v == null) return fallback;
  if (typeof v !== 'string') throw new TypeError(`Cannot cast ${String(v)} to String`);
  return v;
}

function castInt(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v !== 'number' || (v | 0) !== v) throw new TypeError(`Cannot cast ${String(v)} to Int`);
  return v;
}

function castBool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new TypeError(`Cannot cast ${String(v)} to Bool`);
  return v;
}

function checkFrames(name: string, v: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`haxlite.${name} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

/** An integer in [1, 600] or Infinity. */
function checkWakeFrames(v: number): number {
  return v === Infinity ? v : checkFrames('maxWakeFrames', v, 1, 600);
}

function copyDiscProps(props: DiscPropertiesUpdate | null | undefined): DiscPropsInput {
  const out: Record<string, number | null> = {};
  if (props == null) return out;
  for (const k of Object.keys(props)) out[k] = (props as Record<string, number | null>)[k] ?? null;
  return out as DiscPropsInput;
}

// ------------------------------------------------------------------ HBInit

/**
 * Creates a headless room (official `HBInit`, Promise-returning).
 *
 * ```ts
 * const room = await HBInit({ roomName: 'My room', maxPlayers: 16, noPlayer: true, token });
 * room.onPlayerJoin = (p) => room.sendAnnouncement(`Welcome ${p.name}`, p.id);
 * ```
 */
export async function HBInit(config: RoomConfigObject = {}): Promise<RoomObject> {
  const cfg = config ?? {};
  const hx: HaxliteConfig = cfg.haxlite ?? {};

  // ---- official config parsing (`g`/`k` + casts), synchronous errors
  const isPublic = cfg.public ?? false;
  const roomName = castString(cfg.roomName, 'Headless Room') as string;
  const playerName = castString(cfg.playerName, 'Host') as string;
  const noPlayer = cfg.noPlayer ?? false;
  const maxPlayers = castInt(cfg.maxPlayers, 12);
  const password = castString(cfg.password, null);
  const token = castString(cfg.token, null);
  let geo: { flag: string; lat: number; lon: number } | null = null;
  if (cfg.geo != null) {
    geo = { flag: String(cfg.geo.code).toLowerCase(), lat: cfg.geo.lat, lon: cfg.geo.lon };
    if (geo.flag.length > 3) throw new Error('Invalid country code');
  }
  const knobs = {
    inputDelayFrames: checkFrames('inputDelayFrames', hx.inputDelayFrames ?? 2, 1, 60),
    heartbeatFrames: checkFrames('heartbeatFrames', hx.heartbeatFrames ?? 7, 1, 600),
    checksumIntervalFrames: checkFrames('checksumIntervalFrames', hx.checksumIntervalFrames ?? 600, 1, 1 << 20),
    maxWakeFrames: checkWakeFrames(hx.maxWakeFrames ?? 4),
  };

  const httpOpts = { masterUrl: hx.masterUrl, agent: hx.agent };
  if (geo === null) {
    // official: `api/geo` fetched when the headless script loads
    try {
      geo = await fetchGeo(httpOpts);
    } catch {
      geo = { flag: '', lat: 0, lon: 0 };
    }
  }

  // ---- engine
  let joinHook: JoinRequestHandler | null = hx.onJoinRequest ?? null;
  const transportOpts: HostTransportOptions = {
    ...hx.transport,
    token: token ?? '',
    public: isPublic,
    password,
    maxPlayers: maxPlayers < 2 ? 2 : maxPlayers > 30 ? 30 : maxPlayers,
    roomInfo: { name: roomName, flag: geo.flag, lat: geo.lat, lon: geo.lon },
    onJoinRequest: (req: JoinRequest) => (joinHook === null ? undefined : joinHook(req)),
  };
  if (hx.masterUrl !== undefined) transportOpts.masterUrl = hx.masterUrl;
  if (hx.agent !== undefined) transportOpts.agent = hx.agent;
  if (hx.wsUrl !== undefined) transportOpts.wsUrl = hx.wsUrl;
  if (hx.iceServers !== undefined) transportOpts.iceServers = hx.iceServers;
  if (hx.allowNullAuth !== undefined) transportOpts.allowNullAuth = hx.allowNullAuth;
  if (hx.joinRateLimit !== undefined) transportOpts.joinRateLimit = hx.joinRateLimit;
  if (hx.bans !== undefined) transportOpts.bans = hx.bans;
  if (hx.edge != null) transportOpts.edge = hx.edge;
  if (hx.peerBackend !== undefined) transportOpts.peerBackend = hx.peerBackend;
  if (hx.rtc != null) transportOpts.rtcEndpoint = hx.rtc;
  const transport = new HostTransport(transportOpts);
  const host = new HostRoom({
    transport,
    state: createHostRoomState({ roomName, playerName, noPlayer, flag: geo.flag }),
    inputDelayFrames: knobs.inputDelayFrames,
    heartbeatFrames: knobs.heartbeatFrames,
    checksumIntervalFrames: knobs.checksumIntervalFrames,
    maxWakeFrames: knobs.maxWakeFrames,
    pingIntervalMs: hx.pingIntervalMs,
  });

  // ---- lifecycle / init promise
  let stopped = false;
  let initialized = false;
  let initResolve: ((room: RoomObject) => void) | null = null;
  let initReject: ((err: unknown) => void) | null = null;
  let initTimer: NodeJS.Timeout | null = null;
  let roomLink: string | null = null;
  let pendingLink: string | null = null;
  let roomLinkHandler: ((url: string) => void) | null | undefined = undefined;

  const reportError = (err: unknown): void => {
    const h = ext.onError;
    if (h != null) {
      try {
        h(err);
      } catch {
        /* ignore */
      }
    } else {
      console.error('[haxlite]', err);
    }
  };

  const finishInit = (err: unknown): void => {
    if (initialized) return;
    initialized = true;
    if (initTimer !== null) clearTimeout(initTimer);
    initTimer = null;
    const res = initResolve;
    const rej = initReject;
    initResolve = initReject = null;
    if (err === null) res?.(room);
    else {
      stop().catch(reportError);
      rej?.(err);
    }
  };

  const useRecaptchaToken = (response: string): void => {
    if (!stopped) transport.useRecaptchaToken(response);
  };

  host.onError = reportError;
  transport.onError = (err) => {
    if (err instanceof MasterError && err.kind === 'recaptcha') return; // handled by onRecaptcha
    // edge tunnel: keep retrying until initTimeoutMs unless the error is fatal (bad key/version)
    if (!initialized && err instanceof EdgeError && !err.fatal) return;
    if (!initialized) finishInit(err);
    else reportError(err);
  };
  transport.onRecaptcha = (sitekey) => {
    if (!initialized) {
      const h = hx.onRecaptcha;
      if (h == null) {
        finishInit(new InvalidRoomTokenError(sitekey));
        return;
      }
      try {
        h(sitekey, useRecaptchaToken);
      } catch (err) {
        finishInit(err);
      }
      return;
    }
    const h = ext.onRecaptcha;
    if (h != null) {
      try {
        h(sitekey);
      } catch (err) {
        reportError(err);
      }
    } else reportError(new InvalidRoomTokenError(sitekey));
  };
  host.onRoomLink = (link) => {
    roomLink = link;
    const cb = roomLinkHandler;
    if (cb != null) cb(link);
    else pendingLink = link;
    // peerBackend 'rtc' binds its UDP socket during signaling: resolve once it
    // listens (rtcPort set), or reject with the listen error
    const b = transport.backend;
    if (!initialized && b instanceof RtcPeerBackend && !b.ready) {
      b.whenListening().then(
        () => finishInit(null),
        (err: unknown) => finishInit(err),
      );
    } else finishInit(null);
  };

  /** Official `c(event)`: apply in a microtask, in call order. */
  let deferSeq = 0;
  const defer = (fn: () => void): void => {
    deferSeq++;
    queueMicrotask(() => {
      if (!stopped) fn();
    });
  };

  // haxlite private visuals: consecutive calls (no other action in between)
  // share one deferred batch, sent as shared slots (HostRoom.batchPrivate).
  type PrivateUpdate = { viewerId: number; discIndex: number; props: DiscPropsInput; force: boolean };
  let privateList: PrivateUpdate[] | null = null;
  let privateSeq = -1;
  const privateBatch = (u: PrivateUpdate): void => {
    if (privateList === null || privateSeq !== deferSeq) {
      const list: PrivateUpdate[] = [];
      privateList = list;
      defer(() => {
        if (privateList === list) privateList = null;
        host.batchPrivate(() => {
          for (const p of list) {
            if (p.discIndex < 0) host.clearDiscOverrides(p.viewerId);
            else host.setDiscPropertiesFor(p.viewerId, p.discIndex, p.props, p.force);
          }
        });
      });
      privateSeq = deferSeq;
    }
    privateList.push(u);
  };

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (initTimer !== null) clearTimeout(initTimer);
    initTimer = null;
    host.stop();
    liveRooms--;
    if (!initialized) {
      initialized = true;
      const rej = initReject;
      initResolve = initReject = null;
      rej?.(new Error('room stopped before initialization'));
    }
    const backend = transport.backend;
    if (backend instanceof RtcPeerBackend) await backend.whenClosed(); // UDP socket released
    if (liveRooms === 0 && hx.shutdownWebRtcOnLastStop !== false) {
      // let pending native callbacks drain first
      await new Promise<void>((r) => setImmediate(r));
      if (liveRooms === 0) await shutdownWebRtc();
    }
  }

  const bans: BanList = transport.bans;
  const banOps: HaxliteBans = {
    addIp: (ip, note = null) => bans.addIp(ip, note),
    addRange: (cidr, note = null) => bans.addRange(cidr, note),
    addAuth: (auth, note = null) => bans.addAuth(auth, note),
    list: () => bans.list(),
    remove: (id) => bans.remove(id),
    clear: () => bans.clear(),
    isIpBanned: (ip) => bans.isIpBanned(ip),
    isAuthBanned: (auth) => bans.isAuthBanned(auth),
  };

  const ext: HaxliteRoomExtensions = {
    get inputDelayFrames() {
      return host.inputDelayFrames;
    },
    set inputDelayFrames(v: number) {
      host.inputDelayFrames = checkFrames('inputDelayFrames', v, 1, 60);
    },
    get heartbeatFrames() {
      return host.heartbeatFrames;
    },
    set heartbeatFrames(v: number) {
      host.heartbeatFrames = checkFrames('heartbeatFrames', v, 1, 600);
    },
    get checksumIntervalFrames() {
      return host.checksumIntervalFrames;
    },
    set checksumIntervalFrames(v: number) {
      host.checksumIntervalFrames = checkFrames('checksumIntervalFrames', v, 1, 1 << 20);
    },
    get maxWakeFrames() {
      return host.maxWakeFrames;
    },
    set maxWakeFrames(v: number) {
      host.maxWakeFrames = checkWakeFrames(v);
    },
    get roomLink() {
      return roomLink;
    },
    get frame() {
      return host.frame;
    },
    get stopped() {
      return stopped;
    },
    bans: banOps,
    get onBeforeOperation() {
      return host.onBeforeOperation;
    },
    set onBeforeOperation(h) {
      host.onBeforeOperation = h;
    },
    get onJoinRequest() {
      return joinHook;
    },
    set onJoinRequest(h: JoinRequestHandler | null) {
      joinHook = h ?? null;
    },
    onRecaptcha: null,
    onError: null,
    useRecaptchaToken,
    getPlayerConnection(playerId: number): PlayerConnectionInfo | null {
      const c = host.getConnection(playerId);
      if (c === null || c.closed) return null;
      return {
        auth: c.auth,
        conn: c.conn,
        ip: c.peer.ip,
        srflxIps: c.peer.srflxIps,
        ping: c.ping,
        remoteAddress: c.peer.remoteAddress,
      };
    },
    edgeStats() {
      const b = transport.backend;
      return b instanceof EdgePeerBackend ? b.stats() : null;
    },
    rtcStats() {
      const b = transport.backend;
      return b instanceof RtcPeerBackend ? b.stats() : null;
    },
    get rtcPort() {
      const b = transport.backend;
      return b instanceof RtcPeerBackend ? b.port : null;
    },
    get onBackendState() {
      return transport.onBackendState;
    },
    set onBackendState(h) {
      transport.onBackendState = h ?? null;
    },
    setMaxPlayers(n: number) {
      const v = castInt(n, 12);
      host.setMaxPlayers(v < 2 ? 2 : v > 30 ? 30 : v);
    },
    setDiscPropertiesFor(viewerId: number, discIndex: number, properties: DiscPropertiesUpdate, opts?: { force?: boolean }) {
      const update = { viewerId: castInt(viewerId, 0), discIndex: castInt(discIndex, 0), props: copyDiscProps(properties), force: opts?.force === true };
      privateBatch(update);
    },
    clearDiscOverrides(viewerId: number) {
      privateBatch({ viewerId: castInt(viewerId, 0), discIndex: -1, props: {}, force: false });
    },
    getDiscPropertiesFor(viewerId: number, discIndex: number) {
      return host.getDiscPropertiesFor(viewerId, discIndex);
    },
    setPlayerHiddenFor(viewerId: number, playerId: number, hidden: boolean) {
      const v = castInt(viewerId, 0);
      const p = castInt(playerId, 0);
      const h = hidden === true;
      defer(() => host.setPlayerHiddenFor(v, p, h));
    },
    hidePlayerFor(viewerId: number, playerId: number) {
      this.setPlayerHiddenFor(viewerId, playerId, true);
    },
    showPlayerFor(viewerId: number, playerId: number) {
      this.setPlayerHiddenFor(viewerId, playerId, false);
    },
    isPlayerHiddenFor(viewerId: number, playerId: number) {
      return host.isPlayerHiddenFor(viewerId, playerId);
    },
    getHiddenPlayersFor(viewerId: number) {
      return host.getHiddenPlayersFor(viewerId);
    },
    hasPrivateView(viewerId: number) {
      return host.hasPrivateView(viewerId);
    },
    get onPrivateViewEnd() {
      return host.onPrivateViewEnd;
    },
    set onPrivateViewEnd(h) {
      host.onPrivateViewEnd = h ?? null;
    },
    stop,
    close: stop,
    host,
    transport,
  };

  // ---- the official room object (closures, like official: methods may be detached)
  const room: RoomObject = {
    sendChat(message: string, targetId?: number | null) {
      const msg = String(message);
      const target = targetId ?? null;
      defer(() => host.sendChat(msg, target));
    },
    sendAnnouncement(
      msg: string,
      targetId?: number | null,
      color?: number | null,
      style?: AnnouncementStyle | null,
      sound?: AnnouncementSound | null,
    ) {
      const text = String(msg);
      const st = (style != null ? ANNOUNCEMENT_STYLES[style] : undefined) ?? 0;
      const col = color ?? -1;
      const snd = sound ?? 1;
      const target = targetId ?? null;
      defer(() => host.sendAnnouncement(text, target, col, st, snd));
    },
    setPlayerAdmin(playerId: number, admin: boolean) {
      const on = !!admin;
      defer(() => host.setPlayerAdmin(playerId, on));
    },
    setPlayerTeam(playerId: number, team: TeamID) {
      const t = teamArg(team);
      defer(() => host.setPlayerTeam(playerId, t));
    },
    setPlayerAvatar(playerId: number, avatar: string | null) {
      const a = avatar ?? null;
      defer(() => host.setPlayerAvatar(playerId, a));
    },
    kickPlayer(playerId: number, reason?: string | null, ban?: boolean) {
      const r = reason ?? '';
      const b = !!ban;
      defer(() => host.kickPlayer(playerId, r, b));
    },
    clearBan(playerId: number) {
      host.clearBan(playerId);
    },
    clearBans() {
      // official: the (kick-)ban list; haxlite IP/range/auth bans are kept (use haxlite.bans.clear())
      for (const rec of bans.list()) if (rec.kind === 'peer') bans.remove(rec.id);
    },
    setScoreLimit(limit: number) {
      defer(() => host.setScoreLimit(limit));
    },
    setTimeLimit(limitInMinutes: number) {
      defer(() => host.setTimeLimit(limitInMinutes));
    },
    setCustomStadium(stadiumFileContents: string) {
      let s: Stadium;
      try {
        s = parseHbs(stadiumFileContents);
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err), { cause: err });
      }
      defer(() => host.setStadium(s));
    },
    setDefaultStadium(stadiumName: string) {
      const s = defaultStadiumByName(stadiumName);
      if (s === null) throw new Error("Stadium doesn't exist");
      defer(() => host.setStadium(s));
    },
    setDiscProperties(discIndex: number, properties: DiscPropertiesUpdate) {
      const p = copyDiscProps(properties);
      defer(() => host.setDiscProperties(discIndex, p));
    },
    setPlayerDiscProperties(playerId: number, properties: DiscPropertiesUpdate) {
      const p = copyDiscProps(properties);
      defer(() => host.setPlayerDiscProperties(playerId, p));
    },
    setTeamColors(team: TeamID, angle: number, textColor: number, colors: readonly number[]) {
      const t = teamArg(team);
      const cs = Array.from(colors);
      defer(() => host.setTeamColors(t, angle, textColor, cs));
    },
    setKickRateLimit(min?: number | null, rate?: number | null, burst?: number | null) {
      const a = min ?? 2;
      const b = rate ?? 0;
      const c = burst ?? 0;
      defer(() => host.setKickRateLimit(a, b, c));
    },
    startGame() {
      defer(() => host.startGame());
    },
    stopGame() {
      defer(() => host.stopGame());
    },
    pauseGame(pauseState: boolean) {
      const p = !!pauseState;
      defer(() => host.pauseGame(p));
    },
    setTeamsLock(locked: boolean) {
      const l = !!locked;
      defer(() => host.setTeamsLock(l));
    },
    setPassword(pass: string | null) {
      host.setPassword(castString(pass, null));
    },
    setRequireRecaptcha(required: boolean) {
      host.setRequireRecaptcha(castBool(required));
    },
    reorderPlayers(playerIdList: readonly number[], moveToTop: boolean) {
      const ids = Array.from(playerIdList);
      const top = !!moveToTop;
      defer(() => host.reorderPlayers(ids, top));
    },
    getPlayerList(): PlayerObject[] {
      const ps = host.getPlayerList();
      const out: PlayerObject[] = [];
      for (let i = 0; i < ps.length; i++) out.push(playerObject(ps[i]!)!);
      return out;
    },
    getPlayer(playerId: number): PlayerObject | null {
      return playerObject(host.getPlayer(playerId));
    },
    getScores(): ScoresObject | null {
      return host.getScores();
    },
    getBallPosition() {
      return host.getBallPosition();
    },
    getPlayerDiscProperties(playerId: number): DiscPropertiesObject | null {
      return host.getPlayerDiscProperties(playerId);
    },
    getDiscProperties(discIndex: number): DiscPropertiesObject | null {
      return host.getDiscProperties(discIndex);
    },
    getDiscCount() {
      return host.getDiscCount();
    },
    startRecording() {
      host.startRecording();
    },
    stopRecording() {
      return host.stopRecording();
    },
    stopRecordingAsync() {
      return host.stopRecordingAsync();
    },
    CollisionFlags,
    InputFlags,
    get onRoomLink() {
      return roomLinkHandler;
    },
    set onRoomLink(fn: ((url: string) => void) | null | undefined) {
      roomLinkHandler = fn;
      if (fn != null && pendingLink !== null) {
        const link = pendingLink;
        pendingLink = null;
        // Delivered to whichever handler is current by then: a script that
        // wraps its handlers right after assigning them (same tick) must
        // still get the link; a handler cleared in between keeps it pending.
        queueMicrotask(() => {
          if (stopped) return;
          const cb = roomLinkHandler;
          if (cb == null) {
            pendingLink ??= link;
            return;
          }
          try {
            cb(link);
          } catch (err) {
            reportError(err);
          }
        });
      }
    },
    haxlite: ext,
  };

  // ---- room hooks -> official callbacks (official `F.fi` wiring)
  host.onPlayerJoin = (p) => {
    const cb = room.onPlayerJoin;
    if (cb != null) cb(playerJoinObject(p));
  };
  host.onPlayerLeave = (p) => {
    const cb = room.onPlayerLeave;
    if (cb != null) cb(playerObject(p)!);
  };
  host.onPlayerKicked = (p, reason, ban, by) => {
    const cb = room.onPlayerKicked;
    if (cb != null) cb(playerObject(p)!, reason, ban, playerObject(by));
  };
  const hooks = host.state.hooks;
  const state = host.state;
  hooks.onTeamVictory = () => {
    const cb = room.onTeamVictory;
    if (cb != null && state.gameState !== null) cb(host.getScores()!);
  };
  hooks.onPlayerChatFilter = (p, msg) => {
    const cb = room.onPlayerChat;
    // eslint-disable-next-line eqeqeq
    return cb == null ? true : (cb(playerObject(p)!, msg) as unknown) != 0;
  };
  hooks.onPlayerBallKick = (p) => {
    const cb = room.onPlayerBallKick;
    if (cb != null) cb(playerObject(p)!);
  };
  hooks.onTeamGoal = (team) => {
    const cb = room.onTeamGoal;
    if (cb != null && state.gameState !== null) cb(team as TeamID);
  };
  hooks.onGameStart = (by) => {
    const cb = room.onGameStart;
    if (cb != null) cb(playerObject(by));
  };
  hooks.onGameStop = (by) => {
    const cb = room.onGameStop;
    if (cb != null) cb(playerObject(by));
  };
  hooks.onPlayerTeamChange = (by, p) => {
    const cb = room.onPlayerTeamChange;
    if (cb != null) cb(playerObject(p)!, playerObject(by));
  };
  hooks.onPlayerAdminChange = (by, p) => {
    const cb = room.onPlayerAdminChange;
    if (cb != null) cb(playerObject(p)!, playerObject(by));
  };
  hooks.onGameTick = () => {
    const cb = room.onGameTick;
    if (cb != null) cb();
  };
  hooks.onGamePauseChange = (by, paused) => {
    const cb = paused ? room.onGamePause : room.onGameUnpause;
    if (cb != null) cb(playerObject(by));
  };
  hooks.onPositionsReset = () => {
    const cb = room.onPositionsReset;
    if (cb != null) cb();
  };
  hooks.onPlayerInput = (p, prev) => {
    const a = room.onPlayerActivity;
    if (a != null) a(playerObject(p)!);
    const i = room.onPlayerInput;
    if (i != null) i(playerObject(p)!, prev);
  };
  hooks.onStadiumChange = (by, stadium) => {
    const cb = room.onStadiumChange;
    if (cb != null) cb(stadium.name as string, playerObject(by));
  };
  hooks.onKickRateLimitSet = (by, min, rate, burst) => {
    const cb = room.onKickRateLimitSet;
    if (cb != null) cb(min, rate, burst, playerObject(by));
  };
  hooks.onTeamsLockChange = (by, locked) => {
    const cb = room.onTeamsLockChange;
    if (cb != null) cb(locked, playerObject(by));
  };

  // ---- start
  liveRooms++;
  const ready = new Promise<RoomObject>((resolve, reject) => {
    initResolve = resolve;
    initReject = reject;
  });
  host.start();
  if (hx.waitForLink === false) finishInit(null);
  else if (!initialized) {
    const ms = hx.initTimeoutMs ?? 30_000;
    initTimer = setTimeout(() => finishInit(new Error(`HBInit: no room link after ${ms} ms`)), ms);
  }
  return ready;
}
