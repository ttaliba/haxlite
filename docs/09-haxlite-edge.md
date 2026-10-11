# 09 — haxlite Edge: hostear sin exponer la IP del host

> **Qué es.** Un *gateway* WebRTC (`src/edge/`) que se instala en un servidor dedicado
> protegido. Los jugadores (cliente oficial, **sin modificar**) se conectan al edge; el host
> haxlite (en cualquier lugar, incluso una PC de casa detrás de NAT) solo abre conexiones
> **salientes** hacia el edge. Ningún SDP, candidato ICE ni paquete que reciba un jugador
> contiene la dirección del host.
>
> Contexto y alternativas: [08 — Ocultar y proteger la IP](08-ocultar-ip.md). Esto implementa
> el "algo delante" del nivel 3 de ese informe, pero sin TURN ni proxy UDP: el edge **termina**
> el WebRTC de los jugadores y reenvía solo los payloads de los data channels.

---

## 1. Arquitectura

```
 jugadores (cliente oficial)                       EDGE (IP pública, protegida)
 ┌──────────┐  WebRTC: ICE/DTLS/SCTP, 3 canales    ┌──────────────────────────────────┐
 │ browser  │═══ negociados ro / ru / uu ═════════▶│ PeerConnection por jugador       │
 └──────────┘                                       │ (node-datachannel, wrappers      │
      ▲ señalización (offer/answer/candidatos)      │  crash-safe de src/net/webrtc)   │
      │                                             │ flood por jugador, cuotas por key│
 ┌────┴──────────────┐                              └──────────────┬───────────────────┘
 │ master haxball.com│◀── WS de señalización ──┐        túnel      │ (el host se conecta
 └───────────────────┘   (token, sala, offers) │  ┌───────────────┘  hacia AFUERA)
                                               │  │ control: WebSocket (wss) autenticado (HMAC)
                                         ┌─────┴──▼──────────────────────────────┐
                                         │ host haxlite (detrás de NAT, sin       │
                                         │ sockets hacia jugadores): HostRoom,    │
                                         │ HostTransport + EdgePeerBackend        │
                                         └────────────────────────────────────────┘
                                            datos: 1 PeerConnection host↔edge con 3 canales
                                            (ro/ru/uu) multiplexando a todos los jugadores,
                                            o el mismo WebSocket si el UDP está bloqueado
```

Reparto de responsabilidades:

| | Host haxlite | Edge |
|---|---|---|
| Token y WS con el master (`p2p.haxball.com`) | **sí** (sin cambios) | no |
| Admisión previa a WebRTC (4100–4104, bans por IP/conn/srflx, contraseña, `onJoinRequest`) | **sí** | no |
| PeerConnection del jugador, ICE/DTLS/SCTP, `iceCandidatePolicy` | no | **sí** |
| Challenge + verificación de identidad (ECDSA), `auth`, bans por auth | **sí** | no (no entiende el protocolo del juego) |
| Lógica de juego, secuenciador, kicks, "Bad actor" | **sí** | no |
| Límite de flood por jugador | sí (paridad oficial) | **sí, antes del túnel**: avisa al host, que expulsa con "Bad actor" |
| Timeouts (canal 0 en 10 s, inactividad 10 s) | sí | limpieza propia (15 s) |

El edge es **agnóstico del juego**: mueve payloads por `(slot del jugador, canal)` en ambos
sentidos y reporta el ciclo de vida del jugador (canal abierto/cerrado, fallo, flood) y la
dirección remota del par ICE elegido (`getSelectedCandidatePair`).

### 1.1 Flujo de una entrada

1. El master le pasa la *offer* del jugador al host (como siempre). El host aplica **todas** las
   comprobaciones oficiales sin crear nada de WebRTC.
2. El host manda `PeerOpen{slot, sdp}` por el túnel. El edge crea la PeerConnection (3 canales
   negociados, mismas opciones que el host directo) y devuelve `PeerAnswer` (SDP ya filtrado con
   la política del edge) y sus candidatos (`PeerLocalCandidate`, `PeerGathered`).
