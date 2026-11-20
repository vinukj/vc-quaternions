# BLE Session Setup Fix — 2026-11-17

1. **BLE-1 — Synchronize and verify game configuration** — Priority: High — Status: Complete
   - On connect and every config edit, send a versioned config frame and verify the exact sequence and values from the ESP32 state characteristic.
   - Do not enable shot start while config is stale, rejected, or unverified.
2. **BLE-2 — Require explicit three-second stance calibration** — Priority: High — Status: Complete
   - Start calibration only from “Take Stance · 3 s”; require a continuous stable IMU hold, clear the old firmware guard, set a new one, and verify the reported quaternion.
   - Keep the confirmed stance for the BLE session; invalidate on disconnect/reconnect and cancel pending calibration.
3. **BLE-3 — Gate web and ESP32 START on session readiness** — Priority: High — Status: Complete
   - Remove implicit guard capture from tracker and shot-start paths; both browser and LCD start must require verified config and stance.
   - Keep configured shot capture duration in the browser; do not move game-outcome calculations to firmware.
4. **BLE-4 — Regression tests and fix record** — Priority: High — Status: Complete
   - Add state/config/calibration/readiness regression coverage, correct stale shot-practice and stance tests, run the full browser test suite, and document boundary cases.
5. **BLE-5 — Clean firmware build, flash, and web relaunch** — Priority: High — Status: Complete
   - Confirm the connected ESP32 serial target immediately before a clean ESP-IDF build/flash, verify completion, and reopen `http://localhost:8765/?airmouse=1`.
   - Completed 2026-11-18: clean ESP-IDF 6.0 build for ESP32-S3 succeeded; detected and flashed the board at `/dev/cu.wchusbserial585A0867631` (MAC `74:4d:bd:2c:97:50`); bootloader, partition table, and app image hashes verified by esptool; the local UI returned HTTP 200 and was reopened in Edge.

## Scope and regression boundaries

- Expected: connect → config acknowledged → explicit stable stance for three seconds → START enabled; each shot uses the selected browser capture window.
- Previously observed: connection enables controls before config acknowledgement; START/tracker can silently capture guard; config edits are not sent; disconnect/reconnect can leave stale UI assumptions.
- Device writes are authorized by the user's explicit approval in this task. No unrelated device state or project files should be removed.
- Human validation still required: connect to the bat, change config and confirm acknowledgement, calibrate once, start from both UI and LCD, then disconnect/reconnect and confirm setup is required again. Flash verification confirms bytes written, not live BLE/UI behavior; visual browser inspection was unavailable because the browser access host was unavailable.
