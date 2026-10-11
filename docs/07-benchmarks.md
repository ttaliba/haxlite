# 07 — Benchmarks de recursos: haxlite vs host oficial vs node-haxball

> Medición reproducible del consumo de recursos de un **host** de HaxBall en Node.js:
> haxlite (este repo), el **script oficial del headless** ejecutado por `haxball.js` 5.1.0 y
> **node-haxball** 2.3.1 actuando como host. Todo offline contra la `FakeMaster` de
> `test/fake-master`, con clientes reales (node-haxball) en procesos aparte.
> Datos crudos: `bench/results/*.json`. Tablas regenerables con `node bench/net/report.mjs`.

## 0. Resumen

Valores = mediana de 3 repeticiones (60 s de ventana tras 15 s de calentamiento; ociosa 3 × 200 s).
CPU en % de **un** núcleo (100 % = un núcleo entero), medido con `process.cpuUsage()` sobre el
proceso host completo (hilo JS + hilos nativos de WebRTC).

| escenario | métrica | haxlite | oficial (haxball.js) | node-haxball |
|---|---|---:|---:|---:|
| sala pública ociosa, 0 jugadores | CPU % | **0,031** | 0,403 | 1,293 |
| | RSS / heap usado (MB) | 69,7 / 9,1 | 75,7 / 9,7 | 71,5 / 11,6 |
| partida, 4 clientes | CPU % | 4,74 – 5,71 ¹ | 4,76 – 5,17 ¹ | 5,88 |
| partida, 10 clientes | CPU % | 9,79 | 10,13 | 11,76 |
| partida, 20 clientes | CPU % | **21,76** | 23,52 | 25,71 |
| | RSS / heap usado (MB) | 85,5 / **10,7** | 89,8 / 12,4 | 92,8 / 16,0 |
| | GC por minuto / ms de GC por minuto | **17 / 7,6** | 98 / 76,8 | 98 / 61,2 |
| | lag del event loop p50 / p99 (ms) | 0,17 / 1,44 | 0,16 / 1,71 | 0,20 / 1,67 |
| 10 salas × 4 clientes, 1 proceso | CPU % | **28,1** | 31,6 | 33,2 |
| | RSS / heap usado (MB) | **92,4 / 11,8** | 105,4 / 17,9 | 103,3 / 18,5 |
| arranque → link de sala | ms desde el inicio del proceso | 202 | 211 | 215 |
| física (`stepWorld`, Classic 13 discos) | ns/tick | **1044** | 1902 | — |

¹ Rango de medianas de las tres tandas que midieron N = 4 (§4.3): con 1 sala y pocos clientes
haxlite queda **igual o hasta ~10 % por encima** del oficial (coste fijo de su reloj de 60 Hz, §5.1).

Conclusiones cortas (detalle en §5):

* **Ociosa**, haxlite es ~13× más barato que el oficial y ~40× que node-haxball, pero en valores
  absolutos todos son despreciables (0,03 % vs 0,4 % de un núcleo).
* **Con jugadores**, el coste lo domina WebRTC: ~la mitad de la CPU está en hilos nativos de
  libdatachannel (iguales en los tres) y buena parte del hilo JS son las llamadas nativas de
  envío/recepción. haxlite ahorra un **~7 % de CPU con 20 clientes** y un **~11 % con 10 salas**,
  sobre todo en el hilo JS; con 1 sala y 4 clientes no gana (≈ +0,3–0,5 puntos).
* Donde haxlite sí se separa claramente es en **memoria del heap y GC**: heap plano (~10,7 MB con
  1 sala, +0,2 MB por sala extra frente a +0,8 MB del oficial) y **5–6× menos GC** (8–10× menos
  tiempo de GC). El RSS (70–105 MB) lo domina el runtime de Node + TLS + libdatachannel.
* **Lag del event loop**: sin diferencias relevantes (p50 ≈ 0,15–0,2 ms, p99 ≈ 1–1,7 ms en los
  tres). Ninguna implementación bloquea el loop lo bastante como para afectar al netcode.
* **Física**: ×1,85–×1,97 más rápida que la oficial, pero 1 µs por tick son 0,006 % de un núcleo
  a 60 Hz: irrelevante para el consumo total del host.
* **Pasada de ligereza (§7)**: reloj único por proceso (17 despertares/s por sala en partida en
  vez de 60; hilo JS −28 % con 4 clientes, GC a la mitad), camino de mensajes casi sin
  asignaciones (665 → 123 B/mensaje), arranque 192 → 139 ms, paquete instalado 1,4 → 0,77 MB, y
  flags recomendados (−7 MB de RSS).
* **Backend `peerBackend: 'rtc'`** (haxlite-rtc, servidores con IP pública): con 20 clientes el
  host completo baja de 19,1 % a **12,4 %** de CPU (−35 %) y de 19 a 11 hilos (sección final).

## 1. Qué se compara

| | haxlite | oficial | node-haxball |
|---|---|---|---|
| código | `src/` compilado con `tsc` (`npm run bench:build` → `node_modules/.cache/haxlite-bench/dist`) | `haxball.js` 5.1.0 (script `headless-min.js` oficial evaluado en Node) | `node-haxball` 2.3.1 `Room.create` |
| API usada | `HostRoom` + `HostTransport` (como hará la fachada `HBInit`) | `HBInit` | `Room.create` + `room.setPlayerTeam/startGame…` |
| WebRTC | `node-datachannel` 0.33.4 (libdatachannel) | `@webrtc-node/webrtc` 0.2.1 (también libdatachannel, con capa JS W3C) | `node-datachannel` 0.25 (polyfill W3C) |
| reloj | `setTimeout` por frame (60 Hz) con partida; sin timers ociosa | `setInterval(…, 50)` siempre | timers propios |

Misma configuración de sala en las tres: pública, `noPlayer`, `maxPlayers` 30, misma geo, estadio
Classic por defecto, límites de goles/tiempo a 0 (la partida no termina), servidores STUN por
defecto (inalcanzables offline: solo candidatos `host`).

### 1.1 Cómo se ejecuta cada host offline (solo en el arnés, sin tocar las librerías)

* **haxlite**: `HostTransport({ masterUrl: 'http://127.0.0.1:PUERTO/rs/' })`.
* **oficial (haxball.js)**: `haxball.js` no permite cambiar el backend, pero carga `xhr2` y `ws`
  como módulos normales. El arnés parchea `XMLHttpRequest.prototype.open` de `xhr2` (el mismo
  módulo que importa `haxball.js`) para reescribir `https://www.haxball.com/rs/` → FakeMaster; la
  URL del WebSocket del host ya viene en la respuesta de `api/host` (`ws://…/host`). WebRTC se
  inyecta con la opción pública `webrtc` de `HaxballJS()` (ver shims).
* **node-haxball**: `require('node-haxball')(window, { backend: { hostname, hostnameWs, secure: false } })`.

Shims de compatibilidad (clientes node-haxball, no afectan al comportamiento del host):

1. **Retraso del primer envío por canal (40 ms)** en los hosts oficial y node-haxball. Los clientes
   node-haxball (libdatachannel) descartan mensajes que llegan antes de ver abiertos todos sus
   canales; esos hosts envían el *challenge* en cuanto abre el canal 0 y ~20 % de las uniones por
   loopback se cuelgan. haxlite hace lo mismo de serie (`challengeDelayMs = 40`). El envoltorio
   solo difiere los envíos de los primeros 40 ms de cada canal; después `send()` se llama directo
   (coste en régimen: una llamada y una comparación por mensaje).
2. **Candidatos `a=candidate:`** (solo host oficial): node-haxball manda sus candidatos ICE con el
   prefijo SDP `a=`; los navegadores no. `@webrtc-node/webrtc` los rechaza y la unión falla
   siempre; el envoltorio de `addIceCandidate` quita el prefijo.

## 2. Metodología

### 2.1 Procesos

Cada repetición arranca procesos nuevos:

