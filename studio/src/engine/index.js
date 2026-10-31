/* studio/src/engine/index.js —— 语义图 → Op[] → arena → 运行 / 导出 C++
 *
 * 这个模块负责：把引擎的全部公开成员集中 re-export，别的模块只从这里 import。
 *
 * 这个目录和 engine/pc.hpp 是"同一个引擎的两份实现"：张量、op、相位、
 * 区间着色规划、mt19937 初始化序列一一对应，所以浏览器里的曲线和导出的
 * C++ 跑出来的是同一组数（tools/crosscheck 会核对）。
 *
 * 层次：组件库 LIB → 语义图 spec（节点+连线）→ lower() → Program（Op[]+arena）→ run()
 *
 * 连线语义（这是整个界面唯一需要理解的一条规则）：
 *   状态节点的左侧是 in，右侧是 out。op 的 d 输出连到某个状态的 in，
 *   表示"这个 op 直接写进那块内存"（原地写回）。例如
 *       AXPY(Δμ, s=η) → M[1].in      就是  M[1] += η·Δμ
 *       x            → M[0].in      就是  M[0] = x
 */

import { sh, same, fmtShape } from './shape.js';
import { MT } from './mt19937.js';
import { Program, PH, PHNAME, planBuffers, execOp, runPhase } from './program.js';
import { LIB, LIBMAP } from './library.js';
import { tname, label, stateShape, portShape, edgeSource } from './names.js';
import { lower } from './lower.js';
import { num, stateTypes, initProgram } from './init.js';
import { metrics, freeEnergy } from './metrics.js';
import { emitCpp } from './codegen.js';
import { presetLayers, presetBasic, presetDeep, presetSingle, PRESETS } from './presets.js';

export { sh, same, fmtShape, MT, Program, PH, PHNAME, planBuffers, execOp, runPhase, LIB, LIBMAP, tname, label, stateShape, portShape, edgeSource, lower, initProgram, stateTypes, num, metrics, freeEnergy, emitCpp, presetLayers, presetBasic, presetDeep, presetSingle, PRESETS };
