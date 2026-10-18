# 12 — Referencia de operación: todo lo configurable fuera del código de la sala

> Esta página reúne, en un solo lugar, lo que se configura **alrededor** de una sala haxlite y no
> dentro de ella: el gateway **haxlite Edge** (CLI, archivo de configuración, variables de entorno,
> puertos, TLS, límites), las variables de entorno que lee cualquier parte del repositorio, los
> scripts de `package.json`, el arnés de benchmarks y cómo reproducir cada tabla publicada, el
> firewall `ops/haxguard`, los scripts de `scripts/`, la integración continua y el despliegue de
> producción.
>
> La API de la sala (`HBInit`, `room.haxlite`, opciones `haxlite.*`) está en
> [11 — Referencia de la API](11-referencia-api.md). Aquí solo se enlaza.
>
> **Convención.** Cada valor por defecto de las tablas se **leyó en el código** (ruta indicada en
> cada sección), no en los otros documentos. Lo que no se pudo confirmar en esta revisión lleva
> «(no verificado)». Los desajustes entre el código y los documentos existentes están en el
> [apéndice A](#apéndice-a-inconsistencias-detectadas-entre-documentos-y-código). Revisión hecha sobre
> la versión `0.3.1` de `package.json`.

## Índice

1. [Requisitos](#1-requisitos)
2. [Scripts de npm](#2-scripts-de-npm)
3. [haxlite Edge: referencia completa](#3-haxlite-edge-referencia-completa)
   - [3.1 CLI `haxlite-edge`](#31-cli-haxlite-edge)
   - [3.2 Cómo se combinan archivo, variables y valores por defecto](#32-cómo-se-combinan-archivo-variables-y-valores-por-defecto)
   - [3.3 Variables de entorno del Edge](#33-variables-de-entorno-del-edge)
   - [3.4 Archivo de configuración (JSON)](#34-archivo-de-configuración-json)
   - [3.5 Puertos y firewall](#35-puertos-y-firewall)
   - [3.6 TLS](#36-tls)
   - [3.7 Claves de API](#37-claves-de-api)
   - [3.8 Códigos de cierre del WebSocket](#38-códigos-de-cierre-del-websocket)
   - [3.9 Endpoint `/stats`, log y señales](#39-endpoint-stats-log-y-señales)
   - [3.10 Uso programático](#310-uso-programático)
4. [Variables de entorno de todo el repositorio](#4-variables-de-entorno-de-todo-el-repositorio)
5. [`scripts/` y ejemplos](#5-scripts-y-ejemplos)
6. [Arnés de benchmarks](#6-arnés-de-benchmarks)
   - [6.1 Piezas y flujo](#61-piezas-y-flujo)
   - [6.2 `bench/net/run.ts`: escenarios y flags](#62-benchnetrunts-escenarios-y-flags)
   - [6.3 Implementaciones y runtimes (`--impl`, `--runtime`)](#63-implementaciones-y-runtimes---impl---runtime)
   - [6.4 Guiones `.sh`](#64-guiones-sh)
   - [6.5 Cómo reproducir cada tabla de `benchmark-hosts.md` y de `07-benchmarks.md`](#65-cómo-reproducir-cada-tabla)
   - [6.6 Otros bancos: `bench/startup`, `bench/rtc`, micro-benchmarks, `edge-latency`](#66-otros-bancos)
   - [6.7 Informes y gráficos](#67-informes-y-gráficos)
7. [`ops/haxguard`: firewall nftables y XDP](#7-opshaxguard-firewall-nftables-y-xdp)
8. [Integración continua (`.github/workflows`)](#8-integración-continua-githubworkflows)
9. [Despliegue de producción](#9-despliegue-de-producción)
   - [9.1 Edge en un servidor dedicado (systemd + TLS)](#91-edge-en-un-servidor-dedicado-systemd--tls)
   - [9.2 Salas haxlite (Bun/Node, pm2, puertos UDP)](#92-salas-haxlite-bunnode-pm2-puertos-udp)
   - [9.3 TURN, relay-only y firewall del host](#93-turn-relay-only-y-firewall-del-host)
   - [9.4 Ajuste de runtime](#94-ajuste-de-runtime)
   - [9.5 Publicación del paquete](#95-publicación-del-paquete)
10. [Apéndice A: inconsistencias detectadas entre documentos y código](#apéndice-a-inconsistencias-detectadas-entre-documentos-y-código)

---

## 1. Requisitos

| Requisito | Versión / valor | Verificado en | Notas |
|---|---|---|---|
| Node.js | `>= 22` | `package.json` → `engines.node` | CI prueba 22.x, 24.x y 26.x (`.github/workflows/ci.yml`). La máquina de pruebas del proyecto usa Node 26.8 y 22.22 |
| Bun | 1.x; el proyecto lo prueba con 1.4 | `README.md`, `docs/07` | Opcional. Es el runtime de producción de las salas (docs/07 §«Escenarios de producción y Bun»). Los benchmarks lo localizan con `$BUN_PATH` o `bun` del `PATH` |
| `ws` | `^8.22.0` | `package.json` → `dependencies` | Obligatoria |
| `json5` | `^2.2.3` | `package.json` → `dependencies` | Obligatoria (el archivo de configuración del Edge **no** la usa: es JSON estricto, ver §3.4) |
| `node-datachannel` | `^0.33.4` | `package.json` → `optionalDependencies` | **Opcional.** Solo se carga con `peerBackend: 'ndc'` (el valor por defecto de la sala), `playerBackend: 'ndc'` del Edge o el túnel legado `dataPlane: 'webrtc'`. Con `npm install --omit=optional` haxlite se instala igual |
| TypeScript | `^7.0.2` | `devDependencies` | Solo para compilar y comprobar tipos |
| `rolldown` | `1.2.13` | `devDependencies` | Empaquetador de `npm run build` y de los benchmarks |
| `vitest` | `^5.0.3` | `devDependencies` | `npm test` |
| `playwright-core` | `1.56.1` (fija) | `devDependencies` | Solo para las pruebas con navegador real. **No descarga navegadores** (ver `HAXLITE_CHROMIUM`, §4). La 1.56.1 corresponde a Chromium 141 (`chromium-1194`) |
| `haxball.js`, `node-haxball`, `pako` | `5.1.0`, `2.3.1`, `^2.2.0` | `devDependencies` | Oráculos de prueba y referencias de los benchmarks |
| Linux, `taskset`, `flock`, `nft` | — | `bench/net/run.ts`, `scripts/edge-latency.ts` | Solo para benchmarks publicables (`/proc`, fijar núcleos, cerrojo, pérdida simulada). Los benchmarks corren en Windows, pero la CPU por proceso allí no es fiable (docs/07) |
| Chromium instalado | build `chromium-1194` | `test/rtc-interop/harness/browser.ts` | Solo `npm run test:interop` y `bench/rtc` |

**Instalación desde el repositorio**

```sh
npm ci                  # instala dependencias (incluida node-datachannel, que tsc necesita para sus tipos)
npm run build           # genera dist/ (bundle + .d.ts)
node bin/haxlite-edge.js --help
```

Instalar el paquete ya compilado con `npm install haxlite --omit=optional` no descarga
node-datachannel. Para **compilar** desde el repositorio sí hace falta instalado (`tsc` resuelve sus
tipos; README y docs/09 §3).

---

## 2. Scripts de npm

Todos salen de `package.json` → `scripts`. Los argumentos extra se pasan tras `--`
(`npm run bench:game -- --quick`).

| Script | Comando real | Qué hace | Notas |
|---|---|---|---|
| `build` | `node scripts/build.mjs` | `tsc -p tsconfig.build.json` a un directorio temporal, empaqueta con rolldown (entradas `index` y `edge/cli`, un *chunk* compartido, minificado, ASCII), copia los `.d.ts` y deja el resultado en `dist/` | Flags de `scripts/build.mjs`: `--out <dir>` (por defecto `dist`), `--no-minify`. Borra el destino antes de compilar. Lo necesita `bin/haxlite-edge.js` (`import '../dist/edge/cli.js'`) |
| `typecheck` | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.build.json --noEmit` | Comprueba tipos de `src/`, `test/` y `vitest.config.ts`, y luego solo `src/` con `erasableSyntaxOnly` | `tsconfig.build.json` prohíbe `enum`, `namespace` y propiedades de parámetro en `src/`, para poder ejecutarlo sin compilar con `--experimental-strip-types` |
| `test` | `vitest run` | Dos proyectos: `ndc` (todo `test/**/*.test.ts` y `src/**/*.test.ts`) y `rtc` (las suites host/API/transporte repetidas con `peerBackend: 'rtc'`) | Pool `forks`, tiempo límite de 60 s por prueba (`vitest.config.ts`). Las pruebas con Chromium se omiten solas si no hay navegador |
| `test:watch` | `vitest` | Igual, en modo observación | — |
| `test:interop` | `vitest run -c test/rtc-interop/vitest.config.ts` | Banco de interoperabilidad con Chromium real (`test/rtc-interop/**/*.interop.ts`) | Lento (minutos); `fileParallelism: false`; tiempo límite 60 s. Variables en §4 (`HAXLITE_CHROMIUM`, `RTC_INTEROP_*`, `HAXBALL_CLIENT_DIR`) |
| `edge` | `node --experimental-strip-types --no-warnings --import ./scripts/ts-resolve.mjs scripts/edge.ts` | Ejecuta el Edge **desde las fuentes TypeScript**, sin compilar | `npm run edge -- --config edge.json`, `npm run edge -- genkey alice` |
| `bench:build` | `node bench/build.mjs` | Compila haxlite para los hosts del benchmark (`node_modules/.cache/haxlite-bench/{dist,bundle}`), saltándose el trabajo si nada cambió | `--force` o `HAXLITE_BENCH_REBUILD=1` fuerzan la recompilación |
| `bench:sim` | `node --no-warnings --import ./bench/ts-resolve.mjs bench/sim.bench.ts` | Micro-benchmark del paso de física frente al oficial | `--out <archivo.json>` añade la corrida a un JSON |
| `bench:host` | `node bench/build.mjs && node --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts` | Compila y lanza el orquestador `bench/net/run.ts`. Es la base de los atajos siguientes | El primer argumento es el escenario |
| `bench:startup` `bench:idle` `bench:game` `bench:rooms` `bench:soak` `bench:fleet` `bench:join-impaired` | `npm run bench:host -- <escenario>` | Atajo por escenario (ver §6.2) | Aceptan todos los flags de `run.ts` |

No existe un script `lint` ni `format` en `package.json` (verificado).

---

## 3. haxlite Edge: referencia completa

Fuentes: `bin/haxlite-edge.js`, `src/edge/cli.ts`, `src/edge/config.ts`, `src/edge/server.ts`,
`src/edge/tunnel-udp.ts`, `src/edge/players.ts`, `src/net/edge-protocol.ts`. Diseño y modelo de
seguridad: [09 — haxlite Edge](09-haxlite-edge.md).

### 3.1 CLI `haxlite-edge`

`bin/haxlite-edge.js` (el `bin` de `package.json`) importa `dist/edge/cli.js`: **requiere
`npm run build`**. Sin compilar: `npm run edge -- …` (mismo CLI desde `src/`).

| Invocación | Qué hace |
|---|---|
| `haxlite-edge [--config <archivo.json>]` | Arranca el Edge |
| `haxlite-edge genkey <id>` | Imprime una clave nueva (`<id>:<secreto>`) y sale. No toca ningún archivo |
| `haxlite-edge --help` / `-h` | Muestra el uso y sale |

Detalles verificados en `cli.ts`/`config.ts`:

* La **única opción** de línea de comandos es `--config <archivo>` (con espacio). `--config=archivo`
  **no** se reconoce, y cualquier otro argumento se ignora en silencio. Si `--config` es el último
  argumento (sin valor), se ignora y se usa `HAXLITE_EDGE_CONFIG`, si existe.
* `genkey <id>`: el `id` debe cumplir `^[A-Za-z0-9_.-]{1,64}$`; el secreto son 24 bytes aleatorios
  en base64url (32 caracteres, 192 bits). Salida (dos líneas):

  ```
  host config  : haxlite: { edge: { url: 'wss://<edge>:8443/tunnel', key: 'alice:AbC…' } }
  edge keys    : { "id": "alice", "secret": "AbC…" }
  ```

* Arranque: una línea de log con `listening on ws(s)://host:puerto/ruta (N key(s), players <backend> on UDP <puerto>, tunnel v2 UDP <puerto>|off)`.
  Sin TLS añade `WARNING: no TLS configured; use wss:// in production`.
* Código de salida: `1` (con el mensaje de error en `stderr`) si la configuración es inválida o el
  arranque falla; `0` tras SIGINT/SIGTERM.
* Señales: ver [§3.9](#39-endpoint-stats-log-y-señales).

Ejemplos:

```sh
node bin/haxlite-edge.js genkey alice
node bin/haxlite-edge.js --config /etc/haxlite-edge/config.json
HAXLITE_EDGE_KEYS=alice:9fH3xxxxxxxxxxxxxxxxxxxx HAXLITE_EDGE_PORT=9443 node bin/haxlite-edge.js
npm run edge -- --config edge.json        # desde las fuentes
```

### 3.2 Cómo se combinan archivo, variables y valores por defecto

`loadEdgeConfig()` (`src/edge/config.ts`) aplica, de menor a mayor prioridad:

1. Valores por defecto del código (columnas «Defecto» de las tablas).
2. El archivo JSON (`--config`, o si falta, `HAXLITE_EDGE_CONFIG`; **`--config` gana**).
3. Variables `HAXLITE_EDGE_*` (ganan sobre el archivo), con **dos excepciones**:
   * **Claves:** `HAXLITE_EDGE_KEYS_FILE` y `HAXLITE_EDGE_KEYS` se **suman** a las del archivo
     (`keys` + `keysFile`), no las reemplazan. Un `id` repetido es un error («duplicate key id»).
   * **TLS:** `HAXLITE_EDGE_TLS_CERT`/`HAXLITE_EDGE_TLS_KEY` reemplazan el bloque `tls` completo y
     deben darse **las dos** o ninguna.

Solo algunas opciones tienen variable de entorno (§3.3). El resto (`listen.path`, `stats.path`,
`limits.*`, `tunnel.*` salvo el puerto, `webrtc.*` salvo `bindAddress`, el primer puerto de
`portRange` y `publicAddresses`) solo se fijan en el archivo.

El archivo se lee con `JSON.parse`: **JSON estricto, sin comentarios ni comas finales** (aunque
`json5` es una dependencia del paquete, no se usa aquí).

### 3.3 Variables de entorno del Edge

| Variable | Tipo | Defecto | Equivale a | Qué hace / notas |
|---|---|---|---|---|
| `HAXLITE_EDGE_CONFIG` | ruta | — | `--config` | Archivo JSON. `--config` tiene prioridad |
| `HAXLITE_EDGE_HOST` | cadena (IP/host) | `0.0.0.0` | `listen.host` | Dirección de escucha del control TCP. También es la base de la dirección del socket UDP del túnel (§3.5). Se usa `??`: una cadena vacía **cuenta como fijada** |
| `HAXLITE_EDGE_PORT` | entero 0–65535 | `8443` | `listen.port` | Puerto TCP del control (WebSocket + `/stats`). `0` = efímero. Valor inválido → error `bad port` |
| `HAXLITE_EDGE_KEYS` | lista `id:secreto,id2:secreto2` | — | `keys[]` | Se separa por comas y saltos de línea; `#` comenta una línea. Un secreto que contenga `,` no se puede dar por aquí. Se **suma** a las demás claves |
| `HAXLITE_EDGE_KEYS_FILE` | ruta | — | `keysFile` | Archivo de claves (§3.7). Se **suma** |
| `HAXLITE_EDGE_TLS_CERT` | ruta PEM | — | `tls.certFile` | Cadena completa del certificado. Requiere `HAXLITE_EDGE_TLS_KEY` |
| `HAXLITE_EDGE_TLS_KEY` | ruta PEM | — | `tls.keyFile` | Clave privada |
| `HAXLITE_EDGE_BIND` | IP | todas | `webrtc.bindAddress` | Dirección local de los jugadores; el socket UDP del túnel la hereda si no se fija `tunnel.bindAddress` |
| `HAXLITE_EDGE_PORT_RANGE` | `a-b` (p. ej. `40000-40999`) | efímeros | `webrtc.portRange` | Formato estricto `^\d+-\d+$`, `0 < a <= b < 65536`, o error. Con `rtc` **solo se usa el primer puerto** (`a`) como puerto único de jugadores; con `ndc` es el rango de las PeerConnections |
| `HAXLITE_EDGE_PLAYER_BACKEND` | `rtc` / `ndc` | `rtc` | `playerBackend` | Cualquier otro valor → error |
| `HAXLITE_EDGE_PUBLIC_ADDRESSES` | IPs separadas por comas | ver §3.4 | `webrtc.publicAddresses` | Direcciones **anunciadas** a los jugadores (`rtc`: las únicas) |
| `HAXLITE_EDGE_TUNNEL_PORT` | entero 0–65535 u `off` | = puerto TCP | `tunnel.port` / `tunnel.udp=false` | `off` desactiva el túnel v2 (los hosts caen al WebSocket). Cadena vacía = no fijada. Otro valor → error |
| `HAXLITE_EDGE_STATS_TOKEN` | cadena | sin token | `stats.token` | Token *bearer* de `GET /stats` |
| `HAXLITE_EDGE_LOG_INTERVAL_MS` | ms | `60000` | `stats.logIntervalMs` | Periodo de la línea de estadísticas. `0` la apaga. Un valor no numérico (NaN) la apaga sin error (no se valida) |

### 3.4 Archivo de configuración (JSON)

Esqueleto completo (`EdgeConfigFile` en `config.ts`):

```json
{
  "listen":  { "host": "0.0.0.0", "port": 8443, "path": "/tunnel" },
  "tls":     { "certFile": "/etc/haxlite-edge/fullchain.pem", "keyFile": "/etc/haxlite-edge/privkey.pem" },
  "keys":    [{ "id": "alice", "secret": "…", "maxSessions": 4, "maxPeers": 64, "label": "Alice" }],
  "keysFile": "/etc/haxlite-edge/keys.txt",
  "playerBackend": "rtc",
  "webrtc":  { "bindAddress": "203.0.113.10", "port": 40000, "publicAddresses": ["203.0.113.10"] },
  "tunnel":  { "port": 8443, "maxPps": 20000 },
  "limits":  { "maxPeersPerSession": 40, "floodCapacity": 100, "floodMsPerToken": 16 },
  "stats":   { "path": "/stats", "token": "…", "logIntervalMs": 60000 }
}
```

#### `listen`, `tls`, `playerBackend`, `stats`, claves

| Clave | Tipo | Defecto | Qué hace | Notas |
|---|---|---|---|---|
| `listen.host` | cadena | `0.0.0.0` | Dirección del control TCP | Env: `HAXLITE_EDGE_HOST` |
| `listen.port` | entero | `8443` | Puerto TCP del control; `0` = efímero | Env: `HAXLITE_EDGE_PORT` |
| `listen.path` | cadena | `/tunnel` | Ruta del WebSocket de los hosts (`EDGE_DEFAULT_PATH`) | Solo archivo. Otra ruta → la conexión se destruye sin respuesta |
| `tls` | objeto o `null` | `null` (sin TLS, `ws://`) | `{certFile, keyFile}`: PEM → `wss://` | Env: `HAXLITE_EDGE_TLS_*`. SIGHUP recarga (§3.6) |
| `keys[]` | lista | — | Claves de API (§3.7) | Con `keys`+`keysFile`+env vacíos el Edge **no arranca** (`no API keys configured`) |
| `keysFile` | ruta | — | Más claves: array JSON o `id:secreto` por línea | Env: `HAXLITE_EDGE_KEYS_FILE` |
| `playerBackend` | `"rtc"` / `"ndc"` | `"rtc"` | Cómo se atiende WebRTC de los jugadores | `rtc` = haxlite-rtc (TypeScript puro, 1 puerto UDP, ICE-lite). `ndc` = node-datachannel (addon nativo, carga perezosa) |
| `stats.path` | cadena o `null` | `/stats` | Ruta HTTP(S) de las estadísticas; `null` desactiva el endpoint | Solo archivo |
| `stats.token` | cadena o `null` | `null` | Token *bearer*; sin él, `/stats` es público en ese puerto | Env: `HAXLITE_EDGE_STATS_TOKEN` |
| `stats.logIntervalMs` | ms | `60000` | Periodo del resumen en el log; `0` = apagado | Env: `HAXLITE_EDGE_LOG_INTERVAL_MS` |

#### `webrtc` (jugadores) — `EdgeWebRtcOptions`

| Clave | Tipo | Defecto | Aplica a | Qué hace / notas |
|---|---|---|---|---|
| `bindAddress` | IP | todas | rtc, ndc | Dirección local de los jugadores. Con `rtc` y sin `publicAddresses` se anuncia si es una IP concreta. Una IPv6 sin `ipv6: true` es error |
| `publicAddresses` | lista de IP | `bindAddress` si es IP concreta; si no, las IPs **públicas** de las interfaces (solo IPv4 salvo `ipv6`) | rtc | Las **únicas** direcciones escritas en respuestas y candidatos. Obligatoria tras un NAT 1:1. Si no queda ninguna dirección el Edge **no arranca** (error que nombra `webrtc.ipv6` si solo había IPv6) |
| `ipv6` | bool | `false` | rtc, ndc | Escuchar y anunciar IPv6. Sin ella se descartan las IPv6 dadas o detectadas. +20 B por datagrama ≈ +19 % de salida (docs/10 §2.1) |
| `port` | entero | `portRange[0]`; si no hay rango, **efímero** | rtc | Puerto UDP **único** de todos los jugadores. Con el valor por defecto el puerto cambia en cada arranque: fíjalo en producción |
| `publicPort` | entero | el puerto real | rtc | Puerto anunciado si un NAT 1:1 lo traduce |
| `consentTimeoutMs` | ms | `30000` | rtc | Sin Binding STUN autenticado del navegador en este tiempo → sesión cerrada |
| `portRange` | `[a, b]` o `null` | efímeros | ndc (rtc: usa `a`) | Rango UDP de las PeerConnections |
| `enableIceUdpMux` | bool | `false` | ndc | Todas las conexiones en `portRange[0]`. En el Edge **no** ahorra CPU (docs/09) |
| `iceServers` | lista | `stun:stun.l.google.com:19302` | ndc, túnel `webrtc` | STUN/TURN de las PeerConnections propias del Edge |
| `iceCandidatePolicy` | `public` / `private` / `all` / función | `public` | rtc, ndc | Qué direcciones propias se anuncian (con `rtc` también filtra las detectadas). `all` solo para pruebas en loopback |
| `remoteCandidatePolicy` | `public` / `private` / `all` | `public` | rtc, ndc, túnel `webrtc` | Qué candidatos remotos se aceptan: filtra el SDP de la *offer* del jugador y los candidatos que el host reenvía. Con `ndc` además limita a qué direcciones se envían comprobaciones; con `rtc` (ICE-lite) el Edge nunca inicia comprobaciones, así que solo actúa el filtro |
| `rtc` | objeto | — | ndc | Extras de node-datachannel (`mtu`, `maxMessageSize`…) para las PeerConnections de jugadores |

#### `tunnel` (host ↔ Edge, túnel v2) — `EdgeTunnelOptions`

| Clave | Tipo | Defecto | Qué hace | Notas |
|---|---|---|---|---|
| `udp` | bool | `true` | Aceptar túneles v2 (SCTP sobre UDP cifrado) | `false` (o env `…TUNNEL_PORT=off`): los hosts usan el WebSocket |
| `port` | entero | el número de `listen.port` (UDP); si está ocupado **y no se configuró**, uno efímero | Puerto UDP único para todos los hosts | Si se configuró y está ocupado → error. `0` = efímero. Env: `HAXLITE_EDGE_TUNNEL_PORT` |
| `bindAddress` | IP | `webrtc.bindAddress`; si no, `listen.host` (`''` → `0.0.0.0`) | Dirección del socket UDP del túnel | Debe ser **literal IP** (no un nombre) |
| `publicHost` | cadena | el host de la URL WS que usó el host | Destino UDP que se comunica a los hosts en `AuthOk` | Máx. 255 caracteres |
| `publicPort` | entero | el puerto ligado | Puerto UDP comunicado | Detrás de una traducción de puertos |
| `maxPps` | datagramas/s | `20000` | *Token bucket* por túnel desde la dirección autenticada (ráfaga de 2 s, mínimo 16) | `max(1, valor)` |
| `maxForeignPps` | datagramas/s | `20` | *Bucket* por `connId` para cualquier otra dirección (NAT rebinding, ataques) | Cota de intentos de AEAD de un atacante que conozca un `connId` |
| `idleTimeoutMs` | ms | `30000` | Túnel sin datagramas autenticados → cerrado | Barrido cada `min(5 s, max(250 ms, idle/3))`, solo con túneles |
| `allowWebRtc` | bool | `true` | Conceder el túnel legado (PeerConnection) a quien lo pida; carga node-datachannel en ese momento | `false` → ese host recibe el WebSocket |
| `aead` | `auto` / `chacha20-poly1305` / `aes-128-gcm` | `auto` | AEAD que se concede a hosts que piden ChaCha20-Poly1305 | `auto` = ChaCha20-Poly1305 en Node y Bun. Quien no lo pide recibe AES-128-GCM |

Los sockets UDP del túnel piden búferes de 4 MiB de recepción y de envío (`setRecvBufferSize` /
`setSendBufferSize`); el kernel puede recortarlos (`net.core.rmem_max` / `wmem_max`).

#### `limits` — `EdgeLimitsOptions`

| Clave | Tipo | Defecto | Qué limita |
|---|---|---|---|
| `maxSessions` | entero | `1000` | Túneles (salas) simultáneos en el Edge. Exceso → cierre 4429 «edge full» |
| `maxSessionsPerKey` | entero | `16` | Sesiones por clave (cuota por defecto; ver `keys[].maxSessions`) |
| `maxPeersPerKey` | entero | `256` | Jugadores por clave en todas sus sesiones (ver `keys[].maxPeers`) |
| `maxPeersPerSession` | entero | `40` | Jugadores por sala. Se comunica al host en `AuthOk` (tope `0xffff`) |
| `maxPendingPerSession` | entero | `16` | Negociaciones simultáneas por sala (el 4104 oficial) |
| `peerOpenCapacity` | entero | `30` | Ráfaga del ritmo de `PeerOpen` por sala |
| `peerOpenMsPerToken` | ms | `100` | Un `PeerOpen` nuevo por este intervalo |
| `floodCapacity` | entero | `100` | *Bucket* de flood **por jugador** (oficial `new Ra(100, 16)`) |
| `floodMsPerToken` | ms | `16` | Reposición del *bucket*. Agotado: el Edge cierra al jugador y avisa `PeerClosed(Flood)`; el host lo expulsa con «Bad actor» |
| `channelOpenTimeoutMs` | ms | `15000` | El canal 0 debe abrir en este tiempo (limpieza de negociaciones colgadas). Con `rtc` el `handshakeTimeoutMs` del endpoint es este valor + 1000 |
| `authTimeoutMs` | ms | `5000` | De `Hello` a `AuthOk`; si no, cierre 4408 |
| `dataPlaneTimeoutMs` | ms | `15000` | La PeerConnection del túnel **legado** debe abrir en este tiempo; si no, cierre 4408 |
| `keepAliveMs` | ms | `10000` | Periodo del `ping` WebSocket a los hosts (dos sin respuesta = sesión muerta). El temporizador solo corre mientras hay sesiones |
| `allowWsDataPlane` | bool | `true` | Aceptar sesiones con los datos por WebSocket. Con `false` y sin plano UDP/WebRTC disponible el host recibe un error |

Constantes no configurables (`EdgeLimits`, `src/net/edge-protocol.ts`): SDP ≤ 16 384 B, candidato ≤ 1024 B,
`mid` ≤ 64, id de clave ≤ 128, ≤ 32 candidatos remotos por jugador, payload de jugador ≤ 262 144 B,
mensaje WebSocket ≤ 262 144 + 64 B, 16 carriles `ro`.

### 3.5 Puertos y firewall

| Puerto | Protocolo | Defecto | Quién lo usa | Regla recomendada |
|---|---|---|---|---|
| `listen.port` | **TCP** | `8443` | Control (WebSocket `wss://…/tunnel`) y `GET /stats` | Abierto (autenticado con HMAC); idealmente solo desde las IP de los hosts. Limitar conexiones nuevas |
| `tunnel.port` | **UDP** | = `listen.port` | Datos host↔Edge (túnel v2) | Solo desde los hosts si tienen IP fija; si no, abierto (sin `connId` vigente y MAC válido no responde nada) |
| `webrtc.port` (`rtc`) | **UDP** | efímero (**fíjalo**) | **Todos los jugadores** | Abierto al mundo; el sitio natural para `ops/haxguard` (§7) |
| `webrtc.portRange` (`ndc`) | **UDP** | efímeros | Un puerto por PeerConnection | Abrir el rango |

Un host haxlite **no necesita ningún puerto entrante**. Con un Edge, un firewall de salida que
solo permita UDP hacia la IP del Edge garantiza que el host nunca le hable directo a un jugador
(ejemplo nftables en docs/09 §3.1).

### 3.6 TLS

* Activar `wss://`: bloque `tls` o `HAXLITE_EDGE_TLS_CERT`/`…_KEY`. Se leen **al arrancar** con
  `readFileSync`; el usuario del servicio debe poder leer los PEM.
* **SIGHUP recarga** el certificado y la clave (`server.setSecureContext`) sin cortar túneles.
  Si no hay TLS configurado, SIGHUP no hace nada. Un fallo de lectura se registra
  (`TLS reload failed: …`) y se conserva el certificado anterior.
* Sin TLS el control va en claro. Las claves de datos del túnel v2 no se pueden derivar sin la API
  key (docs/09 §4), pero ofertas y slots solo van cifrados con TLS. **Usa `wss://` en producción.**
* Alternativa: terminar TLS en nginx/caddy con `proxy_pass` WebSocket a `127.0.0.1:<listen.port>`.
  Solo pasa el control; el UDP del túnel hay que fijarlo (`tunnel.port`) y abrirlo aparte.

### 3.7 Claves de API

* Formato `"<id>:<secreto>"`. El `id` no puede contener `:` y mide ≤ 128 caracteres; `genkey` es más
  estricto (`[A-Za-z0-9_.-]{1,64}`). El **secreto** debe tener **≥ 16 caracteres** (si no el
  Edge no arranca: `secret … is too short`).
* Orígenes que se suman: `keys[]` (archivo), `keysFile` (archivo), `HAXLITE_EDGE_KEYS_FILE`,
  `HAXLITE_EDGE_KEYS`.
* Formato de `keysFile`: si el texto, tras espacios iniciales, empieza por `[` es un **array JSON** de
  `{id, secret, maxSessions?, maxPeers?, label?}`; si no, una entrada `id:secreto` por línea (o por
  coma), `#` comenta. Los campos `maxSessions`, `maxPeers` y `label` **solo** se pueden dar en la
  forma JSON.
* Cuotas por clave: `maxSessions` (por defecto `limits.maxSessionsPerKey`, 16), `maxPeers` (por
  defecto `limits.maxPeersPerKey`, 256), `label` (solo para estadísticas y logs).
* Para rotar una clave hay que editar el archivo y **reiniciar** el Edge (no hay recarga de claves;
  SIGHUP solo recarga TLS). Al reiniciar se pierden los jugadores conectados, los hosts reconectan
  solos.
* La clave del host se pasa en la opción `haxlite.edge` de la sala: ver [11 — Referencia de la API](11-referencia-api.md).

### 3.8 Códigos de cierre del WebSocket

| Código | Nombre | Cuándo |
|---|---|---|
| 4400 | `Protocol` | Mensaje malformado o fuera de límites |
| 4401 | `AuthFailed` | MAC o clave inválidos |
| 4402 | `Version` | Versión de protocolo incompatible |
| 4408 | `Timeout` | `authTimeoutMs` o `dataPlaneTimeoutMs` vencidos |
| 4429 | `Quota` | Cuota de sesiones (clave o Edge lleno) |
| 4503 | `Shutdown` | El Edge se apaga (SIGINT/SIGTERM): los hosts reconectan |

(`src/net/edge-protocol.ts`, `EdgeCloseCode`.)

### 3.9 Endpoint `/stats`, log y señales

* **`GET <stats.path>`** (por defecto `/stats`), mismo puerto TCP que el control, con TLS si lo hay.
  Con `stats.token`, exige `Authorization: Bearer <token>` (comparación en tiempo constante); sin
  él o con uno erróneo → `401`. Cualquier otra ruta o método → `404`. Respuesta `application/json`,
  `Cache-Control: no-store`.

  ```sh
  curl -s -H "Authorization: Bearer $TOKEN" https://edge.example.com:8443/stats | jq .
  ```

  Campos (`EdgeStats`): `uptimeSec`, `playerBackend`, `sessions`, `peers`, `authFailures`,
  `keys[]` (`id`, `label`, `sessions`, `peers`, `bytesIn/Out`, `messagesIn/Out`, `ppsIn/Out`
  —desde la consulta anterior—, `floods`), `webrtc` (objetos nativos; `null` si node-datachannel
  nunca se cargó), `rtc` (contadores del endpoint de jugadores; `null` con `ndc`), `tunnel` (puerto,
  túneles, datagramas, `unknownConn`, `rateLimited`, `rejected`, `migrations`; `null` si está
  apagado), `dataPlanes` (`udp`/`webrtc`/`ws`), `memoryRssMb`.
* **Log** (a `stdout`, con marca ISO por línea): arranque, `players: haxlite-rtc on UDP <puerto>, announcing …`,
  `tunnel v2: UDP <dirección>:<puerto>`, y cada `stats.logIntervalMs` una línea
  `stats sessions=… peers=… rtc=abiertas/sesiones udp=túneles [pcs=…] rss=…MB | clave: Ns/Mp in X pps out Y pps`.
* **Señales:** `SIGHUP` → recargar TLS; `SIGINT`/`SIGTERM` → cierra todos los túneles con 4503 y
  termina (código 0). Una segunda señal mientras se apaga se ignora.
* Sin temporizadores en vacío: un Edge sin sesiones no despierta nunca (docs/09 §6).

### 3.10 Uso programático

`import { EdgeServer, edge } from 'haxlite'` (reexporta `src/edge`): `EdgeServer.start(opts)` o
`new EdgeServer(opts)` + `listen()`; también `edge.loadEdgeConfig(argv, env)` y
`edge.generateEdgeKey(id)`. `EdgeServerOptions` admite además `server` (un servidor HTTP(S)
existente; entonces `host`/`port`/`tls` se ignoran) y `log`. Métodos: `stats()`, `url(host?)`,
`reloadTls()`, `close({ shutdownWebRtc })`; propiedades `tunnelPort`, `playerPort`, `address`.
La API completa está en [11 — Referencia de la API](11-referencia-api.md).

---

## 4. Variables de entorno de todo el repositorio

Resultado de buscar `process.env` / `Bun.env` / `import.meta.env` en `src/`, `bin/`, `scripts/`,
`bench/`, `test/` y `examples/`. **En `src/` (el paquete publicado) solo hay dos lectores**:
el Edge (§3.3) y el cliente HTTP del maestro (proxies en Bun).

### 4.1 Paquete (`src/`)

| Variable | Defecto | Dónde | Efecto |
|---|---|---|---|
| `HAXLITE_EDGE_*` (12 variables) | — | `src/edge/config.ts` | Configuración del Edge: ver §3.3 |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`, `all_proxy` | sin definir | `src/net/master-http.ts` (`useFetch`) | **Solo en Bun:** si alguna está definida (o se pasa `agent`), el cliente del maestro **no** usa el `fetch` nativo de Bun y cae a `node:http(s)`. haxlite **no aplica** el proxy por sí mismo: para salir por un proxy hay que pasar un `agent` (`https-proxy-agent`, `socks-proxy-agent`…; opción `haxlite.agent`, ver [11](11-referencia-api.md)). `NO_PROXY` no se lee |

El paquete no lee ninguna otra variable: ni `HAXLITE_*` genéricas, ni `NODE_ENV`, ni `DEBUG`
(verificado con `grep`).

### 4.2 Ejemplos y scripts

| Variable | Defecto | Dónde | Efecto |
|---|---|---|---|
| `HAXBALL_TOKEN` | — (obligatoria) | `examples/basic-room.mjs`, `moderation.mjs`, `among-us-vision.mjs`, `scripts/hidden-bigmap-room.mjs` | *Headless token* de <https://www.haxball.com/headlesstoken> (caduca a los pocos minutos) |
| `HX_TOKEN` | — (obligatoria) | `examples/live-room.mjs` | Igual, **otro nombre** (ver apéndice A) |
| `HAXLITE_OPTIONS` | `{}` | los mismos ejemplos | JSON que se pasa como opción `haxlite` de `HBInit` (p. ej. `{"masterUrl":"…","iceServers":[]}`) |
| `HX_BACKEND` | `ndc` | `live-room.mjs` | `rtc` o `ndc` (`peerBackend`) |
| `HX_RTC_PORT` | `40000` | `live-room.mjs` | Puerto UDP con `rtc` |
| `HX_PUBLIC_IP` | autodetectada | `live-room.mjs` | IPs públicas a anunciar con `rtc`, separadas por comas |
| `HX_EDGE_URL`, `HX_EDGE_KEY` | — | `live-room.mjs` | Aloja la sala a través de un Edge |
| `MODERATION_FILE` | `./moderation.json` | `moderation.mjs` | Archivo de bans persistentes |
| `ADMIN_AUTHS` | vacío | `moderation.mjs` | `auth` de los administradores, separados por comas |
| `QUARANTINE_MS` | `120000` | `moderation.mjs` | Tiempo sin poder escribir de un `auth` nunca visto |
| `CONTROL` | sin definir | `scripts/hidden-bigmap-room.mjs` | `1` = sala de control (sin ocultar jugadores) |
| `HAXBALL_CLIENT_DIR`, `OUT`, `PREFIX`, `FILES`, `EXAMPLE`, `VIEW_MODE`, `FRAME`, `POS`, `ONLY`, `PROPS`, `SPECTATE`, `WAIT`, `NAMES`, `KILL`, `KEYS`, `SETTLE`, `CHECKSUM` | ver el encabezado del script | `scripts/among-us-screenshots.ts` | Parámetros de las capturas con el cliente oficial (§5) |
| `EDGE_BENCH_SRC`, `EDGE_BENCH_WEBRTC`, `EDGE_BENCH_EDGE_OPTS` | — | `scripts/edge-latency.ts` | **Internas:** el orquestador las fija desde `--src`, `--edge-webrtc`, `--edge-opts` para sus procesos hijos. No las definas a mano |

### 4.3 Pruebas (`test/`)

| Variable | Defecto | Efecto |
|---|---|---|
| `HAXLITE_TEST_PEER_BACKEND` | `ndc` | `rtc` ejecuta las suites host/API/transporte contra haxlite-rtc (lo fija el proyecto `rtc` de `vitest.config.ts`) |
| `HAXLITE_TEST_RTC_BATCH_FRAMES` | `0` | `1` o `2`: activa `sendBatchFrames` en las suites `rtc` y en la sala del interop con el cliente oficial |
| `HAXLITE_CHROMIUM` | `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` | Ejecutable de Chromium para `test/rtc-interop`, `test/rtc/chromium-dtls.test.ts`, `test/rtc/sctp/chromium.test.ts` y `bench/rtc`. Sin él las pruebas se omiten |
| `HAXBALL_CLIENT_DIR` | vacío | Directorio con el cliente web oficial sin modificar (`game.html`, `game-min.js`, `res.dat`, `vendor/*.js`). Sin él `official-client*.interop.ts` se omiten (docs/10 §4.3) |
| `HAXLITE_TURN_ICE` | vacío | Archivo JSON con la respuesta de `generate-ice-servers` de Cloudflare para `official-client-turn.interop.ts` (necesita red) |
| `HAXBALL_CLIENT_JS` | ruta fija del entorno de desarrollo del autor (`/tmp/claude-0/…/game-min.js`) | `game-min.js` del cliente oficial para `test/replay`. La ruta por defecto es específica de esa máquina: fíjala o la prueba se omite |
| `HAXLITE_REPLAY_FRAMES` | `12000` | Longitud del escenario de `test/replay/replay.test.ts` |
| `HAXLITE_DIFF_TICKS` | `5000` | Ticks por corrida de `test/room/diff.test.ts` |
| `HAXLITE_DIFF_VERBOSE` | sin definir | Imprime estadísticas por corrida |
| `HAXLITE_CHACHA_CASES` | `20000` | Casos aleatorios de `test/rtc/chacha.test.ts` (docs/10 usa 3 000 000) |
| `RTC_INTEROP_CONDITIONS` | todas | Lista (coma) de condiciones de red: `loopback4`, `eth4`, `loopback6`, `lossy`, `dtls13` |
| `RTC_INTEROP_BACKENDS` | todos | `ndc`, `rtc` o ambos |
| `RTC_INTEROP_IDLE` | sin definir | `0` omite la prueba de 40 s de inactividad |
| `RTC_INTEROP_VERBOSE` | sin definir | Imprime cada observación |
| `RTC_INTEROP_REPORT` | sin definir | Archivo JSON donde se acumulan las observaciones medidas |
| `NET_DEBUG`, `EDGE_DEBUG` | sin definir | Log de depuración de `test/net/transport.test.ts` y de `test/edge/harness.ts` |
| `TURN_VERBOSE` | sin definir | `1` (o cualquier valor en `turn-server.test.ts`) activa el log del servidor TURN de prueba |
| `PARITY_DUMP` | sin definir | Ruta donde `test/api/parity.test.ts` vuelca las trazas oficial/propia |
| `NN_KEY`, `NN_PLAYER_BACKEND` | — | **Internas** de `test/edge/edge-no-native.test.ts` |

### 4.4 Benchmarks (`bench/`)

| Variable | Defecto | Efecto |
|---|---|---|
| `BUN_PATH` | `bun` del `PATH` (resuelto a su binario real) | Ejecutable de Bun para `--runtime bun` / `@bun` (en Windows `bun` es un *shim* `.cmd` que `fork()` no puede lanzar) |
| `HAXLITE_BENCH_REBUILD` | sin definir | `1` fuerza `bench/build.mjs` a recompilar |
| `HAXLITE_BENCH_VARIANTS` | `{}` | JSON `{"<nombre>": {dist?, bundle?, transport?, sctp?, logger?}}` que añade variantes `haxlite:<nombre>` para comparar builds A/B (§6.3) |
| `HAXLITE_HOST_OPTS` | `{}` | JSON con opciones extra de `HostRoom` (p. ej. `{"heartbeatFrames":9}`). Solo diagnóstico, nunca en las tablas publicadas |
| `HAXLITE_BENCH_IMPAIR` | — | **Interna** de `join-impaired`: el orquestador la fija |
| `HOST_CPU_PROFILE` | — | Archivo `.cpuprofile` del perfil V8 del hilo JS durante la ventana de medición |
| `HOST_ALLOC_PROFILE` | — | Archivo `.heapprofile` de asignaciones (incluye basura) |
| `HOST_HEAP_SNAPSHOT` | — | Archivo `.heapsnapshot` al final de la ventana |
| `HEAP_PROF` | — | `bench/host-msg.bench.mjs`: archivo de perfil de asignaciones |
| `CHROME_PATH` | Chromium de Playwright; si no, Chrome/Edge local | `bench/charts.mjs`: navegador para capturar los PNG |

### 4.5 Variables de runtime que no lee el código pero que importan

| Variable | Valor | Efecto | Origen de la recomendación |
|---|---|---|---|
| `MIMALLOC_SCAVENGER` | `0` | **Solo Bun.** Elimina el hilo `mi-scavenger`: −7–12 % de CPU y la mitad de despertares, ≈ +1 MB de RSS | Medición del 16-10-2026 en la VM de pruebas Linux (4 vCPU). **No está en `docs/`**; ver apéndice A. Valídala con un *soak* largo antes de aplicarla |
| `MALLOC_ARENA_MAX` | `2` | −5 MB de RSS con node-datachannel (arenas de glibc de los hilos nativos) | docs/07 §7.5. Con `peerBackend: 'rtc'` no hay hilos nativos: efecto no medido (no verificado) |

---

## 5. `scripts/` y ejemplos

| Archivo | Para qué sirve | Cómo se ejecuta |
|---|---|---|
| `scripts/build.mjs` | Compilación del paquete (ver `npm run build`) | `node scripts/build.mjs [--out dir] [--no-minify]` |
| `scripts/ts-resolve.mjs` | Gancho de resolución: permite que `node --experimental-strip-types` ejecute las fuentes de `src/` (imports `.js` que nombran `.ts`) | `--import ./scripts/ts-resolve.mjs` |
| `scripts/edge.ts` | Punto de entrada del Edge desde fuentes (`npm run edge`) | `npm run edge -- --config edge.json` |
| `scripts/edge-latency.ts` | Mide el sobrecoste del Edge en loopback: RTT por canal (`ro`/`uu`) y CPU del host y del Edge por jugador | Ver abajo |
| `scripts/among-us-screenshots.ts` | Capturas de `examples/among-us-vision.mjs` con el **cliente oficial** real en Chromium, sin red | `HAXBALL_CLIENT_DIR=… node --import ./scripts/ts-resolve.mjs scripts/among-us-screenshots.ts` (variables en §4.2) |
| `scripts/hidden-bigmap-room.mjs` | Sala de un mapa enorme para las capturas de jugadores ocultos | La usa el script anterior con `EXAMPLE=scripts/hidden-bigmap-room.mjs` |
| `scripts/vision-mask-cost.ts` | Coste en bytes y desfase de una «máscara de visión» por jugador (docs/04 §7.4) | `node --import ./scripts/ts-resolve.mjs scripts/vision-mask-cost.ts` |
| `scripts/nan-probe.js` | Patrones de bits de NaN en distintos motores JS (jugadores ocultos, docs/04 §7.4) | `node scripts/nan-probe.js` (también en shells de SpiderMonkey/JSC) |

**`scripts/edge-latency.ts`** (el orquestador lanza tres procesos: principal con FakeMaster y clientes,
host y Edge; el Edge en `127.0.0.2`, el túnel del host en `127.0.0.3`).

| Flag | Tipo | Defecto | Qué hace |
|---|---|---|---|
| `--players` | entero | `8` | Clientes de carga (más una sonda de RTT) |
| `--seconds` | s | `20` | Duración de la ventana de medición |
| `--runs` | entero | `1` | Repeticiones (intercaladas entre modos) |
| `--modes` | lista | `direct,edge,edge-ws` | `direct`, o `edge[-<jugadores>][-<plano>]` con jugadores `rtc` (defecto) o `ndc` y plano `udp` (defecto), `webrtc` o `ws`. `edge` = `edge-rtc-udp`; `edge-ndc-webrtc` = la configuración anterior |
| `--src` | ruta | `src/` | Carga host y Edge desde un build compilado (A/B) |
| `--loss` | % | — | Descarta ese % del UDP 127.0.0.2↔127.0.0.3 en ambos sentidos con una regla nftables (`numgen random`). **Linux y root**; la tabla se elimina al salir |
| `--edge-webrtc` | JSON | `{}` | Opciones extra de `webrtc` del `EdgeServer` |
| `--edge-opts` | JSON | `{}` | Opciones extra de `haxlite.edge` del host (p. ej. `{"roLanes":false}`) |

```sh
flock /tmp/haxlite-bench.lock node --experimental-strip-types --no-warnings \
  --import ./scripts/ts-resolve.mjs scripts/edge-latency.ts \
  --players 16 --seconds 20 --runs 3 --modes edge-rtc-udp,edge-ndc-webrtc
# con pérdida del 2 % en el tramo host↔Edge (root):
sudo node --experimental-strip-types --no-warnings --import ./scripts/ts-resolve.mjs \
  scripts/edge-latency.ts --players 17 --seconds 40 --runs 2 --modes edge --loss 2
```

(docs/09 §7 muestra `--experimental-transform-types`; esa bandera la eliminó Node 26: ver apéndice A.)

**Ejemplos** (`examples/`): `basic-room.mjs`, `moderation.mjs`, `live-room.mjs`,
`among-us-vision.mjs`; sus variables están en §4.2. `test/api/examples.test.ts` los ejecuta contra
el FakeMaster.

---

## 6. Arnés de benchmarks

### 6.1 Piezas y flujo

```
npm run bench:host -- <escenario> [flags]
   │  node bench/build.mjs        compila src/ → node_modules/.cache/haxlite-bench/{dist,bundle}
   ▼
bench/net/run.ts  (orquestador; FakeMaster HTTP+WS en 127.0.0.1)
   ├── bench/net/host-proc.mjs   × procs   el host medido (JS plano, sin cargador de TS; se mide a sí mismo)
   └── bench/net/clients-proc.mjs × ceil(clientes/10)   clientes node-haxball (nunca se cuentan)
```

* Cada repetición usa **procesos nuevos**. Las repeticiones se **intercalan** entre configuraciones
  (rep 1 de todas, luego rep 2…) para que la deriva de la máquina afecte a todas por igual.
* `bench/build.mjs`: hash SHA-256 de `src/**`, `tsconfig*.json`, `scripts/build.mjs`,
  `package.json`, `package-lock.json` y las versiones de `typescript` y `rolldown`; si coincide con
  el sello (`build-stamp.json`) no recompila. Genera `dist/` (por módulo, para variantes con
  `dist`) y `bundle/` (el paquete minificado publicado, que es lo que se mide por defecto).
* `bench/ts-resolve.mjs`: cargador que resuelve `.js`→`.ts` y transpila TypeScript con oxc
  (`rolldown/experimental`); **no** hace falta `--experimental-transform-types`. Bun ejecuta los
  mismos archivos sin cargador.
* Bajo Bun el orquestador también funciona: `bun bench/net/run.ts game --impl haxlite:rtc@bun`.
* En máquinas compartidas, envuelve cada ejecución en `flock /tmp/haxlite-bench.lock …` (los `.sh`
  ya lo hacen). **Solo una medición de CPU a la vez.**
* El JSON de salida (`bench/results/<escenario>.json`) guarda `info` (fecha, commit, hash del
  build, versiones, CPU, `params` con **todos los flags efectivos**) y, por configuración, cada
  corrida y su `summary` (mediana, mín, máx, media, IC 95 %).

### 6.2 `bench/net/run.ts`: escenarios y flags

Uso: `node --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts <escenario> [flags]`
(o `npm run bench:<escenario> -- [flags]`). El escenario por defecto, si falta, es `game`.

#### Escenarios

| Escenario | Qué mide | Configuraciones que genera | Métrica clave (`--precision`) | Salida por defecto |
|---|---|---|---|---|
| `startup` | Tiempo del inicio del proceso al enlace de la sala | una por `--impl`; 1 sala, 0 clientes, ventana 0,25 s | proceso → enlace (ms) | `bench/results/startup.json` |
| `idle` | Sala pública con 0 jugadores: CPU %, RSS, hilos, despertares | una por `--impl` | CPU % | `idle.json` |
| `game` | N clientes jugando en 1 sala | `--n` × `--impl` | CPU % | `game.json` |
| `rooms` | K salas en un proceso, 4 clientes por sala | `--k` × `--impl` | CPU % | `rooms.json` |
| `soak` | R salas × C plazas con jugadores entrando y saliendo durante horas; pendiente MB/h, deriva de fds, tamaño de cada Map/Set | `--rooms` × `--clients` × `--impl` | CPU % | `soak.json` |
| `fleet` | P procesos host × R salas × C clientes, medidos juntos (CPU/RSS sumados) | `--procs` × `--rooms` × `--clients` × `--impl` | CPU % | `fleet.json` |
| `join-impaired` | Latencia de entrada con RTT, pérdida y STUN simulados (NAT de usuario de `test/rtc/nat-sim.ts`). **Solo `haxlite:rtc`** | `--rtt` × `--loss` × `--stun` × `--impl` | entrada p50 (ms) | `join-impaired.json` |

Con `--quick` la salida va a `bench/results/dev/` (ignorado por git: `bench/results/dev/.gitignore`).

#### Flags comunes

| Flag | Tipo | Defecto | Con `--quick` | Qué hace / notas |
|---|---|---|---|---|
| `--impl` | lista | `haxlite,official,nodehaxball`; `rooms`: `haxlite`; `soak`, `fleet`, `join-impaired`: `haxlite:rtc` | igual | Implementaciones a comparar (§6.3) |
| `--runtime` | `node` / `bun` | `node` | igual | Runtime del **proceso host** (no de clientes ni orquestador). Un sufijo `@bun`/`@node` en `--impl` manda sobre este flag |
| `--reps` | entero | `3`; `startup`: `10`; `soak`, `join-impaired`: `1` | `2`; `startup`: `3`; `soak`, `join-impaired`: `1` | Repeticiones (el mínimo si hay `--precision`) |
| `--warmup` | s | `15`; `idle`: `10`; `soak`: `60` | `3`; `soak`: `10` | Calentamiento. Con `--warmup-mode auto` es el **tope** |
| `--warmup-mode` | `auto` / `fixed` | `auto` | igual | `auto`: termina cuando dos bloques de 3 s coinciden (CPU ± 5 % o ± 0,25 puntos; RSS ± 1 %), nunca antes de `--min-warmup`. `soak` siempre es fijo. `fixed` reproduce el método anterior |
| `--min-warmup` | s | `6` | `2` | Suelo del calentamiento automático |
| `--window` | s | `60`; `idle`: `200` | `10`; `idle`: `20` | Ventana de medición de CPU. En `soak` se usa `--minutes` |
| `--out` | ruta | `bench/results/<escenario>.json` | `bench/results/dev/<escenario>.json` | Archivo JSON. Se reescribe tras cada corrida |
| `--max-foreign` | % de un núcleo | `100` | igual | Si otros procesos de la máquina usaron más de esto durante la ventana, la repetición se repite |
| `--attempts` | entero | `2` | igual | Intentos por repetición; tras agotarlos se conserva el menos ruidoso y se marca `noisy`. Las tandas publicadas usan `--max-foreign 50 --attempts 3` |
| `--precision` | % | `0` (apagado) | igual | Tras `--reps`, más rondas solo para configuraciones cuya métrica clave tenga un IC 95 % (t de Student) más ancho que P % de la media |
| `--max-reps` | entero | con `--precision`: `max(2·reps, reps+2)`; sin él: `reps` | igual | Tope de rondas con `--precision` |
| `--join-concurrency` | entero | `1` en `game` y `join-impaired`; `4` en el resto | `4` (`join-impaired`: `1`) | Entradas en vuelo por proceso de clientes (≤ 10 clientes cada uno). Con C > 1 sube algo la latencia de entrada; `report.mjs` lo marca |
| `--settle-ms` | ms | `250` | igual | Pausa tras la salida de los procesos de una corrida |
| `--parallel` | entero | `1` | igual | K configuraciones a la vez. **Solo `idle`, `soak`, `join-impaired`**; en otros escenarios el arnés lo rechaza. Implica `--pin` |
| `--pin` | (sin valor) | apagado | igual | Linux con `taskset`: cada host a su núcleo (`taskset -c`), el resto del arnés a los demás. Sin `taskset` o con < 2 CPU avisa y no fija |
| `--host-node-args` | cadena | vacío | igual | Argumentos extra de Node **solo** para el proceso host (diagnóstico: `"--cpu-prof --cpu-prof-dir=DIR"`) |
| `--quick` | (sin valor) | apagado | — | Perfil de **desarrollo, NO publicable** (`info.publishable: false`). Un flag explícito manda sobre el perfil |

Lag del event loop (`game`, `rooms`, `fleet`, `soak`):

| Flag | Defecto | Con `--quick` | Qué hace |
|---|---|---|---|
| `--eld` | `1` | igual | `0` = sin medir lag |
| `--eld-window` | `10` s | `3` | Duración de la sub-ventana de lag, justo tras el calentamiento y **antes** de la ventana de CPU |
| `--eld-method` | `timer` | igual | `timer` = `setInterval` de 10 ms (igual en Node y Bun); `native` = `monitorEventLoopDelay` (solo Node; en Bun cae a `timer`) |
| `--eld-mode` | `separate` | igual | `separate` = sub-ventana propia (la CPU no incluye el monitor); `inline` = método anterior al 16-10-2026, dentro de la ventana de CPU (diagnóstico) |

Flags por escenario:

| Escenario | Flag | Tipo | Defecto | Con `--quick` | Qué hace |
|---|---|---|---|---|---|
| `game` | `--n` | lista | `4,10,20` | `4,10` | Clientes por sala |
| `rooms` | `--k` | lista | `1,5,10` | `1,5` | Salas por proceso (4 clientes cada una) |
| `soak`, `fleet` | `--rooms` | lista | `4` | `2` | Salas por proceso |
| `soak`, `fleet` | `--clients` | lista | `4` | `2` | Clientes (plazas) por sala |
| `fleet` | `--procs` | lista | `3` | `3` | Procesos host simultáneos |
| `soak` | `--minutes` | min | `360` | `3` | Duración de la ventana de muestreo |
| `soak` | `--sample-s` | s | `60` | `15` | Una muestra cada tanto (se guarda al llegar: un soak cortado conserva lo medido) |
| `soak` | `--stay-s` | `min,max` | `20,90` | igual | Tiempo que juega cada plaza (uniforme) |
| `soak` | `--pause-s` | `min,max` | `2,15` | igual | Pausa antes de reentrar (uniforme) |
| `join-impaired` | `--rtt` | lista (ms) | `40` | igual | RTT host↔cliente y host↔STUN (se inyecta rtt/2 por sentido) |
| `join-impaired` | `--loss` | lista (%) | `0,1,3` | `0,3` | Pérdida por sentido |
| `join-impaired` | `--jitter` | ms | `0` | igual | Jitter uniforme ± |
| `join-impaired` | `--stun` | lista | `cold,cached` | igual | `cold`: cada sesión repite la ronda STUN (`gatherRefreshMs` 0); `cached`: una ronda antes del enlace y se reutiliza (1 h) |
| `join-impaired` | `--joins` | entero | `20` | `5` | Clientes que entran uno tras otro (8 s de límite y hasta 4 intentos cada uno) |
| `join-impaired` | `--nat-outside` | IP | `127.0.0.1` | igual | Lado externo del NAT simulado |
| `join-impaired` | `--nat-filtering` | cadena | `endpoint-independent` | igual | Filtrado del NAT (`NatFiltering` de `test/rtc/nat-sim.ts`): *full cone* por defecto |

Notas de diseño: el escenario `fleet` y `soak` sin `--quick` generan el producto cartesiano de las
listas (`--rooms 4,8 --clients 2,4` son 4 configuraciones por `--impl`). `idle` dura
`--warmup + --window` por corrida y repetición.

### 6.3 Implementaciones y runtimes (`--impl`, `--runtime`)

| `--impl` | Host medido | WebRTC |
|---|---|---|
| `haxlite` | `HostRoom` + `HostTransport` del bundle | `peerBackend` por defecto (`ndc`) |
| `haxlite:ndc` | igual | node-datachannel (explícito) |
| `haxlite:rtc` | igual | haxlite-rtc en `127.0.0.1` (`rtcEndpoint: {address: '127.0.0.1', publicAddresses: ['127.0.0.1']}`) |
| `haxlite:<nombre>` | variante definida en `HAXLITE_BENCH_VARIANTS` | la que defina la variante |
| `official` | script oficial del headless ejecutado por `haxball.js` | `@webrtc-node/webrtc` |
| `nodehaxball` | `node-haxball` (`Room.create`) como host | su `node-datachannel` propio |

Sufijo de runtime: `haxlite:rtc@bun`, `haxlite:rtc@node` (el sufijo manda sobre `--runtime`). Los
nombres de resultados en JSON son `spec.impl` (sin sufijo) y `spec.runtime`. Todas las
implementaciones reciben la misma sala: pública, `noPlayer`, 30 jugadores, geo `ar`, estadio
Classic, sin límites de goles ni tiempo.

Variantes A/B (`HAXLITE_BENCH_VARIANTS`): JSON `{ "<nombre>": { dist?, bundle?, transport?, sctp?, logger? } }`.
`dist` = otro build `tsc` por módulo (ruta relativa al repositorio); `bundle` = directorio de otro
build de `scripts/build.mjs --out`; `transport` = opciones extra de `HostTransport`; `sctp` y
`logger` = `setSctpSettings()` / `initLogger()` de node-datachannel.

```sh
HAXLITE_BENCH_VARIANTS='{"base":{"dist":"node_modules/.cache/hx/base/dist"},"new":{"dist":"node_modules/.cache/hx/new/dist"}}' \
  node --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts game \
  --impl haxlite:base,haxlite:new --n 4,20 --eld 0 --out bench/results/ab.json
```

### 6.4 Guiones `.sh`

Todos hacen `cd` a la raíz, ejecutan `node bench/build.mjs` y envuelven cada corrida en
`flock /tmp/haxlite-bench.lock` (necesitan Linux). Duraciones: las que estiman los propios guiones
y docs/07 (no medidas aquí).

| Guion | Qué corre | Duración | Salida |
|---|---|---|---|
| `bench/net/unified.sh` | Comparativa de **5 hosts** (`official,nodehaxball,haxlite:ndc,haxlite:rtc,haxlite:rtc@bun`) en 4 escenarios: `startup` (10 reps), `idle` (3 × 120 s, `--parallel 3`), `game` (N = 4,10,20; 3 × 60 s tras 15 s), `rooms` (K = 10; 3 × 60 s). Todos con `--max-foreign 50 --attempts 3` | ≈ 1 h 35 | `bench/results/unified-{startup,idle,game,rooms}.json`; luego `node bench/net/report.mjs --unified` |
| `bench/net/quick.sh` | Los 4 hosts sin Bun (`official,nodehaxball,haxlite:ndc,haxlite:rtc`) con ventanas de 30 s (idle 60 s, `--parallel 3`) | ≈ 27 min | `bench/results/quick-*.json`. **No confundir con `run.ts --quick`** |
| `bench/net/ours.sh` | Solo `haxlite:rtc` y `haxlite:rtc@bun`: `startup` (10 reps), `game` (N = 20, 3 × 30 s), `rooms` (K = 10), `idle` (3 × 60 s, `--parallel 2`) | ≈ 13 min | `bench/results/ours-*.json` |
| `bench/net/extra.sh` | Escenarios de producción con `haxlite:rtc,haxlite:rtc@bun`: `fleet` (3 × 4 × 4, 3 reps × 60 s), `join-impaired` (rtt 40, pérdida 0/1/3, STUN frío/caché, 20 entradas, 3 reps, `--parallel 2`) y `soak` (4 × 4, `--minutes ${SOAK_MIN:-360}`, `--sample-s 60`, `--parallel 2`) | ≈ 6 h 20; `SOAK_MIN=30` ≈ 50 min | `bench/results/{fleet,join-impaired,soak}.json` |

### 6.5 Cómo reproducir cada tabla

Prerrequisitos de **todas**: Linux (4 vCPU recomendadas), `npm ci`, `taskset` y `flock`, `bun` en el
`PATH` o `BUN_PATH` si hay `@bun`, y una máquina sin otra carga (los valores absolutos de CPU
cambian entre sesiones y máquinas: compara solo dentro de una misma tanda).

`R` en los ejemplos: `R="node --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts"`
y `L="flock /tmp/haxlite-bench.lock"`.

#### `docs/benchmark-hosts.md` — tabla «Resultado actual» (tanda unificada del 13-10-2026)

Filas por escenario y comando equivalente (4 hosts: `I=official,nodehaxball,haxlite:ndc,haxlite:rtc`):

| Filas de la tabla | Escenario | Comando |
|---|---|---|
| Arranque proceso → link, RSS al link | `startup` | `$L $R startup --impl $I --reps 10 --max-foreign 50 --attempts 3 --out bench/results/unified-startup.json` |
| Sala vacía (CPU %, despertares/s, RSS) | `idle` | `$L $R idle --impl $I --reps 3 --warmup 15 --window 120 --max-foreign 50 --attempts 3 --out bench/results/unified-idle.json` |
| 4, 10 y 20 jugadores (CPU %, RSS, heap, GC, lag, hilos, fds, despertares, entrada p50) | `game` | `$L $R game --impl $I --n 4,10,20 --reps 3 --warmup 15 --window 60 --max-foreign 50 --attempts 3 --out bench/results/unified-game.json` |
| 10 salas × 4 (CPU %, RSS, GC, fds) | `rooms` | `$L $R rooms --impl $I --k 10 --reps 3 --warmup 15 --window 60 --max-foreign 50 --attempts 3 --out bench/results/unified-rooms.json` |

Atajo actual: `sh bench/net/unified.sh` (añade `haxlite:rtc@bun`, usa `--parallel 3` en `idle`,
calentamiento automático y lag en sub-ventana propia, así que **no es idéntico** a la tanda del
13-10, que usaba el arnés anterior). Tablas: `node bench/net/report.mjs --unified`. La tabla de
tres columnas de `benchmark-hosts.md` son esos mismos datos sin la columna `haxlite + ndc`.
Para acercarte al método del 13-10: añade `--warmup-mode fixed --eld-mode inline` (no verificado
que reproduzca exactamente las cifras de entonces).

#### `docs/benchmark-hosts.md` — «Resultado rápido anterior» (11-10-2026)

`sh bench/net/quick.sh` (ventanas de 30 s; sala vacía 60 s) → `bench/results/quick-*.json`.

#### `docs/benchmark-hosts.md` y `docs/07` — «Comparativa unificada anterior», reparto por hilo, versiones de WebRTC

* Misma tanda que `unified-*.json` de 11-10-2026 (ya sobrescrita en el repositorio): los comandos son los
  de arriba con el arnés de entonces. El **reparto por hilo** (`hilo JS`, `RTC worker`, `juice poll`,
  `SCTP timer`) sale de `node bench/net/report.mjs --unified` (campo `host.cpuSplit` y lectura de
  `/proc/self/task/*/stat`).
* «Qué WebRTC usa cada librería» no es una medición: son versiones comprobadas en `node_modules`;
  `info.versions` de cada JSON las guarda (`haxball.js`, `node-haxball`, `node-datachannel`,
  `@webrtc-node/webrtc`).

#### `docs/07` — escenarios de producción y Bun

| Tabla | Comando |
|---|---|
| `fleet` | `npm run bench:fleet -- --impl haxlite:rtc,haxlite:rtc@bun` (3 × 4 × 4 por defecto) |
| `soak` | `npm run bench:soak -- --impl haxlite:rtc,haxlite:rtc@bun` (4 × 4, 6 h) o `-- --minutes 10 --sample-s 30` |
| `join-impaired` | `npm run bench:join-impaired -- --impl haxlite:rtc,haxlite:rtc@bun` |
| Las tres a la vez | `sh bench/net/extra.sh` |
| Pruebas de humo (Windows, 16-10-2026) | mismos comandos con tamaños mínimos; no son resultados (docs/07 lo aclara) |

Desarrollo rápido, no publicable: `npm run bench:game -- --quick --impl haxlite:rtc,haxlite:rtc@bun` (≈ 1 min).

#### `docs/07` §2.5 y siguientes (histórico) y `docs/10` §6

| Tabla | Comando |
|---|---|
| §2.5 `startup`, `game`, `rooms`, `idle` (3 hosts) | `npm run bench:build`; `$R startup`; `$R game`; `$R rooms --impl haxlite,official,nodehaxball`; `$R idle` (defectos) |
| §4.5 física | `for i in 1 2 3; do npm run -s bench:sim -- --out bench/results/sim.json; done` |
| §5.1 reloj | `node bench/timer.bench.mjs 20 1; node bench/timer.bench.mjs 20 10` |
| §7.1 despertares | `node bench/wakeups.bench.mjs <dist> <salas> <segundos> [maxWakeFrames]` |
| §7.2 camino de mensajes | `node bench/host-msg.bench.mjs <dist> 20 2000000` (`HEAP_PROF=f.heapprofile` para atribuir) |
| §7.3 arranque | `node --import ./bench/ts-resolve.mjs bench/startup/run.ts 20 antes=<dist-a>/index.js ahora=dist/index.js` |
| §7.5 flags de Node | `$R game --impl haxlite:new --n 20 --reps 2 --eld 0 --host-node-args "--v8-pool-size=1"` |
| «Pasada de ligereza — red» | `bench/net/natives.mjs --n 20 --seconds 15 --dist <dist> [--mux 1]` y `scripts/edge-latency.ts` (§5) |
| docs/10 §6 (rtc vs ndc con Chromium) | `bench/rtc/run.ts` (§6.6) |
| docs/10 §6.3 (asignaciones del host) | `bench/rtc/sctp-host-alloc.ts` (§6.6) |

#### `docs/09` §7 (overhead del Edge)

`scripts/edge-latency.ts`: ver §5. Las tablas de 17 jugadores (16 + sonda) usan `--players 16
--seconds 20 --runs 3 --modes edge-rtc-udp,edge-ndc-webrtc`, y las de 9 jugadores `--players 8 --modes
direct,edge-rtc-udp,edge-ndc-webrtc,edge-rtc-ws`. Las de pérdida (§7.1) añaden `--loss 0|2|5`
(root, Linux) con `--seconds 40 --runs 2` y los modos `edge-ndc-webrtc`, `edge-rtc-webrtc` y `edge-rtc-udp`
(túnel v1 frente a v2). Los argumentos exactos de cada celda se **reconstruyeron** a partir del texto de
docs/09 (no verificado).

### 6.6 Otros bancos

**`bench/startup/run.ts`** — arranque en frío de `HBInit` (proceso nuevo → `import` del paquete →
sala → enlace, contra el FakeMaster, sin red). Posicional, sin flags con nombre:

```sh
node --no-warnings --import ./bench/ts-resolve.mjs bench/startup/run.ts \
  <reps> <etiqueta=entry.js> [<etiqueta=entry.js> …] [-- flags de node…]
# p. ej. comparar dos builds:
node --no-warnings --import ./bench/ts-resolve.mjs bench/startup/run.ts 20 antes=/ruta/dist-a/index.js ahora=dist/index.js
```

Las entradas se intercalan. Imprime un JSON con la **mediana** por etiqueta de `importMs`,
`hbinitToLinkMs`, `processToLinkMs`, `cpuMs`, `rssMB`, `heapMB`, `cjsModules`. Los argumentos tras
`--` se pasan a `node` en cada hijo (p. ej. `--max-semi-space-size=1`).

**`bench/rtc/run.ts`** — haxlite-rtc frente a node-datachannel con Chromium real (docs/10 §6).
Requiere Linux (`/proc`), Chromium (`HAXLITE_CHROMIUM`) y rolldown.

| Flag | Tipo | Defecto | Qué hace |
|---|---|---|---|
| `--backends` | lista | `ndc,rtc` | Backends a medir |
| `--peers` | lista | `1,10,30` | PeerConnections de Chromium |
| `--seconds` | s | `30` | Ventana |
| `--warmup` | s | `5` | Calentamiento |
| `--input-hz` | Hz | `8` | Inputs por segundo por cliente (Poisson) |
| `--per-page` | entero | `10` | PeerConnections por página |
| `--address` | IP | `127.0.0.1` | Dirección ICE del servidor |
| `--out` | ruta | vacío (no escribe) | JSON de resultados (docs/10 usó `bench/results/rtc-backends-1.json` y `-2.json`) |

```sh
flock /tmp/haxlite-bench.lock node --no-warnings --import ./bench/ts-resolve.mjs bench/rtc/run.ts \
  --backends ndc,rtc --peers 1,10,30 --seconds 30 --warmup 5 --out bench/results/rtc-backends.json
```

**`bench/rtc/sctp-host-alloc.ts`** — asignaciones del camino de datos (SCTP + `RtcPeerLink`) sin red.
Flags: `--peers` (20), `--seconds` (120), `--no-bundle`, `--const-clock`, `--depth` (3),
`--show-other`, `--warmup-frames` (20000). Los valores por defecto se leyeron de la documentación
del encabezado; el archivo tiene 320 líneas y no se contrastó cada uno (no verificado).
`bench/rtc/server-proc.ts` es el proceso medido de `run.ts` (no se ejecuta a mano).

**Micro-benchmarks sueltos:**

| Archivo | Uso | Mide |
|---|---|---|
| `bench/sim.bench.ts` | `npm run bench:sim [-- --out f.json]` | `stepWorld` frente al paso oficial (ns/tick; Classic y Huge) |
| `bench/timer.bench.mjs` | `node bench/timer.bench.mjs [segundos=20] [salas=1]` | Coste de las estrategias de reloj del host |
| `bench/wakeups.bench.mjs` | `node bench/wakeups.bench.mjs <dist> [salas=1] [segundos=10] [maxWakeFrames=4]` | Despertares del reloj, sin red |
| `bench/host-msg.bench.mjs` | `node bench/host-msg.bench.mjs [dist] [clientes=20] [mensajes=2e6]` | CPU y bytes asignados por mensaje del host |
| `bench/net/natives.mjs` | `node bench/net/natives.mjs [--n 20] [--seconds 20] [--warmup 3] [--mux 0\|1] [--sctp JSON] [--logger Nivel] [--dist ruta] [--loss 0] [--json out.json]` | Solo la parte nativa de WebRTC (node-datachannel) |

### 6.7 Informes y gráficos

| Comando | Qué genera |
|---|---|
| `node bench/net/report.mjs [dir]` | Tablas markdown de `docs/07` desde `bench/results/*.json` (por defecto `bench/results/`). Marca los resultados `--quick` como no publicables |
| `node bench/net/report.mjs --unified [dir]` | Comparativa unificada (`unified-*.json`) |
| `node bench/charts.mjs <dirSalida> [dirResultados] [claves]` | Tarjetas HTML/SVG y PNG. `dirResultados` por defecto `bench/results/quick`; `claves`: lista de `rtc,ndc,off,nh,rtcbun` (por defecto las cuatro primeras). Navegador: `$CHROME_PATH`, Chromium de Playwright o Chrome/Edge local; sin navegador solo escribe `charts.html`. Imágenes publicadas: `node bench/charts.mjs docs/img/benchmark bench/results/unified rtc,off,nh` |

---

## 7. `ops/haxguard`: firewall nftables y XDP

Cuatro archivos de ejemplo. **Ninguno se carga solo ni lo invoca el código de haxlite**: son
configuraciones para copiar y adaptar (verificado: ningún archivo de `src/` ni `scripts/` llama a
`nft`, `bpftool` ni menciona `haxguard`; el único uso de `nft` es el de pérdida simulada de
`edge-latency.ts`).

| Archivo | Qué hace | Cómo se carga | Parámetros a editar |
|---|---|---|---|
| `haxguard.nft` | Tabla `netdev haxguard` en el hook **ingress** (`priority -500`, antes de conntrack) de la interfaz pública. Para los puertos de sala, en orden: descarta fragmentos UDP/IPv6; deja pasar el UDP que no va a `ROOM_PORTS`; descarta IPs en `deny4/6`; descarta puerto origen < 1024 (reflexión DNS/NTP/CLDAP/SNMP…); acepta jugadores de `active4/6` con tope de 1000 pps por IP (ráfaga 200); acepta respuestas de `stun_servers4`; descarta puertos origen de reflectores (`amp_sports`); acepta IPs de `pending4/6` (20 s); acepta STUN de desconocidos (`udp length >= 28`, cookie `0x2112a442`) con límite de 5/s (ráfaga 10) por origen y 2000/s global; **descarta todo lo demás**. Contadores `c_*` por regla | `nft -c -f ops/haxguard/haxguard.nft` (validar) y `nft -f ops/haxguard/haxguard.nft` (cargar, como root). La línea `destroy table netdev haxguard` hace el archivo idempotente (requiere un nftables con `destroy`; versión mínima no verificada). Quitar: `nft delete table netdev haxguard` | `define WAN = "eth0"` (interfaz) y `define ROOM_PORTS = 20000-20999` (**por defecto no coincide con los 40000 de docs/09**: ajusta al `webrtc.port`/`rtc.port` real). El rango debe quedar fuera de `net.ipv4.ip_local_port_range` (32768-60999) |
| `haxguard_xdp.c` | Boceto **XDP solo IPv4** equivalente al anterior: mapas `active4`, `pending4` (hash con caducidad), `deny4` (LPM), `stunrate4` (LRU) y contadores per-CPU `stats`; mismos pasos y límites (5 pps, ráfaga 10) | `clang -O2 -g -target bpf -c haxguard_xdp.c -o haxguard_xdp.o`; luego `ip link set dev eth0 xdpgeneric obj haxguard_xdp.o sec xdp` (o `xdpdrv`/`xdp-loader load -m native`). Mapas anclados en `/sys/fs/bpf/haxguard/`; se actualizan con `bpftool map update pinned …` | `ROOM_PORT_MIN/MAX` (20000-20999), `STUN_PPS_PER_SRC`, `STUN_BURST`. No compilado ni cargado en esta revisión (no verificado) |
| `relay-only.nft` | Tabla `inet haxhost` para el **host** con `iceTransportPolicy: 'relay'` y node-datachannel: solo deja salir/entrar UDP del rango `40000-40999` hacia/desde las IP del servidor TURN; cualquier otro UDP de ese rango se descarta (cierra la fuga de *checks* directos de libjuice, docs/08, docs/ip/02 §5.3) | `nft -f ops/haxguard/relay-only.nft` | Los sets `turn4`/`turn6` (IP de Cloudflare TURN o de tu relay; hay que vigilar sus A/AAAA) y el rango de puertos, que debe coincidir con `portRange: [40000, 40999]` |
| `canary-counters.nft` | Tabla `inet ipresearch_test` **solo de conteo** (sin `drop`): contadores por `(daddr, dport)` en `41000-41999` para atribuir ataques por dirección («canary addressing», docs/ip/04 §1.4) | `nft -f ops/haxguard/canary-counters.nft`; leer con `nft -j list set inet ipresearch_test canary4` | Rango de puertos. En producción conviene moverlo a una tabla `netdev`/ingress |

**Advertencias de uso (léelas antes de cargar `haxguard.nft`):**

1. **El archivo, tal como está, bloquea el juego.** Solo deja pasar a un origen desconocido el STUN
   inicial; todo lo demás (DTLS, SCTP) cae en el paso 8 («todo lo demás hacia los puertos de sala»)
   salvo que su IP esté en `active4/6` o `pending4/6`. Esos conjuntos los debe mantener un *sidecar*
   con privilegios que **no existe en el repositorio** (docs/08 §3 lo lista como pendiente: eventos
   `onPeerPending`/`onPeerAddress`/`onPeerGone`). Sin él, el firewall solo sirve como esqueleto o
   para pruebas.
2. Con el Edge (`rtc`), el puerto de jugadores es **uno** para todos; el comentario del archivo
   habla de «1 puerto UDP por sala» (`enableIceUdpMux`, del backend `ndc`).
3. Para el modo relay con el backend `rtc`, el puerto del endpoint se fija con `rtc.port`, no con
   `portRange` (que solo aplica a node-datachannel). Ajusta `relay-only.nft` al puerto real (no
   verificado en producción).
4. Un firewall en el host **no** detiene un ataque que sature el enlace: hace falta mitigación del
   proveedor (docs/ip/03).

---

## 8. Integración continua (`.github/workflows`)

### `ci.yml` — «CI»

* **Disparadores:** `push` a `main`, `pull_request` y `workflow_dispatch`. Permisos `contents: read`.
  `concurrency` por flujo y rama con cancelación de ejecuciones anteriores.
* **Job `test`** («Node 22.x / 24.x / 26.x», `ubuntu-latest`, 30 min, `fail-fast: false`):
  `npm ci` → `npm run typecheck` → `npm run build` → `npx vitest run` (ambos proyectos, `ndc` y
  `rtc`). Las pruebas con Chromium se omiten (no hay navegador en el job).
* **Job `interop`** («Interop (Chromium)», Node 24.x, 45 min, `continue-on-error: true`: **no hace
  fallar** el flujo): instala el Chromium que fija `playwright-core` con
  `npx playwright-core install --with-deps chromium`; fija `PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TEMP/pw-browsers`
  y `HAXLITE_CHROMIUM=$RUNNER_TEMP/pw-browsers/chromium-1194/chrome-linux/chrome`; comprueba que el
  binario es ejecutable; ejecuta `npx vitest run --project ndc test/rtc/chromium-dtls.test.ts test/rtc/sctp/chromium.test.ts` y luego
  `npm run test:interop`. No usa `HAXBALL_CLIENT_DIR`: las pruebas contra el cliente oficial se omiten.

### `publish.yml` — «Publish»

* **Disparadores:** `push` de una etiqueta `v*` y `workflow_dispatch`. Permisos `contents: read`,
  `packages: write`.
* **Pasos:** Node 24.x con registro `https://npm.pkg.github.com` → `npm ci` → `npm run typecheck` →
  `npm run build` → (solo con etiqueta) comprueba que `v<version de package.json>` coincide con la
  etiqueta → renombra el paquete a `@<propietario en minúsculas>/haxlite`, fija `publishConfig`,
  `repository.url` y quita `private` (con `npm pkg set/delete`, solo en el *checkout* del job) →
  `npm publish` con `NODE_AUTH_TOKEN=${{ secrets.GITHUB_TOKEN }}`.
* **No ejecuta las pruebas** (solo tipos y compilación): publica lo que haya en la etiqueta.
* En el repositorio el paquete sigue llamándose `haxlite` y es `private`; los consumidores lo
  instalan con un alias (§9.5).

---

## 9. Despliegue de producción

### 9.1 Edge en un servidor dedicado (systemd + TLS)

Resumen operativo de [09 §3](09-haxlite-edge.md) contrastado con el código (§3). Requisitos: Node
≥ 22 (o Bun: lo afirma docs/09, no verificado aquí con el CLI), una IP pública (idealmente con
mitigación DDoS aguas arriba, docs/ip/03), un nombre DNS para el certificado y ningún addon nativo
con la configuración por defecto.

```sh
# 1. Instalar y compilar (como el usuario que ejecutará el servicio, o copiar /opt/haxlite)
git clone <repo> /opt/haxlite && cd /opt/haxlite && npm ci && npm run build

# 2. Una clave por host o cliente del servicio
node bin/haxlite-edge.js genkey alice            # imprime la línea para el host y la del Edge

# 3. Configuración (root:haxlite 0640; las claves 0600)
install -d -m 0750 -o root -g haxlite /etc/haxlite-edge
```

`/etc/haxlite-edge/config.json` (JSON estricto):

```json
{
  "listen": { "host": "0.0.0.0", "port": 8443, "path": "/tunnel" },
  "tls": {
    "certFile": "/etc/haxlite-edge/fullchain.pem",
    "keyFile":  "/etc/haxlite-edge/privkey.pem"
  },
  "keysFile": "/etc/haxlite-edge/keys.txt",
  "playerBackend": "rtc",
  "webrtc": { "bindAddress": "203.0.113.10", "port": 40000, "publicAddresses": ["203.0.113.10"] },
  "tunnel": { "port": 8443 },
  "limits": { "maxPeersPerSession": 40, "maxPeersPerKey": 256, "maxSessionsPerKey": 16 },
  "stats": { "path": "/stats", "token": "cambiar-esto", "logIntervalMs": 60000 }
}
```

`/etc/haxlite-edge/keys.txt` (modo 0600, `#` comenta): una línea `id:secreto` por clave.

`/etc/systemd/system/haxlite-edge.service` (de docs/09 §3; el `ExecStart` apunta a un Node del sistema):

```ini
[Unit]
Description=haxlite Edge (WebRTC gateway)
After=network-online.target
Wants=network-online.target

[Service]
User=haxlite
Group=haxlite
WorkingDirectory=/opt/haxlite
ExecStart=/usr/bin/node /opt/haxlite/bin/haxlite-edge.js --config /etc/haxlite-edge/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=2
# puerto < 1024 sin root: AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/etc/haxlite-edge
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now haxlite-edge
journalctl -u haxlite-edge -f           # el log va a stdout con marca de tiempo
systemctl reload haxlite-edge           # SIGHUP: recarga el certificado TLS
```

**TLS con Let's Encrypt.** El usuario `haxlite` debe poder leer los PEM. Lo habitual es un *deploy
hook* de certbot (`/etc/letsencrypt/renewal-hooks/deploy/`) que copie `fullchain.pem` y `privkey.pem` a
`/etc/haxlite-edge/` con el grupo `haxlite` y ejecute `systemctl reload haxlite-edge`. También se
pueden apuntar `certFile`/`keyFile` directamente a `/etc/letsencrypt/live/<dominio>/…` si el grupo
tiene acceso (ese directorio es `root` por defecto).

**Con systemd, qué cambiar al desplegar:**

* Fija `webrtc.port` (y abre ese puerto UDP): por defecto es efímero.
* Detrás de NAT 1:1 (nube): `bindAddress` = IP privada (o no la pongas) y `publicAddresses` = IP
  pública (+ `publicPort` si el puerto externo difiere).
* `LimitNOFILE=65536` (de docs/09) sobra con `rtc`: el Edge usa un socket UDP para todos los
  jugadores y otro para todos los hosts, más una conexión WebSocket por sala (estimación a partir del
  código, no medida).
* Si usas `ProtectSystem=strict`, el servicio no puede escribir fuera de `PrivateTmp`; el Edge no
  escribe archivos, así que no hace falta `ReadWritePaths`.

**Firewall del Edge** (resumen de §3.5 y docs/09 §3.1): TCP `listen.port` abierto con límite de
conexiones nuevas; UDP `tunnel.port` solo desde los hosts si tienen IP fija; UDP `webrtc.port`
abierto al mundo (candidato a `ops/haxguard`, ver las advertencias de §7); `GET /stats` con token o
solo en red privada. En los hosts: **sin puertos entrantes** y, opcionalmente, un firewall de salida
que solo permita UDP hacia el Edge.

### 9.2 Salas haxlite (Bun/Node, pm2, puertos UDP)

Lo que los documentos describen de la producción (docs/07 §«Escenarios de producción y Bun»):
haxlite con **Bun 1.x**, `peerBackend: 'rtc'`, **3 procesos pm2 × 4 salas** por servidor Linux. Los
documentos no incluyen un `ecosystem.config.js` ni una unidad systemd de las salas; lo siguiente es
lo que se deduce del código y de docs/10:

* **Un puerto UDP por proceso.** Las salas de un mismo proceso con la misma configuración (puerto,
  direcciones, `ipv6`, certificado, tiempos, suites) comparten **un** `RtcEndpoint` y un socket UDP
  (`shared: true`, por defecto). Con `rtc.port: 0` (el defecto) el puerto es efímero: en producción
  fija un puerto **distinto por proceso** (p. ej. 40000, 40001, 40002) y ábrelos en el firewall.
* **IP pública:** con IP pública sin NAT basta `rtc.port`; en nube con NAT 1:1, `publicAddresses`
  (+ `publicPort`). Sin `publicAddresses` ni STUN alcanzable, el endpoint anuncia las IP públicas de
  las interfaces y consulta STUN (`stun.l.google.com:19302` por defecto).
* **Sin puertos TCP entrantes:** la señalización es un WebSocket saliente al maestro.
* **Proxies** (si la salida pasa por uno): el agente se pasa por opción (`haxlite.agent`); las
  variables `HTTP(S)_PROXY` **no** se aplican solas (§4.1).
* **Token:** cada sala necesita un *headless token* vigente al arrancar (caduca a los pocos
  minutos); una sala reiniciada necesita uno nuevo.
* Opciones concretas (`peerBackend`, `rtc.*`, `edge`, `iceServers`…): [11 — Referencia de la API](11-referencia-api.md)
  y [10 §3](10-haxlite-rtc.md).
* Hospedar **detrás de un Edge** en vez de exponer la IP: la sala usa `haxlite.edge: { url, key }`
  y no abre puertos de jugadores (§3).

### 9.3 TURN, relay-only y firewall del host

* **TURN en haxlite-rtc** (RFC 8656, desde 0.3.0; pool de asignaciones desde 0.3.1): basta una
  entrada `turn:…?transport=udp` en `iceServers` (UDP y direcciones relayed IPv4 solamente;
  `turns:` y `?transport=tcp` se omiten). `iceTransportPolicy: 'relay'` oculta la IP real del host.
  Presupuesto por asignación `turnPeersPerAllocation` (8) y tope `maxTurnAllocations` (64):
  Cloudflare solo relaya ~10 direcciones de par distintas por asignación (docs/10 §2.2).
* **Credenciales de Cloudflare:** caducan; usa un TTL largo (p. ej. 24 h, máximo 48 h) y renuévalas
  a la mitad del plazo con `room.haxlite.setIceServers(lista)` (docs/10 §2.2 trae el ejemplo
  completo con `generate-ice-servers`). El **token de la API y el ID de la clave** de Cloudflare son
  secretos de tu aplicación (haxlite no los lee del entorno): guárdalos fuera del código.
* **Con node-datachannel** (`ndc`) el modo relay-only no es hermético (libjuice envía *checks*
  directos): cierra el hueco con `ops/haxguard/relay-only.nft` y `portRange` fijo (§7).
* Alcance de los problemas de la ruta Cloudflare (CGNAT, IPv6-only, rutas triangulares en LATAM):
  docs/ip/02.

### 9.4 Ajuste de runtime

| Ajuste | Aplica a | Efecto medido | Estado |
|---|---|---|---|
| `MIMALLOC_SCAVENGER=0` (variable de entorno) | Bun | −7–12 % CPU, mitad de despertares, ≈ +1 MB RSS | Medido el 16-10-2026 en la VM de pruebas; **no documentado en `docs/`**; validar con *soak* largo (§4.5) |
| `MALLOC_ARENA_MAX=2 node --v8-pool-size=1 --max-semi-space-size=1` | Node + node-datachannel | −7 MB de RSS (−8 %) sin coste de CPU medible | docs/07 §7.5 (medido con `ndc`) |
| `cipherSuites` DTLS por defecto `['chacha20','aes128gcm','aes256gcm']` | rtc | ChaCha20-Poly1305 en JS gana de extremo a extremo también en Bun (≈ 17 % menos CPU) | docs/10 §6.7. No hay que tocarlo |
| `tunnel.aead` / `edge.tunnelAead` `auto` | Edge y host | ChaCha20-Poly1305 en los dos runtimes | docs/09 §1.3 |
| Límites del sistema | todos | `LimitNOFILE` (systemd) / `ulimit -n`; búferes UDP (`net.core.rmem_max`, `wmem_max`) si el kernel recorta los 4 MiB que pide el socket del túnel | Recomendación general (no verificado en producción) |

### 9.5 Publicación del paquete

Flujo descrito por `publish.yml` y el encabezado del propio archivo:

```sh
# versión nueva en package.json, commit, y:
git tag v0.3.2 && git push origin main v0.3.2     # la etiqueta debe ser "v" + package.json.version
```

El flujo publica `@<propietario>/haxlite` en GitHub Packages. Un consumidor lo instala con un
alias para seguir usando `require('haxlite')`:

```json
{ "dependencies": { "haxlite": "npm:@<propietario>/haxlite@^0.3.0" } }
```

y un `~/.npmrc` con `@<propietario>:registry=https://npm.pkg.github.com` y un *token* clásico con
`read:packages` (`//npm.pkg.github.com/:_authToken=…`). Recuerda que `^0.1.0` **no** admite `0.2.x`
ni `0.3.x` (en versiones `0.y.z`, el `^` fija el `y`): para subir de minor hay que cambiar el alias.

---

## Apéndice A: inconsistencias detectadas entre documentos y código

Revisión del 18-10-2026 sobre el árbol de trabajo (`0.3.1`). Cada punto indica **dónde** está el
desajuste y **qué dice el código**. No se modificó ningún otro archivo.

**A. Edge y configuración**

1. `docs/09-haxlite-edge.md` §5 afirma que las variables de entorno «ganan» sobre el archivo.
   En `src/edge/config.ts` `HAXLITE_EDGE_KEYS` y `HAXLITE_EDGE_KEYS_FILE` se **suman** a las
   claves del archivo (y un `id` repetido es un error); solo el resto sobrescribe.
2. `docs/09` §5 y `src/edge/cli.ts` no avisan de que `--config` exige un valor separado (`--config=x`
   se ignora) ni de que el archivo es JSON estricto aunque `json5` sea dependencia.
3. `docs/09` §7 (comando de `edge-latency`) usa `--experimental-transform-types`, bandera que Node 26
   eliminó (así lo dicen `tsconfig.build.json` y `docs/07` §«Comandos exactos»); el encabezado de
   `scripts/edge-latency.ts` usa `--experimental-strip-types`.

**B. Banderas de Node obsoletas en otros documentos y scripts**

4. `--experimental-transform-types` aparece aún en: `docs/benchmark-hosts.md` («Comandos exactos»),
   `docs/07-benchmarks.md` (§2.5, «Pasada de ligereza — red» y «Comandos»), `docs/10-haxlite-rtc.md`
   (§5.2 y §6), `scripts/among-us-screenshots.ts`, `scripts/vision-mask-cost.ts` y
   `test/rtc-interop/manual-server.ts`. En Node 26 hay que usar `--import ./bench/ts-resolve.mjs`
   (transpila con oxc) sin esa bandera.

**C. Benchmarks**

5. `docs/benchmark-hosts.md` («Comandos exactos») describe `unified.sh` como 4 hosts, ≈ 1 h 45 y
   sin `--parallel 3`; el guion actual (`bench/net/unified.sh`) usa **5** hosts (con
   `haxlite:rtc@bun`), `--parallel 3` en `idle` y declara ≈ 1 h 35. `docs/07` §«Comparativa
   unificada» abre hablando de «las cuatro opciones» pero sus «Comandos exactos» ya mencionan
   `+ haxlite:rtc@bun`.
6. `docs/10` §6 dice `--out bench/results/rtc-backends.json`; los archivos del repositorio se llaman
   `rtc-backends-1.json` y `rtc-backends-2.json`.

**D. haxguard / ops**

7. `docs/ip/04-atribucion-y-gating.md` (§1.4 y «Archivos del experimento») cita
   `ipresearch/canary-counters.nft`, `canary-exp.mjs`, `attribution-demo.mjs`; el repositorio no
   tiene carpeta `ipresearch/` y el archivo real es `ops/haxguard/canary-counters.nft`, con tabla
   `ipresearch_test`.
8. `docs/09` §3.1 recomienda `ops/haxguard/haxguard.nft` para el puerto de jugadores del Edge, pero
    el archivo asume un *sidecar* que mantenga `active4/6` y `pending4/6`; ese sidecar no existe en
    el repositorio, así que tal cual **descarta el tráfico DTLS/SCTP de cualquier jugador** (solo
    pasa el STUN). Además su `ROOM_PORTS` por defecto es `20000-20999`, no el 40000 de docs/09.
    Su comentario de cabecera habla de `enableIceUdpMux` (1 puerto por sala), que no es el modelo
    del Edge con `rtc` (1 puerto para todos los jugadores).
9. `ops/haxguard/relay-only.nft` y `docs/08`/`docs/ip/02` §5.3 asumen `portRange` de node-datachannel;
    con `peerBackend: 'rtc'` el puerto es `rtc.port` y la política relay se aplica dentro del proceso
    (`directDropped`), por lo que el rango del archivo debe adaptarse (o no es necesario).

**E. haxlite-rtc y TURN**

10. `docs/10` §3 (tabla de opciones, fila `iceServers`) dice «Las entradas TURN se ignoran (§2.1)» y la
    «Recomendación» del mismo apartado afirma que «lo único que `ndc` puede y `rtc` no es usar un
    servidor TURN». Contradice §2.2 y §7 del mismo documento y `src/rtc/turn.ts`/`endpoint.ts`
    (TURN implementado desde 0.3.0).
11. La tabla de opciones de `docs/10` §3 no lista `iceTransportPolicy`, `turnPeersPerAllocation`
    (defecto 8) ni `maxTurnAllocations` (defecto 64), que existen en `src/rtc/endpoint.ts`.
12. `docs/ip/02-turn.md` §4 (una sola URL, «no incluir la de puerto 53», credenciales por función en
    `negotiate()`) y `docs/08` describen las limitaciones de libjuice/`ndc`; con `rtc` hay lista de
    servidores con *failover* al puerto 53, `setIceServers()` y relay-only dentro del proceso
    (docs/10 §2.2). Los documentos de `docs/ip/` no lo indican.

**F. Variables de entorno y ajuste**

13. `MIMALLOC_SCAVENGER=0` (recomendación medida para Bun) no aparece en ningún documento del
    repositorio; `docs/07` §7.5 recomienda en cambio `MALLOC_ARENA_MAX=2 node --v8-pool-size=1 …`,
    medido solo con node-datachannel.
14. Los ejemplos usan dos nombres para el token: `HAXBALL_TOKEN` (`basic-room`, `moderation`,
    `among-us-vision`) y `HX_TOKEN` (`live-room`). El README solo cita `HAXBALL_TOKEN`.
15. `test/replay/official-replay.ts` usa por defecto una ruta absoluta de la máquina del autor
    (`/tmp/claude-0/…/game-min.js`) para `HAXBALL_CLIENT_JS`; `src/replay/README.md` solo dice
    «o la copia de scratch».

**G. Otros**

16. `README.md` indica que el valor por defecto de `peerBackend` es `ndc`, y así es en el código
    (`src/net/transport.ts`); `docs/10` §3 propone cambiarlo a `rtc` (propuesta explícita, no
    aplicada). La producción (docs/07) ya usa `rtc`: quien despliegue desde cero debe fijar
    `peerBackend: 'rtc'`.
