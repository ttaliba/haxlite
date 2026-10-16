# 04 — Netcode y sincronización de estado en HaxBall

> Objetivo: explicar con evidencia de código cómo todos los clientes de una sala de HaxBall ven el mismo partido.
> Fuentes analizadas (solo lectura estática, sin conectarse a salas reales):
>
> - **Host oficial (headless)**: `haxball.js/src/generated/headless.ts` (mertushka/haxball.js). Envuelve el script headless **oficial** minificado (salida de Haxe, cabecera `HaxBall © Mario Carbajal`, hash de fuente `f066733d`).
> - **Reimplementación completa (cliente + host)**: `node-haxball/src/api.js` (wxyz-abcd/node-haxball v2.3.1, minificado) y sus tipos documentados `node-haxball/src/index.d.ts`, `README.md` y `examples*/`.
>
> Los números de línea `api.js:NNNN` y `headless.js:NNNN` se refieren a copias formateadas con `js-beautify@1.15.1 -s 2` (el original minificado ocupa una sola línea en `api.js`). Para que se pueda hacer grep sobre los fuentes originales, cada cita incluye además un fragmento literal (p. ej. `this.Sb=2`).
> Lo marcado **(no verificado)** es una inferencia que no he podido confirmar del todo en el código.

---

## 0. Resumen ejecutivo

| Pregunta | Respuesta corta |
|---|---|
| ¿Qué modelo usa? | **Lockstep determinista con el host como secuenciador**. Por la red **no viajan snapshots de estado** durante la partida: solo **eventos** (inputs, chat, cambios de equipo…) a los que el host asigna un **número de frame + un índice de orden**. Todos los pares simulan la misma física a 60 Hz y aplican los mismos eventos en el mismo punto. El único snapshot completo se envía **una vez, al unirse** (comprimido con deflate). |
| ¿Quién decide el frame de un evento? | El **host**. El cliente *propone* un frame (su estimación de "frame del host en el momento de llegada + retardo"); el host lo **recorta** a `[frameActual, frameActual+20]`, lo retrasa si llega tarde, lo hace monótono por cliente y le asigna un orden dentro del frame. |
| ¿Hay rollback? | **No sobre el estado autoritativo.** Ni el host ni los clientes rebobinan el estado confirmado. Un evento que llega tarde se **re-sella hacia delante**. Lo que sí hay es una **extrapolación desechable**: en cada render se copia el estado confirmado y se simulan hacia delante hasta 120 frames (2 s). En la práctica funciona como un "rollback implícito" de la predicción. |
| Predicción | Solo predicen los eventos con el flag `predict` (en `headless` se llama `ca` y en node-haxball `PM`): **SendInput** y **PauseResume**. El input propio se inserta en una lista local de pendientes y se usa en la extrapolación hasta que vuelve el eco del host. Del resto de jugadores se asume que **mantienen su último input** (*dead reckoning*). |
| Avance del estado confirmado en el cliente | El cliente **nunca avanza su estado autoritativo por reloj**. Solo avanza cuando recibe del host un *heartbeat* `(frame, nºTotalEventos)` y comprueba que ya tiene **todos** los eventos anteriores a ese frame. |
| Desync | Cada **600 frames (10 s)** el host emite un evento `CheckConsistency` con un hash de 32 bits (XOR de todas las palabras de 32 bits del estado serializado). El cliente lo compara en el mismo `(frame, orden)`. Si no coincide, emite `SetPlayerSync` (con rate limit). **No hay resincronización automática** del estado. |
| Reloj y ping | Paso fijo de 60 Hz: `frame = floor((performance.now() - t0) * 0.06)`. El cliente envía un ping por segundo por el canal no fiable. El host responde con su frame actual (más el retardo). El cliente mantiene el **percentil 50 ponderado** de 50 muestras, tanto del desfase de reloj como del RTT. El ping que se muestra a los demás lo **declara el propio cliente**. |
| Canales | 3 DataChannels WebRTC: `ro` (fiable y ordenado), `ru` (fiable y desordenado) y `uu` (no fiable y desordenado). Los eventos van por canales fiables. Heartbeats y pings van por `uu`. |
| Autoridad | Validación en el host: límite de inundación por conexión (cubeta de 100 tokens que recupera 1 cada 16 ms), límites por tipo de evento (chat, estadio, sync), eventos solo-host que provocan expulsión ("Bad actor") y comprobaciones de permisos (admin) **dentro de `apply`**, que son deterministas en todos los pares. node-haxball añade el hook `onOperationReceived` para aceptar, rechazar o modificar cada evento antes de sellarlo y difundirlo. |

---

## 1. Mapa de nombres minificados → nombres legibles

Los nombres se han deducido cruzando `index.d.ts` (enum `OperationType`, clases `*Event`, `Player`, `RoomState`), el orden de registro de eventos y el comportamiento observado.

### 1.1 Eventos (base y configuración)

| Concepto | headless oficial | node-haxball `api.js` | Evidencia |
|---|---|---|---|
| Clase base de evento | `class m` | `jM` / fábrica `mM.lM({...})` | `headless.js:19`, `api.js:1186` |
| Frame del evento | `eb` | `dM` | `rf(a,b){b.xa(a.eb);b.Fa(a.fb);…}` / `di:function(a,i){i.AM(a.dM),i.gM(a.WE),…}` |
| Orden dentro del frame | `fb` | `WE` | idem |
| Autor (`byId`) | `B` (u16) | `G` | idem |
| Secuencia local del cliente (eco) | `vi` | `$G` | `e.vi=d` / `h.$G=$` |
| Config. por clase | `sd` (= `Clase.U`) | `iW` | `a.prototype.sd=a.U` |
| Flag "se aplica en la extrapolación (predecible)" | `ca` (por defecto `true`) | `PM` | `static Z(a){null==a.delay&&(a.delay=!0);null==a.ca&&(a.ca=!0);…}` / `N.iW.PM&&N.T(W)` |
| Flag "sellado con retardo de input" | `delay` (por defecto `true`) | `IM` | `a.sd.delay||(b=this.da)` / `a.iW.IM?this.j+this.ZW+this.BE:this.j` |
| Rate limit por tipo | `ue:{je:burst, ye:ms}` | `w5:{s5, e5}` | `na.U=m.Z({…ue:{je:10,ye:900}})` |
| Filtro de permiso host-side | `tb(byId, state)` (lanzar excepción = expulsar) | (integrado en `o`/`T` + hooks) | `Z.U=m.Z({…tb:function(){throw r.l(null)}})` |
| Validación previa a aceptar | `fg(state)` | `c$` → `onOperationReceived` | `na.fg` (hook `onPlayerChat`) |

El índice de tipo sale del orden de registro `vb.Ci()` (`headless.js:1259`): `Z`=0 SendAnnouncement, `Ca`=1 SendChatIndicator, `ma`=2 **CheckConsistency**, `Da`=3 **SendInput**, `na`=4 SendChat, `aa`=5 JoinRoom, `S`=6 KickBanPlayer, `oa`=7 StartGame, `pa`=8 StopGame, `qa`=9 **PauseResumeGame**, `U`=10 SetGamePlayLimit, `V`=11 SetStadium, `ba`=12 SetPlayerTeam, `ra`=13 SetTeamsLock, `ca`=14 SetPlayerAdmin, `Ea`=15 AutoTeams, `Fa`=16 **SetPlayerSync**, `da`=17 **Ping**, `Ga`=18 SetAvatar, `sa`=19 SetTeamColors, `ea`=20 ReorderPlayers, `fa`=21 SetKickRateLimit, `ha`=22 SetHeadlessAvatar, `M`=23 SetDiscProperties. Coincide exactamente con `enum OperationType` de `index.d.ts:15-200`. node-haxball añade 24 CustomEvent, 25 BinaryCustomEvent y 26 SetPlayerIdentity, que solo entienden clientes node-haxball.

### 1.2 Bucle de simulación, host, cliente y utilidades

| Concepto | headless oficial | node-haxball | Evidencia |
|---|---|---|---|
| "Runner" base (cola + avance de frames) | `class Ma extends O` | `function MG` (`zM`) | `headless.js:3697`, `api.js:1572` |
| Frame actual | `da` | `j` | |
| Eventos aplicados en el frame actual | `Ra` | `PE` | |
| Total de eventos aplicados en frames cerrados | `od` | `qG` | |
| Cola ordenada de eventos futuros | `Xd` (`class gb`, `Di()` inserta) | `eW` (`FW`, `Rk()` inserta) | |
| Frames por ms | `Be = .06` | `xE = .06` | `this.Be=.06` / `this.xE=.06` |
| Avanzar N frames | `rg(n)` | `D1(n)` | |
| Insertar o aplicar evento | `Cf(ev)` | `u(ev)` | |
| Extrapolar | (no existe en headless) | `j1(frames, pendientes)` / `cW(ms)` | `api.js:1595` |
| Máximo de frames extrapolables | — | `P5 = 120` | `this.P5=120` |
| **Host** | `class Wa extends Ma` | función `I` (`api.js:2477`) | |
| Retardo de input del host (frames) | `Sb = 2` | `ZW = 4` | `this.Sb=2` / `this.ZW=4` |
| Intervalo de checksum | `Bg = 600` | `yU = 600` | |
| Conexiones / id→conexión | `Ha` / `yb` | `KE` / `DG` | |
| Estado por conexión en el host | `class Za` | función `W` (`api.js:2466`) | |
| ↳ media móvil de "retraso" | `jf = new $a(15)` | `X1 = new Sa(15)` | |
| ↳ último frame asignado | `Id` | `Di` | |
| ↳ limitador antiinundación | `Tg = new Ra(100,16)` | `mU = new bW(100,16)` | |
| ↳ limitadores por tipo | `Ie` (Map) | `m1` (Map) | |
| ↳ ping declarado | `ad` | `SG` | |
| Cubeta de tokens | `class Ra` | `bW` | `headless.js:3528` |
| **Cliente** | — (headless solo es host) | función `W` (`api.js:2860`) | |
| ↳ desfase de reloj (frames) | | `ri = new XW(50)` | |
| ↳ RTT | | `A5 = new XW(50)` | |
| ↳ periodo de ping | | `l$ = 1e3` | |
| ↳ frames por delante (estimación) | | `UW` | |
| ↳ handicap en frames | | `BE` (de `cU(ms)`) | |
| ↳ eventos propios pendientes (predicción) | | `_5` | |
| ↳ heartbeats pendientes | | `fI` | |
| Hash de estado | `Ta.Ve()` / `Qg()` | `r1()` / `DN()` | |
| Comparar hash | `Ta.Eg(buf)` | `pc(hash, estadoCompleto)` | |

