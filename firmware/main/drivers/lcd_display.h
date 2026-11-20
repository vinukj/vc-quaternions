/* Raw touch-operated dashboard for the GC9A01 240x240 LCD. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_lcd_panel_ops.h"

typedef enum {
    LCD_TOUCH_NONE = 0,
    LCD_TOUCH_START_SHOT,
} lcd_touch_action_t;

esp_err_t lcd_display_init(esp_lcd_panel_handle_t *panel_out);
void lcd_display_set_brightness(uint8_t pct);
void lcd_display_show_dashboard(uint8_t conn_state, bool start_enabled,
                                bool start_requested, bool shot_in_progress);
lcd_touch_action_t lcd_display_hit_test(uint16_t x, uint16_t y);
void lcd_display_show_message(const char *msg);
void lcd_display_clear(void);
void lcd_display_backlight_off(void);
void lcd_display_backlight_on(void);
