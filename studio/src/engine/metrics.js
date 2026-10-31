/* studio/src/engine/metrics.js —— 统计与自由能
 *
 * 这个模块负责：op / 相位 / arena 的统计（metrics），以及自由能 F = Σ_l ‖ε_l‖²（freeEnergy）。
 */

import { stateTypes } from './init.js';

export function metrics(pr) {
  const byPhase = [0, 0, 0];
  const byKind = {};
  for (const o of pr.ops) {
    byPhase[o.phase]++;
    byKind[o.k] = (byKind[o.k] || 0) + 1;
  }
  return { ops: pr.ops.length, byPhase, byKind, stateBytes: pr.stateBytes, tempBytes: pr.tempBytes,
           total: pr.total, tensors: pr.tensors.length };
}

// 自由能 F = Σ_l Σ_i ε_l[i]²（Σ_l 取单位阵）
export function freeEnergy(pr, spec) {
  const types = spec ? stateTypes(spec) : {};
  let F = 0;
  const perLayer = [];
  for (const t of pr.tensors) {
    if (!t.isState) continue;
    const isE = types[t.name] ? types[t.name] === 'E' : /^E\d+$/.test(t.name);
    if (!isE) continue;
    const p = pr.ptr(t);
    let s = 0;
    for (let i = 0; i < t.shape.n; i++) s += pr.buf[p + i] * pr.buf[p + i];
    perLayer.push({ name: t.name, e: s });
    F += s;
  }
  return { F, perLayer };
}
