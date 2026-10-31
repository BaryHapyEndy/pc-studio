// 这个模块负责：跑图——lower / 初始化、单步与连续运行、跑图面板读数，以及超参输入框的绑定。

import * as PC from '../engine/index.js';
import { $ } from './dom.js';
import { S } from './store.js';
import { makeDataset } from './dataset.js';
import { rebuild, updateNodeValues } from './render.js';
import { drawChart, tensorByName } from './monitor.js';

// ───────────────────────── 运行 ─────────────────────────
export function resetRun() {
  S.rt = PC.lower(S.spec);
  if (S.rt.errors.length) { rebuild(); return; }
  PC.initProgram(S.rt.pr, S.spec);
  const xi = S.spec.nodes.find(n => n.type === 'x');
  S.data = makeDataset(xi ? PC.stateShape(S.spec, xi).c : 64, 5, 11);
  S.it = 0; S.hist = []; S.lastF = 0; S.lastE0 = 0; S.sampleIdx = 0;
  {
    const q = nm => { const t = tensorByName(nm); if (!t) return -1; const v = S.rt.pr.ptr(t); let s = 0; for (let i = 0; i < t.shape.n; i++) s += S.rt.pr.buf[v + i] ** 2; return Math.sqrt(s); };
    if (location.hash.includes('dbg')) console.log('DBG-INIT M1=' + q('M1').toFixed(6) + ' T1=' + q('T1').toFixed(6) + ' x=' + q('x').toFixed(6) + ' nTens=' + S.rt.pr.tensors.length);
  }
  stepOnce(0);              // 先跑一步，画面里就有数
  if (location.hash.includes('dbg')) {
    const q = n => { const t = tensorByName(n); if (!t) return -1; const v = S.rt.pr.ptr(t); let s = 0; for (let i = 0; i < t.shape.n; i++) s += S.rt.pr.buf[v + i] ** 2; return Math.sqrt(s); };
    console.log('DBG wTop=' + S.spec.wTop + ' M1=' + q('M1').toFixed(4) + ' T1=' + q('T1').toFixed(4) + ' B1=' + q('B1').toFixed(4) + ' nops=' + S.rt.pr.ops.length);
  }
  rebuild();
  paintRun();
}

export function feedInput() {
  const t = tensorByName('x');
  if (!t || !S.data) return;
  const s = S.data[S.sampleIdx % S.data.length];
  const p = S.rt.pr.ptr(t);
  for (let i = 0; i < Math.min(s.length, t.shape.n); i++) S.rt.pr.buf[p + i] = s[i];
}

export function stepOnce(dt) {
  if (!S.rt || S.rt.errors.length || !S.rt.pr.planned) return;
  const nI = Math.max(1, +S.spec.nInfer || 10);
  if (S.it % nI === 0) feedInput();
  PC.runPhase(S.rt.pr, (S.it % nI) === (nI - 1) ? 2 : 1);
  S.it++;
  const fixed = $('#p-fixed').checked;   // 固定样本：看着 F 单调下降；关掉则每段换一个随机样本
  if (S.it % nI === 0 && !fixed) S.sampleIdx = (S.sampleIdx + 1) % (S.data ? S.data.length : 1);
  const fe = PC.freeEnergy(S.rt.pr, S.spec);
  S.lastF = fe.F;
  const e0 = fe.perLayer.find(p => p.name === 'E0');
  S.lastE0 = e0 ? e0.e : 0;
  S.hist.push(Math.max(1e-9, S.lastF));
}

export function tick() {
  if (!S.running) return;
  const n = Math.max(1, Math.min(200, +$('#speed').value || 1));
  for (let i = 0; i < n; i++) stepOnce();
  paintRun();
  requestAnimationFrame(tick);
}

export function paintRun() {
  $('#k-it').textContent = S.it;
  const fmt = v => (v === 0 ? '0' : (Math.abs(v) < 1e-3 ? v.toExponential(2) : v.toFixed(5)));
  $('#k-F').textContent = fmt(S.lastF);
  $('#k-e0').textContent = fmt(S.lastE0);
  drawChart();
  updateNodeValues();
}

// 超参绑定
export function bindHyper(id, key, cast) {
  const e = $(id);
  // nInfer 只影响循环节拍，其余超参都会改到 lower 出来的 op，需要重跑
  e.addEventListener('change', () => { S.spec[key] = cast(e.value); if (key === 'nInfer') rebuild(); else resetRun(); });
  return e;
}

export function syncHyper() {
  $('#p-lrmu').value = S.spec.lrMu; $('#p-lrt').value = S.spec.lrT; $('#p-lrb').value = S.spec.lrB;
  $('#p-ninfer').value = S.spec.nInfer; $('#p-seed').value = S.spec.seed; $('#p-wtop').value = S.spec.wTop;
  $('#p-fixed').checked = S.spec.fixed !== false;
}

export function bindRunPanel() {
  $('#btn-run').addEventListener('click', () => {
    S.running = !S.running;
    $('#btn-run').textContent = S.running ? '⏸ 暂停' : '▶ 运行';
    if (S.running) tick();
  });
  $('#btn-step').addEventListener('click', () => { stepOnce(); paintRun(); });
  $('#btn-reset').addEventListener('click', resetRun);

  bindHyper('#p-lrmu', 'lrMu', Number); bindHyper('#p-lrt', 'lrT', Number); bindHyper('#p-lrb', 'lrB', Number);
  bindHyper('#p-ninfer', 'nInfer', v => Math.max(1, +v | 0)); bindHyper('#p-seed', 'seed', Number); bindHyper('#p-wtop', 'wTop', Number);
  $('#p-fixed').addEventListener('change', e => { S.spec.fixed = e.target.checked; });
}
