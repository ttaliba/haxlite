#!/bin/sh
# Solo haxlite + rtc (~10 min): las referencias de haxball.js y node-haxball ya están en
# bench/results/unified-*.json (13-10-2026). Para comparar con ellas, mirar la misma métrica en
# la misma máquina: los valores absolutos de CPU cambian entre sesiones (frecuencia de la VM).
set -e
cd "$(dirname "$0")/../.."
npm run -s bench:build
R="node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts"
L="flock /tmp/haxlite-bench.lock"
$L $R startup --impl haxlite:rtc --reps 10 --max-foreign 50 --attempts 3 --out bench/results/ours-startup.json
$L $R game --impl haxlite:rtc --n 20 --reps 3 --warmup 10 --window 30 --max-foreign 50 --attempts 3 --out bench/results/ours-game.json
$L $R rooms --impl haxlite:rtc --k 10 --reps 3 --warmup 10 --window 30 --max-foreign 50 --attempts 3 --out bench/results/ours-rooms.json
$L $R idle --impl haxlite:rtc --reps 3 --warmup 10 --window 60 --max-foreign 50 --attempts 3 --out bench/results/ours-idle.json
