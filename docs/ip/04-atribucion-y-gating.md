# 04 — Atribución por "canary addressing" y gating del reveal de IP

Trabajo defensivo para los servidores propios (haxlite, rama `feat/haxlite`). Objetivo del track:
**reducir quién aprende la IP del host** y **saber qué sesión la filtró / quién ataca**, para banear.

Contexto del protocolo (confirmado en `docs/01-red-y-salas.md`, `src/net/transport.ts`, cliente oficial
`web/game.pretty.js`):

- El cliente manda al maestro una **oferta** SDP; el maestro la reenvía al host añadiendo `peerId` y
  `conn` (IP del cliente vista por el maestro). En `onJoinRequest` (pre-WebRTC) ya conocemos: `conn`/`ip`,
  IPs **srflx** de los candidatos del cliente, `candidateAddresses`, `version` y `password`.
- El host responde con el **answer** SDP + candidatos ICE. **Ese answer revela la dirección del host**
  (candidato `host` con su IP:puerto, o el srflx si está tras NAT).
- El `auth` firmado (ECDSA P-256) llega **después**, por el data channel `ro` (mensaje 0), y recién ahí se
  verifica la firma. Es decir: **el reveal ocurre antes de poder verificar la identidad**. La única
  identidad fiable en el momento de señalización es la **IP** (`conn` + srflx).
- El ban oficial es **por IP** (conn + srflx). haxlite ya añade ban por IP/rango/auth (`src/net/bans.ts`),
  hook `onJoinRequest` async, y `joinRateLimit` por IP (`src/net/rate-limit.ts`).

---

## 1. Canary addressing: dar a cada jugador un endpoint único del host

### 1.1 Idea

Dar a cada `PeerConnection` entrante su propia dirección/puerto del host de modo que, si llega un ataque a
un endpoint concreto, sepamos **qué sesión** recibió ese endpoint en su answer (es el único que lo conoce,
porque el candidato host va sólo en ese answer). Dos variantes:

- **Puerto único por jugador** (IPv4 o IPv6): `portRangeBegin == portRangeEnd` por `PeerConnection`,
  `enableIceUdpMux` **off** (con mux todas las conexiones comparten un puerto → no sirve para atribuir).
- **Dirección IPv6 única por jugador**: `bindAddress` = una IPv6 distinta sacada del `/64` del servidor
  (p.ej. `2001:db8:a:b::<token>`). Resiste floods a "todos los puertos" de esa IP.

### 1.2 Experimento (resultados reales)

`node-datachannel` 0.33.4 (libdatachannel 0.24.x), Node 22, repo `node_modules`. Script:
`ipresearch/canary-exp.mjs`; salida: `ipresearch/canary-exp.out`. Cada caso levanta un PC host con la
config indicada y un PC cliente en loopback, conecta ICE de verdad y lee `getSelectedCandidatePair()`.

```
== A v4 127.0.0.1 port 41001   {"bindAddress":"127.0.0.1","portRangeBegin":41001,"portRangeEnd":41001}
  host cands : 127.0.0.1 41001 typ host
  selected   : host 127.0.0.1:41001  <->  client 127.0.0.1:42799
== B v4 127.0.0.2 port 41002   {"bindAddress":"127.0.0.2",...41002...}
  host cands : 127.0.0.2 41002 typ host
  selected   : host 127.0.0.2:41002  <->  client 127.0.0.1:43076
== C v4 127.0.0.3 port 41001 (mismo puerto, otra addr)   {"bindAddress":"127.0.0.3",...41001...}
  host cands : 127.0.0.3 41001 typ host
  selected   : host 127.0.0.3:41001  <->  client 127.0.0.1:44794
== D v4 127.0.0.1 port 41001 DE NUEVO (colisión, A sigue abierto)
  host cands : (none)
  error      : Failed to gather local ICE candidates
== E/F mux on 127.0.0.1 range 41010-41010 #1 y #2 (enableIceUdpMux:true)
  host cands : 127.0.0.1 41010 typ host   (AMBOS en el MISMO puerto 41010)
== H/I default ({})  -> host cands : 192.0.2.2 53274 / 192.0.2.2 53021 (puertos efímeros distintos)
== G v6 ::1 port 41003 -> error: Failed to gather (el contenedor no tiene IPv6: sin /proc/net/if_inet6)
```

Sockets UDP del proceso (`/proc/self/net/udp` filtrado por inodos de fds):
`127.0.0.1:41001`, `127.0.0.2:41002`, `127.0.0.3:41001`, `127.0.0.1:41010` (uno solo, compartido E+F), etc.

