/* studio/src/engine/program.js —— Program（Op[] + 区间着色 arena）与执行器
 *
 * 这个模块负责：张量 / op 的登记与形状检查、arena 的区间着色（planBuffers）、
 * 初始化填充，以及按相位执行 op（mm / execOp / runPhase）。
 */

import { MT } from './mt19937.js';
import { fmtShape, same } from './shape.js';

// ─────────────────────────── Program ───────────────────────────
export const PH = { PREDICT: 0, INFER: 1, LEARN: 2 };
export const PHNAME = ['预测/误差', '推理（μ）', '学习（θ,β）'];

export class Program {
  constructor() {
    this.tensors = [];
    this.ops = [];
    this.planned = false;
    this.rng = new MT(42);
  }
  _t(name, s, isState) {
    const t = { id: this.tensors.length, name, shape: s, off: 0, isState, first: -1, last: -1 };
    this.tensors.push(t);
    return t;
  }
  state(name, s) { return this._t(name, s, true); }
  temp(name, s) {
    let n = name, k = 2;
    while (this.tensors.some(t => t.name === n)) n = name + '_' + k++;
    return this._t(n, s, false);
  }

  _push(k, a, b, d, scalar, acc, phase) {
    if (k === 'MATMUL_NN' && !(a.shape.c === b.shape.r && d.shape.r === a.shape.r && d.shape.c === b.shape.c))
      throw new Error(`MATMUL_NN 形状不符: ${fmtShape(a.shape)}·${fmtShape(b.shape)} → ${fmtShape(d.shape)}`);
    if (k === 'MATMUL_TN' && !(a.shape.r === b.shape.r && d.shape.r === a.shape.c && d.shape.c === b.shape.c))
      throw new Error(`MATMUL_TN 形状不符: ${fmtShape(a.shape)}ᵀ·${fmtShape(b.shape)} → ${fmtShape(d.shape)}`);
    if (k === 'MATMUL_NT' && !(a.shape.c === b.shape.c && d.shape.r === a.shape.r && d.shape.c === b.shape.r))
      throw new Error(`MATMUL_NT 形状不符: ${fmtShape(a.shape)}·${fmtShape(b.shape)}ᵀ → ${fmtShape(d.shape)}`);
    if (['ADD', 'SUB', 'MUL'].includes(k) && !(same(a.shape, b.shape) && same(a.shape, d.shape)))
      throw new Error(`${k} 形状不符: ${fmtShape(a.shape)} / ${fmtShape(b.shape)} → ${fmtShape(d.shape)}`);
    if (['SCALE', 'TANH', 'ONE_MINUS_SQ', 'CLAMP', 'AXPY', 'COPY'].includes(k) && !same(a.shape, d.shape))
      throw new Error(`${k} 形状不符: ${fmtShape(a.shape)} → ${fmtShape(d.shape)}`);
    if (k === 'SUM_ROWS' && !(d.shape.r === 1 && d.shape.c === a.shape.c))
      throw new Error(`SUM_ROWS 形状不符: ${fmtShape(a.shape)} → ${fmtShape(d.shape)}`);
    this.ops.push({ k, a, b, d, scalar: scalar || 0, acc: !!acc, phase: phase || 0 });
  }

  clear(d, ph) { this._push('CLEAR', d, null, d, 0, 0, ph); }
  copy(a, d, ph) { this._push('COPY', a, null, d, 0, 0, ph); }
  add(a, b, d, ph) { this._push('ADD', a, b, d, 0, 0, ph); }
  sub(a, b, d, ph) { this._push('SUB', a, b, d, 0, 0, ph); }
  mul(a, b, d, ph) { this._push('MUL', a, b, d, 0, 0, ph); }
  scale(s, a, d, ph) { this._push('SCALE', a, null, d, s, 0, ph); }
  tanh(a, d, ph) { this._push('TANH', a, null, d, 0, 0, ph); }
  oneMinusSq(a, d, ph) { this._push('ONE_MINUS_SQ', a, null, d, 0, 0, ph); }
  clamp(a, d, c, ph) { this._push('CLAMP', a, null, d, c, 0, ph); }
  axpy(s, a, d, ph) { this._push('AXPY', a, null, d, s, 0, ph); }
  sumRows(a, d, acc, ph) { this._push('SUM_ROWS', a, null, d, 0, acc, ph == null ? 2 : ph); }
  mm(a, b, d, acc, ph) { this._push('MATMUL_NN', a, b, d, 0, acc, ph); }
  mmta(a, b, d, acc, ph) { this._push('MATMUL_TN', a, b, d, 0, acc, ph); }
  mmtb(a, b, d, acc, ph) { this._push('MATMUL_NT', a, b, d, 0, acc, ph); }

  plan(align, reuse) { return planBuffers(this, align, reuse); }

  ptr(t) { return t.off / 4; }
  seed(s) { this.rng = new MT(s >>> 0); }
  fillUniform(t, lo, hi) {
    const p = this.ptr(t), n = t.shape.n;
    for (let i = 0; i < n; i++) this.buf[p + i] = this.rng.uniform(lo, hi);
  }
  fill(t, v) { this.buf.fill(v, this.ptr(t), this.ptr(t) + t.shape.n); }
  read(t) { return this.buf.slice(this.ptr(t), this.ptr(t) + t.shape.n); }
  // 某个张量最后一次被写时的相位（写回时跟它对齐，保证先后顺序）
  lastPhase(t) {
    for (let i = this.ops.length - 1; i >= 0; i--) if (this.ops[i].d.id === t.id) return this.ops[i].phase;
    return 0;
  }
  at(t) { return this.ptr(t); }
}

