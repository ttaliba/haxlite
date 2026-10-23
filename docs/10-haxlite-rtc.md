# 10 — haxlite-rtc: data channels WebRTC en TypeScript puro

> **Qué es.** Una pila WebRTC mínima (`src/rtc/`), escrita en TypeScript sin addons nativos
> (`node:dgram` + `node:crypto`), que hace **solo** lo que un host de HaxBall necesita: aceptar la
> oferta de un navegador y mover bytes por los tres data channels pre‑negociados del cliente
> oficial (`ro`, `ru`, `uu`). Sustituye a node-datachannel/libdatachannel: en servidores con IP
> pública (haxlite Edge, hosts dedicados) y, desde que es un agente **ICE completo** con
> recolección STUN (§2.1), también **detrás de NAT** sin configurar nada.
>
> Este documento cubre el diseño (resumen de `src/rtc/README.md` y de la cabecera de
> `src/rtc/sctp/association.ts`), el **banco de interoperabilidad con navegadores reales**
> (`test/rtc-interop/`), los **benchmarks** contra node-datachannel (`bench/rtc/`) y las
> limitaciones conocidas.

---

## 1. Por qué

node-datachannel funciona, pero en un host de producción trae costes y riesgos que no
dependen de nosotros (ver la cabecera de `src/net/webrtc.ts`):

- **Una excepción JS dentro de un callback nativo aborta el proceso** (`Napi::Error`,
  SIGABRT) y un wrapper de DataChannel recolectado antes de su `closed` deja un puntero
  colgante (SIGSEGV en `cleanup()`). haxlite lo esquiva con envoltorios defensivos, pero el
  riesgo es estructural.
- **Hilos nativos**: libdatachannel + usrsctp + libjuice mantienen varios hilos por proceso, y
  el temporizador de usrsctp despierta cada 10 ms aunque no haya conexiones.
- **`cleanup()` puede colgarse**: durante este trabajo el banco registró
  `libdatachannel error# cleanup timeout (possible deadlock)` al apagar un servidor cuyos peers
  habían perdido el camino UDP a mitad de un cierre (§5.3).
- Un puerto UDP por PeerConnection (salvo `enableIceUdpMux`), binario nativo por plataforma.

haxlite-rtc corre entero en el hilo de JS: un único socket UDP por familia para todas las
sesiones, sin hilos extra, y los errores de un peer quedan dentro de su sesión.

## 2. Diseño

```
UDP socket (uno por familia, compartido por todas las sesiones)
 └─ demux (RFC 7983, primer byte): 0–3 STUN → peticiones: sesión por ufrag del USERNAME
                                              respuestas: transacción propia (checks, consentimiento, STUN)
                                   20–63 DTLS → sesión por dirección remota (validada por ICE)
     └─ RtcSession: ICE (stun.ts, ice-agent.ts) → servidor DTLS 1.2 (dtls/) → SctpAssociation (sctp/)
 Gatherer (gather.ts, uno por endpoint): candidatos host + srflx por STUN desde el mismo socket
```

El navegador es **siempre** quien ofrece y el **cliente DTLS**; haxlite-rtc es un agente **ICE
completo en rol controlado** (o ICE‑lite con `iceLite: true`), **servidor DTLS 1.2** y **SCTP** con los tres canales pre‑negociados del cliente
oficial (`ro` id 0 fiable y ordenado, `ru` id 1 fiable y desordenado, `uu` id 2 con
`maxRetransmits: 0`, sin DCEP).

| Capa | Qué hace | Detalles |
|---|---|---|
| SDP (`sdp.ts`) | Lee la oferta, escribe la respuesta | `a=setup:passive`, los candidatos del endpoint (host + srflx; con `iceLite`, `a=ice-lite` y solo `host` de `publicAddresses`), `a=end-of-candidates` si la recolección terminó, `a=max-message-size:262144` |
| Recolección (`gather.ts`) | Candidatos locales, por endpoint | `host`: direcciones de las interfaces del socket filtradas por la política (o `publicAddresses` tal cual); `srflx`: Binding STUN a cada `iceServers` desde el socket compartido, con `raddr 0.0.0.0 rport 0`. Solo IPv4 salvo `ipv6: true`. Resultado cacheado y refrescado en segundo plano cada `gatherRefreshMs` (60 s); solo las sesiones creadas durante la **primera** ronda reciben el resto por trickle (§2.1) |
| ICE (`stun.ts`, `session.ts`, `ice-agent.ts`) | Responde Binding requests **y envía las suyas** | USERNAME `nuestroUfrag:suyoUfrag`, MESSAGE‑INTEGRITY (HMAC‑SHA1) y FINGERPRINT obligatorios, rol *controlling* del navegador. Cada origen autenticado queda *validado* (y es un candidato prflx con *triggered check*); USE‑CANDIDATE nomina. Checks propios a cada candidato remoto (oferta + trickle) con ICE‑CONTROLLED, validación simétrica, retransmisión acotada. Consentimiento: checks propios cada 5 s ± 20 % (RFC 7675) además de los del navegador; sin ninguno respondido/recibido en `idleTimeoutMs` (30 s) se cierra. Cambio de NAT solo con un Binding autenticado nuevo |
| DTLS 1.2 (`dtls/`) | Servidor DTLS (RFC 6347) | HelloVerifyRequest según el modo (`helloVerify`): con ICE completo no, el primer ClientHello recibe el flight 4 (el demux solo entrega DTLS desde direcciones que respondieron a un check nuestro, y los flights solo van ahí); con ICE‑lite sí, por defecto (§6.7); preferencia (igual en Node y Bun): `ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256` (AEAD en JS puro, sin asignaciones, cifra/descifra en el sitio: `dtls/chacha.ts`, §6.4), luego AES_128_GCM y AES_256_GCM (`node:crypto`); configurable con `cipherSuites`; x25519 / P‑256; *extended master secret* obligatorio; certificado del cliente obligatorio y comparado (tiempo constante) con el `a=fingerprint` de la oferta; CertificateVerify comprobado; ventana anti‑replay de 64; retransmisión 1 s → 8 s; fragmentación y reensamblado; `close_notify`. Un Chromium que ofrece DTLS 1.3 recibe un ServerHello 1.2 y conecta |
| SCTP (`sctp/association.ts`) | Asociación SCTP sobre DTLS | RFC 9260, PR‑SCTP (RFC 3758) para `uu`, *stream reset* (RFC 6525) para cerrar canales, *zero checksum* (RFC 9653). Cookie de estado HMAC (INIT sin estado). Sin Nagle: un `send` sale en el acto si las ventanas lo permiten; los envíos hechos dentro de `onMessage` se agrupan en un paquete junto con el SACK. Un solo temporizador por asociación. Ruta caliente sin asignaciones (arena FIFO de bytes, anillos tipados indexados por TSN); `input` nunca lanza |
| Certificado (`cert.ts`) | ECDSA P‑256 autofirmado | Codificador DER mínimo |

**Robustez frente a tráfico hostil.** Límites y cierres que no cambian lo que envía un cliente oficial:

* **DTLS, numeración de la época 0** (`dtls/server.ts`). Los registros de la época 0 del servidor (flight 4 y sus retransmisiones) se numeran desde 0 con ICE completo (`helloVerify` desactivado, el modo por defecto). Con `helloVerify` continúan desde el número de secuencia del ClientHello que trae la cookie (solo sus 32 bits bajos, y solo si los 16 altos son 0; si no, desde 0), para que la ventana anti‑replay del cliente no descarte el flight 4 por repetir el número del HelloVerifyRequest (RFC 6347 §4.2.1).
* **DTLS, agotamiento y errores internos.** La secuencia de escritura de cada época es de 48 bits (16 + 32). Al agotarse, la sesión se cierra con `onClose('dtls-error:sequence-exhausted')`, de forma asíncrona y sin enviar ninguna alerta: no se da la vuelta (RFC 6347 §4.1). Un fallo al reenviar un flight, por temporizador o porque el par lo reenvió, no escapa al bucle de eventos: cierra solo esa sesión con `onClose('dtls-error:internal-<mensaje>')` e intenta mandar una alerta fatal.
* **SCTP, límites por paquete** (`sctp/association.ts`). `COOKIE‑ECHO` solo se procesa si es el primer chunk del paquete (RFC 9260 §5.1: acota el HMAC de la cookie a uno por paquete). Como mucho 2 peticiones RE‑CONFIG por paquete (`MAX_RECONF_REQS`; las demás se ignoran sin contestar, un par conforme las reenvía). Los bloques de gap de un SACK tienen un presupuesto igual a los TSN entre el acumulado y el último enviado. Un FORWARD‑TSN tiene un presupuesto de `4 × rxCap` lecturas del mapa de pendientes por paquete (`FWD_WORK_PER_SLOT`); un emisor conforme lista cada stream una vez y no lo alcanza.
* **SCTP, búfer de recepción.** La ventana anunciada (`a_rwnd`) es `receiveBufferSize` (1 MiB por defecto) menos lo retenido. El TSN que sigue en orden se admite con un margen de un mensaje más (`receiveBufferSize + maxReceiveMessageSize`, 262 144 B por defecto), y un mensaje que llena ese búfer y ya supera `maxReceiveMessageSize` cierra la asociación con `'message-too-large'` (en la sesión, `onClose('sctp:message-too-large')`). Un fallo en un envío disparado por un temporizador cierra la asociación con `'internal-error'` (`sctp:internal-error`, que también va a `onError`).
* **Endpoint.** Un datagrama cuyo procesamiento lanza se descarta, cuenta en `rtcStats().packetErrors` y se registra con `console.error` («[haxlite/rtc] error processing a …») como mucho cada 10 s. Una sesión cuyos datagramas lanzan 5 veces seguidas, o cuyo temporizador del barrido de 1 Hz lanza, se cierra con `onClose('error')`; las demás siguen. Los errores de TURN (asignación, mantenimiento) y de un tick de ICE se registran con `console.error` («[haxlite/rtc] error in …») sin límite de frecuencia.
* **Contrapresión.** `RtcSession.bufferedAmount` son los bytes que `send` aceptó y el par aún no ha confirmado, todos los canales (0 antes de existir la capa de datos y una vez cerrada); un par que lo mantiene alto no lee lo que se le envía. `HostTransport` lo recoge con `PeerLink.queuedBytes()` y cierra al jugador con el motivo `'stalled'` si supera `maxPeerBufferedBytes` (1 MiB) durante `peerBufferedTimeoutMs` (10 s). Es el contrato que debe cumplir un backend propio para que se aplique ese límite.
* **Clasificación de direcciones** (`gather.ts`). Las IPv4‑compatibles (`::a.b.c.d`) son `reserved`; las NAT64 (`64:ff9b::/96`) y 6to4 (`2002::/16`) se clasifican por la IPv4 incrustada si esta no es pública. Afecta a `iceCandidatePolicy` y a los checks hacia esas direcciones: con `'public'` no reciben checks ni se anuncian.

API pública (`src/rtc/index.ts`):

```ts
const ep = await RtcEndpoint.listen({ port: 40000, iceServers: ['stun:stun.l.google.com:19302'] });
//   o, con IP pública fija: { port: 40000, publicAddresses: ['203.0.113.7'] }  (iceLite: true = modo anterior)
const s = ep.createSession(offerSdp);      // lanza RtcSdpError si la oferta no sirve
s.answerSdp; s.localCandidates; s.mid;     // respuesta con los candidatos conocidos
s.gatheringComplete;                       // false mientras corre una ronda STUN: el resto llega por
s.onLocalCandidate = (c) => {}; s.onGatheringComplete = () => {};   // … trickle (mandar al navegador)
s.addRemoteCandidate('candidate:…');       // candidatos del navegador: destino de nuestros checks
s.onOpen = () => {}; s.onMessage = (canal, bytes) => {}; s.onClose = (motivo) => {};
s.onChannelClose = (canal) => {};          // el navegador cerró un canal (reset de stream)
s.send(0, bytes); s.close(); await ep.close();
```

Motivos de `onClose`: `remote-close`, `timeout` (consentimiento ICE), `handshake-timeout`,
`dtls-alert:<n>`, `dtls-error:<qué>`, `sctp:<motivo>`, `endpoint-closed`.

### 2.1 ICE completo detrás de NAT (`ice-agent.ts`, `gather.ts`)

Hasta esta pasada haxlite-rtc era ICE‑lite: solo anunciaba `publicAddresses` y contestaba los
Binding del navegador. Detrás de un NAT doméstico o de nube eso no funciona: el NAT descarta los
checks del navegador hacia el puerto público porque el host nunca mandó nada a esa dirección
(filtrado dependiente de la dirección, el caso común), y el host ni siquiera sabe su IP pública.
Ahora, por defecto, es un agente ICE completo (RFC 8445) en **rol controlado** (el navegador ofrece
y es *controlling*, §6.1.1):

**Candidatos locales (por endpoint, no por sesión).** Todas las sesiones comparten un socket por
familia, así que la recolección se hace una vez por endpoint:

* `host`: con `publicAddresses`, esas direcciones tal cual (como antes); si no, las direcciones de
  las interfaces del socket (todas las de la familia si el *bind* es comodín, si no la dirección de
  *bind*) filtradas por `candidatePolicy` (= `iceCandidatePolicy` del transporte, por defecto
  `'public'`: nunca se anuncian loopback, RFC 1918, CGNAT, ULA ni link‑local — doc 08). **IPv6 es
  opcional** (`ipv6: true`, por defecto `false`): con ella, si la máquina tiene una IPv6 global se
  abre un socket `udp6` además del `udp4` (link‑local nunca); sin ella el endpoint es solo IPv4 (sin
  `udp6`, sin candidatos IPv6, sin consultas AAAA). Motivo: la cabecera IPv6 son 20 B más que la
  IPv4, ≈ +19 % de salida con los datagramas pequeños de HaxBall, y los navegadores prefieren el
  par IPv6 cuando se les ofrecen ambos.
* `srflx`: un Binding STUN sin autenticar (RFC 8489) desde el propio socket compartido a cada
  servidor STUN de `iceServers` (resueltos con DNS: A, y AAAA solo con `ipv6`), retransmitido a 0, 250 y 750 ms,
  abandonado a los 1,5 s. La XOR‑MAPPED‑ADDRESS es la dirección pública del socket en el NAT: es la
  **autodetección de la IP pública** que antes faltaba. Se escribe con `raddr 0.0.0.0 rport 0` (no
  se filtra la base privada), y se omite si coincide con un candidato host (IP pública sin NAT).
* Una ronda arranca al escuchar. Solo las sesiones creadas mientras corre esa **primera** ronda
  (aún sin resultado) quedan con `gatheringComplete = false`: lo nuevo llega por `onLocalCandidate`
  y luego `onGatheringComplete`; el backend lo traduce a los eventos de siempre, y `HostTransport`
  hace con ello lo mismo que con node-datachannel: espera ≤ 500 ms para la respuesta y manda el
  resto por trickle. Después, toda sesión recibe el último resultado y la respuesta sale en el acto;
  si ese resultado tiene más de `gatherRefreshMs` (60 s), la sesión dispara una ronda de refresco
  **en segundo plano**. Las sesiones creadas mientras corre llevan el resultado anterior en la
  respuesta pero sin `a=end-of-candidates` (el backend pide entonces responder con el primer
  candidato, `answerOnFirstCandidate`): si el refresco encuentra otro srflx se les manda por trickle,
  y después el fin de la recolección. (Antes la sesión que disparaba
  el refresco esperaba la respuesta STUN, y con un paquete perdido pagaba los 500 ms enteros: entrada
  de 555–577 ms → 63–65 ms en loopback con el refresco sin respuesta.) Sin servidores STUN no hay
  rondas.

**Lista de comprobaciones (por sesión).** Cada candidato remoto (líneas `a=candidate` de la oferta y
trickle por `addRemoteCandidate`; solo UDP, componente 1, literales IP: un nombre mDNS `*.local` no se
puede resolver y se ignora, igual que en libdatachannel) da **un** par: todos los candidatos locales
comparten el socket de su familia, así que tras la poda de RFC 8445 §6.1.2.4 (srflx → su base)
cada candidato remoto queda en un solo par (socket, remoto). Prioridad de par §6.1.2.3 con G = remoto
y D = nosotros; con un solo componente y un solo flujo de datos todos los pares arrancan *Waiting*
(sin *frozen*). Un check: Binding con USERNAME `suyoUfrag:nuestroUfrag`, MESSAGE‑INTEGRITY con la
contraseña del navegador, PRIORITY de prflx (tipo 110), ICE‑CONTROLLED + desempate, FINGERPRINT. Un
check nuevo por sesión cada `Ta` = 20 ms, retransmisión con RTO 200 ms doblando (5 envíos; fallo a
los 6,2 s). La respuesta se autentica antes de nada (una respuesta falsificada no cierra la
transacción) y tiene que venir de la misma dirección y puerto al mismo socket (§7.2.5.2.1, si no el
par falla). Un éxito **valida** el par: el demux acepta DTLS de ahí. Cada Binding autenticado del
navegador desde un origen nuevo crea un candidato prflx (§7.3.1.3) y todo Binding en un par que aún
no tuvo éxito encola un *triggered check* (§7.3.1.4). En cuanto el DTLS conecta se dejan de iniciar
checks ordinarios (los *triggered* y el consentimiento siguen).

Así se abre el NAT: el host recibe los candidatos del navegador por la señalización **antes** de
mandar la respuesta, su primer check sale por el NAT hacia el srflx del navegador y crea la entrada
que deja pasar los checks del navegador hacia nuestro srflx; si el NAT del host es simétrico (el
srflx no sirve a nadie), el navegador ve llegar nuestro check desde la dirección real, la aprende
como prflx y conecta por ella.

**Consentimiento (RFC 7675).** Con la sesión abierta, un Binding propio al par elegido cada 5 s ± 20 %
(desde el barrido de 1 Hz del endpoint: sin temporizadores nuevos); una respuesta autenticada y
simétrica renueva el consentimiento igual que un Binding recibido. Sin ninguno de los dos en
`idleTimeoutMs` (30 s) la sesión se cierra (`timeout`).

**Coste.** El temporizador de ritmo (20 ms) solo existe mientras alguna sesión tiene checks
pendientes; en régimen quedan el Binding de consentimiento cada ~5 s por jugador (y su respuesta) y,
por cada Binding del navegador, una búsqueda en ≤ 16 pares. La ruta DTLS/SCTP no cambia (§6.5).

**Seguridad.**

* Solo se mandan checks a direcciones de la oferta o del trickle (señalización autenticada por el
  maestro) o a orígenes que ya mandaron un Binding autenticado; nunca a direcciones arbitrarias.
* **Amplificación acotada**: ≤ 16 pares por sesión, ≤ 15 envíos por par, ≤ 120 por sesión (≈ 100 B
  cada uno) y un presupuesto global de 300 checks/s (ráfaga 150) por endpoint; además las ofertas
  pasan antes por la admisión de `HostTransport` (≤ 16 negociaciones, `joinRateLimit`).
* **Destinos permitidos**: una dirección pública siempre; loopback, LAN/CGNAT/ULA o link‑local solo
  si la política (`candidatePolicy`) permitiría anunciarla o si es la clase de nuestras propias
  direcciones (`publicAddresses`, dirección de *bind*). Con la política por defecto una oferta
  manipulada no puede hacer que el host sondee su LAN o sus servicios de loopback; multicast,
  `0.0.0.0`, puerto 0, TCP y mDNS se descartan siempre (`stats().ice.remoteIgnored`).
* MESSAGE‑INTEGRITY y FINGERPRINT en todo; las respuestas STUN de la recolección deben venir del
  servidor y puerto preguntados.
* Privacidad (doc 08): igual que `ndc` con la misma `iceCandidatePolicy`; los srflx nunca llevan la
  dirección privada. Como con node-datachannel, el jugador ve la IP pública del host: para ocultarla
  sigue haciendo falta el Edge (doc 09).

**Desviaciones deliberadas de RFC 8445.**

* *Nominación* (no es una desviación, §7.3.1.5): un Binding con USE‑CANDIDATE nomina su par cuando
  **nuestro** check en ese par ha tenido éxito: en el acto si ya lo tuvo, si no al acabar el
  *triggered check* que provoca. La MESSAGE‑INTEGRITY de un Binding solo prueba que el remitente
  conoce nuestra contraseña ICE, y la conoce todo cliente que entra (va en su answer): podría
  falsear la dirección de origen de una víctima. Solo una dirección validada por nuestro check
  recibe DTLS; lo que llegue de ella antes (el ClientHello que adelanta al check) se retiene unos
  pocos datagramas y se procesa al validarse, y una petición sobre un check en curso lo retransmite
  en el acto (§7.3.1.4), así que la entrada no tarda más.
* *Conflicto de rol*: nunca pasamos a *controlling*. Un Binding con ICE‑CONTROLLED recibe 487 sea cual
  sea el desempate (el otro pasa a *controlling*, §7.2.5.1) y un 487 a un check nuestro solo lo
  reintenta. Converge con cualquier agente RFC 8445; un par ICE‑lite (ningún cliente de HaxBall lo
  es) no podría conectar.

### 2.2 TURN (RFC 8656, `turn.ts`)

Con una entrada `turn:` (UDP) en `iceServers` el endpoint hace **una asignación** desde su propio
socket IPv4 y anuncia su dirección relayed como candidato `relay` (`raddr 0.0.0.0 rport 0`) en todas
las respuestas, sin ningún otro ajuste. Sin `turn:` no cambia nada y no se asigna nada.