```
bench/net/run.ts (orquestador, TS) ── FakeMaster (HTTP + WS de señalización en 127.0.0.1)
  ├─ bench/net/host-proc.mjs     host bajo prueba (JS plano: sin cargador de TypeScript en el
  │                              proceso medido); se mide a sí mismo y responde por IPC
  └─ bench/net/clients-proc.mjs  × ⌈clientes/10⌉  clientes node-haxball (nunca se cuentan)
```

* **Clientes**: node-haxball (`Room.join`) con identidad ECDSA, en procesos separados (≤ 10 por
  proceso). Se unen secuencialmente; el host reparte equipos alternos rojo/azul y arranca la partida.
* **Carga de juego (idéntica para los tres hosts, PRNG con semilla)**: cada cliente cambia su
  estado de teclas cada 60–250 ms (uniforme, ≈ 6,5 cambios/s: un jugador muy activo), una de 9
  direcciones y tiro el 25 % de las veces; chat con probabilidad 1/200 por cambio (≈ 1 mensaje cada
  30 s por cliente). Los contadores confirman la misma carga: p. ej. N = 20 → 9654–9806 inputs y
  46–52 chats por repetición en los tres hosts.
* **Validez**: antes de medir el host debe ver los N jugadores; al final, los N siguen conectados
  y ningún cliente se desconectó (`valid` en el JSON). Todas las repeticiones publicadas son válidas.

### 2.2 Métricas (en el proceso host)

* **CPU**: `process.cpuUsage()` (usuario + sistema, todos los hilos del proceso) / tiempo de pared
  de la ventana. Además, reparto **por hilo** leyendo `/proc/self/task/*/stat` al inicio y al final
  (solo Linux; `main (JS)` = hilo principal; `RTC worker`, `juice poll`, `SCTP timer` = hilos de
  libdatachannel; `node` = hilos de la plataforma V8: GC concurrente, compilación).
* **Memoria**: `process.memoryUsage()` cada 1 s (5 s en ociosa): RSS y heap usado medios/máximos.
* **GC**: `PerformanceObserver` de entradas `gc` (número y duración).
* **Lag del event loop**: `monitorEventLoopDelay({ resolution: 10 })`. El histograma guarda el
  intervalo entre disparos de su timer de 10 ms; se publica `lag = valor − 10 ms` (p50/p99/máx).
  No se usa en ociosa (su propio timer de 100 Hz dominaría la CPU medida).
* **Arranque**: `performance.now()` del proceso host (ms desde que Node arranca) al recibir el
  link; `creación → link` = desde la llamada que crea la sala; CPU consumida hasta el link.

### 2.3 Repeticiones, ruido y equidad

* 3 repeticiones por configuración (10 en arranque), **intercaladas** (rep 1 de todas las
  configuraciones, luego rep 2…) para que la deriva de la máquina afecte a todos por igual.
  Se publica **mediana (mín–máx)**.
* La máquina era compartida con otros procesos (tests de otros ingenieros). El orquestador mide la
  CPU de todo el sistema (`/proc/stat`) durante la ventana y resta la de sus propios procesos:
  columna **«ajeno %»**. Si supera el 100 % de un núcleo, se repite (máx. 2 intentos; si sigue
  ruidoso se conserva el menos ruidoso y se marca `noisy`, `*` en las tablas). Las tandas
  «ociosa», «K salas» y la de confirmación se midieron con la máquina tranquila (ajeno ≤ 4–9 %);
  la tanda «partida» tuvo ruido ajeno en N = 4 y N = 10 (mediana 47–82 %).
* Mismo escenario, mismos clientes, mismo estadio, mismas duraciones y mismo PRNG para los tres.

### 2.4 Máquina y versiones

Intel Xeon @ 2,80 GHz, **4 vCPU** (VM Firecracker), 16 GB, Linux 6.18, **Node v22.22.0**
(V8 12.4). haxball.js 5.1.0, node-haxball 2.3.1, node-datachannel 0.33.4, @webrtc-node/webrtc 0.2.1.
haxlite medido: build `88aef57bf1d4` (commit `aef9533` + árbol de trabajo del 10-10-2026 18:57
UTC) para las tandas principales; build `ff0326f10e5e` (commit `25af3d4`, con el blindaje de red
de `2f25b6b`) para la tanda de confirmación §4.3 y los diagnósticos. El hash del build medido va
en `info.haxliteBuildSha` de cada JSON.

### 2.5 Comandos exactos

```sh
npm ci
npm run bench:build                       # compila src/ → node_modules/.cache/haxlite-bench/dist
R="node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts"
$R startup                                # 10 reps × 3 hosts            → bench/results/startup.json
$R game                                   # N = 4,10,20 × 3 hosts × 3    → bench/results/game.json
$R rooms --impl haxlite,official,nodehaxball   # K = 1,5,10 × 4 clientes → bench/results/rooms.json
$R idle                                   # 3 × 200 s × 3 hosts          → bench/results/idle.json
for i in 1 2 3; do npm run -s bench:sim -- --out bench/results/sim.json; done
node bench/net/report.mjs                 # tablas markdown de este documento
# confirmación con el build actual y diagnósticos
$R game --impl haxlite,official --n 4,20 --out bench/results/game-head.json
$R game --impl haxlite,official --n 4 --eld 0 --out bench/results/diag-noeld.json
HAXLITE_HOST_OPTS='{"heartbeatFrames":9}' $R game --impl haxlite --n 4,20 --out bench/results/diag-heartbeat9.json
node bench/timer.bench.mjs 20 1; node bench/timer.bench.mjs 20 10   # → bench/results/timer.json
```

Atajos: `npm run bench:startup|bench:idle|bench:game|bench:rooms` (compilan antes) y
`npm run bench:sim`. Flags: `--reps`, `--warmup`, `--window`, `--n`, `--k`, `--impl`,
`--max-foreign`, `--attempts`, `--eld 0`, `--host-node-args "--cpu-prof …"`; variables de
diagnóstico `HOST_CPU_PROFILE=<archivo>` (perfil V8 del hilo JS solo durante la ventana) y
`HAXLITE_HOST_OPTS` (opciones extra de `HostRoom`; nunca usadas en las tablas principales).
Duración total aproximada: 3–4 h (cada repetición con clientes ≈ 100 s).

## 3. Escenarios

| | descripción | ventana |
|---|---|---|
| (a) ociosa | sala pública, 0 jugadores, sin partida | 10 s calentamiento + 200 s × 3 reps = **10 min** por host |
| (b) partida | 1 sala, N = 4, 10, 20 clientes jugando una partida en curso | 15 s + 60 s × 3 |
| (c) K salas | K = 1, 5, 10 salas en **un** proceso, 4 clientes por sala (los tres hosts; el oficial evalúa una copia del script por sala) | 15 s + 60 s × 3 |
| (d) arranque | proceso nuevo → link de sala (`onRoomLink`) | 10 reps |

## 4. Resultados

Formato: mediana (mín–máx). «clientes CPU %» = CPU de los procesos de clientes (no contada en el
host; sirve para ver que la carga generada es la misma).

### 4.1 Arranque (d)

| host | reps | inicio proceso → link (ms) | creación → link (ms) | carga módulos (ms) | CPU hasta link (ms) | RSS al link (MB) | heap al link (MB) |
|---|---|---|---|---|---|---|---|
| haxlite | 10 | 202 (178–309) | 20.2 (16.6–28.6) | 134 (116–188) | 270 (239–402) | 76.2 (74.5–76.8) | 10.4 (10.4–10.5) |
| oficial (haxball.js) | 10 | 211 (189–283) | 28.4 (25.9–41.3) | 133 (118–191) | 312 (275–378) | 74.9 (70.6–76.9) | 10.4 (10.4–10.4) |
| node-haxball | 10 | 215 (187–280) | 25.5 (22.3–34.4) | 141 (114–178) | 241 (214–305) | 72.9 (72.2–73.5) | 12.4 (12.4–12.5) |

Prácticamente igual: ~200 ms, dominados por el arranque de Node (~40 ms) y la carga de módulos
(~130 ms: `ws`/TLS y la librería nativa de WebRTC). La FakeMaster es local, así que `creación →
link` (20–28 ms) no incluye latencia real de haxball.com.

