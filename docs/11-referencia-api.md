# 11 - Referencia de la API de haxlite

Referencia completa de lo que ofrece **haxlite** (paquete `haxlite` 1.0.0, Node.js ≥ 22 o Bun) a quien lo usa como librería: `HBInit(config)`, el objeto `room`, las extensiones `config.haxlite` / `room.haxlite` y los módulos de uso avanzado.

Todo lo que aquí figura sale del código (`src/api/types.ts`, `src/api/hbinit.ts`, `src/host/`, `src/net/`, `src/rtc/`, `src/replay/`, `src/sim/`); cada valor por defecto se comprobó en la línea de código que lo aplica. Lo que no se pudo confirmar va marcado **(no verificado)**. Para el porqué de cada ajuste, véanse los documentos enlazados: [04 netcode](04-netcode-y-sincronizacion.md), [06 arquitectura](06-arquitectura-haxlite.md), [09 Edge](09-haxlite-edge.md), [10 haxlite-rtc](10-haxlite-rtc.md) y [ip/02 TURN](ip/02-turn.md). Los cambios de comportamiento por defecto y la opción exacta para volver al comportamiento anterior están en [13 notas de versión](13-notas-de-version.md). La guía de uso rápido está en la sección «haxlite: uso» del [README](../README.md).

## Índice