Tipos del escritor binario (`class A`, `headless.js:2360`): `f`=u8, `Oa`=u16, `ge`=i16, `w`=i32, `xa`=u32, `fe`=f32, `g`=f64, `Fa`=varint (LEB128), `Vb`=string con longitud varint. En node-haxball los equivalentes son `$`=u8, `AM`=u32, `gM`=varint, `J`=f64 y `mM`=u16 (deducido por simetría con el lector).

---

## 2. El modelo: lockstep determinista con secuenciador central

### 2.1 Qué se simula y dónde

- **Todos** los pares (host y clientes) ejecutan la **misma simulación de física a paso fijo** (60 Hz). El paso es `Ta.Da(1)` → `Q.Da(a)` (`headless.js:918`), con el tiempo de juego `this.Nb += .016666666666666666` (1/60 s por frame).
- El estado **no se replica por snapshots** durante el juego. Lo que se replica son **eventos** (`HaxballEvent`): cambios de input (`SendInput`, una máscara de 5 bits up/down/left/right/kick), chat, cambios de equipo, inicio y parada de partida, etc.
- El host es el **reloj** y el **secuenciador**: decide el par `(frame, orden)` de cada evento. Como todos aplican la misma secuencia ordenada sobre el mismo estado inicial con física determinista (doubles IEEE-754 en JS), todos llegan al mismo estado.
- Evidencia de determinismo: las **repeticiones** (`.hbr`) son solo el estado inicial más la lista de eventos con su frame. El lector de repeticiones (`api.js:1639`, función `i` con `d1()`/`LM()`) re-simula aplicando cada evento cuando `this.yk == this.j`. El README describe `setCurrentFrameNo()` como "*the game state data is generated on the fly*".

### 2.2 El bucle común (`Ma.rg` / `MG.D1`)

```js
// headless.js:3709  (Ma.rg) — equivalente a node-haxball MG.D1 (api.js:1586)
rg(n) {                         // avanzar n frames
  for (k = 0; k < n; k++) {
    while (cola[i] && cola[i].eb == this.da) {   // eventos de ESTE frame, ya ordenados por fb
      cola[i].apply(this.Ca); this.Ra++; i++;
    }
    this.Ca.Da(1);              // un paso de física (1/60 s)
    this.od += this.Ra; this.Ra = 0; this.da++;
  }
  // eventos del nuevo frame actual cuyo orden sea consecutivo
  while (cola[i] && cola[i].eb == this.da && cola[i].fb == this.Ra) { apply; this.Ra++; i++; }
  cola.splice(0, i);
}
Cf(ev) {                         // llega un evento
  if (ev.eb == this.da && ev.fb <= this.Ra) { ev.fb = this.Ra++; ev.apply(this.Ca); }  // es para "ahora"
  else this.Xd.Di(ev);           // inserción ordenada por (eb, fb)
}
```

`gb.Di` (`headless.js:3608`) inserta ordenando por `(eb, fb)`. Si ya existe un evento con el mismo `fb` en ese frame, incrementa `fb` y busca el siguiente hueco libre: **el host asigna así el orden total**.

---

## 3. Protocolo y canales

### 3.1 Canales WebRTC

```js
// headless.js:5094  —  grep: kb.channels=
kb.channels = [{name:"ro", reliable:!0, ordered:!0},   // 0: fiable + ordenado
               {name:"ru", reliable:!0, ordered:!1},   // 1: fiable + desordenado
               {name:"uu", reliable:!1, ordered:!1}];  // 2: no fiable + desordenado
// headless.js:1182 (la.Hg): negotiated:!0, id:índice ;  a.reliable||(c.maxRetransmits=0)
```

`Ya.pb(canal, msg)` (`headless.js:3589`) usa el canal 0 como respaldo si el canal pedido no está abierto: `0!=a&&"open"!=c.readyState&&(c=this.jb[0])`. Además, una conexión se cierra si pasan **10 s sin recibir nada** (`this.Qh=1E4` y `ki()`).

### 3.2 Mensajes host → cliente (primer byte)

| Tipo | Contenido | Canal | Dónde se emite (headless) | Dónde se procesa (cliente, node-haxball `N$`) |
|---|---|---|---|---|
| 0 | Nonce de 8 bytes (reto para la firma de identidad) | 0 `ro` | `Ah()` | `D$` → firma y responde |
| 1 | **Snapshot inicial** (deflateRaw): `u16 tuId, u32 frame, u32 totalEventos, varint eventosEnFrame, RoomState, [eventos futuros...]` | 0 `ro` | `$h()` | `j$` (carga el estado y pone `UW=10`) |
| 2 | **Evento secuenciado**: `u32 frame, varint orden, u16 byId, u32 seqCliente, u8 tipo, payload` | 1 `ru` (eventos) / 0 `ro` (checksum) | `Nd()`/`rf()` | `d$` |
| 3 | **Heartbeat de frame**: `u32 frame, u32 totalEventos` | 2 `uu` | `Zd()` | `Q$` → `V1()` |
| 4 | **Respuesta de ping**: `f64 (frameHost + Sb), f64 eco del tiempo del cliente` | 2 `uu` | `Kh()` | `r$` |
| 5 | Expulsión/desconexión (`u8 ban, string motivo, string autor`) | 0 | `Mg()` | `w$` |
| 6 | Evento **dirigido, fuera de la secuencia** (chat o anuncio privado) | 0 | `Ef()` | `s$` (se aplica de inmediato y sin frame) |

### 3.3 Mensajes cliente → host

| Tipo | Contenido | Canal | Host (headless) |
|---|---|---|---|
| 0 | Respuesta de unión (firma ECDSA P-256 del nonce y datos del jugador) | 0 | `Lh()` |
| 1 | **Evento**: `u32 frameSolicitado, u32 seqLocal, u8 tipo, payload` | 0 `ro` | `Mh()` |
| 2 | **Ping**: `f64 performance.now() local, varint pingMedido` | 2 `uu` | `Kh()` |

En node-haxball: `AW` (`api.js:3023`) construye el tipo 1 con `N.$(1),N.AM(h),N.AM($),FE.l(I,N),this.DE(N)` sobre el canal 0, y `J$` (`api.js:3013`) construye el tipo 2 con `f.$(2),f.J(I),f.gM(a),this.DE(f,2)`.

---

## 4. Cómo asigna el host el frame de un evento de cliente

### 4.1 Código (host oficial)

```js
// headless.js:3958 (Wa.Jh) — por cada mensaje recibido de un cliente
Jh(buf, conn) {
  this.Da();                                 // ¡primero ponerse al día con el reloj!
  if (!conn.Tg.Rf()) throw r.l(1);           // antiinundación (100 de ráfaga, +1 token cada 16 ms)
  switch (u8) { case 1: this.Mh(...); case 2: this.Kh(...); ... }
  if (quedan bytes) throw r.l(2);            // mensaje mal formado
} catch → this.Xe(conn)                      // cerrar conexión y expulsar con "Bad actor"

// headless.js:3994 (Wa.Mh)
Mh(rd, conn) {
  c = rd.Qb();                 // frame que PIDE el cliente  (clientFrameNo)
  d = rd.Qb();                 // seq local del cliente (se devuelve como eco)
  e = m.Ji(rd);                // instancia del evento por tipo
  if (e.sd.ue) { lim = conn.Ie[tipo] ??= new Ra(je, ye); if (!lim.Rf()) throw r.l(3); }
  if (e.sd.tb == null || e.sd.tb(conn.P, this.Ca)) {     // los eventos solo-host lanzan excepción → expulsión
    e.W(rd);                                             // decodificar payload
    objetivo = this.da + this.Sb;                        // frameActual + retardo (2)
    f = clamp(c, this.da, this.da + 20);                 // nunca en el pasado, como mucho 20 frames en el futuro
    g = c - objetivo;                                    // >0: llegó con margen; <0: llegó tarde
    if (e.sd.delay) {                                    // solo SendInput y PauseResume
      if (g < -this.Sb - 3) f = objetivo;                // muy tarde (>5 frames) → re-sellar al objetivo
      else conn.jf.qg(clamp(g, -Sb, Sb));                // media móvil de 15 muestras
      if (f < objetivo && conn.jf.ug() < -0.85) f = objetivo; // cliente crónicamente tarde → sin "atajo"
      if (f < conn.Id) f = conn.Id;                      // monótono por cliente (no reordena sus inputs)
      conn.Id = f;
    }
    e.Fi = g; e.Gi = max(0, f - c);                      // estadísticas (retraso añadido)
    e.vi = d; e.B = conn.P; e.eb = f;
    if (e.fg(this.Ca)) {                                 // validación final (p. ej. hook onPlayerChat)
      this.Cf(e);                                        // aplicar ya o encolar con orden fb
      this.jd(this.Nd(e), 1);                            // difundir a TODOS (incluido el autor) por "ru"
    }
  } else rd.Ga();                                        // permiso denegado sin excepción: se ignora
}
```

