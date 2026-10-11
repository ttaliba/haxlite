# Benchmark: hosts de HaxBall en Node.js

## Resultado actual (benchmark rápido, tras la pasada de GC y memoria)

Misma sesión, las 4 opciones intercaladas, 3 repeticiones, ventanas de 30 s (sala vacía: 60 s), arranque con 10 repeticiones; haxlite medido con el **paquete minificado** publicado. Mediana [mín–máx]. Datos: `bench/results/quick-*.json` · `sh bench/net/quick.sh` · imágenes en `docs/img/benchmark/`.

| métrica | haxball.js (oficial) | node-haxball | haxlite + ndc | **haxlite + rtc** |
|---|---:|---:|---:|---:|
| **20 jugadores** · CPU % | 13,72 [13,31–13,81] | 14,98 [14,23–15,31] | 11,85 [11,36–11,96] | **5,41** [5,24–5,46] |
| RSS MB | 89,3 | 92,4 | 84,1 | **73,0** |
| heap MB | 12,2 | 15,8 | **9,3** | 11,1 |
| GC ms/min · pausas/min | 46,2 · 110 | 41,8 · 116 | **3,9 · 12** | 25,2 · 94 |
| lag p99 ms | 1,43 [1,16–2,10] | **1,24** [1,06–5,16] | 1,30 [1,12–1,49] | 1,72 [1,39–2,57] |
| hilos · fds | 18 · 46 | 15 · 48 | 19 · 27 | **11 · 25** |
| despertares/s | 4 274 | 4 379 | 4 150 | **486** |
| entrada p50 ms | 2 054 | 2 060 | 2 054 | **1 056** |
| **10 salas × 4** · CPU % | 19,19 | 20,03 | 15,58 | **6,25** |
| RSS MB · heap MB | 104,3 · 17,8 | 103,0 · 18,1 | 90,7 · **10,5** | **76,2** · 12,4 |
| GC ms/min | 115,0 | 54,5 | **8,2** | 13,5 |
| fds | 75 | 77 | 36 | **34** |
| **Sala vacía** · CPU % | 0,23 | 0,61 | **0,01** | **0,01** |
| despertares/s | 20,6 | 81,6 | **0,2** | **0,2** |
| **Arranque** proceso → link ms | 141 | 135 | 96 | **94** |

**Lectura:** haxlite + rtc gana a haxball.js y a node-haxball en todo salvo el **lag p99** (+0,3–0,5 ms, rangos solapados; todos muy por debajo de un frame de 16,7 ms). Frente a haxlite + ndc gana en CPU (−54 %), RAM, hilos, despertares, entrada y escala; pierde en GC/heap porque el módulo UDP de Node crea objetos por paquete (ndc hace la red en código nativo, fuera del GC).

---

## Comparativa unificada anterior (antes de la pasada de GC; histórica)

haxball.js (script oficial) vs node-haxball vs haxlite + node-datachannel vs haxlite + WebRTC propio.
Extraído de [`docs/07-benchmarks.md`](07-benchmarks.md); datos crudos en `bench/results/unified-*.json`.

Las cuatro opciones de host medidas **en la misma sesión** (11-10-2026, 11:19–13:04 UTC), misma
máquina, mismo build, mismos clientes y orden **intercalado** dentro de cada repetición (rep 1 de
las cuatro, luego rep 2…). Es la única tabla en la que los números de distintas librerías son
comparables entre sí; todo lo que viene después de esta sección es **histórico** (otras sesiones,
otra CPU, otros builds). Datos crudos: `bench/results/unified-{startup,idle,game,rooms}.json`;
tablas completas (mín–máx, reparto por hilo): `node bench/net/report.mjs --unified`.

## Qué se compara

| | host | WebRTC del host |
|---|---|---|
| **oficial** | `haxball.js` 5.1.0 ejecutando el script oficial del headless (`HBInit`) | `@webrtc-node/webrtc` 0.2.1 |
| **node-haxball** | `node-haxball` 2.3.1 `Room.create` | su `node-datachannel` 0.25.0 propio |
| **haxlite + ndc** | `HostRoom` + `HostTransport` (`peerBackend: 'ndc'`, el valor por defecto) | `node-datachannel` 0.33.4 |
| **haxlite + rtc** | ídem con `peerBackend: 'rtc'` (`rtcEndpoint` en 127.0.0.1) | haxlite-rtc (TypeScript, sin addon nativo) |