### 4.2 Sala pública ociosa (a)

| host | reps × ventana | CPU % | CPU ms/min | RSS medio (MB) | Δ RSS en ventana (MB) | heap usado medio (MB) | GC/min | ajeno % |
|---|---|---|---|---|---|---|---|---|
| haxlite | 3 × 200 s | 0.031 (0.030–0.031) | 18 (18–19) | 69.7 (69.2–72.4) | 0.25 (0.25–0.25) | 9.1 (9.1–9.2) | 0.0 (0.0–0.0) | 3 (3–3) |
| oficial (haxball.js) | 3 × 200 s | 0.403 (0.399–0.421) | 242 (239–253) | 75.7 (73.4–78.8) | 1.63 (1.50–1.76) | 9.7 (9.7–9.7) | 0.6 (0.6–0.6) | 3 (3–3) |
| node-haxball | 3 × 200 s | 1.293 (1.243–1.295) | 776 (746–777) | 71.5 (70.2–71.6) | -2.33 (-2.58–3.14) | 11.6 (11.5–11.6) | 3.9 (2.7–3.9) | 3 (3–3) |

* haxlite no arma ningún timer de juego sin clientes ni partida: lo que queda (18 ms de CPU por
  minuto) son el barrido de 1 Hz de `HostTransport`, el keep-alive de señalización y el propio
  muestreo de memoria del arnés (cada 5 s). Ningún GC en 10 minutos.
* El oficial ejecuta `setInterval(…, 50)` siempre (20 despertares/s): 0,40 %. Es coherente con el
  micro-benchmark de timers (§5.1: un `setInterval` de 50 ms vacío cuesta 0,33 % en esta VM).
* Ninguno muestra fuga: Δ RSS ≤ 1,8 MB en 200 s, heap estable.

### 4.3 Partida en curso, 1 sala con N clientes (b)

| config | reps | CPU % | RSS medio (MB) | heap usado medio (MB) | lag p50 (ms) | lag p99 (ms) | lag máx (ms) | GC/min | GC ms/min | clientes CPU % | ajeno % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| haxlite N=4 | 3* | 4.74 (4.13–5.60) | 80.1 (79.6–81.9) | 10.2 (10.1–10.6) | 0.19 (0.19–0.20) | 1.13 (0.97–1.71) | 21.7 (5.2–26.5) | 10.0 (7.0–12.0) | 4.5 (2.8–14.2) | 6 (6–7) | 82 (4–142) |
| oficial (haxball.js) N=4 | 3 | 4.76 (4.59–5.05) | 80.0 (78.0–84.2) | 10.8 (10.8–10.9) | 0.15 (0.15–0.17) | 1.02 (1.02–1.35) | 37.2 (35.1–63.8) | 18.0 (18.0–19.0) | 7.7 (6.6–7.7) | 6 (6–7) | 52 (4–88) |
| node-haxball N=4 | 3 | 5.88 (5.58–6.22) | 84.4 (84.3–85.5) | 14.1 (14.0–14.1) | 0.22 (0.22–0.22) | 1.14 (1.01–1.35) | 44.7 (10.3–49.4) | 35.0 (34.0–36.0) | 14.1 (11.7–14.6) | 7 (6–7) | 78 (4–92) |
| haxlite N=10 | 3 | 9.79 (9.57–10.00) | 84.1 (84.0–88.3) | 10.6 (10.6–10.6) | 0.18 (0.17–0.18) | 1.32 (1.05–1.36) | 51.7 (51.3–155.4) | 12.0 (11.0–14.0) | 4.5 (4.4–5.9) | 14 (14–15) | 74 (4–94) |
| oficial (haxball.js) N=10 | 3 | 10.13 (9.63–10.50) | 82.8 (82.5–85.8) | 11.6 (11.6–11.6) | 0.15 (0.14–0.15) | 1.27 (1.01–1.29) | 31.1 (13.8–44.6) | 58.0 (57.0–59.0) | 25.9 (23.5–27.5) | 14 (13–14) | 47 (4–73) |
| node-haxball N=10 | 3 | 11.76 (11.48–11.91) | 86.5 (86.2–86.7) | 15.2 (15.1–15.2) | 0.19 (0.18–0.20) | 1.18 (1.05–1.18) | 4.9 (4.7–24.1) | 68.0 (65.0–71.0) | 28.2 (25.1–29.9) | 14 (14–14) | 48 (3–55) |
| haxlite N=20 | 3 | 21.76 (20.79–21.83) | 85.5 (84.8–87.0) | 10.7 (10.7–10.7) | 0.17 (0.17–0.17) | 1.44 (1.37–1.71) | 22.5 (13.3–62.6) | 17.0 (15.0–18.0) | 7.6 (7.6–8.4) | 42 (40–42) | 28 (2–42) |
| oficial (haxball.js) N=20 | 3 | 23.52 (22.52–23.63) | 89.8 (87.2–91.0) | 12.4 (12.4–12.5) | 0.16 (0.16–0.17) | 1.71 (1.49–3.16) | 55.2 (52.6–115.2) | 98.0 (95.0–99.0) | 76.8 (72.1–80.0) | 42 (40–42) | 42 (3–81) |
| node-haxball N=20 | 3 | 25.71 (25.29–27.28) | 92.8 (91.8–94.1) | 16.0 (16.0–16.0) | 0.20 (0.19–0.21) | 1.67 (1.61–2.08) | 132.5 (6.4–145.1) | 98.0 (97.0–102.0) | 61.2 (60.7–68.6) | 43 (41–45) | 4 (2–41) |

Reparto por hilo (mediana, % de un núcleo):

| config | main (JS) | RTC worker | juice poll | SCTP timer | node (V8) |
|---|---|---|---|---|---|
| haxlite N=4 | 2.53 | 1.52 | 0.64 | 0.30 | 0.15 |
| oficial (haxball.js) N=4 | 2.20 | 1.55 | 0.61 | 0.32 | 0.15 |
| node-haxball N=4 | 3.08 | 1.62 | 0.65 | 0.32 | 0.20 |
| haxlite N=10 | 4.11 | 3.70 | 1.58 | 0.32 | 0.20 |
| oficial (haxball.js) N=10 | 4.31 | 3.84 | 1.60 | 0.32 | 0.23 |
| node-haxball N=10 | 5.33 | 4.13 | 1.70 | 0.32 | 0.36 |
| haxlite N=20 | 8.48 | 8.83 | 3.90 | 0.33 | 0.17 |
| oficial (haxball.js) N=20 | 9.85 | 8.78 | 3.92 | 0.33 | 0.37 |
| node-haxball N=20 | 11.46 | 9.35 | 4.05 | 0.35 | 0.47 |

**Tanda de confirmación** (máquina tranquila, build actual `ff0326f10e5e` con el blindaje de red,
`bench/results/game-head.json`, haxlite y oficial intercalados):

| config | CPU % | main (JS) | heap usado (MB) | GC/min | lag p50 / p99 (ms) | ajeno % |
|---|---|---|---|---|---|---|
| haxlite N=4 | 5.71 (5.38–5.74) | 2.80 | 10.2 | 8 | 0.21 / 0.98 | 6 |
| oficial N=4 | 5.17 (5.16–5.19) | 2.35 | 10.8 | 18 | 0.17 / 0.96 | 9 |
| haxlite N=20 | 22.23 (21.52–23.06) | 8.63 | 10.8 | 16 | 0.18 / 1.42 | 6 |
| oficial N=20 | 23.96 (23.56–24.19) | 10.17 | 12.4 | 97 | 0.17 / 1.58 | 7 |

Confirma la tanda principal: con 20 clientes haxlite −7 % de CPU (−15 % en el hilo JS); con 4
clientes y la máquina tranquila haxlite queda **+10 %** sobre el oficial (+0,45 puntos en el hilo
JS; causa en §5.1). La tanda principal de N = 4 (paridad) tuvo mucho ruido ajeno.

### 4.4 K salas en un proceso, 4 clientes por sala (c)