Fragmentos para hacer grep en `headless.ts`: `a=this.da+this.Sb;f=this.da;g=this.da+20;f=c<f?f:c>g?g:c`, `if(g<-this.Sb-3)f=a`, `-.85>b.jf.ug()`.
En node-haxball (`api.js:2704`, `i$`) la lógica es idéntica con `ZW=4`: `w<-this.ZW-3?J=d:i.X1.gc(nW(w,-this.ZW,this.ZW)),J<d&&i.X1.Tc()<-.85&&(J=d),J<i.Di&&(J=i.Di)`.

### 4.2 Eventos del propio host

```js
// headless.js:3807 (Wa.oc)       — node-haxball AW (api.js:2530)
oc(ev) { ev.B = 0;
  ev.eb = ev.sd.delay ? this.da + this.Sb + this.Kg : this.da;   // node: j + ZW + BE (handicap)
  this.Cf(ev); this.Zd();                                       // aplicar o encolar y enviar heartbeat
  if (hayClientes) this.jd(this.Nd(ev), 1);
}
```

Los eventos administrativos (`delay=false`) se aplican **en el frame actual del host**. Los clientes los reciben con un frame que, para ellos, todavía está en el futuro de su estado confirmado, porque el estado confirmado del cliente siempre va por detrás del host (§5). Por eso nunca llegan "tarde".

### 4.3 Reloj del host y heartbeats

```js
// headless.js:3830 (Wa.Da) — se llama cada 50 ms (setInterval, headless.js:3413) y en cada mensaje entrante
Da() {
  n = ((performance.now() - this.Lf) * 0.06 | 0) - this.da;  // frames que "debería" llevar
  if (n > 0) this.rg(n);                                     // catch-up: simula TODOS los frames atrasados de golpe
  if (this.da - this.df >= 7)  this.Zd();                    // heartbeat (tipo 3) cada ≥7 frames (7–9: 117–150 ms)
  if (this.da - this.cf >= 600) { this.Zd(); this.Wh(); }    // checksum cada 600 frames = 10 s
}
```

No hay límite de frames en el *catch-up* del host: si el proceso se congela, al volver simula de golpe todo lo pendiente.

**Cadencia real de los heartbeats.** `Da()` corre cada 50 ms (3 frames) y en cada mensaje, así que el heartbeat sale en el primer `Da()` con `da − df ≥ 7`: huecos de **7 a 9 frames** (117–150 ms), no exactamente 7. Además el host manda uno tras cada evento propio (`oc` → `Zd()`, §11).

**haxlite** (`src/host`, detalles en `src/host/README.md`) no tiene un bucle de 50 ms por sala: un único temporizador por proceso despierta en una rejilla absoluta de 60 Hz compartida por todas las salas. Los heartbeats salen en los frames con `(base + frame) % heartbeatFrames === 0`, así que sin *bundling* la cadencia es **exactamente** `heartbeatFrames` (7). Con el backend `rtc`, que agrupa los envíos de una iteración del event loop en un paquete por jugador, el heartbeat que vence en ≤ `floor((heartbeatFrames − 1) / 3)` frames (2) se adelanta y viaja con la difusión del evento de cliente: huecos de **5 a 9 frames**, casi ninguno en un datagrama propio. Catch-ups, `CheckConsistency` y el Ping van en la misma rejilla (≈ 17 despertares/s por proceso con partidas en curso, sin importar cuántas salas); una partida en pausa total no fuerza catch-ups (solo heartbeats). Los clientes oficiales no dependen de la cadencia: solo avanzan al recibir cada heartbeat (§5.1).

---

## 5. Cómo aplica el cliente los eventos en el frame correcto

### 5.1 Recepción

```js
// api.js:2953 (d$)  — evento secuenciado (tipo 2)
d$(rd) { ev = x1(rd);          // {dM: frame, WE: orden, G: byId, $G: seq}
  this.u(ev);                  // aplicar si es para (j, PE) o insertar ordenado en eW
  if (ev.G == this._W)         // ¿es el eco de un evento MÍO?
    this._5.fU(ev.$G);         //   → quitarlo de la lista de predicción local
  this.V1();
}
// api.js:2961 (Q$) — heartbeat (tipo 3)
Q$(rd) { this.fI.push({Y5: rd.u32() /*frame*/, _$: rd.u32() /*totalEventos*/}); this.V1(); }

// api.js:2967 (V1) — ¿puedo avanzar el estado CONFIRMADO?
V1() {
  for (hb of this.fI)
    if (hb.Y5 > this.j &&
        hb._$ == this.qG + this.PE + this.eW.hU(hb.Y5))   // eventos ya aplicados + encolados con frame < Y5
      this.A$(hb.Y5 - this.j);                            // == total del host → no falta ninguno → avanzar
  descartar heartbeats con Y5 <= j;
  this._5.iU(this.j);                                     // limpiar predicciones ya obsoletas
}
A$(n) { this.D1(n); this.UW -= n; }
```

Puntos clave:

1. **El reloj del cliente no avanza el estado autoritativo.** `LM()` del cliente (`api.js:2894`) solo recalcula `UW` (cuántos frames va el host "por delante"). El único camino a `D1()` es `V1()` → `A$()`.
2. **Comprobación de completitud por contador.** Como los eventos viajan por `ru` (fiable pero **desordenado**) y los heartbeats por `uu` (pueden perderse o llegar antes que los eventos), el cliente solo avanza hasta `Y5` cuando el número de eventos que conoce con frame menor que `Y5` coincide con el contador del host. Si falta alguno, espera al siguiente heartbeat. Si se pierde un heartbeat, el siguiente llega 7–9 frames después (§4.3).
3. **No hay "eventos tardíos" en el cliente.** Por construcción el cliente nunca ha simulado más allá de un frame cuyo conjunto de eventos esté completo, así que nunca necesita rebobinar. Si por un error llegara un evento con `dM < j`, se quedaría atascado en la cabeza de la cola (`D1` solo consume `a.dM == this.j`) y bloquearía los demás. Por eso node-haxball expone `room.clearEvents()` ("*can be useful when the game engine is stuck*", README; implementado como `this.I.eW.ME.length = 0`, `api.js:6783`).
4. `s$` (tipo 6) aplica eventos **fuera de la secuencia** (chat o anuncio privado). Solo son válidos si no tocan el estado simulado. Con `executeEventWithTarget` el propio README advierte: "*It will probably cause 'intentional' desync*". Medido en §7.4.

---

## 6. Predicción, extrapolación, retardo de input y handicap

### 6.1 Sellado del input local

```js
// api.js:3023 (cliente AW) — enviar un evento propio
AW(ev) {
  seq = this.q$++;
  frame = ev.iW.IM ? this.j + (this.UW | 0) + this.BE : 0;   // solo los de tipo "delay" llevan frame
  enviar tipo 1 {frame, seq, ev} por "ro";
  if (ev.iW.PM) { ev.$G = seq; ev.G = miId; ev.dM = frame; this._5.Rk(ev); }  // predicción local
}
```

`j + UW` es la **estimación del frame del host en el instante en que el mensaje le llegue, más `Sb`**, porque la respuesta de ping ya incluye `+Sb` (ver §8). Así, si la estimación es buena, el host recibe un `frameSolicitado ≥ da+Sb` y lo respeta tal cual. El cliente predijo exactamente el frame correcto y no hay corrección visible.

El input solo se envía **cuando cambia**, no en cada frame:

```js
// api.js:6492 (_W.LM) — gestor de teclas
LM() { var s = this.Bo.DI; !this.X5 || this.L5 == s || (this.L5 = s, this.X5(SendInput.W(s))); }
```

### 6.2 Extrapolación para el render

```js
// api.js:2899 (cliente cW) — lo que dibuja el renderer: room.extrapolate(ms)
cW(ms = 0) {
  if (!conectado) return this.a;
  frames = (performance.now() + ms) * 0.06 + this.ri.HI(.5) - this.j + this.BE;
  return this.j1(frames, this._5);     // _5 = inputs propios aún sin eco
}
// api.js:1595 (MG.j1)
j1(M, pendientes) {
  if (M <= 0) return this.a;
  M = min(M, 120);                                    // P5: como mucho 2 s
  W = this.a.AE(++this.nk);                           // COPIA del estado confirmado (cacheada por id)
  lista = merge(this.eW /*futuros confirmados*/, pendientes);
  for (f = this.j; f <= this.j + floor(M); f++) {
    for (ev of lista with ev.dM <= f) if (ev.iW.PM) ev.T(W);   // SOLO inputs y pausa
    W.nM(f != this.j + floor(M) ? 1 : M - floor(M));          // último paso fraccionario (render suave)
  }
  return W;                                           // estado "ext" desechable
}
```

- La extrapolación **se recalcula desde cero** en cada `requestAnimationFrame` a partir del último estado confirmado (`AE` copia, `nM` simula). Un fallo de predicción, por ejemplo otro jugador que cambió de dirección, se corrige solo en el siguiente render cuando llega su evento confirmado. Se ve como un pequeño "salto" del disco, sin suavizado (**no verificado** que el renderer oficial no suavice; en node-haxball no he encontrado interpolación de corrección).
- Los eventos que no se pueden predecir (`PM=false`: equipos, estadio, start/stop, etc.) **no** se aplican en la extrapolación. Solo se ven cuando el estado confirmado alcanza su frame.
- El paso fraccionario final (`M - f`) desacopla el render a 60, 144 o más Hz de la física a 60 Hz.