3. El host reenvía answer y candidatos al master **exactamente como hoy** (espera ≤ 500 ms a
   que termine la recolección, `[0][peer]` al final). Los candidatos que el jugador manda después
   (`[4]`) el host los registra (IPs srflx para bans) y los reenvía al edge
   (`PeerRemoteCandidate`, con el retraso de 2,5 s de las conexiones "reverse").
4. Cuando el canal 0 abre en el edge, este manda `PeerChannelOpen` **en banda** (por el canal
   `ro` del túnel, ordenado antes del primer mensaje del jugador). El host envía el challenge,
   verifica el handshake y sigue igual que con un jugador directo.

### 1.2 Protocolo del túnel (versión 1)

Definido en `src/net/edge-protocol.ts`. Mensajes binarios `[u8 tipo]…`; strings con la
codificación del códec (`varuint` + UTF-8).

* **Control (WebSocket, una conexión por sala):** el edge saluda `Hello[u8 versión][nonce 32 B]`;
  el host responde `Auth[u8 versión][keyId][HMAC-SHA256(secret, "haxlite-edge/1" ‖ nonce)][flags]`;
  el edge compara en tiempo constante (`timingSafeEqual`; un keyId desconocido también cuesta un
  HMAC) y contesta `AuthOk[u32 sesión][u16 máx. jugadores][flags]`. El secreto nunca viaja.
* **Datos:** `flags & 1` → una PeerConnection host↔edge con 3 canales negociados que replican la
  fiabilidad de `ro`/`ru`/`uu` (el canal del túnel **es** el canal del jugador). Trama:
  `[u16 slot][payload]` — 2 bytes de overhead. `slot = 0` lleva un mensaje de control en banda.
  Sin el flag (o como *fallback*), todo va por el WebSocket: `[0x70+canal][u16 slot][payload]`.
* **Carriles `ro` (`flags & 2`, `AuthFlag.RoLanes`):** el host lo pide en `Auth` y el edge lo
  confirma en `AuthOk`. Entonces el tráfico `ro` de los jugadores (¡los clientes mandan **todos**
  sus eventos/inputs por `ro`!) se reparte en 16 canales ordenados del túnel según `slot % 16`
  (carril 0 = canal 0, carril k = canal 2 + k): una pérdida en el tramo host↔edge solo retrasa el
  `ro` de los jugadores de ese carril, no el de todos. El orden por jugador se mantiene: todo el
  `ro` de un slot y su control en banda (`PeerChannelOpen`/`PeerClosed`/`PeerClose`) van por su
  carril; un multicast `ro` sale como un mensaje por carril en uso. Un host o un edge que no
  conocen el flag siguen con el canal `ro` único (interoperan en ambos sentidos).
* **Multicast:** las difusiones del host (eventos, heartbeats, CheckConsistency) salen como **un**
  mensaje `[0][0][0x40][canal][n][slot × n][payload]` en vez de uno por jugador: la subida del
  host no crece con el número de jugadores.
* Señalización del túnel (offer/answer/candidatos de la PeerConnection host↔edge) por el
  WebSocket, o sea, **solo con el edge**. El host retiene sus candidatos hasta aplicar la answer
  (evita la carrera DTLS de libdatachannel en loopback).
* Liveness: el edge hace `ping` de WebSocket cada 10 s (dos sin respuesta = sesión muerta); el
  host manda `Ping` de aplicación cada 5 s (mide el RTT del túnel) y da el túnel por caído si en
  15 s no llegó nada.

Por qué UDP para los datos: sin *head-of-line blocking* TCP para `uu`/`ru` (inputs y heartbeats
no esperan retransmisiones de otros), y el host atraviesa su NAT con una conexión saliente (el
edge tiene IP pública; los candidatos del host ni siquiera hacen falta: el edge lo aprende como
*peer-reflexive*).

## 2. Uso desde el host

