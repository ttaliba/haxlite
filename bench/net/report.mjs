// Prints the markdown tables of docs/07-benchmarks.md from bench/results/*.json.
//   node bench/net/report.mjs [resultsDir]
//   node bench/net/report.mjs --unified [resultsDir]   # "Comparativa unificada" (unified-*.json)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIFIED = process.argv.includes('--unified');
const dir = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../results');
const load = (n) => (existsSync(path.join(dir, `${n}.json`)) ? JSON.parse(readFileSync(path.join(dir, `${n}.json`), 'utf8')) : null);
const NAMES = {
  haxlite: 'haxlite',
  official: 'oficial (haxball.js)',
  nodehaxball: 'node-haxball',
  'haxlite:ndc': 'haxlite + ndc',
  'haxlite:rtc': 'haxlite + rtc',
  'haxlite:rtc@bun': 'haxlite + rtc (Bun)',
  'haxlite:ndc@bun': 'haxlite + ndc (Bun)',
  'haxlite@bun': 'haxlite (Bun)',
};
/** Implementation key incl. the host runtime (results before --runtime have none: Node). */
const keyOf = (c) => (c.spec.runtime === 'bun' ? `${c.spec.impl}@bun` : c.spec.impl);
const MB = 1024 * 1024;

function stat(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { median, min: s[0], max: s[n - 1], n };
}
function fmt(st, d = 1) {
  if (!st) return '—';
  return `${st.median.toFixed(d)} (${st.min.toFixed(d)}–${st.max.toFixed(d)})`;
}
const ok = (c) => c.runs.filter((r) => !r.failed);
const col = (c, f, d) => fmt(stat(ok(c).map(f)), d);
const implOf = (c) => NAMES[keyOf(c)] ?? keyOf(c);

