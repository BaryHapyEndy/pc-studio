/* studio/src/engine/init.js —— 初始化与数值参数
 *
 * 这个模块负责：num（参数兜底）、stateTypes（张量名 → 组件类型）、
 * initProgram（按固定顺序灌初值，保证和导出的 C++ 同一组数）。
 */

import { LIBMAP } from './library.js';
import { tname } from './names.js';

export function num(v, dflt) { const x = v == null ? dflt : +v; return isFinite(x) ? x : dflt; }

// 初始化：顺序固定，保证和导出的 C++ 同一组数
// 按组件类型决定初始化：μ/θ 抽 U(−0.1,0.1)，β 填 0.05，其余清零。
// 名字只用来对号，所以用户把 M1 改名成 alpha 也照样能跑。
export function stateTypes(spec) {
  const m = {};
  for (const n of (spec && spec.nodes) || []) {
    const c = LIBMAP[n.type];
    if (c && c.state) m[tname(n)] = n.type;
  }
  return m;
}

export function initProgram(pr, spec) {
  pr.seed(spec.seed == null ? 42 : spec.seed);
  const types = stateTypes(spec);
  const kind = t => types[t.name] || (/^M\d+$/.test(t.name) ? 'M' : /^T\d+$/.test(t.name) ? 'T' : /^B\d+$/.test(t.name) ? 'B' : '');
  const states = pr.tensors.filter(t => t.isState);
  for (const t of states) {
    const k = kind(t);
    if (k === 'M' || k === 'T') pr.fillUniform(t, -0.1, 0.1);
    else if (k === 'B') pr.fill(t, 0.05);
    else pr.fill(t, 0);
  }
}