```js
const room = await HBInit({
  roomName: 'Mi sala', maxPlayers: 16, public: true, noPlayer: true, token,
  haxlite: {
    edge: {
      url: 'wss://edge.midominio.com:8443/tunnel',
      key: 'alice:9fH3…',        // la entrega el operador del edge
      // fallbackWs: true,       // (por defecto) si el UDP al edge está bloqueado, todo por el WS
      // dataPlane: 'ws',        // forzar el WS desde el principio
    },
  },
});
room.haxlite.onBackendState = (state, err) => console.log('edge', state, err?.message);
setInterval(() => console.log(room.haxlite.edgeStats()), 60_000);
```

Con `HostTransport` directamente: `new HostTransport({ token, edge: { url, key } })` (o
`backend:` para un backend propio). `HostRoom` y la fachada `HBInit` no cambian.

| Opción (`haxlite.edge`) | Por defecto | |
|---|---|---|
| `url` | — | `wss://host:puerto/tunnel` (`ws://` solo para pruebas/LAN) |
| `key` | — | `"<keyId>:<secret>"` |
| `roLanes` | `true` | pedir los carriles `ro` (§1.2); `false` = un solo canal `ro` en el túnel |
| `fallbackWs` | `true` | si la PeerConnection de datos no sube en `dataPlaneTimeoutMs`, reconecta con todo por el WebSocket (queda en WS hasta reiniciar la sala) |
| `dataPlane` | `'webrtc'` | `'ws'` para forzar el WebSocket |
| `bindAddress` | — | dirección local para el WS y la PeerConnection del túnel |
| `iceServers` | ninguno | STUN/TURN de la PeerConnection del túnel (normalmente innecesario) |
| `portRange` | — | puertos UDP locales del túnel |
| `connectTimeoutMs` / `dataPlaneTimeoutMs` | 10 s / 5 s | |
| `reconnectMinMs` / `reconnectMaxMs` | 250 ms / 10 s | backoff exponencial; tras una caída el primer reintento es inmediato |
| `pingIntervalMs` / `pingTimeoutMs` | 5 s / 15 s | |
| `wsOptions` | — | opciones del cliente `ws` (p. ej. `ca` para un certificado propio) |

Comportamiento:

* **Arranque:** el host **no** registra la sala en el master hasta que el túnel está listo. Una
  clave inválida o una versión de protocolo incompatible es un `EdgeError` *fatal* y `HBInit`
  rechaza enseguida; los errores de red se reintentan hasta `initTimeoutMs`.
* **Caída del túnel:** los jugadores conectados se pierden (el cliente oficial no puede
  reconectarse ni renegociar), se emiten sus `onPlayerLeave` y `onBackendState('down')`; el host
  reintenta enseguida y con backoff. Mientras tanto las entradas se rechazan con 4104. La sala
  (link, estado, bans) sigue viva; al volver: `onBackendState('ready')`.
* `iceServers`, `iceCandidatePolicy` y `portRange` del host **no se usan** con edge: el host no
  crea PeerConnections de jugadores (el test E2E lo verifica).
* `getPlayerConnection(id).remoteAddress`: dirección del jugador **vista por el edge** (la que
  usa el par ICE elegido). Los bans oficiales siguen siendo por `conn` + srflx (llegan por el
  master), igual que sin edge.

## 3. Despliegue del edge en un servidor dedicado

Requisitos: Node ≥ 22, una IP pública (idealmente con mitigación DDoS aguas arriba, ver
[08 §3 nivel 2](08-ocultar-ip.md)), un nombre DNS para el certificado TLS.

```sh
git clone … haxlite && cd haxlite && npm ci && npm run build
# una clave por host (o por cliente del servicio)
node bin/haxlite-edge.js genkey alice
#   host config  : haxlite: { edge: { url: 'wss://<edge>:8443/tunnel', key: 'alice:…' } }
#   edge keys    : { "id": "alice", "secret": "…" }
```

`/etc/haxlite-edge/config.json`:

