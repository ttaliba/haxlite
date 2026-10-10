# 03 — Motor de física, reglas de juego y estadios (.hbs)

> Documento de ingeniería inversa del simulador de HaxBall a partir de código público.
> Fuente primaria: el **script oficial del host headless** (Haxe minificado) empaquetado por
> `mertushka/haxball.js` en `src/generated/headless.ts` (cabecera `Haxball source hash: f066733d`).
> Fuente secundaria / contraste: la reimplementación `wxyz-abcd/node-haxball` (`src/api.js`
> minificado + `src/index.d.ts` con nombres legibles). Ambas implementan **exactamente la misma
> matemática** de física; donde difieren se indica.
>
> Convenciones: los fragmentos `entre comillas invertidas` con sintaxis minificada (sin espacios)
> son **grep-ables literalmente** en los ficheros originales (no en la copia formateada).
> Lo que no he podido confirmar en el código se marca **(no verificado)**.

---

## 0. Resumen rápido

| Aspecto | Valor | Evidencia |
|---|---|---|
| Frecuencia de simulación | **60 ticks/s** (0,06 ticks por ms) | `this.Be=.06` (headless.ts) |
| Paso de tiempo | **fijo, dt = 1 tick** (unidades: px/tick, px/tick²) | `this.Ca.Da(1)` |
| Integrador | Euler semi-explícito: `pos += v·dt; v = (v + g)·damping` | `e.x=f.x+g.x*a` en `class Oa` |
| Resolución de colisiones | 1 pasada secuencial (Gauss-Seidel) por tick, corrección de posición + impulso | `c.Cg(f)`, `c.Dg(f)` |
| Restitución | `e = bCoef_A · bCoef_B`, impulso con factor `(1+e)` | `g*=c.i*f.i+1` |
| Joints | 2 iteraciones por tick, después de colisiones | `for(a=0;2>a;)` |
| Alcance de chute | distancia entre bordes `< 4` unidades | `4>u-l.M-d.N.M` |
| Reloj de partido | `+1/60 s` por tick sólo en fase *Playing* | `this.Nb+=.016666666666666666` |
| Celebración de gol | 150 ticks (2,5 s) | `this.Cb=150` |
| Fin de partido | 300 ticks (5 s) | `this.Cb=300` |
| RNG en la simulación | **ninguno** | `Math.random` sólo en red (backoff y nonce) |
| Números | `double` IEEE-754 (JS `Number`); serialización `Float64` | `a.g(...)`/`a.s()` = (get/set)Float64 |

---

## 1. Mapa de nombres minificados → nombres legibles

Los nombres de la columna "headless" son los del script oficial (hash `f066733d`; **cambian entre
versiones**). Los nombres legibles provienen de `node-haxball/src/index.d.ts` (namespaces
`Impl.Stadium.*`, tipos `MovableDisc`, `PlayerPhysics`, `GameState`, `World`, `Player`) y de la
API oficial (`getDiscProperties`, `getScores`) que el propio script expone (ver §1.1).

### 1.1 Clases

| headless | Legible | Notas |
|---|---|---|
| `I` | `Point` {x,y} | |
| `X` | `Disc` (disco del estadio, plantilla) | defaults: radio 10, invMass 1, damping 0.99, bCoef 0.5, cMask=cGroup=63 |
| `Ba` | `MovableDisc` (disco vivo en el mundo) | contiene `Cg` (disco–disco) y `Dg` (disco–segmento) |
| `C` | `Vertex` | |
| `E` | `Segment` | `bb()` = aplicar `curve`, `Pb()` = precalcular normal/arco |
| `K` | `Plane` | |
| `xa` | `Goal` | |
| `Ha` | `Joint` | `Da()` = resolver joint |
| `Qa` | `PlayerPhysics` | |
| `w` | `Stadium` | `kh()` = parsear .hbs (JSON5), `Fd()` = estadios por defecto, `Ag()` = test de gol |
| `Oa` | `World` / `physicsState` | `Da(dt)` = paso físico |
| `Q` | `GameState` | `Da(dt)` = tick de juego, `bf()` = reset de posiciones, `af()` = crear disco de jugador, `Jf()` = fin |
| `Ta` | `RoomState` | `ei()` = startGame, `Ic()` = cambiar de equipo, `ai()` = kick-rate, `Ve()` = checksum |
| `Ka` | `Player` | |
| `v` | `Team` (`v.oa` spec, `v.fa` red, `v.ta` blue) | |
| `Ma`/`Wa` | bucle de frames (`rg`) / host de red | |
| `Da` (acción) | `SendInputEvent` | |

### 1.2 Campos

