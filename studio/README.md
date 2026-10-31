# studio/ —— 图形编辑器的源码

这里只放**开发用**的东西。用户实际打开的是仓库根目录的 `pc-studio.html`（单文件，双击即开）。

```
studio/
├── index.html          开发入口（ES module，需要 http 打开）
├── styles/             CSS，按用途拆开，index.css 负责 @import
├── src/
│   ├── engine/         纯逻辑：图 → Op[] → arena → 运行 / 导出 C++
│   ├── ui/             界面：状态、渲染、交互、文件、运行
│   └── dev/            #demo / #selftest 这类调试入口
├── test/               引擎冒烟测试（node --test）
├── build.mjs           把 src/ + styles/ 打成单文件
├── import-drawing.mjs  把一张导出的图纸变成内置示例（写 src/engine/drawings.js）
├── emit_model.mjs      重新生成 gen/model.hpp（= 界面里的「导出 C++」）
└── dump_js.mjs         与 C++ 对数用的脚本
```

## 三条命令

```bash
# 1. 开发时用 http 打开（file:// 下浏览器会拒绝 ES module）
python3 -m http.server 8000 --directory studio
open http://127.0.0.1:8000/

# 2. 改了代码之后重新打成单文件（产出仓库根目录的 pc-studio.html）
node studio/build.mjs

# 3. 跑测试 / 与 C++ 对数
node --test "studio/test/*.test.mjs"
node studio/dump_js.mjs 2000 500      # 与 ./build/pc_basic 2000 500 对照

# 4. 换内置示例图纸（「文件 → 示例图纸」里那几张）
node studio/import-drawing.mjs ~/Downloads/drawing1.json   # 只留这一张
node studio/import-drawing.mjs another.json --append       # 往后追加
node studio/build.mjs                                      # 重新打包才生效
```

改完图想同步 C++ 侧：`node studio/emit_model.mjs` 会重写 `gen/model.hpp`，再 `./build.sh` 即可。

`import-drawing.mjs` 只做一件事：把图纸 JSON 原样写进 `src/engine/drawings.js`（纯数据模块）。
所以示例图纸不依赖外部文件，打包成单文件后照样能用；`drawings.js` 是生成物，不要手改。

## 打包器在做什么

`build.mjs` 不引任何依赖，只做两件事：

1. **CSS**：顺着 `@import` 递归读，合成一个 `<style>`；
2. **JS**：顺着 `import` 递归读，拓扑排序后去掉 `import` / `export` 关键字，合成一个 IIFE。

所以 `src/` 里必须遵守这几条（违反会直接报错）：

- 只用具名导入导出：`import { a, b } from './x.js'`、`export function a() {}`、`export const b = 1`
- 不用 `export default`、`export * from`、动态 `import()`
- 不出现名为 `module` / `exports` / `require` 的变量

这么做的原因：发行物必须是**一个能被 `file://` 直接打开的文件**。`type="module"` 在 `file://` 下过不了 CORS，
所以要有一个"开发用模块、发布用单文件"的双轨，而 `pc-studio.html` 永远是构建产物，不要手改。

## 改东西时先看哪里

| 想改 | 去哪 |
|---|---|
| 颜色、字号、间距 | `styles/tokens.css`（色板）然后对应的 `layout/nodes/panels.css` |
| 某个算子怎么展开成 Op | `src/engine/lower.js` |
| 组件库里有哪些组件、端口叫什么 | `src/engine/library.js` |
| 导出的 C++ 长什么样 | `src/engine/codegen.js` |
| 鼠标/键盘行为 | `src/ui/interaction.js` |
| 节点长什么样 | `src/ui/geometry.js`（尺寸与端口位置）+ `src/ui/render.js`（DOM） |
| 训练循环、曲线、监视格 | `src/ui/runner.js`、`src/ui/monitor.js` |
| 保存/加载/导出 | `src/ui/file-io.js` |
| 内置示例图纸 | `src/engine/drawings.js`（由 `import-drawing.mjs` 生成） |
