/* studio/src/engine/names.js —— 节点 → 张量名 / 显示名 / 端口形状
 *
 * 这个模块负责：tname（写进 arena 和导出 C++ 的名字）、label（界面显示名）、
 * stateShape / portShape（按 dims 推端口形状）、edgeSource（按端口反查上游）。
 */

import { sh } from './shape.js';
import { LIBMAP } from './library.js';

// 张量名（进 arena / 导出 C++）：M0, T1, E0, V_P0 …
export function tname(n) {
  const c = LIBMAP[n.type];
  if (c && c.state && n.name) return String(n.name).replace(/[^\w\u4e00-\u9fa5]/g, '_');
  if (n.type === 'x') return 'x';
  if (['M', 'T', 'B', 'E'].includes(n.type) && n.l != null) return n.type + n.l;
  return n.id;
}
// 显示名（界面上）：M[0], T[1] …
export function label(n) {
  const c = LIBMAP[n.type];
  if (!c) return n.type;
  if (c.state && n.name) return n.name;
  if (c.params && c.params.includes('l') && n.l != null) return `${c.id}[${n.l}]`;
  return c.name;
}

// 某个节点的端口形状
// 状态组件的形状：用户显式填的优先，没填就按老规矩从 dims 推一个默认值
export function stateShape(spec, n) {
  if (n.shape && n.shape.r > 0 && n.shape.c > 0) return sh(n.shape.r, n.shape.c);
  const D = spec.dims || [64, 1024];
  if (n.type === 'x') return sh(1, D[0]);
  if (n.type === 'M') return sh(1, D[n.l || 0]);
  if (n.type === 'T') return sh(D[n.l || 0], D[(n.l || 0) - 1] || D[0]);
  if (n.type === 'B' || n.type === 'E') return sh(1, D[(n.l || 1) - 1] || D[0]);
  return sh(1, D[0]);
}

export function portShape(spec, n, port, isOut) {
  const c = LIBMAP[n.type];
  if (c.state) return isOut ? stateShape(spec, n) : null;
  const D = spec.dims || [64, 1024];
  if (n.type === 'EM') {
    // EM 的形状由它接的状态决定（没接就无从谈起，返回 null 让 UI 只画个圆点）
    const mu = edgeSource(spec, n, 'mu'), th = edgeSource(spec, n, 'th');
    const Du = mu ? portShape(spec, mu.n, mu.port, true) : null;
    const Tt = th ? portShape(spec, th.n, th.port, true) : null;
    if (!Du || !Tt) return null;
    const Dd = sh(1, Tt.c);
    if (isOut) return (port === 'f' || port === 'be1') ? Dd : Du;
    return (port === 'g') ? Dd : Du;
  }
  const defs = isOut ? c.outs : c.ins;
  const def = defs && defs.find(p => p.k === port);
  if (!def || !def.shape) return null;   // 算子端口：形状由上游决定
  return def.shape(D, n.l, n);
}

export function edgeSource(spec, n, port) {
  for (const e of spec.edges) {
    if (e.to[0] === n.id && e.to[1] === port) {
      const src = spec.nodes.find(x => x.id === e.from[0]);
      if (src && LIBMAP[src.type]) return { n: src, port: e.from[1] };
      return null;
    }
  }
  return null;
}
