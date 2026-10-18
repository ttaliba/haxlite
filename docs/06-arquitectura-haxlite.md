# 06 — Arquitectura de haxlite

> haxlite es un **host** de HaxBall (sala *headless*) ligero y en TypeScript, escrito
> para Node.js ≥ 22 y Bun (§4.6). Debe interoperar bit a bit con los clientes oficiales del
> navegador (protocolo 9) y ofrecer una API compatible con `HBInit` (la del headless oficial). Este documento fija los límites entre módulos, las reglas de código
> que todos seguimos y cómo usar los oráculos de prueba.
>
> Documentos de referencia: [01 red](01-red-y-salas.md), [02 protocolo](02-protocolo-binario.md),
> [03 física](03-fisica-y-estadios.md), [04 netcode](04-netcode-y-sincronizacion.md),
> [05 librerías](05-librerias-y-apis.md).

---

## 1. Visión general

```
                   ┌────────────────────────── src/api ───────────────────────────┐
  script usuario → │  HBInit(config) → RoomObject (métodos + callbacks on*)       │  fase 2
                   └───────────────┬───────────────────────────────▲──────────────┘
                                   │ acciones del host             │ eventos de juego
                   ┌───────────────▼────────── src/host ───────────┴──────────────┐
                   │  reloj de frames (timer único por proceso), cola de eventos, │  fase 2
                   │  difusión, snapshot de unión, CheckConsistency, Ping         │
                   └──────┬──────────────────────────────▲─────────────────────────┘
        aplicar evento /  │ tick                          │ mensajes decodificados
                   ┌──────▼────────── src/room ──┐  ┌─────┴─────────── src/net ──────────┐
                   │ RoomState, Player, reglas,   │  │ master HTTP, señalización WS,      │
                   │ eventos 0..23, serialización │  │ WebRTC (haxlite-rtc o ndc), auth,  │
                   │ del estado, checksum (B)     │  │ bans, límites de tasa (C)          │
                   └──────┬───────────────────────┘  └────────────────────────────────────┘
                          │ World, Stadium
                   ┌──────▼────────── src/sim ────┐
                   │ física, estadios (.hbs,      │
                   │ binario, por defecto) (A)    │
                   └──────┬───────────────────────┘
                          │                 todos usan
                   ┌──────▼────── src/codec + src/model.ts + src/protocol.ts ────────────┐
                   │ Writer/Reader, UTF-8 de HaxBall, deflate, checksum; modelo y constantes│
                   └─────────────────────────────────────────────────────────────────────┘
```

Dependencias permitidas (de arriba abajo, nunca al revés):
`api → host → room → sim → codec`, `host → net → codec`. `room` no conoce `net`; `sim` no conoce
`room` (recibe/devuelve tipos del modelo). `test/oracle` solo lo importan los tests.

## 2. Estructura del repositorio y responsables

| Ruta | Contenido | Responsable |
|---|---|---|
| `src/codec/` | `Writer`, `Reader`, UTF-8 de HaxBall, `deflateRaw`/`inflateRaw`, `xorInt32Words`, `varUintSize` | fundación (estable; cambios coordinados) |
| `src/protocol.ts` | constantes: versión 9, 60 Hz, `Input`, `CollisionFlag`, `TeamId`, `GamePhase`, `EventType` 0..23, canales y tipos de mensaje | fundación |
| `src/model.ts` | punto único de importación del modelo (reexporta `sim/types.ts` y `room/types.ts`) | fundación |
| `src/sim/` | `types.ts` (Disc, Vertex, Segment, Plane, Goal, Joint, PlayerPhysics, Stadium, World) + física, parser `.hbs`, serialización de estadios, estadios por defecto | **ingeniero A** |
| `src/room/` | `types.ts` (TeamInfo/TEAMS, TeamColors, Player, GameState, RoomState) + reglas del partido, eventos, serialización del estado, checksum | **ingeniero B** |
| `src/net/` | backend HTTP, WS de señalización, transporte WebRTC (backends de peers: node-datachannel `'ndc'`, haxlite-rtc `'rtc'`, edge), handshake/identidad, bans, flood | **ingeniero C** |
| `src/host/` | secuenciador/netcode | fase 2 |
| `src/api/` | capa compatible con `HBInit` | fase 2 |
| `src/rtc/` | haxlite-rtc: WebRTC de data channels en TypeScript puro (ICE completo en rol controlado con STUN, o ICE‑lite; DTLS 1.2, SCTP), también tras NAT; lo usa `src/net/rtc-backend.ts` (`peerBackend: 'rtc'`). Ver [10](10-haxlite-rtc.md) | ingenieros R1/R2 |
| `src/edge/` | haxlite Edge: gateway WebRTC que oculta la IP del host (servidor + CLI); el lado host es `src/net/edge-client.ts` (`HostTransportOptions.edge`). Ver [09](09-haxlite-edge.md) | ingeniero E |
| `test/oracle/` | oráculos diferenciales (node-haxball y el script oficial) | fundación |
| `test/<módulo>/` | tests de cada módulo | dueño del módulo |