Los clientes son los mismos para los cuatro: node-haxball (libdatachannel) en procesos aparte,
≤ 10 por proceso, con la carga de juego con semilla de §2.1 (los contadores lo confirman: N = 20 →
9 662–9 810 inputs por repetición en los cuatro hosts). Mismos *shims* de cliente que en §1.1
(retraso de 40 ms del primer envío por canal en oficial y node-haxball, que haxlite trae de serie;
quitar el prefijo `a=` de los candidatos para `@webrtc-node/webrtc`). Las cuatro funcionaron sin
fallos: **0 uniones fallidas, 0 desconexiones, 100 repeticiones válidas de 100**.

## Resultados

Mediana de 3 repeticiones (arranque: 10). CPU en % de **un** núcleo (`process.cpuUsage()`, todos
los hilos del proceso host); entre paréntesis, hilo JS + resto de hilos (`/proc/self/task/*/stat`).
Despertares = cambios de contexto voluntarios por segundo de todos los hilos del proceso.

| escenario | métrica | oficial (haxball.js) | node-haxball | haxlite + ndc | haxlite + rtc |
|---|---|---:|---:|---:|---:|
| arranque | inicio del proceso → link (ms) | 139 | 134 | **112** | 122 |
| | RSS al link (MB) | 76,7 | 74,0 | **69,0** | 70,1 |
| sala pública ociosa, 0 jugadores (3 × 120 s) | CPU % (ms de CPU por minuto) | 0,337 (202) | 0,632 (379) | **0,010 (5,9)** | **0,009 (5,7)** |
| | RSS (MB) | 74,1 | 70,8 | **64,4** | 65,9 |
| | hilos · fds | 7 · 24 | 7 · 24 | 7 · 24 | 7 · 25 |
| | despertares/s | 20,5 | 81,0 | **0,2** ¹ | **0,2** ¹ |
| partida, 4 clientes | CPU % (JS + otros) | 2,85 (1,3 + 1,5) | 3,42 (1,6 + 1,8) | 2,59 (1,1 + 1,5) | **2,00** (1,8 + 0,2) |
| | RSS / heap usado (MB) | 79,3 / 10,9 | 83,8 / 14,1 | 78,2 / **9,3** | **72,2** / 10,5 |
| | hilos · fds · despertares/s | 18 · 30 · 761 | 15 · 32 · 841 | 19 · 27 · 778 | **11 · 25 · 184** |
| partida, 10 clientes | CPU % (JS + otros) | 5,81 (2,2 + 3,6) | 6,41 (2,6 + 3,8) | 5,13 (1,8 + 3,4) | **3,56** (3,3 + 0,3) |
| | RSS / heap usado (MB) | 84,7 / 11,7 | 86,3 / 15,3 | 80,1 / **9,8** | **77,1** / 13,3 |
| | hilos · fds · despertares/s | 18 · 36 · 1 731 | 15 · 38 · 1 786 | 19 · 27 · 1 730 | **11 · 25 · 279** |
| partida, 20 clientes | CPU % (JS + otros) | 13,52 (5,0 + 8,5) | 15,10 (6,0 + 9,1) | 11,95 (4,1 + 7,9) | **7,79** (7,3 + 0,4) |
| | RSS / heap usado (MB) | 85,3 / 12,4 | 92,4 / 16,0 | **83,3 / 9,9** | 88,7 / 14,2 |
| | GC por minuto | 96 | 95 | **9** | 56 |
| | lag del event loop p50 / p99 (ms) | 0,10 / 1,78 | 0,13 / 2,39 | 0,09 / 1,66 | 0,13 / 2,72 |
| | hilos · fds · despertares/s | 18 · 46 · 4 331 | 15 · 48 · 4 375 | 19 · 27 · 4 138 | **11 · 25 · 509** |
| | entrada p50 / p90 (ms) ² | 2 057 / 2 075 | 2 060 / 2 557 | 2 055 / 2 065 | **1 059 / 1 076** |
| 10 salas × 4 clientes, 1 proceso | CPU % (JS + otros) | 19,89 (8,4 + 11,6) | 20,37 (8,4 + 11,9) | 15,79 (5,4 + 10,3) | **9,13** (8,9 + 0,3) |
| | RSS / heap usado (MB) | 104,8 / 18,0 | 103,0 / 18,4 | 90,9 / **11,0** | **79,3** / 13,8 |
| | GC por minuto | 237 | 154 | **22** | 103 |
| | hilos · fds | 18 · 75 | 15 · 77 | 19 · **36** | **11** · 43 ³ |

