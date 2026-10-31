# pc-engine：自研路线评审 + schedule 自动生成器

> **v1.0.0 路径说明**：这份报告写于早期，路径按当时的扁平目录。
> 现在对应关系是——`tool/schedgen.js`、`tool/emit.js` → `tools/`；
> 你原来的 `operation.hpp` / `stateArena.hpp` / `executor.hpp` → `core/`（四个融合扩展已并入）；
> `test.hpp` 及其派生的 `verify.cpp` / `bench.cpp` / `behaviour.cpp` 已从发行版移除（报告里的实测数字保留作历史记录）；
> `tool/studio.html`、`tool/pcgraph.js` → `studio/`；
> `pc-engine-graph.html`（老引擎的生成器界面）只服务于已删除的 test 模型，也一并移除。


> 交付物：
> - `pc-engine-graph.html` —— 单文件交互界面（双击即开，无需 npm / 服务器），就是你要的"节点+连线 → schedule"
> - `tool/schedgen.js` —— 编译器核心（语义图 → `Op[]` → arena 规划 → C++）
> - `tool/verify.cpp` / `tool/bench2.cpp` / `tool/behaviour.cpp` —— 数值回归、性能、动力学验证
> - 你的 `operation.hpp` / `executor.hpp` / `test.hpp` / `stateArena.hpp` **一行没动**；新东西全在 `tool/`、`gen/`、`probe/`

---

## 0. 结论先行

1. **可行，而且现在就能跑。** 但价值不在"界面"，而在界面背后的三件事：符号模板实例化、生命周期规划、以及**用你自己的 executor 做数值回归**。前两件我给出来了，第三件是这个方案能成立的关键——没有它，生成器只是画图玩具。
2. **你筛的自研点基本是对的，只需要修正一条**：frontend/DSL 不要自研"编译器"，要自研"**图 → Op[] 的 lowering**"。区别是：前者要你写 parser / IR / pass；后者只需要一个几百行的 JS/C++ 函数 + 一套回归测试。我按后者做的，代码量 `schedgen.js` ≈ 600 行。
3. **界面不应该是"自由画布"**。你的算法是"一套符号模板 × c 条连接"，所以正确的交互是：**模板节点 + 参数面板 + 少量结构开关**，而不是让用户从零拖 30 个方框。真正需要能"连"的，是那几条**现在没接的线**（M[0] 下降、P 门控、c=1）——我把它们做成了可点击的灰色虚线，点一下就接上，指标、op 数、arena 立刻变。

---

## 1. 我从代码里读到的引擎（事实，不是评价）

| 事实 | 位置 | 含义 |
|---|---|---|
| 20 个 opcode，`Op` 只有 **2 src / 1 dst**，`flags` + `meta_index` **空着** | `operation.hpp` | 这两个字段就是你的扩展点：融合算子、accumulate、标量系数全塞得进，不用改结构体 |
| `build_schedule_0` = **28 op，其中 10 个 CLEAR**；`build_schedule_1` = 10 op，3 个 CLEAR | `test.hpp:302` / `test.hpp:586` | **13/38 = 34% 的 op 是 CLEAR**，全是死存储 |
| arena = **12,923,328 B (12.32 MiB)**，其中 `sz_TMP` = `3·D[0]²·4` = **12,582,912 B** | `test.hpp:allocate_all` | 真实瞬时需求 ~48 KB；**97% 的 arena 是"按最坏形状预留"** |
| `M[2]` 和连接 `c=1` **分配了、初始化了、零个 op 引用** | `test.hpp` | 纯死重量（连同 `P/S` 各 12 KB，只要不开门控也是死的） |
| `P_UPDATE` / `NORM_STEP` / `THRESHOLD_MUL` 实现了但**没有任何 schedule 引用** | `executor.hpp` | 死码，且下面第 3 节证明 `P_UPDATE` 接上也是废的 |
| `M[0] = M[0] - TMP[0]` 被注释掉 | `test.hpp:470-476` | 这是**系统唯一的稳定器**，见第 3 节 |

---

## 2. 生成器做了什么

