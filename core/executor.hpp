// core/executor.hpp —— 逐 op 的 kernel 分发
//
// Executor::run() 扫一遍 schedule，按 OpCode 分发到下面的 kernel。
// 每个 kernel 都是"裸循环 + 指针"，不含任何形状推断或分配；形状错误由上层
// （engine/pc.hpp 的构图检查）拦住，这里只负责算。
//
// 三个扩展（相对最早的手写版本）：
//   1. FLAG_ACC —— 矩阵乘用 beta = 1、SUM_ROWS 不清零：
//      把 "gemm 之后再 ADD 一遍" 的三次内存往返压成一次。
//   2. MUL 认 op.scalar —— dst = src0 * src1 * scalar：
//      "先 MUL 再 SCALE" 两趟变一趟（scalar == 0 时退化为普通相乘）。
//   3. PREDICT_ACT / DIFFUSE —— 把预测头那 7 个 op、扩散那 3 个 op
//      各自压成一个原地循环（语义见对应 kernel 的注释）。
//
// 算术按 "与拆分写法逐位一致" 的顺序书写；要保住这一点请用 -ffp-contract=off 编译。
#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "core/operation.hpp"
#include "core/stateArena.hpp"

#ifdef PC_USE_BLAS
#include <cblas.h>
#endif

