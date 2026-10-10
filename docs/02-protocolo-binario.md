# 02 — Protocolo binario de HaxBall: streams, mensajes, eventos, estado, estadios y replays

> Documento de ingeniería inversa basado **exclusivamente** en código abierto público:
> el script *headless* oficial empaquetado por `mertushka/haxball.js` (`src/generated/headless.ts`,
> cabecera `HaxBall © Mario Carbajal`, *source hash* `f066733d`) y la reimplementación
> `wxyz-abcd/node-haxball` (`src/api.js` minificado + `src/index.d.ts`).
> No se conectó a ninguna sala real. Todo lo que no se pudo confirmar en código se marca **(no verificado)**.

Versiones observadas en el código:

| Constante | Valor | Evidencia (grep en el fuente original) |
|---|---|---|
| Versión de protocolo de sala | `9` | `headless.ts`: `version:9`, `h.pi=9` |
| Versión de replay (`.hbr2`) | `3` | `headless.ts`: `eb=new cb(D,3)`; `api.js`: `G.CI("HBR2"),G.AM(3)` |
| Tick de simulación | 60 frames/s (`0.06` frames/ms) | `headless.ts`: `this.Be=.06` |
| Retardo de entrada | 2 frames | `headless.ts`: `this.Sb=2` |

---

## 0. Mapa de nombres minificados → nombres legibles

Los nombres del headless oficial (salida de Haxe minificada) cambian en cada build; los de
node-haxball también están ofuscados pero `index.d.ts` y las tablas de `ak(...)`/`E(W, [], [...])`
de `api.js` dan los nombres públicos. Mapeo usado en este documento:

| Headless oficial | node-haxball (`api.js`) | Nombre legible | Rol |
|---|---|---|---|
| `L` | `HE`/`hE`/`rE` (mismo prototipo) | **StreamReader** | lector sobre `DataView` |
| `A` | `pE`/`oM`/`pM` (`.W(n)`) | **StreamWriter** | escritor con buffer auto-redimensionable |
| `m` | `jM` / `mM.lM(...)` | **HaxballEvent** (acción) base | registro de tipos, `pack`/`unpack` |
| `vb.Ci()` | — | registro de acciones | asigna los IDs numéricos |
| `Ta` | `pE` (RoomState) | **RoomState** | estado de la sala |
| `Ka` | `NG` | **Player** | |
| `Q` | `kM` | **GameState** | partido en curso |
| `Oa` | `q` dentro de `kM` | **World** (físicas) | discos móviles + referencias al estadio |
| `Ba` | — | **MovableDisc** | disco dinámico |
| `X` | `FM` | **Disc** (definición en estadio) | |
| `w` | `b`/`_` (Stadium) | **Stadium** | |
| `C` | `aM` | **Vertex** | |
| `E` | `$M` | **Segment** | |
| `K` | `NM` | **Plane** | |
| `xa` | `tE` | **Goal** | |
| `Ha` | `lE` | **Joint** | |
| `Qa` | `MW` | **PlayerPhysics** | |
| `W` | `n` | **TeamColors** | |
| `v` | `B`/`IM` (Team) | **Team** (`v.oa`=Spectators, `v.fa`=Red, `v.ta`=Blue) | |
| `ab` | `uW.N1` | **RoomInfo** (datos de la lista de salas) | |
| `cb` | `ra`/`Qa` (`kU`) | **ReplayRecorder** | |
| `Aa` | — | conexión de señalización del host (WebSocket) | |
| `la` / `Ya` | `IG` / `xa` | conexión WebRTC (pre/post handshake) | |
| `Wa` (extiende `Ma`→`O`) | `W` en `iI` (cliente) | sala de red del host (scheduler de frames) | |
| `ua` | `xM` (`HW`) | verificación/firmado de identidad ECDSA (`idkey`) | |
| `ka` | — | `pako.Inflate` con límite de tamaño | |
| `Ra` | — | *token bucket* (limitador de tasa) | |

---

## 1. StreamReader / StreamWriter

Ambas clases envuelven un `DataView` con un cursor (`this.a` en el oficial, `this.c` en node-haxball)
y una bandera de endianness (`this.ra` / `this.RM`).

```js
// headless.ts (StreamReader)
class L{constructor(a,b){null==b&&(b=!1);this.j=a;this.ra=b;this.a=0} ...
// headless.ts (StreamWriter)
class A{constructor(a,b){null==b&&(b=!1);this.j=a;this.ra=b;this.a=0} ...
static aa(a,b){null==b&&(b=!1);null==a&&(a=16);return new A(new DataView(new ArrayBuffer(a)),b)}
```

### 1.1 Endianness

* **Big-endian por defecto** (`littleEndian=false` en todas las llamadas `getXxx/setXxx`).
* **Única excepción conocida:** `RoomInfo` (datos públicos de la sala para la lista) se escribe en
  **little-endian**: `ab.G(a){...a.ra=!0;a.Oa(this.pi);...;a.ra=!1}`. node-haxball hace lo mismo
  (`a.RM = !0 ... a.RM = !1`).

### 1.2 Primitivas

