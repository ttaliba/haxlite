> **Nota:** este informe quedó incompleto (la redacción se interrumpió a mitad de la tabla de proveedores). Las conclusiones faltantes están resumidas en [`../08-ocultar-ip.md`](../08-ocultar-ip.md).

# 03: Hosting anti-DDoS, filtrado en el host guiado por haxlite y agilidad de IP

> Alcance: defensa de servidores propios que alojan salas HaxBall con **haxlite**
> (`feat/haxlite`, `src/net/transport.ts`, `src/net/ice.ts`, node-datachannel 0.33.4 / libdatachannel).
> En HaxBall cada cliente abre WebRTC (ICE/STUN + DTLS + SCTP sobre UDP) directamente contra el host,
> así que **cualquiera que entra a la sala conoce la IP:puerto del host**. Es una propiedad del
> protocolo, no un bug, y ningún hosting la elimina. Lo que sí podemos hacer es (a) que la red
> absorba el volumen, (b) que el host descarte en el kernel todo lo que no venga de un jugador y
> (c) que perder una IP salga barato.
> Informes hermanos en el mismo directorio: `01-exposicion-ip.md` (por dónde se filtra la IP; dominio
> y Cloudflare como "NAT"; IPv6 por jugador) y `04-atribucion-y-gating.md` (canary addressing, gating).
> Fecha de la investigación: 2026-10-10. Los precios y capacidades son orientativos: hay que
> **verificarlos** con cada proveedor antes de contratar.

---

## 0. Resumen ejecutivo

1. **Ningún filtro en el host aguanta un ataque volumétrico que llena el enlace.** Un VPS de
   1–10 Gbps se satura con un booter normal. Hace falta mitigación *upstream* sobre la propia IP
   (OVH VAC/Game, Gcore Advanced, Path.net, Vultr DDoS, Oracle, AWS Shield, Cloudflare Magic
   Transit). Eso es scrubbing en la red del proveedor, no un relay: la IP no cambia.
2. **Los scrubbers genéricos no saben qué es WebRTC.** Ninguno de los proveedores revisados tiene un
   perfil "WebRTC/HaxBall". OVH Game sólo ofrece el perfil "Other", que según OVH aporta poca
   seguridad. Path anuncia filtros STUN y DTLS por separado, pero WebRTC mezcla los dos en el mismo
   puerto (RFC 7983) y no está verificado que combinen. Contra un *UDP flood "bypass"* (payload que
   imita tráfico legítimo dirigido al puerto de la sala) el scrubber no distingue, y ahí la **allowlist
   por jugador es la defensa decisiva**.
3. **haxlite sabe exactamente quién es legítimo.** Antes de crear el PeerConnection conoce la IP que
   vio el master y las IPs srflx/relay de la oferta. Con ICE conectado, `pc.getSelectedCandidatePair()`
   le da la IP:puerto exacta del jugador. **Lo comprobé en node-datachannel 0.33.4, con y sin UDP mux.**
   Diseño propuesto: un set de nftables (o mapa XDP) que en *ingress* descarta todo el UDP dirigido a
   los puertos de sala salvo `active` (jugadores), `pending` (IPs de ofertas en curso, 20 s) y STUN de
   desconocidos con límite de tasa. **El script nftables está validado y probado en loopback:** con la
   IP en `pending` el canal abre en unos 60 ms; si se promueve en `ICE connected` hay ~1 s extra por
   retransmisión DTLS; con la IP baneada no conecta.
4. **Es útil contra:** floods por debajo de la capacidad del enlace, floods "bypass" que pasan el
   scrubber, agotamiento de CPU de Node/libjuice (STUN con HMAC, DTLS), amplificación (puerto origen
   < 1024 o puertos de reflectores conocidos), fragmentos y un jugador malicioso (tope de pps por IP
   y luego `deny`). **No sirve contra:** la saturación del enlace. Para eso hace falta upstream.
