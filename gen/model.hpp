// 由 pc-studio 导出 —— 10 个状态，21 个 op，arena 805120 B
// 与界面里的图一一对应；用法见 examples/pc_basic.cpp
#pragma once
#include <cstdint>
#include "engine/pc.hpp"

namespace gen_model {

struct Model {
    pc::Program pr;
    pc::Tens t0;   // x 1×64
    pc::Tens t1;   // M0 1×64
    pc::Tens t2;   // M1 1×1024
    pc::Tens t3;   // T1 1024×64
    pc::Tens t4;   // B1 1×64
    pc::Tens t5;   // P0 1×64
    pc::Tens t6;   // d0 1×64
    pc::Tens t7;   // E0 1×64
    pc::Tens t8;   // g0 1×64
    pc::Tens t9;   // E1 1×1024
};

inline void build(Model& m) {
    pc::Program& pr = m.pr;
    m.t0 = pr.state("x", pc::sh(1, 64));
    m.t1 = pr.state("M0", pc::sh(1, 64));
    m.t2 = pr.state("M1", pc::sh(1, 1024));
    m.t3 = pr.state("T1", pc::sh(1024, 64));
    m.t4 = pr.state("B1", pc::sh(1, 64));
    m.t5 = pr.state("P0", pc::sh(1, 64));
    m.t6 = pr.state("d0", pc::sh(1, 64));
    m.t7 = pr.state("E0", pc::sh(1, 64));
    m.t8 = pr.state("g0", pc::sh(1, 64));
    m.t9 = pr.state("E1", pc::sh(1, 1024));
    auto t10 = pr.temp("pre1", pc::sh(1, 64));
    auto t11 = pr.temp("f0", pc::sh(1, 64));
    auto t12 = pr.temp("mu_hat1", pc::sh(1, 1024));
    auto t13 = pr.temp("th_hat1", pc::sh(1024, 64));
    auto t14 = pr.temp("be_hat1", pc::sh(1, 64));
    auto t15 = pr.temp("dmu1", pc::sh(1, 1024));
    auto t16 = pr.temp("dT1", pc::sh(1024, 64));

    pr.mm(m.t2, m.t3, t10, false);
    pr.add(t10, m.t4, t11);
    pr.tanh(t11, t11);
    pr.mulc(0.02f, m.t2, m.t9);
    pr.one_minus_sq(m.t5, m.t6);
    pr.sub(m.t1, m.t5, m.t7);
    pr.mul(m.t7, m.t6, m.t8);
    pr.copy(m.t0, m.t1);
    pr.copy(t11, m.t5);
    pr.mmtb(m.t8, m.t3, t15, false, pc::PH_INFER);
    pr.sub(t15, m.t9, t15, pc::PH_INFER);
    pr.copy(m.t2, t12, pc::PH_INFER);
    pr.axpy(0.1f, t15, t12, pc::PH_INFER);
    pr.copy(t12, m.t2, pc::PH_INFER);
    pr.mmta(m.t2, m.t8, t16, false, pc::PH_LEARN);
    pr.copy(m.t3, t13, pc::PH_LEARN);
    pr.axpy(0.01f, t16, t13, pc::PH_LEARN);
    pr.copy(m.t4, t14, pc::PH_LEARN);
    pr.axpy(0.01f, m.t8, t14, pc::PH_LEARN);
    pr.copy(t13, m.t3, pc::PH_LEARN);
    pr.copy(t14, m.t4, pc::PH_LEARN);
    pr.plan(64, true);
}

// 初始化顺序与界面一致（同一个种子 ⇒ 同一组初值）
inline void init(Model& m, uint32_t seed = 42) {
    auto& pr = m.pr;
    pr.seed(seed);
    pr.fill(m.t0, 0.f);
    pr.fill_uniform(m.t1, -0.1f, 0.1f);
    pr.fill_uniform(m.t2, -0.1f, 0.1f);
    pr.fill_uniform(m.t3, -0.1f, 0.1f);
    pr.fill(m.t4, 0.05f);
    pr.fill(m.t5, 0.f);
    pr.fill(m.t6, 0.f);
    pr.fill(m.t7, 0.f);
    pr.fill(m.t8, 0.f);
    pr.fill(m.t9, 0.f);
}

// 每步：相位 0/1 全跑；每 20 步跑一次相位 2（学习）
inline void step(Model& m, int it) {
    m.pr.run(it % 20 == 19 ? pc::PH_LEARN : pc::PH_INFER);
}

}  // namespace