GC por minuto y lag con 4 y 10 clientes (detalle en `report.mjs --unified`): GC 18 / 36 / **6** /
33 (N = 4) y 58 / 65 / **8** / 80 (N = 10); lag p50 0,09–0,17 ms y p99 1,5–2,9 ms en todos.

¹ Es el propio muestreo de memoria del arnés (cada 5 s): sin él, 0. ² `Room.join` → `onOpen` en el
cliente (señalización por la FakeMaster + oferta/respuesta + ICE/DTLS/SCTP + desafío), percentiles
sobre los 20 clientes de cada repetición, mediana de las 3. ³ Cada sala abre su propio
`RtcEndpoint` (un socket UDP por sala); con `rtc.endpoint` compartido serían ≈ 34.

Dispersión (mín–máx de las 3 repeticiones) de la CPU en partida: N = 4: oficial 2,77–3,23,
node-haxball 3,13–3,82, ndc 2,48–2,60, rtc 1,77–2,02; N = 20: 13,43–13,96, 14,36–15,24,
11,68–12,05, 7,77–7,90; 10 salas: 19,71–20,13, 20,03–20,98, 15,54–16,24, 8,99–9,49.

**Reparto por hilo, partida con 20 clientes** (% de un núcleo, mediana):

| | hilo JS | `RTC worker` ×4 | `juice poll` / `juice mux` | `SCTP timer` | resto (V8/libuv) |
|---|---:|---:|---:|---:|---:|
| oficial | 5,05 | 5,75 | 2,28 (poll) | 0,18 | 0,30 |
| node-haxball | 6,02 | 6,13 | 2,47 (poll) | 0,18 | 0,32 |
| haxlite + ndc | 4,07 | 5,60 | 1,97 (mux) | 0,17 | 0,13 |
| haxlite + rtc | 7,33 | — | — | — | 0,43 |

## Qué WebRTC usa cada librería

Versiones comprobadas en `node_modules` (paquetes, `CMakeLists.txt` y cadenas de los binarios
`.node`); la versión de libdatachannel de `@webrtc-node/webrtc` se resolvió contra el repositorio
de libdatachannel (`git describe`).