| Tipo | Lector (oficial / node) | Escritor (oficial / node) | Codificación |
|---|---|---|---|
| `int8` | `Ud()` / — | (se escribe con `f`) | 1 byte con signo |
| `uint8` | `C()` / `s()` | `f()` / `$()` | 1 byte |
| `int16` | — / `ok()` | `ge()` / `Jk()` | 2 bytes BE |
| `uint16` | `lc()` / `ZM()` | `Oa()` / `mM()` | 2 bytes BE |
| `int32` | `I()` / `Y()` | `w()` / `g()` | 4 bytes BE |
| `uint32` | `Qb()` / `qM()` | `xa()` / `AM()` | 4 bytes BE |
| `float32` | `Oh()` / — | `fe()` / — | IEEE-754 BE (solo `SetDiscProperties` y `RoomInfo`) |
| `float64` | `s()` / `d()` | `g()` / `J()` | IEEE-754 BE (coordenadas, físicas) |
| **varuint** | `ob()` / `vM()` | `Fa()` / `gM()` | LEB128 sin signo, máx. 5 bytes (ver 1.3) |
| bytes (n) | `Ga(n)`, `Nh(n)` / `XM(n)`, `lk(n)` | `qb()`, `Tf()`, `ti()` / `FM()`, `Ya()` | crudo; sin `n` = "hasta el final" |
| **string** | `nb()` / `sE()` | `Vb()` / `eE()` | `varuint byteLen` + UTF-8 |
| **string nullable** | `Ya()` / `lE()` | `Ea()` / `oE()` | `varuint (byteLen+1)`; `0` ⇒ `null` |
| string corto | `bd(C())` / `k1()` | `Vf()` / `P1()` | `uint8 byteLen` + UTF-8 (`TextEncoder`), máx 255 |
| string sin prefijo | `bd(n)` / `kG(n)` | `he()` / `CI()` | UTF-8 crudo (p. ej. magia `"HBR2"`) |
| **JSON** | `yf()` / `Ka()` | `Uf()` / `ZI()` | `JSON.stringify` → `string` (varuint + UTF-8) |

### 1.3 Varint (`ob` / `Fa`)

LEB128 sin signo, grupos de 7 bits *little-endian*, bit 7 = "continúa"; como máximo 5 bytes
(el quinto lleva `a>>28&127`). El lector devuelve `d|0`, así que valores ≥2³¹ se reinterpretan con signo.

```js
ob(){let a=this.a,b=0,c,d=0;do c=this.j.getUint8(a+b),5>b&&(d|=(c&127)<<7*b>>>0),++b;while(0!=(c&128));this.a+=b;return d|0}
static xg(a){a>>>=0;return 128>a?1:16384>a?2:2097152>a?3:268435456>a?4:5}
```

### 1.4 Strings (UTF-8 "a mano")

* `A.Ng`/`L.Jg` implementan un UTF-8 propio que admite secuencias de hasta 6 bytes (formato UTF-8 original, pre-RFC 3629).
* **Detalle importante:** el escritor itera `charCodeAt` (unidades UTF-16, `P.Yf`), por lo que un carácter
  fuera del BMP (emoji) se codifica como **dos sustitutos de 3 bytes cada uno** (estilo CESU-8/WTF-8), no como
  una secuencia de 4 bytes. El lector usa `String.fromCodePoint` sobre cada valor decodificado, lo que
  reconstruye los pares sustitutos. Una implementación compatible debe replicar este comportamiento.
* El prefijo de longitud cuenta **bytes**, no caracteres. Los límites de las acciones (`140`, `1000`,
  `100`, `25`…) se comprueban en cambio sobre `string.length` (unidades UTF-16) después de decodificar.
* `bd()` lanza `"Actual string length differs from the specified"` si la última secuencia multibyte rebasa el límite.

### 1.5 Compresión

* Siempre **DEFLATE crudo** (`pako.deflateRaw` / `pako.inflateRaw`, sin cabecera zlib ni gzip).
  `haxball.js` sustituye pako por `node:zlib` `deflateRawSync`/`inflateRawSync` (`src/pako.ts`), lo que lo confirma.
* Para mensajes de señalización entrantes el host usa `ka.Xf(data, tb)` con un buffer fijo
  `tb=new Uint8Array(51200)`: inflado limitado a **51 200 bytes** (`"Inflate size exceeds limit"`).
* Dónde se comprime: snapshot inicial (msg P2P `1`), payload de `SetStadium`, replays,
  payloads de señalización WebSocket y (solo node-haxball) `BinaryCustomEvent`.

---

## 2. Transporte y *framing*

HaxBall es P2P con autoridad del host: señalización por **WebSocket** contra los servidores de haxball.com,
y luego **WebRTC DataChannels** directos cliente↔host. Todos los mensajes son binarios
(`binaryType="arraybuffer"`). **No hay cabecera de longitud ni número de secuencia de transporte**: cada
mensaje de DataChannel/WebSocket es una unidad completa cuyo **primer byte es el tipo de mensaje**.

### 2.1 Endpoints HTTP / WebSocket

| Uso | Endpoint | Evidencia |
|---|---|---|
| Host: obtener URL+token de señalización | `POST https://www.haxball.com/rs/api/host` con `token=<headlessToken>&rcr=<recaptcha>` (`application/x-www-form-urlencoded`). Respuesta JSON `{data:{action:"connect",url,token}}` o `{action:"recaptcha",sitekey}` | `za.Le="https://www.haxball.com/rs/"`, `T.Ih(this.di,"token="+this.nc+"&rcr="+a,T.hg)` |
| Host: WebSocket | `<url>?token=<token>` | `new WebSocket(f+"?token="+e)` |
| Cliente: WebSocket | `wss://p2p.haxball.com/client?id=<roomId>[&token=<recaptchaToken>]` | `api.js`: `JP:"p2p.haxball.com"`, `N + "?id=" + a + ...` |
| Lista de salas | `GET https://www.haxball.com/rs/api/list` (binario) | `api.js`: `EWG.bI + "api/list", "arrayBuffer"` |
| Geolocalización | `GET .../rs/api/geo` (JSON `{lat,lon,code}`) | `ia.Sg()` |
| STUN | `stun:stun.l.google.com:19302` | `za.Ld=[{urls:"stun:stun.l.google.com:19302"}]` |

### 2.2 Mensajes WebSocket de señalización (host ↔ servidor)