| Objeto | headless → legible |
|---|---|
| Disc (`X`,`Ba`) | `a`=pos, `u`=speed, `ma`=gravity, `M`=radius, `i`=bCoef, `L`=invMass, `ga`=damping, `T`=color, `c`=cMask, `o`=cGroup |
| Vertex (`C`) | `a`=pos, `i`=bCoef, `c`=cMask, `o`=cGroup, `Lc`=id |
| Segment (`E`) | `F`=v0, `K`=v1, `wb`=bias, `i`=bCoef, `Ia`=curveF, `va`=vis, `T`=color, `c`/`o`; precalculados: `X`=normal, `fc`=arcCenter, `Pe`=arcRadius, `kd`=v0Normal, `ld`=v1Normal |
| Plane (`K`) | `X`=normal, `la`=dist, `i`=bCoef, `c`/`o` |
| Goal (`xa`) | `F`=p0, `K`=p1, `sc`=team |
| Joint (`Ha`) | `Jc`=d0, `Kc`=d1, `La`=minLength, `Va`=maxLength, `rc`=strength, `T`=color |
| PlayerPhysics (`Qa`) | `i`=bCoef, `L`=invMass, `ga`=damping, `Ac`=acceleration, `Pc`=kickingAcceleration, `Qc`=kickingDamping, `Nc`=kickStrength, `ma`=gravity, `o`=cGroup, `M`=radius, `Oc`=kickback |
| Stadium (`w`) | `v`=vertexes, `J`=segments, `Y`=planes, `Sa`=goals, `A`=discs, `Ta`=joints, `Rb`/`Lb`=red/blueSpawnPoints, `Ob`=playerPhysics, `Ed`=defaultStadiumId (255=custom), `pa`=name, `dc`=width, `Hc`=height, `Pd`=maxViewWidth, `Ad`=cameraFollow, `Ma`=spawnDistance, `Bd`=canBeStored, `ed`=fullKickOffReset, `Fc`=bg.type, `Gc`/`Ec`=bg.width/height, `cc`=bg.kickOffRadius, `bc`=bg.cornerRadius, `Dc`=bg.color, `yd`=bg.goalLine |
| GameState (`Q`) | `ia`=physicsState, `$a`=state (fase), `Cb`=goalTickCounter, `Bb`=redScore, `xb`=blueScore, `Nb`=timeElapsed (segundos), `Xa`=pauseGameTickCounter, `Md`=goalConcedingTeam (= equipo que saca), `ab`=scoreLimit, `Na`=timeLimit (min), `ea`=stadium |
| Player (`Ka`) | `ja`=team, `N`=disc, `kb`=input, `Fb`=isKicking, `vc`=kickRateMinTickCounter, `Xb`=kickRateMaxTickCounter, `na`=id, `pa`=name, `Eb`=admin, `Hb`=índice de spawn |
| Team (`v`) | `P`=id (0/1/2), `T`=color, `Re`=lado (−1 rojo, +1 azul, 0 spec), `ih`=flag KO (8 rojo, 16 azul), `o`=cGroup (2 rojo, 4 azul), `$c`=equipo rival |
| RoomState (`Ta`) | `D`=gameState (null si no hay partido), `ba`=players, `ea`=stadium, `Yc`=kickRate min, `hc`=kickRate rate, `Od`=kickRate max (= rate·burst), `ab`, `Na`, `nd`=teamsLocked |

Confirmación directa en el script oficial (función `d(h)` de la API headless):
`x:h.a.x,y:h.a.y,xspeed:h.u.x,yspeed:h.u.y,xgravity:h.ma.x,ygravity:h.ma.y,radius:h.M,bCoeff:h.i,invMass:h.L,damping:h.ga,color:h.T,cMask:h.c,cGroup:h.o`
y `getScores`: `red:y.D.Bb,blue:y.D.xb,time:y.D.Nb,scoreLimit:y.D.ab,timeLimit:60*y.D.Na`.

En node-haxball el mismo mapeo se declara con `CM(clase, [], [nombres...])`/`EWG.R(...)` en
`api.js` (p. ej. `CM(bM,[],["cGroup","cMask","damping","invMass","bCoef","radius","gravity","speed","pos",...])`
— ahí `f`=cGroup, `k`=cMask, `m`=damping, `b`=invMass, `P`=bCoef, `z`=radius, `_`=gravity, `A`=speed, `h`=pos).

---

## 2. Bucle de juego

### 2.1 Frecuencia y paso fijo

* El host calcula cuántos frames "debería" haber simulado desde que arrancó:
  `frames = floor((performance.now() - t0) * 0.06) - frameActual` y ejecuta los que falten
  (`this.Be=.06`, método `Wa.Da`). 0,06 frames/ms = **60 Hz**.
* El host headless invoca ese "catch-up" cada 50 ms (`D.Da()},50)`) y también cada vez que llega
  un mensaje de un cliente (`Jh` llama a `this.Da()` antes de procesar). Por tanto suele avanzar
  ~3 ticks por lote, pero siempre con **dt = 1**: `Ma.rg` hace, por cada frame,
  "aplicar acciones programadas para este frame → `this.Ca.Da(1)` → `this.da++`".
* node-haxball usa los mismos valores (`this.xE=.06`, `this.bk=16.666666666666668` ms/frame).
  Para render, el cliente **extrapola** clonando el estado y simulando hacia delante con un paso
  fraccional (`W.nM($!=h?1:M-f)`), con tope de 120 frames; el paso fraccional sólo escala la
  integración de posición (el damping/gravedad se aplican completos), por eso sólo vale para
  dibujar, no para el estado autoritativo.
* Las acciones (inputs, pausa, cambios de equipo…) llevan número de frame (`eb`) y orden dentro
  del frame (`fb`); se aplican **antes** del paso de ese frame. Los inputs (`SendInput`) y la
  pausa tienen `delay` (se programan `Sb=2` frames en el futuro en el host). Los detalles de red
  quedan fuera de este documento.

### 2.2 Orden de operaciones de un tick (`Q.Da`)

1. **Pausa**: si `pauseGameTickCounter > 0` no se simula nada; si es `<120` se decrementa
   (`120>this.Xa&&this.Xa--`). Pausar pone 120; despausar pone 119 → la reanudación tarda
   119 ticks (~2 s) (`this.xc?b.Xa=120:120==b.Xa&&(b.Xa=119)`).
2. Callback `onGameTick`.
3. **Por cada jugador con disco (en orden de la lista de jugadores)**: chute (si procede) y
   aceleración por teclas (§5).
4. Guardar la posición previa de cada disco con flag `score` (`Q.Se[c]=f`, arrays de 256).
5. **Paso físico del mundo** `World.Da(1)` (§4): integrar todos los discos → colisiones →
   joints ×2.
6. **Máquina de estados** (§6): kickoff / juego / gol / fin.

### 2.3 Pseudocódigo del tick completo