5. **Allowlist upstream programable:** OVH Edge Network Firewall admite 20 reglas por IP (sólo IPv4,
   stateless), así que vale para reglas gruesas (puertos de sala, puertos de origen de reflectores,
   fragmentos) y no para una lista por jugador. Las que sí dan para una lista dinámica son: los
   *cloud firewalls* que se aplican fuera de la VM (AWS Security Groups hasta ~1000 reglas, GCP
   network edge policies con Cloud Armor Enterprise), y sobre todo **Cloudflare Magic Transit +
   Programmable Flow Protection** (eBPF propio en el edge de Cloudflare; beta, Enterprise, requiere
   un /24 propio).
6. **Agilidad de IP:** las IPs flotantes o reservadas cuestan entre 0,5 y 5 US$/mes y se reasignan por
   API en segundos. Rotar no impide que el atacante vuelva a entrar y aprenda la IP nueva; lo que
   sirve es **aislar** (una sala o cohorte por IP, de modo que un null-route sólo tumba eso) y
   **atribuir** (si a cada cohorte se le enseña una IP distinta, la IP atacada delata quién la
   filtró; ver 04-…).
7. **Cloudflare Spectrum (petición nueva del usuario):** técnicamente funciona con WebRTC sin
   cambiar el cliente. **Lo simulé con un proxy UDP por flujo:** 3 clientes conectan, el host ve a
   cada uno como `prflx` con un puerto distinto y DTLS y SCTP pasan. Pero exige **Enterprise más el
   add-on Spectrum** (un precio citado en la comunidad es ~10 000 US$/mes, sin verificar), **no hay
   que activar** SPP/PROXY v2 (rompen STUN y DTLS), hay que cambiar haxlite para anunciar la IP de
   Spectrum y no hablar nunca directamente con los candidatos del cliente, y la IP de origen tiene
   que ser **nueva**. A efectos prácticos es lo mismo que el TURN de Cloudflare que ya probaron, pero
   mucho más caro. Si el TURN "seguía siendo atacado", lo más probable es que la IP de origen siguiera
   expuesta (vieja, o filtrada por candidatos host/srflx); ver §6 y 01-…

---

## 1. Qué ataques sufren los hosts de HaxBall

### 1.1 Evidencia específica de HaxBall
* **haxball-issues #194 (2017):** salas de los Balcanes "bajo constantes ataques DDoS". El
  desarrollador (basro) responde: *"Unfortunately there's not much you can do against a DDoS attack."*
* **haxball-issues #2238 (2025-01-27, "ddos"):** incidente reciente sin respuesta oficial.
* El modelo de amenaza se sigue del protocolo. El host es el centro de una estrella P2P y cada
  jugador recibe sus candidatos ICE, con lo que basta entrar a la sala (o leer
  `chrome://webrtc-internals`) para tener la IP:puerto. Los jugadores **no** conocen las IPs de los
  demás jugadores, y eso hace que una allowlist por IP de jugador sea difícil de falsificar (el
  atacante tendría que conocer y suplantar la IP exacta de un jugador conectado *y* el puerto de la sala).
* No encontré datos públicos de vectores medidos contra salas de HaxBall en concreto (Discords y
  Reddit no son accesibles para el buscador). Lo que sigue se basa en lo que venden los booters y
  en informes generales.

### 1.2 Vectores típicos (booters/stressers y botnets)
* **Reflexión/amplificación UDP:** NTP (amplificación media de ~603× en el estudio de booters),
  DNS (~30×), SSDP (~26×), CLDAP, memcached, chargen. Un estudio de 2022 atribuye la mitad de las
  amplificaciones a SSDP y la otra mitad a CLDAP+NTP. Siempre llegan con **puerto origen fijo**
  (53, 123, 389, 1900, 11211, 19, 161…) y a menudo **fragmentadas**.
* **UDP flood directo / "UDP bypass" / "game" methods:** payload aleatorio o imitando un protocolo,
  con origen suplantado o desde botnet (Mirai/Aisuru), contra la IP:puerto que vemos en ICE. Es lo
  más dañino para WebRTC, porque un filtro genérico no lo separa del tráfico DTLS legítimo.
* **SYN/ACK floods** contra TCP. El host haxlite no necesita TCP entrante (la señalización es un
  WebSocket *saliente* al master), así que basta con descartar los SYN a todo menos SSH.
* **STUN floods:** Binding Requests con forma válida. libjuice calcula HMAC y busca el ufrag por cada
  uno, lo que cuesta CPU en el proceso de Node.
