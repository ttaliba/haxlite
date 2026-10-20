# 02 — TURN para ocultar la IP del host HaxBall (Cloudflare Realtime TURN y alternativas)

Fecha de la investigación: 2026-10-10. Topología analizada: **host headless (haxlite, node-datachannel 0.33.4 → libdatachannel v0.24.5 → libjuice) en modo relay-only; clientes = cliente oficial de HaxBall en el navegador, con ICE `stun:stun.l.google.com:19302` y sin TURN**. Por tanto, solo el host es cliente TURN. Los navegadores hablan directamente con la *relayed address* que el host anuncia como candidato `typ relay`.

Leyenda: **[DOC]** = documentado por el proveedor. **[CÓDIGO]** = verificado en el código fuente. **[MEDIDO]** = medido en un entorno de pruebas. **[INFERENCIA]** = deducción que hay que comprobar en producción.

> **Nota de estado (0.3.x): este informe analiza `peerBackend: 'ndc'` (libdatachannel/libjuice).** Con `peerBackend: 'rtc'` (haxlite-rtc, [docs/10 §2.2](../10-haxlite-rtc.md)) los límites de libjuice de abajo no aplican: el cliente TURN (RFC 8656, `src/rtc/turn.ts`) corre dentro del proceso, acepta varias entradas `turn:` UDP sin límite de 2 ni barajado, y si un Allocate no contesta prueba al instante la siguiente de la lista (p. ej. el puerto 53 de Cloudflare tras el 3478; el bloqueo del 53 es de los navegadores, no del host); con `iceTransportPolicy: 'relay'` no existen pares directos (`ice-agent.ts`) y lo que llegue directo de un jugador no se contesta (`stats().directDropped`), es decir, el bug de la sección 0.1 no existe en ese backend; `room.haxlite.setIceServers(lista)` renueva las credenciales en caliente sin reiniciar la sala; reparte los jugadores entre varias asignaciones (el límite de ~10 pares por asignación de Cloudflare) y pide `CreatePermission` también para la IP con la que el jugador llegó al maestro. Siguen valiendo: solo UDP e IPv4 en el relay, las limitaciones de Cloudflare (BYOIP, rutas, TTL) y el resto del análisis de red. En `ndc`, `setIceServers` también existe, pero solo afecta a las PeerConnections nuevas.

---

## 0. Resumen ejecutivo

