// 这个模块负责：节点盒子的几何——高/行高/内边距/页脚、监视图尺寸、信息行文案、端口坐标、连线贝塞尔路径。

import * as PC from '../engine/index.js';
import { S } from './store.js';

export const NH = 30, ROW = 20, PAD = 6, FT = 18;
export function monitorSize() { return 96; }

export function infoRows(n) {
  if (n.type === 'MON') return ['把一个张量画成方阵'];
  if (n.type === 'EM') {
    const out = [];
    out.push(`f${n.l} = tanh(μ${n.l}·θ${n.l}ᵀ + β${n.l})`.replace('ᵀ', ''));
    out.push(`ε${n.l} = μ${n.l} − f${n.l}`);
    out.push(`μ = μ + η(g·θᵀ − ε)`);
    out.push(`θ = θ + η·μᵀg ,  β = β + η·g`);
    return out;
  }
  if (n.type === 'M') return ['后验状态（行向量）'];
  if (n.type === 'T') return ['权重状态'];
  if (n.type === 'B') return ['偏置状态'];
  if (n.type === 'E') return ['误差状态'];
  return null;
}
export function geom(n) {
  const c = PC.LIBMAP[n.type];
  const ins = (c.ins || []), outs = (c.outs || []);
  const info = infoRows(n) || [];
  const rows = ins.length + outs.length;
  const w = n.type === 'EM' ? 246 : 152;
  const monH = n.type === 'MON' ? monitorSize() + 12 : 0;
  const h = NH + PAD * 2 + rows * ROW + (info.length ? info.length * 16 + 6 : 0) + FT + monH;
  const pin = (i, dir) => ({ x: dir === 'in' ? 0 : w, y: NH + PAD + i * ROW + ROW / 2 });
  return {
    w, h,
    info,
    ins: ins.map((p, i) => ({ k: p.k, name: p.name || p.k, optional: !!p.optional, write: !!p.write, ...pin(i, 'in') })),
    outs: outs.map((p, i) => ({ k: p.k, name: p.name || p.k, optional: !!p.optional, write: !!p.write, ...pin(ins.length + i, 'out') })),
  };
}

// 端口颜色 —— 端口和连线两端颜色的唯一来源。规则分两段：
//
// 1) 没接线：
//      必需输入口 → need 红（组件报错会追到这个口，提醒你接线）
//      其余        → 不着色（灰环 + 全黑小圆），可选口没接是正常状态，不该占用颜色
// 2) 接了线：按「方向」上色
//      source 黄 = 输出口（组件右边，值从这里流出）
//      sink   蓝 = 输入口（组件左边，值流进这个组件）
//    所以每条连线天然是「黄 → 蓝」，靠近源那头黄、靠近汇那头蓝，方向不用箭头也看得懂。
//
// 颜色只由「方向」决定，与这个口是谁无关，因此自定义节点不需要为配色写任何特判。
function roleOf(n, p, dir) {
  const c = PC.LIBMAP[n.type] || {};
  if (!isConnected(n.id, p.k, dir)) {
    return (dir === 'in' && !p.optional && !c.state && !c.view) ? 'need' : '';
  }
  return dir === 'out' ? 'source' : 'sink';
}

// 端口当前有没有接线（渲染用它决定实心还是空心）
export function isConnected(nodeId, port, dir) {
  return S.spec.edges.some(e => (dir === 'in'
    ? (e.to[0] === nodeId && e.to[1] === port)
    : (e.from[0] === nodeId && e.from[1] === port)));
}
export function pinRole(n, p, dir) { return roleOf(n, p, dir); }
// 给连线用：只知道节点 id 和端口名
export function portRole(nodeId, port, dir) {
  const n = S.spec.nodes.find(x => x.id === nodeId);
  if (!n) return '';
  const g = geom(n);
  const p = (dir === 'in' ? g.ins : g.outs).find(x => x.k === port);
  return p ? roleOf(n, p, dir) : '';
}

export function pinPos(nodeId, port, dir) {
  const n = S.spec.nodes.find(x => x.id === nodeId);
  if (!n) return null;
  const g = geom(n);
  const list = dir === 'in' ? g.ins : g.outs;
  const p = list.find(x => x.k === port);
  if (!p) return null;
  return { x: n.pos.x + p.x, y: n.pos.y + p.y };
}

export function bez(a, b) {
  const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