| config | reps | CPU % | RSS medio (MB) | heap usado medio (MB) | lag p50 (ms) | lag p99 (ms) | lag máx (ms) | GC/min | GC ms/min | clientes CPU % | ajeno % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| haxlite K=1 | 3 | 5.39 (5.31–5.49) | 79.9 (78.6–84.3) | 10.1 (10.1–10.2) | 0.20 (0.20–0.21) | 0.96 (0.94–0.98) | 34.2 (21.9–45.6) | 9.0 (8.0–9.0) | 3.7 (3.4–3.7) | 7 (7–7) | 4 (3–4) |
| oficial (haxball.js) K=1 | 3 | 5.11 (4.77–5.28) | 80.9 (79.3–88.4) | 10.9 (10.9–10.9) | 0.17 (0.16–0.17) | 0.94 (0.94–0.96) | 54.5 (11.7–58.2) | 18.0 (18.0–19.0) | 7.0 (6.7–7.8) | 7 (6–7) | 4 (3–4) |
| node-haxball K=1 | 3 | 6.33 (6.31–6.46) | 84.4 (84.3–84.9) | 14.1 (14.0–14.1) | 0.22 (0.21–0.22) | 0.99 (0.98–1.00) | 31.0 (27.2–41.3) | 36.0 (34.0–36.0) | 13.3 (12.8–13.6) | 7 (7–7) | 4 (3–4) |
| haxlite K=5 | 3 | 16.05 (15.01–17.24) | 87.0 (86.8–88.1) | 11.1 (11.1–11.2) | 0.15 (0.14–0.17) | 1.03 (1.01–1.04) | 12.0 (5.9–22.3) | 27.0 (27.0–28.0) | 11.6 (10.7–13.4) | 25 (23–26) | 3 (2–3) |
| oficial (haxball.js) K=5 | 3 | 17.81 (17.37–19.12) | 92.4 (87.5–95.7) | 15.0 (14.9–15.0) | 0.16 (0.14–0.16) | 1.09 (1.06–1.19) | 4.9 (4.8–57.3) | 163.0 (163.0–163.0) | 79.0 (76.5–84.8) | 24 (23–26) | 3 (2–4) |
| node-haxball K=5 | 3 | 19.53 (18.03–20.99) | 93.4 (92.8–94.3) | 16.7 (16.6–16.8) | 0.16 (0.14–0.17) | 1.08 (1.07–1.10) | 26.9 (7.5–60.9) | 85.0 (85.0–86.0) | 41.3 (38.3–41.4) | 25 (23–27) | 3 (3–4) |
| haxlite K=10 | 3 | 28.08 (26.92–32.13) | 92.4 (92.2–94.4) | 11.8 (11.8–11.8) | 0.11 (0.11–0.13) | 1.06 (1.05–1.11) | 35.1 (18.9–43.6) | 45.0 (45.0–46.0) | 17.7 (17.2–20.6) | 47 (44–54) | 0 (0–2) |
| oficial (haxball.js) K=10 | 3 | 31.62 (30.85–33.74) | 105.4 (102.2–109.7) | 17.9 (17.9–18.0) | 0.14 (0.13–0.15) | 1.17 (1.11–1.19) | 10.5 (4.5–35.5) | 239.0 (236.0–239.0) | 148.3 (139.8–159.7) | 45 (43–48) | 0 (0–4) |
| node-haxball K=10 | 3 | 33.21 (31.01–33.89) | 103.3 (102.4–103.6) | 18.5 (18.4–18.6) | 0.13 (0.12–0.13) | 1.18 (1.07–1.28) | 53.7 (5.9–63.3) | 152.0 (152.0–156.0) | 75.4 (74.7–78.6) | 46 (43–47) | 0 (0–0) |

| config | main (JS) | RTC worker | juice poll | SCTP timer | node (V8) |
|---|---|---|---|---|---|
| haxlite K=1 | 2.60 | 1.62 | 0.65 | 0.35 | 0.15 |
| oficial (haxball.js) K=1 | 2.27 | 1.67 | 0.63 | 0.33 | 0.15 |
| node-haxball K=1 | 3.28 | 1.80 | 0.70 | 0.37 | 0.23 |
| haxlite K=5 | 6.27 | 6.38 | 2.90 | 0.35 | 0.18 |
| oficial (haxball.js) K=5 | 7.78 | 6.38 | 2.87 | 0.35 | 0.45 |
| node-haxball K=5 | 8.73 | 6.95 | 3.13 | 0.38 | 0.37 |
| haxlite K=10 | 10.53 | 11.17 | 5.75 | 0.47 | 0.13 |
| oficial (haxball.js) K=10 | 13.58 | 11.33 | 5.73 | 0.42 | 0.57 |
| node-haxball K=10 | 14.53 | 11.95 | 5.93 | 0.50 | 0.35 |

Coste marginal por sala extra (K = 1 → 10, 4 clientes cada una):

| | CPU (puntos/sala) | RSS (MB/sala) | heap usado (MB/sala) |
|---|---|---|---|
| haxlite | +2,5 | **+1,4** | **+0,19** |
| oficial | +2,9 | +2,7 | +0,78 |
| node-haxball | +3,0 | +2,1 | +0,49 |

40 clientes repartidos en 10 salas cuestan bastante menos que lo que sugeriría escalar la sala de
20 (la retransmisión de inputs es O(N²) por sala: cada input se reenvía a los N clientes).

### 4.5 Física (`bench/sim.bench.ts`, `stepWorld` vs `Oa.Da` oficial)

| escenario | reps | haxlite ns/tick | oficial ns/tick | aceleración | crecimiento heap haxlite (KiB / 200k ticks) |
|---|---|---|---|---|---|
| Classic, 8 players (13 discs) | 3 | 1044 (1031–1083) | 1902 (1832–1964) | ×1.85 (1.69–1.88) | 18 (18–18) |
| Huge, 25 players (30 discs) | 3 | 3433 (3377–3777) | 6746 (6364–6844) | ×1.97 (1.68–2.03) | 0 (0–0) |

(Mejor de 5 rondas de 200 000 ticks, 3 procesos; `bench/results/sim.json`.) A 60 Hz, 1–3,5 µs por
tick son 0,006–0,02 % de un núcleo: la física **no** es el cuello de botella del host.

## 5. Análisis y hallazgos de rendimiento en haxlite

### 5.1 Coste fijo del reloj por frame (hallazgo, sin cambiar `src/`)

Con 1 sala y 4 clientes el hilo JS de haxlite gasta +0,3–0,45 puntos más que el oficial
(2,60 vs 2,27 en K = 1; 2,80 vs 2,35 en la tanda de confirmación), aunque procesa los mismos
mensajes con menos trabajo JS. Evidencia:

1. **Perfil V8 del hilo JS durante la ventana** (`HOST_CPU_PROFILE`, N = 4, 30 s): en haxlite el
   código de timers de Node (`processTimers`, `listOnTimeout`, constructor `Timeout`, `insert`) y
   los hooks async suman ~100 ms/30 s (≈ 0,33 % de un núcleo) frente a ~25 ms en el oficial; el
   código propio de haxlite (host, sequencer, room, sim, codec) es < 0,5 % en total.
2. **Micro-benchmark** `bench/timer.bench.mjs` (`bench/results/timer.json`), sin red ni juego:

   | estrategia | 1 sala: CPU % (despertares/s) | 10 salas: CPU % (despertares/s) |
   |---|---|---|
   | `setTimeout` re-armado por frame (haxlite) | 0,84 (61) | 1,47 (615) |
   | mismo, reutilizando el `Timeout` con `refresh()` | 0,93 (61) | 1,22 (610) |
   | un timer de 60 Hz compartido por todas las salas | 1,11 (61) | 1,09 (614 llamadas) |
   | `setInterval(…, 50)` (oficial) | 0,33 (20) | 0,34 (199) |

   En esta VM cada despertar del proceso cuesta ~140–165 µs (sobre todo kernel/epoll, no JS),
   así que lo que pesa es la **frecuencia** de despertares (60/s vs 20/s), no la asignación del
   `Timeout`. Con varias salas los timers coinciden en el mismo ciclo del loop y el coste crece
   poco.
