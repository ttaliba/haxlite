# rev-eng-haxball

Investigación de cómo funciona HaxBall por dentro, a partir de dos librerías públicas:

- [`mertushka/haxball.js`](https://github.com/mertushka/haxball.js) (commit `e5231b0`): envuelve el **script oficial** del host headless (`headless-min.js`, hash de fuente `f066733d`) para ejecutarlo en Node.
- [`wxyz-abcd/node-haxball`](https://github.com/wxyz-abcd/node-haxball) (commit `4d4b88f`): **reimplementación completa** del cliente y del host, con tipos legibles en `index.d.ts`.

Todo sale de leer el código, que en ambos casos está minificado; no se capturó tráfico ni se crearon salas. La única excepción es la lista pública de salas, que se descargó y se parseó. Lo que no se pudo confirmar está marcado "(no verificado)" en cada documento.

## Documentos

| # | Documento | Contenido |
|---|-----------|-----------|
| 01 | [Red y salas](docs/01-red-y-salas.md) | Servidor maestro, lista de salas, señalización WebSocket, WebRTC, auth y versiones |
| 02 | [Protocolo binario](docs/02-protocolo-binario.md) | Streams, framing, tabla de eventos 0–26, snapshot inicial, estadios en binario y `.hbr2` |
| 03 | [Física y estadios](docs/03-fisica-y-estadios.md) | Bucle de juego, colisiones, jugador y chute, reglas, formato `.hbs` y mapas por defecto |
| 04 | [Netcode](docs/04-netcode-y-sincronizacion.md) | Lockstep, asignación de frames, predicción, ping, checksums y autoridad del host |
| 05 | [Librerías y APIs](docs/05-librerias-y-apis.md) | Arquitectura de haxball.js y node-haxball, API HBInit, ejemplos y glosario |

## HaxBall en una página

```
          HTTPS                                  WSS (señalización)
 cliente ───────► www.haxball.com/rs/api/*       p2p.haxball.com
   │              (list / geo / host / client)    ▲          ▲
   │                                              │ /client  │ /host?token=
   │        offer/answer/ICE (deflate) relayed    │          │
   └──────────────────────────────────────────────┘          │
                                                             │
 cliente ◄═══════ WebRTC DataChannels (ro/ru/uu) ═══════► HOST (autoridad)
 cliente ◄══════════════════════════════════════════════►   │
                     topología en estrella, sin TURN        │ 60 Hz lockstep
```

1. **No hay servidor de juego.** El servidor maestro (`www.haxball.com/rs/api`) solo publica la lista de salas y emite tokens y captchas. La señalización va por `wss://p2p.haxball.com`. La partida corre en el navegador (o en el headless) del **host**, que hace de autoridad y reenvía todo a los clientes por WebRTC: STUN de Google y sin TURN.
2. **Canales WebRTC:** `ro` (fiable y ordenado), `ru` (fiable, sin orden) y `uu` (no fiable). Los mensajes son binarios: big-endian, varints LEB128 y bloques grandes comprimidos con deflate raw. El protocolo es la **versión 9** y una versión distinta se rechaza (código de cierre 4103).
3. **Identidad:** cada jugador tiene un par de claves ECDSA P-256, y `auth` es la coordenada x de la pública en base64url. El host envía un reto de 8 bytes que el cliente firma. `conn` es la IP vista por el maestro codificada en hex: no es un hash.
4. **Netcode de lockstep determinista:** durante la partida solo viajan **eventos** (input de 5 bits, chat, acciones de admin). El host los sella con `(frame, orden)` y aplica un retardo de input de 2 frames. Cada peer simula la misma física a 60 Hz con paso fijo. El estado completo solo se envía una vez, comprimido, al entrar. Cada 600 frames el host manda un checksum (XOR) para detectar desincronización; no hay resincronización automática.
5. **Predicción:** el cliente copia el último estado confirmado y re-simula hasta 120 frames hacia delante. Para eso usa sus propios inputs aún no confirmados y supone que el resto mantiene su último input. No hay rollback del estado autoritativo.
6. **Física:** solo usa doubles y ningún número aleatorio. Cada tick mueve los discos (`pos += v; v = (v + gravedad)·damping`) y después resuelve colisiones disco–disco, plano, segmento (recto o curvo, con `bias`) y vértice, con `j = vn·(bCoefA·bCoefB + 1)`. Las joints se resuelven al final, 2 veces. El chute afecta a los discos a menos de 4 px de borde a borde.
7. **Reglas:** el juego tiene 4 fases (antes del saque, jugando, gol con 150 ticks y fin con 300 ticks). El empate al acabar el tiempo pasa a gol de oro. Un gol cuenta cuando el disco de puntuación cruza el segmento de gol dentro de un tick.
8. **Replays `.hbr2`:** empiezan con la marca `HBR2` y la versión 3. Guardan el estado inicial más los eventos con su frame (comprimidos), así que reproducir equivale a re-simular desde el inicio.

## Discrepancias y pendientes

- El host oficial usa un retardo de input de **2** frames (`Sb=2`) y node-haxball usa **4** (`ZW=4`); no se sabe por qué (doc 04).
- En `index.d.ts` de node-haxball, `GameState.timeElapsed` figura en milisegundos, pero el código lo usa en **segundos**. Además, `curveF` no es un ángulo (docs 03 y 05).
- Los ids de eventos 0–23 de node-haxball coinciden 1:1 con el orden de registro del script oficial. Los ids 24–26 son extensiones propias de node-haxball (doc 02).
- No se analizó en profundidad el cliente de navegador oficial (`game-min.js`); el análisis se centró en el script headless.
- Los nombres minificados cambian en cada build del script oficial. Las referencias de los documentos corresponden al hash `f066733d`.

## Aviso

Esto es documentación con fines educativos y de interoperabilidad. El script oficial es "© Mario Carbajal – All rights reserved". node-haxball incluye funciones que permiten abusar del juego (jugadores falsos, speedhack, etc.). El doc 05 comenta los riesgos.
