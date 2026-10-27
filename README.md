<div align="center">

# haxlite

**Un host headless de HaxBall en TypeScript: más ligero, más rápido y con la misma API `HBInit`.**

[![CI](https://github.com/ttaliba/haxlite/actions/workflows/ci.yml/badge.svg)](https://github.com/ttaliba/haxlite/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-3c873a)
![Bun](https://img.shields.io/badge/Bun-compatible-f472b6)
![Protocolo](https://img.shields.io/badge/HaxBall-protocolo%209-1f6feb)
![Licencia](https://img.shields.io/badge/licencia-MIT-lightgrey)

</div>

haxlite habla el protocolo 9 bit a bit con los clientes oficiales del navegador y expone la misma API `HBInit` que la página headless oficial, **sin navegador y sin ejecutar el script oficial**. Está escrito en TypeScript y se basa en el trabajo de la comunidad (ver la [aclaración](#aclaración) al final).

<p align="center">
  <img src="docs/img/benchmark/0-comparativa-completa.png" alt="Comparativa completa de benchmarks: haxlite frente a haxball.js y node-haxball" width="900">
</p>

## Contenido

- [Por qué haxlite](#por-qué-haxlite)
- [Instalación](#instalación)
- [Empezar en 2 minutos](#empezar-en-2-minutos)
- [Compatibilidad con el `HBInit` oficial](#compatibilidad-con-el-hbinit-oficial)
- [Extensiones propias](#extensiones-propias)
- [Cómo se conectan los jugadores](#cómo-se-conectan-los-jugadores)
- [Ajustes de netcode](#ajustes-de-netcode)
- [Seguridad y robustez](#seguridad-y-robustez)
- [Benchmarks](#benchmarks)
- [Arquitectura](#arquitectura)
- [Documentación](#documentación)
- [Desarrollo](#desarrollo)
- [HaxBall en una página](#haxball-en-una-página)
- [Aviso y licencia](#aviso-y-licencia)
- [Aclaración](#aclaración)

## Por qué haxlite

| | |
|---|---|
| **Menos CPU y memoria** | Con 20 jugadores usa un 58 % menos de CPU que haxball.js y 27 % menos de RAM. Con 10 salas en un proceso, un 67 % menos de CPU. |
| **Sala vacía = 0 % CPU** | Un solo temporizador por proceso en una rejilla de 60 Hz compartida por todas las salas; sin partida, no se despierta. |
| **Entra el doble de rápido** | La entrada a la sala pasa de ≈ 2,06 s a ≈ 1,06 s. |
| **WebRTC propio, sin addons nativos** | `peerBackend: 'rtc'`: ICE completo con STUN y TURN, DTLS 1.2 y SCTP en TypeScript puro, un único puerto UDP para todas las salas. Funciona detrás de NAT. |
| **Misma API** | Todos los métodos y callbacks del `HBInit` oficial con las mismas formas de objeto. Un test ejecuta el mismo escenario contra el host oficial real y contra haxlite y exige la misma secuencia de callbacks. |
| **Ocultar la IP del host** | Relay TURN integrado y *gateway* [haxlite Edge](docs/09-haxlite-edge.md) para que la IP del host no llegue nunca a un jugador. |
| **Extras que el oficial no tiene** | Varias salas por proceso, visuales privados por jugador, jugadores ocultos, bans por IP / rango CIDR / `auth`, límite de intentos de entrada, grabación asíncrona. |
| **Node y Bun** | Node.js ≥ 22 y Bun (probado con 1.4), usando en Bun los caminos más baratos (`fetch`, E/S UDP nativa con `sendMany`). |
| **Una dependencia** | `ws`. `node-datachannel` es opcional. El parser de `json5` va incluido en `dist` (MIT, aviso en el propio archivo), no es una dependencia de ejecución. |

## Instalación

```sh
npm install https://github.com/ttaliba/haxlite/releases/download/v1.1.2/haxlite-1.1.2.tgz

# sin node-datachannel: peerBackend 'rtc' (el valor por defecto) o edge con 'rtc'
npm install https://github.com/ttaliba/haxlite/releases/download/v1.1.2/haxlite-1.1.2.tgz --omit=optional

# o, desde este repositorio:
npm install && npm run build         # genera dist/ con los .d.ts (JSDoc en la API HBInit, la raíz y los módulos de operador)
```

El paquete se instala con el nombre `haxlite`. Todavía no está en npmjs.com; el archivo `.tgz` de cada versión se adjunta en [Releases](https://github.com/ttaliba/haxlite/releases).

`node-datachannel` es una `optionalDependency`. Solo hace falta con `peerBackend: 'ndc'` (o sin `peerBackend` pero con `transport.portRange` / `transport.rtc`, que lo eligen), con los jugadores `'ndc'` del edge o con su túnel WebRTC legado. Si falta y se necesita, la negociación falla con «node-datachannel no está instalado: instálalo o usa peerBackend: 'rtc'». Un proyecto TypeScript con `skipLibCheck: false` puede ver TS2307 sin él, porque algunos `.d.ts` importan sus tipos.

### Token

Crear una sala exige un **headless token** de <https://www.haxball.com/headlesstoken>. Caduca a los pocos minutos: crea la sala nada más copiarlo. Si es inválido o ha caducado, el servidor maestro pide un reCAPTCHA y `HBInit` se rechaza con `InvalidRoomTokenError` (igual que haxball.js), salvo que se pase `haxlite.onRecaptcha`.

## Empezar en 2 minutos

```js
import { HBInit } from 'haxlite';

const room = await HBInit({
  roomName: 'Mi sala',
  maxPlayers: 16,
  public: true,
  noPlayer: true,
  token: process.env.HAXBALL_TOKEN,
});

room.onRoomLink = (link) => console.log(link);
room.setDefaultStadium('Big');
room.onPlayerJoin = (player) => room.sendAnnouncement(`Hola ${player.name}`, player.id);
room.onPlayerChat = (player, msg) => msg !== '!secreto'; // false = el mensaje no llega a nadie

process.once('SIGINT', () => room.haxlite.stop()); // el proceso termina solo
```

Para producción en un servidor con IP pública, cambia el WebRTC por el propio:

```js
const room = await HBInit({
  roomName: 'Mi sala', token: process.env.HAXBALL_TOKEN, noPlayer: true,
  haxlite: { peerBackend: 'rtc', rtc: { port: 40000 } },
});
```

### Ejemplos completos

| Ejemplo | Qué enseña |
|---|---|
| [`examples/basic-room.mjs`](examples/basic-room.mjs) | admin al primer jugador, equipos automáticos, comandos `!bb`, `!afk`, `!swap`, `!rr` |
| [`examples/moderation.mjs`](examples/moderation.mjs) | bans persistentes en JSON, re-ban al volver con otra IP, cuarentena de chat para `auth` nuevos, mute, bans por rango CIDR, rechazo de jugadores sin `auth` |
| [`examples/live-room.mjs`](examples/live-room.mjs) | sala real de prueba manual, configurada con variables `HX_*` (ver la cabecera del archivo) |

Los tres primeros se ejecutan en los tests (`test/api/examples.test.ts`).

## Compatibilidad con el `HBInit` oficial

Todos los métodos (`sendChat`, `sendAnnouncement`, `kickPlayer`, `setPlayerAdmin`, `setPlayerTeam`, `startGame`, `setCustomStadium`, `startRecording`, `set/getDiscProperties`, `CollisionFlags`, `InputFlags`…) y todos los callbacks `on*` (incluidos `onPlayerActivity` y `onPlayerInput`), con las mismas formas de objeto, el mismo orden de claves, las mismas unidades y el mismo uso de `null`.

Mismo modelo de ejecución: los métodos que cambian el estado se aplican en un *microtask*, en orden de llamada (`setPlayerAdmin(id, true); getPlayer(id).admin` sigue siendo `false` en esa línea). Los errores de validación (`.hbs` inválido, `Stadium doesn't exist`, *casts*) se lanzan de forma síncrona.

`test/api/parity.test.ts` ejecuta **el mismo script y el mismo escenario** contra el `HBInit` oficial real (conectado a un maestro falso) y contra haxlite.

### Diferencias deliberadas

| | Oficial | haxlite |
|---|---|---|
| `HBInit` | síncrono | `await HBInit(config)`: resuelve cuando el maestro asigna el enlace; un `onRoomLink` asignado después lo recibe igual |
| Token caducado | captcha en la página / `InvalidRoomTokenError` sin capturar | promesa rechazada con `InvalidRoomTokenError`, o flujo `haxlite.onRecaptcha` |
| Excepciones en callbacks | rompen el bucle del motor | se notifican a `room.haxlite.onError` (por defecto `console.error`) y el frame se completa; una promesa rechazada de un callback se notifica igual; las rachas de errores idénticos se coalescen; un `onPlayerChat` que lanza sigue expulsando al emisor, como el oficial |
| `setScoreLimit/TimeLimit(3.5)` | aplica el valor sin convertir | convierte a entero |
| `clearBans()` | vacía la lista de bans | vacía los bans de `kickPlayer(…, true)`; los de `room.haxlite.bans` (IP, rango, auth) se quitan con `room.haxlite.bans.clear()` |
| Varias salas | una por página (`Can't init twice`) | varias por proceso |
| Cierre | no existe | `room.haxlite.stop()` / `close()` |
| Temporizadores | `setInterval` de 50 ms siempre | un temporizador por proceso en una rejilla de 60 Hz; sala vacía sin partida = 0 % CPU |

## Extensiones propias

Todas son opcionales; sin ellas el comportamiento es el oficial. Se pasan en `config.haxlite` y se usan desde `room.haxlite`. **Referencia completa con tipos y valores por defecto: [docs/11 - Referencia de la API](docs/11-referencia-api.md).**

```js
const room = await HBInit({
  roomName: 'Sala', token, noPlayer: true,
  haxlite: {
    inputDelayFrames: 2,
    heartbeatFrames: 7,
    joinRateLimit: { capacity: 3, msPerToken: 15_000 },          // intentos de entrada por IP
    onJoinRequest: async (req) => !(await esIpVetada(req.ip)),   // antes de WebRTC
    peerBackend: 'rtc',
    rtc: { port: 40000 },
  },
});
room.haxlite.bans.addRange('203.0.113.0/24');
room.haxlite.onBeforeOperation = (event, byPlayerId, frame) => true; // false descarta el evento
```

| Extensión | Qué hace |
|---|---|
| `inputDelayFrames`, `heartbeatFrames`, `checksumIntervalFrames` | ajustes de netcode, modificables en caliente ([ver abajo](#ajustes-de-netcode)) |
| `onJoinRequest(req)` | gancho previo a WebRTC con IP, `conn`, IPs *srflx*, versión y contraseña; puede ser `async` |
| `bans` | `addIp`, `addRange` (CIDR IPv4/IPv6), `addAuth`, `list`, `remove`, `clear`…; compartible entre salas |
| `allowNullAuth`, `joinRateLimit` | sin jugadores anónimos; límite de intentos por IP |
| `transport.maxUnjoinedPerIp`, `transport.abusePenalty`, `transport.verifiedIpBans` | protecciones por dirección activas por defecto: conexiones sin unir por IP (12), penalización por abusos y bans de IP verificados. Desactivarlas: `Infinity`, `null`, `false` ([Seguridad y robustez](#seguridad-y-robustez)) |
| `onBeforeOperation(ev, byId, frame)` | ve cada evento de cliente antes de aplicarlo: `false` lo descarta, puede modificarlo |
| `onRecaptcha` / `useRecaptchaToken` | flujo de captcha cuando el maestro lo pide |
| `peerBackend`, `rtc`, `edge` | cómo se conectan los jugadores ([ver abajo](#cómo-se-conectan-los-jugadores)) |
| `stop()` / `close()` | cierra temporizadores, señalización y conexiones; Node termina solo |
| `stopRecordingAsync()` | como `stopRecording()` pero el deflate corre fuera del bucle (siempre con nivel 6; el síncrono usa nivel 1 en Node por encima de 64 KiB). La grabación tiene tope (16 MiB o 2 097 152 eventos): al alcanzarlo se congela y `room.haxlite.recordingTruncated` pasa a `true` |
| `recordAnnouncement(msg, color?, style?, sound?)` | anuncio que va **solo al `.hbr2`** (los jugadores no lo ven), en el momento actual del replay. Ej.: `room.recordAnnouncement(p.name + ' metió gol a las ' + new Date().toLocaleTimeString())` |
| `setDiscPropertiesFor`, `clearDiscOverrides`… | **visuales privados**: cambia un disco solo en el mundo de un jugador sin desincronizar a nadie (máscaras de visión, marcadores) |
| `hidePlayerFor`, `showPlayerFor`, `setPlayerHiddenFor`… | **jugadores ocultos**: el jugador desaparece solo para ese espectador (visión por zonas, espectadores que no deben ver a ciertos jugadores). No es seguridad: un cliente modificado sigue pudiendo saber dónde está |
| `getPlayerConnection(id)` | `auth`, `conn`, IP, IPs *srflx*, ping |
| `getConnectionQuality(id)` | cómo ha ido la conexión de un jugador, medida por el host: jitter, pings perdidos, inputs tardíos y lag del host, con ~5 min de historial (solo números) |
| `getStadium()`, `getKickRateLimit()`, `getRecordingInfo()` | el estadio actual como datos (metas, vértices, segmentos…), los límites de patada y el estado de la grabación |
| `trackTouches`, `getLastTouches()`, `onPlayerTouch` | quién tocó el balón último y penúltimo (para asistencias), opt-in: apagado no cuesta nada |
| `trackStats`, `getStats()` | **estadísticas del partido**: goles, asistencias, autogoles, patadas, pases, recuperaciones y posesión por jugador y equipo |
| `inputGuard`, `onInputAbuse` | **anticheat de inputs**: avisa cuando alguien supera los inputs o patadas por segundo que da un humano (macros, *turbo kick*, clientes modificados) |
| `onTimeLimitReached`, `onPlayerDesyncChange`, `onChatIndicator` | eventos del motor que la API oficial no cablea (fin por tiempo, desincronización, "está escribiendo") |
| `getRoomSettings()`, `getGameInfo()`, `getPlayerInfo(id)` | estado que la API oficial no deja leer: bloqueo de equipos, estadio actual, fase del partido y quién saca, país y `desync` de un jugador |
| `getTeamColors(team)`, `onTeamColorsChange` | uniformes de los equipos leídos de forma nativa (la API oficial no los expone) |
| `setMaxPlayers`, `roomLink`, `frame`, `onError`, `host`, `transport` | utilidades y acceso al motor |

## Cómo se conectan los jugadores

| Modo | Cuándo usarlo | Notas |
|---|---|---|
| `peerBackend: 'rtc'` (por defecto) | producción y desarrollo | WebRTC propio en TypeScript, un puerto UDP, sin hilos nativos, mucha menos CPU por jugador ([docs/07](docs/07-benchmarks.md)). ICE completo con STUN y TURN (RFC 8656): funciona detrás de NAT. [docs/10](docs/10-haxlite-rtc.md) |
| `peerBackend: 'ndc'` | compatibilidad máxima (TURN TCP/TLS, bots en la misma LAN sin *hairpinning*) | `node-datachannel` (libdatachannel nativo). También se elige solo si das `transport.portRange` o `transport.rtc` sin `peerBackend` |
| `edge: { url, key }` | ocultar la IP del host | los jugadores se conectan a un [haxlite Edge](docs/09-haxlite-edge.md) remoto; la IP del host no llega a ningún jugador |

`rtc.sendBatchFrames: 1 | 2` agrupa las difusiones de eventos de cliente: de -23 % a -44 % de bytes por jugador a cambio de n × 8,3 ms de media en las entradas ajenas (por defecto 0). Para esconder la IP del host con Cloudflare TURN y firewall, ver [docs/08](docs/08-ocultar-ip.md) y [docs/ip](docs/ip/01-exposicion-ip.md).

## Ajustes de netcode

Los clientes oficiales se adaptan a estos ajustes sin cambios, porque el host les comunica el retardo en cada *pong* y ellos avanzan según los *heartbeats* que reciben.

| Ajuste | Defecto | Efecto |
|---|---:|---|
| `inputDelayFrames` | 2 (como el oficial) | frames entre «ahora» y el frame en que se aplica el input de un cliente. Más retardo = menos inputs tarde (y menos correcciones) con *jitter*, a cambio de más latencia de control |
| `heartbeatFrames` | 7 | cada cuántos frames envía el host el *heartbeat*. Bajar a 2–3 acorta la extrapolación y reduce las correcciones visibles de los demás jugadores, a ≈ 9 bytes por cliente y *heartbeat* |
| `checksumIntervalFrames` | 600 | periodo del *CheckConsistency* que detecta desincronización |

## Seguridad y robustez

haxlite trata como entrada no fiable a los jugadores, al servidor maestro, al edge y a los ficheros `.hbr2`. Lo siguiente está activo por defecto y cada fila indica cómo se ajusta. Referencia completa: [docs/11](docs/11-referencia-api.md) (opciones, errores y códigos de cierre) y [docs/12](docs/12-referencia-operacion.md) (Edge, firewall). Qué cambió respecto a versiones anteriores y cómo volver atrás: [docs/13](docs/13-notas-de-version.md).

| Qué protege | Qué hace por defecto | Cómo se configura |
|---|---|---|
| Entrada de jugadores | admisión antes de crear WebRTC (16 negociaciones, bans, sala llena); como mucho 12 conexiones sin unir por dirección pública; penalización por abusos (20 fichas, una cada 3 s; agotadas, una conexión cada 3 s durante 30 s); decisiones de `onJoinRequest` validadas | `transport.maxPendingNegotiations`, `transport.maxUnjoinedPerIp`, `transport.abusePenalty`, `joinRateLimit`, `allowNullAuth`, `onJoinRequest` |
| Bans de IP | el kick-ban guarda la IP de `conn` y la dirección del par ICE si el cliente la declaró; no guarda las IP *srflx* declaradas, que podrían ser de un tercero | `transport.verifiedIpBans`, `bans` |
| Jugadores que no leen | se cierra con `'stalled'` al jugador con más de 1 MiB sin confirmar durante 10 s | `transport.maxPeerBufferedBytes`, `transport.peerBufferedTimeoutMs` |
| Callbacks y errores | una excepción o una promesa rechazada en un callback va a `onError` y el frame se completa; las rachas de errores idénticos se coalescen (60, luego un resumen por segundo) | `onError`, `errorRepeatBurst`, `errorRepeatWindowMs` |
| Opciones inválidas | `RangeError` al crear la sala en lugar de aceptar `NaN`, `0` o negativos en silencio | valores válidos en docs/11 |
| Servidor maestro | cuerpos con tope (64 KiB; 8 MiB la lista), plazo total de la petición, URL de señalización `ws(s)` y mensajes de ≤ 256 KiB | `transport.timeoutMs` |
| Edge | topes por IP y pool sin autenticar, repartido por fuente (429/503 con `Retry-After`); `/stats` sin token: solo agregados (`redacted: true`); `ws://` hacia hosts públicos rechazado | `limits.*`, `stats.token`, `edge.allowInsecure` ([docs/09](docs/09-haxlite-edge.md), [docs/12](docs/12-referencia-operacion.md)) |
| WebRTC propio | límites por paquete en SCTP, cierre ante agotamiento de secuencia o error interno en DTLS, tope de pares TURN por sesión | sin opciones ([docs/10](docs/10-haxlite-rtc.md)) |
| Replays y estadios | lectura con tope (32 MiB, 2^21 eventos), grabación que se congela a 16 MiB o 2^21 eventos, estadios que no caben en el cable rechazados | `readReplay(bytes, opts)`, `recorder.maxBytes` / `maxEvents`, `ReplayPlayer` |

Detrás de un proxy inverso (nginx, caddy) el Edge ve todas las conexiones desde la IP del proxy: los topes por IP no se aplican a orígenes loopback o privados salvo `limits.perIpLimitsApplyToPrivate`. `limits.trustForwardedFor` usa la última entrada de `X-Forwarded-For` (`true`: solo loopback; proxy no local: lista de IP/CIDR; [docs/12 §3.6](docs/12-referencia-operacion.md)). Tras una misma NAT o CGNAT se comparten los límites por dirección: sube `maxUnjoinedPerIp` (o `Infinity`).

## Benchmarks

Tanda del 13-10-2026 (4 vCPU Xeon 2,10 GHz, Node 22): haxball.js, node-haxball y haxlite. haxlite se mide con el **paquete minificado** publicado. Los valores son la mediana de la tanda.

| métrica | haxball.js | node-haxball | **haxlite** |
|---|---:|---:|---:|
| **20 jugadores** · CPU % | 16,88 | 18,35 | **7,12** |
| RSS MB · heap MB | 91,4 · 12,5 | 92,5 · 16,1 | **67,0 · 10,6** |
| GC ms/min · pausas/min | 55,6 · 97 | 53,8 · 98 | **15,8 · 42** |
| lag p99 ms | 1,14 | 1,22 | **1,13** |
| hilos · fds · despertares/s | 18 · 46 · 4 199 | 15 · 48 · 4 260 | **11 · 25 · 481** |
| entrada p50 ms | 2 059 | 2 141 | **1 063** |
| **10 salas × 4** · CPU % | 26,11 | 25,46 | **8,67** |
| **Sala vacía** · CPU % | 0,387 | 0,766 | **0,012** |
| **Arranque** proceso → link ms | 196 | 204 | **112** |

haxlite = `peerBackend: 'rtc'`. El lag p99 es ruido (≈ 1,1–1,2 ms en los tres, 15 veces por debajo de un frame de 16,7 ms). Todo esto es Node 22; el arnés también mide Bun y los escenarios de producción `fleet`, `soak` y `join-impaired`.

| Gráficos por categoría | |
|---|---|
| [CPU](docs/img/benchmark/1-cpu.png) | [20 jugadores](docs/img/benchmark/2-sala-20-jugadores.png) |
| [GC y lag](docs/img/benchmark/3-gc-y-lag.png) | [10 salas](docs/img/benchmark/4-diez-salas.png) |
| [Sala vacía y arranque](docs/img/benchmark/5-sala-vacia-y-arranque.png) | [WebRTC por librería](docs/img/benchmark/6-webrtc-por-libreria.png) |

Resultados completos, método y todas las tandas: [docs/benchmark-hosts.md](docs/benchmark-hosts.md) y [docs/07](docs/07-benchmarks.md). Cómo reproducirlos: [docs/12 §6](docs/12-referencia-operacion.md). Regenerar las imágenes: `node bench/charts.mjs docs/img/benchmark bench/results/unified rtc,off,nh`.

## Arquitectura

```
 tu script ──► src/api     HBInit(config) → room (métodos + callbacks on*)
                 │
                 ▼
              src/host     reloj de frames, cola de eventos, difusión, snapshot de entrada
                 │
        ┌────────┴─────────┐
        ▼                  ▼
   src/room            src/net          maestro HTTP, señalización WS, auth, bans,
   estado, reglas,       │               límites de tasa, transporte
   eventos 0..23         ├─► src/rtc    WebRTC propio: ICE · TURN · DTLS 1.2 · SCTP
        │                └─► src/edge   gateway que oculta la IP del host
        ▼
   src/sim · src/codec · src/replay     física y estadios (.hbs), binario, replays .hbr2
```

| Carpeta | Contenido |
|---|---|
| `src/api` | `HBInit` y los tipos públicos |
| `src/host` | motor de la sala (`HostRoom`), secuenciador, reloj compartido |
| `src/room` | estado, jugadores, reglas y los eventos de cliente |
| `src/sim` | física determinista a 60 Hz, estadios `.hbs` y mapas por defecto |
| `src/codec` | lectura y escritura binaria, deflate, checksum |
| `src/net` | señalización, transporte, auth, bans, backends de WebRTC |
| `src/rtc` | haxlite-rtc: ICE, STUN, TURN, DTLS 1.2, SCTP |
| `src/edge` | haxlite Edge: gateway WebRTC con túnel UDP |
| `src/replay` | grabación y reproducción `.hbr2` |
| `bench/`, `scripts/`, `ops/` | benchmarks, utilidades y firewall `haxguard` |

Más detalle: [docs/06 - Arquitectura](docs/06-arquitectura-haxlite.md) y el contrato del motor en [`src/host/README.md`](src/host/README.md).

## Documentación

### Para usar haxlite

| Documento | Contenido |
|---|---|
| [11 - Referencia de la API](docs/11-referencia-api.md) | **todos** los parámetros de `HBInit`, `config.haxlite` / `room.haxlite`, métodos, callbacks, tipos y errores |
| [12 - Referencia de operación](docs/12-referencia-operacion.md) | Edge (CLI, variables de entorno, JSON), scripts de npm, arnés de benchmarks, firewall `haxguard`, CI y despliegue en producción |
| [13 - Notas de versión](docs/13-notas-de-version.md) | cambios de comportamiento por defecto y cómo volver al anterior, cambios en los `.d.ts` y en las dependencias |
| [09 - haxlite Edge](docs/09-haxlite-edge.md) | gateway que oculta la IP del host: arquitectura, despliegue, seguridad |
| [10 - haxlite-rtc](docs/10-haxlite-rtc.md) | WebRTC propio: ICE, DTLS, SCTP, TURN, interoperabilidad y benchmarks |
| [08 - Ocultar y proteger la IP](docs/08-ocultar-ip.md) | por qué se ve la IP, Cloudflare TURN, anti-DDoS, `haxguard` (más en [`docs/ip/`](docs/ip/01-exposicion-ip.md)) |
| [06 - Arquitectura](docs/06-arquitectura-haxlite.md) | módulos, reglas de código y oráculos de prueba |
| [07 - Benchmarks](docs/07-benchmarks.md) · [resultado actual](docs/benchmark-hosts.md) | CPU, memoria, GC y lag frente a haxball.js y node-haxball |

### Cómo funciona HaxBall por dentro

Investigación hecha leyendo el código de librerías públicas (fuentes y versiones exactas en la [aclaración](#aclaración) y en los propios documentos). Todo sale de leer código; no se capturó tráfico ni se crearon salas. Lo no confirmado está marcado «(no verificado)».

| Documento | Contenido |
|---|---|
| [01 - Red y salas](docs/01-red-y-salas.md) | servidor maestro, lista de salas, señalización WebSocket, WebRTC, auth y versiones |
| [02 - Protocolo binario](docs/02-protocolo-binario.md) | streams, framing, eventos 0–26, snapshot inicial, estadios en binario y `.hbr2` |
| [03 - Física y estadios](docs/03-fisica-y-estadios.md) | bucle de juego, colisiones, jugador y chute, reglas, formato `.hbs` |
| [04 - Netcode](docs/04-netcode-y-sincronizacion.md) | lockstep, asignación de frames, predicción, ping, checksums |
| [05 - Librerías y APIs](docs/05-librerias-y-apis.md) | librerías públicas de referencia, API HBInit, glosario |

## Desarrollo

```sh
npm install
npm run build          # dist/ con los .d.ts (rolldown; JSDoc en la API HBInit, la raíz y los módulos de operador)
npm run typecheck      # tsc sobre src y sobre la configuración de build
npm test               # suite completa (vitest)
npm run test:interop   # interoperabilidad WebRTC con Chromium y el cliente oficial
npm run bench:game     # un escenario del arnés de benchmarks (también startup, idle, rooms…)
npm run edge           # haxlite Edge desde el código fuente
```

Notas:

- Algunos tests dependen de Linux (permisos `0600`, `openssl`, NAT simulado, el addon nativo). En Windows fallan por entorno; el CI de Linux (Node 22, 24 y 26) es la referencia.
- Los tests comparan haxlite con **oráculos** externos: el headless oficial, un cliente independiente y Chromium (ver [docs/06 §6](docs/06-arquitectura-haxlite.md)).
- Lista completa de scripts y parámetros del arnés: [docs/12](docs/12-referencia-operacion.md).

## HaxBall en una página

<details>
<summary>Resumen del protocolo y del netcode (desplegar)</summary>

```
          HTTPS                                  WSS (señalización)
 cliente ───────► www.haxball.com/rs/api/*       p2p.haxball.com
   │              (list / geo / host / client)    ▲          ▲
   │                                              │ /client  │ /host?token=
   │        offer/answer/ICE (deflate) relayed    │          │
   └──────────────────────────────────────────────┘          │
                                                             │
 cliente ◄═══════ WebRTC DataChannels (ro/ru/uu) ═══════► HOST (autoridad)
 cliente ◄══════════════════════════════════════════════►   │
                     topología en estrella, sin TURN        │ 60 Hz lockstep
```

1. **No hay servidor de juego.** El servidor maestro solo publica la lista de salas y emite tokens y captchas. La señalización va por `wss://p2p.haxball.com`. La partida corre en el navegador (o en el headless) del **host**, que hace de autoridad y reenvía todo a los clientes por WebRTC: STUN de Google y sin TURN.
2. **Canales WebRTC:** `ro` (fiable y ordenado), `ru` (fiable, sin orden) y `uu` (no fiable). Mensajes binarios: big-endian, varints LEB128 y bloques grandes comprimidos con deflate raw. Protocolo **versión 9**; una versión distinta se rechaza (código 4103).
3. **Identidad:** cada jugador tiene un par de claves ECDSA P-256 y `auth` es la coordenada x de la pública en base64url. El host envía un reto de 8 bytes que el cliente firma. `conn` es la IP vista por el maestro codificada en hex: no es un hash.
4. **Netcode de lockstep determinista:** durante la partida solo viajan **eventos** (input de 5 bits, chat, acciones de admin). El host los sella con `(frame, orden)` y aplica un retardo de input de 2 frames. Cada peer simula la misma física a 60 Hz. El estado completo solo se envía una vez, comprimido, al entrar. Cada 600 frames el host manda un checksum para detectar desincronización; no hay resincronización automática.
5. **Predicción:** el cliente copia el último estado confirmado y re-simula hasta 120 frames hacia delante con sus propios inputs aún no confirmados, suponiendo que el resto mantiene el suyo.
6. **Física:** solo dobles y ningún número aleatorio. Cada tick mueve los discos y resuelve colisiones disco–disco, plano, segmento (recto o curvo) y vértice; las joints, 2 veces al final. El chute afecta a los discos a menos de 4 px de borde a borde.
7. **Reglas:** 4 fases (antes del saque, jugando, gol con 150 ticks y fin con 300 ticks). El empate al acabar el tiempo pasa a gol de oro.
8. **Replays `.hbr2`:** marca `HBR2` y versión 3; estado inicial más eventos con su frame, comprimidos. Reproducir equivale a re-simular desde el inicio.

**Discrepancias y pendientes de la investigación**

- El host oficial usa un retardo de input de **2** frames (`Sb=2`) y otra implementación pública usa **4** (`ZW=4`); no se sabe por qué (doc 04).
- En los tipos de esa implementación pública, `GameState.timeElapsed` figura en milisegundos, pero el código lo usa en **segundos**. Además, `curveF` no es un ángulo (docs 03 y 05).
- Los ids de eventos 0–23 de esa implementación coinciden 1:1 con el orden de registro del script oficial; los 24–26 son extensiones propias suyas (doc 02).
- No se analizó en profundidad el cliente de navegador oficial (`game-min.js`).
- Los nombres minificados cambian en cada build del script oficial; las referencias de los documentos corresponden al hash `f066733d`.

</details>

## Aviso y licencia

Documentación y código con fines educativos y de interoperabilidad. HaxBall y su script oficial del host son «© Mario Carbajal – All rights reserved»; este proyecto no está afiliado a HaxBall.

MIT, ver [LICENSE](LICENSE).

## Aclaración

haxlite se basa en el trabajo de la comunidad, en especial en dos proyectos de código abierto con licencia MIT:

- [`haxball.js`](https://github.com/mertushka/haxball.js) (© mertushka), que ejecuta el script oficial del host headless en Node.js. Las declaraciones de tipos de la API `HBInit` (`src/api/types.ts`) están adaptadas de las suyas.
- [`node-haxball`](https://github.com/wxyz-abcd/node-haxball) (© wxyz-abcd), una implementación completa del cliente y del host.

Los usamos para entender el protocolo y la estructura del host, y como referencia en las pruebas y en los benchmarks, donde figuran solo como dependencias de desarrollo. La investigación de los documentos 01 a 05 parte de `haxball.js` (commit `e5231b0`, script oficial con hash `f066733d`) y `node-haxball` (commit `4d4b88f`).