```text
function gameTick(G):                       # Q.Da(1)
  if G.pauseCounter > 0:
      if G.pauseCounter < 120: G.pauseCounter -= 1
      return
  room.onGameTick()
  pp = G.stadium.playerPhysics
  for P in room.players:                    # orden de la lista (reorderPlayers lo cambia)
      D = P.disc; if D == null: continue
      if (P.input & KICK) == 0: P.isKicking = false
      if P.kickCooldown > 0: P.kickCooldown -= 1               # vc
      if P.kickTokens < room.kickRateMax: P.kickTokens += 1     # Xb (máx = rate*burst)
      if P.isKicking and P.kickCooldown <= 0 and P.kickTokens >= 0:
          kicked = false
          for B in world.discs:
              if (B.cGroup & KICK) and B != D:
                  d = B.pos - D.pos; dist = |d|
                  if dist - B.radius - D.radius < 4:
                      n = d / dist
                      B.speed += n * pp.kickStrength * B.invMass
                      D.speed += n * (-pp.kickback) * D.invMass
                      kicked = true                       # ¡no hay break: chuta todos!
          if kicked:
              room.onPlayerBallKick(P)
              P.isKicking = false
              P.kickCooldown = room.kickRateMin
              P.kickTokens  -= room.kickRateRate
      dx = (P.input&RIGHT?1:0) - (P.input&LEFT?1:0)
      dy = (P.input&DOWN ?1:0) - (P.input&UP  ?1:0)
      if dx != 0 and dy != 0: dx /= √2; dy /= √2
      acc = P.isKicking ? pp.kickingAcceleration : pp.acceleration
      D.speed += (dx, dy) * acc
      D.damping = P.isKicking ? pp.kickingDamping : pp.damping

  prev = [(i, disc.pos) for i, disc in world.discs if disc.cGroup & SCORE]
  world.step(1)                                             # §4

  switch G.state:
    case 0 (BeforeKickOff):
      for P with disc: P.disc.cMask = 39 | G.kickoffTeam.koFlag   # 39 = ball|red|blue|wall
      if |world.discs[0].speed|² > 0: G.state = 1
    case 1 (Playing):
      G.time += 1/60
      for P with disc: P.disc.cMask = 39
      team = NONE
      for (i, p0) in prev:                                  # en orden de índice de disco
          team = stadium.goalCrossed(p0, world.discs[i].pos); if team != NONE: break
      if team != NONE:                                      # team = dueño de la portería
          G.state = 2; G.goalTicks = 150; G.kickoffTeam = team
          if team == RED: G.blueScore++ else G.redScore++
          onTeamGoal(team.rival)
      elif G.timeLimit > 0 and G.time >= 60*G.timeLimit and G.red != G.blue:
          endGame()
    case 2 (AfterGoal):
      G.goalTicks -= 1
      if G.goalTicks <= 0:
          if (G.scoreLimit > 0 and (G.red >= G.scoreLimit or G.blue >= G.scoreLimit))
             or (G.timeLimit > 0 and G.time >= 60*G.timeLimit and G.red != G.blue):
              endGame()
          else:
              resetPositions(); onPositionsReset()
    case 3 (Ending):
      G.goalTicks -= 1
      if G.goalTicks <= 0: room.gameState = null; all players.disc = null; onGameStop(null)

function endGame():                               # Q.Jf
  G.goalTicks = 300; G.state = 3
  onTeamVictory(G.red > G.blue ? RED : BLUE)
```

---

## 3. Objetos físicos

### 3.1 Disc (`X` plantilla de estadio / `Ba` disco vivo)

| Campo | Significado | Default disco `.hbs` | Default balón (`Vc()`) |
|---|---|---|---|
| `pos` | posición (px) | `[0,0]` | `[0,0]` |
| `speed` | velocidad (px/tick) | `[0,0]` | `[0,0]` |
| `gravity` | aceleración constante sumada cada tick (px/tick²) | `[0,0]` | `[0,0]` |
| `radius` | radio | 10 | 10 |
| `invMass` | 1/masa; **0 = inamovible/estático** | 1 | 1 |
| `damping` | factor multiplicativo de velocidad por tick | 0.99 | 0.99 |
| `bCoef` | coef. de rebote | 0.5 | 0.5 |
| `cMask` | con qué grupos colisiona | 63 (`all`) | 63 |
| `cGroup` | a qué grupos pertenece | 63 (`all`) | **193** = ball\|kick\|score |
| `color` | | `FFFFFF` | `FFFFFF` |

* El disco 0 del mundo es **siempre el balón** (el kickoff mira `world.discs[0]` y la API
  `getBallPosition` también).
* Orden en el mundo: discos del estadio (balón primero) y después los de los jugadores, en el
  orden en que se crearon (al iniciar el partido, por orden de la lista de jugadores; un jugador
  que entra a mitad se añade al final).
* Los discos con `invMass == 0` **no colisionan contra la geometría estática** (planos,
  segmentos, vértices): `if(0!=c.L){...}` en `World.Da`. Sí participan en disco–disco (como masa
  infinita).

### 3.2 Vertex (`C`)
Punto estático. Defaults: `bCoef 1`, `cMask 63`, `cGroup 32` (`wall`). Colisiona como un
"disco de radio 0" fijo (§4.6). Los vértices son también los extremos de los segmentos: el
segmento recto **no** gestiona sus extremos; son los vértices los que hacen "redondeadas" las
puntas (si sus flags lo permiten).

### 3.3 Segment (`E`)
Une `v0`→`v1`. Defaults: `bCoef 1`, `cMask 63`, `cGroup 32`, `bias 0`, `vis true`,
`color 000000`, recto (`curveF = Infinity`).

* **Curva**: `curve` en grados. `E.bb(curve)`:
  ```text
  θ = curve·π/180
  if θ < 0: θ = -θ; swap(v0, v1); bias = -bias
  if 10° < θ < 340°: curveF = 1 / tan(θ/2)     # E.jg=.17435839227423353 (≈10°), E.ig=5.934119456780721 (≈340°)
  else: curveF = Infinity (recto)
  ```
  `curveF` (en `.hbs`) es por tanto **cot(θ/2)** — no un ángulo en radianes como afirma el
  comentario de `index.d.ts` (`"The curving angle of this Segment. (in radians)"` es inexacto);
  node-haxball lo invierte con `114.59155902616465*Math.atan(1/this.zM)` = 2·atan(1/curveF) en grados.
