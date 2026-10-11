# 09 — haxlite Edge: hostear sin exponer la IP del host

> **Qué es.** Un *gateway* WebRTC (`src/edge/`) que se instala en un servidor dedicado
> protegido. Los jugadores (cliente oficial, **sin modificar**) se conectan al edge; el host
> haxlite (en cualquier lugar, incluso una PC de casa detrás de NAT) solo abre conexiones
> **salientes** hacia el edge. Ningún SDP, candidato ICE ni paquete que reciba un jugador
> contiene la dirección del host.
>
> Desde la versión 2 del túnel **ni el edge ni el host necesitan addons nativos**: los jugadores
> se atienden con haxlite-rtc ([doc 10](10-haxlite-rtc.md): ICE-lite + DTLS 1.2 + SCTP en
> TypeScript, un único puerto UDP) y el plano de datos host↔edge es nuestra propia asociación
> SCTP sobre datagramas UDP cifrados con AES-128-GCM (§1.3). node-datachannel queda como opción
> (`playerBackend: 'ndc'`, `dataPlane: 'webrtc'`) y solo se carga si se usa.
>
> Contexto y alternativas: [08 — Ocultar y proteger la IP](08-ocultar-ip.md). Esto implementa
> el "algo delante" del nivel 3 de ese informe, pero sin TURN ni proxy UDP: el edge **termina**
> el WebRTC de los jugadores y reenvía solo los payloads de los data channels.

---

## 1. Arquitectura

```
 jugadores (cliente oficial)                        EDGE (IP pública, protegida)
 ┌──────────┐  WebRTC: ICE/DTLS/SCTP, 3 canales     ┌────────────────────────────────────┐
 │ browser  │═══ negociados ro / ru / uu ══════════▶│ haxlite-rtc: ICE-lite, 1 socket UDP │
 └──────────┘   (UDP :40000, un puerto para todos)  │ para todos los jugadores            │
      ▲ señalización (offer/answer/candidatos)      │ flood por jugador, cuotas por key   │
      │                                             └──────────────┬──────────────────────┘
 ┌────┴──────────────┐                                     túnel   │ (el host se conecta
 │ master haxball.com│◀── WS de señalización ──┐  ┌───────────────┘  hacia AFUERA)
 └───────────────────┘   (token, sala, offers) │  │ control: WebSocket (wss, TCP :8443), HMAC + x25519
                                               │  │ datos:   SCTP sobre UDP+AES-128-GCM (UDP :8443)
                                         ┌─────┴──▼──────────────────────────────┐
                                         │ host haxlite (detrás de NAT, sin       │
                                         │ sockets hacia jugadores): HostRoom,    │
                                         │ HostTransport + EdgePeerBackend        │
                                         └────────────────────────────────────────┘
                                   todos los jugadores de la sala multiplexados en UNA
                                   asociación SCTP (streams = canales), o el mismo
                                   WebSocket si el UDP está bloqueado
```

Reparto de responsabilidades:

| | Host haxlite | Edge |
|---|---|---|
| Token y WS con el master (`p2p.haxball.com`) | **sí** (sin cambios) | no |
| Admisión previa a WebRTC (4100–4104, bans por IP/conn/srflx, contraseña, `onJoinRequest`) | **sí** | no |
| Conexión WebRTC del jugador (ICE-lite/DTLS/SCTP), direcciones anunciadas | no | **sí** |
| Challenge + verificación de identidad (ECDSA), `auth`, bans por auth | **sí** | no (no entiende el protocolo del juego) |
| Lógica de juego, secuenciador, kicks, "Bad actor" | **sí** | no |
| Límite de flood por jugador | sí (paridad oficial) | **sí, antes del túnel**: avisa al host, que expulsa con "Bad actor" |
| Timeouts (canal 0 en 10 s, inactividad 10 s) | sí | limpieza propia (15 s) y consentimiento ICE (30 s) |

El edge es **agnóstico del juego**: mueve payloads por `(slot del jugador, canal)` en ambos
sentidos y reporta el ciclo de vida del jugador (canal abierto/cerrado, fallo, flood) y la
dirección remota del jugador (la del par nominado por ICE; las IPs srflx para bans las sigue
sacando el host de la *offer* y de los candidatos que llegan por el master, como siempre).

Dos *backends* de jugadores (`playerBackend`):

| | `'rtc'` (por defecto) | `'ndc'` |
|---|---|---|
| Implementación | haxlite-rtc (`src/rtc`, TypeScript puro) | node-datachannel / libdatachannel (addon nativo) |
| Puertos UDP | **uno** para todos los jugadores (`webrtc.port`) | uno por PeerConnection (`portRange`), o uno con `enableIceUdpMux` |
| ICE | *lite*: el edge solo contesta Binding requests autenticados; **nunca** envía comprobaciones | completo (envía checks a los candidatos remotos permitidos por `remoteCandidatePolicy`) |
| Direcciones anunciadas | exactamente `webrtc.publicAddresses` | las que descubre libjuice, filtradas por `iceCandidatePolicy` |
| Detrás de NAT | solo NAT 1:1 con `publicAddresses` (+ `publicPort`) | STUN (`iceServers`) |
| CPU del edge (17 jugadores, §7, con el túnel v2) | **−29 %** por jugador | referencia |

### 1.1 Flujo de una entrada

1. El master le pasa la *offer* del jugador al host (como siempre). El host aplica **todas** las
   comprobaciones oficiales sin crear nada de WebRTC.
2. El host manda `PeerOpen{slot, sdp}` por el túnel. El edge crea la conexión (3 canales
   negociados) y devuelve `PeerAnswer` (SDP ya filtrado con la política del edge), sus
   candidatos (`PeerLocalCandidate`) y `PeerGathered`. Con haxlite-rtc todo sale en el acto: la
   respuesta ya trae los candidatos (`a=end-of-candidates`).
