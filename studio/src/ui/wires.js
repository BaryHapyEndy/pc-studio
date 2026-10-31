// 这个模块负责：连线（贝塞尔）的绘制与删除、剪刀的命中判定，以及画布上那条临时剪线轨迹 #cutpath。

import { $ } from './dom.js';
import { S, notify } from './store.js';
import { pinPos, bez } from './geometry.js';

export function drawWires() {
  const svg = $('#wires');
  svg.innerHTML = '';
  for (const e of S.spec.edges) {
    const a = pinPos(e.from[0], e.from[1], 'out');
    const b = pinPos(e.to[0], e.to[1], 'in');
    if (!a || !b) continue;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', bez(a, b));
    const isState = /^[MTBE]$/.test(e.to[1]) || e.to[1] === 'in';
    p.setAttribute('stroke', e.to[1] === 'in' ? '#e0a458' : '#4a7fb5');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('fill', 'none');
    p.setAttribute('opacity', '.85');
    if (e.to[1] === 'in') p.setAttribute('stroke-dasharray', '5 3');
    p.classList.add('hit');
    p.__edge = e;
    if (S.mode === 'scissor') p.style.pointerEvents = 'none';
    p.addEventListener('mouseenter', () => { if (S.mode !== 'scissor') p.setAttribute('stroke-width', '3'); });
    p.addEventListener('mouseleave', () => p.setAttribute('stroke-width', '1.6'));
    p.addEventListener('click', ev => { ev.stopPropagation(); removeEdge(e); });
    p.addEventListener('dblclick', ev => { ev.stopPropagation(); removeEdge(e); });
    svg.appendChild(p);
  }
}

export function removeEdge(e) {
  const i = S.spec.edges.indexOf(e);
  if (i >= 0) { S.spec.edges.splice(i, 1); notify('reset'); }
}

// 点到线段的距离（剪刀命中判定）
export function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 剪刀：用这一段的轨迹去切所有还活着的连线
export function scissorCut(x1, y1, x2, y2) {
  let cut = 0;
  for (const p of [...document.querySelectorAll('#wires path.hit')]) {
    if (!p.__edge) continue;
    const len = p.getTotalLength();
    const step = Math.max(4, Math.min(10, len / 40));
    let hit = false;
    for (let d = 0; d <= len; d += step) {
      const q = p.getPointAtLength(d);
      // 世界坐标 → 画布坐标
      const sx = q.x * S.view.k + S.view.x, sy = q.y * S.view.k + S.view.y;
      if (segDist(sx, sy, x1, y1, x2, y2) < 5) { hit = true; break; }
    }
    if (hit) {
      S.spec.edges = S.spec.edges.filter(e => e !== p.__edge);
      p.remove();
      cut++;
    }
  }
  return cut;
}

// ── 剪线轨迹：开始 / 追加一段 / 结束（坐标都是相对 #stage 的左上角） ──
export function cutBegin(st, x, y) {
  const drag = { kind: 'scissor', st, pts: [[x, y]], cut: 0 };
  let cp = $('#cutpath');
  if (!cp) {
    cp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    cp.id = 'cutpath';
    cp.setAttribute('stroke', '#ef7c74'); cp.setAttribute('stroke-width', '1.5');
    cp.setAttribute('fill', 'none'); cp.setAttribute('stroke-dasharray', '4 3');
    cp.setAttribute('pointer-events', 'none');
    $('#wires').appendChild(cp);
  }
  cp.setAttribute('d', `M ${drag.pts[0][0]} ${drag.pts[0][1]}`);
  return drag;
}

export function cutUpdate(drag, x, y) {
  const [px, py] = drag.pts[drag.pts.length - 1];
  if (Math.hypot(x - px, y - py) < 2) return drag.cut;
  drag.pts.push([x, y]);
  const cp = $('#cutpath');
  if (cp) cp.setAttribute('d', 'M ' + drag.pts.map(p => p[0] + ' ' + p[1]).join(' L '));
  drag.cut += scissorCut(px, py, x, y);
  return drag.cut;
}

export function cutEnd(drag) {
  const cp = $('#cutpath'); if (cp) cp.remove();
  return drag.cut;
}
