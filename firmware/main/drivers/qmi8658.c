/*
 * qmi8658.c — QMI8658 6-axis IMU driver
 */
#include "qmi8658.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

#define TAG "QMI8658"

#define I2C_TIMEOUT_MS 10

static i2c_master_dev_handle_t s_device = NULL;
static bool s_initialized = false;

/* Physical scale factors (calculated at runtime from config regs). */
static float s_gyro_range = 2048.0f;
static float s_accel_range = 8.0f;

/* Config: what the register maps to. */
#define QMI_GYRO_FS_LSB_PER_DPS  (32768.0f / 2048.0f)   /* 0.0625 dps/LSB */
#define QMI_ACCEL_FS_LSB_PER_G   (32768.0f / 8.0f)       /* 4096 LSB/g   */

static esp_err_t reg_write(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = {reg, val};
    return i2c_master_transmit(s_device, buf, sizeof(buf), I2C_TIMEOUT_MS);
}

static esp_err_t reg_read(uint8_t reg, uint8_t *data, size_t len)
{
    return i2c_master_transmit_receive(s_device, &reg, 1, data, len,
                                       I2C_TIMEOUT_MS);
}

esp_err_t qmi8658_whoami(uint8_t *whoami)
{
    if (!s_initialized || whoami == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return reg_read(REG_WHO_AM_I, whoami, 1);
}

float qmi8658_get_gyro_range_dps(void) { return s_gyro_range; }
float qmi8658_get_accel_range_g(void)  { return s_accel_range; }

esp_err_t qmi8658_init(i2c_master_bus_handle_t bus)
{
    if (bus == NULL) {
        ESP_LOGE(TAG, "NULL I2C bus");
        return ESP_ERR_INVALID_ARG;
    }
    if (s_initialized) {
        ESP_LOGW(TAG, "Already initialized");
        return ESP_OK;
    }

    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = QMI_I2C_ADDR,
        .scl_speed_hz    = 400000,
    };
    esp_err_t ret = i2c_master_bus_add_device(bus, &cfg, &s_device);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "I2C device add failed: %s", esp_err_to_name(ret));
        return ret;
    }

    uint8_t who = 0;
    ret = reg_read(REG_WHO_AM_I, &who, 1);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "I2C read failed (%d) — check SDA/SCL wiring", ret);
        return ret;
    }
    ESP_LOGI(TAG, "WHO_AM_I = 0x%02X (expect 0x%02X)", who, 0x05);
    if (who != 0x05) {
        ESP_LOGE(TAG, "QMI8658 not found at 0x%02X", QMI_I2C_ADDR);
        return ESP_ERR_NOT_FOUND;
    }

    /* CTRL1: auto-increment for burst reads (bit 6) + soft reset clear. */
    ESP_ERROR_CHECK(reg_write(REG_CTRL1, QMI_CTRL1_VAL));

    /* CTRL2: aFS=010 (±8 g), aODR=0010 (200 Hz). */
    ESP_ERROR_CHECK(reg_write(REG_CTRL2, QMI_CTRL2_VAL));

    /* CTRL3: gFS=111 (±2048 dps), gODR=0010 (200 Hz). */
    ESP_ERROR_CHECK(reg_write(REG_CTRL3, QMI_CTRL3_VAL));

    /* CTRL7: enable accel + gyro, normal noise mode. */
    ESP_ERROR_CHECK(reg_write(REG_CTRL7, QMI_CTRL7_VAL));

    vTaskDelay(pdMS_TO_TICKS(10));

    /* Confirm configuration stuck. */
    uint8_t c2 = 0, c3 = 0;
    reg_read(REG_CTRL2, &c2, 1);
    reg_read(REG_CTRL3, &c3, 1);
    ESP_LOGI(TAG, "CTRL2=0x%02X CTRL3=0x%02X — accel ±%g g @ %u Hz, gyro ±%g dps @ %u Hz",
             c2, c3,
             (double)qmi8658_get_accel_range_g(), (unsigned)200,
             (double)qmi8658_get_gyro_range_dps(), (unsigned)200);

    s_initialized = true;
    return ESP_OK;
}

esp_err_t qmi8658_soft_reset(void)
{
    if (!s_initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    /* CTRL1 bit 7 = soft reset. */
    esp_err_t ret = reg_write(REG_CTRL1, 0x80);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "soft reset write failed: %d", ret);
        return ret;
    }
    vTaskDelay(pdMS_TO_TICKS(10));

    /* Re-apply configuration after reset. */
    ESP_ERROR_CHECK(reg_write(REG_CTRL1, QMI_CTRL1_VAL));
    ESP_ERROR_CHECK(reg_write(REG_CTRL2, QMI_CTRL2_VAL));
    ESP_ERROR_CHECK(reg_write(REG_CTRL3, QMI_CTRL3_VAL));
    ESP_ERROR_CHECK(reg_write(REG_CTRL7, QMI_CTRL7_VAL));

    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_LOGI(TAG, "QMI8658 soft reset + reinit done");
    return ESP_OK;
}

esp_err_t qmi8658_read_raw(qmi8658_sample_t *out)
{
    if (!s_initialized || out == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t raw[12];
    esp_err_t ret = reg_read(REG_AX_L, raw, sizeof(raw));
    if (ret != ESP_OK) {
        return ret;
    }

    /* Burst order: AX_L AX_H AY_L AY_H AZ_L AZ_H GX_L GX_H GY_L GY_H GZ_L GZ_H. */
    int16_t ax = (int16_t)((raw[1]  << 8) | raw[0]);
    int16_t ay = (int16_t)((raw[3]  << 8) | raw[2]);
    int16_t az = (int16_t)((raw[5]  << 8) | raw[4]);
    int16_t gx = (int16_t)((raw[7]  << 8) | raw[6]);
    int16_t gy = (int16_t)((raw[9]  << 8) | raw[8]);
    int16_t gz = (int16_t)((raw[11] << 8) | raw[10]);

    out->ax = QMI_AX(ax);
    out->ay = QMI_AY(ay);
    out->az = QMI_AZ(az);
    out->gx = QMI_GX(gx);
    out->gy = QMI_GY(gy);
    out->gz = QMI_GZ(gz);

    return ESP_OK;
}

esp_err_t qmi8658_read_ready(qmi8658_sample_t *out)
{
    if (!s_initialized || out == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Check the DRR (data-ready) status bit in the data-control register. */
    uint8_t dc = 0;
    esp_err_t ret = reg_read(REG_DATA_CTRL1, &dc, 1);
    if (ret != ESP_OK) {
        return ret;
    }
    if ((dc & 0x01) == 0) {
        return ESP_FAIL;  /* stale buffer */
    }

    return qmi8658_read_raw(out);
}