* **Precálculo** `E.Pb()`:
  * Recto: `normal = normalize(v1.y - v0.y, v0.x - v1.x)` (el vector `v1−v0` girado −90°).
  * Curvo: `h = (v1 − v0)/2`; `centro = v0 + h + (−h.y, h.x)·curveF`; `R = |v0 − centro|`;
    `v0Normal = perp(v0 − centro) = (−(v0.y−c.y), v0.x−c.x)`; `v1Normal = (−(c.y−v1.y), c.x−v1.x)`;
    si `curveF ≤ 0` (arco > 180°) ambos se niegan.
* `bias` (grosor / unidireccional): ver §4.5.

### 3.4 Plane (`K`)
Recta infinita `normal·p = dist`; los discos quedan en el semiplano `normal·p ≥ dist + radio`.
La normal se normaliza al parsear. Defaults `bCoef 1`, `cMask 63`, `cGroup 32`.

### 3.5 Joint (`Ha`)
Une discos `d0` y `d1` (índices en `discs` **incluyendo** el balón en 0 si no se usa `disc0`).

* `length`: `null` → distancia inicial entre los discos (o 100 si alguno no existe);
  número → min = max = valor; `[min,max]` → rango libre.
* `strength`: `"rigid"` o ausente → `Infinity` (rígido); número → muelle.
  (`null==g||"rigid"==g?1/0`)
* `color` default `000000`.

### 3.6 Goal (`xa`)
Segmento `p0`–`p1` con `team` ∈ {`red`,`blue`} = **equipo dueño** (el que defiende). Si un disco
con flag `score` lo cruza, marca **el equipo contrario**. No tiene física (no colisiona).

### 3.7 PlayerPhysics (`Qa`) — defaults

| Campo | Default | Uso |
|---|---|---|
| `radius` | 15 | |
| `invMass` | 0.5 | |
| `bCoef` | 0.5 | |
| `damping` | 0.96 | |
| `acceleration` | 0.1 | px/tick² por tecla |
| `kickingAcceleration` | 0.07 | mientras `isKicking` |
| `kickingDamping` | 0.96 | mientras `isKicking` |
| `kickStrength` | 5 | Δv del balón = 5·invMass_balón |
| `kickback` | 0 | retroceso del jugador |
| `gravity` | [0,0] | |
| `cGroup` | 0 (se le OR-ea el del equipo) | |

(Constructor `class Qa{constructor(){this.Oc=0;this.M=15;this.o=0;...this.L=this.i=.5;this.ga=.96;this.Ac=.1;this.Pc=.07;this.Qc=.96;this.Nc=5}`.)

El disco de jugador se crea en `Q.af`: `radius/invMass/damping/bCoef/gravity` de playerPhysics,
`cMask = 39` (`b.c=39`), `cGroup = team.cGroup | playerPhysics.cGroup` (rojo 2, azul 4),
velocidad 0, color 0.

---

## 4. Paso físico y colisiones (`World.Da(dt)`, `class Oa`)

### 4.1 Filtro de colisión

Dos objetos A y B colisionan sólo si
`(A.cMask & B.cGroup) != 0 && (A.cGroup & B.cMask) != 0`
(`0!=(f.c&c.o)&&0!=(f.o&c.c)`). Es decir, **ambos** deben "aceptar" al otro.

Flags (`w.Ua` en el parser y `CollisionFlags` en la API):

| Flag | Valor | Uso típico |
|---|---|---|
| `ball` | 1 | balón |
| `red` | 2 | jugadores rojos |
| `blue` | 4 | jugadores azules |
| `redKO` | 8 | barrera de kickoff activa cuando saca el rojo |
| `blueKO` | 16 | idem azul |
| `wall` | 32 | paredes (default de vértices, segmentos, planos) |
| `kick` | 64 | el objeto es chutable |
| `score` | 128 | el objeto marca gol al cruzar una portería |
| `c0..c3` | 1<<28 … 1<<31 (`c3` = −2147483648) | libres |
| `all` | 63 | ball\|red\|blue\|redKO\|blueKO\|wall (¡no incluye kick/score/c0-3!) |

### 4.2 Pseudocódigo del paso físico

```text
function worldStep(dt):                     # Oa.Da ; dt = 1 en la simulación real
  for D in discs:                           # 1) integración
      D.pos   += D.speed * dt
      D.speed  = (D.speed + D.gravity) * D.damping
  for i in 0..n-1:                          # 2) colisiones, una sola pasada
      A = discs[i]
      for j in i+1..n-1:  if mask(A, discs[j]): discDisc(A, discs[j])
      if A.invMass != 0:
          for P in planes:   if mask(A,P): discPlane(A,P)
          for S in segments: if mask(A,S): discSegment(A,S)
          for V in vertices: if mask(A,V): discVertex(A,V)
  repeat 2 times:                           # 3) joints
      for J in joints: J.solve(discs)
```

Notas:
* La velocidad usada para mover en el tick es la de *antes* de aplicar damping; el damping se
  aplica después (`e.x=f.x+g.x*a;...e.x=(f.x+g.x)*d`).
* No hay detección continua (CCD): sólo solapamiento al final del movimiento. Los segmentos con
  `bias` existen precisamente para evitar "tunneling" de discos pequeños y rápidos (wiki).
* Al ser una sola pasada secuencial, el **orden de los arrays** afecta al resultado.

### 4.3 Disco–disco (`Ba.Cg`)

```text
d = A.pos - B.pos; dist² = d·d; R = A.radius + B.radius
if 0 < dist² <= R²:
    dist = sqrt(dist²); n = d / dist
    r = A.invMass / (A.invMass + B.invMass)          # fracción que corrige A
    overlap = R - dist
    A.pos += n * overlap * r
    B.pos -= n * overlap * (1 - r)
    vn = n · (A.speed - B.speed)
    if vn < 0:                                         # sólo si se acercan
        j = vn * (A.bCoef * B.bCoef + 1)
        A.speed -= n * j * r
        B.speed += n * j * (1 - r)
```

