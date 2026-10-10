# src/sim — physics, stadiums, World (engineer A)

## Status

| Piece | Status | Verified against |
|---|---|---|
| Stadium binary `writeStadium` / `readStadium` (+ `writeStadiumBody` / `readStadiumBody`) | **READY** | official `w.G`/`w.qa` and node-haxball, byte-exact |
| Disc / World binary `writeDisc` / `readDisc` / `writeWorld` / `readWorld` | **READY** | official `Ba.G` layout (92 bytes, color u32) |
| 10 default stadiums `defaultStadiums()` / `buildDefaultStadium(id)` | **READY** | official `w.Fd()` forced to the 255 form, byte-exact |
| `.hbs` parser `parseHbs` | READY | official `w.kh` + node-haxball, byte-exact on the corpus in `test/sim/hbs-corpus.ts` |
| World step `stepWorld(world, dt)` | READY | official `Oa.Da` bit-exact (Object.is on every disc field, every tick) |

## API for the room (engineer B)

```ts
import {
  stepWorld, createWorld, attachStadium, copyDiscProps, cloneDisc, goalCrossed,
  writeStadium, readStadium, writeWorld, readWorld, writeDisc, readDisc,
  parseHbs, defaultStadiums,
} from '../sim/index.js';
```

* **Stadium on the wire** (RoomState field 8, SetStadium payload before deflate):
  `writeStadium(w, stadium)` writes `u8 defaultStadiumId` and, only when it is 255, the body.
  `readStadium(r)` returns the **shared** built-in instance for ids 0..9 (never mutate it; the
  official code shares them too) or a new custom Stadium (geometry prepared, validated: throws
  `InvalidStadiumError`, like the official reader).
* **Default room stadium**: `defaultStadiums()[0]` (Classic).
* **Game start** (official `Q.eh`): `gs.world = createWorld(stadium)` — geometry arrays are shared
  by reference with the stadium, stadium discs are cloned in order (ball = disc 0). Then append
  player discs (`new Disc()` + fields, as `Q.af` does) yourself.
* **Kick-off reset** (`Q.bf`): `copyDiscProps(world.discs[i], stadium.discs[i])` for `i < (stadium.fullKickOffReset ? stadium.discs.length : 1)`.
* **Each tick** (`Q.Da`): after player input/kick and saving the score-disc positions, call
  `stepWorld(gs.world, 1)` exactly once; then run the phase logic. Goal test:
  `goalCrossed(stadium, cur.x, cur.y, prev.x, prev.y)` → owner team id (1/2) or 0 (official `w.Ag(cur, prev)`).
* **GameState serialization**: `writeWorld(w, world)` (`u8 n` + discs; it assigns `disc.index`,
  which the Player serializer then writes as i16). `readWorld(r, world)` replaces `world.discs`;
  follow it with `attachStadium(world, stadium)`.

`stepWorld` never allocates; it reads `world.discs/planes/segments/vertexes/joints` each call,
so replacing those arrays between ticks is fine.

## Boundary notes / changes vs the original stubs

* `stepWorld(world, dt)`, `writeStadium`, `readStadium`, `parseHbs`, `defaultStadiums`,
  `writeDisc`, `writeWorld` keep their stub signatures.
* Added: `createWorld`, `attachStadium`, `copyDiscProps`, `cloneDisc`, `goalCrossed`,
  `readDisc`, `readWorld`, `writeStadiumBody`, `readStadiumBody`, `buildDefaultStadium`,
  `createDefaultBall`, collision primitives (`collideDiscs`, ...), geometry helpers.
* Model values that the official code leaves `undefined` are stored as the number they become on
  the wire (`NaN` for f64, `0` for int fields): e.g. built-in grass stadiums have
  `bgGoalLine = NaN` (node-haxball says 0 — the official one is NaN), hockey ones `bgColor = 0`.
* `.hbs` values without an official type check (disc pos/speed/gravity, goal points) are
  converted with `Number()`, i.e. what clients decode from the bytes.
