/* Raw framebuffer UI for the Waveshare GC9A01 round LCD. */
#include "lcd_display.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_gc9a01.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define TAG "LCD"
#define LCD_HOST SPI2_HOST
#define LCD_CLK_HZ (40 * 1000 * 1000)
#define LCD_CS 9
#define LCD_DC 8
#define LCD_RST 14
#define LCD_SCLK 10
#define LCD_MOSI 11
#define LCD_BL 2
#define LCD_WIDTH 240
#define LCD_HEIGHT 240
#define FRAME_BYTES (LCD_WIDTH * LCD_HEIGHT * sizeof(uint16_t))
#define FLUSH_ROWS 80 /* 38,400 bytes, below the configured 48 KiB SPI limit. */

#define LEDC_TIMER LEDC_TIMER_0
#define LEDC_CHANNEL LEDC_CHANNEL_0
#define LEDC_MODE LEDC_LOW_SPEED_MODE
#define LEDC_DUTY_RES LEDC_TIMER_10_BIT
#define LEDC_FREQ_HZ 5000

#define C_BLACK 0x0000
#define C_WHITE 0xFFFF
#define C_GREEN 0x07E0
#define C_ORANGE 0xFDA0
#define C_RED 0xF800
#define C_BLUE 0x4D7F
#define C_BG 0x0841
#define C_PANEL 0x18E3
#define C_BORDER 0x39E7

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_panel_io;
static SemaphoreHandle_t s_flush_done;
static uint16_t *s_frame;
static uint8_t s_brightness = 100;

static void lcd_backlight_set(uint8_t pct)
{
    if (pct > 100) pct = 100;
    ESP_ERROR_CHECK(ledc_set_duty(LEDC_MODE, LEDC_CHANNEL,
                                  (uint32_t)pct * 1023 / 100));
    ESP_ERROR_CHECK(ledc_update_duty(LEDC_MODE, LEDC_CHANNEL));
    s_brightness = pct;
}

static void lcd_backlight_init(void)
{
    const ledc_timer_config_t timer = {
        .speed_mode = LEDC_MODE,
        .timer_num = LEDC_TIMER,
        .duty_resolution = LEDC_DUTY_RES,
        .freq_hz = LEDC_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));
    const ledc_channel_config_t channel = {
        .gpio_num = LCD_BL,
        .speed_mode = LEDC_MODE,
        .channel = LEDC_CHANNEL,
        .timer_sel = LEDC_TIMER,
        .duty = 1023,
        .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&channel));
}

