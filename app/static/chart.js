// Minimal, dependency-free charts: a time-series line chart with crosshair
// tooltip, and an SVG sparkline for dashboard cards.

const TIME_STEPS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400];

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function withAlpha(color, alpha) {
  const ctx = withAlpha.ctx || (withAlpha.ctx = document.createElement('canvas').getContext('2d'));
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  const hex = ctx.fillStyle;
  if (hex.startsWith('#')) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return hex.replace(/rgba?\(([^)]+)\)/, (_, inner) => {
    const [r, g, b] = inner.split(',').map((s) => s.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  });
}

export class LineChart {
  /**
   * @param {HTMLElement} host   element containing a <canvas> and a .tip
   * @param {object} opts        { fmtValue(v) -> string, unit, fmtAxisTime(ts, span), fmtTipTime(ts) }
   */
  constructor(host, opts) {
    this.host = host;
    this.canvas = host.querySelector('canvas');
    this.tip = host.querySelector('.tip');
    this.empty = host.querySelector('.chart-empty');
    this.ctx = this.canvas.getContext('2d');
    this.opts = opts;
    this.points = [];
    this.hover = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(host);
    this._onMove = (e) => this.onMove(e);
    this._onLeave = () => {
      this.hover = null;
      this.tip?.classList.remove('show');
      this.draw();
    };
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerdown', this._onMove);
    this.canvas.addEventListener('pointerleave', this._onLeave);
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerdown', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
  }

  /** points: [[tsSeconds, value|null], ...]; domain: [since, until]; gap: seconds that breaks the line */
  setData(points, { since, until, gap, unit, fmtValue }) {
    this.points = points.filter((p) => p[1] != null && Number.isFinite(p[1]));
    this.since = since;
    this.until = until;
    this.gap = gap;
    if (unit !== undefined) this.opts.unit = unit;
    if (fmtValue) this.opts.fmtValue = fmtValue;
    this.hover = null;
    if (this.empty) this.empty.classList.toggle('hidden', this.points.length > 0);
    this.draw();
  }

  /** Append a live point and slide the window forward. */
  push(ts, value) {
    if (value == null) return;
    const span = this.until - this.since;
    this.until = Math.max(this.until, ts);
    this.since = this.until - span;
    this.points.push([ts, value]);
    while (this.points.length && this.points[0][0] < this.since) this.points.shift();
    if (this.empty) this.empty.classList.add('hidden');
    this.draw();
  }

  layout() {
    const rect = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = { l: 8, r: 52, t: 18, b: 28 };
    return { w, h, pad, pw: w - pad.l - pad.r, ph: h - pad.t - pad.b };
  }

