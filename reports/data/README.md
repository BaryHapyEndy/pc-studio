# 测量数据

`probe/` 里跑出来的 CSV，报告里的数字都来自这里。

| 文件 | 内容 |
|---|---|
| `trace_trace.csv` | 1100 步：手写 schedule 的 ε/自由能/各状态范数/激活导数 |
| `trace_variant.csv` | 同上，但把 `test.hpp:470` 注释掉的 `M[0] -= …` 接了回去 |
| `trace_gate.csv` | 同上，但把死代码 `P_UPDATE` 接上（门控） |
| `trace_long.csv` | 22000 步的长期演化（**每 20 行抽 1 行**，原文件 3.3 MB） |
| `optime.csv` | 逐 op 计时（MATMUL_NT 6.97 µs、TANH 2.03 µs…） |

列含义：`e_ss` 是 ‖ε₀‖²，`*_ss` 是各状态 ‖·‖²，`cos` 是 cos(f₀, M₀)。
