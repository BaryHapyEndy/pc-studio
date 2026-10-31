// engine/pc.hpp —— pc-engine 引擎核心（v2，单头文件）
//
// 相对 v1 的三处改动：
//   1. Op 直接持有张量句柄 + 形状，不再有 src0/s0_off/... 的"id + 字节偏移"手工算术；
//      偏移只出现在 plan()，由区间着色自动算出。
//   2. 每个 op 在 append 时做形状检查（matmul 的 M/K/N、逐元素同形），
//      形状错误在构图时就炸，而不是跑完上千步之后。
//   3. 相位（phase）显式化：predict → infer → learn 三段顺序固定，
//      取代"两条 schedule + 手数 cur 累加偏移"。
//
// 语义与 v1 一致：行主序、float32、matmul 可走 cblas_sgemm、逐元素算子允许原地。

#pragma once
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#ifdef PC_USE_BLAS
#include <cblas.h>
#endif

namespace pc {

using i32 = std::int32_t;
using u32 = std::uint32_t;
using usize = std::size_t;

inline usize align_up(usize v, usize a) { return (v + a - 1) / a * a; }

struct Shape {
    i32 r = 0, c = 0;
    i32 n() const { return r * c; }
    usize bytes() const { return usize(n()) * sizeof(float); }
    bool operator==(const Shape& o) const { return r == o.r && c == o.c; }
    bool operator!=(const Shape& o) const { return !(*this == o); }
};
inline Shape sh(i32 r, i32 c) { return Shape{r, c}; }

enum class K : std::uint16_t {
    Clear, Copy, Add, Sub, Mul, Scale,
    Tanh, OneMinusSq, Clamp,
    Matmul, MatmulTA, MatmulTB,
    SumRows, AddScaled,
};

// 执行相位：同一步内先算预测/误差，再更新状态，最后更新权重。
enum : int { PH_PREDICT = 0, PH_INFER = 1, PH_LEARN = 2 };
enum : std::uint8_t { F_ACC = 1 };

inline const char* kname(K k) {
    switch (k) {
        case K::Clear: return "CLEAR";
        case K::Copy: return "COPY";
        case K::Add: return "ADD";
        case K::Sub: return "SUB";
        case K::Mul: return "MUL";
        case K::Scale: return "SCALE";
        case K::Tanh: return "TANH";
        case K::OneMinusSq: return "ONE_MINUS_SQ";
        case K::Clamp: return "CLAMP";
        case K::Matmul: return "MATMUL_NN";
        case K::MatmulTA: return "MATMUL_TN";
        case K::MatmulTB: return "MATMUL_NT";
        case K::SumRows: return "SUM_ROWS";
        case K::AddScaled: return "AXPY";
    }
    return "?";
}

struct Tens {
    i32 id = -1;
    Shape s;
};

struct Op {
    K k = K::Copy;
    Tens a, b, d;
    float scalar = 0.f;
    std::uint8_t flags = 0;
    int phase = PH_PREDICT;
};

// ───────────────────────────── 内核 ─────────────────────────────

namespace kern {

inline void clear(float* d, i32 n) { std::memset(d, 0, usize(n) * sizeof(float)); }
inline void copy_(float* d, const float* a, i32 n) { std::memcpy(d, a, usize(n) * sizeof(float)); }

inline void add(float* d, const float* a, const float* b, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] = a[i] + b[i];
}
inline void sub(float* d, const float* a, const float* b, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] = a[i] - b[i];
}
inline void mul(float* d, const float* a, const float* b, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] = a[i] * b[i];
}
inline void scale(float* d, const float* a, float s, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] = a[i] * s;
}
inline void tanh_(float* d, const float* a, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] = std::tanh(a[i]);
}
inline void one_minus_sq(float* d, const float* a, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] = 1.f - a[i] * a[i];
}
inline void clamp(float* d, const float* a, float c, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] = a[i] > c ? c : (a[i] < -c ? -c : a[i]);
}
inline void axpy(float* d, const float* a, float s, i32 n) {
    for (i32 i = 0; i < n; ++i) d[i] += s * a[i];
}
inline void sum_rows(float* d, const float* a, i32 r, i32 c, bool acc) {
    if (!acc) std::memset(d, 0, usize(c) * sizeof(float));
    for (i32 i = 0; i < r; ++i)
        for (i32 j = 0; j < c; ++j) d[j] += a[usize(i) * usize(c) + usize(j)];
}

