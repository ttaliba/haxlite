// Generates benchmark chart cards (HTML/SVG) and screenshots each one as a PNG.
// Usage: node bench/charts.mjs docs/img/benchmark   (needs the Playwright Chromium in /opt/pw-browsers)
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/user/rev-eng-haxball/package.json');
const { chromium } = require('playwright-core');

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

const C = { surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', ink3: '#7d7c77', grid: '#e9e8e4', axis: '#c9c8c2' };
const LIBS = [
  { key: 'rtc', name: 'haxlite + WebRTC propio', color: '#2a78d6' },
  { key: 'ndc', name: 'haxlite + node-datachannel', color: '#eb6834' },
  { key: 'off', name: 'haxball.js (oficial)', color: '#1baf7a' },
  { key: 'nh', name: 'node-haxball', color: '#eda100' },
];
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
function hpanel({ title, sub, values, decimals, unit = '', width = 530, best = 'min' }) {
  const rowH = 34, gap = 10, labW = 0, T = 8, W = width, R = 70;
  const H = T + LIBS.length * (rowH + gap);
  const max = Math.max(...LIBS.map((l) => values[l.key]));
  const pw = W - labW - R;
  const bestV = best === 'min' ? Math.min(...LIBS.map((l) => values[l.key])) : Math.max(...LIBS.map((l) => values[l.key]));
  let s = `<div class="panel"><div class="ptitle">${esc(title)}</div><div class="psub">${esc(sub)}</div><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  s += `<line x1="${labW}" x2="${labW}" y1="0" y2="${H - gap + 2}" stroke="${C.axis}"/>`;
  LIBS.forEach((l, i) => {
    const v = values[l.key], y = T + i * (rowH + gap), w = Math.max(3, (v / max) * pw);
    s += `<path d="${hbar(labW, y, w, rowH)}" fill="${l.color}"/>`;
    s += `<text x="${labW + w + 10}" y="${y + rowH / 2 + 6}" class="val${v === bestV ? ' best' : ''}">${fmt(v, decimals)}${unit}</text>`;
  });
  return s + '</svg></div>';
}

function card({ id, title, sub, body, note }) {
  return `<section class="card" id="${id}"><header><h1>${esc(title)}</h1><p>${sub}</p></header>${legend()}${body}${note ? `<footer>${note}</footer>` : ''}<div class="src">Benchmark haxlite · 11-10-2026 · misma máquina y sesión (4 vCPU, Node 22) · mediana de 3 repeticiones · clientes reales en procesos aparte</div></section>`;
}

const cpu = groups => grouped({ groups, unit: '%', decimals: 1 });
const cards = [];

cards.push(card({
  id: 'cpu',
  title: 'CPU del host con jugadores',
  sub: '% de un núcleo de CPU que usa el proceso del host · <b>menos es mejor</b>',
  body: cpu([
    { label: '4 jugadores', values: { rtc: 2.0, ndc: 2.59, off: 2.85, nh: 3.42 } },
    { label: '10 jugadores', values: { rtc: 3.56, ndc: 5.13, off: 5.81, nh: 6.41 } },
    { label: '20 jugadores', values: { rtc: 7.79, ndc: 11.95, off: 13.52, nh: 15.1 } },
    { label: '10 salas × 4 jugadores', values: { rtc: 9.13, ndc: 15.79, off: 19.89, nh: 20.37 } },
  ]),
  note: 'Con 20 jugadores, haxlite con WebRTC propio usa <b>42 % menos CPU</b> que el host oficial y <b>48 % menos</b> que node-haxball. Con 10 salas, <b>54 % menos</b> que el oficial.',
}));

cards.push(card({
  id: 'p20',
  title: 'Una sala con 20 jugadores',
  sub: 'Cuatro métricas por separado (cada una con su propia escala) · <b>menos es mejor</b>',
  body: `<div class="grid">${[
    hpanel({ title: 'Despertares por segundo', sub: 'veces que el proceso se despierta', values: { rtc: 509, ndc: 4138, off: 4331, nh: 4375 }, decimals: 0 }),
    hpanel({ title: 'Tiempo para entrar a la sala', sub: 'mediana, segundos', values: { rtc: 1.059, ndc: 2.055, off: 2.057, nh: 2.06 }, decimals: 2, unit: ' s' }),
    hpanel({ title: 'Hilos del proceso', sub: 'incluye los de Node.js', values: { rtc: 11, ndc: 19, off: 18, nh: 15 }, decimals: 0 }),
    hpanel({ title: 'Memoria RAM (RSS)', sub: 'MB', values: { rtc: 88.7, ndc: 83.3, off: 85.3, nh: 92.4 }, decimals: 1, unit: ' MB' }),
  ].join('')}</div>`,
  note: 'El WebRTC propio corre entero en JavaScript, sin hilos nativos: se despierta ~8× menos y los jugadores entran en la mitad de tiempo. La RAM es parecida en los cuatro (la domina Node.js).',
}));

cards.push(card({
  id: 'rooms',
  title: '10 salas en un mismo proceso (4 jugadores c/u)',
  sub: 'Cuánto cuesta escalar a muchas salas · <b>menos es mejor</b>',
  body: `<div class="grid three">${[
    hpanel({ title: 'CPU', sub: '% de un núcleo', values: { rtc: 9.13, ndc: 15.79, off: 19.89, nh: 20.37 }, decimals: 1, unit: ' %', width: 340 }),
    hpanel({ title: 'Memoria RAM (RSS)', sub: 'MB', values: { rtc: 79.3, ndc: 90.9, off: 104.8, nh: 103.0 }, decimals: 0, unit: ' MB', width: 340 }),
    hpanel({ title: 'Pausas del GC', sub: 'por minuto', values: { rtc: 103, ndc: 22, off: 237, nh: 154 }, decimals: 0, width: 340 }),
  ].join('')}</div>`,
  note: 'Las dos variantes de haxlite usan 12–25 MB menos de RAM y bastante menos recolección de basura que haxball.js y node-haxball.',
}));

cards.push(card({
  id: 'idle',
  title: 'Sala pública vacía (0 jugadores)',
  sub: 'Lo que cuesta tener la sala abierta esperando gente · <b>menos es mejor</b>',
  body: `<div class="grid">${[
    hpanel({ title: 'CPU', sub: '% de un núcleo', values: { rtc: 0.009, ndc: 0.01, off: 0.337, nh: 0.632 }, decimals: 3, unit: ' %' }),
    hpanel({ title: 'Despertares por segundo', sub: 'haxlite: 0,2 = solo el medidor del benchmark', values: { rtc: 0.2, ndc: 0.2, off: 20.5, nh: 81 }, decimals: 1 }),
  ].join('')}</div>`,
  note: 'haxlite no tiene timers cuando la sala está vacía: ~35× menos CPU que el oficial y ~65× menos que node-haxball. Las dos variantes de haxlite empatan.',
}));

const stack = [
  ['haxball.js 5.1.0', '@webrtc-node/webrtc 0.2.1', 'libdatachannel (master, ~0.24.5) · libjuice 1.7.2 · OpenSSL 1.1.1w · usrsctp', '18 hilos con jugadores · 1 socket UDP por jugador', 'Cualquier red, también detrás de NAT'],
  ['node-haxball 2.3.1', 'node-datachannel 0.25.0 (copia propia)', 'libdatachannel 0.22.2 · libjuice 1.5.7 · OpenSSL 1.1.1w · usrsctp', '15 hilos · 1 socket UDP por jugador', 'Cualquier red'],
  ['haxlite + node-datachannel', 'node-datachannel 0.33.4', 'libdatachannel 0.24.5 · libjuice 1.7.2 · OpenSSL 1.1.1w · usrsctp', '19 hilos (se liberan con la sala vacía) · 1 socket UDP para todos', 'Cualquier red'],
  ['haxlite + WebRTC propio', 'ninguno: haxlite-rtc (TypeScript)', 'ICE-lite, DTLS 1.2 y SCTP propios · cifrado con node:crypto (OpenSSL 3.5)', '0 hilos nativos · 1 socket UDP para todos', 'Servidor con IP pública (dedicado, VPS) o detrás del edge'],
];
cards.push(`<section class="card wide" id="stack"><header><h1>Qué WebRTC usa cada librería</h1><p>Los tres primeros usan por dentro <b>la misma librería nativa</b> (libdatachannel) en distintas versiones; haxlite puede usar la suya propia</p></header>
<table><thead><tr><th>Librería</th><th>Paquete WebRTC</th><th>Por dentro (ICE · DTLS · SCTP)</th><th>Hilos y sockets</th><th>Dónde funciona</th></tr></thead><tbody>
${stack.map((r, i) => `<tr><td><span class="sw" style="background:${LIBS[[2, 3, 1, 0][i]].color}"></span><b>${esc(r[0])}</b></td>${r.slice(1).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
</tbody></table><div class="src">Versiones verificadas en node_modules y en los binarios .node · Benchmark haxlite · 11-10-2026</div></section>`);

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
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:-1px}
</style></head><body>${cards.join('\n')}</body></html>`;
writeFileSync(`${OUT}/charts.html`, html);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const names = { cpu: '1-cpu-con-jugadores', p20: '2-sala-20-jugadores', rooms: '3-diez-salas', idle: '4-sala-vacia', stack: '5-webrtc-por-libreria' };
for (const [id, name] of Object.entries(names)) await page.locator(`#${id}`).screenshot({ path: `${OUT}/${name}.png` });
await browser.close();
console.log('ok');