**Pool de asignaciones (0.3.1).** Cloudflare solo relaya para ~10 direcciones de par distintas
(ip:puerto) por asignación **en toda su vida** (reportado en cloudflare-docs#33972, no documentado):
la 11.ª no recibe nada, sin error (CreatePermission y Refresh siguen saliendo bien; solo un
ChannelBind recibe 400). Con una asignación por endpoint, una sala (o un proceso con varias salas,
que comparten endpoint) dejaba de aceptar jugadores nuevos tras ~10 direcciones, a los pocos minutos
de tráfico real, mientras los que ya estaban seguían jugando; con haxball.js no pasaba porque cada
PeerConnection hacía su asignación. Ahora cada sesión recibe el candidato relay de una asignación con
hueco: presupuesto `turnPeersPerAllocation` (8) direcciones por asignación, 2 reservadas por sesión
pendiente; una de repuesto se prepara en segundo plano (nadie espera un Allocate); un ChannelBind 400
marca la asignación como llena; las agotadas siguen sirviendo a sus jugadores y se borran (LIFETIME 0,
socket cerrado) cuando se quedan sin sesiones; tope `maxTurnAllocations` (64). La primera usa el
socket del endpoint, las demás un socket UDP propio cada una. Probado contra Cloudflare: 20/20
entradas seguidas en un endpoint (antes fallaba desde la 8.ª con una asignación ya usada por 3).
`turnPeersPerAllocation` y `maxTurnAllocations` son opciones de `RtcEndpoint.listen`, **no** de
`RtcBackendOptions`: `HBInit({ haxlite: { rtc } })` y `HostTransport` no las reenvían, así que
ahí siempre valen 8 y 64; solo se pueden fijar abriendo un `RtcEndpoint` a mano y pasándolo con
`rtc: { endpoint }`.

**Peers relay por sesión.** Con TURN, cada sesión crea pares relay (y permisos) para como mucho `MAX_RELAY_PEERS` = 4 direcciones remotas señaladas (ip:puerto) **vivas y distintas**; un par fallido o desalojado libera su sitio (un cliente que cambia de red trickla candidatos nuevos tras fallar los viejos). Además hay un tope de `MAX_RELAY_PEERS_TOTAL` = 8 direcciones señaladas con par relay en toda la vida de la sesión. Los pares *peer‑reflexive* aprendidos por el relay (una petición que llegó por él) no cuentan. Así una oferta no gasta sola el límite de ~10 direcciones por asignación de Cloudflare. `ice.describe()` añade el campo `relay`. Las constantes se exportan desde `src/rtc/ice-agent.ts`, pero `rtc` no es un espacio de nombres del paquete.

* **Allocate** con credenciales de largo plazo: la primera petición va sin autenticar, el 401 trae
  REALM/NONCE; después USERNAME/REALM/NONCE + MESSAGE‑INTEGRITY con MD5(usuario:realm:clave). 438
  (nonce caducado) se reintenta; 437 (asignación de un proceso anterior en el mismo puerto) se borra
  con Refresh de LIFETIME 0 y se repite. Refresh un minuto antes de LIFETIME (a la mitad si es < 2 min).
  Si el Allocate no contesta se prueba **en el acto** el siguiente servidor de la lista (p. ej. el
  puerto 53 de Cloudflare tras el 3478); agotada la lista, reintento con espera 5 s → 5 min. Una
  asignación perdida se rehace en el acto y las sesiones nuevas reciben el candidato nuevo.
* La primera ronda de recolección espera la asignación como a una respuesta STUN (≤ 3 s, dos
  idas y vueltas por el 401); su XOR‑MAPPED‑ADDRESS cuenta como srflx.
* **Permisos**: CreatePermission para la IP de cada candidato remoto que se empareja con el relay,
  **y para la IP desde la que el jugador llegó al maestro** (`offer.ip`, `createSession(sdp, {remoteIp})`):
  con CGNAT de pool no emparejado el NAT del jugador puede salir hacia el TURN por otra IP que hacia
  el STUN de Google, y con candidatos solo mDNS no hay otra; sin permiso el servidor TURN descarta
  sus checks. Todas las IP de un mismo turno van en **un** CreatePermission. Lo que se manda a una IP
  cuyo permiso está en vuelo se encola (≤ 4) y sale al instalarse: el primer check no paga un RTO.
* **Canales**: al primer datagrama DTLS hacia un par (validado) se hace ChannelBind; desde ahí cada
  datagrama lleva 4 B de ChannelData en vez de ~36 B de Send/Data indication. Permisos (~4 min) y
  canales (~8 min) se renuevan solo mientras hay tráfico; los números libres se reutilizan tras el
  enfriamiento del RFC.
* **ICE**: cada candidato remoto IPv4 de una clase que la política permite tiene además un par sobre
  el relay (prioridad local de tipo `relay`, se comprueba después de los directos). `TurnRelay`
  implementa la misma interfaz que el socket (`PacketIo`): pares, direcciones validadas, consentimiento
  y DTLS funcionan igual; el demux solo mira el puerto del servidor TURN (una comparación por
  datagrama) y las direcciones validadas por el relay viven en su propio mapa.
* Solo UDP hacia el servidor TURN y direcciones relayed IPv4: `turns:` y `?transport=tcp` se omiten.

**Solo relay (`iceTransportPolicy: 'relay'`)** — el equivalente a `rtc: { iceTransportPolicy: 'relay' }`
de node-datachannel (se toma de ahí en `HostTransport`, o `rtcEndpoint.iceTransportPolicy`): solo se
anuncia el candidato relay (la IP del host nunca aparece en el SDP), checks/consentimiento/DTLS solo
por el relay y nada que llegue directo de un jugador se contesta (`stats().directDropped`). Necesita
un `turn:` (si no, `listen` falla). Una sesión sin asignación lista **no** se contesta sin candidatos:
la respuesta sale con el candidato relay; si no hay asignación posible la sesión se cierra con
`'turn-unavailable'` (el join falla limpio, `stats().relayUnavailable`).

**Credenciales cortas (Cloudflare).** `iceServers` acepta tal cual la respuesta de
`generate-ice-servers` (se usan `turn:…:3478?transport=udp` y luego `:53`). Para renovarlas sin
reiniciar la sala: `room.haxlite.setIceServers(lista)` (o `HostTransport.setIceServers`,
`RtcEndpoint.setIceServers`). Las nuevas se usan en el siguiente Allocate; si el servidor es el
mismo, también en los siguientes Refresh/CreatePermission/ChannelBind de la asignación actual (un 401
con la clave vieja se reintenta con la nueva). Si el servidor rechaza las credenciales de la
asignación (401/441) se pierde y se rehace con las nuevas. Recomendado: TTL largo (p. ej. 24 h) y
renovar a la mitad:

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

Las salas de un mismo proceso con la misma configuración comparten endpoint aunque traigan
credenciales distintas (la clave de compartición ignora usuario/clave); vale la última
`setIceServers`.

## 3. Cómo configurarlo: `peerBackend: 'rtc'` (por defecto)

```ts
// HBInit
const room = await HBInit({ token, roomName: 'Sala', haxlite: {
  peerBackend: 'rtc',
  rtc: { port: 40000, publicAddresses: ['203.0.113.7'] },   // abrir 40000/udp
} });
room.haxlite.rtcPort;     // puerto UDP real (útil con port 0)
room.haxlite.rtcStats();  // contadores del endpoint (sesiones, paquetes, bytes, handshakes)

// HostTransport directo
new HostTransport({ token, peerBackend: 'rtc', rtcEndpoint: { port: 40000, publicAddresses: ['203.0.113.7'] } });
```

`rtc` (= `HostTransportOptions.rtcEndpoint`, tipo `RtcBackendOptions` en `src/net/rtc-backend.ts`):

| opción | por defecto | qué es |
|---|---|---|
| `publicAddresses` | — (ICE completo: interfaces + STUN) | candidatos `host` anunciados tal cual en lugar de las direcciones de las interfaces. Útil con un NAT 1:1 cuyo IP público STUN no ve, o para no depender de STUN (con `publicAddresses` y sin `iceServers` propios no se consulta STUN). Con `iceLite` son las **únicas** direcciones del SDP; por defecto, las IPs públicas de las interfaces, y sin ninguna `HBInit` rechaza / `new HostTransport` lanza |
| `iceLite` | `false` | modo anterior: `a=ice-lite`, sin recolección ni checks propios (el servidor tiene que ser alcanzable directamente) |
| `iceServers` | los de `HostTransport.iceServers` (por defecto `stun:stun.l.google.com:19302`, como `ndc`); `[]` si hay `publicAddresses` | servidores STUN para los candidatos srflx y TURN (UDP) para el candidato relay (cadenas `stun:host:puerto` / `turn:…`, objetos de node-datachannel o `RTCIceServer`). `turns:` y `?transport=tcp` se omiten (§2.2). Se pueden renovar en caliente con `room.haxlite.setIceServers(lista)` (§2.2) |
| `iceTransportPolicy` | la de `HostTransport.rtc.iceTransportPolicy`, si no `'all'` | `'relay'`: solo se anuncia el candidato relay y todo el tráfico va por el TURN (la IP del host no llega al jugador); necesita un `turn:` UDP en `iceServers` y no admite `iceLite` (si no, `listen` falla). Ver §2.2 |
| `iceCandidatePolicy` | la de `HostTransport.iceCandidatePolicy`, si no `'public'` | qué direcciones de interfaz se anuncian y a qué clases de dirección remota se mandan checks (§2.1). No se aplica a `publicAddresses` |
| `gatherRefreshMs` | 60 000 | antigüedad a partir de la cual una sesión nueva dispara un refresco STUN en segundo plano (la sesión usa el resultado anterior) |
| `ipv6` | `false` | usar IPv6: socket `udp6` si hay IPv6 global, candidatos IPv6 (interfaces, `publicAddresses`, srflx) y consultas AAAA. Sin ella se omiten las IPv6 de `publicAddresses` (una lista solo IPv6 es un error), `'::'` es el comodín IPv4 y otra IPv6 literal en `address` es un error (§2.1) |
| `port` | 0 (efímero) | puerto UDP único para todos los jugadores |
| `address` | comodín de cada familia de `publicAddresses` (sin ellas: `0.0.0.0`, y `::` si `ipv6` y hay IPv6 global) | dirección de *bind* |
| `publicPort` | el puerto real | puerto anunciado si un NAT 1:1 lo traduce |
| `idleTimeoutMs` / `handshakeTimeoutMs` / `maxSessions` | 30 s / 20 s / 10 000 | del endpoint; las de `HostTransport` (10 s de apertura, 10 s de inactividad, 16 negociaciones, `maxPlayers`) actúan antes |
| `certificate` | uno por proceso (`RtcCertificate.processDefault()`, clave generada de forma síncrona, ≈ 1 ms, sin despertar el *thread pool* de libuv) | certificado DTLS |
| `certificateFile` | — | PEM (certificado + clave, modo 0600) donde guardar/cargar la identidad DTLS: huella estable entre reinicios y sin generar claves al arrancar (`RtcCertificate.loadOrCreate`, E/S síncrona, escritura atómica vía `.tmp` + rename) |
| `shared` | `true` | todas las salas del proceso con la misma configuración (puerto —también 0—, direcciones, `ipv6`, certificado, tiempos, suites) comparten **un** endpoint y un socket UDP (refcontado, `src/rtc/shared.ts`); `false` = endpoint propio |
| `helloVerify` | `false` con ICE completo, `true` con `iceLite` | intercambio de cookie DTLS (HelloVerifyRequest) antes del flight 4 (~1 KB): un RTT más por entrada. Con ICE‑lite no mandamos checks y nada prueba la dirección de origen (§6.7) |
| `cipherSuites` | `['chacha20', 'aes128gcm', 'aes256gcm']` (Node y Bun) | preferencia DTLS del servidor (nombres IANA, ids o cortos); un cliente sin la primera negocia la siguiente. En Bun el AES‑GCM nativo gana la micro‑medida por registro pero pierde de extremo a extremo (§6.7) |
| `sendBatchFrames` | `0` | `1` o `2`: retiene los mensajes de `ru` (difusión de eventos de cliente) por jugador hasta la siguiente frontera de la rejilla de 60 Hz del proceso múltiplo de n; menos datagramas a cambio de n × 8,3 ms de media (máx. n × 16,7 ms) en las entradas ajenas (§6.7). Por sala, también con endpoint compartido |
| `endpoint` | — | un `RtcEndpoint` ya abierto (el backend no lo cierra) |

Qué cambia y qué no respecto a node-datachannel (`'ndc'`, por defecto):

* **Igual**: todo lo de `HostTransport` — admisión (4100–4104, bans por IP del maestro y srflx,
  hook `onJoinRequest`, límite por IP) **antes** de crear ninguna sesión, desafío, handshake ECDSA,
  límite de flood, inactividad de 10 s, kicks/bans (el aviso de kick se entrega antes del cierre),
  códigos de cierre, `Peer.remoteAddress` (aquí: origen de los STUN autenticados del jugador).
* **`iceServers` e `iceCandidatePolicy`** del transporte son los valores por defecto de los de `rtc`
  (el backend es `prefiltered`: el endpoint aplica la política a sus candidatos); `portRange` y `rtc`
  (node-datachannel) se ignoran.
* La respuesta sale **sin la espera de 500 ms** en cuanto hay un resultado STUN (el SDP ya trae
  los candidatos y `a=end-of-candidates`; durante un refresco en segundo plano, sin él y con el srflx
  nuevo por trickle si cambia); solo durante la primera ronda, como con `ndc`: ≤ 500 ms y el resto
  por trickle. Tras enviarla, el `Peer` suelta
  su SDP y sus candidatos (≈ 0,5–1 KB por jugador), y la sesión su `answerSdp` al conectar DTLS.
* **Arranque perezoso**, como `ndc` (que carga node-datachannel con el primer peer): la sala se
  anuncia al maestro en el acto y los módulos rtc, el socket y el certificado se preparan con la
  primera oferta, con `whenListening()` (HBInit lo llama al recibir el enlace y resuelve cuando el
  puerto escucha, o rechaza con el error de *bind*) o 50 ms después de `start()`, lo primero que
  ocurra. Una oferta que llega antes se contesta en cuanto escucha (`DeferredRtcPeerLink`).
* `room.haxlite.rtcStats()` da los contadores del endpoint **compartido** (todas las salas que
  lo usan).
* Los tres canales abren a la vez. **`challengeDelayMs` por defecto depende del cliente**: 0 para
  los navegadores (como el host oficial) y 10 ms para las ofertas de libdatachannel (línea de
  origen `o=rtc`: bots node-haxball), en ambos backends; un valor explícito se aplica a todos.
  Protege a *ese* cliente. Medido con node-haxball (libdatachannel), 30 entradas por configuración:
  `rtc` con 0 ms falla **29/30** (el desafío llega con la asociación SCTP, antes de que el cliente
  dé sus canales por abiertos, y lo descarta); con 10 ms y 40 ms, 0/30 (`ndc`: 5/30 con 0 ms, 0/30
  con 10 y 40). Antes eran 40 ms para todos: la entrada `rtc` con un cliente libdatachannel bajó de
  63–65 a 31–33 ms (loopback) y la de un navegador, 40 ms.
* Un `dc.close()` de un canal en el navegador (reset de stream) llega como
  `RtcSession.onChannelClose(id)` → `onChannelClosed` del backend → el peer se cierra en el acto,
  igual que el evento `closed` de un DataChannel de node-datachannel.
* En reposo: sin sesiones el endpoint no tiene temporizadores (su barrido de 1 Hz se apaga en el
  siguiente tick); queda solo el socket UDP. `room.haxlite.stop()` espera a que se libere.
* node-datachannel ya **no se carga** si no se usa (`src/net/webrtc.ts` lo importa al crear la
  primera PeerConnection): un proceso solo-`rtc` no tiene hilos nativos de WebRTC. Es una
  `optionalDependency`: con `npm install --omit=optional` (o si falla su binario precompilado) haxlite
  se instala igual; si algo lo necesita y falta, la negociación de ese peer falla con «node-datachannel
  no está instalado: instálalo o usa peerBackend: 'rtc'» (en el host llega a `onError`).
* **IPv6** solo con `rtc: { ipv6: true }` (§2.1). Con `ndc` el interruptor es
  `HostTransportOptions.rtc.ipv6` (`NdcRtcConfig`): sin él y sin `bindAddress` propio,
  libdatachannel se enlaza a `0.0.0.0` y no se manda por trickle ningún candidato IPv6.

**Recomendación**: `rtc` funciona ahora en las mismas situaciones que `ndc` (IP pública, NAT 1:1,
NAT doméstico o de nube con filtrado dependiente de dirección/puerto, NAT simétrico del lado del host,
doble NAT con hole punching; §4.4) con la mitad de CPU. TURN (RFC 8656) también funciona en `rtc`
(§2.2: entradas `turn:` UDP en `iceServers`, `iceTransportPolicy: 'relay'`, `setIceServers` en
caliente); las limitaciones son solo UDP/IPv4 hacia el TURN y que con `iceLite` no hay TURN (§7). El
valor por defecto sigue siendo `ndc` (ver la propuesta en §7); en servidores con IP pública `publicAddresses` + puerto fijo sigue siendo lo más simple.

## 4. Banco de interoperabilidad con navegadores reales (`test/rtc-interop/`)

### 4.1 Piezas

| Archivo | Qué es |
|---|---|
| `harness/client.js` | Página de prueba: **transcripción línea a línea del uso de WebRTC del cliente oficial** (`game-min.js`, clases `Ca`, `dc` y `Pb`; doc 01 §2.3–§3): `new RTCPeerConnection({iceServers}, {mandatory:{OfferToReceiveAudio:false, OfferToReceiveVideo:false}})`; tres `createDataChannel` en orden con `{id, negotiated: true, ordered}` + `maxRetransmits: 0` si no es fiable, etiquetas `ro`/`ru`/`uu`, `binaryType = 'arraybuffer'`; la oferta es el resultado de `createOffer()` (sin candidatos); espera de recolección ≤ 1000 ms; WebSocket de señalización abierto **después**; candidatos ya reunidos en la oferta, el resto por trickle, mensaje `[0]` al terminar; timeout de negociación 10 s y 4 s tras la respuesta; un mensaje o cierre de canal durante la negociación = fallo; conectado = `onopen` del canal 0; ya conectado: inactividad 10 s, `iceConnectionState` `closed`/`failed` o cualquier `onclose` ⇒ `pc.close()`; enviar por un canal no abierto ≠ 0 cae al canal 0. Diferencia deliberada: la señalización es JSON por un WebSocket local en vez de `[u8 tipo] + deflateRaw(…)` del maestro (mismo contenido y mismos tiempos) |
| `harness/wire.ts` | Formato de mensajes de prueba `[u8 tipo][u32 seq][f64 t][…]` (patrón de bytes verificable para los 20 KB) y contabilidad de recepción (cuentas, duplicados, desorden, corrupción, latencias). La página lo carga tal cual con los tipos quitados (`stripTypeScriptTypes`) |
| `harness/server.ts` | Servidor HTTP + WebSocket: sirve la página y señaliza como el host oficial a través del maestro (respuesta tras esperar ≤ 500 ms la recolección, luego trickle). Restringe el ICE a una dirección (loopback, eth0, `::1`) y opcionalmente lo pasa por el proxy con pérdida. App mínima por peer: pong en `uu`; en modo `bench`, el tráfico de host de §6 |
| `harness/backends.ts` | Backends de servidor tras la interfaz `PeerBackend` del host: `ndc` = `LocalPeerBackend` (node-datachannel, referencia) y `rtc` = `RtcEndpoint` vía el adaptador `RtcPeerBackend` |
| `harness/udp-proxy.ts` | Proxy UDP con **pérdida, retardo, jitter, reordenación y duplicación**, con semilla (mulberry32). El servidor anuncia la dirección del proxy como su candidato y no recibe los candidatos del navegador, así que **todo** el tráfico (STUN, DTLS, SCTP) pasa por él |
| `harness/browser.ts` | Lanza el Chromium preinstalado de Playwright (`/opt/pw-browsers/chromium-1194`, `executablePath` explícito; `playwright-core` fijado a **1.56.1**, la versión cuyo `browsers.json` nombra ese build). Nunca descarga navegadores |
| `suite.ts`, `ndc.interop.ts`, `rtc.interop.ts` | Escenarios (§4.2) para cada backend × condición de red |
| `udp-proxy.test.ts` | Pruebas rápidas del proxy (corren en `npm test`) |
| `nat.interop.ts` + `test/rtc/nat-sim.ts` | Servidor **detrás de un NAT simulado** (§4.4) |
| `selftest.html`, `manual-server.ts` | Prueba manual para cualquier navegador (§5.2) |

### 4.2 Escenarios

Cada escenario corre con cada backend (`ndc`, `rtc`) y cada condición:

| Condición | ICE del servidor | Navegador |
|---|---|---|
| `loopback4` | `127.0.0.1` | Chromium por defecto (candidatos host ofuscados con mDNS, como un usuario real) |
| `eth4` | primera IPv4 no interna (aquí `192.0.2.2`) | ídem |
| `loopback6` | `::1` | ídem, con `ipv6: true` en ambos backends — **se salta si la máquina no tiene IPv6** (esta VM no tiene `::1`) |
| `lossy` | `127.0.0.1` a través del proxy: **5 % de pérdida, 5 ms + U(0, 30 ms) de retardo**, 2 % de reordenación forzada (+25 ms), 1 % de duplicación, en cada sentido | ídem |
| `dtls13` | `127.0.0.1` | Chromium con `--force-fieldtrials=WebRTC-ForceDtls13/Enabled/` (ofrece DTLS 1.3) |

| Escenario | Qué comprueba |
|---|---|
| conexión | los 3 canales `open` en ambos lados, `connectionState = connected`, tiempo de entrada |
| mensajes en los 3 canales | 300 mensajes de 64 B por canal y sentido: `ro` todos y en orden; `ru` todos, sin duplicados (orden libre); `uu` sin duplicados ni corrupción y ≥ 90 % (≥ 50 % con pérdida); 0 mensajes de texto; 0 fallos de `send` |
| 20 KB | 10 mensajes de 20 000 B (fragmentados en ~17 paquetes SCTP) por canal y sentido, intactos en `ro`/`ru`; en `uu` solo integridad (una ráfaga de 200 KB sin retransmisión puede perder mensajes, ver §5.3) |
| 30 clientes | 3 páginas × 10 PeerConnections a la vez, 20 mensajes por canal y sentido en cada una; luego cierre de los 30 y el servidor debe verlos todos |
| el navegador cierra la PC | el servidor lo detecta |
| el navegador cierra un canal | `dc.close()` de `ru` ⇒ el cliente oficial cierra todo ⇒ el servidor lo detecta |
| el servidor cierra | el navegador lo detecta |
| reconexión | 3 rondas conectar → intercambiar → cerrar (alternando quién cierra) |
| envío inmediato al abrir | el servidor manda un mensaje por cada canal en el instante en que abre el canal 0 (como el *challenge* del host oficial) y el cliente oficial no debe fallar |
| inactividad 40 s | sin datos de aplicación (inactividad del cliente desactivada) la conexión sigue viva gracias al consentimiento ICE y vuelve a transmitir |

Ejecutar:

```sh
npm run test:interop                                   # todo (≈ 7 min)
RTC_INTEROP_BACKENDS=rtc RTC_INTEROP_CONDITIONS=lossy npm run test:interop
RTC_INTEROP_IDLE=0 …                                   # sin las pruebas de 40 s
RTC_INTEROP_REPORT=/tmp/obs.json …                     # vuelca tiempos medidos (cierres, entrada, uu)
```

`npm test` no lanza navegadores (los archivos son `*.interop.ts`, con su propio
`test/rtc-interop/vitest.config.ts`).

### 4.3 Cliente oficial real (`official-client.interop.ts`) y host haxlite completo

El **cliente web oficial sin modificar** (`game.html`, `game-min.js` versión `0349dd60`, `res.dat`,
`vendor/*.js`, CSS) en Chromium 141 headless, contra una sala creada con `HBInit` (host haxlite
completo) con cada backend, sin red:

* Playwright `context.route` sirve los archivos bajo su URL real
  (`https://www.haxball.com/H4mQWPXF/__cache_static__/g/…`), proxifica
  `https://www.haxball.com/rs/api/*` (`api/client`, `api/geo`…) al `FakeMaster` y devuelve vacío
  para el resto (Google Fonts; reCAPTCHA nunca se pide). `https://www.haxball.com/play?c=<id>` es
  una página mínima propia con el `<iframe>` del juego: **el cliente se niega a arrancar fuera de
  un iframe** (`window.self != window.top`) y lee `?c=` de `window.top`.
* `context.routeWebSocket` puentea `wss://p2p.haxball.com/client?id=…&token=…` al WebSocket de
  señalización de clientes del `FakeMaster` (códigos de cierre preservados).
* WebRTC real: Chromium ⇄ haxlite por 127.0.0.1.

El test elige el apodo en el diálogo «Choose nickname» (el cliente siempre lo muestra), entra por
el enlace de la sala y comprueba: `onPlayerJoin` en el host y la lista de jugadores en la vista de
juego del cliente; flecha → mantenida 0,6 s ⇒ inputs en el host y el disco se mueve > 20 unidades;
anuncio del host visible en el chat del cliente y mensaje escrito en el chat del cliente recibido
por `onPlayerChat`; `CheckConsistency` cada 60 frames (≥ 3 durante la prueba) sin ningún informe de
desincronización; `kickPlayer` ⇒ diálogo oficial «You were kicked» con nuestro motivo; ningún error
de página.

| backend | resultado | página → `onPlayerJoin` | inputs | CheckConsistency / desync |
|---|---|---:|---:|---:|
| `ndc` | ✅ (2/2 corridas) | 1 468–1 471 ms | 26 | 4 / 0 |
| `rtc` | ✅ (2/2 corridas) | 1 348–1 353 ms | 26 | 4 / 0 |

(Incluye ≈ 1 s de espera de recolección ICE del cliente, §5.1.) Los archivos del cliente son de
HaxBall (todos los derechos reservados) y **no** están en el repositorio; la suite se salta sin
ellos. Para correrla:

```sh
D=/ruta/al/cliente; B=https://www.haxball.com/H4mQWPXF/__cache_static__/g
mkdir -p $D/vendor $D/images $D/icons/css $D/icons/font
for f in game.html game-min.js game.css res.dat modernizr-custom.js vendor/pako-jszip.min.js \
  vendor/perfect-scrollbar.min.js vendor/json5.min.js icons/css/fontello.css icons/font/fontello.woff2 \
  images/bg.png images/flags.png images/haxball.png; do curl -sSf $B/$f -o $D/$f; done
HAXBALL_CLIENT_DIR=$D npm run test:interop -- official-client
```

Además, las suites E2E del host (`test/host/e2e*`), de la API (`test/api`: hbinit, extensiones,
varias salas, paridad con el headless oficial, apagado limpio del paquete construido) y del
transporte (`test/net/transport*.test.ts`) corren **dos veces** en `npm test`: proyecto vitest `ndc`
y proyecto `rtc` (`HAXLITE_TEST_PEER_BACKEND=rtc`, `test/peer-backend-env.ts`). Sus clientes son
node-haxball y el cliente crudo de `test/net/raw-client.ts`, ambos libdatachannel: una segunda
implementación WebRTC independiente frente a haxlite-rtc. Todas convergen (estados idénticos byte
a byte, sin desync), y kicks, bans (IP del maestro + srflx, auth), flood, inactividad, sala llena,
contraseña y apagado se comportan igual. `test/net/rtc-backend.test.ts` cubre lo específico
(configuración, candidatos anunciados, cierre de un canal, kick + ban, endpoint sin
temporizadores en reposo). En el proyecto `rtc` el proceso hijo del test de apagado comprueba que
node-datachannel nunca se cargó.

### 4.4 Detrás de NAT (simulado en espacio de usuario)

La VM no tiene `ip` (sin veth ni netns configurables) y tocar iptables del host compartido no es
opción, así que el NAT se simula con sockets UDP (`test/rtc/nat-sim.ts`, `UdpNat`): el servidor
escucha **solo en 127.0.0.1**, no anuncia ningún candidato host (la política `'public'` descarta
loopback) y solo sale al exterior a través de **alias**: por cada dirección exterior R el NAT tiene un
socket interior alias(R); lo que el servidor manda a alias(R) sale por el socket exterior de su
*mapping* (en la IP no loopback de la VM, el lado «público») hacia R, y lo que llega a ese socket
exterior desde R' se entrega al servidor desde alias(R') **solo si la regla de filtrado lo permite**.
Las pruebas reescriben los candidatos remotos que aprende el servidor (oferta, trickle, dirección del
STUN) a sus alias: ese es el «enrutado» por el NAT; los sockets del servidor se comportan exactamente
como tras un NAT real. *Mapping* RFC 4787 independiente del extremo o dependiente de dirección(+puerto)
(simétrico); filtrado independiente, dependiente de dirección o de dirección+puerto (por defecto, el
más estricto habitual). Un servidor STUN mínimo (`FakeStunServer`) en el lado público da el srflx.