Lectura en `Aa.ah` (`switch(a.C()){case 1..case 4..case 5..case 6}`), escritura en `Aa.qc/pc/Yh/Yd/Df`.

| Dir. | Tipo | Layout (BE) | Significado |
|---|---|---|---|
| srv→host | `1` | `u32 connId`, `u8 n`, `n bytes` (IP del cliente → hex con `R.yi`), `deflateRaw(…)` = `u8 retryFlag`, `string sdpOffer`, `JSON candidates[]`, **resto** = datos de petición de unión (`u16 protocolVersion`, `nullableString password`) | Oferta WebRTC de un cliente nuevo |
| srv→host | `4` | `u32 connId`, `deflateRaw(JSON iceCandidate)` | Candidato ICE |
| srv→host | `5` | `u8 n`, `n bytes` roomId | Enlace de la sala (`https://www.haxball.com/play?c=<id>`) |
| srv→host | `6` | resto = string token | Nuevo token de reconexión |
| host→srv | `0` | `u32 connId` [+ `u16 errorCode`] | Fin de señalización (sin código) o rechazo (con código) |
| host→srv | `1` | `u32 connId`, `deflateRaw(string sdpAnswer, JSON candidates[])` | Respuesta WebRTC |
| host→srv | `4` | `u32 connId`, `deflateRaw(JSON candidate)` | Candidato ICE |
| host→srv | `7` | `RoomInfo` (LE, ver §7) | Publicar/actualizar datos de la lista (máx. cada 10 s si cambia) |
| host→srv | `8` | — | *Keep-alive* cada 40 s |
| host→srv | `9` | `u8 requireRecaptcha` | Activar reCAPTCHA para unirse |

Códigos de rechazo vistos (`va.zc(...)`, `this.pc(a,...)`): `4100` sala llena, `4101` contraseña incorrecta,
`4102` baneado (IP o candidato `srflx`), `4103` versión de protocolo distinta, `4104` ≥16 conexiones pendientes.
`4001`/`4004` son códigos de cierre del WebSocket del servidor (node-haxball los mapea a mensajes de error) (**no verificado** su significado exacto).

### 2.3 Mensajes WebSocket (cliente ↔ servidor)

En node-haxball (`ci`, `KW`, `oi`, `Ni`): el cliente envía `[u8 tipo][deflateRaw(payload)]`; al recibir,
si queda algo tras el byte de tipo, lo infla.

| Dir. | Tipo | Payload (inflado) |
|---|---|---|
| cli→srv | `1` | `u8 retryFlag` (1 si es reintento → el host retrasa 2500 ms sus candidatos ICE), `string sdpOffer`, `JSON candidates[]`, `u16 version (=9)`, `nullableString password` |
| cli→srv | `4` | `JSON candidate` |
| cli→srv | `0` | — (fin de recogida de candidatos) |
| srv→cli | `1` | `string sdpAnswer`, `JSON candidates[]` |
| srv→cli | `4` | `JSON candidate` |

### 2.4 DataChannels WebRTC

```js
kb.channels=[{name:"ro",reliable:!0,ordered:!0},{name:"ru",reliable:!0,ordered:!1},{name:"uu",reliable:!1,ordered:!1}]
```

Canales **negociados** (`negotiated:true`, `id` = índice), por lo que no hay evento `ondatachannel`:

| id | Nombre | Fiable | Ordenado | Uso observado |
|---|---|---|---|---|
| 0 | `ro` | sí | sí | handshake, snapshot inicial, acciones del cliente, kick, consistency check, mensajes dirigidos |
| 1 | `ru` | sí | no | difusión de eventos (msg `2`) |
| 2 | `uu` | no (`maxRetransmits:0`) | no | sincronía de frame (msg `3`), ping (`2`/`4`) |

Si el canal pedido no está `open`, se usa el canal 0 (`0!=a&&"open"!=c.readyState&&(c=this.jb[0])`).

### 2.5 Mensajes P2P host → cliente

| Tipo | Canal | Layout | Significado |
|---|---|---|---|
| `0` | ro | `varuint n`, `n bytes` reto (8 bytes = `float64` aleatorio) | Desafío de identidad (`Ah`) |
| `1` | ro | `deflateRaw(` `u16 myPlayerId`, `u32 frameNo`, `u32 eventCounter`, `varuint eventsInCurrentFrame`, **RoomState**, `{EventFrame}*` hasta el final `)` | **Snapshot inicial** (§4) |
| `2` | ru | **EventFrame** (abajo) | Evento difundido |
| `3` | uu | `u32 frameNo`, `u32 eventCounter` | Sincronía de frame; enviado si pasaron ≥7 frames o tras una acción del host |
| `4` | uu | `float64 hostFrameEstimate`, `float64 echoClientTime` | Respuesta de ping; `hostFrame = (now-start)*0.06 + 2` |
| `5` | ro | `u8 isBan`, `string reason`, `string byName` (opcional en lectura) | Has sido expulsado/baneado (el host cierra la conexión) |
| `6` | ro | `u8 eventType`, payload | Evento dirigido a **un** cliente, sin cabecera de frame; se aplica con `byId=0` (p. ej. `sendChat`/`sendAnnouncement` privados) |

**EventFrame** (`Wa.rf`): cabecera que precede a cada evento en los msg `1` y `2`:

```
u32     frameNo        (eb)  frame en el que se aplica
varuint orderInFrame   (fb)  índice del evento dentro del frame
u16     byId           (B)   jugador emisor (0 = host)
u32     clientSeq      (vi)  nº de secuencia que puso el cliente emisor (0 si lo genera el host)
u8      eventType            ID de §3
...     payload
```
```js
rf(a,b){b.xa(a.eb);b.Fa(a.fb);b.Oa(a.B);b.xa(a.vi);m.te(a,b)}
```

