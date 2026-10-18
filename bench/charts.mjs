// Generates benchmark chart cards (HTML/SVG) and screenshots each one as a PNG.
// Usage: node bench/charts.mjs docs/img/benchmark [bench/results/quick] [rtc,off,nh]   (also writes 0-comparativa-completa.png: every metric + headline gains; it always shows all libraries)
// The third argument picks the libraries shown (keys of LIBS; default: all four; `rtcbun`
// = haxlite:rtc@bun, when the results have it). Browser: $CHROME_PATH, else the Playwright
// Chromium of /opt/pw-browsers, else a local Chrome/Edge (Windows/macOS/Linux). Without a
// browser only charts.html is written. The cards use the Inter font when installed.
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright-core');

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

const C = { surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', ink3: '#7d7c77', grid: '#e9e8e4', axis: '#c9c8c2' };
const LIB_DEFS = [
  { key: 'rtc', name: 'haxlite + WebRTC propio', color: '#2a78d6' },
  { key: 'ndc', name: 'haxlite + node-datachannel', color: '#eb6834' },
  { key: 'off', name: 'haxball.js (oficial)', color: '#1baf7a' },
  { key: 'nh', name: 'node-haxball', color: '#eda100' },
  { key: 'rtcbun', name: 'haxlite + WebRTC propio (Bun)', color: '#7a4fd0' },
];
let LIBS = LIB_DEFS.filter((l) => (process.argv[4] === undefined ? l.key !== 'rtcbun' : process.argv[4].split(',').includes(l.key)));
const HAS_NDC = LIBS.some((l) => l.key === 'ndc');
const fmt = (v, d) => v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function ticks(max) {
  const raw = max / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const out = [];
  for (let t = 0; t <= max + 1e-9; t += step) out.push(+t.toFixed(6));
  return out;
}
// bar path with 4px rounded data end only
function vbar(x, y0, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  const y = y0 - h;
  return `M${x},${y0} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y0} Z`;
}
function hbar(x0, y, w, h, r = 4) {
  if (w <= 0) return '';
  r = Math.min(r, w, h / 2);
  const x = x0 + w;
  return `M${x0},${y} H${x - r} Q${x},${y} ${x},${y + r} V${y + h - r} Q${x},${y + h} ${x - r},${y + h} H${x0} Z`;
}

function legend() {
  return `<div class="legend">${LIBS.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.name)}</span>`).join('')}</div>`;
}

// grouped vertical bars: groups = [{label, values:{rtc,ndc,off,nh}}]
function grouped({ groups, unit, decimals, max }) {
  const W = 1120, H = 470, L = 64, R = 16, T = 30, B = 56;
  const pw = W - L - R, ph = H - T - B;
  max = max ?? niceMax(Math.max(...groups.flatMap((g) => LIBS.map((l) => g.values[l.key]))) * 1.08);
  const ys = (v) => T + ph - (v / max) * ph;
  const gw = pw / groups.length, bw = 46, gap = 2, inner = LIBS.length * bw + (LIBS.length - 1) * gap;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  for (const t of ticks(max)) {
    s += `<line x1="${L}" x2="${W - R}" y1="${ys(t)}" y2="${ys(t)}" stroke="${t === 0 ? C.axis : C.grid}" stroke-width="1"/>`;
    s += `<text x="${L - 10}" y="${ys(t) + 5}" text-anchor="end" class="tick">${fmt(t, t % 1 ? 1 : 0)}${unit}</text>`;
  }
  groups.forEach((g, gi) => {
    const x0 = L + gi * gw + (gw - inner) / 2;
    LIBS.forEach((l, li) => {
      const v = g.values[l.key], x = x0 + li * (bw + gap), h = (v / max) * ph;
      s += `<path d="${vbar(x, T + ph, bw, h)}" fill="${l.color}"/>`;
      s += `<text x="${x + bw / 2}" y="${T + ph - h - 8}" text-anchor="middle" class="val">${fmt(v, decimals)}</text>`;
    });
    s += `<text x="${L + gi * gw + gw / 2}" y="${H - 18}" text-anchor="middle" class="cat">${esc(g.label)}</text>`;
  });
  return s + '</svg>';
}

// one horizontal-bar small multiple
// rowH/gap shrink the bars; mark draws a dot before the best value(s) (ties at the printed precision)
function hpanel({ title, sub, values, decimals, unit = '', width = 530, best = 'min', rowH = 34, gap = 10, mark = false }) {
  const labW = 0, T = 8, W = width, R = mark ? 84 : 70;
  const H = T + LIBS.length * (rowH + gap);
  const max = Math.max(...LIBS.map((l) => values[l.key]));
  const pw = W - labW - R;
  const bestV = best === 'min' ? Math.min(...LIBS.map((l) => values[l.key])) : Math.max(...LIBS.map((l) => values[l.key]));
  let s = `<div class="panel"><div class="ptitle">${esc(title)}</div><div class="psub">${esc(sub)}</div><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  s += `<line x1="${labW}" x2="${labW}" y1="0" y2="${H - gap + 2}" stroke="${C.axis}"/>`;
  LIBS.forEach((l, i) => {
    const v = values[l.key], y = T + i * (rowH + gap), w = Math.max(3, (v / max) * pw);
    s += `<path d="${hbar(labW, y, w, rowH)}" fill="${l.color}"/>`;
    const isBest = mark ? v.toFixed(decimals) === bestV.toFixed(decimals) : v === bestV;
    if (mark && isBest) s += `<circle cx="${labW + w + 15}" cy="${y + rowH / 2}" r="4" fill="${C.ink}"/>`;
    s += `<text x="${labW + w + (mark && isBest ? 26 : 10)}" y="${y + rowH / 2 + (mark ? 5 : 6)}" class="val${isBest ? ' best' : ''}">${fmt(v, decimals)}${unit}</text>`;
  });
  return s + '</svg></div>';
}