`src/sim/index.ts` y `src/room/index.ts` contienen **stubs** (`throw new Error('not implemented')`)
con las firmas que los demás módulos esperan (`stepWorld`, `writeStadium`, `readStadium`,
`parseHbs`, `defaultStadiums`, `writeRoomState`, `readRoomState`, `roomStateChecksum`,
`stepRoom`). El dueño puede refinarlas, pero manteniéndolas como funciones sobre los tipos del
modelo y avisando del cambio.

Scripts: `npm run build` (tsc → `dist/`), `npm run typecheck`, `npm test` (vitest). Dependencias
de ejecución: `ws` y `json5` (zlib y webcrypto vienen del runtime); `node-datachannel` es una
`optionalDependency` que solo se carga con `peerBackend: 'ndc'`, los jugadores `'ndc'` del edge o
el túnel WebRTC legado (`npm install --omit=optional` para despliegues solo `rtc`; si falta y se
necesita, error claro «node-datachannel no está instalado…»). Algunos `.d.ts` importan tipos de
node-datachannel: un consumidor TypeScript con `skipLibCheck: false` y sin el paquete ve TS2307.
`node-haxball`, `haxball.js` y `pako` (transitiva) son **solo** de desarrollo.

## 3. El modelo compartido (`src/model.ts`)

* Cada clase declara sus campos **en el orden exacto de serialización oficial**; el serializador
  es un recorrido lineal. Cada campo documenta su nombre minificado oficial (`off:`), el de
  node-haxball (`nh:`) y el tipo binario (`bin:`).
* Los equipos se representan por id (`0` spec, `1` rojo, `2` azul); el descriptor estático
  (`TEAMS[id]`: color, lado, flag KO, cGroup, rival) sustituye a los objetos `v.oa/v.fa/v.ta`.
* Representación orientada a rendimiento: campos numéricos planos (`x`, `y`, `xspeed`…, igual que
  `DiscPropertiesObject` de HBInit) en lugar de objetos `Point` anidados; todos los campos se
  inicializan en el constructor en orden fijo (una sola *hidden class* por tipo). La aritmética no
  cambia: el oficial anida `{x,y}`, pero las operaciones de coma flotante son las mismas.
* Referencias que el oficial guarda como objetos se mantienen: `Segment.v0/v1` apuntan a `Vertex`
  (y se serializa `vertex.index`), `Player.disc` apunta a un `Disc` (se serializa `disc.index`,
  i16, −1 si no hay). `Disc.index`/`Vertex.index` reproducen `sf`/`Lc`, que el oficial asigna
  **durante la serialización** del mundo/estadio.
* Campo `Player.reservedI32` = el `i32` sin nombre (`Ai` oficial, `la` en node-haxball): siempre 0
  en el headless; se conserva y se serializa tal cual.