**Conclusiones probadas:**

- `bindAddress` + `portRangeBegin==End` dan a cada PC **su propia dirección:puerto** (A, B, C). Funciona
  por-conexión; el candidato host en el answer es exactamente ese endpoint. **La atribución es viable.**
- `enableIceUdpMux` colapsa todo en un puerto (E+F → 41010): **debe estar off** para atribuir (coincide con
  el comentario de `HostTransportOptions.rtc`).
- **Colisión** (D): si el puerto ya está tomado, el PC **no reúne candidatos y falla**. El asignador debe
  llevar un pool y nunca reusar un puerto ocupado (ver §1.4; incluso conviene cuarentena tras liberar).
- Misma addr distinto puerto, y distinta addr mismo puerto, **ambas funcionan** → el espacio de canarios es
  `direcciones × puertos`.
- IPv6 no se pudo probar aquí (contenedor sin IPv6), pero la API acepta `bindAddress` IPv6 y libdatachannel
  bindea literalmente la dirección dada; en un servidor con `/64` enrutado y las direcciones añadidas a la
  interfaz (o `ip -6 route add local <pfx>/64 dev lo` + bind) cada `bindAddress` da su propio origen.

Nota de capacidad: cada canario = un socket/puerto. Rango de ~20k puertos cubre de sobra una sala (<=30).
Con IPv6 el `/64` da 2^64 direcciones; en la práctica se rota un pool pequeño con cuarentena.

### 1.3 Cómo atacan los "booters" → implicaciones

Material consultado (MITRE ATT&CK T1498.002, encuestas DDoS; ver *Fuentes*): los floods L3/L4 por UDP y
sobre todo los de **reflexión/amplificación** usan origen spoofeado y la víctima se define por **IP de
destino**; el puerto de destino suele ser el del *reflector*, no el del objetivo, de modo que el tráfico
llega a **cualquier/‑todos los puertos** de la IP víctima. La mitigación on-prem recomendada es bloquear por
IP de origen, **por puerto objetivo** o por protocolo. De aquí:

- **Atribución a nivel de puerto** (IPv4, varios jugadores sobre una misma IP) sólo funciona **si el
  atacante dirige el flood a ese puerto concreto** (p.ej. un booter que aprendió `IP:port` del candidato
  host y lo reusa). Contra floods de reflexión "a la IP entera" el puerto no discrimina.
- **Atribución a nivel de dirección IPv6** (una IPv6 del `/64` por jugador) funciona **aunque inunden todos
  los puertos** de esa dirección, porque cada jugador tiene una IP distinta. Es la variante robusta, pero
  **sólo para jugadores que conectan por IPv6** (los IPv4 caen todos bajo la misma IP → sólo puerto).
- Por tanto: **IPv6-per-player** es la atribución fuerte; **puerto-per-player** es un complemento útil y
  barato que captura al subconjunto de atacantes que targetean `IP:port`.

### 1.4 Diseño de feature haxlite: `canary` (boceto)

**Detección de qué endpoint recibe el ataque** (de más simple a más potente):

- **nftables con sets dinámicos con `counter` por `(daddr, dport)`** — recomendado. Probado:
  `ops/haxguard/canary-counters.nft` carga una tabla *solo-conteo* (`policy accept`, sin drops) con hook
  `prerouting`:
  ```
  set canary4 { type ipv4_addr . inet_service; flags dynamic,timeout; timeout 10m; counter; size 65536 }
  chain pre { type filter hook prerouting priority -300; policy accept;
    udp dport 41000-41999 update @canary4 { ip daddr . udp dport } }
  ```
  Se leen contadores con `nft -j list set ...` y se calcula la tasa. En producción, mejor en una tabla
  `netdev`/hook `ingress` de la interfaz pública (cuenta antes del routing, menos coste).
- `/proc/net/snmp` / contadores de interfaz: sólo agregados, no por-puerto → insuficiente para mapear.
- **eBPF/XDP** (`bpf_map` por puerto): la opción más barata a gran pps y permite drop selectivo; más
  complejidad operativa. AF_PACKET+muestreo: fallback sin privilegios de XDP.

