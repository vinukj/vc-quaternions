#include "../main/shot_state_transition.h"

#include <assert.h>
#include <stdio.h>

int main(void)
{
    uint32_t state = 0; /* ready */

    assert(shot_state_enter(&state, 2, 2)); /* ready -> in progress */
    assert(state == 2);
    bool reset_requested = false;
    uint8_t reset_status = SHOT_SENSOR_RESET_IDLE;
    assert(reset_status == SHOT_SENSOR_RESET_IDLE); /* 0x08 only locks; it does not reset */
    assert(shot_state_status_byte(state, reset_status) == 8); /* in-progress, reset idle */
    assert(!shot_state_enter(&state, 2, 2)); /* duplicate BLE START */
    assert(state == 2);
    state = 1; /* LCD START requested */
    assert(shot_state_enter(&state, 2, 2));
    assert(state == 2);

    assert(shot_sensor_reset_request(state, 2, &reset_requested, &reset_status));
    assert(reset_status == SHOT_SENSOR_RESET_PENDING);
    assert(shot_state_status_byte(state, reset_status) == 9);
    assert(!shot_sensor_reset_request(state, 2, &reset_requested, &reset_status));
    shot_sensor_reset_result(&reset_status, true);
    assert(reset_status == SHOT_SENSOR_RESET_COMPLETE);
    assert(shot_state_status_byte(state, reset_status) == 10);
    assert(!shot_sensor_reset_request(0, 2, &reset_requested, &reset_status));
    assert(!shot_sensor_reset_request(state, 2, &reset_requested, &reset_status));
    assert(!shot_sensor_reset_request(state, 2, &reset_requested, &reset_status));

    /* A stance reset may leave COMPLETE; the next accepted 0x08 must clear
     * that previous reset before the shot's one 0x0A reset is requested. */
    state = 0;
    reset_status = SHOT_SENSOR_RESET_COMPLETE;
    reset_requested = true;
    assert(shot_state_enter(&state, 2, 2));
    reset_requested = false;
    reset_status = SHOT_SENSOR_RESET_IDLE;
    assert(shot_sensor_reset_request(state, 2, &reset_requested, &reset_status));
    shot_sensor_reset_result(&reset_status, false);
    assert(reset_status == SHOT_SENSOR_RESET_FAILED);
    assert(!shot_sensor_reset_request(state, 2, &reset_requested, &reset_status));

    /* Recalibration must recover a stale shot/reset latch without rebooting. */
    state = 2;
    reset_requested = true;
    reset_status = SHOT_SENSOR_RESET_COMPLETE;
    assert(shot_state_clear_reference(&state, &reset_status, &reset_requested));
    assert(state == 0);
    assert(reset_status == SHOT_SENSOR_RESET_IDLE);
    assert(!reset_requested);

    reset_status = SHOT_SENSOR_RESET_PENDING;
    reset_requested = true;
    state = 2;
    assert(!shot_state_clear_reference(&state, &reset_status, &reset_requested));
    assert(state == 2 && reset_status == SHOT_SENSOR_RESET_PENDING && reset_requested);

    /* Sampling cadence shares state byte 9: bits 4..5 carry sampcnt - 1. */
    for (uint8_t sampcnt = 1; sampcnt <= 4; sampcnt++) {
        uint8_t status = shot_state_pack_status(2, SHOT_SENSOR_RESET_IDLE, sampcnt);
        assert(shot_state_decode_sampcnt(status) == sampcnt);
        /* Low bits stay intact for reset status and shot lifecycle. */
        assert((status & 0x0FU) == shot_state_status_byte(2, SHOT_SENSOR_RESET_IDLE));
    }
    assert(shot_state_sampcnt_to_skip(1) == 4);
    assert(shot_state_sampcnt_to_skip(2) == 3);
    assert(shot_state_sampcnt_to_skip(3) == 2);
    assert(shot_state_sampcnt_to_skip(4) == 1);

    puts("shot reset transition tests passed");
    return 0;
}
