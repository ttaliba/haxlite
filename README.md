<div align="center">

# haxlite

**Un host headless de HaxBall escrito desde cero en TypeScript: más ligero, más rápido y con la misma API `HBInit`.**

[![CI](https://github.com/ttaliba/haxlite/actions/workflows/ci.yml/badge.svg)](https://github.com/ttaliba/haxlite/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-3c873a)
![Bun](https://img.shields.io/badge/Bun-compatible-f472b6)
![Protocolo](https://img.shields.io/badge/HaxBall-protocolo%209-1f6feb)
![Licencia](https://img.shields.io/badge/licencia-MIT-lightgrey)

</div>

haxlite habla el protocolo 9 bit a bit con los clientes oficiales del navegador y expone la misma API que la página headless oficial (y que [`haxball.js`](https://github.com/mertushka/haxball.js)), **sin navegador y sin ejecutar el script oficial**. Es una reimplementación *clean-room*: física, netcode, reglas, replays y red salen de entender el protocolo, no de copiar código.

<p align="center">
  <img src="docs/img/benchmark/0-comparativa-completa.png" alt="Comparativa completa de benchmarks: haxlite frente a haxball.js, node-haxball y haxlite con node-datachannel" width="900">
</p>

> Misma máquina, misma sesión, clientes reales en procesos aparte y mediana de 3 repeticiones intercaladas (4 vCPU Xeon 2,10 GHz, Node 22). Detalle y método: [benchmarks](#benchmarks).

## Contenido

- [Por qué haxlite](#por-qué-haxlite)
- [Instalación](#instalación)
- [Empezar en 2 minutos](#empezar-en-2-minutos)
- [Compatibilidad con el `HBInit` oficial](#compatibilidad-con-el-hbinit-oficial)
- [Extensiones propias](#extensiones-propias)
- [Cómo se conectan los jugadores](#cómo-se-conectan-los-jugadores)
- [Ajustes de netcode](#ajustes-de-netcode)
- [Benchmarks](#benchmarks)
- [Arquitectura](#arquitectura)
- [Documentación](#documentación)
- [Desarrollo](#desarrollo)
- [HaxBall en una página](#haxball-en-una-página)
- [Aviso y licencia](#aviso-y-licencia)

## Por qué haxlite

| | |
|---|---|
| **Menos CPU y memoria** | Con 20 jugadores usa un 58 % menos de CPU que el host oficial y 27 % menos de RAM. Con 10 salas en un proceso, un 67 % menos de CPU. |
| **Sala vacía = 0 % CPU** | Un solo temporizador por proceso en una rejilla de 60 Hz compartida por todas las salas; sin partida, no se despierta. |
| **Entra el doble de rápido** | La entrada a la sala pasa de ≈ 2,06 s a ≈ 1,06 s. |
| **WebRTC propio, sin addons nativos** | `peerBackend: 'rtc'`: ICE completo con STUN y TURN, DTLS 1.2 y SCTP en TypeScript puro, un único puerto UDP para todas las salas. Funciona detrás de NAT. |
| **Misma API** | Todos los métodos y callbacks del `HBInit` oficial con las mismas formas de objeto. Un test ejecuta el mismo escenario contra el host oficial real y contra haxlite y exige la misma secuencia de callbacks. |
| **Ocultar la IP del host** | Relay TURN integrado y *gateway* [haxlite Edge](docs/09-haxlite-edge.md) para que la IP del host no llegue nunca a un jugador. |
| **Extras que el oficial no tiene** | Varias salas por proceso, visuales privados por jugador, jugadores ocultos, bans por IP / rango CIDR / `auth`, límite de intentos de entrada, grabación asíncrona. |
| **Node y Bun** | Node.js ≥ 22 y Bun (probado con 1.4), usando en Bun los caminos más baratos (`fetch`, E/S UDP nativa con `sendMany`). |
| **Dos dependencias** | `ws` y `json5`. `node-datachannel` es opcional. |

## Instalación

```sh
npm install haxlite                  # cuando esté publicado
npm install haxlite --omit=optional  # sin node-datachannel: solo peerBackend 'rtc' o edge con 'rtc'

# o, desde este repositorio:
npm install && npm run build         # genera dist/ con los .d.ts
```

`node-datachannel` es una `optionalDependency`. Solo hace falta con `peerBackend: 'ndc'` (el valor por defecto), con los jugadores `'ndc'` del edge o con su túnel WebRTC legado. Si falta y se necesita, la negociación falla con «node-datachannel no está instalado: instálalo o usa peerBackend: 'rtc'». Un proyecto TypeScript con `skipLibCheck: false` puede ver TS2307 sin él, porque algunos `.d.ts` importan sus tipos.

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
| [`examples/among-us-vision.mjs`](examples/among-us-vision.mjs) | niebla por habitación, marcador de tarea, jugadores de otras zonas ocultos y fantasmas invisibles para los vivos, todo solo para cada jugador |
| [`examples/live-room.mjs`](examples/live-room.mjs) | sala real de prueba manual, configurada con variables `HX_*` (ver la cabecera del archivo) |

Los tres primeros se ejecutan en los tests (`test/api/examples.test.ts`).

## Compatibilidad con el `HBInit` oficial

Todos los métodos (`sendChat`, `sendAnnouncement`, `kickPlayer`, `setPlayerAdmin`, `setPlayerTeam`, `startGame`, `setCustomStadium`, `startRecording`, `set/getDiscProperties`, `CollisionFlags`, `InputFlags`…) y todos los callbacks `on*` (incluidos `onPlayerActivity` y `onPlayerInput`), con las mismas formas de objeto, el mismo orden de claves, las mismas unidades y el mismo uso de `null`.

Mismo modelo de ejecución: los métodos que cambian el estado se aplican en un *microtask*, en orden de llamada (`setPlayerAdmin(id, true); getPlayer(id).admin` sigue siendo `false` en esa línea). Los errores de validación (`.hbs` inválido, `Stadium doesn't exist`, *casts*) se lanzan de forma síncrona.

`test/api/parity.test.ts` ejecuta **el mismo script y el mismo escenario** contra el `HBInit` oficial real (el `headless-min.js` de haxball.js, conectado a un maestro falso) y contra haxlite.

### Diferencias deliberadas

| | Oficial / haxball.js | haxlite |
|---|---|---|
| `HBInit` | síncrono | `await HBInit(config)`: resuelve cuando el maestro asigna el enlace; un `onRoomLink` asignado después lo recibe igual |
| Token caducado | captcha en la página / `InvalidRoomTokenError` sin capturar | promesa rechazada con `InvalidRoomTokenError`, o flujo `haxlite.onRecaptcha` |
| Excepciones en callbacks | rompen el bucle del motor | se notifican a `room.haxlite.onError` (por defecto `console.error`); un `onPlayerChat` que lanza sigue expulsando al emisor, como el oficial |
| `setScoreLimit/TimeLimit(3.5)` | aplica el valor sin convertir | convierte a entero |
| `clearBans()` | vacía la lista de bans | vacía los bans de `kickPlayer(…, true)`; los de `room.haxlite.bans` (IP, rango, auth) se quitan con `room.haxlite.bans.clear()` |
| Varias salas | una por página (`Can't init twice`) | varias por proceso |
| Cierre | no existe | `room.haxlite.stop()` / `close()` |
| Temporizadores | `setInterval` de 50 ms siempre | un temporizador por proceso en una rejilla de 60 Hz; sala vacía sin partida = 0 % CPU |

## Extensiones propias

Todas son opcionales; sin ellas el comportamiento es el oficial. Se pasan en `config.haxlite` y se usan desde `room.haxlite`. **Referencia completa con tipos y valores por defecto: [docs/11 — Referencia de la API](docs/11-referencia-api.md).**

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
| `onBeforeOperation(ev, byId, frame)` | ve cada evento de cliente antes de aplicarlo: `false` lo descarta, puede modificarlo |
| `onRecaptcha` / `useRecaptchaToken` | flujo de captcha cuando el maestro lo pide |
| `peerBackend`, `rtc`, `edge` | cómo se conectan los jugadores ([ver abajo](#cómo-se-conectan-los-jugadores)) |
| `stop()` / `close()` | cierra temporizadores, señalización y conexiones; Node termina solo |
| `stopRecordingAsync()` | como `stopRecording()` pero el deflate corre fuera del bucle (≈ 3 ms en vez de ≈ 280 ms con una hora de grabación) |
| `setDiscPropertiesFor`, `clearDiscOverrides`… | **visuales privados**: cambia un disco solo en el mundo de un jugador sin desincronizar a nadie (niebla, marcadores) |
| `hidePlayerFor`, `showPlayerFor`, `setPlayerHiddenFor`… | **jugadores ocultos**: el jugador desaparece solo para ese espectador (fantasmas, visión por zonas). No es seguridad: un cliente modificado sigue pudiendo saber dónde está |
| `getPlayerConnection(id)` | `auth`, `conn`, IP, IPs *srflx*, ping |
| `setMaxPlayers`, `roomLink`, `frame`, `onError`, `host`, `transport` | utilidades y acceso al motor |

## Cómo se conectan los jugadores

| Modo | Cuándo usarlo | Notas |
|---|---|---|
| `peerBackend: 'ndc'` (por defecto) | desarrollo, compatibilidad máxima | `node-datachannel` (libdatachannel nativo) |
| `peerBackend: 'rtc'` | **producción** | WebRTC propio en TypeScript, un puerto UDP, sin hilos nativos, ≈ −35 % de CPU con 20 jugadores. ICE completo con STUN y TURN (RFC 8656): funciona detrás de NAT. [docs/10](docs/10-haxlite-rtc.md) |
| `edge: { url, key }` | ocultar la IP del host | los jugadores se conectan a un [haxlite Edge](docs/09-haxlite-edge.md) remoto; la IP del host no llega a ningún jugador |

`rtc.sendBatchFrames: 1 | 2` agrupa las difusiones de eventos de cliente: de −23 % a −44 % de bytes por jugador a cambio de n × 8,3 ms de media en las entradas ajenas (por defecto 0). Para esconder la IP del host con Cloudflare TURN y firewall, ver [docs/08](docs/08-ocultar-ip.md) y [docs/ip](docs/ip/01-exposicion-ip.md).

## Ajustes de netcode

Los clientes oficiales se adaptan a estos ajustes sin cambios, porque el host les comunica el retardo en cada *pong* y ellos avanzan según los *heartbeats* que reciben.

| Ajuste | Defecto | Efecto |
|---|---:|---|
| `inputDelayFrames` | 2 (como el oficial) | frames entre «ahora» y el frame en que se aplica el input de un cliente. Más retardo = menos inputs tarde (y menos correcciones) con *jitter*, a cambio de más latencia de control |
| `heartbeatFrames` | 7 | cada cuántos frames envía el host el *heartbeat*. Bajar a 2–3 acorta la extrapolación y reduce las correcciones visibles de los demás jugadores, a ≈ 9 bytes por cliente y *heartbeat* |
| `checksumIntervalFrames` | 600 | periodo del *CheckConsistency* que detecta desincronización |

## Benchmarks

Tanda unificada del 13-10-2026: haxball.js (host oficial), node-haxball y haxlite (con su WebRTC propio y con node-datachannel), en la misma sesión y con las opciones **intercaladas** en cada repetición. haxlite se mide con el **paquete minificado** publicado. Mediana [mín–máx] de 3 repeticiones de 60 s tras 15 s de calentamiento.

| métrica | haxball.js (oficial) | node-haxball | **haxlite** |
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

Más detalle: [docs/06 — Arquitectura](docs/06-arquitectura-haxlite.md) y el contrato del motor en [`src/host/README.md`](src/host/README.md).

## Documentación

### Para usar haxlite

| Documento | Contenido |
|---|---|
| [11 — Referencia de la API](docs/11-referencia-api.md) | **todos** los parámetros de `HBInit`, `config.haxlite` / `room.haxlite`, métodos, callbacks, tipos y errores |
| [12 — Referencia de operación](docs/12-referencia-operacion.md) | Edge (CLI, variables de entorno, JSON), scripts de npm, arnés de benchmarks, firewall `haxguard`, CI y despliegue en producción |
| [09 — haxlite Edge](docs/09-haxlite-edge.md) | gateway que oculta la IP del host: arquitectura, despliegue, seguridad |
| [10 — haxlite-rtc](docs/10-haxlite-rtc.md) | WebRTC propio: ICE, DTLS, SCTP, TURN, interoperabilidad y benchmarks |
| [08 — Ocultar y proteger la IP](docs/08-ocultar-ip.md) | por qué se ve la IP, Cloudflare TURN, anti-DDoS, `haxguard` (más en [`docs/ip/`](docs/ip/01-exposicion-ip.md)) |
| [06 — Arquitectura](docs/06-arquitectura-haxlite.md) | módulos, reglas de código y oráculos de prueba |
| [07 — Benchmarks](docs/07-benchmarks.md) · [resultado actual](docs/benchmark-hosts.md) | CPU, memoria, GC y lag frente a haxball.js y node-haxball |

### Cómo funciona HaxBall por dentro

Investigación hecha leyendo [`mertushka/haxball.js`](https://github.com/mertushka/haxball.js) (commit `e5231b0`, envuelve el script oficial `headless-min.js`, hash `f066733d`) y [`wxyz-abcd/node-haxball`](https://github.com/wxyz-abcd/node-haxball) (commit `4d4b88f`, reimplementación completa). Todo sale de leer código; no se capturó tráfico ni se crearon salas. Lo no confirmado está marcado «(no verificado)».

| Documento | Contenido |
|---|---|
| [01 — Red y salas](docs/01-red-y-salas.md) | servidor maestro, lista de salas, señalización WebSocket, WebRTC, auth y versiones |
| [02 — Protocolo binario](docs/02-protocolo-binario.md) | streams, framing, eventos 0–26, snapshot inicial, estadios en binario y `.hbr2` |
| [03 — Física y estadios](docs/03-fisica-y-estadios.md) | bucle de juego, colisiones, jugador y chute, reglas, formato `.hbs` |
| [04 — Netcode](docs/04-netcode-y-sincronizacion.md) | lockstep, asignación de frames, predicción, ping, checksums |
| [05 — Librerías y APIs](docs/05-librerias-y-apis.md) | arquitectura de haxball.js y node-haxball, API HBInit, glosario |

## Desarrollo

```sh
npm install
npm run build          # dist/ con los .d.ts (rolldown)
npm run typecheck      # tsc sobre src y sobre la configuración de build
npm test               # suite completa (vitest)
npm run test:interop   # interoperabilidad WebRTC con Chromium y el cliente oficial
npm run bench:game     # un escenario del arnés de benchmarks (también startup, idle, rooms…)
npm run edge           # haxlite Edge desde el código fuente
```

Notas:

- Algunos tests dependen de Linux (permisos `0600`, `openssl`, NAT simulado, el addon nativo). En Windows fallan por entorno; el CI de Linux (Node 22, 24 y 26) es la referencia.
- Los tests comparan haxlite con los **oráculos** reales: el headless oficial, node-haxball y Chromium (ver [docs/06 §6](docs/06-arquitectura-haxlite.md)).
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

- El host oficial usa un retardo de input de **2** frames (`Sb=2`) y node-haxball usa **4** (`ZW=4`); no se sabe por qué (doc 04).
- En `index.d.ts` de node-haxball, `GameState.timeElapsed` figura en milisegundos, pero el código lo usa en **segundos**. Además, `curveF` no es un ángulo (docs 03 y 05).
- Los ids de eventos 0–23 de node-haxball coinciden 1:1 con el orden de registro del script oficial; los 24–26 son extensiones propias de node-haxball (doc 02).
- No se analizó en profundidad el cliente de navegador oficial (`game-min.js`).
- Los nombres minificados cambian en cada build del script oficial; las referencias de los documentos corresponden al hash `f066733d`.

</details>

## Aviso y licencia

Documentación y código con fines educativos y de interoperabilidad. El script oficial del host es «© Mario Carbajal – All rights reserved». node-haxball incluye funciones que permiten abusar del juego (jugadores falsos, speedhack…); el [doc 05](docs/05-librerias-y-apis.md) comenta los riesgos.

MIT, ver [LICENSE](LICENSE).
