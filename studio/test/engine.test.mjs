/* 引擎冒烟测试（零依赖，用 node 内置 test runner）
 *
 *   node --test studio/test/
 *
 * 只测"和 C++ 必须一致"的那些事实：图的规模、arena 大小、错误文案、随机序列。
 * 数值曲线不在这里比（那是 studio/dump_js.mjs 与 ./build/pc_basic 的对数工作）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as PC from '../src/engine/index.js';

const sizes = spec => {
  const { pr, errors } = PC.lower(spec);
  return { pr, errors, ops: pr.ops.length, total: pr.total, state: pr.stateBytes, temp: pr.tempBytes };
};

test('两层图：规模与 arena', () => {
  const r = sizes(PC.presetBasic([16, 64]));
  assert.equal(r.errors.length, 0);
  assert.equal(r.ops, 21);
  assert.equal(r.total, 13888);
  assert.equal(r.state, 5056);
  assert.equal(r.temp, 8832);
});

test('两层图 64×1024：规模与 arena', () => {
  const r = sizes(PC.presetBasic([64, 1024]));
  assert.equal(r.errors.length, 0);
  assert.equal(r.ops, 21);
  assert.equal(r.total, 805120);
  assert.equal(r.state, 272128);
  assert.equal(r.temp, 532992);
});

test('三层图：规模与 arena', () => {
  const r = sizes(PC.presetDeep([64, 512, 256]));
  assert.equal(r.errors.length, 0);
  assert.equal(r.ops, 41);
  assert.equal(r.total, 1726208);
});

test('只有输入层：退化成一次拷贝', () => {
  const r = sizes(PC.presetSingle([64]));
  assert.equal(r.errors.length, 0);
  assert.ok(r.ops >= 1);
});

test('相位划分：预测 / 推理 / 学习 三段都有', () => {
  const { pr } = PC.lower(PC.presetBasic([16, 64]));
  const byPhase = {};
  for (const o of pr.ops) byPhase[o.phase] = (byPhase[o.phase] || 0) + 1;
  assert.ok(byPhase[PC.PH.PREDICT] > 0);
  assert.ok(byPhase[PC.PH.INFER] > 0);
  assert.ok(byPhase[PC.PH.LEARN] > 0);
});

test('run(phase) 能截断：只跑到推理段就不会动 θ', () => {
  const spec = PC.presetBasic([16, 64]);
  const { pr } = PC.lower(spec);
  PC.initProgram(pr, spec);
  const th = pr.tensors.find(t => t.name === 'T1');
  const q = pr.ptr(th);
  const before = pr.buf.slice(q, q + th.shape.n);
  for (let i = 0; i < 30; i++) PC.runPhase(pr, PC.PH.INFER);
  for (let i = 0; i < th.shape.n; i++) assert.equal(pr.buf[q + i], before[i]);
});

test('形状不匹配：只报一条，文案不变', () => {
  const spec = {
    lrMu: 0.1, lrT: 0.01, lrB: 0.01, nInfer: 10, seed: 1,
    nodes: [
      { id: 'a', type: 'V', name: 'a', shape: { r: 1, c: 8 }, pos: {} },
      { id: 'b', type: 'V', name: 'b', shape: { r: 6, c: 4 }, pos: {} },
      { id: 'mm', type: 'MATMUL_NN', pos: {} },
      { id: 'c', type: 'V', name: 'c', shape: { r: 1, c: 4 }, pos: {} },
    ],
    edges: [
      { from: ['a', 'out'], to: ['mm', 'a'] },
      { from: ['b', 'out'], to: ['mm', 'b'] },
      { from: ['mm', 'd'], to: ['c', 'in'] },
    ],
  };
  const { errors } = PC.lower(spec);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /矩阵乘不上/);
});

test('EM 缺 θ：报错指向 EM 节点', () => {
  const spec = PC.presetBasic([16, 64]);
  spec.nodes = spec.nodes.filter(n => n.name !== 'T1');
  spec.edges = spec.edges.filter(e => e.from[0] !== 'T1' && e.to[0] !== 'T1');
  const { errors } = PC.lower(spec);
  assert.ok(errors.length >= 1);
  assert.ok(errors.some(e => /EM|θ/.test(e.msg)));
});

test('mt19937 序列：与 C++ std::mt19937 + /2^32 一致', () => {
  // std::mt19937(42) 前三个输出（标准测试向量），映射到 [0,1) 后取 7 位
  const r = new PC.MT(42);
  const got = [r.next32(), r.next32(), r.next32()];
  assert.deepEqual(got, [1608637542, 3421126067, 4083286876]);
  assert.equal(r.uniform(0, 1) >= 0, true);
});

test('emitCpp：生成的头文件含模型骨架', () => {
  const { text, errors } = PC.emitCpp(PC.presetBasic([16, 64]), 'demo');
  assert.equal(errors.length, 0);
  assert.match(text, /#pragma once/);
  assert.match(text, /namespace gen_demo/);
  assert.match(text, /pc::Program/);
  assert.match(text, /inline void build\(/);
});

test('导出 API 齐全（UI 与 C++ 对数脚本都靠它）', () => {
  for (const k of ['lower', 'initProgram', 'metrics', 'freeEnergy', 'presetBasic', 'emitCpp',
                   'stateShape', 'portShape', 'tname', 'label', 'LIB', 'LIBMAP', 'MT', 'runPhase', 'PH']) {
    assert.ok(PC[k] !== undefined, `缺少导出 ${k}`);
  }
});
