/**
 * Network constants transcribed from the official headless host (hash
 * f066733d; minified names in `off:` comments) — see docs/01 §1, §2, §6.
 */

/** Master HTTP base (`za.Le`). Endpoints are appended: `api/host`, `api/geo`, `api/list`. */
export const DEFAULT_MASTER_URL = 'https://www.haxball.com/rs/';
/** Room link prefix (`F.uh`): `play?c=<roomId>` + `&p=1` when the room has a password. */
export const DEFAULT_ROOM_LINK_BASE = 'https://www.haxball.com/play?c=';
/** STUN servers (`za.Ld = [{urls: 'stun:stun.l.google.com:19302'}]`). No TURN. */
export const DEFAULT_ICE_SERVERS: readonly string[] = ['stun:stun.l.google.com:19302'];
/**
 * Origin header for the signaling WebSocket. The master validates Origin;
 * haxball.js (which runs the official headless in Node) uses this value.
 */
export const DEFAULT_WS_ORIGIN = 'https://html5.haxball.com';

/** Negotiated data channels (`kb.channels`), id = index. */
export const CHANNELS: readonly { label: string; reliable: boolean; ordered: boolean }[] = [
  { label: 'ro', reliable: true, ordered: true }, // id 0
  { label: 'ru', reliable: true, ordered: false }, // id 1
  { label: 'uu', reliable: false, ordered: false }, // id 2 (maxRetransmits: 0)
];

/** Join rejection codes sent to the master (`Aa.pc(peer, code)`), surfaced as the client WS close code. */
export const RejectCode = {
  /** Malformed offer payload (`this.pc(b, 0)` in `Aa.Zg`). */
  ParseError: 0,
  /** "The room is full." (`va.zc(4100)`) */
  Full: 4100,
  /** "Wrong password." */
  WrongPassword: 4101,
  /** "You are banned from this room." (conn or srflx IP) */
  Banned: 4102,
  /** "Incompatible game version." */
  Version: 4103,
  /** ">= 16 pending negotiations" ("Connection closed (4104)"). */
  TooManyPending: 4104,
} as const;

/** WebSocket close codes used by the master. */
export const MasterCloseCode = {
  /** Host WS: do not reconnect (`4001 != g.code`). Client WS: "The room was closed." */
  RoomClosed: 4001,
  /** Client WS: the room requires a captcha token. */
  RecaptchaRequired: 4004,
} as const;

/** Master -> host signaling message types (`Aa.ah`). */
export const MasterToHost = {
  Offer: 1,
  Candidate: 4,
  RoomLink: 5,
  Token: 6,
} as const;

/** Host -> master signaling message types. */
export const HostToMaster = {
  /** `[0][u32 peer]` end of signaling, or `[0][u32 peer][u16 code]` rejection. */
  End: 0,
  Answer: 1,
  Candidate: 4,
  RoomInfo: 7,
  KeepAlive: 8,
  RequireRecaptcha: 9,
} as const;

/** Client <-> master signaling message types (`dc` in game-min.js). */
export const ClientSignal = {
  /** client: ICE gathering done (no payload). */
  Done: 0,
  /** client: offer + join data; master: answer. */
  Offer: 1,
  Candidate: 4,
} as const;

/** Timings and limits of the official host (docs/01 §6). */
export const NetDefaults = {
  /** Host keep-alive (`setInterval(Yh, 4e4)`). */
  keepAliveMs: 40_000,
  /**
   * haxlite: max time for the master WS upgrade (TCP + TLS + HTTP 101). The
   * official host relies on the browser's (long) defaults.
   */
  signalingHandshakeTimeoutMs: 15_000,
  /** RoomInfo batching window after a send (`setTimeout(…, 1e4)` in `Aa.ae`). */
  roomInfoThrottleMs: 10_000,
  /** Debounce of the "require captcha" flag (`Aa.$d`). */
  recaptchaDebounceMs: 1_000,
  /** Reconnect delay = min + random() * range (`Sh = 1e4`, `Th = 5e4`). */
  reconnectMinMs: 10_000,
  reconnectRangeMs: 50_000,
  /** Max simultaneous negotiations (`16 <= this.zb.size` -> 4104). */
  maxPendingNegotiations: 16,
  /** Max wait for local ICE gathering before sending the answer (`ub.li`). */
  answerIceWaitMs: 500,
  /** Delay applied to remote candidates on a "reverse connection" offer (`l.Qe = 2500`). */
  reverseIceDelayMs: 2_500,
  /** Channel 0 must open within this time after the offer (`la.gi`, 1e4). */
  channelOpenTimeoutMs: 10_000,
  /** Connected peer idle timeout (`Ya.Qh = 1e4`). */
  peerIdleTimeoutMs: 10_000,
  /** Per-connection message flood bucket (`new Ra(100, 16)`). */
  floodCapacity: 100,
  floodMsPerToken: 16,
  /** Max inflated signaling payload (`new Uint8Array(51200)` bounded inflater). */
  signalingInflateLimit: 51_200,
} as const;

/** Join info limits checked by the official host (`D.yh`), in UTF-16 code units. */
export const JoinLimits = {
  name: 25,
  flag: 3,
  avatar: 2,
} as const;

/** RoomInfo limits (`ab.yg`). */
export const RoomInfoLimits = {
  name: 40,
  flag: 3,
} as const;
