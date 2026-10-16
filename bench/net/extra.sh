#!/bin/sh
# Escenarios de producción (docs/07-benchmarks.md, "Escenarios de producción"), haxlite + rtc
# en Node y en Bun: flota 3 procesos × 4 salas × 4 clientes, entrada con red degradada y
# soak de 6 h con jugadores entrando y saliendo. Cada corrida toma el candado de benchmark de la VM.
# join-impaired y soak corren Node y Bun a la vez (--parallel 2): host de Node en el núcleo 0,
# host de Bun en el 1, clientes y arnés en el 2–3 (taskset); no miden CPU sino latencia y memoria.
#
#   sh bench/net/extra.sh              # ≈ 6 h 20 min (antes ≈ 12 h 30; el soak: 6 h, ambos runtimes juntos)
#   SOAK_MIN=30 sh bench/net/extra.sh  # soak corto: ≈ 50 min (antes ≈ 1 h 30)
#   node bench/net/report.mjs          # tablas de fleet / soak / join-impaired
set -eu
cd "$(dirname "$0")/../.."
node bench/build.mjs
IMPLS=haxlite:rtc,haxlite:rtc@bun
NOISE="--max-foreign 50 --attempts 3"
run() {
  flock /tmp/haxlite-bench.lock node --no-warnings \
    --import ./bench/ts-resolve.mjs bench/net/run.ts "$@"
}
run fleet --impl $IMPLS --procs 3 --rooms 4 --clients 4 --reps 3 --warmup 15 --window 60 $NOISE --out bench/results/fleet.json
run join-impaired --impl $IMPLS --rtt 40 --loss 0,1,3 --stun cold,cached --joins 20 --reps 3 --parallel 2 --out bench/results/join-impaired.json
run soak --impl $IMPLS --rooms 4 --clients 4 --minutes "${SOAK_MIN:-360}" --sample-s 60 --parallel 2 --out bench/results/soak.json