1. **Hallazgo crítico (no es culpa de Cloudflare): en este stack, `iceTransportPolicy: 'relay'` no es relay-only de verdad.** libdatachannel solo deja de *anunciar* los candidatos que no son relay. libjuice, en cambio, sigue creando un par **directo** desde el socket real del host para cada candidato remoto y le envía *connectivity checks* STUN desde la IP real [CÓDIGO]. Es un bug abierto: [libdatachannel#1587](https://github.com/paullouisageneau/libdatachannel/issues/1587) (11-jun-2026) y [libjuice#345](https://github.com/paullouisageneau/libjuice/issues/345) (6-jul-2026), sin PR. Consecuencias:
   - Algunos jugadores reciben paquetes desde la IP real del host: los que tienen IP pública, NAT *full-cone*/EIF o IPv6 sin firewall. Esa IP se ve con Wireshark.
   - Con esos jugadores, el par directo puede ganar a la relay (un prflx tiene más prioridad que un relay) y la partida va **directa**.
   - Mientras no se corrija, la ocultación de IP es parcial. Además, en la misma sala unos jugadores van por relay y otros directos.
   - **Arreglo inmediato: firewall de salida en el host** (sección 5.3).
2. **Por qué "algunos no pueden entrar"**, de más a menos probable:
   - (a) Por TURN solo pasan los paquetes de IPs para las que el host hizo `CreatePermission`. El host solo conoce las IPs de los candidatos del cliente, y el cliente oficial solo tiene srflx de Google STUN. Si a ese jugador le falla el STUN de Google, o sale a Cloudflare por otra IP pública (CGNAT con pool no emparejado, multi-WAN, VPN/WARP), la conexión muere. Sin TURN, el host lo habría "descubierto" como peer-reflexive. **[DOC+CÓDIGO+INFERENCIA]**
   - (b) Cloudflare **solo asigna relayed addresses IPv4** [DOC]. Los clientes sin candidato IPv4 (iOS en redes IPv6-only/NAT64, o STUN IPv4 fallido) no pueden emparejar.
   - (c) **Credenciales caducadas**: con `ndc` haxlite fija `iceServers` al construir el transport (hoy se pueden cambiar en caliente con `setIceServers`, ver la nota de estado) y la TTL máxima es de 48 h [DOC][CÓDIGO]. Al caducar, las nuevas allocations fallan, así que nadie más entra, y los jugadores conectados se caen poco después.
   - (d) Cloudflare **rechaza `CreatePermission` hacia rangos BYOIP** de clientes de Cloudflare [DOC]. Un jugador cuyo ISP u hosting anuncie su prefijo vía Cloudflare (Magic Transit/BYOIP) no puede entrar.
   - (e) Bloqueos de IPs de Cloudflare a nivel de país o ISP: España con LaLiga (Movistar, O2, DIGI en días de partido) y el *throttling* de Cloudflare en Rusia.
   - (f) Timeouts del cliente oficial: 4 s, y 10 s en "reverse connection". La relay añade RTT y una ronda de `CreatePermission`.
3. **Por qué "el tráfico se enruta mal" [DOC]:**
   - La allocation se "homea" en el PoP de Cloudflare más cercano **al host** (el cliente TURN).
   - Los jugadores envían a una IP *anycast/soft-unicast*. Su tráfico entra por el PoP más cercano **al jugador** y viaja por el backbone de Cloudflare hasta el PoP del host. La vuelta sale del PoP del host hacia el jugador **por Internet público**. Cloudflare dice explícitamente que si solo un extremo usa TURN, ese tramo depende del interconexionado entre el peer y Cloudflare.
   - En LATAM muchos ISPs no intercambian tráfico localmente con Cloudflare y lo llevan a São Paulo o a Miami. El resultado son triángulos de decenas o centenares de ms frente a la ruta directa.
4. **Recomendación:**
   - Arreglar el punto 1 con nftables.
   - Credenciales frescas **por conexión** y una sola URL `turn:…:3478?transport=udp` (libjuice ignora TCP y TLS).
   - Medir en Analytics el `datacenterCode` donde caen las allocations.
   - Para salas LATAM con jugadores del mismo país, conviene más un relay propio en la misma ciudad, sobre hosting con filtrado DDoS y con el puerto TURN de control cerrado a todo excepto el host. Cloudflare queda como reserva, o para salas con público internacional.

---

## 1. Cómo funciona Cloudflare Realtime TURN (documentado)

### 1.1 Endpoints, puertos y protocolos
| Protocolo | Host | Puerto principal | Alternativo |
|---|---|---|---|
| STUN/UDP | stun.cloudflare.com | 3478/udp | — |
| TURN/UDP | turn.cloudflare.com | 3478/udp | 443/udp (antes 53/udp) |
| TURN/TCP | turn.cloudflare.com | 3478/tcp | 80/tcp |
| TURN/TLS | turn.cloudflare.com | 5349/tcp | 443/tcp |

- TLS 1.1, 1.2 y 1.3. Sin límite MTU específico. **Sin DTLS hacia el servidor TURN.**
  - Fuente: https://developers.cloudflare.com/realtime/turn/ y https://developers.cloudflare.com/realtime/turn/rfc-matrix/
- La API devuelve las seis URLs. La doc advierte que **el puerto alternativo 53 lo bloquean los navegadores**. Ese puerto aparecía en la entrada del blog de lanzamiento: https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc
- Dominios propios: se admiten por CNAME a `turn.cloudflare.com`, solo para UDP y TCP (no TLS). Si usas el DNS de Cloudflare, el registro va en "nube gris". Fuente: https://developers.cloudflare.com/realtime/turn/custom-domains/

### 1.2 Anycast y relayed address
- Los clientes TURN llegan a `turn.cloudflare.com` por **anycast** al PoP más cercano. Dentro del PoP, Unimog fija cada 5-tupla a un servidor.
- **La relayed address también es anycast, en la variante "soft-unicast"**. Si un paquete de un peer llega al PoP equivocado, "lo reenviamos por nuestro backbone al datacenter correcto en vez de devolverlo a Internet". Según Cloudflare, así los paquetes hacia la relay entran en su red lo más cerca posible del emisor. Fuente: https://blog.cloudflare.com/webrtc-turn-using-anycast/
- Soft-unicast funciona así: cada IP queda ligada lógicamente a un datacenter, y cada rango de puertos de esa IP a una máquina concreta. Unimog reenvía por backbone los paquetes que caen en otro PoP. Fuente: https://blog.cloudflare.com/cloudflare-servers-dont-own-ips-anymore/
  - **Implicación DDoS:** la IP relay es compartida por muchos clientes y se anuncia desde todos los PoPs. Un flood hacia ella se reparte por toda la red de Cloudflare.
- La FAQ dice: "Las allocations se homean en el datacenter disponible más cercano al cliente TURN vía anycast. Si **ambos** extremos usan Cloudflare TURN, Cloudflare puede controlar el enrutado y usar el backbone."
  - La FAQ también dice: "Si solo un peer usa TURN, el otro tramo atraviesa Internet público y la latencia/pérdida dependen del interconexionado entre ese peer y el datacenter Cloudflare más cercano."
  - Fuente: https://developers.cloudflare.com/realtime/turn/faq/
  - Nuestro caso es exactamente ese: solo usa TURN el host.

### 1.3 ¿Relaya hacia y desde peers que no usan Cloudflare? Sí, con restricciones [DOC]
- Es TURN estándar (RFC 5766/8656). Cualquier IP pública puede enviar a la relayed address si el cliente TURN hizo `CreatePermission` o `ChannelBind` para esa IP.
- **Se deniegan** `CreatePermission` y `ChannelBind` hacia:
  - rangos privados, loopback, link-local y multicast;
  - **IPs que forman parte de BYOIP** (prefijos de clientes que Cloudflare anuncia).
- **No hay relayed addresses IPv6.** Cloudflare ignora `REQUESTED-ADDRESS-FAMILY` y siempre da IPv4. El acceso cliente→servidor sí puede ir por IPv4 o IPv6.
- **No hay TCP relaying** (RFC 6062). El tramo peer↔relay es siempre UDP.
- Credenciales: TTL de hasta **48 h**. Si la credencial caduca con la allocation en uso, se deja de facturar y "tras un breve retraso se desconecta". Una allocation no tiene duración máxima mientras se refresque con una credencial válida.
- Mantenimiento o cambios de topología pueden romper allocations, y Cloudflare "recomienda mucho ICE restart". El cliente oficial de HaxBall no lo hace.

### 1.4 Límites
- Por allocation, no por cuenta [DOC]:
  - más de 5 IPs nuevas por segundo;
  - más de 5–10 kpps;
  - más de 50–100 Mbps.
  - Por encima de eso, Cloudflare descarta paquetes en silencio.
- **Límite no documentado:** un usuario reporta que **cada allocation solo intercambia datos con 10 direcciones de peer (IP:puerto) en toda su vida**. Los slots no se liberan al quedar inactivos, y el `ChannelBind` al 11.º peer falla con un 400. Es un issue abierto del 4-oct-2026, sin respuesta oficial: https://github.com/cloudflare/cloudflare-docs/issues/33972
  - Con una allocation por jugador, como hace haxlite (un PeerConnection por jugador), no debería afectar.
  - **Nunca compartir una allocation entre jugadores.**
- Emisión de credenciales: sin límite definido. Cloudflare sugiere empezar en 500/s.

### 1.5 API de credenciales
```bash
curl https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers \
  -H "Authorization: Bearer $TURN_KEY_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"ttl": 86400}'      # máx. 172800 (48 h)
```
- Hay una variante `.../credentials/generate` que acepta `customIdentifier`, útil para atribuir uso por sala.
- Revocación: `POST .../credentials/$USERNAME/revoke`.
- Hasta 1000 TURN keys por cuenta.
- Fuentes: https://developers.cloudflare.com/realtime/turn/generate-credentials/ y https://developers.cloudflare.com/realtime/turn/replacing-existing/

### 1.6 Precio (muy favorable en esta topología)
- 0,05 $/GB, con **1000 GB/mes gratis** (compartidos con el SFU).
- **Solo se factura lo que va del edge de Cloudflare al cliente TURN**, es decir, al host. Lo que la relay envía a los peers (los jugadores) "no forma parte de la facturación".
- En HaxBall eso significa que solo se paga el tráfico jugador→host (inputs, pequeño) más el overhead TURN. El tráfico grande, host→jugadores, es gratis.
- Fuentes: https://developers.cloudflare.com/realtime/turn/faq/ y https://developers.cloudflare.com/realtime/sfu/platform/pricing/

### 1.7 IPs publicadas para allowlist
- `141.101.90.1/32`, `162.159.207.1/32`, `2a06:98c1:3200::1/128`, `2606:4700:48::1/128`.
- Pueden cambiar. Cloudflare pide vigilar el DNS y actualizar en menos de 14 días.
- Las IPs de las relays no se publican.

### 1.8 Analytics
- La API GraphQL `callsTurnUsageAdaptiveGroups` tiene las dimensiones `datacenterCity`, `datacenterCode`, `datacenterCountry` y `customIdentifier`.
- **Con ella se ve en qué PoP se homean las allocations del host.**
- Fuente: https://developers.cloudflare.com/realtime/turn/analytics/

---

## 2. Lo que hace realmente nuestro stack (haxlite → node-datachannel → libdatachannel → libjuice)

Verificado en el código: `src/net/ice.ts`, `src/net/transport.ts`, y libdatachannel v0.24.5 (`src/impl/icetransport.cpp`, `src/impl/peerconnection.cpp`) con libjuice (`src/agent.c`, `src/agent.h`).

1. **libjuice solo soporta TURN por UDP.**
   - Las entradas `turn:...?transport=tcp` y `turns:` se descartan con el aviso "TURN transports TCP and TLS are not supported with libjuice".
   - Ofrecer TCP/TLS al host no aporta nada. La única salida sería compilar con el backend libnice.
2. **Como mucho 2 servidores TURN por PeerConnection** (`MAX_TURN_SERVERS_COUNT = 2`).
   - La lista de `iceServers` **se baraja al azar** (`std::shuffle`) antes de elegir.
   - Si se pasan las seis URLs de Cloudflare, cada conexión usa dos UDP al azar.
   - También se usa **un solo** servidor STUN, elegido al azar.
3. **Relay-only no es relay-only (bug):**
   - `PeerConnection::processLocalCandidate` solo filtra qué candidatos locales se anuncian.
   - `agent_add_candidate_pairs_for_remote` siempre añade el par `(local=NULL → socket directo, remote)` además de los pares relay.
   - Resultado: el host envía *connectivity checks* desde su IP:puerto real a cada candidato del jugador. Issues: https://github.com/paullouisageneau/libdatachannel/issues/1587 y https://github.com/paullouisageneau/libjuice/issues/345
4. **Permisos TURN:**
   - libjuice hace `CreatePermission` (y luego `ChannelBind`) solo para los destinos a los que envía, es decir, los **candidatos remotos conocidos**.
   - Los candidatos host del navegador son mDNS `.local` (no resolubles) o privados (Cloudflare los rechaza). En la práctica, **el único candidato útil del jugador es su srflx de Google STUN**.
   - Los pares relay solo se forman con candidatos de la misma familia. Como la relay es IPv4, un jugador sin srflx IPv4 no tiene ningún par relay posible.
5. Allocation con lifetime de 10 min, refrescada cada 9 min con la **misma** credencial.
   - Cuando se escribió esto, `iceServers` se resolvía una vez en el constructor (`transport.ts`) y no había forma de renovar credenciales sin reiniciar el transport. Hoy existe `HostTransport.setIceServers` / `room.haxlite.setIceServers` (con `ndc` solo las PeerConnections nuevas usan la lista nueva; con `rtc` el siguiente Allocate y los Refresh de la misma asignación).
6. haxlite envía la answer con el primer candidato permitido (como mucho `answerIceWaitMs` = 500 ms, igual que el oficial) y después hace *trickle* del candidato relay. Bien.
   - El cliente oficial da 4 s para conectar (10 s en "reverse connection", con 2,5 s de retraso al aplicar candidatos). Ver `docs/01-red-y-salas.md`.

---

## 3. Diagnóstico de los problemas del usuario con Cloudflare

### 3.1 "Demasiado estricto: algunos no pueden entrar"
| # | Causa | Tipo | Cómo comprobarlo |
|---|---|---|---|
| A | **El jugador no aporta un candidato IPv4 utilizable**. El STUN de Google falla (UDP 19302 bloqueado, Google STUN caído o filtrado) o solo se obtiene IPv6. El host no puede crear permiso, y Cloudflare descarta los checks del jugador porque vienen de una IP sin permiso. En modo directo esto se salvaba con peer-reflexive; con TURN no. | DOC (permisos RFC 8656, solo IPv4) + CÓDIGO | Loguear en haxlite los candidatos de cada oferta que falla. Patrón típico: 0 srflx, o solo srflx IPv6 |
| B | **La IP con la que el jugador llega a Cloudflare no coincide con su srflx de Google**: CGNAT móvil con pool de IPs no emparejado, multi-WAN, balanceadores, VPN de split-tunnel, WARP. El permiso queda en la IP equivocada. | INFERENCIA (RFC 4787 recomienda *paired pooling*, pero no todos los CGN lo cumplen) | Comparar el srflx anunciado con la IP de los paquetes que llegan (TURN `Data indication` / XOR-PEER-ADDRESS) en los logs de libjuice a nivel verbose |
| C | **Credenciales caducadas**: credencial fija con TTL de 24 h (el ejemplo de la doc) en una sala de larga duración. Pasado ese tiempo no se crean allocations nuevas, así que ningún jugador entra, y los conectados caen en el siguiente Refresh. | DOC + CÓDIGO | Logs de libjuice: "TURN allocation failed" o un 401 en Refresh. Hora del fallo frente a la hora de arranque más la TTL |
| D | **IP del jugador dentro de un prefijo BYOIP/Magic Transit de Cloudflare**: ISPs u hostings protegidos por Cloudflare, incluidas IPs de egreso corporativas. `CreatePermission` se rechaza. | DOC | Error en la respuesta a CreatePermission en el log. Comprobar el ASN del prefijo |
| E | **Bloqueo o degradación de IPs de Cloudflare en su país o ISP**: España en días de LaLiga (Movistar, O2, DIGI, con miles de IPs bloqueadas por jornada) y Rusia (*throttling* de Cloudflare desde junio de 2025). | DOC (prensa, OONI, Cloudflare) | Correlacionar los fallos con el país y el ISP del jugador (haxlite conoce su IP por `conn`) y con los horarios de partido |
| F | **Jugador IPv6-only (NAT64 sin CLAT, típico en iOS)**: no puede alcanzar una relay IPv4. | DOC (sin relay IPv6) + INFERENCIA | Candidatos del jugador solo IPv6 |
| G | **Timeout del cliente oficial (4 s)**: la ruta jugador→PoP→backbone→PoP del host→host añade RTT, y la primera ronda de `CreatePermission` también suma. | INFERENCIA | ¿Fallan más los jugadores lejanos? ¿Entran en el segundo intento ("reverse")? |
| H | Más de 10 direcciones de peer por allocation | Reporte no oficial | Solo afecta si se reutiliza una allocation entre jugadores (haxlite no lo hace) |

Lo que **no** explica fallos: los puertos o el protocolo del lado del jugador. Los jugadores ya usaban UDP hacia puertos altos del host. Si su red bloquea UDP, tampoco podían jugar antes, porque el cliente oficial no tiene TURN.

### 3.2 "El tráfico se enruta mal"
1. **Homing en el PoP del host.** Si el proveedor del VPS enruta `141.101.90.1` (o el IPv6 `2a06:98c1:3200::1`) hacia un PoP lejano, toda la sala hace un desvío hasta ese PoP. Es frecuente en LATAM, donde históricamente se ha enrutado vía Miami; Cloudflare lo explica en sus posts de Buenos Aires y Quito.
   - Ojo: el catchment IPv4 y el IPv6 pueden ser **distintos**. libjuice puede contactar el TURN por IPv6 si el host tiene IPv6.
2. **Entrada de cada jugador por "su" PoP.** Ese PoP depende de con quién intercambia tráfico su ISP, no de la geografía. Por ejemplo, un jugador argentino cuyo ISP lleva Cloudflare a São Paulo o a Miami, jugando contra un host en Buenos Aires: el camino es AR→GRU/MIA→backbone→EZE→host, frente a una ruta directa de pocos ms.
3. **Vuelta asimétrica.** La relay → jugador sale desde el PoP del host por Internet público. Cloudflare solo garantiza el backbone "si ambos extremos usan Cloudflare TURN" [DOC FAQ].
4. Además (bug de la sección 2.3), algunos jugadores van directos y otros por relay. La calidad es inconsistente y algunos ven la IP real.

Verificación recomendada:
- Consulta GraphQL de analytics agrupando por `datacenterCode`: debería salir **un solo** PoP, el más cercano al host.
- Desde el host: `mtr -u -P 3478 141.101.90.1` y `mtr 2a06:98c1:3200::1`.
- `curl https://www.cloudflare.com/cdn-cgi/trace` da la pista del colo HTTP, que no tiene por qué coincidir con el del TURN.
- Pedir a jugadores de cada país el `colo=` de `https://cloudflare.com/cdn-cgi/trace`. Es una aproximación de su PoP de entrada.

---

## 4. Configuración recomendada para "host relay-only, clientes directos" en Cloudflare

1. **Una sola URL TURN UDP**: `turn:turn.cloudflare.com:3478?transport=udp`.
   - Opcionalmente una segunda, `turn:turn.cloudflare.com:443?transport=udp`, como respaldo si el datacenter del host filtra el 3478/udp. libjuice admite como mucho 2.
   - **No incluir** las URLs TCP/TLS (libjuice las ignora), la de puerto 53 ni la de STUN. Un STUN solo sirve para generar candidatos srflx que de todas formas se filtran.
   - Ambas URLs acaban en el mismo PoP y dan dos relay candidates casi idénticos. No hay ganancia de diversidad de ruta.
2. **Credenciales por conexión.** (Resuelto en parte: ya existe `setIceServers` en caliente; sigue sin existir una función por conexión.) Cuando se redactó hacía falta un cambio en haxlite: que `iceServers` acepte una función que se llama en `negotiate()` (async o cacheada).
   - Generar credenciales con `ttl` de 172800 s (máximo) y renovar la caché cada 1–6 h.
   - Así cada allocation tiene al menos ~42 h de vida y nunca se reutiliza una credencial caducada.
   - Etiquetar con `customIdentifier = <sala>` para ver uso y PoP por sala.
   - Alternativa sin reiniciar: llamar a `setIceServers` con credenciales nuevas antes de que caduquen (docs/10 §2.2 da el ejemplo de renovación a mitad de TTL).
3. **Forzar IPv4 en el tramo host→TURN** si el catchment IPv6 es peor: `rtc.bindAddress = '<IPv4 del host>'`, o deshabilitar IPv6 en el host o en su namespace.
4. **Cerrar el bug de relay-only a nivel de sistema** (sección 5.3). Es imprescindible.
5. **No hay ICE restart con el cliente oficial.** Si Cloudflare reubica una allocation (mantenimiento o cambio de rutas), el jugador cae y tiene que reentrar. Esto es aceptable, pero conviene que la sala tolere reconexiones (por ejemplo, conservar el equipo y el puesto unos segundos).
6. **Diagnóstico.** Loguear por jugador que falle:
   - nº de candidatos y tipos/familias (`srflx` v4/v6, mDNS);
   - país/ASN de la IP de `conn`;
   - si entró en el intento "reverse".
   Con eso se separan las causas A–G.
7. **Opcional, por jugador** (la IP se conoce por `conn` antes de negociar): elegir `iceServers` según la geografía del jugador. Por ejemplo, relay propia en la ciudad del host para jugadores del mismo país y Cloudflare para el resto. Requiere el mismo cambio que el punto 2.

---

## 5. TURN propio: por qué caen y cómo endurecerlo

### 5.1 Por qué caen
- El atacante conoce la **IP de la relay**, porque aparece como candidato `typ relay` en el SDP o en `chrome://webrtc-internals`.
- Con un VPS normal, un flood volumétrico UDP (reflexión DNS/NTP/CLDAP/memcached o botnet directa) **satura el enlace**, de 1–10 Gbps, antes de que coturn vea nada. **Ninguna opción de coturn protege contra eso.** El proveedor suele hacer null-route de la IP, y con ella cae la sala.
- Ataques a nivel de protocolo:
  - floods de Allocate o 401 al 3478 (amplificación por reflexión);
  - agotamiento de cuotas o puertos;
  - floods a los puertos de relay que coturn procesa en userspace (mucha CPU por paquete).

### 5.2 Endurecimiento de coturn (específico de esta topología)
La clave es que **el único cliente TURN es el host**. Los jugadores solo tocan los puertos de relay. Fuente: https://www.enablesecurity.com/blog/coturn-security-configuration-guide/ y https://github.com/coturn/coturn

```ini
# Escuchar el control TURN solo para el host (además, firewall: 3478/5349 permitidos SOLO desde la IP del host)
listening-ip=<IP_privada_o_pública>
relay-ip=<IP_pública_relay>          # varias relay-ip/instancias = pool para rotar
external-ip=<IP_pública>[/<IP_privada>]   # solo si está detrás de NAT 1:1
min-port=49152
max-port=65535                        # o un rango corto, p.ej. 50000-50999, para filtrar fácil upstream
use-auth-secret
static-auth-secret=<secreto>          # credenciales efímeras generadas por el host
realm=t                               # 401 más pequeño
no-tcp-relay                          # WebRTC solo necesita UDP
no-multicast-peers
no-rfc5780
no-software-attribute
no-cli
unauthorized-ratelimit                # >= 4.14
user-quota=40                         # ~máx. jugadores por sala (+margen)
total-quota=200
max-bps=125000                        # ~1 Mbps por sesión; HaxBall usa mucho menos
bps-capacity=<tu enlace en B/s>
stale-nonce=600
# denied-peer-ip para 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 198.18/15,
# 224/4, 240/4, ::1, fc00::/7, fe80::/10, ::ffff:0:0/96 (CVE-2026-27624), 64:ff9b::/96 …
```
- Usar coturn **4.17.2 o posterior** (o 4.18), por los bypass de cuotas y ACL corregidos. Alternativas: eturnal, o Violet (del autor de libjuice).
- Escalar `user-quota` y `total-quota` según el número de salas: cada jugador es una allocation, igual que en Cloudflare.
- **Firewall en la caja TURN:**
  - 3478 y 5349 cerrados a todo excepto la IP del host.
  - Relay range abierta solo a UDP.
  - Extra: un **nftables set** con las IPs de los jugadores en sala, que haxlite conoce por `conn`, con `drop` del resto en el rango de relay. Así se tira en el kernel o XDP lo que no viene de jugadores.
  - Descartar puertos de origen típicos de reflexión: 53, 123, 389, 1900, 11211, 19, 161 y 3702.
  - Descartar payloads que no sean STUN (primer byte 0–3), DTLS (20–63) o ChannelData. Ojo: hacia el *peer side* solo llega STUN o DTLS del navegador.
- **Rotación y atribución:** varias IPs de relay (una instancia o un `relay-ip` por IP) y asignar al jugador N una relay concreta. Si se ataca una IP:
  - se sabe a qué jugadores se les mostró;
  - los nuevos jugadores van a otra IP;
  - los ya conectados caen (no hay ICE restart) y reentran por otra IP.
- **Hosting:** la caja TURN tiene que estar en una red con **filtrado DDoS UDP aguas arriba**. La configuración de coturn no basta. Opciones:
  - Gcore DDoS Protection para servidores: centros de limpieza en São Paulo con IX.br, y presencia en Buenos Aires, Santiago y Bogotá según terceros. https://gcore.com/ddos-protection/servers
  - Hostings "game anti-DDoS" con reglas UDP personalizables (OVH Game, Path.net y similares). Validar en LATAM: OVH no tiene datacenters ahí.
  - Proveedores locales de São Paulo con mitigación (por ejemplo HypeHost, según su propia publicidad).
  - Lo importante es que permitan **reglas stateless por puerto o rango y por patrón de payload**, y que no hagan null-route.
- Alternativa sin TURN (fuera del alcance de este informe, pero equivalente para ocultar la IP): un VPS protegido en la ciudad del host que hace DNAT/WireGuard del rango UDP de ICE hacia el host oculto. haxlite anuncia la IP del frontal. Ahorra la doble encapsulación TURN y no tiene límites de proveedor.

### 5.3 Arreglo inmediato del bug relay-only (en el host, con Cloudflare o con TURN propio)
haxlite ya permite `portRange`, y libjuice usa **un solo socket UDP por agente** para STUN, TURN y checks. Basta con dejar salir ese rango de puertos solo hacia los servidores TURN:
```nft
table inet haxhost {
  set turn4 { type ipv4_addr; flags interval; elements = { 141.101.90.1, 162.159.207.0/24 } }   # o la IP de tu relay
  set turn6 { type ipv6_addr; flags interval; elements = { 2a06:98c1:3200::1, 2606:4700:48::1 } }
  chain out {
    type filter hook output priority 0; policy accept;
    udp sport 40000-40999 ip  daddr @turn4 accept
    udp sport 40000-40999 ip6 daddr @turn6 accept
    udp sport 40000-40999 drop          # checks directos de libjuice → nunca salen
  }
  chain in {
    type filter hook input priority 0; policy accept;
    udp dport 40000-40999 ip  saddr @turn4 accept
    udp dport 40000-40999 ip6 saddr @turn6 accept
    udp dport 40000-40999 drop
  }
}
```
- Configuración en haxlite: `portRange: [40000, 40999]` y `rtc: { iceTransportPolicy: 'relay' }`.
- **El rango tiene que quedar fuera de los puertos efímeros del kernel.** Las reglas `drop` valen para cualquier proceso del host, no solo para haxlite: 40000-40999 cae dentro de `net.ipv4.ip_local_port_range` (32768-60999 por defecto) y el ~3,5 % de los sockets UDP sin puerto fijo (resolver DNS, NTP, QUIC) quedaría sin poder enviar (`EPERM`) ni recibir respuestas. Reserva el rango, de forma persistente (`/etc/sysctl.d/`): `sysctl -w net.ipv4.ip_local_reserved_ports=40000-40999`. Solo excluye el rango del puerto automático (IPv4 e IPv6): haxlite ata sus puertos de forma explícita y no se ve afectado. Alternativa: mover `portRange` y las reglas fuera de `ip_local_port_range`.
- `flags interval` es obligatorio en cuanto un set lleve prefijos (`/24`): sin él `nft` rechaza el archivo entero y no se instala nada. Comprueba el código de salida de `nft -f` y el resultado de `nft list table inet haxhost`. La versión de `ops/haxguard/relay-only.nft` además se puede recargar sin duplicar reglas; úsala en vez de copiar este bloque.
- Vigilar los A/AAAA de `turn.cloudflare.com` y actualizar los sets: Cloudflare exige hacerlo en menos de 14 días si cambian.
- Esto hace que el único camino posible sea la relay, y que la IP real nunca llegue a un jugador.

---

## 6. Comparativa de proveedores TURN gestionados (para "solo el host usa TURN")

| Proveedor | Tipo de relayed address | PoPs LATAM | Precio | DDoS | Notas para HaxBall |
|---|---|---|---|---|---|
| **Cloudflare Realtime TURN** | **Anycast/soft-unicast compartida** por muchos clientes. Un ataque a la IP lo absorbe toda la red | 57 ciudades LATAM/MX/CA en la red (Brasil 31; AR: Buenos Aires, Córdoba, Neuquén; CL 4; CO 4; PE: Lima; MX: CDMX, Guadalajara, Querétaro). No hay garantía documentada de que el TURN corra en todos | 0,05 $/GB **solo Cloudflare→host**, 1 TB/mes gratis. Host→jugadores gratis | Red Cloudflare. La relay no es atacable de forma aislada | Solo relay IPv4 y UDP; credencial ≤48 h; se homea en el PoP del host; ruta mala si el ISP del jugador no intercambia tráfico localmente; denegación de BYOIP; límite de 10 peers reportado |
| **Twilio NTS** | Unicast AWS por región (rangos publicados; puertos relay 10000–60000/udp). `global.turn.twilio.com` por geo-DNS | **Solo São Paulo** (9 regiones en total) | 0,40 $/GB (US/EU), 0,60 (Asia), **0,80 $/GB São Paulo** | Sin promesa específica (AWS) | Token ≤24 h. La IP relay es de una región concreta: ataque localizado. https://www.twilio.com/en-us/stun-turn/pricing · https://www.twilio.com/docs/stun-turn/regions |
| **Xirsys** | Unicast por región, geo-routing | São Paulo (12 regiones) | 39 $/50 GB … 499 $/2 TB; excedente 0,50–0,09 $/GB | Sin afirmaciones | Credenciales estáticas o API; ofrece "private cloud". https://xirsys.com/pricing/ |
| **Metered.ca** | Unicast por región (`global.relay.metered.ca` + regionales) | La web de marketing cita São Paulo; la API de regiones no tiene ninguna de Sudamérica | 99 $/150 GB … 499 $/2 TB; excedente 0,40–0,10 $/GB; **cuenta entrada+salida** | Sin afirmaciones | Dice tener backbone privado (sin verificar). https://www.metered.ca/stun-turn |
| **ExpressTURN** | Unicast (servidores propios) | São Paulo (18 ubicaciones) | Gratis 1000 GB/mes; Premium 9 $/mes por 5000 GB | Sin afirmaciones | Proveedor pequeño: un DDoS a "tu" relay afecta a sus otros clientes, con riesgo de que te echen. https://www.expressturn.com/ |
| **turnix.io** | Unicast, GeoIP | **México y Brasil** (9 regiones) | 30 $/40 GB … 450 $/2 TB; excedente 0,40–0,07 $/GB | Sin afirmaciones | https://turnix.io/ |
| **Gcore** | — (no encontré TURN gestionado) | Limpieza en São Paulo; presencia en BA, SCL y BOG (según terceros) | — | Sí (servidores y juegos) | Sirve como **hosting protegido para TURN o proxy propio** |
| **Vonage / otros CPaaS** | TURN incluido en sus SDK de vídeo, no como servicio suelto | — | — | — | No aplica (no verificado en detalle) |

Conclusión de la comparativa:
- **Ninguno ofrece relays en Argentina, Chile, Perú o Colombia**, salvo Cloudflare, que es anycast y depende del peering.
- En DDoS, **Cloudflare es el único donde atacar la relay equivale a atacar Cloudflare**. Los demás exponen IPs unicast regionales y no publican garantías anti-DDoS.
- Para una sala argentina con jugadores argentinos, cualquier proveedor con relay en São Paulo añade unos 30–40 ms por sentido frente a una ruta local. Si el ISP del jugador lleva a Cloudflare por Miami, Cloudflare puede ser peor.
- Por eso la opción robusta en LATAM es **una relay o proxy propio en la ciudad del host sobre red con mitigación**, con Cloudflare como plan B o para jugadores lejanos.

---

## 7. Mediciones desde este contenedor

**[MEDIDO] DNS** (resolver 8.8.8.8 y DoH 1.1.1.1):
- `turn.cloudflare.com` → A `141.101.90.1` (TTL ~37 000 s) y AAAA `2a06:98c1:3200::1`.
- `stun.cloudflare.com` → A `162.159.207.0` y AAAA `2606:4700:49::`.

**[MEDIDO] Origen (RIPEstat):**
- `141.101.90.0/24` → AS13335 (Cloudflare).
- `162.159.207.0/24` → AS13335.
- Esto coincide con la lista de allowlist de la FAQ: 141.101.90.1, 162.159.207.1 y los dos IPv6.

**[MEDIDO] Puertos** (script propio con STUN Binding y Allocate sin auth, `scratchpad/ipresearch/stunprobe.py`):
- **Todo UDP sin respuesta**, incluido Google STUN 19302: el contenedor no tiene salida UDP.
- TCP 3478 y TLS 5349: timeout.
- TCP 80 y 443 responden con "HT…" (HTTP), es decir, **los intercepta el proxy del entorno** y no Cloudflare.
- **No se puede medir alcanzabilidad real ni catchment desde aquí.** Hay que repetirlo desde el host de producción, por ejemplo con `python3 stunprobe.py` y `mtr`.

---

## 8. Fuentes principales
- Cloudflare TURN (overview, puertos, límites): https://developers.cloudflare.com/realtime/turn/
- FAQ (homing, backbone, IPv6, BYOIP, TTL 48 h, IPs): https://developers.cloudflare.com/realtime/turn/faq/
- Generar credenciales: https://developers.cloudflare.com/realtime/turn/generate-credentials/
- Matriz RFC: https://developers.cloudflare.com/realtime/turn/rfc-matrix/
- Dominios propios: https://developers.cloudflare.com/realtime/turn/custom-domains/
- Analytics: https://developers.cloudflare.com/realtime/turn/analytics/
- Precios: https://developers.cloudflare.com/realtime/sfu/platform/pricing/
- Blog, TURN y anycast (relay anycast con reenvío por backbone): https://blog.cloudflare.com/webrtc-turn-using-anycast/
- Blog, soft-unicast: https://blog.cloudflare.com/cloudflare-servers-dont-own-ips-anymore/
- Blog, Calls anycast (puertos alternativos, incluido el 53): https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc
- Límite de 10 peers (no oficial): https://github.com/cloudflare/cloudflare-docs/issues/33972
- Firefox y CreatePermission sin ERROR-CODE (afecta a clientes TURN Firefox, no a nuestro caso): https://community.cloudflare.com/t/bug-firefox-fails-using-turn-service/713305
- Bug relay-only libdatachannel/libjuice: https://github.com/paullouisageneau/libdatachannel/issues/1587 · https://github.com/paullouisageneau/libjuice/issues/345
- libjuice (solo UDP): https://github.com/paullouisageneau/libjuice
- Red Cloudflare: https://www.cloudflare.com/network/
- Peering en LATAM: https://blog.cloudflare.com/buenos-aires/ · https://blog.cloudflare.com/quito-data-center
- LaLiga/España: https://www.euronews.com/2026/09/18/in-spain-football-matches-knock-thousands-of-websites-and-services-offline · https://www.laliga.com/en-AR/news/official-statement-in-relation-to-the-blocking-of-ips-during-the-recent-ea-sports-laliga-matchdays-linked-to-illegal-cloudflare-practices
- Rusia: https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/service-disruption · https://en.zona.media/article/2025/06/27/cloud_confirmed
- Twilio: https://www.twilio.com/en-us/stun-turn/pricing · https://www.twilio.com/docs/stun-turn/regions · https://www.twilio.com/docs/stun-turn/api
- Xirsys: https://xirsys.com/pricing/ · Metered: https://www.metered.ca/stun-turn · https://metered.ca/pricing · ExpressTURN: https://www.expressturn.com/ · turnix: https://turnix.io/
- Gcore: https://gcore.com/ddos-protection/servers · https://gcore.com/ddos-protection-for-game-servers/
- coturn hardening: https://www.enablesecurity.com/blog/coturn-security-configuration-guide/