```
语义图 (states + templates)
   │  符号实例化：对每个 active connection 用 (D[c], D[c+1]) 绑定一套模板
   ▼
Op[]（带 phase: 0=fwd 每步, 1=slow 每 N 步）
   │  区间着色：first-def / last-use，alloc 先于 free 处理（这条我踩过坑）
   ▼
单 arena + 每张量的 byte offset（enum OFF_xxx）
   ▼
C++ header（namespace、build_fwd/build_slow、init_values、Cfg）
   ▼
和你的 test.hpp 编在一起，跑 1100 步逐张量比对
```

两档融合：

| 档位 | 做什么 | 需要 executor 改什么 |
|---|---|---|
| `local` | 只用你**已有**的 20 个 opcode | 什么都不用改 |
| `compound` | 加 `PREDICT_ACT`（原地 tanh+导数）、`DIFFUSE`（原地 shift+dt+accum）、`ACC`(beta=1)、`MUL` 带标量 | +2 个 case，约 40 行（已写在 `tool/fast/executor2.hpp`，不改你的文件） |

### 结果

| schedule | ops (fwd+slow) | ops/步 | arena | 与手写对比（1100 步） |
|---|---|---|---|---|
| 手写 `build_schedule_0/1` | 28+10（13 CLEAR） | 290 | 12.92 MB | 基准 |
| `gen local1` | 18+7 | 187 | **607 KB**（21.3×） | **逐位一致**（M0/M1/T0/E0/P0 全部 bit-identical） |
| `gen comp1` | 9+4 | 94 | **345 KB**（37.5×） | max\|Δ\| ≤ 1.4e-5（M0、P0 逐位一致） |
| `gen comp2` | 16+8 | 168 | 352 KB | 首次把 `c=1` 接上（覆盖验证） |

`local1` 是**逐位复现**（不是"误差很小"）：说明这套 lowering 对你是安全的 drop-in 替换，可以立刻拿去用，风险为零。

### 我修掉的 4 个真 bug（写下来是因为它们会再咬人）

1. **phase 顺序**：一开始按 connection 排（conn0-fwd, conn0-slow, conn1-fwd…），区间着色就会把"fwd 全跑 10 次然后才跑 slow"的顺序搞错 → 改成 phase-major。
2. **单 arena + 偏移**：早先每个张量一个 buffer、偏移非零，`ptr(id, off)` 直接越界，验证出来全是 0。
3. **删掉未用 state 会挪动 rng**：`M[2]` 没用就剪掉，结果 `init` 少抽 48 个数，`T[0]` 初值全错 → 现在**只剪 temp，永久保留 state**。
4. **planner 在同一 op 上 free-before-alloc**（最贵的一个）：`MATMUL_NT` 的目标 `(K,Du)` 复用了它**正在读**的 `G2` 的槽位。数值上第 11 步还逐位一致，1100 步后误差 9e-3 —— 这类 bug 只有长跑回归才抓得到，这就是为什么"生成器必须自带数值回归"。

---

## 3. 顺手测出来的算法事实（推理-学习）

1100 步（= `Test::run()` 的 100×(10 fwd + 1 slow)），稳态平方和：

| schedule | E[0] Σx² | M[0] | M[1] | T[0] | B[0] | cos(F₀,M₀) |
|---|---|---|---|---|---|---|
| 手写 | 3.008e-3 | 16.70 | 2.511 | 219.8 | 10.29 | 0.99993 |
| `comp1`（生成） | 3.007e-3 | 16.70 | 2.511 | 219.8 | 10.29 | — |
| **+ 接上 M[0] 下降** | **2.578e-4**（↓11.7×） | **4.088** | **0.347** | 217.5 | **3.440** | — |
| + 接上 P 门控 | 3.009e-3（无变化） | 16.70 | 2.511 | 219.8 | 10.29 | — |

三件事：