### 6.3 Parámetros del usuario

| Ajuste | Dónde actúa | Rango (cliente original) | Evidencia |
|---|---|---|---|
| **extrapolation** (ms) | Solo el render: se suma a `cW(ms)`. Si es positivo dibuja más "en el futuro"; si es negativo, menos. **No** cambia el frame de los inputs. | −200 … 200 ms | `examples_web/src/game.js:226` "*Extrapolation must be a value between -200 and 200 milliseconds*"; `renderer.extrapolation` → `room.extrapolate(thisRenderer.extrapolation, true)` (`examples/renderers/sandboxRenderer.js:1126`) |
| **handicap** (ms) | `cU(ms)`: `this.BE = ms*0.06|0`. Se suma al frame de **cada input enviado** (más retardo de input) y a la extrapolación. Sirve para igualarse con jugadores de mayor ping. | 0 … 300 ms | `index.d.ts:7549-7555` "*`0` <= `handicap` <= `300`*"; `api.js:1621` `cU:function(M){this.BE=M*this.xE|0,…}` |

### 6.4 Diagrama temporal (ASCII)

Supuestos: RTT del cliente A = 100 ms (6 frames), retardo del host `Sb` = 2, heartbeat cada 7 frames.

```
tiempo real →     t0                 t0+50ms               t0+100ms             t0+150ms
frames host:  100  101  102  103 [104] 105  106  107  108  109  110  111  112  113  114
                                   ▲ llega input A (pedido para 106 = 104+Sb)
Host          ─────────────────────┼─ Mh(): f=clamp(106,104,124)=106 ; g=106-(104+2)=0 ✓
                                   └─► difunde Evento{frame:106, orden:0, byId:A, seq:17} por "ru"
              heartbeat{frame:105,total:N} ──(uu)──► (cada ≥7 frames)

Cliente A (pulsa tecla en t0, su estimación: hostFrame(llegada)+Sb = 101+3+2 = 106)
   confirmado j:  ~98 ................ ~98 ......... salta a 105 al recibir HB y comprobar total
   render:    copia(j) + simula hasta ≈ 106+ (incluye su input PREDICHO en 106) → respuesta instantánea
   t0+100ms:  recibe eco seq:17 con frame 106 → lo quita de _5; ahora está en la cola confirmada

Cliente B (RTT 60 ms)
   recibe Evento(106) en ≈ t0+80ms; su render ya iba por ≈107-108 extrapolando A con el input viejo
   → en el siguiente rAF re-simula desde j con el evento real en 106 → el disco de A "corrige" su posición
```

Retardo efectivo de cada vía (aproximado):

- **Input propio → pantalla propia**: unos 0 ms gracias a la predicción, salvo el handicap.
- **Input propio → estado confirmado del host**: one-way + `Sb` frames (unos 33 ms en el headless).
- **Distancia de extrapolación de un cliente** ≈ (`hostAhora` − `j`) + `Sb` + RTT/2 ≈ RTT + `Sb` + (0…9 frames de heartbeat). Tope: 120 frames.

---

## 7. Detección de desincronización (checksums)

### 7.1 Generación en el host

```js
// headless.js:3925 (Wa.Wh) — cada 600 frames
Wh() { this.cf = this.da;
  ev = new CheckConsistency; ev.eb = this.da; ev.fb = this.Ra++; ev.B = 0;
  ev.qd = this.Ca.Qg();              // 4 bytes: hash del RoomState en ESTE punto exacto
  this.jd(this.Nd(ev));              // canal 0 "ro"
}
// headless.js:2763 (Ta.Ve) — hash
Ve() { h = 0; w = new Writer; this.G(w);          // serializar TODO el RoomState (incl. jugadores, discos, f64)
       for (r = w.reader(); quedan ≥4 bytes;) h ^= r.int32(); return h; }
```

En node-haxball el host hace lo mismo en `M$` (`api.js:2640`): `for(var i=0,f=a.i1();f.c<=f.Q.byteLength-4;)i^=f.Y();`. Si `debugDesync=true`, adjunta además el **estado completo** (`pa.W(f.bG(), this.hM.kI ? a.bG() : null)`).

### 7.2 Comprobación en el cliente

El evento tiene un `(frame, orden)` concreto, así que el cliente lo aplica **exactamente en el mismo punto lógico** de la secuencia y calcula su propio hash:

```js
// headless.js:2773 (Ta.Eg)       — node-haxball pc (api.js:1887)
Eg(buf) { remoto = new Reader(buf).int32(); callback(this.Ve() != remoto); }

// node-haxball, cableado del callback (api.js:6552)
w1: (desync, estadoHost) => {
  if (desync != P.Gc) {
    if (P.kI && desync && estadoHost) P.kI(estadoLocal, estadoHost);  // debugDesync del cliente
    P.Gc = desync; P.e(SetPlayerSync.W(desync));                      // avisa a la sala (solo si CAMBIA)
  }
}
```

- `SetPlayerSync` (tipo 16) cambia el flag `fW` / `me` del jugador en todos los pares. El flag se pone a `true` cuando el hash **no** coincide. Es decir, en la práctica funciona como un flag de "desync", aunque `index.d.ts` lo documente como "*Whether this Player is currently synchronized*" (**no verificado** el sentido exacto que muestra la UI oficial).
- Tiene rate limit: `Fa.U=m.Z({ca:!1,delay:!1,ue:{je:2,ye:1E4}})`, es decir, ráfaga de 2 y 1 cada 10 s.
- `CheckConsistency` solo puede emitirlo el host. Si un cliente lo envía, `ma.U … tb:function(){throw r.l(null)}` provoca su expulsión.

### 7.3 ¿Hay resync?

**No he encontrado ninguna resincronización automática.** El snapshot completo (`$h()` en el host / `G$()` en node-haxball) solo se envía cuando un jugador se une (`Lh` → `$h`). Un cliente desincronizado sigue simulando su estado divergente, avisa con `SetPlayerSync` y, en la práctica, tiene que **reconectarse** para recuperar el estado (**no verificado** en la UI oficial). Las herramientas de depuración de node-haxball (`debugDesync`, `examples/other/compareStates.js`) existen precisamente porque no hay corrección automática.

### 7.4 Eventos para un solo jugador y visuales privados (haxlite)

**Qué hace de verdad `executeEventWithTarget` de node-haxball** (medido con un host node-haxball 2.3.1, dos clientes node-haxball y el `FakeMaster`; host con jugador, los tres en juego):

- El host (`ji(ev, targetId)`, `api.js:2539`) pone `ev.G = 0` y manda al objetivo **solo** `[6][u8 tipo][payload]`. Con `sendInput(8)` el objetivo recibió exactamente `06 03 00000008`: ni frame, ni orden, ni `byId`.
- El cliente (`s$`, `api.js:2960`) lo aplica **al instante** sobre su estado confirmado, con `byId = 0`. El cliente oficial hace lo mismo (`game-min.js` `0349dd60`, `fr(a){a=p.Jj(a);a.P=0;a.Ge=0;a.apply(this.T);…}`).
- Consecuencia: un `SendInput` dirigido **solo puede cambiar el input del jugador del host (id 0)** en el mundo del objetivo. Poner `ev.byId = B` antes de enviarlo no sirve: no viaja. En la prueba, el disco del host avanzó en el mundo del objetivo (−277,5 → −182,3 en 1 s) y siguió quieto en el host y en el otro cliente. Ese input nunca se "deshace", así que el mundo del objetivo **divergió para siempre**: marcó un gol (1-0) que no existe en los demás.
- En el siguiente `CheckConsistency` (≈10,8 s) el objetivo emitió `SetPlayerSync(true)` y **toda la sala** vio su marca de desincronización. Con `noPlayer: true` el evento no tendría efecto alguno (no hay jugador 0).
- Conclusión: no existe "mandar inputs a un jugador" en ningún cliente. Lo que hay es aplicar un evento fuera de secuencia sobre el jugador 0, con desync visible garantizado si toca el estado.

**Por qué el mensaje 6 no sirve para nada que toque la simulación.** El host no sabe en qué punto de la secuencia lo aplica el cliente: su estado confirmado va por detrás un tiempo variable (RTT + *heartbeat*). Si entre medias hay un reinicio de saque, un `StartGame` o un `StopGame`, el resultado cambia según el orden. Ni siquiera con un disco estático puede el host reproducir el mundo del cliente.

**Lo que sí funciona: ranura privada secuenciada + mundo sombra** (`room.haxlite.setDiscPropertiesFor`, `src/host/sequencer.ts` `privateSlot`/`ViewerWorld`):

