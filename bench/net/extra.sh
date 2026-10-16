#!/bin/sh
# Escenarios de producción (docs/07-benchmarks.md, "Escenarios de producción"), haxlite + rtc
# en Node y en Bun: flota 3 procesos × 4 salas × 4 clientes, entrada con red degradada y
# soak de 6 h con jugadores entrando y saliendo. Cada corrida toma el candado de benchmark de la VM.
#
#   sh bench/net/extra.sh              # ≈ 12 h 30 min (el soak: 6 h por runtime)
#   SOAK_MIN=30 sh bench/net/extra.sh  # soak corto
#   node bench/net/report.mjs          # tablas de fleet / soak / join-impaired
set -eu
cd "$(dirname "$0")/../.."
npm run -s bench:build
IMPLS=haxlite:rtc,haxlite:rtc@bun
NOISE="--max-foreign 50 --attempts 3"
run() {
  flock /tmp/haxlite-bench.lock node --no-warnings \
    --import ./bench/ts-resolve.mjs bench/net/run.ts "$@"
}
run fleet --impl $IMPLS --procs 3 --rooms 4 --clients 4 --reps 3 --warmup 15 --window 60 $NOISE --out bench/results/fleet.json
run join-impaired --impl $IMPLS --rtt 40 --loss 0,1,3 --stun cold,cached --joins 20 --reps 3 --out bench/results/join-impaired.json
run soak --impl $IMPLS --rooms 4 --clients 4 --minutes "${SOAK_MIN:-360}" --sample-s 60 --out bench/results/soak.json
