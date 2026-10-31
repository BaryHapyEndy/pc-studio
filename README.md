# pc-studio v1.0.0

给「预测编码 + 在线学习」这类算法做实验的小引擎：**在图上搭结构 → 自动生成 schedule → 跑 / 导出 C++**。

两条硬指标：

- **改算法只需要改图**——不用重写 C++，不用手算缓冲区偏移。
- **界面里的数和导出的 C++ 逐位对得上**——同一张图两边跑 2000 步，自由能一致到 7 位有效数字。

```bash
./build.sh                      # 编译（macOS / Linux 均可）
./build/schedule_demo           # 算子层：跑一份生成器产出的 schedule
./build/pc_basic 2000 500       # 图引擎：两层基本模型，打印 F / ε₀ / ε₁
open pc-studio.html             # 图形界面（单文件，零依赖，双击也行）
```

---

## 1. 目录

| 路径 | 说明 |
|---|---|
| `core/` | **算子层**：`operation.hpp`(Op/OpCode) · `stateArena.hpp`(对齐缓冲区) · `executor.hpp`(kernel 分发) · `core.hpp`(一并包含) |
| `engine/pc.hpp` | **图引擎**：张量/相位/区间着色内存规划，单头文件，14 个算子 |
| `gen/sched_comp1.hpp` | 生成器产出的 schedule（单块 arena，13 op / 轮） |
| `gen/model.hpp` | 界面「导出 C++」产出的模型（21 op，二层预测编码） |
| `examples/schedule_demo.cpp` | 在 `core/` 上跑 `gen/sched_comp1.hpp`：arena、op 数、计时、数值体检 |
| `examples/pc_basic.cpp` | 用 `engine/pc.hpp` 搭两层模型并训练 |
| `studio/` | 图形编辑器的源码：`studio.html` · `pcgraph.js`(图→Op[] lowering) · `bundle.js` · `dump_js.js` |
| `tools/` | `schedgen.js`(schedule 编译器) · `emit.js`(把 schedule 落成 C++ 头) |
| `pc-studio.html` | **主入口**：图形界面（内联了 `studio/pcgraph.js`） |
| `reports/` | 两轮实验报告；`reports/data/` 是测量出来的 CSV |
| `CMakeLists.txt` | 唯一构建入口（`build.sh` 只是它的薄包装） |

```
core/      说"算什么、在哪算"        ← 手写或生成器都能直接喂
engine/    说"什么时候算、内存怎么复用"  ← 图形界面用它
```

## 2. 两个层次，为什么都要在

| | `core/`（算子层） | `engine/pc.hpp`（图引擎） |
|---|---|---|
| 张量 | 缓冲区 id + 字节偏移（手算） | `Tens` 句柄 + `Shape`，偏移由计划器算 |
| 内存 | 一个 `StateArena`，粒度到字节 | 区间着色，临时量自动复用 |
| 次序 | 你给的 `std::vector<Op>` 顺序 | 按 `PH_PREDICT → PH_INFER → PH_LEARN` 排序 |
| 谁来驱动 | 生成器（`tools/schedgen.js`）或手写 | 图编辑器（`pcgraph.js`） |

算子层的价值是**下限可控**：生成的 schedule 直接是 `Op[]`，没有解释器、没有虚函数，
arena 大小、每个 op 的形状都是编译期定好的常量。图引擎的价值是**上限**：形状检查、相位、
内存规划、跨语言一致性都在这一层解决。

### 算子层的四个"融合"扩展

相对最早的手写版本，`core/executor.hpp` 多了三样东西（`core/operation.hpp` 里对应加了
`FLAG_ACC` 与两个算子）：

| 扩展 | 作用 | 效果 |
|---|---|---|
| `FLAG_ACC` | 矩阵乘 `beta=1`、`SUM_ROWS` 不清零 | 省掉「gemm 之后再 ADD 一遍」 |
| `MUL` 认 `op.scalar` | `dst = src0*src1*scalar` | 「MUL 再 SCALE」两趟合一 |
| `PREDICT_ACT` | 原地：`row0 = tanh(row0+B)`，其余行 `*= 1-row0²` | 预测头 7 个 op → 1 个 |
| `DIFFUSE` | 原地：`state[k] += dt*state[k+1]`，末行 `*= -0.1` | 扩散 3 个 op + 1 块临时区 → 1 个 |