1. El host reserva **un** hueco normal de la secuencia: frame actual y el siguiente orden, como hace `CheckConsistency` (§7.1). El jugador V recibe ahí un `SetDiscProperties` (solo-host, `byId` 0). Todos los demás reciben **en el mismo `(frame, orden)`** un `SetDiscProperties` con máscara 0, que no hace nada (`Mb.apply` oficial solo asigna los campos presentes). Así los contadores de eventos y los *heartbeats* coinciden para todos: nadie se atasca. El host no aplica nada a su estado.
2. Desde ese momento el host mantiene una **copia exacta del mundo de V**: la ronda de serialización del snapshot de unión. La copia recibe los mismos eventos secuenciados que V y avanza a la vez que la sala, en el mismo bucle (`stepRoom`, ~1 µs/tick por vista).
3. En cada `CheckConsistency` todos reciben el mismo `(frame, orden)`, pero V lleva **el hash de su mundo**. No hay `SetPlayerSync` y nadie ve nada.
4. La vista se descarta sola cuando el mundo de V vuelve a ser idéntico byte a byte al de la sala. Se comprueba tras cada `StopGame`/`StartGame`/`SetStadium` y en cada `CheckConsistency`, así que cubre parar o empezar el juego, cambiar de estadio, un saque que reinicia el disco (`kickOffReset: "full"`) y `clearDiscOverrides`. También se descarta cuando V sale.
5. Solo se aceptan discos **solo visuales**: de estadio, distinto del 0 (el 0 decide el saque y la cámara), que no sean de jugador, sin *joints* y con `cGroup` 0 en todos los mundos. Con `cGroup` 0 nadie choca con él (§ física: hacen falta `a.cMask & b.cGroup` **y** `a.cGroup & b.cMask`), no se puede chutar (`cGroup & kick`) y no marca (`cGroup & score`). Puede moverse y rebotar en paredes (eso solo le afecta a él; la copia lo simula). Cualquier otra cosa se rechaza (por `onError`) salvo `force`. Con `force`, el protocolo sigue siendo consistente, pero V ve otro partido.

Probado con clientes node-haxball reales (`test/api/private-view.test.ts`):

- un disco cambia de posición, radio y color solo para V, y otro disco con velocidad diverge solo para V;
- ningún `SetPlayerSync` durante más de 8 rondas de `CheckConsistency` (intervalo de 30 frames);
- los frames confirmados de todos avanzan;
- discos de jugadores y balón idénticos en los tres clientes en el mismo frame;
- `clearDiscOverrides`, `stopGame` y la salida del jugador cierran la vista;
- control negativo: el mismo cambio enviado como mensaje 6 marca al jugador como desincronizado ante toda la sala en la ronda siguiente.

`examples/among-us-vision.mjs` lo usa para una niebla por habitación y un marcador de tarea, junto con `hidePlayerFor` (jugadores de otras zonas y fantasmas, ver "Jugadores ocultos por espectador"), y también se prueba.

**Orden de dibujo del cliente oficial** (`game-min.js` `0349dd60`, método de render de la vista de juego; el `defaultRenderer` de node-haxball sigue el mismo orden):

1. fondo;
2. segmentos con `vis`;
3. *joints* (sin los de color < 0);
4. flechas de borde de pantalla del balón y de cada jugador fuera de cámara (`wr`/`Jk`);
5. nombres e indicador de chat;
6. halo propio;
7. **discos de jugador**;
8. **el resto de discos** en orden de `world.discs`.

Por tanto **los discos de estadio se dibujan encima de los jugadores**: un disco opaco grande tapa a los jugadores que tenga debajo, y también sus nombres. Basta con ponerlo en el estadio; no hace falta ningún truco de orden en el snapshot. Detalles:

- `color: -1` ("transparente") no rellena, pero sigue trazando el contorno negro (`-1 != (a.S|0) && fill(); stroke()`).
- Un disco con radio negativo no se dibuja y **corta el bucle**: no se dibuja ningún disco de estadio posterior.
- Para ocultar un disco por jugador lo más limpio es aparcarlo fuera del campo (la cámara no sale de los límites del estadio).
- `SetDiscProperties` cambia `x`, `y`, velocidad, gravedad, `radius`, `bCoef`, `invMass`, `damping`, `color`, `cMask` y `cGroup`. Puertas o máscaras de visión pueden mostrarse u ocultarse por jugador cambiando posición, radio o color.

Límites:

- solo hay círculos: segmentos, planos y fondo no se pueden cambiar por jugador, y el estadio es global;
- las flechas de borde pueden delatar a jugadores fuera de la cámara (ver abajo; `hidePlayerFor` las quita);
- cada cambio llega con ≈ 1 RTT + *heartbeat*, porque `SetDiscProperties` no se predice;
- seguir al jugador cuadro a cuadro (un cono de visión pegado a él) cuesta un evento por frame y por jugador: es viable por habitación o zona, no por píxel;
- cada actualización manda además un no-op de 20 bytes a cada otro cliente. Las actualizaciones de varios jugadores en la misma tanda comparten ranura (`HostRoom.batchPrivate`; la fachada `HBInit` agrupa las llamadas consecutivas);
- los espectadores y la grabación `.hbr2` ven el mundo de la sala.

**Flechas de borde del cliente oficial** (`game-min.js` `0349dd60`, `wr`/`Jk`/`Kk`; verificado con el cliente real en Chromium, `scripts/among-us-screenshots.ts`, capturas en `docs/img/among-us/`):

- `wr` llama a `Jk` para el disco 0 (balón, en su color de disco) y para **cada jugador con disco** (`null != e.I`): rojos y azules, compañeros o rivales, y también el propio. Los espectadores no tienen disco, así que no tienen flecha.
- `Jk(pos, color, ancho, alto)` recorta la posición del disco al rectángulo de la vista reducido 25 unidades por lado (`±(ancho/2 − 25)`, `±(alto/2 − 25)` alrededor de la cámara). Si el centro del disco queda a **más de 30 unidades** de ese punto (`900 < dx² + dy²`), dibuja allí un triángulo de 15 × 14 que apunta al disco, con sombra `rgba(0,0,0,0.5)`. Es decir: solo hay flecha si el centro está más de ~5 unidades fuera de la pantalla.
- El color es el del **equipo** (`e.fa.S`): constantes `0xE56E56` (rojo) y `0x5689E5` (azul). `setTeamColors` no lo cambia. El radio, el color y la visibilidad del disco del jugador no importan: con `radius: 0` la flecha sigue (`05-…png`).
- No hay ajuste de sala ni de cliente para quitarlas. `show_indicators` solo controla el icono de "escribiendo" del chat.
- Tamaño de la vista en unidades del mundo, con el área de juego de W × H px CSS (el ajuste "Viewport Mode" del cliente, `view_mode`, que el jugador también cambia **en partida con las teclas 0–7**):
  - Dynamic (por defecto): ≈ 610 · W/H de ancho y 610 · (H − 35 − chat)/H de alto.
  - Restricted 840x410: el lienzo, como mucho 840 × 410.
  - Full z× (1, 1,25 … 2,5): W/z × (H − 35 − chat)/z.
  - `maxViewWidth` del estadio (si > 0) solo **reduce** el ancho visible (acerca la cámara). Nunca lo amplía.
- Cámara (`As`/`Go`): sigue al balón (punto medio balón-jugador, con el jugador dentro de la vista) o al jugador con `cameraFollow: "player"`. Después se limita a `±(width − ancho/2)` usando el `width`/`height` del estadio, y **si la vista es más ancha que `2·width` se queda en x = 0** (lo mismo en y).
- Se dibujan **antes** que los discos de estadio, en coordenadas del mundo: un disco de estadio opaco tapa una flecha igual que tapa a un jugador.

**Cómo evitar que delaten posiciones** (comprobado en el cliente real):

1. **Que el mapa quepa en la pantalla** (sirve): `width`/`height` del estadio iguales a la mitad del mapa y centros de disco dentro de la vista. La cámara queda centrada, nadie está fuera de cámara y no se dibuja ninguna flecha. Con el ejemplo (centros en ±245 × ±115, hace falta una vista de 480 × 230) no hay flechas en Dynamic, Restricted ni en Full 1x–2x con un área de 1000 × 700 (`01`–`03`, `06`).
2. **Niebla como semiplano** (refuerzo): un disco de radio 10000 cuyo borde pasa por la puerta tapa todo lo que hay más allá, también fuera del mapa. Si el jugador acerca la cámara y el mapa ya no cabe, la flecha hacia la sala con niebla cae en el borde de la pantalla y queda **debajo** de la niebla mientras ese borde esté pasada la puerta (`07`). Con la cámara contra la pared del fondo, eso se cumple si el ancho visible es ≥ `width + puerta + 25` (325 unidades en el ejemplo): Full 2,5x a partir de ~815 px de ancho.
3. **Espectadores** (sirve, pero solo para quien ya no juega): un jugador "muerto" movido a espectadores no tiene disco ni flecha.
4. **Propiedades del disco del jugador** (no sirve): son globales y la flecha no mira radio ni color.
5. **Ocultar al jugador para ese espectador** (sirve siempre, con cualquier zoom): `room.haxlite.hidePlayerFor(V, P)`. Es lo que usa ahora el ejemplo. Se explica abajo.

Límite de los puntos 1 y 2: la sala no conoce ni controla el zoom del cliente. Con zoom fuerte en una ventana estrecha (Full 2,5x a 800 px, `08`) el borde de la pantalla cae en el pasillo y las flechas de los jugadores asoman. `04` muestra el problema original: mapa más grande que la vista y niebla circular. Con el punto 5 la misma vista ya no tiene flechas (`09`).

#### Jugadores ocultos por espectador (`hidePlayerFor` / `showPlayerFor`)

Objetivo: que el jugador P sea **del todo invisible para el espectador V** (disco, nombre, avatar y flecha) mientras sigue jugando normal para los demás, y poder devolverlo después. Sin marca de desincronización y sin atascos.

**Candidatos estudiados** (`game-min.js` `0349dd60`, física oficial; los prometedores, probados en el cliente real):

1. **Posición NaN del disco de P en el mundo de V** (elegido). Ver más abajo.
2. **Mover a P a espectadores solo en el mundo de V** (`SetPlayerTeam` en la ranura privada). Descartado:
   - el cliente imprime "P was moved to Spectators" mientras hay partido (`a.Xl = … null != a.M && Hb(e.D + " was moved to " + f.D …)`) y la lista de jugadores lo muestra en espectadores;
   - `SetPlayerTeam` pasa al jugador al final de la lista y su disco nuevo al final de `world.discs`. Al devolverlo, el orden de discos (el orden de las colisiones) ya no es el de la sala: el mundo de V no vuelve a ser idéntico y la posición se restaura en f32.