3. El host reenvía answer y candidatos al master **exactamente como hoy** (espera ≤ 500 ms a
   que termine la recolección, `[0][peer]` al final). Los candidatos que el jugador manda después
   (`[4]`) el host los registra (IPs srflx para bans) y los reenvía al edge
   (`PeerRemoteCandidate`, con el retraso de 2,5 s de las conexiones "reverse"); con ICE-lite
   son solo una pista (el navegador es quien comprueba; el edge aprende su dirección como
   *peer-reflexive* del primer Binding autenticado).
4. Cuando el canal 0 abre en el edge, este manda `PeerChannelOpen` **en banda** (por el canal
   `ro` del túnel, ordenado antes del primer mensaje del jugador). El host envía el challenge,
   verifica el handshake y sigue igual que con un jugador directo.

### 1.2 Protocolo del túnel (versiones 1 y 2)

Definido en `src/net/edge-protocol.ts`. Mensajes binarios `[u8 tipo]…`; strings con la
codificación del códec (`varuint` + UTF-8).

**Control (WebSocket, una conexión por sala):**

```
edge → host  Hello    [u8 1][32 B nonce][u8 versiónMáx = 2]      (un host v1 ignora el último byte)
host → edge  Auth v2  [u8 2][string keyId][32 B mac2][u8 flags][32 B x25519 hostPub  si flags & Udp]
             mac2 = HMAC-SHA256(secret, "haxlite-edge/2" ‖ nonce ‖ u8 flags ‖ hostPub)
host → edge  Auth v1  [u8 1][string keyId][32 B HMAC-SHA256(secret, "haxlite-edge/1" ‖ nonce)][u8 flags]
edge → host  AuthOk   [u32 sesión][u16 máx. jugadores][u8 flags concedidos]
             + si Udp: [32 B edgePub][u32 connId][u16 puertoUdp][string hostUdp][32 B okMac]
             okMac = HMAC-SHA256(secret, "haxlite-edge/2 ok" ‖ nonce ‖ hostPub ‖ AuthOk hasta antes del MAC)
```

El edge compara en tiempo constante (`timingSafeEqual`; un keyId desconocido también cuesta un
HMAC). El secreto nunca viaja. `mac2` ata los flags pedidos y la clave efímera del host a la
API key; `okMac` prueba que el edge también conoce la clave (autenticación **mutua**, aun sin
TLS) y ata su clave efímera, el connId y el destino UDP. Un `okMac` inválido es un `EdgeError`
fatal de tipo `auth`.

**Flags** (`Auth` = pedidos; `AuthOk` = concedidos, nunca más de lo pedido):

| Flag | Valor | |
|---|---|---|
| `WebRtc` | 1 | plano de datos legado: una PeerConnection node-datachannel host↔edge (señalización `TunnelOffer/Answer/Candidate` por el WS) |
| `RoLanes` | 2 | carriles `ro` (abajo); con `Udp` o `WebRtc` |
| `Udp` | 4 | **túnel v2** (§1.3), solo en `Auth` versión 2 |

Sin flags de plano concedidos, todo va por el WebSocket: `[0x70+canal][u16 slot][payload]`.

**Compatibilidad:** el edge v2 acepta `Auth` v1 y v2; el host v2 habla v1 con un edge que no
manda el byte de versión máxima (entonces `dataPlane: 'udp'` cae al WebSocket, o a la
PeerConnection si se pidió `'webrtc'`). Un host que pide un plano que el edge no concede
(`tunnel.udp: false`, `tunnel.allowWebRtc: false`, node-datachannel no instalado) recibe el
WebSocket (o un error si `fallbackWs: false`).

**Datos** (en cualquier plano UDP): trama `[u16 slot][payload]` — 2 bytes de overhead; el canal
del túnel **es** el canal del jugador (`ro` 0 ordenado y fiable, `ru` 1 desordenado y fiable,
`uu` 2 sin retransmisión). `slot = 0` lleva un mensaje de control en banda.

* **Carriles `ro`** (`RoLanes`): el tráfico `ro` de los jugadores (¡los clientes mandan
  **todos** sus eventos/inputs por `ro`!) se reparte en 16 canales ordenados según `slot % 16`
  (carril 0 = canal 0, carril k = canal 2 + k): una pérdida en el tramo host↔edge solo retrasa
  el `ro` de los jugadores de ese carril. El orden por jugador se mantiene: todo el `ro` de un
  slot y su control en banda (`PeerChannelOpen`/`PeerClosed`/`PeerClose`) van por su carril; un
  multicast `ro` sale como un mensaje por carril en uso.
* **Multicast:** las difusiones del host (eventos, heartbeats, CheckConsistency) salen como **un**
  mensaje `[0][0][0x40][canal][n][slot × n][payload]` en vez de uno por jugador. En el túnel v2
  los mensajes de un multicast (uno por carril) se agrupan en el mínimo de datagramas (`cork`).
* Liveness: el edge hace `ping` de WebSocket cada 10 s (dos sin respuesta = sesión muerta); el
  host manda `Ping` de aplicación cada 5 s por el WS **y** un `Ping` UDP autenticado (keep-alive
  del NAT + RTT del plano de datos) y da el túnel por caído si en 15 s no llegó nada por el WS o
  nada autenticado por el UDP. El edge cierra un túnel v2 sin datagramas autenticados en 30 s.

### 1.3 Plano de datos v2: SCTP sobre UDP cifrado

`src/net/edge-udp.ts` (común), `src/edge/tunnel-udp.ts` (edge). Sin WebRTC, sin ICE, sin DTLS:
la autenticación ya ocurrió en el WebSocket, así que solo hace falta un canal cifrado con
estado mínimo.