* `Disc.color` se escribe como **u32** (`-1` → `0xFFFFFFFF`) pero el resto de colores como i32.
* Valores por defecto = los del constructor oficial (p. ej. `Player.name = "Player"`,
  `RoomState` 3/3, kick rate `min 2, rate 0, max 1`, `goalConcedingTeam = rojo`).

## 4. Reglas de código (obligatorias)

### 4.1 Rendimiento (bucle por tick)

1. **Cero asignaciones en el camino caliente** (tick de física, aplicar input, serializar para
   checksum): nada de `new`, literales `{}`/`[]`, `map/filter/forEach` con *closures*, `...spread`,
   desestructuración de objetos temporales ni strings dentro del tick.
2. Reutilizar buffers: un `Writer` de larga vida por propósito (`reset()` en vez de crear otro);
   `Writer.finish()` devuelve una vista **sin copia** (válida hasta la siguiente escritura). Copiar
   (`copyBytes()`) solo si los bytes deben sobrevivir.
3. Bucles `for (let i = 0; i < arr.length; i++)` sobre arrays densos; **sin iterar `Map`/`Set`**
   en el camino caliente (usar arrays indexados; un `Map` solo para búsquedas puntuales por id).
4. Campos tipados y monomórficos: no añadir propiedades después del constructor, no `delete`, no
   mezclar tipos en un mismo campo (`number` nunca pasa a `undefined`; usar `NaN`/`-1`/`null`
   declarados).
5. Sin *closures* creadas por tick ni callbacks opcionales por disco; los hooks de usuario se
   invocan desde `host/api`, no desde `sim`.
6. Scratch estático (p. ej. posiciones previas de discos con `score`, 256 entradas como el
   oficial `Q.Se`) preasignado una vez.

### 4.2 Determinismo

1. **Mismo orden de operaciones de coma flotante que el oficial**, expresión por expresión
   (`a*b*c` ≠ `a*(b*c)`). Al transcribir fórmulas de `hl.js`, conservar la asociatividad y los
   temporales tal cual (p. ej. el joint rígido hace `x + e*g*0.5` con `g = f*d`).
2. Nada de `Math.fround`, `Float32Array` ni `f32` en el estado salvo donde el oficial lo hace:
   **solo** `SetDiscProperties` (cuantiza a float32 los 10 campos reales) y `RoomInfo` (lat/lon).
3. Prohibido `Math.random`, `Date.now`/`performance.now` en `sim` y `room`. El tiempo de juego son
   ticks; la única fuente de tiempo real es el reloj del host (`src/host`).
4. Respetar el orden de los arrays: jugadores (orden de lista, alterado por `ReorderPlayers` y por
   cambios de equipo), discos (estadio con balón primero, luego jugadores por orden de creación),
   joints (2 pasadas), pares de colisión `i<j`.
5. **Conservar `-0`.** El spawn del primer jugador de cada equipo es `y = 55 * -0 = -0`, que se
   serializa como `80 00 00 00 00 00 00 00`. No normalizar con `|| 0`, `Math.abs`, `+0`, etc.
6. Constantes literales idénticas: `1/60` como `0.016666666666666666`, `E.jg = 0.17435839227423353`,
   `E.ig = 5.934119456780721`, etc. `Math.sqrt` es exacto en todos los motores; `Math.tan` (solo al
   curvar segmentos de estadios por defecto) se calcula igual que el host oficial en V8.
7. Los eventos se aplican **antes** del paso del frame al que están asignados, en su orden dentro
   del frame (ver docs/04 §2.2).

### 4.3 Interoperabilidad

1. Todo lo que viaja por la red o entra en un checksum debe ser **byte-idéntico** al oficial y
   estar cubierto por un test diferencial contra el oráculo (§6).
