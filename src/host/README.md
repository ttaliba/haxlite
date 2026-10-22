# src/host — authoritative host engine

Owner: engineer H. Depends on `room`, `sim`, `net`, `replay`, `codec`. Exported from
`src/host/index.ts`.

| Export | What |
|---|---|
| `HostRoom` | the engine: clock, sequencing, joins/leaves/kicks/bans, pings, host actions, queries, recording |
| `createHostRoomState(opts)` | initial `RoomState` as official `HBInit` builds it (room name, host player id 0, admin) |
| `Sequencer` | pure, clock/transport-free event pipeline (official `Ma` + `Wa`); tested against the official `Wa` |
| `SequencerClient`, `HostConnection` | per-connection state (official `Za`) |
| `MovingAverage`, `ProtocolViolation`, `encodePong`, `encodeTargetedEvent`, `HostDefaults` | helpers |

## Quick start (what the HBInit facade does)

```ts
import { HostTransport } from '../net/index.js';
import { HostRoom, createHostRoomState } from '../host/index.js';

const transport = new HostTransport({ token, public: true, maxPlayers: clamp(maxPlayers, 2, 30),
  password, roomInfo: { name: roomName, flag, lat, lon } });
const host = new HostRoom({
  transport,
  state: createHostRoomState({ roomName, playerName, noPlayer, flag }),
  // inputDelayFrames: 2, heartbeatFrames: 7, checksumIntervalFrames: 600, pingIntervalMs: 3000
});
host.onRoomLink = (link) => room.onRoomLink?.(link);
host.onPlayerJoin = (p) => room.onPlayerJoin?.(toPlayerObject(p));   // p.auth / p.conn are set
host.onPlayerLeave = (p) => room.onPlayerLeave?.(toPlayerObject(p));
host.onPlayerKicked = (p, reason, ban, by) => room.onPlayerKicked?.(toPlayerObject(p), reason, ban, toPlayerObject(by));
host.state.hooks.onPlayerChatFilter = (p, msg) => room.onPlayerChat?.(toPlayerObject(p), msg) !== false;
host.state.hooks.onGameTick = () => room.onGameTick?.();
// … every other rs.hooks slot, see the mapping table below
host.start();
```

## Clock and scheduling

* `frame = ((performance.now() - start) * 0.06) | 0` exactly as official; each wake-up simulates
  **every** pending frame one by one (catch-up, official `Wa.Da`), then sends the periodic
  heartbeat (see the grid below) and heartbeat + CheckConsistency every `checksumIntervalFrames`.
* **Process-wide grids** (real clock): `start` is the last 60 Hz boundary of the process
  (`floor(t0 * 0.06) / 0.06`, never sent anywhere: pongs carry frames), so every room's frame
  boundaries are the same instants. On top of it, an **absolute heartbeat grid**: periodic
  heartbeats leave on frames where `(gridBase + frame) % heartbeatFrames === 0` (`gridBase` =
  index of frame 0 on the process grid; 0 with an injected clock) instead of
  `lastHeartbeat + heartbeatFrames`, and the in-game catch-ups, CheckConsistency (first grid
  point ≥ `lastChecksum + checksumIntervalFrames`) and the Ping event are placed on that same
  grid. All rooms of a process therefore wake on the same ~2 boundaries per heartbeat period:
  **~17 wake-ups/s per process whatever the number of rooms** (was ~17 per room, capped at 60).
  A wake-up more than a frame late delays that heartbeat but does not shift the next one.
  Host events still heartbeat right away (official `oc`).
* Instead of the official 50 ms `setInterval`, every `HostRoom` registers in **one
  process-wide clock** (`src/host/clock.ts`, `hostClock`): a single `setTimeout` armed for the
  earliest room that has work, re-armed only when that time changes. A room asks to be woken at:
  * with ready clients: the next heartbeat grid point and the CheckConsistency grid point
    (and, without a game or with a fully paused one, the next queued event);
  * the Ping event (`pingIntervalMs`, only while clients are connected; rounded up to a
    heartbeat grid point, nominal cadence kept);
  * while a game runs (not fully paused): at least every `maxWakeFrames` (default 4 = 66.7 ms;
    official ≈ 3), on catch-up points spread evenly inside each grid period (default: grid
    point +4 and +7 → ~17 wake-ups/s, official 20/s; `maxWakeFrames: Infinity` → one per
    heartbeat, ~8.6/s). The room takes the LAST such point within `maxWakeFrames` of the frame
    it last caught up to, so a room kept busy by client messages skips points.
  * a fully paused game (`pauseGameTickCounter === 120`) runs no per-frame hook: no catch-up
    bound, only heartbeats (~8.6/s with clients, 0 without); the unpause countdown restores it.
  It bounds how late per-frame hooks (`onGameTick`, `onTeamGoal`, …) fire and how stale getters
  are between messages; every frame is still simulated (and `onGameTick` called) exactly once.