* **Claves por sesión.** Ambos lados generan un par x25519 **efímero** por sesión y se mandan la
  mitad pública en `Auth`/`AuthOk` (cubierta por `mac2`/`okMac`). Después:

  ```
  salt  = HMAC-SHA256(apiSecret, "haxlite-tunnel/2 salt" ‖ nonce del Hello)
  okm   = HKDF-SHA256(X25519(priv, pubDelOtro), salt, "haxlite-tunnel/2" ‖ hostPub ‖ edgePub ‖ u32 connId, 64)
  s_h2e = okm[0..32), s_e2h = okm[32..64)                       (un secreto por sentido)
  clave_e = HKDF(s_e, "…key", 16), iv_e = HKDF(s_e, "…iv", 12), s_{e+1} = HKDF(s_e, "…next", 32)
  ```

  *Forward secrecy*: las claves privadas x25519 se descartan apenas se calcula el secreto
  compartido; filtrar más tarde la API key no descifra sesiones grabadas. La API key entra en
  la derivación: aun con el control sin TLS, un intermediario que no la conoce no puede derivar
  las claves de datos (y `okMac`/`mac2` impiden sustituir las claves efímeras).
* **Datagrama** (ambos sentidos):

  ```
  [u8 tipo][u32 connId][u16 época][u48 seq] [AES-128-GCM(payload)] [tag 16 B]
   └────────────── 13 B de cabecera = AAD ─┘        nonce = iv_época XOR (0⁶ ‖ seq48)
  ```

  `tipo`: `0xF0` paquete SCTP, `0xF1` Ping `[f64]`, `0xF2` Pong (eco del mismo tamaño), `0xF3`
  cierre. Overhead total por datagrama: 29 B (un registro DTLS 1.2 con AES-GCM: 37 B). `seq` es por
  sentido y época, estrictamente creciente: el nonce nunca se repite (una clave por sentido, así
  que un datagrama reflejado tampoco abre). **Ventana anti-replay** de 1024 datagramas.
  **Ratchet** cada 2²⁴ datagramas por sentido: época + 1 con claves derivadas de la anterior
  (que se borra; la previa se acepta 30 s para paquetes reordenados) — muy por debajo de los
  límites de uso de AES-GCM, sin renegociar nada.
* **SCTP**: `src/rtc/sctp` (el mismo de haxlite-rtc), el host es el iniciador (`connect()`) y el
  edge el lado pasivo (INIT sin estado, cookie HMAC). Streams = canales del túnel (0 `ro`,
  1 `ru`, 2 `uu` con `maxRetransmits: 0`, 3–17 carriles `ro`), mensajes de hasta 1 MiB, paquetes
  SCTP ≤ 1200 B (+ 29 B + IP/UDP ≤ 1280). *Zero checksum* (RFC 9653): la integridad la da el AEAD.
  Como los dos extremos son nuestros, el ajuste es agresivo: SACK diferido 10 ms (WebRTC usa
  200 ms), RTO = SRTT + máx(4·RTTVAR, 20 ms) con mínimo 30 ms (≥ 200 ms en WebRTC), RTO máx. 3 s — una pérdida en el tramo
  host↔edge se repara en decenas de ms (§7.1).
* **Un puerto UDP en el edge para todos los hosts** (`tunnel.port`, por defecto el mismo número
  que el control: TCP **y** UDP 8443). Demultiplexado por `connId` (aleatorio, emitido por el
  WS). El host usa un socket UDP *conectado* (el kernel descarta todo lo que no venga del edge),
  **habla primero** (Ping + INIT): atraviesa cualquier NAT sin STUN ni candidatos, y el Ping
  periódico mantiene viva la asociación del NAT.
* **Cambio de dirección del host** (NAT rebinding): el edge adopta la nueva dirección de origen
  solo con un datagrama **autenticado** que además es el más nuevo visto (un datagrama repetido
  o atrasado no puede desviar el tráfico).
* *Fallback*: si la asociación no sube en `dataPlaneTimeoutMs` (5 s), el host reconecta con
  todo por el WebSocket (igual que antes).

## 2. Uso desde el host