2. Usar exclusivamente `src/codec` para leer/escribir binario. Peculiaridades ya resueltas allí:
   * strings con UTF-8 "por unidad UTF-16" (emoji = 2×3 bytes, estilo CESU-8); el lector admite
     formas de 1–6 bytes;
   * `stringU8` (solo `RoomInfo`) usa UTF-8 estándar (`TextEncoder`) como el oficial (node-haxball
     aquí se desvía);
   * varuint LEB128 con el 5.º byte calculado con desplazamiento **con signo** (`0x80000000` →
     `80 80 80 80 78`); el lector devuelve int32;
   * `nullableString`: `varuint(len+1)`, `0` (o negativo) = `null`;
   * campos parcheados a posteriori (flags del segmento, máscara de `SetDiscProperties`) con
     `setU8At`/`setU16At`.
3. Deflate: `deflateRaw` usa `node:zlib` con los parámetros de pako (nivel 6). **Los bytes
   comprimidos pueden diferir de pako** (≈40 % de los casos medidos), pero ningún hash cubre bytes
   comprimidos y haxball.js ejecuta el host oficial con esta misma sustitución, así que no afecta a
   la interoperabilidad. `inflateRaw(data, 51200)` reproduce el límite de señalización. En Bun,
   `deflateRaw` usa `Bun.deflateSync` solo donde su salida es byte a byte la de `deflateRawSync`
   (entrada ≤ 64 KB, niveles 1–9, salida < 16 KB, un único chunk de node:zlib; si no, rehace con
   node:zlib): mismos bytes que antes en todos los casos (snapshots, estadios y señalización van por
   la ruta rápida). `deflateRawAsync` hace el mismo deflate en el *threadpool* (replays con
   `stopAsync`).
4. Las extensiones de node-haxball (eventos 24–26, campos extra en `SendChatIndicator`) **nunca**
   se envían.

### 4.4 Procedencia del código

1. Prohibido copiar código minificado (de `hl.js`, `api.js`, `game.pretty.js`) al producto. Se
   reimplementa con nombres legibles. Se permite transcribir **constantes numéricas, fórmulas y
   órdenes de campos**, citando el nombre minificado en un comentario (`off:`).
2. El código de `test/oracle/` es la única excepción: puede usar nombres minificados de
   node-haxball y del script oficial, porque solo los ejecuta para comparar.
3. Nada de `src/` puede importar `node-haxball`, `haxball.js`, `pako` ni `test/`.

### 4.5 Tests

1. Framework: **vitest**. `npm test` y `npm run typecheck` deben pasar siempre antes de entregar.
2. Ubicación: `test/<módulo>/*.test.ts` (o `src/**/*.test.ts` para tests unitarios muy locales).
3. Cada módulo tiene **tests diferenciales contra el oráculo**: mismo escenario en haxlite y en
   el oráculo → mismos bytes de estado (o mismos bytes de evento/estadio). Además, tests unitarios
   de casos borde.
4. Aleatoriedad en tests solo con `prng(seed)` (mulberry32) de `test/oracle` → reproducible.
5. Al encontrar una divergencia, reducirla a un test mínimo y dejarlo en el repo.

### 4.6 Runtimes: Node y Bun

El mismo `dist/` corre en Node ≥ 22 y en Bun (medido con Bun 1.4; benchmarks en
[07](07-benchmarks.md)). El código detecta el runtime solo donde el camino más barato difiere; la
salida en la red es la misma:

| Dónde | Node | Bun |
|---|---|---|
| Cliente HTTP del maestro (`src/net/master-http.ts`) | `node:http(s)`, cargado en la primera petición | `fetch` nativo si no hay `agent` ni variables `HTTP(S)_PROXY`/`ALL_PROXY` (si las hay, `node:http` como en Node). Diferencias: Bun añade `User-Agent: Bun/<v>`, `Accept` y `Accept-Encoding` (cuerpo descomprimido de forma transparente), sus mensajes de error de red y un timeout que acota la petición entera |
| E/S UDP de haxlite-rtc y del socket del túnel v2 en el edge (`src/rtc/udp.ts`) | `UDPWrap` del socket con un `SendWrap` reutilizado | socket nativo dentro de `dgram` (envío directo, recepción por `reload`) y un `sendMany` por vaciado del bundler (`sendmmsg` en Linux) |
| `chacha: 'node'` de `DtlsServer` | ChaCha20‑Poly1305 de `node:crypto` | cae a la AEAD JS (`node:crypto` de Bun no la tiene) |
| Holgura del reloj del host | +1 ms por temporizador (el de libuv puede disparar hasta ~1 ms antes) | 0 (Bun no dispara antes) |
| `deflateRaw` | `node:zlib` | `Bun.deflateSync` cuando da los mismos bytes (§4.3) |

