/* studio/src/engine/lower.js —— 语义图 → Op[]：lower() 的七步
 *
 * 这个模块负责：把 spec（节点 + 连线）lower 成 Program。原来是 pcgraph.js 里一个
 * 两百多行的闭包大函数，现在按执行顺序拆成独立函数，原来的闭包状态统一挂在 ctx 上：
 * 建上下文 → 声明状态张量 → 逐个节点展开算子 / EM → 状态写回 → 收集监视张量 → 规划 arena。
 */

import { Program, PH } from './program.js';
import { LIBMAP } from './library.js';
import { sh, same, fmtShape } from './shape.js';
import { tname, label, stateShape } from './names.js';
import { num } from './init.js';

// ─────────────────────────── lowering ───────────────────────────

// 建 ctx：Program、张量表 T、错误表，以及按 id 的正查 / 反查索引
//（byId 是 id→节点，inc 是 "nodeId.port"→入边，就是原来的 byId / inc 邻接表）
export function createLowerContext(spec) {
  const D = spec.dims;
  const L = D.length - 1;
  const pr = new Program();
  const errors = [];
  // 监视组件不进 lowering，但它的连线要能查到源张量
  const all = spec.nodes.filter(n => LIBMAP[n.type]);
  const nodes = all.filter(n => !LIBMAP[n.type].view);
  const byId = {};
  all.forEach(n => (byId[n.id] = n));

  const T = {};           // "nodeId.port" → tensor
  const errNodes = new Set();
  const writing = new Set();
  const done = new Set();
  const inc = {};         // "nodeId.port" → edge
  for (const e of spec.edges) {
    if (byId[e.from[0]] && byId[e.to[0]]) inc[e.to[0] + '.' + e.to[1]] = e;
  }

  return { spec, D, L, pr, T, errors, errNodes, writing, done, all, byId, inc, nodes, views: {} };
}

// 报错：记进 errors，同时把节点记到 errNodes（界面据此标红）
const bad = (ctx, n, msg) => { ctx.errNodes.add(n.id); ctx.errors.push({ node: n.id, msg }); };

export function declareStates(ctx) {
  const { pr, T, nodes, spec } = ctx;
  // 状态张量（含 V），名字 = 节点标签
  for (const n of nodes) {
    const c = LIBMAP[n.type];
    if (!c.state) continue;
    const s = stateShape(spec, n);
    T[n.id + '.out'] = pr.state(tname(n), s);
  }
}

const stateT = (ctx, name) => ctx.pr.tensors.find(t => t.name === name && t.isState);

// 缺省状态：EM 需要 M/T/B/E，没有就自动补（省得用户手拖 4 个节点）
function ensure(ctx, name, s) {
  const e = stateT(ctx, name);
  if (e) return e;
  return ctx.pr.state(name, s);
}

// 某个端口的输入张量：顺着 to→from 的边找上游节点
function inTensor(ctx, n, port) {
  const { inc, byId } = ctx;
  const e = inc[n.id + '.' + port];
  if (!e) return null;
  return outOf(ctx, byId[e.from[0]], e.from[1]);
}

// 某个端口的输出张量（还没有就先把它 emit 出来）
function outOf(ctx, n, port) {
  const { T, errors, errNodes } = ctx;
  const key = n.id + '.' + port;
  if (T[key]) return T[key];
  emitNode(ctx, n);
  if (!T[key] && !errNodes.has(n.id)) errors.push({ node: n.id, msg: `${label(n)}.${port} 没有输出` });
  return T[key];
}

// 写回目标：op 的 d 连到状态 in 时，直接写那块内存
// （注意看的是从本节点 d 端口"出去"的边，不是进来的边）
function writeTarget(ctx, n, shape) {
  const { spec, T, errors, byId, pr } = ctx;
  const e = spec.edges.find(x => x.from[0] === n.id && x.from[1] === 'd' && x.to[1] === 'in');
  if (e) {
    const tgt = byId[e.to[0]];
    const tc = LIBMAP[tgt.type];
    if (tc && tc.state) {
      const st = T[tgt.id + '.out'];
      if (!same(st.shape, shape)) {
        errors.push({ node: n.id, msg: `写回 ${label(tgt)} 形状不符: ${fmtShape(shape)} → ${fmtShape(st.shape)}` });
        return pr.temp(n.id, shape);
      }
      return st;
    }
  }
  return pr.temp(n.id, shape);
}

// 逐个节点展开：状态节点在 declareStates 里登记过了，直接跳过
export function emitNode(ctx, n) {
  const { writing, done, errors } = ctx;
  if (!n || writing.has(n.id) || done.has(n.id)) return;
  const c = LIBMAP[n.type];
  if (!c) return;
  if (c.state) return;          // 状态是被动的
  writing.add(n.id);

  try {
    if (n.type === 'EM') emitEM(ctx, n);
    else emitOperator(ctx, n);
  } catch (err) {
    errors.push({ node: n.id, msg: err.message });
  }
  writing.delete(n.id);
  done.add(n.id);
}

