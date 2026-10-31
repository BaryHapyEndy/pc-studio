// 这个模块负责：连线（贝塞尔）的绘制与删除、剪刀的命中判定，以及画布上那条临时剪线轨迹 #cutpath。
//
// 连线的颜色是「有向」的：每条线都从中点附近由黄过渡到蓝——黄的那头是输出口（源），
// 蓝的那头是输入口（汇），所以不画箭头也能看出值往哪边走。方向定义见 geometry.js 的 roleOf。
// 过渡带刻意做得很窄（42% → 58%）：既不是生硬的硬切，也不会在中间拖出一段发灰的混色。

import { $, svgEl } from './dom.js';
import { S, notify } from './store.js';
import { pinPos, bez, portRole } from './geometry.js';

const COLOR = {
  sink: '#4a7fb5',    // 蓝：输入口（值流进这个组件）
  source: '#e0a458',  // 黄：输出口（值从这个组件流出）
  need: '#ef7c74',    // 红：必需但没连（线画出来时不会是它，留作兜底）
  '': '#48566b',      // 灰：端口未知
};

const WIDTH = 1.8;
const WIDTH_HOT = 3.2;
const BAND_FROM = 0.42;   // 过渡带的起点（占整条线长的比例）
const BAND_TO = 0.58;     // 过渡带的终点

// 一条线一个渐变；坐标系直接用世界坐标（端点和线都在世界坐标里）
function makeGradient(id, a, b, c1, c2) {
  const g = svgEl('linearGradient');
  g.setAttribute('id', id);
  g.setAttribute('gradientUnits', 'userSpaceOnUse');
  g.setAttribute('x1', a.x); g.setAttribute('y1', a.y);
  g.setAttribute('x2', b.x); g.setAttribute('y2', b.y);
  const stops = [
    [0, c1, 0.9],
    [BAND_FROM, c1, 0.9],
    [BAND_TO, c2, 0.95],
    [1, c2, 0.95],
  ];
  for (const [offset, color, opacity] of stops) {
    const st = svgEl('stop');
    st.setAttribute('offset', String(offset));
    st.setAttribute('stop-color', color);
    st.setAttribute('stop-opacity', String(opacity));
    g.appendChild(st);
  }
  return g;
}

function edgeColor(nodeId, port, dir) {
  return COLOR[portRole(nodeId, port, dir)] || COLOR[''];
}

export function drawWires() {
  const svg = $('#wires');
  svg.innerHTML = '';
  const defs = svgEl('defs');
  svg.appendChild(defs);

  let index = 0;
  for (const e of S.spec.edges) {
    const a = pinPos(e.from[0], e.from[1], 'out');
    const b = pinPos(e.to[0], e.to[1], 'in');
    if (!a || !b) continue;

    const gid = `lg${index++}`;
    const c1 = edgeColor(e.from[0], e.from[1], 'out');
    const c2 = edgeColor(e.to[0], e.to[1], 'in');
    defs.appendChild(makeGradient(gid, a, b, c1, c2));

    const p = svgEl('path');
    p.setAttribute('d', bez(a, b));
    p.setAttribute('stroke', `url(#${gid})`);
    p.setAttribute('stroke-width', String(WIDTH));
    p.setAttribute('fill', 'none');
    p.classList.add('hit');
    p.__edge = e;

    if (S.mode === 'scissor') p.style.pointerEvents = 'none';
    p.addEventListener('mouseenter', () => {
      if (S.mode !== 'scissor') p.setAttribute('stroke-width', String(WIDTH_HOT));
    });
    p.addEventListener('mouseleave', () => p.setAttribute('stroke-width', String(WIDTH)));
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
    for (let d = 0; d <= len; d += step) {
      const q = p.getPointAtLength(d);
      // 世界坐标 → 画布坐标
      const sx = q.x * S.view.k + S.view.x, sy = q.y * S.view.k + S.view.y;
      if (segDist(sx, sy, x1, y1, x2, y2) < 5) {
        S.spec.edges = S.spec.edges.filter(e => e !== p.__edge);
        p.remove();
        cut++;
        break;
      }
    }
  }
  return cut;
}

// ── 剪线轨迹：开始 / 追加一段 / 结束（坐标都是相对 #stage 的左上角） ──
export function cutBegin(st, x, y) {
  const drag = { kind: 'scissor', st, pts: [[x, y]], cut: 0 };
  let cp = $('#cutpath');
  if (!cp) {
    cp = svgEl('path');
    cp.id = 'cutpath';
    cp.setAttribute('stroke', '#ef7c74');
    cp.setAttribute('stroke-width', '1.5');
    cp.setAttribute('fill', 'none');
    cp.setAttribute('stroke-dasharray', '4 3');
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
  const cp = $('#cutpath');
  if (cp) cp.remove();
  return drag.cut;
}