// 区间着色：状态先放（偏移稳定、可读），临时量按生命周期首次适配
export function planBuffers(pr, align, reuse) {
  align = align || 64;
  const up = v => Math.ceil(v / align) * align;
  pr.ops.sort((x, y) => x.phase - y.phase);
  const touch = (t, i) => { if (!t) return; if (t.first < 0) t.first = i; t.last = i; };
  pr.ops.forEach((o, i) => { touch(o.a, i); touch(o.b, i); touch(o.d, i); });

  let cur = 0;
  for (const t of pr.tensors) {
    if (!t.isState) continue;
    t.off = cur;
    cur += up(t.shape.n * 4);
  }
  pr.stateBytes = cur;

  const iv = pr.tensors
    .filter(t => !t.isState && t.first >= 0)
    .map(t => ({ t, beg: t.first, end: t.last, bytes: up(t.shape.n * 4) }))
    .sort((x, y) => (x.beg - y.beg) || (x.t.id - y.t.id));

  if (reuse === false) {
    let off = 0;
    for (const v of iv) { v.t.off = cur + off; off += v.bytes; }
    pr.tempBytes = off;
  } else {
    let top = 0;
    const active = [];
    for (const v of iv) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].end < v.beg) active.splice(i, 1);
      const act = active.slice().sort((x, y) => x.off2 - y.off2);
      const free = [];
      let c2 = 0;
      for (const a of act) {
        if (a.off2 > c2) free.push([c2, a.off2 - c2]);
        c2 = Math.max(c2, a.off2 + a.bytes);
      }
      if (top > c2) free.push([c2, top - c2]);
      let chosen = -1;
      for (const f of free) if (f[1] >= v.bytes) { chosen = f[0]; break; }
      if (chosen < 0) chosen = top;
      active.push({ end: v.end, off2: chosen, bytes: v.bytes });
      top = Math.max(top, chosen + v.bytes);
      v.t.off = cur + chosen;
    }
    pr.tempBytes = top;
  }
  pr.total = up(pr.stateBytes + pr.tempBytes);
  pr.buf = new Float32Array(pr.total / 4 + 16);
  pr.planned = true;
  return pr;
}

export function mm(B, d, a, b, M, N, Kk, ta, tb, acc) {
  if (!acc) B.fill(0, d, d + M * N);
  for (let m = 0; m < M; m++)
    for (let k = 0; k < Kk; k++) {
      const av = ta ? B[a + k * M + m] : B[a + m * Kk + k];
      if (av === 0) continue;
      const dRow = d + m * N, bRow = tb ? b + k * Kk : b + k * N;
      for (let n = 0; n < N; n++) B[dRow + n] += av * (tb ? B[b + n * Kk + k] : B[bRow + n]);
    }
}

export function execOp(pr, o) {
  const B = pr.buf;
  const d = pr.ptr(o.d);
  const a = o.a ? pr.ptr(o.a) : 0;
  const b = o.b ? pr.ptr(o.b) : 0;
  const n = o.d.shape.n;
  switch (o.k) {
    case 'CLEAR': B.fill(0, d, d + n); break;
    case 'COPY': if (a !== d) B.copyWithin(d, a, a + n); break;
    case 'ADD': for (let i = 0; i < n; i++) B[d + i] = B[a + i] + B[b + i]; break;
    case 'SUB': for (let i = 0; i < n; i++) B[d + i] = B[a + i] - B[b + i]; break;
    case 'MUL': for (let i = 0; i < n; i++) B[d + i] = B[a + i] * B[b + i]; break;
    case 'SCALE': for (let i = 0; i < n; i++) B[d + i] = B[a + i] * o.scalar; break;
    case 'TANH': for (let i = 0; i < n; i++) B[d + i] = Math.tanh(B[a + i]); break;
    case 'ONE_MINUS_SQ': for (let i = 0; i < n; i++) B[d + i] = 1 - B[a + i] * B[a + i]; break;
    case 'CLAMP': for (let i = 0; i < n; i++) B[d + i] = Math.max(-o.scalar, Math.min(o.scalar, B[a + i])); break;
    case 'AXPY': for (let i = 0; i < n; i++) B[d + i] += o.scalar * B[a + i]; break;
    case 'SUM_ROWS': {
      const r = o.a.shape.r, c = o.a.shape.c;
      if (!o.acc) B.fill(0, d, d + c);
      for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) B[d + j] += B[a + i * c + j];
      break;
    }
    case 'MATMUL_NN': mm(B, d, a, b, o.a.shape.r, o.b.shape.c, o.a.shape.c, false, false, o.acc); break;
    case 'MATMUL_TN': mm(B, d, a, b, o.a.shape.c, o.b.shape.c, o.a.shape.r, true, false, o.acc); break;
    case 'MATMUL_NT': mm(B, d, a, b, o.a.shape.r, o.b.shape.r, o.a.shape.c, false, true, o.acc); break;
  }
}

export function runPhase(pr, maxPhase) {
  const mp = maxPhase == null ? 2 : maxPhase;
  for (const o of pr.ops) { if (o.phase > mp) break; execOp(pr, o); }
}