**Demo de atribución extremo a extremo (benigna)** — `ipresearch/attribution-demo.mjs` /
`attribution-demo.out`: se envían datagramas UDP normales a dos endpoints canario, se leen los contadores
nft y se resuelve `endpoint → sesión`:
```
endpoint             packets  bytes   -> session
127.0.0.1:41247            5    540   -> player #7 Alice auth=pub_AAA conn=C0A80001
127.0.0.1:41417           12   1296   -> player #9 Bob   auth=pub_BBB conn=C0A80002
hottest endpoint: 127.0.0.1:41417 -> would attribute/ban Bob auth=pub_BBB
```
Queda demostrado el circuito **paquetes en endpoint X → tabla de asignación → sesión (auth, conn, name) →
ban**. (No se genera tráfico de ataque; sólo paquetes UDP normales para validar que el contador por
endpoint atribuye correctamente.)

**Config** (bajo `HaxliteConfig`, nuevo bloque `canary?`):
```ts
canary?: {
  mode: 'port' | 'ipv6' | 'ipv6+port' | 'off';   // off = comportamiento actual
  ipv4Address?: string;                           // IP pública IPv4 del host (modo 'port')
  portRange?: [number, number];                   // pool de puertos canario (debe ser amplio)
  ipv6Prefix?: string;                            // '/64' enrutado (modo 'ipv6'); se derivan direcciones
  quarantineMs?: number;                          // no reusar endpoint liberado hasta pasado este tiempo
  detector?: {
    backend: 'nftables' | 'ebpf' | 'none';
    pollMs?: number;                              // p.ej. 500
    ppsThreshold?: number; bytesPerSecThreshold?: number;  // umbral de "endpoint caliente"
    action?: 'event-only' | 'ban-ip' | 'ban-auth' | 'ban-both';
  };
}
```

**Integración en el transporte** (`src/net/transport.ts`, `negotiate()`): hoy ya aplica
`portRange`→`portRangeBegin/End` y mezcla `this.opts.rtc`. El asignador elegiría **por peer** un
`{bindAddress?, portRangeBegin==End}` libre del pool antes de `createPeerConnection`, guardaría
`endpoint → peer` y lo liberaría (con cuarentena) en `closePeer`. Clave: `enableIceUdpMux` **off** y
`iceCandidatePolicy` que **no** oculte el candidato host de ese endpoint (si no, el cliente no lo ve; pero
ojo: eso es justo el reveal — ver §2, hay tensión entre atribuir y ocultar).

**Eventos / API** (`HaxliteRoomExtensions`):
```ts
room.haxlite.onCanaryAttack = (ev) => { /* {endpoint, playerId, auth, conn, name, pps, bytesPerSec} */ };
room.haxlite.canary.list();                 // asignaciones endpoint -> sesión vigentes
room.haxlite.canary.endpointOf(playerId);   // para logging/soporte
```
El handler por defecto (si `action!=='event-only'`) llamaría a `bans.addIp(...)` / `bans.addAuth(player.auth)`
y cerraría al peer. **auth** se conoce sólo tras el handshake, así que `getPlayerConnection(playerId)` da el
cruce `endpoint↔auth` una vez el jugador entró (encaja con el modelo de confianza, §3).

**Storage**: en memoria basta (pool + Map endpoint→sesión). Para historial de reincidentes, persistir
`{auth, ips[], primer visto, nº incidentes canario, reputación}` (ver §3) en un JSON/SQLite del operador.

**Tensión importante**: la atribución por canario **requiere revelar** el endpoint host a ese jugador (el
candidato host va en su answer). Es decir, canary addressing **ayuda a identificar al filtrador/atacante**,
pero **no reduce** por sí solo quién aprende una IP del host — simplemente hace que cada quien aprenda una
*distinta*, lo que permite banear a la que se usa para atacar sin afectar a las demás. Reducir el *número*
de quienes aprenden la IP es el trabajo del §2 (gating). Las dos piezas son complementarias.

---

## 2. Gating del reveal (quién llega a recibir el answer)

Como el answer revela la IP y aún no hay `auth`, toda decisión de *revelar o no* se toma con lo de
`onJoinRequest`: `conn`/IP, srflx IPs, `candidateAddresses`, `version`, `password`. Estrategias y costes:

| Estrategia | Qué bloquea | Coste / contra |
|---|---|---|
| **Sala privada + password por Discord tras verificación** | Elimina el join anónimo; sólo quien pasó por tu verificación obtiene la pass → reduce drásticamente quién aprende la IP | Fricción; la pass se puede filtrar (rotarla, o una pass por persona); el password se valida en `onJoinRequest` **antes** del answer (ya implementado, `RejectCode.WrongPassword` = 4101) |
| **Reputación de la IP conn (ASN VPN/hosting)** | Bloquea/encola joins desde ASNs de hosting/VPN (típico de atacantes) usando **GeoLite2-ASN offline** (sin llamadas externas) o APIs de reputación | GeoLite2 requiere licencia MaxMind y actualización; APIs online = latencia/privacidad; falsos positivos (jugadores legítimos con VPN) → combinar con allowlist |
| **Cola / "sala de espera" para IPs nuevas** | Una IP nunca vista no recibe answer de inmediato: espera/че se le pide verificación | Hay que mantener estado de IPs vistas; UX de espera |
| **Rate-limit de join por IP** | Frena intentos repetidos desde una IP (reparto de IPs a escala) | Ya existe (`joinRateLimit`, `KeyedRateLimiter`); poco efectivo contra muchas IPs distintas |
| **reCAPTCHA (`requireRecaptcha`)** | El maestro exige captcha antes de dar token de sala al cliente → filtra bots que ni llegan a ofertar | Sólo humanos-vs-bots; un humano atacante pasa; depende del maestro oficial (ver flujo abajo) |
| **Modo allowlist / "lockdown"** | Durante un ataque, **sólo** IPs/rangos vistos antes con buen historial reciben answer; el resto se rechaza con un código | Jugadores nuevos legítimos quedan fuera mientras dure; requiere historial IP↔reputación (§3) |

### 2.1 Cómo funciona el reCAPTCHA oficial (cliente `web/game.pretty.js`)

- El cliente, al conectar a una sala, si el host tiene `requireRecaptcha` activo, recibe **cierre 4004** del
  WS de sala (`case 4004` en el manejador `uf`/`g.uf`, línea ~3430). Eso dispara `B.Vo(room, cb)`.
- `B.Vo` hace `POST {masterBase}api/client` con `room=<roomId>&rcr=<respuesta>` (línea ~3147). La respuesta
  es `{action:"connect", token}` (sigue el join con ese token) o `{action:"recaptcha", sitekey}`.
- Con `action:"recaptcha"` el cliente renderiza el widget Google (`grecaptcha`, carga
  `https://www.google.com/recaptcha/api.js`, línea ~7357; diálogo "Only humans", clase `ba`, línea ~5790
  con `sitekey`, `callback`, `theme:"dark"`), obtiene la respuesta y reintenta `api/client` con `rcr=<resp>`.
- En haxlite esto está expuesto: `transport.setRequireRecaptcha(on)` (línea ~428), `useRecaptchaToken(rcr)`,
  y `room.haxlite.onRecaptcha(sitekey)` / `useRecaptchaToken`. El flujo de host (`/rs/api/host`) tiene la
  misma mecánica (`{action:"recaptcha",sitekey}`). **Importante**: reCAPTCHA filtra bots, **no** impide que
  un humano determinado aprenda la IP; es una capa, no la solución.

### 2.2 Decoy / lobby sacrificable

- **Decoy dentro de una misma sala: no es viable.** El estado de la sala vive en **un** host; todos los
  admitidos se conectan a esa instancia. No se puede contestar a desconocidos con "otro endpoint
  sacrificable" y a la vez meterlos en la misma partida: o les das un endpoint real (y aprenden la IP), o no
  entran. Lo más parecido es el canary (§1): endpoints distintos, pero **todos** reales y sobre el mismo
  host; sirve para *atribuir*, no para *sacrificar*.
- **Lobby separado en IP sacrificable: sí, y es la mejor pieza arquitectónica.** Dos salas en dos hosts/IPs:
  1. **Lobby** (host en IP "barata"/protegida/con scrubbing, o incluso detrás de TURN-relay `rtc:
     {iceTransportPolicy:'relay'}` para que **nunca** revele la IP real — sólo la del TURN). Entra todo el
     mundo. Ahí se verifica identidad (`auth`), reputación, se observa comportamiento.
  2. **Main** (sala real, privada, con password rotatoria o allowlist). El host del lobby **promueve** a los
     jugadores de confianza enviándoles por el canal de datos del lobby el **link + password** de la main.
     Sólo entonces aprenden una IP del host principal.
  - Resultado: los atacantes anónimos sólo pueden floodear la IP del **lobby** (sacrificable / tras TURN /
    con scrubbing), no la main. Combinado con canary en la main, cualquier filtración desde la main se
    atribuye a un `auth` ya conocido (porque sólo entran verificados). Esta es la defensa en profundidad más
    sólida con el protocolo actual.
  - Variante fuerte: el **lobby operando relay-only** (`iceTransportPolicy:'relay'`, ya soportado) no revela
    IP real de host en absoluto; el precio es latencia/ancho de banda del TURN, aceptable para un lobby.

---

## 3. Modelo de confianza