| librería | paquete WebRTC + versión | libdatachannel | ICE | DTLS | SCTP | modelo de hilos | dónde funciona |
|---|---|---|---|---|---|---|---|
| **haxball.js** 5.1.0 | `@webrtc-node/webrtc` 0.2.1 (addon Node-API `webrtc_node.node` 6,1 MB + capa W3C en JS de ~4 500 líneas) | **sí**: commit `188ec93` de *master* (`v0.24.5-199`, 06-07-2026, versión CMake 0.24.5), enlazada estática | libjuice 1.7.2, ICE completo + STUN; un socket UDP por conexión (`enableIceUdpMux: false` por defecto) | OpenSSL 1.1.1w (estático) | usrsctp `fec583d5` | hilo JS + 4 `RTC worker` (= núcleos) + `juice poll` + hilos de usrsctp: 18 con jugadores | en cualquier red (tras NAT, como un navegador) |
| **node-haxball** 2.3.1 | `node-datachannel` **0.25.0** (copia propia en `node-haxball/node_modules`, *polyfill* W3C) | v0.22.2 | libjuice 1.5.7, ICE completo + STUN; un socket por conexión | OpenSSL 1.1.1w (estático) | usrsctp `ebb18ada` | igual: 15 hilos con jugadores | en cualquier red |
| **haxlite + ndc** | `node-datachannel` **0.33.4** (prebuild `@node-datachannel/linux-x64-gnu`, API nativa sin *polyfill*) | v0.24.5 | libjuice 1.7.2, ICE completo + STUN, **mux UDP** por defecto (un socket, hilo `juice mux`) | OpenSSL 1.1.1w (estático) | usrsctp `fec583d5` | igual: 19 hilos con jugadores; se liberan 15 s después de cerrar la última conexión | en cualquier red (por defecto de haxlite) |
| **haxlite + rtc** | ninguno: **haxlite-rtc** (`src/rtc`, TypeScript, `node:dgram` + `node:crypto`) | no | ICE‑lite propio (solo responde Bindings; candidatos `host` de `publicAddresses`), un socket UDP compartido | DTLS 1.2 servidor propio; primitivas de `node:crypto` (OpenSSL 3.5.4 de Node 22.22) | SCTP propio (RFC 9260 + PR‑SCTP + *zero checksum*) | todo en el hilo JS; 0 hilos nativos (11 = 7 de Node + 4 del *threadpool* de libuv, que arranca la verificación ECDSA de los jugadores) | solo con **IP pública** alcanzable (o NAT 1:1 con `publicAddresses`/`publicPort`) y el puerto UDP abierto, o detrás del edge; **no** tras NAT doméstico (sin candidatos srflx) |

Los tres primeros son, por debajo, **la misma pila nativa** (libdatachannel + libjuice + usrsctp +
OpenSSL 1.1.1w), en tres versiones y con tres *bindings* distintos. Ninguno arranca hilos nativos
hasta la primera PeerConnection (por eso los 7 hilos en la sala ociosa).

## Conclusiones

* **Con jugadores, la diferencia la marca el WebRTC, no la librería de juego.** Los tres hosts
  sobre libdatachannel gastan casi lo mismo en hilos nativos (7,9–9,1 % con 20 clientes); lo que
  los separa es el hilo JS. **haxlite + rtc** elimina los hilos nativos y es el más barato en todos
  los escenarios con clientes: con 20 clientes 7,8 % frente a 12,0 (ndc, −35 %), 13,5 (oficial,
  −42 %) y 15,1 (node-haxball, −48 %); con 10 salas 9,1 % frente a 15,8 / 19,9 / 20,4. Los rangos
  no se solapan. Además hace ~8× menos despertares (509/s frente a ~4 100–4 400/s) y la entrada
  tarda la mitad (≈ 1,06 s frente a ≈ 2,06 s: ICE‑lite responde sin esperar la recolección).
* **haxlite + ndc frente al oficial** (misma pila nativa, más nueva y con mux): −9 % de CPU con 4
  clientes (2,59 frente a 2,85: diferencia real pero pequeña, 0,26 puntos), −12 % con 10 y 20, −21 %
  con 10 salas; ahorro sobre todo en el hilo JS y en el hilo ICE (mux). **node-haxball** es el más
  caro en todos los escenarios con clientes (+10–20 % sobre el oficial con 1 sala; +2 % con 10
  salas, dentro del ruido).
* **Memoria**: RSS dentro de ~12 MB entre los cuatro con 1 sala (72–92 MB): lo domina el runtime
  de Node. haxlite + ndc tiene el heap más pequeño (9,9 MB con 20 clientes) y **10× menos GC** que
  oficial/node-haxball (9 frente a ~95 por minuto); rtc paga +4 MB de heap y más GC (56/min) porque
  el estado DTLS/SCTP vive en JS. Con 10 salas, los dos haxlite usan 12–25 MB menos de RSS.
* **Ociosa**: los dos haxlite están en ≈ 0,01 % (6 ms de CPU por minuto, sin despertares propios),
  frente a 0,34 % del oficial (su `setInterval` de 50 ms: 20 despertares/s) y 0,63 % de node-haxball
  (81 despertares/s). En valor absoluto todo es despreciable; **ndc y rtc son iguales** (dentro del
  ruido: en reposo ninguno tiene conexiones).
