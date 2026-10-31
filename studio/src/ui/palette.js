// 这个模块负责：左侧组件库的渲染（分组、拖拽起点、点击放入画布）和 addNode 这个「放一个新组件」的动作。

import * as PC from '../engine/index.js';
import { $, el } from './dom.js';
import { S, selectNode, DEFAULT_SHAPE, uniqueName } from './store.js';
import { resetRun } from './runner.js';
import { buildSettings } from './settings.js';

export function buildPalette() {
  const left = $('#lc-body');
  left.innerHTML = '';
  const groups = {};
  for (const c of PC.LIB) (groups[c.group] = groups[c.group] || []).push(c);
  for (const g of Object.keys(groups)) {
    left.appendChild(el('div', 'grp', g));
    for (const c of groups[g]) {
      const d = el('div', 'item');
      d.draggable = true;
      d.innerHTML = `<span class="dot" style="background:${c.color}"></span><span class="t">${c.name}</span>`;
      d.title = c.note || '';
      d.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'copy'; });
      d.addEventListener('click', () => addNode(c.id, null));
      left.appendChild(d);
    }
  }
  // 折叠 / 设置浮窗
  $('#lc-head').addEventListener('click', () => {
    const on = $('#lc-body').classList.toggle('open');
    $('#lc-head').classList.toggle('open', on);
  });
  buildSettings();
}

export function addNode(type, pos, silent) {
  const c = PC.LIBMAP[type];
  const n = { id: type.toLowerCase() + (S.uid++), type: type };
  if (c.params) for (const p of c.params) {
    if (c.defaults && c.defaults[p] !== undefined) n[p] = c.defaults[p];
  }
  if (c.state) {
    const d = DEFAULT_SHAPE[type] || [1, 64];
    n.name = uniqueName(type === 'x' ? 'x' : (type === 'V' ? 'v' : type));
    n.shape = { r: d[0], c: d[1] };
    if (type === 'M' || type === 'T' || type === 'B' || type === 'E') n.l = 1;
  }
  if (type === 'EM') n.l = 1;
  if (pos) n.pos = pos;
  else {
    const maxX = S.spec.nodes.reduce((a, x) => Math.max(a, x.pos ? x.pos.x : 0), 0);
    n.pos = { x: maxX + 190, y: 60 };
  }
  S.spec.nodes.push(n);
  resetRun();
  if (!silent) selectNode(n.id);
  return n;
}