| prueba | cliente | resultado |
|---|---|---|
| `test/rtc/nat.test.ts` (en `npm test`) | libdatachannel (node-datachannel) | ✅ NAT de puerto restringido: un solo candidato (srflx = IP:puerto exterior del NAT, `raddr 0.0.0.0`), checks propios, datos ida y vuelta · ✅ NAT simétrico (el cliente aprende nuestro prflx) · ✅ **ambos lados** tras NAT de puerto restringido (hole punching doble) · ✅ consentimiento: nuestros checks de consentimiento respondidos · ✅ **control**: sin los candidatos del cliente (= sin checks) no conecta y el NAT cuenta los checks del cliente descartados |
| `test/net/rtc-nat.test.ts` (en `npm test`) | **3 clientes node-haxball** por el FakeMaster contra `HostTransport` `peerBackend: 'rtc'` sin `publicAddresses` | ✅ los tres entran, canales abiertos, `stats().ice.checksSucceeded ≥ 3` |
| `test/rtc-interop/nat.interop.ts` (`npm run test:interop`) | Chromium 141 (cliente transcrito del oficial) | ✅ rtc con host mDNS + srflx del navegador · ✅ rtc con host IP revelada sin STUN · ✅ rtc tras NAT simétrico · ✅ **control**: rtc sin candidatos remotos → falla · ✅ **control**: rtc `iceLite` → falla · ✅ **referencia**: `ndc` (libjuice) tras el mismo NAT conecta igual |

En todos los casos que conectan el servidor ve al jugador en un alias del NAT (todo pasó por él) y la
entrada tarda lo mismo que sin NAT (un único check propio basta: llega antes de que el navegador
tenga la respuesta). Las pruebas unitarias (`test/rtc/ice-agent.test.ts`) cubren formato de los
checks, retransmisión y abandono, respuestas falsificadas y no simétricas, 487, *triggered checks* y
prflx, destinos prohibidos (LAN, loopback, multicast, mDNS, TCP, puerto 0), topes de pares y envíos,
recolección (trickle a sesiones creadas durante una ronda, STUN caído, refresco) e ICE‑lite sin checks.