// d = a·b，行主序；transA/transB 表示对应操作数"转置后参与"
inline void mm(float* d, const float* a, const float* b, i32 M, i32 N, i32 Kk,
               bool transA, bool transB, bool acc) {
#ifdef PC_USE_BLAS
    cblas_sgemm(CblasRowMajor, transA ? CblasTrans : CblasNoTrans,
                transB ? CblasTrans : CblasNoTrans, M, N, Kk, 1.f, a,
                transA ? M : Kk, b, transB ? Kk : N, acc ? 1.f : 0.f, d, N);
#else
    if (!acc)
        for (i32 i = 0; i < M * N; ++i) d[i] = 0.f;
    for (i32 m = 0; m < M; ++m)
        for (i32 k = 0; k < Kk; ++k) {
            const float av = transA ? a[usize(k) * usize(M) + usize(m)] : a[usize(m) * usize(Kk) + usize(k)];
            for (i32 n = 0; n < N; ++n) {
                const float bv = transB ? b[usize(n) * usize(Kk) + usize(k)] : b[usize(k) * usize(N) + usize(n)];
                d[usize(m) * usize(N) + usize(n)] += av * bv;
            }
        }
#endif
}

}  // namespace kern

// ───────────────────────────── Program ─────────────────────────────

class Program {
public:
    struct Entry {
        std::string name;
        Shape s;
        usize off = 0;
        bool is_state = false;
        i32 first = -1, last = -1;
    };

    // ── 构图 ───────────────────────────────────────────────
    Tens state(const std::string& name, Shape s) {
        Tens t;
        t.id = i32(layout_.size());
        t.s = s;
        layout_.push_back(Entry{name, s, 0, true, -1, -1});
        states_.push_back(t);
        return t;
    }
    Tens temp(const std::string& name, Shape s) {
        Tens t;
        t.id = i32(layout_.size());
        t.s = s;
        layout_.push_back(Entry{name, s, 0, false, -1, -1});
        temps_.push_back(t);
        return t;
    }

    void clear(Tens d, int ph = PH_PREDICT) { ops_.push_back(Op{K::Clear, {}, {}, d, 0.f, 0, ph}); }
    void copy(Tens a, Tens d, int ph = PH_PREDICT) {
        assert(a.s == d.s && "copy: shape mismatch");
        ops_.push_back(Op{K::Copy, a, {}, d, 0.f, 0, ph});
    }
    void add(Tens a, Tens b, Tens d, int ph = PH_PREDICT) { binary(K::Add, a, b, d, 0.f, ph); }
    void sub(Tens a, Tens b, Tens d, int ph = PH_PREDICT) { binary(K::Sub, a, b, d, 0.f, ph); }
    void mul(Tens a, Tens b, Tens d, int ph = PH_PREDICT) { binary(K::Mul, a, b, d, 0.f, ph); }
    void mulc(float s, Tens a, Tens d, int ph = PH_PREDICT) { unary(K::Scale, a, d, s, ph); }
    void tanh(Tens a, Tens d, int ph = PH_PREDICT) { unary(K::Tanh, a, d, 0.f, ph); }
    void one_minus_sq(Tens a, Tens d, int ph = PH_PREDICT) { unary(K::OneMinusSq, a, d, 0.f, ph); }
    void clamp(Tens a, Tens d, float c, int ph = PH_PREDICT) { unary(K::Clamp, a, d, c, ph); }
    void axpy(float s, Tens a, Tens d, int ph = PH_PREDICT) { unary(K::AddScaled, a, d, s, ph); }
    void sum_rows(Tens a, Tens d, bool acc = false, int ph = PH_LEARN) {
        assert(d.s.r == 1 && d.s.c == a.s.c && "sum_rows: dst must be 1×C");
        ops_.push_back(Op{K::SumRows, a, {}, d, 0.f, acc ? std::uint8_t(F_ACC) : std::uint8_t(0), ph});
    }

    // d = a·b (a: M×K, b: K×N)
    void mm(Tens a, Tens b, Tens d, bool acc = false, int ph = PH_PREDICT) {
        assert(b.s.r == a.s.c && "mm: inner dims must agree");
        assert(d.s.r == a.s.r && d.s.c == b.s.c && "mm: dst must be M×N");
        ops_.push_back(Op{K::Matmul, a, b, d, 0.f, acc ? std::uint8_t(F_ACC) : std::uint8_t(0), ph});
    }
    // d = aᵀ·b (a: K×M, b: K×N)
    void mmta(Tens a, Tens b, Tens d, bool acc = false, int ph = PH_PREDICT) {
        assert(b.s.r == a.s.r && "mmta: inner dims must agree");
        assert(d.s.r == a.s.c && d.s.c == b.s.c && "mmta: dst must be M×N");
        ops_.push_back(Op{K::MatmulTA, a, b, d, 0.f, acc ? std::uint8_t(F_ACC) : std::uint8_t(0), ph});
    }
    // d = a·bᵀ (a: M×K, b: N×K)
    void mmtb(Tens a, Tens b, Tens d, bool acc = false, int ph = PH_PREDICT) {
        assert(b.s.c == a.s.c && "mmtb: inner dims must agree");
        assert(d.s.r == a.s.r && d.s.c == b.s.r && "mmtb: dst must be M×N");
        ops_.push_back(Op{K::MatmulTB, a, b, d, 0.f, acc ? std::uint8_t(F_ACC) : std::uint8_t(0), ph});
    }