```json
{
  "listen": { "host": "0.0.0.0", "port": 8443, "path": "/tunnel" },
  "tls": {
    "certFile": "/etc/letsencrypt/live/edge.midominio.com/fullchain.pem",
    "keyFile": "/etc/letsencrypt/live/edge.midominio.com/privkey.pem"
  },
  "keysFile": "/etc/haxlite-edge/keys.txt",
  "webrtc": {
    "bindAddress": "203.0.113.10",
    "portRange": [40000, 40999],
    "iceCandidatePolicy": "public",
    "remoteCandidatePolicy": "public"
  },
  "limits": { "maxPeersPerSession": 40, "maxPeersPerKey": 256, "maxSessionsPerKey": 16 },
  "stats": { "path": "/stats", "token": "cambiar-esto", "logIntervalMs": 60000 }
}
```

`/etc/haxlite-edge/keys.txt` (permisos 600; una por línea, `#` comenta):

```
alice:9fH3…
bob:Qm81…
```

Unidad systemd (`/etc/systemd/system/haxlite-edge.service`):

```ini
[Unit]
Description=haxlite Edge (WebRTC gateway)
After=network-online.target
Wants=network-online.target

[Service]
User=haxlite
Group=haxlite
WorkingDirectory=/opt/haxlite
ExecStart=/usr/bin/node /opt/haxlite/bin/haxlite-edge.js --config /etc/haxlite-edge/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=2
# puerto < 1024 sin root: AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/etc/haxlite-edge
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

* TLS: el usuario `haxlite` tiene que poder leer los PEM (p. ej. un *deploy hook* de certbot que
  los copie a `/etc/haxlite-edge/` con el grupo correcto y haga `systemctl reload haxlite-edge`;
  **SIGHUP recarga el certificado** sin cortar túneles). Alternativa: terminar TLS en nginx/caddy
  con `proxy_pass` de WebSocket a `127.0.0.1:8443` (solo el control; el UDP no pasa por ahí).
* SIGINT/SIGTERM cierran todos los túneles con 4503; los hosts reconectan solos (al reiniciar el
  edge se pierden los jugadores conectados).
* Desarrollo, sin compilar: `npm run edge -- --config edge.json` o
  `HAXLITE_EDGE_KEYS=alice:… npm run edge`.

### 3.1 Firewall y haxguard

**Edge** (IP pública):

| Tráfico | Regla |
|---|---|
| TCP 8443 (control) | abierto (autenticado con HMAC); si los hosts tienen IP fija, mejor solo desde ellas. Rate-limit de conexiones nuevas (`ct state new limit rate 20/second`) |
| UDP `portRange` (40000–40999) | jugadores **y** túneles de datos. Es el `ROOM_PORTS` de [`ops/haxguard/haxguard.nft`](../ops/haxguard/haxguard.nft): descartar fragmentos, puertos origen < 1024 y reflectores, aceptar STUN con límite por origen |
| `GET /stats` | ponerle `stats.token` o no exponerlo (bind privado / firewall) |

Con `enableIceUdpMux: true` todas las PeerConnections comparten `portRange[0]` (un solo puerto
para filtrar, como en haxguard); sin mux, una por conexión (permite la atribución por puerto de
08 §3).

**Host** (casa / VPS): **no necesita ningún puerto entrante**. Recomendado: firewall de salida que
solo permita UDP hacia la IP del edge (más DNS y HTTPS/WSS al master). Así ni un error de
configuración puede hacer que el host le hable directo a un jugador:

```
# nftables en el host (ejemplo)
table inet hostout {
  chain out {
    type filter hook output priority 0; policy accept;
    udp dport 53 accept
    ip daddr 203.0.113.10 accept          # el edge
    meta l4proto udp drop                 # ningún otro UDP sale
  }
}
```

Varias salas en un mismo host = varias sesiones de túnel con la misma clave (cuota
`maxSessionsPerKey`). Varios edges (por región): cada sala elige su `url`.

## 4. Modelo de seguridad

* **La IP del host nunca llega a un jugador.** Los jugadores solo intercambian SDP/candidatos con
  PeerConnections del edge; el edge filtra **sus propias** direcciones con
  `iceCandidatePolicy` (por defecto `'public'`: ni LAN ni loopback) y jamás pone una dirección del
  host en nada que envíe (la conoce solo como origen del WS y del túnel). El test E2E liga el edge
  a 127.0.0.2 y el host a 127.0.0.3 y comprueba que **todo** lo que reciben los clientes
  (answers, candidatos en el SDP y *trickle*) nombra solo 127.0.0.2, que 127.0.0.3 no aparece en
  ningún byte, y que el par ICE elegido de cada cliente apunta al edge.
* **Lo que el host le deja ver al master** no cambia: el master ya veía la IP del host (WS de
  señalización) y nunca la reenvía a los clientes.
* **Autenticación de hosts:** clave por host/tenant, desafío-respuesta HMAC-SHA256 con nonce de
  32 B por conexión, comparación en tiempo constante, IDs desconocidos indistinguibles por
  tiempo. Usar `wss://` en producción: sin TLS el HMAC protege la clave pero no la sesión.
