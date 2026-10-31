// 这个模块负责：造训练样本——几个随机频率的正弦叠加出的平滑模式，归一化到 [-1,1]。

import * as PC from '../engine/index.js';

export function makePattern(D0, r) {
  const v = new Float32Array(D0);
  for (let f = 0; f < 3; f++) {
    const a = r.uniform(-1, 1), b = r.uniform(-1, 1), freq = 1 + Math.floor(r.uniform(0, 3));
    for (let i = 0; i < D0; i++) v[i] += a * Math.sin(2 * Math.PI * freq * i / D0) + b * Math.cos(2 * Math.PI * (freq + 1) * i / D0);
  }
  let m = 0; for (const x of v) m = Math.max(m, Math.abs(x));
  for (let i = 0; i < D0; i++) v[i] /= (m || 1);
  return v;
}

export function makeDataset(D0, n, seed) {
  const r = new PC.MT(seed || 7), out = [];
  for (let k = 0; k < n; k++) {
    // 由几个随机频率的正弦叠加出的平滑模式，归一化到 [-1,1]
    const v = new Float32Array(D0);
    for (let f = 0; f < 3; f++) {
      const a = r.uniform(-1, 1), b = r.uniform(-1, 1), freq = 1 + Math.floor(r.uniform(0, 3));
      for (let i = 0; i < D0; i++) v[i] += a * Math.sin(2 * Math.PI * freq * i / D0) + b * Math.cos(2 * Math.PI * (freq + 1) * i / D0);
    }
    let m = 0; for (const x of v) m = Math.max(m, Math.abs(x));
    for (let i = 0; i < D0; i++) v[i] /= (m || 1);
    out.push(v);
  }
  return out;
}
