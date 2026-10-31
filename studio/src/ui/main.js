// 这个模块负责：组装——绑定所有事件、注册统一重绘、启动，并按 location.hash 决定是否跑演示 / 自检。

import { $ } from './dom.js';
import { S, onChange } from './store.js';
import { buildPalette } from './palette.js';
import { applySettings, bindSettingsPop } from './settings.js';
import { syncHyper, resetRun, stepOnce, paintRun, bindRunPanel } from './runner.js';
import { rebuild, refreshSel, fitView } from './render.js';
import { paintStatus, drawChart, tensorByName } from './monitor.js';
import { renderInspector } from './inspector.js';
import { bindCanvas } from './interaction.js';
import { bindTopBar, loadPreset, setMode } from './menu.js';
import { bindFilePicker, saveTextAs } from './file-io.js';
import { bindCtxClose } from './clipboard.js';
import { getLastExport, toast } from './modal.js';
import { runDemo } from '../dev/demo.js';
import { runSelftest } from '../dev/selftest.js';

// 重绘入口：任何模块改完状态只要 notify(...)，这里统一决定重绘哪几块
function renderAll() { rebuild(); paintStatus(); drawChart(); }
onChange(reason => {
  if (reason === 'reset') resetRun();
  else if (reason === 'render') renderAll();
  else if (reason === 'select') { refreshSel(); renderInspector(); }
  else renderAll();
});

// ───────────────────────── 导出弹窗 ─────────────────────────
$('#m-save').addEventListener('click', () => { const e = getLastExport(); if (e) saveTextAs(e.kind, e.text); });
$('#m-close').addEventListener('click', () => $('#modal').classList.remove('on'));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').classList.remove('on'); });
$('#m-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#m-body').textContent).then(() => toast('已复制'), () => toast('复制失败'));
});

// ───────────────────────── 绑定 ─────────────────────────
bindSettingsPop();
bindTopBar();
bindRunPanel();
bindFilePicker();
bindCtxClose();
bindCanvas();

// ───────────────────────── 启动 ─────────────────────────
buildPalette();
applySettings();
syncHyper();
resetRun();
fitView();
window.addEventListener('load', () => {
  setTimeout(fitView, 60);
  if (location.hash.includes('menu')) setTimeout(() => $('#filemenu').classList.add('on'), 200);
  if (location.hash.includes('tools')) setTimeout(() => $('#toolmenu').classList.add('on'), 200);
  if (location.hash.includes('scissor')) setTimeout(() => setMode('scissor'), 220);
  if (location.hash.includes('deep')) loadPreset(0);
  const h = location.hash.match(/run=(\d+)/);
  if (h) {
    const n = +h[1];
    for (let i = 0; i < n; i++) {
      stepOnce();
      if (location.hash.includes('dbg') && i % 100 === 0) {
        const q = nm => { const t = tensorByName(nm); const v = S.rt.pr.ptr(t); let s = 0; for (let k = 0; k < t.shape.n; k++) s += S.rt.pr.buf[v + k] ** 2; return s; };
        console.log('DBG-TRACE ' + i + ' M1=' + q('M1').toFixed(4) + ' T1=' + q('T1').toFixed(2) + ' B1=' + q('B1').toFixed(4) + ' E0=' + q('E0').toFixed(4) + ' x=' + q('x').toFixed(2));
      }
    }
    paintRun();
    if (location.hash.includes('dbg')) {
      const q = nm => { const t = tensorByName(nm); if (!t) return -1; const v = S.rt.pr.ptr(t); let s = 0; for (let i = 0; i < t.shape.n; i++) s += S.rt.pr.buf[v + i] ** 2; return Math.sqrt(s); };
      console.log('DBGOPS ' + S.rt.pr.ops.map(o => [o.k, o.a && o.a.name, o.b && o.b.name, o.d.name, o.phase, o.scalar || 0].join(':')).join(' | '));
      console.log('DBG-END it=' + S.it + ' M1=' + q('M1').toFixed(4) + ' T1=' + q('T1').toFixed(4) + ' B1=' + q('B1').toFixed(4) + ' P0=' + q('P0').toFixed(4) + ' wTop=' + S.spec.wTop + ' fixed=' + $('#p-fixed').checked);
    }
  }
});
window.addEventListener('resize', () => { drawChart(); });

// 演示态（#demo）：加一个监视组件、开设置浮窗、跑若干步，给截图用
if (location.hash.includes('demo')) setTimeout(runDemo, 300);

// 交互自检（仅 #selftest 时跑，给无头浏览器用）
if (location.hash.includes('selftest')) setTimeout(runSelftest, 250);