```js
const room = await HBInit({
  roomName: 'Mi sala', maxPlayers: 16, public: true, noPlayer: true, token,
  haxlite: {
    edge: {
      url: 'wss://edge.midominio.com:8443/tunnel',
      key: 'alice:9fH3…',        // la entrega el operador del edge
      // dataPlane: 'udp',       // (por defecto) túnel v2; 'webrtc' = PeerConnection legada; 'ws'
      // fallbackWs: true,       // (por defecto) si el UDP al edge está bloqueado, todo por el WS
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
| `dataPlane` | `'udp'` | `'udp'` = túnel v2 (§1.3, sin addons); `'webrtc'` = PeerConnection node-datachannel (carga el addon); `'ws'` = forzar el WebSocket |
| `roLanes` | `true` | pedir los carriles `ro` (§1.2); `false` = un solo canal `ro` en el túnel |
| `fallbackWs` | `true` | si el plano UDP no sube en `dataPlaneTimeoutMs` (o el edge no lo concede), todo por el WebSocket (queda en WS hasta reiniciar la sala) |
| `bindAddress` | — | dirección local para el WS y el socket UDP del túnel |
| `iceServers` / `portRange` | ninguno / — | solo `dataPlane: 'webrtc'` |
| `connectTimeoutMs` / `dataPlaneTimeoutMs` | 10 s / 5 s | |
| `reconnectMinMs` / `reconnectMaxMs` | 250 ms / 10 s | backoff exponencial; tras una caída el primer reintento es inmediato |
| `pingIntervalMs` / `pingTimeoutMs` | 5 s / 15 s | también el keep-alive UDP y su timeout |
| `wsOptions` | — | opciones del cliente `ws` (p. ej. `ca` para un certificado propio) |

Comportamiento:

* **Arranque:** el host **no** registra la sala en el master hasta que el túnel está listo. Una
  clave inválida, un `AuthOk` sin MAC válido o una versión de protocolo incompatible es un
  `EdgeError` *fatal* y `HBInit` rechaza enseguida; los errores de red se reintentan hasta
  `initTimeoutMs`.
* **Caída del túnel:** los jugadores conectados se pierden (el cliente oficial no puede
  reconectarse ni renegociar), se emiten sus `onPlayerLeave` y `onBackendState('down')`; el host
  reintenta enseguida y con backoff. Mientras tanto las entradas se rechazan con 4104. La sala
  (link, estado, bans) sigue viva; al volver: `onBackendState('ready')`.
* `iceServers`, `iceCandidatePolicy` y `portRange` del host **no se usan** con edge: el host no
  crea PeerConnections de jugadores (el test E2E lo verifica).
* **Sin addon nativo:** con `dataPlane: 'udp'` o `'ws'` el host no carga node-datachannel (el
  módulo del túnel legado se importa solo con `'webrtc'`, y `src/net/webrtc.ts` carga el addon
  recién en la primera PeerConnection). `test/edge/edge-no-native.test.ts` lo verifica (§8).
* `getPlayerConnection(id).remoteAddress`: dirección del jugador **vista por el edge** (la del
  par nominado). Los bans oficiales siguen siendo por `conn` + srflx (llegan por el master),
  igual que sin edge.
* `edgeStats()` → `{state, dataPlane: 'udp'|'webrtc'|'ws', roLanes, sessionId, rttMs, peers,
  sessions, bytes/messages In/Out, udp}`; `rttMs` es el RTT del plano UDP cuando existe; `udp`
  trae los contadores del túnel v2 (datagramas, rechazados, ratchets, estado SCTP,
  retransmisiones).

## 3. Despliegue del edge en un servidor dedicado

Requisitos: Node ≥ 22, una IP pública (idealmente con mitigación DDoS aguas arriba, ver
[08 §3 nivel 2](08-ocultar-ip.md)), un nombre DNS para el certificado TLS. **Ningún addon
nativo** se carga con la configuración por defecto (node-datachannel sigue en `dependencies`
para `playerBackend: 'ndc'` y el túnel legado, pero ni se importa; §8).

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
  "playerBackend": "rtc",
  "webrtc": {
    "bindAddress": "203.0.113.10",
    "port": 40000,
    "publicAddresses": ["203.0.113.10"]
  },
  "tunnel": { "port": 8443 },
  "limits": { "maxPeersPerSession": 40, "maxPeersPerKey": 256, "maxSessionsPerKey": 16 },
  "stats": { "path": "/stats", "token": "cambiar-esto", "logIntervalMs": 60000 }
}
```

En una nube con NAT 1:1 (la interfaz tiene una IP privada): `bindAddress` = la privada (o sin
poner) y `publicAddresses` = la pública; si el puerto externo difiere, `publicPort`. Sin
`publicAddresses`, el edge anuncia `bindAddress` si es una IP concreta, o las IPs públicas de sus
interfaces; si no encuentra ninguna, no arranca (mejor que anunciar una dirección inservible).

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
  con `proxy_pass` de WebSocket a `127.0.0.1:8443` (solo el control; el UDP no pasa por ahí:
  entonces fijar `tunnel.port` y abrirlo aparte).
* SIGINT/SIGTERM cierran todos los túneles con 4503; los hosts reconectan solos (al reiniciar el
  edge se pierden los jugadores conectados).
* Desarrollo, sin compilar: `npm run edge -- --config edge.json` o
  `HAXLITE_EDGE_KEYS=alice:… npm run edge`.

### 3.1 Firewall y haxguard

**Edge** (IP pública):

| Tráfico | Regla |
|---|---|
| TCP 8443 (control) | abierto (autenticado con HMAC); si los hosts tienen IP fija, mejor solo desde ellas. Rate-limit de conexiones nuevas (`ct state new limit rate 20/second`) |
| UDP 8443 (túnel v2) | **solo de los hosts** si tienen IP fija; si no, abierto: sin un `connId` vigente y un MAC válido el edge no responde nada (§4) |
| UDP 40000 (jugadores, `webrtc.port`) | el `ROOM_PORTS` de [`ops/haxguard/haxguard.nft`](../ops/haxguard/haxguard.nft): descartar fragmentos, puertos origen < 1024 y reflectores, aceptar STUN con límite por origen. Con `'rtc'` es **un** puerto para todos los jugadores |
| `GET /stats` | ponerle `stats.token` o no exponerlo (bind privado / firewall) |

Con `playerBackend: 'ndc'` el rango es `portRange` (una PeerConnection por puerto salvo
`enableIceUdpMux`, que permite la atribución por puerto de 08 §3).

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
  el edge; con haxlite-rtc el edge anuncia **exactamente** `publicAddresses` (y además filtra con
  `iceCandidatePolicy`), y jamás pone una dirección del host en nada que envíe (la conoce solo
  como origen del WS y del túnel). El test E2E liga el edge a 127.0.0.2 y el host a 127.0.0.3 y
  comprueba —con ambos backends— que **todo** lo que reciben los clientes (answers, candidatos en
  el SDP y *trickle*) nombra solo 127.0.0.2, que 127.0.0.3 no aparece en ningún byte, y que el
  par ICE elegido de cada cliente apunta al edge.
* **Lo que el host le deja ver al master** no cambia: el master ya veía la IP del host (WS de
  señalización) y nunca la reenvía a los clientes.
* **Autenticación de hosts:** clave por host/tenant, desafío-respuesta HMAC-SHA256 con nonce de
  32 B por conexión, comparación en tiempo constante, IDs desconocidos indistinguibles por
  tiempo. En v2 el edge **también** se autentica ante el host (`okMac`). Usar `wss://` en
  producción: aunque las claves del túnel v2 no se pueden derivar sin la API key, el control
  (offers, slots) solo va cifrado con TLS.
