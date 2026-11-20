# Stance reference and capture-window fixes

1. **VCQ-WEB-008 — Show the saved stance reference** · Priority: Medium · Status: In Progress
   - After calibration, show the stance as the session's neutral (0°) baseline and explain that shot sectors are relative to it; do not claim an absolute compass heading.
   - Validation: UI regression assertion for the confirmation text; hardware check that the modal reports the successful saved reference.
2. **VCQ-WEB-009 — Enforce the configured capture window** · Priority: High · Status: In Progress
   - Accept only notification timestamps in `[captureStart, captureStart + capture_window_ms)`, even if the browser timer is delayed. Keep the ESP32's 50 Hz stream cadence unchanged and visibly distinguish its config acknowledgement from that cadence.
   - Validation: 400/525/900 ms window-count tests, exact-boundary and delayed-timer cases, existing BLE config acknowledgement tests, full web suite.