3. **No es un artefacto del monitor de lag**: sin `monitorEventLoopDelay` la diferencia se
   mantiene (N = 4: haxlite 4,91 (4,85–5,12) % vs oficial 4,46 (4,46–4,60) %, `diag-noeld.json`).
4. **No son los heartbeats**: con `heartbeatFrames: 9` (cadencia ≈ oficial) la CPU no baja
   (`diag-heartbeat9.json`: N = 4 5,68 %, N = 20 22,5 %).

Impacto: ~0,3–0,5 % de un núcleo por proceso (no por cliente). Es el precio de enviar heartbeats y
eventos en el frame exacto en lugar de cuantizados a 50 ms (menos jitter para los clientes).
**Sugerencias** (para el dueño de `src/host`):
* opción `clockIntervalMs`/`tickBatchFrames` (p. ej. despertar cada 2–3 frames y simular el
  atraso, como el oficial) para quien prefiera CPU a precisión;
* para muchos procesos/salas, un reloj **compartido por proceso** (un timer para todas las
  `HostRoom`); `refresh()` no aporta nada medible.

### 5.2 El hilo JS lo dominan las llamadas nativas de WebRTC (no es un problema de haxlite)

Perfil N = 20: ~5,8 % de un núcleo en funciones nativas sin nombre (`sendMessageBinary` de
node-datachannel y las callbacks N-API de mensajes entrantes), frente a ~1,6 % del JS de haxlite
(host, sequencer, codec, física). En el oficial lo equivalente es ~7 % + ~1 % de su capa JS
W3C (`@webrtc-node/webrtc`) + 1 % de su script. Con N clientes, cada input se reenvía a N
destinatarios: ≈ 20 × 6,5 × 20 ≈ 2 600 envíos/s más ~170 heartbeats/s: unos 20 µs
de hilo JS por envío (más el trabajo en los hilos de libdatachannel: `RTC worker` + `juice poll`
≈ 13 % con 20 clientes, igual en los tres hosts). Los perfiles se tomaron con el profiler activo
(que encarece todo ~2×): solo valen las proporciones. No es reducible sin cambiar el protocolo (no hay envío por
lotes en HaxBall 9). Posible mejora menor a evaluar en `src/net`: evitar el envoltorio JS por
mensaje (`net/webrtc.js`) en el camino de recepción si el blindaje lo permite.

### 5.3 Memoria y GC

* El camino caliente casi no asigna: 15–17 GC/min con 20 clientes (frente a 98) y heap plano
  (~10,7 MB). Esto corrobora las reglas de §4.1 de docs/06.
* El RSS (70–105 MB) lo fija el runtime: Node vacío 42 MB; + `node-datachannel` 60 MB; + `ws`/TLS
  e imports de haxlite 74 MB (medido con imports aislados). No hay margen grande en haxlite ahí.
* Sin fugas en 10 min ociosos ni en las ventanas de 60 s (heap estable, Δ RSS < 2 MB).

### 5.4 Lag del event loop

p50 0,11–0,22 ms y p99 0,9–1,8 ms en los tres hosts y en todos los escenarios. Los máximos
(5–155 ms) aparecen en los tres sin patrón y coinciden con ruido ajeno; no son atribuibles a
ninguna implementación con 3 repeticiones. haxlite muestra p50 ~0,03 ms más alto que el oficial
(más timers por segundo compitiendo con el del monitor), sin efecto práctico. Ninguno se acerca a
un frame (16,7 ms) en p99.

### 5.5 Incidencias observadas

* 1 de las ~80 repeticiones con clientes (haxlite N = 20, build actual) falló: 16/20 clientes
  unidos tras 4 intentos cada uno; en el reintento, el link de sala tardó 41,7 s (compatible con
  el reintento de señalización de 10–60 s tras un primer fallo de conexión al master). No se
  reprodujo en 20 arranques aislados ni en el resto de tandas; la máquina tenía tests de estrés
  de otros ingenieros en ese momento. Queda registrado en `game-head.json` (`discarded`).
* En la tanda principal de N = 4 haxlite tuvo una repetición marcada `noisy` (ajeno 142 %).

## 6. Advertencias (caveats)

* **Máquina compartida**: 4 vCPU de una VM con otros procesos. La CPU del host (`cpuUsage`) es
  robusta al ruido; el lag del event loop y los máximos no tanto. Ver columna «ajeno %».
* **Loopback**: sin pérdida, latencia ni jitter reales; DTLS/SCTP sí se ejecutan. Con red real el
  coste por mensaje (retransmisiones SCTP, ICE) puede ser mayor y los timers de 50 ms del oficial
  añadirían jitter que aquí no se mide.
* Los clientes son node-haxball, no navegadores; los dos shims de §1.1 son necesarios para ellos.
* El monitor de lag (timer de 10 ms) y el muestreo de 1 s también consumen CPU dentro del proceso
  medido, igual para los tres: **≈ 0,7–0,8 puntos** (N = 4 sin monitor, `diag-noeld.json`:
  haxlite 4,91 %, oficial 4,46 %, frente a 5,71 % / 5,17 % con monitor en la misma máquina). Los
  valores absolutos de CPU en partida y K salas lo incluyen; las diferencias entre hosts no cambian.
* El host oficial corre en `haxball.js` (Node, `@webrtc-node/webrtc`, pako sustituido por zlib),
  no en el navegador headless de haxball.com; node-haxball usa su propio `node-datachannel` 0.25.
* En K salas el oficial y node-haxball evalúan/crean una instancia por sala en el mismo proceso;
  no es su forma de despliegue habitual (normalmente un proceso/navegador por sala, lo que
  multiplicaría el RSS base de ~70 MB por sala).
* 3 repeticiones de 60 s: diferencias menores de ~5 % en CPU están dentro del ruido (ver rangos).
* haxlite evoluciona en paralelo (`src/net` se endureció durante las mediciones); la tanda de
  confirmación con el build actual reproduce las conclusiones.

## 7. Pasada de ligereza (src/host, room, sim, codec, replay, api, build)

Objetivo: menos CPU, despertares, memoria, GC, arranque y tamaño de instalación **sin cambiar el
comportamiento** (los tests oráculo siguen bit-exactos; suite completa en verde). A/B con el
mismo arnés: `base` = build anterior (snapshot del árbol antes de la pasada), `new` = esta pasada
con el **mismo** `src/net` congelado, para aislar los cambios de L1. Las corridas de red usan
`--eld 0` (sin el monitor de lag, cuyo timer de 100 Hz taparía los despertares que se quieren
medir). Todas las mediciones se hicieron con `flock /tmp/haxlite-bench.lock` (sin solaparse con
las de otros ingenieros).

### 7.1 Reloj compartido por proceso (§5.1 resuelto)

`src/host/clock.ts` (`hostClock`): **un único `setTimeout`** para todas las `HostRoom` del
proceso, armado para la sala con trabajo más próximo y re-armado solo cuando ese instante
cambia. Cada sala pide despertar en: el frame exacto del próximo heartbeat y del próximo
CheckConsistency (con clientes), el próximo evento encolado (sin partida), el Ping de 3 s, y con
partida como mucho cada `maxWakeFrames` (nuevo, por defecto 4 = 66,7 ms; el oficial ≈ 3 frames /
50 ms), repartidos dentro de cada periodo de heartbeat (frames +4 y +7). La aritmética de frames
no cambia: cada frame se simula una vez, en lotes como el bucle de 50 ms oficial; los heartbeats
salen en el mismo frame que antes (+~1 ms de holgura del timer, que evita los disparos
adelantados del reloj de milisegundos de libuv: sin ella ~13 % de despertares extra). Sala sin
clientes ni partida: **cero** despertares. `maxWakeFrames: Infinity` → solo heartbeats/mensajes.

Despertares del proceso, sin red (`bench/wakeups.bench.mjs`, 1 cliente falso por sala, partida
en curso, 10 s):