1. **误差小 ≠ 算法在工作**。E 从 13.55 掉到 0.003，但 `M[0]` 从 10.3 涨到 16.7、`M[1]` 涨 4.8×、`T` 也在涨 —— 预测器是在**追一个漂移的目标**（cos 0.9999 就是证据）。跑 22000 步：无 NaN/Inf，但 `M[0]`→970、`T`→368、`B`→18.8，**唯一在兜底的是 `M[0]` 的 clamp(±1)**，其它量没有任何东西约束。
2. **被注释的那 6 行是稳定器**。接上后 E 降 11.7×，而且所有量都**收敛**而不是发散（`M[0]` 4.09、`B` 3.44 都稳住了）。所以那不是"调试残留"，是算法的一部分。
3. **`P_UPDATE` 接上等于没接**：`S += P²E² − P`，当 P=1 时≈每次 −1，约 3 步后 `tanh(S−1)` 饱和到 −1、P→1，门控退化成恒等。实测 P 的平方和 3072 → 2785 → 回到 3072。**这套门控没有工作点**，要修的话得先把 `S` 的更新改成 EMA（`S ← (1−α)S + α E²`）之类，否则接上只是白算。
4. **tanh 其实没起作用**：`d_act` 的平方和 ≈1009/1024 → RMS 0.993，即 tanh 工作在完全线性区，非线性项基本是恒等映射。想让非线性有语义，得先让 `x = M@T + B` 的量级离开 0（现在 |x| ≪ 1）。

---

## 4. 性能（`build/bench2`，best of 5，1100 步）

| schedule | 总时间 | µs/step | fwd | **slow** | 相对手写 |
|---|---|---|---|---|---|
| 手写 | 28.43 ms | 25.84 | 27.17 | 4.29 ms | 1.00× |
| `gen local1` | 28.19 ms | 25.62 | 23.94 | 5.71 ms | 0.99× |
| `gen comp1` | **19.86 ms** | **18.06** | 19.06 | **1.06 ms** | **1.43×** |
| `gen comp2` | 22.32 ms | 20.29 | 21.36 | 1.14 ms | — |

- **`local1` 和手写一样快**：13 个 CLEAR 从来不是成本（0.17 µs/op）。所以"省 op 数"本身不值钱。
- **真正赚的是 `comp1` 的 slow 阶段：4.29 → 1.06 ms（4×）**。原因很具体：你的 gemm `beta` 硬编码 0，`M[u] += G@T^T` 只能"先算到临时区，再跑一趟 ADD"；`beta=1` 直接累加就省掉那趟（`T[0] += ...` 每步 20.35 µs 的元凶）。
- 第二条连接的**边际成本 ≈ 2.5 ms / 1100 步**（22.32 − 19.86），这是 c=1 接上后的真实代价。
- 另外两个白送的优化（我没做，但测过原因）：`exec_shift` 的 `−0.1f` 硬编码、以及 in-place 两指针 elementwise 比 out-of-place 慢 **5×**（clang 生成 `sub/cmp/b.lo` 别名检查，命中走标量尾巴）。把 `z=x*y` 这类改成单指针重载或 `__restrict`+手写 4 路，`local1` 还能再快一截——但那是 executor 的事，不是图的语义。

---

## 5. 你问的三个设计问题

### (a) 一个节点应该是"层状态"吗？

**节点有两类，而且必须分开：**

| 类 | 例子 | 语义 | 在图上的行为 |
|---|---|---|---|
| **常驻状态张量** | `M[l]`、`T[c]`、`B[c]`、`P[c]`、`S[c]` | 生命周期 = 整个训练；init 抽 rng；**永远不能被剪掉** | 只能被连，不产生 op；编辑器里是"水库" |
| **计算模板** | `PREDICT`、`ERROR`、`UPD_M`、`DIFFUSE`、`UPD_T`、`UPD_B` | 一段 lowering 规则；吃若干张量、吐若干张量 | 每个 active connection 实例化一次；节点上显示"它吃掉几个 op" |

注意 `M[l]` **不是"层"**，是 `(K, D[l])` 的一个张量：K 行是层级，D 是宽度。把它当"层"会让 `K` 这个维度无处安放——你的算法里 K 行共享同一个 `T/B`，这正是 `EXTRACT_ROW`/`CONCAT_ROWS` 存在的原因。

### (b) 不同类型的连线控制操作吗？