Es el impulso clásico `J = −(1+e)·vₙ / (1/mA + 1/mB)` con `e = bCoefA·bCoefB`, aplicado como
`Δv_A = J·invMass_A·n`. Ejemplo: jugador (0.5) vs balón (0.5) ⇒ `e = 0.25`; masas: jugador
invMass 0.5 (m=2), balón invMass 1 (m=1) ⇒ `r_jugador = 0.5/1.5 = 1/3`.
**Caso borde (no verificado en ejecución)**: si ambos `invMass` son 0 y se solapan con máscaras
compatibles, `r = 0/0 = NaN` (en joints sí hay guarda `d!=d&&(d=.5)`, aquí no).

### 4.4 Disco–plano

```text
g = P.dist - (P.normal · A.pos) + A.radius            # penetración
if g > 0:
    A.pos += P.normal * g
    vn = A.speed · P.normal
    if vn < 0: A.speed -= P.normal * vn * (A.bCoef * P.bCoef + 1)
```

### 4.5 Disco–segmento (`Ba.Dg`), recto, curvo y `bias`

```text
if S.curveF == ±Infinity:                              # RECTO  (0!=0*a.Ia)
    e = S.v1 - S.v0
    if (A.pos - S.v0)·e <= 0 or (A.pos - S.v1)·e >= 0: return   # fuera de la "banda" del segmento
    n = S.normal
    g = n · (A.pos - S.v1)                              # distancia con signo
else:                                                  # CURVO
    r = A.pos - S.arcCenter
    inSector = (S.v0Normal·r > 0 and S.v1Normal·r > 0)
    if inSector == (S.curveF <= 0): return              # fuera del sector angular del arco
    dist = |r|; if dist == 0: return
    g = dist - S.arcRadius                              # >0 fuera del círculo
    n = r / dist
# --- bias ---
b = S.bias
if b == 0:
    if g < 0: g = -g; n = -n                            # colisiona por ambas caras
else:
    if b < 0: b = -b; g = -g; n = -n                    # cara "frontal" invertida
    if g < -b: return                                   # más allá del grosor por detrás: se ignora
if g >= A.radius: return
A.pos += n * (A.radius - g)
vn = A.speed · n
if vn < 0: A.speed -= n * vn * (A.bCoef * S.bCoef + 1)
```

Interpretación de `bias` (coincide con la wiki): con `bias=0` el segmento es "fino" y
bidireccional; con `bias≠0` es **unidireccional** (sólo empuja hacia la cara de la normal, o la
opuesta si `bias<0`) y tiene **grosor |bias|**: un disco cuyo centro esté detrás de la línea
hasta `|bias|` unidades es devuelto a la cara frontal; más allá se ignora.

### 4.6 Disco–vértice

```text
d = A.pos - V.pos; dist² = d·d
if 0 < dist² <= A.radius²:
    dist = sqrt(dist²); n = d / dist
    A.pos += n * (A.radius - dist)
    vn = n · A.speed
    if vn < 0: A.speed -= n * vn * (A.bCoef * V.bCoef + 1)
```

### 4.7 Joints (`Ha.Da`)

```text
P0 = discs[d0]; P1 = discs[d1]; if missing: return
dvec = P0.pos - P1.pos; dist = |dvec|; if dist <= 0: return
n = dvec / dist
r = P0.invMass / (P0.invMass + P1.invMass); if r is NaN: r = 0.5
if min >= max:        target = min; k = 0          # longitud fija
elif dist <= min:     target = min; k = 1          # demasiado corto
elif dist >= max:     target = max; k = -1         # demasiado largo
else: return                                       # dentro del rango: no hace nada
err = target - dist
if strength finito (muelle):
    s = strength * err * 0.5
    P0.speed += n * s * P0.invMass
    P1.speed -= n * s * P1.invMass
else (rígido):
    P0.pos += n * err * r * 0.5
    P1.pos -= n * err * (1 - r) * 0.5
    vrel = n · (P0.speed - P1.speed)
    if vrel * k <= 0:                               # elimina la velocidad relativa que viola la restricción
        P0.speed -= n * vrel * r
        P1.speed += n * vrel * (1 - r)
```

Se ejecuta **dos veces** por tick sobre todos los joints, después de las colisiones; cada
iteración corrige la mitad del error de posición (rígido) — no es una restricción exacta.

---

## 5. Movimiento del jugador, input y chute

### 5.1 Input
Bitmask de 5 bits (`InputFlags: {up:1,down:2,left:4,right:8,kick:16}` en el headless):

| Bit | Tecla | Efecto |
|---|---|---|
| 1 | up | `dy -= 1` (la Y crece hacia **abajo**) |
| 2 | down | `dy += 1` |
| 4 | left | `dx -= 1` |
| 8 | right | `dx += 1` |
| 16 | kick | flanco de subida ⇒ `isKicking = true` |

La acción `SendInput` (`class Da`): `0==(b.kb&16)&&0!=(d&16)&&(b.Fb=!0);b.kb=d`. Es decir,
`isKicking` sólo se activa al **pulsar** kick (transición 0→1); cada tick, si el bit no está
pulsado, se desactiva; y tras un chute efectivo se pone a `false` aunque se mantenga pulsado
(hay que soltar y volver a pulsar).

### 5.2 Aceleración
`speed += dir · (isKicking ? kickingAcceleration : acceleration)`, con `dir` normalizado en
diagonal (`g/=f,k/=f` con `f=Math.sqrt(g*g+k*k)`; node-haxball: `cG=1/Math.SQRT2`).
`damping` del disco = `isKicking ? kickingDamping : damping` (`d.N.ga=d.Fb?e.Qc:e.ga`).

