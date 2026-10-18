# 08 — Ocultar y proteger la IP del host de una sala

Este informe resume 4 investigaciones. Los detalles y las fuentes están en `docs/ip/`:

- [01 — Por dónde se filtra la IP](ip/01-exposicion-ip.md)
- [02 — Cloudflare TURN y TURN gestionado](ip/02-turn.md)
- [03 — Hosting anti-DDoS y filtrado en el host](ip/03-ddos-hosting.md) (incompleto; sus conclusiones están aquí)
- [04 — Atribución y control del reveal](ip/04-atribucion-y-gating.md)

Las configuraciones de ejemplo están en [`ops/haxguard/`](../ops/haxguard).

## 0. La regla física

Un jugador **siempre** puede ver la dirección a la que envía sus paquetes UDP. Ningún software lo impide. Solo se puede decidir cuatro cosas:

1. **Qué dirección es:** la del host o la de algo delante (relay o proxy).
2. **Si aguanta un ataque:** mitigación del proveedor y filtrado en el host.
3. **Quién la recibe y cuándo:** filtros antes de revelarla.
4. **Si se puede saber quién la filtró:** una dirección distinta por jugador.

Un **dominio no sirve.** La RFC 8839 manda a los navegadores ignorar los candidatos ICE con nombre de dominio. Si alguno lo resuelve, se conecta a la IP y esta se ve igual. Además, el proxy normal de Cloudflare (la nube naranja) solo transporta HTTP(S): el UDP de WebRTC no pasa. Para UDP hace falta Spectrum, que es Enterprise.

## 1. Diagnóstico probable de los ataques que siguen llegando

| Síntoma | Causa más probable | Evidencia |
|---|---|---|
| Atacan aunque haya TURN o Cloudflare delante | **La IP real seguía saliendo.** Hay dos maneras: (a) sin `iceTransportPolicy: 'relay'` el host anuncia y envía desde su IP real; (b) con libdatachannel/libjuice (node-datachannel, el que usan **node-haxball** y haxlite), `relay` **no es relay-only**: libjuice manda *connectivity checks* directos desde la IP real a cada candidato del jugador. Es un bug abierto: libdatachannel#1587, libjuice#345 | ip/02 §2, §5.3; ip/01 §3 |
| Cloudflare TURN "no deja entrar a algunos" | Cloudflare solo asigna relayed addresses **IPv4** (los jugadores solo IPv6 o con NAT64 no pueden emparejarse); las credenciales caducan (máx. 48 h) y con `ndc` haxlite las usa tal como las recibió al arrancar (hoy hay `setIceServers` para renovarlas); el STUN de Google del jugador falla; hay IPs de Cloudflare bloqueadas en algunos países; el timeout del cliente oficial es de 4 s | ip/02 §3 |
| Cloudflare TURN "enruta mal" | La allocation se ancla en el PoP más cercano al host. La vuelta relay → jugador sale por Internet público, porque el backbone solo se garantiza si ambos extremos usan TURN de Cloudflare. En LATAM muchos ISP entran a Cloudflare por São Paulo o Miami, con rutas triangulares | ip/02 §3 |
| Los TURN propios caen | Floods volumétricos que saturan el enlace del VPS antes de que coturn vea nada. Ninguna opción de coturn evita eso | ip/02 §5.1 |

**Arreglo inmediato si usás relay** (Cloudflare o propio) con node-haxball o haxlite: fijá el rango de puertos y bloqueá, a nivel de sistema, todo UDP de ese rango que no vaya al TURN. Así la relay es el único camino posible. Configuración: [`ops/haxguard/relay-only.nft`](../ops/haxguard/relay-only.nft), y en haxlite `portRange: [40000, 40999]` + `rtc: { iceTransportPolicy: 'relay' }`.

> Con el host oficial en Chrome (navegador), `relay` sí es estricto. El bug es de libjuice.