`eventCounter` (`od`) es el número acumulado de eventos aplicados en frames anteriores; el cliente lo usa
con el msg `3` para saber si ya recibió todos los eventos hasta `frameNo` antes de avanzar la simulación.

### 2.6 Mensajes P2P cliente → host

El host (`Wa.Jh`) solo acepta el tipo `0` antes de completar el handshake, y `1`/`2` después.
Si sobran bytes tras parsear, la conexión se corta (`if(0<c.j.byteLength-c.a)throw r.l(2)`).

| Tipo | Canal | Layout | Significado |
|---|---|---|---|
| `0` | ro | `varuint n`, `n bytes` **authBlob**, `varuint m`, `m bytes` **joinData** | Respuesta al reto + datos del jugador |
| `1` | ro | `u32 targetFrame`, `u32 clientSeq`, `u8 eventType`, payload | Acción del cliente. `targetFrame=0` si la acción no es *delay* |
| `2` | uu | `float64 clientTime` (`performance.now()`), `varuint myPingMs` | Ping (el host responde con msg `4`; el ping reportado alimenta la acción `Ping`) |

*joinData* (`D.yh`): `string name` (≤25), `string country/flag` (≤3), `nullableString avatar` (≤2).

*authBlob* (`ua.ri` / node `xM.prototype.yc`):

```
u8   1                      (versión del blob)
u16  L
L bytes signedData = string x, string y, bytes reto(8)
resto = firma ECDSA P-256 / SHA-256 de signedData
```

`x`,`y` son las coordenadas JWK de la clave pública; la clave privada se guarda como
`"idkey.<x>.<y>.<d>"`. Si la firma verifica, el host expone `x` como `player.auth`; si no, `auth=null`.

El host programa la acción en `f = clamp(targetFrame, da, da+20)`; para acciones *delay* además
suaviza con una media móvil y nunca adelanta a `da+2` salvo excepciones (ver `Wa.Mh`).

### 2.7 Secuencia de conexión (resumen)

```
cliente                      servidor señalización                host
  |-- WS /client?id=… --------->|                                   |
  |-- [1] deflate(offer,cands,ver,pwd) ->|-- [1] connId,IP,deflate(...) ->|  valida ver/pwd/bans (Xg)
  |<- [1] deflate(answer,cands) -|<- [1] connId,deflate(answer,…) --|
  |<====================== WebRTC DataChannels ro/ru/uu ==========>|
  |<---------------------------- [0] reto (8 bytes) -----------------|
  |----------------------------- [0] authBlob + joinData ---------->|  verifica firma, id=wh++
  |                                                                  |  difunde JoinRoom(id,name,flag,avatar)
  |<---------------------------- [1] deflate(snapshot) -------------|
  |<--- [2] eventos (ru) / [3] sync (uu) / [4] pong (uu) -----------|
  |---- [1] acciones (ro) / [2] ping (uu) ------------------------->|
```

### 2.8 Limitación de tasa

`Ra(capacidad, msPorToken)` es un *token bucket*.

| Ámbito | Parámetros | Evidencia |
|---|---|---|
| Todos los mensajes de una conexión | 100 de ráfaga, 1 cada 16 ms | `this.Tg=new Ra(100,16)` |
| `SendChat` (4) | 10, 1 cada 900 ms | `na.U=m.Z({…,ue:{je:10,ye:900}})` |
| `SetStadium` (11) | 10, 1 cada 2000 ms | `V.U=m.Z({…,ue:{je:10,ye:2E3},…})` |
| `SetPlayerSync` (16) | 2, 1 cada 10 000 ms | `Fa.U=m.Z({…,ue:{je:2,ye:1E4}})` |

Superar un límite lanza excepción y el host desconecta al cliente.

---

## 3. Eventos / operaciones (acciones)

### 3.1 Mecanismo

* Cada clase de acción extiende `m` e implementa `apply(state)`, `S(writer)` (serializar) y `W(reader)` (deserializar).
* `vb.Ci()` registra las clases en orden con `m.$(X)`; **el ID es el orden de registro** (`a.kg=m.ie; … m.ie++`):
  `m.$(Z);m.$(Ca);m.$(ma);m.$(Da);m.$(na);m.$(aa);m.$(S);m.$(oa);m.$(pa);m.$(qa);m.$(U);m.$(V);m.$(ba);m.$(ra);m.$(ca);m.$(Ea);m.$(Fa);m.$(da);m.$(Ga);m.$(sa);m.$(ea);m.$(fa);m.$(ha);m.$(M)`
* Empaquetado: `m.te(a,b)` = `u8 typeId` + `a.S(b)`. Desempaquetado: `m.Ji(a)` lee `u8` y crea la instancia.
* Configuración por clase (`X.U = m.Z({...})`, por defecto `delay:true, ca:true`):
  * `delay`: el cliente la programa en `frameActual + retardo` (en node-haxball `IM`).
  * `ca`: el cliente la aplica localmente de forma predictiva antes de que vuelva del host (node `PM`) (**interpretación no verificada**; solo `SendInput` y `PauseResumeGame` la tienen a `true`, junto con `delay`).
  * `tb(byId, state)`: permiso al recibirla de un cliente. `tb:function(){throw …}` ⇒ **solo el host** puede emitirla.
  * `ue:{je,ye}`: limitador de tasa (§2.8).
* Las acciones del host llevan `byId=0`. Muchas `apply` comprueban `a.Aa(this.B)` = "emisor es host o admin".

### 3.2 Tabla de tipos

IDs 0–23 = protocolo oficial. 24–26 son **extensiones de node-haxball**
(solo las procesan clientes node-haxball; el cliente oficial no las conoce).