function table(header, rows) {
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${header.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  console.log();
}

if (UNIFIED) {
  unifiedReport();
  process.exit(0);
}

const startup = load('startup');
if (startup) {
  console.log('### Arranque\n');
  table(
    ['host', 'reps', 'inicio proceso → link (ms)', 'creación → link (ms)', 'carga módulos (ms)', 'CPU hasta link (ms)', 'RSS al link (MB)', 'heap al link (MB)'],
    startup.configs.map((c) => [
      implOf(c),
      ok(c).length,
      col(c, (r) => r.startup.links[0].tLink, 0),
      col(c, (r) => r.startup.links[0].createToLinkMs, 1),
      col(c, (r) => r.startup.links[0].tLoad, 0),
      col(c, (r) => r.startup.links[0].cpuMs, 0),
      col(c, (r) => r.startup.links[0].rss / MB, 1),
      col(c, (r) => r.startup.links[0].heapUsed / MB, 1),
    ]),
  );
}

const idle = load('idle');
if (idle) {
  console.log('### Sala pública ociosa (0 jugadores)\n');
  table(
    ['host', 'reps × ventana', 'CPU % (1 núcleo = 100)', 'CPU ms/min', 'RSS medio (MB)', 'Δ RSS en ventana (MB)', 'heap usado medio (MB)', 'GC/min', 'ajeno %'],
    idle.configs.map((c) => [
      implOf(c),
      `${ok(c).length} × ${c.spec.windowS} s`,
      col(c, (r) => r.host.cpuPct, 3),
      col(c, (r) => ((r.host.cpuUserMs + r.host.cpuSystemMs) / r.host.wallMs) * 60_000, 0),
      col(c, (r) => r.host.rssMean / MB, 1),
      col(c, (r) => (r.host.rssEnd - r.host.rssStart) / MB, 2),
      col(c, (r) => r.host.heapUsedMean / MB, 1),
      col(c, (r) => ((r.host.gcCount ?? NaN) / r.host.wallMs) * 60_000, 1),
      col(c, (r) => r.machine.foreignPct, 0),
    ]),
  );
}

for (const [name, title] of [
  ['game', 'Partida en curso, 1 sala con N clientes'],
  ['rooms', 'K salas en un proceso, 4 clientes por sala'],
]) {
  const g = load(name);
  if (!g) continue;
  console.log(`### ${title}\n`);
  table(
    ['config', 'reps', 'CPU %', 'RSS medio (MB)', 'heap usado medio (MB)', 'lag p50 (ms)', 'lag p99 (ms)', 'lag máx (ms)', 'GC/min', 'GC ms/min', 'clientes CPU %', 'ajeno %'],
    g.configs.map((c) => [
      `${implOf(c)} ${name === 'game' ? `N=${c.spec.clientsPerRoom}` : `K=${c.spec.rooms}`}`,
      `${ok(c).length}${ok(c).some((r) => r.noisy) ? '*' : ''}${ok(c).every((r) => r.valid) ? '' : ' ⚠'}`,
      col(c, (r) => r.host.cpuPct, 2),
      col(c, (r) => r.host.rssMean / MB, 1),
      col(c, (r) => r.host.heapUsedMean / MB, 1),
      col(c, (r) => r.host.eld?.p50, 2),
      col(c, (r) => r.host.eld?.p99, 2),
      col(c, (r) => r.host.eld?.max, 1),
      col(c, (r) => ((r.host.gcCount ?? NaN) / r.host.wallMs) * 60_000, 1),
      col(c, (r) => ((r.host.gcMs ?? NaN) / r.host.wallMs) * 60_000, 1),
      col(c, (r) => r.clients.reduce((a, x) => a + x.cpuPct, 0), 0),
      col(c, (r) => r.machine.foreignPct, 0),
    ]),
  );
  const withThreads = g.configs.filter((c) => ok(c).some((r) => r.host.threadsPct));
  if (withThreads.length) {
    console.log(`#### Reparto de CPU por hilo (${title}; mediana, % de un núcleo)\n`);
    const keys = new Set();
    for (const c of withThreads) for (const r of ok(c)) for (const k of Object.keys(r.host.threadsPct ?? {})) keys.add(k);
    const ks = [...keys].sort();
    table(
      ['config', ...ks],
      withThreads.map((c) => [
        `${implOf(c)} ${name === 'game' ? `N=${c.spec.clientsPerRoom}` : `K=${c.spec.rooms}`}`,
        ...ks.map((k) => {
          const s = stat(ok(c).filter((r) => r.host.threadsPct).map((r) => r.host.threadsPct[k] ?? 0));
          return s ? s.median.toFixed(2) : '—';
        }),
      ]),
    );
  }
}

const fleet = load('fleet');
if (fleet) {
  console.log('### Flota: P procesos × R salas × C clientes (sumas sobre los procesos)\n');
  table(
    ['config', 'reps', 'CPU % total', 'RSS total (MB)', 'heap total (MB)', 'lag p99 peor proceso (ms)', 'salida/jugador msg/s · B/s', 'UDP/jugador pkt/s · B/s', 'hueco p50 / p99 / p99,9 (ms)'],
    fleet.configs.map((c) => [
      `${implOf(c)} P=${c.spec.procs} R=${c.spec.rooms} C=${c.spec.clientsPerRoom}`,
      ok(c).length,
      col(c, (r) => r.host.cpuPct, 2),
      col(c, (r) => r.host.rssMean / MB, 1),
      col(c, (r) => r.host.heapUsedMean / MB, 1),
      col(c, (r) => r.host.eld?.p99 ?? NaN, 2),
      `${col(c, (r) => r.egressPerPlayer.appMsgsPerS, 1)} · ${col(c, (r) => r.egressPerPlayer.appBytesPerS, 0)}`,
      `${col(c, (r) => r.egressPerPlayer.udpPacketsPerS ?? NaN, 1)} · ${col(c, (r) => r.egressPerPlayer.udpBytesPerS ?? NaN, 0)}`,
      `${col(c, (r) => r.traffic.gapsAll.p50, 1)} / ${col(c, (r) => r.traffic.gapsAll.p99, 1)} / ${col(c, (r) => r.traffic.gapsAll.p999, 1)}`,
    ]),
  );
}

const soak = load('soak');
if (soak) {
  console.log('### Soak: salas con jugadores entrando y saliendo\n');
  table(
    ['config', 'horas', 'muestras', 'RSS inicio → fin (MB)', 'pendiente RSS (MB/h)', 'pendiente heap usado (MB/h)', 'pendiente external (MB/h)', 'deriva fds', 'entradas · salidas · fallos'],
    soak.configs.flatMap((c) =>
      ok(c).map((r) => {
        const s = r.soak?.[0] ?? {};
        const ch = (r.clients ?? []).reduce((a, x) => ({ j: a.j + (x.churn?.joins ?? 0), l: a.l + (x.churn?.leaves ?? 0), f: a.f + (x.churn?.failures ?? 0) }), { j: 0, l: 0, f: 0 });
        return [implOf(c) + ` R=${c.spec.rooms} C=${c.spec.clientsPerRoom}`, s.hours, s.samples, `${s.rssStartMB} → ${s.rssEndMB}`, s.rssSlopeMBph, s.heapUsedSlopeMBph, s.externalSlopeMBph, s.fdDrift ?? 'n/d', `${ch.j} · ${ch.l} · ${ch.f}`];
      }),
    ),
  );
}

const ji = load('join-impaired');
if (ji) {
  console.log('### Entrada con red degradada (NAT simulado, latencia y pérdida)\n');
  table(
    ['config', 'entradas', 'p50 (ms)', 'p90 (ms)', 'p99 (ms)', 'máx (ms)', 'reintentos', 'consultas STUN'],
    ji.configs.map((c) => [
      c.label,
      col(c, (r) => r.join.reduce((a, j) => a + j.joined, 0), 0),
      col(c, (r) => q(r.join.flatMap((j) => j.joinMs), 0.5), 0),
      col(c, (r) => q(r.join.flatMap((j) => j.joinMs), 0.9), 0),
      col(c, (r) => q(r.join.flatMap((j) => j.joinMs), 0.99), 0),
      col(c, (r) => Math.max(...r.join.flatMap((j) => j.joinMs)), 0),
      col(c, (r) => r.join.reduce((a, j) => a + j.failures, 0), 0),
      col(c, (r) => r.impairStats.reduce((a, h) => a + h.rooms.reduce((b, x) => b + (x?.stunRequests ?? 0), 0), 0), 0),
    ]),
  );
}
function q(xs, p) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

const sim = load('sim');
if (sim) {
  console.log('### Física (bench/sim.bench.ts)\n');
  const labels = sim.runs[0].rows.map((r) => r.label);
  table(
    ['escenario', 'reps', 'haxlite ns/tick', 'oficial ns/tick', 'aceleración', 'crecimiento heap haxlite (KiB / 200k ticks)'],
    labels.map((l) => {
      const rows = sim.runs.map((r) => r.rows.find((x) => x.label === l));
      return [
        l,
        rows.length,
        fmt(stat(rows.map((r) => r.haxliteNs)), 0),
        fmt(stat(rows.map((r) => r.officialNs)), 0),
        `×${fmt(stat(rows.map((r) => r.speedup)), 2)}`,
        fmt(stat(rows.map((r) => r.haxliteHeapGrowthKiB)), 0),
      ];
    }),
  );
}

// ------------------------------------------------------------- unified report
function unifiedReport() {
  const ORDER = ['official', 'nodehaxball', 'haxlite:ndc', 'haxlite:rtc'];
  const es = (x, d) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : '—');
  const med = (c, f) => stat(ok(c).map(f))?.median ?? NaN;
  const rng = (c, f, d) => {
    const st = stat(ok(c).map(f));
    return st ? `${es(st.median, d)} (${es(st.min, d)}–${es(st.max, d)})` : '—';
  };
  const byImpl = (j, pred = () => true) => ORDER.map((impl) => j?.configs.find((c) => keyOf(c) === impl && pred(c)) ?? null);
  const joinQ = (r, q) => {
    const xs = (r.join ?? []).flatMap((j) => j.joinMs ?? []).sort((a, b) => a - b);
    if (!xs.length) return NaN;
    const i = (xs.length - 1) * q;
    const lo = Math.floor(i);
    return xs[lo] + (xs[Math.min(lo + 1, xs.length - 1)] - xs[lo]) * (i - lo);
  };
  const cell = (c, f, d) => (c && ok(c).length ? es(med(c, f), d) : 'n/d');
  const flags = (c) => (c ? `${ok(c).length}${ok(c).some((r) => r.noisy) ? '*' : ''}${ok(c).every((r) => r.valid) ? '' : '⚠'}` : '0');
  const header = ['escenario', 'métrica', ...ORDER.map((i) => NAMES[i])];
  const rows = [];
  const startup = load('unified-startup');
  const idle = load('unified-idle');
  const game = load('unified-game');
  const rooms = load('unified-rooms');
  // extra columns (e.g. haxlite:rtc@bun) when the results have them
  for (const j of [startup, idle, game, rooms]) for (const c of j?.configs ?? []) if (!ORDER.includes(keyOf(c))) ORDER.push(keyOf(c));
  header.splice(2, header.length - 2, ...ORDER.map((i) => NAMES[i] ?? i));
  if (startup) {
    const cs = byImpl(startup);
    rows.push(['arranque', 'inicio del proceso → link (ms)', ...cs.map((c) => cell(c, (r) => r.startup.links[0].tLink, 0))]);
    rows.push(['', 'RSS al link (MB)', ...cs.map((c) => cell(c, (r) => r.startup.links[0].rss / MB, 1))]);
  }
  if (idle) {
    const cs = byImpl(idle);
    rows.push(['sala pública ociosa, 0 jugadores', 'CPU % · ms de CPU/min', ...cs.map((c) => (c ? `${cell(c, (r) => r.host.cpuPct, 3)} · ${cell(c, (r) => ((r.host.cpuUserMs + r.host.cpuSystemMs) / r.host.wallMs) * 60_000, 1)}` : 'n/d'))]);
    rows.push(['', 'RSS (MB)', ...cs.map((c) => cell(c, (r) => r.host.rssMean / MB, 1))]);
    rows.push(['', 'hilos · fds', ...cs.map((c) => (c ? `${cell(c, (r) => r.host.threadCount, 0)} · ${cell(c, (r) => r.host.fdCount, 0)}` : 'n/d'))]);
    rows.push(['', 'despertares/s (cambios de contexto voluntarios)', ...cs.map((c) => cell(c, (r) => r.host.wakeups?.voluntaryPerS, 1))]);
  }
  if (game) {
    for (const n of [...new Set(game.configs.map((c) => c.spec.clientsPerRoom))]) {
      const cs = byImpl(game, (c) => c.spec.clientsPerRoom === n);
      rows.push([`partida, ${n} clientes`, 'CPU % total (hilo JS + otros hilos)', ...cs.map((c) => (c ? `**${cell(c, (r) => r.host.cpuPct, 2)}** (${cell(c, (r) => r.host.cpuSplit?.mainPct, 1)} + ${cell(c, (r) => r.host.cpuSplit?.otherPct, 1)})` : 'n/d'))]);
      rows.push(['', 'RSS / heap usado (MB)', ...cs.map((c) => (c ? `${cell(c, (r) => r.host.rssMean / MB, 1)} / ${cell(c, (r) => r.host.heapUsedMean / MB, 1)}` : 'n/d'))]);
      rows.push(['', 'GC/min', ...cs.map((c) => cell(c, (r) => ((r.host.gcCount ?? NaN) / r.host.wallMs) * 60_000, 0))]);
      rows.push(['', 'lag del event loop p50 / p99 (ms)', ...cs.map((c) => (c ? `${cell(c, (r) => r.host.eld?.p50, 2)} / ${cell(c, (r) => r.host.eld?.p99, 2)}` : 'n/d'))]);
      rows.push(['', 'hilos · fds', ...cs.map((c) => (c ? `${cell(c, (r) => r.host.threadCount, 0)} · ${cell(c, (r) => r.host.fdCount, 0)}` : 'n/d'))]);
      rows.push(['', 'despertares/s', ...cs.map((c) => cell(c, (r) => r.host.wakeups?.voluntaryPerS, 0))]);
      rows.push(['', 'entrada p50 (ms, Room.join → onOpen)', ...cs.map((c) => cell(c, (r) => joinQ(r, 0.5), 0))]);
      if (cs.some((c) => c && ok(c).some((r) => r.egressPerPlayer))) {
        rows.push(['', 'salida por jugador: mensajes/s · B/s (aplicación)', ...cs.map((c) => (c && ok(c).some((r) => r.egressPerPlayer) ? `${cell(c, (r) => r.egressPerPlayer.appMsgsPerS, 1)} · ${cell(c, (r) => r.egressPerPlayer.appBytesPerS, 0)}` : 'n/d'))]);
        rows.push(['', 'salida por jugador: datagramas/s · B/s (UDP)', ...cs.map((c) => (c && ok(c).some((r) => r.egressPerPlayer?.udpBytesPerS != null) ? `${cell(c, (r) => r.egressPerPlayer.udpPacketsPerS, 1)} · ${cell(c, (r) => r.egressPerPlayer.udpBytesPerS, 0)}` : 'n/d'))]);
        rows.push(['', 'hueco entre mensajes en el cliente p50 / p99 / p99,9 (ms)', ...cs.map((c) => (c && ok(c).some((r) => r.traffic) ? `${cell(c, (r) => r.traffic.gapsAll.p50, 1)} / ${cell(c, (r) => r.traffic.gapsAll.p99, 1)} / ${cell(c, (r) => r.traffic.gapsAll.p999, 1)}` : 'n/d'))]);
      }
    }
  }
  if (rooms) {
    for (const k of [...new Set(rooms.configs.map((c) => c.spec.rooms))]) {
      const cs = byImpl(rooms, (c) => c.spec.rooms === k);
      rows.push([`${k} salas × 4 clientes, 1 proceso`, 'CPU % total (hilo JS + otros hilos)', ...cs.map((c) => (c ? `**${cell(c, (r) => r.host.cpuPct, 2)}** (${cell(c, (r) => r.host.cpuSplit?.mainPct, 1)} + ${cell(c, (r) => r.host.cpuSplit?.otherPct, 1)})` : 'n/d'))]);
      rows.push(['', 'RSS / heap usado (MB)', ...cs.map((c) => (c ? `${cell(c, (r) => r.host.rssMean / MB, 1)} / ${cell(c, (r) => r.host.heapUsedMean / MB, 1)}` : 'n/d'))]);
      rows.push(['', 'hilos · fds', ...cs.map((c) => (c ? `${cell(c, (r) => r.host.threadCount, 0)} · ${cell(c, (r) => r.host.fdCount, 0)}` : 'n/d'))]);
    }
  }
  console.log('### Resumen (medianas)\n');
  table(header, rows);

  // Detail tables: median (min–max) over the repetitions + validity and machine noise.
  const detail = (j, title, label, pred) => {
    if (!j) return;
    console.log(`### ${title}\n`);
    table(
      ['host', 'reps', 'CPU %', 'hilo JS %', 'otros hilos %', 'RSS (MB)', 'heap (MB)', 'GC/min', 'lag p50 / p99 (ms)', 'hilos', 'fds', 'despertares/s', 'entrada p50 / p90 (ms)', 'ajeno % · loadavg'],
      j.configs.filter(pred).map((c) => [
        label(c),
        flags(c),
        rng(c, (r) => r.host.cpuPct, j.scenario === 'idle' ? 3 : 2),
        rng(c, (r) => r.host.cpuSplit?.mainPct, 2),
        rng(c, (r) => r.host.cpuSplit?.otherPct, 2),
        rng(c, (r) => r.host.rssMean / MB, 1),
        rng(c, (r) => r.host.heapUsedMean / MB, 1),
        rng(c, (r) => ((r.host.gcCount ?? NaN) / r.host.wallMs) * 60_000, 0),
        j.scenario === 'idle' ? '—' : `${es(med(c, (r) => r.host.eld?.p50), 2)} / ${es(med(c, (r) => r.host.eld?.p99), 2)}`,
        rng(c, (r) => r.host.threadCount, 0),
        rng(c, (r) => r.host.fdCount, 0),
        rng(c, (r) => r.host.wakeups?.voluntaryPerS, 0),
        j.scenario === 'idle' ? '—' : `${es(med(c, (r) => joinQ(r, 0.5)), 0)} / ${es(med(c, (r) => joinQ(r, 0.9)), 0)}`,
        `${es(med(c, (r) => r.machine.foreignPct), 0)} · ${es(med(c, (r) => r.machine.loadavgEnd[0]), 2)}`,
      ]),
    );
  };
  if (startup) {
    console.log('### Arranque (detalle)\n');
    table(
      ['host', 'reps', 'inicio proceso → link (ms)', 'creación → link (ms)', 'carga módulos (ms)', 'CPU hasta link (ms)', 'RSS al link (MB)', 'heap al link (MB)'],
      byImpl(startup).filter(Boolean).map((c) => [
        NAMES[keyOf(c)] ?? keyOf(c),
        flags(c),
        rng(c, (r) => r.startup.links[0].tLink, 0),
        rng(c, (r) => r.startup.links[0].createToLinkMs, 1),
        rng(c, (r) => r.startup.links[0].tLoad, 0),
        rng(c, (r) => r.startup.links[0].cpuMs, 0),
        rng(c, (r) => r.startup.links[0].rss / MB, 1),
        rng(c, (r) => r.startup.links[0].heapUsed / MB, 1),
      ]),
    );
  }
  detail(idle, 'Ociosa (detalle)', (c) => implOf(c), () => true);
  detail(game, 'Partida (detalle)', (c) => `${implOf(c)} N=${c.spec.clientsPerRoom}`, () => true);
  detail(rooms, 'K salas (detalle)', (c) => `${implOf(c)} K=${c.spec.rooms}`, () => true);
  for (const [j, title, label] of [
    [game, 'partida', (c) => `${implOf(c)} N=${c.spec.clientsPerRoom}`],
    [rooms, 'K salas', (c) => `${implOf(c)} K=${c.spec.rooms}`],
  ]) {
    if (!j) continue;
    const keys = new Set();
    for (const c of j.configs) for (const r of ok(c)) for (const k of Object.keys(r.host.threadsPct ?? {})) keys.add(k);
    const ks = [...keys].sort();
    console.log(`#### Reparto de CPU por hilo (${title}; mediana, % de un núcleo)\n`);
    table(['config', ...ks], j.configs.map((c) => [label(c), ...ks.map((k) => es(med(c, (r) => r.host.threadsPct?.[k] ?? 0), 2))]));
  }
  const any = startup ?? idle ?? game ?? rooms;
  if (any) console.log(`Máquina: ${any.info.cpu}, ${any.info.nproc} vCPU, ${any.info.totalMemMB} MB, ${any.info.platform}, Node ${any.info.node}; build haxlite ${any.info.haxliteBuildSha} (commit ${any.info.commit.slice(0, 7)})`);
}
