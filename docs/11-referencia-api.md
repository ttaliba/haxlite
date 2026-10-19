# 11 - Referencia de la API de haxlite

Referencia completa de lo que ofrece **haxlite** (paquete `haxlite` 1.0.0, Node.js ≥ 22 o Bun) a quien lo usa como librería: `HBInit(config)`, el objeto `room`, las extensiones `config.haxlite` / `room.haxlite` y los módulos de uso avanzado.

Todo lo que aquí figura sale del código (`src/api/types.ts`, `src/api/hbinit.ts`, `src/host/`, `src/net/`, `src/rtc/`, `src/replay/`, `src/sim/`); cada valor por defecto se comprobó en la línea de código que lo aplica. Lo que no se pudo confirmar va marcado **(no verificado)**. Para el porqué de cada ajuste, véanse los documentos enlazados: [04 netcode](04-netcode-y-sincronizacion.md), [06 arquitectura](06-arquitectura-haxlite.md), [09 Edge](09-haxlite-edge.md), [10 haxlite-rtc](10-haxlite-rtc.md) y [ip/02 TURN](ip/02-turn.md). La guía de uso rápido está en la sección «haxlite: uso» del [README](../README.md).

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
* Los callbacks reciben objetos planos nuevos con el orden de claves oficial. Una excepción dentro de un callback no rompe el motor: va a `room.haxlite.onError` (por defecto `console.error('[haxlite]', err)`). Excepción: si `onPlayerChat` lanza, se expulsa al emisor («Bad actor»), como el oficial.

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
| `pingIntervalMs` | `number` (ms) | `3000` | Periodo del evento *Ping* | Solo en `config.haxlite` (no hay propiedad en vivo). Solo se emite mientras hay clientes. Sin validación **(no verificado qué ocurre con valores ≤ 0)** |

`room.haxlite.frame` (solo lectura) es el número de frame actual del reloj del host (a fecha de la última simulación).

### 2.2 Maestro, señalización y arranque

| Nombre (`config.haxlite.`) | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `masterUrl` | `string` (termina en `/`) | `'https://www.haxball.com/rs/'` | URL base del servidor maestro (`api/host`, `api/geo`, `api/list`) | Para pruebas, *proxies* o maestros propios |
| `agent` | `http.Agent` | ninguno | Agente HTTP(S)/SOCKS (`https-proxy-agent`, `socks-proxy-agent`…) | Se usa para la API HTTP del maestro **y** para el WebSocket de señalización. No afecta al tráfico WebRTC. En Bun, con `agent` o variables `HTTP(S)_PROXY` se usa `node:http` en vez de `fetch` |
| `wsUrl` | `string` | el que devuelve el maestro | Sustituye la URL del WebSocket de señalización | Para *proxies* o backends propios |
| `waitForLink` | `boolean` | `true` | `HBInit` se resuelve solo cuando existe el enlace de la sala | `false`: se resuelve nada más arrancar; el enlace llega después por `room.onRoomLink` |
| `initTimeoutMs` | `number` (ms) | `30000` | Si no hay enlace tras este tiempo, `HBInit` se rechaza (y la sala se detiene) | Solo con `waitForLink: true`. Un túnel de edge con errores no fatales se reintenta hasta este plazo |
| `onRecaptcha` | `(sitekey: string, useRecaptchaToken: (respuesta: string) => void) => void` | ninguno | El maestro pide un captcha durante el arranque (token inválido o caducado) | Resuelve el captcha y llama a `useRecaptchaToken(respuesta)`. **Sin este manejador `HBInit` se rechaza con `InvalidRoomTokenError`** (comportamiento de haxball.js). Pasado el arranque se usa `room.haxlite.onRecaptcha` |
| `shutdownWebRtcOnLastStop` | `boolean` | `true` | Al parar la última sala del proceso, libera node-datachannel (`shutdownWebRtc()`) para que Node pueda terminar solo | Pon `false` si arrancas salas nuevas con frecuencia. Solo cuenta salas creadas con `HBInit` |

### 2.3 Admisión y moderación

