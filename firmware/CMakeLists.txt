# ESP-IDF project CMake for the Cricket Bat Tracker (vc-quaternions)
# Board: Waveshare ESP32-S3-LCD-1.28

cmake_minimum_required(VERSION 3.16)

set(VC_FW_VERSION "0.1.0")
message(STATUS "Building vc-quaternions firmware v${VC_FW_VERSION} for ESP32-S3")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(vc-quaternions VERSION ${VC_FW_VERSION} LANGUAGES C CXX ASM)