- **En señalización la única identidad fiable es la IP** (`conn` + srflx). El `auth` **no** está disponible
  aún y, aunque lo estuviera, es trivialmente regenerable (clave local del navegador) → sirve para
  identificar/seguir cuentas, no como barrera dura. El `conn` lo fija el **maestro** (IP real vista por él),
  no es spoofeable por el cliente en el join → es el dato de confianza en el reveal.
- **Binding IP ↔ historial de auth** (lo vemos *ambos* tras el join: `getPlayerConnection(playerId)` da
  `{auth, conn, ip, srflxIps, ping}`): tras cada partida, registrar `auth → {ips vistas, primer/último
  visto, nº sesiones, incidentes (kick/ban/canary-attack), nota del operador}` y el inverso `ip → auths`.
  Con eso se construye una **reputación** por IP y por auth.
- **Uso en futuros reveals** (en `onJoinRequest`, que sólo ve IP): decidir según la reputación de la IP:
  - IP con historial de `auth`(s) de buen standing → revelar (o revelar directo incluso en lockdown).
  - IP nueva → cola/captcha/espera (modo normal) o **rechazo** (modo lockdown).
  - IP ligada a auth(s) con incidentes, o ASN de hosting/VPN → rechazo/cuarentena.
  - Esquema de puntuación simple: `score(ip) = f(standing de sus auths, antigüedad, incidentes, clase de
    ASN)`; umbral configurable; en lockdown el umbral sube.
- **Límite honesto**: el binding es probabilístico (IPs dinámicas, CGNAT comparten IP entre jugadores;
  VPNs). Por eso el historial *favorece* (allowlist de buen standing) más que *castiga* por IP compartida —
  el castigo duro va por `auth` + por el incidente concreto de canary.

---

## 4. Recomendaciones priorizadas

1. **Lobby + main (IP sacrificable)** — máxima reducción de "quién aprende la IP real". Lobby relay-only o
   en IP protegida; main privada; promoción por auth verificado. Es la pieza con mejor relación
   impacto/riesgo y la única que de verdad *reduce* el reveal.
2. **Historial IP↔auth + reputación** (§3) y **modo lockdown** (allowlist de buen standing durante ataques).
   Barato de implementar sobre `getPlayerConnection` + `onJoinRequest`/`bans` ya existentes.
3. **Canary IPv6-per-player** en la main (si el server tiene `/64`): atribución robusta aunque inunden todos
   los puertos. Detector nftables `netdev`/ingress con sets `counter` por dirección → ban automático del
   `auth` asociado. Añadir **puerto-per-player** como complemento barato para atacantes que targetean
   `IP:port`. Requiere pool con cuarentena (evitar la colisión del caso D) y `enableIceUdpMux` off.
4. **Password privada rotatoria por Discord** + **reCAPTCHA** como capas de fricción anti-bot en el lobby.
   Útiles pero insuficientes solas (humano atacante las pasa).
5. **Reputación de ASN con GeoLite2-ASN offline** para encolar/bloquear joins de hosting/VPN; combinar
   siempre con la allowlist de §3 para no castigar jugadores legítimos con VPN.
6. Rate-limit por IP ya existe; mantenerlo, pero no confiar en él contra ataques con muchas IPs.

**Tensión a recordar**: canary *atribuye* pero no *oculta* (cada quien recibe una IP distinta, todas
reales). Ocultar/reducir el reveal es trabajo del lobby/allowlist. Úsense juntos: lobby para reducir, canary
en la main para atribuir lo que se filtre desde dentro.

## Archivos del experimento
- `ipresearch/canary-exp.mjs` / `canary-exp.out` — asignación de dirección:puerto por PeerConnection.
- `ops/haxguard/canary-counters.nft` (en el repo; los demás archivos de `ipresearch/` son del experimento y no están en él) — tabla nftables solo-conteo por `(daddr,dport)` (hook prerouting).
- `ipresearch/attribution-demo.mjs` / `attribution-demo.out` — mapeo endpoint→sesión (tráfico benigno).

## Fuentes
- [MITRE ATT&CK T1498.002 — Reflection Amplification](https://attack.mitre.org/techniques/T1498/002/)
- [A Survey of DDoS Attacks and Defenses (arXiv)](https://arxiv.org/pdf/2008.01345)
- [ioriver — Reflection Attacks](https://www.ioriver.io/blog/reflection-attacks-ddos-traffic)
- node-datachannel 0.33.4 `RtcConfig` (`node_modules/.../lib/types.d.ts`): `bindAddress`,
  `portRangeBegin/End`, `enableIceUdpMux`, `iceTransportPolicy`.