function card({ id, title, sub, body, note, cls = '', src }) {
  return `<section class="card${cls}" id="${id}"><header><h1>${esc(title)}</h1><p>${sub}</p></header>${legend()}${body}${note ? `<footer>${note}</footer>` : ''}<div class="src">${src ?? `Benchmark haxlite · ${RUN_DATE} · misma máquina y sesión (4 vCPU, Node 22) · mediana de 3 repeticiones intercaladas · clientes reales en procesos aparte · paquete minificado`}</div></section>`;
}


// ---- data: read the quick/unified result files -------------------------------------------
const { readFileSync } = await import('node:fs');
const RES = process.argv[3] ?? 'bench/results/quick';
const IMPL = { 'haxlite:rtc': 'rtc', 'haxlite:ndc': 'ndc', official: 'off', nodehaxball: 'nh', 'haxlite:rtc@bun': 'rtcbun' };
function load(name) {
  const j = JSON.parse(readFileSync(`${RES}-${name}.json`, 'utf8'));
  const out = {};
  // spec.runtime (bench --runtime) is absent in results older than it: Node
  for (const c of j.configs) out[IMPL[c.spec.runtime === 'bun' ? `${c.spec.impl}@bun` : c.spec.impl]] = c.summary;
  return (metric, scale = 1) => Object.fromEntries(Object.entries(out).map(([k, s]) => [k, s[metric].median * scale]));
}
const RUN_INFO = JSON.parse(readFileSync(`${RES}-game.json`, 'utf8')).info;
const RUN_DATE = (() => {
  const d = new Date(RUN_INFO.date);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
})();
const game = load('game'), rooms = load('rooms'), idle = load('idle'), startup = load('startup');
const pct = (a, b) => Math.round((1 - a / b) * 100);
const cg = game('cpuPct'), cr = rooms('cpuPct');

const cpu = groups => grouped({ groups, unit: '%', decimals: 1 });
const cards = [];

cards.push(card({
  id: 'cpu',
  title: 'CPU del host',
  sub: '% de un núcleo de CPU que usa el proceso del host · <b>menos es mejor</b>',
  body: cpu([
    { label: 'Una sala con 20 jugadores', values: cg },
    { label: '10 salas × 4 jugadores (un proceso)', values: cr },
  ]),
  note: `Con 20 jugadores, haxlite con WebRTC propio usa <b>${pct(cg.rtc, cg.off)} % menos CPU</b> que el host oficial (haxball.js) y <b>${pct(cg.rtc, cg.nh)} % menos</b> que node-haxball. Con 10 salas, <b>${pct(cr.rtc, cr.off)} % menos</b> que el oficial.`,
}));

