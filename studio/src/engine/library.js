/* studio/src/engine/library.js —— 组件库
 *
 * 这个模块负责：界面上可点的组件定义（状态组件、算子、EM 集成块）和按 id 的索引 LIBMAP。
 */

// ─────────────────────────── 组件库 ───────────────────────────
// shape 规则统一用 (D, l) 求值；宽 D[l] 的行向量约定见 docs
export const LIB = [
  // 状态组件：名字和形状都是用户自己填的（不预设层宽 D）。
  // 算子连上来之后，会按连线的形状去校验，不合法就在节点上报错。
  { id: 'x', name: '输入 x', group: '状态', color: '#e2b86b', note: '观测。最低层，永远不被更新',
    state: true, ins: [{ k: 'in', name: '写', optional: true }], outs: [{ k: 'out', optional: true, name: 'x' }] },

  { id: 'M', name: '后验 μ', group: '状态', color: '#69c98a', note: '后验状态，典型形状 1 × n 的行向量',
    state: true, ins: [{ k: 'in', name: '写', optional: true }], outs: [{ k: 'out', optional: true, name: 'μ' }] },

  { id: 'T', name: '权重 θ', group: '状态', color: '#5aa9e6', note: '权重状态，典型形状 n_上 × n_下',
    state: true, ins: [{ k: 'in', name: '写', optional: true }], outs: [{ k: 'out', optional: true, name: 'θ' }] },

  { id: 'B', name: '偏置 β', group: '状态', color: '#9b7ff0', note: '偏置状态，形状要和它预测的那层一致',
    state: true, ins: [{ k: 'in', name: '写', optional: true }], outs: [{ k: 'out', optional: true, name: 'β' }] },

  { id: 'E', name: '误差 ε', group: '状态', color: '#ef7c74', note: '误差状态 ε = μ − f',
    state: true, ins: [{ k: 'in', name: '写', optional: true }], outs: [{ k: 'out', optional: true, name: 'ε' }] },

  { id: 'V', name: '中间量', group: '状态', color: '#8d9bb0', note: '通用命名缓冲区（f、d、g …放在这里好观察）',
    state: true, ins: [{ k: 'in', name: '写', optional: true }], outs: [{ k: 'out', optional: true, name: 'v' }] },

  { id: 'MON', name: '监视', group: '状态', color: '#7bd88f', note: '把一个张量画成方阵热力图（纯显示，不参与计算）',
    view: true, ins: [{ k: 'v', name: '看', optional: true }], outs: [] },

  { id: 'MATMUL_NN', name: 'MATMUL_NN', group: '算子', color: '#7fa8d8', note: 'd = a·b',
    ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'MATMUL_NT', name: 'MATMUL_NT', group: '算子', color: '#7fa8d8', note: 'd = a·bᵀ',
    ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'MATMUL_TN', name: 'MATMUL_TN', group: '算子', color: '#7fa8d8', note: 'd = aᵀ·b',
    ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'ADD', name: 'ADD', group: '算子', color: '#7fa8d8', note: 'd = a + b',
    ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'SUB', name: 'SUB', group: '算子', color: '#7fa8d8', note: 'd = a − b',
    ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'MUL', name: 'MUL', group: '算子', color: '#7fa8d8', note: 'd = a ⊙ b',
    ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'SCALE', name: 'SCALE', group: '算子', color: '#7fa8d8', note: 'd = s·a',
    params: ['s'], defaults: { s: 1 }, ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'TANH', name: 'TANH', group: '算子', color: '#7fa8d8', note: 'd = tanh(a)',
    ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'ONE_MINUS_SQ', name: 'ONE_MINUS_SQ', group: '算子', color: '#7fa8d8', note: 'd = 1 − a²（tanh 导数）',
    ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'AXPY', name: 'AXPY 累加', group: '算子', color: '#e0a458', note: 'd += s·a —— 原地写回状态',
    params: ['s'], defaults: { s: 0.1 }, ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd', optional: true }] },
  { id: 'CLAMP', name: 'CLAMP', group: '算子', color: '#7fa8d8', note: 'd = clip(a, ±c)',
    params: ['c'], defaults: { c: 1 }, ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd', optional: true }] },

  { id: 'EM', name: 'EM 集成块', group: '集成', color: '#e8a0c0',
    note: '一层的前向预测 + 误差 + 推理更新 + 学习更新。左下接 g（下层的 ε⊙d），左侧三个状态位的读/写各走一条线。',
    macro: true, params: ['l'],
    // 必需（不接就算不出来）：mu、th。其余都可以不接——g/fa 缺了就当 0，
    // be 缺了 EM 自己造一个，mu1/th1/be1 不接就只是「不做更新」。
    ins: [{ k: 'g', name: 'g（下层 ε⊙d）', optional: true },
          { k: 'mu', name: 'μ（读）' },
          { k: 'th', name: 'θ（读）' },
          { k: 'be', name: 'β（读）', optional: true },
          { k: 'fa', name: 'f_l（上层预测）', optional: true }],
    // EM 右侧整排都是输出口（黄）；要不要接到状态上由用户决定。
    outs: [{ k: 'f', name: 'f（预测下层）', optional: true },
           { k: 'eps', name: 'ε（本层误差）', optional: true },
           { k: 'mu1', name: 'μ′ 写回', optional: true },
           { k: 'th1', name: 'θ′ 写回', optional: true },
           { k: 'be1', name: 'β′ 写回', optional: true }] },
];
export const LIBMAP = {}; LIB.forEach(c => (LIBMAP[c.id] = c));