**不要**。连线类型若决定"做什么 op"，图就变成了语法糖，`Op` 的语义会漏到 IR 外面。

连线只有两种有意义的类型，而且它们决定的是**别的东西**：

| 连线 | 含义 | 决定什么 |
|---|---|---|
| `data`（蓝色实线） | 只读张量流动 | 决定 op 的 src 和形状 |
| `write-back`（琥珀虚线） | **原地写回**（`M[l] += …`、`in-place SCALE/CLAMP`） | 决定**别名与生命周期**：能不能省临时区、要不要补一趟 copy、以及会不会踩你 executor 里那个 5× 的 in-place 惩罚 |

第三种我加了 `slow`（紫色点线）：它不是张量类型，是**相位**——每 N 步跑一次的 op 必须在图上可见，否则 `T/B` 的更新就成了隐式魔法。

### (c) 为什么是"符号模板实例化"而不是"每个连接画一套"

你的算法对 c=0 和 c=1 是**同一套公式、不同维度**（`D[0]=1024 → D[1]=64` vs `D[1]=64 → D[2]=16`）。所以正确形态是：**一张模板图 + 一个连接表**，`lowering` 时用 `(D[c], D[c+1])` 绑定实例化。好处：
- 图不会随连接数指数膨胀；
- 加 c=1 只是多一行绑定，**不需要画第二张图**（现在 `gen comp2` 就是这么来的）；
- 参数（`lrM/lrE/lrTB/dt/clamp`）挂在模板上，一处改全连接生效。

---

## 6. 现成模板对比（你问的"有没有现成 UI"）

| 方案 | 是什么 | 对你的适配度 | 代价 |
|---|---|---|---|
| **React Flow / xyflow** | React 节点编辑器库，最主流 | 交互最顺手，但**只是"画布"**：节点/连线/拖拽全给你，语义一点没有 | React + 打包；为一个 60 KB 的图拉一套 SPA |
| **Rete.js** | 数据流/逻辑图框架，带执行引擎 | 有"节点执行"概念，接近你要的 lowering | 它的执行模型是 push-based 数据流，和你的"整体 schedule + arena"不同构，得绕 |
| **LiteGraph.js** | **ComfyUI 用的就是它** | 最像 ComfyUI：节点、类型化插槽、widget | 老（ES5 风格、全局单例），要自己接构建；且它的 slot 类型是"数据类型"，不是"别名语义" |
| **Baklava.js** | Vue 节点编辑器 | 轻 | 生态小 |
| **Blockly** | 积木式 | 形状约束强，不适合张量图 | 语义不匹配 |
| **手写单文件（我选的）** | 60 KB，零依赖，`file://` 直接开 | 图是"模板 + 少量实例"，90% 的通用能力用不上；我需要的是"点一下接上那条虚线 → 指标立刻变" | 手写 ~700 行；换来零依赖、可离线、可嵌进你仓库 |

顺带说：ComfyUI 的模型是 "node = 一个可执行单元 + 有类型的插槽"，它能成立是因为扩散采样图是**DAG + 数据流**。你的是**带环的在线学习图 + 全局 arena**，中间还夹着"每 N 步一次"的相位——直接照搬会别扭。我的选择是保留"节点+连线"的**视觉语法**，但语义按你的算法来（状态 / 模板 / 相位 / 写回）。

---

## 7. 这个界面怎么用

双击 `pc-engine-graph.html`（单文件，无网络）。

- **拖节点**移动，**滚轮**缩放，空白处拖动平移，`0` 键回到全图
- 左栏：融合档位、连接开关、三个"没接的线"开关、执行器能力、超参
- 点**灰色虚线节点**（`M[0] -= 0.01·E⊙P`、`connection c=1 未接线`）＝**直接接上**
- 右栏：ops/步、arena、临时区、gemm 数、arena 布局（含每个张量的 offset/bytes）、完整 op 表（可筛 phase0 / phase1 / gemm / 融合）、JSON / C++ 导出
- 顶部预设：`手写 → local → compound → +M[0] 下降 → ×2 连接`，一眼看到 op 数 290 → 187 → 94 → 104 → 168 和 arena 12.92 MB → 345 KB
- 右上角 `verify` 徽标是**实测结论**（local = 逐位一致，compound = ≤1.4e-5），不是估计

