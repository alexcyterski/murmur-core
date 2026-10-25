import { LineChart, sparkline } from './chart.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() / 1000;
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  nodes: new Map(),
  settings: null,
  meta: {},
  wsOk: false,
  spark: new Map(), // id -> { points, since, until, at, range }
  page: { name: null },
};

const INTERVALS = [2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const RANGES = ['1h', '6h', '24h', '7d', '30d', '90d'];
const ACCENTS = [
  ['#3e6ae1', 'Blue'], ['#e8eaed', 'Silver'], ['#e82127', 'Red'],
  ['#2fbf71', 'Green'], ['#f2a93b', 'Amber'], ['#9b6bff', 'Violet'],
];
const PRESSURE = { hPa: 1, kPa: 0.1, inHg: 0.0295299830714, mmHg: 0.750061683 };
const P_DIGITS = { hPa: 1, kPa: 2, inHg: 2, mmHg: 1 };

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
};

// ---------------------------------------------------------------------------
// Units & formatting
// ---------------------------------------------------------------------------
const S = () => state.settings;
const U = {
  t: (c) => (c == null ? null : S().temp_unit === 'F' ? c * 9 / 5 + 32 : c),
  tBack: (v) => (v == null ? null : S().temp_unit === 'F' ? (v - 32) * 5 / 9 : v),
  tDelta: (c) => (S().temp_unit === 'F' ? c * 9 / 5 : c),
  tDeltaBack: (v) => (S().temp_unit === 'F' ? v * 5 / 9 : v),
  tUnit: () => (S().temp_unit === 'F' ? '°F' : '°C'),
  p: (h) => (h == null ? null : h * PRESSURE[S().pressure_unit]),
  pDelta: (h) => h * PRESSURE[S().pressure_unit],
  pDeltaBack: (v) => v / PRESSURE[S().pressure_unit],
  pUnit: () => S().pressure_unit,
  pDigits: () => P_DIGITS[S().pressure_unit],
};
// U+2212 minus reads better than a hyphen at light font weights
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d).replace(/^-/, '\u2212'));
const dbm = (v) => (v == null ? '—' : String(v).replace(/^-/, '\u2212'));
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function dewPoint(t, h) {
  if (t == null || h == null || h <= 0) return null;
  const a = 17.62, b = 243.12;
  const g = Math.log(h / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, now() - ts);
  if (s < 5) return 'now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function duration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

const intervalLabel = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${+(s / 60).toFixed(1)}m` : `${+(s / 3600).toFixed(1)}h`);
const hour12 = () => S().time_format === '12h';
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: hour12() });
const dateShort = (ts) => new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
const dateTime = (ts) => (ts ? `${dateShort(ts)}, ${clock(ts)}` : '—');
const axisTime = (ts, span) => (span <= 2 * 86400 ? clock(ts) : dateShort(ts));
const tipTime = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: hour12() });

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Still up?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function signal(rssi) {
  if (rssi == null) return { bars: 0, label: '—' };
  if (rssi >= -55) return { bars: 4, label: 'Excellent' };
  if (rssi >= -65) return { bars: 3, label: 'Good' };
  if (rssi >= -75) return { bars: 2, label: 'Fair' };
  return { bars: 1, label: 'Weak' };
}
const barsHtml = (n) => `<span class="bars" aria-hidden="true">${[4, 7, 10, 12].map((h, i) => `<i class="${i < n ? 'on' : ''}" style="height:${h}px"></i>`).join('')}</span>`;

const humidityLabel = (h) => (h == null ? '' : h < 30 ? 'Dry' : h <= 60 ? 'Comfortable' : h <= 70 ? 'Humid' : 'Very humid');
const dewLabel = (d) => (d == null ? '' : d < 10 ? 'Crisp' : d < 16 ? 'Comfortable' : d < 18 ? 'Sticky' : d < 21 ? 'Muggy' : 'Oppressive');

function alertsFor(n) {
  const out = [];
  const { alerts: a, last: l } = n;
  const T = (c) => `${num(U.t(c))}°`;
  if (l.t != null && a.t_max != null && l.t > a.t_max) out.push({ dir: 'up', text: `Above ${T(a.t_max)}` });
  if (l.t != null && a.t_min != null && l.t < a.t_min) out.push({ dir: 'down', text: `Below ${T(a.t_min)}` });
  if (l.h != null && a.h_max != null && l.h > a.h_max) out.push({ dir: 'up', text: `RH above ${num(a.h_max, 0)}%` });
  if (l.h != null && a.h_min != null && l.h < a.h_min) out.push({ dir: 'down', text: `RH below ${num(a.h_min, 0)}%` });
  return out;
}

const sensorLabel = (s) => (s ? s.toUpperCase().replace('+', ' + ') : 'Unknown sensor');

// ---------------------------------------------------------------------------
// API, toast, theme
// ---------------------------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === 'string' ? j.detail : (j.detail?.[0]?.msg ?? msg);
    } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', err);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function applyTheme() {
  const s = S();
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--accent', s.accent);
  const n = parseInt(s.accent.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  root.style.setProperty('--accent-ink', lum > 0.6 ? '#111318' : '#ffffff');
  requestAnimationFrame(() => {
    $('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#0a0b0d';
    state.page.chart?.draw();
  });
}

function renderLink() {
  const el = $('#link-state');
  const dot = $('.dot', el), label = $('span', el);
  let cls = '', text = 'Reconnecting';
  if (state.wsOk && state.meta.mqtt) { cls = 'on'; text = 'MQTT · Live'; }
  else if (state.wsOk && state.meta.demo) { cls = 'warn'; text = 'Demo mode'; }
  else if (state.wsOk) { cls = 'off'; text = 'Broker offline'; }
  dot.className = `dot ${cls}`;
  label.textContent = text;
  el.classList.toggle('live', cls === 'on');
}

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let ping;
  ws.onopen = () => {
    state.wsOk = true;
    renderLink();
    ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000);
  };
  ws.onclose = () => {
    state.wsOk = false;
    clearInterval(ping);
    renderLink();
    setTimeout(connect, 2500);
  };
  ws.onmessage = (e) => {
    try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
}

function handle(msg) {
  const page = state.page;
  switch (msg.type) {
    case 'hello':
      state.nodes = new Map(msg.nodes.map((n) => [n.id, n]));
      state.settings = msg.settings;
      state.meta = { ...state.meta, ...msg.meta };
      applyTheme();
      renderLink();
      if (page.name === 'dash') renderDash();
      else if (page.name === 'node') updateNodeLive();
      break;
    case 'reading':
    case 'node': {
      const isNew = !state.nodes.has(msg.node.id);
      state.nodes.set(msg.node.id, msg.node);
      if (page.name === 'dash') {
        if (isNew) renderDash();
        else updateCard(msg.node);
      } else if (page.name === 'node' && page.id === msg.node.id) {
        updateNodeLive();
        if (msg.type === 'reading') pushLivePoint(msg.node);
      }
      break;
    }
    case 'removed':
      state.nodes.delete(msg.id);
      state.spark.delete(msg.id);
      if (page.name === 'dash') renderDash();
      else if (page.name === 'node' && page.id === msg.id) location.hash = '#/';
      break;
    case 'settings':
      state.settings = msg.settings;
      applyTheme();
      if (page.name === 'dash') renderDash();
      else if (page.name === 'settings') renderSettings();
      else if (page.name === 'node') { updateNodeLive(); drawChart(); }
      break;
    case 'meta':
      state.meta = { ...state.meta, ...msg.meta };
      renderLink();
      if (page.name === 'node') updateNodeLive();
      break;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function route() {
  state.page.chart?.destroy();
  clearInterval(state.page.timer);
  clearInterval(state.page.reload);
  const h = location.hash.slice(1) || '/';
  if (h.startsWith('/node/')) renderNode(decodeURIComponent(h.slice(6)));
  else if (h === '/settings') renderSettings();
  else renderDash();
  const nav = state.page.name === 'settings' ? 'settings' : 'dash';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function sortedNodes() {
  const list = [...state.nodes.values()];
  const by = S().sort_by;
  const cmpName = (a, b) => a.name.localeCompare(b.name);
  if (by === 'location') return list.sort((a, b) => a.location.localeCompare(b.location) || cmpName(a, b));
  if (by === 'temperature') return list.sort((a, b) => (b.last.t ?? -999) - (a.last.t ?? -999));
  if (by === 'recent') return list.sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));
  return list.sort(cmpName);
}

function heroHtml(nodes) {
  const live = nodes.filter((n) => n.online && n.last.t != null);
  const temps = live.map((n) => n.last.t);
  const hums = live.map((n) => n.last.h).filter((v) => v != null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const hAvg = avg(hums);
  const lo = temps.length ? Math.min(...temps) : null, hi = temps.length ? Math.max(...temps) : null;
  return `
    <div>
      <div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div class="big">${greeting()}</div>
      <div class="caption">${!nodes.length ? 'No nodes yet' : live.length === nodes.length ? `All ${nodes.length} node${nodes.length === 1 ? ' is' : 's are'} reporting` : `${live.length} of ${nodes.length} nodes reporting`}</div>
    </div>
    <div class="summary">
      <div><div class="k">Healthy</div><div class="v">${nodes.filter((n) => n.online).length}<small>/ ${nodes.length}</small></div></div>
      <div><div class="k">Humidity</div><div class="v">${num(hAvg, 0)}<small>%</small></div></div>
      <div><div class="k">Spread</div><div class="v">${lo == null ? '—' : `${num(U.t(lo))}–${num(U.t(hi))}`}<small>°</small></div></div>
    </div>`;
}

function cardHtml(n) {
  const sp = state.spark.get(n.id);
  const alerts = n.online ? alertsFor(n) : [];
  const dot = n.online ? 'on' : n.last_seen ? 'off' : '';
  const p = n.last.p;
  const dew = dewPoint(n.last.t, n.last.h);
  return `
  <a class="card node-card ${n.online ? '' : 'stale'} ${alerts.length ? 'alert' : ''}" href="#/node/${encodeURIComponent(n.id)}" data-id="${esc(n.id)}">
    <div class="top">
      <div>
        <div class="name">${esc(n.location || n.name)}</div>
        <div class="loc">${esc(n.location ? n.name : n.id)}</div>
      </div>
      ${alerts.length
        ? `<span class="chip warn">${ICON.alert}${esc(alerts[0].text)}</span>`
        : `<div class="seen"><i class="dot ${dot}"></i><span data-seen="${n.online && !n.sleeping ? n.last_seen ?? '' : ''}">${n.sleeping ? 'Sleeping' : n.online ? ago(n.last_seen) : 'Offline'}</span></div>`}
    </div>
    <div class="temp"><span>${num(U.t(n.last.t))}</span><span class="unit">${U.tUnit()}</span></div>
    <div class="metrics">
      <div class="metric"><div class="k">Humidity</div><div class="v">${num(n.last.h, 0)}<small>%</small></div></div>
      ${p != null
        ? `<div class="metric"><div class="k">Pressure</div><div class="v">${num(U.p(p), U.pUnit() === 'hPa' ? 0 : U.pDigits())}<small>${U.pUnit()}</small></div></div>`
        : `<div class="metric"><div class="k">Dew pt</div><div class="v">${num(U.t(dew))}<small>°</small></div></div>`}
      ${p != null
        ? `<div class="metric"><div class="k">Dew pt</div><div class="v">${num(U.t(dew))}<small>°</small></div></div>`
        : `<div class="metric"><div class="k">Signal</div><div class="v">${dbm(n.rssi)}<small>dBm</small></div></div>`}
    </div>
    ${sp ? sparkline(sp.points.map(([t, v]) => [t, U.t(v)]), sp.since, sp.until) : '<svg class="spark" viewBox="0 0 100 32" aria-hidden="true"></svg>'}
    <div class="foot"><span>${esc(sensorLabel(n.sensor))}</span><span>${n.interval ? `every ${intervalLabel(n.interval)}` : ''}</span></div>
  </a>`;
}

function emptyHtml() {
  const host = location.hostname || 'this-pi';
  return `
  <section class="card empty">
    <span class="mark" aria-hidden="true"></span>
    <div class="eyebrow">No nodes yet</div>
    <h2 style="margin-top:8px">Waiting for the first report</h2>
    <p>Nodes appear here automatically the moment they publish to the broker. To add one:</p>
    <ol>
      <li>Flash an ESP32-C3 with the <code>murmur-node</code> firmware.</li>
      <li>Join its Wi-Fi network <code>Murmur-XXXXXX</code> from your phone.</li>
      <li>Pick the sensor, enter your Wi-Fi, and set the broker to <code>${esc(host)}</code> port <code>1883</code>.</li>
    </ol>
  </section>`;
}

function renderDash() {
  state.page = { name: 'dash' };
  const view = $('#view');
  const nodes = sortedNodes();
  if (!nodes.length) {
    view.innerHTML = emptyHtml();
    return;
  }
  view.innerHTML = `
    <section class="dash-hero" id="dash-hero">${heroHtml(nodes)}</section>
    <div class="section-title"><h2>Nodes</h2><span class="mono faint">${nodes.length} REGISTERED · TREND ${S().spark_range.toUpperCase()}</span></div>
    <div class="grid" id="grid">${nodes.map(cardHtml).join('')}</div>
    <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
      <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--accent);stop-opacity:.28"/>
        <stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/>
      </linearGradient></defs></svg>`;
  loadSparks();
  state.page.timer = setInterval(() => {
    $$('[data-seen]').forEach((el) => { if (el.dataset.seen && el.textContent !== 'Offline') el.textContent = ago(+el.dataset.seen); });
    loadSparks();
  }, 5000);
}

function updateCard(n) {
  const el = $(`.node-card[data-id="${CSS.escape(n.id)}"]`);
  if (el) el.outerHTML = cardHtml(n);
  const hero = $('#dash-hero');
  if (hero) hero.innerHTML = heroHtml([...state.nodes.values()]);
}

async function loadSparks() {
  const range = S().spark_range;
  const stale = [...state.nodes.values()].filter((n) => {
    const sp = state.spark.get(n.id);
    return !sp || sp.range !== range || now() - sp.at > 120;
  });
  await Promise.all(stale.map(async (n) => {
    try {
      const h = await api(`/api/nodes/${encodeURIComponent(n.id)}/history?range=${range}&points=60`);
      state.spark.set(n.id, { points: h.points.map((p) => [p[0], p[1]]), since: h.since, until: h.until, at: now(), range });
      const el = $(`.node-card[data-id="${CSS.escape(n.id)}"] .spark`);
      const sp = state.spark.get(n.id);
      if (el) el.outerHTML = sparkline(sp.points.map(([t, v]) => [t, U.t(v)]), sp.since, sp.until);
    } catch { /* node may have been removed */ }
  }));
}

// ---------------------------------------------------------------------------
// Node detail
// ---------------------------------------------------------------------------
const G = { min: -10, max: 40, r: 84, cx: 100, cy: 100 };
const polar = (deg, r) => [G.cx + r * Math.cos((deg * Math.PI) / 180), G.cy + r * Math.sin((deg * Math.PI) / 180)];

function gaugeSvg() {
  const [sx, sy] = polar(135, G.r), [ex, ey] = polar(45, G.r);
  const ticks = [];
  for (let i = 0; i <= 50; i++) {
    const a = 135 + (270 * i) / 50;
    const major = i % 10 === 0;
    const [x1, y1] = polar(a, G.r + 9), [x2, y2] = polar(a, G.r + (major ? 15 : 12));
    ticks.push(`<line class="tick ${major ? 'major' : ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
  }
  const arc = `M${sx.toFixed(2)} ${sy.toFixed(2)} A${G.r} ${G.r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  return `
    <svg viewBox="0 0 200 200" role="img" aria-label="Temperature gauge">
      ${ticks.join('')}
      <path class="track" d="${arc}" pathLength="100"/>
      <path class="value" id="g-value" d="${arc}" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100"/>
      <circle class="knob" id="g-knob" r="6" cx="${sx.toFixed(2)}" cy="${sy.toFixed(2)}"/>
      <text class="scale" id="g-lo" x="${sx - 2}" y="${sy + 22}" text-anchor="middle"></text>
      <text class="scale" id="g-hi" x="${ex + 2}" y="${ey + 22}" text-anchor="middle"></text>
    </svg>`;
}

function nodeHtml(n) {
  const id = esc(n.id);
  const r = state.page.range;
  return `
  <a class="back" href="#/">${ICON.back}All nodes</a>
  <header class="node-head">
    <div>
      <div class="eyebrow">${id}</div>
      <h1 id="n-name">${esc(n.location || n.name)}</h1>
      <div class="sub" id="n-sub"></div>
    </div>
    <div class="head-actions">
      <button class="btn" data-cmd="identify" title="Blink the node's LED for 10 seconds">${ICON.pulse}Identify</button>
      <button class="btn" data-cmd="read" title="Take a reading now">${ICON.refresh}Read now</button>
    </div>
  </header>

  <section class="card hero">
    <div class="gauge-wrap">
      <div class="gauge">
        ${gaugeSvg()}
        <div class="readout">
          <div class="eyebrow">Temperature</div>
          <div class="t"><span id="g-temp">—</span><span class="unit" id="g-unit"></span></div>
          <div class="lbl eyebrow" id="g-sub"></div>
        </div>
      </div>
    </div>
    <div class="tiles" id="tiles"></div>
  </section>

  <section class="card chart-card">
    <div class="chart-head">
      <div class="seg" id="metric-seg">
        <button data-metric="t">Temperature</button>
        <button data-metric="h">Humidity</button>
        <button data-metric="p">Pressure</button>
      </div>
      <div class="seg mono" id="range-seg">
        ${RANGES.map((x) => `<button data-range="${x}" class="${x === r ? 'on' : ''}">${x.toUpperCase()}</button>`).join('')}
      </div>
    </div>
    <div class="chart-wrap" id="chart">
      <canvas aria-label="History chart"></canvas>
      <div class="tip"></div>
      <div class="chart-empty hidden">No readings in this window yet</div>
    </div>
    <div class="stats" id="stats"></div>
  </section>

  <div class="two-col">
    <section class="card card-pad">
      <h3>Device</h3>
      <div class="slider">
        <div class="slider-head">
          <div><div class="label">Report interval</div><div class="hint faint" id="iv-hint" style="font-size:12.5px">Pushed to the node over MQTT</div></div>
          <div class="val" id="iv-val"></div>
        </div>
        <input type="range" id="iv" min="0" max="${INTERVALS.length - 1}" step="1">
        <div class="ticks"><span>2s</span><span>30s</span><span>5m</span><span>1h</span></div>
      </div>
      <div class="row" style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px">
        <div><div class="label">Battery mode</div><div class="hint" id="battery-hint"></div></div>
        <label class="switch"><input type="checkbox" id="battery" aria-label="Battery mode"><span></span></label>
      </div>
      <div class="row" style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px">
        <div><div class="label">Status LED</div><div class="hint">Blink on every report</div></div>
        <label class="switch"><input type="checkbox" id="led"><span></span></label>
      </div>
      <div class="btn-row" style="margin-top:6px">
        <button class="btn danger" data-cmd="reboot">${ICON.power}Reboot node</button>
      </div>
      <dl class="kv" id="kv"></dl>
    </section>

    <section class="card card-pad">
      <h3>Configuration</h3>
      <form id="cfg" autocomplete="off">
        <div class="form-grid">
          <div class="field"><label for="f-name">Name</label><input class="input" id="f-name" name="name" maxlength="48" required></div>
          <div class="field"><label for="f-loc">Location</label><input class="input" id="f-loc" name="location" maxlength="48" placeholder="e.g. Upstairs"></div>
        </div>
        <div class="form-sub">Calibration offset</div>
        <div class="form-grid three">
          <div class="field"><label>Temp</label><div class="input-unit"><input class="input" name="t_off" type="number" step="0.1"><span data-u="t"></span></div></div>
          <div class="field"><label>Humidity</label><div class="input-unit"><input class="input" name="h_off" type="number" step="0.5"><span>%</span></div></div>
          <div class="field"><label>Pressure</label><div class="input-unit"><input class="input" name="p_off" type="number" step="0.1"><span data-u="p"></span></div></div>
        </div>
        <div class="form-sub">Alert thresholds</div>
        <div class="form-grid">
          <div class="field"><label>Temp min</label><div class="input-unit"><input class="input" name="t_min" type="number" step="0.5" placeholder="Off"><span data-u="t"></span></div></div>
          <div class="field"><label>Temp max</label><div class="input-unit"><input class="input" name="t_max" type="number" step="0.5" placeholder="Off"><span data-u="t"></span></div></div>
          <div class="field"><label>Humidity min</label><div class="input-unit"><input class="input" name="h_min" type="number" step="1" min="0" max="100" placeholder="Off"><span>%</span></div></div>
          <div class="field"><label>Humidity max</label><div class="input-unit"><input class="input" name="h_max" type="number" step="1" min="0" max="100" placeholder="Off"><span>%</span></div></div>
        </div>
        <div class="form-actions">
          <button type="reset" class="btn ghost">Revert</button>
          <button type="submit" class="btn primary">Save changes</button>
        </div>
      </form>
    </section>
  </div>

  <section class="card card-pad" style="margin-top:14px">
    <h3>Data</h3>
    <div class="row">
      <div><div class="label">Export readings</div><div class="hint">CSV with raw values in °C, %RH and hPa</div></div>
      <div class="btn-row">
        <select class="input" id="exp-range" style="width:auto;height:38px">
          ${['24h', '7d', '30d', '90d', '1y'].map((x) => `<option value="${x}" ${x === '30d' ? 'selected' : ''}>Last ${x}</option>`).join('')}
        </select>
        <a class="btn" id="exp-btn" href="/api/nodes/${encodeURIComponent(n.id)}/export.csv?range=30d">${ICON.download}Download</a>
      </div>
    </div>
    <div class="row">
      <div><div class="label">Forget node</div><div class="hint">Deletes its history. It re-registers if it reports again.</div></div>
      <button class="btn danger" id="forget">Forget</button>
    </div>
  </section>`;
}

function renderNode(id) {
  const n = state.nodes.get(id);
  const view = $('#view');
  if (!n) {
    state.page = { name: 'missing' };
    view.innerHTML = `<a class="back" href="#/">${ICON.back}All nodes</a><section class="card empty"><h2>Node not found</h2><p>It may have been forgotten.</p></section>`;
    return;
  }
  state.page = { name: 'node', id, metric: 't', range: store.get('murmur.range', '24h'), hist: null };
  if (!RANGES.includes(state.page.range)) state.page.range = '24h';
  view.innerHTML = nodeHtml(n);
  fillConfigForm(n);
  updateNodeLive();
  bindNode();
  state.page.chart = new LineChart($('#chart'), {
    fmtValue: (v) => v.toFixed(2).replace(/\.?0+$/, '') || '0',
    fmtAxisTime: axisTime,
    fmtTipTime: tipTime,
  });
  loadHistory();
  state.page.timer = setInterval(() => {
    const el = $('#n-seen');
    const cur = state.nodes.get(id);
    if (el && cur) el.textContent = ago(cur.last_seen);
  }, 5000);
  state.page.reload = setInterval(loadHistory, 300000);
}

function updateNodeLive() {
  const page = state.page;
  const n = state.nodes.get(page.id);
  if (!n) return;
  const { t, h, p } = n.last;
  const dew = dewPoint(t, h);
  const sig = signal(n.rssi);

  $('#n-name').textContent = n.location || n.name;
  $('#n-sub').innerHTML = `
    <i class="dot ${n.online ? 'on' : 'off'}"></i><span>${n.sleeping ? 'Sleeping' : n.online ? 'Online' : 'Offline'}</span>
    <span class="sep">·</span><span>Updated <span id="n-seen">${ago(n.last_seen)}</span></span>
    ${n.error ? `<span class="chip crit">${ICON.alert}Sensor: ${esc(n.error)}</span>` : ''}
    ${alertsFor(n).map((a) => `<span class="chip warn">${ICON[a.dir]}${esc(a.text)}</span>`).join('')}`;

  // gauge
  const frac = t == null ? 0 : Math.min(1, Math.max(0, (t - G.min) / (G.max - G.min)));
  $('#g-value').setAttribute('stroke-dashoffset', String(100 - frac * 100));
  const [kx, ky] = polar(135 + 270 * frac, G.r);
  const knob = $('#g-knob');
  knob.setAttribute('cx', kx.toFixed(2));
  knob.setAttribute('cy', ky.toFixed(2));
  knob.style.opacity = t == null ? 0 : 1;
  $('#g-temp').textContent = num(U.t(t));
  $('#g-unit').textContent = U.tUnit();
  $('#g-sub').textContent = dew != null ? `Dew point ${num(U.t(dew))}°` : esc(sensorLabel(n.sensor));
  $('#g-lo').textContent = `${Math.round(U.t(G.min))}°`;
  $('#g-hi').textContent = `${Math.round(U.t(G.max))}°`;

  $('#tiles').innerHTML = `
    <div class="tile">
      <div class="k">Humidity</div>
      <div><div class="v">${num(h)}<small>%</small></div>
      <div class="bar"><i style="width:${h ?? 0}%"></i></div>
      <div class="d">${humidityLabel(h)}</div></div>
    </div>
    <div class="tile">
      <div class="k">Pressure</div>
      <div><div class="v">${num(U.p(p), U.pDigits())}<small>${p == null ? '' : U.pUnit()}</small></div>
      <div class="d">${p == null ? `Not measured by ${esc(sensorLabel(n.sensor))}` : 'Station pressure'}</div></div>
    </div>
    <div class="tile">
      <div class="k">Dew point</div>
      <div><div class="v">${num(U.t(dew))}<small>${U.tUnit()}</small></div>
      <div class="d">${dewLabel(dew)}</div></div>
    </div>
    <div class="tile">
      <div class="k">Signal ${barsHtml(sig.bars)}</div>
      <div><div class="v">${dbm(n.rssi)}<small>dBm</small></div>
      <div class="d">${sig.label}</div></div>
    </div>`;

  // device controls
  const iv = $('#iv');
  // Preserve an active drag, but don't let lingering focus hide saved changes.
  if (iv && !iv.matches(':active')) {
    const idx = INTERVALS.indexOf(n.interval);
    iv.value = idx >= 0 ? idx : INTERVALS.findIndex((x) => x >= (n.interval || 30));
    setIntervalLabel();
  }
  $('#led').checked = n.led;
  $('#battery').checked = !!n.battery;
  $('#battery').disabled = n.battery == null;
  $('#battery-hint').textContent = n.battery == null
    ? 'Update node firmware to enable battery mode'
    : 'Deep sleep between reports. RESET opens a 5-minute window for commands and OTA.';
  $('#iv-hint').textContent = n.battery
    ? 'Sleep duration; 5–15 minutes recommended. Changes apply at the next wake.'
    : 'Pushed to the node over MQTT';
  $$('[data-cmd]').forEach((b) => {
    b.disabled = n.sleeping || !n.online || !state.meta.mqtt;
    b.title = n.sleeping ? 'Press RESET on the node to open a maintenance window' : '';
  });
  $('#kv').innerHTML = [
    ['Sensor', sensorLabel(n.sensor)],
    ['Firmware', n.fw ? `v${n.fw}` : '—'],
    ['Board', n.model || '—'],
    ['IP address', n.ip || '—'],
    ['MAC', n.mac || '—'],
    ['Uptime', duration(n.uptime)],
    ['First seen', dateTime(n.first_seen)],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');

  $('#metric-seg [data-metric="p"]').disabled = p == null && !(page.hist?.stats.p.avg != null);
  if (page.metric === 'p' && $('#metric-seg [data-metric="p"]').disabled) page.metric = 't';
  $$('#metric-seg button').forEach((b) => b.classList.toggle('on', b.dataset.metric === page.metric));
}

function setIntervalLabel() {
  const iv = $('#iv');
  const s = INTERVALS[+iv.value];
  const pct = (+iv.value / (INTERVALS.length - 1)) * 100;
  iv.style.setProperty('--fill', `${pct}%`);
  const label = intervalLabel(s);
  $('#iv-val').innerHTML = `${label.slice(0, -1)}<small>${{ s: 'sec', m: 'min', h: 'hr' }[label.slice(-1)]}</small>`;
}

function fillConfigForm(n) {
  const f = $('#cfg');
  f.name.value = n.name;
  f.location.value = n.location;
  f.t_off.value = round(U.tDelta(n.offsets.t), 2);
  f.h_off.value = round(n.offsets.h, 2);
  f.p_off.value = round(U.pDelta(n.offsets.p), 2);
  f.t_min.value = n.alerts.t_min == null ? '' : round(U.t(n.alerts.t_min), 1);
  f.t_max.value = n.alerts.t_max == null ? '' : round(U.t(n.alerts.t_max), 1);
  f.h_min.value = n.alerts.h_min ?? '';
  f.h_max.value = n.alerts.h_max ?? '';
  $$('[data-u="t"]', f).forEach((el) => (el.textContent = U.tUnit()));
  $$('[data-u="p"]', f).forEach((el) => (el.textContent = U.pUnit()));
}

async function patchNode(body, okMsg) {
  const id = state.page.id;
  try {
    const res = await api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    state.nodes.set(id, res.node);
    if (state.page.name === 'node' && state.page.id === id) updateNodeLive();
    toast(res.pushed === false ? `${okMsg} — node will sync when the broker is back`
      : res.pushed && res.node.sleeping ? `${okMsg} — applies at the next wake` : okMsg);
    return res.node;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

function bindNode() {
  const id = state.page.id;
  const enc = encodeURIComponent(id);

  $$('[data-cmd]').forEach((b) => b.addEventListener('click', async () => {
    const action = b.dataset.cmd;
    if (action === 'reboot' && !confirm('Reboot this node?')) return;
    b.disabled = true;
    try {
      await api(`/api/nodes/${enc}/command`, { method: 'POST', body: { action } });
      toast({ identify: 'Blinking LED for 10 seconds', read: 'Reading requested', reboot: 'Reboot sent' }[action]);
    } catch (e) { toast(e.message, true); }
    setTimeout(() => {
      if (state.page.name === 'node' && state.page.id === id) updateNodeLive();
    }, 1200);
  }));

  $('#metric-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    state.page.metric = b.dataset.metric;
    $$('#metric-seg button').forEach((x) => x.classList.toggle('on', x === b));
    drawChart();
  });

  $('#range-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.page.range = b.dataset.range;
    store.set('murmur.range', b.dataset.range);
    $$('#range-seg button').forEach((x) => x.classList.toggle('on', x === b));
    loadHistory();
  });

  const iv = $('#iv');
  iv.addEventListener('input', setIntervalLabel);
  iv.addEventListener('change', () => {
    const s = INTERVALS[+iv.value];
    patchNode({ interval: s }, `Interval set to ${intervalLabel(s)}`);
  });

  $('#led').addEventListener('change', (e) => patchNode({ led: e.target.checked }, e.target.checked ? 'Status LED on' : 'Status LED off'));
  $('#battery').addEventListener('change', async (e) => {
    const battery = e.target.checked;
    await patchNode({ battery }, battery ? 'Battery mode saved' : 'Always-on mode saved');
    if (state.page.name === 'node' && state.page.id === id) updateNodeLive();
  });

  const form = $('#cfg');
  form.addEventListener('reset', (e) => { e.preventDefault(); fillConfigForm(state.nodes.get(id)); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (name) => (form[name].value.trim() === '' ? null : parseFloat(form[name].value));
    const t = (name) => (val(name) == null ? null : round(U.tBack(val(name)), 3));
    const body = {
      name: form.name.value.trim(),
      location: form.location.value.trim(),
      t_off: round(U.tDeltaBack(val('t_off') ?? 0), 3),
      h_off: val('h_off') ?? 0,
      p_off: round(U.pDeltaBack(val('p_off') ?? 0), 3),
      t_min: t('t_min'), t_max: t('t_max'),
      h_min: val('h_min'), h_max: val('h_max'),
    };
    const n = await patchNode(body, 'Configuration saved');
    if (n) { fillConfigForm(n); updateNodeLive(); }
  });

  $('#exp-range').addEventListener('change', (e) => {
    $('#exp-btn').href = `/api/nodes/${enc}/export.csv?range=${e.target.value}`;
  });

  $('#forget').addEventListener('click', async () => {
    const n = state.nodes.get(id);
    if (!confirm(`Forget "${n.name}" and delete all of its history?`)) return;
    try {
      await api(`/api/nodes/${enc}`, { method: 'DELETE' });
      toast('Node forgotten');
      location.hash = '#/';
    } catch (e) { toast(e.message, true); }
  });
}

async function loadHistory() {
  const page = state.page;
  const { id, range } = page;
  try {
    const h = await api(`/api/nodes/${encodeURIComponent(id)}/history?range=${range}&points=360`);
    if (state.page !== page || page.range !== range) return;
    page.hist = h;
    updateNodeLive();
    drawChart();
  } catch (e) {
    toast(e.message, true);
  }
}

const METRIC = {
  t: { idx: 1, conv: (v) => U.t(v), unit: () => U.tUnit(), digits: () => 1 },
  h: { idx: 2, conv: (v) => v, unit: () => '%', digits: () => 1 },
  p: { idx: 3, conv: (v) => U.p(v), unit: () => ` ${U.pUnit()}`, digits: () => U.pDigits() },
};

function drawChart() {
  const page = state.page;
  if (!page.hist || !page.chart) return;
  const n = state.nodes.get(page.id);
  const m = METRIC[page.metric];
  const h = page.hist;
  const pts = h.points.map((p) => [p[0], p[m.idx] == null ? null : m.conv(p[m.idx])]);
  const gap = Math.max(h.bucket * 3, (n?.interval || 30) * 3, (S().resolution || 0) * 3, 90);
  page.chart.setData(pts, {
    since: h.since, until: h.until, gap,
    unit: m.unit(),
    fmtValue: (v) => v.toFixed(m.digits()),
  });

  const st = h.stats[page.metric];
  const d = m.digits();
  const u = m.unit().trim();
  $('#stats').innerHTML = [
    ['Min', st.min], ['Avg', st.avg], ['Max', st.max],
  ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${num(v == null ? null : m.conv(v), d)}<small>${u}</small></div></div>`).join('')
    + `<div><div class="k">Samples</div><div class="v">${h.stats.count.toLocaleString()}</div></div>`;
}