static const gc9a01_lcd_init_cmd_t s_vendor_init_cmds[] = {
    {0xEF, (uint8_t[]){0x00}, 1, 0}, {0xEB, (uint8_t[]){0x14}, 1, 0},
    {0xFE, (uint8_t[]){0x00}, 0, 0}, {0xEF, (uint8_t[]){0x00}, 0, 0},
    {0xEB, (uint8_t[]){0x14}, 1, 0}, {0x84, (uint8_t[]){0x40}, 1, 0},
    {0x85, (uint8_t[]){0xFF}, 1, 0}, {0x86, (uint8_t[]){0xFF}, 1, 0},
    {0x87, (uint8_t[]){0xFF}, 1, 0}, {0x88, (uint8_t[]){0x0A}, 1, 0},
    {0x89, (uint8_t[]){0x21}, 1, 0}, {0x8A, (uint8_t[]){0x00}, 1, 0},
    {0x8B, (uint8_t[]){0x80}, 1, 0}, {0x8C, (uint8_t[]){0x01}, 1, 0},
    {0x8D, (uint8_t[]){0x01}, 1, 0}, {0x8E, (uint8_t[]){0xFF}, 1, 0},
    {0x8F, (uint8_t[]){0xFF}, 1, 0}, {0xB6, (uint8_t[]){0x00, 0x20}, 2, 0},
    {0x3A, (uint8_t[]){0x05}, 1, 0},
    {0x90, (uint8_t[]){0x08, 0x08, 0x08, 0x08}, 4, 0},
    {0xBD, (uint8_t[]){0x06}, 1, 0}, {0xBC, (uint8_t[]){0x00}, 1, 0},
    {0xFF, (uint8_t[]){0x60, 0x01, 0x04}, 3, 0},
    {0xC3, (uint8_t[]){0x13}, 1, 0}, {0xC4, (uint8_t[]){0x13}, 1, 0},
    {0xC9, (uint8_t[]){0x22}, 1, 0}, {0xBE, (uint8_t[]){0x11}, 1, 0},
    {0xE1, (uint8_t[]){0x10, 0x0E}, 2, 0},
    {0xDF, (uint8_t[]){0x21, 0x0C, 0x02}, 3, 0},
    {0xF0, (uint8_t[]){0x45, 0x09, 0x08, 0x08, 0x26, 0x2A}, 6, 0},
    {0xF1, (uint8_t[]){0x43, 0x70, 0x72, 0x36, 0x37, 0x6F}, 6, 0},
    {0xF2, (uint8_t[]){0x45, 0x09, 0x08, 0x08, 0x26, 0x2A}, 6, 0},
    {0xF3, (uint8_t[]){0x43, 0x70, 0x72, 0x36, 0x37, 0x6F}, 6, 0},
    {0xED, (uint8_t[]){0x1B, 0x0B}, 2, 0}, {0xAE, (uint8_t[]){0x77}, 1, 0},
    {0xCD, (uint8_t[]){0x63}, 1, 0},
    {0x70, (uint8_t[]){0x07, 0x07, 0x04, 0x0E, 0x0F, 0x09, 0x07, 0x08, 0x03}, 9, 0},
    {0xE8, (uint8_t[]){0x34}, 1, 0},
    {0x62, (uint8_t[]){0x18, 0x0D, 0x71, 0xED, 0x70, 0x70, 0x18, 0x0F, 0x71, 0xEF, 0x70, 0x70}, 12, 0},
    {0x63, (uint8_t[]){0x18, 0x11, 0x71, 0xF1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xF3, 0x70, 0x70}, 12, 0},
    {0x64, (uint8_t[]){0x28, 0x29, 0xF1, 0x01, 0xF1, 0x00, 0x07}, 7, 0},
    {0x66, (uint8_t[]){0x3C, 0x00, 0xCD, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00}, 10, 0},
    {0x67, (uint8_t[]){0x00, 0x3C, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98}, 10, 0},
    {0x74, (uint8_t[]){0x10, 0x85, 0x80, 0x00, 0x00, 0x4E, 0x00}, 7, 0},
    {0x98, (uint8_t[]){0x3E, 0x07}, 2, 0}, {0x35, (uint8_t[]){0x00}, 0, 0},
    {0x11, (uint8_t[]){0x00}, 0, 120}, {0x21, (uint8_t[]){0x00}, 0, 0},
    {0x29, (uint8_t[]){0x00}, 0, 20},
};

static bool lcd_color_done(esp_lcd_panel_io_handle_t io,
                           esp_lcd_panel_io_event_data_t *event, void *ctx)
{
    (void)io;
    (void)event;
    (void)ctx;
    BaseType_t higher_priority_woken = pdFALSE;
    xSemaphoreGiveFromISR(s_flush_done, &higher_priority_woken);
    return higher_priority_woken == pdTRUE;
}

esp_err_t lcd_display_init(esp_lcd_panel_handle_t *panel_out)
{
    if (panel_out == NULL) return ESP_ERR_INVALID_ARG;
    s_flush_done = xSemaphoreCreateBinary();
    if (s_flush_done == NULL) return ESP_ERR_NO_MEM;
    s_frame = heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (s_frame == NULL) return ESP_ERR_NO_MEM;
    lcd_backlight_init();
    lcd_backlight_set(s_brightness);

    const spi_bus_config_t bus_config = {
        .sclk_io_num = LCD_SCLK, .mosi_io_num = LCD_MOSI, .miso_io_num = -1,
        .quadwp_io_num = -1, .quadhd_io_num = -1,
        .max_transfer_sz = 48 * 1024,
    };
    esp_err_t err = spi_bus_initialize(LCD_HOST, &bus_config, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) return err;

    const esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = LCD_DC, .cs_gpio_num = LCD_CS, .pclk_hz = LCD_CLK_HZ,
        .lcd_cmd_bits = 8, .lcd_param_bits = 8, .spi_mode = 0,
        .trans_queue_depth = 2, .on_color_trans_done = lcd_color_done,
    };
    err = esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST,
                                   &io_config, &s_panel_io);
    if (err != ESP_OK) return err;

    const gc9a01_vendor_config_t vendor_config = {
        .init_cmds = s_vendor_init_cmds,
        .init_cmds_size = sizeof(s_vendor_init_cmds) / sizeof(s_vendor_init_cmds[0]),
    };
    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
        .vendor_config = (void *)&vendor_config,
    };
    err = esp_lcd_new_panel_gc9a01(s_panel_io, &panel_config, panel_out);
    if (err != ESP_OK) return err;
    ESP_ERROR_CHECK(esp_lcd_panel_reset(*panel_out));
    ESP_ERROR_CHECK(esp_lcd_panel_init(*panel_out));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(*panel_out, true));
    s_panel = *panel_out;
    ESP_LOGI(TAG, "GC9A01 raw UI ready (240x240, touch enabled by app)");
    return ESP_OK;
}

