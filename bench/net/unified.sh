#!/bin/sh
# Unified same-session comparison (docs/07-benchmarks.md, "Comparativa unificada"):
# haxball.js (official headless script, @webrtc-node/webrtc), node-haxball as host
# (its bundled node-datachannel 0.25), haxlite + node-datachannel 0.33,
# haxlite + haxlite-rtc and haxlite + haxlite-rtc on Bun (`haxlite:rtc@bun`, the
# production runtime; `bun` on PATH or BUN_PATH). Every scenario interleaves the
# five hosts within each repetition; every run holds the shared benchmark lock of the VM.
#
#   sh bench/net/unified.sh            # ≈ 1 h 35 min (was ≈ 2 h 10) → bench/results/unified-*.json
#   node bench/net/report.mjs --unified
#
# Run time (docs/07, "Duración del arnés"): cached build, client joins 4 at a time in rooms
# (game keeps sequential joins: its join p50/p90 is a published row), warm-up
# until steady state (capped at --warmup), no fixed pauses between runs, and idle with 3 hosts
# at once, each pinned to its own core (taskset; the rest of the harness on core 3).
# Measurement windows and repetitions are unchanged.
set -eu
cd "$(dirname "$0")/../.."
node bench/build.mjs
IMPLS=official,nodehaxball,haxlite:ndc,haxlite:rtc,haxlite:rtc@bun
NOISE="--max-foreign 50 --attempts 3"
run() {
  flock /tmp/haxlite-bench.lock node --no-warnings \
    --import ./bench/ts-resolve.mjs bench/net/run.ts "$@"
}
run startup --impl $IMPLS --reps 10 $NOISE --out bench/results/unified-startup.json
run idle --impl $IMPLS --reps 3 --warmup 15 --window 120 --parallel 3 $NOISE --out bench/results/unified-idle.json
run game --impl $IMPLS --n 4,10,20 --reps 3 --warmup 15 --window 60 $NOISE --out bench/results/unified-game.json
run rooms --impl $IMPLS --k 10 --reps 3 --warmup 15 --window 60 $NOISE --out bench/results/unified-rooms.json
