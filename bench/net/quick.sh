#!/bin/sh
# Quick-but-precise unified comparison (~35 min): same 4 hosts as unified.sh, interleaved,
# 3 reps, shorter windows, headline scenarios only. Loads the shipped minified bundle.
set -e
cd "$(dirname "$0")/../.."
npm run -s bench:build
R="node --experimental-transform-types --no-warnings --import ./bench/ts-resolve.mjs bench/net/run.ts"
I=official,nodehaxball,haxlite:ndc,haxlite:rtc
L="flock /tmp/haxlite-bench.lock"
$L $R startup --impl $I --reps 10 --max-foreign 50 --attempts 3 --out bench/results/quick-startup.json
$L $R game --impl $I --n 20 --reps 3 --warmup 10 --window 30 --max-foreign 50 --attempts 3 --out bench/results/quick-game.json
$L $R rooms --impl $I --k 10 --reps 3 --warmup 10 --window 30 --max-foreign 50 --attempts 3 --out bench/results/quick-rooms.json
$L $R idle --impl $I --reps 3 --warmup 10 --window 60 --max-foreign 50 --attempts 3 --out bench/results/quick-idle.json
