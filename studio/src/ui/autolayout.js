// 这个模块负责：自动布局——按前向边做最长路径分层，每层按上游平均纵坐标排序以减少交叉。

import { S } from './store.js';
import { geom } from './geometry.js';

// 前向边（读）决定层次，写回边（→ state.in）是反向的，不参与分层。
export function autoLayout() {
  const nodes = S.spec.nodes, byId = {};
  for (const n of nodes) byId[n.id] = n;
  const fwd = S.spec.edges.filter(e => e.to[1] !== 'in' && byId[e.from[0]] && byId[e.to[0]]);
  const preds = {}, succs = {};
  for (const n of nodes) { preds[n.id] = []; succs[n.id] = []; }
  for (const e of fwd) { preds[e.to[0]].push(e.from[0]); succs[e.from[0]].push(e.to[0]); }
  // 最长路径分层（图有环也无所谓：限制迭代次数）
  const depth = {};
  for (const n of nodes) depth[n.id] = 0;
  for (let pass = 0; pass < nodes.length + 2; pass++) {
    let changed = false;
    for (const e of fwd) {
      const d = depth[e.from[0]] + 1;
      if (d > depth[e.to[0]] && d < nodes.length + 1) { depth[e.to[0]] = d; changed = true; }
    }
    if (!changed) break;
  }
  // 输入源固定在 0 层
  for (const n of nodes) if (!preds[n.id].length && !succs[n.id].length) depth[n.id] = 0;
  const cols = {};
  for (const n of nodes) (cols[depth[n.id]] = cols[depth[n.id]] || []).push(n);
  const COLW = 250, ROWGAP = 26;
  let x = 40;
  for (const d of Object.keys(cols).map(Number).sort((a, b) => a - b)) {
    const col = cols[d];
    // 同一层里按"上游的平均纵坐标"排序，减少交叉
    const key = n => {
      const p = preds[n.id];
      if (!p.length) return 0;
      return p.reduce((acc, id) => acc + (depth[id] * 1000 + (byId[id]._ord || 0)), 0) / p.length;
    };
    col.forEach((n, i) => { n._ord = i; });
    col.sort((a, b) => key(a) - key(b));
    let y = 60;
    let maxW = 0;
    for (const n of col) {
      const g = geom(n);
      n.pos = { x: x, y: y };
      y += g.h + ROWGAP;
      maxW = Math.max(maxW, g.w);
    }
    x += Math.max(COLW, maxW + 60);
  }
}
