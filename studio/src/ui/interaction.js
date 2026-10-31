// 这个模块负责：画布上的所有指针交互——节点拖拽、拉线、框选、平移、缩放、剪刀、快捷键。

import * as PC from '../engine/index.js';
import { $ } from './dom.js';
import { S, setSelection, selectNode, toggleSelect } from './store.js';
import { pinPos, bez, geom } from './geometry.js';
import { applyView, fitView, refreshSel } from './render.js';
import { drawWires, cutBegin, cutUpdate, cutEnd } from './wires.js';
import { resetRun } from './runner.js';
import { setMode, newDrawing } from './menu.js';
import { renderInspector } from './inspector.js';
import { showCtx, showPasteMenu, pasteClip, copySelection, deleteSelected } from './clipboard.js';
import { addNode } from './palette.js';
import { saveCurrent, openFile } from './file-io.js';
import { toast } from './modal.js';

// ───────────────────────── 交互：选择 / 框选 / 平移 / 缩放 ─────────────────────────
export function startDragNode(e, n) {
  if (e.button === 2 || e.button === 1) return;          // 右键/中键留给平移
  if (e.button !== 0) return;
  e.stopPropagation();
  if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSelect(n.id); return; }
  if (!S.selSet.has(n.id)) selectNode(n.id);
  else { S.sel = n.id; renderInspector(); refreshSel(); }
  const items = [...S.selSet].map(id => {
    const m = S.spec.nodes.find(x => x.id === id);
    return { n: m, ox: m.pos.x, oy: m.pos.y };
  });
  S.drag = { kind: 'node', sx: e.clientX, sy: e.clientY, items };
}

export function startWire(e, nodeId, port, dir) {
  S.drag = { kind: 'wire', from: { node: nodeId, port, dir }, sx: e.clientX, sy: e.clientY };
  const svg = $('#wires');
  const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tmp.setAttribute('stroke', '#7bd88f'); tmp.setAttribute('stroke-width', '2');
  tmp.setAttribute('fill', 'none'); tmp.setAttribute('stroke-dasharray', '4 3');
  tmp.id = 'tmpwire';
  svg.appendChild(tmp);
}

export function startPan(e) {
  S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.x, oy: S.view.y, moved: false };
  $('#stage').classList.add('panning');
}

export function connect(fn, fp, tn, tp) {
  S.spec.edges = S.spec.edges.filter(e => !(e.to[0] === tn && e.to[1] === tp));
  S.spec.edges.push({ from: [fn, fp], to: [tn, tp] });
  resetRun();
}

// 缩放
export function zoomAt(k2, ax, ay) {
  k2 = Math.min(2.4, Math.max(0.2, k2));
  S.view.x = ax - (ax - S.view.x) * (k2 / S.view.k);
  S.view.y = ay - (ay - S.view.y) * (k2 / S.view.k);
  S.view.k = k2;
  applyView();
}
export function zoomCenter(f) {
  const st = $('#stage').getBoundingClientRect();
  zoomAt(S.view.k * f, st.width / 2, st.height / 2);
}

