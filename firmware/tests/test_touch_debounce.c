#include "../main/drivers/touch_debounce.h"

#include <assert.h>
#include <stdio.h>

int main(void)
{
    touch_debounce_state_t state = {0};

    assert(touch_debounce_update(&state, true, 2, 8) == TOUCH_DEBOUNCE_NO_EDGE);
    assert(touch_debounce_update(&state, true, 2, 8) == TOUCH_DEBOUNCE_PRESSED);

    /* A brief false release from the touch controller must not re-arm START. */
    for (int sample = 0; sample < 4; sample++) {
        assert(touch_debounce_update(&state, false, 2, 8) == TOUCH_DEBOUNCE_NO_EDGE);
    }
    assert(touch_debounce_update(&state, true, 2, 8) == TOUCH_DEBOUNCE_NO_EDGE);
    assert(state.pressed);

    for (int sample = 0; sample < 7; sample++) {
        assert(touch_debounce_update(&state, false, 2, 8) == TOUCH_DEBOUNCE_NO_EDGE);
    }
    assert(touch_debounce_update(&state, false, 2, 8) == TOUCH_DEBOUNCE_RELEASED);
    assert(!state.pressed);

    assert(touch_debounce_update(&state, true, 2, 8) == TOUCH_DEBOUNCE_NO_EDGE);
    assert(touch_debounce_update(&state, true, 2, 8) == TOUCH_DEBOUNCE_PRESSED);
    puts("touch debounce tests passed");
    return 0;
}