## 3. 图形界面

左侧组件库拖到画布 → 端口连线 → 点「运行 ▶」；「文件 → 导出 C++」得到用 `engine/pc.hpp` 的代码。

| 操作 | 作用 |
|---|---|
| 左键单击 / 拖空白 | 选中 / **框选** |
| Shift · ⌘ + 单击 | 加选、减选 |
| 右键拖动（或中键） | **平移视图** |
| 右键单击（不拖动） | 空白处「粘贴到这里」；组件上「删除 / 复制 / 粘贴」 |
| 滚轮 / 右下角滑块 | 缩放（灵敏度在「设置」里）、适应画布 |
| ⌘N · ⌘S · ⌘O | 新建 / 保存 / 加载图纸（直接读写本地文件） |
| ⌘C · ⌘V · Delete | 复制（只带两头都在选区内的连线）/ 粘贴 / 删除 |
| V · S | 选择 / **剪刀**（按住左键划过连线即断） |

组件：**状态**（输入 x、后验 μ、权重 θ、偏置 β、误差 ε、中间量——名字和形状都自己定）、
**监视**（把张量画成 ⌈√n⌉ 列的方阵热力图）、**算子**（MATMUL_NN/NT/TN、ADD、SUB、MUL、SCALE、
TANH、ONE_MINUS_SQ、AXPY、CLAMP）、**集成**（EM：接 μ 与 θ，一次做完两层间的推理 + 学习）。

三条约定（看懂任何一张图只需要这三条）：

1. **状态组件的左端口是「写」，右端口是「读」**：算子输出接到 `in` ⇒ 原地写那块状态。
2. **`μ_l` 是 `1 × D_l` 的行向量**，是第 l 层的后验；**高层预测低层**。
3. **连线只有两种语义**：数据（实线）与写回 / 别名（虚线）。算子由组件决定，不由连线决定。

## 4. 工具

```bash
node tools/emit.js                 # 重新生成 gen/sched_comp1.hpp（顺便打印各配置规模）
node studio/bundle.js              # 把 pcgraph.js 内联进 pc-studio.html
node studio/dump_js.js 2000 500    # 在 node 里跑同一张图，用于和 C++ 对数
```

对数：`node studio/dump_js.js 2000 500 > /tmp/js.txt` 与 `./build/pc_basic 2000 500 > /tmp/cpp.txt`
逐行应一致（末几位差来自 `sin/cos` 与 float32 舍入）。

## 5. 数字

| | op / 轮 | arena | 说明 |
|---|---|---|---|
| 手写 schedule | 28 + 10 | 12.92 MB | 13 个 CLEAR，临时区 12.58 MB |
| 生成（local） | 18 + 7 | 607 KB | 只用手写已有的算子，逐位一致 |
| 生成（compound） | 9 + 4 | **345 KB** | 融合算子 + `beta=1`，耗时降 43% |

`./build/schedule_demo` 的实测：1000 步 20.25 µs/步，`|M0|²=16.7028  |T0|²=219.77  |B0|²=10.2853`。

## 6. 依赖

- C++17，无第三方库。
- 矩阵乘默认走 **BLAS**：macOS 用 Accelerate（`CMakeLists.txt` 自动找头文件与框架），
  其它平台 `find_package(BLAS)`；都不想要就 `cmake -DPC_USE_BLAS=OFF` 退回朴素三重循环。
- `-ffp-contract=off` 默认开启——这是「融合算子」与「拆开写的算子序列」能逐位对数的前提。
- File System Access API 只有 Chromium 系支持；Safari / Firefox 打开界面会退化成
  「下载文件 + 选择文件打开」，功能不缺，只是不能原地覆盖。

## 7. 文档

- `reports/报告-重构与studio.md` —— 引擎重构、图→schedule 语义、界面实现、跨语言对数的完整说明。
- `reports/报告-schedule-generator.md` —— schedule 自动生成器那一轮：融合分层、内存规划、四个真 bug、实测数据。
