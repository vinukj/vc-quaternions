/* CST816S touch controller used on the Waveshare ESP32-S3-LCD-1.28 touch board. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "driver/i2c_master.h"
#include "esp_err.h"

#define CST816S_ADDR    0x15
#define CST816S_INT_PIN 5
#define CST816S_RST_PIN 13

typedef struct {
    uint16_t x;
    uint16_t y;
    uint8_t gesture;
    bool pressed;
    /* False only when the I2C sample could not be read. */
    bool valid;
} cst816s_touch_t;

/** Add the touch device to the shared QMI8658 I2C bus and initialize it. */
esp_err_t cst816s_init(i2c_master_bus_handle_t bus);

/** Read the current touch point; returns false when no finger is down.
 * Check out->valid to distinguish a valid release from an I2C read failure.
 */
bool cst816s_read(cst816s_touch_t *out);