1. [`HBInit(config)`: opciones oficiales](#1-hbinitconfig-opciones-oficiales)
2. [`config.haxlite` y `room.haxlite`](#2-confighaxlite-y-roomhaxlite)
   - [2.1 Netcode](#21-netcode)
   - [2.2 Maestro, señalización y arranque](#22-maestro-señalización-y-arranque)
   - [2.3 Admisión y moderación](#23-admisión-y-moderación)
   - [2.4 Conexión de los jugadores: `iceServers`, `peerBackend`, `rtc`, `edge`, `transport`](#24-conexión-de-los-jugadores)
   - [2.5 Tabla completa de `room.haxlite`](#25-tabla-completa-de-roomhaxlite)
   - [2.6 Visuales privados y jugadores ocultos](#26-visuales-privados-y-jugadores-ocultos)
   - [2.7 Ejemplos](#27-ejemplos)
3. [Métodos de `room` y callbacks `on*`](#3-métodos-de-room-y-callbacks-on)
4. [Tipos de datos](#4-tipos-de-datos)
5. [Uso avanzado: lo que exporta `haxlite`](#5-uso-avanzado-lo-que-exporta-haxlite)
6. [Errores y códigos de cierre](#6-errores-y-códigos-de-cierre)

Convenciones: «oficial» es la API del host headless de HaxBall; **[ext.]** marca lo que haxlite añade y el host oficial no tiene. Los tipos están tal cual en `dist/index.d.ts` tras `npm run build`.

---

## 1. `HBInit(config)`: opciones oficiales

```ts
import { HBInit } from 'haxlite';

const room: RoomObject = await HBInit(config?: RoomConfigObject);
```

A diferencia del `HBInit` oficial (síncrono), el de haxlite **devuelve una `Promise<RoomObject>`** **[ext.]**: consulta la geolocalización (`api/geo`) como hace el script oficial al cargar y, por defecto, se resuelve cuando el servidor maestro ha asignado el enlace de la sala. Un `room.onRoomLink` asignado después de resolver recibe igualmente el enlace (en un *microtask*). Como `HBInit` es `async`, los errores de validación de `config` **rechazan la promesa** (no se lanzan de forma síncrona).

Todas las opciones son opcionales (`config` puede omitirse).

| Opción | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `roomName` | `string` | `'Headless Room'` | Nombre de la sala (lista pública y estado de la sala) | Un valor que no sea `string` lanza `TypeError: Cannot cast … to String`. En la lista pública se trunca a 40 unidades UTF-16 |
| `playerName` | `string` | `'Host'` | Nombre del jugador anfitrión (id 0, admin) | Se ignora con `noPlayer: true`. Mismo *cast* que `roomName` |
| `password` | `string \| null` | `null` (sin contraseña) | Contraseña de la sala | Cambiable luego con `room.setPassword()`. Con contraseña, el enlace lleva `&p=1` |
| `maxPlayers` | `number` (entero) | `12` | Capacidad de la sala | Debe ser entero (si no, `TypeError: Cannot cast … to Int`). Se **recorta a 2..30**. Cambiable en caliente con `room.haxlite.setMaxPlayers()` **[ext.]** |
| `public` | `boolean` | `false` | Publica la sala en la lista pública del maestro | No se puede cambiar en caliente por la API de `room` (ver `room.haxlite.transport.setPublic`, [§5](#5-uso-avanzado-lo-que-exporta-haxlite)) |
| `geo` | `{ code: string; lat: number; lon: number } \| null` | el de `api/geo` del maestro; si falla, `{ code: '', lat: 0, lon: 0 }` | Geolocalización publicada (bandera y coordenadas) | `code` se pasa a minúsculas; más de 3 caracteres lanza `Error('Invalid country code')`. Con `geo` dado no se consulta `api/geo`. La bandera también es la del jugador anfitrión |
| `token` | `string \| null` | `null` | *Headless token* de <https://www.haxball.com/headlesstoken> | Caduca a los pocos minutos. Sin token válido el maestro pide un captcha: ver `haxlite.onRecaptcha` y `InvalidRoomTokenError` ([§6](#6-errores-y-códigos-de-cierre)) |
| `noPlayer` | `boolean` | `false` | La sala no crea un jugador anfitrión | Con `true`, las acciones del host llegan a los callbacks con `byPlayer === null`. Recomendado en salas automatizadas |
| `haxlite` | `HaxliteConfig` | `{}` | Opciones propias de haxlite **[ext.]** | Ver [§2](#2-confighaxlite-y-roomhaxlite). Sin ellas el comportamiento es el oficial |

### Qué hace `HBInit`, en orden

1. *Casts* y comprobaciones de `config` y de los ajustes de netcode (errores → promesa rechazada).
2. Si no hay `geo`, pide `api/geo` al maestro (con `masterUrl` y `agent`).
3. Crea el `HostTransport` y el `HostRoom` ([§5](#5-uso-avanzado-lo-que-exporta-haxlite)) y los arranca. La sala se anuncia al maestro y recibe el enlace.
4. Se resuelve con `room` cuando llega el enlace (y, con `peerBackend: 'rtc'`, cuando el socket UDP ya escucha). Con `waitForLink: false` se resuelve nada más arrancar. Si no llega el enlace en `initTimeoutMs`, se rechaza.
5. Cualquier error de red del maestro o de bind UDP **durante** el arranque rechaza la promesa y detiene la sala; los de después van a `room.haxlite.onError`.

### Modelo de ejecución (igual que el oficial)

* Los métodos que **cambian el estado** construyen sus argumentos de forma síncrona y se aplican en un *microtask*, en orden de llamada: `room.setPlayerAdmin(id, true); room.getPlayer(id).admin` sigue devolviendo `false` en esa línea.
* Los errores de validación (`.hbs` inválido, `Stadium doesn't exist`, *casts*) se lanzan de forma **síncrona** desde el método.
* `clearBan`, `clearBans`, `setPassword`, `setRequireRecaptcha`, `startRecording`, `stopRecording` y todas las consultas (`get*`) son síncronos.
* Los callbacks reciben objetos planos nuevos con el orden de claves oficial. Una excepción dentro de un callback no rompe el motor: va a `room.haxlite.onError` (por defecto `console.error('[haxlite]', err)`) y el frame o el evento que se estaba aplicando se completa igual que en los clientes (`onGameTick`, `onPlayerBallKick`, `onTeamGoal`, `onPlayerTeamChange`…). Excepción: si `onPlayerChat` lanza, se expulsa al emisor («Bad actor»), como el oficial.
* Los callbacks pueden devolver una promesa. Si se rechaza, el error va a `room.haxlite.onError` (o a `console.error('[haxlite]', err)` si no hay manejador) en lugar de quedar como rechazo sin manejar; vale para `onPlayerJoin`, `onGameTick`, `onStadiumChange`, `onRoomLink`, `onRecaptcha`, `onBeforeOperation`, `onPrivateViewEnd`, `onBackendState` y el resto de `on*`. Un `onError` que devuelve una promesa rechazada va a `console.error` y no se reenvía a sí mismo.
* Las rachas de errores idénticos (mismo nombre y mensaje) se coalescen: pasadas `errorRepeatBurst` entregas seguidas, llega un `RepeatedError` por cada `errorRepeatWindowMs` ([§2.1](#21-netcode)).

---

## 2. `config.haxlite` y `room.haxlite`

`config.haxlite` (tipo `HaxliteConfig`) son las opciones de arranque; `room.haxlite` (tipo `HaxliteRoomExtensions`) son los métodos y propiedades en vivo. Algunas existen en ambos sitios (los de netcode, `onJoinRequest`, `bans`…). Todo es opcional y **sin ello el comportamiento es el del host oficial**.

### 2.1 Netcode

Los clientes oficiales se adaptan a estos ajustes sin cambios: el host les comunica el retardo en cada *pong* y ellos avanzan según los *heartbeats* que reciben (explicación en [docs/04 §4.3 y §6](04-netcode-y-sincronizacion.md)).

| Nombre (`config.haxlite.` y `room.haxlite.`) | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `inputDelayFrames` | entero 1–60 | `2` (oficial) | Frames entre «ahora» y el frame en que se aplica el input de un cliente (`Sb`) | Más = menos inputs tardíos en enlaces con *jitter*, más latencia de control. **Modificable en caliente** (`room.haxlite.inputDelayFrames = 3`): afecta a eventos y *pongs* nuevos. Fuera de rango: `RangeError` |
| `heartbeatFrames` | entero 1–600 | `7` (oficial) | Frames entre *heartbeats* (mensaje 3) | Menos (2–3) acorta la extrapolación de los clientes y reduce correcciones visibles; cuesta ~9 bytes por cliente y *heartbeat*. Modificable en caliente. Con el backend `'rtc'` el *heartbeat* se adelanta hasta `floor((heartbeatFrames-1)/3)` frames para viajar con un evento |
| `checksumIntervalFrames` | entero 1–1 048 576 | `600` (10 s, oficial) | Periodo del *CheckConsistency* (detección de desincronización) | Modificable en caliente |
| `maxWakeFrames` | entero 1–600 o `Infinity` | `4` (66,7 ms; oficial ≈ 3) | Con una partida en curso, simula al menos cada N frames aunque no lleguen mensajes | Acota la latencia de los callbacks por frame (`onGameTick`, `onTeamGoal`…) y lo desfasado que puede estar un *getter*. `Infinity` = solo en *heartbeats* y mensajes (~8,6 despertares/s). Modificable en caliente. **[ext.]** |
| `pingIntervalMs` | `number` (ms) | `3000` | Periodo del evento *Ping* | Solo en `config.haxlite` (no hay propiedad en vivo). Solo se emite mientras hay clientes. Debe ser un número ≥ 1, o `Infinity` para no emitir *Ping*; si no, `RangeError: haxlite.pingIntervalMs must be a number >= 1` y `HBInit` se rechaza |
| `errorRepeatBurst` | `number` | `60` | Errores idénticos (mismo nombre y mensaje) que se entregan a `room.haxlite.onError` (o a `console.error`) antes de coalescer el resto de la racha | Solo en `config.haxlite`. Número ≥ 1; `Infinity` = entregar todos. Si no, `RangeError: haxlite.errorRepeatBurst must be a number >= 1`. Pasado el límite, un `RepeatedError` por ventana (`count` = errores no entregados, `cause` = el último; mensaje `<nombre>: <mensaje> (repeated N more times in W ms)`). Los errores distintos no se coalescen. La clase `RepeatedError` no se exporta del paquete: se reconoce por `err.name === 'RepeatedError'` |
| `errorRepeatWindowMs` | `number` (ms) | `1000` | Ventana del resumen de `errorRepeatBurst`; la racha termina tras una ventana sin ese error | Solo en `config.haxlite`. Finito y > 0, si no `RangeError: haxlite.errorRepeatWindowMs must be a finite number > 0` |

`room.haxlite.frame` (solo lectura) es el número de frame actual del reloj del host (a fecha de la última simulación).

### 2.2 Maestro, señalización y arranque

| Nombre (`config.haxlite.`) | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `masterUrl` | `string` (termina en `/`) | `'https://www.haxball.com/rs/'` | URL base del servidor maestro (`api/host`, `api/geo`, `api/list`) | Para pruebas, *proxies* o maestros propios |
| `agent` | `http.Agent` | ninguno | Agente HTTP(S)/SOCKS (`https-proxy-agent`, `socks-proxy-agent`…) | Se usa para la API HTTP del maestro **y** para el WebSocket de señalización. No afecta al tráfico WebRTC. En Bun, con `agent` o variables `HTTP(S)_PROXY` se usa `node:http` en vez de `fetch` |
| `wsUrl` | `string` | el que devuelve el maestro | Sustituye la URL del WebSocket de señalización | Para *proxies* o backends propios. Sin `wsUrl`, la URL que devuelve `api/host` debe ser `ws://` o `wss://`; si no, se notifica `MasterError('invalid-response')` «api/host: url is not a ws(s) url» por `onError` y se reintenta |
| `waitForLink` | `boolean` | `true` | `HBInit` se resuelve solo cuando existe el enlace de la sala | `false`: se resuelve nada más arrancar; el enlace llega después por `room.onRoomLink` |
| `initTimeoutMs` | `number` (ms) | `30000` | Si no hay enlace tras este tiempo, `HBInit` se rechaza (y la sala se detiene) | Solo con `waitForLink: true`. Un túnel de edge con errores no fatales se reintenta hasta este plazo |
| `onRecaptcha` | `(sitekey: string, useRecaptchaToken: (respuesta: string) => void) => void` | ninguno | El maestro pide un captcha durante el arranque (token inválido o caducado) | Resuelve el captcha y llama a `useRecaptchaToken(respuesta)`. **Sin este manejador `HBInit` se rechaza con `InvalidRoomTokenError`** (comportamiento de haxball.js). Pasado el arranque se usa `room.haxlite.onRecaptcha` |
| `shutdownWebRtcOnLastStop` | `boolean` | `true` | Al parar la última sala del proceso, libera node-datachannel (`shutdownWebRtc()`) para que Node pueda terminar solo | Pon `false` si arrancas salas nuevas con frecuencia. Solo cuenta salas creadas con `HBInit` |

El maestro se trata como entrada no fiable. Estos topes son constantes de `src/net/master-http.ts` y `src/net/signaling.ts`; no se pueden configurar:

* Cuerpo de la respuesta: 65 536 B en `api/host` y `api/geo`, 8 388 608 B en `api/list` (también si el `Content-Length` declarado lo supera). Superado: `MasterError('invalid-response')` «<ruta>: response too large».
* `transport.timeoutMs` (por defecto 15 000 ms) limita la inactividad **y** el tiempo total de la petición: ×1 en `api/host` y `api/geo`, ×2 en `api/list`. En la ruta `node:http`, `timeoutMs: 0` desactiva el plazo. Una respuesta que no es 2xx se rechaza en cuanto llegan las cabeceras.
* Ruta `fetch` (Bun): se pide `Accept-Encoding: identity` y se desactiva la descompresión; otro `content-encoding` da `MasterError('invalid-response')` «<ruta>: unsupported content-encoding». La ruta `node:http` no comprueba esa cabecera.
* Un mensaje del WebSocket de señalización de más de 262 144 B cierra el enlace (se reconecta). El token renovado (mensaje 6) de más de 4096 B se ignora y se notifica por `onError` («master signaling: token too long»).
* `fetchGeo`, `fetchRoomList` y la petición de sesión aceptan `signal` (`AbortSignal`): al abortarse rechazan con `MasterError('network', 'aborted')`. `room.haxlite.stop()` aborta además un `api/host` en vuelo.

### 2.3 Admisión y moderación

La admisión ocurre **durante la señalización, antes de crear ningún objeto WebRTC**. Orden de las comprobaciones (`src/net/transport.ts`). Primero las que solo necesitan la IP del maestro (`preflight`, antes de inflar la oferta; si fallan, la oferta se descarta con el código indicado): oferta con el `peerId` de una negociación viva (se ignora sin respuesta) → backend listo (4104) → negociaciones pendientes < `maxPendingNegotiations` (4104) → IP de `conn` baneada (4102) → dirección bloqueada por `abusePenalty` (4104) → `maxUnjoinedPerIp` (4104) → `joinRateLimit` → sala llena (4100). Después de inflar la oferta: IP *srflx* baneada (4102; solo se examinan los 32 primeros candidatos) → candidato `host`/`prflx` público baneado (4102, con `verifiedIpBans`) → versión del protocolo (4103) → contraseña (4101) → `maxUnjoinedPerIp` otra vez, ya contando las negociaciones directas abandonadas (4104) → `onJoinRequest`. Después de abrir el canal, el *handshake* ECDSA da `auth` y aplica `allowNullAuth`, los bans por `auth` y, con `verifiedIpBans`, el ban de la dirección remota del par ICE elegido.

| Nombre (`config.haxlite.`) | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `allowNullAuth` | `boolean` | `true` (oficial) | Deja entrar a quien falla la prueba de identidad (con `auth = null`) | `false`: se le expulsa («Identity verification failed») antes de entrar |
| `joinRateLimit` | `{ capacity: number; msPerToken: number; code?: number } \| null` | `null` (desactivado) | Límite de intentos de entrada **por IP** (*token bucket*: `capacity` intentos, se recupera uno cada `msPerToken` ms) | Al excederlo se rechaza con `code` (por defecto **4104**). `capacity` ≥ 1 y `msPerToken` finito > 0; si no, `RangeError` al crear la sala («token bucket capacity must be a number >= 1, got X» / «token bucket msPerToken must be a finite number > 0, got X»). `code`, entero 0..65535. No existe en el host oficial **[ext.]** |
| `bans` | `BanList` | una nueva por sala | Lista de bans compartida (p. ej. una para varias salas) | `new BanList()` se exporta de `haxlite`. Ver `room.haxlite.bans` en la [§2.5](#25-tabla-completa-de-roomhaxlite) |
| `onJoinRequest` | `(req: JoinRequest) => JoinDecision \| PromiseLike<JoinDecision>` \| `null` | ninguno | Gancho previo a WebRTC: acepta o rechaza la entrada | También es propiedad en vivo (`room.haxlite.onJoinRequest = …`). Puede ser `async` (se espera cualquier objeto con `then`). Si lanza, rechaza la promesa o devuelve una decisión mal formada, se informa por `onError` y se rechaza la entrada con 4104. Si no se resuelve nunca, la negociación se descarta al cumplirse `channelOpenTimeoutMs` |

`JoinRequest` (lo que recibe `onJoinRequest`):

| Campo | Tipo | Qué es |
|---|---|---|
| `peerId` | `number` | id de negociación asignado por el maestro |
| `conn` | `string` | `player.conn` (IP vista por el maestro, en hexadecimal mayúsculas) |
| `ip` | `string` | IP del cliente vista por el maestro |
| `srflxIps` | `readonly string[]` | IPs *server-reflexive* de sus candidatos ICE (máx. 32 candidatos considerados). Las declara el cliente: no están verificadas |
| `candidateAddresses` | `readonly string[]` | todas las direcciones de candidatos de la oferta (pueden ser nombres mDNS) |
| `reverse` | `boolean` | la oferta viene marcada como «conexión inversa» (reintento del cliente) |
| `version` | `number` | versión del protocolo del cliente (la sala exige 9) |
| `password` | `string \| null` | contraseña que envía el cliente |

`JoinDecision` (lo que devuelve, `src/net/transport.ts`): `undefined`, `null`, `true` o `{ accept: true }` aceptan; `false` rechaza como baneado (**4102**); un entero `n` en 0..65535 o `{ reject: n }` cierra con ese código. Un número que no es un código de cierre, o un `reject` cuyo valor no lo es, rechaza con **4104** y se informa por `onError` (`TypeError` «onJoinRequest returned an invalid decision (…)»), igual que si el gancho lanza. Cualquier otro valor (una cadena, un array, un objeto sin `reject`) **acepta** y se informa una sola vez por transporte («onJoinRequest returned a value that is not a JoinDecision (…): the join is accepted»). **`{ accept: false }` no rechaza**: es un objeto sin `reject`, así que acepta; para rechazar usa `false`, un código o `{ reject: n }`. Códigos habituales en [§6](#6-errores-y-códigos-de-cierre).

**Protecciones por dirección [ext.]** (activas por defecto; opciones de [`transport`](#transport-válvula-de-escape)). Se aplican a direcciones públicas (IPv6 agrupado por /64); loopback y redes privadas están exentas:

* `maxUnjoinedPerIp` (12): conexiones de la misma dirección que aún no han entrado. Cabe un grupo de unos 10 jugadores tras una NAT entrando a la vez porque el reintento *reverse* de un cliente sustituye a su intento directo abandonado a los 4 s.
* `abusePenalty` (20 fichas, una cada 3 s; 30 s de una conexión cada 3 s): solo cuenta el abuso que comete la propia conexión. La expulsión «Bad actor» que decide la sala (un script que lanza, el límite de chat) y los *timeouts* de jugadores ya unidos no cuentan, así que no la acota: para limitar ese *churn* usa `joinRateLimit`.
* `verifiedIpBans` (`true`): el ban de IP guarda direcciones verificadas ([§2.5](#25-tabla-completa-de-roomhaxlite)).

Jugadores tras una misma NAT o CGNAT comparten dirección y, por tanto, estos límites. Para desactivarlos: `maxUnjoinedPerIp: Infinity`, `abusePenalty: null`, `verifiedIpBans: false` (tabla de [13 notas de versión](13-notas-de-version.md)).

**Sala llena y asientos rancios.** El *preflight* acepta la oferta de una sala llena si hay una conexión con el desafío enviado y sin responder desde hace `NetDefaults.staleChallengeMs` (5000 ms) o más (si el desafío aún no salió, desde que abrió el canal 0). Esa conexión cede su plaza (cierre `'timeout'`) cuando la nueva abre su canal 0; si para entonces ya no hay ninguna rancia, la nueva se cierra con `'full'`. `staleChallengeMs` y `NetDefaults.directAttemptMs` (4000) son constantes de `net.NetDefaults`, no opciones.

### 2.4 Conexión de los jugadores

haxlite puede terminar las conexiones WebRTC de los jugadores de tres maneras. Prioridad: `transport.backend` (propio) > `edge` > `peerBackend`.

| Opción | Pila | Notas |
|---|---|---|
| `peerBackend: 'ndc'` (por defecto) | node-datachannel / libdatachannel (nativo, opcional) | ICE completo con STUN, funciona tras NAT. Soporta TURN UDP/TCP/TLS |
| `peerBackend: 'rtc'` | **haxlite-rtc**: TypeScript puro (ICE, DTLS 1.2, SCTP), un solo puerto UDP para todos los jugadores, sin hilos nativos | ≈ la mitad de CPU por jugador. Por defecto ICE completo con STUN (funciona tras NAT); TURN UDP. [docs/10](10-haxlite-rtc.md) |
| `edge: { url, key }` | un [haxlite Edge](09-haxlite-edge.md) remoto termina el WebRTC | La IP del host nunca llega a un jugador |

#### `iceServers`

| Nombre | Tipo | Por defecto | Notas |
|---|---|---|---|
| `iceServers` (`config.haxlite.`) | `readonly IceServerConfig[]` | `['stun:stun.l.google.com:19302']` (como el host oficial) | Cada entrada puede ser: una cadena (`'stun:host:3478'`, `'turn:usuario:clave@host:3478'`, `'turn:u:c@host:3478?transport=tcp'`, `'turns:…'`), un objeto de node-datachannel (`{ hostname, port, username, password, relayType }`) o un `RTCIceServer` del navegador (`{ urls, username, credential }`). Con `ndc` valen todas; con `rtc` solo **UDP** `turn:` (se omiten `turns:` y `?transport=tcp`). Con `edge` se ignora (el edge tiene los suyos) |
| `room.haxlite.setIceServers(lista)` **[ext.]** | método | - | Sustituye los servidores en caliente (p. ej. credenciales TURN de corta vida de Cloudflare). `rtc`: el siguiente `Allocate` usa las nuevas; `ndc`: las PeerConnections nuevas. Ignorado por un backend edge. Ver [docs/10 §2.2](10-haxlite-rtc.md) |

Con `peerBackend: 'rtc'`, `iceServers` es solo el **valor por defecto** de `rtc.iceServers`. **Ojo:** si das `rtc.publicAddresses` y no das `rtc.iceServers`, la lista efectiva es `[]` aunque pongas `haxlite.iceServers` (código en `RtcPeerBackend`); pon el TURN dentro de `rtc.iceServers` en ese caso.

Relay-only (la IP del host no aparece): `rtc: { iceTransportPolicy: 'relay' }` con `peerBackend: 'rtc'` (relay real) o, con `ndc`, `transport: { rtc: { iceTransportPolicy: 'relay' } }` (en ese stack **no es relay-only de verdad**, véase [ip/02 §0](ip/02-turn.md)).

#### `peerBackend`

`'ndc' | 'rtc'`, por defecto `'ndc'`. Cualquier otro valor lanza `TypeError: peerBackend must be 'ndc' or 'rtc'` (rechaza `HBInit`). `rtc` solo se usa con `peerBackend: 'rtc'` y se ignora con `'ndc'` o con `edge`.

#### `rtc` (tipo `RtcBackendOptions`)

Ajustes de haxlite-rtc. Las salas del mismo proceso con la misma configuración **comparten un único endpoint** (un socket UDP por familia). `room.haxlite.rtcPort` da el puerto UDP real y `room.haxlite.rtcStats()` los contadores del endpoint compartido.

| Opción | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `port` | `number` | `0` (efímero) | Puerto UDP único para todos los jugadores | En producción fija uno y ábrelo en el firewall |
| `address` | `string` | comodín de cada familia (sin `publicAddresses`: `0.0.0.0`) | Dirección de *bind* | `'::'` es el comodín IPv4 salvo con `ipv6`; otra IPv6 literal exige `ipv6: true` |
| `ipv6` | `boolean` | `false` | Usa IPv6: socket `udp6`, candidatos IPv6, consultas AAAA | Una cabecera IPv6 son 20 B más (≈ +19 % de salida) y los navegadores prefieren pares IPv6. Una lista de `publicAddresses` solo-IPv6 sin `ipv6` es un error |
| `publicAddresses` | `readonly string[]` (IPs literales) | ninguno | Candidatos `host` anunciados tal cual, en lugar de las IPs de las interfaces | ICE completo: opcional (NAT 1:1 cuya IP STUN no ve, o para no depender de STUN). Con `iceLite` son las únicas direcciones del SDP: por defecto, las IPs públicas de las interfaces; sin ninguna, `HBInit` se rechaza. Vacío o no-IP: error |
| `iceLite` | `boolean` | `false` | Modo ICE-lite original (`a=ice-lite`, sin recolección ni checks propios) | El servidor ha de ser alcanzable directamente. Fuerza `iceServers = []` y activa `helloVerify` por defecto |
| `iceServers` | `readonly IceServerConfig[]` | `[]` con `iceLite` o con `publicAddresses`; si no, `haxlite.iceServers` (por defecto Google STUN) | STUN (candidatos *srflx*) y TURN UDP (candidato `relay`) | TURN: una asignación por endpoint con *pool* automático ([docs/10 §2.2](10-haxlite-rtc.md)). Cada sesión crea pares relay para como mucho 4 direcciones remotas señaladas, vivas y distintas (`MAX_RELAY_PEERS`) y 8 en toda su vida (`MAX_RELAY_PEERS_TOTAL`); los pares *peer-reflexive* que aprende el relay no cuentan. Los parámetros `turnPeersPerAllocation` (8) y `maxTurnAllocations` (64) del endpoint **no se pueden fijar desde `HBInit`** |
| `iceTransportPolicy` | `'all' \| 'relay'` | `'all'` (o `'relay'` si `transport.rtc.iceTransportPolicy` lo es) | `'relay'`: solo se anuncia el candidato relay y todo pasa por el TURN | Necesita un `turn:` UDP en `iceServers` y no es compatible con `iceLite`; si no, el *bind* falla y `HBInit` se rechaza. Sin asignación posible la sesión se cierra con `'turn-unavailable'` |
| `iceCandidatePolicy` | `'public' \| 'private' \| 'all' \| (c: {address, type}) => boolean` | `transport.iceCandidatePolicy`, si no `'public'` | Qué direcciones de interfaz se anuncian y a qué clases de dirección remota se mandan checks | No se aplica a `publicAddresses`. Las direcciones IPv6 NAT64 (`64:ff9b::/96`) y 6to4 (`2002::/16`) se clasifican por la IPv4 que llevan incrustada si esta no es pública, y las IPv4-compatibles (`::a.b.c.d`) son `reserved`: con `'public'` no reciben checks |
| `gatherRefreshMs` | `number` | `60000` | Antigüedad a partir de la cual una sesión nueva refresca el STUN en segundo plano | |
| `publicPort` | `number` | el puerto real | Puerto anunciado si un NAT 1:1 lo traduce | |
| `certificate` | `RtcCertificate` | uno por proceso (`RtcCertificate.processDefault()`) | Certificado DTLS | El tipo `RtcCertificate` no se exporta desde el paquete (no hay forma de construirlo; usa `certificateFile`) |
| `certificateFile` | `string` | ninguno | PEM (certificado + clave, modo 0600) donde guardar/cargar la identidad DTLS | Huella estable entre reinicios; E/S síncrona |
| `shared` | `boolean` | `true` | Comparte endpoint/socket con las demás salas del proceso de igual configuración | `false`: endpoint y socket propios |
| `cipherSuites` | `readonly (number \| string)[]` | `['chacha20', 'aes128gcm', 'aes256gcm']` (Node y Bun) | Preferencia DTLS del servidor (nombres IANA, ids o los nombres cortos) | En Bun ChaCha gana de extremo a extremo ([docs/10 §6.7](10-haxlite-rtc.md)) |
| `helloVerify` | `boolean` | `false` con ICE completo, `true` con `iceLite` | Cookie DTLS (HelloVerifyRequest) antes del primer vuelo del servidor | Un RTT más por entrada |
| `idleTimeoutMs` | `number` | `30000` | Sin consentimiento ICE durante este tiempo, se cierra la sesión | Antes actúan los 10 s de inactividad de `HostTransport` |
| `handshakeTimeoutMs` | `number` | `20000` | Sesión no abierta tras este tiempo → se cierra | Antes actúa el plazo de apertura de `HostTransport` (10 s) |
| `maxSessions` | `number` | `10000` | Tope de sesiones del endpoint | |
| `sendBatchFrames` | `0 \| 1 \| 2` | `0` | Retiene los mensajes de `ru` por jugador hasta la siguiente frontera de 1 o 2 frames de la rejilla de 60 Hz | Menos datagramas a cambio de n × 8,3 ms de media en las entradas ajenas. Otro valor lanza error |
| `endpoint` | `RtcEndpoint` | ninguno | Usa un endpoint ya abierto (varias salas en un puerto) | El backend no lo cierra y el resto de opciones se ignoran. El tipo `RtcEndpoint` no se exporta; solo se obtiene de otro backend (`room.haxlite.transport.backend.endpoint`) **(no verificado en uso)** |

Las opciones numéricas del endpoint se validan al abrirlo y un valor inutilizable lanza `RangeError` (`RtcEndpoint: <opción> must be …`), con lo que `HBInit` se rechaza: `port` entero 0..65535; `publicPort` entero 1..65535; `maxSessions` y `maxTurnAllocations` enteros ≥ 1; `turnPeersPerAllocation` entero ≥ 1 o `Infinity`; `idleTimeoutMs` y `handshakeTimeoutMs` finitos > 0; `gatherRefreshMs` ≥ 0 o `Infinity` (`src/rtc/endpoint.ts`).

El tráfico de `rtc` sigue pasando por la misma admisión de `HostTransport` (§2.3). Para el funcionamiento interno (ICE, TURN, DTLS, SCTP) véase [docs/10](10-haxlite-rtc.md) y [`src/rtc/README.md`](../src/rtc/README.md).

#### `edge` (tipo `EdgeOptions`)

Los jugadores se conectan al edge, nunca a esta máquina. Se ignoran `iceServers`, `transport.iceCandidatePolicy`, `transport.portRange` y `transport.rtc`. Detalle y seguridad en [docs/09 §2](09-haxlite-edge.md).

| Opción | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `url` | `string` | - (obligatorio) | Endpoint de control, p. ej. `wss://edge.ejemplo.com:8443/tunnel`. `ws://` no cifra: se acepta sin más hacia loopback y redes privadas (con un aviso en el log) y hacia un host público solo con `allowInsecure: true` (ver la política debajo de la tabla) |
| `key` | `string` | - (obligatorio) | Clave del operador del edge: `"<keyId>:<secreto>"` |
| `dataPlane` | `'udp' \| 'webrtc' \| 'ws'` | `'udp'` | `'udp'` = túnel v2 (SCTP sobre UDP cifrado, TypeScript puro); `'webrtc'` = PeerConnection legada (carga el addon); `'ws'` = directamente por WebSocket |
| `fallbackWs` | `boolean` | `true`; `false` con un `ws://` público aceptado por `allowInsecure` | Si el plano UDP no sube en `dataPlaneTimeoutMs` (o el edge no lo concede), todo el tráfico va por el WebSocket (HOL blocking, algo más de latencia). Con un `ws://` público iría en claro y lo podría forzar quien esté en el camino, por eso ahí se apaga; `fallbackWs: true` lo activa |
| `allowInsecure` | `boolean` | `false` | Acepta una URL `ws://` cuyo host no es loopback ni de red privada (sin TLS: el canal de control es legible en el camino; la clave sigue autenticando al edge) |
| `roLanes` | `boolean` | `true` | Pide carriles `ro` independientes para que una pérdida en host↔edge no frene a todos |
| `tunnelAead` | `'auto' \| 'aes-128-gcm' \| 'chacha20-poly1305'` | `'auto'` | Solo `dataPlane: 'udp'`: AEAD del túnel. `'auto'` pide ChaCha20-Poly1305 (Node y Bun); el edge decide |
| `bindAddress` | `string` | ninguna | Dirección local para el WS y el socket UDP del túnel |
| `iceServers` / `portRange` | `IceServerConfig[]` / `[number, number]` | ninguno | Solo `dataPlane: 'webrtc'` |
| `connectTimeoutMs` | `number` | `10000` | Plazo de conexión WS + autenticación |
| `dataPlaneTimeoutMs` | `number` | `5000` | Plazo del plano de datos (luego `fallbackWs`) |
| `reconnectMinMs` / `reconnectMaxMs` | `number` | `250` / `10000` | *Backoff* exponencial de reconexión. Tras una sesión estable (`reconnectStableMs`) se reconecta sin espera y el *backoff* vuelve a `reconnectMinMs`; tras una más corta el retardo es el *backoff* × (0,8 a 1,2) y sigue creciendo |
| `reconnectStableMs` | `number` | `10000` | Tiempo mínimo en `ready` para que una caída cuente como la de un túnel sano. Evita un bucle de reconexión con un edge que acepta la sesión y la cae enseguida |
| `pingIntervalMs` / `pingTimeoutMs` | `number` | `5000` / `15000` | Ping de aplicación y plazo de túnel muerto. Con el túnel v2 el host exige además un *Pong* a sus propios *Ping* dentro de `max(pingTimeoutMs, 2 × pingIntervalMs)` (15 000 ms por defecto); si no llega, el túnel falla con `EdgeError` «tunnel timed out (the edge does not answer pings)» aunque el edge siga mandando sus mensajes |
| `wsOptions` | opciones del cliente `ws` | ninguno | p. ej. `ca`, `rejectUnauthorized`, `agent` |
| `log` | `(msg: string) => void` | ninguno | Registro de depuración; recibe también los avisos de arranque de abajo |

**Política de `ws://`** (`src/net/edge-client.ts`). `wss://` no tiene restricciones. Con `ws://`: loopback (`localhost`, 127.0.0.0/8, `::1`, IPv4 mapeadas 127.x) se acepta sin aviso; una red privada (RFC 1918, 100.64.0.0/10, 169.254.0.0/16, `fc00::/7`, `fe80::/10`, IPv4 mapeadas privadas, nombres de una sola etiqueta y los acabados en `.local`, `.internal`, `.lan` o `.home.arpa`) se acepta con el aviso «WARNING: ws:// edge url without TLS (private network)…»; cualquier otro host lanza `Error` («ws:// edge url points to a public host (<host>) without TLS: use wss://, or set allowInsecure: true …») al crear el backend, y `HBInit` se rechaza. Otros avisos del log: «WARNING: short edge key secret…» (secreto de menos de 22 caracteres con `ws://`) y «WARNING: TLS certificate verification is off…» (`wsOptions.rejectUnauthorized: false`). Un esquema que no sea `ws://` ni `wss://` lanza `Error('edge url must start with ws:// or wss://')`.

**Plano WebSocket.** Los mensajes no fiables (canal `uu`) se descartan si hay más de 262 144 B en la cola del socket; con más de 8 388 608 B en cola el túnel falla con `EdgeError` (`kind: 'tunnel'`) «tunnel send buffer overflow (the edge does not read)» y se reconecta. En el túnel WebRTC legado (`dataPlane: 'webrtc'`), `send` devuelve `false` si el canal del túnel acumula más de 8 388 608 B. Ninguno de estos topes es configurable.

**Entrada del edge.** `getPlayerConnection(id).remoteAddress` es `null` si el edge no envía una IP válida. Los textos de error y los motivos de cierre que manda el edge se reducen a ASCII imprimible de hasta 200 caracteres (el resto pasa a `?`) antes de registrarlos. Por conexión de jugador se retransmiten como mucho `EdgeLimits.maxLocalCandidates` (32) candidatos locales y se aceptan `EdgeLimits.maxRemoteCandidates` (32) remotos (también en el túnel legado); un `PeerAnswer` o `PeerGathered` repetido se ignora.

Con edge: `room.haxlite.edgeStats()` devuelve `{ state, dataPlane, roLanes, sessionId, rttMs, peers, sessions, bytesOut, bytesIn, messagesOut, messagesIn, udp }`, y `room.haxlite.onBackendState(state, err)` avisa de `'down'` (túnel perdido: se desconecta a todos y se rechazan las entradas con 4104) y `'ready'`. Si la clave es inválida o la versión incompatible (`EdgeError` fatal), `HBInit` se rechaza enseguida.

#### `transport` (válvula de escape)

`config.haxlite.transport` es un `Partial<HostTransportOptions>` que se mezcla debajo de lo que fija `HBInit`. **`HBInit` siempre sobrescribe** `token`, `public`, `password`, `maxPlayers`, `roomInfo` y `onJoinRequest`; y `masterUrl`, `agent`, `wsUrl`, `iceServers`, `allowNullAuth`, `joinRateLimit`, `bans`, `edge`, `peerBackend` y `rtc→rtcEndpoint` solo si los das en `haxlite`. Opciones útiles (todas verificadas en `src/net/transport.ts` y `signaling.ts`):

| Opción | Por defecto | Qué hace |
|---|---|---|
| `iceCandidatePolicy` | `'public'` | Qué candidatos propios (y dirección `c=` del SDP) se envían: `'public'` no revela LAN/loopback; `'private'` añade LAN; `'all'` todo (pruebas locales); o un predicado |
| `portRange` | ninguno | Rango de puertos UDP de ICE (solo `ndc`); atajo de `rtc.portRangeBegin/End` |
| `rtc` | `{ enableIceUdpMux: true }` | Configuración de node-datachannel (`bindAddress`, `portRangeBegin/End`, `enableIceUdpMux`, `iceTransportPolicy`, `maxMessageSize`, `mtu`, `proxyServer`, y `ipv6` de haxlite, por defecto `false`). Solo `ndc` (salvo `iceTransportPolicy: 'relay'`, que también lee `rtc`) |
| `version` | `9` | Versión de protocolo que se exige a los clientes (4103). Entero 0..65535, si no `RangeError` |
| `floodCapacity` / `floodMsPerToken` | `100` / `16` | Límite de mensajes por conexión (si se agota, se expulsa por «Bad actor»). `floodCapacity` ≥ 1 y `floodMsPerToken` finito > 0; si no, `RangeError` al crear el transporte |
| `maxPendingNegotiations` | `16` | Negociaciones simultáneas máximas (4104). Entero ≥ 1; si no, `RangeError: maxPendingNegotiations must be an integer >= 1 (got X)` |
| `maxUnjoinedPerIp` | `12` (`NetDefaults.maxUnjoinedPerIp`) | **[ext.]** Conexiones de una misma dirección pública (IPv6: un /64) que aún no han entrado (negociando, esperando `onJoinRequest`, con el desafío enviado o verificando). La siguiente oferta recibe 4104 «too many unjoined connections from this address». Los jugadores ya unidos no cuentan; loopback y redes privadas están exentas. Un cliente oficial puede tener 2 a la vez (el reintento *reverse* sustituye al intento directo abandonado a los 4 s). Entero ≥ 1 o `Infinity` (lo desactiva); si no, `RangeError` |
| `abusePenalty` | `{ capacity: 20, msPerToken: 3000, blockMs: 30000, admitEveryMs: 3000 }` (`NetDefaults.abusePenalty`) | **[ext.]** Penalización por dirección pública (IPv6: un /64) por el abuso que comete la propia conexión y detecta el transporte o el edge: *flood* o mensaje de texto (en cualquier estado), *handshake* mal formado o cualquier otro mensaje antes de unirse, y no completar el *handshake* estando con el desafío enviado. Cada cierre abusivo gasta una ficha (`capacity` fichas, una se repone cada `msPerToken` ms); sin fichas, durante `blockMs` la dirección recibe una conexión nueva cada `admitEveryMs` y el resto 4104 «address blocked after abusive connections». No cuentan los cierres que pide la sala (`HostTransport.close`, «Bad actor»), los *timeouts* de jugadores ya unidos, los asientos cedidos ni `'stalled'`. `admitEveryMs` es opcional (`Infinity` = rechazo total). `null` lo desactiva. `capacity` entero ≥ 1; `msPerToken`, `blockMs` y `admitEveryMs` finitos > 0; si no, `RangeError`. Jugadores tras una misma NAT comparten la dirección |
| `verifiedIpBans` | `true` | **[ext.]** Los bans de IP se apoyan en direcciones que el host ha verificado. `kickPlayer(…, true)` y `banPeer` guardan la IP de `conn` y la dirección pública del par ICE elegido **si el cliente la declaró** como candidato `host` o `srflx` propio (una dirección relay de TURN, compartida por todos los que usan ese servidor, nunca se guarda); las IP *srflx* declaradas, que podrían ser de un tercero, no se guardan. En el *handshake* se comprueba esa dirección contra los bans (expulsión «You are banned from this room.», motivo `'banned'`) y la oferta se rechaza con 4102 «banned candidate» si un candidato `host` o `prflx` público está baneado. `false`: comportamiento oficial (`conn` y *srflx* declaradas, sin esas comprobaciones) |
| `maxPeerBufferedBytes` | `1048576` (`DEFAULT_MAX_PEER_BUFFERED_BYTES`, 1 MiB) | **[ext.]** Bytes enviados a un jugador y aún sin confirmar por encima de los cuales se le cierra con `'stalled'` si se mantienen `peerBufferedTimeoutMs`; se comprueba en cada barrido. Entero ≥ 1 o `Infinity` (lo desactiva). Solo con backends que informan `queuedBytes` (`ndc`, `rtc`); un edge aplica los suyos |
| `peerBufferedTimeoutMs` | `10000` (`DEFAULT_PEER_BUFFERED_TIMEOUT_MS`) | **[ext.]** Cuánto debe mantenerse la cola por encima de `maxPeerBufferedBytes` antes de cerrar al jugador. Finito > 0 |
| `channelOpenTimeoutMs` | `10000` | Plazo para que el canal 0 abra tras la oferta. Finito > 0, si no `RangeError` |
| `peerIdleTimeoutMs` | `10000` | Inactividad de un jugador conectado. Finito > 0, si no `RangeError` |
| `answerIceWaitMs` | `500` | Espera máxima de la recolección ICE local antes de contestar. ≥ 0 y ≤ 2 147 483 647 |
| `reverseIceDelayMs` | `2500` | Retraso de los candidatos remotos en una oferta «inversa». ≥ 0 y ≤ 2 147 483 647 |
| `challengeDelayMs` | `10` para clientes libdatachannel (bots node-haxball), `0` para el resto | Retraso entre abrir el canal 0 y enviar el desafío. ≥ 0 y ≤ 2 147 483 647 |
| `roomLinkBase` | `'https://www.haxball.com/play?c='` | Prefijo del enlace de sala |
| `sweepIntervalMs` | `1000` | Periodo del barrido de temporizadores. > 0 y ≤ 2 147 483 647 |
| `origin` / `wsHeaders` | `'https://html5.haxball.com'` / ninguno | Cabecera `Origin` y cabeceras extra del WebSocket de señalización |
| `reconnect` | `true` | Reconectar la señalización tras una caída inesperada |
| `keepAliveMs` | `40000` | Keep-alive de la señalización (también comprueba que el enlace siga vivo) |
| `handshakeTimeoutMs` | `15000` | Plazo del *upgrade* del WebSocket de señalización |
| `reconnectMinMs` / `reconnectRangeMs` | `10000` / `50000` | Retardo de reconexión = mín + aleatorio × rango |
| `headers` / `timeoutMs` | ninguno / `15000` | Cabeceras extra y plazo de las peticiones HTTP al maestro (inactividad y tiempo total: ver [§2.2](#22-maestro-señalización-y-arranque)) |
| `log` | ninguno | Registro de depuración del ciclo de vida de los peers |
| `backend` | ninguno | `PeerBackend` propio (sustituye a `edge` y `peerBackend`) |

### 2.5 Tabla completa de `room.haxlite`

| Nombre | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `inputDelayFrames` | `number` | `2` | Retardo de input (frames) | Lectura/escritura; 1–60 ([§2.1](#21-netcode)) |
| `heartbeatFrames` | `number` | `7` | Periodo de *heartbeat* | Lectura/escritura; 1–600 |
| `checksumIntervalFrames` | `number` | `600` | Periodo de *CheckConsistency* | Lectura/escritura; 1–1 048 576 |
| `maxWakeFrames` | `number` | `4` | Cota de despertar con partida en curso | Lectura/escritura; 1–600 o `Infinity` |
| `roomLink` | `string \| null` (solo lectura) | `null` hasta que el maestro lo asigna | Enlace actual de la sala | Es el último recibido: **no se recalcula** al llamar a `setPassword()` (usa `room.haxlite.transport.roomLink` para el enlace con `&p=1` actualizado). Se vuelve a recibir tras reconexiones de la señalización |
| `frame` | `number` (solo lectura) | - | Frame actual del reloj del host | |
| `recordingTruncated` | `boolean` (solo lectura) | `false` | `true` cuando la grabación actual (o la última) se congeló en su tope (`host.recorder.maxBytes` / `maxEvents`) | El replay termina en el frame en que se congeló. Se avisa una vez por grabación por `onError` («replay recording truncated at frame F …»). Ver [Replays](#replays-hbr2) |
| `stopped` | `boolean` (solo lectura) | `false` | `true` tras `stop()`/`close()` | |
| `bans` | `HaxliteBans` | lista de la sala (o la de `config.haxlite.bans`) | Operaciones sobre los bans | Ver tabla de abajo |
| `onBeforeOperation` | `((ev: RoomEvent, byPlayerId: number, requestedFrame: number) => boolean \| void) \| null` | `null` | Ve cada evento de cliente, después de asignarle frame y del filtro de chat, y antes de aplicarlo y difundirlo | Devolver `false` lo descarta; se pueden modificar campos del evento (no `frame`/`order`/`byId`); si **lanza**, se expulsa al emisor («Bad actor»). Una promesa rechazada se reporta a `onError` y el evento se permite (solo `false` lo descarta). El getter devuelve la función que asignaste. Se llama también por cada input: mantenlo barato |
| `onJoinRequest` | `JoinRequestHandler \| null` | el de `config.haxlite` o `null` | Gancho previo a WebRTC | Ver [§2.3](#23-admisión-y-moderación) |
| `onRecaptcha` | `((sitekey: string) => void) \| null` | `null` | El maestro pide captcha **tras** el arranque (p. ej. al reconectar con un token caducado) | Responde con `useRecaptchaToken()`. Sin manejador se notifica `InvalidRoomTokenError` por `onError` |
| `useRecaptchaToken(respuesta)` | método | - | Reintenta el registro en el maestro con la respuesta al captcha | No hace nada si la sala está parada |
| `onError` | `((err: unknown) => void) \| null` | `null` (→ `console.error('[haxlite]', err)`) | Errores de callbacks de sala (excepciones y promesas rechazadas), del transporte, de visuales privados rechazados y de grabación truncada | Si el propio manejador lanza, se ignora; si devuelve una promesa rechazada, va a `console.error`. Las rachas de errores idénticos se coalescen en un `RepeatedError` ([§2.1](#21-netcode)) |
| `getPlayerConnection(playerId)` | `PlayerConnectionInfo \| null` | - | Datos de conexión de un jugador | `null` para el host, ids desconocidos o jugadores ya cerrados |
| `setMaxPlayers(n)` | método | - | Cambia la capacidad en caliente (no es posible en el oficial) | Mismo *cast* y recorte 2..30 que `maxPlayers`. Actualiza el cartel de la lista pública |
| `setDiscPropertiesFor(viewerId, discIndex, props, opts?)` | método | - | Cambia un disco **solo** para un jugador | Ver [§2.6](#26-visuales-privados-y-jugadores-ocultos) |
| `clearDiscOverrides(viewerId)` | método | - | Restaura los valores de la sala en los discos modificados para ese jugador | |
| `getDiscPropertiesFor(viewerId, discIndex)` | `DiscPropertiesObject \| null` | - | El disco tal como lo ve ese jugador | |
| `hasPrivateView(viewerId)` | `boolean` | - | `true` mientras el jugador tiene un mundo privado | |
| `onPrivateViewEnd` | `((viewerId: number) => void) \| null` | `null` | La vista privada terminó porque su mundo volvió a ser idéntico al de la sala | No se llama si el jugador sale |
| `hidePlayerFor(viewerId, playerId)` | método | - | Oculta a `playerId` solo para `viewerId` | Ver [§2.6](#26-visuales-privados-y-jugadores-ocultos) |
| `showPlayerFor(viewerId, playerId)` | método | - | Deshace `hidePlayerFor` | |
| `setPlayerHiddenFor(viewerId, playerId, oculto)` | método | - | `oculto ? hidePlayerFor : showPlayerFor` | |
| `isPlayerHiddenFor(viewerId, playerId)` | `boolean` | - | `true` si está oculto (tras ejecutarse la llamada diferida) | |
| `getHiddenPlayersFor(viewerId)` | `number[]` | - | Ids ocultos para ese jugador | |
| `edgeStats()` | `EdgeBackendStats \| null` | - | Estadísticas del túnel de edge | `null` sin `haxlite.edge` |
| `rtcStats()` | `RtcEndpointStats \| null` | - | Contadores del endpoint haxlite-rtc | `null` salvo con `peerBackend: 'rtc'` o hasta que escucha. Del endpoint **compartido**: `sessions`, `open`, `packetsIn/Out`, `bytesIn/Out`, `stunAuthenticated`, `stunRejected`, `dtlsUnknownSource`, `dtlsHeld`, `unknownPackets`, `handshakesCompleted/Failed`, `dtlsReplayed`, `dtlsBadRecords`, `stunResponses`, `ice`, `reflexive`, `relayUnavailable`, `directDropped`, `turn`, `packetErrors`. `packetErrors` cuenta los datagramas o temporizadores cuyo procesamiento lanzó una excepción: se descartan, no tumban el proceso y se registran con `console.error` («[haxlite/rtc] error processing a …») como mucho cada 10 s |
| `setIceServers(lista)` | método | - | Cambia los servidores STUN/TURN en caliente | Ver [§2.4](#iceservers) |
| `rtcPort` | `number \| null` (solo lectura) | `null` | Puerto UDP al que se conectan los jugadores | Solo con `peerBackend: 'rtc'` y ya escuchando |
| `onBackendState` | `((state: 'ready' \| 'down', err: Error \| null) => void) \| null` | `null` | Disponibilidad del backend (túnel del edge) | Los backends locales siempre están `ready` |
| `stop()` | `Promise<void>` | - | Detiene la sala: temporizadores, señalización y todos los peers | Idempotente: cada llamada devuelve la misma promesa, que se resuelve al liberarse la sala (el socket UDP de `rtc` y, con la última sala del proceso, `shutdownWebRtc()`). Aborta un `api/host` en vuelo |
| `close()` | `Promise<void>` | - | Alias de `stop()` | |
| `host` | `HostRoom` (solo lectura) | - | El motor, para usos avanzados | [§5](#5-uso-avanzado-lo-que-exporta-haxlite) |
| `transport` | `HostTransport` (solo lectura) | - | El transporte, para usos avanzados | [§5](#5-uso-avanzado-lo-que-exporta-haxlite) |

`room.stopRecordingAsync()` **[ext.]** vive en `room`, no en `room.haxlite` ([§3](#3-métodos-de-room-y-callbacks-on)).

**`room.haxlite.bans`** (`HaxliteBans`). Todos los bans (también los de `kickPlayer(…, true)`) son `BanRecord` con `id`. IP y rangos se comprueban en la señalización, antes de WebRTC; `auth` tras el *handshake*, antes de entrar.

| Método | Qué hace |
|---|---|
| `addIp(ip, note?)` → `BanRecord` | Banea una IP (v4/v6); lanza `TypeError` si no es válida. Afecta a futuras entradas |
| `addRange(cidr, note?)` → `BanRecord` | Banea un rango CIDR (`203.0.113.0/24`, `2001:db8::/32`); `TypeError` si es inválido |
| `addAuth(auth, note?)` → `BanRecord` | Banea una clave pública (`player.auth`) |
| `list()` → `BanRecord[]` | Todos los registros |
| `remove(id)` → `boolean` | Quita un registro |
| `clear()` | Vacía toda la lista |
| `isIpBanned(ip)` / `isAuthBanned(auth)` → `boolean` | Consultas |

`BanRecord`: `{ id, kind: 'peer' \| 'ip' \| 'range' \| 'auth', ips: readonly string[], range: string \| null, auth: string \| null, note: string \| null, createdAt: number }`. Un `kickPlayer(id, motivo, true)` crea un registro `'peer'` con la IP de `conn` y, por defecto (`transport.verifiedIpBans: true`), la dirección pública del par ICE elegido (`remoteAddress`) si el cliente la declaró como candidato `host` o `srflx`; no guarda las IP *srflx* que declara el cliente (podrían ser de un tercero) ni su `auth` (para eso, `addAuth`). Con `verifiedIpBans: false` guarda `conn` y las *srflx* declaradas, como el host oficial. Los rangos CIDR se consultan por un índice de intervalos con búsqueda binaria que se reconstruye de forma perezosa tras cada alta o baja (`src/net/bans.ts`).

**`PlayerConnectionInfo`** (lo que devuelve `getPlayerConnection`):

| Campo | Tipo | Qué es |
|---|---|---|
| `auth` | `string \| null` | clave pública verificada |
| `conn` | `string` | IP del maestro en hexadecimal mayúsculas |
| `ip` | `string` | IP vista por el maestro |
| `srflxIps` | `readonly string[]` | IPs *server-reflexive* de sus candidatos (declaradas por el cliente, no verificadas) |
| `ping` | `number` | ping declarado por el cliente (ms) |
| `remoteAddress` | `string \| null` | dirección remota del par ICE elegido (vista por este host, o por el edge) |

### 2.6 Visuales privados y jugadores ocultos

Ambos mecanismos hacen que un solo jugador vea un mundo distinto sin desincronizar a nadie: el host simula ese mundo privado y le manda su propio hash de *CheckConsistency*. Explicación completa en [docs/04 §7.4](04-netcode-y-sincronizacion.md). Todas las llamadas son diferidas (se aplican en un *microtask*) y los errores van a `onError`.

* **`setDiscPropertiesFor(viewerId, discIndex, props, { force })`**: cambia el disco `discIndex` solo para `viewerId` (máscaras de visión, marcadores…). El disco debe ser «solo visual»: de estadio, no el 0, no un disco de jugador, sin *joints* y con `cGroup` 0 en todos los mundos. Si no, se rechaza por `onError`, salvo `force: true` (entonces ese jugador puede ver otra partida de verdad). `props` es un `DiscPropertiesUpdate`. Llamadas consecutivas sin otra acción en medio comparten un lote. El efecto se descarta al parar/empezar el juego, cambiar de estadio, un saque inicial que reinicia el disco, `clearDiscOverrides` o al salir el jugador.
* **`hidePlayerFor(viewerId, playerId)`**: `playerId` desaparece por completo para `viewerId` (sin disco, nombre, avatar ni flecha de borde en el cliente oficial) y sigue jugando normal para los demás. En el mundo del espectador su disco pasa a posición NaN y `cGroup` 0. Se vuelve a ocultar tras cada reaparición. Termina con el juego o cuando sale cualquiera de los dos. **No es una frontera de seguridad**: el estado de la sala sigue llegando a todos los clientes.

### 2.7 Ejemplos

Sala básica con las extensiones más usadas:

```js
import { HBInit } from 'haxlite';

const room = await HBInit({
  roomName: 'Mi sala', maxPlayers: 16, public: true, noPlayer: true,
  token: process.env.HAXBALL_TOKEN,
  haxlite: {
    inputDelayFrames: 2,
    heartbeatFrames: 4,
    allowNullAuth: false,                        // sin jugadores anónimos
    joinRateLimit: { capacity: 3, msPerToken: 15_000 },
    onJoinRequest: async (req) => !(await estaVetada(req.ip)),   // false => 4102
  },
});
room.haxlite.onError = (err) => console.error('error de sala', err);
room.haxlite.bans.addRange('203.0.113.0/24', 'proveedor abusivo');
process.once('SIGINT', () => room.haxlite.stop());
```

haxlite-rtc con TURN de corta vida (Cloudflare), solo relay, renovando credenciales:

```js
async function cfIce() {
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }),
  });
  return (await r.json()).iceServers;
}
const room = await HBInit({
  roomName: 'sala', token,
  haxlite: { peerBackend: 'rtc', iceServers: await cfIce(), rtc: { iceTransportPolicy: 'relay' } },
});
setInterval(async () => room.haxlite.setIceServers(await cfIce()), 12 * 3600_000);
```

Detrás de un edge (la IP del host no se expone):

```js
const room = await HBInit({
  roomName: 'Mi sala', token, noPlayer: true,
  haxlite: { edge: { url: 'wss://edge.midominio.com:8443/tunnel', key: 'alice:9fH3…' } },
});
room.haxlite.onBackendState = (state, err) => console.log('edge', state, err?.message);
setInterval(() => console.log(room.haxlite.edgeStats()), 60_000);
```

Filtrar eventos de cliente (`onBeforeOperation`) y limitar el chat con enlaces:

```js
import { EventType } from 'haxlite';

room.haxlite.onBeforeOperation = (ev, byPlayerId, requestedFrame) => {
  if (ev.type === EventType.SendChat && /https?:\/\//i.test(ev.message)) return false; // se descarta
};
```

Un jugador oculto para otro y un disco visual privado:

```js
room.haxlite.hidePlayerFor(viewerId, playerId);                      // viewer ya no ve a ese jugador
room.haxlite.setDiscPropertiesFor(viewerId, 5, { color: 0xff0000 }); // disco 5: solo visual
room.haxlite.onPrivateViewEnd = (id) => console.log('vista privada terminada', id);
```

---

## 3. Métodos de `room` y callbacks `on*`

`room` es el `RoomObject` oficial más `room.haxlite` ([§2](#2-confighaxlite-y-roomhaxlite)) y `stopRecordingAsync` **[ext.]**. Convenciones de tipos: `TeamID = 0 | 1 | 2` (0 espectadores, 1 rojo, 2 azul); `PlayerObject`, `ScoresObject`, `DiscPropertiesObject`… en la [§4](#4-tipos-de-datos). «Diferido» = se aplica en un *microtask*.

### 3.1 Métodos de acción

| Método | Qué hace | Notas |
|---|---|---|
| `sendChat(message: string, targetId?: number \| null): void` | Chat como el host | `targetId` = envío privado a ese jugador. El mensaje se trunca a 140 caracteres. No pasa por `onPlayerChat` (solo el chat de clientes lo hace). Diferido |
| `sendAnnouncement(msg: string, targetId?: number \| null, color?: number \| null, style?: AnnouncementStyle \| null, sound?: AnnouncementSound \| null): void` | Anuncio con formato | Por defecto `targetId = null` (todos), `color = -1` (color por defecto del cliente; si no, `0xRRGGBB`), `style = 'normal'`, `sound = 1`. Estilos: `'normal' \| 'bold' \| 'italic' \| 'small' \| 'small-bold' \| 'small-italic'` (otro valor ⇒ normal). Sonido: `0` ninguno, `1` chat, `2` notificación. Se trunca a 1000 caracteres. Con `targetId` es privado (no se registra en replays). Diferido |
| `setPlayerAdmin(playerId: number, admin: boolean): void` | Da o quita admin | Diferido |
| `setPlayerTeam(playerId: number, team: TeamID): void` | Mueve a un jugador de equipo | `1` rojo, `2` azul, cualquier otro valor espectadores. Diferido |
| `kickPlayer(playerId: number, reason?: string \| null, ban?: boolean): void` | Expulsa (y banea con `ban`) | `reason` por defecto `''` (máx. 100 caracteres); `ban` por defecto `false`. El baneo guarda la IP de `conn` y la dirección verificada del par ICE (ver [§2.5](#25-tabla-completa-de-roomhaxlite)). El id 0 no se puede expulsar. Diferido |
| `clearBan(playerId: number): void` | Quita el ban creado al banear a `playerId` | **Síncrono** |
| `clearBans(): void` | Vacía los bans de `kickPlayer(…, true)` | **Síncrono.** Conserva los bans de `room.haxlite.bans` (IP, rango, `auth`); esos se quitan con `room.haxlite.bans.clear()` |
| `setScoreLimit(limit: number): void` | Límite de goles | Entero 0–99 (se convierte con `\| 0`; el oficial no convierte). **Sin efecto con una partida en curso**. Diferido |
| `setTimeLimit(limitInMinutes: number): void` | Límite de tiempo en **minutos** | Entero 0–99. Sin efecto con partida en curso. Diferido |
| `setCustomStadium(stadiumFileContents: string): void` | Estadio desde texto `.hbs` | Lanza de forma síncrona `Error` con el mensaje del *parser* (`cause` = el error original: `HbsParseError` o `SyntaxError` de JSON5). También lanza si el estadio no cabe en el cable: «Stadium too large: deflated N > 65535» (el estadio comprimido no cabe en el `u16` de `SetStadium`) o «Stadium has a list over 255 items» (una lista de más de 255 elementos). Son límites del evento, no del *parser*: un `.hbs` con 300 *joints* se parsea pero no se puede cargar. Sin efecto con partida en curso |
| `setDefaultStadium(stadiumName: string): void` | Estadio incorporado por nombre exacto | Nombres: `'Classic'`, `'Easy'`, `'Small'`, `'Big'`, `'Rounded'`, `'Hockey'`, `'Big Hockey'`, `'Big Easy'`, `'Big Rounded'`, `'Huge'`. Otro nombre: `Error("Stadium doesn't exist")` síncrono. Sin efecto con partida en curso |
| `setTeamsLock(locked: boolean): void` | Bloquea que los jugadores cambien de equipo | Diferido |
| `setTeamColors(team: TeamID, angle: number, textColor: number, colors: readonly number[]): void` | Colores de un equipo | `angle` en grados; `textColor` y hasta 3 `colors` como `0xRRGGBB`. Diferido |
| `startGame(): void` / `stopGame(): void` | Inicia / detiene la partida | Diferidos |
| `pauseGame(pauseState: boolean): void` | Pausa o reanuda | Diferido |
| `reorderPlayers(playerIdList: readonly number[], moveToTop: boolean): void` | Reordena la lista de jugadores | Máx. 40 ids, sin duplicados. Diferido |
| `setKickRateLimit(min?: number \| null, rate?: number \| null, burst?: number \| null): void` | Límite de frecuencia de chutes | Por defecto `min = 2`, `rate = 0`, `burst = 0` (el motor recorta: `min`/`rate` 0..255, `burst` 0..100). Diferido |
| `setPlayerAvatar(playerId: number, avatar: string \| null): void` | Avatar forzado (máx. 2 caracteres); `null` lo quita | Diferido |
| `setDiscProperties(discIndex: number, properties: DiscPropertiesUpdate): void` | Modifica un disco del mundo por índice | Necesita partida en curso (si no, se ignora). Los campos `null`/ausentes no cambian; los flotantes se cuantizan a f32. Diferido |
| `setPlayerDiscProperties(playerId: number, properties: DiscPropertiesUpdate): void` | Modifica el disco de un jugador | Igual que el anterior |
| `setPassword(pass: string \| null): void` | Cambia o quita la contraseña | **Síncrono.** Actualiza la lista pública. Un valor que no sea `string`/`null` lanza `TypeError` |
| `setRequireRecaptcha(required: boolean): void` | Pide captcha a los que entran | **Síncrono**, con 1 s de *debounce* hacia el maestro. Un no-booleano lanza `TypeError` |
| `startRecording(): void` | Empieza (o reinicia) una grabación `.hbr2` | **Síncrono.** La grabación se congela al llegar a 16 MiB de registro o a 2 097 152 eventos (unas 2 horas de partida normal): el replay termina en ese frame y `room.haxlite.recordingTruncated` pasa a `true` (ver [Replays](#replays-hbr2)) |
| `stopRecording(): Uint8Array \| null` | Detiene y devuelve los bytes `.hbr2`, o `null` si no grababa | **Síncrono.** El deflate bloquea el bucle: con un cuerpo de más de 65 536 B usa el nivel 1 en Node (2 en Bun), un 3 % mayor que el nivel 6 y con una pausa 10 a 100 veces menor |
| `stopRecordingAsync(): Promise<Uint8Array \| null>` **[ext.]** | Igual, pero el deflate corre en el *threadpool* de libuv, siempre con nivel 6 | La grabación se detiene en la llamada (ya se puede llamar a `startRecording()`); resuelve `null` si no grababa. El cuerpo inflado es idéntico al de `stopRecording()`; los bytes comprimidos, no |

`CollisionFlags` e `InputFlags` también cuelgan de `room` y se exportan sueltos de `haxlite` ([§4](#4-tipos-de-datos)).

### 3.2 Consultas (síncronas)

| Método | Devuelve | Notas |
|---|---|---|
| `getPlayer(playerId: number)` | `PlayerObject \| null` | |
| `getPlayerList()` | `PlayerObject[]` | En el orden de la lista de la sala. Incluye al host si no hay `noPlayer` |
| `getScores()` | `ScoresObject \| null` | `null` sin partida. `time` y `timeLimit` en **segundos** |
| `getBallPosition()` | `{ x: number; y: number } \| null` | `null` sin partida |
| `getDiscProperties(discIndex: number)` | `DiscPropertiesObject \| null` | `null` sin partida o con índice inexistente |
| `getPlayerDiscProperties(playerId: number)` | `DiscPropertiesObject \| null` | `null` sin partida o si el jugador no tiene disco |
| `getDiscCount()` | `number` | `0` sin partida |

### 3.3 Callbacks `on*`

Son propiedades de `room` que se asignan y se pueden cambiar o poner a `null` en cualquier momento (`room.onPlayerJoin = (p) => …`). Todos son opcionales. Lo que aparece como `byPlayer` es `null` cuando la acción la hizo el host sin jugador (`noPlayer`) o el propio sistema.

| Callback | Firma | Cuándo | Notas |
|---|---|---|---|
| `onPlayerJoin` | `(player: PlayerJoinObject) => void` | Un jugador entra | Único con `auth` y `conn` |
| `onPlayerLeave` | `(player: PlayerObject) => void` | Un jugador se va, es expulsado o baneado | Se llama **antes** que `onPlayerKicked` |
| `onPlayerKicked` | `(kickedPlayer: PlayerObject, reason: string, ban: boolean, byPlayer: PlayerObject \| null) => void` | Expulsión o baneo | Siempre después de `onPlayerLeave` |
| `onPlayerChat` | `(player: PlayerObject, message: string) => boolean \| void` | Un cliente envía un mensaje | Devolver `false` (o `0`) descarta el mensaje: no llega a nadie. Solo el chat de clientes pasa por aquí. Si lanza, se expulsa al emisor |
| `onPlayerBallKick` | `(player: PlayerObject) => void` | Un jugador chuta la pelota | |
| `onTeamGoal` | `(team: TeamID) => void` | Gol | `team` = equipo que **marca** |
| `onTeamVictory` | `(scores: ScoresObject) => void` | Una partida termina con vencedor | |
| `onGameStart` / `onGameStop` | `(byPlayer: PlayerObject \| null) => void` | Empieza / se detiene la partida | `onGameStop` con `byPlayer = null` también cuando acaba la fase final |
| `onGamePause` / `onGameUnpause` | `(byPlayer: PlayerObject \| null) => void` | Pausa / reanudación | |
| `onGameTick` | `() => void` | 60 veces por segundo con partida sin pausar | La latencia de despertar la acota `maxWakeFrames` ([§2.1](#21-netcode)); cada frame se simula y llama exactamente una vez |
| `onPositionsReset` | `() => void` | Reinicio de posiciones tras un gol (saque) | |
| `onPlayerAdminChange` | `(changedPlayer: PlayerObject, byPlayer: PlayerObject \| null) => void` | Cambio de admin | |
| `onPlayerTeamChange` | `(changedPlayer: PlayerObject, byPlayer: PlayerObject \| null) => void` | Cambio de equipo | |
| `onPlayerActivity` | `(player: PlayerObject) => void` | Un jugador **con disco** cambia su input | En haxlite solo se dispara con cambios de input (se llama justo antes que `onPlayerInput`). Otras señales de actividad que pudiera tener el oficial **(no verificado)** |
| `onPlayerInput` | `(player: PlayerObject, prevInput: number) => void` | Cambio de input de un jugador con disco | `player.input` ya es el nuevo. Aparece en el código del host oficial (según `src/host/README.md`); no consta en el wiki oficial **(no verificado)** |
| `onStadiumChange` | `(newStadiumName: string, byPlayer: PlayerObject \| null) => void` | Cambio de estadio | |
| `onRoomLink` | `(url: string) => void` | La sala tiene enlace | Un manejador asignado después de que `HBInit` se resuelva recibe igualmente el enlace actual (en un *microtask*). Puede repetirse si la señalización se reconecta |
| `onKickRateLimitSet` | `(min: number, rate: number, burst: number, byPlayer: PlayerObject \| null) => void` | Cambio del límite de chutes | |
| `onTeamsLockChange` | `(locked: boolean, byPlayer: PlayerObject \| null) => void` | Bloqueo de equipos | |

El motor (`HostRoom.state.hooks`) tiene además ganchos que **no** se conectan al `RoomObject` (`onChatIndicator`, `onAnnouncement`, `onPlayerDesyncChange`, `onConsistencyResult`, `onTimeLimitReached`, `onGoalMarker`, `onPlayerChat` aplicado): se pueden usar a través de `room.haxlite.host.state.hooks` ([§5](#5-uso-avanzado-lo-que-exporta-haxlite)). No pises `onPlayerJoin`/`onPlayerLeave` de esos ganchos (son del motor) ni `onGoalMarker` mientras grabas.

---

## 4. Tipos de datos

Todos se exportan como tipos desde `haxlite` (`import type { PlayerObject } from 'haxlite'`) salvo indicación.

### `PlayerObject`

| Campo | Tipo | Notas |
|---|---|---|
| `name` | `string` | |
| `team` | `TeamID` | 0 espectadores, 1 rojo, 2 azul |
| `id` | `number` | Único y nunca reutilizado en la sala. El del host (si hay) es 0 |
| `admin` | `boolean` | |
| `position` | `{ x: number; y: number } \| null` | `null` si el jugador no está en el campo |
| `input` | `number` | Máscara de input actual (ver `InputFlags`) |

`PlayerJoinObject` extiende `PlayerObject` con `auth: string | null` (clave pública, `null` si falló la prueba de identidad) y `conn: string` (IP vista por el maestro, en hexadecimal mayúsculas: no es un hash).

### `ScoresObject`

| Campo | Tipo | Notas |
|---|---|---|
| `red`, `blue` | `number` | Goles |
| `time` | `number` | Segundos transcurridos (no avanza en pausa) |
| `scoreLimit` | `number` | |
| `timeLimit` | `number` | **Segundos** (la API lo recibe en minutos en `setTimeLimit`) |

### `DiscPropertiesObject` y `DiscPropertiesUpdate`

`DiscPropertiesObject` tiene `x`, `y`, `xspeed`, `yspeed`, `xgravity`, `ygravity`, `radius`, `bCoeff`, `invMass`, `damping`, `color`, `cMask`, `cGroup` (todos `number`). `color` es `0xRRGGBB` y `-1` significa transparente. `DiscPropertiesUpdate` es cualquier subconjunto, con `null` o ausencia = «sin cambios» (nombre oficial `bCoeff`, no `bCoef`).

### `CollisionFlags` e `InputFlags`

Constantes congeladas, accesibles como `room.CollisionFlags` / `room.InputFlags` y exportadas sueltas (`import { CollisionFlags, InputFlags } from 'haxlite'`):

| `CollisionFlags` | Valor | | `InputFlags` | Valor |
|---|---|---|---|---|
| `ball` | 1 | | `up` | 1 |
| `red` | 2 | | `down` | 2 |
| `blue` | 4 | | `left` | 4 |
| `redKO` | 8 | | `right` | 8 |
| `blueKO` | 16 | | `kick` | 16 |
| `wall` | 32 | | | |
| `kick` | 64 | | | |
| `score` | 128 | | | |
| `c0` / `c1` / `c2` / `c3` | 268435456 / 536870912 / 1073741824 / -2147483648 | | | |
| `all` | 63 | | | |

### Otros tipos de la API

| Tipo | Definición |
|---|---|
| `TeamID` | `0 \| 1 \| 2` |
| `AnnouncementStyle` | `'normal' \| 'bold' \| 'italic' \| 'small' \| 'small-bold' \| 'small-italic'` |
| `AnnouncementSound` | `0 \| 1 \| 2` |
| `GeoLocationConfig` | `{ code: string; lat: number; lon: number }` |
| `RoomConfigObject` | opciones de `HBInit` ([§1](#1-hbinitconfig-opciones-oficiales)) |
| `HaxliteConfig`, `HaxliteRoomExtensions`, `HaxliteBans` | [§2](#2-confighaxlite-y-roomhaxlite) |
| `PlayerConnectionInfo` | [§2.5](#25-tabla-completa-de-roomhaxlite) |
| `JoinRequestHandler` | `(request: JoinRequest) => JoinDecision \| Promise<JoinDecision>` |
| `RecaptchaHandler` | `(sitekey: string, useRecaptchaToken: (response: string) => void) => void` |
| `RoomObject` | el objeto que devuelve `HBInit` |

Además, `JoinRequest`, `JoinDecision`, `JoinInfo`, `BanRecord`, `BanKind`, `BanList`, `EdgeOptions`, `EdgeBackendStats`, `HostTransportOptions`, `HostRoomOptions`, `ListedRoom`, `RoomInfo`… se exportan desde la raíz, y el modelo interno (`Player`, `RoomState`, `GameState`, `Stadium`, `Disc`, `TeamColors`, `TEAMS`, `TeamId`, `GamePhase`, `Input`, `CollisionFlag`, `EventType`, `Channel`, `PROTOCOL_VERSION`, `REPLAY_VERSION`…) vía `export * from './model.js'`. Los eventos (`RoomEvent` y sus subclases, que recibe `onBeforeOperation`) están en el espacio de nombres `room` (`room.RoomEvent`, `room.SendChatEvent`, `room.SendInputEvent`…).

---

## 5. Uso avanzado: lo que exporta `haxlite`

```ts
import {
  HBInit, InvalidRoomTokenError, CollisionFlags, InputFlags,          // API HBInit
  HostRoom, HostDefaults, createHostRoomState,                          // motor
  HostTransport, BanList, MasterError, shutdownWebRtc, fetchGeo, fetchRoomList, EdgeError, // transporte
  EdgeServer,                                                           // gateway (docs/09)
  readReplay, writeReplay, ReplayData, ReplayPlayer, ReplayRecorder,    // replays .hbr2
  parseHbs, HbsParseError, defaultStadiums, buildDefaultStadium,        // estadios
  codec, sim, room, net, host, replay, edge,                            // módulos como espacios de nombres
} from 'haxlite';
```

El paquete solo expone la raíz (`exports: { ".": … }`). El módulo `rtc` **no** es un espacio de nombres exportado: lo de haxlite-rtc se alcanza a través de `peerBackend: 'rtc'` y `net.RtcPeerBackend`. La arquitectura de módulos está en [docs/06](06-arquitectura-haxlite.md) y el contrato del motor en [`src/host/README.md`](../src/host/README.md).

### `HostRoom` (el motor)

```ts
import { HostTransport, HostRoom, createHostRoomState } from 'haxlite';

const transport = new HostTransport({ token, public: true, maxPlayers: 16, roomInfo: { name: 'Sala' } });
const host = new HostRoom({ transport, state: createHostRoomState({ roomName: 'Sala', noPlayer: true }) });
host.onRoomLink = (link) => console.log(link);
host.onPlayerJoin = (p) => host.sendAnnouncement(`Hola ${p.name}`, p.id);
host.start();
// … host.stop() al terminar
```

`HostRoomOptions`: `transport` (obligatorio), `state` (por defecto una sala Classic vacía, `createHostRoomState()`), `inputDelayFrames` (2), `heartbeatFrames` (7), `checksumIntervalFrames` (600), `pingIntervalMs` (3000; número ≥ 1 o `Infinity`, si no `RangeError: pingIntervalMs must be >= 1 (got X)`), `maxWakeFrames` (4), `errorRepeatBurst` (60; ≥ 1 o `Infinity`) y `errorRepeatWindowMs` (1000; finito > 0), con `RangeError` si no ([§2.1](#21-netcode)), `now` (reloj en ms para tests; por defecto `performance.now`). `HostDefaults` expone esos mismos valores (`errorRepeatBurst` y `errorRepeatWindowMs` incluidos). `createHostRoomState({ roomName?, playerName?, noPlayer?, flag?, stadium? })` construye el `RoomState` inicial como lo hace `HBInit` (el jugador anfitrión es el id 0, admin).

| Miembro de `HostRoom` | Qué es |
|---|---|
| `start()`, `stop()`, `isRunning` | Ciclo de vida (`stop` desconecta a los clientes sin aviso) |
| `state` (`RoomState`), `transport`, `sequencer`, `recorder` (se crea al primer uso), `recordingTruncated`, `frame`, `update()` | Estado y utilidades (`update()` simula ahora todos los frames pendientes). `recorder.maxBytes` (16 MiB), `recorder.maxEvents` (2 097 152) y `recorder.truncated` se leen y ajustan aquí; ver [Replays](#replays-hbr2) |
| `inputDelayFrames`, `heartbeatFrames`, `checksumIntervalFrames`, `maxWakeFrames` | Ajustes de netcode, modificables en caliente (`heartbeatFrames` 1–600…; en `HostRoom` el `maxWakeFrames` acepta cualquier número ≥ 1 y lo trunca) |
| `onPlayerJoin(player)`, `onPlayerLeave(player)`, `onPlayerKicked(player, reason, ban, byPlayer)`, `onRoomLink(link)`, `onBadActor(playerId, err)`, `onError(err)`, `onEventApplied(ev)`, `onPrivateViewEnd(id)`, `onBeforeOperation` | Callbacks del motor (`Player` es el modelo vivo, no el `PlayerObject`) |
| `emit(ev)`, `emitTo(ev, playerId)` | Emite un evento arbitrario como host / a un solo jugador. `emit` de un `SetStadiumEvent` que no cabe en el cable ([`wireError()`](#estadios)) se notifica por `onError` y no se aplica, difunde ni graba |
| `sendChat`, `sendAnnouncement(msg, targetId, color=-1, style=0 numérico, sound=1)`, `setPlayerAdmin`, `setPlayerTeam`, `setPlayerAvatar`, `kickPlayer(id, reason='', ban=false)`, `clearBan`, `clearBans`, `setScoreLimit`, `setTimeLimit`, `setStadium(stadium)`, `setCustomStadium`, `setDefaultStadium`, `setTeamsLock`, `setTeamColors`, `setKickRateLimit(min=2, rate=0, burst=0)`, `startGame`, `stopGame`, `pauseGame`, `setDiscProperties`, `setPlayerDiscProperties`, `reorderPlayers`, `setPassword`, `setRequireRecaptcha`, `setMaxPlayers`, `startRecording`, `stopRecording`, `stopRecordingAsync` | Acciones (en `HostRoom` se aplican de forma síncrona, salvo desde dentro de un callback, donde se difieren al final del bucle; `HBInit` añade el *microtask* oficial). `clearBans()` aquí vacía **toda** la lista, a diferencia de `room.clearBans()` |
| `getPlayerList()`, `getPlayer(id)`, `getScores()`, `getBallPosition()`, `getDiscProperties(i)`, `getPlayerDiscProperties(id)`, `getDiscCount()`, `getConnection(id)` | Consultas (`getPlayer*` devuelven objetos `Player` vivos, no `PlayerObject`) |
| `setDiscPropertiesFor`, `clearDiscOverrides`, `hasPrivateView`, `getDiscPropertiesFor`, `setPlayerHiddenFor`, `isPlayerHiddenFor`, `getHiddenPlayersFor`, `batchPrivate(fn)` | Visuales privados y jugadores ocultos ([§2.6](#26-visuales-privados-y-jugadores-ocultos)) |

`setStadium` y `setCustomStadium` lanzan `Error` («Stadium too large: deflated N > 65535» / «Stadium has a list over 255 items») antes de aplicar nada si el estadio no cabe en el cable. `setMaxPlayers(n)` (también en `HostTransport`) lanza `RangeError` si `n` no es un entero en 0..255. Ids de jugador: del 1 al 65 535; tras el 65 535 el contador vuelve a 1 y salta los ids en uso (conectados, en la sala, con ban por id o autores de un evento en cola). Si los bans por id ocupan todos los demás, se reutiliza el id del ban más antiguo (el ban sigue vigente, pero `clearBan(idViejo)` ya no lo encuentra; usa `haxlite.bans` para levantarlo); si no queda ningún id, se cierra el peer y se notifica `Error('no free player id')` por `onError`. La excepción en un gancho de frame (`onFrameStepped`, `onEventApplied`) se notifica por `onError` sin interrumpir el bucle de frames.

Otros exports del motor (en el espacio de nombres `host`): `Sequencer`, `SequencerClient`, `HostConnection`, `MovingAverage`, `ProtocolViolation`, `encodePong`, `encodeTargetedEvent`, `DEFAULT_STADIUM_NAMES`, `defaultStadiumByName(name)`.

### `HostTransport` (red)

Es todo lo que hay entre el maestro y los mensajes decodificados de cada jugador. Opciones: `HostTransportOptions` ([§2.4 `transport`](#transport-válvula-de-escape) y [§2.2/2.3](#22-maestro-señalización-y-arranque)); además `token` (obligatorio), `public` (`false`), `password` (`null`), `maxPlayers` (12; el control de capacidad lo hace aquí, `HBInit` ya lo recorta a 2..30), `roomInfo` (`{ name, flag, lat, lon, players }`), `onJoinRequest`, `iceServers`, `peerBackend`, `rtcEndpoint` (= `haxlite.rtc`), `edge`, `backend`.

| Miembro | Qué es |
|---|---|
| `start()`, `stop()` | Ciclo de vida |
| `onRoomLink(link, roomId)`, `onPeerJoin(peer, info)`, `onPeerMessage(peer, data, channel)`, `onPeerClose(peer, reason)`, `onJoinRejected(req, code, why)`, `onRecaptcha(sitekey)`, `onError(err)`, `onBackendState(state, err)` | Callbacks. En `onPeerMessage`, `data` solo vale durante la llamada (cópialo si lo guardas) |
| `send(peer, channel, data)`, `broadcast(channel, data, except?)`, `broadcastTo(targets, channel, data)` | Envío (`Channel.ReliableOrdered` 0 / `ReliableUnordered` 1 / `Unreliable` 2) |
| `kick(peer, { reason, ban, byName, banAuth })`, `banPeer(peer, { auth, note })`, `close(peer, reason)` | Moderación |
| `setPassword`, `setMaxPlayers`, `setPublic(on)`, `setRoomInfo(info)`, `getRoomInfo()`, `setRequireRecaptcha`, `useRecaptchaToken`, `setIceServers` | Ajustes en caliente de la sala |
| `bans` (`BanList`), `signaling`, `backend`, `peers`, `pendingCount`, `connectionCount`, `roomId`, `roomLink` | Estado |

Peers: `Peer` tiene `id`, `conn`, `ip`, `srflxIps`, `ips` (todas las conocidas), `reverse`, `state`, `auth`, `info` (`{ name, flag, avatar }`), `remoteAddress`, `playerId` y `userData` (libres para ti). Motivos de cierre (`PeerCloseReason`): `'closed'`, `'timeout'` (sin mensajes durante `peerIdleTimeoutMs`, o sin *handshake* con la sala llena y otra conexión necesitando el asiento), `'flood'`, `'protocol'`, `'kicked'`, `'host'`, `'full'`, `'auth'`, `'banned'`, `'failed'`, `'shutdown'` y `'stalled'` (el jugador mantuvo más de `maxPeerBufferedBytes` sin confirmar durante `peerBufferedTimeoutMs`; la sala lo trata como una salida normal, no como «Bad actor»). Un `PeerBackend` propio puede informar `PeerLink.queuedBytes?()` (bytes enviados y aún sin confirmar, todos los canales) para que el transporte aplique ese límite; `RtcSession.bufferedAmount` es lo equivalente en haxlite-rtc.

Funciones sueltas del maestro: `fetchGeo(opts?)` → `{ flag, lat, lon }` y `fetchRoomList(opts?)` → `ListedRoom[]` (`{ id, info: RoomInfo }`), con `opts` = `{ masterUrl?, agent?, headers?, timeoutMs?, signal? }` (`signal`: `AbortSignal`; ver [§2.2](#22-maestro-señalización-y-arranque)); `shutdownWebRtc(timeoutMs = 5000)` para cerrar node-datachannel. `MasterError` (`kind`: `'recaptcha' | 'master' | 'http' | 'network' | 'invalid-response'`, `sitekey`, `status`).

### `BanList`

`new BanList()` y los mismos métodos que `room.haxlite.bans` (`addIp`, `addRange`, `addAuth`, `remove`, `clear`, `list`, `isIpBanned`, `isAuthBanned`) más `addPeer(ips, auth?, note?)`, `get(id)` y `size`. Se puede pasar a varias salas con `haxlite.bans`:

```js
import { BanList, HBInit } from 'haxlite';
const bans = new BanList();
const a = await HBInit({ token: t1, haxlite: { bans } });
const b = await HBInit({ token: t2, haxlite: { bans } });
bans.addIp('198.51.100.7');   // vale en las dos salas
```

### Replays `.hbr2`

```js
import { writeFileSync, readFileSync } from 'node:fs';
import { readReplay, ReplayPlayer } from 'haxlite';

room.startRecording();
// … se juega …
writeFileSync('partida.hbr2', await room.stopRecordingAsync());

const rep = readReplay(readFileSync('partida.hbr2'));   // ReplayData
console.log(rep.version, rep.totalFrames, rep.goalMarkers, rep.events.length);

const p = new ReplayPlayer(rep);       // o new ReplayPlayer(bytes)
p.seek(600);                           // re-simula hasta el frame 600
console.log(p.rs.gameState?.redScore); // estado de la sala en ese frame
const final = p.finish();              // RoomState al detener la grabación
// con ficheros ajenos: await p.finishAsync({ sliceMs: 8, signal })
```

| Export | Qué es |
|---|---|
| `readReplay(bytes, opts?): ReplayData` | Decodifica el fichero entero. `ReplayData`: `version` (3), `totalFrames`, `goalMarkers: { frame, team }[]`, `stateBytes`, `events: RoomEvent[]` (frames relativos al inicio) y `initialState()`. `opts` (`ReplayReadOptions`): `maxBodyBytes` (cuerpo inflado; por defecto `REPLAY_MAX_BODY_BYTES` = 33 554 432, 32 MiB) y `maxEvents` (por defecto `REPLAY_MAX_EVENTS` = 2 097 152); `Infinity` = sin tope y un valor inválido da el defecto. Superados: `ReplayFormatError` «replay body larger than maxBodyBytes (N)» o «too many events (more than maxEvents = N)». Un replay oficial más largo exige subirlos. `replay.replayBody(bytes, maxBodyBytes?)` aplica el mismo tope al cuerpo |
| `writeReplay(data): Uint8Array` | `ReplayData` → `.hbr2` (para recortar o editar) |
| `ReplayPlayer` | `new ReplayPlayer(ReplayData \| Uint8Array, opts?)`; `opts` (`ReplayPlayerOptions`) hereda `maxBodyBytes` y `maxEvents` (solo si recibe bytes) y añade `maxSeekMs` (presupuesto de tiempo de `seek`/`finish`; por defecto `Infinity`, sin presupuesto) y `maxFrames` (por defecto `REPLAY_PLAYER_MAX_FRAMES` = 16 777 216, unas 77 h). Miembros: `rs` (estado actual), `frame`, `totalFrames`, `ended`, `hooks`, `onReset`, `onEvent`, `step(n = 1)`, `reset()`, `applyCurrentFrameEvents()`. `seek(frame, { maxMs }?)` (retrocede re-simulando desde el inicio) y `finish({ maxMs }?)` llegan al destino; sin presupuesto, un destino por encima de `maxFrames` lanza `RangeError` («replay seek beyond maxFrames (T > M); use seekAsync, a time budget or a higher maxFrames») antes de simular nada, y con presupuesto (`maxSeekMs` o `maxMs`) lanzan `RangeError` «replay seek budget exceeded (F/T frames)» dejando el jugador en un frame coherente: la siguiente llamada continúa. `seekAsync(frame, { sliceMs = 8, signal }?)` y `finishAsync({ sliceMs, signal }?)` ceden el hilo cada `sliceMs` ms y se abortan con un `AbortSignal` (la promesa rechaza con `signal.reason` y el jugador queda donde llegó); úsalos con ficheros ajenos y no uses el jugador hasta que se resuelvan |
| `ReplayRecorder` | Grabador que usa el host: `new ReplayRecorder(version = 3, { maxBytes, maxEvents }?)`, `start(rs, frame, clock?)`, `onEvent`, `stop(frame)`, `stopAsync`, `snapshot`, `snapshotAsync`, `cancel`…; normalmente basta `room.startRecording()`. El registro tiene tope: `maxBytes` (por defecto `REPLAY_RECORD_MAX_BYTES` = 16 777 216, 16 MiB; estado inicial más eventos) y `maxEvents` (por defecto `REPLAY_MAX_EVENTS`); `Infinity` = sin tope y un valor inválido da el defecto. Al alcanzarlo la grabación se **congela**: el fichero termina en el frame del primer evento no grabado, `truncated` pasa a `true` y se llama a `onTruncated(frame)` una vez. Con los topes por defecto, lo grabado siempre se lee con los topes de lectura por defecto. Desde `HBInit`: `room.haxlite.host.recorder.maxBytes` / `.maxEvents`. `stop()` y `snapshot()` usan deflate de nivel 1 en Node (2 en Bun) si el cuerpo supera 65 536 B; `stopAsync()` y `snapshotAsync()`, nivel 6 |
| `replay.ReplayFormatError`, `replay.ReplayVersionError` | Fichero malformado / versión distinta de 3 (el segundo tiene `version`). En el espacio de nombres `replay`. Detalle en [`src/replay/README.md`](../src/replay/README.md) |

Constantes exportadas en el espacio de nombres `replay`: `REPLAY_MAX_BODY_BYTES`, `REPLAY_MAX_EVENTS`, `REPLAY_RECORD_MAX_BYTES` y `REPLAY_PLAYER_MAX_FRAMES`; los tipos de opciones (`ReplayReadOptions`, `ReplayPlayerOptions`, `ReplaySeekOptions`, `ReplayAsyncSeekOptions`, `ReplayRecorderOptions`) también.

### Estadios

| Export | Qué es |
|---|---|
| `parseHbs(text): Stadium` | Parsea texto `.hbs` (JSON5) con la geometría derivada calculada. Lanza `HbsParseError` (o un `SyntaxError` de JSON5) en los mismos casos que el *parser* oficial. Lo que usa `room.setCustomStadium` |
| `HbsParseError` | Error del *parser* (`message` con el texto oficial) |
| `defaultStadiums(): readonly Stadium[]` | Los 10 estadios incorporados, **compartidos**: no los modifiques |
| `buildDefaultStadium(id): Stadium` | Copia privada del estadio incorporado `id` (0 Classic, 1 Easy, 2 Small, 3 Big, 4 Rounded, 5 Hockey, 6 Big Hockey, 7 Big Easy, 8 Big Rounded, 9 Huge) |
| `room.STADIUM_INFLATE_LIMIT` / `room.STADIUM_PACKED_LIMIT` | Topes del evento `SetStadium` (espacio `room`): 262 144 B de estadio inflado (un cliente que envía más se expulsa por «Bad actor», `CodecError` «Inflate size exceeds limit») y 65 535 B de estadio comprimido (el `u16` de longitud) |
| `room.SetStadiumEvent#packedSize()` / `#wireError()` | Tamaño comprimido y motivo por el que el estadio no se puede enviar («Stadium has a list over 255 items» o «Stadium too large: deflated N > 65535»), o `null`. Compruébalo antes de emitir un estadio construido a mano; `SetStadiumEvent.write` lanza `CodecError` antes de escribir si no cabe. Un `SetStadium` de cliente que decodifica pero que nuestro deflate no logra meter en 65 535 B se descarta y se notifica por `onError`, sin expulsar al admin |

El formato `.hbs` y los mapas por defecto: [docs/03](03-fisica-y-estadios.md).

### `EdgeServer`

`EdgeServer` (raíz y espacio de nombres `edge`) implementa el gateway que oculta la IP; `edge.loadEdgeConfig` y `edge.generateEdgeKey` (solo en el espacio de nombres) cargan la configuración y generan claves. La CLI es `haxlite-edge` (`bin/haxlite-edge.js`). Configuración completa en [docs/09 §5](09-haxlite-edge.md) y [docs/12 §3.4](12-referencia-operacion.md). `EdgeServer.start()` cierra el listener y las conexiones que abrió si `listen()` falla; un límite numérico inválido (`limits.*`) o un periodo `NaN` lanzan `RangeError` al construir. `EdgeServer.stats()` devuelve `EdgeStats`; la respuesta HTTP de `/stats` sin `stats.token` es un resumen sin datos por clave y lleva `redacted: true`.

---

## 6. Errores y códigos de cierre

### Errores de `HBInit` (promesa rechazada)

| Error | Cuándo | Notas |
|---|---|---|
| `InvalidRoomTokenError` | El maestro pide un captcha (token inválido o caducado) y no hay `haxlite.onRecaptcha` | Propiedad `sitekey: string \| null`. Mensaje: «Invalid room token. Generate a new token at https://www.haxball.com/headlesstoken.». Genera un token nuevo y vuelve a llamar |
| `TypeError` `Cannot cast … to String` / `to Int` | `roomName`, `playerName`, `password`, `token` que no son `string`; `maxPlayers` que no es entero | |
| `Error('Invalid country code')` | `geo.code` de más de 3 caracteres | |
| `RangeError` `haxlite.<opción> must be an integer in [min, max]` | `inputDelayFrames`, `heartbeatFrames`, `checksumIntervalFrames` o `maxWakeFrames` fuera de rango | Lo mismo al asignarlas luego en `room.haxlite` |
| `RangeError` `haxlite.pingIntervalMs must be a number >= 1`, `haxlite.errorRepeatBurst must be a number >= 1`, `haxlite.errorRepeatWindowMs must be a finite number > 0` | Valor fuera de rango en `config.haxlite` | `pingIntervalMs: Infinity` y `errorRepeatBurst: Infinity` son válidos |
| `RangeError` de `haxlite.transport` | `maxPendingNegotiations`, `maxUnjoinedPerIp`, `abusePenalty.capacity` (enteros ≥ 1; `maxUnjoinedPerIp` también `Infinity`); `maxPeerBufferedBytes` (entero ≥ 1 o `Infinity`); `channelOpenTimeoutMs`, `peerIdleTimeoutMs`, `peerBufferedTimeoutMs`, `abusePenalty.msPerToken` / `blockMs` / `admitEveryMs` (finitos > 0); `floodCapacity`, `floodMsPerToken` y `joinRateLimit` (token bucket: capacidad ≥ 1, `msPerToken` finito > 0); `version` y `joinRateLimit.code` (0..65535); `sweepIntervalMs`, `answerIceWaitMs`, `reverseIceDelayMs`, `challengeDelayMs` (≤ 2 147 483 647) | Mensajes del tipo `<opción> must be an integer >= 1 or Infinity (got X)` y `<opción> must be a finite number of ms > 0 (got X)`. `HostTransport.setMaxPlayers` y `HostRoom.setMaxPlayers`: entero 0..255 |
| `RangeError` `RtcEndpoint: <opción> must be …` | Opción numérica de `rtc` inutilizable (ver [`rtc`](#rtc-tipo-rtcbackendoptions)) | |
| `Error` `ws:// edge url points to a public host …` / `edge url must start with ws:// or wss://` | URL de `edge` no válida o `ws://` público sin `allowInsecure` | Ver la política de `ws://` en [`edge`](#edge-tipo-edgeoptions) |
| `Error` `onRecaptcha failed: null` (o `undefined`) | El `onRecaptcha` de arranque lanzó o rechazó con `null`/`undefined` | Con otro valor, `HBInit` se rechaza con ese error; pasado el arranque va a `onError` |
| `TypeError` `peerBackend must be 'ndc' or 'rtc'` | Valor inválido | |
| `Error` `peerBackend 'rtc': …` | `publicAddresses` vacío, con valores que no son IP, o solo IPv6 sin `ipv6`; `iceLite` sin dirección pública detectable; `sendBatchFrames` inválido; `cannot listen on UDP …` (el *bind* falló) | |
| `Error` `RtcEndpoint: iceTransportPolicy 'relay' needs …` | `iceTransportPolicy: 'relay'` sin un `turn:` UDP en `iceServers`, o con `iceLite` | |
| `MasterError` | Fallo de red/HTTP con el maestro durante el arranque (`kind`: `'network'`, `'http'`, `'master'`, `'invalid-response'`) | `kind: 'recaptcha'` no se rechaza: va por `onRecaptcha`. `'invalid-response'` también por cuerpo demasiado grande, `content-encoding` no admitido (Bun) o una URL de `api/host` que no es `ws(s)`; `'network'` «aborted» si se abortó con `signal` |
| `EdgeError` | Clave inválida, versión incompatible o cuota del edge (`fatal: true`); los demás se reintentan hasta `initTimeoutMs` | Propiedades `kind` (`'auth' \| 'version' \| 'quota' \| 'protocol' \| 'connect' \| 'tunnel'`) y `fatal` |
| `Error('HBInit: no room link after N ms')` | No llegó el enlace en `initTimeoutMs` | |
| `Error('room stopped before initialization')` | Se llamó a `stop()` antes de terminar el arranque | |

En todos los casos de fallo en el arranque la sala se detiene sola.

### Errores síncronos de los métodos de `room`

`setCustomStadium` (mensaje del *parser*, con `cause`; «Stadium too large: deflated N > 65535» y «Stadium has a list over 255 items» si no cabe en el cable), `setDefaultStadium` (`Stadium doesn't exist`), `setPassword` y `setRequireRecaptcha` (*cast* de tipo → `TypeError`), `room.haxlite.bans.addIp/addRange` (`TypeError: invalid IP` / `invalid CIDR range`), asignaciones inválidas a las propiedades de netcode (`RangeError`).

### Errores posteriores al arranque

Van a `room.haxlite.onError(err)`: excepciones en tus callbacks, errores del transporte y de red, `EdgeError`, `MasterError`, `InvalidRoomTokenError` (si el maestro pide captcha y no hay `room.haxlite.onRecaptcha`) y los rechazos de visuales privados, además de las promesas rechazadas de tus callbacks, `RepeatedError` (rachas de errores idénticos coalescidas, [§2.1](#21-netcode)), el aviso de grabación truncada («replay recording truncated at frame F …»), `TypeError` de `onJoinRequest` («returned an invalid decision» / «returned a value that is not a JoinDecision») y `Error('no free player id')`. Con el edge, un `EdgeError` «tunnel send buffer overflow (the edge does not read)» o «tunnel timed out (the edge does not answer pings)» reconecta el túnel. Sin manejador se escriben con `console.error('[haxlite]', err)`.

### Códigos de cierre de la señalización (los ve el cliente)

| Código | Constante (`net.RejectCode`) | Significado en haxlite |
|---|---|---|
| `0` | `ParseError` | Oferta malformada |
| `4100` | `Full` | «The room is full.» (`maxPlayers` alcanzado y ninguna conexión rancia que ceda su asiento) |
| `4101` | `WrongPassword` | Contraseña incorrecta |
| `4102` | `Banned` | «You are banned from this room.»: IP del maestro o *srflx* baneada; con `verifiedIpBans`, un candidato `host`/`prflx` público baneado («banned candidate»); o `onJoinRequest` devolvió `false` |
| `4103` | `Version` | Versión del protocolo incompatible (la sala exige 9) |
| `4104` | `TooManyPending` | Demasiadas negociaciones pendientes (`maxPendingNegotiations`, 16), **o** `maxUnjoinedPerIp` superado («too many unjoined connections from this address»), **o** dirección limitada por `abusePenalty` («address blocked after abusive connections»), **o** `joinRateLimit` excedido (código por defecto), **o** el backend no está listo / el túnel del edge está caído, **o** `onJoinRequest` falló (lanzó, rechazó la promesa o devolvió una decisión mal formada) |
| *n* | - | El que devuelva `onJoinRequest` (`n` o `{ reject: n }`) o `joinRateLimit.code` |

Códigos del servidor maestro (`net.MasterCloseCode`): `4001` sala cerrada (el host **no** reconecta) y `4004` el maestro exige un captcha al cliente. La señalización reconecta sola con retardo de 10–60 s tras cualquier otra caída (`transport: { reconnect: false }` lo evita).

Códigos del túnel host↔edge (`net.EdgeCloseCode`): `4400` protocolo, `4401` autenticación, `4402` versión, `4408` tiempo agotado (`authTimeoutMs`, `dataPlaneTimeoutMs`, o una sesión sin autenticar que lleva ≥ 5 s y se desaloja con el motivo «auth timeout»), `4429` cuota («edge full» al hacer el *upgrade* o al autenticar con el edge lleno), `4503` el edge se apaga. Antes del WebSocket, el edge puede responder HTTP `429 Too Many Requests` (límite por IP) o `503 Service Unavailable` (pool de sockets sin autenticar lleno), ambos con `Retry-After: 1`: el cliente WebSocket lo ve como un fallo del *handshake*, no como un cierre 44xx ([docs/12 §3.8](12-referencia-operacion.md)).

### Expulsiones de un jugador ya conectado

| Motivo | Mensaje que ve el jugador | Notas |
|---|---|---|
| `allowNullAuth: false` y verificación fallida | «Identity verification failed» | `PeerCloseReason` `'auth'` |
| `auth` baneado (`bans.addAuth`), o dirección remota del par ICE baneada (con `verifiedIpBans`) | «You are banned from this room.» | `'banned'` |
| Exceso de mensajes (`floodCapacity`), mensaje de texto o malformado, evento no permitido, excepción en `onPlayerChat`/`onBeforeOperation`, `SetStadium` que infla a más de 262 144 B, chat de más de 840 B o avatar de más de 48 B (se rechazan antes de decodificar) | «Bad actor» | `'flood'`/`'protocol'`; se emite `onPlayerLeave` y `onPlayerKicked` |
| Sin mensajes durante `peerIdleTimeoutMs` (10 s) | - (conexión cerrada) | `'timeout'` |
| Más de `maxPeerBufferedBytes` sin confirmar durante `peerBufferedTimeoutMs` | - (conexión cerrada) | `'stalled'`; no es «Bad actor» y no suma al contador de `abusePenalty` |
| `kickPlayer(id, reason, ban)` | el `reason` indicado | Con `ban`, el cliente ve el baneo |
