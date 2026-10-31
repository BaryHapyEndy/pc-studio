#!/usr/bin/env node
/* studio/import-drawing.mjs —— 把界面导出的 .json 图纸变成「文件 → 示例图纸」里的内置示例
 *
 * 这个模块负责：读一张（或多张）图纸 .json，生成 studio/src/engine/drawings.js。
 * 生成的文件是纯数据模块，被 ui/menu.js 直接 import，所以示例图纸不依赖任何外部文件，
 * 打包成单文件后照样能用。
 *
 * 用法：
 *   node studio/import-drawing.mjs drawing1.json            # 只用这一张（替换掉原来的示例）
 *   node studio/import-drawing.mjs a.json b.json            # 换成一串，按参数顺序排列
 *   node studio/import-drawing.mjs more.json --append       # 追加到现有示例后面
 *   node studio/import-drawing.mjs x.json --name "三层 PC"  # 改菜单里显示的名字
 *
 * 约定：.json 既可以是界面「导出 JSON」那种 { v, name, spec }，也可以直接是 spec 本身。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'src/engine/drawings.js');

const argv = process.argv.slice(2);
const files = [];
let name = null, id = null, append = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--name') name = argv[++i];
  else if (a === '--id') id = argv[++i];
  else if (a === '--append') append = true;
  else if (a === '-h' || a === '--help') { usage(0); }
  else if (a.startsWith('-')) { console.error('不认识的参数: ' + a); usage(1); }
  else files.push(a);
}
if (!files.length) usage(1);

function usage(code) {
  console.log(`用法: node studio/import-drawing.mjs <图纸.json> [更多.json…] [--name 显示名] [--id 英文id] [--append]

  --name   菜单里显示的名字（只有一张时生效；默认用 json 里的 name 或文件名）
  --id     内部 id（同上，默认由文件名生成）
  --append 追加到现有示例后面，而不是替换`);
  process.exit(code);
}

// 从一张 json 里取出 spec，顺便校验它像不像是这个界面导出的东西
function readDrawing(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { fail(`${file}: 不是合法 JSON —— ${e.message}`); }
  let spec = raw && raw.spec ? raw.spec : raw;
  if (!spec || !Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) {
    fail(`${file}: 里面既没有 spec.nodes/edges，也不像一张图纸`);
  }
  spec = cleanSpec(spec);
  return { wrap: raw, spec, fallbackName: (raw && raw.name) || basename(file).replace(/\.json$/i, '') };
}

// 顺手清掉老图纸里已经不用的字段：
//   dims —— 以前用它推状态形状，现在形状写在每个节点上（所以老图的 dims 只是噪音）
//   v    —— 版本号属于文件外壳 { v, name, spec }，spec 自己不需要
// 节点上没有 shape 的（很老的图）按名字补一个，保证还能打开。
function cleanSpec(spec) {
  const out = JSON.parse(JSON.stringify(spec));
  delete out.dims;
  delete out.v;
  for (const n of out.nodes) {
    if (!n.shape && ['x', 'M', 'T', 'B', 'E', 'V'].includes(n.type)) {
      n.shape = n.type === 'T' ? { r: 64, c: 64 } : { r: 1, c: 64 };
    }
  }
  return out;
}

function fail(msg) { console.error(msg); process.exit(1); }

// 读旧的 drawings.js（--append 用）：把 DRAWINGS 里的 spec 原样取回来
function readExisting() {
  let text;
  try { text = readFileSync(OUT, 'utf8'); } catch { return []; }
  const m = text.match(/export const DRAWINGS = ([\s\S]*?);\s*$/);
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch { return []; }
}

const drawings = append ? readExisting() : [];
for (const file of files) {
  const { spec, fallbackName } = readDrawing(file);
  const base = files.length === 1 && name ? name : fallbackName;
  const slug = (files.length === 1 && id) ? id : fallbackName.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').toLowerCase();
  drawings.push({ id: slug, name: base, spec });
}

// 幂等：同 id 的旧条目先删掉，避免 --append 同一张图两次留下两份
const seen = new Set();
const list = drawings.filter(d => (seen.has(d.id) ? false : (seen.add(d.id), true)));

const body = list.map(d => {
  const json = JSON.stringify({ id: d.id, name: d.name, spec: d.spec }, null, 2)
    .split('\n').map(l => '  ' + l).join('\n');
  return json;
}).join(',\n');

const out = `/* studio/src/engine/drawings.js —— 内置示例图纸（**自动生成，别手改**）
 *
 * 这个模块负责：给「文件 → 示例图纸」提供内置图纸。内容是纯数据，不依赖任何外部文件，
 * 所以打包成 pc-studio.html 之后依然可用。
 *
 * 换图纸：
 *     node studio/import-drawing.mjs 你的图纸.json          # 只用这一张
 *     node studio/import-drawing.mjs 你的图纸.json --append # 追加
 * 然后 node studio/build.mjs 重新打包。
 */

export const DRAWINGS = [
${body},
];
`;

writeFileSync(OUT, out);
console.log(`写了 ${OUT.replace(process.cwd() + '/', '')} —— ${list.length} 张示例：` +
  list.map(d => `${d.name}(${d.spec.nodes.length} 节点/${d.spec.edges.length} 连线)`).join('、'));
