// 这个模块负责：顶栏「文件 / 工具」菜单与模式（选择 / 剪刀）切换，以及新建图纸、切换示例图纸。

import * as PC from '../engine/index.js';
import { $ } from './dom.js';
import { S, setSelection } from './store.js';
import { syncHyper, resetRun } from './runner.js';
import { fitView, rebuild } from './render.js';
import { autoLayout } from './autolayout.js';
import { drawChart } from './monitor.js';
import { toast, showModal, HELP } from './modal.js';
import { saveCurrent, saveAs, openFile } from './file-io.js';
import { DRAWINGS } from '../engine/drawings.js';

// 示例图纸：内容来自 src/engine/drawings.js（由 studio/import-drawing.mjs 生成），
// 只在「文件 → 示例图纸」里出现。想换成自己的图纸：
//     node studio/import-drawing.mjs 你的图纸.json && node studio/build.mjs
export const DEMO_PRESETS = DRAWINGS.map(d => ({
  id: d.id, name: d.name, make: () => JSON.parse(JSON.stringify(d.spec)),
}));

// 工具模式：'select' 默认，'scissor' 剪刀（左键划动剪线）
export function setMode(m) {
  S.mode = m;
  $('#stage').classList.toggle('cutting', m === 'scissor');
  $('#btn-tool').classList.toggle('on', m === 'scissor');
  document.querySelectorAll('#toolmenu .mi').forEach(d => d.classList.toggle('cur', d.dataset.mode === m));
  toast(m === 'scissor' ? '剪刀：按住左键划过连线即可剪断，右键回到选择' : '选择模式');
  closeToolMenu();
}
export function closeToolMenu() { $('#toolmenu').classList.remove('on'); }

export function newDrawing() {
  S.spec = {
    nodes: [], edges: [],
    lrMu: 0.1, lrT: 0.01, lrB: 0.01, nInfer: 20, seed: 42, wTop: 0.02, fixed: true,
  };
  S.curFile = null; S.curName = null;
  document.title = 'pc-studio · 预测编码图编辑器';
  syncHyper();
  setSelection([], null);
  resetRun();
  toast('新图纸：从左边组件库拖东西进来');
}

export function loadPreset(i) {
  S.spec = DEMO_PRESETS[i].make();
  S.curFile = null; S.curName = null;
  document.title = 'pc-studio · 预测编码图编辑器';
  syncHyper();
  setSelection([], null);
  resetRun();
  fitView();
}

// ───────────────────────── 顶栏菜单 ─────────────────────────
export function closeMenu() { $('#filemenu').classList.remove('on'); }

export function bindTopBar() {
  $('#btn-file').addEventListener('click', e => { e.stopPropagation(); $('#filemenu').classList.toggle('on'); });
  document.addEventListener('click', e => { if (!e.target.closest('.menu-btn')) closeMenu(); });
  $('#filemenu').addEventListener('click', e => {
    const mi = e.target.closest('.mi');
    if (!mi) return;
    closeMenu();
    const a = mi.dataset.act;
    if (a === 'new') newDrawing();
    else if (a === 'save') saveCurrent();
    else if (a === 'saveas') saveAs();
    else if (a === 'open') openFile();
    else if (a === 'ex') loadPreset(+mi.dataset.i);
    else if (a === 'json') $('#btn-json').click();
    else if (a === 'cpp') $('#btn-cpp').click();
  });

  // 示例图纸列表按 drawings.js 生成（不用改 index.html）
  const ex = $('#exlist');
  ex.innerHTML = '';
  DEMO_PRESETS.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'mi';
    d.dataset.act = 'ex';
    d.dataset.i = i;
    d.textContent = p.name;
    ex.appendChild(d);
  });

  // 工具菜单
  $('#btn-tool').addEventListener('click', e => {
    e.stopPropagation();
    $('#filemenu').classList.remove('on');
    $('#toolmenu').classList.toggle('on');
  });
  $('#toolmenu').addEventListener('click', e => {
    const mi = e.target.closest('.mi');
    if (mi) setMode(mi.dataset.mode);
  });
  document.addEventListener('click', e => { if (!e.target.closest('#btn-tool')) closeToolMenu(); });

  // 左 / 右栏开关（只影响显示，不动图纸）
  $('#btn-left').addEventListener('click', () => {
    const off = $('#main').classList.toggle('hide-left');
    $('#btn-left').classList.toggle('off', off);
    setTimeout(drawChart, 0);
  });
  $('#btn-right').addEventListener('click', () => {
    const off = $('#main').classList.toggle('hide-right');
    $('#btn-right').classList.toggle('off', off);
    setTimeout(() => { drawChart(); fitView(); }, 0);
  });
  $('#btn-json').addEventListener('click', () => showModal('导出 JSON（可保存 / 再导入）', JSON.stringify(S.spec, null, 2), 'json'));
  $('#btn-cpp').addEventListener('click', () => {
    const r = PC.emitCpp(S.spec, 'model');
    showModal('导出 C++（engine/pc.hpp）', r.text, 'cpp');
  });
  $('#btn-help').addEventListener('click', () => showModal('怎么用', HELP, 'txt'));
  $('#btn-layout').addEventListener('click', () => { autoLayout(); rebuild(); fitView(); });
}
