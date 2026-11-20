/*
 * imu_bluetooth_task.h — IMU sampling + Madgwick fusion + BLE streaming task
 *
 * Task responsibilities (run on its own core):
 *   1. Read QMI8658 at 200 Hz (fixed 5 ms intervals).
 *   2. Feed accel/gyro into Madgwick (6-axis, beta=0.1) -> quaternion.
 *   3. Detect bat swings on-device (gyro mag > 300 dps) and set flag bit0.
 *   4. Stream quaternion over BLE notify at 50 Hz (every 4th sample).
 *   5. Optional: light sleep between packets for power saving.
 *
 * Thread sharing: s_current_q / s_current_q_valid are written by this task
 * and read by ble_server_handle_command (Take Guard). The BLE notify path
 * copies under the notify lock.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "esp_err.h"
#include "madgwick.h"

#define IMU_BLUETOOTH_TASK_PRIORITY 10

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Create and start the IMU + BLE stream task.
 * @param stack_words  task stack size in words (ESP32-S3: >= 4096)
 * @param prio         task priority (ESP32-S3: 1..24, 24=highest)
 * @param core         core to pin the task on (-1 = any)
 * @return ESP_OK on success
 */
esp_err_t imu_bluetooth_task_create(size_t stack_words, uint8_t prio, int core);

/**
 * Stop the task (blocks until it deletes itself).
 */
void imu_bluetooth_task_stop(void);

/**
 * Trigger a "Take Guard" command from software (alternative to BLE).
 */
void imu_bluetooth_trigger_guard(void);

/** Copy the most recently fused quaternion without racing the IMU task. */
bool imu_bluetooth_get_current_quaternion(madgwick_quaternion_t *out);

/** Return the cumulative on-device swing count. */
uint16_t imu_bluetooth_get_swing_count(void);

/** Report whether the QMI8658 initialized successfully. */
bool imu_bluetooth_is_ready(void);

/** Ask the IMU task to reinitialize its filter on the next iteration. */
void imu_bluetooth_request_filter_reset(void);

#ifdef __cplusplus
}
#endif