| | haxlite antes | haxlite ahora | ahora, `maxWakeFrames: Infinity` | oficial |
|---|---:|---:|---:|---:|
| 1 sala, despertares/s | 61,5 | **17,3** | 8,7 | 20 |
| 10 salas, despertares/s | 637,9 | **137,8** | 87,0 | 200 |
| sala ociosa (sin clientes ni partida) | 0 | 0 | 0 | 20 |

Con red real (`bench/results/lite-game.json`, `lite-rooms.json`; mediana (mín–máx)):

| config | CPU % antes | CPU % ahora | hilo JS antes → ahora | GC/min antes → ahora | GC ms/min |
|---|---:|---:|---|---|---|
| 1 sala, N = 4 (3 reps) | 4,87 (4,74–5,30) | **4,31** (4,13–4,36) | 2,18 → **1,57** (−28 %) | 8 → 5 | 3,3 → 1,9 |
| 1 sala, N = 20 (3 reps) | 20,90 (20,30–21,98) | 21,17 (20,02–21,37) | 8,08 → 7,93 | 14 → **7** | 7,0 → 5,1 |
| 10 salas × 4 (2 reps) | 28,67 (28,30–28,67) | 28,24 (27,26–28,24) | 10,78 → **9,93** (−8 %) | 44 → **23** | 19,4 → 11,7 |

Con 4 clientes haxlite pasa de +10 % sobre el oficial (§4.3) a ~−10 %. Con 20 clientes los
mensajes ya provocan los catch-ups y el coste lo domina WebRTC: la CPU total queda en el ruido,
pero el GC se reduce a la mitad.

### 7.2 Camino de mensajes sin asignaciones

`bench/host-msg.bench.mjs`: `HostRoom` + transporte falso, N clientes enviando SendInput que se
secuencia y difunde a los N (más heartbeats); mide CPU y bytes de *new space* por mensaje
(lotes sin GC de 1000 mensajes) y atribuye con el perfilador de heap (`HEAP_PROF=`).

| | ns/mensaje antes → ahora | bytes asignados/mensaje antes → ahora | scavenges / 1000 msgs |
|---|---|---|---|
| N = 20 (21,5 envíos por mensaje) | 3 390 → **2 650** (−22 %) | 665 → **123** | 0,25 → 0,06 |
| N = 4 | 2 570 → **1 600** (−38 %) | 889 → **181** | 0,36 → 0,09 |

Qué se quitó: el cierre por mensaje de `run(() => …)` (160 B), `new Reader` + `DataView` por
mensaje (80 B: `Reader` ahora lee con aritmética de bytes y se reutiliza con `reset()`), la vista
`subarray` de cada difusión/heartbeat/pong (96 B: `Writer.finishShared()` cachea una vista por
longitud ≤ 256 B), los `splice` de la cola de eventos (2 × 32 B de arrays de resultado) y el
`setTimeout` re-armado (≈ 180 B por frame). Queda, a propósito: el objeto `RoomEvent` del
mensaje (64 B; es el objeto que reciben `onBeforeOperation`/`onEventApplied`, reutilizarlo
cambiaría la API) y, en el bench, el re-armado del reloj porque el tiempo virtual avanza un frame
cada 1–2 mensajes (en tiempo real ocurre ~17 veces/s, no por mensaje). El `Buffer` de cada
mensaje entrante lo crea node-datachannel (`src/net`, fuera de este alcance); en la frontera
host↔net no hay copias (`Uint8Array` en ambos sentidos).

### 7.3 Arranque, carga perezosa y bundle

`bench/startup/run.ts` (proceso nuevo → `import` del paquete → `HBInit` público → link de la
FakeMaster; 20 reps intercaladas, mediana):

| variante | proceso → link (ms) | import (ms) | CPU hasta link (ms) | RSS (MB) | heap (MB) | módulos ESM / CJS |
|---|---:|---:|---:|---:|---:|---|
| antes (tsc, ~50 archivos) | 192 | 127 | 248 | 75,5 | 11,6 | 67 / 23 |
| + json5 perezoso, grabador perezoso | 194 | 127 | 250 | 76,1 | 12,3 | 67 / 18 |
| + bundle (rolldown) | 185 ¹ | 115 ¹ | 247 ¹ | 76,4 ¹ | 10,9 ¹ | 17 / 18 |
| + `node:http` vía `require` (src/net, L2) | 167 ¹ | 101 ¹ | 233 ¹ | 72,0 ¹ | 9,5 ¹ | |
| **build actual** (todo junto) | **139** | **76** | **197** | **71,1** | **9,0** | 17 / 18 |

¹ Otra tanda de 20 reps (misma máquina, mismo método). Total: **−28 % de arranque, −51 ms de
CPU, −4,4 MB de RSS**.

* **Bundle**: `npm run build` (`scripts/build.mjs`) compila con `tsc` (tipos `.d.ts` intactos) y
  agrupa el JS con rolldown en `dist/index.js` + `dist/edge/cli.js` + un chunk compartido:
  `import 'haxlite'` carga 2 archivos propios en lugar de ~50 (−20 ms). Dependencias de runtime
  externas.
* **Hallazgo `node:http`**: `import http from 'node:http'` en ESM crea la fachada del módulo
  leyendo todos sus exports, lo que dispara los getters perezosos `http.WebSocket` /
  `CloseEvent` / `MessageEvent` y carga **undici** entero (~35 ms y ~4 MB de RSS) aunque nadie lo
  use. Con `createRequire(import.meta.url)('node:http')` no ocurre (aplicado por L2 en
  `net/master-http.ts` y `edge/server.ts`).
* **Perezosos**: `json5` se carga en el primer `parseHbs` (−5 módulos CJS, ~2 ms; la mayoría de
  salas no parsean `.hbs`); el `ReplayRecorder` (17 KB de buffers) se crea en el primer uso.
  Replay, `.hbs` y Edge se siguen exportando desde la raíz (no se rompe la API); con el bundle su
  coste de carga es marginal (2–3 ms en total), así que no se separaron en subpaths.

### 7.4 Dependencias y tamaño de instalación

`npm pack` + `npm install --omit=dev` del tarball en un directorio vacío:

| | antes | ahora |
|---|---:|---:|
| tarball | 248 KB | **177 KB** |
| paquete `haxlite` instalado | 1 444 KB, 162 archivos | **768 KB**, 60 archivos |
| `node_modules` total (6 paquetes) | 12 024 KB, 383 archivos | **11 348 KB**, 281 archivos |

Se dejan de publicar los `.map` (apuntaban a `src/*.ts`, que no se publica) y el JS va agrupado.
El resto es node-datachannel (+ binario `@node-datachannel/linux-x64-gnu`, 9,9 MB de los 11,3).

Rechazado:
* **Sustituir `json5`** (296 KB, 1 paquete): para ser exactos hay que replicar su máquina de
  estados (mensajes de error `JSON5: invalid character … at l:c`, columnas, `console.warn` de
  U+2028) **y sus tablas Unicode 10** de identificadores: frente a `\p{ID_Start}`/`\p{ID_Continue}`
  de V8 (Unicode 15) difieren ~16 000 code points en 156 + 202 rangos. Ganancia pequeña, riesgo
  real de aceptar `.hbs` que el oficial rechaza → se mantiene, cargado de forma perezosa.
* **`ws` → `WebSocket` nativo de Node 22 (undici)**: acepta `headers` (Origin) pero no un
  `http.Agent` (la opción `haxlite.agent` para proxies HTTP(S)/SOCKS); haría falta el paquete
  `undici` (`ProxyAgent`), más grande que `ws`, y cargar undici cuesta ~35 ms. Se mantiene `ws`.

### 7.5 Memoria (RSS) y flags de Node

RSS medio con el build nuevo: sala pública ociosa **73 MB** (heap 9,2 MB; `lite-idle.json`, 0
GC/min salvo arranque), 1 sala con 20 clientes **87–88 MB** (heap 11,0), 10 salas × 4 clientes
**95 MB** (heap 12,1). El heap de haxlite es ~10 % del RSS: el resto es Node + libdatachannel.

