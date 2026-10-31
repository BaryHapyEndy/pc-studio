// 这个模块负责：画布的重绘（节点 DOM、实时数值、错误标红、连线）、视图变换（平移 / 缩放 / 适应画布）。

import * as PC from '../engine/index.js';
import { $, el } from './dom.js';
import { S } from './store.js';
import { geom, monitorSize, pinRole, isConnected } from './geometry.js';
import { drawWires } from './wires.js';
import { paintStatus, paintMonitor, tensorByName } from './monitor.js';
import { renderInspector } from './inspector.js';

// ───────────────────────── 视图 ─────────────────────────
export function applyView() {
  $('#world').style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`;
  const pct = Math.round(S.view.k * 100);
  const r = $('#z-range'), v = $('#z-val');
  if (r) r.value = Math.max(20, Math.min(240, pct));
  if (v) v.textContent = pct + '%';
}

export function fitView() {
  if (!S.spec.nodes.length) return;
  const minX = Math.min(...S.spec.nodes.map(n => n.pos.x)) - 40;
  const maxX = Math.max(...S.spec.nodes.map(n => n.pos.x + 160)) + 40;
  const minY = Math.min(...S.spec.nodes.map(n => n.pos.y)) - 30;
  const maxY = Math.max(...S.spec.nodes.map(n => n.pos.y + 120)) + 30;
  const st = $('#stage').getBoundingClientRect();
  const k = Math.min(1.4, Math.min(st.width / (maxX - minX), st.height / (maxY - minY)));
  S.view.k = Math.max(0.35, k);
  S.view.x = (st.width - (maxX - minX) * S.view.k) / 2 - minX * S.view.k;
  S.view.y = (st.height - (maxY - minY) * S.view.k) / 2 - minY * S.view.k;
  applyView();
}

export function refreshSel() {
  document.querySelectorAll('.node').forEach(d => d.classList.toggle('sel', S.selSet.has(d.dataset.id)));
}

// ───────────────────────── 重绘 ─────────────────────────
// 端口画什么颜色（判定在 geometry.js 的 roleOf，这里只用结果）：
//   sink   —— 蓝：输入口（组件左边，值流进这个组件）
//   source —— 黄：输出口（组件右边，值从这个组件流出）
//   need   —— 红：没连，但它是必需的输入口（算子 a/b、EM 的 μ/θ）
// 另外 open class 标出"还没接线"：未接线画空心圈，颜色不变。
export function rebuild() {
  // 只画图：rt 由 resetRun() 负责 lower + 初始化。
  // （这里曾经重新 lower 一次，等于把训练好的状态清零，表现为 M[1]/T[1] 全部塌成 0）
  if (!S.rt) S.rt = PC.lower(S.spec);
  // 2) 节点
  const host = $('#nodes');
  host.innerHTML = '';
  const errNodes = new Set((S.rt.errors || []).map(e => e.node));
  for (const n of S.spec.nodes) {
    const g = geom(n);
    const d = el('div', 'node' + (S.selSet.has(n.id) ? ' sel' : '') + (errNodes.has(n.id) ? ' err' : ''));
    d.style.left = n.pos.x + 'px';
    d.style.top = n.pos.y + 'px';
    d.style.width = g.w + 'px';
    d.style.height = g.h + 'px';
    d.dataset.id = n.id;
    const c = PC.LIBMAP[n.type];
    const hd = el('div', 'hd');
    hd.innerHTML = `<span class="dot" style="background:${c.color}"></span><span class="nm">${PC.label(n)}</span>` +
                   `<span class="tag">${n.type === 'EM' ? 'MACRO' : (c.state ? 'STATE' : 'OP')}</span>`;
    d.appendChild(hd);
    const bd = el('div', 'bd');

    // 一个端口的 HTML：连接点 + 名称。颜色 class 来自 geometry 的 roleOf（按方向、且只在接线后上色），
    // linked 表示已接线——已接线时小圆填成"比环暗一点"的同色，没接线时小圆保持全黑。
    // 输入口把连接点放行首、输出口放行尾，和「左进右出」的画法一致。
    const portHTML = (n2, p, dir) => {
      const role = pinRole(n2, p, dir);
      const linked = isConnected(n2.id, p.k, dir);
      const cls = 'pin' + (role ? ' ' + role : '') + (linked ? ' linked' : '');
      const tip = role === 'need' ? ' title="这个输入必需，还没连"'
                : linked ? '' : ' title="还没接线"';
      const pinTag = `<span class="${cls}" data-node="${n2.id}" data-port="${p.k}" data-dir="${dir}"` +
                     ` style="top:4.5px"${tip}></span>`;
      const label = `<span class="lb">${p.name}</span>`;
      return dir === 'in' ? pinTag + label : label + pinTag;
    };

    for (const p of g.ins) {
      const r = el('div', 'port in');
      r.innerHTML = portHTML(n, p, 'in');
      bd.appendChild(r);
    }
    for (const p of g.outs) {
      const r = el('div', 'port out');
      r.innerHTML = portHTML(n, p, 'out');
      bd.appendChild(r);
    }

    for (const line of g.info) {
      const r = el('div', 'note', line);
      bd.appendChild(r);
    }
    if (n.type === 'MON') {
      const g2 = el('div', 'mon');
      g2.dataset.mon = n.id;
      g2.style.height = monitorSize() + 'px';
      g2.style.alignContent = 'center';
      g2.style.justifyContent = 'center';
      bd.appendChild(g2);
    }
    d.appendChild(bd);
    d.appendChild(el('div', 'ft', footText(n)));
    host.appendChild(d);
  }
  // 3) 连线
  drawWires();
  // 4) 端口事件：节点上的 mousedown / contextmenu / 端口拖线统一由 interaction.js 在 #nodes 上委托
  paintStatus();
  renderInspector();
  if (S.rt && S.rt.pr && S.rt.pr.planned) updateNodeValues();
}

export function footText(n) {
  const e = (S.rt.errors || []).filter(x => x.node === n.id)[0];
  if (e) return `<span style="color:var(--bad)">${e.msg.slice(0, 26)}</span>`;
  const c = PC.LIBMAP[n.type];
  if (n.type === 'MON') {
    const t = S.rt && S.rt.views && S.rt.views[n.id];
    return t ? `看 ${t.name}` : '没接张量';
  }
  if (c.state) {
    const s = PC.stateShape(S.spec, n);
    return `${PC.fmtShape(s)} · ${s.n * 4} B`;
  }
  if (n.type === 'EM') return `${n.l >= 1 ? `ε${n.l}, θ${n.l}, β${n.l}` : ''}`;
  return 'op';
}

// 状态组件页脚：形状 + ‖·‖²
export function updateNodeValues() {
  if (!S.rt || !S.rt.pr || !S.rt.pr.buf) return;
  for (const n of S.spec.nodes) {
    const c = PC.LIBMAP[n.type];
    if (c.state) {
      const t = tensorByName(PC.tname(n));
      const d = document.querySelector(`.node[data-id="${n.id}"] .ft`);
      if (!d || !t) continue;
      const v = S.rt.pr.buf.subarray(S.rt.pr.ptr(t), S.rt.pr.ptr(t) + t.shape.n);
      let s = 0; for (const q of v) s += q * q;
      d.textContent = `${PC.fmtShape(t.shape)} · ‖·‖² ${s.toFixed(4)}`;
    } else if (n.type === 'MON') {
      paintMonitor(n);
    }
  }
}