Las suites DTLS por defecto y la AEAD del túnel v2 con `'auto'` **no** dependen del runtime:
ChaCha20‑Poly1305 (JS, en el sitio, sin asignar) primero también en Bun. El AES‑GCM nativo de Bun
gana la micro‑medida por registro, pero de extremo a extremo cuesta ≈ 21 % más CPU (un objeto de
cifrado por registro despierta al *scavenger* de mimalloc) y ≈ 9 % más bytes ([10 §6.7](10-haxlite-rtc.md)).

`node:http(s)` del `EdgeServer` y de `ws` tampoco se cargan en Bun con un host normal (arranque del
paquete en Bun: 42,7 → 29,6 ms, RSS −3,6 MB).

## 5. `src/codec` (API)

```ts
import { Writer, Reader, deflateRaw, inflateRaw, xorInt32Words, varUintSize } from './codec/index.js';

const w = new Writer(1024);          // reutilizable: w.reset()
w.u8(1); w.i16(-1); w.u32(x); w.f64(v); w.varUint(n);
w.string(s); w.nullableString(null); w.stringU8('ES'); w.json(obj); w.bytes(u8);
const at = w.pos; w.u16(0); /* … */ w.setU16At(at, mask);   // parcheo
w.u16LE(9); w.f32LE(lat);           // variantes little-endian explícitas (RoomInfo)
const view = w.finish();            // sin copia; w.copyBytes() para copiar

const r = new Reader(bytes);         // acepta Uint8Array (con byteOffset) o ArrayBuffer
r.u8(); r.i8(); r.u16(); r.i32(); r.f64(); r.varUint(); r.string(); r.nullableString();
r.stringU8(); r.json(); r.bytes(n) /* sin copia */; r.remaining;
```

Errores: lecturas fuera de rango lanzan `RangeError`/`CodecError`; en el camino de red cualquier
excepción equivale a "desconectar al par", como en el oficial.

## 6. Oráculos de prueba (`test/oracle/`)

Hay **dos** oráculos, ambos solo para tests:

1. **node-haxball** (`test/oracle/index.ts`): reimplementación completa cuyos clientes pasan el
   *CheckConsistency* de salas oficiales. Se conduce offline con `Room.sandbox`. Es el oráculo
   de uso diario (API cómoda, `.hbs`, export de estadios, eventos con nombre).
2. **El script oficial del headless** (`test/oracle/official.ts`): el `headless-min.js`
   (hash `f066733d`) que trae `haxball.js` en `dist/index.mjs`, evaluado offline con un `window`
   falso, sustituyendo el arranque `F.sh()` por un gancho que nos entrega sus clases internas
   (`Ta` RoomState, `L`/`A` Reader/Writer, `m` eventos, `vb` registro, `w` Stadium). Es la verdad
   absoluta. `cross-oracle.test.ts` comprueba que **ambos producen bytes de RoomState idénticos en
   cada tick** (Classic 5000 ticks con goles; los 10 estadios por defecto; un `.hbs` con curvas,
   `bias`, joints, gravedad, spawn points, `kickOffReset: full` y eventos de admin).

### 6.1 API de `test/oracle/index.ts`

