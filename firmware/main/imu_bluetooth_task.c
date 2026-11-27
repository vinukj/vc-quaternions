/*
 * imu_bluetooth_task.c — IMU sampling + Madgwick + BLE quaternion stream
 *
 * Task responsibilities (run on its own core):
 *   1. Read QMI8658 at 200 Hz (fixed 5 ms intervals).
 *   2. Feed accel/gyro into Madgwick (6-axis, beta=0.1) -> quaternion.
 *   3. Detect bat swings on-device (gyro mag > 300 dps) and set flag bit0.
 *   4. Stream quaternion over BLE notify at the selected cadence
 *      (default every 4th IMU sample = 50 Hz; 0x0B selects 4/3/2/1).
 *   5. Optional: light sleep between packets for power saving.
 *
 * Thread sharing: s_current_q / s_current_q_valid are written by this task
 * and read by ble_server_handle_command (Take Guard). The BLE notify path
 * copies under the notify lock.
 */
#include "imu_bluetooth_task.h"

#include "madgwick.h"
#include "drivers/qmi8658.h"
#include "ble/ble_server.h"

#include <math.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TAG "IMU-BT"

/* ---- Config per vc.md spec ---- */
#define IMU_SAMPLE_HZ         200
#define IMU_INTERVAL_MS        5           /* 1 / 200 Hz */
#define SWING_THRESHOLD_DPS   300.0f       /* on-device swing detection */

#define FILTER_BETA          0.1f          /* Madgwick beta */

/* Task config. */
#define IMU_BT_STACK_WORDS   8192
#define IMU_BT_PRIO          10
#define IMU_BT_CORE          1            /* keep BLE host off this core */

/* ---- Shared state between this task and ble_server (Take Guard) ---- */
static madgwick_quaternion_t s_current_q = {1.0f, 0.0f, 0.0f, 0.0f};
static bool s_current_q_valid = false;
static portMUX_TYPE s_quaternion_lock = portMUX_INITIALIZER_UNLOCKED;

/* Shared IMU sample (filled by qmi8658_read_raw). */
qmi8658_sample_t s_imu_sample;

/* Guard trigger from external (e.g. a pin or another task). */
static volatile bool s_guard_requested = false;
volatile bool s_filter_reset_requested = false;
static volatile bool s_sensor_reset_requested = false;

/* ---- Madgwick state ---- */
static madgwick_state_t s_filter;

static void store_current_quaternion(const madgwick_quaternion_t *q)
{
    portENTER_CRITICAL(&s_quaternion_lock);
    s_current_q = *q;
    s_current_q_valid = true;
    portEXIT_CRITICAL(&s_quaternion_lock);
}

bool imu_bluetooth_get_current_quaternion(madgwick_quaternion_t *out)
{
    if (out == NULL) {
        return false;
    }

    portENTER_CRITICAL(&s_quaternion_lock);
    bool valid = s_current_q_valid;
    if (valid) {
        *out = s_current_q;
    }
    portEXIT_CRITICAL(&s_quaternion_lock);
    return valid;
}

void imu_bluetooth_request_filter_reset(void)
{
    __atomic_store_n(&s_filter_reset_requested, true, __ATOMIC_RELEASE);
}

void imu_bluetooth_request_sensor_reset(void)
{
    __atomic_store_n(&s_sensor_reset_requested, true, __ATOMIC_RELEASE);
}

/* ---- Swing detection state ---- */
static uint16_t s_swing_count = 0;
static bool s_imu_ready = false;
static bool s_in_swing = false;
static bool s_swing_start_pending = false;
static float s_peak_gyro_dps = 0.0f;
static uint64_t s_swing_start_us = 0;

uint16_t imu_bluetooth_get_swing_count(void)
{
    return __atomic_load_n(&s_swing_count, __ATOMIC_RELAXED);
}

bool imu_bluetooth_is_ready(void)
{
    return __atomic_load_n(&s_imu_ready, __ATOMIC_ACQUIRE);
}

/* Task handle (for stopping). */
static TaskHandle_t s_imu_task_handle = NULL;

/* External: I2C bus created by main.c. */
extern i2c_master_bus_handle_t g_i2c_bus;

/* ---------------------------------------------------------------------- */

