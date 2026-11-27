/*
 * qmi8658.h — driver for the Waveshare QMI8658 6-axis IMU
 *
 * Board: Waveshare ESP32-S3-LCD-1.28 (non-touch)
 *   I2C bus 0 shared: SDA = GPIO6, SCL = GPIO7, 400 kHz
 *   Chip address: 0x6B (SA0 = VCC on Waveshare board)
 *
 * Spec target (per vc.md):
 *   - Gyro:  ±2000 dps → use ±2048 dps range (closest Waveshare setting)
 *   - Accel: ±8 g
 *   - Sample rate: 200 Hz
 *
 * Data ready / low-power: the QMI8658 has an internal FIFO and a DRR (data
 * ready) interrupt pin. For simplicity we poll via I2C burst reads. A sensor
 * soft reset restores its register configuration; it is not gyro-bias
 * calibration and cannot eliminate 6-axis yaw drift.
 *
 * Reference: QMI8658 datasheet, Rev. 1.3 — register map below.
 */
#pragma once

#include "esp_err.h"
#include "driver/i2c_master.h"
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* I2C chip address (SA0 tied to VCC on the Waveshare board). */
#define QMI_I2C_ADDR  0x6B

/** Raw 6-axis sample (int16 LSB, board default axis order). */
typedef struct {
    int16_t ax;    /* accel X (board X-forward) */
    int16_t ay;    /* accel Y (board Y-left)   */
    int16_t az;    /* accel Z (board Z-up)     */
    int16_t gx;    /* gyro X                   */
    int16_t gy;    /* gyro Y                   */
    int16_t gz;    /* gyro Z                   */
} qmi8658_sample_t;

/*
 * Board axis convention (QMI8658 data-sheet default):
 *   X-forward, Y-left, Z-up.
 *
 * To mount the bat consistently (display-face-up, handle pointing toward the
 * batter's back / down the pitch), keep this convention and do the coordinate
 * transform (−90° about X) on the *client* side, per the vc.md spec.
 *
 * If your physical mount differs, swap axis pairs here (e.g. ax<->ay) rather
 * than in the filter — this keeps the Madgwick filter board-agnostic.
 */
#if defined(QMI8658_SWAP_AX)
#define QMI_AX(ax)  (ax)
#define QMI_AY(ay)  (ay)
#define QMI_AZ(az)  (az)
#define QMI_GX(gx)  (gx)
#define QMI_GY(gy)  (gy)
#define QMI_GZ(gz)  (gz)
#else
#define QMI_AX(ax)  (ax)
#define QMI_AY(ay)  (ay)
#define QMI_AZ(az)  (az)
#define QMI_GX(gx)  (gx)
#define QMI_GY(gy)  (gy)
#define QMI_GZ(gz)  (gz)
#endif

/* Register map. */
#define REG_WHO_AM_I    0x00   /* 0x05 */
#define REG_CTRL1       0x02   /* serial IF control, auto-inc, reset */
#define REG_CTRL2       0x03   /* accel ODR + full scale */
#define REG_CTRL3       0x04   /* gyro  ODR + full scale */
#define REG_CTRL7       0x08   /* sensor enable / low noise */
#define REG_DATA_CTRL1  0x34   /* data-ready interrupt, FIFO */
#define REG_AX_L        0x35   /* accel burst: AX_L..GZ_H (12 bytes) */

/* CTRL2: aFS=010 (±8 g), aODR=0010 (200 Hz) → 0x22 */
#define QMI_CTRL2_VAL  ((0x02 << 4) | 0x02)

/* CTRL3: gFS=111 (±2048 dps — closest to spec's ±2000), gODR=0010 (200 Hz) → 0x72 */
#define QMI_CTRL3_VAL  ((0x07 << 4) | 0x02)

#define QMI_CTRL7_VAL  0x03    /* accel enable + gyro enable */
#define QMI_CTRL1_VAL  0x40    /* address auto-increment for burst read */

/**
 * Initialize the QMI8658 on the shared I2C bus created by main.c
 * (i2c_bus_init — SDA=6, SCL=7 @ 400 kHz).
 * @param bus  I2C bus handle from i2c_new_master_bus()
 * @return ESP_OK on success, error otherwise
 */
esp_err_t qmi8658_init(i2c_master_bus_handle_t bus);

/**
 * Poll-read a single 6-axis sample via burst read (12 bytes).
 * @param out  output sample (callers must supply buffer)
 * @return ESP_OK when a fresh sample is available
 */
esp_err_t qmi8658_read_raw(qmi8658_sample_t *out);

/**
 * Non-blocking poll: fill *out only if a new sample is ready (check DRR bit).
 * Returns ESP_OK if a new sample was read, ESP_FAIL if the buffer is stale.
 */
esp_err_t qmi8658_read_ready(qmi8658_sample_t *out);

/**
 * Soft-reset the sensor and re-apply CTRL2/CTRL3/CTRL7 configuration.
 * Call between capture windows to reset the sensor hardware only. This does
 * not calibrate gyro bias or reset the ESP32, BLE connection, stance, or filter.
 * Takes ~30 ms (10 ms reset + 20 ms settling). Safe to call from the IMU task.
 */
esp_err_t qmi8658_soft_reset(void);

/**
 * Read the WHO_AM_I register for diagnostics.
 */
esp_err_t qmi8658_whoami(uint8_t *whoami);

/**
 * Get the configured gyro full-scale range (for client-side dps conversion).
 * Default: 2048.0 dps.
 */
/* Conversion factors (shared with imu task). */
#define QMI_GYRO_FS_LSB_PER_DPS  (32768.0f / 2048.0f)   /* 0.0625 dps/LSB */
#define QMI_ACCEL_FS_LSB_PER_G   (32768.0f / 8.0f)       /* 4096 LSB/g     */

float qmi8658_get_gyro_range_dps(void);

/**
 * Get the configured accel full-scale range (for client-side g conversion).
 * Default: 8.0 g.
 */
float qmi8658_get_accel_range_g(void);

#ifdef __cplusplus
}
#endif