Velocidades terminales derivadas (`v* = a·d/(1−d)`) con la física por defecto:
* andando: 0.1·0.96/0.04 = **2.4 px/tick ≈ 144 px/s**;
* con kick pulsado: 0.07·0.96/0.04 = **1.68 px/tick ≈ 101 px/s**.

### 5.3 Chute
* Condiciones: `isKicking && kickRateMinTickCounter <= 0 && kickRateMaxTickCounter >= 0`.
* Afecta a **todos** los discos con flag `kick` (≠ el propio) cuyo hueco borde-a-borde sea
  `< 4` px (`4>u-l.M-d.N.M`; node-haxball `i-E.z-M.z>=4`).
* Dirección = centro del jugador → centro del disco (no depende de hacia dónde se mueve).
* `disc.speed += n·kickStrength·disc.invMass`; `player.speed += n·(−kickback)·player.invMass`.
  Con defaults el balón recibe **+5 px/tick** (300 px/s) sumado a su velocidad; sin más
  colisiones recorrería ≈ 5/(1−0.99) = 500 px.
* Se evalúa con las posiciones del final del tick anterior, antes de la aceleración por teclas y
  antes de la integración.

### 5.4 Kick rate limit (`Ta.ai`, acción `SetKickRateLimit`)
`setKickRateLimit(min=2, rate=0, burst=0)` (defaults de la API; el estado inicial de la sala es
`Yc=2, hc=0, Od=1`):
* `min` (0–255): tras chutar, `kickRateMinTickCounter = min` y decrece 1/tick ⇒ mínimo de ticks
  entre chutes.
* `rate` (0–255) y `burst` (0–100): cubeta de fichas `kickRateMaxTickCounter` que crece 1/tick hasta
  `rate·burst`; cada chute resta `rate`; se exige `≥ 0` ⇒ media de un chute cada `rate` ticks
  con hasta `burst` chutes acumulados.

---

## 6. Reglas de juego (máquina de estados de `GameState`)

### 6.1 Fases (`GamePlayState`)

| `$a` | Nombre (index.d.ts) | Qué ocurre |
|---|---|---|
| 0 | `BeforeKickOff` | jugadores con `cMask = 39 | KO(equipoQueSaca)`; reloj parado; pasa a 1 en cuanto `|balón.speed|>0` |
| 1 | `Playing` | `cMask = 39`; reloj `+1/60`; detección de gol; fin por tiempo si no hay empate |
| 2 | `AfterGoal` | 150 ticks (física sigue, sin goles ni reloj); luego fin o reset |
| 3 | `Ending` | 300 ticks; luego se destruye el partido (`onGameStop(null)`) |

### 6.2 Kickoff y barreras
* `goalConcedingTeam` (`Md`) empieza en **rojo** ⇒ el rojo saca primero. Tras un gol pasa a ser
  el **dueño de la portería** (= el que encajó) ⇒ **saca el que recibe el gol**.
* En fase 0, todos los jugadores (de ambos equipos) reciben `cMask |= KO` del equipo que saca
  (`39|this.Md.ih`; rojo→`redKO`=8, azul→`blueKO`=16). En los estadios por defecto la barrera
  central (`w.hf`) son dos segmentos verticales con `cGroup redKO|blueKO` y `cMask red|blue` y dos
  semicírculos de radio `kickOffRadius`, uno con `cGroup redKO` y el otro con `blueKO`, curvados
  hacia lados opuestos. Así un único semicírculo deja entrar al círculo central sólo al equipo que
  saca y mantiene fuera al rival.
* La transición a fase 1 la provoca **cualquier** velocidad no nula del disco 0 (chute,
  empujón, gravedad del balón…).

### 6.3 Detección de gol (`Stadium.Ag`)
Para cada disco con flag `score` (en orden de índice) se toma el segmento
`posAntes → posDespués` del tick y se comprueba si **cruza estrictamente** el segmento de alguna
portería (test de orientación con productos cruzados en ambos sentidos). La primera portería
cruzada determina el gol. El test **no depende de la dirección** del cruce (no verificado si en
la práctica se puede marcar "desde dentro de la red"). Sólo se comprueba en fase 1.
Si la portería es roja ⇒ `blueScore++`, si es azul ⇒ `redScore++`; `onTeamGoal(rival)`.

### 6.4 Tiempo, límite de goles, prórroga
* `timeLimit` en minutos (0 = sin límite, rango 0–99), `scoreLimit` (0 = sin límite, 0–99); sólo
  modificables sin partido en curso (`a.Aa(this.B)&&null==a.D`). Defaults de la sala: 3 y 3.
* `timeElapsed` está en **segundos** (`+= 1/60` por tick); el comentario de index.d.ts
  "in miliseconds" es incorrecto.
* Fin por tiempo: en fase 1, si `time >= 60·timeLimit` **y el marcador no está empatado** ⇒
  `Ending`. Si está empatado el partido sigue: **prórroga con gol de oro** (el siguiente gol, al
  terminar los 150 ticks de celebración, cumple `time>=límite && red!=blue` ⇒ fin).
* Fin por goles: se comprueba sólo al terminar la fase 2 (`red>=scoreLimit || blue>=scoreLimit`).
* Ganador: `red > blue ? red : blue`.

### 6.5 Reset de posiciones (`Q.bf`) y spawn
1. `state = 0`.
2. Copiar del estadio al mundo **sólo el disco 0 (balón)**, o **todos** los discos del estadio si
   `kickOffReset: "full"` (`this.ed?b.length:1`). Se restauran todas sus propiedades (incluso las
   cambiadas con `setDiscProperties`).
3. Para cada jugador (en orden de lista) se (re)crea su disco (`af`): velocidad 0, propiedades de
   `playerPhysics`, `cMask 39`. Posición:
   * sin spawn points del equipo: `x = spawnDistance · lado` (rojo −1, azul +1),
     `y = 55·l`, con `l = (k+1)>>1` y signo negativo si `k` es par, donde `k` = nº de jugadores ya
     colocados en ese equipo ⇒ y = 0, +55, −55, +110, −110, …;
   * con spawn points: el `k`-ésimo (si se acaban, el último).
