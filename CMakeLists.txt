cmake_minimum_required(VERSION 3.16)
project(pc_engine VERSION 1.0.0 LANGUAGES CXX)

# ---------------------------------------------------------------------------
# 基本设置
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "构建类型" FORCE)
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS Debug Release RelWithDebInfo MinSizeRel)
endif()

option(PC_USE_BLAS "用 cblas 做矩阵乘（关掉则退回朴素三重循环，便于在没有 BLAS 的机器上跑）" ON)

# 公共编译选项。ffp-contract=off 保证 "融合算子" 与 "拆开写的算子序列" 逐位可比，
# 这是能拿生成代码跟手写实现直接对数的前提。
add_library(pc_common INTERFACE)
target_include_directories(pc_common INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_options(pc_common INTERFACE -Wall -Wextra -ffp-contract=off)

# ---------------------------------------------------------------------------
# BLAS：macOS 用 Accelerate，其它平台找系统 BLAS
# ---------------------------------------------------------------------------
set(PC_BLAS ON)
if(PC_USE_BLAS)
    if(APPLE)
        find_path(PC_ACCELERATE_INCLUDE cblas.h
            PATHS
              /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/Accelerate.framework/Frameworks/vecLib.framework/Headers
              /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/Accelerate.framework/Frameworks/vecLib.framework/Headers
            PATH_SUFFIXES Headers)
        if(NOT PC_ACCELERATE_INCLUDE)
            set(PC_BLAS OFF)
        endif()
    else()
        find_package(BLAS QUIET)
        if(NOT BLAS_FOUND)
            set(PC_BLAS OFF)
        endif()
    endif()
endif()

if(NOT PC_USE_BLAS)
    set(PC_BLAS OFF)
endif()

# 给一个 target 挂上 core/engine 需要的包含路径、宏和链接库
function(pc_link_runtime target)
    target_link_libraries(${target} PRIVATE pc_common)
    if(PC_BLAS)
        target_compile_definitions(${target} PRIVATE PC_USE_BLAS)
        if(APPLE)
            target_include_directories(${target} PRIVATE ${PC_ACCELERATE_INCLUDE})
            target_compile_definitions(${target} PRIVATE ACCELERATE_NEW_LAPACK)
            # 系统 cblas.h 上挂着 deprecated 标注，只是头文件换代的噪音
            target_compile_options(${target} PRIVATE -Wno-deprecated-declarations)
            target_link_libraries(${target} PRIVATE "-framework Accelerate")
        else()
            target_link_libraries(${target} PRIVATE ${BLAS_LIBRARIES})
        endif()
    endif()
endfunction()

# ---------------------------------------------------------------------------
# 可执行文件
#   pc_basic       —— engine/pc.hpp：两层预测编码模型（图 → schedule → 运行）
#   schedule_demo  —— core/：直接跑一份生成器产出的 schedule
# ---------------------------------------------------------------------------
add_executable(pc_basic examples/pc_basic.cpp)
pc_link_runtime(pc_basic)

add_executable(schedule_demo examples/schedule_demo.cpp)
pc_link_runtime(schedule_demo)

message(STATUS "pc-engine ${PROJECT_VERSION}: BLAS = ${PC_BLAS}, build type = ${CMAKE_BUILD_TYPE}")
