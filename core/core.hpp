// core/core.hpp —— 算子层三件套的入口
//
//   operation.hpp   OpCode / Op         ("说什么")
//   stateArena.hpp  StateArena          ("在哪")
//   executor.hpp    Executor            ("怎么算")
//
// 上层 engine/pc.hpp 在这三个之上做图、相位和内存规划；
// 生成器（tools/schedgen.js）则可以绕过 engine，直接吐 Op[] 交给 Executor 跑。
#pragma once
#include "core/executor.hpp"
#include "core/operation.hpp"
#include "core/stateArena.hpp"
