# 10 — haxlite-rtc: data channels WebRTC en TypeScript puro

> **Qué es.** Una pila WebRTC mínima (`src/rtc/`), escrita en TypeScript sin addons nativos
> (`node:dgram` + `node:crypto`), que hace **solo** lo que un host de HaxBall necesita: aceptar la
> oferta de un navegador y mover bytes por los tres data channels pre‑negociados del cliente
> oficial (`ro`, `ru`, `uu`). Sustituye a node-datachannel/libdatachannel en servidores con IP
> pública (haxlite Edge, hosts dedicados).
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
 └─ demux (RFC 7983, primer byte): 0–3 STUN → sesión por ufrag del USERNAME
                                   20–63 DTLS → sesión por dirección remota (validada por ICE)
     └─ RtcSession: ICE-lite (stun.ts) → servidor DTLS 1.2 (dtls/) → SctpAssociation (sctp/)
```

El navegador es **siempre** quien ofrece y el **cliente DTLS**; haxlite-rtc es un extremo
**ICE‑lite**, **servidor DTLS 1.2** y **SCTP** con los tres canales pre‑negociados del cliente
oficial (`ro` id 0 fiable y ordenado, `ru` id 1 fiable y desordenado, `uu` id 2 con
`maxRetransmits: 0`, sin DCEP).

| Capa | Qué hace | Detalles |
|---|---|---|
| SDP (`sdp.ts`) | Lee la oferta, escribe la respuesta | `a=ice-lite`, `a=setup:passive`, candidatos `host` solo de `publicAddresses`, `a=end-of-candidates`, `a=max-message-size:262144` |
| ICE‑lite (`stun.ts`, `session.ts`) | Responde Binding requests; nunca envía comprobaciones | USERNAME `nuestroUfrag:suyoUfrag`, MESSAGE‑INTEGRITY (HMAC‑SHA1) y FINGERPRINT obligatorios, rol *controlling* del navegador. Cada origen autenticado queda *validado*; USE‑CANDIDATE nomina. Consentimiento: si no llega ningún Binding autenticado en `idleTimeoutMs` (30 s) se cierra. Cambio de NAT solo con un Binding autenticado nuevo |
| DTLS 1.2 (`dtls/`) | Servidor DTLS (RFC 6347) | Cookie HMAC (HelloVerifyRequest) antes de guardar estado; preferencia `ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256` (AEAD en JS puro, sin asignaciones, cifra/descifra en el sitio: `dtls/chacha.ts`, §6.3), luego AES_128_GCM y AES_256_GCM (`node:crypto`), configurable con `cipherSuites`; x25519 / P‑256; *extended master secret* obligatorio; certificado del cliente obligatorio y comparado (tiempo constante) con el `a=fingerprint` de la oferta; CertificateVerify comprobado; ventana anti‑replay de 64; retransmisión 1 s → 8 s; fragmentación y reensamblado; `close_notify`. Un Chromium que ofrece DTLS 1.3 recibe un ServerHello 1.2 y conecta |
| SCTP (`sctp/association.ts`) | Asociación SCTP sobre DTLS | RFC 9260, PR‑SCTP (RFC 3758) para `uu`, *stream reset* (RFC 6525) para cerrar canales, *zero checksum* (RFC 9653). Cookie de estado HMAC (INIT sin estado). Sin Nagle: un `send` sale en el acto si las ventanas lo permiten; los envíos hechos dentro de `onMessage` se agrupan en un paquete junto con el SACK. Un solo temporizador por asociación. Ruta caliente sin asignaciones (arena FIFO de bytes, anillos tipados indexados por TSN); `input` nunca lanza |
| Certificado (`cert.ts`) | ECDSA P‑256 autofirmado | Codificador DER mínimo |

API pública (`src/rtc/index.ts`):

```ts
const ep = await RtcEndpoint.listen({ port: 40000, publicAddresses: ['203.0.113.7'] });
const s = ep.createSession(offerSdp);      // lanza RtcSdpError si la oferta no sirve
s.answerSdp; s.localCandidates; s.mid;     // respuesta completa (ya trae los candidatos)
s.onOpen = () => {}; s.onMessage = (canal, bytes) => {}; s.onClose = (motivo) => {};
s.onChannelClose = (canal) => {};          // el navegador cerró un canal (reset de stream)
s.send(0, bytes); s.close(); await ep.close();
```

Motivos de `onClose`: `remote-close`, `timeout` (consentimiento ICE), `handshake-timeout`,
`dtls-alert:<n>`, `dtls-error:<qué>`, `sctp:<motivo>`, `endpoint-closed`.

## 3. Cómo activarlo: `peerBackend: 'rtc'`

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
| `publicAddresses` | IPs **públicas** de las interfaces (`os.networkInterfaces()` clasificadas con `classifyAddress`) | las **únicas** direcciones que se escriben en el SDP (candidatos `host`). Sin ninguna (NAT, nube con NAT 1:1 tipo AWS/GCP) `HBInit` rechaza / `new HostTransport` lanza con un mensaje que pide configurarla. El maestro **no** informa al host de su IP pública (el protocolo no la transmite; `api/geo` solo da país/coordenadas), así que no hay autodetección por el maestro |
| `port` | 0 (efímero) | puerto UDP único para todos los jugadores |
| `address` | comodín de cada familia de `publicAddresses` | dirección de *bind* |
| `publicPort` | el puerto real | puerto anunciado si un NAT 1:1 lo traduce |
| `idleTimeoutMs` / `handshakeTimeoutMs` / `maxSessions` | 30 s / 20 s / 10 000 | del endpoint; las de `HostTransport` (10 s de apertura, 10 s de inactividad, 16 negociaciones, `maxPlayers`) actúan antes |
| `certificate` | uno por proceso (`RtcCertificate.processDefault()`, clave generada en el *thread pool*) | certificado DTLS |
| `certificateFile` | — | PEM (certificado + clave, modo 0600) donde guardar/cargar la identidad DTLS: huella estable entre reinicios y sin generar claves al arrancar (`RtcCertificate.loadOrCreate`) |
| `shared` | `true` | todas las salas del proceso con la misma configuración (puerto —también 0—, direcciones, certificado, tiempos, suites) comparten **un** endpoint y un socket UDP (refcontado, `src/rtc/shared.ts`); `false` = endpoint propio |
| `cipherSuites` | `['chacha20', 'aes128gcm', 'aes256gcm']` | preferencia DTLS del servidor (nombres IANA, ids o cortos); un cliente sin ChaCha20 negocia AES-GCM |
| `endpoint` | — | un `RtcEndpoint` ya abierto (el backend no lo cierra) |

Qué cambia y qué no respecto a node-datachannel (`'ndc'`, por defecto):

* **Igual**: todo lo de `HostTransport` — admisión (4100–4104, bans por IP del maestro y srflx,
  hook `onJoinRequest`, límite por IP) **antes** de crear ninguna sesión, desafío, handshake ECDSA,
  límite de flood, inactividad de 10 s, kicks/bans (el aviso de kick se entrega antes del cierre),
  códigos de cierre, `Peer.remoteAddress` (aquí: origen de los STUN autenticados del jugador).
* **`iceCandidatePolicy`, `iceServers`, `portRange`, `rtc` (node-datachannel)** se ignoran: el
  backend es `prefiltered` y solo anuncia `publicAddresses`.
* La respuesta sale **sin la espera de 500 ms** de recolección (el SDP ya trae los candidatos y
  `a=end-of-candidates`).
* **Arranque perezoso**, como `ndc` (que carga node-datachannel con el primer peer): la sala se
  anuncia al maestro en el acto y los módulos rtc, el socket y el certificado se preparan con la
  primera oferta, con `whenListening()` (HBInit lo llama al recibir el enlace y resuelve cuando el
  puerto escucha, o rechaza con el error de *bind*) o 50 ms después de `start()`, lo primero que
  ocurra. Una oferta que llega antes se contesta en cuanto escucha (`DeferredRtcPeerLink`).
* `room.haxlite.rtcStats()` da los contadores del endpoint **compartido** (todas las salas que
  lo usan).
* Los tres canales abren a la vez. **`challengeDelayMs` se mantiene en 40 ms** también con `rtc`:
  protege al *cliente*. Medido con node-haxball (libdatachannel), 30 entradas por configuración:
  `rtc` con 0 ms falla **29/30** (el desafío llega con la asociación SCTP, antes de que el cliente
  dé sus canales por abiertos, y lo descarta); con 10 ms y 40 ms, 0/30 (`ndc`: 5/30 con 0 ms, 0/30
  con 10 y 40). Los navegadores no lo necesitan (el host oficial manda el desafío sin espera).
* Un `dc.close()` de un canal en el navegador (reset de stream) llega como
  `RtcSession.onChannelClose(id)` → `onChannelClosed` del backend → el peer se cierra en el acto,
  igual que el evento `closed` de un DataChannel de node-datachannel.
* En reposo: sin sesiones el endpoint no tiene temporizadores (su barrido de 1 Hz se apaga en el
  siguiente tick); queda solo el socket UDP. `room.haxlite.stop()` espera a que se libere.
* node-datachannel ya **no se carga** si no se usa (`src/net/webrtc.ts` lo importa al crear la
  primera PeerConnection): un proceso solo-`rtc` no tiene hilos nativos de WebRTC.

**Recomendación**: `rtc` en servidores con IP pública (dedicados, VPS, edge); `ndc` en hosts detrás
de NAT sin edge. El valor por defecto sigue siendo `ndc` (el único que funciona sin configurar en
cualquier red); `rtc` exige `publicAddresses` alcanzables y el puerto UDP abierto.

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
| `selftest.html`, `manual-server.ts` | Prueba manual para cualquier navegador (§5.2) |

### 4.2 Escenarios

Cada escenario corre con cada backend (`ndc`, `rtc`) y cada condición:

| Condición | ICE del servidor | Navegador |
|---|---|---|
| `loopback4` | `127.0.0.1` | Chromium por defecto (candidatos host ofuscados con mDNS, como un usuario real) |
| `eth4` | primera IPv4 no interna (aquí `192.0.2.2`) | ídem |
| `loopback6` | `::1` | ídem — **se salta si la máquina no tiene IPv6** (esta VM no tiene `::1`) |
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
node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs \
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
flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings \
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
- **Arranque**: certificado por proceso generado en el *thread pool* (`processDefault`, opcional
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

### 6.5 Pasada E/S UDP (`node:dgram`)

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

## 7. Limitaciones

- **Solo IP pública** (o NAT 1:1): ICE‑lite no hace comprobaciones ni reúne candidatos
  srflx/relay, así que el servidor tiene que ser alcanzable directamente. Detrás de NAT doméstico
  sigue haciendo falta node-datachannel (o el Edge).
- **Solo data channels pre‑negociados** `ro`/`ru`/`uu`; sin audio/vídeo, sin DCEP (un
  `DATA_CHANNEL_OPEN` del navegador se rechaza con reset de stream), sin renegociación.
- **El navegador siempre ofrece** y es cliente DTLS; haxlite-rtc no puede iniciar conexiones.
- **DTLS 1.2 únicamente** (los navegadores con DTLS 1.3 negocian 1.2, comprobado con el field
  trial de Chromium); sin reanudación de sesión.
- Todo corre en el hilo principal de Node: el cifrado (ChaCha20‑Poly1305 en JS, o AES‑GCM de
  `node:crypto`) y el SCTP compiten con la lógica del host (ver CPU en §6).
- Cada datagrama pasa por `dgram` de Node, que asigna objetos JS por envío (≈ 260 B) y por
  recepción (≈ 350 B, el `Buffer` y el `rinfo`): con miles de datagramas/s es la basura que queda
  (§6.3), y no se puede evitar sin un addon nativo.
- **Interoperabilidad verificada solo con Chromium 141** (§5). Firefox, Safari y móviles están
  pendientes (§5.2). IPv6 no se pudo probar en esta VM.
- Sin autodetección de la IP pública vía el maestro (el protocolo no la da): `publicAddresses`
  explícitas salvo que una interfaz tenga IP pública.