4. Jugador que entra a un equipo **con el partido en curso** (`Ta.Ic` → `af`): último spawn point
   del equipo, o si no hay, `x = lado·width` (borde de la cámara, p. ej. ±420 en Classic), `y = 0`.

### 6.6 Inicio / parada / equipos
* `startGame` (`Ta.ei`): crea `GameState`, copia referencias a la geometría estática del
  estadio (vértices, segmentos, planos, joints) y **clona** los discos; llama a `bf()`.
* `stopGame`: destruye el `GameState` y los discos de jugador.
* `AutoTeams` (`class Ea`): si rojos == azules, manda los dos primeros espectadores a rojo y azul;
  si no, el primer espectador al equipo con menos jugadores.
* Cambiar de equipo con partido en marcha borra el disco antiguo del mundo y añade uno nuevo al final.
* Cambiar estadio, límites, etc. sólo sin partido en curso.

---

## 7. Formato de estadio `.hbs`

JSON5 parseado por `Stadium.kh`. Campos de nivel superior:

| Campo | Tipo | Default / comportamiento (código) |
|---|---|---|
| `name` | string | obligatorio |
| `width`, `height` | float | obligatorios; rectángulo de cámara. También posición de entrada a mitad de partido |
| `maxViewWidth` | float | 0 (desactivado) |
| `cameraFollow` | `"player"` / `"ball"` | `"ball"` (sólo `"player"` cambia algo: `Ad=1`) |
| `spawnDistance` | float | **200** en custom (`this.Ma=200`) |
| `canBeStored` | bool | true |
| `kickOffReset` | `"full"`/`"partial"` | partial (sólo `"full"` activa el reset total) |
| `bg` | objeto | `type` ∈ grass/hockey/(otro=none), `width`, `height`, `kickOffRadius`, `cornerRadius`, `goalLine` (default 0), `color` (default `718C5A` = 7441498) |
| `traits` | mapa nombre→props | se aplican al parsear: copia cada clave del trait **sólo si el objeto no la define** (`null==a[e]&&(a[e]=b[e])`); no se transmiten |
| `vertexes` | `[{x,y,bCoef,cMask,cGroup,trait}]` | |
| `segments` | `[{v0,v1,bCoef,curve,curveF,bias,cMask,cGroup,vis,color,trait}]` | `curveF` tiene prioridad sobre `curve` |
| `goals` | `[{p0,p1,team,trait}]` | `team` debe ser `red`/`blue` (si no: "Bad team value") |
| `discs` | `[{pos,speed,gravity,radius,invMass,damping,color,bCoef,cMask,cGroup,trait}]` | se añaden **después** del balón |
| `planes` | `[{normal,dist,bCoef,cMask,cGroup,trait}]` | normal normalizada |
| `joints` | `[{d0,d1,length,strength,color,trait}]` | opcional; índices validados |
| `redSpawnPoints`, `blueSpawnPoints` | `[[x,y],...]` | opcional, `[]` |
| `playerPhysics` | objeto (§3.7) | omitido ⇒ defaults |
| `ballPhysics` | objeto disco o `"disc0"` | omitido ⇒ balón por defecto; objeto ⇒ se parte del balón por defecto y se fuerza `cGroup |= kick|score` (`a.o|=192`); `"disc0"` ⇒ no se crea balón, el primer disco de `discs` es el balón **sin** tocar su cGroup (hay que poner `kick`/`score` a mano) |

Colores: `"transparent"` (= −1), `"RRGGBB"` o `[r,g,b]`. Flags: array de nombres (§4.1).

Validación (`Stadium.Sf` y `kh`): ≥1 disco, `bg.kickOffRadius ≥ 0`, `bg.cornerRadius ≥ 0`,
`playerPhysics.radius ≥ 0`; como máximo **255** vértices, segmentos, planos, porterías y discos.
Los errores se reportan como `Error in "<array>" index: <n>`.

Serialización binaria (para red/replays, `Stadium.G`): 1 byte `defaultStadiumId`; si ≠255 no se
envía nada más (cada cliente reconstruye el estadio por defecto). Si es 255, se envían todos los
campos con `Float64` para números y `Int32` para flags/colores, y el segmento guarda un byte de
flags (bit0 bias≠0, bit1 curveF finito, bit2 color≠0, bit3 vis). El `curveF` viaja ya calculado.

---

## 8. Estadios por defecto (`Stadium.Fd`)

Construidos por código, no desde `.hbs`. Índice = `defaultStadiumId`.

`lb(nombre, width, height, bgWidth, bgHeight, semiPortería, kickOffRadius, cornerRadius=0)` y
`gf(nombre, width, height, bgWidth, bgHeight, semiPortería, goalLine, cornerRadius)` (hockey):

| id | Nombre | width×height | bg (ancho×alto) | semi-portería | KO radius | esquinas | spawnDistance |
|---|---|---|---|---|---|---|---|
| 0 | Classic | 420×200 | 370×170 | 64 | 75 | 0 | 277.5 |
| 1 | Easy | 420×200 | 370×170 | 90 | 75 | 0 | 277.5 |
| 2 | Small | 420×200 | 320×130 | 55 | 70 | 0 | 240 |
| 3 | Big | 600×270 | 550×240 | 80 | 80 | 0 | 400 (tope) |
| 4 | Rounded | 420×200 | 370×170 | 64 | 75 | 75 | 277.5 |
| 5 | Hockey | 420×204 | 398×182 | 68 | 75 | 100 | 208.5 |
| 6 | Big Hockey | 600×270 | 550×240 | 90 | 75 | 150 | 292.5 |
| 7 | Big Easy | 600×270 | 550×240 | 95 | 80 | 0 | 400 |
| 8 | Big Rounded | 600×270 | 550×240 | 80 | 75 | 100 | 400 |
| 9 | Huge | 750×350 | 700×320 | 100 | 80 | 0 | 400 |

