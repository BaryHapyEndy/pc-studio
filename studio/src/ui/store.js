// 这个模块负责：全局状态容器 S、统一的变更通知（onChange / notify），以及选中集、「名字唯一化」这两个最小的状态读写工具。

import * as PC from '../engine/index.js';

// 所有会被多个模块读写的状态都放这里，别的模块一律通过 S.xxx 访问。
export const S = {
  spec: PC.presetBasic([64, 1024]),   // 图纸（节点 + 连线 + 超参）
  view: { x: 40, y: 20, k: 0.8 },     // 画布视图
  sel: null,              // 主选中（检视器看这个）
  selSet: new Set(),      // 当前选中的全部节点
  rt: null,               // { pr, T, errors }
  it: 0,
  running: false,
  hist: [],               // F 曲线
  lastF: 0,
  lastE0: 0,
  data: null,             // 数据集
  sampleIdx: 0,
  mode: 'select',         // 工具模式：'select' 默认，'scissor' 剪刀（左键划动剪线）
  drag: null,             // 当前正在进行的拖拽/框选/剪线
  clip: null,             // 剪贴板 {nodes:[…], edges:[…]}
  settings: { wheel: 0.15, grid: true, cell: 4 },   // 具体值在 settings.js 里用 localStorage 合并
  curFile: null,          // FileSystemFileHandle（保存过一次就有）
  curName: null,
  uid: 100,
};

export const listeners = new Set();
export function onChange(fn) { listeners.add(fn); }
export function notify(reason) { for (const f of listeners) f(reason); }

// ───────────────────────── 选中集 ─────────────────────────
// 这里只改状态并通知；.sel 类和检视器的重绘由 main.js 注册的监听器负责（避免 store 反向依赖 render/inspector）。
export function setSelection(ids, primary) {
  S.selSet = new Set(ids);
  if (primary !== undefined) S.sel = primary;
  else S.sel = ids.length ? ids[ids.length - 1] : null;
  if (S.sel && !S.selSet.has(S.sel)) S.sel = null;
  notify('select');
}
export function selectNode(id) { setSelection(id ? [id] : [], id || null); }
export function toggleSelect(id) {
  const next = new Set(S.selSet);
  if (next.has(id)) { next.delete(id); if (S.sel === id) S.sel = [...next].pop() || null; }
  else { next.add(id); S.sel = id; }
  setSelection([...next], S.sel);
}

// ───────────────────────── 状态组件的命名 ─────────────────────────
// 状态组件：默认名字不重复；形状用户可以随时改（算子会按连线校验）
export const DEFAULT_SHAPE = { x: [1, 64], M: [1, 64], T: [64, 64], B: [1, 64], E: [1, 64], V: [1, 64] };
export function usedNames() {
  const s = new Set();
  for (const n of S.spec.nodes) {
    const c = PC.LIBMAP[n.type];
    if (c && c.state) s.add(PC.tname(n));
  }
  return s;
}
export function uniqueName(base) {
  const used = usedNames();
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(base + '_' + i)) i++;
  return base + '_' + i;
}