* **Datos 2025 (Cloudflare):** en el T2-2025 los vectores L3/4 principales fueron DNS floods (~1/3),
  SYN floods (27 %) y UDP floods (13 %). En el T4-2025 Brasil estuvo entre los 5 países más
  atacados, Argentina fue la 4.ª fuente de ataques y Gaming la 4.ª industria más atacada; el récord
  fue de 31,4 Tbps en 35 s. Los booters suelen entregar bastante menos de lo que anuncian (en un
  estudio, ~25 % del pico prometido), pero aun así van de decenas de Gbps hacia arriba, muy por
  encima del enlace de un VPS.

### 1.3 Qué para cada cosa

| Vector | Filtro en host (nft/XDP, §3) | Upstream (proveedor) |
|---|---|---|
| Amplificación (sport 53/123/389/1900/11211…) | descarta barato **si el enlace no está lleno** (`udp sport < 1024`, set `amp_sports`) | **Sí**, trivial: ACL por puerto origen (OVH ENF, cloud firewall) y scrubbing |
| Fragment flood | `ip frag-off` drop (WebRTC no fragmenta) | ENF `fragments` / scrubbing |
| UDP flood "bypass" a la IP:puerto de la sala | **Sí**: sólo pasan `active`/`pending`/STUN limitado; `pending` solo vale si el sidecar mete IPs validadas (la oferta la escribe el cliente) | difícil para scrubbers genéricos; lo ideal es una allowlist upstream (Magic Transit PFP, SG de AWS) |
| STUN flood | nft: límite por prefijo de origen (5/s; /24 v4, /64 v6) y global (2000/s); XDP: por IP de origen y global (2000/s); opcional: comprobar ufrag en XDP | perfil STUN (Path), rate-limit |
| SYN/ACK flood | descartar SYN salvo SSH de administración; syncookies | scrubbing estándar (lo hacen todos) |
| Jugador malicioso (ya en allowlist) | tope de 1000 pps por IP (nft y XDP), kick y set `deny` | — |
| Volumétrico > capacidad del enlace / carpet bombing del /24 | **No** | **Sí**, y es lo único que funciona |

---

## 2. Proveedores con mitigación sobre la propia IP (sin relay)

### 2.1 Tabla comparativa

| Proveedor | Modelo | Capacidad anunciada | Filtros/API propios | WebRTC (STUN+DTLS+SCTP en el mismo puerto) | LATAM | Precio orientativo |
|---|---|---|---|---|---|---|
| **OVHcloud** VPS / Bare Metal | VAC siempre activo; **Edge Network Firewall** (ENF) stateless | multi-Tbps (global) | ENF: **20 reglas/IP**, sólo IPv4, campos protocolo/IP origen/puerto origen/destino/fragments/tcp; rangos de puertos desde 03-2026; API `/ip/{ip}/firewall/{ipOnFirewall}/rule` (terraform/pulumi `ovh_ip_firewall_rule`); se activa solo durante un ataque | sin perfil; con ENF bien configurado pasa UDP a los puertos de sala. Riesgo de FP bajo pero **sin garantía**: probar | **No tiene DC en LATAM** (Brasil se sirve "desde cerca": Beauharnois/EE. UU.). La Local Zone VPS **no** tiene anti-DDoS | VPS desde ~5–10 US$/mes con anti-DDoS incluido |
| **OVHcloud Game** (Bare Metal GAME) | ENF + **Game firewall** L7 por perfiles | ídem | 100 reglas/IP (Gen3) o 30 (RISE/SYS-GAME), "Default Deny"; perfiles de juegos concretos (CS2, Rust, FiveM, Minecraft…); `GET /ip/{ip}/game/` | **no hay perfil WebRTC**; sólo "Other", que OVH describe como "poca seguridad adicional" | igual, sin LATAM | ~100+ US$/mes (verificar) |
| **Path.net** | red anycast con scrubbing, *port punching* (default-drop) | ~12 Tbps (agregador) | filtros STUN, DTLS, RTP, genérico, rate limiters (según revendedores). No encontré documentación pública de la API | lo más parecido a "entiende WebRTC", pero hay que **confirmar** si un mismo puerto admite STUN+DTLS a