* **Túnel v2 (UDP):**
  * Confidencialidad e integridad: AES-128-GCM con claves por sesión y por sentido (§1.3);
    cabecera autenticada; ventana anti-replay de 1024; ratchet de claves cada 2²⁴ datagramas;
    *forward secrecy* por x25519 efímero.
  * **Sin amplificación ni reflexión:** un datagrama con un `connId` desconocido se descarta
    sin hacer criptografía y **sin respuesta**; el edge **nunca** envía nada a una dirección de
    la que no recibió antes un datagrama que pasó el AEAD con las claves de ese túnel (el primer
    paquete del host tiene que estar autenticado; hasta entonces la salida SCTP se descarta). Las
    únicas respuestas a un datagrama del host son las de SCTP y un Pong **del mismo tamaño** que
    el Ping. Un datagrama reflejado no abre (otra clave), uno repetido cae en la ventana.
  * **Rate limits por `connId`:** un *token bucket* para los datagramas desde la dirección
    autenticada (`tunnel.maxPps`, 20 000/s, ráfaga de 2 s) y otro chico para cualquier otro
    origen (`maxForeignPps`, 20/s): un atacante que conoce un `connId` (32 bits aleatorios, solo
    visible en el camino) no puede hacer gastar al edge más de 20 intentos de AEAD por segundo.
  * La dirección del host solo cambia con un datagrama autenticado que además es el más nuevo:
    no se puede secuestrar el tráfico con datagramas repetidos. Un atacante **en el camino** que
    adelanta una copia de un datagrama legítimo podría redirigir respuestas (cifradas) hasta el
    siguiente datagrama del host — sin ganancia (no las puede leer) y sin amplificación.
  * Túnel sin datagramas autenticados en 30 s → cerrado.
* **Jugadores con haxlite-rtc (ICE-lite):** el edge **nunca** inicia comprobaciones ICE: un host
  (o un jugador) no puede hacer que el edge mande STUN a ninguna parte. Solo responde Binding
  requests con MESSAGE-INTEGRITY válido para el ufrag de esa sesión, y DTLS solo desde
  direcciones así validadas (cookie HMAC antes de guardar estado). Con `'ndc'`, como antes: los
  candidatos remotos pasan por `remoteCandidatePolicy` (por defecto `'public'`), máximo 32 por
  conexión, y lo único que se puede provocar son binding requests STUN (sin amplificación).
* **Un host malicioso no puede convertir el edge en un cañón:** cada entrada se valida (tamaños de
  SDP/candidato/mid/host UDP, slots, longitudes de string, claves x25519 de orden bajo; un
  mensaje malformado cierra la sesión con 4400).
* **Cuotas:** sesiones totales (`maxSessions`), por clave (`maxSessionsPerKey` / `maxSessions` de
  la clave), jugadores por sala y por clave, negociaciones simultáneas por sala (16, como el
  4104 oficial) y ritmo de `PeerOpen` (ráfaga 30, 1 cada 100 ms). Excederlas devuelve
  `PeerClosed(Limit)` (el host lo trata como negociación fallida) o cierra con 4429.
* **Flood de jugadores:** *token bucket* oficial (100, 1/16 ms) por jugador **en el edge**: el
  exceso no llega al túnel; el edge cierra al jugador y avisa `PeerClosed(Flood)`, y el host lo
  expulsa con "Bad actor" (misma semántica que el host oficial; el host conserva además su propio
  bucket y sus límites por evento, p. ej. chat 10/900 ms). Con `'ndc'`, un mensaje de texto (no
  binario) → `PeerClosed(Protocol)` → "Bad actor".
* **Aislamiento entre tenants:** cada sesión solo ve sus slots y su `connId`; las estadísticas
  son por clave.

Lo que el edge **no** resuelve: un ataque volumétrico contra el edge (para eso, hosting con
mitigación aguas arriba + haxguard), ni la atribución de filtraciones (la IP del edge es pública
por diseño; con un /64 IPv6 en el edge se puede seguir aplicando el "canary" de 08 §3).

## 5. Referencia de configuración del edge

JSON (`--config` o `HAXLITE_EDGE_CONFIG`) + variables de entorno (ganan): `HAXLITE_EDGE_HOST`,
`HAXLITE_EDGE_PORT`, `HAXLITE_EDGE_KEYS` (`id:secret,id2:secret2`), `HAXLITE_EDGE_KEYS_FILE`,
`HAXLITE_EDGE_TLS_CERT`/`HAXLITE_EDGE_TLS_KEY`, `HAXLITE_EDGE_BIND`, `HAXLITE_EDGE_PORT_RANGE`
(`40000-40999`), `HAXLITE_EDGE_PLAYER_BACKEND` (`rtc`/`ndc`), `HAXLITE_EDGE_PUBLIC_ADDRESSES`
(IPs separadas por comas), `HAXLITE_EDGE_TUNNEL_PORT` (número u `off`),
`HAXLITE_EDGE_STATS_TOKEN`, `HAXLITE_EDGE_LOG_INTERVAL_MS`. Programático:
`new EdgeServer(opts)` + `listen()` / `EdgeServer.start(opts)` de `src/edge`.

