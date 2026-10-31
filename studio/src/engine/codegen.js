/* studio/src/engine/codegen.js —— 导出 C++
 *
 * 这个模块负责：把已经规划好的 Program 逐张量、逐 op 生成 C++，保证导出的
 * 代码和图上的数逐位一致。
 */

import { lower } from './lower.js';
import { fmtShape } from './shape.js';
import { stateTypes } from './init.js';

// ─────────────────────────── C++ 导出 ───────────────────────────
// 直接按"已规划的程序"逐张量、逐 op 生成，因此永远和图上一致。
export function emitCpp(spec, name) {
  const { pr, errors } = lower(spec, { reuse: true });
  if (errors.length) return { text: '// 图有错误，无法导出：\n' + errors.map(e => '//   ' + e.msg).join('\n'), errors };
  const D = spec.dims, L = D.length - 1;
  const varOf = {}, refOf = {};
  pr.tensors.forEach((t, i) => {
    varOf[t.name] = 't' + i;
    refOf[t.name] = (t.isState ? 'm.' : '') + 't' + i;   // 状态是成员，临时量是局部变量
  });
  const L2 = [];
  const p = s => L2.push(s);

  p(`// 由 pc-studio 导出 —— ${pr.tensors.filter(t => t.isState).length} 个状态，${pr.ops.length} 个 op，arena ${pr.total} B`);
  p('// 与界面里的图一一对应；用法见 examples/pc_basic.cpp');
  p('#pragma once');
  p('#include <cstdint>');
  p('#include "engine/pc.hpp"');
  p('');
  p(`namespace gen_${name || 'model'} {`);
  p(`inline constexpr int NL = ${L};`);
  p(`inline constexpr int D[${D.length}] = {${D.join(', ')}};`);
  p('');
  p('struct Model {');
  p('    pc::Program pr;');
  for (const t of pr.tensors) if (t.isState) p(`    pc::Tens ${varOf[t.name]};   // ${t.name} ${fmtShape(t.shape)}`);
  p('};');
  p('');
  p('inline void build(Model& m) {');
  p('    pc::Program& pr = m.pr;');
  for (const t of pr.tensors) {
    const ctor = t.isState ? 'state' : 'temp';
    const decl = t.isState ? `m.${varOf[t.name]} =` : `auto ${varOf[t.name]} =`;
    p(`    ${decl} pr.${ctor}("${t.name}", pc::sh(${t.shape.r}, ${t.shape.c}));`);
  }
  p('');
  for (const o of pr.ops) {
    const A = n => (n && n.id >= 0 ? refOf[n.name] : '{}');
    const ph = o.phase === 0 ? '' : `, pc::PH_${o.phase === 1 ? 'INFER' : 'LEARN'}`;
    const acc = o.acc ? ', true' : '';
    switch (o.k) {
      case 'CLEAR': p(`    pr.clear(${A(o.d)}${ph});`); break;
      case 'COPY': p(`    pr.copy(${A(o.a)}, ${A(o.d)}${ph});`); break;
      case 'ADD': p(`    pr.add(${A(o.a)}, ${A(o.b)}, ${A(o.d)}${ph});`); break;
      case 'SUB': p(`    pr.sub(${A(o.a)}, ${A(o.b)}, ${A(o.d)}${ph});`); break;
      case 'MUL': p(`    pr.mul(${A(o.a)}, ${A(o.b)}, ${A(o.d)}${ph});`); break;
      case 'SCALE': p(`    pr.mulc(${o.scalar}f, ${A(o.a)}, ${A(o.d)}${ph});`); break;
      case 'TANH': p(`    pr.tanh(${A(o.a)}, ${A(o.d)}${ph});`); break;
      case 'ONE_MINUS_SQ': p(`    pr.one_minus_sq(${A(o.a)}, ${A(o.d)}${ph});`); break;
      case 'CLAMP': p(`    pr.clamp(${A(o.a)}, ${A(o.d)}, ${o.scalar}f${ph});`); break;
      case 'AXPY': p(`    pr.axpy(${o.scalar}f, ${A(o.a)}, ${A(o.d)}${ph});`); break;
      // acc 必须显式传：否则相位实参会落进 acc 形参（bool 隐式转换）
      case 'SUM_ROWS': p(`    pr.sum_rows(${A(o.a)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
      case 'MATMUL_NN': p(`    pr.mm(${A(o.a)}, ${A(o.b)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
      case 'MATMUL_TN': p(`    pr.mmta(${A(o.a)}, ${A(o.b)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
      case 'MATMUL_NT': p(`    pr.mmtb(${A(o.a)}, ${A(o.b)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
    }
  }
  p('    pr.plan(64, true);');
  p('}');
  p('');
  p('// 初始化顺序与界面一致（同一个种子 ⇒ 同一组初值）');
  p('inline void init(Model& m, uint32_t seed = 42) {');
  p('    auto& pr = m.pr;');
  p('    pr.seed(seed);');
  const types = stateTypes(spec);
  const kindOf = n => types[n] || (/^M\d+$/.test(n) || /^T\d+$/.test(n) ? 'M' : /^B\d+$/.test(n) ? 'B' : '');
  for (const t of pr.tensors) {
    if (!t.isState) continue;
    const k = kindOf(t.name);
    if (k === 'M' || k === 'T') p(`    pr.fill_uniform(m.${varOf[t.name]}, -0.1f, 0.1f);`);
    else if (k === 'B') p(`    pr.fill(m.${varOf[t.name]}, 0.05f);`);
    else p(`    pr.fill(m.${varOf[t.name]}, 0.f);`);
  }
  p('}');
  p('');
  p(`// 每步：相位 0/1 全跑；每 ${spec.nInfer || 10} 步跑一次相位 2（学习）`);
  p('inline void step(Model& m, int it) {');
  p(`    m.pr.run(it % ${spec.nInfer || 10} == ${(spec.nInfer || 10) - 1} ? pc::PH_LEARN : pc::PH_INFER);`);
  p('}');
  p('');
  p('}  // namespace');
  return { text: L2.join('\n'), errors };
}