3. **Esconderlo dentro de la pantalla de V bajo un disco opaco.** Descartado:
   - la sala no sabe qué parte del mapa ve V (zoom), así que el único sitio siempre visible es el propio V, y un disco que tape a P también taparía a V;
   - el nombre se dibuja 50 unidades por debajo del disco;
   - los inputs de P mueven su disco cada tick: la aceleración no depende de `invMass` y `damping` se reescribe cada tick. Haría falta reposicionarlo con un evento por tick y por pareja.
4. **Máscara de visión que sigue a V** (N semiplanos de `cGroup` 0 tangentes a un círculo alrededor de V, con la velocidad de V y refresco periódico). Funciona como efecto visual, pero no oculta de forma fiable:
   - coste medido con el codificador real (`scripts/vision-mask-cost.ts`): 36 B por disco y refresco. Con 10 jugadores, 8 semiplanos y 10 Hz son 80 eventos/s y 2,9 kB/s por cliente, y 29 kB/s de subida en el host. A 20 Hz, 5,8 kB/s por cliente.
   - retraso del centro de la máscara respecto al disco de V, que su cliente predice sin retraso (simulado con la física Classic y entradas aleatorias): a 10 Hz y 100 ms de latencia, media 2,6, p95 5,7 y máximo 10,4 unidades; a 5 Hz y 200 ms, máximo 38. El radio de un jugador es 15.
   - no garantiza nada: si el círculo de visión sale de la pantalla (zoom fuerte), las flechas de borde vuelven a verse.
5. **Alguna propiedad que el render respete.** No hay ninguna:
   - las flechas solo miran `null != e.I` (tener disco);
   - un radio negativo quita el disco (`lm`: `0 > a.V || …`), pero no el nombre ni la flecha;
   - color, `cGroup` y avatar no influyen.

**Por qué NaN funciona en el cliente oficial:**

- **Flecha:** `Jk` recorta `e = a.x − cam.x` con `e > d ? d : e < g ? g : e`. Con NaN las comparaciones son falsas: `e` sigue siendo NaN y `900 < e·e + a·a` es falso. No hay flecha.
- **Disco** (`lm`): `arc(NaN, …)` y `translate(NaN, …)` no hacen nada (la especificación de canvas ignora cualquier argumento no finito), y `fill`/`stroke` pintan un camino vacío. Tampoco hay avatar, que es el relleno del disco.
- **Nombre e indicador de chat** (`yr`): `drawImage(…, NaN, …)` no hace nada.
- **Cámara** (`As`): solo usa el balón y el disco propio, nunca el de P.
- **Física, en el mundo de V:** el disco de P también recibe `cGroup` 0. Sin grupo no choca con discos (hacen falta `a.cMask & b.cGroup` **y** `a.cGroup & b.cMask`), con segmentos, planos ni vértices, nadie lo chuta (`cGroup & kick`) y no marca (`cGroup & score`). `cMask` no sirve, porque el juego lo reescribe cada tick. Lo único que se le hace cada tick es `x = x + xspeed` con velocidad finita.
- **Chute de P** en el mundo de V: es `4 > dist − r − r`, falso con NaN. node-haxball 2.3.1 usa `!(dist − r − r >= 4)`, verdadero con NaN, y convertía el balón en NaN. Por eso V recibe los `SendInput` de P **sin el bit de chute**: es una variante por vista con el mismo (frame, orden). Al ocultar, se le quita también el bit vigente y el de los inputs de P ya encolados (`privateSlotAt`). Así P nunca chuta en el mundo de V, con ningún cliente.

**Determinismo del hash (lo crítico).** El `CheckConsistency` es el XOR de las palabras de 32 bits del estado serializado, **con** las posiciones f64. Una NaN con otro signo u otra carga da otro hash (`test/room/hidden-nan.test.ts`). Por eso V y la copia del host deben tener exactamente los mismos bits:

- En el cable va `Math.fround(NaN)` como f32 `7fc00000`. `getFloat32` la convierte en `7ff8000000000000`, la NaN canónica.
- `NaN + finito` conserva la carga de la NaN en x86 (SSE devuelve el operando NaN) y en ARM (con `FPCR.DN = 0` devuelve el operando; con `DN = 1`, la NaN por defecto, que también es `7ff8000000000000`).
- Las NaN "nuevas" sí dependen de la máquina: `0·∞`, `∞ − ∞`, `sqrt(−1)` y `−NaN` dan `fff8…` en x86 y `7ff8…` en ARM. haxlite nunca guarda una: sin colisiones ni chute no hay ninguna operación que la cree o le cambie el signo.

Medido con `scripts/nan-probe.js`: NaN leída del f32, 200 000 ticks de `x + v` y luego `setFloat64`. Resultado: `7ff8000000000000` y la misma palabra de hash en Node 22 (V8), Chromium 141 (V8), SpiderMonkey 159 y JavaScriptCore (jsvu), todos en x86-64. En los cuatro, las NaN nuevas dieron `fff8…`. ARM no se ha probado en ejecución, solo se ha razonado como arriba.

**Qué hace haxlite** (`HostRoom.setPlayerHiddenFor`, `syncHidden`, `Sequencer.viewVariant` y `privateSlotAt`):

1. **Ocultar:** ranura privada con `SetDiscProperties(P, {x: NaN, y: NaN, cGroup: 0})` para V y un no-op de 20 B para los demás. Desde ese momento hay vista privada: el host simula el mundo de V y le manda su propio hash.
2. **Mantenerlo oculto:** después de cada acción del host y de cada frame simulado, si el disco de P vuelve a ser visible en el mundo de V, se oculta otra vez en el mismo punto de la secuencia. Pasa con un disco nuevo (cambio de equipo, juego nuevo), un saque tras gol o un `setPlayerDiscProperties` global.
3. **Reconciliar:** si un disco que V no oculta difiere entre la sala y el mundo de V (porque P lo empujó o chutó), se manda **a todos** un `SetDiscProperties` con los valores de la sala, redondeados a f32. Lo aplican la sala y todos los mundos. Los espectadores que ocultan o sobrescriben ese disco reciben un no-op en la misma ranura.
4. **Mostrar** (`showPlayerFor`): la reconciliación devuelve a V el disco real de P (posición, velocidad y `cGroup` de la sala en f32). La vista se cierra sola cuando los dos mundos vuelven a ser idénticos byte a byte.
5. **Limpieza:** las parejas terminan con el juego (parar o empezar otro) y cuando sale V o P.

**Pruebas:**

- `test/api/hidden-players.test.ts` (clientes node-haxball reales):
  - P oculto es NaN solo en el mundo de V;
  - P empuja a otro jugador, chuta y cruza un segmento curvo de *bias* negativo;
  - el balón y los demás discos son idénticos en los tres mundos en el mismo frame;
  - más de 8 rondas de `CheckConsistency` sin `SetPlayerSync` y sin atascos;
  - el cambio de equipo se vuelve a ocultar;
  - `showPlayerFor` hace converger la vista;
  - `stopGame` y la salida de V la limpian.
- `test/api/examples.test.ts`: el ejemplo con niebla, jugadores ocultos por zona y fantasmas que atraviesan paredes.
- Cliente oficial real en Chromium (`scripts/among-us-screenshots.ts` con `CHECKSUM=30`): con el jugador oculto moviéndose y chutando, 23 y 28 rondas sin ningún `SetPlayerSync` ni aviso "desynchronized". Capturas:

| Captura | Qué muestra |
|---|---|
| `09-oculto-zoom2.5x-ventana-estrecha-sin-flechas.png` | el caso de `08` (Full 2,5x a 800 px): ya no hay flechas |
| `10-…-vivo-A-no-ve-fantasmas.png`, `12-…-vivo-C-…` | los vivos no ven a los fantasmas B y D aunque están a su lado: ni disco, ni nombre, ni avatar, ni flecha |
| `11-…-fantasma-B-ve-a-todos.png`, `13-…-fantasma-D-…` | los fantasmas se ven entre sí (avatar 👻) y ven a los vivos |
| `14-mapa-grande-sin-ocultar-flechas.png` (control) / `15-mapa-grande-ocultos-sin-flechas.png` | mapa de 3000 × 1400: sin ocultar hay flechas roja y azul; ocultos solo queda la del balón |
| `16-mapa-grande-zoom2.5x-ocultos-A.png` / `17-…-B-ve-a-A.png` | zoom 2,5x: A no ve a nadie; B, en el mismo partido, ve las flechas de A y C |

**Garantías y límites (honestos):**