## 5. Matriz de interoperabilidad

### 5.1 Resultados (Chromium 141.0.7390.37, headless, Linux x86‑64)

| Backend | loopback4 | eth4 | lossy (5 % / 30 ms) | dtls13 | loopback6 |
|---|---|---|---|---|---|
| node-datachannel 0.33 (libdatachannel 0.24) | ✅ 10/10 | ✅ 9/9 ¹ | ✅ 10/10 | ✅ 9/9 ¹ | sin IPv6 en la VM |
| **haxlite-rtc** | ✅ 10/10 | ✅ 9/9 ¹ | ✅ 10/10 | ✅ 9/9 ¹ | sin IPv6 en la VM |

¹ Sin la prueba de 40 s (solo se corre en `loopback4` y `lossy`).

Tiempos medidos (`RTC_INTEROP_REPORT`, rangos de 2–3 corridas; «limpio» = loopback4, eth4 y
dtls13):

| Medida | node-datachannel | haxlite-rtc |
|---|---:|---:|
| entrada (oferta → canal 0 abierto), limpio / pérdida | 1 072–1 083 / 1 336–1 340 ms | 1 021–1 049 / 1 316–1 332 ms |
| el navegador cierra la PC → el servidor lo nota, limpio / pérdida | 2–4 / 21–23 ms | 2–3 / 20–22 ms |
| `dc.close()` de `ru` → `onclose` en el navegador, limpio / pérdida | 3–6 / 55–60 ms | 2–10 / 54–59 ms |
| el servidor cierra → el navegador lo nota, limpio / pérdida | 8–19 / 24–28 ms | 8–17 / 29–38 ms |
| ráfaga de 10 × 20 KB por `uu` servidor → navegador (limpio) | 6–10 / 10 | 10 / 10 siempre |
| mensajes enviados por el servidor al abrirse el canal 0, por canal `ro/ru/uu` | 3 / 0 / 0 | 1 / 1 / 1 |

La entrada ronda 1 s porque Chromium no da por terminada la recolección ICE en este entorno y
el cliente oficial espera su tope de 1000 ms antes de mandar la oferta; el resto (≈ 50 ms con
haxlite-rtc, ≈ 80 ms con node-datachannel, en loopback) es señalización + ICE + DTLS + SCTP.

### 5.2 Firefox, Safari y móviles: pendiente

No hay Firefox ni WebKit instalados en la VM, así que esas columnas están **pendientes**. Para
probarlos (cualquier navegador, incluso un móvil en la misma red):

```sh
node --no-warnings --import ./bench/ts-resolve.mjs \
  test/rtc-interop/manual-server.ts rtc            # o ndc; opcional: <IP ICE> <puerto HTTP>
# → abre http://<IP>:8080/selftest.html en el navegador a probar y pulsa «Probar»
```

`selftest.html` usa el mismo cliente (`client.js`) y comprueba: conexión, 200 mensajes por canal
en ambos sentidos, 20 KB por `ro`/`ru`, 40 s de inactividad, cierre desde el servidor,
reconexión y cierre desde el navegador. Muestra una tabla OK/FALLO y un JSON (con el
`userAgent`) para pegar en un issue. El puerto HTTP y el ICE deben ser alcanzables desde el
dispositivo (el ICE usa un puerto UDP efímero en esa IP; abrirlo en el firewall o probar en la
misma LAN). Safari exige que la página no sea `file://`; HTTP plano en LAN funciona para data
channels (no se piden cámara ni micrófono).

### 5.3 Observaciones

- **Cierres con pérdida**: el reset de stream (RFC 6525) de un `dc.close()` y el ABORT de un
  cierre del servidor llegan en decenas de ms con 5 % de pérdida en ambos backends. (Una versión
  anterior del banco cerraba el proxy en cuanto el servidor veía el cierre y cortaba así la
  respuesta del reset; parecía un fallo de node-datachannel y no lo era.)
- **node-datachannel abre `ru`/`uu` después de `ro`**: en el servidor, el evento *open* de los
  canales 1 y 2 llega después del del canal 0, también en loopback. Lo que el host envía
  justo al abrirse el canal 0 por `ru`/`uu` cae al canal 0 (comportamiento oficial de `Za.pb`).
  haxlite-rtc abre los tres a la vez (la asociación SCTP es una sola).
- **`uu` con ráfagas grandes**: de 10 × 20 KB seguidos por `uu` (sin retransmisión),
  node-datachannel pierde a veces 1–4 mensajes incluso sin pérdida de red; haxlite-rtc los
  entregó todos en todas las corridas. HaxBall solo manda mensajes pequeños por `uu`.
- **`cleanup()` de node-datachannel**: cuando el camino UDP desaparecía a mitad de un cierre
  (el proxy cortado, como un jugador que pierde la conexión mientras se desconecta), al apagar
  el servidor se registró `cleanup timeout (possible deadlock)` (riesgo descrito en §1). No
  rompe nada, pero `cleanup()` tarda su timeout entero.
- **Inactividad del cliente oficial**: el cliente cierra a los 10 s sin recibir nada. Un host real
  nunca calla tanto (heartbeats cada ~117 ms), pero una prueba que conecta 30 clientes con
  pérdida y no manda nada hasta tenerlos todos sí lo dispara; esas pruebas la desactivan.

## 6. Benchmarks (`bench/rtc/`)

Peers reales: Chromium 141 headless (10 PeerConnections por página, cada una con el cliente de
§4.1) contra el servidor del banco en modo `bench`, en un proceso aparte que es el que se mide.
Ese proceso se empaqueta antes con rolldown a JS plano (sin cargador de TypeScript) y solo carga
el backend que se mide.

Tráfico tipo HaxBall (doc 04): cada cliente manda un *input* por `ro` a 8 Hz de media (Poisson:
el cliente oficial solo lo manda cuando cambia) y un ping por `uu` cada 1 s; el servidor
reenvía cada input a **todos** los peers por `ru` (como `jd` del host oficial), contesta los
pings por `uu` y manda un *heartbeat* por `uu` a cada peer cada ≥ 7 frames (≈ 117 ms) desde un
tick de 50 ms. Mensajes de 13–31 B. Con N peers el servidor envía ≈ 8·N² + 9,6·N mensajes/s
(N = 30: ≈ 7 500/s) y recibe ≈ 9·N/s.

Métricas del proceso servidor: CPU = (utime + stime de todos los hilos) / tiempo de pared, en %
de **un** núcleo; hilos = `/proc/<pid>/task`; RSS (media de la ventana); heap V8 usado; fds
abiertos (`/proc/<pid>/fd`). Latencias medidas en el navegador: RTT del ping (`uu`), RTT
input → su propio evento (`ro` → `ru`, la latencia que siente un jugador) y retardo en un
sentido de los heartbeats (mismo reloj de pared en ambos extremos). Ventana de 30 s tras 5 s
de calentamiento; dos repeticiones (`bench/results/rtc-backends-1.json`, `-2.json`); se dan
ambas cuando difieren. VM de 4 vCPU compartida con Chromium (que corre en las mismas CPUs).

| backend | peers | CPU % | hilos (reposo → carga) | RSS MB (reposo → carga) | heap MB | fds (reposo → carga) |
|---|---:|---:|---:|---:|---:|---:|
| node-datachannel | 1 | 1,6 / 1,3 | 11 → 19 | 74 → 78 | 8,5 | 23 → 28 |
| **haxlite-rtc** | 1 | 1,5 / 1,5 | **7 → 7** | 72 → 72 | 9,9 | **24 → 24** |
| node-datachannel | 10 | 9,8 / 9,9 | 11 → 19 | 74 → 82 | 9,2 | 23 → 37 |
| **haxlite-rtc** | 10 | **7,0 / 7,1** | **7 → 7** | 70 → 80 | 11,5 | **24 → 24** |
| node-datachannel | 30 | 48,7 / 47,5 | 11 → 19 | 79 → 91 | 9,5–10 | 23 → 57 |
| **haxlite-rtc** | 30 | **25,0 / 26,1** | **7 → 7** | 72 → 83 | 13,9–15,1 | **24 → 25** |

| backend | peers | ping RTT p50 / p99 ms | input → evento p50 / p99 ms | heartbeat 1 vía p50 / p99 ms |
|---|---:|---:|---:|---:|
| node-datachannel | 1 | 1,2–1,4 / 2,2 | 1,2–1,4 / 3,1–4,7 | 0,8 / 3,0–3,7 |
| haxlite-rtc | 1 | 1,4 / 1,9–2,1 | 1,4–1,5 / 2,4–5,1 | 1,0–1,2 / 2,2–2,8 |
| node-datachannel | 10 | 1,2 / 3,9–5,0 | 1,3–1,4 / 5,2–5,6 | 0,7–0,8 / 3,2–4,2 |
| haxlite-rtc | 10 | 1,1 / 2,5–3,8 | 1,5–1,6 / 3,8–4,0 | 0,8–0,9 / 2,3–2,9 |
| node-datachannel | 30 | 1,5–1,6 / 10,1–10,2 | 2,2–2,4 / 11,7–13,6 | 1,4–1,5 / 5,5–6,0 |
| haxlite-rtc | 30 | 1,0–1,1 / 7,4–13,1 | 2,3–2,5 / 8,3–14,0 | 1,4–1,6 / 4,9–8,2 |

Lectura:

- **CPU**: con 30 peers y ≈ 7 500 mensajes/s de salida, haxlite-rtc gasta **la mitad** que
  node-datachannel (25–26 % frente a 47–49 % de un núcleo); con 10 peers, un 28 % menos; con 1
  peer, igual (lo domina el resto del proceso).
- **Hilos y fds**: haxlite-rtc no crea ninguno: 7 hilos (los de Node) y los mismos fds con 0 o
  30 peers (un socket UDP compartido). node-datachannel pasa a 19 hilos con el primer peer y abre
  ~1 fd por peer (un socket UDP por PeerConnection).
- **Memoria**: RSS parecido; el heap de V8 es algo mayor con haxlite-rtc (+5 MB con 30 peers)
  porque el estado DTLS/SCTP vive en JS, mientras que el de libdatachannel está fuera del heap
  (dentro del RSS).
- **Latencia**: equivalente; las medianas están en 1–2,5 ms en ambos. Los p99 con 30 peers
  (5–14 ms) varían entre repeticiones y los dominan el planificador y Chromium compitiendo por
  las mismas 4 CPU, no el backend.

Reproducir (siempre con el cerrojo compartido de benchmarks de la VM):

```sh
flock /tmp/haxlite-bench.lock node --no-warnings \
  --import ./bench/ts-resolve.mjs bench/rtc/run.ts \
  [--backends ndc,rtc] [--peers 1,10,30] [--seconds 30] [--warmup 5] [--input-hz 8] \
  [--per-page 10] [--out bench/results/rtc-backends.json]
```

### 6.1 CRC32c del SCTP

Chromium 141 no negocia el *zero checksum* (RFC 9653), así que cada paquete SCTP lleva CRC32c en
ambos sentidos. `test/rtc/sctp/bench.ts` (dos asociaciones en proceso, mensajes de 30 B; mismo
proceso y build, 3 corridas intercaladas, `flock`):

| variante | ns/mensaje |
|---|---:|
| `ro` sin CRC (zero checksum) | 341–375 |
| `ro` con CRC32c (como con Chromium) | 510–532 |

El CRC son ≈ 170–190 ns por mensaje de ida y vuelta (≈ 35 %; ~150 B checksumeados: paquete de
datos de 60 B en ambos extremos + medio SACK de 28 B), ≈ 0,8 B/ns. La implementación ya era
*slicing‑by‑8* (8 tablas, 8 B por iteración). Se probaron, con un micro‑benchmark de la mezcla real
de paquetes y en el benchmark de asociación:

| alternativa | resultado |
|---|---|
| *slicing‑by‑16* (una tabla de 16 KiB o 16 tablas separadas) | igual o peor (±10 %, ruido) |
| lecturas de 32 bits vía un alias `Int32Array` de los buffers de envío alineados | −0–10 % en el micro, no medible en la asociación |
| verificación en una pasada (campo puesto a cero y restaurado) en vez de tres llamadas | no medible |
| WebAssembly *slicing‑by‑16* (clang `--target=wasm32 -O3`) copiando el paquete a la memoria lineal | 97–130 ns para 28–58 B (2–3× **peor**); solo gana desde ~1 KiB |
| ídem sin copia (paquete ya en memoria WASM) | 31–49 ns para 28–58 B frente a 37–60 ns en JS: −15–20 % a cambio de mover los buffers de la asociación a memoria WASM |

Ninguna mejora justifica el cambio: el límite son las cargas de *typed arrays* (un byte y una
entrada de tabla por byte), no el ancho del *slicing*; WASM SIMD no tiene multiplicación sin
acarreo. Se mantiene *slicing‑by‑8* (con las pruebas de vectores RFC 3720 y de equivalencia
aleatoria contra una implementación de una tabla y contra la bit a bit, incluidas actualizaciones
partidas y `Buffer` con desplazamiento no alineado). Para un host lo que pesa es el envío (≈ 8·N²
mensajes salientes frente a 9·N entrantes), y el beneficio global del backend `rtc` ya se mide en
§6.2.