* **No clients and no game → no wake-ups at all** (0 CPU); the frame counter is virtual and is
  caught up (O(1) for game-less frames) on the next message/action/`update()`.
* Every incoming client message first catches the clock up (official `Jh` → `Da`), and so do
  host actions (the official `oc` stamps with a possibly 50 ms-stale frame; ours is exact).
* The clock adds 1 ms of slack to each timer on Node (its millisecond timer clock can fire up
  to ~1 ms early, which would cost a second wake-up): heartbeats leave ~1–2 ms after their
  frame boundary. Bun never fires early (0/1000 samples): no slack there.

* **Bundling scope**: every wake-up, client message and top-level action runs inside the peer
  backend's optional `cork()`/`uncork()` (implemented by the haxlite-rtc backend): all the
  messages one peer gets in that event-loop iteration — from every step that ran in it (event on
  `ru`, heartbeat on `uu`, pong, the SACK it is owed…) — leave as one SCTP packet / DTLS record /
  datagram from a single `setImmediate` (check phase, right after poll: no timer, no added
  wait). Other backends ignore it. Opt-in `rtc.sendBatchFrames: 1 | 2` additionally holds `ru`
  messages until the next 1- or 2-frame boundary of the same process-wide 60 Hz grid the rooms
  wake on (docs/10 §6.7).