* **Un host malicioso no puede convertir el edge en un cañón:** cada entrada se valida (tamaños de
  SDP/candidato/mid, slots, longitudes de string; un mensaje malformado cierra la sesión con 4400).
  Los candidatos remotos (de jugadores y del túnel) pasan por `remoteCandidatePolicy` (por
  defecto `'public'`: el edge no envía checks a loopback/LAN/reservadas, y las conexiones igual
  suben por *peer-reflexive*), máximo 32 por conexión. Lo único que un host puede provocar es lo
  que provocaría un navegador cualquiera: binding requests STUN (sin amplificación) hacia
  direcciones públicas que él elija, acotadas por las cuotas.
* **Cuotas:** sesiones totales (`maxSessions`), por clave (`maxSessionsPerKey` / `maxSessions` de
  la clave), jugadores por sala y por clave, negociaciones simultáneas por sala (16, como el
  4104 oficial) y ritmo de `PeerOpen` (ráfaga 30, 1 cada 100 ms). Excederlas devuelve
  `PeerClosed(Limit)` (el host lo trata como negociación fallida) o cierra con 4429.
* **Flood de jugadores:** *token bucket* oficial (100, 1/16 ms) por jugador **en el edge**: el
  exceso no llega al túnel; el edge cierra al jugador y avisa `PeerClosed(Flood)`, y el host lo
  expulsa con "Bad actor" (misma semántica que el host oficial; el host conserva además su propio
  bucket). Un mensaje de texto (no binario) → `PeerClosed(Protocol)` → "Bad actor".
* **Aislamiento entre tenants:** cada sesión solo ve sus slots; las estadísticas son por clave.

Lo que el edge **no** resuelve: un ataque volumétrico contra el edge (para eso, hosting con
mitigación aguas arriba + haxguard), ni la atribución de filtraciones (la IP del edge es pública
por diseño; con un /64 IPv6 en el edge se puede seguir aplicando el "canary" de 08 §3).

## 5. Referencia de configuración del edge

JSON (`--config` o `HAXLITE_EDGE_CONFIG`) + variables de entorno (ganan): `HAXLITE_EDGE_HOST`,
`HAXLITE_EDGE_PORT`, `HAXLITE_EDGE_KEYS` (`id:secret,id2:secret2`), `HAXLITE_EDGE_KEYS_FILE`,
`HAXLITE_EDGE_TLS_CERT`/`HAXLITE_EDGE_TLS_KEY`, `HAXLITE_EDGE_BIND`, `HAXLITE_EDGE_PORT_RANGE`
(`40000-40999`), `HAXLITE_EDGE_STATS_TOKEN`, `HAXLITE_EDGE_LOG_INTERVAL_MS`. Programático:
`new EdgeServer(opts)` / `EdgeServer.start(opts)` de `src/edge`.