/*
 * update_swing_flags — on-device swing detection (gyro magnitude > 300 dps).
 * Sets flags bit0 when a swing starts; updates peak gyro in dps.
 */
static void update_swing_flags(uint16_t *flags, float *peak_out)
{
    float gmag_lsb = sqrtf((float)s_imu_sample.gx * s_imu_sample.gx +
                           (float)s_imu_sample.gy * s_imu_sample.gy +
                           (float)s_imu_sample.gz * s_imu_sample.gz);
    float gmag_dps = gmag_lsb / QMI_GYRO_FS_LSB_PER_DPS;

    uint16_t flags_val = 0;
    if (gmag_dps > SWING_THRESHOLD_DPS) {
        if (!s_in_swing) {
            /* Swing start. */
            s_in_swing = true;
            s_swing_start_pending = true;
            s_swing_start_us = esp_timer_get_time();
            uint16_t swing_count = __atomic_add_fetch(&s_swing_count, 1,
                                                       __ATOMIC_RELAXED);
            ESP_LOGI(TAG, "SWING #%u started — t_ms=%llu",
                     (unsigned)swing_count,
                     (long long)((esp_timer_get_time() - s_swing_start_us) / 1000));
            flags_val |= 0x01;
        }
        if (gmag_dps > s_peak_gyro_dps) {
            s_peak_gyro_dps = gmag_dps;
        }
    } else {
        if (s_in_swing) {
            /* Swing end. */
            s_in_swing = false;
            uint64_t dur_us = esp_timer_get_time() - s_swing_start_us;
            float dur_ms = (float)dur_us / 1000.0f;
            ESP_LOGI(TAG, "SWING #%u ended — dur=%g ms, peak=%g dps",
                     (unsigned)s_swing_count, dur_ms, (double)s_peak_gyro_dps);
        }
    }

    if (flags)   *flags   = flags_val;
    if (peak_out) *peak_out = s_peak_gyro_dps;
}

/* ---------------------------------------------------------------------- */