function pushLivePoint(n) {
  const page = state.page;
  if (!page.chart || !page.hist || !['1h', '6h'].includes(page.range) || !n.last.ts) return;
  const m = METRIC[page.metric];
  const raw = [n.last.t, n.last.h, n.last.p][m.idx - 1];
  page.hist.points.push([Math.floor(n.last.ts), n.last.t, n.last.h, n.last.p]);
  page.hist.until = Math.floor(n.last.ts);
  page.hist.since = page.hist.until - ({ '1h': 3600, '6h': 21600 })[page.range];
  page.chart.push(Math.floor(n.last.ts), raw == null ? null : m.conv(raw));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function seg(key, options, cls = '') {
  const cur = S()[key];
  return `<div class="seg ${cls}" data-set="${key}">${options.map(([v, l]) =>
    `<button data-v="${esc(JSON.stringify(v))}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function select(key, options) {
  const cur = S()[key];
  return `<select class="input" data-set="${key}" style="width:auto;min-width:160px">${options.map(([v, l]) =>
    `<option value="${esc(JSON.stringify(v))}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}

function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function renderSettings() {
  state.page = { name: 'settings' };
  const s = S();
  const m = state.meta;
  $('#view').innerHTML = `
  <header class="settings-head">
    <div class="eyebrow">Preferences</div>
    <h1>Settings</h1>
  </header>
  <div class="settings">
    <div style="display:grid;gap:14px">
      <section class="card">
        <h3>Units</h3>
        <div class="row"><div class="label">Temperature</div>${seg('temp_unit', [['C', '°C'], ['F', '°F']])}</div>
        <div class="row"><div class="label">Pressure</div>${seg('pressure_unit', [['hPa', 'hPa'], ['inHg', 'inHg'], ['mmHg', 'mmHg'], ['kPa', 'kPa']])}</div>
      </section>
      <section class="card">
        <h3>Appearance</h3>
        <div class="row"><div class="label">Theme</div>${seg('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Auto']])}</div>
        <div class="row"><div class="label">Accent</div>
          <div class="swatches" data-set="accent">${ACCENTS.map(([c, l]) =>
            `<button class="swatch ${c === s.accent ? 'on' : ''}" style="background:${c}" data-v='"${c}"' title="${l}" aria-label="${l}"></button>`).join('')}</div>
        </div>
        <div class="row"><div class="label">Clock</div>${seg('time_format', [['24h', '24-hour'], ['12h', '12-hour']])}</div>
        <div class="row"><div><div class="label">Card trend window</div><div class="hint">Sparkline range on the dashboard</div></div>${seg('spark_range', [['1h', '1H'], ['6h', '6H'], ['24h', '24H']], 'mono')}</div>
        <div class="row"><div class="label">Sort nodes by</div>${select('sort_by', [['name', 'Name'], ['location', 'Location'], ['temperature', 'Temperature'], ['recent', 'Last report']])}</div>
      </section>
    </div>
    <div style="display:grid;gap:14px">
      <section class="card">
        <h3>History</h3>
        <div class="row"><div><div class="label">Retention</div><div class="hint">Older readings are purged hourly</div></div>
          ${select('retention_days', [[7, '7 days'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [0, 'Forever']])}</div>
        <div class="row"><div><div class="label">Recording resolution</div><div class="hint">Minimum spacing between stored points</div></div>
          ${select('resolution', [[0, 'Every reading'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes']])}</div>
        <div class="row"><div><div class="label">Mark offline after</div><div class="hint">Or 3× the node's interval, whichever is longer</div></div>
          ${select('offline_after', [[60, '1 minute'], [180, '3 minutes'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes']])}</div>
      </section>
      <section class="card">
        <h3>System</h3>
        <div class="row"><div class="label">Broker</div><div class="value">${m.mqtt ? '<span class="chip good">Connected</span>' : m.demo ? '<span class="chip warn">Demo mode</span>' : '<span class="chip crit">Disconnected</span>'}</div></div>
        <div class="row"><div class="label">Endpoint</div><div class="value">mqtt://${esc(m.mqtt_host)}:${m.mqtt_port}</div></div>
        <div class="row"><div class="label">Topic root</div><div class="value">${esc(m.base_topic)}/&lt;node&gt;/…</div></div>
        <div class="row"><div class="label">Stored readings</div><div class="value">${(m.readings ?? 0).toLocaleString()}</div></div>
        <div class="row"><div class="label">Database</div><div class="value">${bytes(m.db_bytes)}</div></div>
        <div class="row"><div class="label">Version</div><div class="value">v${esc(m.version)}</div></div>
        <div class="form-actions"><button class="btn ghost" id="reset">Restore defaults</button></div>
      </section>
    </div>
  </div>`;

  const save = async (key, value) => {
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: { [key]: value } });
      applyTheme();
      renderSettings();
      toast('Saved');
    } catch (e) { toast(e.message, true); }
  };
  $$('[data-set]').forEach((el) => {
    const key = el.dataset.set;
    if (el.tagName === 'SELECT') el.addEventListener('change', () => save(key, JSON.parse(el.value)));
    else el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) save(key, JSON.parse(b.dataset.v));
    });
  });
  $('#reset').addEventListener('click', async () => {
    if (!confirm('Restore all settings to their defaults?')) return;
    state.settings = await api('/api/settings/reset', { method: 'POST' });
    applyTheme();
    renderSettings();
    toast('Defaults restored');
  });
  api('/api/meta').then((meta) => {
    const fresh = JSON.stringify(meta) !== JSON.stringify(state.meta);
    state.meta = meta;
    if (fresh && state.page.name === 'settings') renderSettings();
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const [settings, nodes, meta] = await Promise.all([api('/api/settings'), api('/api/nodes'), api('/api/meta')]);
    state.settings = settings;
    state.meta = meta;
    state.nodes = new Map(nodes.map((n) => [n.id, n]));
  } catch (e) {
    $('#view').innerHTML = `<section class="card empty"><h2>Can't reach the Murmur server</h2><p>${esc(e.message)}</p></section>`;
    setTimeout(boot, 3000);
    return;
  }
  applyTheme();
  renderLink();
  window.addEventListener('hashchange', route);
  route();
  connect();
}

boot();