    // ── 规划 + 执行 ────────────────────────────────────────
    void plan(usize align = 64, bool reuse = true);
    // 只跑到某个相位为止：run(PH_INFER) = 预测 + 推理，run(PH_LEARN) = 完整一步
    void run(int max_phase = PH_LEARN);
    void reset_states();

    bool planned() const { return planned_; }
    usize bytes() const { return total_; }
    usize state_bytes() const { return state_bytes_; }
    usize temp_bytes() const { return temp_bytes_; }
    usize num_ops() const { return ops_.size(); }
    const std::vector<Op>& ops() const { return ops_; }
    const std::vector<Entry>& layout() const { return layout_; }

    float* ptr(Tens t) {
        assert(t.id >= 0 && planned_);
        return base_ + layout_[usize(t.id)].off / sizeof(float);
    }
    const char* name(Tens t) const { return layout_[usize(t.id)].name.c_str(); }

    // ── 初始化：跨语言可复现的 RNG（mt19937 + 固定映射） ──
    void seed(u32 s) { rng_.seed(s); }
    u32 next_u32() { return rng_(); }
    float next_uniform(float lo, float hi) {
        const double u = static_cast<double>(rng_()) / 4294967296.0;
        return static_cast<float>(lo + double(hi - lo) * u);
    }
    void fill_uniform(Tens t, float lo, float hi) {
        float* p = ptr(t);
        for (i32 i = 0; i < t.s.n(); ++i) p[i] = next_uniform(lo, hi);
    }
    void fill(Tens t, float v) {
        float* p = ptr(t);
        for (i32 i = 0; i < t.s.n(); ++i) p[i] = v;
    }

    // 从某个张量读出（给示例/导出 JSON 用）
    std::vector<float> read(Tens t) {
        const float* p = ptr(t);
        return std::vector<float>(p, p + t.s.n());
    }

private:
    void binary(K k, Tens a, Tens b, Tens d, float s, int ph) {
        assert(a.s == b.s && "binary: a/b shape mismatch");
        assert(a.s == d.s && "binary: dst shape mismatch");
        ops_.push_back(Op{k, a, b, d, s, 0, ph});
    }
    void unary(K k, Tens a, Tens d, float s, int ph) {
        assert(a.s == d.s && "unary: shape mismatch");
        ops_.push_back(Op{k, a, {}, d, s, 0, ph});
    }
    void exec(const Op& o);

    std::vector<Entry> layout_;
    std::vector<Tens> states_, temps_;
    std::vector<Op> ops_;
    std::vector<float> arena_;
    float* base_ = nullptr;
    usize total_ = 0, state_bytes_ = 0, temp_bytes_ = 0;
    bool planned_ = false;
    std::mt19937 rng_{42};
};