namespace pc {
namespace core {

class Executor {
public:
    void run(const std::vector<Op>& schedule, StateArena& arena) {
        for (const Op& op : schedule) {
            switch (op.code) {
                // 逐元素
                case OpCode::ADD: exec_add(op, arena); break;
                case OpCode::SUB: exec_sub(op, arena); break;
                case OpCode::MUL: exec_mul(op, arena); break;
                case OpCode::MUL_BC: exec_mul_bc(op, arena); break;
                case OpCode::SCALE: exec_scale(op, arena); break;
                case OpCode::COPY: exec_copy(op, arena); break;
                case OpCode::ADD_SCALED: exec_add_scaled(op, arena); break;
                case OpCode::TANH: exec_tanh(op, arena); break;
                case OpCode::CLEAR: exec_clear(op, arena); break;
                case OpCode::CLAMP: exec_clamp(op, arena); break;
                case OpCode::ONE_MINUS_SQ: exec_one_minus_sq(op, arena); break;
                case OpCode::THRESHOLD_MUL: exec_threshold(op, arena); break;

                // 结构操作
                case OpCode::SHIFT: exec_shift(op, arena); break;
                case OpCode::SUM_ROWS: exec_sum_rows(op, arena); break;
                case OpCode::EXTRACT_ROW: exec_extract_row(op, arena); break;
                case OpCode::EXTRACT_ROWS_EXCEPT: exec_extract_rows_except(op, arena); break;
                case OpCode::CONCAT_ROWS: exec_concat_rows(op, arena); break;

                // 矩阵乘
                case OpCode::MATMUL_NN: exec_matmul(op, arena, false, false); break;
                case OpCode::MATMUL_NT: exec_matmul(op, arena, false, true); break;
                case OpCode::MATMUL_TN: exec_matmul(op, arena, true, false); break;

                // 复合
                case OpCode::P_UPDATE: exec_p_update(op, arena); break;
                case OpCode::NORM_STEP: exec_norm_step(op, arena); break;
                case OpCode::PREDICT_ACT: exec_predict_act(op, arena); break;
                case OpCode::DIFFUSE: exec_diffuse(op, arena); break;
            }
        }
    }

private:
    // ---- 逐元素 ----------------------------------------------------------
    void exec_add(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        const float* y = a.ptr(op.src1, op.s1_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = x[i] + y[i];
    }

    void exec_sub(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        const float* y = a.ptr(op.src1, op.s1_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = x[i] - y[i];
    }

    // dst = src0 * src1 * scalar（scalar == 0 时不乘，保持"纯 MUL"的老语义）
    void exec_mul(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        const float* y = a.ptr(op.src1, op.s1_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        if (op.scalar == 0.f) {
            #pragma omp simd
            for (usize i = 0; i < n; ++i) z[i] = x[i] * y[i];
        } else {
            const float s = op.scalar;
            #pragma omp simd
            for (usize i = 0; i < n; ++i) z[i] = x[i] * y[i] * s;
        }
    }

    // 按行广播：src1 是 1 × C，src0 是 R × C
    void exec_mul_bc(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        const float* y = a.ptr(op.src1, op.s1_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize R = op.s0_R, C = op.s0_C;
        for (usize r = 0; r < R; ++r) {
            #pragma omp simd
            for (usize c = 0; c < C; ++c) z[r * C + c] = x[r * C + c] * y[c];
        }
    }

    void exec_scale(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        const float s = op.scalar;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = x[i] * s;
    }

    void exec_copy(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = x[i];
    }

    // dst += src0 * scalar
    void exec_add_scaled(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        const float s = op.scalar;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] += x[i] * s;
    }

    void exec_tanh(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = std::tanh(x[i]);
    }

    void exec_clear(const Op& op, StateArena& a) {
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.d_R * op.d_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = 0.f;
    }

    void exec_clamp(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        const float c = op.scalar;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = std::max(-c, std::min(c, x[i]));
    }

    void exec_one_minus_sq(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.s0_R * op.s0_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) z[i] = 1.f - x[i] * x[i];
    }

    // dst[i] = dst[i] * (dst[i] > scalar)
    void exec_threshold(const Op& op, StateArena& a) {
        float* z = a.ptr(op.dst, op.d_off);
        const usize n = op.d_R * op.d_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i)
            if (z[i] <= op.scalar) z[i] = 0.f;
    }

    // ---- 结构操作 --------------------------------------------------------
    // dst[k] = src0[k+1]；最后一行 *= -0.1（K × C 行主序）
    void exec_shift(const Op& op, StateArena& a) {
        const float* m = a.ptr(op.src0, op.s0_off);
        float* d = a.ptr(op.dst, op.d_off);
        const usize K = op.s0_R, C = op.s0_C;
        for (usize k = 0; k < K - 1; ++k) {
            #pragma omp simd
            for (usize j = 0; j < C; ++j) d[k * C + j] = m[(k + 1) * C + j];
        }
        #pragma omp simd
        for (usize j = 0; j < C; ++j) d[(K - 1) * C + j] = -0.1f * m[(K - 1) * C + j];
    }

    // dst[0, :] = sum_k src0[k, :]；FLAG_ACC 时不清零、直接累加到 dst
    void exec_sum_rows(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize K = op.s0_R, C = op.s0_C;
        if (!(op.flags & FLAG_ACC)) {
            #pragma omp simd
            for (usize c = 0; c < C; ++c) z[c] = 0.f;
        }
        for (usize k = 0; k < K; ++k) {
            #pragma omp simd
            for (usize c = 0; c < C; ++c) z[c] += x[k * C + c];
        }
    }

    void exec_extract_row(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize C = op.s0_C, r = static_cast<usize>(op.scalar);
        #pragma omp simd
        for (usize i = 0; i < C; ++i) z[i] = x[r * C + i];
    }

    void exec_extract_rows_except(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize R = op.s0_R, C = op.s0_C, r = static_cast<usize>(op.scalar);
        const usize n1 = C * r;
        const usize n2 = C * (R - r - 1);
        #pragma omp simd
        for (usize i = 0; i < n1; ++i) z[i] = x[i];
        #pragma omp simd
        for (usize i = 0; i < n2; ++i) z[n1 + i] = x[(r + 1) * C + i];
    }

    void exec_concat_rows(const Op& op, StateArena& a) {
        const float* x = a.ptr(op.src0, op.s0_off);
        const float* y = a.ptr(op.src1, op.s1_off);
        float* z = a.ptr(op.dst, op.d_off);
        const usize R1 = op.s0_R, R2 = op.s1_R, C = op.s0_C;
        const usize n1 = R1 * C, n2 = R2 * C;
        #pragma omp simd
        for (usize i = 0; i < n1; ++i) z[i] = x[i];
        #pragma omp simd
        for (usize i = 0; i < n2; ++i) z[n1 + i] = y[i];
    }

    // ---- 矩阵乘 ----------------------------------------------------------
    // 逻辑形状：C(d_R × d_C) = op(A) @ op(B)，A 是 s0_R × s0_C、B 是 s1_R × s1_C。
    // FLAG_ACC 时 beta = 1，把结果累加进 dst。
    void exec_matmul(const Op& op, StateArena& a, bool transA, bool transB) {
#ifdef PC_USE_BLAS
        const float* A = a.ptr(op.src0, op.s0_off);
        const float* B = a.ptr(op.src1, op.s1_off);
        float* C = a.ptr(op.dst, op.d_off);

        const CBLAS_TRANSPOSE ta = transA ? CblasTrans : CblasNoTrans;
        const CBLAS_TRANSPOSE tb = transB ? CblasTrans : CblasNoTrans;

        const usize M = transA ? op.s0_C : op.s0_R;
        const usize K = transA ? op.s0_R : op.s0_C;
        const usize N = transB ? op.s1_R : op.s1_C;
        const usize lda = op.s0_C;             // A 的存储列数
        const usize ldb = transB ? K : N;      // B 的存储列数
        const usize ldc = N;

        cblas_sgemm(CblasRowMajor, ta, tb, static_cast<int>(M), static_cast<int>(N),
                    static_cast<int>(K), 1.0f, A, static_cast<int>(lda), B,
                    static_cast<int>(ldb), (op.flags & FLAG_ACC) ? 1.0f : 0.0f, C,
                    static_cast<int>(ldc));
#else
        // 无 BLAS 的朴素实现（同样的行主序语义，慢一些，方便在没装 cblas 的机器上跑）
        const float* A = a.ptr(op.src0, op.s0_off);
        const float* B = a.ptr(op.src1, op.s1_off);
        float* C = a.ptr(op.dst, op.d_off);
        const usize M = transA ? op.s0_C : op.s0_R;
        const usize K = transA ? op.s0_R : op.s0_C;
        const usize N = transB ? op.s1_R : op.s1_C;
        const bool acc = (op.flags & FLAG_ACC) != 0;
        for (usize i = 0; i < M; ++i) {
            for (usize j = 0; j < N; ++j) {
                float sum = 0.f;
                for (usize k = 0; k < K; ++k) {
                    const float av = transA ? A[k * op.s0_C + i] : A[i * op.s0_C + k];
                    const float bv = transB ? B[j * op.s1_C + k] : B[k * op.s1_C + j];
                    sum += av * bv;
                }
                C[i * N + j] = acc ? C[i * N + j] + sum : sum;
            }
        }
#endif
    }

    // ---- 复合算子 --------------------------------------------------------
    // S += P^2 E^2 - P ; P = 0.5 - 0.5 tanh(S - 1)，并把 P <= 0.5 的位置剪掉
    void exec_p_update(const Op& op, StateArena& a) {
        float* s = a.ptr(op.src0, op.s0_off);   // S
        const float* e = a.ptr(op.src1, op.s1_off);  // E
        float* p = a.ptr(op.dst, op.d_off);     // P
        const usize n = op.s0_R * op.s0_C;
        #pragma omp simd
        for (usize i = 0; i < n; ++i) s[i] = s[i] + p[i] * p[i] * e[i] * e[i] - p[i];
        #pragma omp simd
        for (usize i = 0; i < n; ++i) {
            p[i] = 0.5f - 0.5f * std::tanh(s[i] - 1.f);
            if (p[i] <= 0.5f) p[i] = 0.f;
        }
    }

    // set *= 1 - 0.5 tanh(|set| - 0.5)（原地）
    void exec_norm_step(const Op& op, StateArena& a) {
        float* x = a.ptr(op.src0, op.s0_off);
        const usize n = op.s0_R * op.s0_C;
        float norm = 0.f;
        for (usize i = 0; i < n; ++i) norm += std::abs(x[i]);
        const float s = 0.5f - 0.5f * std::tanh(norm - 0.5f);
        #pragma omp simd
        for (usize i = 0; i < n; ++i) x[i] = x[i] * s;
    }

    // 预测头，原地：先对第 0 行做 tanh(x + B)，再让其余行乘上 1 - t^2。
    //   dst 是 (K × C) 的预测缓冲区，src1 是 1 × C 的偏置。
    //   等价于 EXTRACT_ROW / ADD / TANH / ONE_MINUS_SQ / EXTRACT_ROWS_EXCEPT /
    //   MUL_BC / CONCAT_ROWS 这七步，但只过一遍内存。
    void exec_predict_act(const Op& op, StateArena& a) {
        float* z = a.ptr(op.dst, op.d_off);
        const float* b = a.ptr(op.src1, op.s1_off);
        const usize R = op.d_R, C = op.d_C;
        for (usize i = 0; i < C; ++i) z[i] = std::tanh(z[i] + b[i]);
        for (usize r = 1; r < R; ++r) {
            float* row = z + r * C;
            for (usize i = 0; i < C; ++i) {
                const float t = z[i] * z[i];
                row[i] = row[i] * (1.f - t);
            }
        }
    }

    // 扩散，原地：state[k] += dt * state[k+1]，最后一行按 -0.1 泄漏。
    //   等价于 SHIFT / SCALE / ADD 三步 + 一块临时缓冲区。
    void exec_diffuse(const Op& op, StateArena& a) {
        float* z = a.ptr(op.dst, op.d_off);
        const usize R = op.d_R, C = op.d_C;
        const float dt = op.scalar;
        for (usize k = 0; k + 1 < R; ++k) {
            float* cur = z + k * C;
            const float* nxt = z + (k + 1) * C;
            #pragma omp simd
            for (usize j = 0; j < C; ++j) cur[j] += nxt[j] * dt;
        }
        float* last = z + (R - 1) * C;
        #pragma omp simd
        for (usize j = 0; j < C; ++j) last[j] += (-0.1f * last[j]) * dt;
    }
};

}  // namespace core
}  // namespace pc
