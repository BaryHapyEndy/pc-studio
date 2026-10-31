/* tool/pcgraph.js —— 语义图 → Op[] → arena → 运行 / 导出 C++
 *
 * 这个文件和 engine/pc.hpp 是"同一个引擎的两份实现"：张量、op、相位、
 * 区间着色规划、mt19937 初始化序列一一对应，所以浏览器里的曲线和导出的
 * C++ 跑出来的是同一组数（tools/crosscheck 会核对）。
 *
 * 层次：组件库 LIB → 语义图 spec（节点+连线）→ lower() → Program（Op[]+arena）→ run()
 *
 * 连线语义（这是整个界面唯一需要理解的一条规则）：
 *   状态节点的左侧是 in，右侧是 out。op 的 d 输出连到某个状态的 in，
 *   表示"这个 op 直接写进那块内存"（原地写回）。例如
 *       AXPY(Δμ, s=η) → M[1].in      就是  M[1] += η·Δμ
 *       x            → M[0].in      就是  M[0] = x
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PC = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const sh = (r, c) => ({ r, c, n: r * c });
  const same = (a, b) => !!a && !!b && a.r === b.r && a.c === b.c;
  const fmtShape = s => (s ? (s.r === 1 ? `1×${s.c}` : `${s.r}×${s.c}`) : '?');

  // ───────────────────── mt19937（与 C++ std::mt19937 同序列）─────────────────────
  class MT {
    constructor(seed) {
      this.mt = new Uint32Array(624);
      this.idx = 624;
      this.mt[0] = seed >>> 0;
      for (let i = 1; i < 624; i++) {
        const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
        this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
      }
    }
    next32() {
      if (this.idx >= 624) this.twist();
      let y = this.mt[this.idx++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    }
    twist() {
      for (let i = 0; i < 624; i++) {
        const y = (this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff);
        this.mt[i] = this.mt[(i + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.idx = 0;
    }
    uniform(lo, hi) { return lo + (hi - lo) * (this.next32() / 4294967296); }
  }

  // ─────────────────────────── Program ───────────────────────────
  const PH = { PREDICT: 0, INFER: 1, LEARN: 2 };
  const PHNAME = ['预测/误差', '推理（μ）', '学习（θ,β）'];

  class Program {
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

    // 区间着色：状态先放（偏移稳定、可读），临时量按生命周期首次适配
    plan(align, reuse) {
      align = align || 64;
      const up = v => Math.ceil(v / align) * align;
      this.ops.sort((x, y) => x.phase - y.phase);
      const touch = (t, i) => { if (!t) return; if (t.first < 0) t.first = i; t.last = i; };
      this.ops.forEach((o, i) => { touch(o.a, i); touch(o.b, i); touch(o.d, i); });

      let cur = 0;
      for (const t of this.tensors) {
        if (!t.isState) continue;
        t.off = cur;
        cur += up(t.shape.n * 4);
      }
      this.stateBytes = cur;

      const iv = this.tensors
        .filter(t => !t.isState && t.first >= 0)
        .map(t => ({ t, beg: t.first, end: t.last, bytes: up(t.shape.n * 4) }))
        .sort((x, y) => (x.beg - y.beg) || (x.t.id - y.t.id));

      if (reuse === false) {
        let off = 0;
        for (const v of iv) { v.t.off = cur + off; off += v.bytes; }
        this.tempBytes = off;
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
        this.tempBytes = top;
      }
      this.total = up(this.stateBytes + this.tempBytes);
      this.buf = new Float32Array(this.total / 4 + 16);
      this.planned = true;
      return this;
    }

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

  function mm(B, d, a, b, M, N, Kk, ta, tb, acc) {
    if (!acc) B.fill(0, d, d + M * N);
    for (let m = 0; m < M; m++)
      for (let k = 0; k < Kk; k++) {
        const av = ta ? B[a + k * M + m] : B[a + m * Kk + k];
        if (av === 0) continue;
        const dRow = d + m * N, bRow = tb ? b + k * Kk : b + k * N;
        for (let n = 0; n < N; n++) B[dRow + n] += av * (tb ? B[b + n * Kk + k] : B[bRow + n]);
      }
  }

  function execOp(pr, o) {
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

  function runPhase(pr, maxPhase) {
    const mp = maxPhase == null ? 2 : maxPhase;
    for (const o of pr.ops) { if (o.phase > mp) break; execOp(pr, o); }
  }

  // ─────────────────────────── 组件库 ───────────────────────────
  // shape 规则统一用 (D, l) 求值；宽 D[l] 的行向量约定见 docs
  const LIB = [
    // 状态组件：名字和形状都是用户自己填的（不预设层宽 D）。
    // 算子连上来之后，会按连线的形状去校验，不合法就在节点上报错。
    { id: 'x', name: '输入 x', group: '状态', color: '#e2b86b', note: '观测。最低层，永远不被更新',
      state: true, ins: [{ k: 'in', name: '写' }], outs: [{ k: 'out', name: 'x' }] },

    { id: 'M', name: '后验 μ', group: '状态', color: '#69c98a', note: '后验状态，典型形状 1 × n 的行向量',
      state: true, ins: [{ k: 'in', name: '写' }], outs: [{ k: 'out', name: 'μ' }] },

    { id: 'T', name: '权重 θ', group: '状态', color: '#5aa9e6', note: '权重状态，典型形状 n_上 × n_下',
      state: true, ins: [{ k: 'in', name: '写' }], outs: [{ k: 'out', name: 'θ' }] },

    { id: 'B', name: '偏置 β', group: '状态', color: '#9b7ff0', note: '偏置状态，形状要和它预测的那层一致',
      state: true, ins: [{ k: 'in', name: '写' }], outs: [{ k: 'out', name: 'β' }] },

    { id: 'E', name: '误差 ε', group: '状态', color: '#ef7c74', note: '误差状态 ε = μ − f',
      state: true, ins: [{ k: 'in', name: '写' }], outs: [{ k: 'out', name: 'ε' }] },

    { id: 'V', name: '中间量', group: '状态', color: '#8d9bb0', note: '通用命名缓冲区（f、d、g …放在这里好观察）',
      state: true, ins: [{ k: 'in', name: '写' }], outs: [{ k: 'out', name: 'v' }] },

    { id: 'MON', name: '监视', group: '状态', color: '#7bd88f', note: '把一个张量画成方阵热力图（纯显示，不参与计算）',
      view: true, ins: [{ k: 'v', name: '看' }], outs: [] },

    { id: 'MATMUL_NN', name: 'MATMUL_NN', group: '算子', color: '#7fa8d8', note: 'd = a·b',
      ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'MATMUL_NT', name: 'MATMUL_NT', group: '算子', color: '#7fa8d8', note: 'd = a·bᵀ',
      ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'MATMUL_TN', name: 'MATMUL_TN', group: '算子', color: '#7fa8d8', note: 'd = aᵀ·b',
      ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'ADD', name: 'ADD', group: '算子', color: '#7fa8d8', note: 'd = a + b',
      ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'SUB', name: 'SUB', group: '算子', color: '#7fa8d8', note: 'd = a − b',
      ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'MUL', name: 'MUL', group: '算子', color: '#7fa8d8', note: 'd = a ⊙ b',
      ins: [{ k: 'a', name: 'a' }, { k: 'b', name: 'b' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'SCALE', name: 'SCALE', group: '算子', color: '#7fa8d8', note: 'd = s·a',
      params: ['s'], defaults: { s: 1 }, ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'TANH', name: 'TANH', group: '算子', color: '#7fa8d8', note: 'd = tanh(a)',
      ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'ONE_MINUS_SQ', name: 'ONE_MINUS_SQ', group: '算子', color: '#7fa8d8', note: 'd = 1 − a²（tanh 导数）',
      ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'AXPY', name: 'AXPY 累加', group: '算子', color: '#e0a458', note: 'd += s·a —— 原地写回状态',
      params: ['s'], defaults: { s: 0.1 }, ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd' }] },
    { id: 'CLAMP', name: 'CLAMP', group: '算子', color: '#7fa8d8', note: 'd = clip(a, ±c)',
      params: ['c'], defaults: { c: 1 }, ins: [{ k: 'a', name: 'a' }], outs: [{ k: 'd', name: 'd' }] },

    { id: 'EM', name: 'EM 集成块', group: '集成', color: '#e8a0c0',
      note: '一层的前向预测 + 误差 + 推理更新 + 学习更新。左下接 g（下层的 ε⊙d），左侧三个状态位的读/写各走一条线。',
      macro: true, params: ['l'],
      ins: [{ k: 'g', name: 'g（下层 ε⊙d）', optional: true },
            { k: 'mu', name: 'μ（读）', optional: true },
            { k: 'th', name: 'θ（读）', optional: true },
            { k: 'be', name: 'β（读）', optional: true },
            { k: 'fa', name: 'f_l（上层预测）', optional: true }],
      outs: [{ k: 'f', name: 'f（预测下层）' },
             { k: 'eps', name: 'ε（本层误差）' },
             { k: 'mu1', name: 'μ′ 写回' },
             { k: 'th1', name: 'θ′ 写回' },
             { k: 'be1', name: 'β′ 写回' }] },
  ];
  const LIBMAP = {}; LIB.forEach(c => (LIBMAP[c.id] = c));

  // 张量名（进 arena / 导出 C++）：M0, T1, E0, V_P0 …
  function tname(n) {
    const c = LIBMAP[n.type];
    if (c && c.state && n.name) return String(n.name).replace(/[^\w\u4e00-\u9fa5]/g, '_');
    if (n.type === 'x') return 'x';
    if (['M', 'T', 'B', 'E'].includes(n.type) && n.l != null) return n.type + n.l;
    return n.id;
  }
  // 显示名（界面上）：M[0], T[1] …
  function label(n) {
    const c = LIBMAP[n.type];
    if (!c) return n.type;
    if (c.state && n.name) return n.name;
    if (c.params && c.params.includes('l') && n.l != null) return `${c.id}[${n.l}]`;
    return c.name;
  }

  // 某个节点的端口形状
  // 状态组件的形状：用户显式填的优先，没填就按老规矩从 dims 推一个默认值
  function stateShape(spec, n) {
    if (n.shape && n.shape.r > 0 && n.shape.c > 0) return sh(n.shape.r, n.shape.c);
    const D = spec.dims || [64, 1024];
    if (n.type === 'x') return sh(1, D[0]);
    if (n.type === 'M') return sh(1, D[n.l || 0]);
    if (n.type === 'T') return sh(D[n.l || 0], D[(n.l || 0) - 1] || D[0]);
    if (n.type === 'B' || n.type === 'E') return sh(1, D[(n.l || 1) - 1] || D[0]);
    return sh(1, D[0]);
  }

  function portShape(spec, n, port, isOut) {
    const c = LIBMAP[n.type];
    if (c.state) return isOut ? stateShape(spec, n) : null;
    const D = spec.dims || [64, 1024];
    if (n.type === 'EM') {
      // EM 的形状由它接的状态决定（没接就无从谈起，返回 null 让 UI 只画个圆点）
      const mu = edgeSource(spec, n, 'mu'), th = edgeSource(spec, n, 'th');
      const Du = mu ? portShape(spec, mu.n, mu.port, true) : null;
      const Tt = th ? portShape(spec, th.n, th.port, true) : null;
      if (!Du || !Tt) return null;
      const Dd = sh(1, Tt.c);
      if (isOut) return (port === 'f' || port === 'be1') ? Dd : Du;
      return (port === 'g') ? Dd : Du;
    }
    const defs = isOut ? c.outs : c.ins;
    const def = defs && defs.find(p => p.k === port);
    if (!def || !def.shape) return null;   // 算子端口：形状由上游决定
    return def.shape(D, n.l, n);
  }

  function edgeSource(spec, n, port) {
    for (const e of spec.edges) {
      if (e.to[0] === n.id && e.to[1] === port) {
        const src = spec.nodes.find(x => x.id === e.from[0]);
        if (src && LIBMAP[src.type]) return { n: src, port: e.from[1] };
        return null;
      }
    }
    return null;
  }

  // ─────────────────────────── lowering ───────────────────────────
  // 返回 {pr, errors, T, stats}
  function lower(spec, opts) {
    opts = opts || {};
    const D = spec.dims;
    const L = D.length - 1;
    const pr = new Program();
    const errors = [];
    // 监视组件不进 lowering，但它的连线要能查到源张量
    const all = spec.nodes.filter(n => LIBMAP[n.type]);
    const nodes = all.filter(n => !LIBMAP[n.type].view);
    const byId = {};
    all.forEach(n => (byId[n.id] = n));

    const T = {};           // "nodeId.port" → tensor
    const errNodes = new Set();
    const bad = (n, msg) => { errNodes.add(n.id); errors.push({ node: n.id, msg }); };
    const writing = new Set();
    const inc = {};         // "nodeId.port" → edge
    for (const e of spec.edges) {
      if (byId[e.from[0]] && byId[e.to[0]]) inc[e.to[0] + '.' + e.to[1]] = e;
    }

    // 状态张量（含 V），名字 = 节点标签
    for (const n of nodes) {
      const c = LIBMAP[n.type];
      if (!c.state) continue;
      const s = stateShape(spec, n);
      T[n.id + '.out'] = pr.state(tname(n), s);
    }
    const stateT = (name) => pr.tensors.find(t => t.name === name && t.isState);

    // 缺省状态：EM 需要 M/T/B/E，没有就自动补（省得用户手拖 4 个节点）
    function ensure(name, s) {
      const e = stateT(name);
      if (e) return e;
      return pr.state(name, s);
    }

    function inTensor(n, port) {
      const e = inc[n.id + '.' + port];
      if (!e) return null;
      return outOf(byId[e.from[0]], e.from[1]);
    }
    function outOf(n, port) {
      const key = n.id + '.' + port;
      if (T[key]) return T[key];
      emit(n);
      if (!T[key] && !errNodes.has(n.id)) errors.push({ node: n.id, msg: `${label(n)}.${port} 没有输出` });
      return T[key];
    }

    // 写回目标：op 的 d 连到状态 in 时，直接写那块内存
    // （注意看的是从本节点 d 端口"出去"的边，不是进来的边）
    function writeTarget(n, shape) {
      const e = spec.edges.find(x => x.from[0] === n.id && x.from[1] === 'd' && x.to[1] === 'in');
      if (e) {
        const tgt = byId[e.to[0]];
        const tc = LIBMAP[tgt.type];
        if (tc && tc.state) {
          const st = T[tgt.id + '.out'];
          if (!same(st.shape, shape)) {
            errors.push({ node: n.id, msg: `写回 ${label(tgt)} 形状不符: ${fmtShape(shape)} → ${fmtShape(st.shape)}` });
            return pr.temp(n.id, shape);
          }
          return st;
        }
      }
      return pr.temp(n.id, shape);
    }

    const done = new Set();
    function emit(n) {
      if (!n || writing.has(n.id) || done.has(n.id)) return;
      const c = LIBMAP[n.type];
      if (!c) return;
      if (c.state) return;          // 状态是被动的
      writing.add(n.id);

      try {
        if (n.type === 'EM') emitEM(n);
        else emitOp(n);
      } catch (err) {
        errors.push({ node: n.id, msg: err.message });
      }
      writing.delete(n.id);
      done.add(n.id);
    }

    function emitOp(n) {
      const a = inTensor(n, 'a');
      const b = inTensor(n, 'b');
      const need = (n.type === 'ADD' || n.type === 'SUB' || n.type === 'MUL' ||
                    n.type === 'MATMUL_NN' || n.type === 'MATMUL_NT' || n.type === 'MATMUL_TN');
      if (!a && !b) { bad(n, `${label(n)}: 输入没连线`); return; }
      if (need && (!a || !b)) {
        bad(n, `${label(n)}: 还差一个输入（都连上才算得出形状）`);
        return;
      }
      // 形状从连线上"读"出来：连对了就算得动，连错了就在这报出来
      let s;
      switch (n.type) {
        case 'MATMUL_NN':
          if (a.shape.c !== b.shape.r) { bad(n, `矩阵乘不上: ${fmtShape(a.shape)}·${fmtShape(b.shape)}（左列 ${a.shape.c} ≠ 右行 ${b.shape.r}）`); return; }
          s = sh(a.shape.r, b.shape.c); break;
        case 'MATMUL_NT':
          if (a.shape.c !== b.shape.c) { bad(n, `矩阵乘不上: ${fmtShape(a.shape)}·${fmtShape(b.shape)}ᵀ（列 ${a.shape.c} ≠ 列 ${b.shape.c}）`); return; }
          s = sh(a.shape.r, b.shape.r); break;
        case 'MATMUL_TN':
          if (a.shape.r !== b.shape.r) { bad(n, `矩阵乘不上: ${fmtShape(a.shape)}ᵀ·${fmtShape(b.shape)}（行 ${a.shape.r} ≠ 行 ${b.shape.r}）`); return; }
          s = sh(a.shape.c, b.shape.c); break;
        case 'ADD': case 'SUB': case 'MUL':
          if (!same(a.shape, b.shape)) { bad(n, `${n.type} 两边形状不一致: ${fmtShape(a.shape)} vs ${fmtShape(b.shape)}`); return; }
          s = a.shape; break;
        default: s = (a || b).shape;
      }
      const d = writeTarget(n, s);
      const ph = n.type === 'AXPY' ? PH.LEARN : PH.PREDICT;
      switch (n.type) {
        case 'MATMUL_NN': pr.mm(a, b, d); break;
        case 'MATMUL_NT': pr.mmtb(a, b, d); break;
        case 'MATMUL_TN': pr.mmta(a, b, d); break;
        case 'ADD': pr.add(a, b, d); break;
        case 'SUB': pr.sub(a, b, d); break;
        case 'MUL': pr.mul(a, b, d); break;
        case 'SCALE': pr.scale(num(n.s, 1), a, d); break;
        case 'TANH': pr.tanh(a, d); break;
        case 'ONE_MINUS_SQ': pr.oneMinusSq(a, d); break;
        case 'CLAMP': pr.clamp(a, d, num(n.c, 1)); break;
        case 'AXPY': pr.axpy(num(n.s, 0.1), a, d, ph); break;
      }
      T[n.id + '.d'] = d;
    }

    function emitEM(n) {
      const l = n.l || 1;
      // 形状完全由接进来的状态决定：μ 是 (1×Du)，θ 是 (Du×Dd)
      const M = inTensor(n, 'mu');
      const Tt = inTensor(n, 'th');
      if (!M || !Tt) { bad(n, `EM 需要把 μ 和 θ 两个状态接进来（形状从它们读）`); return; }
      if (M.shape.r !== 1) { bad(n, `EM 的 μ 应该是行向量 (1×n)，现在是 ${fmtShape(M.shape)}`); return; }
      const Du = M.shape.c, Dd = Tt.shape.c;
      if (Tt.shape.r !== Du) { bad(n, `EM 的 θ 应该是 (${Du}×n)，现在是 ${fmtShape(Tt.shape)}`); return; }
      const B = inTensor(n, 'be') || ensure('B' + l, sh(1, Dd));
      if (!same(B.shape, sh(1, Dd))) { bad(n, `EM 的 β 应该是 (1×${Dd})，现在是 ${fmtShape(B.shape)}`); return; }
      const E = ensure('E' + l, sh(1, Du));
      if (!same(E.shape, sh(1, Du))) { bad(n, `EM 的误差状态应该是 (1×${Du})，现在是 ${fmtShape(E.shape)}`); return; }
      const g = inTensor(n, 'g');
      const fa = inTensor(n, 'fa');

      const pre = pr.temp('pre' + l, sh(1, Dd));
      const f = pr.temp('f' + (l - 1), sh(1, Dd));
      pr.mm(M, Tt, pre, false, PH.PREDICT);
      pr.add(pre, B, f, PH.PREDICT);
      pr.tanh(f, f, PH.PREDICT);

      if (fa) {
        if (!same(fa.shape, M.shape)) bad(n, `f_l 形状不符: ${fmtShape(fa.shape)} vs ${fmtShape(M.shape)}`);
        pr.sub(M, fa, E, PH.PREDICT);
      } else {
        // 顶层：先验 N(0, Σ_l)，精度 ω = spec.wTop。ε = ω·μ（否则 ε=μ 会把 μ 压向 0，
        // 高阶表征塌缩、只剩偏置在拟合——这正是修好之前的现象）
        pr.scale(num(spec.wTop, 0.02), M, E, PH.PREDICT);
      }
      T[n.id + '.f'] = f;
      T[n.id + '.eps'] = E;

      // 三个状态位的新值（推理 / 学习）
      const mu1 = pr.temp('mu_hat' + l, sh(1, Du));
      const th1 = pr.temp('th_hat' + l, sh(Du, Dd));
      const be1 = pr.temp('be_hat' + l, sh(1, Dd));
      if (g) {
        if (!same(g.shape, sh(1, Dd))) bad(n, `g 形状不符: ${fmtShape(g.shape)} vs ${fmtShape(sh(1, Dd))}`);
        const dmu = pr.temp('dmu' + l, sh(1, Du));
        pr.mmtb(g, Tt, dmu, false, PH.INFER);      // g·θᵀ
        pr.sub(dmu, E, dmu, PH.INFER);             // − ε_l
        pr.copy(M, mu1, PH.INFER);
        pr.axpy(num(spec.lrMu, 0.1), dmu, mu1, PH.INFER);   // μ′ = μ + η(gθᵀ − ε)
        const dT = pr.temp('dT' + l, sh(Du, Dd));
        pr.mmta(M, g, dT, false, PH.LEARN);        // μᵀg
        pr.copy(Tt, th1, PH.LEARN);
        pr.axpy(num(spec.lrT, 0.01), dT, th1, PH.LEARN);
        pr.copy(B, be1, PH.LEARN);
        pr.axpy(num(spec.lrB, 0.01), g, be1, PH.LEARN);
      } else {
        pr.copy(M, mu1, PH.PREDICT);
        pr.copy(Tt, th1, PH.PREDICT);
        pr.copy(B, be1, PH.PREDICT);
      }
      T[n.id + '.mu1'] = mu1;
      T[n.id + '.th1'] = th1;
      T[n.id + '.be1'] = be1;
    }

    // 展开所有有输出的节点（深度优先，自动处理依赖）
    for (const n of nodes) emit(n);

    // 状态写回：某个 op/EM 的输出连到状态的 in ⇒ 把新值赋值进去
    // （必须放在所有节点展开之后：写回要用到本步刚算出来的值）
    for (const n of nodes) {
      const c = LIBMAP[n.type];
      if (!c.state) continue;
      const e = inc[n.id + '.in'];
      if (!e) continue;
      const src = byId[e.from[0]];
      if (!src) continue;
      const st = outOf(src, e.from[1]);
      if (!st || st.id === T[n.id + '.out'].id) continue;   // 已经原地写进去了，不用再拷
      if (!same(st.shape, T[n.id + '.out'].shape)) {
        errors.push({ node: n.id, msg: `写回形状不符: ${fmtShape(st.shape)} → ${fmtShape(T[n.id + '.out'].shape)}` });
        continue;
      }
      pr.copy(st, T[n.id + '.out'], pr.lastPhase(st));
    }

    // 监视组件：记下它要看的那块张量（只显示，不参与计划）
    const views = {};
    for (const n of spec.nodes) {
      const c = LIBMAP[n.type];
      if (!c || !c.view) continue;
      const e = inc[n.id + '.v'];
      if (!e) continue;
      const src = byId[e.from[0]];
      if (!src) continue;
      const t = outOf(src, e.from[1]);
      if (t) views[n.id] = t;
    }

    if (!errors.length) pr.plan(64, opts.reuse !== false);
    else pr.total = 0;

    return { pr, errors, T, D, L, views };
  }

  function num(v, dflt) { const x = v == null ? dflt : +v; return isFinite(x) ? x : dflt; }

  // 初始化：顺序固定，保证和导出的 C++ 同一组数
  // 按组件类型决定初始化：μ/θ 抽 U(−0.1,0.1)，β 填 0.05，其余清零。
  // 名字只用来对号，所以用户把 M1 改名成 alpha 也照样能跑。
  function stateTypes(spec) {
    const m = {};
    for (const n of (spec && spec.nodes) || []) {
      const c = LIBMAP[n.type];
      if (c && c.state) m[tname(n)] = n.type;
    }
    return m;
  }

  function initProgram(pr, spec) {
    pr.seed(spec.seed == null ? 42 : spec.seed);
    const types = stateTypes(spec);
    const kind = t => types[t.name] || (/^M\d+$/.test(t.name) ? 'M' : /^T\d+$/.test(t.name) ? 'T' : /^B\d+$/.test(t.name) ? 'B' : '');
    const states = pr.tensors.filter(t => t.isState);
    for (const t of states) {
      const k = kind(t);
      if (k === 'M' || k === 'T') pr.fillUniform(t, -0.1, 0.1);
      else if (k === 'B') pr.fill(t, 0.05);
      else pr.fill(t, 0);
    }
  }

  function metrics(pr) {
    const byPhase = [0, 0, 0];
    const byKind = {};
    for (const o of pr.ops) {
      byPhase[o.phase]++;
      byKind[o.k] = (byKind[o.k] || 0) + 1;
    }
    return { ops: pr.ops.length, byPhase, byKind, stateBytes: pr.stateBytes, tempBytes: pr.tempBytes,
             total: pr.total, tensors: pr.tensors.length };
  }

  // 自由能 F = Σ_l Σ_i ε_l[i]²（Σ_l 取单位阵）
  function freeEnergy(pr, spec) {
    const types = spec ? stateTypes(spec) : {};
    let F = 0;
    const perLayer = [];
    for (const t of pr.tensors) {
      if (!t.isState) continue;
      const isE = types[t.name] ? types[t.name] === 'E' : /^E\d+$/.test(t.name);
      if (!isE) continue;
      const p = pr.ptr(t);
      let s = 0;
      for (let i = 0; i < t.shape.n; i++) s += pr.buf[p + i] * pr.buf[p + i];
      perLayer.push({ name: t.name, e: s });
      F += s;
    }
    return { F, perLayer };
  }

  // ─────────────────────────── C++ 导出 ───────────────────────────
  // 直接按"已规划的程序"逐张量、逐 op 生成，因此永远和图上一致。
  function emitCpp(spec, name) {
    const { pr, errors } = lower(spec, { reuse: true });
    if (errors.length) return { text: '// 图有错误，无法导出：\n' + errors.map(e => '//   ' + e.msg).join('\n'), errors };
    const D = spec.dims, L = D.length - 1;
    const varOf = {}, refOf = {};
    pr.tensors.forEach((t, i) => {
      varOf[t.name] = 't' + i;
      refOf[t.name] = (t.isState ? 'm.' : '') + 't' + i;   // 状态是成员，临时量是局部变量
    });
    const L2 = [];
    const p = s => L2.push(s);

    p(`// 由 pc-studio 导出 —— ${pr.tensors.filter(t => t.isState).length} 个状态，${pr.ops.length} 个 op，arena ${pr.total} B`);
    p('// 与界面里的图一一对应；用法见 examples/pc_basic.cpp');
    p('#pragma once');
    p('#include <cstdint>');
    p('#include "engine/pc.hpp"');
    p('');
    p(`namespace gen_${name || 'model'} {`);
    p(`inline constexpr int NL = ${L};`);
    p(`inline constexpr int D[${D.length}] = {${D.join(', ')}};`);
    p('');
    p('struct Model {');
    p('    pc::Program pr;');
    for (const t of pr.tensors) if (t.isState) p(`    pc::Tens ${varOf[t.name]};   // ${t.name} ${fmtShape(t.shape)}`);
    p('};');
    p('');
    p('inline void build(Model& m) {');
    p('    pc::Program& pr = m.pr;');
    for (const t of pr.tensors) {
      const ctor = t.isState ? 'state' : 'temp';
      const decl = t.isState ? `m.${varOf[t.name]} =` : `auto ${varOf[t.name]} =`;
      p(`    ${decl} pr.${ctor}("${t.name}", pc::sh(${t.shape.r}, ${t.shape.c}));`);
    }
    p('');
    for (const o of pr.ops) {
      const A = n => (n && n.id >= 0 ? refOf[n.name] : '{}');
      const ph = o.phase === 0 ? '' : `, pc::PH_${o.phase === 1 ? 'INFER' : 'LEARN'}`;
      const acc = o.acc ? ', true' : '';
      switch (o.k) {
        case 'CLEAR': p(`    pr.clear(${A(o.d)}${ph});`); break;
        case 'COPY': p(`    pr.copy(${A(o.a)}, ${A(o.d)}${ph});`); break;
        case 'ADD': p(`    pr.add(${A(o.a)}, ${A(o.b)}, ${A(o.d)}${ph});`); break;
        case 'SUB': p(`    pr.sub(${A(o.a)}, ${A(o.b)}, ${A(o.d)}${ph});`); break;
        case 'MUL': p(`    pr.mul(${A(o.a)}, ${A(o.b)}, ${A(o.d)}${ph});`); break;
        case 'SCALE': p(`    pr.mulc(${o.scalar}f, ${A(o.a)}, ${A(o.d)}${ph});`); break;
        case 'TANH': p(`    pr.tanh(${A(o.a)}, ${A(o.d)}${ph});`); break;
        case 'ONE_MINUS_SQ': p(`    pr.one_minus_sq(${A(o.a)}, ${A(o.d)}${ph});`); break;
        case 'CLAMP': p(`    pr.clamp(${A(o.a)}, ${A(o.d)}, ${o.scalar}f${ph});`); break;
        case 'AXPY': p(`    pr.axpy(${o.scalar}f, ${A(o.a)}, ${A(o.d)}${ph});`); break;
        // acc 必须显式传：否则相位实参会落进 acc 形参（bool 隐式转换）
        case 'SUM_ROWS': p(`    pr.sum_rows(${A(o.a)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
        case 'MATMUL_NN': p(`    pr.mm(${A(o.a)}, ${A(o.b)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
        case 'MATMUL_TN': p(`    pr.mmta(${A(o.a)}, ${A(o.b)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
        case 'MATMUL_NT': p(`    pr.mmtb(${A(o.a)}, ${A(o.b)}, ${A(o.d)}, ${o.acc ? 'true' : 'false'}${ph});`); break;
      }
    }
    p('    pr.plan(64, true);');
    p('}');
    p('');
    p('// 初始化顺序与界面一致（同一个种子 ⇒ 同一组初值）');
    p('inline void init(Model& m, uint32_t seed = 42) {');
    p('    auto& pr = m.pr;');
    p('    pr.seed(seed);');
    const types = stateTypes(spec);
    const kindOf = n => types[n] || (/^M\d+$/.test(n) || /^T\d+$/.test(n) ? 'M' : /^B\d+$/.test(n) ? 'B' : '');
    for (const t of pr.tensors) {
      if (!t.isState) continue;
      const k = kindOf(t.name);
      if (k === 'M' || k === 'T') p(`    pr.fill_uniform(m.${varOf[t.name]}, -0.1f, 0.1f);`);
      else if (k === 'B') p(`    pr.fill(m.${varOf[t.name]}, 0.05f);`);
      else p(`    pr.fill(m.${varOf[t.name]}, 0.f);`);
    }
    p('}');
    p('');
    p(`// 每步：相位 0/1 全跑；每 ${spec.nInfer || 10} 步跑一次相位 2（学习）`);
    p('inline void step(Model& m, int it) {');
    p(`    m.pr.run(it % ${spec.nInfer || 10} == ${(spec.nInfer || 10) - 1} ? pc::PH_LEARN : pc::PH_INFER);`);
    p('}');
    p('');
    p('}  // namespace');
    return { text: L2.join('\n'), errors };
  }

  // ─────────────────────────── 预设图 ───────────────────────────
  // 每一层（stage c：第 c 层被第 c+1 层预测）用一个横向条带画出来：
  //
  //   M[c+1] ┐                                                        ┌ g[c] ┐
  //   T[c+1] ┤→ EM[c+1] → P[c] → SUB → E[c] ┐                        │      │
  //   B[c+1] ┘                            └→ ONE_MINUS_SQ → D[c] ┴→ MUL ┘
  //
  // 状态节点的左边是写、右边是读；EM 的 μ′/θ′/β′ 连回状态左边完成更新。
  function presetLayers(dims) {
    const D = dims || [64, 1024];
    const L = D.length;
    const nodes = [], edges = [];
    const X = { st: 20, em: 200, pred: 450, sub: 630, err: 810 };
    const DY = 132;                    // 同列节点的纵向间距
    // 从顶层往下排；第 1 层那条带最高（它还要放 x 和 M[0]）
    // 顶层还要多放一个"本层误差 ε_L"状态，所以再高一点
    function bandH(l) { return (l === 1 ? DY * 5 + 40 : DY * 3 + 40) + (l === L - 1 ? 120 : 0); }
    const yOf = {};
    for (let l = L - 1; l >= 1; l--) {
      let y = 30;
      for (let k = L - 1; k > l; k--) y += bandH(k);
      yOf[l] = y;
    }
    const uid = (a, b) => a + b;

    for (let l = L - 1; l >= 1; l--) {
      const y = yOf[l], c = l - 1;
      // 状态列
      if (l === 1) {
        nodes.push({ id: 'x', type: 'x', name: 'x', shape: { r: 1, c: D[0] }, pos: { x: X.st, y: y } });
        nodes.push({ id: 'M0', type: 'M', l: 0, name: 'M0', shape: { r: 1, c: D[0] }, pos: { x: X.st, y: y + DY } });
      }
      const stBase = l === 1 ? y + DY * 2 : y;
      nodes.push({ id: uid('M', l), type: 'M', l: l, name: 'M' + l, shape: { r: 1, c: D[l] }, pos: { x: X.st, y: stBase } });
      nodes.push({ id: uid('T', l), type: 'T', l: l, name: 'T' + l, shape: { r: D[l], c: D[l - 1] }, pos: { x: X.st, y: stBase + DY } });
      nodes.push({ id: uid('B', l), type: 'B', l: l, name: 'B' + l, shape: { r: 1, c: D[l - 1] }, pos: { x: X.st, y: stBase + DY * 2 } });
      nodes.push({ id: uid('EM', l), type: 'EM', l: l, pos: { x: X.em, y: y } });
      // 预测链
      nodes.push({ id: uid('P', c), type: 'V', name: 'P' + c, shape: { r: 1, c: D[c] }, pos: { x: X.pred, y: y + 40 } });
      nodes.push({ id: uid('DM', c), type: 'ONE_MINUS_SQ', pos: { x: X.pred, y: y + 180 } });
      nodes.push({ id: uid('SUB', c), type: 'SUB', pos: { x: X.sub, y: y + 40 } });
      nodes.push({ id: uid('D', c), type: 'V', name: 'd' + c, shape: { r: 1, c: D[c] }, pos: { x: X.sub, y: y + 180 } });
      nodes.push({ id: uid('E', c), type: 'E', l: c, name: 'E' + c, shape: { r: 1, c: D[c] }, pos: { x: X.err, y: y + 40 } });
      nodes.push({ id: uid('MUL', c), type: 'MUL', pos: { x: X.err, y: y + 180 } });
      nodes.push({ id: uid('G', c), type: 'V', name: 'g' + c, shape: { r: 1, c: D[c] }, pos: { x: X.sub, y: y + 300 } });

      for (const [k, st] of [['mu', 'M'], ['th', 'T'], ['be', 'B']]) {
        edges.push({ from: [st + l, 'out'], to: ['EM' + l, k] });
        edges.push({ from: ['EM' + l, k + '1'], to: [st + l, 'in'] });
      }
      edges.push({ from: ['EM' + l, 'f'], to: ['P' + c, 'in'] });
      if (l === L - 1) {
        // 顶层没有上层预测 ⇒ ε_l 由 EM 直接给出（ε = ω·μ），单独挂一个误差状态方便观察
        nodes.push({ id: 'Etop' + l, type: 'E', l: l, name: 'E' + l, shape: { r: 1, c: D[l] }, pos: { x: X.pred, y: y + 400 } });
        edges.push({ from: ['EM' + l, 'eps'], to: ['Etop' + l, 'in'] });
      }
      edges.push({ from: ['M' + c, 'out'], to: ['SUB' + c, 'a'] });
      edges.push({ from: ['P' + c, 'out'], to: ['SUB' + c, 'b'] });
      edges.push({ from: ['SUB' + c, 'd'], to: ['E' + c, 'in'] });
      edges.push({ from: ['P' + c, 'out'], to: ['DM' + c, 'a'] });
      edges.push({ from: ['DM' + c, 'd'], to: ['D' + c, 'in'] });
      edges.push({ from: ['E' + c, 'out'], to: ['MUL' + c, 'a'] });
      edges.push({ from: ['D' + c, 'out'], to: ['MUL' + c, 'b'] });
      edges.push({ from: ['MUL' + c, 'd'], to: ['G' + c, 'in'] });
      edges.push({ from: ['G' + c, 'out'], to: ['EM' + l, 'g'] });
      if (l + 1 < L) edges.push({ from: ['EM' + (l + 1), 'f'], to: ['EM' + l, 'fa'] });
    }
    // 输入 → 第 0 层
    edges.push({ from: ['x', 'out'], to: ['M0', 'in'] });
    return { dims: D, lrMu: 0.1, lrT: 0.01, lrB: 0.01, nInfer: 20, seed: 42, wTop: 0.02, nodes, edges };
  }

  function presetBasic(dims) { return presetLayers(dims || [64, 1024]); }
  function presetDeep(dims) { return presetLayers(dims || [64, 512, 256]); }

  // 单层：只有 x 和 M[0]，没有 EM（用来看"没有隐藏层时会怎样"）
  function presetSingle(dims) {
    const D = dims || [64];
    return {
      dims: D, lrMu: 0.1, lrT: 0.01, lrB: 0.01, nInfer: 20, seed: 42, wTop: 0.02,
      nodes: [{ id: 'x', type: 'x', name: 'x', shape: { r: 1, c: D[0] }, pos: { x: 60, y: 200 } },
              { id: 'M0', type: 'M', l: 0, name: 'M0', shape: { r: 1, c: D[0] }, pos: { x: 240, y: 200 } }],
      edges: [{ from: ['x', 'out'], to: ['M0', 'in'] }],
    };
  }

  return { sh, same, fmtShape, MT, Program, LIB, LIBMAP, label, tname, portShape, stateShape, edgeSource, lower, initProgram,
           metrics, freeEnergy, execOp, runPhase, emitCpp, PH, PHNAME,
           presetBasic, presetSingle, presetDeep };
});