| Clave | Por defecto | |
|---|---|---|
| `listen.host` / `listen.port` / `listen.path` | `0.0.0.0` / 8443 / `/tunnel` | endpoint WS de control |
| `tls.certFile` / `tls.keyFile` | — | PEM → `wss://`; SIGHUP recarga |
| `keys[]` | — | `{id, secret (≥ 16 caracteres), maxSessions?, maxPeers?, label?}` |
| `keysFile` | — | JSON (array) o `id:secret` por línea |
| `webrtc.bindAddress` | todas | dirección local (y anunciada) de las PeerConnections |
| `webrtc.portRange` | efímeros | rango UDP de jugadores y túneles |
| `webrtc.enableIceUdpMux` | false | todas las conexiones en un puerto (en el edge **no** ahorra CPU: +6 % medido, §7.1; el host sí lo usa por defecto) |
| `webrtc.iceServers` | STUN de Google | para descubrir la IP pública detrás de NAT 1:1 (nubes con IP privada) |
| `webrtc.iceCandidatePolicy` | `'public'` | candidatos propios anunciados (`'all'` solo para pruebas en loopback) |
| `webrtc.remoteCandidatePolicy` | `'public'` | candidatos remotos aceptados (`'private'`/`'all'` para LAN/pruebas) |
| `webrtc.rtc` | — | extras de node-datachannel para las conexiones de jugadores (`mtu`, `maxMessageSize`…) |
| `limits.maxSessions` | 1000 | túneles simultáneos |
| `limits.maxSessionsPerKey` / `maxPeersPerKey` | 16 / 256 | cuotas por defecto de cada clave |
| `limits.maxPeersPerSession` | 40 | jugadores por sala |
| `limits.maxPendingPerSession` | 16 | negociaciones en curso por sala |
| `limits.peerOpenCapacity` / `peerOpenMsPerToken` | 30 / 100 | ritmo de entradas por sala |
| `limits.floodCapacity` / `floodMsPerToken` | 100 / 16 | bucket por jugador (oficial) |
| `limits.channelOpenTimeoutMs` | 15 000 | limpieza de negociaciones colgadas |
| `limits.authTimeoutMs` / `dataPlaneTimeoutMs` | 5 000 / 15 000 | |
| `limits.keepAliveMs` | 10 000 | ping WS a los hosts |
| `limits.allowWsDataPlane` | true | aceptar túneles con los datos por WebSocket |
| `stats.path` / `stats.token` / `stats.logIntervalMs` | `/stats` / — / 60 000 | JSON por HTTP(S) y línea de log periódica |

`GET /stats` (con `Authorization: Bearer <token>` si hay token) devuelve sesiones, jugadores,
fallos de autenticación, por clave `{sessions, peers, bytesIn/Out, messagesIn/Out, ppsIn/Out,
floods}` (pps desde la consulta anterior), objetos nativos vivos y RSS. Del lado del host:
`room.haxlite.edgeStats()` → `{state, dataPlane, sessionId, rttMs, peers, sessions, bytes/messages
In/Out}`.

## 6. Límites y decisiones

* *Head-of-line* en el túnel: los clientes oficiales mandan **todos** sus eventos (inputs, chat)
  por `ro`, así que con un único canal `ro` en el túnel una pérdida en el tramo host↔edge frenaba
  los inputs de **todos** los jugadores hasta la retransmisión. Con los carriles `ro` (§1.2, por
  defecto) solo se frena el carril del paquete perdido (≈ 1/16 de los jugadores): con 2–5 % de
  pérdida en el túnel el RTT medio por `ro` baja a la mitad del exceso (§7.1). Eventos del host
  (`ru`) y heartbeats (`uu`) nunca sufren HOL. Con el *fallback* WebSocket todo es TCP (HOL
  total): usarlo solo si el UDP está bloqueado.
* Sin *batching* de mensajes chicos: cada mensaje de jugador es un mensaje de túnel (+2 bytes).
  Agruparlos añadiría latencia y las mediciones (§7) no lo justifican; el multicast ya elimina el
  caso caro (difusiones).
