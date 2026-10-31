// 打印与 examples/pc_basic.cpp 完全相同的表，用于跨语言核对
//
//   node studio/dump_js.mjs 2000 500 [输出文件]
//
// 与 ./build/pc_basic 2000 500 的输出逐行对照：应有 7 位有效数字一致
// （末几位差异只来自 sin/cos 与 float32 舍入）。
import { writeFileSync } from 'node:fs';
import * as PC from './src/engine/index.js';

const D = [64, 1024];
const spec = PC.presetBasic(D);
const { pr } = PC.lower(spec);
PC.initProgram(pr, spec);

const T = n => pr.tensors.find(t => t.name === n);
const xt = T('x');
const p = pr.ptr(xt);
const E0 = T('E0'), E1 = T('E1');
const sumsq = t => {
  const q = pr.ptr(t);
  let s = 0;
  for (let i = 0; i < t.shape.n; i++) s += pr.buf[q + i] ** 2;
  return s;
};

const r = new PC.MT(11);
const pat = () => {
  const v = new Float32Array(D[0]);
  for (let f = 0; f < 3; f++) {
    const a = r.uniform(-1, 1), b = r.uniform(-1, 1), q = 1 + Math.floor(r.uniform(0, 3));
    for (let i = 0; i < D[0]; i++) {
      const t = 2 * Math.PI * i / D[0];
      v[i] += a * Math.sin(q * t) + b * Math.cos((q + 1) * t);
    }
  }
  let m = 0;
  for (const x of v) m = Math.max(m, Math.abs(x));
  for (let i = 0; i < D[0]; i++) v[i] /= (m || 1);
  return v;
};

const steps = +(process.argv[2] || 600);
const every = +(process.argv[3] || 100);
const nI = spec.nInfer;

const out = [
  `# ops=${pr.ops.length} arena=${pr.total} B (state ${pr.stateBytes} + temp ${pr.tempBytes})`,
  '# step  F          E0         E1',
];

for (let it = 0; it < steps; it++) {
  if (it % nI === 0) {
    const cur = pat();
    for (let i = 0; i < D[0]; i++) pr.buf[p + i] = cur[i];
  }
  PC.runPhase(pr, (it % nI) === nI - 1 ? 2 : 1);
  if (it % every === 0 || it === steps - 1) {
    const e0 = sumsq(E0), e1 = sumsq(E1);
    out.push(`${String(it).padStart(6)}  ${(e0 + e1).toPrecision(6)}  ${e0.toPrecision(6)}  ${e1.toPrecision(6)}`);
  }
}

writeFileSync(process.argv[4] || '/tmp/js_table.txt', out.join('\n') + '\n');
console.log(out.join('\n'));
