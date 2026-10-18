# 01 — Arquitectura de red y ciclo de vida de las salas

> Investigación basada en código abierto público y en los recursos estáticos públicos de haxball.com.
> No se ha creado ninguna sala ni se ha intentado conectar a salas reales. Las únicas peticiones
> hechas a haxball.com fueron GET a recursos públicos (`cache_hash.json`, páginas HTML/JS estáticas,
> `/rs/api/geo`, `/rs/api/notice` y `/rs/api/list`).
>
> Versiones analizadas:
> - `haxball.js` (mertushka) commit `e5231b0` — envuelve el **headless oficial**: cache hash `H4mQWPXF`, source hash `f066733d`.
> - `node-haxball` (wxyz-abcd) commit `4d4b88f` — reimplementación, `version: "2.3.1"`.
> - Cliente web oficial `game-min.js` (descargado de `https://www.haxball.com/H4mQWPXF/__cache_static__/g/game-min.js`), source hash `0349dd60`.
>
> Convención: los nombres minificados (p. ej. `Aa`, `la`, `Wa`) son los del headless oficial
> (`haxball.js/src/generated/headless.ts`) salvo que se indique otra cosa. Lo marcado como
> **(no verificado)** es inferencia razonable que no se ha podido confirmar en código.

---

## 0. Resumen ejecutivo

- **Topología en estrella, host autoritativo.** Cada cliente abre una única `RTCPeerConnection` con el
  host. No hay conexiones cliente↔cliente ni servidor de juego: el host simula y retransmite.
- **Servidor maestro (backend)** en `https://www.haxball.com/rs/` (HTTP) y
  `wss://p2p.haxball.com/` (WebSocket). Sólo hace: listado de salas, geolocalización, emisión de
  tokens (reCAPTCHA / Turnstile), y **señalización** WebRTC (relay de SDP/ICE entre cliente y host).
- **Señalización binaria** por WebSocket: el host mantiene un WS permanente a `.../host?token=…`; cada
  cliente abre un WS efímero a `.../client?id=<roomId>[&token=…]`. Las cargas útiles van comprimidas
  con `deflateRaw` (pako).
- **WebRTC**: 3 data channels *negociados* (`negotiated: true`, ids 0/1/2): `ro` (fiable+ordenado),
  `ru` (fiable, no ordenado), `uu` (no fiable, no ordenado). STUN: `stun:stun.l.google.com:19302`.
  Sin TURN.
- **Control de admisión** en el host, **antes** de crear la conexión WebRTC: sala llena (4100),
  contraseña incorrecta (4101), baneado (4102), versión incompatible (4103), demasiadas
  negociaciones simultáneas (4104).
- **Identidad**: clave ECDSA **P‑256** generada en el navegador (`player_auth_key` =
  `idkey.<x>.<y>.<d>`). El host envía un *challenge* aleatorio de 8 bytes; el cliente lo firma
  (ECDSA/SHA‑256). `player.auth` = coordenada `x` de la clave pública (base64url, 43 caracteres).
  `player.conn` = IP del cliente vista por el maestro, en texto ASCII codificado en hexadecimal.
- **Versión de protocolo = 9** (u16), presente en la petición de unión y en la ficha de la sala del
  listado.

---

## 1. Servidor maestro (backend HTTP)

### 1.1 Constantes base

Headless oficial (`headless.ts`, pretty-print ~l.5423):

```js
za.Le = 'https://www.haxball.com/rs/';
za.Ld = [{ urls: 'stun:stun.l.google.com:19302' }];
T.hg  = 'application/x-www-form-urlencoded';
```

Cliente web oficial (`game-min.js`):

```js
m.Js="wss://p2p.haxball.com/"; m.Se="https://www.haxball.com/rs/"; m.kg=[{urls:"stun:stun.l.google.com:19302"}];
```

node-haxball (`api.js`, objeto de configuración global `EWG`):

```js
rE: { ja: "www.haxball.com", JP: "p2p.haxball.com", zG: !0 },   // hostname, hostnameWs, secure
DP: 9,                                                           // version
Wk: [{ urls: "stun:stun.l.google.com:19302" }],
...
W.jP = (W.rE.zG ? "wss" : "ws") + "://" + W.rE.JP + "/",         // base WS
W.bI = W?.gE?.wc || (W.rE.zG ? "https" : "http") + "://" + W.rE.ja + "/rs/"   // base HTTP
```

(El README de node-haxball menciona `wss://p2p2.haxball.com/` para clientes, pero tanto el código de
node-haxball como el cliente oficial actual usan `wss://p2p.haxball.com/` para ambos roles.)

### 1.2 Lista de endpoints