Flags evaluados con N = 20 (`bench/results/lite-flags-*.json`, 2 reps cada uno; CPU con ruido
ajeno de hasta 36–55 % en algunas tandas, el RSS es robusto):

| flags | RSS (MB) | CPU % | veredicto |
|---|---:|---:|---|
| ninguno | 86,9 – 87,8 | 19,7 – 21,2 | referencia |
| `--max-semi-space-size=1` | 87,4 | 20,5 | neutro (el heap ya es pequeño) |
| `--single-threaded-gc` | 88,0 | 20,5 | neutro |
| `--optimize-for-size` | 86,4 | **22,3** | rechazado: +1–2,5 puntos de CPU |
| `--v8-pool-size=1` | 84,5 | 20,6 | −3 MB (menos hilos de plataforma V8) |
| `MALLOC_ARENA_MAX=2` (variable de entorno) | 82,6 | 19,6 | −5 MB (arenas de glibc de los hilos de libdatachannel) |
| `MALLOC_ARENA_MAX=2` + `--v8-pool-size=1` + `--max-semi-space-size=1` | **80,3** | 19,3 | **−7 MB (−8 %), sin coste de CPU medible** |

**Recomendado** para hosts de larga duración:

```sh
MALLOC_ARENA_MAX=2 node --v8-pool-size=1 --max-semi-space-size=1 mi-sala.js
```

`--jitless`/`--lite-mode` no se consideran (CPU). `--max-old-space-size` no reduce el RSS (el
heap viejo es de ~11 MB). `--v8-pool-size=1` puede alargar algo el arranque (compilación en
segundo plano con un solo hilo); no medido como significativo.

### 7.6 Comandos

```sh
npm run build                                           # tsc + bundle → dist/
node bench/host-msg.bench.mjs <dist> 20 2000000         # §7.2 (HEAP_PROF=f.heapprofile para atribuir)
node bench/wakeups.bench.mjs <dist> 10 10 [Infinity]    # §7.1 despertares (K salas, s, maxWakeFrames)
node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs \
  bench/startup/run.ts 20 antes=<dist-a>/index.js ahora=dist/index.js        # §7.3
HAXLITE_BENCH_VARIANTS='{"base":{"dist":"…"},"new":{"dist":"…"}}' \
  node … bench/net/run.ts game --impl haxlite:base,haxlite:new --n 4,20 --eld 0 --out bench/results/lite-game.json
node … bench/net/run.ts game --impl haxlite:new --n 20 --reps 2 --eld 0 --host-node-args "--v8-pool-size=1"
```

## Pasada de ligereza — red (`src/net`, `src/edge`)

Objetivo: bajar el coste de WebRTC/red del host y del edge sin cambios visibles para el cliente
oficial (mismos canales, mismos mensajes, mismo orden). Cada cambio se midió A/B en la misma
máquina (4 vCPU, compartida con otro ingeniero: todas las corridas serializadas con
`flock /tmp/haxlite-bench.lock`), con builds compilados el mismo momento que solo difieren en
`src/net` + `src/edge` (base = commit `2ce0ae7`, resto del árbol idéntico). Herramientas nuevas:

* `bench/net/natives.mjs`: solo WebRTC. N pares node-datachannel en un proceso hijo contra
  `LocalPeerLink` de haxlite, con la carga de una partida haxlite (input de 6 B por cliente cada
  60–250 ms reenviado a los N por `ru`, heartbeat de 8 B a los N por `uu` cada 7 frames, sonda de
  RTT). Reproduce el perfil del host con 20 clientes (20,5 % CPU; JS 7,3 / RTC worker 8,8 / juice
  3,9) en 15 s en vez de 2,5 min. Flags `--mux`, `--sctp`, `--logger`, `--dist`, `--rtc`.
* `bench/net/run.ts` acepta variantes `--impl haxlite:<nombre>` definidas en
  `HAXLITE_BENCH_VARIANTS` (`{"<nombre>": {dist, transport, sctp, logger}}`) y ahora reporta
  hilos y fds del host.
* `scripts/edge-latency.ts`: `--src <dist>` (build a medir), `--loss <pct>` (descarta ese % de
  los paquetes UDP **solo** entre edge 127.0.0.2 y túnel del host 127.0.0.3 con una regla
  `nftables numgen random`; el tráfico de los jugadores no se toca), `--edge-webrtc`, `--edge-opts`.

### Hilos y sockets nativos (node-datachannel 0.33.4 / libdatachannel 0.24)

Contados en `/proc/<pid>/task` y `/proc/<pid>/fd`:

| momento | hilos | fds | detalle |
|---|---:|---:|---|
| Node vacío | 7 | 21 | |
| `import 'node-datachannel'` | 11 | 21 | +4 `libuv-worker` |
| 1.ª PeerConnection | 19 | 26 | +4 `RTC worker` (pool = `hardware_concurrency`, mín. 4), `RTC poll`, `SCTP iterator`, `SCTP timer`, `juice poll` |
| cada PeerConnection más | +0 | **+1** | un socket UDP por conexión |
| … con `enableIceUdpMux` | +0 | +0 | un solo socket (`juice mux`) para todas |
| tras cerrar todas | 18 | 23 | **los hilos siguen vivos** |
| tras `cleanup()` | 11 | 21 | |

Los hilos no crecen por jugador; el tamaño del pool no es configurable (node-datachannel no lo
expone). Con 20 jugadores el host tenía 48 fds; con mux, 27.

### Resultados

| cambio | medición | antes | después |
|---|---|---:|---:|
| **mux UDP por defecto en el host** (`rtc.enableIceUdpMux: true`) | `natives.mjs` N = 20, 5 × 15 s: CPU % | 20,81 (19,5–22,0) | **19,53** (19,0–20,4) |
| | ídem: hilo ICE / CPU de sistema | 3,93 / 9,56 | 3,33 / 8,69 |
| | fds del proceso con 20 jugadores | 47–48 | **26–27** |
| | `run.ts game` N = 20, 3 × 30 s (build final completo) | 20,30 (18,8–20,6) | **18,70** (18,3–20,0) |
| | ídem: RSS medio (MB) | 85,7 | 82,8 |
| **sin barrido de 1 Hz en vacío** (`HostTransport` lo arma solo con negociaciones/peers/cierres diferidos) | `run.ts idle`, 2 × 120 s: CPU % (ms de CPU/min) | 0,028 (16,9) | **0,009 (5,5)** |
| **liberación de hilos nativos en vacío** (`setWebRtcIdleRelease`, 15 s tras cerrar la última PeerConnection) | proceso que ya usó WebRTC, 0 conexiones, 20 s: CPU % | 0,632 (`SCTP timer` 0,45: usrsctp despierta cada 10 ms) | **0,004** |
| | hilos | 18 | 11 |
| **`node:http(s)` por `require`** (la fachada ESM evalúa los getters `WebSocket/CloseEvent/MessageEvent` y carga undici) | `import` de `net/index.js` / `edge/index.js`, mediana de 15 (ms) | 123 / 120 | **90 / 92** |
| **carriles `ro` en el túnel del edge** (16 canales ordenados por `slot % 16`) | 17 jugadores, 2 % de pérdida en el túnel, 2 × 40 s: RTT `ro` media / p99 (ms) | 2,79 · 2,31 / 37,3 · 36,9 | **2,09 · 2,02 / 26,8 · 24,7** |
| | ídem con 5 % de pérdida: media / p99 | 4,94 · 4,80 / 40,9 · 53,2 | **3,24 · 3,34** / 46,4 · 43,0 |
| | RTT `uu` (control) media, 2 % / 5 % | 1,73 · 1,53 / 1,82 · 1,77 | 1,65 · 1,60 / 1,60 · 1,52 |

* Mux: el ahorro está en el hilo `juice` (un `recvfrom` sobre un socket en vez de `poll` sobre N)
  y en el kernel. Con 9 jugadores la diferencia ya no se distingue del ruido (edge-latency
  directo: 8,9 % ↔ 8,4–9,2 %). srflx/STUN funciona igual con mux (probado con un STUN local que
  devuelve una dirección mapeada falsa: cada conexión recibe su candidato srflx). Choca con una
  dirección por jugador ("canary" de docs/08 §3): para eso `rtc: { enableIceUdpMux: false }`.