`spawnDistance = min(0.75·bgWidth, 400)` (`this.Ma=.75*d`); hockey: `min(0.75·(bgWidth−goalLine), 400)`;
goalLine 120 (Hockey) y 160 (Big Hockey). Todos usan `playerPhysics` y balón por defecto y
`kickOffReset` parcial.

Geometría de un estadio "lb" (p. ej. Classic, x hacia la derecha, y hacia abajo):
* 4 planos de cámara (`y=±height`, `x=±width`) con `bCoef 0`, máscara 63 ⇒ nada sale del rectángulo.
* 2 planos `y=±bgHeight` sólo para el balón (`cMask=1`), `bCoef 1`.
* 4 segmentos invisibles sólo-balón en `x=±bgWidth` desde las esquinas hasta los postes
  (dejan abierta la boca de gol). Los jugadores **no** están limitados por las líneas del campo,
  sólo por el rectángulo de cámara, postes y (si aplica) redes.
* Porterías (`w.Wc`): línea de gol en `x=±bgWidth` entre `y=±semi`; postes = discos `radius 8`,
  `invMass 0`, color `FFCCCC` (rojo, x<0) / `CCCCFF` (azul, x>0); red = 3 segmentos (`bCoef 0.1`)
  que empiezan 8 px detrás de la línea y tienen 22 px de fondo con esquinas curvas de 90°.
  En los "lb" la red sólo colisiona con el balón (`cMask=1`): los jugadores la atraviesan.
  En Hockey la red y postes usan `cMask=63` y la portería está en `x=±(bgWidth−goalLine)`, con
  planos sólo-balón en los cuatro lados.
* Barrera de kickoff (`w.hf`): ver §6.2 (`bCoef 0.1`, invisibles).
* Esquinas redondeadas (`w.ff`) si `cornerRadius>0`: segmentos sólo-balón curvados ±90°, `bCoef 1`.
* Equipo rojo a la izquierda (`Re=-1`), azul a la derecha (`Re=+1`). Colores de equipo: rojo
  `E56E56` (15035990), azul `5689E5` (5671397).

---

## 9. Determinismo

* **Sin aleatoriedad** en la simulación: las únicas llamadas a `Math.random` del headless son el
  backoff de reconexión al master server y un nonce de 8 bytes en el handshake.
  node-haxball sólo lo usa además en utilidades fuera del motor.
* Todo es `Number` (double IEEE-754). Operaciones usadas en el bucle: `+ − × ÷` y `Math.sqrt`,
  que ECMAScript exige correctamente redondeadas ⇒ resultados bit-idénticos entre motores
  siempre que se respete el **orden** de operaciones y de arrays (jugadores, discos, joints).
* `Math.tan` sólo se usa al construir segmentos curvos. Para estadios custom el `curveF` se
  calcula una vez y viaja como `Float64`; para los estadios por defecto cada cliente lo calcula
  localmente (posible diferencia entre motores JS: **no verificado**).
* `setDiscProperties` cuantiza los valores a **Float32** antes de enviarlos
  (`M.Zf=new Float32Array(1)`), para que host y clientes apliquen el mismo número.
* Verificación de sincronía: cada 600 frames (`this.Bg=600`, 10 s) el host emite una acción de
  *consistency check* con un hash = XOR de todas las palabras de 32 bits del estado serializado
  (`Ta.Ve`); el cliente compara y detecta desync.
* El estado completo del partido es pequeño: discos (pos, speed, gravity, radius, bCoef, invMass,
  damping, color, cMask, cGroup), `goalTickCounter`, `state`, marcadores, `timeElapsed` (double),
  `pauseGameTickCounter` y equipo que saca; la geometría estática viene del estadio.

---

## 10. Discrepancias encontradas entre fuentes

| Tema | index.d.ts / docs | Código real |
|---|---|---|
| `Segment.curveF` | "curving angle (in radians)" | `cot(curve/2)`; `Infinity` = recto |
| `GameState.timeElapsed` | "in miliseconds" | segundos (`+1/60` por tick) |
| `PlayerPhysics.bCoef` | "of this Vertex" (copy-paste) | coef. de rebote del disco de jugador |
| node-haxball vs oficial | — | Misma física; node-haxball añade callbacks (p. ej. `onKickOff`, colisiones), extrapolación y modo sandbox |

---

## Fuentes

* Script oficial del host headless de HaxBall (© Mario Carbajal), "Haxball source hash:
  f066733d", tal como lo empaqueta `mertushka/haxball.js`:
  `src/generated/headless.ts` (commit `e5231b0`, 2026-09-25). Clases citadas: `Oa`, `Q`, `Ba`,
  `E`, `K`, `C`, `X`, `xa`, `Ha`, `Qa`, `w` (`kh`, `Fd`, `lb`, `gf`, `Wc`, `hf`, `ff`, `Ag`),
  `Ta`, `Ka`, `v`, `Ma`/`Wa`, acciones `Da`, `qa`, `U`, `fa`, `M`, `Ea`, `ba`.
* `wxyz-abcd/node-haxball` (commit `4d4b88f`, 2026-07-17): `src/api.js` (motor `LM`,
  `e8`=kickBall, `_8`=movimiento, `nM`=runSteps, `Ah`=reset), `src/index.d.ts`
  (`Impl.Stadium.*`, `MovableDisc`, `PlayerPhysics`, `GameState`, `GamePlayState`,
  `CollisionFlags`), `README.md`.
* Wiki oficial: <https://github.com/haxball/haxball-issues/wiki/Stadium-(.hbs)-File> y
  <https://github.com/haxball/haxball-issues/wiki/Headless-Host> (`setKickRateLimit`,
  `onGameTick` "60 times per second", `setTimeLimit`/`setScoreLimit`).
* Para leer el código se formatearon copias con `prettier@3.3.3` (sólo lectura; los fragmentos
  citados aquí corresponden al fichero original minificado).