* Asignación de slots monótona (u16, se reutiliza tras 65 535 entradas): un cierre en vuelo nunca
  se confunde con una entrada nueva.
* Si el edge se reinicia o el túnel cae, los jugadores se pierden (limitación del cliente oficial).
* El edge no aplica límites de ancho de banda por clave (solo cuotas de conexiones y flood por
  jugador); las estadísticas por clave permiten detectar abusos.
* Cero asignaciones por mensaje en los caminos calientes salvo las inevitables (el `Buffer` que
  entrega node-datachannel por mensaje recibido y la vista `subarray`): los encabezados se
  escriben en un buffer *scratch* reutilizado (node-datachannel copia de forma síncrona). Quitar
  el encabezado es una vista (`subarray`), el multicast entrega **la misma** vista del payload a
  cada jugador y se parsea en el sitio (sin `Reader`). Anteponer el slot en el sentido
  jugador→host cuesta una copia del payload al *scratch* (no hay espacio previo en el `Buffer` que
  entrega node-datachannel); son decenas de bytes.
* Sin temporizadores en vacío: el ping de keep-alive a los hosts (10 s) solo corre mientras hay
  sesiones; el barrido de negociaciones colgadas (1 s) solo mientras hay alguna negociación
  pendiente. Un edge sin sesiones no despierta nunca (y libera los hilos nativos de libdatachannel
  15 s después de cerrar su última PeerConnection, ver `setWebRtcIdleRelease`).

## 7. Overhead medido (loopback)

`scripts/edge-latency.ts` (procesos separados: clientes + master / host / edge; carga de
"jugador ocupado" de bench/net: un cambio de teclas cada 60–250 ms por jugador, partido en
curso; sonda RTT con el mensaje Ping del cliente cada 50 ms, alternando `ro` y `uu`; el Pong
vuelve por `uu`):

```sh
node --experimental-transform-types --no-warnings --import ./scripts/ts-resolve.mjs \
     scripts/edge-latency.ts --players 8 --seconds 20 --runs 2
```

Medido en el contenedor de desarrollo (Linux, Node 22.22, loopback; edge en 127.0.0.2, túnel del
host en 127.0.0.3). "CPU %" = tiempo de CPU del proceso (todos sus hilos, incluidos los de
libdatachannel) / tiempo real; "por jugador" = dividido por los jugadores conectados (carga + sonda).
~200 muestras de RTT por canal y corrida.

**9 jugadores** (8 de carga + sonda), 2 corridas de 20 s:

| Modo | RTT `ro` p50 / p99 (ms) | RTT `uu` p50 / p99 (ms) | CPU host (% total) | CPU host %/jugador | CPU edge %/jugador |
|---|---|---|---|---|---|
| directo (sin edge) | 1,03 / 2,81 · 1,05 / 3,04 | 1,00 / 4,07 · 1,04 / 3,11 | 10,5 · 10,8 | 1,17 · 1,20 | — |
| edge, datos por UDP (PeerConnection) | 1,69 / 5,85 · 1,64 / 5,79 | 1,73 / 4,16 · 1,72 / 4,09 | 6,3 · 6,1 | 0,70 · 0,68 | 1,26 · 1,22 |
| edge, datos por WebSocket (*fallback*) | 1,61 / 5,08 · 1,69 / 3,13 | 1,62 / 8,02 · 1,68 / 3,49 | 5,0 · 5,2 | 0,56 · 0,58 | 1,23 · 1,30 |

**17 jugadores** (16 + sonda), 1 corrida de 20 s:

| Modo | RTT `ro` p50 / p99 (ms) | RTT `uu` p50 / p99 (ms) | CPU host (% total) | CPU host %/jugador | CPU edge %/jugador |
|---|---|---|---|---|---|
| directo | 1,02 / 3,67 | 1,00 / 2,37 | 19,4 | 1,14 | — |
| edge (UDP) | 1,68 / 4,53 | 1,70 / 6,63 | 8,1 | 0,48 | 1,24 |
| edge (WS) | 1,56 / 3,53 | 1,50 / 3,99 | 6,4 | 0,38 | 1,18 |

