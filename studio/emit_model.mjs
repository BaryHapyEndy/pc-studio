#!/usr/bin/env node
/* studio/emit_model.mjs —— 生成 gen/model.hpp（examples/pc_basic.cpp 用的那张两层图）
 *
 * 这个模块负责：把「界面里点导出 C++」那件事搬到命令行，方便重新生成与回归。
 * 生成的头文件与界面导出的完全一致（同一个 emitCpp）。
 *
 * 用法：
 *   node studio/emit_model.mjs              # 默认 64 → 1024，写 gen/model.hpp
 *   node studio/emit_model.mjs 16 64        # 换层宽
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PC from './src/engine/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dims = process.argv.slice(2).map(Number).filter(n => n > 0);
const D = dims.length ? dims : [64, 1024];

const spec = PC.presetBasic(D);
const { text, errors } = PC.emitCpp(spec, 'model');
if (errors.length) {
  console.error('图有错误，没有写出头文件：');
  for (const e of errors) console.error('  ' + e.msg);
  process.exit(1);
}
const out = resolve(ROOT, 'gen/model.hpp');
writeFileSync(out, text);
const m = PC.metrics(PC.lower(spec).pr);
console.log(`写了 gen/model.hpp —— ${D.join(' → ')}，${m.ops} op，arena ${m.total} B`);