- **Cliente oficial y física oficial:** comprobado en Chromium. Firefox, Safari y ARM se apoyan en el análisis de NaN de arriba y en la sonda con SpiderMonkey y JSC; el cliente oficial no se ha ejecutado en ellos.
- **No es seguridad.** El estado de la sala sigue llegando a todos: V recibe los `SendInput` de P y conoce sus posiciones hasta que se oculta. Un cliente modificado puede reconstruir dónde está P (simulando la sala, o simplemente sin aplicar el NaN). Esto oculta a P del cliente oficial; no impide hacer trampa.
- **Retraso:** ocultar y mostrar llegan ≈ 1 RTT + *heartbeat* después. Un saque tras gol reaparece a P en el mundo de V hasta que llega el nuevo ocultado. Ese evento sale en el mismo frame del host, pero el cliente de V puede haber extrapolado ya algún frame por delante: unas decenas de ms con P visible en su punto de saque. Un cambio de equipo hecho por el host se vuelve a ocultar en el mismo frame. Un juego nuevo termina las parejas: el script vuelve a ocultar en cuanto lo sabe (el ejemplo, en el primer `onGameTick`, un tick después).
- **Si P interactúa con algo compartido** (empuja a otro, chuta el balón), V ve el efecto un tick tarde (la reconciliación) y además todos reciben un evento de 36 B por disco y tick mientras dure. Lo que no es un disco no se puede corregir. Si P mueve el balón en el saque, el reloj de V arranca un tick tarde. Si lo mete en la portería, V puede no ver el gol. Por eso el ejemplo hace que los ocultos no toquen nada: vivos `c1` (no chocan entre sí), fantasmas `c0` (solo los bordes los paran) y balón no chutable.
- **Sigue en la lista de jugadores:** P aparece en su equipo en la lista de V. Solo deja de dibujarse en el campo.
- **Clientes node-haxball como espectadores:** funcionan, gracias a que se quita el bit de chute. Otros clientes de terceros con otra física ante NaN podrían desincronizarse si P interactúa con algo.
- **Coste:** una vista privada por espectador con jugadores ocultos (≈ 1 µs/tick cada una). Ocultar o mostrar cuesta 32 B para V y un no-op de 20 B para cada uno de los demás.

**Lo que no necesita ninguna divergencia** (camino recomendado para las interacciones de tarea):

- el host lee posiciones (`getPlayerDiscProperties`, `onGameTick`) y decide;
- `sendAnnouncement`/`sendChat` con `targetId` (mensaje 6: no tocan el estado);
- `setPlayerAvatar` cambia el avatar que ve **toda** la sala (`SetHeadlessAvatar` es secuenciado y global). Un avatar distinto por jugador cabría en el mismo mecanismo de ranura privada (el campo se serializa con el jugador y la copia lo sigue), pero no está expuesto.

**¿Y los inputs de otro jugador vistos distintos por uno solo?** Con el mismo mecanismo sería posible: sustituir en el flujo de V los `SendInput` de P, mantener los contadores y simular la copia. Pero V vería **otro partido**: la pelota, los goles, el marcador y el fin del juego divergen sin vuelta atrás, porque no existe resync y `SetDiscProperties` cuantiza a f32. Restaurar el mundo exige reiniciar el juego o que V se reconecte. Reenviar el snapshot (mensaje 1) en mitad de la partida no parece fiable: `j$`/`ar` recargan el estado pero no vacían la cola de eventos ya recibidos, y los que tengan frame anterior al nuevo bloquearían la cola (**no verificado** en ejecución). Por eso no se implementa.

---

## 8. Ping, reloj y compensación de latencia

### 8.1 Bucle de ping (cliente)

```js
// api.js:2894 (cliente LM) — se llama en cada rAF y cada 50 ms (setInterval en wG(l=50), api.js:3127)
LM() {
  if (conectado && now - this.H1 > 1000) this.J$();                 // 1 ping por segundo
  this.UW = clamp(now*0.06 + this.ri.HI(.5) - this.j, 0, 120);      // frames que va "por delante"
}
J$() { t = now; this.Qi.push(t);
       ping = this.A5.HI(.5) | 0; ping = modifyClientPing?.(ping) ?? ping;   // ping DECLARADO
       enviar tipo 2 {f64 t, varint ping} por "uu"; }

// api.js:2984 (r$) — respuesta del host (tipo 4)
r$(rd) { hostFrame = rd.f64();  t0 = rd.f64();  rtt = now - t0;
         this.ri.f1(hostFrame - t0*0.06);   // muestra de desfase de reloj (en frames)
         this.A5.f1(rtt);                   // muestra de RTT
         onPingChange(instantáneo=rtt, mediana=A5.HI(.5), máx=A5.Bc()); }
```

```js
// headless.js:3981 (Wa.Kh) — el host responde
Kh(rd, conn) { t = rd.f64(); conn.ad = rd.varint();                      // guarda el ping que DECLARA el cliente
  enviar tipo 4 { (now - Lf)*0.06 + this.Sb , t } por "uu"; }
```

### 8.2 Qué estima `ri`

Muestra: `s = (H + Sb) − t0·0.06`, donde `H` es el frame del host al responder. En un instante `t`, la estimación vale `t·0.06 + s = H + Sb + (t − t0)·0.06`. Al llegar la respuesta (`t ≈ t0 + RTT`), con latencia simétrica, `H ≈ hostAhora − RTT/2`, así que:

```
estimación ≈ frameHostAhora + Sb + (RTT/2)·0.06
```

Ese valor es exactamente **el frame en el que un input enviado ahora sería aplicado por el host**. La estimación del cliente se "adelanta" al host por la latencia de ida. Es la misma idea que en los *fighting games* con *input delay* adaptativo.

### 8.3 Estadísticos robustos

`XW` (clase `d` en `api.js:735`) guarda hasta 50 muestras ordenadas, con un peso que decae ×0,97 en cada muestra nueva (`let f = .97`, `api.js:486`). `HI(p)` devuelve el **percentil ponderado** (p = 0,5, la mediana) y `Bc()` el máximo. Esto filtra picos de RTT y de jitter.

### 8.4 Difusión de pings

Cada **3 s** el host crea un evento `Ping` (tipo 17, solo host) con el `ad` de cada jugador: `window.setInterval(function(){D.oc(da.V(D))},3E3)` (`headless.js:3416`). node-haxball hace lo mismo con `room.hostPing` para el host (`api.js:3110`). Como el valor lo declara el cliente, el host **no mide el RTT por su cuenta**. node-haxball permite falsearlo en ambos extremos con `modifyClientPing` y `modifyPlayerPing`.

### 8.5 Tiempo real ↔ frames y catch-up

| Rol | Fórmula | Catch-up |
|---|---|---|
| Host | `objetivo = floor((performance.now() − t0) · 0.06)`. Se simulan `objetivo − da` frames en cada `Da()` (cada 50 ms y en cada mensaje). | Ilimitado: simula todo lo pendiente de golpe. |
| Cliente (confirmado) | Solo hasta el último heartbeat completo. | `D1(n)` simula `n` frames de golpe cuando llega el heartbeat. Si la pestaña estuvo congelada, se pone al día al llegar los heartbeats (los eventos están en la cola fiable). |
| Cliente (render) | `(now + ext)·0.06 + offset − j + BE` | Tope de 120 frames: más allá, la extrapolación se congela en +2 s. |
| Repeticiones | acumulador `$W += dt·velocidad`, `frames = $W·0.06` (`api.js:1660`) | — |

---

## 9. Fiabilidad y pérdida de paquetes

| Tráfico | Canal | Si se pierde un paquete… |
|---|---|---|
| Eventos cliente → host (incluido **input**) | `ro` (fiable y ordenado) | SCTP lo retransmite. El input llega más tarde y el host lo **re-sella** a un frame futuro (§4.1). No se pierde ningún input, pero puede perder su frame "ideal". Como el input solo se envía al cambiar, un cambio perdido para siempre dejaría al jugador con la tecla pegada; la fiabilidad lo evita. |
| Eventos host → clientes | `ru` (fiable y desordenado) | Se retransmiten. El orden lo da `(frame, orden)` y no el transporte. Un evento atrasado bloquea el avance del estado confirmado hasta que llega (comprobación por contador), pero la extrapolación sigue mostrando movimiento. |
| CheckConsistency, snapshot inicial, expulsión | `ro` | Fiable. |
| Heartbeats (tipo 3) | `uu` (no fiable) | Se ignora: el siguiente llega 7–9 frames después (§4.3). Solo retrasa la confirmación. |
| Ping / respuesta de ping | `uu` | La muestra se pierde. `Qi` purga los pings antiguos. |

Tolerancia a la desconexión: el host corta un peer que lleva 10 s sin mandar nada (`Ya`, `this.Qh=1E4`), y el cliente aborta si no recibe el estado inicial en 10 s (`$.VG = EWG.wE(…,1e4)`, `api.js:2872`).

---

## 10. Autoridad del host: validación, flood y hooks

### 10.1 Capas de validación (host oficial)

1. **Antiinundación por conexión**: `this.Tg=new Ra(100,16)` es una cubeta de tokens con capacidad 100 que recupera 1 token cada 16 ms (unos 62 mensajes/s sostenidos). Si se supera → `throw r.l(1)`.
2. **Formato**: tipo de mensaje desconocido → `r.l(0)`; bytes sobrantes → `r.l(2)`; strings demasiado largos (chat > 140, nombre > 25, país > 3, avatar > 2) lanzan excepción en `W()`.
3. **Rate limit por tipo** (`ue`; → `r.l(3)`):

   | Evento | Ráfaga (`je`) | Recarga (`ye`) |
   |---|---|---|
   | SendChat (`na`) | 10 | 1 cada 900 ms |
   | SetStadium (`V`) | 10 | 1 cada 2000 ms |
   | SetPlayerSync (`Fa`) | 2 | 1 cada 10 000 ms |

4. **Eventos solo-host** (`tb` lanza excepción): SendAnnouncement, CheckConsistency, JoinRoom, SetHeadlessAvatar, ReorderPlayers, SetDiscProperties y Ping. Si un cliente los envía, se le **expulsa**.
5. **Permisos que se rechazan en silencio**: `SetStadium` requiere ser admin (`tb: … return null!=a?a.Eb:!1`). Si no lo es, se descarta sin difundir.
6. **Permisos dentro de `apply` (deterministas)**: la mayoría de los eventos administrativos **sí** se difunden y cada par comprueba al aplicarlos si el autor era admin. Ejemplo de pausa: `qa.apply`: `if(null!=b&&a.Aa(this.B))…` (`Aa(id)` = id 0 o admin). En node-haxball: `f.OE(this.G,128)&&…`. Como todos tienen el mismo estado, todos rechazan igual.
7. **Validación final `fg(state)`**: solo el chat la usa en el headless, a través del callback `onPlayerChat` (si devuelve `false`, no se difunde).
8. **Expulsión**: cualquier excepción → `Xe()` cierra el peer → `lf` → el host emite `KickBan(id, "Bad actor")`: `D.lf=function(h){null!=y.O(h)&&D.oc(S.V(h,"Bad actor",!1))}` (`headless.js:3419`).

