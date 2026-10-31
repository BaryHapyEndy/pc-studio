#!/usr/bin/env node
/* studio/build.mjs —— 把 src/ 下的 ES 模块 + styles/ 下的 CSS 打成单文件 pc-studio.html
 *
 * 为什么不用 Vite / esbuild：这个项目不引入任何 npm 依赖，发行物必须"双击就能开"。
 * 这里做的是最小的两件事：
 *   1. CSS：顺着 @import 递归读，合成一个 <style>；
 *   2. JS ：顺着 import 递归读，拓扑排序后去掉 import/export 关键字，合成一个 IIFE。
 *
 * 约定（src/ 里必须遵守，否则打包器会直接报错）：
 *   - 只用具名导入/导出：`import { a, b } from './x.js'` / `export function a(){}` / `export const b = 1`
 *   - 允许命名空间导入 `import * as PC from './x.js'`：打包时会就地合成一个 `const PC = { … }`
 *   - 不用 `export default`、`export * from`、动态 `import()`（dev/ 里的两个文件也是静态导入）
 *   - 模块里不要出现叫 `module` / `exports` / `require` 的变量
 *
 * 用法：node studio/build.mjs [--out 路径] [--check]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(STUDIO, '..');

const argv = process.argv.slice(2);
const argOut = argv.indexOf('--out');
const OUT = argOut >= 0 ? resolve(argv[argOut + 1]) : join(ROOT, 'pc-studio.html');
const CHECK_ONLY = argv.includes('--check');

/* ───────────────────────────── CSS ───────────────────────────── */

function expandCss(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  return src.replace(/@import\s+url\(['"]?([^'")]+)['"]?\)\s*;?/g, (_, rel) => {
    const target = resolve(dirname(file), rel);
    if (!existsSync(target)) throw new Error(`@import 找不到文件: ${rel}（在 ${relative(ROOT, file)}）`);
    return expandCss(target, seen);
  });
}

/* ───────────────────────────── JS ───────────────────────────── */

const IMPORT_RE = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*\n?/gm;
const NS_IMPORT_RE = /^[ \t]*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?[ \t]*\n?/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s*['"]([^'"]+)['"];?[ \t]*\n?/gm;
const EXPORT_DECL_RE = /^([ \t]*)export\s+(?=(async\s+function|function|class|const|let|var)\b)/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\};?[ \t]*\n?/gm;
const EXPORT_NAME_RE = /^[ \t]*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

const cache = new Map();   // 绝对路径 → { deps: [], code }

/** 模块对外导出的名字（命名空间导入合成 `const NS = { … }` 用） */
function exportNames(raw) {
  const names = [];
  for (const m of raw.matchAll(EXPORT_NAME_RE)) names.push(m[1]);
  for (const m of raw.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.push((as[1] || as[0]).trim());
    }
  }
  return [...new Set(names)];
}

function loadModule(file) {
  const abs = resolve(file);
  if (cache.has(abs)) return cache.get(abs);
  if (!existsSync(abs)) throw new Error(`import 找不到文件: ${relative(ROOT, abs)}`);

  const raw = readFileSync(abs, 'utf8');
  if (/export\s+default/.test(raw)) throw new Error(`${relative(ROOT, abs)}: 不支持 export default`);
  if (/export\s*\*\s*from/.test(raw)) throw new Error(`${relative(ROOT, abs)}: 不支持 export * from`);
  if (/\bimport\s*\(/.test(raw)) throw new Error(`${relative(ROOT, abs)}: 不支持动态 import()，dev/ 里的文件请静态导入`);

  const deps = [];
  const ns = [];   // 命名空间导入：{ name, dep }
  const code = raw
    .replace(NS_IMPORT_RE, (_, name, spec) => {
      const dep = resolve(dirname(abs), spec);
      deps.push(dep);
      ns.push({ name, dep });
      return '';
    })
    .replace(IMPORT_RE, (_, names, spec) => { deps.push(resolve(dirname(abs), spec)); return ''; })
    .replace(BARE_IMPORT_RE, (_, spec) => { deps.push(resolve(dirname(abs), spec)); return ''; })
    .replace(EXPORT_DECL_RE, '$1')
    .replace(EXPORT_LIST_RE, '');

  const mod = { abs, deps, ns, code, exports: exportNames(raw) };
  cache.set(abs, mod);
  return mod;
}

/** 深度优先拓扑排序：被依赖的在前 */
function orderModules(entry) {
  const out = [], state = new Map();   // 1=访问中 2=完成
  (function visit(file) {
    if (state.get(file) === 2) return;
    if (state.get(file) === 1) throw new Error(`循环 import: ${relative(ROOT, file)}`);
    state.set(file, 1);
    const mod = loadModule(file);
    for (const d of mod.deps) visit(d);
    state.set(file, 2);
    out.push(mod);
  })(resolve(entry));
  return out;
}

/* ───────────────────────────── 打包 ───────────────────────────── */

const HTML = readFileSync(join(STUDIO, 'index.html'), 'utf8');

function mustReplace(html, re, build, what) {
  if (!re.test(html)) throw new Error(`index.html 里找不到${what}的占位`);
  return html.replace(re, () => build());
}

let nCss = 0, nJs = 0;

const html = HTML
  .replace(/<link[^>]+href="\.\/styles\/index\.css"[^>]*>/g, () => {
    const css = expandCss(join(STUDIO, 'styles/index.css'))
      .split('\n')
      .map(l => (l.trim() ? '  ' + l : l))
      .join('\n');
    nCss = (css.match(/\{/g) || []).length;
    return `<style>\n${css}\n  </style>`;
  })
  .replace(/<script[^>]+src="\.\/src\/ui\/main\.js"[^>]*><\/script>/g, () => {
    const mods = orderModules(join(STUDIO, 'src/ui/main.js'));
    // 命名空间导入：在所有依赖该模块的模块之前、依赖模块自己的代码之后，合成一次 `const NS = { … }`
    const nsByDep = new Map();   // dep 绝对路径 → [{ name, exports }]
    const nsSeen = new Map();    // 局部名 → dep 绝对路径
    for (const m of mods) {
      for (const n of m.ns) {
        if (nsSeen.has(n.name) && nsSeen.get(n.name) !== n.dep) throw new Error(`命名空间导入名冲突: ${n.name}`);
        nsSeen.set(n.name, n.dep);
        if (!nsByDep.has(n.dep)) nsByDep.set(n.dep, []);
        const list = nsByDep.get(n.dep);
        if (!list.some(x => x.name === n.name)) list.push({ name: n.name, exports: loadModule(n.dep).exports });
      }
    }
    const body = mods
      .map(m => {
        let s = `/* ── ${relative(STUDIO, m.abs)} ── */\n${m.code.trim()}\n`;
        for (const n of (nsByDep.get(m.abs) || [])) {
          if (!n.exports.length) throw new Error(`${relative(ROOT, n.dep)}: 没有可导出的名字，无法合成 ${n.name}`);
          s += `const ${n.name} = { ${n.exports.join(', ')} };\n`;
        }
        return s;
      })
      .join('\n');
    nJs = mods.length;
    return `<script>\n(function () {\n'use strict';\n${body}\n})();\n  </script>`;
  })
  .replace(/\n{3,}/g, '\n\n')
  .replace(/[ \t]+$/gm, '');

if (CHECK_ONLY) {
  console.log(`ok · ${nJs} modules · css ${nCss} rules · 未写文件`);
} else {
  writeFileSync(OUT, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`wrote ${relative(ROOT, OUT)} · ${kb} KB · ${nJs} modules · css ${nCss} rules`);
}