导出的 C++ 直接可用：

```bash
ACC=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/Accelerate.framework/Frameworks/vecLib.framework/Headers

# 重新生成全部 header
node tool/emit.js

# 数值回归（bit-identical / max|d|）
clang++ -std=c++17 -O2 -ffp-contract=off -I. -I"$ACC" -Wno-deprecated-declarations \
        tool/verify.cpp -framework Accelerate -o build/verify && ./build/verify

# 性能
clang++ -std=c++17 -O2 -ffp-contract=off -I. -I"$ACC" -Wno-deprecated-declarations \
        tool/bench2.cpp -framework Accelerate -o build/bench2 && ./build/bench2

# 动力学（生成 vs 手写，含两个开关）
clang++ -std=c++17 -O2 -ffp-contract=off -I. -I"$ACC" -Wno-deprecated-declarations \
        tool/behaviour.cpp -framework Accelerate -o build/behaviour && ./build/behaviour
```

> `-ffp-contract=off` 是为了让"逐位一致"这个结论有意义（否则 FMA 收缩会让两边差 ulp）。你自己的构建里要不要开是另一回事——开 FMA 只影响 local1 的"逐位"，不影响 comp1 的 ≤1.4e-5。

---

## 8. 下一步（按性价比排）

| # | 做什么 | 代价 | 收益 |
|---|---|---|---|
| 1 | **接上 `M[0]` 下降**（就是那 6 行注释） | 1 行 | E ↓ **11.7×**，所有量从发散变收敛 |
| 2 | **让 gemm 支持 `beta`**（ACC） | 1 行 + 1 个 flag | slow 阶段 **4×**，整步 1.43× |
| 3 | **修 in-place 别名检查**（单指针重载 / `__restrict` + 4 路展开） | ~50 行 | 元素级算子在原地时 **5×**（现在 3.5 vs 19.2 Gelem/s） |
| 4 | **接上 c=1 或删掉 M[2]/c=1 的分配** | 1 行 / 1 行 | 要么算法多一层，要么 arena 少 12 KB + 一条死路径 |
| 5 | 修 `P_UPDATE` 的 S 更新（EMA） | ~10 行 | 门控才可能有用；现在接上是空转 |
| 6 | **暂缓"自研 DSL"** | — | 你现在"生成 .hpp → 编译"只要几秒；等你要"不重编译就换图"再上，且那时直接在 lowering 里加 pass，不必写 parser |
| 7 | 反向/更新规则表达式化 | 大 | 等图稳定再动；现在 `flags`+`meta_index` 两个空字段足够塞"融合 op 的元信息" |

关于**自研 vs 借力**，你的分档我基本认同，只有一处补丁：**memory planner 不是"脚本"，它也值得写进生成器**——我这边 30 行区间着色就从 12.58 MB 临时区压到 24 KB。手算 `cur` 累加那步确实该自动化，但它属于 lowering 的一部分，不是独立工具。

---

## 9. 代码地图

```
pc-engine-graph.html        ← 单文件交互界面（= tool/ui.html + schedgen.js 内联）
tool/schedgen.js            ← 编译器：normalize → lower → plan → metrics → emitCpp
tool/ui.html                ← 界面源码（<script src="schedgen.js">，开发时直接开）
tool/bundle_ui.js           ← 内联打包成单文件
tool/emit.js                ← 批量生成 gen/*.hpp + gen/summary.json
tool/fast/executor2.hpp     ← 只加 4 个扩展的 executor（不改你的文件）
tool/verify.cpp             ← 数值回归（4 档）
tool/bench2.cpp             ← 性能
tool/behaviour.cpp          ← 动力学 + 两个开关的真实效果
gen/sched_*.hpp             ← 生成物（local1/local1_noreuse/local2/comp1/comp1_noacc/comp1_learn/comp1_gate/comp2）
probe/                      ← 之前的插桩探针与 CSV（trace_*.csv、optime.csv、microbench）
```