Ninguna corrida perdió pings (`lost: 0`).

* **Latencia agregada por el edge: ≈ +0,65 ms en la mediana** (≈ 1,0 → 1,7 ms de ida y vuelta
  completa) y +1–3 ms en el p99, en el mismo equipo. Es el costo de un salto extra con dos
  pasadas por el event loop de Node (hilo de libdatachannel → JS → hilo de libdatachannel) en el
  edge y una en el host; el RTT directo de ~1 ms en loopback ya es casi todo eso mismo.
* **CPU del host: −40 % con 9 jugadores, −58 % con 17**, y el costo por jugador *baja* al subir
  jugadores (multicast + una sola sesión DTLS/SCTP). El edge gasta ≈ 1,2 % de un núcleo por
  jugador (≈ lo que gastaba el host directo: es el WebRTC de los jugadores que se mudó ahí).
* En loopback el WebSocket rinde igual o mejor que el UDP (sin pérdidas, TCP no paga nada); con
  pérdida real en el tramo host↔edge el UDP evita el *head-of-line blocking* de `ru`/`uu`, por eso
  es el modo por defecto.

Lectura:

* **Latencia:** el edge agrega un salto en el mismo equipo (SCTP/DTLS extra + dos pasadas por el
  event loop de Node); en producción se suma además el tramo de red host↔edge, que conviene
  minimizar eligiendo un edge en la misma ciudad/proveedor que el host (o que los jugadores, si
  el host está lejos: el camino jugador→edge→host puede incluso ser mejor que el directo).
* **CPU del host:** baja, porque el host ya no hace DTLS/SCTP por jugador (una sola conexión con
  el edge) y las difusiones salen una vez (multicast). El costo se traslada al edge, que es
  donde están los recursos.

### 7.1 Pasada de ligereza (red) y pérdida en el túnel

Detalle y comandos en [07 «Pasada de ligereza — red»](07-benchmarks.md#pasada-de-ligereza--red-srcnet-srcedge).

* **Pérdida en el tramo host↔edge** (`--loss`, regla nftables solo sobre el UDP 127.0.0.2↔127.0.0.3;
  17 jugadores, 2 × 40 s por configuración):

  | pérdida | RTT `ro` media (ms): 1 canal `ro` → carriles | RTT `ro` p99 (ms) | RTT `uu` media (ms) |
  |---|---|---|---|
  | 2 % | 2,79 · 2,31 → **2,09 · 2,02** | 37,3 · 36,9 → 26,8 · 24,7 | 1,73 · 1,53 → 1,65 · 1,60 |
  | 5 % | 4,94 · 4,80 → **3,24 · 3,34** | 40,9 · 53,2 → 46,4 · 43,0 | 1,82 · 1,77 → 1,60 · 1,52 |

  El exceso medio de `ro` sobre `uu` baja a la mitad; el p99 lo siguen dominando las pérdidas de
  los propios paquetes de la sonda.
* **Sin pérdida** (9 jugadores, 3 × 20 s intercaladas, mediana): CPU host 4,86 → 4,72 %, CPU edge
  10,06 → 9,68 % (1,12 → 1,08 %/jugador, dentro del ruido), RTT `ro` p50 1,58 → 1,44 ms. Los
  carriles no cuestan CPU (sin carriles: 4,64 / 9,83 %).
* **`enableIceUdpMux` en el edge**: 17 jugadores, 3 × 30 s: CPU edge 17,0 → 18,1 % y RTT +0,1–0,2 ms;
  queda desactivado por defecto (en el host directo sí ahorra, ver docs/07).
* En vacío el edge no despierta: keep-alive y barrido solo con sesiones/negociaciones, y los hilos
  nativos se liberan 15 s después de la última PeerConnection.
