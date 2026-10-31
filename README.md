# pc-studio

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](#)
[![C++17](https://img.shields.io/badge/C%2B%2B-17-blue.svg)](#)

> 面向「预测编码 + 在线学习」算法的实验引擎：**在图上搭建结构 → 自动生成 schedule → 运行 / 导出 C++**。

项目围绕两个核心设计目标构建：

- **算法改动只发生在图上** —— 无需重写 C++，也无需手算缓冲区偏移。
- **界面与导出的 C++ 一致** —— 同一张图在两侧各跑 2000 步，自由能相对差 ≤ 2e-6（只来自 `sin/cos` 与 float32 累加顺序）。

## 快速开始

```bash
./build.sh                      # 编译（macOS / Linux 均可）
./build/schedule_demo           # 算子层：跑一份生成器产出的 schedule
./build/pc_basic 2000 500       # 图引擎：两层基本模型，打印 F / ε₀ / ε₁
open pc-studio.html             # 图形界面：单文件构建产物，双击亦可
./launch.sh                     # 或起本地服务器打开 studio/ 源码版
# 等价于：python3 -m http.server 8000 --directory studio
#         然后浏览器访问 http://localhost:8000/index.html
```

## 目录结构

| 路径                         | 说明                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`                      | **算子层**：`operation.hpp`(Op/OpCode) · `stateArena.hpp`(对齐缓冲区) · `executor.hpp`(kernel 分发) · `core.hpp`(一并包含)            |
| `engine/pc.hpp`              | **图引擎**：张量/相位/区间着色内存规划，单头文件，14 个算子                                                                           |
| `gen/sched_comp1.hpp`        | 生成器产出的 schedule（单块 arena，13 op / 轮）                                                                                       |
| `gen/model.hpp`              | 界面「导出 C++」产出的模型（21 op，二层预测编码）                                                                                     |
| `examples/schedule_demo.cpp` | 在 `core/` 上跑 `gen/sched_comp1.hpp`：arena、op 数、计时、数值体检                                                                   |
| `examples/pc_basic.cpp`      | 用 `engine/pc.hpp` 搭两层模型并训练                                                                                                   |
| `studio/`                    | 图编辑器源码（ES 模块）：`index.html` · `styles/` · `src/engine/`(11 个模块) · `src/ui/`(18 个) · `test/` · `build.mjs`(打包成单文件) |
| `tools/`                     | `schedgen.js`(schedule 编译器) · `emit.js`(把 schedule 落成 C++ 头)                                                                   |
| `pc-studio.html`             | **主入口**：图形界面（由 `node studio/build.mjs` 从 `studio/` 打出的单文件，请勿手改）                                                |
| `launch.sh`                  | 在 `studio/` 上起本地 HTTP 服务的薄包装（macOS / Linux：`./launch.sh`，等价于 `python3 -m http.server 8000 --directory studio`）      |
| `reports/`                   | 两轮实验报告；`reports/data/` 为测量得到的 CSV                                                                                        |
| `CMakeLists.txt`             | 唯一构建入口（`build.sh` 只是它的薄包装）                                                                                             |

```
core/      说"算什么、在哪算"        ← 手写或生成器都能直接喂
engine/    说"什么时候算、内存怎么复用"  ← 图形界面用它
```

## 两层架构

|          | `core/`（算子层）                   | `engine/pc.hpp`（图引擎）                  |
| -------- | ----------------------------------- | ------------------------------------------ |
| 张量     | 缓冲区 id + 字节偏移（手算）        | `Tens` 句柄 + `Shape`，偏移由计划器算      |
| 内存     | 一个 `StateArena`，粒度到字节       | 区间着色，临时量自动复用                   |
| 次序     | 你给的 `std::vector<Op>` 顺序       | 按 `PH_PREDICT → PH_INFER → PH_LEARN` 排序 |
| 谁来驱动 | 生成器（`tools/schedgen.js`）或手写 | 图编辑器（`studio/src/engine/`）           |

算子层的价值在于**下限可控**：生成的 schedule 直接就是 `Op[]`，没有解释器、没有虚函数，arena 大小与每个 op 的形状都是编译期常量。图引擎的价值在于**上限**：形状检查、相位、内存规划、跨语言一致性都在这一层解决。

### 算子层的融合扩展

相比最早的手写版本，`core/executor.hpp` 增加了以下扩展（`core/operation.hpp` 中相应加入 `FLAG_ACC` 与两个算子）：

| 扩展                 | 作用                                              | 效果                             |
| -------------------- | ------------------------------------------------- | -------------------------------- |
| `FLAG_ACC`           | 矩阵乘 `beta=1`、`SUM_ROWS` 不清零                | 省掉「gemm 之后再 ADD 一遍」     |
| `MUL` 认 `op.scalar` | `dst = src0*src1*scalar`                          | 「MUL 再 SCALE」两趟合一         |
| `PREDICT_ACT`        | 原地：`row0 = tanh(row0+B)`，其余行 `*= 1-row0²`  | 预测头 7 个 op → 1 个            |
| `DIFFUSE`            | 原地：`state[k] += dt*state[k+1]`，末行 `*= -0.1` | 扩散 3 个 op + 1 块临时区 → 1 个 |

## 图形界面

三种打开方式，功能完全一致，按需选择：

1. **双击 `pc-studio.html`** —— 构建产物，`file://` 直接打开，单文件零依赖；
2. **`python3 -m http.server 8000 --directory studio`** —— 直接在源码目录起服务，浏览器访问 `http://localhost:8000/index.html`，修改 `studio/` 下的源文件后刷新即生效，无需构建；
3. **`./launch.sh`** —— 第 2 条命令的包装脚本（macOS / Linux），`./launch.sh` 或双击运行均可。

将左侧组件库拖到画布 → 端口连线 → 点「运行 ▶」；「文件 → 导出 C++」即可得到使用 `engine/pc.hpp` 的代码。

| 操作               | 作用                                               |
| ------------------ | -------------------------------------------------- |
| 左键单击 / 拖空白  | 选中 / **框选**                                    |
| Shift · ⌘ + 单击   | 加选、减选                                         |
| 右键拖动（或中键） | **平移视图**                                       |
| 右键单击（不拖动） | 空白处「粘贴到这里」；组件上「删除 / 复制 / 粘贴」 |
| 滚轮 / 右下角滑块  | 缩放（灵敏度在「设置」里）、适应画布               |
| ⌘N · ⌘S · ⌘O       | 新建 / 保存 / 加载图纸（直接读写本地文件）         |
| ⌘C · ⌘V · Delete   | 复制（只带两头都在选区内的连线）/ 粘贴 / 删除      |
| V · S              | 选择 / **剪刀**（按住左键划过连线即断）            |

**端口颜色 = 方向，而且只在接线之后才上色**：

| 状态 | 外观 | 含义 |
|---|---|---|
| 已接线 | 蓝环 + 深蓝小圆 / 黄环 + 深黄小圆 | **蓝 = 输入口**（组件左边，值流进来）、**黄 = 输出口**（组件右边，值流出去） |
| 没接、非必需 | **灰环 + 主黑小圆** | 没接线是正常状态，不占用颜色 |
| 没接、必需 | 红环 + 主黑小圆 | 组件报错会追到这个口：这里少一根线 |

所以每条连线天然是「**黄 → 蓝**」：靠近源（左侧输出口）那头黄，靠近汇（右侧输入口）那头蓝，
顺着一条线看颜色顺序就知道数据往哪边走，不需要箭头。渐变只在中间 42%–58% 过渡，两端仍是纯色。
连接点本身是「半圆环 + 同心小圆」：环画方向色，小圆比环暗一档，所以接没接线一眼能看出来。

组件类型：

- **状态**（输入 x、后验 μ、权重 θ、偏置 β、误差 ε、中间量——名字和形状均可自定义）
- **监视**（把张量画成 ⌈√n⌉ 列的方阵热力图）
- **算子**（MATMUL_NN/NT/TN、ADD、SUB、MUL、SCALE、TANH、ONE_MINUS_SQ、AXPY、CLAMP）
- **集成**（EM：接 μ 与 θ，一次做完两层间的推理 + 学习）

三条核心约定（理解任何一张图只需这三条）：

1. **状态组件的左端口是「写」，右端口是「读」**：算子输出接到 `in` ⇒ 原地写那块状态。
2. **`μ_l` 是 `1 × D_l` 的行向量**，是第 l 层的后验；**高层预测低层**。
3. **连线只有两种语义**：数据与写回 / 别名。颜色只标出"这一端是什么"，算子由组件决定，不由连线决定。

### 老图纸里已经删掉的参数

`spec` 里不再有 **`dims`（层宽数组）**。以前状态组件的形状是从 `dims` 推出来的，现在**每个状态节点自带
`shape`（行 × 列）**，算子接上来时按连线的实际形状校验。所以你可以在同一张图里放任意宽的层、任意多的分支，
不必先声明「有几层、每层多宽」。

兼容性：老图里的 `dims` 会被直接忽略（不报错）；万一某个状态节点连 `shape` 都没有，按 `θ → 64×64`、其余
`→ 1×64` 兜底，打开后手动改一下形状即可。`node studio/import-drawing.mjs` 导入时也会顺手清掉 `dims` / `v`。

顺带删掉的：`spec.v`（版本号属于文件外壳 `{ v, name, spec }`，`spec` 自己不需要）、导出 C++ 里的 `NL` / `D[]`
常量（生成的头只描述「算什么」，宽度由每个张量自己的形状决定），以及 `portShape` 里那段永远走不到的
`def.shape(D, n.l, n)` 分支。

## 工具链

```bash
node tools/emit.js                 # 重新生成 gen/sched_comp1.hpp（顺便打印各配置规模）
node studio/build.mjs              # 把 studio/ 下的模块和样式打成根目录的 pc-studio.html
node --test "studio/test/*.test.mjs"   # 引擎单测（11 条，零依赖，node 内置 runner）
node studio/dump_js.mjs 2000 500   # 在 node 里跑同一张图，用于和 C++ 对数
node studio/import-drawing.mjs 图纸.json   # 把导出的图纸变成「文件 → 示例图纸」里的内置示例
node studio/emit_model.mjs         # 重新生成 gen/model.hpp（等同于界面里「导出 C++」）
```

跨语言对数：`node studio/dump_js.mjs 2000 500 > /tmp/js.txt` 与 `./build/pc_basic 2000 500 > /tmp/cpp.txt` 逐行应一致（末几位差异来自 `sin/cos` 与 float32 舍入）。

### 开发界面

`pc-studio.html` 是**构建产物**，修改界面请改 `studio/` 里的源文件，再跑一次 `node studio/build.mjs`：

```bash
python3 -m http.server 8000 --directory studio   # 然后访问 http://localhost:8000/index.html
./launch.sh                                      # 同上，一条命令的包装脚本
```

`studio/index.html` 走原生 ES module（改完刷新即可，无需构建）；`pc-studio.html` 是同一个程序打成的单文件，可以 `file://` 直接双击——两轨并存的原因见 `studio/README.md`。

## 性能数据

|                  | op / 轮 | arena      | 说明                            |
| ---------------- | ------- | ---------- | ------------------------------- |
| 手写 schedule    | 28 + 10 | 12.92 MB   | 13 个 CLEAR，临时区 12.58 MB    |
| 生成（local）    | 18 + 7  | 607 KB     | 只用手写已有的算子，逐位一致    |
| 生成（compound） | 9 + 4   | **345 KB** | 融合算子 + `beta=1`，耗时降 43% |

`./build/schedule_demo` 的实测：1000 步 20.25 µs/步，`|M0|²=16.7028  |T0|²=219.77  |B0|²=10.2853`。

## 依赖

- C++17，无第三方库。
- 矩阵乘默认走 **BLAS**：macOS 使用 Accelerate（`CMakeLists.txt` 自动查找头文件与框架），其它平台 `find_package(BLAS)`；均不需要时可 `cmake -DPC_USE_BLAS=OFF` 退回朴素三重循环。
- `-ffp-contract=off` 默认开启——这是「融合算子」与「拆开写的算子序列」能够逐位对数的前提。
- File System Access API 仅 Chromium 系支持；Safari / Firefox 打开界面会退化为「下载文件 + 选择文件打开」，功能不缺，只是无法原地覆盖。

## 文档

- `reports/报告-重构与studio.md` —— 引擎重构、图→schedule 语义、界面实现、跨语言对数的完整说明。
- `reports/报告-schedule-generator.md` —— schedule 自动生成器那一轮：融合分层、内存规划、四个真实 bug、实测数据。
