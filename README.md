# rev-eng-haxball

Investigación de cómo funciona HaxBall por dentro, a partir de dos librerías públicas:

- [`mertushka/haxball.js`](https://github.com/mertushka/haxball.js) (commit `e5231b0`): envuelve el **script oficial** del host headless (`headless-min.js`, hash de fuente `f066733d`) para ejecutarlo en Node.
- [`wxyz-abcd/node-haxball`](https://github.com/wxyz-abcd/node-haxball) (commit `4d4b88f`): **reimplementación completa** del cliente y del host, con tipos legibles en `index.d.ts`.

Todo sale de leer el código, que en ambos casos está minificado; no se capturó tráfico ni se crearon salas. La única excepción es la lista pública de salas, que se descargó y se parseó. Lo que no se pudo confirmar está marcado "(no verificado)" en cada documento.

## Documentos

| # | Documento | Contenido |
|---|-----------|-----------|
| 01 | [Red y salas](docs/01-red-y-salas.md) | Servidor maestro, lista de salas, señalización WebSocket, WebRTC, auth y versiones |
| 02 | [Protocolo binario](docs/02-protocolo-binario.md) | Streams, framing, tabla de eventos 0–26, snapshot inicial, estadios en binario y `.hbr2` |
| 03 | [Física y estadios](docs/03-fisica-y-estadios.md) | Bucle de juego, colisiones, jugador y chute, reglas, formato `.hbs` y mapas por defecto |
| 04 | [Netcode](docs/04-netcode-y-sincronizacion.md) | Lockstep, asignación de frames, predicción, ping, checksums y autoridad del host |
| 05 | [Librerías y APIs](docs/05-librerias-y-apis.md) | Arquitectura de haxball.js y node-haxball, API HBInit, ejemplos y glosario |
| 06 | [Arquitectura de haxlite](docs/06-arquitectura-haxlite.md) | Host propio en TypeScript: módulos, reglas de código y oráculos de prueba (`npm test`) |
| 07 | [Benchmarks](docs/07-benchmarks.md) | CPU, memoria, GC y lag: haxlite vs host oficial vs node-haxball. **Resultado actual** en [benchmark-hosts.md](docs/benchmark-hosts.md) (misma sesión, 20 clientes): CPU oficial 16,9 % · node-haxball 18,4 % · haxlite 7,1 %; entrada 2,06 s → 1,06 s con haxlite; qué WebRTC usa cada uno |
| 08 | [Ocultar y proteger la IP](docs/08-ocultar-ip.md) | Por qué se ve la IP, fuga de relay-only en libjuice, Cloudflare TURN, anti-DDoS, firewall `haxguard`, IP por jugador |
| 09 | [haxlite Edge](docs/09-haxlite-edge.md) | Gateway WebRTC que oculta la IP del host: arquitectura, despliegue (TLS, systemd, firewall), seguridad, configuración y overhead medido |
| 10 | [haxlite-rtc](docs/10-haxlite-rtc.md) | WebRTC propio en TypeScript (ICE completo con STUN, DTLS, SCTP): `peerBackend: 'rtc'`, funciona tras NAT, interoperabilidad con Chromium y con el cliente oficial real, benchmarks |

## haxlite: uso

**haxlite** es un host headless de HaxBall escrito desde cero en TypeScript. Corre en Node.js ≥ 22 y en Bun (probado con Bun 1.4; donde Bun tiene un camino más barato se usa: `fetch` para el maestro, E/S UDP nativa con `sendMany`; ver [doc 06 §4.6](docs/06-arquitectura-haxlite.md)). Habla el protocolo 9 bit a bit con los clientes oficiales del navegador y expone la misma API `HBInit` que la página headless oficial (y que `haxball.js`), sin navegador ni script oficial. Depende de `ws` y `json5`; `node-datachannel` (WebRTC nativo) es opcional.

### Instalación

```sh
npm install haxlite          # cuando esté publicado
npm install haxlite --omit=optional   # sin node-datachannel: solo peerBackend 'rtc' / edge con 'rtc'
# o, desde este repositorio:
npm install && npm run build # genera dist/ con los .d.ts
```

`node-datachannel` es una `optionalDependency`: solo hace falta con `peerBackend: 'ndc'` (el valor por defecto), los jugadores `'ndc'` del edge o su túnel WebRTC legado; si falta y se necesita, la negociación falla con «node-datachannel no está instalado: instálalo o usa peerBackend: 'rtc'». Un proyecto TypeScript con `skipLibCheck: false` puede ver TS2307 sin él, porque algunos `.d.ts` importan sus tipos.

### Token

Crear una sala exige un **headless token** de <https://www.haxball.com/headlesstoken>. Caduca a los pocos minutos, así que hay que crear la sala nada más copiarlo. Si es inválido o ha caducado, el servidor maestro pide un reCAPTCHA y `HBInit` se rechaza con `InvalidRoomTokenError` (igual que haxball.js), salvo que se pase `haxlite.onRecaptcha` (ver más abajo).

### Ejemplo mínimo

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

Ejemplos completos: [`examples/basic-room.mjs`](examples/basic-room.mjs) (admin al primer jugador, equipos automáticos, comandos `!bb`, `!afk`, `!swap`, `!rr`) y [`examples/moderation.mjs`](examples/moderation.mjs) (bans persistentes en JSON, re-ban al volver con otra IP, cuarentena de chat para `auth` nuevos, mute, bans por rango CIDR y rechazo de jugadores sin `auth`), y [`examples/among-us-vision.mjs`](examples/among-us-vision.mjs) (niebla por habitación, marcador de tarea, jugadores de otras zonas ocultos y fantasmas invisibles para los vivos, todo solo para cada jugador). Se ejecutan en los tests (`test/api/examples.test.ts`).

### Compatibilidad con el `HBInit` oficial

* Todos los métodos (`sendChat`, `setPlayerAdmin`, `setPlayerTeam`, `kickPlayer`, `clearBan(s)`, `setScoreLimit`, `setTimeLimit`, `setCustomStadium`, `setDefaultStadium`, `setTeamsLock`, `setTeamColors`, `startGame`, `stopGame`, `pauseGame`, `getPlayer`, `getPlayerList`, `getScores`, `getBallPosition`, `startRecording`, `stopRecording`, `setPassword`, `setRequireRecaptcha`, `reorderPlayers`, `sendAnnouncement`, `setKickRateLimit`, `setPlayerAvatar`, `set/getDiscProperties`, `set/getPlayerDiscProperties`, `getDiscCount`, `CollisionFlags`, `InputFlags`) y todos los callbacks `on*` (incluidos `onPlayerActivity` y `onPlayerInput`) con las mismas formas de objeto, el mismo orden de claves, las mismas unidades (`scores.time` y `timeLimit` en segundos) y el mismo uso de `null` (`byPlayer` es `null` en las acciones del host sin jugador).
* Mismo modelo de ejecución: los métodos que cambian el estado se aplican en un *microtask*, en orden de llamada (`setPlayerAdmin(id, true); getPlayer(id).admin` sigue siendo `false` en esa línea). Los errores de validación (`.hbs` inválido, `Stadium doesn't exist`, *casts*) se lanzan de forma síncrona.
* `test/api/parity.test.ts` ejecuta **el mismo script y el mismo escenario** (clientes node-haxball que entran, chatean, cambian equipos, juegan, marcan, son expulsados…) contra el `HBInit` oficial real (el `headless-min.js` que trae haxball.js, conectado a un maestro falso) y contra haxlite, y exige la misma secuencia de callbacks con los mismos argumentos y los mismos resultados de los *getters*.

Diferencias deliberadas:

| | Oficial / haxball.js | haxlite |
|---|---|---|
| `HBInit` | síncrono (haxball.js: `await HaxballJS()` y luego `HBInit()`) | `await HBInit(config)`: consulta la geolocalización y resuelve cuando el maestro asigna el enlace; un `onRoomLink` asignado después lo recibe igual |
| Token caducado | captcha en la página / `InvalidRoomTokenError` sin capturar | promesa rechazada con `InvalidRoomTokenError`, o flujo `haxlite.onRecaptcha` |
| Excepciones en callbacks | rompen el bucle del motor | se notifican a `room.haxlite.onError` (por defecto `console.error`); `onPlayerChat` que lanza sigue expulsando al emisor ("Bad actor"), como el oficial |
| `setScoreLimit/TimeLimit(3.5)` | aplica el valor sin convertir (los clientes leen un `i32`) | convierte a entero |
| `clearBans()` | vacía la lista de bans | vacía los bans de `kickPlayer(…, true)`; los bans de `room.haxlite.bans` (IP, rango, auth) se quitan con `room.haxlite.bans.clear()` |
| Varias salas | una por página (`Can't init twice`) | varias por proceso |
| Cierre | no existe | `room.haxlite.stop()` / `close()` |
| Temporizadores | `setInterval` de 50 ms siempre | un temporizador por proceso en una rejilla de 60 Hz compartida por todas las salas (≈ 17 despertares/s con partidas en curso, sean cuantas sean); sala vacía sin partida = 0 % CPU |

### Extensiones (`room.haxlite` y `config.haxlite`)

Todas son opcionales; sin ellas el comportamiento es el oficial.

```js
const room = await HBInit({
  roomName: 'Sala', token, noPlayer: true,
  haxlite: {
    inputDelayFrames: 2,          // Sb oficial
    heartbeatFrames: 7,           // oficial
    masterUrl: 'https://www.haxball.com/rs/',
    agent: proxyAgent,            // http.Agent (https-proxy-agent, socks-proxy-agent…) para HTTP y WebSocket
    iceServers: ['stun:stun.l.google.com:19302'],
    allowNullAuth: false,         // rechaza a quien falla la verificación de identidad
    joinRateLimit: { capacity: 3, msPerToken: 15_000 },   // intentos por IP
    onJoinRequest: async (req) => (await esIpVetada(req.ip) ? false : true), // antes de WebRTC
    onRecaptcha: (sitekey, useRecaptchaToken) => { /* resolver el captcha y llamar useRecaptchaToken(respuesta) */ },
  },
});
room.haxlite.onBeforeOperation = (event, byPlayerId, frame) => true; // false descarta el evento del cliente
room.haxlite.bans.addRange('203.0.113.0/24');
room.haxlite.getPlayerConnection(id); // { auth, conn, ip, srflxIps, ping }
```

| Extensión | Qué hace |
|---|---|
| `haxlite.inputDelayFrames`, `haxlite.heartbeatFrames`, `haxlite.checksumIntervalFrames` | ajustes de netcode (ver abajo); modificables en caliente |
| `haxlite.onJoinRequest(req)` | gancho previo a WebRTC con `ip`, `conn`, IPs *srflx*, versión y contraseña. Puede ser `async`. `undefined`/`true` acepta, `false` rechaza como baneado (4102), un número o `{reject: código}` cierra con ese código |
| `haxlite.bans` | `addIp`, `addRange` (CIDR IPv4/IPv6), `addAuth`, `list`, `remove`, `clear`, `isIpBanned`, `isAuthBanned`. IP y rangos se comprueban en la señalización (sin coste de WebRTC); `auth` tras el *handshake*, antes de entrar. `config.haxlite.bans` permite compartir una lista entre salas |
| `allowNullAuth`, `joinRateLimit` | sin jugadores anónimos; límite de intentos de entrada por IP |
| `haxlite.onBeforeOperation(ev, byId, frame)` | ve cada evento de cliente (después del filtro de chat) antes de aplicarlo: `false` lo descarta, puede modificarlo, lanzar expulsa al emisor. Se llama también para cada input: debe ser barato |
| `haxlite.onRecaptcha` / `useRecaptchaToken(r)` | el maestro pide captcha (token caducado al reconectar): se recibe la `sitekey` y se reintenta con la respuesta |
| `haxlite.stop()` / `close()` | cierra temporizadores, señalización y conexiones; con la última sala del proceso libera node-datachannel para que Node termine solo (`shutdownWebRtcOnLastStop`) |
| `haxlite.peerBackend: 'rtc'`, `haxlite.rtc: { port, publicAddresses, iceLite, ipv6, sendBatchFrames }` | jugadores sobre haxlite-rtc (TypeScript puro, un puerto UDP, sin hilos nativos, −35 % de CPU con 20 jugadores); ICE completo con STUN, funciona también tras NAT sin configurar (`publicAddresses` opcional). Solo IPv4 salvo `ipv6: true` (una cabecera IPv6 son 20 B más: ≈ +19 % de salida). `sendBatchFrames: 1 \| 2` agrupa las difusiones de eventos de cliente por frame: −23 a −44 % de bytes en el cable por jugador a cambio de n × 8,3 ms de media en las entradas ajenas (por defecto 0). Por defecto `'ndc'` (node-datachannel). `haxlite.rtcPort`, `haxlite.rtcStats()`. Ver [docs/10 §3](docs/10-haxlite-rtc.md) y [§6.7](docs/10-haxlite-rtc.md) |
| `haxlite.edge: { url, key, tunnelAead }` | jugadores en un [haxlite Edge](docs/09-haxlite-edge.md) remoto: la IP del host nunca llega a un jugador. `tunnelAead` (`'auto'`): AEAD del túnel UDP, ChaCha20‑Poly1305 (Node y Bun) si el edge lo concede |
| `room.stopRecordingAsync()` | como `stopRecording()` (mismos bytes, la grabación se detiene en la llamada), pero el deflate corre en el *threadpool* de libuv: una grabación de ~1 h bloquea el bucle ~3 ms en vez de ~280 ms. Extensión: la API oficial solo tiene la versión síncrona |
| `haxlite.setDiscPropertiesFor(viewerId, disco, props, {force})`, `clearDiscOverrides(viewerId)`, `getDiscPropertiesFor`, `hasPrivateView`, `onPrivateViewEnd` | **visuales privados**: cambia un disco solo en el mundo de un jugador (niebla / visión, marcador de tarea) sin desincronizar a nadie. El disco debe ser "solo visual" (de estadio, no el 0, sin *joints*, `cGroup` 0) salvo `force`. El host simula el mundo de ese jugador y le manda su propio hash de *CheckConsistency*. Se descarta al parar/empezar el juego, cambiar de estadio o salir el jugador. Ver [docs/04 §7.4](docs/04-netcode-y-sincronizacion.md) y [`examples/among-us-vision.mjs`](examples/among-us-vision.mjs) |
| `haxlite.hidePlayerFor(viewerId, playerId)`, `showPlayerFor`, `setPlayerHiddenFor(v, p, oculto)`, `isPlayerHiddenFor`, `getHiddenPlayersFor` | **jugadores ocultos**: el jugador desaparece por completo solo para ese espectador (sin disco, nombre, avatar ni flecha de borde en el cliente oficial, con cualquier zoom) y sigue jugando normal para los demás. Sirve para fantasmas o para la visión por zonas. En el mundo del espectador su disco pasa a posición NaN y `cGroup` 0, y el host simula ese mundo (sin desincronizar). Se vuelve a ocultar tras cada reaparición. Lo que el oculto cambia en la sala se copia a ese mundo (f32). Al mostrarlo, la vista converge. Termina con el juego o al salir uno de los dos. **No es seguridad**: un cliente modificado sigue pudiendo saber dónde está. Ver [docs/04 §7.4](docs/04-netcode-y-sincronizacion.md) y [`examples/among-us-vision.mjs`](examples/among-us-vision.mjs) |
| `haxlite.setMaxPlayers(n)`, `haxlite.roomLink`, `haxlite.frame`, `haxlite.onError` | utilidades |
| `haxlite.host`, `haxlite.transport` | el motor (`HostRoom`) y el transporte (`HostTransport`) para usos avanzados |

### Ajustes de netcode

Los clientes oficiales se adaptan a ambos ajustes sin cambios, porque el host les comunica el retardo en cada *pong* y ellos avanzan según los *heartbeats* que reciben.

* **`inputDelayFrames`** (por defecto 2, como el oficial): frames entre "ahora" y el frame en que se aplica el input de un cliente. Con más retardo llegan menos inputs tarde (que el host re-sella y provocan correcciones) en enlaces con *jitter*, a cambio de más latencia de control. Con menos, la respuesta es más inmediata.
* **`heartbeatFrames`** (por defecto 7): cada cuántos frames el host envía el *heartbeat* (mensaje 3; el oficial, por su bucle de 50 ms, da huecos de 7 a 9; haxlite usa una rejilla exacta, y con `'rtc'` adelanta hasta 2 frames el heartbeat para que viaje con un evento: 5 a 9, [docs/04 §4.3](docs/04-netcode-y-sincronizacion.md)). Los clientes solo avanzan su estado confirmado al recibirlo y extrapolan desde él, así que bajar a 2–3 acorta la extrapolación y reduce las correcciones visibles de los demás jugadores. Cuesta unos 9 bytes por cliente y *heartbeat*.
* **`checksumIntervalFrames`** (600): periodo del *CheckConsistency* que detecta desincronización.

### Uso avanzado

`import { HostRoom, HostTransport, readReplay, ReplayPlayer, parseHbs, defaultStadiums } from 'haxlite'` da acceso directo al motor, al transporte, a los replays `.hbr2` y a los estadios. Cada módulo también se exporta como espacio de nombres (`codec`, `sim`, `room`, `net`, `host`, `replay`). La arquitectura está en el [doc 06](docs/06-arquitectura-haxlite.md) y el contrato del motor en [`src/host/README.md`](src/host/README.md).

## HaxBall en una página

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

1. **No hay servidor de juego.** El servidor maestro (`www.haxball.com/rs/api`) solo publica la lista de salas y emite tokens y captchas. La señalización va por `wss://p2p.haxball.com`. La partida corre en el navegador (o en el headless) del **host**, que hace de autoridad y reenvía todo a los clientes por WebRTC: STUN de Google y sin TURN.
2. **Canales WebRTC:** `ro` (fiable y ordenado), `ru` (fiable, sin orden) y `uu` (no fiable). Los mensajes son binarios: big-endian, varints LEB128 y bloques grandes comprimidos con deflate raw. El protocolo es la **versión 9** y una versión distinta se rechaza (código de cierre 4103).
3. **Identidad:** cada jugador tiene un par de claves ECDSA P-256, y `auth` es la coordenada x de la pública en base64url. El host envía un reto de 8 bytes que el cliente firma. `conn` es la IP vista por el maestro codificada en hex: no es un hash.
4. **Netcode de lockstep determinista:** durante la partida solo viajan **eventos** (input de 5 bits, chat, acciones de admin). El host los sella con `(frame, orden)` y aplica un retardo de input de 2 frames. Cada peer simula la misma física a 60 Hz con paso fijo. El estado completo solo se envía una vez, comprimido, al entrar. Cada 600 frames el host manda un checksum (XOR) para detectar desincronización; no hay resincronización automática.
5. **Predicción:** el cliente copia el último estado confirmado y re-simula hasta 120 frames hacia delante. Para eso usa sus propios inputs aún no confirmados y supone que el resto mantiene su último input. No hay rollback del estado autoritativo.
6. **Física:** solo usa doubles y ningún número aleatorio. Cada tick mueve los discos (`pos += v; v = (v + gravedad)·damping`) y después resuelve colisiones disco–disco, plano, segmento (recto o curvo, con `bias`) y vértice, con `j = vn·(bCoefA·bCoefB + 1)`. Las joints se resuelven al final, 2 veces. El chute afecta a los discos a menos de 4 px de borde a borde.
7. **Reglas:** el juego tiene 4 fases (antes del saque, jugando, gol con 150 ticks y fin con 300 ticks). El empate al acabar el tiempo pasa a gol de oro. Un gol cuenta cuando el disco de puntuación cruza el segmento de gol dentro de un tick.
8. **Replays `.hbr2`:** empiezan con la marca `HBR2` y la versión 3. Guardan el estado inicial más los eventos con su frame (comprimidos), así que reproducir equivale a re-simular desde el inicio.

## Discrepancias y pendientes

- El host oficial usa un retardo de input de **2** frames (`Sb=2`) y node-haxball usa **4** (`ZW=4`); no se sabe por qué (doc 04).
- En `index.d.ts` de node-haxball, `GameState.timeElapsed` figura en milisegundos, pero el código lo usa en **segundos**. Además, `curveF` no es un ángulo (docs 03 y 05).
- Los ids de eventos 0–23 de node-haxball coinciden 1:1 con el orden de registro del script oficial. Los ids 24–26 son extensiones propias de node-haxball (doc 02).
- No se analizó en profundidad el cliente de navegador oficial (`game-min.js`); el análisis se centró en el script headless.
- Los nombres minificados cambian en cada build del script oficial. Las referencias de los documentos corresponden al hash `f066733d`.

## Aviso

Esto es documentación con fines educativos y de interoperabilidad. El script oficial es "© Mario Carbajal – All rights reserved". node-haxball incluye funciones que permiten abusar del juego (jugadores falsos, speedhack, etc.). El doc 05 comenta los riesgos.

## Licencia

MIT, ver [LICENSE](LICENSE).