### 6.2 Host completo con 20 clientes: `rtc` vs `ndc`

`bench/net/run.ts game` (docs/07, sección final): mismo build, 20 clientes node-haxball jugando,
3 × 60 s:

| backend | CPU % | hilos | fds | RSS MB | heap MB |
|---|---:|---:|---:|---:|---:|
| `ndc` | 18,97 · 19,46 · 18,74 | 19 | 27 | 84 | 9,9 |
| **`rtc`** | **12,45 · 12,35 · 12,53** | **11** | 25 | 86–90 | 14,3 |

−35 % de CPU del proceso host completo (juego + red), 8 hilos nativos menos; lag del event loop p99
1,13–1,20 → 1,30–1,50 ms.

### 6.3 Pasada GC / bundling (SCTP, backend `rtc`, host)

Objetivo: bajar la basura de la ruta de datos (GC) sin añadir latencia. Cambios (W1; los de
DTLS/endpoint —ChaCha20-Poly1305 en JS, registros sellados en un búfer compartido, envío UDP
síncrono— son de la pasada paralela de W2 y entran en la columna «después»):

- **Bundling por paso del host** (`src/net/rtc-backend.ts`, `src/host/host-room.ts`): el primer
  `send` a un peer «corcha» su asociación SCTP; `HostRoom` envuelve cada despertar del reloj, cada
  mensaje de cliente y cada acción de nivel superior en `backend.cork()/uncork()`, y al cerrar el
  ámbito más externo cada peer recibe **un paquete SCTP** con todos sus mensajes (evento en `ru`,
  heartbeat en `uu`, pong…, más el SACK que se le debe: RFC 9260 §6.10, hasta la MTU y la ventana
  de congestión). El flush ocurre antes de devolver el control al event loop: **cero latencia
  añadida**. Envíos fuera de ámbito (desafío, kick desde código de usuario) se agrupan con un único
  `setImmediate` (misma iteración). Cerrar un enlace vacía antes su lote (el kick precede al
  ABORT). Mientras está corchada, la asociación difiere también el SACK de fin de `input`.
  (Después pasó a **un vaciado por iteración del event loop**, §6.7.)
- **Recepción sin asignaciones**: opción `transientDelivery` de `SctpAssociation` (la sesión la
  activa): un mensaje no fragmentado se copia a un búfer de trabajo por asociación y se entrega
  como vista cacheada de su longitud, válida solo durante `onMessage`. `HostTransport` copia el
  único mensaje que retiene (el handshake, que cruza un `await`) y `HostRoom` el de la cola
  diferida. `input(packet, off, len)` acepta el registro descifrado en su sitio, sin vista.
- **Temporizadores**: un montículo de plazos por proceso con un solo `setTimeout`
  (`src/rtc/sctp/timers.ts`) para las asociaciones con reloj/temporizadores por defecto: mover el
  T3 en cada SACK ya no crea un `Timeout`.
- **Reloj**: cada `performance.now()` asigna un HeapNumber en Node (~16 B). El reloj SCTP es de
  milisegundos enteros (Smi) y se **congela** durante un flush del lote y durante los disparos del
  montículo (`src/rtc/sctp/clock.ts`): una lectura por lote en vez de una por peer.
- **Sin *boxing***: los valores de 32 bits fuera del rango Smi (TSN, CRC32c) devueltos o pasados
  a funciones no *inlined* se empaquetan en un HeapNumber. El CRC se verifica con una función
  booleana (`sctpChecksumMatches`) y el ack acumulado / a_rwnd del SACK pasan por campos.

**Micro‑benchmark** `bench/rtc/sctp-host-alloc.ts` (SctpAssociation + `RtcPeerLink` + ámbitos de
bundling con tráfico HaxBall: 20 peers, 60 Hz, inputs a 8 Hz por `ro`, ping 1 Hz, heartbeat cada 7
frames, eco a todos por `ru`; perfil de asignaciones de V8 incluyendo objetos ya recolectados;
los «navegadores» usan otra copia del módulo para separar sus asignaciones):

| variante (300 s simulados) | mensajes / paquetes de salida | asignación del host |
|---|---:|---:|
| bundling por ámbito (como `HostRoom`) | 1 034 860 / 1 034 860 | **8,8 B/mensaje** — todo es la lectura de reloj por paquete recibido (`performance.now()`) |
| `--no-bundle` (flush en cada `send`, como antes) | 1 034 860 / 1 034 860 | 8,7 B/mensaje (ídem) |
| `--const-clock` (reloj inyectado constante) | 1 034 860 / 1 034 860 | **0,00 B/mensaje** (1,6 KiB en total) |

Sin contar las lecturas de reloj, la ruta SCTP + `RtcPeerLink` + bundler **no asigna nada** en
régimen estacionario (antes: una vista por mensaje recibido, un `Timeout` por re‑armado, un
HeapNumber por SACK y por CRC verificado, las listas del lote). Con este tráfico el bundling no
reduce paquetes (1,00 mensajes/paquete en ambos casos): cada paso del host envía un mensaje por
peer.

**Host completo**, `bench/net/run.ts game`, N = 20 clientes node-haxball, 3 × 60 s, misma
sesión y `flock` (`bench/results/gc-bundling.json`; «antes» = build de `b423ffb`, «después» = el
árbol con ambas pasadas):

| variante | CPU % | GC/min | GC ms/min | heap MB | RSS MB | lag p99 ms | UDP salida / entrada /s |
|---|---:|---:|---:|---:|---:|---:|---:|
| `rtc` antes | 7,34 · 7,73 · 8,23 | 55 · 55 · 55 | 138 · 139 · 140 | 14,3 | 87,4 | 2,09 · 2,37 · 4,07 | 2 620–2 660 / 1 520–1 545 |
| **`rtc` después** | **5,30 · 6,08 · 5,76** | 49 · 50 · 50 | **19 · 20 · 23** | 14,2 | **77,8 · 81,4 · 82,0** | 2,23 · 3,05 · 2,02 | 2 575–2 630 / 1 500–1 530 |
| `ndc` antes | 11,30 · 12,14 · 12,30 | 10 · 8 · 8 | 3,3 · 3,8 · 2,6 | 9,9 | 84,2–85,2 | 1,80 · 2,35 · 2,53 | — |
| `ndc` después | 11,78 · 12,73 · 12,07 | 9 · 11 · 7 | 3,6 · 3,6 · 2,2 | 10,0–10,1 | 82,8–84,3 | 2,01 · 2,29 · 1,85 | — |

Lectura:

- **CPU −25 %** (7,7 → 5,8 %, mediana; menos de la mitad que `ndc`) y **tiempo de GC ÷ 6–7**
  (139 → 20 ms/min: las recolecciones jóvenes pasan de ~2,5 ms a ~0,4 ms porque casi no sobrevive
  nada). **RSS** −5 a −10 MB: ahora por debajo de `ndc`.
- **El bundling apenas reduce datagramas** (−1 %): con este tráfico cada paso del host lleva ~1
  mensaje por peer (los inputs llegan repartidos en el tiempo) y agruparlos más exigiría retrasar
  envíos. La cadencia de datagramas (≈ 2 600/s de salida, ≈ 1 500/s de entrada, casi todo SACKs
  de los clientes) queda fijada por el tráfico.
- **Número de GC y heap: `ndc` sigue ganando.** Del ~1,5 MB/s de basura joven que queda, la pila
  SCTP + backend aporta ≈ 0,04 MB/s (lecturas de reloj); el resto es por datagrama dentro de Node
  (`dgram.send`: ~0,67 MB/s en SendWrap/listas/vistas; recepción: Buffer + `rinfo` ≈ 0,5 MB/s) y la
  física (`collideDiscSegment` ≈ 0,12 MB/s, también presente en `ndc`). Con un semiespacio de
  ~1 MB eso son ~50 recolecciones/min; `ndc` hace ese trabajo en hilos nativos. El heap (+4 MB)
  es, según el análisis de la pasada DTLS, sobre todo código y fuentes de los módulos DTLS/SCTP
  cargados (el estado SCTP por peer son unos pocos KB en *typed arrays*). Cifras de basura: perfil
  de asignaciones del proceso host (`HOST_ALLOC_PROFILE`), N = 20.
- **Lag p99**: sin cambio claro (2,0–3,1 frente a 1,9–2,5 ms de `ndc`); la red sigue corriendo en
  el hilo JS.

### 6.4 Pasada DTLS / endpoint / arranque (W2)

Cambios (`src/rtc/dtls/*`, `endpoint.ts`, `session.ts`, `cert.ts`, `shared.ts`, arranque del
backend `rtc`):