**Verificación cruzada (hecha):** el orden de registro del headless oficial
(`m.$(Z);m.$(Ca);m.$(ma);m.$(Da);m.$(na);m.$(aa);m.$(S);m.$(oa);m.$(pa);m.$(qa);m.$(U);m.$(V);m.$(ba);m.$(ra);m.$(ca);m.$(Ea);m.$(Fa);m.$(da);m.$(Ga);m.$(sa);m.$(ea);m.$(fa);m.$(ha);m.$(M)`,
24 clases) **coincide 1:1** con `OperationType` 0–23 de node-haxball (`index.d.ts`). La correspondencia se comprobó por
semántica de cada clase (su `apply` y sus campos `S`/`W`), no solo por nombre: p. ej. `Z` (0) aplica un anuncio con
color/estilo/sonido, `Da` (3) asigna `player.input`, `V` (11) cambia el estadio, `M` (23) modifica propiedades de disco,
y los payloads de node-haxball (`api.js`, clases `M: Z.Tf`…`M: Z.Wh`) usan el mismo orden de campos. El headless oficial
registra exactamente 24 tipos, así que los IDs 24–26 no existen en el protocolo oficial.

| ID | node-haxball `OperationType` | Clase oficial | Payload (en orden, BE) | Quién / restricciones |
|---|---|---|---|---|
| 0 | `SendAnnouncement` | `Z` | `string msg` (≤1000), `i32 color` (-1 = transparente), `u8 style` (0 normal,1 bold,2 italic,3 small,4 small-bold,5 small-italic), `u8 sound` (0 ninguno,1 chat,2 highlight) | solo host |
| 1 | `SendChatIndicator` | `Ca` | `u8 value` (0/1 "está escribiendo") | cualquiera |
| 2 | `CheckConsistency` | `ma` | `varuint n`, `n bytes` (4 bytes: hash XOR del RoomState) | solo host |
| 3 | `SendInput` | `Da` | `u32 input` (bits: 1 up, 2 down, 4 left, 8 right, 16 kick) | cualquiera; `delay`+`ca` |
| 4 | `SendChat` | `na` | `string text` (≤140) | cualquiera; 10/900 ms |
| 5 | `JoinRoom` | `aa` | `i32 playerId`, `nullableString name`, `nullableString flag`, `nullableString avatar` | solo host |
| 6 | `KickBanPlayer` | `S` | `i32 playerId`, `nullableString reason` (≤100; `null` = salida voluntaria), `u8 ban` | admin |
| 7 | `StartGame` | `oa` | — | admin |
| 8 | `StopGame` | `pa` | — | admin |
| 9 | `PauseResumeGame` | `qa` | `u8 paused` | admin; `delay`+`ca` |
| 10 | `SetGamePlayLimit` | `U` | `i32 type` (0 = scoreLimit, 1 = timeLimit), `i32 value` (se acota a 0..99) | admin, sin partido |
| 11 | `SetStadium` | `V` | `u16 n`, `n bytes` = `deflateRaw(Stadium)` (§5.3) | admin, sin partido; 10/2000 ms |
| 12 | `SetPlayerTeam` | `ba` | `i32 playerId`, `i8 teamId` (0 spec, 1 red, 2 blue) | admin, o uno mismo si equipos sin bloquear y sin partido |
| 13 | `SetTeamsLock` | `ra` | `u8 locked` | admin |
| 14 | `SetPlayerAdmin` | `ca` | `i32 playerId`, `u8 isAdmin` | admin |
| 15 | `AutoTeams` | `Ea` | — | admin |
| 16 | `SetPlayerSync` | `Fa` | `u8 value` (el cliente envía `true` al detectar **desincronización** tras un `CheckConsistency`) | cualquiera; 2/10 s |
| 17 | `Ping` | `da` | `varuint n`, `n × varuint pingMs` (en el orden de la lista de jugadores) | solo host; cada 3 s |
| 18 | `SetAvatar` | `Ga` | `nullableString avatar` (rechazo si >8, se trunca a 2) | cualquiera |
| 19 | `SetTeamColors` | `sa` | `i8 teamId`, **TeamColors** (§4.5) | admin |
| 20 | `ReorderPlayers` | `ea` | `u8 moveToTop`, `u8 n`, `n × i32 playerId` (máx. 40) | solo host |
| 21 | `SetKickRateLimit` | `fa` | `i32 min`, `i32 rate`, `i32 burst` | admin |
| 22 | `SetHeadlessAvatar` | `ha` | `nullableString avatar` (≤2), `i32 playerId` | solo host |
| 23 | `SetDiscProperties` | `M` | `i32 id`, `u8 isPlayer`, `u16 mask`, valores presentes (abajo) | solo host |
| 24 | `CustomEvent` *(node)* | — | `u32 type`, `string JSON(data)` | node-haxball |
| 25 | `BinaryCustomEvent` *(node)* | — | `u32 n`, `n bytes` = `deflateRaw(u32 type, bytes data)` | node-haxball |
| 26 | `SetPlayerIdentity` *(node)* | — | `i32 playerId`, `string JSON(data)` | node-haxball, solo host |

**`SetDiscProperties` (23) — máscara de 16 bits** (escrita como placeholder y parcheada al final):

| bit | campo | tipo |  | bit | campo | tipo |
|---|---|---|---|---|---|---|
| 0 | x | f32 | | 7 | bCoef | f32 |
| 1 | y | f32 | | 8 | invMass | f32 |
| 2 | xspeed | f32 | | 9 | damping | f32 |
| 3 | yspeed | f32 | | 10 | color | i32 |
| 4 | xgravity | f32 | | 11 | cMask | i32 |
| 5 | ygravity | f32 | | 12 | cGroup | i32 |
| 6 | radius | f32 | | | | |