cards.push(card({
  id: 'p20',
  title: 'Una sala con 20 jugadores',
  sub: 'Cada métrica con su propia escala · <b>menos es mejor</b> · en negrita el mejor',
  body: `<div class="grid">${[
    hpanel({ title: 'Memoria RAM (RSS)', sub: 'MB', values: game('rssMeanMB'), decimals: 1, unit: ' MB' }),
    hpanel({ title: 'Tiempo para entrar a la sala', sub: 'mediana, segundos', values: game('joinP50Ms', 1 / 1000), decimals: 2, unit: ' s' }),
    hpanel({ title: 'Hilos del proceso', sub: 'incluye los de Node.js', values: game('threadCount'), decimals: 0 }),
    hpanel({ title: 'Despertares por segundo', sub: 'veces que el proceso se despierta', values: game('wakeupsPerS'), decimals: 0 }),
  ].join('')}</div>`,
  note: 'El WebRTC propio corre entero en JavaScript, sin hilos nativos: menos RAM, ~8× menos despertares y los jugadores entran en la mitad de tiempo.',
}));

cards.push(card({
  id: 'gc',
  title: 'Recolector de basura y lag (20 jugadores)',
  sub: 'Pausas de JavaScript para liberar memoria y retraso del event loop · <b>menos es mejor</b>',
  body: `<div class="grid">${[
    hpanel({ title: 'Tiempo en GC', sub: 'ms por minuto', values: game('gcMsPerMin'), decimals: 1, unit: ' ms' }),
    hpanel({ title: 'Memoria JS (heap)', sub: 'MB', values: game('heapUsedMeanMB'), decimals: 1, unit: ' MB' }),
    hpanel({ title: 'Lag del event loop p99', sub: 'ms (un frame del juego = 16,7 ms)', values: game('eldP99'), decimals: 2, unit: ' ms' }),
    hpanel({ title: 'Pausas de GC', sub: 'por minuto', values: game('gcPerMin'), decimals: 0 }),
  ].join('')}</div>`,
  note: (() => {
    const lag = Object.entries(game('eldP99')).filter(([k]) => LIBS.some((l) => l.key === k)).map(([, v]) => v);
    const range = `Lag p99 entre ${fmt(Math.min(...lag), 2)} y ${fmt(Math.max(...lag), 2)} ms en todos: muy por debajo de un frame.`;
    return HAS_NDC
      ? `El WebRTC propio hace menos GC que haxball.js y node-haxball y usa menos memoria JS; haxlite + node-datachannel hace aún menos porque su red vive en código nativo (la basura que queda en el propio la crea el módulo UDP de Node por cada paquete recibido). ${range}`
      : `haxlite hace <b>${pct(game('gcMsPerMin').rtc, game('gcMsPerMin').off)} % menos tiempo de GC</b> que haxball.js y usa menos memoria JS que los otros dos. ${range}`;
  })(),
}));

cards.push(card({
  id: 'rooms',
  title: '10 salas en un mismo proceso (4 jugadores c/u)',
  sub: 'Cuánto cuesta escalar a muchas salas · <b>menos es mejor</b>',
  body: `<div class="grid three">${[
    hpanel({ title: 'Memoria RAM (RSS)', sub: 'MB', values: rooms('rssMeanMB'), decimals: 0, unit: ' MB', width: 340 }),
    hpanel({ title: 'Tiempo en GC', sub: 'ms por minuto', values: rooms('gcMsPerMin'), decimals: 0, unit: ' ms', width: 340 }),
    hpanel({ title: 'Sockets y archivos (fds)', sub: 'descriptores abiertos', values: rooms('fdCount'), decimals: 0, width: 340 }),
  ].join('')}</div>`,
  note: 'Con el WebRTC propio todas las salas comparten un solo socket UDP.',
}));

cards.push(card({
  id: 'idle',
  title: 'Sala vacía y arranque',
  sub: 'Costo de tener la sala abierta esperando gente, y tiempo hasta tener el link · <b>menos es mejor</b>',
  body: `<div class="grid three">${[
    hpanel({ title: 'CPU con la sala vacía', sub: '% de un núcleo', values: idle('cpuPct'), decimals: 2, unit: ' %', width: 340 }),
    hpanel({ title: 'Despertares/s con la sala vacía', sub: 'haxlite: ~0,3 = solo el medidor', values: idle('wakeupsPerS'), decimals: 1, width: 340 }),
    hpanel({ title: 'Arranque hasta el link', sub: 'ms desde que inicia el proceso', values: startup('processStartToLinkMs'), decimals: 0, unit: ' ms', width: 340 }),
  ].join('')}</div>`,
  note: (() => {
    const st = startup('processStartToLinkMs');
    const gain = Math.round(Math.min(st.off, st.nh) - (HAS_NDC ? Math.max(st.rtc, st.ndc) : st.rtc));
    return HAS_NDC
      ? `haxlite no tiene timers con la sala vacía. Las dos variantes de haxlite empatan en reposo y arrancan ~${gain} ms antes que las otras.`
      : `haxlite no tiene timers con la sala vacía (cero despertares propios) y arranca ~${gain} ms antes que las otras.`;
  })(),
}));

