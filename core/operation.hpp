// core/operation.hpp —— 算子词汇表
//
// 这里是整台引擎的"语言"：一个 Op 只描述「把哪块内存的哪一片，按什么规则写回哪里」，
// 不含任何形状推断、内存规划或调度信息（那些在 engine/pc.hpp 里）。
//
// 寻址方式：状态张量 = (缓冲区 id, 字节偏移)，Op 自带 src/dst 的行列数。
// 之所以用 id + 偏移而不是指针，是为了让区间着色能把多个临时量复用到同一块 arena。
#pragma once
#include <cstddef>
#include <cstdint>

namespace pc {
namespace core {

using u32 = std::uint32_t;
using usize = std::size_t;

// ---------------------------------------------------------------------------
// OpCode
//
// 分为四组，名字与 engine/pc.hpp 里的 K 一一对应（那边是构图用的同义词）。
// ---------------------------------------------------------------------------
enum class OpCode : std::uint16_t {
    // 逐元素（全部允许原地：dst 可以与 src0 / src1 是同一块内存）
    ADD,            // dst = src0 + src1
    SUB,            // dst = src0 - src1
    MUL,            // dst = src0 * src1 * scalar    (scalar == 0 时退化为 src0 * src1)
    MUL_BC,         // dst = src0 * src1[0, :]       (按行广播)
    SCALE,          // dst = src0 * scalar
    COPY,           // dst = src0
    ADD_SCALED,     // dst += src0 * scalar          (原地累加)
    TANH,           // dst = tanh(src0)
    CLEAR,          // dst = 0
    CLAMP,          // dst = clamp(src0, -scalar, +scalar)
    ONE_MINUS_SQ,   // dst = 1 - src0^2
    THRESHOLD_MUL,  // dst *= (dst > scalar)

    // 行/列方向的结构操作
    SHIFT,          // dst[k] = src0[k+1]，最后一行 *= -0.1   (K × C 行主序)
    SUM_ROWS,       // dst[0, :] = sum_k src0[k, :]           (FLAG_ACC 时不清零)
    EXTRACT_ROW,    // dst = src0[scalar, :]
    EXTRACT_ROWS_EXCEPT,  // dst = src0[去掉第 scalar 行]
    CONCAT_ROWS,    // dst = [src0 ; src1]

    // 矩阵乘（行主序，A 的存储列数决定 lda）
    MATMUL_NN,      // C = A @ B
    MATMUL_NT,      // C = A @ B^T
    MATMUL_TN,      // C = A^T @ B

    // 复合算子：把"本来要拆成五六个 pass"的一段算法压成一个循环，
    // 既省 kernel launch 也省临时缓冲区。语义见 core/executor.hpp 里的实现。
    P_UPDATE,       // S += P^2 E^2 - P ; P = gate(S)
    NORM_STEP,      // set *= 1 - 0.5 * tanh(|set| - 0.5)
    PREDICT_ACT = 1000,  // 原地：row0 = tanh(row0 + B)，其余行 *= 1 - row0^2
    DIFFUSE = 1001,      // 原地：state[k] += dt * state[k+1]，最后一行 *= -0.1
};

// flags 的第 0 位：累加写回。
//   - MATMUL_*   → beta = 1（C += A @ B），省掉 "gemm 之后再来一遍 ADD"
//   - SUM_ROWS   → 不清零 dst 直接累加
constexpr std::uint16_t FLAG_ACC = 1u;

inline const char* op_name(OpCode c) {
    switch (c) {
        case OpCode::ADD: return "ADD";
        case OpCode::SUB: return "SUB";
        case OpCode::MUL: return "MUL";
        case OpCode::MUL_BC: return "MUL_BC";
        case OpCode::SCALE: return "SCALE";
        case OpCode::COPY: return "COPY";
        case OpCode::ADD_SCALED: return "ADD_SCALED";
        case OpCode::TANH: return "TANH";
        case OpCode::CLEAR: return "CLEAR";
        case OpCode::CLAMP: return "CLAMP";
        case OpCode::ONE_MINUS_SQ: return "ONE_MINUS_SQ";
        case OpCode::THRESHOLD_MUL: return "THRESHOLD_MUL";
        case OpCode::SHIFT: return "SHIFT";
        case OpCode::SUM_ROWS: return "SUM_ROWS";
        case OpCode::EXTRACT_ROW: return "EXTRACT_ROW";
        case OpCode::EXTRACT_ROWS_EXCEPT: return "EXTRACT_ROWS_EXCEPT";
        case OpCode::CONCAT_ROWS: return "CONCAT_ROWS";
        case OpCode::MATMUL_NN: return "MATMUL_NN";
        case OpCode::MATMUL_NT: return "MATMUL_NT";
        case OpCode::MATMUL_TN: return "MATMUL_TN";
        case OpCode::P_UPDATE: return "P_UPDATE";
        case OpCode::NORM_STEP: return "NORM_STEP";
        case OpCode::PREDICT_ACT: return "PREDICT_ACT";
        case OpCode::DIFFUSE: return "DIFFUSE";
    }
    return "?";
}

// ---------------------------------------------------------------------------
// Op
//
// 16 个字段按「谁、哪片、写成什么」排列。没有构造函数，聚合初始化即可：
//     Op{OpCode::TANH, 0, 0, 0.f, buf, off, R, C, buf, 0, 0, 0, buf, off, R, C}
// ---------------------------------------------------------------------------
struct Op {
    OpCode code;
    std::uint16_t flags;   // 目前只有 FLAG_ACC
    u32 meta_index;        // 保留：与层/连接编号绑定的外部索引，暂未使用
    float scalar;          // 标量参数（缩放系数、阈值、行号、dt）

    u32 src0;
    usize s0_off, s0_R, s0_C;

    u32 src1;              // 一元算子留 0
    usize s1_off, s1_R, s1_C;

    u32 dst;
    usize d_off, d_R, d_C;
};

}  // namespace core
}  // namespace pc
