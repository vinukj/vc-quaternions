/* CST816S touch controller — adapted to the project's shared I2C bus. */
#include "cst816s.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define TAG "CST816S"
#define I2C_TIMEOUT_MS 10
#define REG_GESTURE 0x01
#define REG_AUTO_SLEEP 0xFE
#define TOUCH_WAKE_PERIOD pdMS_TO_TICKS(2000)

static i2c_master_dev_handle_t s_device;
static TickType_t s_last_wake;

static esp_err_t write_register(uint8_t reg, uint8_t value)
{
    uint8_t bytes[] = {reg, value};
    return i2c_master_transmit(s_device, bytes, sizeof(bytes), I2C_TIMEOUT_MS);
}

esp_err_t cst816s_init(i2c_master_bus_handle_t bus)
{
    if (bus == NULL) return ESP_ERR_INVALID_ARG;

    const i2c_device_config_t config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = CST816S_ADDR,
        .scl_speed_hz = 400000,
    };
    esp_err_t err = i2c_master_bus_add_device(bus, &config, &s_device);
    if (err != ESP_OK) return err;

    const gpio_config_t reset_config = {
        .pin_bit_mask = 1ULL << CST816S_RST_PIN,
        .mode = GPIO_MODE_OUTPUT,
    };
    err = gpio_config(&reset_config);
    if (err != ESP_OK) return err;

    gpio_set_level(CST816S_RST_PIN, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(CST816S_RST_PIN, 1);
    vTaskDelay(pdMS_TO_TICKS(200));

    err = write_register(REG_AUTO_SLEEP, 0x01);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to wake touch controller: %s", esp_err_to_name(err));
        s_device = NULL;
        return err;
    }
    s_last_wake = xTaskGetTickCount();
    ESP_LOGI(TAG, "CST816S ready on I2C address 0x%02X", CST816S_ADDR);
    return ESP_OK;
}

bool cst816s_read(cst816s_touch_t *out)
{
    if (out == NULL) return false;
    out->valid = false;
    if (s_device == NULL) return false;

    TickType_t now = xTaskGetTickCount();
    if ((now - s_last_wake) >= TOUCH_WAKE_PERIOD) {
        (void)write_register(REG_AUTO_SLEEP, 0x01);
        s_last_wake = now;
    }

    uint8_t reg = REG_GESTURE;
    uint8_t data[6] = {0};
    if (i2c_master_transmit_receive(s_device, &reg, 1, data, sizeof(data),
                                    I2C_TIMEOUT_MS) != ESP_OK) {
        return false;
    }

    out->valid = true;
    out->gesture = data[0];
    out->pressed = data[1] != 0;
    out->x = (uint16_t)(((data[2] & 0x0F) << 8) | data[3]);
    out->y = (uint16_t)(((data[4] & 0x0F) << 8) | data[5]);
    if (out->x >= 240) out->x = 239;
    if (out->y >= 240) out->y = 239;
    return out->pressed;
}