Solo se serializan los campos cuyo bit está activo, en orden de bit. Si `isPlayer=1`, `id` es un
playerId; si no, es el índice del disco en `World.discs`.

**`SetKickRateLimit`**: `RoomState.ai()` acota `min` y `rate` a 0..255, `burst` a 0..100, y guarda
`kickRate_max = rate × burst`.

**`SetTeamColors`**: `angle` se guarda como `u8 = 256·grados/360`.

---

## 4. Snapshot inicial del estado (msg P2P `1`)

Construido por `Wa.$h` cuando el handshake termina (tras difundir el `JoinRoom` del recién llegado, de modo que el
snapshot ya lo incluye):

```js
$h(a){let b=A.aa();b.f(1);let c=A.aa();c.Oa(a.P);c.xa(this.da);c.xa(this.od);c.Fa(this.Ra);this.Ca.G(c);
 let d=this.Xd.list,…;for(;e<f;)this.rf(d[e++],c);b.qb(pako.deflateRaw(c.Db()));a.pb(b)}
```

```
u8 1
deflateRaw(
  u16      myPlayerId
  u32      frameNo            (da)
  u32      eventCounter       (od)
  varuint  eventsAppliedInCurrentFrame (Ra)
  RoomState                   (§4.1)
  EventFrame*                 eventos ya aceptados pero programados para frames futuros
)
```

### 4.1 RoomState (`Ta.G` / node `pE.QU`·`rU`)

| # | Campo (node) | Tipo | Notas |
|---|---|---|---|
| 1 | `name` | nullableString | nombre de la sala |
| 2 | `teamsLocked` | u8 | |
| 3 | `scoreLimit` | i32 | por defecto 3 |
| 4 | `timeLimit` | i32 | minutos, por defecto 3 |
| 5 | `kickRate_max` | i16 | por defecto 1 |
| 6 | `kickRate_rate` | u8 | por defecto 0 |
| 7 | `kickRate_min` | u8 | por defecto 2 |
| 8 | `stadium` | **Stadium** (§5.3) | `u8 255` + cuerpo, o solo el índice de estadio por defecto |
| 9 | — | u8 | 1 si hay partido en curso |
| 10 | `gameState` | **GameState** (§4.3) | solo si (9)=1 |
| 11 | — | u8 n | nº de jugadores |
| 12 | `players` | n × **Player** (§4.2) | |
| 13 | `teamColors[red]` | **TeamColors** | |
| 14 | `teamColors[blue]` | **TeamColors** | |

### 4.2 Player (`Ka.S`)

| # | Campo (node) | Tipo |
|---|---|---|
| 1 | `isAdmin` | u8 |
| 2 | `avatarNumber` (dorsal en el equipo) | i32 |
| 3 | `avatar` | nullableString |
| 4 | `headlessAvatar` | nullableString |
| 5 | `sync` (en realidad flag de **desync**) | u8 |
| 6 | `flag` (país) | nullableString |
| 7 | desconocido (`Ai` oficial / `la` node, sin nombre público; siempre 0 en el headless) **(no verificado)** | i32 |
| 8 | `name` | nullableString |
| 9 | `input` | i32 |
| 10 | `id` | varuint |
| 11 | `isKicking` | u8 |
| 12 | `kickRateMaxTickCounter` | i16 |
| 13 | `kickRateMinTickCounter` | u8 |
| 14 | `team` | u8 (0/1/2) |
| 15 | índice de su disco en `World.discs` | i16 (−1 = sin disco) |

El `ping` del jugador **no** forma parte del estado serializado; llega por la acción `Ping`.

### 4.3 GameState (`Q.G`)

| # | Campo (node) | Tipo | Notas |
|---|---|---|---|
| 1 | `physicsState` | **World**: `u8 n` + n × **MovableDisc** | solo los discos dinámicos; las partes estáticas salen del estadio |
| 2 | `goalTickCounter` | i32 | 150 tras gol, 300 al terminar |
| 3 | `state` | i32 | 0 BeforeKickOff, 1 Playing, 2 AfterGoal, 3 Ending |
| 4 | `redScore` | i32 | |
| 5 | `blueScore` | i32 | |
| 6 | `timeElapsed` | f64 | **segundos** (`Nb+=1/60` por frame; `index.d.ts` dice milisegundos, pero el código suma 1/60) |
| 7 | `pauseGameTickCounter` | i32 | 120 = pausado; cuenta atrás hasta 0 al reanudar |
| 8 | `goalConcedingTeam` | u8 | equipo que recibió el último gol / saca |

### 4.4 MovableDisc (`Ba.G`) y Disc de estadio (`X.G`) — mismo layout

`f64 x, f64 y, f64 xspeed, f64 yspeed, f64 xgravity, f64 ygravity, f64 radius, f64 bCoef, f64 invMass, f64 damping, u32 color, i32 cMask, i32 cGroup` (= 10×8 + 3×4 = **92 bytes**).

### 4.5 TeamColors (`W.G`)

`u8 angle`, `i32 textColor`, `u8 n` (≤3, si no `"too many"`), `n × i32 color`.
Valores por defecto: Red `0xE56E56` (15035990), Blue `0x5689E5` (5671397).

### 4.6 Comprobación de consistencia

`Ta.Ve()` serializa el RoomState y hace XOR de todas las palabras `i32` completas; el host envía ese valor
como `CheckConsistency` cada `Bg=600` frames (10 s). El cliente compara con su propio estado y, si el
resultado cambia, envía `SetPlayerSync(desync)`. node-haxball añade además (fuera de replays) el estado completo como
datos extra en `CheckConsistency` para depurar.

---

## 5. Estadios

### 5.1 Formato `.hbs` (JSON5)

Se parsea con `JSON5.parse` (`w.kh`). Claves de primer nivel reconocidas:

| Clave | Tipo / valores | Por defecto |
|---|---|---|
| `name` | string | — |
| `width`, `height` | número (límites de cámara) | — |
| `maxViewWidth` | número | 0 |
| `cameraFollow` | `"player"` → 1; otro → 0 | 0 |
| `spawnDistance` | número | 200 |
| `bg` | `{type:"grass"/"hockey"/otro, width, height, kickOffRadius, cornerRadius, goalLine, color}` | color `0x718C5A` (7441498) |
| `canBeStored` | bool | true |
| `kickOffReset` | `"full"` → true; otro → partial | partial |
| `traits` | objeto `{nombre: {props…}}` | — |
| `ballPhysics` | objeto de disco, o `"disc0"` (usar el primer disco de `discs` como balón) | disco por defecto |
| `vertexes` | `[{x,y,bCoef,cMask,cGroup,trait}]` | |
| `segments` | `[{v0,v1,bias,bCoef,curve,curveF,vis,color,cMask,cGroup,trait}]` | |
| `goals` | `[{p0:[x,y],p1:[x,y],team:"red"/"blue"}]` | |
| `discs` | `[{pos,speed,gravity,radius,bCoef,invMass,damping,color,cMask,cGroup,trait}]` | |
| `planes` | `[{normal:[x,y],dist,bCoef,cMask,cGroup,trait}]` | |
| `joints` | `[{d0,d1,length:(num | [min,max] | null=distancia actual),strength:("rigid" | num),color}]` | |
| `redSpawnPoints`, `blueSpawnPoints` | `[[x,y],…]` | |
| `playerPhysics` | `{bCoef,invMass,damping,acceleration,kickingAcceleration,kickingDamping,kickStrength,gravity,cGroup,radius,kickback}` | |

Reglas relevantes:

* `trait`: copia al objeto las propiedades del *trait* que el objeto no define (`w.tg`).
* Colores (`w.Tc`): `"transparent"` → −1; string hexadecimal `"RRGGBB"`; o `[r,g,b]`.
* Flags de colisión (`w.Ua`) — array de nombres: `ball`=1, `red`=2, `blue`=4, `redKO`=8, `blueKO`=16, `wall`=32,
  `kick`=64, `score`=128, `c0`=2²⁸, `c1`=2²⁹, `c2`=2³⁰, `c3`=−2³¹, `all`=63.
* El balón (si `ballPhysics≠"disc0"`) se inserta como disco 0 con `cGroup |= 192` (kick|score); por defecto
  `radius 10, bCoef 0.5, invMass 1, damping 0.99, color 0xFFFFFF, cMask 63, cGroup 193`.
* `curve` (grados) se convierte a `curveF = 1/tan(curve/2)` solo si 10° < |curve| < 340°; curva negativa intercambia v0/v1.
* Máximo 255 elementos por lista (vértices, segmentos, planos, metas, discos); al menos 1 disco; `bg.cornerRadius`, `bg.kickOffRadius` y `playerPhysics.radius` ≥ 0 (`"Invalid stadium"`).

### 5.2 Estadios por defecto (por índice)

`w.Fd()` los genera por código: `0 Classic, 1 Easy, 2 Small, 3 Big, 4 Rounded, 5 Hockey, 6 Big Hockey, 7 Big Easy, 8 Big Rounded, 9 Huge`.
En binario un estadio por defecto es **un único byte** con su índice.

### 5.3 Serialización binaria del estadio (`w.G` / `w.oi`)

```
u8  defaultStadiumId          255 = personalizado; 0..9 = por defecto (y no sigue nada más)
--- solo si 255 ---
nullableString name
i32  bgType                   0 none, 1 grass, 2 hockey
f64  bgWidth
f64  bgHeight
f64  bgKickOffRadius
f64  bgCornerRadius
f64  bgGoalLine
i32  bgColor
f64  width
f64  height
f64  spawnDistance
PlayerPhysics
u16  maxViewWidth
u8   cameraFollow
u8   canBeStored
u8   fullKickOffReset
u8 n + n × Vertex
u8 n + n × Segment
u8 n + n × Plane
u8 n + n × Goal
u8 n + n × Disc               (§4.4)
u8 n + n × Joint
u8 n + n × (f64 x, f64 y)     redSpawnPoints
u8 n + n × (f64 x, f64 y)     blueSpawnPoints
```

Sub-estructuras:

| Estructura | Layout (BE) |
|---|---|
| **PlayerPhysics** (`Qa`) | `f64 bCoef, f64 invMass, f64 damping, f64 acceleration, f64 kickingAcceleration, f64 kickingDamping, f64 kickStrength, f64 gravity.x, f64 gravity.y, i32 cGroup, f64 radius, f64 kickback` |
| **Vertex** (`C`) | `f64 x, f64 y, f64 bCoef, i32 cMask, i32 cGroup` |
| **Segment** (`E`) | `u8 flags` (bit0 bias, bit1 curveF≠∞, bit2 color≠0, bit3 vis), `u8 v0`, `u8 v1`, [`f64 bias`], [`f64 curveF`], [`i32 color`], `f64 bCoef, i32 cMask, i32 cGroup` |
| **Plane** (`K`) | `f64 normal.x, f64 normal.y, f64 dist, f64 bCoef, i32 cMask, i32 cGroup` |
| **Goal** (`xa`) | `f64 p0.x, f64 p0.y, f64 p1.x, f64 p1.y, i8 team` |
| **Joint** (`Ha`) | `u8 d0, u8 d1, f64 minLength, f64 maxLength, f64 strength (∞ = rígido), i32 color` |

Por la red el estadio viaja: (a) dentro del RoomState (sin comprimir, ya que el snapshot entero va deflado), y
(b) en `SetStadium` como `u16 len + deflateRaw(Stadium)`. Tras deserializar se recalculan las geometrías
derivadas de segmentos curvos (`this.Pb()`) y se valida.