| Función / método | Qué hace |
|---|---|
| `OracleRoom.create({ stadium, players: [{id,name,team,flag,avatar,admin}], start, scoreLimit, timeLimit, teamsLocked, kickRate })` | sala sandbox lista para jugar |
| `OracleRoom.empty()` | `RoomState` recién creado (Classic, 3/3, sin jugadores) |
| `OracleRoom.fromStateBytes(bytes)` | carga un RoomState **binario oficial** (p. ej. el que genera nuestro serializador) y permite seguir simulando |
| `room.step(n)` / `room.frame` | avanza `n` ticks (1/60 s cada uno) |
| `room.input(id, mask)` | `SendInput` del jugador `id` (kick = flanco de subida del bit 16) |
| `room.runTimeline([{frame, playerId, input} \| {frame, event, byId} \| {frame, run}], hasta)` | aplica acciones en frames exactos (antes del paso de ese frame) |
| `room.join/leave/kick/chat/announce/setTeam/setAdmin/startGame/stopGame/pause/setScoreLimit/setTimeLimit/setTeamsLock/setKickRateLimit/setStadium/setAvatar/setHeadlessAvatar/setTeamColors/reorderPlayers/autoTeams/setPlayerSync/setDiscProperties/setPlayerDiscProperties` | eventos 0..23 con `byId` (0 = host) |
| `room.applyEventBytes(bytes, byId)` | aplica bytes oficiales de evento (`u8 tipo` + payload), p. ej. los que produce **nuestro** codificador |
| `room.stateBytes()` | bytes exactos del RoomState oficial (snapshot/checksum) |
| `room.checksum()` / `room.hash()` | hash XOR oficial (int32) / sha256 de los bytes |
| `room.discs()` / `room.dump()` | JSON legible: discos (x, y, xspeed, yspeed, gravedad, radio, …) y estado completo |
| `room.snapshot()` / `room.restore(s)` | copia/restaura el estado |
| `stadiumToBytes(spec, { forceCustom })` | estadio → binario oficial; `forceCustom` emite la forma 255 de un estadio por defecto (para comparar geometría generada) |
| `hbsToStadiumBytes(text)`, `parseStadiumBytes(bytes)` | `.hbs` → binario; binario → `{bytes, hbs, name}` |
| `encodeEvent(nombre, ...args)` / `decodeEvent(bytes)` | evento ↔ bytes oficiales (`EventFactory` de node-haxball) |
| `DEFAULT_STADIUM_NAMES`, `prng(seed)`, `sha256(bytes)`, `nhWriter()`, `nhReader()` | utilidades |

`StadiumSpec` = índice `0..9`, nombre (`"Classic"`), `{ hbs }` o `{ bytes }`.

`test/oracle/official.ts` expone `OfficialRoom` con el núcleo de la misma API:
`applyEventBytes(bytes, byId)`, `step(n)`, `stateBytes()`, `checksum()`, y `officialInternals()`
para acceder a las clases oficiales.

### 6.2 Recetas

```ts
// A — física: misma partida en ambos lados, comparar bytes del estado cada tick
const oracle = OracleRoom.create({ stadium: 'Classic', players: [{ id: 1, name: 'a', team: 1 }], start: true });
const ours = /* RoomState de haxlite construido igual */;
for (let f = 0; f < 600; f++) {
  oracle.input(1, Input.Right | (f % 30 === 0 ? Input.Kick : 0)).step();
  stepRoom(ours); /* + mismo input */
  expect(writeRoomStateBytes(ours)).toEqual(oracle.stateBytes());
}
// A — estadios por defecto: geometría generada
expect(writeStadiumBytes(forceCustom(defaultStadiums()[5]))).toEqual(stadiumToBytes(5, { forceCustom: true }));

// B — eventos: nuestro codificador == oficial, y el oráculo acepta nuestros bytes
expect(ourEncode(chatEvent)).toEqual(encodeEvent('sendChat', 'hola 😀'));
oracle.applyEventBytes(ourEncode(ev), byId);
// B — deserializador: cargar en el oráculo un estado producido por nosotros
OracleRoom.fromStateBytes(ourStateBytes).step(300).stateBytes();

// C — payloads: los eventos y estados que viajan por la red se validan con encodeEvent/decodeEvent
```

Para depurar una divergencia: `room.dump()` en ambos lados y comparar el primer tick distinto;
`cross-oracle.test.ts` muestra cómo localizar el frame exacto.