  scales(L) {
    const vals = this.points.map((p) => p[1]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (!vals.length) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const padV = (hi - lo) * 0.15;
    lo -= padV; hi += padV;
    const step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const x = (ts) => L.pad.l + ((ts - this.since) / (this.until - this.since)) * L.pw;
    const y = (v) => L.pad.t + (1 - (v - lo) / (hi - lo)) * L.ph;
    return { x, y, lo, hi, step };
  }

  draw() {
    const ctx = this.ctx;
    const L = this.layout();
    ctx.clearRect(0, 0, L.w, L.h);
    if (this.since == null) return;

    const accent = cssVar(this.host, '--accent', '#3e6ae1');
    const line = cssVar(this.host, '--line', 'rgba(255,255,255,.07)');
    const ink3 = cssVar(this.host, '--text-3', '#686c74');
    const surface = cssVar(this.host, '--surface', '#141518');
    const mono = cssVar(this.host, '--mono', 'monospace');
    const S = this.scales(L);
    this.S = S; this.L = L;

    // horizontal grid + y labels (right side, recessive)
    ctx.font = `10.5px ${mono}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    const decimals = S.step < 1 ? (S.step < 0.1 ? 2 : 1) : 0;
    for (let v = S.lo; v <= S.hi + S.step / 2; v += S.step) {
      const yy = Math.round(S.y(v)) + 0.5;
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(L.pad.l, yy); ctx.lineTo(L.pad.l + L.pw, yy); ctx.stroke();
      ctx.fillStyle = ink3;
      ctx.fillText(v.toFixed(decimals), L.pad.l + L.pw + 10, yy);
    }

    // x labels, aligned to local time
    const span = this.until - this.since;
    const tz = -new Date().getTimezoneOffset() * 60;
    const step = TIME_STEPS.find((s) => span / s <= 6) || TIME_STEPS[TIME_STEPS.length - 1];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let t = Math.ceil((this.since + tz) / step) * step - tz; t <= this.until; t += step) {
      const xx = S.x(t);
      if (xx < L.pad.l + 18 || xx > L.pad.l + L.pw - 18) continue;
      ctx.fillStyle = ink3;
      ctx.fillText(this.opts.fmtAxisTime(t, span), xx, L.h - 8);
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(Math.round(xx) + 0.5, L.pad.t + L.ph); ctx.lineTo(Math.round(xx) + 0.5, L.pad.t + L.ph + 4); ctx.stroke();
    }

    if (!this.points.length) return;

    // split into segments where data is missing
    const segs = [];
    let cur = [];
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (cur.length && p[0] - cur[cur.length - 1][0] > this.gap) { segs.push(cur); cur = []; }
      cur.push(p);
    }
    if (cur.length) segs.push(cur);

    const base = L.pad.t + L.ph;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.pad.l, 0, L.pw, L.h);
    ctx.clip();
    const grad = ctx.createLinearGradient(0, L.pad.t, 0, base);
    grad.addColorStop(0, withAlpha(accent, 0.24));
    grad.addColorStop(1, withAlpha(accent, 0));

    for (const seg of segs) {
      ctx.beginPath();
      seg.forEach(([t, v], i) => (i ? ctx.lineTo(S.x(t), S.y(v)) : ctx.moveTo(S.x(t), S.y(v))));
      if (seg.length === 1) {
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(S.x(seg[0][0]), S.y(seg[0][1]), 2, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      ctx.lineTo(S.x(seg[seg.length - 1][0]), base);
      ctx.lineTo(S.x(seg[0][0]), base);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      seg.forEach(([t, v], i) => (i ? ctx.lineTo(S.x(t), S.y(v)) : ctx.moveTo(S.x(t), S.y(v))));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.restore();

    // selective direct labels: min & max only
    if (this.points.length > 2 && !this.hover) {
      let mi = 0, ma = 0;
      this.points.forEach((p, i) => { if (p[1] < this.points[mi][1]) mi = i; if (p[1] > this.points[ma][1]) ma = i; });
      if (this.points[ma][1] - this.points[mi][1] > S.step * 0.25) {
        this.marker(ctx, this.points[ma], 'MAX', -1, { accent, surface, ink3, mono }, L);
        this.marker(ctx, this.points[mi], 'MIN', 1, { accent, surface, ink3, mono }, L);
      }
    }

    // crosshair
    if (this.hover) {
      const [t, v] = this.hover;
      const xx = Math.round(S.x(t)) + 0.5, yy = S.y(v);
      ctx.strokeStyle = withAlpha(cssVar(this.host, '--text', '#fff'), 0.25);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xx, L.pad.t); ctx.lineTo(xx, base); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(xx, yy, 5, 0, Math.PI * 2);
      ctx.fillStyle = accent; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = surface; ctx.stroke();
    }
  }

  marker(ctx, [t, v], label, dir, c, L) {
    const S = this.S;
    const xx = S.x(t), yy = S.y(v);
    ctx.beginPath(); ctx.arc(xx, yy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = c.surface; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = c.accent; ctx.stroke();
    const text = `${label} ${this.opts.fmtValue(v)}`;
    ctx.font = `10px ${c.mono}`;
    const tw = ctx.measureText(text).width;
    let tx = Math.min(Math.max(xx, L.pad.l + tw / 2 + 2), L.pad.l + L.pw - tw / 2 - 2);
    let ty = yy + dir * 14;
    if (ty < L.pad.t + 4) ty = yy + 16;
    if (ty > L.pad.t + L.ph - 2) ty = yy - 10;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.ink3;
    ctx.fillText(text, tx, ty);
  }

  onMove(e) {
    if (!this.points.length || !this.S) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = this.since + ((px - this.L.pad.l) / this.L.pw) * (this.until - this.since);
    // binary search nearest point
    let lo = 0, hi = this.points.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.points[mid][0] < t) lo = mid; else hi = mid; }
    const p = Math.abs(this.points[lo][0] - t) < Math.abs(this.points[hi][0] - t) ? this.points[lo] : this.points[hi];
    this.hover = p;
    this.draw();
    if (this.tip) {
      const unit = this.opts.unit ? `<small>${this.opts.unit}</small>` : '';
      this.tip.innerHTML = `<div class="tv">${this.opts.fmtValue(p[1])}${unit}</div><div class="tt">${this.opts.fmtTipTime(p[0])}</div>`;
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      const x = this.S.x(p[0]), y = this.S.y(p[1]);
      let left = x + 14;
      if (left + tw > this.L.w - 4) left = x - tw - 14;
      const top = Math.max(0, Math.min(y - th - 12, this.L.h - th - 30));
      this.tip.style.transform = `translate(${left}px, ${top}px)`;
      this.tip.classList.add('show');
    }
  }
}

/** Build an inline SVG sparkline (line + soft area) from [[ts, v], ...]. */
export function sparkline(points, since, until) {
  const pts = points.filter((p) => p[1] != null);
  if (pts.length < 2) return '<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"></svg>';
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  if (hi - lo < 0.2) { const m = (hi + lo) / 2; lo = m - 0.1; hi = m + 0.1; }
  const x = (t) => ((t - since) / (until - since)) * 100;
  const y = (v) => 4 + (1 - (v - lo) / (hi - lo)) * 24;
  const d = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(2)} ${y(v).toFixed(2)}`).join('');
  const area = `${d}L${x(pts[pts.length - 1][0]).toFixed(2)} 32L${x(pts[0][0]).toFixed(2)} 32Z`;
  return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${area}"/><path class="line" d="${d}"/></svg>`;
}