// 算子：形状从连线上读出来 → 校验 → 生成 op
export function emitOperator(ctx, n) {
  const { pr, T } = ctx;
  const a = inTensor(ctx, n, 'a');
  const b = inTensor(ctx, n, 'b');
  const need = (n.type === 'ADD' || n.type === 'SUB' || n.type === 'MUL' ||
                n.type === 'MATMUL_NN' || n.type === 'MATMUL_NT' || n.type === 'MATMUL_TN');
  if (!a && !b) { bad(ctx, n, `${label(n)}: 输入没连线`); return; }
  if (need && (!a || !b)) {
    bad(ctx, n, `${label(n)}: 还差一个输入（都连上才算得出形状）`);
    return;
  }
  // 形状从连线上"读"出来：连对了就算得动，连错了就在这报出来
  let s;
  switch (n.type) {
    case 'MATMUL_NN':
      if (a.shape.c !== b.shape.r) { bad(ctx, n, `矩阵乘不上: ${fmtShape(a.shape)}·${fmtShape(b.shape)}（左列 ${a.shape.c} ≠ 右行 ${b.shape.r}）`); return; }
      s = sh(a.shape.r, b.shape.c); break;
    case 'MATMUL_NT':
      if (a.shape.c !== b.shape.c) { bad(ctx, n, `矩阵乘不上: ${fmtShape(a.shape)}·${fmtShape(b.shape)}ᵀ（列 ${a.shape.c} ≠ 列 ${b.shape.c}）`); return; }
      s = sh(a.shape.r, b.shape.r); break;
    case 'MATMUL_TN':
      if (a.shape.r !== b.shape.r) { bad(ctx, n, `矩阵乘不上: ${fmtShape(a.shape)}ᵀ·${fmtShape(b.shape)}（行 ${a.shape.r} ≠ 行 ${b.shape.r}）`); return; }
      s = sh(a.shape.c, b.shape.c); break;
    case 'ADD': case 'SUB': case 'MUL':
      if (!same(a.shape, b.shape)) { bad(ctx, n, `${n.type} 两边形状不一致: ${fmtShape(a.shape)} vs ${fmtShape(b.shape)}`); return; }
      s = a.shape; break;
    default: s = (a || b).shape;
  }
  const d = writeTarget(ctx, n, s);
  const ph = n.type === 'AXPY' ? PH.LEARN : PH.PREDICT;
  switch (n.type) {
    case 'MATMUL_NN': pr.mm(a, b, d); break;
    case 'MATMUL_NT': pr.mmtb(a, b, d); break;
    case 'MATMUL_TN': pr.mmta(a, b, d); break;
    case 'ADD': pr.add(a, b, d); break;
    case 'SUB': pr.sub(a, b, d); break;
    case 'MUL': pr.mul(a, b, d); break;
    case 'SCALE': pr.scale(num(n.s, 1), a, d); break;
    case 'TANH': pr.tanh(a, d); break;
    case 'ONE_MINUS_SQ': pr.oneMinusSq(a, d); break;
    case 'CLAMP': pr.clamp(a, d, num(n.c, 1)); break;
    case 'AXPY': pr.axpy(num(n.s, 0.1), a, d, ph); break;
  }
  T[n.id + '.d'] = d;
}