// ---- summary card: every key metric + headline gains of haxlite (rtc) over the official host ----
{
  // the summary always shows every library (rtcbun only when requested), whatever the 3rd-argument filter says
  const libsFilter = LIBS;
  LIBS = LIB_DEFS.filter((l) => l.key !== 'rtcbun' || libsFilter.some((x) => x.key === 'rtcbun'));
  const ghz = /@\s*([\d.]+)\s*GHz/.exec(RUN_INFO.cpu ?? '')?.[1];
  const machine = `${RUN_INFO.nproc} vCPU Xeon${ghz ? ' ' + fmt(+ghz, 2) + ' GHz' : ''}, Node ${String(RUN_INFO.node).replace(/^v(\d+).*/, '$1')}`;
  const reps = RUN_INFO.params?.REPS ?? 3;
  const sep = (t) => `<h2 class="sec">${t}</h2>`;
  const ratio1 = (r) => fmt(Math.round(r * 10) / 10, 1).replace(/,0$/, '');
  const mi = (n) => (n < 0 ? '+' : '−') + Math.abs(n) + ' %';
  // headline tiles, all computed from the results: haxlite (rtc) vs official (haxball.js)
  const tile = (big, label, a, b, f) => `<div class="tile"><div class="big">${big}</div><div class="tl">${label}</div><div class="td">${f(a)} frente a ${f(b)} del oficial</div></div>`;
  const less = (label, v, d, u) => tile(mi(pct(v.rtc, v.off)), label, v.rtc, v.off, (x) => fmt(x, d) + u);
  const fast = (label, labelFallback, v, d, u) => {
    const r = v.off / v.rtc;
    return r >= 1.5 ? tile(`${ratio1(r)}×`, label, v.rtc, v.off, (x) => fmt(x, d) + u) : less(labelFallback, v, d, u);
  };
  const st = startup('processStartToLinkMs');
  const heads = [
    less('de CPU con 20 jugadores', game('cpuPct'), 1, ' %'),
    less('de CPU con 10 salas', rooms('cpuPct'), 1, ' %'),
    less('de RAM con 20 jugadores', game('rssMeanMB'), 0, ' MB'),
    fast('más rápido al entrar a la sala', 'de tiempo para entrar a la sala', game('joinP50Ms', 1 / 1000), 2, ' s'),
    fast('menos despertares por segundo', 'de despertares por segundo', game('wakeupsPerS'), 0, ''),
    less('de tiempo en GC', game('gcMsPerMin'), 0, ' ms/min'),
    less('de hilos del proceso', game('threadCount'), 0, ''),
    less('de tiempo de arranque hasta el link', st, 0, ' ms'),
  ];
  const P = (o) => hpanel({ width: 312, rowH: 24, gap: 8, mark: true, ...o });
  const body = `<div class="heads">${heads.join('')}</div><div class="subcap">Titulares: haxlite con WebRTC propio frente al host oficial (haxball.js), en las mismas condiciones.</div>
${sep('Una sala con 20 jugadores')}<div class="grid four">${[
    P({ title: 'CPU del host', sub: '% de un núcleo', values: game('cpuPct'), decimals: 1, unit: ' %' }),
    P({ title: 'Memoria RAM (RSS)', sub: 'MB', values: game('rssMeanMB'), decimals: 1, unit: ' MB' }),
    P({ title: 'Tiempo para entrar', sub: 'mediana, segundos', values: game('joinP50Ms', 1 / 1000), decimals: 2, unit: ' s' }),
    P({ title: 'Hilos del proceso', sub: 'incluye los de Node.js', values: game('threadCount'), decimals: 0 }),
    P({ title: 'Despertares por segundo', sub: 'veces que el proceso se despierta', values: game('wakeupsPerS'), decimals: 0 }),
    P({ title: 'Tiempo en GC', sub: 'ms por minuto', values: game('gcMsPerMin'), decimals: 1, unit: ' ms' }),
    P({ title: 'Memoria JS (heap)', sub: 'MB', values: game('heapUsedMeanMB'), decimals: 1, unit: ' MB' }),
    P({ title: 'Lag del event loop p99', sub: 'ms (un frame = 16,7 ms)', values: game('eldP99'), decimals: 2, unit: ' ms' }),
  ].join('')}</div>
${sep('10 salas en un mismo proceso (4 jugadores c/u)')}<div class="grid four">${[
    P({ title: 'CPU del host', sub: '% de un núcleo', values: rooms('cpuPct'), decimals: 1, unit: ' %' }),
    P({ title: 'Memoria RAM (RSS)', sub: 'MB', values: rooms('rssMeanMB'), decimals: 0, unit: ' MB' }),
    P({ title: 'Tiempo en GC', sub: 'ms por minuto', values: rooms('gcMsPerMin'), decimals: 0, unit: ' ms' }),
    P({ title: 'Sockets y archivos (fds)', sub: 'descriptores abiertos', values: rooms('fdCount'), decimals: 0 }),
  ].join('')}</div>
${sep('Sala vacía y arranque')}<div class="grid four">${[
    P({ title: 'CPU con la sala vacía', sub: '% de un núcleo', values: idle('cpuPct'), decimals: 2, unit: ' %' }),
    P({ title: 'Despertares/s, sala vacía', sub: 'haxlite: ~0,3 = solo el medidor', values: idle('wakeupsPerS'), decimals: 1 }),
    P({ title: 'Arranque hasta el link', sub: 'ms desde que inicia el proceso', values: startup('processStartToLinkMs'), decimals: 0, unit: ' ms' }),
    '<div class="how"><b>Cómo leerlo</b><br>Barra más corta = mejor. <i class="dot"></i> marca el mejor valor de cada métrica. Cada métrica tiene su propia escala.</div>',
  ].join('')}</div>`;
  cards.unshift(card({
    id: 'all',
    cls: ' wide all',
    title: 'haxlite frente a las demás librerías: comparativa completa',
    sub: 'Todas las métricas del benchmark en una sola imagen · <b>menos es mejor</b> en todas',
    body,
    src: `Benchmark haxlite · ${RUN_DATE} · misma máquina y sesión (${machine}) · mediana de ${reps} repeticiones intercaladas · clientes reales en procesos aparte · paquete minificado`,
  }));
  LIBS = libsFilter;
}

