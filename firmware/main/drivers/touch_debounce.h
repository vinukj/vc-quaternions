/* Asymmetric debounce for the CST816S start-screen touch input. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    bool pressed;
    bool candidate;
    uint8_t candidate_samples;
} touch_debounce_state_t;

typedef enum {
    TOUCH_DEBOUNCE_NO_EDGE = 0,
    TOUCH_DEBOUNCE_PRESSED,
    TOUCH_DEBOUNCE_RELEASED,
} touch_debounce_event_t;

static inline touch_debounce_event_t touch_debounce_update(
    touch_debounce_state_t *state,
    bool sampled_pressed,
    uint8_t press_samples,
    uint8_t release_samples)
{
    if (state == NULL || press_samples == 0 || release_samples == 0) {
        return TOUCH_DEBOUNCE_NO_EDGE;
    }

    if (sampled_pressed == state->candidate) {
        const uint8_t limit = state->candidate ? press_samples : release_samples;
        if (state->candidate_samples < limit) state->candidate_samples++;
    } else {
        state->candidate = sampled_pressed;
        state->candidate_samples = 1;
    }

    const uint8_t required_samples = state->candidate ? press_samples : release_samples;
    if (state->candidate_samples < required_samples || state->pressed == state->candidate) {
        return TOUCH_DEBOUNCE_NO_EDGE;
    }

    state->pressed = state->candidate;
    return state->pressed ? TOUCH_DEBOUNCE_PRESSED : TOUCH_DEBOUNCE_RELEASED;
}
