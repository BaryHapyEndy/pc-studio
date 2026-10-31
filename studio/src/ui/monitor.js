// 这个模块负责：右侧面板的徽章读数、自由能曲线，以及「监视」组件把张量画成方阵热力图。

import * as PC from '../engine/index.js';
import { $ } from './dom.js';
import { S } from './store.js';
import { monitorSize } from './geometry.js';

// ───────────────────────── 取张量 ─────────────────────────
export function tensorByName(name) { return S.rt && S.rt.pr ? S.rt.pr.tensors.find(t => t.name === name) : null; }

// ───────────────────────── 指标 / 状态 ─────────────────────────
export function paintStatus() {
  const m = S.rt && S.rt.pr && S.rt.pr.total ? PC.metrics(S.rt.pr) : null;
  $('#b-ops').textContent = m ? `ops ${m.ops}` : 'ops —';
  $('#b-arena').textContent = m ? `arena ${m.total} B` : 'arena —';
  const errs = (S.rt && S.rt.errors) || [];
  const b = $('#b-check');
  b.className = 'badge ' + (errs.length ? 'bad' : 'ok');
  b.textContent = errs.length ? `校验 ${errs.length} 个问题` : '校验 通过';
  b.title = errs.map(e => e.msg).join('\n');
}

// ───────────────────────── 图表 ─────────────────────────
export function drawChart() {
  const cv = $('#chart'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const pts = S.hist.slice(-240);
  if (pts.length < 2) { g.fillStyle = '#4b5563'; g.font = '11px sans-serif'; g.fillText('运行后出现曲线', 10, h / 2); return; }
  const lo = Math.log10(Math.min(...pts) + 1e-12), hi = Math.log10(Math.max(...pts) + 1e-12);
  const X = i => 6 + i * (w - 12) / (pts.length - 1);
  const Y = v => h - 8 - (Math.log10(v + 1e-12) - lo) / Math.max(1e-6, hi - lo) * (h - 18);
  g.strokeStyle = '#1d2634'; g.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const y = 8 + i * (h - 18) / 3; g.beginPath(); g.moveTo(6, y); g.lineTo(w - 6, y); g.stroke(); }
  g.beginPath();
  pts.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.strokeStyle = '#4da3ff'; g.lineWidth = 1.6; g.stroke();
  g.lineTo(X(pts.length - 1), h - 8); g.lineTo(X(0), h - 8); g.closePath();
  g.fillStyle = 'rgba(77,163,255,.10)'; g.fill();
  g.fillStyle = '#8b98a9'; g.font = '10px monospace';
  g.fillText(Math.pow(10, hi).toExponential(1), 8, 14);
  g.fillText(Math.pow(10, lo).toExponential(1), 8, h - 4);
}

// 监视组件：把张量画成方阵（列数 = √n 向上取整，尽量是正方形）
export function paintMonitor(n) {
  const host = document.querySelector(`.mon[data-mon="${n.id}"]`);
  if (!host) return;
  const t = S.rt && S.rt.views && S.rt.views[n.id];
  if (!t) { host.innerHTML = '<span class="empty">没接张量</span>'; return; }
  const v = S.rt.pr.buf.subarray(S.rt.pr.ptr(t), S.rt.pr.ptr(t) + t.shape.n);
  const cols = Math.ceil(Math.sqrt(v.length));
  const rows = Math.ceil(v.length / cols);
  const cell = Math.max(2, Math.min(S.settings.cell || 4, Math.floor(monitorSize() / cols)));
  let mx = 0; for (const x of v) mx = Math.max(mx, Math.abs(x));
  if (mx < 1e-9) mx = 1;
  let cells = host.children;
  if (cells.length !== v.length) {
    host.innerHTML = '';
    for (let i = 0; i < v.length; i++) { const d = document.createElement('i'); d.style.width = d.style.height = cell + 'px'; d.style.borderRadius = '1px'; host.appendChild(d); }
    cells = host.children;
  }
  host.style.gridTemplateColumns = `repeat(${cols},${cell}px)`;
  for (let i = 0; i < v.length; i++) {
    const x = v[i], a = Math.min(1, Math.abs(x) / mx);
    cells[i].style.background = x >= 0 ? `rgba(123,216,143,${0.05 + a * 0.95})` : `rgba(239,124,116,${0.05 + a * 0.95})`;
    cells[i].title = x.toFixed(4);
  }
}