* **Lag del event loop**: sin diferencias que importen (p50 ≈ 0,1 ms; p99 1,5–2,9 ms en todos). El
  de rtc es 0,3–1,3 ms mayor en p99 con 10–20 clientes (la red corre en el hilo JS), muy por debajo
  de un frame (16,7 ms). Los máximos (15–120 ms) varían entre repeticiones sin patrón.
* **Arranque**: 112–139 ms del inicio del proceso al link en los cuatro; haxlite + ndc es ~20 ms
  más rápido (menos módulos que cargar), pero los rangos se solapan parcialmente (103–135 frente a
  117–148): diferencia pequeña.
* **Cuándo usar cada backend de haxlite**: `rtc` donde haya IP pública (VPS, dedicado, edge);
  `ndc` (por defecto) tras NAT.

## Condiciones, ruido y advertencias

* Máquina: VM Firecracker de **4 vCPU** (Intel Xeon, el kernel la reporta a 2,30 GHz; las tandas
  históricas eran de 2,80 GHz), 16 GB, Linux 6.18.44, **Node v22.22.0** (V8 12.4, OpenSSL 3.5.4).
  haxlite: commit `bc5d625`, `src/` sin cambios, build `0e27a1def092`.
* Máquina tranquila durante toda la sesión: CPU ajena (sistema − nuestros procesos) ≤ 4 % de un
  núcleo en las 60 ventanas con clientes u ociosas (`machine.foreignPct` en cada JSON; `loadavg` de
  1 min ≤ 1,6 incluyendo nuestros propios procesos). Umbral de repetición: 50 %; solo se repitió
  una medición de arranque (haxlite + ndc, 57 % ajeno durante los ~0,1 s del arranque).
* Las tres sobre libdatachannel no están en igualdad de versión (0.22.2 / 0.24.5 / master): es lo
  que cada librería instala hoy, que es lo que se quería comparar.
* Todo es loopback y los clientes son libdatachannel: no hay pérdida ni latencia de red reales.
  La interoperabilidad de haxlite-rtc con navegadores y el cliente oficial está en docs/10 §4–§6.
* El reparto por hilo usa tics de 10 ms: con 60 s de ventana la resolución es 0,017 puntos.
* Los hosts oficial y node-haxball llevan los dos *shims* de cliente de §1.1 (coste en régimen:
  una llamada y una comparación por mensaje enviado).

## Comandos exactos

```sh
npm ci
sh bench/net/unified.sh          # ≈ 1 h 45 min; compila haxlite y corre los cuatro escenarios
node bench/net/report.mjs --unified
```

`bench/net/unified.sh` ejecuta, cada uno bajo `flock /tmp/haxlite-bench.lock`:

```sh
npm run -s bench:build
R="node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts"
I=official,nodehaxball,haxlite:ndc,haxlite:rtc
flock /tmp/haxlite-bench.lock $R startup --impl $I --reps 10 --max-foreign 50 --attempts 3 --out bench/results/unified-startup.json
flock /tmp/haxlite-bench.lock $R idle --impl $I --reps 3 --warmup 15 --window 120 --max-foreign 50 --attempts 3 --out bench/results/unified-idle.json
flock /tmp/haxlite-bench.lock $R game --impl $I --n 4,10,20 --reps 3 --warmup 15 --window 60 --max-foreign 50 --attempts 3 --out bench/results/unified-game.json
flock /tmp/haxlite-bench.lock $R rooms --impl $I --k 10 --reps 3 --warmup 15 --window 60 --max-foreign 50 --attempts 3 --out bench/results/unified-rooms.json
```

Métricas añadidas al arnés para esta tanda (solo `bench/`, sin tocar las librerías): reparto
hilo JS / resto (`host.cpuSplit`), despertares (`host.wakeups`, de `voluntary_ctxt_switches` de
`/proc/self/task/*/status`), tiempo de entrada por cliente (`join[].joinMs`) y versión del
`node-datachannel` de node-haxball en `info.versions`.
