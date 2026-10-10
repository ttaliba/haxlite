# 05 — Librerías y APIs: `haxball.js` vs `node-haxball`

> Objetivo: entender cómo está estructurado HaxBall a partir de dos librerías open-source que lo
> automatizan desde Node.js, y qué revela su superficie pública (API) sobre el juego.
>
> - **haxball.js** (`mertushka/haxball.js`, npm `haxball.js` v5.1.0, commit `e5231b0`, 2026-09-25):
>   *envoltorio* que ejecuta el **script oficial** del Headless Host de haxball.com dentro de Node.
> - **node-haxball** (`wxyz-abcd/node-haxball`, npm `node-haxball` v2.3.1, commit `4d4b88f`, 2026-07-17):
>   *reimplementación* completa (cliente + host + motor de física + replays) del juego.
>
> Convenciones: las rutas `haxball.js/...` y `node-haxball/...` son relativas a la raíz de cada repo
> clonado. `L<n>` = número de línea. Lo marcado **(no verificado)** no se ha comprobado en ejecución
> (no se creó ni se unió a ninguna sala real durante este análisis). Todos los ejemplos de código son
> **ilustrativos y no probados**.

---

## Índice

1. [haxball.js: envoltorio del script oficial](#1-haxballjs-envoltorio-del-script-oficial)
2. [node-haxball: reimplementación completa](#2-node-haxball-reimplementación-completa)
3. [Comparativa](#3-comparativa)
4. [Ejemplos mínimos (no probados)](#4-ejemplos-mínimos-no-probados)
5. [Glosario de conceptos de HaxBall expuestos por las APIs](#5-glosario-de-conceptos-de-haxball-expuestos-por-las-apis)
6. [Fuentes](#fuentes)

---

## 1. haxball.js: envoltorio del script oficial

### 1.1 Idea general

`haxball.js` **no reimplementa nada del juego**. Toma el fichero oficial
`headless-min.js` (el mismo que carga `https://www.haxball.com/headless` en un navegador), lo
incrusta dentro de una función TypeScript y le inyecta un entorno "falso" de navegador
(`window`, `document`, WebSocket, WebRTC, XHR, crypto, etc.) construido con paquetes de Node.
Cuando el script oficial termina de inicializarse asigna `window.parent.HBInit`, y la librería
captura esa asignación para resolver una `Promise<HBInit>`.

Punto de entrada (`haxball.js/src/index.ts` L14-18):

```ts
export default function HaxballJS(config: HaxballJSConfig = {}): Promise<HBInit> {
  return loadHeadless(createHeadlessEnvironment(config))
}
```

### 1.2 Cómo obtiene el script oficial (`cache_hash.json` → URL)

Importante: **la descarga no ocurre en tiempo de ejecución**, sino en tiempo de *build/mantenimiento*.
El script `scripts/update-headless.ts` genera `src/generated/headless.ts`, que se publica en npm ya
incrustado.

| Paso | Detalle | Cita |
|---|---|---|
| 1 | `GET https://www.haxball.com/cache_hash.json` → devuelve un string JSON (p. ej. `"H4mQWPXF"`) | `scripts/update-headless.ts` L4, L95-104 |
| 2 | Valida que el hash sea `[A-Za-z0-9_-]+` | L20-22 |
| 3 | `GET https://www.haxball.com/${cacheHash}/__cache_static__/g/headless-min.js` | L107 |
| 4 | Extrae el "source hash" de 8 hex del comentario de cabecera (p. ej. `f066733d`) | L24-27 |
| 5 | Comprueba **invariantes** con regex: exactamente 1 `window.parent.HBInit =`, 1 `new WebSocket(`, 1 `getElementById("roomlink")`, 1 `getElementById("recaptcha")`. Si cambian, falla (protección ante cambios de versión del juego) | L29-43 |
| 6 | Envuelve el código en `export function loadHeadless(environment)` que desestructura `WebSocket, XMLHttpRequest, JSON5, pako, RTCPeerConnection, RTCIceCandidate, RTCSessionDescription, crypto, performance, TextEncoder` y crea `const window = environment.createWindow(resolve)` → así los identificadores globales del script oficial quedan "sombreados" por las versiones de Node | L51-92 |
| 7 | Escritura atómica (`.tmp` + `rename`) y salida `new_hash=` para GitHub Actions | L120-132 |

La versión incrustada en el clon analizado tiene cabecera
`// Haxball cache hash: H4mQWPXF` / `// Haxball source hash: f066733d` y el aviso
`HaxBall © Mario Carbajal - All rights reserved.` (`src/generated/headless.ts` L1-3, L26-29).

Un workflow semanal (`.github/workflows/checkupdates.yml`, `cron: '0 9 * * 1'`) ejecuta
`npm run update:headless` y abre un PR automático "Update Haxball Headless (<hash>)".

### 1.3 El `window` / `document` falsos

`createWindow(resolve)` (`haxball.js/src/runtime.ts` L94-140):

- `window.parent` tiene un **setter** `HBInit` que llama a `resolve(value)` (L98-103): es el
  "gancho" que convierte la asignación del script oficial en la resolución de la promesa.
  `onHBLoaded` es un no-op.
- `document.getElementById` solo conoce dos ids: `"roomlink"` (objeto con `innerHTML`) y
  `"recaptcha"` (objeto con `hidden`) (L106-110). Son exactamente los dos elementos DOM que usa el
  script headless oficial.
- `document.createElement()` devuelve un objeto mínimo y `document.head.appendChild()` dispara
  asíncronamente `onerror(new Error('reCAPTCHA is unavailable in the Node.js runtime'))`
  (L111-126): cuando el script oficial intenta cargar
  `https://www.google.com/recaptcha/api.js?...`, falla de forma controlada. **No hay forma de resolver
  un reCAPTCHA en Node; se necesita token.**
- Además expone `crypto`, `performance`, `setTimeout/clearTimeout/setInterval/clearInterval` y
  `console` (L129-139).

### 1.4 APIs de navegador "polyfilleadas"

`createHeadlessEnvironment(config)` (`runtime.ts` L142-191) y `package.json` (dependencias):

| API que espera el script oficial | Implementación en Node | Cita |
|---|---|---|
| `RTCPeerConnection`, `RTCIceCandidate`, `RTCSessionDescription` | `@webrtc-node/webrtc` (^0.2.1) por defecto; sustituible con `config.webrtc` | `runtime.ts` L1, L176, L183-185; `test/webrtc.test.ts` |
| `WebSocket` | `ws` (^8.18.3), subclase `HaxballWebSocket` que fuerza la cabecera `origin: 'https://html5.haxball.com'` y opcionalmente un `agent` de proxy | `runtime.ts` L149-162 |
| `XMLHttpRequest` | `xhr2` (^0.2.1), subclase que intercepta el evento `load` y, si la respuesta es `{action:"recaptcha"}` (o `{data:{action:"recaptcha"}}`), lanza `InvalidRoomTokenError` | `runtime.ts` L72-92, L164-174, L49-56 |
| `crypto` | WebCrypto nativo de Node (`globalThis.crypto`) | `runtime.ts` L132, L186 |
| `performance`, `TextEncoder` | nativos de Node | `runtime.ts` L187-188 |
| `JSON5` | paquete `json5` (para parsear estadios `.hbs`) | `runtime.ts` L3, L181 |
| `pako` | **adaptador propio** sobre `node:zlib` (`deflateRaw`, `inflateRaw`, clase `Inflate`) — ya no usa el paquete `pako` | `src/pako.ts` L1-20, L22+ |

La cabecera `Origin` es necesaria porque el servidor de señalización de HaxBall comprueba el origen
de la conexión WebSocket (ver §2.9). Node no envía `Origin` por defecto, y en navegador no se puede
cambiar.

### 1.5 Soporte de proxy

- `config.proxy` (string URL) → `new HttpsProxyAgent(new URL(config.proxy))` (`runtime.ts` L145-147)
  y se pasa como `agent` **solo al WebSocket** (L151-153).
- El XHR **no** pasa por el proxy: hay un test explícito "does not proxy XMLHttpRequest connections"
  (`test/proxy.test.ts` L11+).
- El README lo justifica: "Haxball has a limit of 2 rooms per IP" (README, sección *Proxy*).
  **(no verificado)** el límite exacto en el servidor.

### 1.6 Qué revela el script oficial incrustado (lectura del minificado)

Fragmentos observados en `src/generated/headless.ts` (código minificado, nombres ofuscados):

- Canales WebRTC DataChannel: `{name:"ro",reliable:!0,ordered:!0}`,
  `{name:"ru",reliable:!0,ordered:!1}`, `{name:"uu",reliable:!1,ordered:!1}` → fiable+ordenado,
  fiable+desordenado, no fiable+desordenado.
- Backend HTTP: `https://www.haxball.com/rs/`; endpoints `api/host` (crear sala) y `api/geo`
  (geolocalización por IP).
- STUN: `stun:stun.l.google.com:19302`.
- Versión de protocolo: `version:9`.
- Flujo: POST `token=<token>&rcr=<recaptchaResponse>` (`application/x-www-form-urlencoded`) a
  `api/host` → respuesta `{action:"connect", url, token}` o `{action:"recaptcha", sitekey}`. Con
  `connect` abre `new WebSocket(url + "?token=" + token)` con `binaryType="arraybuffer"`; un
  `setInterval` de 40 s (`4E4`) mantiene la conexión; el código de cierre `4001` se trata de forma
  especial.
- Valores por defecto del `RoomConfig`: `roomName:"Headless Room"`, `playerName:"Host"`,
  `maxPlayers:12`, `public:false`, `noPlayer:false`; `geo` inválido → "Invalid country code".
- `HBInit` solo puede llamarse una vez ("init twice").

(Estos detalles se analizan más a fondo en los documentos de red/protocolo; aquí se citan solo como
evidencia de lo que la librería ejecuta.)

### 1.7 Token y reCAPTCHA

- Crear una sala **requiere** un *headless token* de `https://www.haxball.com/headlesstoken`
  (README: `token: 'YOUR_TOKEN_HERE', // Required`). Caduca "after a few minutes"
  (`src/types.ts` L46; wiki oficial).
- Si el token es inválido/caducado, el backend responde `action: "recaptcha"` y la librería lanza
  `InvalidRoomTokenError` con el mensaje "Invalid room token. Generate a new token at
  https://www.haxball.com/headlesstoken." (`runtime.ts` L49-56, L164-174).
- `room.setRequireRecaptcha(bool)` controla si **los jugadores** deben resolver reCAPTCHA para
  entrar (`types.ts` L209-213).
- El test de integración se salta si no existe `TEST_HB_HEADLESS_TOKEN` (`test/basic.test.ts` L6-11).

### 1.8 API `HBInit` / `RoomConfigObject`

`export type HBInit = (roomConfig: RoomConfigObject) => RoomObject` (`types.ts` L17).

`RoomConfigObject` (`types.ts` L33-54), todo opcional:

| Campo | Tipo | Significado |
|---|---|---|
| `roomName` | string | Nombre de la sala |
| `playerName` | string | Nombre del jugador host (ignorado si `noPlayer`) |
| `password` | string | Contraseña |
| `maxPlayers` | number | Máximo de jugadores |
| `public` | boolean | Aparecer en la lista de salas |
| `geo` | `{code, lat, lon}` | Forzar geolocalización/bandera |
| `token` | string | Headless token (salta reCAPTCHA) |
| `noPlayer` | boolean | Sin jugador host; recomendado `true`. Eventos causados por el host llegan con `byPlayer = null` |

Constantes: `InputFlags = {up:1, down:2, left:4, right:8, kick:16}` (`types.ts` L19-25) y
`CollisionFlags` (L572-599).

### 1.9 `RoomObject`: métodos

`types.ts` L60-312. "All API functions that modify the game's state execute asynchronously" (L58).

| Método | Firma / notas | Línea |
|---|---|---|
| `sendChat` | `(msg, targetId?)` | L66 |
| `setPlayerAdmin` | `(playerId, admin)` | L73 |
| `setPlayerTeam` | `(playerId, team: 0/1/2)` | L80 |
| `kickPlayer` | `(playerId, reason?, ban?)` | L88 |
| `clearBan` / `clearBans` | `(playerId)` / `()` | L94, L99 |
| `setScoreLimit` / `setTimeLimit` | sin efecto con partida en curso; tiempo en minutos | L106, L113 |
| `setCustomStadium` | `(contenido .hbs)` | L120 |
| `setDefaultStadium` | `(nombre exacto, case-sensitive)` | L127 |
| `setTeamsLock` | `(locked)` | L133 |
| `setTeamColors` | `(team, angle, textColor, colors[])` | L142-147 |
| `startGame` / `stopGame` / `pauseGame(bool)` | | L153-165 |
| `getPlayer` / `getPlayerList` | `PlayerObject` | L172, L177 |
| `getScores` | `ScoresObject \| null` | L183 |
| `getBallPosition` | `{x,y} \| null` | L189 |
| `startRecording` / `stopRecording` | devuelve `Uint8Array` (replay `.hbr2`) | L195, L201 |
| `setPassword` | `(pass \| null)` | L207 |
| `setRequireRecaptcha` | `(required)` | L213 |
| `reorderPlayers` | `(ids[], moveToTop)` | L221 |
| `sendAnnouncement` | `(msg, targetId?, color?, style?, sound?)`; estilos `normal/bold/italic/small/small-bold/small-italic`; sonido 0/1/2 | L232-238 |
| `setKickRateLimit` | `(min=2, rate=0, burst=0)` en *frames* lógicos | L246 |
| `setPlayerAvatar` | `(playerId, avatar \| null)` (override del host) | L253 |
| `setDiscProperties` / `getDiscProperties` | por índice de disco | L266, L273 |
| `setPlayerDiscProperties` / `getPlayerDiscProperties` | por id de jugador | L280-290 |
| `getDiscCount` | incluye balón y jugadores | L295 |
| `CollisionFlags`, `InputFlags` | constantes | L311-312 |

### 1.10 `RoomObject`: eventos (callbacks asignables)

`types.ts` L318-467 (verificados también como cadenas `on*` en el script oficial):

| Evento | Parámetros | Línea |
|---|---|---|
| `onPlayerJoin` | `(player: PlayerJoinObject)` — incluye `auth` y `conn` | L318 |
| `onPlayerLeave` | `(player)` | L324 |
| `onTeamVictory` | `(scores)` | L330 |
| `onPlayerChat` | `(player, msg)` → devolver `false` filtra el mensaje | L340 |
| `onPlayerBallKick` | `(player)` | L346 |
| `onTeamGoal` | `(team)` | L352 |
| `onGameStart` / `onGameStop` | `(byPlayer \| null)` | L358, L364 |
| `onPlayerAdminChange` | `(changedPlayer, byPlayer)` | L371 |
| `onPlayerTeamChange` | `(changedPlayer, byPlayer)` | L381 |
| `onPlayerKicked` | `(kicked, reason, ban, byPlayer)` — siempre después de `onPlayerLeave` | L394 |
| `onGameTick` | `()` — 60 veces/s, no se llama en pausa/parado | L406 |
| `onGamePause` / `onGameUnpause` | `(byPlayer)` | L412, L420 |
| `onPositionsReset` | `()` tras un gol | L425 |
| `onPlayerActivity` | `(player)` | L432 |
| `onPlayerInput` | `(player, prevInput)` — más reciente; `PlayerObject.input` | L433 |
| `onStadiumChange` | `(newStadiumName, byPlayer)` | L440 |
| `onRoomLink` | `(url)` | L446 |
| `onKickRateLimitSet` | `(min, rate, burst, byPlayer)` | L455 |
| `onTeamsLockChange` | `(locked, byPlayer)` | L467 |

Tipos de datos: `PlayerObject {id, name, team, admin, position, input}` (L473-485),
`PlayerJoinObject` añade `auth`, `conn` (L491-505), `ScoresObject {red, blue, time, scoreLimit,
timeLimit}` (L510-521), `DiscPropertiesObject` (L534-561) y el esquema completo de estadio `.hbs`
(`StadiumObject`, `Vertex`, `Segment`, `Goal`, `Plane`, `Disc`, `PlayerPhysics`, `Joint`; L605-877).

---

## 2. node-haxball: reimplementación completa

### 2.1 Diseño general: `initAPI(window, config)`

`node-haxball/src/api.js` (~156 KB, minificado/empaquetado) contiene el motor completo. Expone
`abcHaxballAPI(window, config)` en navegador; en Node:

- `src/index.js` L1-4: `module.exports = (window, config) => indexCommon(initAPI, window, config)`.
- `src/indexCommon.js` L1-47: inyecta dependencias, usando las del `window` recibido si existen o
  polyfills de Node si no:

| Objeto requerido | Polyfill en Node | Línea |
|---|---|---|
| `RTCPeerConnection/IceCandidate/SessionDescription` | `node-datachannel/polyfill` (antes `@koush/wrtc`, comentado) | L1 |
| `crypto` | `@peculiar/webcrypto` (`new Crypto()`) | L2, L26 |
| `WebSocket` | `ws` | L3 |
| `fetch` | `node-fetch` (XHR ya no se usa; `xhr2` comentado) | L4-5 |
| `performance` | `perf_hooks` | L6 |
| `JSON5`, `pako` | paquetes `json5`, `pako` | L7-8 |
| `requestAnimationFrame` | `setTimeout(cb, 16.67)` | L21 |

  y construye el `config`: `proxy.WebSocketChangeOriginAllowed` (por defecto **`true`** en Node,
  L33), `WebSocketUrl`, `HttpUrl`, `backend`, `proxyAgent`, `stunServer`, `version`,
  `noVariableValueChangeEvent`, `identityToken` (L35-45).

Config documentada (README L136-155; tipos `LibConfig` en `src/index.d.ts` L10380+):

- `backend.hostname` = `www.haxball.com`, `backend.hostnameWs` = `p2p.haxball.com`, `backend.secure` = `true`.
- `proxy.WebSocketUrl` (por defecto `wss://p2p.haxball.com/` host y `wss://p2p2.haxball.com/` cliente según README; **(no verificado)** el segundo host — en `api.js` solo se observa `p2p.haxball.com` y el sufijo `client`), `proxy.HttpUrl` = `https://www.haxball.com/rs/`.
- `stunServer` = `stun:stun.l.google.com:19302`; `version` = `9`.

En `api.js` se ven los mismos valores por defecto: `{ja:"www.haxball.com",JP:"p2p.haxball.com",zG:!0}`,
`DP:9`, `Wk:[{urls:"stun:stun.l.google.com:19302"}]`, y los endpoints `api/list` (lista de salas,
binaria), `api/geo`, `api/host` (`token=…&rcr=…`). El tipo raíz del módulo es
`export = (object?: WindowLike, config?: LibConfig) => MainReturnType` (`index.d.ts` L10450).

### 2.2 Módulos exportados

Destructuring típico (README L33; `examples/api_structure/createRoom.js` L2):

```js
const { OperationType, VariableType, ConnectionState, AllowFlags, Direction, CollisionFlags,
  CameraFollow, BackgroundType, GamePlayState, BanEntryType, Callback, Utils, Room, Replay, Query,
  Library, RoomConfig, Plugin, Renderer, Errors, Language, EventFactory, Impl } = require("node-haxball")();
```

| Módulo | Función | Referencia |
|---|---|---|
| **Enums** | `OperationType` (0-26), `ConnectionState`, `AllowFlags`, `AddonType`, `CollisionFlags`, `Direction`, `CameraFollow`, `BackgroundType`, `GamePlayState`, `PlayerPositionInGame`, `BanEntryType`, `VariableType` | `index.d.ts` L15-720, L1264 |
| **Room** | Clase principal; estáticos `create`, `join`, `sandbox`, `streamWatcher` | `index.d.ts` L8216-8325; README L322-635 |
| **Utils** | `generateAuth`, `authFromKey`, `getRoomList`, `getGeo`, `parseStadium`, `exportStadium`, `getDefaultStadiums`, `keyState`, `runAfterGameTick`, `refreshRoomToken`, `generateRoomId`, conversiones IP/auth/color… | `index.d.ts` L4335-4581; README L246-271 |
| **Replay** | `read` (lector asíncrono), `readAll`, `trim`, `trimAsync`, `writeAll`, `ReplayData` | `index.d.ts` L8839-8925; README L199-244 |
| **Query** | Búsqueda geométrica en el mapa (vértice/segmento/gol/plano/joint/disco/spawn en coordenada) | `index.d.ts` L8932-9138; README L307-320 |
| **EventFactory** | Construye mensajes de operación (`sendChat`, `sendInput`, `joinRoom`, `setDiscProperties`, `customEvent`…) | `index.d.ts` L8331-8697; README L273-305 |
| **Errors** | `ErrorCodes` (p. ej. `ConnectionClosed=1`, `MissingRecaptchaCallbackError=38`) y `HBError {code, params, toString()}` | `index.d.ts` L9423-9641; README L186-193 |
| **Language** | Textos de error localizables; `Language.current = new EnglishLanguage(API)` | `src/languageTemplate.js`; README L169-184 |
| **Callback** | `add(eventName)` / `remove` para crear eventos propios (`_on<Evento>`) | README L195-197; `index.d.ts` L4272 |
| **Plugin / RoomConfig / Renderer / Library** | Clases base de "addons" | §2.5-2.6 |
| **Impl** | Clases internas: `Core.{Point, TeamColors, Team}`, `Stream.{Reader, Writer}`, `Stadium.{Vertex, Segment, Plane, Goal, Disc, Joint, Stadium}` | `index.d.ts` L9760-10290; README L1033+ |

### 2.3 Crear y unirse a salas

**`Room.create(createParams, commonParams)`** (README L324-337; `index.d.ts` L4610-4672):

| `createParams` | Notas |
|---|---|
| `name`, `password` | |
| `token` | headless token de `/headlesstoken` |
| `noPlayer` | sin jugador host |
| `geo` `{lat, lon, flag}` | |
| `maxPlayerCount` | |
| `showInRoomList` | pública |
| `playerCount` | **falsea** el número de jugadores mostrado |
| `unlimitedPlayerCount` | salta el control de cupo (el backend no lista salas con >30) |
| `fakePassword` | muestra candado sin tener contraseña |
| `onError(error, playerId)` | excepción provocada por un cliente → se cierra su conexión ("Bad actor") |

**`Room.join(joinParams, commonParams)`** (README L339-345; `index.d.ts` L4673-4695):
`id` (lo que va tras `?c=` en `https://www.haxball.com/play?c=<id>`), `password`, `token` (token de
*cliente* si la sala exige reCAPTCHA; obtenible con el `tokenGenerator`), `authObj` (de
`Utils.generateAuth()` / `Utils.authFromKey()`).

**`commonParams`** (README L345-370; `index.d.ts` L4696-4800): `storage` (`player_name` [def. `"abc"`],
`avatar`, `geo` [def. lat 40, lon 40, flag `"tr"`], `crappy_router` [timeout 10 s en lugar de 4 s],
`player_auth_key`), `noPluginMechanism`, `libraries`, `config`, `renderer`, `plugins`, `version`
(def. 9), `proxyAgent`, `identityToken`, `debugDesync`, y callbacks `preInit(room)`, `onOpen(room)`,
`onClose(error)`, `onConnInfo(state, extraInfo)`.

Devuelve `{ cancel(), useRecaptchaToken(token) }` (`index.d.ts` L4786-4805).

Estados de conexión al unirse (`ConnectionState`, `index.d.ts` L342-356):
`TryingReverseConnection=-1`, `ConnectingToMaster=0`, `ConnectingToPeer=1`, `AwaitingState=2`,
`Active=3`, `ConnectionFailed=4`. En `ConnectingToPeer`/`AwaitingState`, `extraInfo` contiene el
**SDP** WebRTC (útil para ver IP/puerto del par).

Detalles de transporte visibles en `api.js`:
- Host: WebSocket a `<WebSocketUrl>?token=<token>`; si `WebSocketChangeOriginAllowed`, añade
  cabecera `Origin: https://www.haxball.com`.
- Cliente: WebSocket a `<WebSocketUrl>client?id=<roomId>[&token=<token>]` con cabeceras
  `Cache-control`, `Pragma`, un `User-agent` de Chrome 133 en Windows y `Origin`.
- Auth del jugador: claves **ECDSA P-256** importadas como JWK (`{name:"ECDSA", namedCurve:"P-256"}`,
  firma con SHA-256).

### 2.4 Sistema de eventos y callbacks

Cada evento `XXX` del juego se propaga en una **cadena ordenada** (README L680-683; `roomConfigTemplate_method*.js`):

```
room.onBeforeXXX(...)            → devuelve customData (o false para cortar la propagación)
  plugin.onXXX(..., customData)  → para cada plugin activo, en orden
room.onXXX(..., customData)
renderer.onXXX(..., customData)
room.onAfterXXX(..., customData)
```

Eventos principales (lista completa en `src/pluginTemplate.js` L20-79):
`onRoomLink`, `onPlayerBallKick`, `onTeamGoal(teamId, goalId, goal, ballDiscId, ballDisc)`,
`onGameEnd`, `onGameTick`, `onPlayerSyncChange`, `onAnnouncement`, `onAutoTeams`,
`onScoreLimitChange`, `onTimeLimitChange`, `onPlayerAdminChange`, `onPlayerAvatarChange`,
`onPlayerHeadlessAvatarChange`, `onPlayersOrderChange`, `onPlayerTeamChange`, `onStadiumChange`,
`onTeamsLockChange`, `onPlayerObjectCreated`, `onPlayerDiscCreated/Destroyed`, `onPlayerJoin`,
`onGamePauseChange`, `onPlayerChat`, `onPlayerInputChange`, `onPlayerChatIndicatorChange`,
`onPlayerLeave(playerObj, reason, isBanned, byId)`, `onSetDiscProperties`, `onKickRateLimitChange`,
`onTeamColorsChange`, `onGameStart`, `onKickOff`, `onTimeIsUp`, `onPositionsReset`, `onGameStop`,
`onPingData`, `onPingChange` (cliente), `onHandicapChange`, `onBansClear/onBanClear`,
`onRoomRecaptchaModeChange`, `onRoomTokenChange`, `onRoomRecordingChange`, `onRoomPropertiesChange`,
`onCollisionDiscVsDisc/Segment/Plane`, `onCustomEvent`, `onBinaryCustomEvent`, `onIdentityEvent`, y
eventos de gestión de addons (`onPluginAdd/Move/Update/Remove/ActiveChange`, `onLibrary*`,
`onConfigUpdate`, `onRendererUpdate`, `onLanguageChange`, `onVariableValueChange`).

Clasificación en `index.d.ts`: `HostOnlyCallbacks` (L1989), `HostTriggeredCallbacks` (L2042),
`ClientTriggeredCallbacks` (L2141), `GameCallbacks` (L2157, "triggered individually": cada par los
calcula localmente a partir de la simulación determinista), `LocalCallbacks`, `APICallbacks`,
`ModifierCallbacks` (L2684), `CustomCallbacks` (L2739).

**Callbacks modificadores (solo host)** (README L664-675):
- `modifyPlayerDataBefore/modifyPlayerData/modifyPlayerDataAfter(playerId, name, flag, avatar, conn, auth[, customData])`
  → `[nombre, bandera, avatar]` o `null` para **rechazar** la entrada; pueden ser `async`.
- `modifyPlayerPing*`, `modifyClientPing*` (cliente) → alterar el ping mostrado.
- **`onBeforeOperationReceived(type, msg, globalFrameNo, clientFrameNo)`** → `customData`. Por defecto
  parsea chat: `{isCommand: text.startsWith("!"), data: text.trimEnd().split(" ")}`.
- **`onOperationReceived(type, msg, globalFrameNo, clientFrameNo, customData)`** (room y cada plugin) y
  `onAfterOperationReceived`: se ejecutan para **cada mensaje que llega de un cliente** antes de
  aplicarlo. `return true` acepta, `false` lo bloquea, `throw` corta la conexión del emisor. `msg`
  se puede **modificar**. Es el punto de interceptación de "paquetes" del protocolo.

`OperationType` (`index.d.ts` L15-197) enumera los tipos de mensaje del protocolo:
`SendAnnouncement=0, SendChatIndicator=1, CheckConsistency=2, SendInput=3, SendChat=4, JoinRoom=5,
KickBanPlayer=6, StartGame=7, StopGame=8, PauseResumeGame=9, SetGamePlayLimit=10, SetStadium=11,
SetPlayerTeam=12, SetTeamsLock=13, SetPlayerAdmin=14, AutoTeams=15, SetPlayerSync=16, Ping=17,
SetAvatar=18, SetTeamColors=19, ReorderPlayers=20, SetKickRateLimit=21, SetHeadlessAvatar=22,
SetDiscProperties=23` — y tres **extensiones propias de node-haxball** que solo reciben clientes de
la API: `CustomEvent=24, BinaryCustomEvent=25, SetPlayerIdentity=26` (L171-196).

> Nota: el orden 0-23 coincide con el registro de clases de acciones del script oficial
> (`static $(a){… m.ag.set(m.ie,a); m.ie++}` en el minificado) **(no verificado** que el orden de
> registro sea idéntico; ver documento de protocolo).

### 2.5 Sistema de addons: Plugin, RoomConfig, Library, Language

Todos siguen el mismo patrón "clase base + prototipo" (`src/pluginTemplate.js` L1-10):

```js
module.exports = function(API){
  Object.setPrototypeOf(this, API.Plugin.prototype);
  API.Plugin.call(this, "nombreUnico", true /*activo*/, { version, author, description,
    allowFlags: API.AllowFlags.CreateRoom | API.AllowFlags.JoinRoom });
  this.initialize = function(){};  this.finalize = function(){};
  this.onPlayerJoin = function(playerObj, customData){ this.room.sendChat("Hola " + playerObj.name); };
};
```

- **Plugin** (README L868-950): `name` único (accesible en `room.pluginsMap[name]`), `active`
  (`room.setPluginActive`), `room`. Callbacks `onXXX` + modificadores (`modifyPlayerData`,
  `modifyPlayerPing`, `modifyClientPing`, `onOperationReceived`). `defineVariable({name, value, type,
  range, description})` expone variables editables por GUI y dispara `onVariableValueChange`.
  `AllowFlags` (`JoinRoom=1`, `CreateRoom=2`) indica si funciona como host, cliente o ambos.
- **RoomConfig** (README L652-866): la "configuración principal" de la sala; tiene además las
  variantes `onBefore*/onAfter*` y `modify*Before/After`. Dos estilos de plantilla:
  `roomConfigTemplate_method1.js` (asignar callbacks directamente al `room` en `onOpen`) y
  `roomConfigTemplate_method2.js` (subclase de `RoomConfig`). `room.setConfig()` / `mixConfig()`.
- **Library** (README L636-650; `src/libraryTemplate.js`): código compartido entre addons
  (`room.librariesMap[name]`), solo `initialize/finalize`. Ejemplos: `commands.js`,
  `permissions.js`, `aimbot.js`, `gui.js`.
- **Language** (`src/languageTemplate.js`): mapas de textos para `HBError.toString()`; ejemplos en
  inglés, español, portugués y turco (`examples/languages/`).
- Gestión en caliente: `addPlugin/movePlugin/updatePlugin/removePlugin`, `addLibrary/...`,
  `setRenderer` (README L561-570).

Ejemplos (`examples/plugins/`): bots de autojuego (`autoPlay_followBall`, `autoPlay_defensive`…),
comandos (`CMD_*`), juegos completos sobre el motor (`CMD_chess`, `tetris`, `CMD_sokoban`,
`quoridor`), y también "hacks" (`CMD_speedHack`, `aimbot`, `fakeRejoin`, `syncSpammer`,
`chatIndicatorSpammer`, `CMD_controlOtherPlayers`).

### 2.6 Sistema de renderers

`src/rendererTemplate.js` L12-40: subclase de `Renderer` con `render(extrapolatedRoomState)` llamado
dentro de `requestAnimationFrame`, más los mismos `onXXX` que los plugins (se ejecutan después del
plugin y del `room.onXXX`). `room.extrapolate(ms)` produce un estado extrapolado en las claves `ext`
para dibujar con suavidad entre ticks (README L505). Renderers de ejemplo:
`examples/renderers/defaultRenderer.js` (canvas 2D similar al original), `pixiRenderer.js`,
`imageRenderer.js`, `sandboxRenderer.js`, `flappyKirbyRenderer.js`.

### 2.7 Sandbox (simulación offline)

- **`Room.sandbox(callbacks, options)`** (`index.d.ts` L8311; README L402-461): sala local **sin red**
  que ejecuta el mismo motor de física. `callbacks` = callbacks de renderer + `filterEvents(event)`;
  `options` = `controlledPlayerId`, `delayedInit`, `requestAnimationFrame`, `cancelAnimationFrame`.
  Funciones: `initialize`, `startRecording/stopRecording/isRecording`, `extrapolate`,
  `setSimulationSpeed(coef)` (0 = congelar, <1 cámara lenta, >1 acelerar), `runSteps(n)`,
  `executeEvent(eventMsg)`, `takeSnapshot/useSnapshot` (estado completo copiable → "undo"),
  `playerJoin/playerLeave/playerInput/playerChat`, y versiones "falsas" de todas las acciones
  administrativas con `byId` (0 = host).
- **Funciones de modo sandbox sobre el estado** (README L572-612): crear/añadir/actualizar/eliminar
  vértices, segmentos, goles, planos, discos, joints, spawn points y jugadores en caliente;
  `updateStadiumPlayerPhysics`, `updateStadiumBg`, `updateStadiumGeneral`, `exportStadium()`.
  "Not supported by the original Haxball client": en red solo se sincronizan vía `CustomEvent`.
- **`src/sandboxWrapper.js`** (814 líneas): implementa `Room.create` sobre `Room.sandbox` para
  ejecutar *los mismos* plugins/roomConfigs/renderers sin conectarse a nada
  (L34-110). Simula pings aleatorios cada 3 s (L62), el `roomId` es `"sandbox"` y
  **solo "abre" la sala si `token == "sandbox"`**; con otro token emite
  `MissingRecaptchaCallbackError` (L800-808). Uso en navegador: `examples_web/src/sandboxRoomWrapper.js` L3-9.
- Página `examples_web/src/sandbox.html`: editor de mapas en vivo con congelar/avanzar por pasos y
  snapshots (`examples_web/README.md`; creación en `sandbox.js` L4971-4980).

### 2.8 Replays: lectura y escritura

README L199-244; `index.d.ts` L8703-8925.

- `Replay.read(uint8Array, callbacks, options)` → `AsyncReplayReader` con `state`, `gameState`,
  `maxFrameNo`, `length()`, `getTime()`, `setTime(ms)`, `getCurrentFrameNo()`,
  `setCurrentFrameNo(n)`, `setSpeed(coef)`, `extrapolate()`, `destroy()`, y callbacks
  `onDestinationTimeReached`, `onEnd`. Rebobinar re-simula desde el principio (no guarda estados).
- `Replay.readAll(bytes)` → `ReplayData {roomData, events, goalMarkers, totalFrames, version}`;
  `version` debe ser **3**. `Replay.trim/trimAsync(data, {beginFrameNo, endFrameNo})`.
  `Replay.writeAll(data)` → `Uint8Array`.
- Ejemplo de edición (`examples/api_structure/replayModifier.js` L8-30): filtra jugadores, discos y
  eventos (`x.eventType == OperationType.SendInput`), renumera al jugador como id 0 y reescribe el
  `.hbr2`. Esto demuestra que un replay = **estado inicial + lista de eventos/operaciones con
  `frameNo`**, re-simulados de forma determinista.
- `room.startRecording()/stopRecording()` en salas reales y sandbox.
- Web: `replayViewer.html`, `replayToVideo.html` (CCapture).

### 2.9 Streaming server

- `room.startStreaming({immediate, onClientCount, emitData})` → `{onOpen, onDataReceived, interval}`
  (README L557-560); "recording and streaming cannot be run simultaneously".
- `streamingServer/src/index.js` L1-57: relé WebSocket (`ws`) en el puerto **1935**. La **primera**
  conexión es el host; las siguientes son espectadores. Protocolo mínimo de 3 bytes: tipo `0` +
  `uint16` número de clientes (servidor→host), tipo `1` + `uint16` id de cliente para pedir datos
  iniciales; mensajes del host con primer byte `1` van a un cliente concreto, el resto se difunden.
- `streamingServer/src/roomScript.js` L1-19: lado host en modo "interval" (`setInterval(s.interval, 50)`).
- Espectadores: `Room.streamWatcher(initialStreamData, callbacks, options)` con
  `readStream`/`readImmediateStream` (README L375-400); página `examples_web/src/streamWatcher.html`.
  El README lo declara "experimental and buggy".

### 2.10 Token generator

`tokenGenerator/` (NW.js): carga `https://www.haxball.com/headlesstoken` en un `<iframe nwdisable
nwfaketop>` (`src/index.html` L5) y, en modo cliente, reescribe el formulario para enviarlo a
`rs/api/client` con el campo `rcr` y un campo `room` (L37-55), en vez de `rs/api/getheadlesstoken`
con `g-recaptcha-response`. El humano sigue resolviendo el reCAPTCHA; la herramienta solo permite
obtener también **tokens de cliente** (para unirse a salas con reCAPTCHA). El README menciona como
"plan futuro" un resolvedor automático (no implementado).

Relacionado: `Utils.refreshRoomToken({token, rcr})` y `Utils.generateRoomId({token, proxyAgent})`
(`index.d.ts` L4570-4581).

### 2.11 haxballOriginModifier (extensión de navegador) — por qué hace falta

- **Problema**: los servidores de HaxBall validan la cabecera `Origin` del WebSocket/HTTP. En un
  navegador, el `WebSocket` de JavaScript **no permite** fijar `Origin` (lo pone el navegador con el
  origen de la página). Una web propia (p. ej. `localhost` o `moo-hoo.com`) que use node-haxball sería
  rechazada. Por eso el `config.proxy.WebSocketChangeOriginAllowed` (README L148) es `true` en Node
  (donde `ws` permite cabeceras arbitrarias) y hace falta un proxy o esta extensión en navegador.
- **Solución**: extensión Manifest V3 (`haxballOriginModifier/src/manifest.json` L1-35) con permiso
  `declarativeNetRequest`; `background.js` L1-31 añade una regla que, para `*://*.haxball.com/*`
  originadas desde dominios listados, **fija** `Origin: https://www.haxball.com` y
  `Referer: https://www.haxball.com/` y responde con `Access-Control-Allow-Origin: *`.
- Alternativa: el proxy público del autor (`wss://node-haxball.onrender.com/`,
  `https://node-haxball.onrender.com/rs/`, README L44-63), que "expira al final de cada mes".
- Contraste: haxball.js pone `origin: https://html5.haxball.com` (el origen real del iframe headless
  oficial), node-haxball pone `https://www.haxball.com`. Ambos parecen aceptados **(no verificado)**.

### 2.12 Otros componentes

- `src/headlessWrapper.js` L1-151: **capa de compatibilidad** que expone un `HBInit` con la misma API
  que el Headless Host oficial, implementado sobre `Room.create`. Muestra el mapeo 1:1 entre ambas
  APIs (p. ej. `onPlayerLeave` con `reason != null` → `onPlayerKicked`, L72; `onPlayerChat` se
  implementa en `onBeforeOperationReceived` filtrando `OperationType.SendChat` y `byId != 0`, L74;
  `onPlayerInputChange` → `onPlayerActivity`, L84; casi todas las escrituras se difieren con
  `Utils.runAfterGameTick`, L103-132, imitando la asincronía oficial).
- `examples_web/`: front-end alternativo completo (lista de salas, unirse, crear, multi-join,
  replays, sandbox, game.html).
- `examples/other/compareStates.js`: comparador campo a campo de dos `RoomState` (útil para depurar
  desincronizaciones); `debugDesync` en `commonParams`.
- Proyectos hermanos citados en README L274-283: `nago.js` (motor de física original en JS puro),
  `node-haxball-client` (cliente NW.js), `node-haxball-headless-bridge`, `open-haxball` (backend).

---

## 3. Comparativa

| Aspecto | haxball.js (envoltorio oficial) | node-haxball (reimplementación) |
|---|---|---|
| Código del juego | Script oficial `headless-min.js` incrustado tal cual | Motor propio (`api.js`) compatible a nivel de protocolo (versión 9) |
| Fidelidad | Máxima: es el código de basro | Alta pero dependiente de ingeniería inversa; riesgo de desync si el juego cambia |
| Actualizaciones | PR automático semanal al cambiar `cache_hash` | Manual (requiere reimplementar cambios) |
| Rol | **Solo host** (Headless Host) | Host **y cliente** (`Room.join`), multi-join, sandbox offline, stream watcher |
| API | La oficial (`HBInit`, ~31 métodos, ~21 eventos) | Superconjunto: ~100+ métodos, cadena before/plugin/room/renderer/after, interceptación de cada operación |
| Física | Solo `setDiscProperties` y estadios `.hbs` | Acceso directo a `room.state`/`gameState.physicsState`; añadir/quitar objetos en caliente; `runSteps`, velocidad de simulación, snapshots |
| Replays | `startRecording/stopRecording` | Leer, reproducir, buscar, recortar, **modificar** y escribir `.hbr2` (v3) |
| Render | Ninguno | Renderers pluggables (canvas, PIXI…) |
| Plugins | No (un único script de bot) | Plugin/RoomConfig/Library/Language con activación en caliente |
| Protocolo propio | No | `CustomEvent`, `BinaryCustomEvent`, `SetPlayerIdentity` entre clientes de la API |
| Funciones "hack" | No | `fakePassword`, `playerCount` falso, `unlimitedPlayerCount`, `fakePlayerJoin/Leave`, `fakeSendPlayerChat/Input` (eventos atribuidos a otros), `executeEventWithTarget` (desync intencionado), aimbot/speedhack de ejemplo, `passwordGuesser.js` |
| Navegador | No (Node ≥ 22.18) | Sí (con proxy o extensión de Origin) y Node ≥ 16.9 |
| WebRTC | `@webrtc-node/webrtc` (sustituible) | `node-datachannel/polyfill` (o el del `window`) |
| Proxy | `proxy` (solo WebSocket) | `proxyAgent` global o por sala; `proxy.WebSocketUrl/HttpUrl`; backend personalizado |
| Token | Obligatorio para crear sala | Obligatorio con backend oficial (headless token); token de cliente para salas con reCAPTCHA; `"sandbox"` en sandbox |
| Licencia | MIT (pero redistribuye un script "© Mario Carbajal – All rights reserved") | MIT ("Absolutely no rights reserved") |

### Riesgos y consideraciones de ToS / ética

- **Redistribución**: haxball.js publica en npm el script oficial marcado "All rights reserved"
  (`src/generated/headless.ts` L26-29). Implicaciones de licencia **(no verificado)**; ningún
  documento de los repos menciona autorización explícita.
- **Términos de servicio**: no se localizó un documento formal de ToS de haxball.com en este análisis
  **(no verificado)**. Aun así, usar clientes modificados para engañar a otros jugadores (ocultar o
  falsear contraseña/aforo, suplantar mensajes o inputs de otros con `fake*`, aimbot, speedhack,
  fuerza bruta de contraseñas con `passwordGuesser.js`, rotar IPs con proxies para saltarse el límite
  de salas por IP) es abuso del servicio y de otros usuarios. Para investigación conviene limitarse a
  sandbox/replays locales y salas privadas propias.
- **Estabilidad**: node-haxball depende de que el protocolo no cambie (`version: 9`); haxball.js
  depende de invariantes del minificado (falla de forma explícita si cambian).
- **Seguridad**: en el host de node-haxball, una excepción en `onOperationReceived` desconecta al
  emisor ("Bad actor"); `onConnInfo` expone el SDP de los pares (IPs). Tratar `conn`/IP como dato
  personal.
- **Infraestructura de terceros**: el proxy público de node-haxball (onrender.com) ve todo el tráfico
  que pasa por él.

---

## 4. Ejemplos mínimos (no probados)

> Ejemplos **adaptados** de la documentación; **no se han ejecutado** (no se crearon salas reales).
> Requieren un token válido de `https://www.haxball.com/headlesstoken`, que caduca en minutos.

### 4.1 haxball.js — hospedar una sala

Adaptado de `haxball.js/README.md` ("Module Usage Example") y `test/basic.test.ts`:

```js
// EJEMPLO NO PROBADO
import HaxballJS, { InvalidRoomTokenError } from 'haxball.js';

const HBInit = await HaxballJS({ /* proxy: 'http://ip:puerto', debug: true */ });

const room = HBInit({
  roomName: 'Sala de prueba',
  maxPlayers: 12,
  public: false,        // privada: no aparece en la lista
  noPlayer: true,       // sin jugador host (recomendado)
  token: process.env.HB_TOKEN,
});

room.setDefaultStadium('Big');
room.setScoreLimit(3);
room.setTimeLimit(3);

room.onRoomLink = (link) => console.log('Enlace:', link);
room.onPlayerJoin = (p) => {
  console.log(`${p.name} (id=${p.id}, auth=${p.auth}, conn=${p.conn})`);
  if (!room.getPlayerList().some((x) => x.admin)) room.setPlayerAdmin(p.id, true);
};
room.onPlayerChat = (p, msg) => {
  if (msg === '!bb') { room.kickPlayer(p.id, 'Adiós', false); return false; } // false = no se difunde
};
room.onTeamGoal = (team) => room.sendAnnouncement(team === 1 ? '¡Gol Red!' : '¡Gol Blue!', null, 0xFFFF00, 'bold', 2);
// Un token caducado provoca InvalidRoomTokenError (lanzado desde el XHR interno).
```

### 4.2 node-haxball — hospedar una sala

Adaptado de `node-haxball/examples/api_structure/createRoom.js` L1-35 y README L109-130:

```js
// EJEMPLO NO PROBADO
const API = require('node-haxball')();
const { Room, Utils, Plugin, AllowFlags } = API;
API.Language.current = new (require('node-haxball/examples/languages/englishLanguage'))(API); // para error.toString()

function Greeter(API) {           // plugin mínimo
  Object.setPrototypeOf(this, Plugin.prototype);
  Plugin.call(this, 'greeter', true, { version: '0.1', author: 'yo', description: 'saluda',
    allowFlags: AllowFlags.CreateRoom });
  this.onPlayerJoin = (playerObj) => this.room.sendChat('Hola ' + playerObj.name);
}

Room.create({
  name: 'Sala de prueba', password: null, showInRoomList: false,
  maxPlayerCount: 12, noPlayer: true, token: process.env.HB_TOKEN,
}, {
  storage: { player_name: 'bot', avatar: '🤖' },
  plugins: [new Greeter(API)],
  onOpen: (room) => {
    room.onAfterRoomLink = (link) => console.log('Enlace:', link);
    room.onPlayerChat = (id, message) => console.log(room.getPlayer(id)?.name, ':', message);
    // Interceptar operaciones entrantes (solo host):
    room.onOperationReceived = (type, msg) => {
      if (type === API.OperationType.SendChat && msg.text.includes('spam')) return false; // bloquear
      return true;
    };
  },
  onClose: (err) => console.log('Sala cerrada:', err?.toString()),
});
```

### 4.3 node-haxball — unirse como cliente

Adaptado de `node-haxball/examples/api_structure/joinRoom.js` L1-32 y README L88-106:

```js
// EJEMPLO NO PROBADO — usar solo con una sala propia
const API = require('node-haxball')();
const { Room, Utils, ConnectionState } = API;

Utils.generateAuth().then(([authKey, authObj]) => {   // guardar authKey para conservar identidad (auth)
  Room.join({ id: 'ID_DE_TU_SALA', password: 'pwd', authObj }, {
    storage: { player_name: 'cliente', avatar: '👽', player_auth_key: authKey },
    onConnInfo: (state, extra) => console.log('estado:', Object.keys(ConnectionState).find(k => ConnectionState[k] === state)),
    onOpen: (room) => {
      room.sendChat('Hola desde node-haxball');
      room.onGameTick = () => {
        const ball = room.getBall();               // acceso directo al estado de física
        // room.setKeyState(Utils.keyState(1, 0, false)); // mover a la derecha
      };
    },
    onClose: (err) => console.log('Desconectado:', err?.toString()),
  });
});
```

### 4.4 node-haxball — sandbox offline (sin red)

Basado en README L402-461 y `examples_web/src/sandbox.js` L4971-4980:

```js
// EJEMPLO NO PROBADO
const API = require('node-haxball')();
const sb = API.Room.sandbox({
  onTeamGoal: (teamId) => console.log('gol de', teamId),
  render: () => {},
}, { controlledPlayerId: 0 });
sb.setCurrentStadium(API.Utils.getDefaultStadiums()[0], 0);
sb.playerJoin(1, 'p1', 'es', 'P1', 'fakeConn', 'fakeAuth');
sb.setPlayerTeam(1, 1, 0);
sb.startGame(0);
sb.setSimulationSpeed(0);   // congelar
sb.runSteps(60);            // avanzar 1 s de juego (60 ticks)
console.log(sb.gameState?.physicsState.discs[0].pos);
```

---

## 5. Glosario de conceptos de HaxBall expuestos por las APIs

| Concepto | Descripción | Evidencia |
|---|---|---|
| **Sala (room)** | Partida alojada por un *host*; topología estrella P2P: el host es la autoridad y los clientes conectan a él por WebRTC tras señalización por WebSocket | `api/host`, canales `ro/ru/uu` (§1.6) |
| **Room link / room id** | `https://www.haxball.com/play?c=<id>`; el `id` es lo que usa `Room.join` | README node-haxball L341; `onRoomLink` |
| **Host / player id 0** | El host ocupa el id **0**. Acciones "solo host" usan `byId = 0`; los clientes originales tienen un caso especial para id 0 (`fakePlayerLeave(0)` causa desync); en el headless oficial con `noPlayer`, los eventos del host llegan con `byPlayer = null` | README node-haxball L438-456, L616; `headlessWrapper.js` L74; `types.ts` L51 |
| **Player id** | Entero único por jugador en la sesión, nunca reutilizado mientras dura (`uint16`, 0-65535 en node-haxball) | `types.ts` L474; README L615 |
| **Equipos** | `0` = Espectadores, `1` = Red, `2` = Blue (`TeamID`); `Team.byId = [spec, red, blue]`; cada `Team` tiene `color`, `defenseDir`, `cMask`, `cGroup` | `types.ts` L523-529; `index.d.ts` L1491-1549, L9811-9826 |
| **Colores de equipo** | `TeamColors {angle, text, inner[]}`: ángulo de franjas, color del texto del avatar, hasta 3 franjas; enteros RGB `0xRRGGBB`, `-1` = transparente | `index.d.ts` L1455-1480; `setTeamColors` en `types.ts` L142 |
| **Admin** | Permiso para cambiar equipos, estadio, límites, kick/ban, etc.; se concede con `setPlayerAdmin` | `types.ts` L73, L371 |
| **auth** | ID público del jugador (clave pública de un par ECDSA P-256; string de 43 caracteres). Visible en `haxball.com/playerauth`. Sirve para cuentas, no para bans (no prueba que *no* seas otro) | `types.ts` L491-498; `Utils.authToNumber` (README L256); `api.js` (ECDSA P-256) |
| **conn** | Identificador de la conexión de red (IP codificada en hex); igual para jugadores en la misma red. `Utils.hexStrToNumber` lo convierte a IP legible | `types.ts` L499-504; README L268 |
| **player_auth_key** | Clave privada guardada por el cliente; `Utils.generateAuth()` / `authFromKey()` | README L248-249 |
| **Avatar vs headless avatar** | Avatar del cliente (≤2 caracteres/emoji) frente al override que impone el host (`SetHeadlessAvatar`, op 22); `avatarNumber` se muestra si no hay avatar | `index.d.ts` L1572-1600; `types.ts` L253 |
| **Bandera / geo** | `{lat, lon, flag/code}`: país de 2 letras, ubicación mostrada en la lista de salas; `api/geo` la deduce de la IP | `types.ts` L45; `index.d.ts` L1551 |
| **Token headless** | Prueba de reCAPTCHA para crear salas (prefijo observado `thr1.`); caduca en minutos | `examples/api_structure/createRoom.js` L13 |
| **Token de cliente / rcr** | Respuesta reCAPTCHA (`rcr`) necesaria para unirse a salas con `requireRecaptcha` | `tokenGenerator/src/index.html` L37-42 |
| **Tick / frame** | La simulación avanza 60 ticks/s (`onGameTick`); kick rate en frames lógicos | `types.ts` L402-406, L242 |
| **Input / key state** | Bitmask `up=1, down=2, left=4, right=8, kick=16` (0-31) | `types.ts` L19-25; README L259 |
| **Kick rate limit** | `min`, `rate`, `burst`: frames mínimos entre disparos y "ahorro" de disparos | `types.ts` L240-246 |
| **Estadio (.hbs)** | JSON5 con `vertexes, segments, goals, discs, planes, joints, spawnPoints, playerPhysics, ballPhysics, bg, traits` | `types.ts` L605-877 |
| **Disco** | Objeto físico circular (balón = disco 0 salvo `ballPhysics:"disc0"`); `pos, speed, gravity, radius, invMass, damping, bCoef, color, cMask, cGroup` | `types.ts` L534-561, L847-856 |
| **Collision flags** | `ball=1, red=2, blue=4, redKO=8, blueKO=16, wall=32, kick=64, score=128`, `c0..c3` (bits 28-31); A y B colisionan si `(A.cGroup & B.cMask) && (B.cGroup & A.cMask)` | `index.d.ts` L426-575; `types.ts` L563-599 |
| **Estado de juego** | `GamePlayState`: `BeforeKickOff=0, Playing=1, AfterGoal=2, Ending=3`; `goalTickCounter` = 150 tras gol; `pauseGameTickCounter` = 120 al pausar | `index.d.ts` L665-680, L1725-1800 |
| **Tiempo / marcador** | `ScoresObject.time` en segundos (oficial); `GameState.timeElapsed` documentado como "milisegundos" en node-haxball, pero el wrapper lo pasa sin conversión como `time` → probablemente segundos **(no verificado)** | `types.ts` L515; `index.d.ts` L1732; `headlessWrapper.js` L29 |
| **Sync / desync** | Todos los pares simulan de forma determinista y reciben las mismas operaciones; `SetPlayerSync`/`CheckConsistency` detectan desincronizaciones | `OperationType` 2 y 16; `debugDesync` |
| **Ping / handicap** | El host difunde pings de todos (op 17); `handicap` añade retardo artificial al input propio (ms) | README L503-504; `onPingData` |
| **Replay (.hbr2)** | Estado inicial + eventos con `frameNo` + marcadores de gol; versión de formato 3 | README L234-239 |
| **Announcement** | Mensaje del host con color/estilo/sonido; funciona sin jugador host | `types.ts` L223-238 |
| **Teams lock** | Impide que los jugadores cambien de equipo por sí mismos | `types.ts` L130-133 |
| **Auto teams** | Mueve los dos últimos espectadores a Red/Blue | README L531 |

---

## Fuentes

Código (clones locales, ver encabezado para commits):

- haxball.js: `README.md`, `package.json`, `src/index.ts`, `src/runtime.ts`, `src/pako.ts`,
  `src/types.ts`, `src/generated/headless.ts` (script oficial incrustado, cache hash `H4mQWPXF`,
  source hash `f066733d`), `scripts/update-headless.ts`, `test/basic.test.ts`,
  `test/proxy.test.ts`, `test/webrtc.test.ts`, `.github/workflows/checkupdates.yml`.
- node-haxball: `README.md`, `package.json`, `src/index.js`, `src/indexCommon.js`, `src/api.js`
  (minificado; inspeccionado con búsquedas de cadenas), `src/index.d.ts`, `src/pluginTemplate.js`,
  `src/rendererTemplate.js`, `src/libraryTemplate.js`, `src/languageTemplate.js`,
  `src/roomConfigTemplate_method1.js`, `src/roomConfigTemplate_method2.js`,
  `src/headlessWrapper.js`, `src/sandboxWrapper.js`, `examples/api_structure/{createRoom,joinRoom,replayReader,replayModifier,headless_web}.js`,
  `examples/plugins/greetPeople.js`, `examples/other/compareStates.js`,
  `examples_web/README.md`, `examples_web/src/{sandbox,sandboxRoomWrapper,headless}.js`,
  `streamingServer/{README.md,src/index.js,src/roomScript.js}`,
  `tokenGenerator/{README.md,src/index.html,src/package.json}`,
  `haxballOriginModifier/{README.md,src/manifest.json,src/background.js}`, `unit_tests/test.js`.

Web:

- Repositorio y npm de haxball.js: https://github.com/mertushka/haxball.js · https://www.npmjs.com/package/haxball.js
- Repositorio, wiki y npm de node-haxball: https://github.com/wxyz-abcd/node-haxball · https://github.com/wxyz-abcd/node-haxball/wiki · https://www.npmjs.com/package/node-haxball
- Wiki oficial del Headless Host: https://github.com/haxball/haxball-issues/wiki/Headless-Host
  (consultada: arranque en `html5.haxball.com/headless`, `window.HBInit`/`onHBLoaded`, token que
  caduca en minutos, asincronía de la API, `auth`/`conn`, lista de métodos y eventos).
- Collision flags: https://github.com/haxball/haxball-issues/wiki/Collision-Flags (referenciado desde `types.ts` L299, L570).
