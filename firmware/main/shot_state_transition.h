#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
    SHOT_SENSOR_RESET_IDLE = 0,
    SHOT_SENSOR_RESET_PENDING,
    SHOT_SENSOR_RESET_COMPLETE,
    SHOT_SENSOR_RESET_FAILED,
};

static inline bool shot_state_enter(uint32_t *state, uint32_t next,
                                   uint32_t already_active)
{
    return __atomic_exchange_n(state, next, __ATOMIC_ACQ_REL) != already_active;
}

static inline bool shot_sensor_reset_request(uint32_t state,
                                             uint32_t in_progress,
                                             bool *requested,
                                             uint8_t *status)
{
    if (state != in_progress || requested == NULL || status == NULL ||
        *requested || *status == SHOT_SENSOR_RESET_PENDING) return false;
    *requested = true;
    *status = SHOT_SENSOR_RESET_PENDING;
    return true;
}

static inline void shot_sensor_reset_result(uint8_t *status, bool succeeded)
{
    if (status != NULL) {
        *status = succeeded ? SHOT_SENSOR_RESET_COMPLETE : SHOT_SENSOR_RESET_FAILED;
    }
}

static inline bool shot_state_clear_reference(uint32_t *state, uint8_t *status,
                                              bool *requested)
{
    if (state == NULL || status == NULL || requested == NULL ||
        *status == SHOT_SENSOR_RESET_PENDING) return false;
    __atomic_store_n(state, 0, __ATOMIC_RELEASE);
    *status = SHOT_SENSOR_RESET_IDLE;
    *requested = false;
    return true;
}

/* State byte 9 layout: bits 0..1 IMU reset status, bits 2..3 shot lifecycle,
 * bits 4..5 sampling-cadence code (sampcnt - 1, so 0..3 encode 1..4). */
static inline uint8_t shot_state_status_byte(uint32_t state, uint8_t reset_status)
{
    return (uint8_t)((reset_status & 0x03U) | ((state & 0x03U) << 2));
}

static inline uint8_t shot_state_pack_status(uint32_t state, uint8_t reset_status,
                                             uint8_t sampcnt)
{
    return (uint8_t)(shot_state_status_byte(state, reset_status) |
                     (((sampcnt - 1U) & 0x03U) << 4));
}

static inline uint8_t shot_state_decode_sampcnt(uint8_t status_byte)
{
    return (uint8_t)(((status_byte >> 4) & 0x03U) + 1U);
}

/* BLE notify divisor for a sampcnt code: 1 -> every 4th (50 Hz),
 * 2 -> every 3rd (~67 Hz), 3 -> every 2nd (100 Hz), 4 -> every sample (200 Hz). */
static inline uint8_t shot_state_sampcnt_to_skip(uint8_t sampcnt)
{
    switch (sampcnt) {
    case 2: return 3;
    case 3: return 2;
    case 4: return 1;
    default: return 4;
    }
}
