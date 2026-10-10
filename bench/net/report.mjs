// Prints the markdown tables of docs/07-benchmarks.md from bench/results/*.json.
//   node bench/net/report.mjs [resultsDir]
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../results');
const load = (n) => (existsSync(path.join(dir, `${n}.json`)) ? JSON.parse(readFileSync(path.join(dir, `${n}.json`), 'utf8')) : null);
const NAMES = { haxlite: 'haxlite', official: 'oficial (haxball.js)', nodehaxball: 'node-haxball' };
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
const implOf = (c) => NAMES[c.spec.impl] ?? c.spec.impl;

function table(header, rows) {
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${header.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  console.log();
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
      col(c, (r) => (r.host.gcCount / r.host.wallMs) * 60_000, 1),
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
      col(c, (r) => r.host.eld.p50, 2),
      col(c, (r) => r.host.eld.p99, 2),
      col(c, (r) => r.host.eld.max, 1),
      col(c, (r) => (r.host.gcCount / r.host.wallMs) * 60_000, 1),
      col(c, (r) => (r.host.gcMs / r.host.wallMs) * 60_000, 1),
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
