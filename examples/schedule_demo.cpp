// examples/schedule_demo.cpp —— 在 core/ 上跑一份生成器产出的 schedule
//
// 这条 schedule 由 tools/schedgen.js 生成（fusion=compound），区间着色把整条流水线
// 压进了一块 337 KB 的 arena：9 个前向 op + 4 个慢更新 op，每 10 步做一次慢更新。
//
// 演示的是"算子层"的完整闭环：
//   StateArena 分配 → Cfg::init 初始化 → build_fwd/build_slow 取 Op[] → Executor 执行
//
//   cmake -S . -B build && cmake --build build && ./build/schedule_demo

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

#include "core/core.hpp"
#include "gen/sched_comp1.hpp"

namespace {

constexpr int kOuter = 100;   // 100 轮
constexpr int kInner = 10;    // 每轮 10 次前向 + 1 次慢更新

// ‖x‖²，只用来做个可读的体检
float sum_sq(const float* p, std::size_t n) {
    float s = 0.f;
    for (std::size_t i = 0; i < n; ++i) s += p[i] * p[i];
    return s;
}

// 跑 kOuter 轮，每轮 kInner 次前向 + 1 次慢更新
void run_rounds(pc::core::Executor& ex, const std::vector<pc::core::Op>& fwd,
                const std::vector<pc::core::Op>& slow, pc::core::StateArena& arena) {
    for (int i = 0; i < kOuter; ++i) {
        for (int j = 0; j < kInner; ++j) ex.run(fwd, arena);
        ex.run(slow, arena);
    }
}

}  // namespace

int main() {
    using pc::core::Op;
    using pc::core::StateArena;
    using pc::core::usize;

    // 1) 按生成器给的布局分配 arena（NUM_BUF 个缓冲区，这里只有 1 块）
    StateArena arena;
    std::vector<usize> sizes(gen_comp1::NUM_BUF);
    for (std::uint32_t i = 0; i < gen_comp1::NUM_BUF; ++i) sizes[i] = gen_comp1::ARENA_BYTES[i];
    arena.allocate(sizes);

    // 2) 两个相位的 Op[]
    std::vector<Op> fwd, slow;
    gen_comp1::Cfg::fwd(fwd);
    gen_comp1::Cfg::slow(slow);

    pc::core::Executor ex;
    const int steps = kOuter * kInner;

    // 3) 计时：每次都从同一初始状态出发，取 5 次里最快的一次
    double ms = 1e9;
    for (int rep = 0; rep < 5; ++rep) {
        gen_comp1::Cfg::init(arena);
        const auto t0 = std::chrono::steady_clock::now();
        run_rounds(ex, fwd, slow, arena);
        const auto t1 = std::chrono::steady_clock::now();
        ms = std::min(ms, std::chrono::duration<double, std::milli>(t1 - t0).count());
    }

    // 4) 再跑一遍用于体检（同样从初始状态出发，数字可复现）
    gen_comp1::Cfg::init(arena);
    run_rounds(ex, fwd, slow, arena);

    const float* m0 = arena.ptr(gen_comp1::BUF, gen_comp1::OFF_M0);
    const float* t0v = arena.ptr(gen_comp1::BUF, gen_comp1::OFF_Tc0);
    const float* b0 = arena.ptr(gen_comp1::BUF, gen_comp1::OFF_Bc0);
    const float s_m0 = sum_sq(m0, 3 * 1024);
    const float s_t0 = sum_sq(t0v, 64 * 1024);
    const float s_b0 = sum_sq(b0, 1024);

    std::printf("schedule : gen_comp1 (fusion=compound, 10 fwd + 1 slow)\n");
    std::printf("ops      : %zu + %zu = %zu / 轮, %d 步\n", fwd.size(), slow.size(),
                fwd.size() + slow.size(), steps);
    std::printf("arena    : %zu B (%zu 块缓冲区, %.1f KB)\n", arena.total_bytes(), arena.num_buffers(),
                double(arena.total_bytes()) / 1024.0);
    std::printf("time     : %.2f ms, %.2f us/step (best of 5)\n", ms, ms * 1000.0 / steps);
    std::printf("state    : |M0|^2=%.4f |T0|^2=%.2f |B0|^2=%.4f\n", s_m0, s_t0, s_b0);

    const bool ok = std::isfinite(s_m0) && std::isfinite(s_t0) && std::isfinite(s_b0) &&
                    s_m0 > 0.f && s_t0 > 0.f;
    std::printf("check    : %s\n", ok ? "有限且非零 OK" : "数值异常");
    return ok ? 0 : 1;
}
