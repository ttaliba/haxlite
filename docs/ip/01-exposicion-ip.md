# 01 — Exposición de la IP del host en HaxBall: forense completo y trucos viables con el cliente oficial

> Objetivo defensivo: proteger la IP de los hosts propios (haxlite) frente a DDoS sin que los jugadores
> instalen nada y, si es posible, sin infraestructura extra.
>
> Fuentes: cliente web oficial `web/game.pretty.js` (CL), headless oficial `pretty/hl.js` (HL),
> haxlite `src/net/{transport,ice,signaling,webrtc}.ts` (rama `feat/haxlite`), RFCs y bugs de
> Chromium (enlaces al final). Experimentos con `node-datachannel 0.33.4` (libdatachannel/libjuice)
> en `ipresearch/exp1*.mjs`, `exp3-relay-sdp.mjs` (+ `.out`). El contenedor **no tiene IPv6**
> (no existe `/proc/net/if_inet6`), así que IPv6 se ha probado por analogía con el `127.0.0.0/8` de
> IPv4, que se comporta como una ruta "AnyIP" (es el mismo truco que `ip -6 route add local <pfx>/64 dev lo`).

---

## 0. Resumen ejecutivo

1. **La IP a la que el cliente manda UDP no se puede ocultar a ese cliente.** Aunque se borren todos los
   candidatos del SDP, el cliente aprende la dirección del host como candidato *peer-reflexive* en cuanto
   recibe un check STUN (RFC 8445 §7.3.1.3), y en cualquier caso el sistema operativo del jugador
   (Wireshark, `netstat`, Monitor de recursos) ve el destino de sus paquetes. Lo único que se controla
   es **qué dirección** es esa, **a quién** se le da y **cuándo**.
2. **haxlite ya filtra lo filtrable**: `iceCandidatePolicy: 'public'` quita candidatos LAN/loopback/
   link-local/mDNS, borra `raddr/rport` (que en libjuice contiene la IP privada detrás de NAT) y
   neutraliza `c=`/`m=` cuando la dirección no es pública. El `o=` de libdatachannel es siempre
   `IN IP4 127.0.0.1` (no filtra nada). El listado `/rs/api/list` y la señalización **no** contienen la
   IP del host (sólo lo que el host pone en su answer).
3. **Momento de la revelación**: tanto en el oficial como en haxlite, la IP sale en la *answer*, **después**
   de: límite de negociaciones (4104), ban por IP de `conn`/srflx (4102), sala llena (4100), versión
   (4103) y **contraseña (4101)**; en haxlite además rate limit por IP y el hook asíncrono
   `onJoinRequest`. Sale **antes** de: verificación de la clave de identidad (`auth`), nombre, avatar,
   bans por `auth` y cualquier lógica `onPlayerJoin` del script. **Nada en la oferta está firmado** con la
   clave del jugador → es imposible verificar `auth` antes de revelar la IP. El único secreto pre‑ICE
   que viaja en la oferta es la **contraseña**.
4. **Idea más fuerte sin infraestructura extra: una dirección IPv6 distinta por jugador** (de la /64 del
   servidor) en cada conexión, con puerto también único. Probado: libdatachannel acepta
   `bindAddress`/`portRangeBegin=End` **por PeerConnection**, sólo anuncia esa dirección y 8 sesiones
   concurrentes en 8 direcciones distintas funcionan. Una dirección filtrada identifica al filtrador y se
   puede descartar (firewall/blackhole de esa /128) sin afectar al resto. **Ojo:** con
   `enableIceUdpMux: true` el `bindAddress` de las conexiones siguientes **se ignora** (todas usan el
   socket de la primera) → hay que desactivar el mux. Cobertura IPv6 (APNIC, media 30 días a 2026‑10‑09):
   Uruguay 61 %, Brasil 59 %, México 58 %, Paraguay 45 %, Bolivia 44 %, Ecuador 38 %, Perú 35 %,
   **Argentina 34 %**, Chile 23 %, Colombia 22 %, Venezuela 10 %. Los jugadores sólo-IPv4 tienen que
   caer a la IPv4 compartida (o a una ruta protegida).
5. **Cambiar la IP en mitad de la partida no es posible** con el cliente oficial: cierra el WS de
   señalización en cuanto se abre el canal 0 y no implementa renegociación ni ICE restart. La única
   forma de "mover" a un jugador es forzar una reconexión (kick + volver a entrar), y el cliente no tiene
   botón de "reintentar".
6. **"TryingReverseConnection" no es un relay**: es un reintento único de la misma negociación P2P con
   un retardo de 2,5 s en el host. No existe ningún relay del master; el cliente tiene el STUN de Google
   *hardcodeado* y no admite TURN propio. Pero el reintento sí sirve como **segunda oportunidad**: el host
   puede ofrecer IPv6 en el primer intento e IPv4 sólo si falla.
6b. **Anunciar un dominio en vez de la IP no sirve** (§6.1): RFC 8839 manda ignorar candidatos FQDN;
   Chrome probablemente los resuelve, pero conecta a la IP resuelta (visible), y un dominio con el proxy
   naranja de Cloudflare no reenvía UDP (sólo HTTP/HTTPS; el UDP requiere Spectrum Enterprise) → la
   conexión falla.