| Método | URL | Cuerpo / query | Respuesta | Quién lo usa |
|---|---|---|---|---|
| GET | `https://www.haxball.com/cache_hash.json` | — | string JSON, p. ej. `"H4mQWPXF"` (prefijo de los estáticos `/<hash>/__cache_static__/g/…`) | páginas `/play`, `/headless` |
| GET | `/rs/api/list` | — | binario `application/octet-stream` (ver §1.3) | cliente (lista de salas), `Utils.getRoomList()` |
| GET | `/rs/api/geo` | — | `{"data":{"code":"US","lat":39.96,"lon":-82.99}}` | host y cliente (bandera/ubicación por IP) |
| GET | `/rs/api/notice` | — | `{"data":{"content":""}}` (aviso HTML para el cliente) | cliente web |
| POST | `/rs/api/host` | `token=<tok>&rcr=<captcha>` (form-urlencoded) | `{"data":{"action":"connect","url":<wsUrl>,"token":<wsTok>}}` o `{"data":{"action":"recaptcha","sitekey":…}}` | host (crear/re-anunciar sala) |
| POST | `/rs/api/client` | `room=<roomId>&rcr=<captcha>` | `{"data":{"action":"connect","token":…}}` o `{"data":{"action":"recaptcha","sitekey":…}}` | cliente, sólo si la sala exige captcha (cierre 4004) |
| POST | `/rs/api/getheadlesstoken` | formulario con respuesta del captcha | token headless (formato **no verificado**; históricamente `thr1.…`) | página `https://www.haxball.com/headlesstoken` |
| WS | `wss://p2p.haxball.com/host?token=<wsTok>` | — | protocolo binario §2.2 | host |
| WS | `wss://p2p.haxball.com/client?id=<roomId>[&token=<tok>]` | — | protocolo binario §2.3 | cliente |
| — | `https://www.haxball.com/play?c=<roomId>[&p=1]` | — | enlace de la sala (`p=1` ⇒ con contraseña) | `F.uh()` en headless |
| — | `https://www.haxball.com/playerauth` | — | página que muestra/genera la clave de identidad del jugador | usuario |

Todas las respuestas JSON siguen el sobre `{data: …}` / `{error: …}`: helper `T.Rg`/`T.Ih` del headless
(`let c = b.error; if (null != c) throw …; return b.data;`).

Nota sobre el captcha: el headless oficial y el cliente cargan **Google reCAPTCHA v2**
(`https://www.google.com/recaptcha/api.js?onload=___recaptchaload&render=explicit`), pero la página
`/headlesstoken` actual usa **Cloudflare Turnstile** (`challenges.cloudflare.com/turnstile/v0/api.js`,
`data-sitekey="0x4AAAAAAB9wKqpkUhNzqheb"`) y envía el formulario a `/rs/api/getheadlesstoken`.
El `tokenGenerator` de node-haxball (NW.js) documenta el par
`formAction: ["rs/api/getheadlesstoken", "rs/api/client"]`, `captchaName: ["g-recaptcha-response", "rcr"]`.

El maestro valida el **Origin**: node-haxball necesita un proxy o la extensión
`haxballOriginModifier` (que fuerza `Origin: https://www.haxball.com`) para usarse desde otro
dominio, y haxball.js abre el WS con `headers: { origin: 'https://html5.haxball.com' }`
(`src/runtime.ts`).

### 1.3 Formato binario de `/rs/api/list`

Parser oficial (`game-min.js`, clase `Qb.parse`) y node-haxball (`Ak:` en `api.js`):

```js
static parse(a) {            // a = lector big-endian
  a.F();                     // u8 cabecera (valor 0 observado)
  for (; 0 != a.s.byteLength - a.a;) {
    let c = a.se(a.Sb()),    // u16 BE longitud + id de sala (UTF-8)
        d = a.cm(a.Sb());    // u16 BE longitud + bytes de la ficha
    let e = new Rb; e.na(new J(new DataView(d), !1)); ...
```

Ficha de sala (`Rb.na` en el cliente, `ab.G` en headless — **little-endian**, `a.ra = !0` / `a.Ua = !0`):

```
offset  tipo         campo           notas
0       u16 LE       version         9 (el cliente marca "old" si < 9 y rechaza si != 9)
2       u8 + bytes   name            UTF-8, recortado a 40 caracteres
.       u8 + bytes   flag            código de país, <= 3 caracteres
.       f32 LE       lat
.       f32 LE       lon
.       u8           password        0/1 (lo declara el host; node-haxball permite fakePassword)
.       u8           maxPlayers      el cliente descarta la sala si > 30
.       u8           players
```

Formato completo del listado:

```
u8 0x00
repetir hasta EOF:
   u16 BE idLen  | id (UTF-8, 11 caracteres observados, p. ej. "UquwOEmuJeA")
   u16 BE dataLen| ficha (formato anterior)
```

Validado contra una descarga real de `/rs/api/list` (75 177 bytes, 1 047 salas, todas con
`version = 9`, ninguna ficha con bytes sobrantes). Script de comprobación en el scratchpad
(`scripts/parselist.py`). El cliente calcula la distancia con la fórmula del coseno esférico y radio
6378 km (`Qb.vt`; node-haxball `Pq`/`calculateAllRoomDistances`), con 22 000 km como valor por defecto.