La admisión ocurre **durante la señalización, antes de crear ningún objeto WebRTC**. Orden de las comprobaciones sobre cada oferta (`src/net/transport.ts`): backend listo → negociaciones pendientes (< 16) → IP del maestro baneada → IP *srflx* de los candidatos baneada → `joinRateLimit` → sala llena (4100) → versión del protocolo (4103) → contraseña (4101) → `onJoinRequest`. Después de abrir el canal, el *handshake* ECDSA da `auth` (y aplica `allowNullAuth` y los bans por `auth`).

| Nombre (`config.haxlite.`) | Tipo | Por defecto | Qué hace | Notas |
|---|---|---|---|---|
| `allowNullAuth` | `boolean` | `true` (oficial) | Deja entrar a quien falla la prueba de identidad (con `auth = null`) | `false`: se le expulsa («Identity verification failed») antes de entrar |
| `joinRateLimit` | `{ capacity: number; msPerToken: number; code?: number } \| null` | `null` (desactivado) | Límite de intentos de entrada **por IP** (*token bucket*: `capacity` intentos, se recupera uno cada `msPerToken` ms) | Al excederlo se rechaza con `code` (por defecto **4104**). No existe en el host oficial **[ext.]** |
| `bans` | `BanList` | una nueva por sala | Lista de bans compartida (p. ej. una para varias salas) | `new BanList()` se exporta de `haxlite`. Ver `room.haxlite.bans` en la [§2.5](#25-tabla-completa-de-roomhaxlite) |
| `onJoinRequest` | `(req: JoinRequest) => JoinDecision \| Promise<JoinDecision>` \| `null` | ninguno | Gancho previo a WebRTC: acepta o rechaza la entrada | También es propiedad en vivo (`room.haxlite.onJoinRequest = …`). Puede ser `async`. Si lanza o rechaza la promesa, se informa por `onError` y se rechaza la entrada con 4104 |

`JoinRequest` (lo que recibe `onJoinRequest`):

| Campo | Tipo | Qué es |
|---|---|---|
| `peerId` | `number` | id de negociación asignado por el maestro |
| `conn` | `string` | `player.conn` (IP vista por el maestro, en hexadecimal mayúsculas) |
| `ip` | `string` | IP del cliente vista por el maestro |
| `srflxIps` | `readonly string[]` | IPs *server-reflexive* de sus candidatos ICE (máx. 32 candidatos considerados) |
| `candidateAddresses` | `readonly string[]` | todas las direcciones de candidatos de la oferta (pueden ser nombres mDNS) |
| `reverse` | `boolean` | la oferta viene marcada como «conexión inversa» (reintento del cliente) |
| `version` | `number` | versión del protocolo del cliente (la sala exige 9) |
| `password` | `string \| null` | contraseña que envía el cliente |

`JoinDecision` (lo que devuelve): `undefined`, `true` o `{ accept: true }` aceptan; `false` rechaza como baneado (**4102**); un número `n` o `{ reject: n }` cierra con ese código. Códigos habituales en [§6](#6-errores-y-códigos-de-cierre).

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
| `iceServers` | `readonly IceServerConfig[]` | `[]` con `iceLite` o con `publicAddresses`; si no, `haxlite.iceServers` (por defecto Google STUN) | STUN (candidatos *srflx*) y TURN UDP (candidato `relay`) | TURN: una asignación por endpoint con *pool* automático ([docs/10 §2.2](10-haxlite-rtc.md)). Los parámetros `turnPeersPerAllocation` (8) y `maxTurnAllocations` (64) del endpoint **no se pueden fijar desde `HBInit`** |
| `iceTransportPolicy` | `'all' \| 'relay'` | `'all'` (o `'relay'` si `transport.rtc.iceTransportPolicy` lo es) | `'relay'`: solo se anuncia el candidato relay y todo pasa por el TURN | Necesita un `turn:` UDP en `iceServers` y no es compatible con `iceLite`; si no, el *bind* falla y `HBInit` se rechaza. Sin asignación posible la sesión se cierra con `'turn-unavailable'` |
| `iceCandidatePolicy` | `'public' \| 'private' \| 'all' \| (c: {address, type}) => boolean` | `transport.iceCandidatePolicy`, si no `'public'` | Qué direcciones de interfaz se anuncian y a qué clases de dirección remota se mandan checks | No se aplica a `publicAddresses` |
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

El tráfico de `rtc` sigue pasando por la misma admisión de `HostTransport` (§2.3). Para el funcionamiento interno (ICE, TURN, DTLS, SCTP) véase [docs/10](10-haxlite-rtc.md) y [`src/rtc/README.md`](../src/rtc/README.md).

#### `edge` (tipo `EdgeOptions`)

Los jugadores se conectan al edge, nunca a esta máquina. Se ignoran `iceServers`, `transport.iceCandidatePolicy`, `transport.portRange` y `transport.rtc`. Detalle y seguridad en [docs/09 §2](09-haxlite-edge.md).

| Opción | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `url` | `string` | - (obligatorio) | Endpoint de control, p. ej. `wss://edge.ejemplo.com:8443/tunnel` (`ws://` solo pruebas/LAN) |
| `key` | `string` | - (obligatorio) | Clave del operador del edge: `"<keyId>:<secreto>"` |
| `dataPlane` | `'udp' \| 'webrtc' \| 'ws'` | `'udp'` | `'udp'` = túnel v2 (SCTP sobre UDP cifrado, TypeScript puro); `'webrtc'` = PeerConnection legada (carga el addon); `'ws'` = directamente por WebSocket |
| `fallbackWs` | `boolean` | `true` | Si el plano UDP no sube en `dataPlaneTimeoutMs` (o el edge no lo concede), todo el tráfico va por el WebSocket (HOL blocking, algo más de latencia) |
| `roLanes` | `boolean` | `true` | Pide carriles `ro` independientes para que una pérdida en host↔edge no frene a todos |
| `tunnelAead` | `'auto' \| 'aes-128-gcm' \| 'chacha20-poly1305'` | `'auto'` | Solo `dataPlane: 'udp'`: AEAD del túnel. `'auto'` pide ChaCha20-Poly1305 (Node y Bun); el edge decide |
| `bindAddress` | `string` | ninguna | Dirección local para el WS y el socket UDP del túnel |
| `iceServers` / `portRange` | `IceServerConfig[]` / `[number, number]` | ninguno | Solo `dataPlane: 'webrtc'` |
| `connectTimeoutMs` | `number` | `10000` | Plazo de conexión WS + autenticación |
| `dataPlaneTimeoutMs` | `number` | `5000` | Plazo del plano de datos (luego `fallbackWs`) |
| `reconnectMinMs` / `reconnectMaxMs` | `number` | `250` / `10000` | *Backoff* exponencial de reconexión |
| `pingIntervalMs` / `pingTimeoutMs` | `number` | `5000` / `15000` | Ping de aplicación y plazo de túnel muerto |
| `wsOptions` | opciones del cliente `ws` | ninguno | p. ej. `ca`, `rejectUnauthorized`, `agent` |
| `log` | `(msg: string) => void` | ninguno | Registro de depuración |

Con edge: `room.haxlite.edgeStats()` devuelve `{ state, dataPlane, roLanes, sessionId, rttMs, peers, sessions, bytesOut, bytesIn, messagesOut, messagesIn, udp }`, y `room.haxlite.onBackendState(state, err)` avisa de `'down'` (túnel perdido: se desconecta a todos y se rechazan las entradas con 4104) y `'ready'`. Si la clave es inválida o la versión incompatible (`EdgeError` fatal), `HBInit` se rechaza enseguida.

#### `transport` (válvula de escape)

`config.haxlite.transport` es un `Partial<HostTransportOptions>` que se mezcla debajo de lo que fija `HBInit`. **`HBInit` siempre sobrescribe** `token`, `public`, `password`, `maxPlayers`, `roomInfo` y `onJoinRequest`; y `masterUrl`, `agent`, `wsUrl`, `iceServers`, `allowNullAuth`, `joinRateLimit`, `bans`, `edge`, `peerBackend` y `rtc→rtcEndpoint` solo si los das en `haxlite`. Opciones útiles (todas verificadas en `src/net/transport.ts` y `signaling.ts`):

| Opción | Por defecto | Qué hace |
|---|---|---|
| `iceCandidatePolicy` | `'public'` | Qué candidatos propios (y dirección `c=` del SDP) se envían: `'public'` no revela LAN/loopback; `'private'` añade LAN; `'all'` todo (pruebas locales); o un predicado |
| `portRange` | ninguno | Rango de puertos UDP de ICE (solo `ndc`); atajo de `rtc.portRangeBegin/End` |
| `rtc` | `{ enableIceUdpMux: true }` | Configuración de node-datachannel (`bindAddress`, `portRangeBegin/End`, `enableIceUdpMux`, `iceTransportPolicy`, `maxMessageSize`, `mtu`, `proxyServer`, y `ipv6` de haxlite, por defecto `false`). Solo `ndc` (salvo `iceTransportPolicy: 'relay'`, que también lee `rtc`) |
| `version` | `9` | Versión de protocolo que se exige a los clientes (4103) |
| `floodCapacity` / `floodMsPerToken` | `100` / `16` | Límite de mensajes por conexión (si se agota, se expulsa por «Bad actor») |
| `maxPendingNegotiations` | `16` | Negociaciones simultáneas máximas (4104) |
| `channelOpenTimeoutMs` | `10000` | Plazo para que el canal 0 abra tras la oferta |
| `peerIdleTimeoutMs` | `10000` | Inactividad de un jugador conectado |
| `answerIceWaitMs` | `500` | Espera máxima de la recolección ICE local antes de contestar |
| `reverseIceDelayMs` | `2500` | Retraso de los candidatos remotos en una oferta «inversa» |
| `challengeDelayMs` | `10` para clientes libdatachannel (bots node-haxball), `0` para el resto | Retraso entre abrir el canal 0 y enviar el desafío |
| `roomLinkBase` | `'https://www.haxball.com/play?c='` | Prefijo del enlace de sala |
| `sweepIntervalMs` | `1000` | Periodo del barrido de temporizadores |
| `origin` / `wsHeaders` | `'https://html5.haxball.com'` / ninguno | Cabecera `Origin` y cabeceras extra del WebSocket de señalización |
| `reconnect` | `true` | Reconectar la señalización tras una caída inesperada |
| `keepAliveMs` | `40000` | Keep-alive de la señalización (también comprueba que el enlace siga vivo) |
| `handshakeTimeoutMs` | `15000` | Plazo del *upgrade* del WebSocket de señalización |
| `reconnectMinMs` / `reconnectRangeMs` | `10000` / `50000` | Retardo de reconexión = mín + aleatorio × rango |
| `headers` / `timeoutMs` | ninguno / `15000` | Cabeceras extra y plazo de las peticiones HTTP al maestro |
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
| `stopped` | `boolean` (solo lectura) | `false` | `true` tras `stop()`/`close()` | |
| `bans` | `HaxliteBans` | lista de la sala (o la de `config.haxlite.bans`) | Operaciones sobre los bans | Ver tabla de abajo |
| `onBeforeOperation` | `((ev: RoomEvent, byPlayerId: number, requestedFrame: number) => boolean \| void) \| null` | `null` | Ve cada evento de cliente, después de asignarle frame y del filtro de chat, y antes de aplicarlo y difundirlo | Devolver `false` lo descarta; se pueden modificar campos del evento (no `frame`/`order`/`byId`); si **lanza**, se expulsa al emisor («Bad actor»). Se llama también por cada input: mantenlo barato |
| `onJoinRequest` | `JoinRequestHandler \| null` | el de `config.haxlite` o `null` | Gancho previo a WebRTC | Ver [§2.3](#23-admisión-y-moderación) |
| `onRecaptcha` | `((sitekey: string) => void) \| null` | `null` | El maestro pide captcha **tras** el arranque (p. ej. al reconectar con un token caducado) | Responde con `useRecaptchaToken()`. Sin manejador se notifica `InvalidRoomTokenError` por `onError` |
| `useRecaptchaToken(respuesta)` | método | - | Reintenta el registro en el maestro con la respuesta al captcha | No hace nada si la sala está parada |
| `onError` | `((err: unknown) => void) \| null` | `null` (→ `console.error('[haxlite]', err)`) | Errores de callbacks de sala, del transporte y de visuales privados rechazados | Si el propio manejador lanza, se ignora |
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
| `rtcStats()` | `RtcEndpointStats \| null` | - | Contadores del endpoint haxlite-rtc | `null` salvo con `peerBackend: 'rtc'` o hasta que escucha. Del endpoint **compartido**: `sessions`, `open`, `packetsIn/Out`, `bytesIn/Out`, `stunAuthenticated`, `stunRejected`, `dtlsUnknownSource`, `dtlsHeld`, `unknownPackets`, `handshakesCompleted/Failed`, `dtlsReplayed`, `dtlsBadRecords`, `stunResponses`, `ice`, `reflexive`, `relayUnavailable`, `directDropped`, `turn` |
| `setIceServers(lista)` | método | - | Cambia los servidores STUN/TURN en caliente | Ver [§2.4](#iceservers) |
| `rtcPort` | `number \| null` (solo lectura) | `null` | Puerto UDP al que se conectan los jugadores | Solo con `peerBackend: 'rtc'` y ya escuchando |
| `onBackendState` | `((state: 'ready' \| 'down', err: Error \| null) => void) \| null` | `null` | Disponibilidad del backend (túnel del edge) | Los backends locales siempre están `ready` |
| `stop()` | `Promise<void>` | - | Detiene la sala: temporizadores, señalización y todos los peers | Idempotente. Espera a que se libere el socket UDP de `rtc` y, con la última sala del proceso, a `shutdownWebRtc()` |
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

`BanRecord`: `{ id, kind: 'peer' \| 'ip' \| 'range' \| 'auth', ips: readonly string[], range: string \| null, auth: string \| null, note: string \| null, createdAt: number }`. Un `kickPlayer(id, motivo, true)` crea un registro `'peer'` con la IP de `conn` y las IP *srflx* del jugador (no su `auth`: para eso, `addAuth`).

**`PlayerConnectionInfo`** (lo que devuelve `getPlayerConnection`):

| Campo | Tipo | Qué es |
|---|---|---|
| `auth` | `string \| null` | clave pública verificada |
| `conn` | `string` | IP del maestro en hexadecimal mayúsculas |
| `ip` | `string` | IP vista por el maestro |
| `srflxIps` | `readonly string[]` | IPs *server-reflexive* de sus candidatos |
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
| `kickPlayer(playerId: number, reason?: string \| null, ban?: boolean): void` | Expulsa (y banea con `ban`) | `reason` por defecto `''` (máx. 100 caracteres); `ban` por defecto `false`. El baneo guarda la IP de `conn` y las *srflx*. El id 0 no se puede expulsar. Diferido |
| `clearBan(playerId: number): void` | Quita el ban creado al banear a `playerId` | **Síncrono** |
| `clearBans(): void` | Vacía los bans de `kickPlayer(…, true)` | **Síncrono.** Conserva los bans de `room.haxlite.bans` (IP, rango, `auth`); esos se quitan con `room.haxlite.bans.clear()` |
| `setScoreLimit(limit: number): void` | Límite de goles | Entero 0–99 (se convierte con `\| 0`; el oficial no convierte). **Sin efecto con una partida en curso**. Diferido |
| `setTimeLimit(limitInMinutes: number): void` | Límite de tiempo en **minutos** | Entero 0–99. Sin efecto con partida en curso. Diferido |
| `setCustomStadium(stadiumFileContents: string): void` | Estadio desde texto `.hbs` | Lanza de forma síncrona `Error` con el mensaje del *parser* (`cause` = el error original: `HbsParseError` o `SyntaxError` de JSON5). Sin efecto con partida en curso |
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
| `startRecording(): void` | Empieza (o reinicia) una grabación `.hbr2` | **Síncrono** |
| `stopRecording(): Uint8Array \| null` | Detiene y devuelve los bytes `.hbr2`, o `null` si no grababa | **Síncrono.** El deflate bloquea el bucle (una grabación de ~1 h, unos ~280 ms) |
| `stopRecordingAsync(): Promise<Uint8Array \| null>` **[ext.]** | Igual, pero el deflate corre en el *threadpool* de libuv | La grabación se detiene en la llamada (ya se puede llamar a `startRecording()`); resuelve `null` si no grababa |

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

`HostRoomOptions`: `transport` (obligatorio), `state` (por defecto una sala Classic vacía, `createHostRoomState()`), `inputDelayFrames` (2), `heartbeatFrames` (7), `checksumIntervalFrames` (600), `pingIntervalMs` (3000), `maxWakeFrames` (4), `now` (reloj en ms para tests; por defecto `performance.now`). `HostDefaults` expone esos mismos valores. `createHostRoomState({ roomName?, playerName?, noPlayer?, flag?, stadium? })` construye el `RoomState` inicial como lo hace `HBInit` (el jugador anfitrión es el id 0, admin).

| Miembro de `HostRoom` | Qué es |
|---|---|
| `start()`, `stop()`, `isRunning` | Ciclo de vida (`stop` desconecta a los clientes sin aviso) |
| `state` (`RoomState`), `transport`, `sequencer`, `recorder` (se crea al primer uso), `frame`, `update()` | Estado y utilidades (`update()` simula ahora todos los frames pendientes) |
| `inputDelayFrames`, `heartbeatFrames`, `checksumIntervalFrames`, `maxWakeFrames` | Ajustes de netcode, modificables en caliente (`heartbeatFrames` 1–600…; en `HostRoom` el `maxWakeFrames` acepta cualquier número ≥ 1 y lo trunca) |
| `onPlayerJoin(player)`, `onPlayerLeave(player)`, `onPlayerKicked(player, reason, ban, byPlayer)`, `onRoomLink(link)`, `onBadActor(playerId, err)`, `onError(err)`, `onEventApplied(ev)`, `onPrivateViewEnd(id)`, `onBeforeOperation` | Callbacks del motor (`Player` es el modelo vivo, no el `PlayerObject`) |
| `emit(ev)`, `emitTo(ev, playerId)` | Emite un evento arbitrario como host / a un solo jugador |
| `sendChat`, `sendAnnouncement(msg, targetId, color=-1, style=0 numérico, sound=1)`, `setPlayerAdmin`, `setPlayerTeam`, `setPlayerAvatar`, `kickPlayer(id, reason='', ban=false)`, `clearBan`, `clearBans`, `setScoreLimit`, `setTimeLimit`, `setStadium(stadium)`, `setCustomStadium`, `setDefaultStadium`, `setTeamsLock`, `setTeamColors`, `setKickRateLimit(min=2, rate=0, burst=0)`, `startGame`, `stopGame`, `pauseGame`, `setDiscProperties`, `setPlayerDiscProperties`, `reorderPlayers`, `setPassword`, `setRequireRecaptcha`, `setMaxPlayers`, `startRecording`, `stopRecording`, `stopRecordingAsync` | Acciones (en `HostRoom` se aplican de forma síncrona, salvo desde dentro de un callback, donde se difieren al final del bucle; `HBInit` añade el *microtask* oficial). `clearBans()` aquí vacía **toda** la lista, a diferencia de `room.clearBans()` |
| `getPlayerList()`, `getPlayer(id)`, `getScores()`, `getBallPosition()`, `getDiscProperties(i)`, `getPlayerDiscProperties(id)`, `getDiscCount()`, `getConnection(id)` | Consultas (`getPlayer*` devuelven objetos `Player` vivos, no `PlayerObject`) |
| `setDiscPropertiesFor`, `clearDiscOverrides`, `hasPrivateView`, `getDiscPropertiesFor`, `setPlayerHiddenFor`, `isPlayerHiddenFor`, `getHiddenPlayersFor`, `batchPrivate(fn)` | Visuales privados y jugadores ocultos ([§2.6](#26-visuales-privados-y-jugadores-ocultos)) |

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

Peers: `Peer` tiene `id`, `conn`, `ip`, `srflxIps`, `ips` (todas las conocidas), `reverse`, `state`, `auth`, `info` (`{ name, flag, avatar }`), `remoteAddress`, `playerId` y `userData` (libres para ti). Motivos de cierre (`PeerCloseReason`): `'closed'`, `'timeout'`, `'flood'`, `'protocol'`, `'kicked'`, `'host'`, `'full'`, `'auth'`, `'banned'`, `'failed'`, `'shutdown'`.

Funciones sueltas del maestro: `fetchGeo(opts?)` → `{ flag, lat, lon }` y `fetchRoomList(opts?)` → `ListedRoom[]` (`{ id, info: RoomInfo }`), con `opts` = `{ masterUrl?, agent?, headers?, timeoutMs? }`; `shutdownWebRtc(timeoutMs = 5000)` para cerrar node-datachannel. `MasterError` (`kind`: `'recaptcha' | 'master' | 'http' | 'network' | 'invalid-response'`, `sitekey`, `status`).

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
```

| Export | Qué es |
|---|---|
| `readReplay(bytes): ReplayData` | Decodifica el fichero entero. `ReplayData`: `version` (3), `totalFrames`, `goalMarkers: { frame, team }[]`, `stateBytes`, `events: RoomEvent[]` (frames relativos al inicio) y `initialState()` |
| `writeReplay(data): Uint8Array` | `ReplayData` → `.hbr2` (para recortar o editar) |
| `ReplayPlayer` | `new ReplayPlayer(ReplayData \| Uint8Array)`; `rs` (estado actual), `frame`, `totalFrames`, `ended`, `hooks`, `onReset`, `onEvent`; `seek(frame)` (retrocede re-simulando desde el inicio), `step(n = 1)`, `reset()`, `applyCurrentFrameEvents()`, `finish()` |
| `ReplayRecorder` | Grabador que usa el host (`start(rs, frame, clock?)`, `onEvent`, `stop(frame)`, `stopAsync`, `snapshot`, `cancel`…); normalmente basta `room.startRecording()` |
| `replay.ReplayFormatError`, `replay.ReplayVersionError` | Fichero malformado / versión distinta de 3 (el segundo tiene `version`). En el espacio de nombres `replay`. Detalle en [`src/replay/README.md`](../src/replay/README.md) |

### Estadios

| Export | Qué es |
|---|---|
| `parseHbs(text): Stadium` | Parsea texto `.hbs` (JSON5) con la geometría derivada calculada. Lanza `HbsParseError` (o un `SyntaxError` de JSON5) en los mismos casos que el *parser* oficial. Lo que usa `room.setCustomStadium` |
| `HbsParseError` | Error del *parser* (`message` con el texto oficial) |
| `defaultStadiums(): readonly Stadium[]` | Los 10 estadios incorporados, **compartidos**: no los modifiques |
| `buildDefaultStadium(id): Stadium` | Copia privada del estadio incorporado `id` (0 Classic, 1 Easy, 2 Small, 3 Big, 4 Rounded, 5 Hockey, 6 Big Hockey, 7 Big Easy, 8 Big Rounded, 9 Huge) |

El formato `.hbs` y los mapas por defecto: [docs/03](03-fisica-y-estadios.md).

### `EdgeServer`

`EdgeServer` (raíz y espacio de nombres `edge`) implementa el gateway que oculta la IP; `edge.loadEdgeConfig` y `edge.generateEdgeKey` (solo en el espacio de nombres) cargan la configuración y generan claves. La CLI es `haxlite-edge` (`bin/haxlite-edge.js`). Configuración completa en [docs/09 §5](09-haxlite-edge.md).

---

## 6. Errores y códigos de cierre

### Errores de `HBInit` (promesa rechazada)

| Error | Cuándo | Notas |
|---|---|---|
| `InvalidRoomTokenError` | El maestro pide un captcha (token inválido o caducado) y no hay `haxlite.onRecaptcha` | Propiedad `sitekey: string \| null`. Mensaje: «Invalid room token. Generate a new token at https://www.haxball.com/headlesstoken.». Genera un token nuevo y vuelve a llamar |
| `TypeError` `Cannot cast … to String` / `to Int` | `roomName`, `playerName`, `password`, `token` que no son `string`; `maxPlayers` que no es entero | |
| `Error('Invalid country code')` | `geo.code` de más de 3 caracteres | |
| `RangeError` `haxlite.<opción> must be an integer in [min, max]` | `inputDelayFrames`, `heartbeatFrames`, `checksumIntervalFrames` o `maxWakeFrames` fuera de rango | Lo mismo al asignarlas luego en `room.haxlite` |
| `TypeError` `peerBackend must be 'ndc' or 'rtc'` | Valor inválido | |
| `Error` `peerBackend 'rtc': …` | `publicAddresses` vacío, con valores que no son IP, o solo IPv6 sin `ipv6`; `iceLite` sin dirección pública detectable; `sendBatchFrames` inválido; `cannot listen on UDP …` (el *bind* falló) | |
| `Error` `RtcEndpoint: iceTransportPolicy 'relay' needs …` | `iceTransportPolicy: 'relay'` sin un `turn:` UDP en `iceServers`, o con `iceLite` | |
| `MasterError` | Fallo de red/HTTP con el maestro durante el arranque (`kind`: `'network'`, `'http'`, `'master'`, `'invalid-response'`) | `kind: 'recaptcha'` no se rechaza: va por `onRecaptcha` |
| `EdgeError` | Clave inválida, versión incompatible o cuota del edge (`fatal: true`); los demás se reintentan hasta `initTimeoutMs` | Propiedades `kind` (`'auth' \| 'version' \| 'quota' \| 'protocol' \| 'connect' \| 'tunnel'`) y `fatal` |
| `Error('HBInit: no room link after N ms')` | No llegó el enlace en `initTimeoutMs` | |
| `Error('room stopped before initialization')` | Se llamó a `stop()` antes de terminar el arranque | |

En todos los casos de fallo en el arranque la sala se detiene sola.

### Errores síncronos de los métodos de `room`

`setCustomStadium` (mensaje del *parser*, con `cause`), `setDefaultStadium` (`Stadium doesn't exist`), `setPassword` y `setRequireRecaptcha` (*cast* de tipo → `TypeError`), `room.haxlite.bans.addIp/addRange` (`TypeError: invalid IP` / `invalid CIDR range`), asignaciones inválidas a las propiedades de netcode (`RangeError`).

### Errores posteriores al arranque

Van a `room.haxlite.onError(err)`: excepciones en tus callbacks, errores del transporte y de red, `EdgeError`, `MasterError`, `InvalidRoomTokenError` (si el maestro pide captcha y no hay `room.haxlite.onRecaptcha`) y los rechazos de visuales privados. Sin manejador se escriben con `console.error('[haxlite]', err)`.

### Códigos de cierre de la señalización (los ve el cliente)

| Código | Constante (`net.RejectCode`) | Significado en haxlite |
|---|---|---|
| `0` | `ParseError` | Oferta malformada |
| `4100` | `Full` | «The room is full.» (`maxPlayers` alcanzado) |
| `4101` | `WrongPassword` | Contraseña incorrecta |
| `4102` | `Banned` | «You are banned from this room.»: IP del maestro o *srflx* baneada, o `onJoinRequest` devolvió `false` |
| `4103` | `Version` | Versión del protocolo incompatible (la sala exige 9) |
| `4104` | `TooManyPending` | Demasiadas negociaciones pendientes (≥ 16), **o** `joinRateLimit` excedido (código por defecto), **o** el backend no está listo / el túnel del edge está caído, **o** `onJoinRequest` falló (lanzó o rechazó la promesa) |
| *n* | - | El que devuelva `onJoinRequest` (`n` o `{ reject: n }`) o `joinRateLimit.code` |

Códigos del servidor maestro (`net.MasterCloseCode`): `4001` sala cerrada (el host **no** reconecta) y `4004` el maestro exige un captcha al cliente. La señalización reconecta sola con retardo de 10–60 s tras cualquier otra caída (`transport: { reconnect: false }` lo evita).

Códigos del túnel host↔edge (`net.EdgeCloseCode`): `4400` protocolo, `4401` autenticación, `4402` versión, `4408` tiempo agotado, `4429` cuota, `4503` el edge se apaga.

### Expulsiones de un jugador ya conectado

| Motivo | Mensaje que ve el jugador | Notas |
|---|---|---|
| `allowNullAuth: false` y verificación fallida | «Identity verification failed» | `PeerCloseReason` `'auth'` |
| `auth` baneado (`bans.addAuth`) | «You are banned from this room.» | `'banned'` |
| Exceso de mensajes (`floodCapacity`), mensaje de texto o malformado, evento no permitido, excepción en `onPlayerChat`/`onBeforeOperation` | «Bad actor» | `'flood'`/`'protocol'`; se emite `onPlayerLeave` y `onPlayerKicked` |
| Sin mensajes durante `peerIdleTimeoutMs` (10 s) | - (conexión cerrada) | `'timeout'` |
| `kickPlayer(id, reason, ban)` | el `reason` indicado | Con `ban`, el cliente ve el baneo |
