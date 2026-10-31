// 基本模型（两层，带偏置）：用 pc-studio 导出的 gen/model.hpp 跑训练。
// 编译：见 build.sh / README
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>

#include "engine/pc.hpp"
#include "gen/model.hpp"

using namespace pc;

// 与界面完全一致的数据流：3 个随机频率的正弦叠加，归一化到 [-1,1]
struct Stream {
    std::mt19937 rng;
    int N;
    std::vector<float> v;
    explicit Stream(int n, uint32_t seed = 11) : rng(seed), N(n), v(size_t(n)) {}
    float u(float lo, float hi) {
        return lo + (hi - lo) * float(double(rng()) / 4294967296.0);
    }
    void next() {
        std::fill(v.begin(), v.end(), 0.f);
        for (int f = 0; f < 3; ++f) {
            const float a = u(-1, 1), b = u(-1, 1);
            const int q = 1 + int(u(0, 3));
            for (int i = 0; i < N; ++i) {
                const double t = 2.0 * 3.14159265358979323846 * double(i) / double(N);
                v[size_t(i)] += a * float(std::sin(q * t)) + b * float(std::cos((q + 1) * t));
            }
        }
        float m = 0.f;
        for (float x : v) m = std::max(m, std::abs(x));
        for (float& x : v) x /= (m > 0.f ? m : 1.f);
    }
};

static float sumsq(const Program& pr, Tens t) {
    const float* p = const_cast<Program&>(pr).ptr(t);
    float s = 0.f;
    for (i32 i = 0; i < t.s.n(); ++i) s += p[i] * p[i];
    return s;
}

int main(int argc, char** argv) {
    const int steps = argc > 1 ? std::atoi(argv[1]) : 600;
    const int every = argc > 2 ? std::atoi(argv[2]) : 100;

    gen_model::Model m;
    gen_model::build(m);
    gen_model::init(m, 42);
    Program& pr = m.pr;

    Stream st(gen_model::D[0]);
    const int nInfer = 20;

    std::printf("# ops=%zu arena=%zu B (state %zu + temp %zu)\n", pr.num_ops(), pr.bytes(),
                pr.state_bytes(), pr.temp_bytes());
    std::printf("# step  F          E0         E1\n");

    float* x = pr.ptr(m.t0);
    for (int it = 0; it < steps; ++it) {
        if (it % nInfer == 0) {
            st.next();
            for (int i = 0; i < gen_model::D[0]; ++i) x[i] = st.v[size_t(i)];
        }
        pr.run((it % nInfer) == nInfer - 1 ? PH_LEARN : PH_INFER);
        if (it % every == 0 || it == steps - 1) {
            const float e0 = sumsq(pr, m.t7), e1 = sumsq(pr, m.t9);
            std::printf("%6d  %.6g  %.6g  %.6g\n", it, double(e0 + e1), double(e0), double(e1));
        }
    }
    return 0;
}
