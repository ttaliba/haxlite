# src/sim — physics, stadiums, World (engineer A)

## Status

| Piece | Status | Verified against |
|---|---|---|
| Stadium binary `writeStadium` / `readStadium` (+ `writeStadiumBody` / `readStadiumBody`) | **READY** | official `w.G`/`w.qa` and node-haxball, byte-exact |
| Disc / World binary `writeDisc` / `readDisc` / `writeWorld` / `readWorld` | **READY** | official `Ba.G` layout (92 bytes, color u32) |
| 10 default stadiums `defaultStadiums()` / `buildDefaultStadium(id)` | **READY** | official `w.Fd()` forced to the 255 form, byte-exact |
| `.hbs` parser `parseHbs` | **READY** | official `w.kh` byte-exact on 103 stadiums (hand-written edge cases, 10 exported built-ins, 80 random) + 30 rejected inputs; node-haxball agrees wherever it accepts the input |
| World step `stepWorld(world, dt)` | **READY** | official `Oa.Da` bit-exact: 172,600 ticks, every field of every disc compared with `Object.is` after each tick (10 built-ins + 24 custom stadiums) |

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
* **Default room stadium**: `defaultStadium(0)` (Classic). `defaultStadium(id)` builds and
  caches only that stadium (same instance as `defaultStadiums()[id]`, which builds all ten,
  ~120 KB of heap).
* **`parseHbs`** tries `JSON.parse` first and loads/uses json5 only when that throws (comments,
  unquoted keys, trailing commas…): same `Stadium`, same errors for invalid text (51 KB map,
  Node 26: 5.9 → 0.35 ms steady state).
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

## Tests and benchmark

* `test/sim/default-stadiums.test.ts`: built-ins vs official `w.Fd()` (255 form), 1-byte form, round trip.
* `test/sim/hbs.test.ts` + `test/sim/hbs-corpus.ts`: parser vs official `w.kh` (and node-haxball), error cases.
* `test/sim/physics.test.ts`: differential world step vs official `Oa.Da` (reached through
  `test/sim/official-sim.ts`), 5000 ticks per stadium, player-like chase/kick nudges, mask flips,
  fractional dt.
* `test/sim/world.test.ts`: world/disc bytes vs official `Oa.G`, `goalCrossed` vs official `w.Ag`,
  cached step vs literal reference step, cache invalidation.
* Benchmark: `node --experimental-strip-types --no-warnings --import ./bench/ts-resolve.mjs bench/sim.bench.ts`
  (Node 22.22, this container): Classic + 8 players ≈ 1.1 µs/tick vs official ≈ 2.1 µs/tick;
  Huge with 30 discs ≈ 3.5 µs/tick vs ≈ 6.4 µs/tick. No GC during 2M ticks (`--trace-gc`).

## Performance notes

`stepWorld` keeps the official algorithm and float expressions, but iterates only the static
objects whose masks can match the disc (a per-world, per-(cMask, cGroup) ordered index list;
skipped objects have no side effects, so results are identical — `stepWorldReference` is the
literal full scan and the tests check they agree). The cache notices replaced geometry arrays;
call `invalidateGeometryCache(world)` only if you mutate a plane/segment/vertex mask in place
(the official game never does).

## Known host-vs-client corners of the official parser (we follow the clients)

The official HOST keeps some `.hbs` values uncast while clients get the serialized numbers; we
always produce the client's view (the bytes are identical either way):
* string / missing disc `pos`/`speed`/`gravity` items (`"5"`, `[1]`) → `Number()` (5, NaN);
* a joint without `d0`/`d1` → the official host skips it (undefined index), clients apply it to
  disc 0 (u8 0 on the wire); we store 0.
* an unparsable colour (`"zzz"`) → stored as NaN: serializes as 0 and keeps the segment colour flag set.
