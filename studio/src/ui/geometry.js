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
    ins: ins.map((p, i) => ({ k: p.k, name: p.name || p.k, opt: !!p.optional, ...pin(i, 'in') })),
    outs: outs.map((p, i) => ({ k: p.k, name: p.name || p.k, ...pin(ins.length + i, 'out') })),
  };
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