* Carriles `ro`: los clientes oficiales mandan **todos** sus eventos (inputs incluidos) por `ro`,
  así que con un único canal `ro` en el túnel una pérdida frenaba los inputs de todos los
  jugadores hasta la retransmisión. La mitad del exceso de RTT medio desaparece; el p99 restante
  lo dominan las pérdidas de los propios paquetes de la sonda (inevitables, igual que en directo).
  Sin pérdida no cuesta nada: 9 jugadores, 3 × 20 s intercaladas, CPU host / edge (%) base
  4,86 / 10,06, final 4,72 / 9,68, final sin carriles 4,64 / 9,83; RTT `ro` p50 1,58 / 1,44 / 1,53 ms.
* Idle release: la teardown es la misma de `shutdownWebRtc()` (espera a que todas las
  PeerConnection confirmen el cierre y mantiene referenciados los DataChannel huérfanos). Llamada
  **justo** después de cerrar, `cleanup()` de libdatachannel se bloqueó 1 vez en ~10 corridas de
  los tests 10 s ("cleanup timeout (possible deadlock)"); con 2 s de espera, 0 de 58 en dos
  corridas completas de test/net + test/edge + test/api. Por eso la espera por defecto es 15 s y,
  si `cleanup()` falla igualmente, haxlite conserva todos los wrappers y desactiva la liberación
  automática para el resto del proceso (nunca deja wrappers colectables).

**Camino de envío (análisis, sin cambio):** `sendMessageBinary` copia el `Uint8Array` a un
`std::vector` y, **en el hilo JS**, hace SCTP + cifrado DTLS + `sendto()` (≈ 20 µs por envío con
20 jugadores): de ahí que el hilo JS esté dominado por llamadas nativas (§5.2). En JS no hay copia
por destinatario (la misma vista va a los N; con edge, un único multicast), el `try/catch` por envío
no cuesta nada en V8 y no hay `Buffer.from` por envío. Agrupar mensajes no es posible: el cliente
oficial espera cada evento/heartbeat como mensaje DC propio. **Recepción:** node-datachannel crea
un `Buffer` por mensaje (copia inevitable); se quitaron dos closures y un array de argumentos
por mensaje (`guard1`, `onMessage` sin `safely`/`callUser`). Con ~150 mensajes entrantes/s
frente a ~3 000 envíos/s no se distingue en CPU (`natives.mjs`: 20,81 → 19,50 %, dentro del
ruido); se mantiene porque no tiene coste.

**Descartado (medido):**

| experimento | resultado |
|---|---|
| `initLogger('Fatal')` | 20,70 % vs 20,81 %: sin efecto (sin logger, libjuice ya no formatea logs) |
| `setSctpSettings({ delayedSackTime: 200 })` | 21,36 % vs 20,81 %: peor (el host recibe pocos mensajes; los SACK que pesan son los de los clientes) |
| demás `setSctpSettings` (buffers, `maxChunksOnQueue`, ventana inicial, control de congestión) | no aplican a ~10–20 msg/s de < 100 B por conexión; no expuestos: RTO mín., intervalo de heartbeat SCTP |
| tamaño del pool de hilos | no expuesto por node-datachannel 0.33 (fijo en `hardware_concurrency`); los hilos ociosos no gastan CPU |
| mux UDP en el **edge** | 3 × 30 s, 17 jugadores: CPU del edge 17,0 % → 18,1 % (**+6 %**) y RTT +0,1–0,2 ms: queda desactivado por defecto |
| agrupar mensajes en el túnel del edge | a 130 inputs/s casi nunca llegan dos en el mismo turno del event loop; las difusiones ya van en un multicast |

Comandos (además de los de §2.5):

```sh
D=node_modules/.cache/haxlite-bench-net            # builds A/B (tsc de una copia de src/)
flock /tmp/haxlite-bench.lock node bench/net/natives.mjs --n 20 --seconds 15 --dist $D/base/dist [--mux 1]
HAXLITE_BENCH_VARIANTS='{"base":{"dist":"'$D'/base/dist"},"net":{"dist":"'$D'/final/dist"}}' \
  flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs \
  bench/net/run.ts game --impl haxlite:base,haxlite:net --n 20 --reps 3 --warmup 10 --window 30
flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings --import ./scripts/ts-resolve.mjs \
  scripts/edge-latency.ts --src $D/final/dist --players 16 --seconds 40 --modes edge --loss 2 [--edge-opts '{"roLanes":false}']
```

## Backend de peers: `peerBackend: 'rtc'` (haxlite-rtc) vs `'ndc'` (node-datachannel)

Host completo (`HostRoom` + `HostTransport` del build actual) con **20 clientes node-haxball**
jugando una partida (escenario *game* de §3), mismo build, solo cambia el backend de peers
(`--impl haxlite:ndc,haxlite:rtc`, variantes integradas en `bench/net/host-proc.mjs`; `rtc` =
`{ peerBackend: 'rtc', rtcEndpoint: { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] } }`).
3 repeticiones intercaladas × 60 s tras 15 s de calentamiento, `flock /tmp/haxlite-bench.lock`
(`bench/results/game-rtc-vs-ndc.json`). Los clientes siguen siendo libdatachannel (node-haxball),
así que solo cambia el lado del host.

| backend | CPU % (3 reps) | hilos | fds | RSS MB | heap MB | lag p50 / p99 ms |
|---|---:|---:|---:|---:|---:|---:|
| `ndc` (node-datachannel, mux UDP) | 18,97 · 19,46 · 18,74 | 19 | 27 | 84,2–84,4 | 9,9 | 0,13–0,14 / 1,13–1,20 |
| **`rtc`** (haxlite-rtc) | **12,45 · 12,35 · 12,53** | **11** | **25** | 86,1–89,9 | 14,3 | 0,13–0,15 / 1,30–1,50 |

* **CPU −35 %** (19,1 → 12,4 % de un núcleo, sin solapamiento entre repeticiones). Con
  node-datachannel el hilo JS hace por cada envío una llamada nativa que copia el mensaje y corre
  SCTP + DTLS + `sendto()`, y además corren 8 hilos nativos (RTC workers, usrsctp, libjuice);
  haxlite-rtc hace el mismo trabajo en el hilo JS sin cruces nativos ni hilos.
* **Hilos 19 → 11**: los 11 de `rtc` son los 7 de Node + los 4 del *threadpool* de libuv (lo
  arranca la verificación ECDSA de los jugadores, `crypto.subtle`). node-datachannel ya no se carga
  si no se usa (`src/net/webrtc.ts` lo importa perezosamente al crear la primera PeerConnection):
  un host `rtc` no tiene ningún hilo nativo de WebRTC.
* **Memoria**: RSS similar (+2–5 MB), heap +4,4 MB: el estado DTLS/SCTP de los 20 jugadores
  vive en el heap de JS en vez de en memoria nativa.
* **Lag del event loop**: igual en p50; p99 0,1–0,3 ms mayor (el trabajo de red ahora está en el
  hilo JS), muy por debajo de un frame (16,7 ms).
* **Entrada a la sala** (node-haxball, 30 entradas secuenciales, loopback): p50 ≈ 1,03 s con
  `rtc` frente a ≈ 2,02 s con `ndc` (ICE‑lite: la respuesta sale sin esperar la recolección y el
  cliente valida el único candidato al primer intento).

Recomendación: **`rtc` en servidores con IP pública** (dedicados, VPS, edge) y **`ndc` detrás de
NAT** sin edge (haxlite-rtc es ICE‑lite: no reúne candidatos srflx). El valor por defecto sigue
siendo `ndc` porque es el único que funciona sin configuración en cualquier red (ver docs/10 §3).

```sh
npm run bench:build
flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs \
  bench/net/run.ts game --impl haxlite:ndc,haxlite:rtc --n 20 --reps 3 --warmup 15 --window 60 \
  --out bench/results/game-rtc-vs-ndc.json
```