### 1.4 Cómo se anuncia una sala y se mantiene viva

No hay "pings HTTP" al maestro: todo pasa por el **WebSocket de host**, que permanece abierto toda la
vida de la sala.

- La ficha de sala (§1.3) se genera en `F.fi` → función `b()` cada vez que cambia algo (nombre,
  contraseña, número de jugadores…) y se envía como mensaje **7** (`Aa.ae` / `Aa.Yd`). Si la sala es
  privada (`public: false`) `b()` no hace nada ⇒ el maestro nunca recibe ficha y la sala **no aparece
  en el listado**, aunque sigue siendo accesible por enlace.
  - Anti‑spam: sólo se envía si los bytes cambian; tras un envío, los cambios siguientes se agrupan
    en una ventana de 10 s (`window.setTimeout(…, 1e4)`).
- Keep‑alive: mensaje **8** (1 byte) cada 40 s (`this.Dh = window.setInterval(…Yh…, 4E4)`).
- Modo captcha para clientes: mensaje **9** `[9][u8 on]`, con *debounce* de 1 s (`$d`), activado por
  `room.setRequireRecaptcha(bool)`.
- Reconexión: si el WS se cierra con un código distinto de **4001**, se reintenta todo el flujo
  (`POST /rs/api/host` + WS) tras `10 000 + random()*50 000` ms (`this.Sh = 1e4`, `this.Th = 5e4`,
  `Aa.Gd`). Se reutiliza el último token recibido por el mensaje **6** (`Yg`: `this.nc = a.bd(...)`).
  El maestro vuelve a mandar el enlace (mensaje 5) y se llama de nuevo a `onRoomLink`
  (documentado en `index.d.ts`, `onRoomLink`). Si el id de sala se conserva tras la reconexión:
  **(no verificado)**.

### 1.5 Flujo del token headless

```
 Usuario          haxball.com/headlesstoken        Script headless (host)           Maestro
   |  resuelve Turnstile/captcha  |                         |                          |
   |----------------------------->| POST /rs/api/getheadlesstoken                       |
   |<--------- token (caduca en minutos, según wiki) -------|                          |
   |  HBInit({token, ...})  ---------------------------->   |                          |
   |                                                        | POST /rs/api/host        |
   |                                                        |  token=<tok>&rcr=        |
   |                                                        |------------------------->|
   |                                                        |<- {action:"connect",     |
   |                                                        |    url, token:wsTok}     |
   |                                                        |   (o {action:"recaptcha",|
   |                                                        |    sitekey} si el token  |
   |                                                        |    no vale)              |
   |                                                        | WS url?token=wsTok       |
   |                                                        |=========================>|
   |                                                        |<== [5][u8 len][roomId]   |  -> onRoomLink(https://www.haxball.com/play?c=roomId)
   |                                                        |<== [6][nuevo token]      |  (para reconectar)
   |                                                        |==> [7][ficha sala]       |
   |                                                        |==> [8] cada 40 s         |
```

Código (headless, clase `Aa`, método `be`):

```js
T.Ih(this.di, 'token=' + this.nc + '&rcr=' + a, T.hg).then(function (e) {
  switch (e.action) { case 'connect': c(e); break; case 'recaptcha': b(e); }
})
// c(e):
d.ua = new WebSocket(f + '?token=' + e);   // f = e.url, e = e.token
d.ua.binaryType = 'arraybuffer';
d.ua.onclose = function (g) { d.Gd(4001 != g.code); };
```