---

## 6. Formato de replay `.hbr2`

Grabador `cb` (oficial) y `Replay.read/readAll/writeAll` de node-haxball (`Da`/`Qa` + callbacks `ma`/`Sa`/`ya`/`Bk`).

```
"HBR2"            4 bytes ASCII (sin prefijo de longitud)  = u32 BE 0x48425232 (1212305970)
u32  version      = 3 (node-haxball rechaza otras)
u32  totalFrames  (frame final − frame inicial)
deflateRaw(
   u16 goalMarkerCount
   goalMarkerCount × { varuint deltaFrame, u8 teamId }
   RoomState                         (§4.1, al inicio de la grabación)
   { varuint deltaFrame, u16 byId, u8 eventType, payload }*   hasta el final
)
```

```js
// headless.ts — cb.stop()
this.Jb.j.setUint16(0,this.eg,this.Jb.ra);this.Jb.qb(this.yc.Db());
let a=pako.deflateRaw(this.Jb.Db()),b=A.aa(a.byteLength+32);b.he("HBR2");b.xa(this.version);b.xa(this.pe.da-this.ud);b.qb(a)
// api.js — validación de cabecera
if (G.qM() != 1212305970) throw ""; var k = G.qM(); if (k != 3) throw …
```

Notas:

* Los `deltaFrame` son relativos al evento/gol anterior (el primero, relativo al frame inicial).
* Los eventos de replay **no** llevan `orderInFrame` ni `clientSeq` (a diferencia del EventFrame de red).
* Los marcadores de gol se registran con `zf(d.P)` donde `d` es el equipo **dueño de la portería** en la que entró el balón
  (node-haxball lo llama `teamId`) (**no verificado** cómo lo interpreta la UI oficial).
* No hay snapshots intermedios: para saltar en el tiempo hay que re-simular desde el RoomState inicial
  (lo confirma el README de node-haxball: *"the game state data is generated on the fly"*).
* La extensión `.hbr2` es la del cliente oficial; el contenido se identifica por la magia `HBR2` (**no verificado** si existen variantes `.hbr` antiguas compatibles; node-haxball solo soporta versión 3).

---

## 7. Extra: RoomInfo y lista de salas

**RoomInfo** (`ab.G`, **little-endian**), enviado por el host al servidor en el WS msg `7`:

| Campo | Tipo |
|---|---|
| `version` | u16 LE (=9) |
| `name` | `u8 len` + UTF-8 (≤40) |
| `flag` | `u8 len` + UTF-8 (≤3) |
| `lat` | f32 LE |
| `lon` | f32 LE |
| `password` | u8 |
| `maxPlayers` | u8 |
| `players` | u8 |

**`/rs/api/list`** (node-haxball `Ak`): `u8` (versión/ignorado) y luego, hasta el final,
`u16 BE len + roomId`, `u16 BE len + RoomInfo` (LE).

---

## 8. Puntos inciertos / pendientes

* Semántica exacta de `ca` (`PM` en node) en la configuración de acciones: se interpreta como "aplicar de forma predictiva en el cliente" **(no verificado)**.
* Campo `i32` sin nombre en Player (`Ai`/`la`) **(no verificado)**.
* Significado de los códigos de cierre WebSocket `4001` / `4004` **(no verificado)**.
* La parte servidor de señalización (`p2p.haxball.com`) no es pública: los formatos srv→host/cliente se infieren de lo que leen los clientes; que el servidor anteponga `connId`/IP y los quite en sentido inverso es una inferencia coherente con el código **(no verificado)**.
* Los nombres minificados del headless cambian con cada build (este análisis: hash `f066733d`, cache `H4mQWPXF`).

---

## Fuentes

* `mertushka/haxball.js` — commit `e5231b0628bff591573c192a037d9d904f444683` (v5.1.0): https://github.com/mertushka/haxball.js
  * `src/generated/headless.ts` (script headless oficial, *source hash* `f066733d`). Fragmentos citados (grep sobre el original): `m.$(Z);m.$(Ca);m.$(ma)`, `kb.channels=[{name:"ro"`, `b.f(2);this.rf(a,b)`, `a.f(3);a.xa(this.da);a.xa(this.od)`, `c.Oa(a.P);c.xa(this.da)`, `a.f(this.Ed);if(!this.gh())`, `b.he("HBR2")`, `eb=new cb(D,3)`, `this.Tg=new Ra(100,16)`, `this.Be=.06`, `version:9`, `new Uint8Array(51200)`, `Fa.U=m.Z({ca:!1,delay:!1,ue:{je:2,ye:1E4}})`.
  * `src/pako.ts` (adaptador `deflateRawSync`/`inflateRawSync` de `node:zlib`), `src/runtime.ts`.
* `wxyz-abcd/node-haxball` — commit `4d4b88f1e5e25d484d27819ee6a4699720bda164` (v2.3.1): https://github.com/wxyz-abcd/node-haxball
  * `src/index.d.ts`: `enum OperationType` (IDs 0–26), clases `*Event`, `GameState`, `GamePlayState`, `Impl.Stadium.Stadium`, `ErrorCodes`.
  * `src/api.js` (formateado con prettier): `G.qM()!=1212305970`, `G.CI("HBR2"),G.AM(3)`, `f.$(2),f.J(I),f.gM(a)` (ping), `N.$(1),N.AM(h),N.AM($)` (acción de cliente), `"idkey"` (formato de clave de identidad), `p2p.haxball.com`, tablas de nombres `ak(...)`/`E(W, [], ["version","name","flag",...])`.
  * `README.md` (secciones `Replay`, `ReplayData`, `onOperationReceived`).