| Clave | Por defecto | |
|---|---|---|
| `listen.host` / `listen.port` / `listen.path` | `0.0.0.0` / 8443 / `/tunnel` | endpoint WS de control |
| `tls.certFile` / `tls.keyFile` | — | PEM → `wss://`; SIGHUP recarga |
| `keys[]` | — | `{id, secret (≥ 16 caracteres), maxSessions?, maxPeers?, label?}` |
| `keysFile` | — | JSON (array) o `id:secret` por línea |
| `playerBackend` | `'rtc'` | `'rtc'` = haxlite-rtc; `'ndc'` = node-datachannel |
| `webrtc.bindAddress` | todas | dirección local de los jugadores (`'rtc'`: y anunciada si no hay `publicAddresses`) |
| `webrtc.publicAddresses` | `bindAddress` o IPs públicas de las interfaces | `'rtc'`: las **únicas** direcciones anunciadas |
| `webrtc.port` / `webrtc.publicPort` | `portRange[0]` o efímero / el mismo | `'rtc'`: puerto UDP de todos los jugadores |
| `webrtc.consentTimeoutMs` | 30 000 | `'rtc'`: sin Binding autenticado del navegador en este tiempo → cerrado |
| `webrtc.portRange` | efímeros | `'ndc'`: rango UDP de jugadores y túneles legados |
| `webrtc.enableIceUdpMux` | false | `'ndc'`: todas las conexiones en un puerto (en el edge **no** ahorra CPU, §7.1 de la versión anterior) |
| `webrtc.iceServers` | STUN de Google | `'ndc'` / túnel legado |
| `webrtc.iceCandidatePolicy` | `'public'` | candidatos propios anunciados (`'all'` solo para pruebas en loopback) |
| `webrtc.remoteCandidatePolicy` | `'public'` | candidatos remotos aceptados (`'private'`/`'all'` para LAN/pruebas) |
| `webrtc.rtc` | — | `'ndc'`: extras de node-datachannel (`mtu`, `maxMessageSize`…) |
| `tunnel.udp` | true | aceptar túneles v2 |
| `tunnel.port` | el puerto de `listen` (UDP), o efímero si está ocupado | puerto UDP del túnel v2 para todos los hosts |
| `tunnel.bindAddress` | `webrtc.bindAddress`, si no `listen.host` | |
| `tunnel.publicHost` / `tunnel.publicPort` | el host de la URL del WS / el puerto ligado | destino que se comunica a los hosts en `AuthOk` |
| `tunnel.maxPps` / `tunnel.maxForeignPps` | 20 000 / 20 | buckets por `connId` (§4) |
| `tunnel.idleTimeoutMs` | 30 000 | túnel sin datagramas autenticados |
| `tunnel.allowWebRtc` | true | conceder el túnel legado a quien lo pida (carga node-datachannel en ese momento) |
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

`GET /stats` (con `Authorization: Bearer <token>` si hay token) devuelve `playerBackend`,
sesiones, jugadores, fallos de autenticación, sesiones por plano de datos (`dataPlanes`), por
clave `{sessions, peers, bytesIn/Out, messagesIn/Out, ppsIn/Out, floods}` (pps desde la consulta
anterior), `rtc` (contadores del endpoint de jugadores: sesiones, abiertas, STUN rechazados,
handshakes…), `tunnel` (puerto, túneles, datagramas, `unknownConn`, `rateLimited`, `rejected`,
`migrations`), `webrtc` (objetos nativos; `null` si node-datachannel nunca se cargó) y RSS.

## 6. Límites y decisiones

* *Head-of-line* en el túnel: los clientes oficiales mandan **todos** sus eventos (inputs, chat)
  por `ro`, así que con un único canal `ro` en el túnel una pérdida en el tramo host↔edge frenaba
  los inputs de **todos** los jugadores hasta la retransmisión. Con los carriles `ro` (§1.2, por
  defecto) solo se frena el carril del paquete perdido (≈ 1/16 de los jugadores), y el túnel v2
  (SACK 10 ms, RTO ≥ 30 ms) recorta la cola: p99 ≈ 32 vs 40–43 ms con 5 % de pérdida (§7.1). Eventos del host
  (`ru`) y heartbeats (`uu`) nunca sufren HOL. Con el *fallback* WebSocket todo es TCP (HOL
  total): usarlo solo si el UDP está bloqueado.
* Por qué SCTP propio sobre UDP+AEAD y no DTLS/ICE: la autenticación ya existe (WS + API key),
  el host siempre inicia y el edge tiene IP pública, así que ICE y el handshake DTLS sobran; un
  canal AEAD con claves derivadas del WS cuesta 29 B por datagrama, ningún RTT extra de
  handshake y cero estado en el edge antes de autenticar. SCTP (no un protocolo propio de
  fiabilidad) porque ya está probado contra Chromium y libdatachannel y da exactamente la
  semántica de los canales (ordenado/desordenado/parcialmente fiable por stream).
* Puerto UDP del túnel separado del de los jugadores: se puede restringir a las IPs de los
  hosts en el firewall, y los ataques a uno no compiten por el socket del otro.
* Sin *batching* artificial de mensajes chicos: cada mensaje de jugador es un mensaje de túnel
  (+2 bytes) y sale en el acto (sin Nagle); SCTP agrupa solo lo que ya está en cola (p. ej. los
  carriles de un multicast, o lo enviado mientras se procesa un datagrama).
* Asignación de slots monótona (u16, se reutiliza tras 65 535 entradas): un cierre en vuelo nunca
  se confunde con una entrada nueva.
* Si el edge se reinicia o el túnel cae, los jugadores se pierden (limitación del cliente oficial).
* El edge no aplica límites de ancho de banda por clave (solo cuotas de conexiones, flood por
  jugador y pps por túnel); las estadísticas por clave permiten detectar abusos.
* Cero asignaciones evitables en los caminos calientes: los encabezados se escriben en un buffer
  *scratch* reutilizado (SCTP copia de forma síncrona); quitar el encabezado es una vista, el
  multicast entrega **la misma** vista del payload a cada jugador y se parsea en el sitio. Por
  datagrama del túnel: el buffer de salida (cabecera + cifrado) y el texto plano descifrado (que
  SCTP entrega por vistas, sin otra copia).
* Sin temporizadores en vacío: el ping de keep-alive a los hosts (10 s) solo corre mientras hay
  sesiones; el barrido de negociaciones colgadas (1 s) solo mientras hay alguna negociación
  pendiente; el barrido de túneles UDP solo con túneles; el de haxlite-rtc solo con jugadores. Un
  edge sin sesiones no despierta nunca, y con la configuración por defecto no tiene hilos nativos.
* Con haxlite-rtc no se distingue un mensaje de texto de uno binario (la sesión no expone el
  PPID): un texto llega al host como bytes y el host lo valida como cualquier mensaje binario (no
  hay `PeerClosed(Protocol)` como con `'ndc'`).

## 7. Overhead medido (loopback)

