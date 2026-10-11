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
- **`cleanup()` puede colgarse**: durante este trabajo el banco registró varias veces
  `libdatachannel error# cleanup timeout (possible deadlock)` al cerrar el servidor tras las
  pruebas con pérdida (§5.3).
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
| DTLS 1.2 (`dtls/`) | Servidor DTLS (RFC 6347) | Cookie HMAC (HelloVerifyRequest) antes de guardar estado; `ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` (+ AES_256_GCM, CHACHA20_POLY1305); x25519 / P‑256; *extended master secret* obligatorio; certificado del cliente obligatorio y comparado (tiempo constante) con el `a=fingerprint` de la oferta; CertificateVerify comprobado; ventana anti‑replay de 64; retransmisión 1 s → 8 s; fragmentación y reensamblado; `close_notify`. Un Chromium que ofrece DTLS 1.3 recibe un ServerHello 1.2 y conecta |
| SCTP (`sctp/association.ts`) | Asociación SCTP sobre DTLS | RFC 9260, PR‑SCTP (RFC 3758) para `uu`, *stream reset* (RFC 6525) para cerrar canales, *zero checksum* (RFC 9653). Cookie de estado HMAC (INIT sin estado). Sin Nagle: un `send` sale en el acto si las ventanas lo permiten; los envíos hechos dentro de `onMessage` se agrupan en un paquete junto con el SACK. Un solo temporizador por asociación. Ruta caliente sin asignaciones (arena FIFO de bytes, anillos tipados indexados por TSN); `input` nunca lanza |
| Certificado (`cert.ts`) | ECDSA P‑256 autofirmado | Codificador DER mínimo |

API pública (`src/rtc/index.ts`):

```ts
const ep = await RtcEndpoint.listen({ port: 40000, publicAddresses: ['203.0.113.7'] });
const s = ep.createSession(offerSdp);      // lanza RtcSdpError si la oferta no sirve
s.answerSdp; s.localCandidates; s.mid;     // respuesta completa (ya trae los candidatos)
s.onOpen = () => {}; s.onMessage = (canal, bytes) => {}; s.onClose = (motivo) => {};
s.send(0, bytes); s.close(); await ep.close();
```

Motivos de `onClose`: `remote-close`, `timeout` (consentimiento ICE), `handshake-timeout`,
`dtls-alert:<n>`, `dtls-error:<qué>`, `sctp:<motivo>`, `endpoint-closed`.

## 3. Cómo activarlo

La integración en el transporte del host se hará con una opción de backend de peers
(**pendiente de cablear** en `src/net`):

```ts
HostTransport({ …, peerBackend: 'rtc', rtcPort: 40000, publicAddresses: ['203.0.113.7'] })
```

Mientras tanto, el adaptador `RtcPeerBackend` de `test/rtc-interop/harness/backends.ts` muestra
cómo encaja `RtcEndpoint` en la interfaz `PeerBackend` de `src/net/peer-backend.ts` (la misma
que usan `LocalPeerBackend` y el Edge): `createPeer(id, offer, eventos)` → `onLocalDescription`
con `answerSdp`, `onLocalCandidate` por cada candidato, `onGatheringComplete`, y al abrir la
asociación `onChannelOpen` de los tres canales a la vez.

Requisitos: IP pública (o NAT 1:1 con `publicPort`) y **un** puerto UDP abierto para todos los
jugadores. No hay STUN/TURN propio ni modo detrás de NAT: para eso sigue node-datachannel.

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

## 5. Matriz de interoperabilidad

### 5.1 Resultados (Chromium 141.0.7390.37, headless, Linux x86‑64)

| Backend | loopback4 | eth4 | lossy (5 % / 30 ms) | dtls13 | loopback6 |
|---|---|---|---|---|---|
| node-datachannel 0.33 (libdatachannel 0.24) | ✅ 10/10 | ✅ 9/9 ¹ | ✅ 10/10 ² | ✅ 9/9 ¹ | sin IPv6 en la VM |
| **haxlite-rtc** | ✅ 10/10 | ✅ 9/9 ¹ | ✅ 10/10 | ✅ 9/9 ¹ | sin IPv6 en la VM |

¹ Sin la prueba de 40 s (solo se corre en `loopback4` y `lossy`).
² El cierre de un canal desde el navegador no se completa con pérdida (§5.3); la prueba lo
registra y sigue.