// EM 集成块：一次展开成预测 / 误差 / 更新三组 op
export function emitEM(ctx, n) {
  const { pr, T, spec } = ctx;
  const l = n.l || 1;
  // 形状完全由接进来的状态决定：μ 是 (1×Du)，θ 是 (Du×Dd)
  const M = inTensor(ctx, n, 'mu');
  const Tt = inTensor(ctx, n, 'th');
  if (!M || !Tt) { bad(ctx, n, `EM 需要把 μ 和 θ 两个状态接进来（形状从它们读）`); return; }
  if (M.shape.r !== 1) { bad(ctx, n, `EM 的 μ 应该是行向量 (1×n)，现在是 ${fmtShape(M.shape)}`); return; }
  const Du = M.shape.c, Dd = Tt.shape.c;
  if (Tt.shape.r !== Du) { bad(ctx, n, `EM 的 θ 应该是 (${Du}×n)，现在是 ${fmtShape(Tt.shape)}`); return; }
  const B = inTensor(ctx, n, 'be') || ensure(ctx, 'B' + l, sh(1, Dd));
  if (!same(B.shape, sh(1, Dd))) { bad(ctx, n, `EM 的 β 应该是 (1×${Dd})，现在是 ${fmtShape(B.shape)}`); return; }
  const E = ensure(ctx, 'E' + l, sh(1, Du));
  if (!same(E.shape, sh(1, Du))) { bad(ctx, n, `EM 的误差状态应该是 (1×${Du})，现在是 ${fmtShape(E.shape)}`); return; }
  const g = inTensor(ctx, n, 'g');
  const fa = inTensor(ctx, n, 'fa');

  const pre = pr.temp('pre' + l, sh(1, Dd));
  const f = pr.temp('f' + (l - 1), sh(1, Dd));
  pr.mm(M, Tt, pre, false, PH.PREDICT);
  pr.add(pre, B, f, PH.PREDICT);
  pr.tanh(f, f, PH.PREDICT);

  if (fa) {
    if (!same(fa.shape, M.shape)) bad(ctx, n, `f_l 形状不符: ${fmtShape(fa.shape)} vs ${fmtShape(M.shape)}`);
    pr.sub(M, fa, E, PH.PREDICT);
  } else {
    // 顶层：先验 N(0, Σ_l)，精度 ω = spec.wTop。ε = ω·μ（否则 ε=μ 会把 μ 压向 0，
    // 高阶表征塌缩、只剩偏置在拟合——这正是修好之前的现象）
    pr.scale(num(spec.wTop, 0.02), M, E, PH.PREDICT);
  }
  T[n.id + '.f'] = f;
  T[n.id + '.eps'] = E;

  // 三个状态位的新值（推理 / 学习）
  const mu1 = pr.temp('mu_hat' + l, sh(1, Du));
  const th1 = pr.temp('th_hat' + l, sh(Du, Dd));
  const be1 = pr.temp('be_hat' + l, sh(1, Dd));
  if (g) {
    if (!same(g.shape, sh(1, Dd))) bad(ctx, n, `g 形状不符: ${fmtShape(g.shape)} vs ${fmtShape(sh(1, Dd))}`);
    const dmu = pr.temp('dmu' + l, sh(1, Du));
    pr.mmtb(g, Tt, dmu, false, PH.INFER);      // g·θᵀ
    pr.sub(dmu, E, dmu, PH.INFER);             // − ε_l
    pr.copy(M, mu1, PH.INFER);
    pr.axpy(num(spec.lrMu, 0.1), dmu, mu1, PH.INFER);   // μ′ = μ + η(gθᵀ − ε)
    const dT = pr.temp('dT' + l, sh(Du, Dd));
    pr.mmta(M, g, dT, false, PH.LEARN);        // μᵀg
    pr.copy(Tt, th1, PH.LEARN);
    pr.axpy(num(spec.lrT, 0.01), dT, th1, PH.LEARN);
    pr.copy(B, be1, PH.LEARN);
    pr.axpy(num(spec.lrB, 0.01), g, be1, PH.LEARN);
  } else {
    pr.copy(M, mu1, PH.PREDICT);
    pr.copy(Tt, th1, PH.PREDICT);
    pr.copy(B, be1, PH.PREDICT);
  }
  T[n.id + '.mu1'] = mu1;
  T[n.id + '.th1'] = th1;
  T[n.id + '.be1'] = be1;
}

// 状态写回：某个 op/EM 的输出连到状态的 in ⇒ 把新值赋值进去
// （必须放在所有节点展开之后：写回要用到本步刚算出来的值）
export function applyStateWrites(ctx) {
  const { pr, T, errors, byId, inc, nodes } = ctx;
  for (const n of nodes) {
    const c = LIBMAP[n.type];
    if (!c.state) continue;
    const e = inc[n.id + '.in'];
    if (!e) continue;
    const src = byId[e.from[0]];
    if (!src) continue;
    const st = outOf(ctx, src, e.from[1]);
    if (!st || st.id === T[n.id + '.out'].id) continue;   // 已经原地写进去了，不用再拷
    if (!same(st.shape, T[n.id + '.out'].shape)) {
      errors.push({ node: n.id, msg: `写回形状不符: ${fmtShape(st.shape)} → ${fmtShape(T[n.id + '.out'].shape)}` });
      continue;
    }
    pr.copy(st, T[n.id + '.out'], pr.lastPhase(st));
  }
}

// 监视组件：记下它要看的那块张量（只显示，不参与计划）
export function collectViews(ctx) {
  const { spec, inc, byId } = ctx;
  const views = {};
  for (const n of spec.nodes) {
    const c = LIBMAP[n.type];
    if (!c || !c.view) continue;
    const e = inc[n.id + '.v'];
    if (!e) continue;
    const src = byId[e.from[0]];
    if (!src) continue;
    const t = outOf(ctx, src, e.from[1]);
    if (t) views[n.id] = t;
  }
  ctx.views = views;
  return views;
}

// 收尾：有错就把 total 归零（界面显示规划不出来），没错就排 arena
export function finalize(ctx, opts) {
  const { pr, errors, T, D, L, views } = ctx;
  opts = opts || {};
  if (!errors.length) pr.plan(64, opts.reuse !== false);
  else pr.total = 0;

  return { pr, errors, T, D, L, views };
}

// 返回 {pr, errors, T, stats}
export function lower(spec, opts) {
  opts = opts || {};
  const ctx = createLowerContext(spec);
  declareStates(ctx);
  // 展开所有有输出的节点（深度优先，自动处理依赖）
  for (const n of ctx.nodes) emitNode(ctx, n);
  applyStateWrites(ctx);
  collectViews(ctx);
  return finalize(ctx, opts);
}
