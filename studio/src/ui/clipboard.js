// 这个模块负责：复制 / 粘贴 / 删除选中，以及两个右键菜单（节点菜单、空白处的「粘贴到这里」）。

import * as PC from '../engine/index.js';
import { $, el } from './dom.js';
import { S, setSelection, uniqueName } from './store.js';
import { resetRun } from './runner.js';
import { toast } from './modal.js';

export function deleteSelected() {
  if (!S.selSet.size) return;
  const ids = new Set(S.selSet);
  S.spec.nodes = S.spec.nodes.filter(n => !ids.has(n.id));
  S.spec.edges = S.spec.edges.filter(x => !ids.has(x.from[0]) && !ids.has(x.to[0]));
  setSelection([], null);
  resetRun();
}

// ───────────────────────── 复制 / 粘贴 / 右键菜单 ─────────────────────────
export function copySelection() {
  if (!S.selSet.size) { toast('先选几个组件'); return; }
  const ids = new Set(S.selSet);
  const nodes = S.spec.nodes.filter(n => ids.has(n.id)).map(n => JSON.parse(JSON.stringify(n)));
  // 只复制两头都在选区里的连线
  const edges = S.spec.edges.filter(e => ids.has(e.from[0]) && ids.has(e.to[0]))
                          .map(e => JSON.parse(JSON.stringify(e)));
  S.clip = { nodes, edges };
  toast(`已复制 ${nodes.length} 个组件 · ${edges.length} 条连线`);
}

export function pasteClip(at) {
  if (!S.clip || !S.clip.nodes.length) { toast('剪贴板是空的'); return; }
  const map = {};
  const dx = at ? 0 : 46, dy = at ? 0 : 46;
  const added = S.clip.nodes.map(n => {
    const id = n.type.toLowerCase() + (S.uid++);
    map[n.id] = id;
    const c = JSON.parse(JSON.stringify(n));
    c.id = id;
    c.pos = { x: (n.pos ? n.pos.x : 0) + dx, y: (n.pos ? n.pos.y : 0) + dy };
    if (at) c.pos = { x: at.x, y: at.y };
    if (PC.LIBMAP[n.type].state) c.name = uniqueName(PC.tname(n));
    return c;
  });
  S.spec.nodes.push(...added);
  for (const e of S.clip.edges) {
    if (!map[e.from[0]] || !map[e.to[0]]) continue;
    S.spec.edges.push({ from: [map[e.from[0]], e.from[1]], to: [map[e.to[0]], e.to[1]] });
  }
  setSelection(added.map(n => n.id), added[0].id);
  resetRun();
  toast(`已粘贴 ${added.length} 个组件`);
}

export function showCtx(x, y, forNode) {
  const m = $('#ctxmenu');
  m.innerHTML = '';
  let any = false;
  const add = (label, k, fn, dis) => {
    any = true;
    const d = el('div', 'ci' + (dis ? ' dis' : ''));
    d.innerHTML = `<span>${label}</span><span class="k">${k || ''}</span>`;
    if (!dis) d.addEventListener('click', () => { hideCtx(); fn(); });
    m.appendChild(d);
  };
  if (forNode) {
    add('删除', 'Del', deleteSelected, !S.selSet.size);
    add('复制', '⌘C', copySelection, !S.selSet.size);
  }
  add('粘贴', '⌘V', () => pasteClip(), !(S.clip && S.clip.nodes.length));
  if (!any) return;
  m.classList.add('on');
  const w = m.offsetWidth || 140, h = m.offsetHeight || 96;
  m.style.left = Math.min(x, innerWidth - w - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - h - 8) + 'px';
}
export function hideCtx() { $('#ctxmenu').classList.remove('on'); }

// 右键单击空白画布（没有拖动）→ 弹「粘贴到这里」
export function showPasteMenu(x, y) {
  const st = $('#stage').getBoundingClientRect();
  const at = { x: (x - st.left - S.view.x) / S.view.k, y: (y - st.top - S.view.y) / S.view.k };
  if (!(S.clip && S.clip.nodes.length)) return;
  $('#ctxmenu').innerHTML = '';
  const d = el('div', 'ci');
  d.innerHTML = '<span>粘贴到这里</span><span class="k">⌘V</span>';
  d.addEventListener('click', () => { hideCtx(); pasteClip(at); });
  $('#ctxmenu').appendChild(d);
  $('#ctxmenu').classList.add('on');
  $('#ctxmenu').style.left = Math.min(x, innerWidth - 160) + 'px';
  $('#ctxmenu').style.top = Math.min(y, innerHeight - 70) + 'px';
}

export function bindCtxClose() {
  document.addEventListener('mousedown', e => { if (!e.target.closest('#ctxmenu')) hideCtx(); }, true);
}