Tiempos medidos (`RTC_INTEROP_REPORT`):

| Medida | node-datachannel | haxlite-rtc |
|---|---:|---:|
| entrada (oferta → canal 0 abierto) loopback / pérdida | 1 080 / 1 340 ms | 1 047 / 1 316 ms |
| el navegador cierra la PC → el servidor lo nota (loopback / pérdida) | 3 / 23 ms | 3 / 22 ms |
| `dc.close()` de `ru` → `onclose` en el navegador (loopback / pérdida) | 3 ms / **no termina en 40 s** | 2 / 55 ms |
| el servidor cierra → el navegador lo nota (loopback / pérdida) | ≈ 15 / ≈ 115 ms | ≈ 14 / ≈ 120 ms |
| ráfaga de 10 × 20 KB por `uu` servidor → navegador (loopback / eth0) | 6–8 / 10 | 10 / 10 |
| mensajes enviados por el servidor al abrirse el canal 0, por canal `ro/ru/uu` | 3 / 0 / 0 | 1 / 1 / 1 |

La entrada ronda 1 s porque Chromium no da por terminada la recolección ICE en este entorno y
el cliente oficial espera su tope de 1000 ms antes de mandar la oferta; el resto (≈ 50 ms en
loopback) es ICE + DTLS + SCTP.

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

- **node-datachannel × pérdida, cierre de canal**: con 5 % de pérdida, el `dc.close()` de
  Chromium (reset de stream SCTP, RFC 6525) contra usrsctp **no se completa en 40 s** (en
  loopback limpio tarda 3 ms). Con haxlite-rtc tarda 55 ms. El cliente oficial nunca cierra un
  solo canal, así que no afecta a HaxBall, pero indica un fallo de retransmisión del RE‑CONFIG en
  esa combinación.
- **node-datachannel abre `ru`/`uu` después de `ro`**: en el servidor, el evento *open* de los
  canales 1 y 2 llega después del del canal 0, también en loopback. Lo que el host envía
  justo al abrirse el canal 0 por `ru`/`uu` cae al canal 0 (comportamiento oficial de `Za.pb`).
  haxlite-rtc abre los tres a la vez (la asociación SCTP es una sola).
- **`uu` con ráfagas grandes**: 10 × 20 KB seguidos por `uu` (sin retransmisión) pierden 2–4
  mensajes con node-datachannel en loopback (en eth0 llegaron todos); haxlite-rtc los entrega
  todos. HaxBall solo
  manda mensajes pequeños por `uu`.
- **`cleanup()` de node-datachannel**: al apagar el servidor tras las pruebas con pérdida se
  registró `cleanup timeout (possible deadlock)` (no rompe la prueba, pero es el riesgo descrito
  en §1).
- **Inactividad del cliente oficial**: el cliente cierra a los 10 s sin recibir nada. Un host real
  nunca calla tanto (heartbeats cada ~117 ms), pero una prueba que conecta 30 clientes con
  pérdida y no manda nada hasta tenerlos todos sí lo dispara; esas pruebas la desactivan.

## 6. Benchmarks (`bench/rtc/`)

BENCH_PLACEHOLDER

## 7. Limitaciones

- **Solo IP pública** (o NAT 1:1): ICE‑lite no hace comprobaciones ni reúne candidatos
  srflx/relay, así que el servidor tiene que ser alcanzable directamente. Detrás de NAT doméstico
  sigue haciendo falta node-datachannel (o el Edge).
- **Solo data channels pre‑negociados** `ro`/`ru`/`uu`; sin audio/vídeo, sin DCEP (un
  `DATA_CHANNEL_OPEN` del navegador se rechaza con reset de stream), sin renegociación.
- **El navegador siempre ofrece** y es cliente DTLS; haxlite-rtc no puede iniciar conexiones.
- **DTLS 1.2 únicamente** (los navegadores con DTLS 1.3 negocian 1.2, comprobado con el field
  trial de Chromium); sin reanudación de sesión.
- Todo corre en el hilo principal de Node: el cifrado AES‑GCM de `node:crypto` y el SCTP compiten
  con la lógica del host (ver CPU en §6).
- **Interoperabilidad verificada solo con Chromium 141** (§5). Firefox, Safari y móviles están
  pendientes (§5.2). IPv6 no se pudo probar en esta VM.
- `peerBackend: 'rtc'` aún no está cableado en `HostTransport`.