`scripts/edge-latency.ts` (procesos separados: clientes + master / host / edge; carga de
"jugador ocupado" de bench/net: un cambio de teclas cada 60–250 ms por jugador, partido en
curso; sonda RTT con el mensaje Ping del cliente cada 50 ms, alternando `ro` y `uu`; el Pong
vuelve por `uu`). Modos: `direct`, `edge[-rtc|-ndc][-udp|-webrtc|-ws]` (por defecto
`rtc`/`udp`, o sea `edge` = la configuración nueva y `edge-ndc-webrtc` = la anterior):

```sh
flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings \
  --import ./scripts/ts-resolve.mjs scripts/edge-latency.ts \
  --players 16 --seconds 20 --runs 3 --modes edge-rtc-udp,edge-ndc-webrtc
```

Medido en el contenedor de desarrollo (Linux, 4 vCPU, Node 22.22, loopback; edge en 127.0.0.2,
túnel del host en 127.0.0.3). "CPU %" = tiempo de CPU del proceso (todos sus hilos, incluidos
los de libdatachannel cuando los hay) / tiempo real; "por jugador" = dividido por los jugadores
conectados (carga + sonda). ~200 muestras de RTT por canal y corrida.

Contenedor recién reiniciado, una sola tanda intercalada (los números de otras tandas o de la
versión anterior de este documento no son comparables: la carga del equipo cambia mucho entre
sesiones). Cada celda: corridas separadas por « · ».

**17 jugadores** (16 + sonda), 3 × 20 s:

| Modo | RTT `ro` p50 / p99 (ms) | CPU host % (total) | CPU host %/jugador | CPU edge % (total) | CPU edge %/jugador |
|---|---|---|---|---|---|
| **edge `rtc` + túnel v2 (nuevo)** | 0,66 / 4,2 · 0,76 / 4,2 · 0,72 / 9,5 | 3,81 · 4,24 · 4,08 | 0,22 · 0,25 · 0,24 | 7,75 · 8,53 · 8,40 | **0,46 · 0,50 · 0,49** |
| edge `ndc` + PeerConnection (anterior) | 0,83 / 6,9 · 0,90 / 7,6 · 0,83 / 10,1 | 3,99 · 4,20 · 4,08 | 0,24 · 0,25 · 0,24 | 11,33 · 12,09 · 11,82 | 0,67 · 0,71 · 0,70 |

**9 jugadores** (8 + sonda), 2 × 20 s:

| Modo | RTT `ro` p50 / p99 (ms) | RTT `uu` p50 / p99 (ms) | CPU host % | CPU edge %/jugador |
|---|---|---|---|---|
| directo (sin edge) | 0,50 / 2,5 · 0,48 / 3,9 | 0,50 / 2,0 · 0,47 / 2,8 | 4,85 · 4,84 | — |
| **edge `rtc` + túnel v2** | 0,79 / 6,5 · 0,72 / 4,8 | 0,77 / 4,2 · 0,71 / 2,0 | 3,07 · 2,71 | **0,57 · 0,54** |
| edge `ndc` + PeerConnection | 0,89 / 11,0 · 0,91 / 5,7 | 0,87 / 4,1 · 0,86 / 5,4 | 2,76 · 2,91 | 0,67 · 0,64 |
| edge `rtc` + WebSocket | 0,73 / 5,2 · 0,72 / 6,0 | 0,71 / 3,6 · 0,71 / 3,1 | 2,13 · 2,03 | 0,52 · 0,53 |

Ninguna corrida perdió pings (`lost: 0`).

* **CPU del edge: −29 % por jugador con 17 jugadores** (0,48 vs 0,69 % de un núcleo; total 8,2 %
  vs 11,7 %) y −15 % con 9. Desglose (tanda del §7.1 sin pérdida, 17 jugadores): jugadores en
  haxlite-rtc con el túnel legado 9,2 % → además el túnel v2 7,9–8,1 %; `ndc`+PeerConnection
  11,2–11,8 %. Todo en el hilo de JS: sin hilos nativos (antes ~4 hilos de libdatachannel y el
  timer de usrsctp despertando cada 10 ms).
* **CPU del host:** igual o algo menor que con la PeerConnection (3,5–4,1 % vs 3,8–4,2 % con
  17 jugadores) aun haciendo SCTP + AES-GCM en JS: la asociación es una sola y el multicast
  agrupa los carriles en pocos datagramas. Frente al host directo sigue siendo −35 / −45 %.
* **Latencia:** el salto extra cuesta ≈ +0,25 ms de mediana sobre el directo (0,49 → 0,72–0,79
  ms), ≈ 0,1–0,15 ms menos que el edge anterior. Los p99 en loopback (2–10 ms) son ruido del
  planificador (4 vCPU compartidas por cliente, master, host y edge).
* El WebSocket sigue siendo el más barato en loopback (TCP sin pérdidas no cuesta nada); con
  pérdida real tiene *head-of-line blocking* total, por eso no es el modo por defecto.

### 7.1 Pérdida en el tramo host↔edge: túnel v1 vs v2

`--loss <pct>`: regla nftables (`numgen random`) que descarta ese % del UDP 127.0.0.2↔127.0.0.3
en ambos sentidos (solo el túnel; los jugadores no se tocan). 17 jugadores, 2 × 40 s por
configuración, carriles `ro` activos en todos los casos.

RTT de la sonda (ms; `ro` = mensajes del jugador → host, el sentido que sufre HOL). Cada celda:
dos corridas.

