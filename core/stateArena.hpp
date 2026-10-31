// core/stateArena.hpp —— 对齐的缓冲区集合
//
// 一块 arena 由若干缓冲区组成，每个缓冲区是一段 64 字节对齐的 float 内存。
// 偏移由上层（区间着色的内存规划器）算好，这里只负责"按 id + 偏移拿到指针"。
//
// 之所以还能多缓冲区：schedule 生成器把整条流水线规划到了单块缓冲区（id 0），
// 但手写 schedule 仍习惯每类状态一个缓冲区，两种写法都要能跑。
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <new>
#include <vector>

namespace pc {
namespace core {

using u32 = std::uint32_t;
using usize = std::size_t;

constexpr usize kAlign = 64;

class StateArena {
public:
    StateArena() = default;
    ~StateArena() { release(); }

    StateArena(const StateArena&) = delete;
    StateArena& operator=(const StateArena&) = delete;

    // sizes[i] 是第 i 个缓冲区的字节数；调用会把旧内容释放掉。
    void allocate(const std::vector<usize>& sizes) {
        release();
        sizes_ = sizes;
        data_.resize(sizes.size(), nullptr);
        for (usize i = 0; i < sizes.size(); ++i) {
            if (sizes[i] == 0) continue;
            void* p = nullptr;
            if (posix_memalign(&p, kAlign, sizes[i]) != 0 || p == nullptr) {
                release();
                throw std::bad_alloc();
            }
            data_[i] = p;
        }
    }

    float* ptr(u32 id, usize offset = 0) {
        return reinterpret_cast<float*>(static_cast<char*>(data_[id]) + offset);
    }
    const float* ptr(u32 id, usize offset = 0) const {
        return reinterpret_cast<const float*>(static_cast<const char*>(data_[id]) + offset);
    }

    void* raw(u32 id) { return data_[id]; }
    usize size_of(u32 id) const { return sizes_[id]; }
    usize num_buffers() const { return data_.size(); }

    usize total_bytes() const {
        usize n = 0;
        for (usize s : sizes_) n += s;
        return n;
    }

    // 整块清零：调试和"从头再来"时用
    void zero() {
        for (usize i = 0; i < data_.size(); ++i) {
            char* p = static_cast<char*>(data_[i]);
            for (usize k = 0; k < sizes_[i]; ++k) p[k] = 0;
        }
    }

private:
    void release() {
        for (void* p : data_) std::free(p);
        data_.clear();
        sizes_.clear();
    }

    std::vector<void*> data_;
    std::vector<usize> sizes_;
};

}  // namespace core
}  // namespace pc