// ───────────────────────── 事件绑定 ─────────────────────────
export function bindCanvas() {
  $('#stage').addEventListener('contextmenu', e => {
    e.preventDefault();          // 菜单在 mouseup 时才弹（避免和右键拖动平移打架）
  });

  $('#stage').addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  $('#stage').addEventListener('drop', e => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!PC.LIBMAP[type]) return;
    const st = $('#stage').getBoundingClientRect();
    addNode(type, { x: (e.clientX - st.left - S.view.x) / S.view.k - 70, y: (e.clientY - st.top - S.view.y) / S.view.k - 20 });
  });

  $('#stage').addEventListener('mousedown', e => {
    if (e.target.closest('#zoombar')) return;
    if (e.button === 2 || e.button === 1) {
      if (S.mode === 'scissor') { setMode('select'); return; }         // 剪刀模式下右键退出
      startPan(e);                                                    // 右键拖动 = 移动视图（在组件上也一样）
      S.drag.onNode = !!e.target.closest('.node');
      return;
    }
    if (e.button !== 0) return;
    if (e.target.closest('.node')) return;                           // 节点自己处理
    if (!['stage', 'wires', 'nodes', 'world', 'cutpath'].includes(e.target.id)) return;
    if (S.mode === 'scissor') {
      const st = $('#stage').getBoundingClientRect();
      S.drag = cutBegin(st, e.clientX - st.left, e.clientY - st.top);
      return;
    }
    // 左键拖空白 = 框选
    const st = $('#stage').getBoundingClientRect();
    S.drag = { kind: 'marquee', sx: e.clientX, sy: e.clientY, st, base: [...S.selSet] };
    if (!(e.shiftKey || e.metaKey || e.ctrlKey)) setSelection([], null);
    const m = $('#marquee');
    m.style.display = 'block';
    m.style.left = (e.clientX - st.left) + 'px';
    m.style.top = (e.clientY - st.top) + 'px';
    m.style.width = m.style.height = '0px';
  });

  // 节点上的事件统一在 #nodes 上委托（render 只负责建 DOM，不需要反过来知道 interaction 的函数）
  $('#nodes').addEventListener('mousedown', e => {
    const pin = e.target.closest('.pin');
    if (pin) { e.stopPropagation(); startWire(e, pin.dataset.node, pin.dataset.port, pin.dataset.dir); return; }
    const d = e.target.closest('.node');
    if (!d) return;
    const n = S.spec.nodes.find(x => x.id === d.dataset.id);
    if (!n) return;
    if (e.target.closest('.hd')) { startDragNode(e, n); return; }
    if (e.target !== d || e.button !== 0) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelect(n.id); else selectNode(n.id);
  });
  $('#nodes').addEventListener('contextmenu', e => {
    const d = e.target.closest('.node');
    if (!d) return;
    const n = S.spec.nodes.find(x => x.id === d.dataset.id);
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    if (!S.selSet.has(n.id)) selectNode(n.id);
    showCtx(e.clientX, e.clientY, true);
  });

  window.addEventListener('mousemove', e => {
    const drag = S.drag;
    if (!drag) return;
    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      S.view.x = drag.ox + dx;
      S.view.y = drag.oy + dy;
      applyView();
    } else if (drag.kind === 'node') {
      const dx = (e.clientX - drag.sx) / S.view.k, dy = (e.clientY - drag.sy) / S.view.k;
      for (const it of drag.items) {
        it.n.pos.x = it.ox + dx;
        it.n.pos.y = it.oy + dy;
        const d = document.querySelector(`.node[data-id="${it.n.id}"]`);
        if (d) { d.style.left = it.n.pos.x + 'px'; d.style.top = it.n.pos.y + 'px'; }
      }
      drawWires();
    } else if (drag.kind === 'marquee') {
      const st = drag.st;
      const x1 = drag.sx - st.left, y1 = drag.sy - st.top;
      const x2 = e.clientX - st.left, y2 = e.clientY - st.top;
      const m = $('#marquee');
      m.style.left = Math.min(x1, x2) + 'px';
      m.style.top = Math.min(y1, y2) + 'px';
      m.style.width = Math.abs(x2 - x1) + 'px';
      m.style.height = Math.abs(y2 - y1) + 'px';
    } else if (drag.kind === 'scissor') {
      const st = drag.st;
      cutUpdate(drag, e.clientX - st.left, e.clientY - st.top);
    } else if (drag.kind === 'wire') {
      const tmp = $('#tmpwire');
      const a = pinPos(drag.from.node, drag.from.port, drag.from.dir);
      const st = $('#stage').getBoundingClientRect();
      const b = { x: (e.clientX - st.left - S.view.x) / S.view.k, y: (e.clientY - st.top - S.view.y) / S.view.k };
      if (tmp && a) tmp.setAttribute('d', drag.from.dir === 'out' ? bez(a, b) : bez(b, a));
    }
  });

  window.addEventListener('mouseup', e => {
    const drag = S.drag;
    if (drag && drag.kind === 'wire') {
      const tgt = document.elementFromPoint(e.clientX, e.clientY);
      if (tgt && tgt.classList.contains('pin')) {
        const to = { node: tgt.dataset.node, port: tgt.dataset.port, dir: tgt.dataset.dir };
        if (to.dir !== drag.from.dir) {
          const from = drag.from.dir === 'out' ? drag.from : to;
          const into = drag.from.dir === 'out' ? to : drag.from;
          connect(from.node, from.port, into.node, into.port);
        }
      }
    }
    if (drag && drag.kind === 'marquee') {
      const m = $('#marquee');
      m.style.display = 'none';
      const st = drag.st;
      const x1 = Math.min(drag.sx, e.clientX) - st.left, y1 = Math.min(drag.sy, e.clientY) - st.top;
      const x2 = Math.max(drag.sx, e.clientX) - st.left, y2 = Math.max(drag.sy, e.clientY) - st.top;
      if (x2 - x1 > 3 && y2 - y1 > 3) {
        const hit = [];
        for (const n of S.spec.nodes) {
          const g = geom(n);
          const nx = n.pos.x * S.view.k + S.view.x, ny = n.pos.y * S.view.k + S.view.y;
          if (nx < x2 && nx + g.w * S.view.k > x1 && ny < y2 && ny + g.h * S.view.k > y1) hit.push(n.id);
        }
        const merged = (e.shiftKey || e.metaKey || e.ctrlKey) ? [...new Set([...drag.base, ...hit])] : hit;
        setSelection(merged, merged.length ? merged[merged.length - 1] : null);
      }
    }
    if (drag && drag.kind === 'pan' && !drag.moved && e.button === 2 && !drag.onNode) {
      showPasteMenu(e.clientX, e.clientY);      // 右键单击空白（没拖动）才弹粘贴菜单
    }
    if (drag && drag.kind === 'scissor') {
      const cut = cutEnd(drag);
      if (cut) { resetRun(); toast(`剪断 ${cut} 条连线`); }
    }
    $('#stage').classList.remove('drag', 'panning');
    S.drag = null;
    const t = $('#tmpwire'); if (t) t.remove();
  });

  window.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    if (e.key === 'Escape') {
      if (S.mode === 'scissor') setMode('select');
      $('#toolmenu').classList.remove('on');
      $('#filemenu').classList.remove('on');
      $('#ctxmenu').classList.remove('on');
      setSelection([], null);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selSet.size) { e.preventDefault(); deleteSelected(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newDrawing(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); }
    if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'v') setMode('select');
    if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 's') setMode('scissor');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClip(); }
  });

  $('#z-in').addEventListener('click', () => zoomCenter(1.2));
  $('#z-out').addEventListener('click', () => zoomCenter(1 / 1.2));
  $('#z-fit').addEventListener('click', () => fitView());
  $('#z-range').addEventListener('input', e => {
    const k2 = +e.target.value / 100;
    const st = $('#stage').getBoundingClientRect();
    zoomAt(k2, st.width / 2, st.height / 2);
  });

  $('#stage').addEventListener('wheel', e => {
    e.preventDefault();
    const st = $('#stage').getBoundingClientRect();
    const mx = e.clientX - st.left, my = e.clientY - st.top;
    const step = Math.sign(e.deltaY) * S.settings.wheel;      // 灵敏度来自左侧「设置」
    zoomAt(S.view.k * Math.exp(-step), mx, my);
  }, { passive: false });
}