| Pérdida | Túnel | RTT `ro` p50 | RTT `ro` p99 | RTT `ro` media | RTT `uu` media | CPU edge % | retransm. SCTP (host) |
|---|---|---|---|---|---|---|---|
| 0 % | v1 (`ndc` + PeerConnection) | 0,80 · 0,86 | 4,6 · 5,0 | 1,03 · 0,97 | 0,96 · 1,05 | 11,2 · 11,8 | — |
| 0 % | v1 (`rtc` + PeerConnection) | 0,83 · 0,81 | 7,7 · 2,1 | 1,11 · 0,86 | 1,09 · 0,90 | 9,2 · 9,2 | — |
| 0 % | **v2** (`rtc` + UDP/SCTP) | **0,69 · 0,71** | 7,3 · 7,2 | 0,94 · 1,03 | 0,83 · 1,06 | **7,9 · 8,1** | 0 · 0 |
| 2 % | v1 (`ndc`) | 0,91 · 0,93 | 26,9 · 21,3 | 1,74 · 1,61 | 0,99 · 1,17 | 12,2 · 12,0 | — |
| 2 % | v1 (`rtc`) | 0,88 · 0,93 | 32,4 · 23,8 | 1,62 · 1,59 | 1,06 · 1,28 | 9,8 · 10,2 | — |
| 2 % | **v2** | **0,76 · 0,75** | 29,5 · 30,7 | 1,35 · 1,59 | 0,86 · 0,89 | **8,7 · 8,4** | 149 · 140 |
| 5 % | v1 (`ndc`) | 0,91 · 0,92 | 39,8 · 43,2 | 2,10 · 2,85 | 1,13 · 1,03 | 12,3 · 11,9 | — |
| 5 % | v1 (`rtc`) | 1,01 · 0,93 | 40,9 · 39,7 | 3,00 · 2,37 | 1,33 · 1,39 | 10,5 · 9,9 | — |
| 5 % | **v2** | **0,83 · 0,79** | **31,7 · 31,6** | 2,56 · 2,55 | 1,11 · 0,97 | **9,0 · 8,4** | 428 · 386 |

Lectura:

* El túnel v2 **no empeora nada con pérdida** y mejora la mediana en todos los casos (−0,1 a
  −0,15 ms) y el p99 con 5 % (≈ 32 ms vs 40–43 ms). La media de `ro` queda igual (dentro del
  ruido entre corridas).
* El p99 de `ro` con pérdida lo dominan los mensajes de la sonda que caen en un paquete perdido:
  a este ritmo de tráfico (≈ 150 paquetes/s edge→host) la recuperación llega por *fast
  retransmit* (tres SACK con hueco ≈ 20 ms) antes que por RTO, en ambos túneles; el RTO bajo del
  v2 (≥ 30 ms) recorta la cola cuando hay pocos paquetes detrás (5 %). Una recuperación más
  rápida pediría un umbral de duplicados menor o RACK en `src/rtc/sctp` (pendiente).
* `uu` (heartbeats/Pong) no se retransmite nunca: su RTT no depende del túnel; las pérdidas de la
  sonda (`lost` 20–65 de ~800 por corrida) son los propios Ping/Pong `uu` descartados.
* Ajuste del túnel v2 usado: SACK diferido 10 ms, RTO mín. 30 ms, varianza mín. 20 ms (en una
  prueba previa con 60/40 ms la media de `ro` con 5 % de pérdida era peor; no comparable con esta
  tanda por el reinicio del equipo).

### 7.2 Mediciones de la versión anterior (node-datachannel en ambos lados)

Para referencia (mismo script, `edge` = `edge-ndc-webrtc` de hoy):

* 9 jugadores: directo RTT `ro` p50 1,03 ms / CPU host 10,5 %; edge (PeerConnection) RTT `ro` p50
  1,69 ms / CPU host 6,3 % / edge 1,26 %/jugador; edge (WS) 1,61 ms / 5,0 % / 1,23 %/jugador.
* 17 jugadores: directo 1,02 ms / 19,4 %; edge (UDP) 1,68 ms / 8,1 % / 1,24 %/jugador; edge (WS)
  1,56 ms / 6,4 % / 1,18 %/jugador.
* Carriles `ro` con 2 % / 5 % de pérdida en el túnel: RTT `ro` medio 2,79 → 2,09 ms y
  4,94 → 3,24 ms (un canal → carriles); `enableIceUdpMux` en el edge: +6 % de CPU.

## 8. Sin addons nativos

* `src/edge/server.ts` y `src/net/edge-client.ts` no importan node-datachannel: todo lo que lo usa
  (túnel legado y `playerBackend: 'ndc'`) está en `src/net/edge-ndc.ts` y se carga con
  `import()` solo cuando un host pide `WebRtc` o el operador elige `'ndc'`; el build (rolldown)
  lo deja en su propio *chunk*.
* `test/edge/edge-no-native.test.ts` arranca, en procesos separados, un edge con la configuración
  por defecto y una sala completa (`HBInit`) hosteada a través de él por el túnel v2; un cliente
  node-haxball real entra y chatea; ambos procesos registran **todas** las llamadas a
  `process.dlopen` y toda resolución de un especificador `node-datachannel`
  (`module.registerHooks`) desde antes de importar haxlite: ambas listas quedan vacías y
  `require.cache` no tiene nada de node-datachannel. Control positivo en el mismo test: con
  `playerBackend: 'ndc'` la trampa sí ve el addon.
* `test/rtc-interop/edge.interop.ts` (`npm run test:interop`): Chromium real (la página del banco
  de interoperabilidad, copia del uso de WebRTC del cliente oficial) negocia a través del host →
  túnel → edge (haxlite-rtc) y intercambia 300 mensajes por canal en ambos sentidos; luego 10
  navegadores a la vez, cerrados desde el host.
* Combinaciones probadas en `npm test` (`test/edge/`): `rtc`+`udp` (por defecto), `ndc`+`webrtc`
  (E2E completo de > 3000 frames con ambos), `ndc`+`udp`, `rtc`+`webrtc`, `rtc`+`ws`, edge sin
  túnel v2 → WS, edge sin túnel legado → WS, host v2 ↔ edge protocolo 1 (falso) → WS, `AuthOk`
  falsificado → error fatal, ataques UDP (connId desconocido, datagramas falsos, repetidos desde
  otra dirección: sin respuesta y sin desvío), NAT rebinding seguido y ratchet de claves en
  partida.