> **Con `peerBackend: 'rtc'` (haxlite-rtc) esto ya no aplica.** El bug y las limitaciones de arriba son de `ndc` (libdatachannel/libjuice). Con `rtc` el cliente TURN es propio y corre dentro del proceso ([docs/10 §2.2](10-haxlite-rtc.md)): con `rtc: { iceTransportPolicy: 'relay' }` no se crean pares directos, la IP del host no aparece en el SDP y lo que llegue directo de un jugador no se contesta (`rtcStats().directDropped`); las credenciales caducables se renuevan en caliente con `room.haxlite.setIceServers(lista)` (en `ndc` también existe, pero solo afecta a las PeerConnections nuevas); si el Allocate no contesta se prueba al instante el siguiente servidor de la lista (p. ej. el puerto 53 de Cloudflare tras el 3478); y las asignaciones se reparten para no topar con el límite de ~10 pares de Cloudflare. Siguen valiendo la regla física (§0), solo UDP/IPv4 hacia el relay y las demás causas de la tabla (IPv4 del jugador, rutas, BYOIP). El firewall de salida de `relay-only.nft` sigue siendo una defensa en profundidad razonable, pero con `rtc` ya no es el único freno al bug.

## 2. Qué ya hace haxlite y qué no se puede tapar

- **Ya se limpia** (`iceCandidatePolicy: 'public'`, activo por defecto): candidatos LAN, loopback y mDNS, `raddr`/`rport`, y las líneas `c=`/`m=` del SDP.
- **No se puede tapar:** el candidato público (srflx), la dirección de origen de los checks ICE (el cliente la aprende como *peer-reflexive*) y lo que ve el sistema operativo del jugador (Wireshark, `netstat`). DTLS y SCTP no llevan IPs.
- **Momento del reveal:** la IP sale en el *answer*, **después** de comprobar versión, sala llena, contraseña, bans por IP y `onJoinRequest`, pero **antes** de verificar el auth. El auth se firma por el data channel, que solo existe después de ICE. Nada en la oferta está firmado. Lo único secreto que llega antes de ICE es la **contraseña**.
- **No hay cambio de IP a mitad de partida:** el cliente oficial cierra la señalización al abrir el canal y no admite renegociación ni ICE restart.

## 3. Opciones, ordenadas por relación beneficio/costo

### Nivel 1: sin infraestructura extra

1. **Cerrar la fuga de relay-only** (sección 1) si ya usás TURN. Es lo más urgente.
2. **Firewall en el kernel controlado por haxlite** ([`ops/haxguard/haxguard.nft`](../ops/haxguard/haxguard.nft), borrador XDP en `haxguard_xdp.c`). En el hook *ingress*, para los puertos de las salas, aplica en orden:
   1. descarta fragmentos, IPs baneadas, puertos de origen < 1024 y reflectores conocidos;
   2. acepta jugadores conectados (con un tope de pps por IP) y los que están entrando (20 s);
   3. acepta STUN de desconocidos con límite por origen y global;
   4. descarta todo lo demás.

   Se probó en loopback: la entrada sigue funcionando y las IPs baneadas no conectan. **Protege la CPU y aguanta floods que no saturan el enlace.** Si el ataque llena el enlace, no sirve: ahí solo ayuda el proveedor.
   - Le falta a haxlite: eventos `onPeerPending` / `onPeerAddress` / `onPeerGone` (node-datachannel ya expone `getSelectedCandidatePair()`) y un *sidecar* con privilegios que actualice los sets.
3. **Una dirección distinta por jugador ("canary").** Con `bindAddress` y el puerto por PeerConnection (`rtc: { enableIceUdpMux: false }`: desde la pasada de ligereza haxlite usa el mux UDP por defecto, un puerto para todos), cada jugador recibe su propia dirección:puerto. Se probó con 8 sesiones simultáneas en 8 direcciones.
   - Con un **/64 de IPv6**, cada jugador tiene una /128 propia. Si atacan esa dirección, se sabe **quién la filtró**: se banea su auth/IP y se descarta la dirección sin afectar al resto.
   - IPv6 disponible por país (APNIC): UY 61 %, BR 59 %, MX 58 %, PE 35 %, AR 34 %, CL 23 %, CO 22 %. Los jugadores que solo tienen IPv4 comparten la IPv4.
   - Los booters suelen atacar la IP entera, así que **la atribución por puerto solo atrapa a los ingenuos**; por dirección IPv6 es robusta. Un ataque contra todo el /64 sigue saturando el enlace.
4. **Controlar a quién se le revela:**
   - **Modo lockdown** durante un ataque: solo reciben el *answer* las IPs con buen historial IP↔auth.
   - Contraseñas por jugador o rotativas, distribuidas por Discord.
   - Captcha adaptativo.
   - Reputación ASN offline (GeoLite2) para VPN y datacenters.
   - Límite de entradas por IP.

### Nivel 2: elegir bien dónde hostear (sin componentes extra)