Dentro de la simulación hay además un **limitador de patadas determinista** (SetKickRateLimit, `min/rate/burst`). Es una cubeta por jugador que se recarga cada frame: `d.Xb<this.ha.Od&&d.Xb++` y `d.vc=this.ha.Yc,d.Xb-=this.ha.hc` (`headless.js:931-963`). No es protección de red: forma parte del estado y del hash.

### 10.2 Hooks de node-haxball (host)

En `i$` (`api.js:2704`), **después** de calcular el frame y **antes** de insertar y difundir:

```js
h.G = conn.id; h.$G = seq; h.dM = frameAsignado;
this.hM?.c$(h, frameSolicitado) && (this.u(h), this.aI(this.r5(h), 1));
// c$ (api.js:6791) → kc(ev, hostFrame, clientFrame) → _onOperationReceived(type, ev, globalFrameNo, clientFrameNo)
```

`_onOperationReceived` (`api.js:7291`) encadena estos callbacks:

```
customData = config.onBeforeOperationReceived(type, msg, globalFrameNo, clientFrameNo)   // false → rechazar
for plugin in activePlugins: plugin.onOperationReceived(type, msg, g, c, customData)      // false → rechazar
config.onOperationReceived(...)  →  config.onAfterOperationReceived(...)
return aceptado
```

- `return false` → el evento **no se aplica ni se difunde**.
- `msg` es mutable: se pueden cambiar sus campos (texto de chat, input, etc.) **antes** de que se difunda, y todos verán la versión modificada sin desync, porque el host la difunde ya modificada.
- `throw` → `XG()` → `onError` y expulsión de ese jugador ("Bad actor").
- `globalFrameNo` = `this.I.j` (frame del host) y `clientFrameNo` = frame que pidió el cliente. Su diferencia permite medir el retraso o adelanto de cada input (detección de macros, *lag switches*…).
- Los `CustomEvent`, `BinaryCustomEvent` y `SetPlayerIdentity` aceptados **no** entran en la secuencia: se reenvían como tipo 6 solo a clientes node-haxball (`S1(G,G.G,!0)` → `FU`).
- Otras palancas: `executeEvent(event, byId)` (inyectar eventos falsos con cualquier autor), `fakePlayerJoin/Leave`, `fakeSendPlayerInput`…, `modifyPlayerPing`, `setHandicap`, `clearEvents`.

---

## 11. Diferencias entre host oficial (headless) y node-haxball

| Aspecto | headless oficial (`f066733d`) | node-haxball 2.3.1 |
|---|---|---|
| Retardo de input del host | `Sb = 2` frames (33 ms) | `ZW = 4` frames (67 ms). Puede deberse a una versión distinta del juego o a una elección de la librería (**no verificado**). |
| Ventana de lateness | `−Sb−3` = −5 frames | `−ZW−3` = −7 frames |
| Heartbeat tras evento propio | `oc` → `Zd()` | `AW` → `Q5(!0)` (+ hook `onHostSpecificDataSent`) |
| Checksum | solo hash | hash y, si `debugDesync`, estado completo |
| Límite de jugadores | `Xc` limitado a 2…30 | `unlimitedPlayerCount`, `playerCount` falso |
| Hooks de validación | solo `onPlayerChat` (`fg`) | `onBefore/On/AfterOperationReceived` sobre **todos** los tipos |
| Extrapolación | no existe (headless no renderiza) | `j1/cW` en cliente y host |

---

## 12. Pseudocódigo resumen del ciclo completo

```text
HOST (cada 50 ms y en cada mensaje):
  avanzar_frames_hasta( floor((now - t0) * 60/1000) )   # aplicando eventos (frame, orden) en cola
  si frame - ultimoHB >= 7:    broadcast_uu( HB{frame, totalEventos} )
  si frame - ultimoCC >= 600:  ev = CheckConsistency(hash(estado)); sellar(frame, orden++); broadcast_ro(ev)
  cada 3 s:                    oc( Ping[pings declarados] )

HOST al recibir EVENTO(frameSolicitado, seq, ev) de c:
  flood/rate/permisos → si falla: kick "Bad actor"
  f = clamp(frameSolicitado, frame, frame+20)
  si ev.delay: corregir por lateness (umbral −Sb−3, media móvil < −0.85) y monotonía por cliente
  [node-haxball] if !onOperationReceived(type, ev, frame, frameSolicitado): descartar
  ev.(frame, orden, byId, seq) = (f, siguiente_hueco(f), c.id, seq)
  encolar/aplicar; broadcast_ru( EVENTO_SELLADO )

CLIENTE:
  al recibir EVENTO_SELLADO: insertar ordenado; si byId==yo: quitar de pendientes(seq)
  al recibir HB{F, N}: si eventos_conocidos(<F) == N: simular estado CONFIRMADO hasta F
  cada 1 s: ping → offset_reloj, RTT (medianas ponderadas)
  al cambiar teclas: frame = j + UW + handicap; enviar; añadir a pendientes (predicción)
  cada rAF: ext = copia(confirmado); simular hasta (now+extrapolation)*0.06+offset+handicap
            aplicando solo inputs/pausa (confirmados futuros + pendientes); render(ext)
  al aplicar CheckConsistency: si hash(local) != hash(host): enviar SetPlayerSync(desync)
```

---

## 13. Implicaciones de diseño

- **Ancho de banda mínimo**: durante el juego solo viajan cambios de teclas (unos pocos bytes), heartbeats cada 117–150 ms y pings. No hay estado de discos en la red. Por eso un host doméstico puede sostener muchas salas o jugadores.
- **Coste de CPU en el cliente**: re-simular hasta 120 frames por cada frame de render en el peor caso (ping alto).
- **El jugador con lag perjudica sobre todo su propia experiencia**: sus inputs se re-sellan más tarde, pero los demás nunca esperan por él. No es un lockstep "estricto" que bloquee a todos.
- **Confianza**: el host no reconcilia estado, así que un cliente con física modificada solo se desincroniza a sí mismo y queda señalado por `SetPlayerSync`. En cambio, el host tiene autoridad total: puede inyectar o alterar eventos, falsear pings, etc., como demuestra node-haxball.
- **Ping auto-declarado**: el valor que se muestra a los demás no es fiable como medida antitrampas.

---

## 14. Elementos no verificados

- La semántica exacta del booleano de `SetPlayerSync` en la UI oficial (si muestra "desync" con `true`) y si el cliente oficial ofrece algún tipo de resincronización manual o automática más allá de reconectarse.
- Si el renderer del cliente oficial suaviza las correcciones de la extrapolación. En node-haxball no hay suavizado.
- El motivo de `ZW=4` en node-haxball frente a `Sb=2` en el headless actual (¿versión o elección propia?).
- Que el cliente oficial del navegador (`game-min.js`) use exactamente las mismas constantes que node-haxball (`P5=120`, `l$=1000`, `XW(50)`, decaimiento 0,97). node-haxball dice ser una reimplementación fiel, pero no he analizado `game-min.js` directamente.
- El tipo exacto de algunos campos de las cabeceras del cliente (u32 frente a i32), deducidos por simetría entre `Qb()`=`getUint32` y `AM`.

---

## Fuentes

- `haxball.js/src/generated/headless.ts`: script headless oficial de HaxBall (© Mario Carbajal), cache hash `H4mQWPXF`, source hash `f066733d`, empaquetado por mertushka/haxball.js. Clases clave: `m`, `Ma`, `Wa`, `Za`, `Ra`, `$a`, `gb`, `Ta`, `kb.channels`, configuración `X.U=m.Z({...})`.
- `node-haxball/src/api.js` (wxyz-abcd/node-haxball v2.3.1, commit `4d4b88f`). Clases clave: `MG`/`zM` (runner), host `I`/`W` (`api.js:2466-2735`), cliente `W` (`api.js:2860-3030`), `XW` (estadísticos), `_W` (input), `_onOperationReceived` (`api.js:7291`).
- `node-haxball/src/index.d.ts`: `enum OperationType`, `HaxballEvent`, `ConsistencyCheckEvent`, `PingEvent`, `Player.sync/ping/input/kickRate*`, `onOperationReceived(type,msg,globalFrameNo,clientFrameNo)`, `setHandicap` (0–300 ms), `extrapolate(ms)`, `debugDesync`.
- `node-haxball/README.md`: secciones `Room.join/commonParams` (`debugDesync`), `extrapolate`, `clearEvents`, `executeEventWithTarget`, `onOperationReceived`, `modifyPlayerPing/modifyClientPing`, `fake event triggers`.
- `node-haxball/examples_web/src/game.js` y `sandboxRoomWrapper.js`: comandos `/extrapolation` (−200…200 ms) y `/handicap` (0…300 ms), que reproducen los textos del cliente oficial.
- `node-haxball/examples/renderers/sandboxRenderer.js`: uso de `room.extrapolate(extrapolation, true)` en cada frame de render.
- Copias formateadas para leer el código: `js-beautify@1.15.1 -s 2` sobre los archivos anteriores (las referencias `api.js:N` y `headless.js:N` se refieren a ellas).