void lcd_display_set_brightness(uint8_t pct) { lcd_backlight_set(pct); }

void lcd_display_backlight_off(void)
{
    if (s_panel) ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, false));
    lcd_backlight_set(0);
}

void lcd_display_backlight_on(void)
{
    if (s_panel) ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));
    lcd_backlight_set(s_brightness);
}

static void fill_rect(int x, int y, int w, int h, uint16_t color)
{
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > LCD_WIDTH) w = LCD_WIDTH - x;
    if (y + h > LCD_HEIGHT) h = LCD_HEIGHT - y;
    if (w <= 0 || h <= 0) return;
    for (int row = y; row < y + h; row++) {
        uint16_t *dst = &s_frame[row * LCD_WIDTH + x];
        for (int col = 0; col < w; col++) dst[col] = color;
    }
}

static void draw_round_rect(int x, int y, int w, int h,
                            uint16_t fill, uint16_t border)
{
    fill_rect(x, y, w, h, border);
    fill_rect(x + 1, y + 1, w - 2, h - 2, fill);
}

/* 5x7 glyph columns: space, A-Z, 0-9, colon, dash, percent. */
static const uint8_t s_font[][5] = {
    {0,0,0,0,0},
    {0x7E,0x11,0x11,0x11,0x7E}, {0x7F,0x49,0x49,0x49,0x36},
    {0x3E,0x41,0x41,0x41,0x22}, {0x7F,0x41,0x41,0x22,0x1C},
    {0x7F,0x49,0x49,0x49,0x41}, {0x7F,0x09,0x09,0x09,0x01},
    {0x3E,0x41,0x49,0x49,0x7A}, {0x7F,0x08,0x08,0x08,0x7F},
    {0x00,0x41,0x7F,0x41,0x00}, {0x20,0x40,0x41,0x3F,0x01},
    {0x7F,0x08,0x14,0x22,0x41}, {0x7F,0x40,0x40,0x40,0x40},
    {0x7F,0x02,0x0C,0x02,0x7F}, {0x7F,0x04,0x08,0x10,0x7F},
    {0x3E,0x41,0x41,0x41,0x3E}, {0x7F,0x09,0x09,0x09,0x06},
    {0x3E,0x41,0x51,0x21,0x5E}, {0x7F,0x09,0x19,0x29,0x46},
    {0x46,0x49,0x49,0x49,0x31}, {0x01,0x01,0x7F,0x01,0x01},
    {0x3F,0x40,0x40,0x40,0x3F}, {0x1F,0x20,0x40,0x20,0x1F},
    {0x3F,0x40,0x38,0x40,0x3F}, {0x63,0x14,0x08,0x14,0x63},
    {0x07,0x08,0x70,0x08,0x07}, {0x61,0x51,0x49,0x45,0x43},
    {0x3E,0x51,0x49,0x45,0x3E}, {0x00,0x42,0x7F,0x40,0x00},
    {0x42,0x61,0x51,0x49,0x46}, {0x21,0x41,0x45,0x4B,0x31},
    {0x18,0x14,0x12,0x7F,0x10}, {0x27,0x45,0x45,0x45,0x39},
    {0x3C,0x4A,0x49,0x49,0x30}, {0x01,0x71,0x09,0x05,0x03},
    {0x36,0x49,0x49,0x49,0x36}, {0x06,0x49,0x49,0x29,0x1E},
    {0x00,0x36,0x36,0x00,0x00}, {0x08,0x08,0x08,0x08,0x08},
    {0x63,0x13,0x08,0x64,0x63},
};

static const uint8_t *glyph_for(char ch)
{
    if (ch == ' ') return s_font[0];
    if (ch >= 'A' && ch <= 'Z') return s_font[1 + ch - 'A'];
    if (ch >= '0' && ch <= '9') return s_font[27 + ch - '0'];
    if (ch == ':') return s_font[37];
    if (ch == '-') return s_font[38];
    if (ch == '%') return s_font[39];
    return s_font[0];
}