La mitigación tiene que estar **aguas arriba**, sobre la IP del propio servidor. Los datos recogidos (precios y capacidades aproximados; verificar antes de contratar):

| Proveedor | Lo relevante | LATAM |
|---|---|---|
| Vultr | Complemento DDoS a 10 USD/mes, 10 Gbps, reactivo (unos 60 s) | São Paulo, Santiago, CDMX |
| Gcore | Básico gratis; avanzado siempre activo, a cotizar | São Paulo |
| Oracle Cloud | L3/L4 incluido sin costo | São Paulo, Santiago, Querétaro… |
| AWS | Shield Standard gratis (reflexión UDP); Advanced unos 3000 USD/mes | São Paulo |
| OVH | Muy buena mitigación y *Edge Firewall* con API (20 reglas/IP, solo IPv4) | **No hay DC en LATAM** |
| Path.net | Filtros STUN/DTLS, red anycast | Verificar |

Complementos:
- **IP desechable:** IPs flotantes o reservadas (Hetzner unos 3 €/mes, Vultr 3 USD/mes, DigitalOcean gratis mientras esté asignada). Si atacan, se recrea la sala en otra IP.
- **Una sala por IP:** un ataque tira una sola sala.

### Nivel 3: algo delante (si los niveles 1–2 no alcanzan)

> **Implementado:** [haxlite Edge (doc 09)](09-haxlite-edge.md). Un gateway WebRTC en un
> servidor protegido termina las conexiones de los jugadores; el host solo abre un túnel
> saliente hacia él y nunca habla con los jugadores. Funciona con el cliente oficial y no
> depende de TURN ni del bug de relay-only de libjuice.

- **Proxy UDP tipo NAT** en la misma ciudad, sobre hosting protegido. Funciona con el cliente oficial: se simuló un proxy por flujo con 3 clientes y DTLS/SCTP funcionaron. Es más simple que TURN, pero exige que el host **nunca** envíe directo (firewall de salida) y una IP de origen que nunca se haya expuesto.
- **TURN propio endurecido:** el puerto 3478 cerrado a todo salvo el host, `no-tcp-relay`, cuotas, coturn ≥ 4.17.2 y hosting con filtrado aguas arriba.
- **Cloudflare Spectrum UDP o Magic Transit:** oculta el origen y absorbe el ataque, pero es Enterprise. Hay que desactivar los encabezados Proxy Protocol (SPP/PROXY v2) porque rompen STUN/DTLS.
- **Cloudflare TURN bien configurado:**
  - una sola URL `turn:turn.cloudflare.com:3478?transport=udp`;
  - credenciales por conexión (pendiente en haxlite: `iceServers` como función);
  - la fuga de relay-only cerrada.

  Sigue con las limitaciones de solo IPv4 y rutas asimétricas.

## 4. Plan recomendado

1. **Hoy:** si usás relay, aplicá [`relay-only.nft`](../ops/haxguard/relay-only.nft) con `portRange` fijo. Verificá con `chrome://webrtc-internals`, desde una conexión con IP pública, que el par elegido sea `relay` y que nunca aparezca tu IP.
2. **Hosting:** salas en un proveedor con mitigación en LATAM (Vultr, Gcore u Oracle en São Paulo o Santiago) y una sala por IP, con IPs reservadas para rotar.
3. **haxlite:**
   - eventos de dirección de peer, sidecar nftables (`haxguard`) y modo lockdown;
   - `iceServers` como función (credenciales TURN por conexión y TURN por región).
4. **Atribución:** direcciones IPv6 por jugador con contadores por dirección y ban automático del que filtró.
5. **A largo plazo:** si se hace un juego propio, la solución de fondo es cliente → relays de borde con tickets firmados → servidor oculto (el modelo de Steam Datagram Relay). Eso solo es posible controlando el cliente.

## 5. Pendiente de verificar en producción

- El contenedor de investigación **no tiene salida UDP ni IPv6**. Quedan por probar desde un servidor real:
  - la alcanzabilidad de Cloudflare TURN;
  - candidatos IPv6 con Chrome real;
  - el *fallback* de IPv6 a IPv4 del canary;
  - el tratamiento de candidatos FQDN en Firefox.
- El programa XDP compila pero **no pasó por el verifier** del kernel.
- El bug de relay-only de libjuice se identificó en el código y en issues abiertos. **Falta reproducirlo** con un TURN real.