* **Heartbeat piggyback** (bundling backends only): after broadcasting a client event, the
  host also sends the heartbeat if its grid point is within `floor((heartbeatFrames - 1) / 3)`
  frames (2 with the default 7); that heartbeat covers the grid point. It leaves in the same
  packet as the event, so with ~6 inputs/s per player almost no heartbeat needs its own
  datagram per client. Heartbeat gaps: `heartbeatFrames ± lead` (5..9 by default; the official
  host's 50 ms loop gives 7..9, and it heartbeats after each of its own events). Other backends
  keep the exact grid cadence.
* Received message bytes may be transient (rtc backend): `handleMessage` consumes them
  synchronously and copies only when it has to defer the message.

## Netcode knobs (host-only, compatible with official clients)

| Option | Default | Effect |
|---|---|---|
| `inputDelayFrames` (`Sb`) | 2 | Frames between "now" and the frame a client input is scheduled for. The pong carries `hostFrame + Sb`, so clients adapt automatically. Higher = fewer late (re-stamped) inputs on jittery links; lower = less input lag. E2E-tested with 1, 2, 4. |
| `heartbeatFrames` | 7 | Clients only advance their *confirmed* state when a heartbeat (msg 3) arrives, and extrapolate from it for rendering. Lower values (e.g. 2) shorten that extrapolation window → fewer visible corrections of remote players, at ~9 bytes × clients per heartbeat on `uu`. E2E-tested with 2 and 7. |
| `checksumIntervalFrames` | 600 | CheckConsistency period. |
| `pingIntervalMs` | 3000 | Ping event period. |
| `maxWakeFrames` | 4 | While a game runs, simulate at least every N frames without messages (hook latency / getter staleness vs wake-ups; see above). `Infinity` = only at heartbeats/messages. |

## Facade-facing API

### Callbacks

| HostRoom | Official HBInit | Notes |
|---|---|---|
| `onPlayerJoin(player)` | `onPlayerJoin` | fired while the JoinRoom event applies; `player.auth`/`player.conn` set |
| `onPlayerLeave(player)` | `onPlayerLeave` | every removal (leave, kick, ban, "Bad actor") |
| `onPlayerKicked(player, reason, ban, byPlayer)` | `onPlayerKicked` | after `onPlayerLeave` when there was a reason; `byPlayer` null = host id 0 without a host player |
| `onRoomLink(link)` | `onRoomLink` | |
| `onBeforeOperation(ev, byId, requestedFrame)` | — (node-haxball `onOperationReceived`) | client events only, after frame assignment and the chat filter; return `false` to drop; payload mutable; throw = "Bad actor" |
| `onEventApplied(ev)` | (`Ab`) | every applied event (recording/diagnostics) |
| `onBadActor(playerId, err)` | — | diagnostics |
| `onError(err)` | — | exceptions thrown by callbacks/hooks are reported here and never break the engine |

**Do not set `state.hooks.onPlayerJoin` / `onPlayerLeave`** (HostRoom owns them) nor
`onGoalMarker` while recording (the recorder chains it). Every other `state.hooks` slot is the
facade's. Mapping to the official `HBInit` callbacks (from `hl.js` `F.fi`):

| `state.hooks` slot | HBInit callback |
|---|---|
| `onPlayerChatFilter(p, msg)` → boolean | `onPlayerChat(player, msg)`; returning `false` drops the message. Only CLIENT chat goes through it (the host's own `sendChat` doesn't, like official). Throwing kicks the sender ("Bad actor") like official. |
| `onPlayerInput(p, prevInput)` | `onPlayerActivity(player)` **then** `onPlayerInput(player, prevInput)` (official `vf`; only for players with a disc) |
| `onPlayerBallKick(p)` | `onPlayerBallKick` |
| `onTeamGoal(team)` | `onTeamGoal(team)` (official checks a game exists) |
| `onTeamVictory(winner)` | `onTeamVictory(scores)` (call `host.getScores()`) |
| `onGameStart(by)` / `onGameStop(by)` | `onGameStart(byPlayer)` / `onGameStop(byPlayer)` |
| `onGamePauseChange(by, paused)` | `onGamePause(by)` / `onGameUnpause(by)` |
| `onGameTick()` | `onGameTick` |
| `onPositionsReset()` | `onPositionsReset` |
| `onPlayerTeamChange(by, p, team)` | `onPlayerTeamChange(player, byPlayer)` |
| `onPlayerAdminChange(by, p)` | `onPlayerAdminChange(player, byPlayer)` |
| `onStadiumChange(by, stadium)` | `onStadiumChange(stadium.name, byPlayer)` |
| `onKickRateLimitSet(by, min, rate, burst)` | `onKickRateLimitSet(min, rate, burst, byPlayer)` |
| `onTeamsLockChange(by, locked)` | `onTeamsLockChange(locked, byPlayer)` |
| `onTimeLimitReached()` | `haxlite.onTimeLimitReached()` (haxlite only) |
| `onPlayerDesyncChange(player)` | `haxlite.onPlayerDesyncChange(player, desync)` (haxlite only) |
| `onChatIndicator(player, value)` | `haxlite.onChatIndicator(player, typing)` (haxlite only) |
| `onTeamColorsChange(by, team, colors)` | `haxlite.onTeamColorsChange(team, colors, byPlayer)` (haxlite only) |

Official HBInit does NOT wire `onPlayerChat` (applied chat), `onChatIndicator`, `onAnnouncement`,
`onPlayerDesyncChange`, `onConsistencyResult`, `onTimeLimitReached`; they are free extensions.

### Actions (all emitted as player 0, official `oc`)

`emit(ev)`, `emitTo(ev, playerId)` (msg 6), `sendChat(msg, targetId?)`,
`sendAnnouncement(msg, targetId?, color=-1, style=0, sound=1)` (style is numeric: map
`bold→1, italic→2, small→3, small-bold→4, small-italic→5`, unknown→0; `null` sound → 1),
`setPlayerAdmin`, `setPlayerTeam(id, team)` (1 red, 2 blue, else spec), `setPlayerAvatar(id, avatar)`
(SetHeadlessAvatar), `kickPlayer(id, reason = '', ban = false)`, `clearBan(playerId)`, `clearBans()`,
`setScoreLimit`, `setTimeLimit`, `setStadium(stadium)`, `setCustomStadium(hbs)` (throws the parse
error), `setDefaultStadium(name)` (throws `Stadium doesn't exist`), `setTeamsLock`,
`setTeamColors(team, angleDeg, textColor, colors)`, `setKickRateLimit(min=2, rate=0, burst=0)`,
`startGame`, `stopGame`, `pauseGame(paused)`, `setDiscProperties(index, props)`,
`setPlayerDiscProperties(id, props)` (`props` use HBInit names incl. `bCoeff`), `reorderPlayers(ids, moveToTop)`,
`setPassword`, `setRequireRecaptcha`, `setMaxPlayers` (extension), `startRecording()`,
`stopRecording()` → `.hbr2` bytes | null, `stopRecordingAsync()` (extension, also on the HBInit
RoomObject: same bytes, recording stops at the call, only the deflate runs on the libuv
threadpool), `update()` (catch up now). `recorder` is created on first use.

**Timing / parity.** Actions run synchronously (the state reflects them on return), except when
called from inside a room hook / HostRoom callback that fires while events are applied: then
they are deferred until that apply/step loop ends (still before control returns to the event
loop). The official `HBInit` defers *every* action with `Promise.resolve().then(...)`; for strict
parity (e.g. `setPlayerAdmin(id, true); getPlayer(id).admin` is still `false` officially) the
facade can wrap calls in `queueMicrotask`. Validation errors (`setDefaultStadium`, `.hbs` parse)
are thrown synchronously, as official.

### Queries

`getPlayerList()` / `getPlayer(id)` return live `Player` model objects (convert to HBInit
`PlayerObject`: `{name, team, id, admin, position: disc ? {x, y} : null, auth, conn}`),
`getLinkQuality(id)` (host-measured jitter / lost pings / late inputs / host timer lag, link-stats.ts), `getRoomSettings()`, `getGameInfo()`, `getPlayerInfo(id)`, `getStadium()` (plain data, src/host/stadium-info.ts), `getKickRateLimit()`, `getRecordingInfo()`, `setTouchTracking(on)` / `getLastTouches()` (opt-in last / previous ball toucher, src/room/touches.ts), `getScores()` (`timeLimit` in seconds), `getTeamColors(team)` (degrees, like `setTeamColors`), `getBallPosition()`, `getDiscProperties(i)`,
`getPlayerDiscProperties(id)` (HBInit `DiscPropertiesObject`, `bCoeff`), `getDiscCount()`,
`getConnection(id)` (peer, IP…), `frame`, `state`, `transport`, `sequencer`, `recorder`.

## Wire behaviour (what is verified)

* `Sequencer` is checked against the **official** `Wa` (offline, `test/host/sequencer.test.ts`):
  12 000 random operations for Sb = 1/2/4 (client inputs with early/late/very late/far-future
  frames, non-delay events, host events, heartbeats, checksums, rate limits, host-only kicks) →
  byte-identical msg 2/msg 3/CheckConsistency broadcasts, counters (`da/Ra/od`), per-client
  `Id`/`jf`, kick decisions, inflated snapshots and RoomState bytes.
* Snapshot `[1] deflate(u16 id, u32 frame, u32 od, varuint Ra, RoomState, EventFrame*)`, pong
  `[4][f64 (now-start)*0.06 + Sb][f64 echo]`, heartbeat `[3][u32 frame][u32 od]` on `uu`,
  events on `ru` (author included), CheckConsistency on `ro`, targeted `[6][type][payload]` on
  `ro`, kick `[5][u8 ban][reason][byName]` (`test/host/raw.test.ts`).
* E2E with node-haxball clients (`test/host/e2e*.test.ts`): byte-identical confirmed states,
  all consistency checks pass, kicks/admin kicks/bans/clearBan, late join, replay.

## haxlite Edge

With `new HostTransport({ …, edge: { url, key } })` (or `HBInit({ haxlite: { edge } })`) the
player PeerConnections live on a remote haxlite Edge and this process never talks to players
(docs/09-haxlite-edge.md). Nothing changes for HostRoom except that broadcasts go through
`transport.broadcastTo(this.ready, channel, data)`, which the edge backend turns into one
multicast tunnel message (the local backend loops `send`).

## Deviations from the official host

* One shared, frame-aligned timer for all rooms instead of `setInterval(Da, 50)` per room
  (frame math identical; heartbeats leave on an absolute grid of `heartbeatFrames` (± the
  piggyback lead with bundling) instead of the 50 ms-quantized 7..9 frames; during a game
  catch-ups every ≤ `maxWakeFrames`; frame 0 starts on the process's 60 Hz grid).
* Idle rooms run no timers; the 3 s Ping event is only emitted while clients are connected
  (it changes no serialized state). Host actions stamp with the caught-up frame.
* Exceptions in room hooks are reported via `onError` and never abort the frame loop (the
  official loop would abort and re-apply events later).
* `setScoreLimit/TimeLimit` coerce to int (`| 0`): the official host applies a non-integer
  limit unconverted while clients read the i32, which can desync game-end logic.
* node-haxball extensions (events 24–26) are neither sent nor accepted (a client sending one is
  dropped as "Bad actor", like the official host).