### 6.3 Cómo se encontraron los internos (y sorpresas)

* **Serializador del estado en node-haxball**: `RoomState.l(writer)` (método minificado `l`;
  `o(reader)` deserializa, `r1()` es el checksum XOR, `DN()` lo devuelve en 4 bytes). Se localizó
  buscando el bucle XOR `for(...;f.c<=f.Q.byteLength-4;)i^=f.Y()` en `api.js`. El writer público es
  `Impl.Stream.Writer.create()`. El constructor de `RoomState` no es público: se alcanza como
  `state.oG.pE` (`oG` = espacio interno de la API).
* **Estadios**: `stadium.l(writer)` serializa (forma 255 o 1 byte); `Impl.Stadium.Stadium.o(reader)`
  es el lector estático. Para forzar la forma 255 de un estadio por defecto: `copy()` y `JI = 255`
  (`JI` = `defaultStadiumId`, cuyo getter público es de solo lectura).
* **Eventos**: `event.l(writer, true)` escribe el payload **oficial** (con `false` añade campos de
  extensión de node-haxball); el byte de tipo lo escribimos nosotros. `EventFactory.createFromStream`
  decodifica en modo oficial. El `byId` es el campo `G` (también hay setter `byId`).
* **Sorpresa 1**: `sandbox.runSteps(n)` / `RoomState.nM(n)` **no son n ticks**: hacen **un** tick
  con `dt = n` (la integración hace `pos += v·n`). El oráculo llama `runSteps(1)` n veces.
* **Sorpresa 2**: `EventFactory.sendChatIndicator(active)` guarda `active ? 0 : 1` (invertido).
* **Sorpresa 3**: en node-haxball los alias `writeUTF8Char`/`readUTF8Char` son en realidad el
  writer/reader de **varuint** (`gM`/`vM`); y `writeString2` usa su UTF-8 propio en vez de
  `TextEncoder` (difiere del oficial solo con caracteres fuera del BMP en `RoomInfo`).
* **Sorpresa 4**: el oráculo sandbox aplica los eventos inmediatamente (sin cola por frame). Por
  eso "evento en el frame F" = aplicarlo cuando `room.frame === F`, antes de `step()`.
* **Sorpresa 5**: `-0` aparece en estados reales (spawn `y` del primer jugador de cada equipo) y
  está en los bytes del checksum.

### 6.4 Lo que los oráculos no cubren y cómo suplirlo

* **Secuenciación del host** (asignación de frame/orden, msg 1 snapshot de unión, msg 3 sync,
  pings): ni el sandbox ni el oráculo oficial offline ejecutan la parte de red (`Wa`/`Ma`
  necesitan WebRTC/señalización). Propuesta para C/fase 2: test de extremo a extremo conectando
  un **cliente node-haxball** (`Room.join`) a nuestro host a través de un servidor de señalización
  local falso (node-haxball permite `config.proxy.WebSocketUrl`), y comprobando que el cliente no
  reporta desync (`SetPlayerSync`) y que sus checksums coinciden.
* **Formato `.hbr2`**: node-haxball tiene `Replay.read/readAll/writeAll` (no envuelto aún; usar
  `nh.Replay` directamente si hace falta).
* `haxball.js` (5.1.0) y `node-haxball` (2.3.1) están **fijados a versión exacta** en `package.json`.
  Si se actualiza `haxball.js`, los nombres minificados de `official.ts` pueden cambiar: el test
  `cross-oracle` fallará al cargar y habrá que revisarlos.

## 7. Flujo de trabajo

1. Leer los docs 02–04 para el área propia y los `off:` del modelo.
2. Escribir primero el test diferencial contra el oráculo; luego la implementación.
3. `npm run typecheck && npm test` antes de entregar. No hacer commit: lo hace el coordinador.
4. Cualquier cambio en `src/codec`, `src/protocol.ts` o `src/*/types.ts` se comunica, porque
   afecta a todos.