7. **Frente con forma de NAT (reenvío UDP) en otra IP**: es compatible a nivel de protocolo con el cliente
   oficial (ICE/STUN/consent/DTLS/SCTP sobreviven a cualquier NAT simétrico) **siempre que** el host nunca
   envíe paquetes directamente al cliente. Pero es infraestructura extra y sólo sirve si esa IP está en una
   red con mitigación DDoS; si no, se cae igual que el TURN propio. La protección viene de la capacidad de
   la red, no del protocolo.

---

## 1. Canales por los que un cliente puede aprender la IP del host

| # | Canal | ¿Revela la IP del host? | Oficial (headless Chrome) | haxlite | ¿Evitable? |
|---|---|---|---|---|---|
| 1 | Listado `/rs/api/list` | No. Ficha = versión, nombre, bandera, lat/lon declaradas, password, max, players (doc 01 §1.3) | lat/lon salen de `/rs/api/geo` (geolocaliza la IP del host, ~ciudad) | lat/lon arbitrarias | Sí (haxlite: no poner coordenadas reales) |
| 2 | Señalización (WS cliente↔master) | Sólo reenvía la answer y los candidatos del host. El master conoce la IP del host (WS del host) pero no la publica | — | — | n/a |
| 3 | SDP answer: `c=IN IP4 x`, `m=application <puerto>` | Sí, si el host la pone. libdatachannel pone la dirección del candidato host (exp1: `c=IN IP4 127.0.0.2`, `m=application 40001`) | Chrome: `c=IN IP4 0.0.0.0` / puerto 9 en la answer inicial | `filterSdp` → `0.0.0.0`/puerto 9 si no es pública | Sólo es redundante con (4) |
| 4 | `a=candidate` host/srflx en answer y *trickle* | **Sí** (es su función) | candidatos host como `*.local` (mDNS) + **srflx = IP pública** | sólo públicos con policy `'public'` | No, salvo que la dirección anunciada sea otra (TURN/frente) |
| 5 | `raddr/rport` de srflx/relay | Sí: IP privada/local del host (libjuice pone la IP local real) | Chrome pone `raddr 0.0.0.0 rport 0` con mDNS | `filterCandidate` lo pone a `0.0.0.0 rport 0` | Sí (ya hecho) |
| 6 | `o=` del SDP | No: libdatachannel siempre `o=rtc <id> 0 IN IP4 127.0.0.1` (exp1/exp3) | — | — | n/a |
| 7 | Checks de conectividad ICE (STUN Binding) | **Sí, inevitable**: la dirección de origen del check o de la respuesta pasa a ser un candidato remoto *prflx* (RFC 8445 §7.3.1.3); exp1: `remote … typ prflx 127.0.0.2` | igual | igual | No |
| 8 | DTLS / SCTP | El 5-tupla es el mismo que (7). Dentro no hay IPs: RFC 8261 §6.1 "INIT y INIT-ACK MUST NOT contain any IPv4/IPv6 Address parameters" | — | — | n/a |
| 9 | mDNS | Sólo afecta a candidatos host *del navegador* (oculta IPs LAN). libjuice no publica mDNS | host = `uuid.local` | no aplica (no se anuncian privados) | n/a |
| 10 | IPv6 | Si el host tiene IPv6 y lo anuncia, un cliente dual-stack ve **ambas** direcciones aunque use sólo una | Chrome anuncia v4+v6 | idem salvo `bindAddress` | Sí (anunciar sólo una familia por jugador, §4) |
| 11 | `getStats()` / `chrome://webrtc-internals` | Muestran la descripción remota y el par seleccionado. Chrome sanea la dirección de los **prflx remotos** en `getStats` (bug 968161, W3C webrtc-stats #375) pero los candidatos firmados en el SDP se ven tal cual | — | — | Irrelevante: el SO ve el destino |
| 12 | Extensiones del navegador / herramientas del SO | Una extensión con acceso a la página puede envolver `RTCPeerConnection`; Wireshark/`netstat` ven el destino UDP | — | — | No |
| 13 | Reintento "reverse connection" | Segunda answer con las mismas direcciones (nada nuevo) | — | — | — |
| 14 | Fuera de WebRTC | Cosas del script de sala: URLs que el host descarga a petición de jugadores, dominios/servicios web en la misma IP, historial (si la IP ya se filtró alguna vez, sigue en las listas de los atacantes) | — | — | Sí, operativo |

**Conclusión (1):** lo que haxlite ya filtra (3, 5, LAN/mDNS de 4) es todo lo que se puede filtrar; (4)
y (7) son la esencia del P2P. La única forma de "ocultar" la IP es que **la dirección a la que habla el
cliente no sea la del servidor** (TURN del lado del host o un frente con forma de NAT) o que **sea
desechable y distinta por jugador** (IPv6 por jugador).

### 1.1 Nota sobre el TURN propio "que seguía siendo atacado"

Causas probables, por orden:

- **Política de transporte `all`**: si el host (oficial en Chrome, o haxlite sin
  `rtc: { iceTransportPolicy: 'relay' }`) tiene TURN *además* de candidatos host/srflx, la answer lleva
  la IP real (srflx) y además el host manda checks desde su IP real a los candidatos del cliente
  (→ prflx). Con el headless oficial no hay forma de forzar `relay` sin modificar el código
  (`new RTCPeerConnection({ iceServers: b }, la.Fg)`, HL l.1347). En haxlite sí: exp3 confirma que con
  `iceTransportPolicy: 'relay'` la answer queda `c=IN IP4 0.0.0.0`, `m=application 9` y no se
  recoge ningún candidato host.
- **La IP del TURN es la nueva IP atacada**: el atacante tumba el TURN y la sala cae igual. El TURN no
  protege; sólo traslada el objetivo.
- **Fuga previa**: la IP del servidor ya era conocida (historial, otros servicios en la misma IP).

---

## 2. Cronología: ¿cuándo exactamente se revela la IP?

### 2.1 Flujo del cliente oficial (CL)

```
B.eg (l.3355)  → new Ia(roomId, {iceServers: m.kg /* sólo stun google */, version: 9, password, Gn: crappy_router})
Ia.Za (l.8282) → new dc(wsUrl, iceServers, roomId, channels, joinData=[u16 ver, str? pass], token)
dc  (l.5610)   1. createOffer + setLocalDescription + espera ICE ≤1 s          (Ca.No, l.3520)
               2. new WebSocket(".../client?id=ROOM[&token=…]")
               3. onopen → Qi(): [1] deflate(reverseFlag, sdp, candidatos, joinData)
               4. master → host (añade peerId + conn = IPv4 del cliente vista por el master)
               5. host: checks de admisión  ─── si falla: código 4100..4104 → cierre WS, NO hay IP
               6. host: answer + candidatos  ─── ★ AQUÍ SE REVELA LA IP ★
               7. Zh(): setRemoteDescription(answer) + addIceCandidate; timeout 4 s (10 s si reverse)
               8. ICE/DTLS/SCTP; canal 0 abierto → Hd → pk() CIERRA el WS de señalización
Ia             9. canal "ro": host manda challenge; cliente firma con su idkey ECDSA → handshake
host          10. verifica firma (auth), bans por auth, onPlayerJoin del script…
```

Captcha (`requireRecaptcha`): con la sala en modo captcha el master cierra el WS del cliente con
**4004**; el cliente hace `POST api/client` (`room=…&rcr=…`), muestra el reCAPTCHA y reintenta con
`&token=` (CL l.3147, l.3430). Como la oferta se envía en el `onopen` del WS y el cierre 4004 lo
decide el master, lo razonable es que **la oferta no llegue al host** hasta resolver el captcha
(inferido; no verificado contra el master real).

### 2.2 Host oficial (HL `Aa.$g`, l.686) vs haxlite (`transport.ts handleOffer`)

| Orden | Oficial | haxlite | ¿IP ya revelada? |
|---|---|---|---|
| 1 | ≥16 pendientes → 4104 | idem (`maxPendingNegotiations`) | No |
| 2 | `conn` baneada → 4102 | idem (`BanList`, admite CIDR) | No |
| 3 | IP srflx de la oferta baneada → 4102 | idem | No |
| 4 | — | rate limit por IP (`joinRateLimit`) | No |
| 5 | `Oe` = `Wa.Xg`: llena 4100, versión 4103, contraseña 4101 | idem | No |
| 6 | — | `onJoinRequest` (async) con `ip`, `srflxIps`, `candidateAddresses`, `password`, `reverse` | No |
| 7 | crear PC, answer, esperar ICE ≤500 ms, **enviar answer** | idem, pero con node-datachannel la answer sale con el primer candidato permitido (`answerIceWaitMs` = 500 ms solo si no hay ninguno) | **SÍ** |
| 8 | canal 0 abierto: sala llena → cierre | idem | Sí |
| 9 | challenge → firma → `auth` | idem (+ `allowNullAuth:false`) | Sí |
| 10 | ban por `auth`, script `onPlayerJoin` (kicks por nombre, etc.) | idem | Sí |

### 2.3 ¿Se puede verificar la identidad antes de mandar candidatos?

**No.** Contenido de la oferta: `reverseFlag`, SDP, candidatos, `u16 version`, `string? password`.
En el SDP sólo hay `ice-ufrag/ice-pwd` aleatorios y la huella DTLS de un **certificado efímero**: el
cliente crea el `RTCPeerConnection` con `{ iceServers: b }` sin `certificates` (CL l.3489), así que
Chrome genera uno nuevo por conexión. La clave `idkey` sólo se usa para firmar el challenge que viaja
**por el canal de datos** (después de ICE). Por tanto:

- El `auth` es inutilizable para filtrar antes de revelar la IP.
- **La contraseña sí**: se comprueba en el paso 5, antes de crear el PeerConnection. Es el único secreto
  pre‑ICE que el cliente oficial transmite.

### 2.4 Mejoras de "gating" posibles en haxlite (sin infraestructura)

| Idea | Cómo | Valor real | Viabilidad |
|---|---|---|---|
| **Contraseñas por jugador / un solo uso** | El cliente pide contraseña si la ficha tiene `password=1` (o enlace `&p=1`) y vuelve a pedirla tras 4101 (CL l.3436). En `onJoinRequest` validar `password` contra una tabla `token→persona` (repartida por un bot de Discord, web con login, etc.). Requiere un cambio menor: hoy `handleOffer` compara con `this.password` *antes* del hook; habría que separar "anunciar contraseña" de "comprobarla" | Alto para salas privadas/competitivas: sólo quien tiene un token recibe la IP, y la IP queda **ligada a un token** (atribución) | Alta |
| Captcha adaptativo | `setRequireRecaptcha(true)` cuando sube el ritmo de entradas o tras un ataque; lo hace el master (gratis) antes de que la oferta llegue | Medio: frena bots y scrapers masivos de IPs; un atacante humano lo resuelve una vez | Alta (ya existe) |
| Reputación de `conn` (ASN de VPN/datacenter/Tor) en `onJoinRequest` | `conn` es la IPv4 que ve el master (el master es **sólo IPv4**: `p2p.haxball.com` y `www.haxball.com` no tienen AAAA), no falsificable por el cliente. Lista local de ASN (p. ej. ip2asn offline) → rechazar 4102 o pedir contraseña | Medio-bajo: corta a los "atacantes cuidadosos" que esconden su IP; quien alquila un booter no necesita esconderse | Alta |
| Rate limit / cuotas de revelación por IP y por /24 (/48 en v6) | `joinRateLimit` ya existe; añadir "máximo N answers por IP al día" | Bajo-medio contra recolección automatizada | Alta |
| Bans "pre-ICE" más ricos | El kick-ban oficial guarda `conn` + srflx; ampliar a CIDR/ASN | Bajo (cambiar de IP es trivial) | Alta |
| Retrasar la revelación (cola de espera) | Retener la answer N segundos | **Inútil**: el cliente sólo espera la answer mientras el WS siga abierto y después de recibirla da 4 s; retenerla sólo empeora la experiencia | — |

---

## 3. ¿Puede el cliente oficial conectarse a una dirección que no sea la del host, sin TURN?

### 3.1 A nivel de protocolo: sí, un frente que se comporte como un NAT funciona

Razonamiento con los RFC (sin prueba con navegador real; el contenedor no tiene Chrome):

- **El tipo/dirección de un candidato no se valida**: el cliente manda checks a lo que diga la answer
  (`typ host` con una IP ajena es aceptable para el agente remoto). Lo que sí exige ICE es la
  **simetría**: la respuesta tiene que venir de la misma dirección a la que se envió la petición
  (RFC 8445 §7.2.5.2.1, *non-symmetric transport addresses* → fallo). Por eso un reenvío que sólo
  cambie el destino y deje que el host responda desde su IP real **falla y además filtra** la IP; hace
  falta traducir en ambos sentidos, exactamente como un NAT.
- **MESSAGE-INTEGRITY** (RFC 8489) se calcula sobre el mensaje STUN con la `ice-pwd` del SDP; no
  incluye cabeceras IP → un NAT no lo rompe.
- **XOR-MAPPED-ADDRESS** de la respuesta será la dirección que vio el host (la del frente). El cliente
  lo trata como un nuevo candidato local *prflx* (RFC 8445 §7.2.5.3.1) y el par sigue siendo válido.
  Es lo mismo que ocurre con cualquier NAT de carrier.
- **Consent freshness** (RFC 7675): checks STUN cada ~5 s, expira a los 30 s → sólo exige que el frente
  mantenga el mapeo UDP > 30 s.
- **DTLS/SCTP**: no transportan direcciones (RFC 8261 §6.1).
- **Condición crítica**: el host **no debe enviar nunca** nada directamente a los candidatos del
  cliente. Si lo hace, el cliente aprende la IP real como prflx y, si su NAT lo deja pasar (cono
  completo, IPv6 sin firewall), incluso puede elegir ese par directo. Es decir, toda la salida UDP
  de ICE del host tiene que salir también por el frente.

### 3.2 Coste y superficie frente a TURN

| | TURN del lado del host | Frente con forma de NAT |
|---|---|---|
| Cambios en el cliente | Ninguno (el relay es un candidato del host) | Ninguno |
| Cambios en haxlite | Ninguno (`iceServers` + `iceTransportPolicy:'relay'`) | Reescribir la dirección anunciada y garantizar que el host no hable directo |
| Estado/autenticación | Asignaciones, permisos, credenciales, refrescos | Sólo tabla de mapeos |
| Rendimiento | Espacio de usuario (coturn), más pps por paquete útil | Puede ir en el kernel |
| Qué se ataca | La IP del TURN | La IP del frente |
| Si el frente/TURN no tiene mitigación | Cae | Cae |

**Veredicto:** el frente es más simple y ligero que TURN, pero **no resuelve el problema por sí
solo**: la IP que ve el cliente sigue siendo atacable. Sólo tiene sentido si esa IP está en una red con
mitigación DDoS para UDP (proveedores "game protection" o túneles GRE de proveedores anti‑DDoS), o si
se combina con **direcciones de frente desechables y repartidas por jugador** (atribución + rotación).
Viabilidad técnica: alta. Encaje con "sin infraestructura extra": **no cumple**.

---

## 4. Direcciones/puertos por jugador

### 4.1 Lo que permite libdatachannel (probado)

`RtcConfig` tiene `bindAddress`, `portRangeBegin/End`, `enableIceUdpMux` y se pasa **por
PeerConnection** (en haxlite: `createPeerConnection(name, {...portRange, ...this.opts.rtc, iceServers})`
en `negotiate()`, hoy igual para todos).

| Experimento | Resultado |
|---|---|
| exp1: PC A `bindAddress 127.0.0.2:40001`, PC B `127.0.0.3:40002` | Cada answer lleva **sólo** su dirección (`c=` + 1 candidato `typ host`); conexión OK; el cliente ve la remota como `prflx 127.0.0.2:40001` y luego el candidato host |
| exp1d: 8 sesiones **concurrentes**, `127.0.1.10…17`, todas puerto 40100, sin mux | 8/8 OK, cada una con su propia dirección |
| exp1c: lo mismo con `enableIceUdpMux: true` | 8/8 OK pero **las 8 anuncian `127.0.1.10`**: con mux el socket se comparte por puerto y el `bindAddress` de las demás se ignora |
| exp1b: mux, direcciones distintas, mismo puerto, secuencial | se anuncia la dirección correcta sólo porque la sesión anterior ya había cerrado |
| exp3: `bindAddress 192.0.2.2`, sin servidores ICE | answer con `c=IN IP4 192.0.2.2` y un único candidato host; sin STUN no hace falta srflx si la IP es pública en la interfaz |

`127.0.0.0/8` es una ruta `local` del kernel: se puede enlazar a cualquier dirección del rango sin
configurarla. En IPv6 el equivalente es `ip -6 route add local 2001:db8:1:2::/64 dev lo` (AnyIP) o
`net.ipv6.ip_nonlocal_bind=1` + ruta. Además el proveedor tiene que **enrutar** la /64 al servidor (en
redes donde la /64 está "en el enlace" hace falta proxy NDP, p. ej. `ndppd`). **No probado en IPv6 real**
(el contenedor no tiene IPv6).

### 4.2 Diseño propuesto ("IPv6 por jugador")

1. En `handleOffer`, decidir la familia: si la oferta trae un candidato **srflx IPv6** (el STUN de Google
   tiene AAAA `2001:4860:4864:5:8000::1`, así que un Chrome con IPv6 genera srflx v6; libwebrtc no lo
   descarta como redundante cuando el host está ofuscado con mDNS) o una dirección v6 no‑mDNS → jugador
   **IPv6**.
2. Generar una /128 nueva y aleatoria de la /64 (64 bits de espacio: nunca se reutiliza), y un puerto
   aleatorio. Crear el PC con `bindAddress=<esa /128>`, `portRangeBegin=End=<puerto>`, sin mux y sin
   servidores STUN (no hace falta: la dirección es pública).
3. Guardar `addr → {peerId, conn, auth, nombre, hora}` (registro de atribución).
4. Al salir el jugador, la dirección **muere**: regla de firewall que descarta todo lo que vaya a ella
   (o simplemente no se vuelve a escuchar).
5. Si la oferta no trae IPv6, o si el intento falla, usar la IPv4 compartida (o la ruta protegida).
   El **reintento "reverse"** da la segunda oportunidad gratis: el cliente oficial reintenta una vez con
   `reverseFlag=1` si ya recibió answer y sigue en "Connecting to peer" (CL l.8314:
   `if (!e && 1 == d.yd && g) … c(!0)`). Coste: ~4 s extra para esos jugadores (`bj(4E3)`). En ese
   reintento convendría **no** aplicar el retardo de 2,5 s de `reverseIceDelayMs`.

Cambios necesarios en haxlite: un hook `rtcConfigFor(peer, offer)` (o `bindFor`) en `negotiate()` que
devuelva `bindAddress`/puerto por jugador; registrar la dirección en `Peer`; desactivar `enableIceUdpMux`
en ese modo (o mux por dirección).

### 4.3 Qué gana y qué no

- **Gana**: atribución exacta (quién filtró), filtrado barato (descartar una /128 concreta en el firewall
  del proveedor o con RTBH, si el proveedor acepta prefijos tan específicos), y direcciones con caducidad:
  un atacante sólo conoce una dirección válida mientras él (o un cómplice) está en la sala. Eso convierte
  "conozco la IP del servidor para siempre" en "conozco una dirección que muere cuando me echan".
- **No gana**: un ataque volumétrico contra *cualquier* dirección de la /64 sigue llegando al enlace del
  servidor; descartarlo en el propio servidor no evita la saturación. Sólo ayuda de verdad si el filtrado
  se hace antes del enlace (firewall del proveedor / RTBH) o si el atacante ataca la dirección concreta y
  no la /64 entera. (Hipótesis no verificada: los servicios de DDoS por encargo tienen menos capacidad
  contra objetivos IPv6, porque casi todos los vectores de amplificación son IPv4.)
- **IPv4 sólo**: con una única IPv4 lo máximo es un **puerto por jugador** (atribución si el atacante
  apunta al puerto que vio; descarte barato en nftables/XDP por puerto), pero no protege el ancho de banda.
  Con un bloque pequeño (/29, /28) se pueden repartir jugadores en grupos de direcciones para localizar
  al filtrador por bisección.

### 4.4 Cobertura IPv6 en LATAM

APNIC IPv6 Capability (medido con anuncios en navegadores), media de 30 días a 2026‑10‑09
(`ipresearch/apnic-summary.txt`):

| País | IPv6 capaz | IPv6 preferido |
|---|---|---|
| Uruguay | 61,5 % | 60,5 % |
| Brasil | 58,9 % | 57,8 % |
| México | 58,2 % | 57,7 % |
| Paraguay | 45,4 % | 44,1 % |
| Bolivia | 43,7 % | 43,4 % |
| Ecuador | 38,1 % | 37,6 % |
| Perú | 34,8 % | 34,4 % |
| **Argentina** | **34,3 %** | 32,4 % |
| Chile | 22,8 % | 22,1 % |
| Colombia | 21,6 % | 21,1 % |
| Venezuela | 10,5 % | 10,4 % |
| (EE. UU. / España, referencia) | 61,4 % / 10,5 % | 59,6 % / 10,1 % |

En Argentina depende mucho del ISP: Telecom (AS7303) 21 %, Telefónica (AS22927) 51 %,
Techtel (AS11664) 67 %. Las cifras incluyen móviles; en banda ancha fija de escritorio (que es donde se
juega a HaxBall) puede ser menor. Además, extensiones anti‑fugas WebRTC o políticas
`default_public_interface_only` pueden limitar los candidatos IPv6 del jugador. Estimación práctica para
una sala argentina: entre **un cuarto y un tercio** de los jugadores podría ir por IPv6; para Brasil o
México, más de la mitad.

---

## 5. ¿Puede el host cambiar de IP en mitad de la partida?

**No, con el cliente oficial.**

- Al abrirse el canal 0, `dc.Hd` crea `Pb` y llama a `pk()`, que **cierra el WebSocket de señalización**
  (CL l.5617‑5622, l.5651). No queda ningún canal para una nueva oferta/answer ni para nuevos candidatos.
- `Pb` (CL l.46‑70) sólo escucha `oniceconnectionstatechange` (`closed`/`failed` → desconexión), sin
  `onnegotiationneeded`, sin `restartIce`, sin `createOffer` posterior; el protocolo de juego no lleva
  SDP por el canal de datos.
- Teoría: el host podría enviar checks STUN con credenciales válidas **desde una dirección nueva**; el
  agente del cliente aprendería un prflx remoto (RFC 8445 §7.3.1.3) y Chrome podría cambiar de par si el
  original deja de responder. Pero (a) el NAT/firewall del cliente descarta tráfico entrante de una
  dirección a la que el cliente nunca ha enviado nada (casi todos los NAT domésticos y los firewalls
  IPv6 con estado), y (b) libjuice tiene un socket por agente y no puede emitir desde otra dirección.
  **Viabilidad: muy baja.**
- Lo único factible es **forzar la reconexión**: kick con un mensaje ("vuelve a entrar") y nueva answer
  con otra dirección. El diálogo de desconexión del cliente sólo tiene "Ok" (y "replay"), no
  "reintentar" (CL clase `Ua`, l.1567), así que el jugador tiene que volver a entrar a mano.

---

## 6. Mecanismos propios de HaxBall

- **"Trying reverse connection..."** (CL l.3459, l.8314; HL l.709 `f && (l.Qe = 2500)`): mismo P2P, con
  el host retrasando 2,5 s los candidatos remotos y el cliente esperando 10 s. Activado también por
  `localStorage.crappy_router` (CL l.3108). No hay relay. Útil como segunda oportunidad (§4.2).
- **Master**: sólo señalización. No relaya juego, no tiene TURN, no expone la IP del host. Es **sólo
  IPv4**, así que `conn` siempre es la IPv4 del cliente, aunque luego juegue por IPv6 (útil para bans y
  reputación).
- **ICE servers del cliente fijos**: `m.kg = [{urls: "stun:stun.l.google.com:19302"}]` (CL l.10291); el
  host no puede pasarle un TURN al cliente. Cualquier relay tiene que ser del lado del host.
- **Captcha del master** (`requireRecaptcha`): el único "gating" que ocurre fuera del host y antes de que
  la oferta llegue.

### 6.1 ¿Puede el host anunciar un DOMINIO (p. ej. detrás del proxy de Cloudflare) en lugar de una IP?

**Veredicto: no sirve. En el mejor caso no oculta nada y, con el proxy naranja, la conexión falla.**

1. **Estándar**: RFC 8839 §5.1 admite FQDN en la sintaxis de `<connection-address>`, pero dice que *"an
   agent generating local candidates MUST NOT use FQDN addresses"* y que *"an agent processing remote
   candidates MUST ignore 'candidate' lines that include candidates with FQDNs"* salvo que una extensión
   defina cómo tratarlos (§11 lo recoge como cambio respecto a RFC 5245). La única extensión desplegada
   es la de mDNS (`*.local`).
2. **Chrome (libwebrtc)**: desde el commit "Support domain name ICE candidates" (agosto de 2018,
   webrtc:4165), `P2PTransportChannel::AddRemoteCandidate` envía los candidatos con
   `IsUnresolvedIP()` a un resolvedor asíncrono; si hay `AsyncResolverFactory`, resuelve el nombre
   (prefiere AAAA, luego A), **sustituye el nombre por la IP resuelta** y sigue por el camino normal; si
   no hay factoría o la resolución falla, descarta el candidato. Que Chromium resuelva por DNS normal
   cualquier nombre que no sea `.local` es **probable pero no está verificado** con un navegador real
   (el contenedor no tiene Chrome). Safari usa libwebrtc: comportamiento **no verificado**. Firefox
   (nICEr): no se ha encontrado soporte para candidatos FQDN que no sean mDNS; lo esperable según RFC 8839
   es que los ignore (**no verificado**). Hay informes antiguos (FreeSWITCH, 2016) de sesiones sin
   medios con nombres en el SDP en Chrome y Firefox.
3. **Aunque se resuelva, no oculta nada**: el navegador manda el UDP a la **IP resuelta**. Esa IP la ve
   el sistema operativo del jugador (Wireshark/`netstat`) y aparece como candidato remoto/par
   seleccionado en `chrome://webrtc-internals`. Además cualquiera puede resolver el nombre con
   `nslookup`. Es como publicar la IP con un paso más.
4. **Cloudflare naranja (proxy)**: sólo hace proxy de HTTP/HTTPS en puertos concretos (80, 8080, 8880,
   2052, 2082, 2086, 2095 / 443, 2053, 2083, 2087, 2096, 8443). Para otros puertos u otro tráfico la
   documentación dice que hay que poner el registro en gris (*"bypass the Cloudflare network and connect
   directly to your origin"*, o sea, expone la IP) o usar **Spectrum**, y *"Spectrum for all TCP and UDP
   ports is only available on the Enterprise plan"*. Un nombre en naranja resuelve a IPs anycast de
   Cloudflare que **no reenvían UDP arbitrario** al origen → el STUN/DTLS del jugador nunca llega al host
   → la conexión falla. En gris resuelve a la IP del origen → no oculta nada.
5. **En haxlite**: libjuice siempre genera IPs; habría que reescribir el candidato, y `classifyAddress`
   clasificaría un nombre que no sea IP como `'invalid'`, así que la policy `'public'` lo **descartaría**.
   El cliente oficial no hace nada especial: `new RTCIceCandidate(json)` + `addIceCandidate` (CL l.5683‑5694).

Lo que sí funciona del ecosistema de Cloudflare para UDP es su TURN (ya probado y descartado por el
enrutamiento) o Spectrum Enterprise, que sería un "frente" del tipo de §3 con su red de mitigación.

---

## 7. Valoración de ideas

| Idea | Sin infraestructura | Protege el ancho de banda | Atribución | Viabilidad | Recomendación |
|---|---|---|---|---|---|
| Filtro de candidatos (`iceCandidatePolicy`) | Sí | No | No | Hecho | Mantener |
| `iceTransportPolicy:'relay'` si se usa TURN | — | Traslada el objetivo | No | Alta | Obligatorio si hay TURN |
| Contraseñas por jugador / un solo uso | Sí | No | **Sí** | Alta | **Sí** para salas privadas/competitivas |
| Captcha adaptativo | Sí | No | No | Alta | Sí |
| Reputación de ASN/VPN en `onJoinRequest` | Sí | No | Parcial | Alta | Opcional |
| **IPv6 por jugador + puerto por jugador** | Sí (con /64 enrutada) | Sólo con filtrado aguas arriba | **Sí** | Media-alta (falta probar en IPv6 real) | **Sí, prioridad 1** |
| Puerto por jugador en IPv4 | Sí | No | Parcial | Alta | Sí (barato) |
| IPv6 primero y v4 en el reintento "reverse" | Sí | — | — | Media | Sí, junto con la anterior |
| Frente con forma de NAT | No | Sólo con red protegida | Si es por jugador | Alta (técnica) | Sólo si se acepta infraestructura en red con mitigación |
| TURN propio | No | Igual que el frente | No | Hecha | Peor que el frente |
| Cambiar de IP en mitad de la partida | — | — | — | Muy baja | No |
| Anunciar un dominio (FQDN) en vez de IP / Cloudflare naranja | Sí | No (con proxy naranja, falla) | No | Nula | No |
| Verificar `auth` antes de ICE | — | — | — | Imposible | — |

## 8. Recomendaciones concretas

1. **Cambiar la IP pública actual** cuando se despliegue cualquier medida: la de ahora ya está quemada.
   No alojar nada más (web, bot, DNS público) en esa IP.
2. Implementar en haxlite un hook por jugador para la config RTC (`bindAddress` + puerto) y el modo
   **"IPv6 efímera por jugador"** con registro de atribución; desactivar `enableIceUdpMux` en ese modo.
   Confirmar con el proveedor que la /64 está **enrutada** (o usar `ndppd`), y si su firewall o RTBH
   puede descartar /128 concretas.
3. Para jugadores sólo-IPv4: puerto por jugador en la IPv4 compartida (atribución por puerto); si se
   acepta algo de infraestructura, mandar sólo a esos jugadores por un frente/relay en red con mitigación,
   así la carga y la superficie son menores.
4. Salas privadas/competitivas: contraseñas personales (cambiar `handleOffer` para separar el flag de
   contraseña de la comprobación y validarla en `onJoinRequest`). Es el único secreto que el cliente
   oficial entrega antes de ICE.
5. Activar captcha automáticamente cuando suba el ritmo de entradas o tras un ataque; añadir cuotas de
   answers por IP o por /24.
6. Si se usa TURN o un frente: `iceTransportPolicy: 'relay'` (o equivalente) y egress del host
   restringido, para que el host nunca hable directamente con un cliente.
7. Pendiente de validar con un Chrome real: srflx IPv6 en la oferta con mDNS activo; tiempo real del
   fallback v6→v4 vía "reverse"; comportamiento del frente con Chrome/Firefox.

---

## Referencias

- RFC 8445 (ICE): §7.2.5.2.1 simetría, §7.2.5.3.1 prflx local, §7.3.1.3 prflx remoto — https://www.rfc-editor.org/rfc/rfc8445
- RFC 7675 (consent freshness) — https://www.rfc-editor.org/rfc/rfc7675
- RFC 8489 (STUN, MESSAGE-INTEGRITY, XOR-MAPPED-ADDRESS) — https://www.rfc-editor.org/rfc/rfc8489
- RFC 8261 §6.1 (SCTP sobre DTLS sin direcciones IP) — https://www.rfc-editor.org/rfc/rfc8261.html
- RFC 8828 (manejo de direcciones IP en WebRTC) — https://www.rfc-editor.org/rfc/rfc8828
- mDNS ICE candidates — https://datatracker.ietf.org/doc/html/draft-ietf-rtcweb-mdns-ice-candidates-02
- W3C webrtc-stats #375 (IP remota en stats) — https://lists.w3.org/Archives/Public/public-webrtc-logs/2019Aug/0324.html
- Chromium/libwebrtc: saneado de prflx remotos (bug 968161) — https://webrtc.googlesource.com/src/+/7627fdd68a31f4873d32e2af4c78e0f16eab3bd8%5E%21
- libwebrtc: descarte de srflx redundante salvo con mDNS — https://webrtc.googlesource.com/src/+/7eea6672285f765599fd883a5737f5cae8d20917%5E%21 ; WebKit 233414 — https://bugs.webkit.org/show_bug.cgi?id=233414
- RFC 8839 §5.1/§11 (FQDN en candidatos) — https://www.rfc-editor.org/rfc/rfc8839.html
- libwebrtc "Support domain name ICE candidates" (2018) — https://webrtc.googlesource.com/src.git/+/6fcdc2f70815601861f7a718c67490a5f14f1e1b%5E%21/
- FreeSWITCH, nombre de host en el SDP (2016) — https://lists.freeswitch.org/pipermail/freeswitch-users/2016-August/121790.html
- Cloudflare, puertos del proxy y Spectrum — https://developers.cloudflare.com/fundamentals/reference/network-ports/
- APNIC IPv6 por país — https://stats.labs.apnic.net/ipv6/AR (BR, CL, PE, MX, UY, CO, VE, PY, BO, EC)
- Google IPv6 statistics — https://www.google.com/intl/en/ipv6/statistics.html
- DNS: `stun.l.google.com` AAAA `2001:4860:4864:5:8000::1`; `p2p.haxball.com` y `www.haxball.com` sin AAAA (consultado vía dns.google, 2026‑10‑10)

## Archivos del experimento (`$SCRATCH/ipresearch/`)

- `exp1-bind.mjs` / `exp1-bind.out`: `bindAddress` + puerto por PC, contenido de la answer, par seleccionado.
- `exp1b-mux-multiaddr.mjs` / `exp1b.out`, `exp1c-concurrent.mjs` / `exp1c.out` (con mux: se ignora `bindAddress`),
  `exp1d-concurrent-nomux.mjs` / `exp1d.out` (sin mux: 8 direcciones OK).
- `exp3-relay-sdp.mjs` / `exp3.out`: SDP con `iceTransportPolicy:'relay'` (limpio) y con `bindAddress`.
- `apnic/*.html`, `apnic-summary.txt`: datos de cobertura IPv6.
