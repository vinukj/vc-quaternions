/*
 * main.c — Cricket Bat Tracker (vc-quaternions)
 *
 * Hardware: Waveshare ESP32-S3-LCD-1.28
 *   GC9A01 LCD : SPI2, CLK=10, MOSI=11, CS=9, DC=8, RST=14, BL=2
 *   QMI8658    : I2C0     SDA=6, SCL=7, 400 kHz
 *
 * Task map:
 *   Core 1: imu_bluetooth_task  — 200 Hz IMU + Madgwick + BLE @ 50 Hz
 *   Core 0: nimble_host         — BLE stack (NimBLE)
 *
 * Serial debug: 115200 baud (ESP32-S3 UART0).
 */
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/i2c_master.h"
#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"

#include "ble/ble_server.h"
#include "imu_bluetooth_task.h"
#include "drivers/qmi8658.h"
#include "drivers/lcd_display.h"
#include "drivers/cst816s.h"
#include "drivers/touch_debounce.h"

#define TAG "MAIN"

/* Shared I2C bus for the IMU. */
#define I2C_SDA_PIN  GPIO_NUM_6
#define I2C_SCL_PIN  GPIO_NUM_7
#define I2C_FREQ_HZ  400000

i2c_master_bus_handle_t g_i2c_bus = NULL;

/* ---------------------------------------------------------------------- */
/* Simple UART debug bridge. */

static void uart_init(void)
{
    /* UART0 = ESP32-S3 native UART, 115200-8-N-1, no flow control. */
    const uart_config_t cfg = {
        .baud_rate = 115200,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 256, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(UART_NUM_0, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM_0,
                                 UART_PIN_NO_CHANGE, /* TX: GPIO43 on Waveshare */
                                 UART_PIN_NO_CHANGE, /* RX: GPIO44 on Waveshare */
                                 UART_PIN_NO_CHANGE,
                                 UART_PIN_NO_CHANGE));
    ESP_LOGI(TAG, "Serial debug @ 115200");
}

/* I2C bus shared by the QMI8658 (and CST816S on the touch variant). */
static esp_err_t i2c_bus_init(void)
{
    const i2c_master_bus_config_t cfg = {
        .i2c_port      = I2C_NUM_0,
        .sda_io_num    = I2C_SDA_PIN,
        .scl_io_num    = I2C_SCL_PIN,
        .clk_source    = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t ret = i2c_new_master_bus(&cfg, &g_i2c_bus);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "I2C bus init failed: %s", esp_err_to_name(ret));
        return ret;
    }
    ESP_LOGI(TAG, "I2C bus init: SDA=%d SCL=%d @%d Hz",
             I2C_SDA_PIN, I2C_SCL_PIN, I2C_FREQ_HZ);
    return ESP_OK;
}

/* ---------------------------------------------------------------------- */

void app_main(void)
{
    ESP_LOGI(TAG, "=== Cricket Bat Tracker (vc-quaternions) v0.1 ===");

    /* 1. NVS + UART. */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);
    uart_init();

    /* 2. I2C + IMU. */
    ESP_ERROR_CHECK(i2c_bus_init());

    /* 3. Bring up the raw touch dashboard before starting background tasks. */
    esp_lcd_panel_handle_t lcd_panel = NULL;
    ESP_ERROR_CHECK(lcd_display_init(&lcd_panel));
    ret = cst816s_init(g_i2c_bus);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Touch controller init failed: %s", esp_err_to_name(ret));
    }

    /* 4. Physical start button GPIO */
    {
        gpio_config_t io_conf = {
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
        };
        gpio_config(&io_conf);
    }

    /* 5. BLE server (starts advertising). */
    ble_server_init();

    /* 5. IMU + BLE stream task on Core 1. */
    ESP_ERROR_CHECK(imu_bluetooth_task_create(0, IMU_BLUETOOTH_TASK_PRIORITY, 1));

    lcd_display_show_dashboard(0, false, false, false);
    ESP_LOGI(TAG, "Booted OK — waiting for BLE connection");

    /* Poll touch at 50 Hz; redraw the dashboard at 5 Hz. */
    TickType_t last_wake = xTaskGetTickCount();
    uint8_t ui_ticks = 0;
    touch_debounce_state_t touch_state = {0};
    const uint8_t touch_press_debounce_samples = 2;
    /* Ignore short CST816S release glitches so one touch cannot re-arm START
     * in the middle of the completed browser capture/re-arm sequence. */
    const uint8_t touch_release_debounce_samples = 8;
    while (1) {
        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(20));

        cst816s_touch_t touch = {0};
        (void)cst816s_read(&touch);
        bool redraw_now = false;
        if (touch.valid) {
            touch_debounce_event_t touch_event = touch_debounce_update(
                &touch_state, touch.pressed,
                touch_press_debounce_samples, touch_release_debounce_samples);
            if (touch_event == TOUCH_DEBOUNCE_PRESSED) {
                lcd_touch_action_t action = lcd_display_hit_test(touch.x, touch.y);
                ESP_LOGI(TAG, "CST816S press at (%u,%u), action=%s",
                         touch.x, touch.y,
                         action == LCD_TOUCH_START_SHOT ? "START" : "none");
                if (action == LCD_TOUCH_START_SHOT) {
                    if (ble_server_request_shot_start()) {
                        ESP_LOGI(TAG, "Touch requested a browser shot cycle");
                        redraw_now = true;
                    } else {
                        ESP_LOGI(TAG, "START touch received but session is not ready or shot is busy");
                    }
                }
            }
        }

        if (++ui_ticks >= 10 || redraw_now) {
            ui_ticks = 0;
            ble_shot_state_t shot_state = ble_server_get_shot_state();
            lcd_display_show_dashboard(
                ble_server_is_connected() ? 1 : 0,
                ble_server_is_start_ready(),
                shot_state == BLE_SHOT_START_REQUESTED,
                shot_state == BLE_SHOT_IN_PROGRESS);
        }
    }
}
