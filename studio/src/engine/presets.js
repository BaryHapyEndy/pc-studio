/* studio/src/engine/presets.js —— 预设图
 *
 * 这个模块负责：几种开箱即用的语义图（2 层 / 3 层 / 只用输入层），以及按名字索引的 PRESETS。
 */

// ─────────────────────────── 预设图 ───────────────────────────
// 每一层（stage c：第 c 层被第 c+1 层预测）用一个横向条带画出来：
//
//   M[c+1] ┐                                                        ┌ g[c] ┐
//   T[c+1] ┤→ EM[c+1] → P[c] → SUB → E[c] ┐                        │      │
//   B[c+1] ┘                            └→ ONE_MINUS_SQ → D[c] ┴→ MUL ┘
//
// 状态节点的左边是写、右边是读；EM 的 μ′/θ′/β′ 连回状态左边完成更新。
export function presetLayers(dims) {
  const D = dims || [64, 1024];
  const L = D.length;
  const nodes = [], edges = [];
  const X = { st: 20, em: 200, pred: 450, sub: 630, err: 810 };
  const DY = 132;                    // 同列节点的纵向间距
  // 从顶层往下排；第 1 层那条带最高（它还要放 x 和 M[0]）
  // 顶层还要多放一个"本层误差 ε_L"状态，所以再高一点
  function bandH(l) { return (l === 1 ? DY * 5 + 40 : DY * 3 + 40) + (l === L - 1 ? 120 : 0); }
  const yOf = {};
  for (let l = L - 1; l >= 1; l--) {
    let y = 30;
    for (let k = L - 1; k > l; k--) y += bandH(k);
    yOf[l] = y;
  }
  const uid = (a, b) => a + b;

  for (let l = L - 1; l >= 1; l--) {
    const y = yOf[l], c = l - 1;
    // 状态列
    if (l === 1) {
      nodes.push({ id: 'x', type: 'x', name: 'x', shape: { r: 1, c: D[0] }, pos: { x: X.st, y: y } });
      nodes.push({ id: 'M0', type: 'M', l: 0, name: 'M0', shape: { r: 1, c: D[0] }, pos: { x: X.st, y: y + DY } });
    }
    const stBase = l === 1 ? y + DY * 2 : y;
    nodes.push({ id: uid('M', l), type: 'M', l: l, name: 'M' + l, shape: { r: 1, c: D[l] }, pos: { x: X.st, y: stBase } });
    nodes.push({ id: uid('T', l), type: 'T', l: l, name: 'T' + l, shape: { r: D[l], c: D[l - 1] }, pos: { x: X.st, y: stBase + DY } });
    nodes.push({ id: uid('B', l), type: 'B', l: l, name: 'B' + l, shape: { r: 1, c: D[l - 1] }, pos: { x: X.st, y: stBase + DY * 2 } });
    nodes.push({ id: uid('EM', l), type: 'EM', l: l, pos: { x: X.em, y: y } });
    // 预测链
    nodes.push({ id: uid('P', c), type: 'V', name: 'P' + c, shape: { r: 1, c: D[c] }, pos: { x: X.pred, y: y + 40 } });
    nodes.push({ id: uid('DM', c), type: 'ONE_MINUS_SQ', pos: { x: X.pred, y: y + 180 } });
    nodes.push({ id: uid('SUB', c), type: 'SUB', pos: { x: X.sub, y: y + 40 } });
    nodes.push({ id: uid('D', c), type: 'V', name: 'd' + c, shape: { r: 1, c: D[c] }, pos: { x: X.sub, y: y + 180 } });
    nodes.push({ id: uid('E', c), type: 'E', l: c, name: 'E' + c, shape: { r: 1, c: D[c] }, pos: { x: X.err, y: y + 40 } });
    nodes.push({ id: uid('MUL', c), type: 'MUL', pos: { x: X.err, y: y + 180 } });
    nodes.push({ id: uid('G', c), type: 'V', name: 'g' + c, shape: { r: 1, c: D[c] }, pos: { x: X.sub, y: y + 300 } });

    for (const [k, st] of [['mu', 'M'], ['th', 'T'], ['be', 'B']]) {
      edges.push({ from: [st + l, 'out'], to: ['EM' + l, k] });
      edges.push({ from: ['EM' + l, k + '1'], to: [st + l, 'in'] });
    }
    edges.push({ from: ['EM' + l, 'f'], to: ['P' + c, 'in'] });
    if (l === L - 1) {
      // 顶层没有上层预测 ⇒ ε_l 由 EM 直接给出（ε = ω·μ），单独挂一个误差状态方便观察
      nodes.push({ id: 'Etop' + l, type: 'E', l: l, name: 'E' + l, shape: { r: 1, c: D[l] }, pos: { x: X.pred, y: y + 400 } });
      edges.push({ from: ['EM' + l, 'eps'], to: ['Etop' + l, 'in'] });
    }
    edges.push({ from: ['M' + c, 'out'], to: ['SUB' + c, 'a'] });
    edges.push({ from: ['P' + c, 'out'], to: ['SUB' + c, 'b'] });
    edges.push({ from: ['SUB' + c, 'd'], to: ['E' + c, 'in'] });
    edges.push({ from: ['P' + c, 'out'], to: ['DM' + c, 'a'] });
    edges.push({ from: ['DM' + c, 'd'], to: ['D' + c, 'in'] });
    edges.push({ from: ['E' + c, 'out'], to: ['MUL' + c, 'a'] });
    edges.push({ from: ['D' + c, 'out'], to: ['MUL' + c, 'b'] });
    edges.push({ from: ['MUL' + c, 'd'], to: ['G' + c, 'in'] });
    edges.push({ from: ['G' + c, 'out'], to: ['EM' + l, 'g'] });
    if (l + 1 < L) edges.push({ from: ['EM' + (l + 1), 'f'], to: ['EM' + l, 'fa'] });
  }
  // 输入 → 第 0 层
  edges.push({ from: ['x', 'out'], to: ['M0', 'in'] });
  return { dims: D, lrMu: 0.1, lrT: 0.01, lrB: 0.01, nInfer: 20, seed: 42, wTop: 0.02, nodes, edges };
}

export function presetBasic(dims) { return presetLayers(dims || [64, 1024]); }
export function presetDeep(dims) { return presetLayers(dims || [64, 512, 256]); }

// 单层：只有 x 和 M[0]，没有 EM（用来看"没有隐藏层时会怎样"）
export function presetSingle(dims) {
  const D = dims || [64];
  return {
    dims: D, lrMu: 0.1, lrT: 0.01, lrB: 0.01, nInfer: 20, seed: 42, wTop: 0.02,
    nodes: [{ id: 'x', type: 'x', name: 'x', shape: { r: 1, c: D[0] }, pos: { x: 60, y: 200 } },
            { id: 'M0', type: 'M', l: 0, name: 'M0', shape: { r: 1, c: D[0] }, pos: { x: 240, y: 200 } }],
    edges: [{ from: ['x', 'out'], to: ['M0', 'in'] }],
  };
}

// 按名字取预设（界面 / 单测都从这里拿）
export const PRESETS = {
  basic:  (dims) => presetLayers(dims || [64, 1024]),
  deep:   (dims) => presetLayers(dims || [64, 512, 256]),
  single: (dims) => presetSingle(dims || [64]),
};
