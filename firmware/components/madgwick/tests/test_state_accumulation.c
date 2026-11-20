#include "madgwick.h"

#include <assert.h>
#include <math.h>
#include <stdio.h>

int main(void)
{
    madgwick_state_t state;
    madgwick_quaternion_t output;
    madgwick_init(&state);

    const float dt_s = 0.005f;
    const float gyro_z_dps = 90.0f;
    for (int sample = 0; sample < 200; ++sample) {
        /* Level bat: gravity is aligned with the filter's Z-up frame. */
        assert(madgwick_updateIMU(&state, 0.0f, 0.0f, 1.0f,
                                 0.0f, 0.0f, gyro_z_dps,
                                 dt_s, &output));
        assert(isfinite(output.w) && isfinite(output.x));
        assert(isfinite(output.y) && isfinite(output.z));
    }

    const float expected = 0.70710678f;
    assert(fabsf(state.q.w - expected) < 0.01f);
    assert(fabsf(state.q.z - expected) < 0.01f);
    assert(fabsf(output.w - state.q.w) < 1e-6f);
    assert(fabsf(output.z - state.q.z) < 1e-6f);

    madgwick_quaternion_t before_invalid_update = state.q;
    assert(!madgwick_updateIMU(&state, NAN, 0.0f, 1.0f,
                               0.0f, 0.0f, 0.0f, dt_s, &output));
    assert(fabsf(state.q.w - before_invalid_update.w) < 1e-6f);
    assert(fabsf(state.q.z - before_invalid_update.z) < 1e-6f);

    puts("Madgwick stays finite at rest and accumulates orientation");
    return 0;
}
