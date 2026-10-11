#!/bin/sh
# Unified same-session comparison (docs/07-benchmarks.md, "Comparativa unificada"):
# haxball.js (official headless script, @webrtc-node/webrtc), node-haxball as host
# (its bundled node-datachannel 0.25), haxlite + node-datachannel 0.33 and
# haxlite + haxlite-rtc. Every scenario interleaves the four hosts within each
# repetition; every run holds the shared benchmark lock of the VM.
#
#   sh bench/net/unified.sh            # ≈ 1 h 45 min → bench/results/unified-*.json
#   node bench/net/report.mjs --unified
set -eu
cd "$(dirname "$0")/../.."
npm run -s bench:build
IMPLS=official,nodehaxball,haxlite:ndc,haxlite:rtc
NOISE="--max-foreign 50 --attempts 3"
run() {
  flock /tmp/haxlite-bench.lock node --experimental-transform-types --no-warnings \
    --import ./bench/ts-resolve.mjs bench/net/run.ts "$@"
}
run startup --impl $IMPLS --reps 10 $NOISE --out bench/results/unified-startup.json
run idle --impl $IMPLS --reps 3 --warmup 15 --window 120 $NOISE --out bench/results/unified-idle.json
run game --impl $IMPLS --n 4,10,20 --reps 3 --warmup 15 --window 60 $NOISE --out bench/results/unified-game.json
run rooms --impl $IMPLS --k 10 --reps 3 --warmup 15 --window 60 $NOISE --out bench/results/unified-rooms.json