inline void Program::plan(usize align, bool reuse) {
    // 1) 相位稳定排序：predict / infer / learn 三段内部保持构图顺序
    std::stable_sort(ops_.begin(), ops_.end(),
                     [](const Op& x, const Op& y) { return x.phase < y.phase; });

    // 2) 生命周期：首次出现 → 最后一次被读
    auto touch = [&](Tens t, int i) {
        if (t.id < 0) return;
        Entry& e = layout_[usize(t.id)];
        if (e.first < 0) e.first = i;
        e.last = i;
    };
    for (int i = 0; i < int(ops_.size()); ++i) {
        touch(ops_[usize(i)].a, i);
        touch(ops_[usize(i)].b, i);
        touch(ops_[usize(i)].d, i);
    }

    // 3) 状态先排，偏移稳定可读
    usize cur = 0;
    for (const Tens& t : states_) {
        layout_[usize(t.id)].off = cur;
        cur += align_up(t.s.bytes(), align);
    }
    state_bytes_ = cur;

    // 4) 临时区：区间着色（首次适配 + 滑动释放，起点顺序扫描）
    struct Iv {
        i32 id, beg, end;
        usize bytes;
        usize off2 = 0;
    };
    std::vector<Iv> iv;
    for (const Tens& t : temps_)
        if (layout_[usize(t.id)].first >= 0)
            iv.push_back(Iv{t.id, layout_[usize(t.id)].first, layout_[usize(t.id)].last,
                            align_up(t.s.bytes(), align)});
    std::sort(iv.begin(), iv.end(), [](const Iv& x, const Iv& y) {
        return x.beg != y.beg ? x.beg < y.beg : x.id < y.id;
    });

    usize top = 0;
    if (reuse) {
        std::vector<Iv> active;
        std::vector<std::pair<usize, usize>> free_;  // (off, bytes)，按 off 升序
        for (const Iv& v : iv) {
            active.erase(std::remove_if(active.begin(), active.end(),
                                        [&](const Iv& a) { return a.end < v.beg; }),
                         active.end());
            // 重建空闲块（区间数很少，直接重算，避免复杂的合并逻辑）
            free_.clear();
            usize cur_off = 0;
            std::vector<Iv> act = active;
            std::sort(act.begin(), act.end(), [](const Iv& x, const Iv& y) { return x.off2 < y.off2; });
            for (const Iv& a : act) {
                if (a.off2 > cur_off) free_.push_back({cur_off, a.off2 - cur_off});
                cur_off = std::max(cur_off, a.off2 + a.bytes);
            }
            if (top > cur_off) free_.push_back({cur_off, top - cur_off});

            usize chosen = usize(-1);
            for (const auto& f : free_)
                if (f.second >= v.bytes) { chosen = f.first; break; }
            if (chosen == usize(-1)) chosen = top;
            Iv placed = v;
            placed.off2 = chosen;
            active.push_back(placed);
            top = std::max(top, chosen + v.bytes);
            layout_[usize(v.id)].off = state_bytes_ + chosen;
        }
        temp_bytes_ = top;
    } else {
        usize off = 0;
        for (const Iv& v : iv) {
            layout_[usize(v.id)].off = state_bytes_ + off;
            off += v.bytes;
        }
        temp_bytes_ = off;
    }

    total_ = align_up(state_bytes_ + temp_bytes_, align);
    arena_.assign(total_ / sizeof(float) + 16, 0.f);
    base_ = arena_.data();
    planned_ = true;
}

inline void Program::run(int max_phase) {
    assert(planned_ && "call plan() first");
    for (const Op& o : ops_) {
        if (o.phase > max_phase) break;   // plan() 已按相位排好序
        exec(o);
    }
}

inline void Program::reset_states() {
    for (const Tens& t : states_) std::memset(ptr(t), 0, t.s.bytes());
}

inline void Program::exec(const Op& o) {
    float* d = ptr(o.d);
    const float* a = o.a.id >= 0 ? ptr(o.a) : nullptr;
    const float* b = o.b.id >= 0 ? ptr(o.b) : nullptr;
    switch (o.k) {
        case K::Clear: kern::clear(d, o.d.s.n()); break;
        case K::Copy: kern::copy_(d, a, o.d.s.n()); break;
        case K::Add: kern::add(d, a, b, o.d.s.n()); break;
        case K::Sub: kern::sub(d, a, b, o.d.s.n()); break;
        case K::Mul: kern::mul(d, a, b, o.d.s.n()); break;
        case K::Scale: kern::scale(d, a, o.scalar, o.d.s.n()); break;
        case K::Tanh: kern::tanh_(d, a, o.d.s.n()); break;
        case K::OneMinusSq: kern::one_minus_sq(d, a, o.d.s.n()); break;
        case K::Clamp: kern::clamp(d, a, o.scalar, o.d.s.n()); break;
        case K::AddScaled: kern::axpy(d, a, o.scalar, o.d.s.n()); break;
        case K::SumRows: kern::sum_rows(d, a, o.a.s.r, o.a.s.c, (o.flags & F_ACC) != 0); break;
        case K::Matmul:  kern::mm(d, a, b, o.a.s.r, o.b.s.c, o.a.s.c, false, false, (o.flags & F_ACC) != 0); break;
        case K::MatmulTA: kern::mm(d, a, b, o.a.s.c, o.b.s.c, o.a.s.r, true, false, (o.flags & F_ACC) != 0); break;
        case K::MatmulTB: kern::mm(d, a, b, o.a.s.r, o.b.s.r, o.a.s.c, false, true, (o.flags & F_ACC) != 0); break;
    }
}

}  // namespace pc