static void draw_text(int x, int y, const char *text, uint16_t color, int scale)
{
    if (text == NULL) return;
    for (const char *ch = text; *ch; ch++, x += 6 * scale) {
        const uint8_t *glyph = glyph_for(*ch);
        for (int col = 0; col < 5; col++) {
            for (int row = 0; row < 7; row++) {
                if ((glyph[col] & (1U << row)) == 0) continue;
                fill_rect(x + col * scale, y + row * scale, scale, scale, color);
            }
        }
    }
}

static void draw_centered_text(int center_x, int y, const char *text,
                               uint16_t color, int scale)
{
    int width = (int)strlen(text) * 6 * scale - scale;
    draw_text(center_x - width / 2, y, text, color, scale);
}

static void flush_frame(void)
{
    if (s_panel == NULL || s_frame == NULL) return;
    for (int y = 0; y < LCD_HEIGHT; y += FLUSH_ROWS) {
        int rows = (y + FLUSH_ROWS <= LCD_HEIGHT) ? FLUSH_ROWS : LCD_HEIGHT - y;
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(s_panel, 0, y, LCD_WIDTH,
                                                   y + rows,
                                                   &s_frame[y * LCD_WIDTH]));
        /* Keep each DMA source stable until its transaction completes. */
        if (xSemaphoreTake(s_flush_done, pdMS_TO_TICKS(250)) != pdTRUE)
            ESP_LOGE(TAG, "LCD DMA completion timed out at row %d", y);
    }
}

void lcd_display_show_dashboard(uint8_t conn_state, bool start_enabled,
                                bool start_requested, bool shot_in_progress)
{
    if (s_panel == NULL || s_frame == NULL) return;
    for (int i = 0; i < LCD_WIDTH * LCD_HEIGHT; i++) s_frame[i] = C_BG;

    draw_centered_text(120, 45, "BAT TRACKER", C_WHITE, 1);

    if (conn_state != 1) {
        uint16_t status_color = conn_state == 2 ? C_RED : C_ORANGE;
        fill_rect(57, 78, 7, 7, status_color);
        draw_centered_text(126, 78,
                           conn_state == 2 ? "BLE ERROR" : "WAITING FOR BLE",
                           status_color, 1);
        draw_centered_text(120, 109, "CONNECT IN WEB", C_WHITE, 1);
        draw_round_rect(40, 143, 160, 48, C_PANEL, C_BORDER);
        draw_centered_text(120, 163, "NOT CONNECTED", C_WHITE, 1);
    } else {
        fill_rect(57, 78, 7, 7, C_GREEN);
        draw_centered_text(126, 78, "BLE CONNECTED", C_GREEN, 1);
        const char *state_text = start_enabled ? "READY"
            : start_requested ? "STARTING"
            : shot_in_progress ? "SHOT RUNNING" : "SETUP IN WEB UI";
        uint16_t state_color = start_enabled ? C_GREEN
            : (start_requested || shot_in_progress || conn_state == 1) ? C_ORANGE : C_WHITE;
        draw_centered_text(120, 105, state_text, state_color, 1);
        draw_round_rect(40, 143, 160, 48,
                        start_enabled ? 0x1430 : 0x18E3,
                        start_enabled ? C_GREEN : C_BORDER);
        draw_centered_text(120, 163,
                           start_enabled ? "START"
                               : start_requested ? "SENT" : "SETUP",
                           start_enabled ? C_WHITE : C_BORDER, 2);
    }
    flush_frame();
}

lcd_touch_action_t lcd_display_hit_test(uint16_t x, uint16_t y)
{
    if (x >= 40 && x < 200 && y >= 143 && y < 191)
        return LCD_TOUCH_START_SHOT;
    return LCD_TOUCH_NONE;
}

void lcd_display_show_message(const char *msg)
{
    if (s_frame == NULL || s_panel == NULL || msg == NULL) return;
    for (int i = 0; i < LCD_WIDTH * LCD_HEIGHT; i++) s_frame[i] = C_BG;
    draw_centered_text(120, 112, msg, C_GREEN, 2);
    flush_frame();
}

void lcd_display_clear(void)
{
    if (s_frame == NULL || s_panel == NULL) return;
    for (int i = 0; i < LCD_WIDTH * LCD_HEIGHT; i++) s_frame[i] = C_BLACK;
    flush_frame();
}