- **ChaCha20‑Poly1305 en JS puro** (`src/rtc/dtls/chacha.ts`) como suite preferida. node:crypto
  necesita un objeto `Cipher` nativo nuevo por registro (un AEAD no admite otro nonce) más búferes
  de salida y de etiqueta: era la mayor fuente de basura y los objetos con respaldo nativo alargan
  las pausas. La implementación nueva cifra en el sitio en un búfer compartido, descifra en el
  sitio en el datagrama recibido **después** de verificar la etiqueta, y no asigna nada. Tiempo
  constante en lo que JS permite: ChaCha20 es ARX sobre int32; Poly1305 usa limbs de 13 bits
  (disposición de poly1305‑donna‑16) cuyas sumas parciales quedan < 2^32, reducción final con
  máscaras y comparación de etiqueta por OR de diferencias; sin ramas ni tablas dependientes de
  secretos. **AES no se implementa en JS** (las tablas no son de tiempo constante): AES‑GCM sigue
  en node:crypto para clientes sin ChaCha20, con la preferencia configurable (`cipherSuites`).
  Validación: vectores RFC 8439 §2.5.2 / §2.8.2 / A.3 (#5–#9), Poly1305 contra una referencia
  BigInt, y **3 000 000 de casos aleatorios** (claves, nonces, AAD 0–40 B, 0–1 300 B,
  desplazamientos no alineados) idénticos a `chacha20-poly1305` de node:crypto
  (`HAXLITE_CHACHA_CASES=3000000 npx vitest run test/rtc/chacha.test.ts`); OpenSSL `s_client
  -dtls1_2` con la suite por defecto y con `-cipher ECDHE-ECDSA-CHACHA20-POLY1305` (y un cliente
  solo‑AES negocia AES‑128‑GCM); repetición y registros alterados se descartan con ambas AEAD.
- **Chromium 141 ofrece ChaCha20 en DTLS 1.2 y lo negocia**: `getStats()` del navegador da
  `dtlsCipher: TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256` (`test/rtc/chromium-dtls.test.ts`;
  con `cipherSuites: ['aes128gcm', …]` da AES‑128‑GCM). Toda la suite de interoperabilidad (§4,
  80 escenarios) y el cliente oficial sin modificar (§4.3) pasan con ChaCha20.
- **Envío sin basura propia**: `dgram` con una `lookup` síncrona para literales IP (sin
  `dns.lookup` + `process.nextTick` + dos cierres por datagrama, y el envío queda síncrono), los
  registros se sellan en **un** búfer por endpoint (sustituido si el kernel encola un envío con
  EAGAIN, comprobado con `getSendQueueCount()`) y se envían con vistas de longitud exacta
  cacheadas. Recepción: el registro descifrado pasa a SCTP como `(datagrama, off, len)`.
  Tras el handshake se liberan secreto maestro, ECDHE y clave del cliente.
- **Endpoint compartido por defecto** (`src/rtc/shared.ts`, opción `rtc.shared`, por defecto
  `true`): las salas de un proceso con la misma configuración comparten un endpoint refcontado (un
  socket UDP); el último en salir lo cierra. 10 salas = 1 socket.
- **Arranque**: certificado por proceso (`processDefault`; hoy generado de forma síncrona, §6.7; opcional
  `certificateFile` en disco); el backend anuncia la sala en el acto y levanta módulos, socket y
  certificado de forma perezosa (§3). Antes, `start()` cargaba los módulos rtc (~5 ms), generaba
  la clave (~3–7 ms la primera vez) y abría el socket **antes** de hablar con el maestro.

Micro‑benchmark de la AEAD (cifrar + descifrar un registro, mismo proceso, 300 000 registros;
`GC` = recolecciones por 100 000 registros):

| tamaño | node AES‑128‑GCM | node ChaCha20‑Poly1305 | **JS ChaCha20‑Poly1305** |
|---:|---:|---:|---:|
| 50 B | 6,6 µs · 71 GC (83 ms) | 9,2 µs · 35 GC (71 ms) | **1,8 µs · 0 GC** |
| 120 B | 7,5 µs · 35 GC (79 ms) | 9,8 µs · 35 GC (79 ms) | **2,3 µs · 0 GC** |
| 300 B | 10,7 µs · 35 GC (62 ms) | 13,4 µs · 35 GC (68 ms) | **4,7 µs · 0 GC** |
| 600 B | 10,3 µs · 70 GC (56 ms) | 11,7 µs · 35 GC (68 ms) | **8,2 µs · 0 GC** |
| 1 200 B | 10,6 µs · 35 GC (62 ms) | 14,7 µs · 35 GC (67 ms) | 15,8 µs · 0 GC |

(El JS gana hasta ~800 B; los registros de HaxBall son de 30–400 B.)

Perfil de asignaciones del host con N = 20 (`HOST_ALLOC_PROFILE`, incluye lo ya recolectado):
**≈ 5,5 → 1,4 MB/s** de basura joven con ambas pasadas. Lo que queda es de Node: `dgram.send`
≈ 0,67 MB/s (SendWrap, lista, cierre por datagrama) y la recepción (Buffer + `rinfo`) ≈ 0,54 MB/s;
`ndc` asigna ≈ 0,16 MB/s en total.

**Host completo**, misma sesión, `flock`, intercalado («antes» = build de `b423ffb`, «después» =
árbol con las pasadas de W1 y W2; mediana de 3 × 60 s, arranque 10 repeticiones;
`bench/results/rtc-dtls-endpoint-{startup,game,rooms}.json`):

| escenario | métrica | `ndc` antes | `rtc` antes | `ndc` después | **`rtc` después** |
|---|---|---:|---:|---:|---:|
| arranque | proceso → link (ms) | 105,8 | 118,5 | 105,8 | **109,0** |
| | creación → link (ms) | 12,8 | 23,0 | 12,7 | **13,1** |
| | RSS / heap al link (MB) | 67,1 / 8,9 | 68,5 / 9,1 | 66,8 / 9,1 | 67,8 / 9,1 |
| partida N = 20 | CPU % | 11,90 | 8,17 | 11,41 | **5,42** |
| | RSS MB | 82,5 | 75,3 | 82,6 | **77,4** (72,5–77,8) |
| | heap MB | **9,9** | 12,8 | 10,1 | 13,1 |
| | GC/min · ms/min | **9 · 3,8** | 157 · 162 | 10 · 3,4 | 61 · 24,9 |
| | lag p50 / p99 ms | 0,09 / 1,65 | 0,12 / 2,41 | 0,09 / 1,80 | 0,11 / 2,76 |
| | hilos · fds · despertares/s | 19 · 27 · 4 183 | 11 · 25 · 514 | 19 · 27 · 4 225 | **11 · 25 · 489** |
| | entrada p50 (ms) | 2 056 | 1 057 | 2 055 | **1 058** |
| 10 salas × 4 | CPU % | 15,63 | 9,31 | 15,86 | **6,54** |
| | RSS MB | 88,9 | 88,0 | 89,1 | **75,2** |
| | heap MB | **11,0** | 15,6 | 11,2 | 13,5 |
| | GC/min · ms/min | **20 · 6,8** | 33 · 94 | 21 · 5,9 | 39 · 14,9 |
| | lag p99 ms | 1,82 | 2,01 | 1,74 | 1,95 |
| | hilos · fds | 19 · 36 | 11 · 43 | 19 · 36 | **11 · 34** |

(En «10 salas», `udp in/out` del arnés suma los contadores de cada sala, que ahora son los del
endpoint compartido: aparecen ×10. Una repetición de `ndc antes` y `rtc antes` falló en esa tanda
y su mediana es de 2.)

Lectura:

- **Gana**: CPU (−52 % frente a `ndc` con N = 20, −59 % con 10 salas), RSS (−5 / −14 MB), hilos,
  fds (10 salas: 34 frente a 36; antes 43), despertares, tiempo de entrada, y el arranque queda
  **a la par** (109,0 frente a 105,8 ms en esta tanda, 105,1 frente a 107,3 en la anterior: dentro
  del ruido; creación → link 13,1 frente a 12,7 ms, antes 23).
- **Pierde todavía**: número y tiempo de GC (61/min y 25 ms/min frente a 10 y 3,4; antes 157 y
  162), heap (+3 MB) y lag p99 (+0,2 a +1 ms). Las causas son estructurales de hacer la red en el
  hilo JS: la basura que queda es la de `dgram` de Node por datagrama (≈ 2 600 envíos y 1 500
  recepciones por segundo con N = 20) y no se puede evitar sin un addon nativo o sin usar
  internos de Node (`process.binding('udp_wrap')` reutilizando `SendWrap`: descartado por
  frágil); el heap extra es código JIT y fuentes de los módulos DTLS/SCTP (instantánea de heap:
  +1,25 MB de código, +0,26 MB de cadenas de fuente con comentarios; el estado por sesión es
  pequeño), y el bench carga el JS de `tsc` sin minificar —con el paquete publicado (rolldown,
  minificado) las fuentes ocupan menos—; el lag p99 lo marcan las pausas de GC y el trabajo de
  red en el hilo JS.

Reproducir: `HAXLITE_BENCH_VARIANTS` con `dist` de cada build (ver la cabecera de
`bench/net/host-proc.mjs`) y `bench/net/run.ts startup|game|rooms`; diagnóstico con
`HOST_ALLOC_PROFILE=<f>.heapprofile` y `HOST_HEAP_SNAPSHOT=<f>.heapsnapshot`.

### 6.5 ICE completo: coste en régimen

A/B intercalado con `bench/net/run.ts game --n 20 --reps 3 --warmup 10 --window 30` (bajo
`flock /tmp/haxlite-bench.lock`, 20 clientes node-haxball, `rtcEndpoint` en 127.0.0.1 con
`publicAddresses`, es decir sin STUN), tres variantes compiladas módulo a módulo
(`HAXLITE_BENCH_VARIANTS`): `base` = commit anterior (ICE‑lite), `ice` = esta pasada con ICE completo
(por defecto), `lite` = esta pasada con `iceLite: true`.

| variante | CPU proceso (3 reps) | media | hilo JS | heap | lag p99 | UDP entrada/salida |
|---|---|---:|---:|---:|---:|---:|
| `base` (ICE‑lite, antes) | 6,99 / 7,25 / 7,17 % | 7,14 % | 6,60–6,80 % | 14,0 MB | 1,08–1,16 ms | ≈ 1 510 / 2 590 /s |
| `ice` (ICE completo) | 7,16 / 7,36 / 7,07 % | 7,20 % | 6,67–6,92 % | 12,3 MB | 1,05–1,08 ms | ≈ 1 510 / 2 590 /s |
| `lite` (esta pasada, `iceLite`) | 7,12 / 7,42 / 7,03 % | 7,19 % | 6,66–7,03 % | 12,2–14,3 MB | 1,04–1,14 ms | ≈ 1 510 / 2 590 /s |

La diferencia `base` → `ice` (+0,06 puntos, +0,8 %) es menor que la dispersión entre repeticiones
(± 0,15) y la misma que `base` → `lite`, que no envía ningún check: no hay regresión medible en la
ruta de régimen. Lo que añade ICE completo en régimen es un Binding de consentimiento cada ~5 s por
jugador (≈ 4 datagramas/s de ida y vuelta con 20 jugadores, frente a ≈ 4 100/s de juego) y una
búsqueda en ≤ 16 pares por Binding recibido. (La máquina tenía carga ajena: «foreign» 3–45 %; las
recolecciones de GC por minuto variaron 48–88 entre repeticiones sin patrón por variante.)

### 6.6 Pasada E/S UDP (`node:dgram`)

Perfil de asignaciones del host (N = 20, paquete minificado, incluye lo ya recolectado):
**1,37 MB/s**, de los que `dgram.send` eran 0,69 (por datagrama: lista de búferes, cierre de la
continuación del `lookup`, array de *rest args* de `defaultTriggerAsyncIdScope` y un `SendWrap`
con tres propiedades, ~260 B × 2 600/s), la recepción 0,54 (0,44 creados en C++ por
`UDPWrap::OnRecv` —`ArrayBuffer` + `Buffer` + objeto `rinfo` + la cadena de la dirección, ~290 B ×
1 500/s— y 0,1 en el `onMessage` JS de dgram: `rinfo.size` y el `emit`) y ~0,15 el resto.

Cambios:

- **`src/rtc/udp.ts` (`UdpIo`)**: el endpoint habla con el `UDPWrap` del socket como lo hace
  dgram, `handle.send(req, list, 1, port, ip, false)`, con **un** `SendWrap` y **una** lista
  reutilizados. El éxito síncrono (`uv_udp_try_send`, devuelve longitud + 1) no retiene nada; solo
  si libuv encola el envío (EAGAIN, devuelve 0) el lado C++ adopta `req` (que mantiene vivo el
  búfer) y se crea un par nuevo (y el endpoint cambia su búfer de sellado, como antes). El
  constructor de `SendWrap` no es público: se toma del `req` que dgram pasa al handle en el primer
  envío. En recepción, `handle.onmessage` (lo que llama `OnRecv`) apunta directo al endpoint. Todo
  con detección de forma: si los internos no son los esperados se usa `socket.send()` /
  `'message'` como antes (`test/rtc/udp.test.ts` cubre ambos caminos y EAGAIN con un handle falso).
- **Montículo de temporizadores SCTP**: vaciarse ya no cancela el `Timeout` de Node (cada SACK que
  confirma todo vacía T3 y el siguiente envío lo vuelve a poner: ~100 `Timeout` nuevos por
  segundo); el temporizador viejo dispara como mucho una vez y no se rearma.

Resultado: **1,37 → 0,58 MB/s** de basura; el 75 % de lo que queda es lo que crea `OnRecv` en C++
por cada datagrama recibido (no evitable desde JS), ~0,02 MB/s la lectura de reloj por paquete
SCTP recibido (`performance.now()` devuelve un HeapNumber creado en C++) y el resto es del juego,
de Node (temporizadores) y del propio arnés.

Host completo, misma sesión, `flock`, intercalado, 3 × 30 s, mediana [mín–máx] («antes» = paquete
de `4bdca83`; heap en MB decimales, `bench/net/run.ts` con la variante `bundle`):

| escenario | métrica | `rtc` antes | **`rtc` después** | `ndc` |
|---|---|---:|---:|---:|
| N = 20 | CPU % | 7,55 [7,46–8,01] | **7,11** [7,09–7,16] | 15,26 [14,20–15,44] |
| | GC/min | 50 [50–94] | 46 [42–46] | **12** [8–12] |
| | GC ms/min | 29,6 [22,4–31,6] | 19,5 [15,0–26,0] | **4,2** [2,8–8,0] |
| | heap MB | 11,83 | 11,31 | **9,81** |
| | lag p99 ms | 1,12 [1,09–1,44] | 1,28 [1,05–1,40] | 1,08 [1,03–1,22] |
| 10 salas × 4 | CPU % | 8,78 | 8,85 | 19,64 |
| | GC/min · ms/min | 42 · 17,3 | 54 · 19,2 | **28 · 11,1** |
| | heap MB | 13,01 | 12,53 | **10,98** |
| | lag p99 ms | 1,08 | **1,00** | 1,02 |

(La máquina estaba compartida: `ndc` dio 15 % de CPU frente a 11,9 en el benchmark rápido.) En
una tanda anterior (solo `UdpIo`, sin el cambio de temporizadores) el mismo A/B dio GC 52 → 44/min, 26,0 → 14,1 ms/min, lag p99 1,06 / 1,10 /
1,06 (antes / después / `ndc`).

Lectura y límites:

- **El número de GC apenas baja aunque la basura cae a menos de la mitad.** V8 encoge el espacio
  joven a su mínimo (semiespacio de 1 MB, ~0,8 MB útiles por recolección) cuando la tasa de
  asignación baja de 1 MB/s (`Heap::ShouldResizeNewSpace`, `kLowAllocationThroughput`) y lo deja
  crecer por encima: con 1,37 MB/s el espacio joven estaba a veces agrandado (de ahí los 50 / 94
  GC/min bimodales de antes), con 0,58 MB/s queda en el mínimo. Por debajo de 1 MB/s el número de
  GC es ≈ tasa / 0,8 MB: el suelo de **~33 GC/min** lo pone `OnRecv` (0,44 MB/s a 1 500
  datagramas/s, casi todos SACK de los clientes, que confirman cada 2 paquetes) y no se puede
  bajar sin un addon nativo (o `--min-semi-space-size`, que es del proceso, no de la biblioteca).
  `ndc` asigna ≈ 0,16 MB/s porque libdatachannel hace la red fuera del heap.
- **Heap**: −0,5 MB (espacio joven más pequeño). Los ~1,5 MB que quedan sobre `ndc` son, según
  instantáneas de heap al final de la ventana (12,1 frente a 10,3 MB), **código** (+1,15 MB:
  código optimizado, *bytecode*, *feedback* de la pila DTLS/SCTP/ChaCha en JS) y los envoltorios
  de los *typed arrays* por sesión (+0,1 MB); el estado nativo de `ndc` no cuenta en el heap.
- **Lag p99**: empate dentro del ruido (rangos solapados, en ambas tandas). El perfil de CPU del
  hilo JS con N = 20: el 42 % del tiempo ocupado es la llamada `sendmsg` (~7,5 µs por datagrama en
  loopback, que incluye la entrega al receptor); un *input* reenviado a 20 peers son ~0,15 ms de
  llamadas al sistema en el mismo turno. Lo demás (ChaCha, SCTP, juego) es < 2 % por función.

### 6.7 Pasada de rendimiento: Bun, entrada, envío

haxlite corre en Node ≥ 22 y en Bun (medido con Bun 1.4). Esta pasada ajusta haxlite-rtc a los dos
runtimes y recorta la entrada y los datagramas. Micro‑medidas de los commits («mejor de», Windows
salvo que se diga otra cosa); los resultados del host completo están en [docs/07](07-benchmarks.md).

**DTLS sin HelloVerifyRequest con ICE completo** (`dtls/server.ts`). RFC 6347 §4.2.1 permite omitir
el intercambio de cookie, cuyo único fin es probar que el cliente es dueño de su dirección de origen.
Con ICE completo eso lo prueba nuestro propio check: `RtcEndpoint` solo entrega DTLS a una sesión
desde direcciones cuyo check nuestro recibió una respuesta autenticada y simétrica, y los flights del
handshake solo van a la dirección del ClientHello que lo empezó; el resto cuenta como
`dtlsUnknownSource`. Un Binding autenticado **no** basta: su clave es nuestra contraseña ICE, que
conoce todo cliente que entra, así que un cliente podría falsear el origen de una víctima, nominarla
y mandar un ClientHello falso para que el flight 4 (~1 KB, retransmitido: ×20–40) le llegue a ella.
Con ICE‑lite no mandamos checks, nada prueba la dirección y el cookie queda **activado por defecto**
(`helloVerify`, opción de `RtcEndpoint` y `RtcBackendOptions`; un RTT más por entrada). Sin cookie,
el primer ClientHello recibe el flight 4: un RTT menos por entrada y dos HMAC menos por sesión. Un
ClientHello retransmitido solo retransmite el flight 4 tal cual (como mucho uno cada 250 ms); un
cookie no pedido se ignora.
Interop: Chrome real (loopback4, lossy, dtls13), libdatachannel y OpenSSL sin fallos nuevos.

**Suites: ChaCha20‑Poly1305 primero también en Bun** (`defaultSuites` en `dtls/crypto.ts`, mismo
orden en los dos runtimes: ChaCha20‑Poly1305, AES‑128‑GCM, AES‑256‑GCM; `cipherSuites` sigue
mandando). En la micro‑medida por registro Bun favorece AES‑128‑GCM (sellar + abrir 300 B: 2,95 µs
frente a 10,2 µs de la ChaCha JS), y durante un tiempo fue el primero en Bun. De extremo a extremo
pierde: partida N = 10, Linux (Debian 12, 4 vCPU), 3 repeticiones, monitor de lag del arnés apagado,
Bun 1.4.0 frente a Node 26.8.1:

| variante | CPU | RSS | UDP B/s por jugador |
|---|---|---|---|
| Bun, AES‑128‑GCM primero | 2,96 % | 64 MB | 5635 |
| Bun, ChaCha20‑Poly1305 primero | 2,45 % | 64 MB | 5150 |
| Node 26 (ChaCha20‑Poly1305) | 2,42 % | 76 MB | 5140 |

Por hilo: con AES el hilo principal gasta 2,4–2,5 % y el *scavenger* de mimalloc (`mi-scavenger`)
0,40–0,45 %; con ChaCha, 1,95–2,2 % y 0,2 %. AES‑GCM crea un objeto de cifrado nativo
(`createCipheriv`) por registro: esa basura no aparece en la micro‑medida pero mantiene ocupado al
*scavenger* de Bun; la ChaCha JS cifra en el sitio sin asignar. Además AES‑GCM lleva un nonce
explícito de 8 B por registro (≈ 9 % más bytes). Resultado: ≈ 17 % menos CPU con ChaCha, a la par
con Node. Lo mismo vale para el túnel UDP del edge (`tunnelAead: 'auto'`, docs/09 §1.3).

Bun no tiene `chacha20-poly1305` en `node:crypto`: `chacha: 'node'` (opción de `DtlsServer`) cae a la
AEAD en JS en vez de lanzar «Unknown cipher».

**Claves como `KeyObject`**: `createHmac`/`createCipheriv` con una clave `Buffer` la importan en cada
llamada. Ahora se crean una vez con `createSecretKey` las claves MESSAGE‑INTEGRITY de STUN (local y
remota), el secreto del PRF de DTLS, las claves AES‑GCM de los registros y la del state cookie de
SCTP. Mismos bytes (vectores de RFC 5769, PRF de referencia).

| operación | Node 26.8 | Bun 1.4 |
|---|---:|---:|
| verificar + responder un Binding (`checkIntegrity` + `buildBindingSuccess`) | 97,0 → 8,7 µs | 2,86 → 2,94 µs |
| PRF, bloque de claves de 88 B | 252 → 26,8 µs | 8,5 → 8,3 µs |
| sellar un registro AES‑128‑GCM de 300 B | 54,2 → 5,6 µs | 1,45 → 1,31 µs |
| state cookie SCTP (crear clave + firmar + verificar) | 94,2 → 15,3 µs | 4,07 → 4,11 µs |

**E/S UDP en Bun** (`src/rtc/udp.ts`). En Node el camino no cambia (`UDPWrap`, §6.6). En Bun,
`UdpIo` toma el socket nativo que `dgram` guarda dentro (detección por forma; si falta algo, sigue
por `dgram`): envío síncrono con `send(buf, port, ip)` (si devuelve `false`, el datagrama va a la
cola de `dgram` y todo pasa por ella hasta vaciarla, para no desordenar) y recepción con `reload`
directa al endpoint, sin `rinfo` ni `emit`. Además, cada vaciado del bundler abre un lote UDP: los
registros sellados se copian a un anillo por socket (64 × 2 KiB) y salen en un `sendMany` (`sendmmsg`
en Linux: una llamada al sistema por vaciado en vez de una por jugador). Loopback, 200 B, envío +
recepción por `UdpIo`: Bun `dgram` 10,31 µs/datagrama → nativo 9,61 (−7 %) → nativo + `sendMany`
9,38 (−9 %); Node 11,3 sin cambios. La ganancia de `sendmmsg` no se pudo medir (Windows no lo tiene).

**Bundling por iteración del event loop** (`src/net/rtc-backend.ts`). El `SendBundler` ya no vacía
al cerrar cada ámbito de cork, sino una vez por iteración, en un `setImmediate` (fase *check*, justo
después de *poll*: sin temporizador ni espera). Lo que varios ámbitos de la misma iteración mandan a
un peer (p. ej. los broadcasts de todas las entradas que libuv entregó en una misma fase *poll*) sale
en un único paquete SCTP. 20 jugadores: datagramas de salida 2 480 → 1 915/s y, como los navegadores
confirman cada segundo paquete, de entrada 1 390 → 1 115/s. `flushRtcBundles()` vacía a mano (arneses
síncronos). Con el *piggyback* del host ([`src/host/README.md`](../src/host/README.md)) el heartbeat
inminente viaja en el mismo paquete que el evento de cliente.

**Agrupado por frame opcional** (`rtc: { sendBatchFrames: 1 | 2 }`, por defecto 0 = sin cambios, sin
temporizadores ni objetos). Un `SendInput` son 17 B de carga y ~105 B en el cable (DATA 16 + carga
con relleno 20 + cabecera SCTP 12 + DTLS 13 + tag 16 + IP/UDP 28), y las entradas llegan repartidas en
el tiempo, así que el bundling por iteración apenas las junta. Con n = 1 o 2, los mensajes de `ru`
(difusión de eventos de cliente: entradas, chat, acciones) se retienen por jugador y salen en la
siguiente frontera de la rejilla de 60 Hz del proceso cuyo índice es múltiplo de n (la misma
rejilla y el mismo despertar que los heartbeats de las salas), un paquete SCTP por jugador hasta la
MTU. `ro` (snapshot, eventos del host, kicks) y `uu` (heartbeats, pongs) nunca se retienen: salen en
su iteración llevándose delante lo retenido (mismo orden por jugador; el ping mostrado no cambia).
`close()` y `flushRtcBundles()` vacían también lo retenido. **Coste**: las entradas ajenas llegan de
media n × 8,3 ms más tarde (máx. n × 16,7 ms).

Bun 1.4, Windows, 1 sala, clientes node-haxball a ~6,45 entradas/s, 20 s × 2 (valores por jugador y
segundo; bytes = carga UDP, cable = + 28 B por datagrama):

| jugadores | variante | datagramas/s | bytes/s | cable B/s | SACKs entrantes/s |
|---:|---|---:|---:|---:|---:|
| 12 | 0 (por defecto) | 72,0 | 6 599 | 8 614 | 45,4 |
| 12 | 1 frame | 46,8 (−35 %) | 5 365 | 6 674 (−23 %) | 33,3 |
| 12 | 2 frames | 34,5 (−52 %) | 4 764 | 5 729 (−33 %) | 31,5 |
| 20 | 0 (por defecto) | 114,2 | 10 414 | 13 610 | 64,5 |
| 20 | 1 frame | 58,1 (−49 %) | 7 660 | 9 287 (−32 %) | 37,3 |
| 20 | 2 frames | 37,4 (−67 %) | 6 614 | 7 660 (−44 %) | 32,7 |

CPU del host (máquina compartida, ruidosa): 2,0–3,5 % / 1,1–2,0 % / 1,0–2,0 %; 0 desconexiones.
`HAXLITE_TEST_RTC_BATCH_FRAMES=1|2` corre las suites rtc (proyecto vitest `rtc` y la sala del interop
con el cliente oficial) con el agrupado activado.

**Entrada y memoria por jugador.** Además del DTLS sin cookie (ICE completo): refresco STUN en segundo plano (§2.1),
`challengeDelayMs` 0 / 10 ms según el cliente (§3), el `Peer` suelta SDP y candidatos al mandar la
respuesta y `RtcSession.answerSdp` pasa a ser un getter que devuelve `''` una vez conectado DTLS (o
cerrada la sesión). Certificado: `processDefault()` y `loadOrCreate` son síncronos (≈ 1–3 ms una vez),
así una sala inactiva no arranca los 4 hilos del *thread pool* de libuv.

## 7. Limitaciones

- **TURN solo por UDP** (§2.2): sin `turn:` configurado, con el host tras un NAT simétrico **y** el
  jugador también no hay camino (igual que node-datachannel sin TURN). `turns:`/TCP no están
  soportados; la dirección relayed es siempre IPv4. Con `iceLite: true` no hay TURN y vuelve a hacer
  falta IP pública o NAT 1:1.
- **Candidatos mDNS** (`*.local`) del navegador no se resuelven (tampoco en libdatachannel): con un
  jugador que solo ofrece mDNS y no tiene STUN, conecta solo si sus checks nos alcanzan (prflx).
- Las interfaces se leen al escuchar (un cambio de IP local no se ve hasta reiniciar el endpoint);
  la IP pública por STUN se refresca a los 60 s, al crear una sesión.
- **Solo data channels pre‑negociados** `ro`/`ru`/`uu`; sin audio/vídeo, sin DCEP (un
  `DATA_CHANNEL_OPEN` del navegador se rechaza con reset de stream), sin renegociación.
- **El navegador siempre ofrece** y es cliente DTLS; haxlite-rtc no puede iniciar conexiones.
- **DTLS 1.2 únicamente** (los navegadores con DTLS 1.3 negocian 1.2, comprobado con el field
  trial de Chromium); sin reanudación de sesión.
- Todo corre en el hilo principal (Node o Bun): el cifrado (ChaCha20‑Poly1305 en JS, o AES‑GCM de
  `node:crypto`) y el SCTP compiten con la lógica del host (ver CPU en §6).
- En Node, cada datagrama recibido sigue creando en C++ un `Buffer` y un `rinfo` (`UDPWrap::OnRecv`,
  §6.6): con miles de datagramas/s es la basura que queda, y no se puede evitar sin un addon nativo.
  En Bun la recepción va directa del socket nativo al endpoint (§6.7).
- **Interoperabilidad verificada solo con Chromium 141** (§5). Firefox, Safari y móviles están
  pendientes (§5.2). IPv6 (opcional, `ipv6: true`) no se pudo probar en esta VM.
- La IP pública se autodetecta por STUN (el maestro no la da: el protocolo no la transmite).

**`peerBackend` por defecto: `'rtc'` (aplicado).** Con ICE completo `rtc` cubre lo que cubre `ndc`
sin TURN, conecta igual de rápido y gasta mucha menos CPU (§6; en una partida de 20 clientes del
banco `game`, Windows 10, Node 26: ≈ 3 % de un núcleo frente a ≈ 18 % con `ndc`). Interoperabilidad
verificada con Chromium 141 y libdatachannel (node-haxball) en todas las condiciones del banco (§5)
y tras NAT simulado de puerto restringido, simétrico y doble (§4.4); node-datachannel deja de
cargarse (sin hilos nativos ni riesgo de SIGABRT/SIGSEGV, §1). Sin `peerBackend`, dar
`transport.portRange` o `transport.rtc` (ajustes de node-datachannel) sigue eligiendo `'ndc'`.
Pendiente todavía: Firefox/Safari/móviles (§5.2), IPv6 y NAT **reales** (CGNAT de operadoras,
routers domésticos con *hairpinning* raro, firewalls que limitan UDP) fuera del simulador (TURN:
§2.2). Diferencia conocida con `ndc`: con la política por defecto no se envían checks a direcciones
privadas o de loopback del jugador (§2.1, «Destinos permitidos»), así que un bot de node-haxball en
la misma LAN o máquina conecta por la IP pública (*hairpinning*) o con
`iceCandidatePolicy: 'private'`. Salida: `peerBackend: 'ndc'`.
