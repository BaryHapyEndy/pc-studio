/* ============================================================================
 * schedgen.js — schedule compiler for the pc-engine prototype
 *
 *   semantic graph  ──lower──▶  Op[] (your struct Op)  ──plan──▶  arena layout
 *
 * Runs in the browser (window.SchedGen) and in node (require('./schedgen.js')).
 * No dependencies.
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SchedGen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.1';
  var ALIGN = 64;
  function alignUp(x) { return (x + ALIGN - 1) & ~(ALIGN - 1); }

  /* ---------------------------------------------------------------- opcodes */
  // kind: 'el' elementwise, 'mm' matmul, 'sp' special (has its own loop shape)
  var OPINFO = {
    ADD:        { kind: 'el', d: 'dst = src0 + src1' },
    SUB:        { kind: 'el', d: 'dst = src0 - src1' },
    MUL:        { kind: 'el', d: 'dst = src0 * src1 * scalar' },
    MUL_BC:     { kind: 'el', d: 'dst = src0 * src1[0,:] (broadcast row)' },
    SCALE:      { kind: 'el', d: 'dst = src0 * scalar' },
    TANH:       { kind: 'el', d: 'dst = tanh(src0)' },
    CLEAR:      { kind: 'el', d: 'dst = 0' },
    CLAMP:      { kind: 'el', d: 'dst = clamp(src0, -scalar, +scalar)' },
    ONE_MINUS_SQ:{kind: 'el', d: 'dst = 1 - src0^2' },
    SHIFT:      { kind: 'el', d: 'dst = shifted state (row k <- row k+1, last row * gain)' },
    SUM_ROWS:   { kind: 'sp', d: 'dst[0,:] (+)= sum_k src0[k,:]' },
    THRESHOLD_MUL:{kind:'el', d: 'dst *= (dst > scalar)' },
    MATMUL_NN:  { kind: 'mm', d: 'C = A @ B' },
    MATMUL_NT:  { kind: 'mm', d: 'C = A @ B^T' },
    MATMUL_TN:  { kind: 'mm', d: 'C = A^T @ B' },
    P_UPDATE:   { kind: 'sp', d: 'S += P^2 E^2 - P ; P = gate(S) ; prune' },
    NORM_STEP:  { kind: 'sp', d: 'set *= 1 - 0.5 tanh(|set| - target)' },
    PREDICT_ACT:{ kind: 'sp', d: 'row0 = tanh(row0+B) ; rows1: *= 1-row0^2   (in place)' },
    DIFFUSE:    { kind: 'sp', d: 'state[k] += scalar*(state[k+1] / last row*=-0.1)  (in place)' },
    EXTRACT_ROW:{ kind: 'sp', d: 'dst = src0[scalar, :]' },
    EXTRACT_ROWS_EXCEPT:{ kind: 'sp', d: 'dst = src0[rows != scalar, :]' },
    CONCAT_ROWS:{ kind: 'sp', d: 'dst = [src0 ; src1]' }
  };

  var FLAG_ACC = 1; // accumulate into dst instead of overwriting (matmul beta=1, sum_rows +=)

  /* ------------------------------------------------------------------- spec */
  function normalize(spec) {
    spec = spec || {};
    var D = (spec.D || [1024, 64, 16]).slice();
    var s = {
      K: spec.K != null ? spec.K : 3,
      D: D,
      connections: [],
      fusion: spec.fusion || 'compound',   // 'compound' | 'local'
      gate: !!spec.gate,                   // wire the dead P_UPDATE op
      norm: !!spec.norm,                   // wire the dead NORM_STEP op
      learnM0: !!spec.learnM0,             // re-enable the commented-out M[0] descent
      lrM: spec.lrM != null ? spec.lrM : 0.01,
      lrTB: spec.lrTB != null ? spec.lrTB : 0.1,
      lrE: spec.lrE != null ? spec.lrE : 1.0,
      dt: spec.dt != null ? spec.dt : 0.001,
      clampC: spec.clampC != null ? spec.clampC : 1.0,
      shiftGain: spec.shiftGain != null ? spec.shiftGain : -0.1,
      updateEvery: spec.updateEvery != null ? spec.updateEvery : 10,
      clearPolicy: spec.clearPolicy || 'none', // 'none' | 'hand' (照手写 schedule 那样发 CLEAR)
      diffuse: spec.diffuse || 'bottom',       // 'bottom' | 'all'
      acc: spec.acc !== false,                 // use beta=1 / += accumulators
      reuse: spec.reuse !== false              // let the planner overlap dead temps
    };
    if (Array.isArray(spec.connections)) {
      s.connections = spec.connections.map(function (c, i) {
        return { id: 'c' + i, lower: c.lower, upper: c.upper, on: c.on !== false };
      });
    } else {
      var n = spec.connections != null ? spec.connections : Math.max(0, D.length - 1);
      for (var i = 0; i < n; ++i) s.connections.push({ id: 'c' + i, lower: i, upper: i + 1, on: true });
    }
    return s;
  }

  /* ---------------------------------------------------------------- tensors */
  function T(name, r, c, kind, label) {
    return { name: name, r: r, c: c, bytes: alignUp(r * c * 4), kind: kind, label: label || name };
  }

  /* --------------------------------------------------------------- lowering */
  function lower(spec) {
    var ph = [[], []];          // phase-major: all fwd ops of all connections, then all slow ops
    var tensors = {};
    var byName = function (n) { if (!tensors[n]) throw new Error('unknown tensor ' + n); return tensors[n]; };

    function add(t) { tensors[t.name] = t; return t; }

    function emit(phase, code, o) {
      var op = {
        code: code, phase: phase, conn: o.conn != null ? o.conn : -1,
        tpl: o.tpl || '', scalar: o.scalar != null ? o.scalar : 0,
        acc: !!o.acc, flags: o.acc ? FLAG_ACC : 0,
        s0: o.s0 ? o.s0.name : null, s1: o.s1 ? o.s1.name : null, dst: o.dst.name,
        r: o.r, c: o.c, r1: o.r1, c1: o.c1, r2: o.r2, c2: o.c2,
        mmM: o.mm ? o.mm[0] : 0, mmN: o.mm ? o.mm[1] : 0, mmK: o.mm ? o.mm[2] : 0
      };
      // sanity: elementwise extents must fit their tensors
      if (OPINFO[code].kind === 'el' && o.r != null) {
        var cap = byName(o.dst.name).r * byName(o.dst.name).c;
        if (o.r * o.c > cap) throw new Error(code + ': extent ' + o.r + 'x' + o.c + ' > dst ' + o.dst.name + ' (' + cap + ')');
      }
      ph[op.phase].push(op);
      return op;
    }

    var K = spec.K;
    var D = spec.D;

    // persistent state tensors
    for (var l = 0; l < D.length; ++l) add(T('M' + l, K, D[l], 'state', 'M[' + l + '] state'));
    var conns = spec.connections.filter(function (c) { return c.on; });
    conns.forEach(function (cn) {
      var Dc = D[cn.lower], Du = D[cn.upper];
      add(T('T' + cn.id, Du, Dc, 'state', 'T[' + cn.lower + '] transition'));
      add(T('B' + cn.id, 1, Dc, 'state', 'B[' + cn.lower + '] bias'));
      add(T('P' + cn.id, K, Dc, 'state', 'P[' + cn.lower + '] precision'));
      add(T('S' + cn.id, K, Dc, 'state', 'S[' + cn.lower + '] gate accum'));
      add(T('E' + cn.id, K, Dc, 'reg', 'E[' + cn.lower + '] error (lives fwd->slow)'));
      add(T('Dp' + cn.id, 1, Dc, 'reg', 'd_act[' + cn.lower + '] tanh derivative'));
    });

    var ti = 0;
    function tmp(label) { return add(T('t' + (ti++), 1, 1, 'temp', label)); }
    function tmpOf(r, c, label) { return add(T('t' + (ti++), r, c, 'temp', label)); }

    conns.forEach(function (cn) {
      var c = cn.lower, Dc = D[c], Du = D[cn.upper];
      var M_l = byName('M' + cn.lower), M_u = byName('M' + cn.upper);
      var Tt = byName('T' + cn.id), B = byName('B' + cn.id);
      var P = byName('P' + cn.id), S = byName('S' + cn.id);
      var E = byName('E' + cn.id), Dp = byName('Dp' + cn.id);
      var tag = 'c' + c;

      /* ---------------- phase 0 : predict / error / update M_up / diffuse ---- */
      if (spec.fusion === 'compound') {
        // Y = M_up @ T   (K, Dc)
        var Y = tmpOf(K, Dc, 'Y: prediction');
        emit(0, 'MATMUL_NN', { conn: c, tpl: 'PREDICT', dst: Y, s0: M_u, s1: Tt, mm: [K, Dc, Du] });
        // in place: row0 = tanh(row0+B) ; rows1: *= 1-row0^2    -- the 12-op fan-out of build_schedule_0, fused
        emit(0, 'PREDICT_ACT', { conn: c, tpl: 'PREDICT', dst: Y, s0: Y, s1: B, r: K, c: Dc });
        emit(0, 'ONE_MINUS_SQ', { conn: c, tpl: 'PREDICT', dst: Dp, s0: Y, r: 1, c: Dc });
        // E = M_l - Y   (E is a real buffer: phase 1 reads it back)
        emit(0, 'SUB', { conn: c, tpl: 'ERROR', dst: E, s0: M_l, s1: Y, r: K, c: Dc });
      } else {
        // ---- 'local' : only opcodes your executor already implements ----------
        var X = tmpOf(K, Dc, 'X: prediction');
        emit(0, 'MATMUL_NN', { conn: c, tpl: 'PREDICT', dst: X, s0: M_u, s1: Tt, mm: [K, Dc, Du] });
        var H = tmpOf(1, Dc, 'h: row0 activation');
        emit(0, 'EXTRACT_ROW', { conn: c, tpl: 'PREDICT', dst: H, s0: X, scalar: 0, r: 1, c: Dc });
        emit(0, 'ADD', { conn: c, tpl: 'PREDICT', dst: H, s0: H, s1: B, r: 1, c: Dc });
        emit(0, 'TANH', { conn: c, tpl: 'PREDICT', dst: H, s0: H, r: 1, c: Dc });
        emit(0, 'ONE_MINUS_SQ', { conn: c, tpl: 'PREDICT', dst: Dp, s0: H, r: 1, c: Dc });
        var R = tmpOf(K - 1, Dc, 'rest: rows 1..K-1');
        emit(0, 'EXTRACT_ROWS_EXCEPT', { conn: c, tpl: 'PREDICT', dst: R, s0: X, scalar: 0, r: K - 1, c: Dc });
        var R2 = tmpOf(K - 1, Dc, 'rest * d_act');
        emit(0, 'MUL_BC', { conn: c, tpl: 'PREDICT', dst: R2, s0: R, s1: Dp, r: K - 1, c: Dc });
        emit(0, 'CONCAT_ROWS', { conn: c, tpl: 'PREDICT', dst: X, s0: H, s1: R2, r: K, c: Dc, r1: 1, r2: K - 1 });
        emit(0, 'SUB', { conn: c, tpl: 'ERROR', dst: E, s0: M_l, s1: X, r: K, c: Dc });
      }

      // gated error direction:  G = E * P * lr
      var G = tmpOf(K, Dc, 'G: gated error');
      if (spec.fusion === 'compound') {
        emit(0, 'MUL', { conn: c, tpl: 'UPD_M', dst: G, s0: E, s1: P, r: K, c: Dc, scalar: spec.lrM * spec.lrE });
      } else {
        emit(0, 'MUL', { conn: c, tpl: 'UPD_M', dst: G, s0: E, s1: P, r: K, c: Dc });
        emit(0, 'SCALE', { conn: c, tpl: 'UPD_M', dst: G, s0: G, r: K, c: Dc, scalar: spec.lrM * spec.lrE });
      }
      var G2 = tmpOf(K, Dc, 'G * d_act');
      emit(0, 'MUL_BC', { conn: c, tpl: 'UPD_M', dst: G2, s0: G, s1: Dp, r: K, c: Dc });

      if (spec.learnM0) {
        // exactly the line commented out in build_schedule_0: M[0] = M[0] - TMP0
        emit(0, 'SUB', { conn: c, tpl: 'LEARN_LOWER', dst: M_l, s0: M_l, s1: G, r: K, c: Dc });
      }

      // M_up (+)= G2 @ T^T
      if (spec.fusion === 'compound' && spec.acc !== false) {
        emit(0, 'MATMUL_NT', { conn: c, tpl: 'UPD_M', dst: M_u, s0: G2, s1: Tt, mm: [K, Du, Dc], acc: true });
      } else {
        var W = tmpOf(K, Du, 'dM_up');
        emit(0, 'MATMUL_NT', { conn: c, tpl: 'UPD_M', dst: W, s0: G2, s1: Tt, mm: [K, Du, Dc] });
        emit(0, 'ADD', { conn: c, tpl: 'UPD_M', dst: M_u, s0: M_u, s1: W, r: K, c: Du });
      }

      // diffuse: M_l += dt * shift(M_l) ; clamp   ('bottom' = only stage 0, as your build_schedule_0 does)
      if (spec.diffuse !== 'bottom' || c === 0) {
      if (spec.fusion === 'compound') {
        // one fused in-place pass: 3 ops (SHIFT/SCALE/ADD) -> 1
        emit(0, 'DIFFUSE', { conn: c, tpl: 'DIFFUSE', dst: M_l, s0: M_l, r: K, c: Dc, scalar: spec.dt });
      } else {
        var Z = tmpOf(K, Dc, 'shifted state');
        emit(0, 'SHIFT', { conn: c, tpl: 'DIFFUSE', dst: Z, s0: M_l, r: K, c: Dc });
        emit(0, 'SCALE', { conn: c, tpl: 'DIFFUSE', dst: Z, s0: Z, r: K, c: Dc, scalar: spec.dt });
        emit(0, 'ADD', { conn: c, tpl: 'DIFFUSE', dst: M_l, s0: M_l, s1: Z, r: K, c: Dc });
      }
      emit(0, 'CLAMP', { conn: c, tpl: 'DIFFUSE', dst: M_l, s0: M_l, r: K, c: Dc, scalar: spec.clampC });
      }

      if (spec.gate) {
        emit(1, 'P_UPDATE', { conn: c, tpl: 'GATE', dst: P, s0: S, s1: E, r: K, c: Dc });
      }
      if (spec.norm) {
        emit(1, 'NORM_STEP', { conn: c, tpl: 'NORM', dst: P, s0: P, r: K, c: Dc, scalar: 0.5 });
      }

      /* ---------------- phase 1 : the slow updates (T, B) -------------------- */
      var Gs = tmpOf(K, Dc, 'G: gated error (slow)');
      if (spec.fusion === 'compound') {
        emit(1, 'MUL', { conn: c, tpl: 'UPD_T', dst: Gs, s0: E, s1: P, r: K, c: Dc, scalar: spec.lrTB * spec.lrE });
      } else {
        emit(1, 'MUL', { conn: c, tpl: 'UPD_T', dst: Gs, s0: E, s1: P, r: K, c: Dc });
        emit(1, 'SCALE', { conn: c, tpl: 'UPD_T', dst: Gs, s0: Gs, r: K, c: Dc, scalar: spec.lrTB * spec.lrE });
      }
      var Gs2 = tmpOf(K, Dc, 'G * d_act (slow)');
      emit(1, 'MUL_BC', { conn: c, tpl: 'UPD_T', dst: Gs2, s0: Gs, s1: Dp, r: K, c: Dc });
      if (spec.fusion === 'compound' && spec.acc !== false) {
        emit(1, 'MATMUL_TN', { conn: c, tpl: 'UPD_T', dst: Tt, s0: M_u, s1: Gs2, mm: [Du, Dc, K], acc: true });
        emit(1, 'SUM_ROWS', { conn: c, tpl: 'UPD_B', dst: B, s0: Gs2, r: K, c: Dc, acc: true });
      } else {
        var Wt = tmpOf(Du, Dc, 'dT');
        emit(1, 'MATMUL_TN', { conn: c, tpl: 'UPD_T', dst: Wt, s0: M_u, s1: Gs2, mm: [Du, Dc, K] });
        emit(1, 'ADD', { conn: c, tpl: 'UPD_T', dst: Tt, s0: Tt, s1: Wt, r: Du, c: Dc });
        var Wb = tmpOf(1, Dc, 'dB');
        emit(1, 'SUM_ROWS', { conn: c, tpl: 'UPD_B', dst: Wb, s0: Gs2, r: K, c: Dc });
        emit(1, 'ADD', { conn: c, tpl: 'UPD_B', dst: B, s0: B, s1: Wb, r: 1, c: Dc });
      }
    });

    // drop temps/registers nothing touches, but keep every *state*: they are part of
    // the model (M[2] is dead in your schedule too, yet it is still allocated) and
    // their initial values consume the rng in a fixed order.
    var ops = ph[0].concat(ph[1]);
    var used = {};
    ops.forEach(function (o) { if (o.s0) used[o.s0] = 1; if (o.s1) used[o.s1] = 1; used[o.dst] = 1; });
    Object.keys(tensors).forEach(function (k) {
      if (!used[k] && tensors[k].kind !== 'state') delete tensors[k];
    });

    return { ops: ops, tensors: tensors };
  }

  /* ------------------------------------------------------- liveness + plan */
  function plan(ops, tensors, opts) {
    opts = opts || {};
    var names = Object.keys(tensors);
    var first = {}, last = {};
    ops.forEach(function (o, i) {
      [o.s0, o.s1, o.dst].forEach(function (n) {
        if (!n) return;
        if (first[n] == null) first[n] = i;
        last[n] = i;
      });
    });

    var states = names.filter(function (n) { return tensors[n].kind === 'state'; });
    var regs = names.filter(function (n) { return tensors[n].kind === 'reg'; });
    var temps = names.filter(function (n) { return tensors[n].kind === 'temp'; });

    // persistent region: one arena, states and long-lived registers packed by size
    var offOf = {};
    var off = 0;
    var layout = [];
    function place(t) {
      off = alignUp(off);
      offOf[t.name] = off;
      layout.push({ name: t.name, offset: off, bytes: t.bytes, kind: t.kind, label: t.label });
      off += t.bytes;
    }
    states.slice().sort(function (a, b) { return tensors[b].bytes - tensors[a].bytes; })
      .forEach(function (n) { place(tensors[n]); });
    regs.forEach(function (n) { place(tensors[n]); });
    var persistentBytes = alignUp(off);

    // transient pool: interval colouring, first fit on the low-address side
    var live = [];
    var poolMax = 0, peakOps = null;
    function firstFit(size) {
      var occ = live.slice().sort(function (a, b) { return a.off - b.off; });
      var at = 0;
      for (var i = 0; i < occ.length; ++i) {
        if (at + size <= occ[i].off) break;
        at = Math.max(at, occ[i].off + occ[i].size);
      }
      return at;
    }
    var order = temps.slice().sort(function (a, b) { return (first[a] - first[b]) || (tensors[b].bytes - tensors[a].bytes); });
    var ev = [];
    order.forEach(function (n) {
      ev.push({ step: first[n], type: 'alloc', name: n });
      ev.push({ step: last[n], type: 'free', name: n });
    });
    // At equal step ALLOCATE before FREE: an op reads its operands and then writes its
    // destination, so a value whose last use is op i may NOT share a slot with a value
    // first defined at op i. (That was a real bug: MATMUL_NT wrote its (K,Du) result on
    // top of the G2 operand it was still reading -> corrupt schedule, bit-clean at step 11
    // and wrong by step 1100.)
    ev.sort(function (a, b) { return (a.step - b.step) || (a.type === 'free' ? 1 : -1); });
    var slots = {};
    ev.forEach(function (e) {
      if (e.type === 'free' && opts.reuse === false) { return; }
      if (e.type === 'alloc') {
        var t = tensors[e.name];
        var at = firstFit(t.bytes);
        slots[e.name] = at;
        layout.push({ name: e.name, offset: persistentBytes + at, bytes: t.bytes, kind: 'temp', label: t.label });
        live.push({ off: at, size: t.bytes, name: e.name });
        var cur = 0;
        live.forEach(function (b) { cur = Math.max(cur, b.off + b.size); });
        if (cur > poolMax) { poolMax = cur; peakOps = e.step; }
      } else {
        live = live.filter(function (b) { return b.name !== e.name; });
      }
    });
    poolMax = alignUp(poolMax);
    layout.push({ name: 'POOL', offset: persistentBytes, bytes: poolMax, kind: 'pool', label: 'transient pool' });

    var total = persistentBytes + poolMax;

    // resolve every op to (buffer id, byte offset) — the whole arena is buffer 0
    function ref(n) {
      if (!n) return null;
      return { id: 0, off: offOf[n] != null ? offOf[n] : persistentBytes + slots[n], name: n };
    }
    var resolved = ops.map(function (o, i) {
      var r = {
        i: i, code: o.code, phase: o.phase, conn: o.conn, tpl: o.tpl, scalar: o.scalar, acc: o.acc,
        src0: ref(o.s0), src1: ref(o.s1), dst: ref(o.dst),
        s0_off: 0, s0_R: 0, s0_C: 0, s1_off: 0, s1_R: 0, s1_C: 0, d_off: 0, d_R: 0, d_C: 0
      };
      var mm = OPINFO[o.code].kind === 'mm';
      if (mm) {
        var M = o.mmM, N = o.mmN, Kk = o.mmK;
        r.d_R = M; r.d_C = N;
        if (o.code === 'MATMUL_NN') { r.s0_R = M; r.s0_C = Kk; r.s1_R = Kk; r.s1_C = N; }
        if (o.code === 'MATMUL_NT') { r.s0_R = M; r.s0_C = Kk; r.s1_R = N; r.s1_C = Kk; }
        if (o.code === 'MATMUL_TN') { r.s0_R = Kk; r.s0_C = M; r.s1_R = Kk; r.s1_C = N; }
      } else {
        r.s0_R = o.r || 0; r.s0_C = o.c || 0;
        r.d_R = o.r || 0; r.d_C = o.c || 0;
        if (o.code === 'CONCAT_ROWS') { r.s0_R = o.r1 || 1; r.s1_R = o.r2 || 0; r.s0_C = o.c; }
        if (o.code === 'SUM_ROWS') { r.s0_R = o.r; r.s0_C = o.c; r.d_R = 1; r.d_C = o.c; }
        if (o.code === 'MUL_BC') { r.s1_R = 1; r.s1_C = o.c; }
        if (o.code === 'PREDICT_ACT') { r.s1_R = 1; r.s1_C = o.c; }
        if (o.code === 'EXTRACT_ROW') { r.s0_R = 1; r.d_R = 1; }
        if (o.code === 'EXTRACT_ROWS_EXCEPT') { r.s0_R = o.r + 1; r.d_R = o.r; }
      }
      return r;
    });

    return {
      buffers: [{ id: 0, name: 'ARENA', bytes: total, offset: 0, kind: 'arena', label: 'single arena' }],
      layout: layout, ops: resolved, persistentBytes: persistentBytes,
      poolBytes: poolMax, totalBytes: total, numBuf: 1,
      peakOpIndex: peakOps
    };
  }

  /* ----------------------------------------------------------------- metrics */
  function metrics(spec, ops, arena) {
    var phases = [0, 1];
    var per = {};
    phases.forEach(function (p) {
      var list = ops.filter(function (o) { return o.phase === p; });
      var flops = 0, bytes = 0, clears = 0, mm = 0;
      list.forEach(function (o) {
        if (OPINFO[o.code].kind === 'mm') {
          flops += 2 * o.mmM * o.mmN * o.mmK;
          mm++;
        }
      });
      per[p] = { ops: list.length, flops: flops, matmul: mm, clears: clears };
    });
    var byTpl = {};
    ops.forEach(function (o) {
      var k = o.tpl || o.code;
      byTpl[k] = (byTpl[k] || 0) + 1;
    });
    return {
      opsPhase0: per[0].ops, opsPhase1: per[1].ops, opsTotal: ops.length,
      flopsPhase0: per[0].flops, flopsPhase1: per[1].flops,
      matmuls: per[0].matmul + per[1].matmul,
      clears: ops.filter(function (o) { return o.code === 'CLEAR'; }).length,
      byTemplate: byTpl,
      updateEvery: spec.updateEvery,
      // per whole learning step (updateEvery x phase0 + 1 x phase1)
      stepOps: per[0].ops * spec.updateEvery + per[1].ops,
      stepFlops: per[0].flops * spec.updateEvery + per[1].flops,
      arenaBytes: arena.totalBytes,
      arenaPool: arena.poolBytes
    };
  }

  /* ------------------------------------------- the hand-written baseline (yours) */
  // 手写参考实现：每个状态一块缓冲区 + 12.58 MB 的临时区（基准线，用来算节省倍数）
  function manualBaseline(spec) {
    var K = 3, D = [1024, 64, 16];
    var cub = 0, cur;
    function al(x) { return (x + 63) & ~63; }
    // M
    cur = 0;
    for (var l = 0; l < 3; ++l) { cur = al(cur); cur += K * D[l] * 4; }
    var sz_M = al(cur);
    // F/E/P/S share sz_FE (offset pattern), 4 separate buffers of that size
    cur = 0;
    for (var c = 0; c < 2; ++c) { cur = al(cur); cur += K * D[c] * 4; }
    var sz_FE = al(cur);
    cur = 0;
    for (c = 0; c < 2; ++c) { cur = al(cur); cur += D[c + 1] * D[c] * 4; }
    var sz_T = al(cur);
    cur = 0;
    for (c = 0; c < 2; ++c) { cur = al(cur); cur += D[c] * 4; }
    var sz_B = al(cur);
    var sz_D = sz_B;
    var slot = D[0] * D[0] * 4;
    cur = 0;
    for (var i = 0; i < 3; ++i) { cur = al(cur); cur += slot; }
    var sz_TMP = al(cur);
    var total = sz_M + 4 * sz_FE + sz_T + sz_B + sz_D + sz_TMP;
    return {
      opsPhase0: 28, opsPhase1: 10, opsTotal: 38, clears: 13,
      flops: 0, arenaBytes: total, arenaTmp: sz_TMP, szFE: sz_FE, szT: sz_T,
      stepOps: 28 * 10 + 10,
      scheduleCoverage: 1, connections: 2,
      note: 'build_schedule_0/1 hand-written; only connection c=0 is wired, c=1 is allocated but never used'
    };
  }

  /* ------------------------------------------------------- semantic graph view */
  function buildGraph(spec, ops) {
    var nodes = [], edges = [];
    var K = spec.K, D = spec.D;
    var COL = 360, ROW = 86;
    var active = spec.connections.filter(function (c) { return c.on; });

    nodes.push({ id: 'stage0', type: 'header', x: 40, y: 24, w: 300, h: 46, title: 'stage 0  D=' + D[0], sub: 'width 1024' });
    for (var l = 0; l < D.length; ++l) {
      nodes.push({
        id: 'M' + l, type: 'state', x: 40 + l * COL, y: 120 + l * 120, w: 220, h: 64,
        title: 'M[' + l + ']', sub: K + ' x ' + D[l], kind: 'state'
      });
    }
    active.forEach(function (cn, i) {
      var c = cn.lower, x0 = 40 + c * COL + 250;
      var tpl0 = ops.filter(function (o) { return o.conn === c && o.phase === 0; });
      var tpl1 = ops.filter(function (o) { return o.conn === c && o.phase === 1; });
      var y = 120;
      nodes.push({ id: 'PREDICT' + c, type: 'op', x: x0, y: y, w: 210, h: 70, title: 'PREDICT', sub: 'M[u]@T -> tanh(row0) | rows*d', tpl: 'PREDICT', conn: c, ops: tpl0.filter(function (o) { return o.tpl === 'PREDICT'; }).length });
      nodes.push({ id: 'ERROR' + c, type: 'op', x: x0, y: y + 100, w: 210, h: 70, title: 'ERROR', sub: 'E = M[l] - F', tpl: 'ERROR', conn: c, ops: tpl0.filter(function (o) { return o.tpl === 'ERROR'; }).length });
      nodes.push({ id: 'UPD_M' + c, type: 'op', x: x0, y: y + 200, w: 210, h: 70, title: 'UPD_M', sub: 'M[u] += (E*P*lr*d)@T^T', tpl: 'UPD_M', conn: c, ops: tpl0.filter(function (o) { return o.tpl === 'UPD_M'; }).length });
      nodes.push({ id: 'DIFFUSE' + c, type: 'op', x: x0, y: y + 300, w: 210, h: 70, title: 'DIFFUSE', sub: 'M[l] += dt*shift(M[l])', tpl: 'DIFFUSE', conn: c, ops: tpl0.filter(function (o) { return o.tpl === 'DIFFUSE'; }).length });
      nodes.push({ id: 'UPD_T' + c, type: 'op', x: x0 + 250, y: y + 60, w: 210, h: 70, title: 'UPD_T', sub: 'T += M[u]^T@(E*P*lr*d)', tpl: 'UPD_T', conn: c, ops: tpl1.filter(function (o) { return o.tpl === 'UPD_T'; }).length });
      nodes.push({ id: 'UPD_B' + c, type: 'op', x: x0 + 250, y: y + 160, w: 210, h: 70, title: 'UPD_B', sub: 'B += sum_rows(E*P*lr*d)', tpl: 'UPD_B', conn: c, ops: tpl1.filter(function (o) { return o.tpl === 'UPD_B'; }).length });
      if (spec.gate) nodes.push({ id: 'GATE' + c, type: 'op', x: x0 + 250, y: y + 260, w: 210, h: 70, title: 'GATE', sub: 'S,P update (P_UPDATE)', tpl: 'GATE', conn: c, ops: 1 });
      // state nodes on the wire
      nodes.push({ id: 'T' + cn.id, type: 'tensor', x: x0 + 250, y: y + 340, w: 200, h: 54, title: 'T[' + c + ']', sub: D[cn.upper] + ' x ' + D[c] });
      nodes.push({ id: 'B' + cn.id, type: 'tensor', x: x0 - 60, y: y + 400, w: 200, h: 54, title: 'B[' + c + ']', sub: '1 x ' + D[c] });
      nodes.push({ id: 'P' + cn.id, type: 'tensor', x: x0 + 150, y: y + 400, w: 200, h: 54, title: 'P[' + c + ']', sub: K + ' x ' + D[c] });
      nodes.push({ id: 'E' + cn.id, type: 'tensor', x: x0 + 360, y: y + 400, w: 200, h: 54, title: 'E[' + c + ']', sub: K + ' x ' + D[c] });

      var push = function (a, b, kind) { edges.push({ from: a, to: b, kind: kind || 'data' }); };
      push('M' + cn.upper, 'PREDICT' + c);
      push('T' + cn.id, 'PREDICT' + c);
      push('B' + cn.id, 'PREDICT' + c);
      push('PREDICT' + c, 'ERROR' + c);
      push('M' + c, 'ERROR' + c);
      push('ERROR' + c, 'E' + cn.id);
      push('E' + cn.id, 'UPD_M' + c);
      push('P' + cn.id, 'UPD_M' + c);
      push('UPD_M' + c, 'M' + cn.upper);
      push('M' + c, 'DIFFUSE' + c);
      push('DIFFUSE' + c, 'M' + c, 'alias');
      push('E' + cn.id, 'UPD_T' + c);
      push('UPD_T' + c, 'T' + cn.id);
      push('E' + cn.id, 'UPD_B' + c);
      push('UPD_B' + c, 'B' + cn.id);
      push('PREDICT' + c, 'UPD_T' + c, 'phase');
    });
    return { nodes: nodes, edges: edges };
  }

  /* -------------------------------------------------------------------- main */
  function build(specIn) {
    var spec = normalize(specIn);
    var low = lower(spec);
    var arena = plan(low.ops, low.tensors, { reuse: spec.reuse !== false });
    var met = metrics(spec, low.ops, arena);
    var graph = buildGraph(spec, low.ops);
    return {
      spec: spec, ops: low.ops, tensors: low.tensors, arena: arena,
      metrics: met, graph: graph, baseline: manualBaseline(spec),
      phases: [
        { id: 0, name: 'fwd  (predict / error / update M_up / diffuse)', repeat: spec.updateEvery },
        { id: 1, name: 'slow (update T / B)', repeat: 1 }
      ]
    };
  }

  /* ------------------------------------------------------------- code emitters */
  // PREDICT_ACT / DIFFUSE 已经是 core/operation.hpp 里的正式成员（显式赋了 1000/1001），
  // 生成代码直接按名字引用即可。
  function cppOp(code) { return 'OpCode::' + code; }
  function fs(v) { var t = String(v); if (t.indexOf('.') < 0 && t.indexOf('e') < 0) t += '.0'; return t + 'f'; }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  function emitCpp(res, ns) {
    ns = ns || 'gen';
    var a = res.arena, ops = a.ops;
    var L = [];
    L.push('// ==== generated by schedgen.js ' + VERSION + ' — do not edit ==============');
    L.push('// fusion=' + res.spec.fusion + '  acc=' + (res.spec.acc !== false) + '  gate=' + res.spec.gate +
      '  learnM0=' + res.spec.learnM0 + '  diffuse=' + res.spec.diffuse);
    L.push('// 整条流水线被区间着色进了一块 arena，所有 op 共用缓冲区 BUF = 0。');
    L.push('#pragma once');
    L.push('#include <cstddef>');
    L.push('#include <cstdint>');
    L.push('#include <random>');
    L.push('#include <vector>');
    L.push('');
    L.push('#include "core/operation.hpp"');
    L.push('#include "core/stateArena.hpp"');
    L.push('');
    L.push('namespace ' + ns + ' {');
    L.push('using pc::core::Op;');
    L.push('using pc::core::OpCode;');
    L.push('using pc::core::StateArena;');
    L.push('using pc::core::usize;');
    L.push('');
    L.push('static const uint32_t NUM_BUF = 1u;   // the whole schedule lives in one arena');
    L.push('static const uint32_t BUF = 0u;');
    L.push('static const size_t TOTAL_BYTES = ' + a.totalBytes + 'u;');
    L.push('static const size_t ARENA_BYTES[1] = { ' + a.totalBytes + 'u };');
    L.push('');
    L.push('// arena layout: name, byte offset, size');
    a.layout.forEach(function (b) {
      L.push('//  ' + pad(b.kind, 6) + pad(b.name, 8) + pad(String(b.offset), 10) + pad(String(b.bytes), 10) + b.label);
    });
    L.push('enum : size_t {');
    L.push('    ' + a.layout.map(function (b) { return 'OFF_' + b.name + ' = ' + b.offset + 'u'; }).join(',\n    '));
    L.push('};');
    L.push('');
    function opLine(o, i) {
      return 's[' + i + '] = Op{' + [
        cppOp(o.code), (o.acc ? '1u' : '0u'), '0u', fs(o.scalar),
        'BUF', (o.src0 ? o.src0.off : 0) + 'u', o.s0_R + 'u', o.s0_C + 'u',
        'BUF', (o.src1 ? o.src1.off : 0) + 'u', o.s1_R + 'u', o.s1_C + 'u',
        'BUF', o.dst.off + 'u', o.d_R + 'u', o.d_C + 'u'
      ].join(', ') + '};  // ' + pad(o.code, 15) + o.tpl;
    }
    [0, 1].forEach(function (p) {
      var list = ops.filter(function (o) { return o.phase === p; });
      L.push('inline void build_' + (p === 0 ? 'fwd' : 'slow') + '(std::vector<Op>& s) {');
      L.push('    s.resize(' + list.length + 'u);');
      list.forEach(function (o, i) { L.push('    ' + opLine(o, i)); });
      L.push('}');
      L.push('');
    });
    L.push('} // namespace ' + ns);
    return L.join('\n');
  }

  function emitCppInit(res, ns) {
    // 初始化顺序固定（M/T ~ U(-0.1,0.1)、B = 0.05、P = 1、S = 0.5、其余清零），
    // 这样同一份 spec 每次生成的初始状态都一样，便于对拍。
    ns = ns || 'gen';
    var a = res.arena;
    var byName = {};
    a.layout.forEach(function (b) { byName[b.name] = b; });
    var L = [];
    L.push('inline void init_values(StateArena& arena) {');
    L.push('    (void)arena;');
    L.push('    std::mt19937 rng(42);');
    L.push('    std::uniform_real_distribution<float> u(-0.1f, 0.1f);');
    function fill(bufName, n, expr) {
      var b = byName[bufName];
      if (!b) return;
      L.push('    { float* p = arena.ptr(BUF, OFF_' + bufName + '); for (size_t i = 0; i < ' + n + 'u; ++i) p[i] = ' + expr + '; }');
    }
    res.spec.D.forEach(function (d, l) { fill('M' + l, res.spec.K * d, 'u(rng)'); });
    res.spec.connections.filter(function (c) { return c.on; }).forEach(function (cn) {
      var Dc = res.spec.D[cn.lower], Du = res.spec.D[cn.upper];
      fill('T' + cn.id, Du * Dc, 'u(rng)');
      fill('B' + cn.id, Dc, '0.05f');
      fill('P' + cn.id, res.spec.K * Dc, '1.0f');
      fill('S' + cn.id, res.spec.K * Dc, '0.5f');
      fill('Dp' + cn.id, Dc, '1.0f');
      fill('E' + cn.id, res.spec.K * Dc, '0.0f');
    });
    L.push('}');
    return L.join('\n');
  }

  return {
    version: '1.0',
    ALIGN: ALIGN, OPINFO: OPINFO, FLAG_ACC: FLAG_ACC, VERSION: VERSION,
    normalize: normalize, build: build, lower: lower, plan: plan, buildGraph: buildGraph,
    manualBaseline: manualBaseline, emitCpp: emitCpp, emitCppInit: emitCppInit
  };
});
