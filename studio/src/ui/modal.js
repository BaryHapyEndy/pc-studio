// 这个模块负责：toast 提示、通用弹窗（含 HELP 文案）与弹窗里「保存…」要用的最近一次导出内容。

import { $ } from './dom.js';

export const HELP = `操作
· 左键单击组件 = 选中；Shift/⌘ + 单击 = 加选；左键拖空白 = 框选（可框多个）
· 右键（或中键）拖动 = 平移视图；滚轮 = 以光标为中心缩放
· 右键组件 = 删除 / 复制 / 粘贴；⌘C / ⌘V 也行；画布空白右键 = 粘贴到这里
· Delete 删除选中；点连线可以删掉这条线；右下角滑块 / ⤢ = 缩放 / 适应画布
· 顶栏右侧「左栏 / 右栏」可以收起两侧面板（不影响图纸内容）

图
1. 组件库在左边：点「组件」展开/收起；点一下组件 = 放到画布中央，也可以直接拖进来。
2. 连线：从组件右侧的圆点拖到另一个组件左侧的圆点。
3. 状态组件（x / 后验 μ / 权重 θ / 偏置 β / 误差 ε / 中间量）的名字和形状都自己定：
   选中后在右边「检视器」里改「名称」「形状 r × c」。连上算子之后，算子会按你的形状
   自动校验，形状对不上会在组件上直接标红报错。
4. 状态组件的左边是「写」、右边是「读」。op 的输出连到状态组件的左边 = 原地写回那块内存
   （例如 AXPY 的输出连到 M[1] 的左边，就是 M[1] += η·Δμ）。
5. 「监视」组件：把一个张量画成方阵热力图（列数取 √n 向上取整），接在哪个状态的
   「读」口上就画它。跟运行无关，只做显示。
6. EM 是「集成」组件：接 μ（1×n 行向量）和 θ（Du×n），f/ε 是下层预测与本层误差，
   μ′/θ′/β′ 是写回的新值，接回状态组件的左边。

文件
7. 文件 → 保存（⌘S）直接写回你打开/上次另存的那个本地 .json；没有文件时弹保存框。
   另存为… = 选个新位置；加载图纸（⌘O）= 选本地 .json 打开。
8. 导出的 JSON / C++ 弹窗里也有「保存…」，可以直接存成 .json / .hpp。
9. 运行：▶ 开始，F 曲线是自由能，重建误差 ‖ε₀‖² 越小说明重建越好。
10. 导出 C++ 把当前图变成一段 build() 代码，用的是 engine/pc.hpp；种子一致时和界面里
    跑出来的数一样（examples/pc_basic.cpp 会核对）。
`;

let toastImpl = t => {
  const d = $('#toast'); d.textContent = t; d.classList.add('on');
  setTimeout(() => d.classList.remove('on'), 1400);
};
export function toast(t) { toastImpl(t); }
// 想临时接管 toast（例如自检里收集所有提示）就换一个实现，返回旧的，再传回来即可还原。
export function setToast(fn) { const prev = toastImpl; toastImpl = fn; return prev; }

let lastExport = null;   // { kind, text } —— 弹窗里「保存…」用
export function getLastExport() { return lastExport; }

export function showModal(title, text, kind) {
  $('#m-title').textContent = title;
  $('#m-body').textContent = text;
  lastExport = { kind: kind || 'json', text };
  $('#modal').classList.add('on');
}
