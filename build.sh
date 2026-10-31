#!/usr/bin/env bash
# 一行构建：等价于 cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build
#
#   ./build.sh            编译全部
#   ./build.sh run        编译并跑两个示例
#
# 清掉构建目录：rm -rf build
set -euo pipefail
cd "$(dirname "$0")"

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

if [ "${1:-build}" = "run" ]; then
  echo
  ./build/schedule_demo
  echo
  ./build/pc_basic 2000 500 | head -12
fi

cat <<'MSG'

done.

  ./build/schedule_demo        算子层：跑一份生成器产出的 schedule（arena / 计时 / 体检）
  ./build/pc_basic 2000 500    图引擎：两层基本模型，打印 F / ε₀ / ε₁
  双击 pc-studio.html           图形界面
MSG
