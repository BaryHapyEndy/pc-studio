/* studio/src/engine/mt19937.js —— 随机数
 *
 * 这个模块负责：初始化与固定样本用的 mt19937；序列必须和 C++ 的 std::mt19937
 * 逐位一致，所以是原样搬过来的实现，不要重写。
 */

// ───────────────────── mt19937（与 C++ std::mt19937 同序列）─────────────────────
export class MT {
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
