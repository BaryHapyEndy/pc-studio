/* studio/src/engine/names.js —— 节点 → 张量名 / 显示名 / 端口形状
 *
 * 这个模块负责：tname（写进 arena 和导出 C++ 的名字）、label（界面显示名）、
 * stateShape / portShape（端口形状完全由节点的 shape 与连线决定）、edgeSource（按端口反查上游）。
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

// 状态组件的形状：就是节点上自己填的那个 shape。
//（老图纸可能没填，给个兜底：θ 是 64×64，其余一律 1×64；界面上新建节点时都会填好）
const FALLBACK_SHAPE = { T: sh(64, 64) };
export function stateShape(spec, n) {
  if (n.shape && n.shape.r > 0 && n.shape.c > 0) return sh(n.shape.r, n.shape.c);
  return FALLBACK_SHAPE[n.type] || sh(1, 64);
}

export function portShape(spec, n, port, isOut) {
  const c = LIBMAP[n.type];
  if (c.state) return isOut ? stateShape(spec, n) : null;
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
  return null;   // 算子端口：形状由上游算出来，不在这里声明
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