- Sin token, el headless muestra un reCAPTCHA (`ya.jh()` + `F.bi`) y reintenta con `rcr=<respuesta>`.
- haxball.js no puede resolver captchas en Node: intercepta la respuesta en `HaxballXMLHttpRequest`
  (`isRecaptchaResponse`) y lanza `InvalidRoomTokenError` ("Generate a new token at
  https://www.haxball.com/headlesstoken").
- node-haxball expone `Utils.refreshRoomToken({token, rcr})` (sólo `POST api/host`) y
  `Utils.generateRoomId({token})` (abre el WS de host, espera el mensaje 5 y cierra), además de
  `room.useRecaptchaToken`.
- La URL WS devuelta por `api/host` no se ha observado directamente; node-haxball le añade `host` si
  no termina así (`cM.endsWith("host") || (… cM += "host")`), lo que sugiere
  `wss://p2p.haxball.com/host` **(no verificado)**.

---

## 2. Señalización (WebSocket)

### 2.1 Codificación común

Lector/escritor binario (`L` / `A` en headless; `nW`/`LW` en node-haxball). Por defecto
**big-endian** (`DataView` con `littleEndian = false`), salvo la ficha de sala.

| Escritor (`A`) | Lector (`L`) | Tipo |
|---|---|---|
| `f` | `C` | u8 |
| `Oa` | `lc` | u16 |
| `w` / `xa` | `I` / `Qb` | i32 / u32 |
| `fe` / `g` | `Oh` / `s` | f32 / f64 |
| `Fa` | `ob` | varint (LEB128 sin signo, ≤5 bytes) |
| `Vb` | `nb` | string UTF‑8 con longitud varint |
| `Ea` | `Ya` | string anulable (varint = len+1, 0 = null) |
| `Vf` | (`bd(C())`) | string con longitud u8 (≤255 bytes) |
| `Uf` | `yf` | JSON serializado como string varint |
| `qb` | `Ga` | bytes crudos |

### 2.2 WebSocket del host (`Aa` en headless; `Fa`/`E` en node-haxball)

**Maestro → host** (`Aa.ah`, `switch (a.C())`):

| Tipo | Formato | Significado |
|---|---|---|
| 1 | `u32 peerId`, `u8 len` + `conn` (bytes), `deflateRaw( u8 reverseFlag, string sdpOffer, JSON candidatos[], joinData… )` | nuevo cliente quiere entrar |
| 4 | `u32 peerId`, `deflateRaw( JSON candidato )` | ICE *trickle* del cliente |
| 5 | `u8 len` + `roomId` | id de sala asignado → `onRoomLink` |
| 6 | resto del mensaje = string | token nuevo para reconectar |
| 111 | — | **extensión exclusiva de node-haxball** para backends propios (no existe en el oficial) |

`joinData` (lo que el cliente adjunta a su oferta, §3.3): `u16 version`, `string? password`.

**Host → maestro**:

| Tipo | Formato | Método | Significado |
|---|---|---|---|
| 0 | `u32 peerId`, `u16 código` | `pc` | rechazo (4100–4104) o error de parseo (0) |
| 0 | `u32 peerId` | `qc(0,…)` | fin de la señalización para ese peer (ICE completado, abierto o fallido) |
| 1 | `u32 peerId`, `deflateRaw( string sdpAnswer, JSON candidatos[] )` | `Zh` | respuesta SDP |
| 4 | `u32 peerId`, `deflateRaw( JSON candidato )` | `Xh` | ICE trickle del host |
| 7 | ficha de sala (§1.3) | `Yd` | anunciar / actualizar sala |
| 8 | — | `Yh` | keep‑alive (40 s) |
| 9 | `u8 0/1` | `Df` | exigir captcha a los clientes |

### 2.3 WebSocket del cliente (`dc` en game-min.js; `iI`/`E` en node-haxball)

URL: `wss://p2p.haxball.com/client?id=<roomId>` + `&token=<tok>` si la sala exige captcha
(`g.aa = new WebSocket(a + "client?id=" + c + (null == f ? "" : "&token=" + f))`).

Trama genérica cliente→maestro: `[u8 tipo] + deflateRaw(payload)` (node-haxball `KW`):

| Tipo | Payload | Significado |
|---|---|---|
| 1 | `u8 reverseFlag`, `string sdpOffer`, `JSON candidatos[]`, `joinData` (`u16 version`, `string? password`) | oferta + petición de entrada |
| 4 | `JSON candidato` | ICE trickle |
| 0 | — | ICE del cliente terminado |

Maestro→cliente: `[u8 tipo] + deflateRaw(...)`; tipo **1** = `string sdpAnswer`, `JSON candidatos[]`;
tipo **4** = `JSON candidato`. El maestro **reenvía** la oferta al host añadiendo `peerId` y `conn`
(el payload que recibe el host es el mismo que envía el cliente) **(inferido de la simetría de
formatos, no verificado en el servidor)**.

Códigos de cierre del WS de cliente (`Oc.description` en game-min.js; `mW` en node-haxball):

| Código | Mensaje | Origen |
|---|---|---|
| 4001 | "The room was closed." | maestro (sala inexistente/cerrada) |
| 4004 | (captcha requerido → `MissingRecaptchaCallbackError` en node-haxball) | maestro; el cliente hace `POST api/client` y reintenta con `&token=` |
| 4100 | "The room is full." | host |
| 4101 | "Wrong password." | host (el cliente vuelve a pedir contraseña si no la dio) |
| 4102 | "You are banned from this room." | host |
| 4103 | "Incompatible game version." | host |
| 4104 | "Connection closed (4104)" (sin texto propio) | host: ≥16 negociaciones pendientes |
| otro | "Connection closed (N)" | — |

### 2.4 Diagrama de secuencia completo de entrada a una sala

```
Cliente                      Maestro (p2p.haxball.com)                     Host
  |  GET /rs/api/list (opcional)  |                                          |
  |  createOffer() con 3 DC negociados, setLocalDescription, espera ICE      |
  |  WS /client?id=ROOM[&token]   |                                          |
  |==============================>|                                          |
  |-- [1] deflate(flag,sdp,cands, |                                          |
  |       u16 ver, str? pass) --->|-- [1][u32 peer][conn] deflate(...) ----->|
  |                               |                                          | ¿16 pendientes? -> 4104
  |                               |                                          | ¿conn o IP srflx baneada? -> 4102
  |                               |                                          | ¿sala llena? -> 4100
  |                               |                                          | ¿ver != 9? -> 4103
  |                               |                                          | ¿password != ? -> 4101
  |                               |<-- [0][u32 peer][u16 código] (rechazo) --|
  |<== close(código) =============|                                          |
  |                               |     (si se acepta)                       |
  |                               |                                          | new RTCPeerConnection, 3 DC,
  |                               |                                          | setRemote(offer), createAnswer,
  |                               |                                          | espera ICE ≤500 ms
  |<-- [1] deflate(sdpAnswer,cands) --|<-- [1][u32 peer] deflate(answer,c) --|
  |<-- [4] cand (trickle) --------|<-- [4][u32 peer] cand -------------------|
  |-- [4] cand (trickle) -------->|-- [4][u32 peer] cand ------------------->|
  |-- [0] (ICE cliente listo) --->|                 [0][u32 peer] (fin) <----|
  |                                                                          |
  |================= DTLS/SCTP directo (STUN google) =======================|
  |<------------------ DC "ro": [0][varint 8][challenge 8B] -----------------|
  |-- DC "ro": [0][varint n][auth firmado][varint m][nick,flag,avatar] ----->|
  |                                                    verifica ECDSA, asigna id
  |<------------- DC "ro": [1] deflate(u16 id, estado completo) -------------|
  |   ... estado de juego (ver doc de protocolo de juego) ...               |
```

Estados de conexión del cliente (`ConnectionState` en `index.d.ts`): `ConnectingToMaster = 0`,
`ConnectingToPeer = 1`, `AwaitingState = 2`, `Active = 3`, `ConnectionFailed = 4`,
`TryingReverseConnection = -1`.

**"Reverse connection"**: si la conexión al peer falla después de que el maestro haya respondido,
el cliente reintenta una vez con `reverseFlag = 1` ("Trying reverse connection..."). El host, al ver
el flag, retrasa 2 500 ms la aplicación de los candidatos ICE remotos (`f && (l.Qe = 2500)`), y el
cliente amplía su timeout de 4 s a 10 s (node-haxball: `this.EM.Ii(this.iI ? 1e4 : 4e3)`; opción
`crappy_router`). Es una heurística para NAT difíciles; no hay TURN.

---

## 3. WebRTC y modelo de sala

### 3.1 Configuración

```js
// headless: clase la (conexión entrante en negociación)
this.ka = new RTCPeerConnection({ iceServers: b }, la.Fg);   // b = [{urls:'stun:stun.l.google.com:19302'}]
la.Fg = { mandatory: { OfferToReceiveAudio: !1, OfferToReceiveVideo: !1 } };

Hg(a) {
  let b = this.jb.length,
      c = { id: b, negotiated: !0, ordered: a.ordered };
  a.reliable || (c.maxRetransmits = 0);
  a = this.ka.createDataChannel(a.name, c);
  a.binaryType = 'arraybuffer'; ...
}
kb.channels = [
  { name: 'ro', reliable: !0, ordered: !0 },   // id 0
  { name: 'ru', reliable: !0, ordered: !1 },   // id 1
  { name: 'uu', reliable: !1, ordered: !1 },   // id 2
];
```

- Canales **pre-negociados** por id: los nombres no se transmiten por SCTP DCEP. Prueba de ello:
  node-haxball los llama `c1`, `c2`, `c3` (`K1: [{U:"c1",Ei:!0,Wi:!0},…]`) y es interoperable.
- El cliente crea la **oferta**, el host la **respuesta**.
- Uso de canales (headless `Wa`/`Za.pb(msg, canal)`; si el canal no está abierto se cae al 0):
  - `ro` (0): challenge, autenticación, estado inicial, acciones del cliente, kick/ban, mensajes
    privados del host.
  - `ru` (1): difusión de acciones/eventos a todos (`this.jd(this.Nd(a), 1)`).
  - `uu` (2): sincronización de frame (`[3][u32 frame][u32 …]`, `this.jd(a, 2)`), pings
    (cliente `[2][f64 t][varint ping]` cada 500 ms; host responde `[4][f64 tHost][f64 eco]`).

### 3.2 Topología: estrella con host autoritativo

- El host (`Wa extends Ma`) mantiene `Ha` (lista de conexiones), `yb` (mapa id→conexión). Recibe las
  acciones de cada cliente, las valida (rate limit por tipo de acción, permisos `tb`), les asigna
  frame y las **retransmite** a todos (`jd`). No hay mensajes cliente↔cliente.
- Tick de host: `D.Da()` cada 50 ms; acción de pings de jugadores cada 3 s
  (`D.oc(da.V(D))`); frame de sincronización si han pasado ≥7 frames; *checksum*/consistencia cada
  600 frames (`this.Bg = 600`, `Wh`).
- Límite de mensajes entrantes por conexión: *token bucket* `new Ra(100, 16)` (capacidad 100,
  +1 token cada 16 ms ≈ 62 msg/s); si se excede ⇒ desconexión.
- Timeout de inactividad de un peer conectado: 10 s sin mensajes (`Ya`: `this.Qh = 1e4`).
- Timeout para abrir el canal tras la negociación: 10 s (`la.gi`).
- Errores de protocolo de un cliente ⇒ `Xe` ⇒ cierre + kick con razón **"Bad actor"**
  (`D.lf = … S.V(h, 'Bad actor', !1)`).

Mensajes **host → cliente** por data channel (`er()` en game-min.js / `N$` en node-haxball):

| Tipo | Contenido |
|---|---|
| 0 | `varint len` + challenge (8 bytes = `f64 Math.random()`) |
| 1 | `deflateRaw( u16 tuId, u32 frame, u32 …, varint …, estado de sala, acciones pendientes )` |
| 2 | acción/evento (`u32 frame, varint …, u16 autor, u32 …, acción`) |
| 3 | `u32 frame`, `u32 …` (sincronización) |
| 4 | respuesta de ping |
| 5 | `u8 ban`, `string razón`, `string porQuién` → "You were banned/kicked by X (razón)" |
| 6 | acción dirigida sólo a ese jugador (`Ef`: `sendChat`/`sendAnnouncement` con `targetId`) |

Mensajes **cliente → host**: 0 = auth + datos de jugador (sólo antes de estar admitido), 1 = acción,
2 = ping. Cualquier otro tipo, o bytes sobrantes, ⇒ "Bad actor". (El detalle de acciones y estado
de juego corresponde a otro documento.)

### 3.3 Contenido de la petición de entrada

Se reparte en dos fases:

**Fase A — vía maestro (antes de WebRTC)**, comprobada por `Wa.Xg`:

```js
Xg(a, b) {
  if (this.Ha.length >= this.Xc) return va.zc(4100);                        // capacidad
  try { if (b.lc() != this.si) throw r.l(null); } catch (c) { return va.zc(4103); }   // u16 version
  try { let c = b.Ya(); if (null != this.mb && c != this.mb) throw r.l(null); }
  catch (c) { return va.zc(4101); }                                         // string? password
  return va.Ae;
}
```

Escrito por el cliente oficial (`Ia.Za`): `f.Xb(b.version); f.Eb(b.password);` y por node-haxball
(`wG`): `h.mM(this.hM.tE), h.oE(a)`. La contraseña viaja **en claro** (dentro de TLS hasta el
maestro) y es el maestro quien la reenvía al host.

**Fase B — por data channel `ro`, tras abrirse** (`Wa.Ah` → `Wa.Lh`):

```
host  -> [u8 0][varint 8][8 bytes challenge]
client-> [u8 0][varint authLen][authBlob (0 bytes si no hay clave)][varint infoLen][info]
info  =  string nick (≤25), string flag (≤3), string? avatar (≤2 caracteres)
```

Validación en headless (`D.yh`): `if (25 < t.length) throw 'name too long'`,
`if (3 < G.length) throw 'country too long'`, `if (null != n && 2 < n.length) throw 'avatar too long'`.
Después el host emite la acción de "jugador entra" (`aa.V(id, nick, flag, avatar)`), envía el
estado completo (mensaje 1) y llama a `onPlayerJoin` con `auth` y `conn`.

### 3.4 Kick / ban / contraseña / capacidad

- **Capacidad**: `maxPlayers` se acota a `[2, 30]` en headless (`D.Xc = 2 > B ? 2 : 30 < B ? 30 : B`);
  se comprueba en la fase A (4100) y otra vez al abrirse el canal (`Ah`: si está llena, cierra).
  node-haxball permite `unlimitedPlayerCount` y `fakePassword`.
- **Contraseña**: fase A (4101). `setPassword` vuelve a publicar la ficha (flag `password`).
- **Kick/ban**: la acción de expulsión (`S.V(id, razón, ban)`) se difunde; el host envía el mensaje
  5 al afectado y cierra el peer (`Wa.Mg`). Si es **ban**, guarda (`Aa.vg`):
  - `Bc`: el `conn` (IP vista por el maestro) del jugador;
  - `ac`: todas las IP de candidatos ICE **srflx** del jugador (`Aa.We`: parsea
    `candidate.split(' ')`, campo 4 = IP, campo 7 = tipo, sólo `srflx`).
  En la fase de señalización, `$g` rechaza con 4102 si el `conn` o cualquier IP srflx de la oferta
  están en esas listas; los candidatos *trickle* (`Vg`) con IP baneada se ignoran. `clearBan(id)` /
  `clearBans()` (`Cd` / `Dd`) los eliminan.
  - Consecuencia: el ban oficial es **por IP**, no por `auth` (la wiki lo advierte: el auth sirve
    para identificar cuentas, no para banear). node-haxball añade listas de ban por IP/rango y por
    auth (`BanEntryType { Player=0, IP=1, Auth=2 }`).
- **Rate limit de kicks**: `setKickRateLimit(min, rate, burst)` (acción `fa`).
- **Captcha para entrar**: `setRequireRecaptcha(true)` ⇒ mensaje 9 al maestro ⇒ el maestro cierra con
  4004 a clientes sin token ⇒ el cliente hace `POST /rs/api/client` (`room=…&rcr=…`) y reintenta.

---

## 4. Identidad del jugador (auth)

### 4.1 Clave

- Algoritmo: `{ name: 'ECDSA', namedCurve: 'P-256' }` para la clave y
  `{ name: 'ECDSA', hash: { name: 'SHA-256' } }` para firmar (headless `ua.sg` / `ua.ci`;
  node-haxball `aW` / `ZW`).
- Generación con WebCrypto (`generateKey(…, ["sign","verify"])`, exportación JWK) y persistencia
  en `localStorage["player_auth_key"]` (cliente oficial: `this.Zj = e("player_auth_key", null, 1024)`).
- Formato de texto: `"idkey." + x + "." + y + "." + d` (componentes JWK en base64url). El parser
  rechaza otra forma (`if (4 != a.length || "idkey" != a[0]) return Promise.reject("Invalid id format")`).
- node-haxball: `Utils.generateAuth()` → `[authKey, authObj]`, `Utils.authFromKey(key)`.

### 4.2 Blob firmado (cliente oficial `V.ks`, node-haxball `xM.prototype.yc`)

```
u8   1
u16  len(payload)               (big-endian)
payload = string x (varint) | string y (varint) | challenge (8 bytes)
firma   = resto del mensaje      (ECDSA P-256/SHA-256 en formato WebCrypto, r||s de 64 bytes)
```

### 4.3 Verificación en el host (`ua.ri`)

1. Lee `payload` y `firma`; extrae `x`, `y`, `challenge`.
2. Comprueba que `challenge` coincide byte a byte con el que envió (`b.ec`, que se anula tras usarse:
   evita *replay*).
3. Importa `{kty:'EC', crv:'P-256', x, y}` como clave de verificación y ejecuta
   `crypto.subtle.verify`.
4. Éxito ⇒ `player.auth = x` (43 caracteres base64url = 32 bytes). Fallo ⇒ `auth = null` **pero el
   jugador entra igualmente** (`.catch(function () { return null; })`). La wiki: "Can be null if the
   ID validation fails".

No interviene el maestro: es un esquema *self-signed* tipo TOFU; demuestra posesión de la clave,
no una identidad emitida por HaxBall.

### 4.4 `conn`

- El maestro antepone, en el mensaje 1 al host, `u8 len + bytes`; el host lo convierte a hex
  (`c = R.yi(a.Ga(a.C()))`, `R.yi` = concatenar `qb.Bi(byte)` en hex mayúsculas).
- Esos bytes son la **IP del cliente en texto ASCII**: node-haxball los decodifica con
  `M5: c => c.reduce((l, j) => l + String.fromCharCode(j), "")` y `FI` (hex→texto);
  `Utils.hexStrToNumber(conn)` / `byteArrayToIp` "convierte `playerObject.conn` a una IP legible".
  Ejemplo: `"3132372E302E302E31"` ⇒ `"127.0.0.1"`. No es un hash (aunque la wiki lo describe sólo
  como "identifica la conexión").

---

## 5. Versiones de protocolo

| Elemento | Valor | Dónde |
|---|---|---|
| Versión de juego/red | **9** (u16) | headless `version: 9` y `h.pi = 9`; cliente `version: 9`, `t.Fe = 9`; node-haxball `DP: 9` |
| Versión de replays (.hbr) | 3 | headless `new cb(D, 3)`; node-haxball "Currently, only version 3 is supported" |
| Cache hash de estáticos | `H4mQWPXF` | `cache_hash.json`, cabecera de `headless.ts` |
| Source hash headless / cliente | `f066733d` / `0349dd60` | comentario de cabecera de cada JS |

Gestión de incompatibilidades:
1. **Lista de salas**: el cliente marca con la clase CSS `old` las salas con `version < 9` y, al
   pulsar una con `version != 9`, muestra "Incompatible version — The room is running a different
   version." sin intentar conectar.
2. **Entrada por enlace**: el host compara el `u16` de la petición con su versión (`b.lc() != this.si`)
   y rechaza con **4103** ("Incompatible game version.") antes de crear la conexión WebRTC.
3. node-haxball permite cambiar la versión (`config.version` / `commonParams.version`), lo que de
   facto crea salas aisladas de los clientes oficiales.

No hay negociación de versión ni compatibilidad hacia atrás: es igualdad estricta.

---

## 6. Tiempos y límites (resumen)

| Parámetro | Valor | Código |
|---|---|---|
| Keep-alive host→maestro | 40 s | `setInterval(…, 4E4)` |
| Ventana de agrupación de fichas | 10 s | `setTimeout(…, 1e4)` en `Aa.ae` |
| Debounce de "require captcha" | 1 s | `Aa.$d` |
| Reintento del WS de host | 10–60 s aleatorio | `Sh = 1e4`, `Th = 5e4` |
| Negociaciones simultáneas máx. | 16 | `16 <= this.zb.size` ⇒ 4104 |
| Espera de ICE antes de responder | 500 ms | `ub.li` |
| Retraso de ICE en reverse connection | 2 500 ms | `l.Qe = 2500` |
| Apertura de canal tras señalización | 10 s | `la.gi` |
| Inactividad de peer | 10 s | `Ya.Qh = 1e4` |
| Timeout peer en cliente | 4 s (10 s en reverse) | node-haxball `Ii` |
| Timeout de estado de juego en cliente | 10 s | "Game state timeout" |
| Ping de cliente | 500 ms | `this.Rn = 500` |
| Rate limit de mensajes por peer | 100 tokens, +1/16 ms | `new Ra(100, 16)` |
| Jugadores máx. | 2–30 | `D.Xc` |
| Longitudes | nick 25, país 3, avatar 2, nombre de sala 40 | `D.yh`, `ab.yg` |

---

## 7. Fuentes

Rutas relativas a `$SRC`, el directorio con los fuentes descargados.
Los JS minificados son una sola línea: usar `grep -o '.\{200\}PATRÓN.\{300\}'`.

**Headless oficial** — `$SRC/haxball.js/src/generated/headless.ts` (línea 31):
- Constantes: `za.Le="https://www.haxball.com/rs/"`, `za.Ld=[{urls:"stun:stun.l.google.com:19302"}]`, `kb.channels=`
- Señalización del host (clase `Aa`): `"token="+this.nc+"&rcr="`, `"?token="+e`, `4001!=g.code`, `16<=this.zb.size`, `this.pc(a,4104)`, `"srflx"==b.ni`, `a.f(8)`, `4E4`
- Peer (clase `la`): `negotiated:!0`, `maxRetransmits=0`, `OfferToReceiveAudio`
- Sala host (clase `Wa`): `b.lc()!=this.si`, `va.zc(4103)`, `va.zc(4101)`, `va.zc(4100)`, `Ra(100,16)`
- Auth (clase `ua`): `namedCurve:"P-256"`, `crypto.subtle.verify`
- Ficha de sala (clase `ab`) y API `HBInit` (`F.fi`): `h.pi=9`, `version:9`, `25<t.length`, `"Bad actor"`, `play?c=`
- Copia legible usada en este análisis: `scratchpad/pretty/hl.js` (prettier).

**Runtime de haxball.js** — `$SRC/haxball.js/src/runtime.ts` (`origin: 'https://html5.haxball.com'`,
`isRecaptchaResponse`, `InvalidRoomTokenError`); `$SRC/haxball.js/scripts/update-headless.ts`
(descarga de `cache_hash.json` y del headless).

**node-haxball** — `$SRC/node-haxball/src/api.js` (copia legible en `scratchpad/pretty/api.js`):
- Config: `JP:"p2p.haxball.com"`, `DP:9`, `"api/list"`, `"api/geo"`, `"api/host"`
- Cliente: `"?id="`, `4001:`, `endsWith("client")`; host: `this.Wa(a,4104)`, `case 111`
- Auth: `"idkey"`, `namedCurve:"P-256"`, `generateKey`
- `$SRC/node-haxball/src/index.d.ts`: `enum ConnectionState`, `RoomDataDetails`, `enum ErrorCodes`,
  `BanEntryType`, `Utils.generateAuth/authFromKey/getRoomList/hexStrToNumber/byteArrayToIp/refreshRoomToken/generateRoomId`, `onRoomLink`
- `$SRC/node-haxball/README.md` (§config `backend`/`proxy`, `Room.create`/`Room.join`)
- `$SRC/node-haxball/tokenGenerator/src/index.html` (`rs/api/getheadlesstoken`, `rs/api/client`)
- `$SRC/node-haxball/haxballOriginModifier/src/background.js` (reescritura de `Origin`)

**Recursos públicos de haxball.com** (descargados a `scratchpad/web/`):
- `https://www.haxball.com/cache_hash.json` → `"H4mQWPXF"`
- `https://www.haxball.com/H4mQWPXF/__cache_static__/g/game-min.js` (cliente oficial): `"client?id="`,
  `"api/client"`, `"room="+f+"&rcr="`, `Qb.parse`, `Oc.description`, `"player_auth_key"`, `"idkey."`
- `https://www.haxball.com/headlesstoken` (Turnstile + `/rs/api/getheadlesstoken`)
- `https://www.haxball.com/rs/api/geo`, `/rs/api/notice`, `/rs/api/list` (formato validado con
  `scratchpad/scripts/parselist.py`)
- Wiki: `https://github.com/haxball/haxball-issues/wiki/Headless-Host` (semántica de `auth`, `conn`,
  `token`, `setRequireRecaptcha`)
