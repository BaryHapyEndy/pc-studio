/* tools/emit.js —— 把一条 schedule 落成 C++ 头文件
 *
 *   node tools/emit.js            # 写 gen/sched_comp1.hpp，并打印各配置的规模
 *
 * 生成的头文件自带 core/ 依赖，examples/schedule_demo.cpp 直接 include 就能跑。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./schedgen.js');

const ROOT = path.resolve(__dirname, '..');
const GEN = path.join(ROOT, 'gen');

const BASE = { D: [1024, 64, 16], K: 3 };
const CONFIGS = [
  // 名字            spec
  ['local1', Object.assign({}, BASE, { connections: 1, fusion: 'local' })],
  ['comp1', Object.assign({}, BASE, { connections: 1, fusion: 'compound' })],
  ['comp1_learn', Object.assign({}, BASE, { connections: 1, fusion: 'compound', learnM0: true })],
  ['comp1_gate', Object.assign({}, BASE, { connections: 1, fusion: 'compound', gate: true })],
  ['comp2', Object.assign({}, BASE, { connections: 2, fusion: 'compound' })],
];

// 只有这一个进版本库：低层运行时的演示用例
const SHIP = 'comp1';

function header(res, ns) {
  const init = S.emitCppInit(res, ns);
  return [
    S.emitCpp(res, ns),
    'namespace ' + ns + ' {',
    init,
    'struct Cfg {',
    '    static uint32_t numBuf() { return NUM_BUF; }',
    '    static const std::size_t* sizes() { return ARENA_BYTES; }',
    '    static void init(StateArena& a) { init_values(a); }',
    '    static void fwd(std::vector<Op>& s) { build_fwd(s); }',
    '    static void slow(std::vector<Op>& s) { build_slow(s); }',
    '};',
    '}  // namespace ' + ns,
    '',
  ].join('\n');
}

const rows = [];
for (const [name, spec] of CONFIGS) {
  const res = S.build(spec);
  const ns = 'gen_' + name;
  if (name === SHIP) {
    fs.mkdirSync(GEN, { recursive: true });
    fs.writeFileSync(path.join(GEN, 'sched_' + name + '.hpp'), header(res, ns));
  }
  const m = res.metrics;
  rows.push([name, m.opsPhase0 + '+' + m.opsPhase1, m.stepOps, m.arenaBytes, m.arenaPool]);
}

const base = S.manualBaseline({});
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('配置', 14) + pad('op(fwd+slow)', 14) + pad('每步 op', 10) + pad('arena B', 12) + '临时区 B');
for (const r of rows) console.log(pad(r[0], 14) + pad(r[1], 14) + pad(r[2], 10) + pad(r[3], 12) + r[4]);
console.log(pad('手写 schedule', 14) + pad(base.opsPhase0 + '+' + base.opsPhase1, 14) +
            pad(base.stepOps, 10) + pad(base.arenaBytes, 12) + base.arenaTmp);
console.log('\n已写出 gen/sched_' + SHIP + '.hpp');