const stack = [
  ['off', 'haxball.js 5.1.0', '@webrtc-node/webrtc 0.2.1', 'libdatachannel (master, ~0.24.5) · libjuice 1.7.2 · OpenSSL 1.1.1w · usrsctp', '18 hilos con jugadores · 1 socket UDP por jugador', 'Cualquier red, también detrás de NAT'],
  ['nh', 'node-haxball 2.3.1', 'node-datachannel 0.25.0 (copia propia)', 'libdatachannel 0.22.2 · libjuice 1.5.7 · OpenSSL 1.1.1w · usrsctp', '15 hilos · 1 socket UDP por jugador', 'Cualquier red'],
  ['ndc', 'haxlite + node-datachannel', 'node-datachannel 0.33.4', 'libdatachannel 0.24.5 · libjuice 1.7.2 · OpenSSL 1.1.1w · usrsctp', '19 hilos (se liberan con la sala vacía) · 1 socket UDP para todos', 'Cualquier red'],
  ['rtc', 'haxlite + WebRTC propio', 'ninguno: haxlite-rtc (TypeScript)', 'ICE completo (STUN, comprobaciones propias), DTLS 1.2 (ChaCha20-Poly1305 en JS) y SCTP propios', '0 hilos nativos · 1 socket UDP para todas las salas', 'Cualquier red, también detrás de NAT (sin TURN)'],
];
cards.push(`<section class="card wide" id="stack"><header><h1>Qué WebRTC usa cada librería</h1><p>${HAS_NDC ? 'Los tres primeros usan por dentro <b>la misma librería nativa</b> (libdatachannel) en distintas versiones; haxlite puede usar la suya propia' : 'haxball.js y node-haxball usan por dentro <b>la misma librería nativa</b> (libdatachannel) en distintas versiones; haxlite usa la suya propia, sin código nativo'}</p></header>
<table><thead><tr><th>Librería</th><th>Paquete WebRTC</th><th>Por dentro (ICE · DTLS · SCTP)</th><th>Hilos y sockets</th><th>Dónde funciona</th></tr></thead><tbody>
${stack
  .filter((r) => LIBS.some((l) => l.key === r[0]))
  .map((r) => `<tr><td><span class="sw" style="background:${LIBS.find((l) => l.key === r[0]).color}"></span><b>${esc(r[1])}</b></td>${r.slice(2).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
  .join('')}
</tbody></table><div class="src">Versiones verificadas en node_modules y en los binarios .node · Benchmark haxlite · ${RUN_DATE}</div></section>`);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box} body{margin:0;background:#e9e8e4;font-family:Inter,system-ui,sans-serif;color:${C.ink};-webkit-font-smoothing:antialiased}
.card{width:1200px;background:${C.surface};padding:44px 40px 28px;margin:0 0 24px}
.card.wide{width:1400px}
header h1{margin:0;font:700 34px/1.15 'Inter Display',Inter,sans-serif;letter-spacing:-.01em}
header p{margin:8px 0 0;font-size:18px;color:${C.ink2}}
.legend{display:flex;flex-wrap:wrap;gap:10px 26px;margin:22px 0 18px;font-size:16px;color:${C.ink2}}
.legend span{display:inline-flex;align-items:center;gap:8px} .legend i{width:14px;height:14px;border-radius:3px;display:inline-block}
.tick{font-size:14px;fill:${C.ink3}} .cat{font-size:16px;fill:${C.ink};font-weight:600} .val{font-size:14px;fill:${C.ink2};font-weight:600}
.val.best{fill:${C.ink};font-weight:700}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:28px 40px}.grid.three{grid-template-columns:1fr 1fr 1fr;gap:28px 30px}
.ptitle{font-size:18px;font-weight:700}.psub{font-size:14px;color:${C.ink3};margin:2px 0 10px}
footer{margin-top:20px;padding:14px 16px;background:#f0efec;border-radius:8px;font-size:16px;line-height:1.45;color:${C.ink}}
.src{margin-top:14px;font-size:12.5px;color:${C.ink3}}
table{width:100%;border-collapse:collapse;margin-top:22px;font-size:15px;line-height:1.4}
th{text-align:left;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:${C.ink3};padding:0 14px 10px;border-bottom:1px solid ${C.axis}}
td{padding:14px;border-bottom:1px solid ${C.grid};vertical-align:top;color:${C.ink2}} td:first-child{color:${C.ink};white-space:nowrap}
.heads{display:grid;grid-template-columns:repeat(4,1fr);gap:14px 16px;margin-bottom:8px}
.tile{background:#f0efec;border-radius:10px;padding:14px 16px 12px;border-left:5px solid ${LIB_DEFS[0].color}}
.big{font:700 38px/1.05 'Inter Display',Inter,sans-serif;letter-spacing:-.02em}
.tl{font-size:16px;font-weight:600;margin-top:4px;line-height:1.25}.td{font-size:13px;color:${C.ink3};margin-top:4px}
.subcap{font-size:13px;color:${C.ink3};margin:2px 0 4px}
.sec{font:700 22px/1.2 'Inter Display',Inter,sans-serif;margin:22px 0 12px;padding-top:14px;border-top:1px solid ${C.grid}}
.grid.four{grid-template-columns:repeat(4,312px);gap:18px 24px}.all .ptitle{font-size:16px}.all .psub{font-size:13px;margin-bottom:6px}
.all .val{font-size:13px}
.how{align-self:center;font-size:14px;line-height:1.5;color:${C.ink2};background:#f0efec;border-radius:8px;padding:12px 14px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:${C.ink}}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:-1px}
</style></head><body>${cards.join('\n')}</body></html>`;
writeFileSync(`${OUT}/charts.html`, html);

const browserPath = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!browserPath) {
  console.log(`no browser found (set CHROME_PATH): wrote only ${OUT}/charts.html`);
  process.exit(0);
}
const browser = await chromium.launch({ executablePath: browserPath });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
await page.setContent(html);
// optional: INTER_FONT=<variable Inter .woff2> renders with Inter when it is not installed
if (process.env.INTER_FONT && existsSync(process.env.INTER_FONT)) {
  const b64 = readFileSync(process.env.INTER_FONT).toString('base64');
  const face = (n) => `@font-face{font-family:'${n}';font-weight:100 900;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  await page.addStyleTag({ content: face('Inter') + face('Inter Display') });
}
await page.evaluate(() => document.fonts.ready);
const names = { all: '0-comparativa-completa', cpu: '1-cpu', p20: '2-sala-20-jugadores', gc: '3-gc-y-lag', rooms: '4-diez-salas', idle: '5-sala-vacia-y-arranque', stack: '6-webrtc-por-libreria' };
for (const [id, name] of Object.entries(names)) await page.locator(`#${id}`).screenshot({ path: `${OUT}/${name}.png` });
await browser.close();
console.log('ok');