static void imu_bluetooth_task(void *pv)
{
    (void)pv;

    ESP_ERROR_CHECK(esp_task_wdt_add(NULL));

    /* IMU init (bus created in main.c). */
    esp_err_t ret = qmi8658_init(g_i2c_bus);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "QMI8658 init failed: %s", esp_err_to_name(ret));
        /* Keep retrying reads without claiming the sensor is ready. */
    } else {
        __atomic_store_n(&s_imu_ready, true, __ATOMIC_RELEASE);
        ESP_LOGI(TAG, "QMI8658 ready — sampling at %d Hz", IMU_SAMPLE_HZ);
    }

    /* Madgwick init. */
    madgwick_init(&s_filter);
    madgwick_set_beta(&s_filter, FILTER_BETA);
    madgwick_set_interval_ms(&s_filter, IMU_INTERVAL_MS);

    /* Start advertising before stream, so a browser can pair. */
    ble_server_start_advertising();

    TickType_t last_wake = xTaskGetTickCount();
    uint32_t sample_count = 0;
    uint32_t notify_count = 0;

    while (1) {
        ESP_ERROR_CHECK(esp_task_wdt_reset());

        /* Check filter reset request (from Full Reset command). */
        bool reset_req = __atomic_exchange_n(&s_filter_reset_requested, false,
                                               __ATOMIC_ACQ_REL);
        if (reset_req) {
            madgwick_init(&s_filter);
            madgwick_set_beta(&s_filter, FILTER_BETA);
            madgwick_set_interval_ms(&s_filter, IMU_INTERVAL_MS);
        }

        /* Only this task owns QMI8658 I2C. Preserve the BLE link and the
         * session-relative filter/stance frame across sensor resets. */
        bool sensor_reset_req = __atomic_exchange_n(&s_sensor_reset_requested,
                                                     false, __ATOMIC_ACQ_REL);
        if (sensor_reset_req) {
            s_imu_sample = (qmi8658_sample_t){0};
            s_in_swing = false;
            s_swing_start_pending = false;
            s_peak_gyro_dps = 0.0f;
            s_swing_start_us = 0;

            ret = qmi8658_soft_reset();
            if (ret != ESP_OK) {
                ESP_LOGE(TAG, "QMI8658-only reset failed: %s; MCU and BLE remain running",
                         esp_err_to_name(ret));
                ble_server_set_sensor_reset_result(false);
            } else {
                ESP_LOGI(TAG, "QMI8658 reset complete; preserving stance and filter frame");
                ble_server_set_sensor_reset_result(true);
            }
            /* Do not fuse a pre-reset sample after this asynchronous request. */
            last_wake = xTaskGetTickCount();
            continue;
        }

        /* Check external guard trigger (e.g. from a UI task). */
        bool guard_req = __atomic_exchange_n(&s_guard_requested, false,
                                               __ATOMIC_ACQ_REL);
        if (guard_req) {
            ble_server_handle_command(0x03);
        }

        /* Read IMU (poll read). */
        ret = qmi8658_read_raw(&s_imu_sample);
        if (ret != ESP_OK) {
            ESP_LOGW(TAG, "IMU read failed (%d) — retrying", ret);
            vTaskDelay(pdMS_TO_TICKS(1));
            continue;
        }

        /* Convert raw LSB to engineering units.
         * accel: g ; gyro: deg/s (Madgwick expects deg/s). */
        float ax = s_imu_sample.ax / QMI_ACCEL_FS_LSB_PER_G;
        float ay = s_imu_sample.ay / QMI_ACCEL_FS_LSB_PER_G;
        float az = s_imu_sample.az / QMI_ACCEL_FS_LSB_PER_G;
        float gx = s_imu_sample.gx / QMI_GYRO_FS_LSB_PER_DPS;
        float gy = s_imu_sample.gy / QMI_GYRO_FS_LSB_PER_DPS;
        float gz = s_imu_sample.gz / QMI_GYRO_FS_LSB_PER_DPS;

        /* Madgwick update (6-axis, no magnetometer). */
        madgwick_quaternion_t q;
        bool ok = madgwick_updateIMU(&s_filter, ax, ay, az, gx, gy, gz,
                                     (float)IMU_INTERVAL_MS / 1000.0f, &q);
        if (!ok) {
            ESP_LOGW(TAG, "Madgwick update failed");
            continue;
        }

        /* Store shared quaternion (guarded: Take Guard reads it). */
        store_current_quaternion(&q);

        /* Swing detection + flags. */
        uint16_t flags = 0;
        float peak = 0.0f;
        update_swing_flags(&flags, &peak);

        /* BLE stream at the selected cadence (default every 4th = 50 Hz). */
        const uint8_t notify_skip = ble_server_get_notify_skip();
        if (++sample_count % notify_skip == 0) {
            /* Latch the 200 Hz onset until a notification carries it. */
            s_swing_start_pending = s_swing_start_pending || ((flags & 0x01) != 0);
            ble_server_notify_quaternion(&q,
                                         s_swing_start_pending ? 0x01 : 0x00);
            s_swing_start_pending = false;
            notify_count++;
            if (notify_count % 50 == 0) {
                ESP_LOGD(TAG, "BLE stream %u packets sent, swings=%u",
                         (unsigned)notify_count,
                         (unsigned)imu_bluetooth_get_swing_count());
            }
        }

        /* Fixed 200 Hz timing via vTaskDelayUntil. */
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(IMU_INTERVAL_MS));
    }
}

/* ---------------------------------------------------------------------- */

esp_err_t imu_bluetooth_task_create(size_t stack_words, uint8_t prio, int core)
{
    BaseType_t rc = xTaskCreatePinnedToCore(
        imu_bluetooth_task,
        "IMU-BT",
        (stack_words == 0) ? IMU_BT_STACK_WORDS : stack_words,
        NULL,
        prio,
        &s_imu_task_handle,
        (core >= 0) ? core : tskNO_AFFINITY);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "task create failed: %d", (int)rc);
        return ESP_FAIL;
    }
    return ESP_OK;
}

void imu_bluetooth_task_stop(void)
{
    if (s_imu_task_handle != NULL) {
        vTaskDelete(s_imu_task_handle);
        s_imu_task_handle = NULL;
    }
}

void imu_bluetooth_trigger_guard(void)
{
    __atomic_store_n(&s_guard_requested, true, __ATOMIC_RELEASE);
}
