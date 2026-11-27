# Bug fixes

## 2026-11-26 — Configurable BLE sampling cadence and consistent "Behind batter" zone

**Bug ID**: VCQ-BLE-010  
**Description**: The BLE quaternion stream was hard-wired to 50 Hz, the broad field zone behind the batter read "Behind wicket" while the detailed sector read "Behind batter", and the recurring per-packet stream log was noisy at INFO.  
**Root Cause**: The IMU task decimated with a fixed `NOTIFY_SKIP 4`, there was no command to change it, the wagon-wheel broad-zone map aliased the "Behind batter" sector to "Behind wicket", and the periodic stream counter logged at INFO.  
**Fix Applied**: Added a dedicated two-byte command `[0x0B, sampcnt]` (sampcnt 1–4 → every 4th/3rd/2nd/1st 200 Hz sample = 50/67/100/200 Hz; values outside 1–4 rejected). IMU fusion stays at 200 Hz; only the notify cadence changes. The selected code is echoed in state byte 9 bits 4–5 and the browser reads it back before enabling START. The browser game config gains a 50/67/100/200 Hz selector, sends the cadence through the serialized command queue, verifies the readback, invalidates the saved batting stance on a cadence change while keeping the separate bat-orientation reference, and derives classifier timing/gap/sample-count diagnostics from the configured rate instead of assuming 50 Hz. The broad zone for the "Behind batter" sector now reads "Behind batter" so sector, broad zone, and direction agree. The recurring "BLE stream … packets sent" log is downgraded to DEBUG; connection, command, reset, and error logs are unchanged.  
**Areas Addressed**: Firmware BLE command/state protocol, IMU-task decimation and logging, browser game config/setup/diagnostics, wagon-wheel broad zone, docs.  
**Tests Added/Updated**: `firmware/tests/test_shot_state_transition.c` covers cadence pack/decode and divisor mapping; `web/tests/device-config.test.js` covers cadence decode and rate mapping; `ble-session-setup.test.js` covers cadence readback verification, all four divisors, stance invalidation with orientation retention, and rejection paths; `shot-classifier.test.js` covers cadence-aware angular speed; `wagon-wheel.test.js` and `shot-report.test.js` expect the "Behind batter" broad zone; `page-startup.test.js` covers the cadence selector and readback-gated START.  
**Boundary Validations**: sampcnt outside 1–4 is rejected by firmware and browser; START stays locked until the cadence readback matches; a cadence change never discards the bat-orientation reference; the 26-byte state frame and 17-byte notify payload are unchanged.  
**HITL Required**: Yes — clean ESP-IDF build, flash the rebuilt firmware, confirm the cadence readback in the UI, and verify shots at each cadence without BLE disconnect.  
**Regression Risk**: Low–Medium; the state byte 9 contract and notify cadence are shared by web and firmware, but the wire layout is otherwise unchanged.

## 2026-11-26 — Clear the stance-reset latch when a new shot is accepted

**Bug ID**: VCQ-BLE-009  
**Description**: After orientation/stance setup, the browser could display START while the ESP32 stayed on SETUP; the next shot's `0x0A` IMU reset could be rejected immediately, leaving both sides out of sync.  
**Root Cause**: Saving the stance (`0x03`) resets the IMU and can leave the firmware reset status at COMPLETE. The older `0x08` shot-accepted path changed the shot state but did not clear that previous reset status/latch, so the next `0x0A` was rejected as a duplicate/completed reset. The browser also treated its local setup flags as sufficient without checking the firmware shot state.  
**Fix Applied**: On a successful new `0x08` transition, clear per-shot reset status and its accepted latch before accepting the next `0x0A`; `0x04` now re-arms READY and clears stale setup state, unless an IMU reset is still pending. Browser orientation/stance setup reads back and requires firmware READY before enabling START. Rejection logs now include shot state, reset status, and the accepted latch to distinguish the cause.  
**Areas Addressed**: Firmware BLE shot lifecycle, setup readback, browser START readiness, diagnostics.  
**Tests Added/Updated**: `web/tests/ble-session-setup.test.js` models a device that leaves READY while stance is saved; `firmware/tests/test_shot_state_transition.c` covers clearing a completed stance-reset latch before the next shot reset.  
**Boundary Validations**: Duplicate `0x08` does not clear an active shot reset; `0x0A` remains limited to one reset during an active shot; `0x04` cannot re-arm while reset is pending; the browser rejects READY when firmware readback disagrees.  
**HITL Required**: Yes — flash the rebuilt firmware, complete orientation and stance, verify the LCD returns to START, then perform at least three shots without disconnecting. Expected logs per shot: `CMD 0x08 Shot in progress; reset latch cleared`, `CMD 0x0A IMU-only reset requested before countdown`, and one QMI8658 reset completion.  
**Regression Risk**: Medium; the browser and firmware must share the existing 26-byte state-frame layout. No BLE connection, quaternion payload, game-config format, or saved stance quaternion changes.

## 2026-11-25 — Reset IMU before countdown and re-arm LCD START

**Bug ID**: VCQ-BLE-008  
**Description**: After the first shot, the ESP32 could remain on SETUP instead of START; the browser also failed to confirm per-shot IMU reset. The shot-accepted command and the sensor reset need separate acknowledgements so countdown never starts before the reset completes.  
**Root Cause**: Firmware reset the QMI8658 on `0x08`, did not implement the browser's `0x0A` reset command, left state byte 9 unused despite the browser decoding reset/shot status there, and the UI's READY check could not validate firmware state.  
**Fix Applied**: `0x08` now only locks the shot state; `0x0A` queues exactly one QMI8658-only reset while a shot is active. The IMU-owner task reports success/failure, firmware packs reset status and shot state into byte 9, and `0x09` returns the LCD to READY while clearing per-shot reset status. The browser waits for reset completion before capture and verifies READY before accepting another LCD START. BLE connection, notification packet, and saved session stance are unchanged.  
**Areas Addressed**: Browser shot lifecycle, BLE command/state protocol, IMU-task reset acknowledgement, LCD re-arm.  
**Tests Added/Updated**: Focused browser tests verify pre-countdown reset acknowledgement and READY readback; `firmware/tests/test_shot_state_transition.c` verifies reset status transitions and state-byte encoding.  
**Boundary Validations**: Reset outside an active shot is rejected; duplicate reset commands are rejected; failed reset can be retried on a subsequent attempt; only the IMU task touches sensor I²C; `0x08` does not reset; `0x09` state readback remains the readiness gate.  
**HITL Required**: Yes — on the ESP32, verify LCD returns to START after one result, repeat at least three starts without BLE disconnect, and confirm logs show one `CMD 0x0A` plus one sensor reset completion before each countdown.  
**Regression Risk**: Medium; web and firmware require the matching state-byte contract. The existing 26-byte state frame and 17-byte quaternion notification payload remain unchanged.

## 2026-11-23 — Separate bat orientation and batting stance setup in the browser

**Bug ID**: VCQ-WEB-011  
**Description**: The browser had no distinct bat-orientation action/status, BLE samples and dialog cancellation called nonexistent setup methods, and shot CSV exports omitted the orientation quaternion.  
**Root Cause**: UI method names drifted from `BleSessionSetup` exports; orientation calibration was implemented in the session module but was not exposed in the page flow or per-shot export.  
**Fix Applied**: Add separate 3-second bat-orientation and batting-stance controls, show both session states beneath the wagon-wheel map, require orientation before stance, reuse the calibration dialog, and call the module's exported sample/cancel APIs. Store orientation per history row in `orientation_reference_json` while preserving the stance meaning of `guard_reference_json`. UI text clarifies that orientation is retained separately and does not currently alter classifier direction math.  
**Areas Addressed**: Browser setup flow, BLE calibration sample/cancel wiring, shot-history CSV.  
**Tests Added/Updated**: `web/tests/page-startup.test.js` covers separate actions/statuses and API wiring; `web/tests/shot-history.test.js` verifies independent immutable stance/orientation snapshots and CSV columns.  
**Boundary Validations**: Stance remains disabled until orientation exists; retaking orientation invalidates the session stance; cancellation uses the actual setup API; both quaternion snapshots remain separate in each CSV row.  
**HITL Required**: Yes — connect the mounted ESP32, capture the straight-down-pitch orientation, then capture a normal stance, cancel each operation once, and verify shot start plus downloaded CSV on real BLE data.  
**Regression Risk**: Low to medium; setup now intentionally blocks stance and START until both captures are complete. Hardware capture stability and physical 0° alignment still require manual validation.

## 2026-11-23 — Reset only the IMU between stance and shot captures

**Bug ID**: VCQ-IMU-010  
**Description**: Sensor reset was requested after stance and at each new shot, but reset must not reboot the ESP32 or drop BLE; repeated `0x08` acknowledgements must not interrupt an active capture.  
**Root Cause**: The existing QMI8658 reset helper was not connected to these lifecycle events, and configuration writes inside the helper used `ESP_ERROR_CHECK`, which could reboot the MCU on an I²C error.  
**Fix Applied**: Queue reset requests from BLE handling and execute them only on the IMU task that owns I²C. Reset after a successfully captured stance and once when entering shot-in-progress; ignore duplicate busy acknowledgements while already in progress. Clear transient sample/swing state and skip a post-reset fusion pass, while preserving the ESP32, BLE connection, saved stance quaternion, Madgwick filter frame, and cumulative swing diagnostics. Propagate QMI configuration errors instead of aborting. Clarify that soft reset is not gyro-bias calibration and cannot eliminate 6-axis yaw drift.  
**Areas Addressed**: Firmware BLE state transition, IMU task ownership, QMI8658 reset error handling, documentation.  
**Tests Added**: `firmware/tests/test_shot_state_transition.c` checks one reset-triggering transition into shot-in-progress and no repeated reset trigger for duplicate acknowledgements.  
**Boundary Validations**: Failed stance capture does not queue a reset; duplicate `0x08` during a shot does not reset the sensor; sensor reset failure is logged and returned without an MCU restart; only the IMU-owned task accesses QMI I²C for these resets.  
**HITL Required**: Yes — verify BLE remains connected and notifications resume after stance and shot-start resets, confirm the stored stance remains fixed through several shots, and inspect serial logs for reset completion/errors.  
**Regression Risk**: Medium; sensor output pauses for approximately 30 ms per reset and one fusion iteration is skipped. Soft reset is not a gyro calibration, so pre-existing gyro bias/yaw drift may persist.

## 2026-11-14 — NimBLE rejected the readable quaternion characteristic

**Bug ID**: VCQ-BLE-001  
**Description**: Firmware restarted during BLE startup before advertising.  
**Root Cause**: The quaternion characteristic declared READ and NOTIFY properties but omitted the mandatory NimBLE GATT access callback, so `ble_gatts_count_cfg()` returned `BLE_HS_EINVAL` (3).  
**Fix Applied**: Added a read callback that returns the most recent complete 17-byte packet under the existing mutex and rejects unsupported access operations. The packet wire format is unchanged.  
**Areas Addressed**: BLE service configuration and read path.  
**Tests Added**: None; the failure is at NimBLE service registration and requires the target stack for direct validation.  
**Boundary Validations**: Read before a stream is safe because host sync pre-seeds the packet with an identity quaternion; mutex failure and mbuf allocation failure return ATT errors.  
**HITL Required**: Yes — boot the board, confirm advertising and sensor initialization, then connect from Edge and verify notifications and command writes.  
**Regression Risk**: Low; the change only supplies the callback required for the already-declared READ property and preserves the 17-byte payload.

## 2026-11-14 — NimBLE sync callback dereferenced a null address-type pointer

**Bug ID**: VCQ-BLE-002  
**Description**: After GATT registration was fixed, the device panicked at BLE host sync and rebooted continuously.  
**Root Cause**: `ble_hs_id_infer_auto()` requires a writable output pointer; passing `NULL` caused a StoreProhibited exception inside NimBLE.  
**Fix Applied**: Store the inferred own-address type and pass it to `ble_gap_adv_start()` rather than hard-coding the public-address type.  
**Areas Addressed**: BLE host synchronization and advertising configuration.  
**Tests Added**: None; validation is on the ESP32-S3 against the bundled ESP-IDF NimBLE stack.  
**Boundary Validations**: NimBLE inference errors continue to log and restart rather than advertising with an uninitialized address type.  
**HITL Required**: Yes — confirm startup, advertising, connection, notification delivery, and command writes on the physical board.  
**Regression Risk**: Low; this follows the target ESP-IDF API contract and the working reference implementation.

## 2026-11-16 — One physical START touch could produce repeated shot captures

**Bug ID**: VCQ-SHOT-003  
**Description**: A single physical touch could appear as many one-second shot-history entries. Each entry is one complete capture window; its sensor packets are already aggregated into one analysis result.  
**Root Cause**: The LCD accepted both touch press and release after only two 20 ms samples. Brief release glitches from the CST816S could therefore re-arm START, and a subsequent pressed sample could trigger another browser cycle.  
**Fix Applied**: Kept the responsive 40 ms press debounce and required 8 stable samples (160 ms) before recognizing release. Short release glitches no longer emit a fresh press edge.  
**Areas Addressed**: Firmware touchscreen input and one-capture/one-history behavior.  
**Tests Added**: `firmware/tests/test_touch_debounce.c` covers brief release glitches, stable release, and a subsequent intentional press; `web/tests/shot-practice.test.js` verifies 50 packets in one capture produce one result.  
**Boundary Validations**: Invalid touch reads do not advance debounce state; release glitches shorter than 160 ms are ignored; a stable release followed by a 40 ms press is accepted.  
**HITL Required**: Yes — on the ESP32, make one quick touch, wait through a full capture, and verify exactly one history entry; then repeat a deliberate second touch and verify a second entry. Exercise a real swing and confirm rotation is nonzero.  
**Regression Risk**: Low; release recognition is delayed by 120 ms more than press recognition, while touch polling and shot-state handling are unchanged.

## 2026-11-17 — Wagon-wheel sector, arrow, and shot labels disagreed

**Bug ID**: VCQ-SHOT-004  
**Description**: The arrow, highlighted sector, shot-name, report/history, or CSV could disagree (including Fine Leg vs Square Leg and Cover vs Straight). History also needed a way to discard prior in-session shots.  
**Root Cause**: UI surfaces retained classifier labels while the wagon wheel separately derived its direction and selected sector from the bat-motion vector; the drawn arrow endpoint was not guaranteed to use the exact selected wedge angle.  
**Fix Applied**: Use `WagonWheel.shotGeometry()` as the canonical result geometry for direction, sector, side, shot family, and direction-specific candidate strokes. Feed it to the track map, shot name, accessibility/report/history and CSV primary columns; snap completed-shot arrows to the selected field-sector angle. Keep original classifier outputs only as explicit CSV diagnostic fields. Add accessible clear-history UI behavior which removes in-memory/exported shots, clears the rendered list, disables actions when empty, and restarts numbering. Align Cover/Mid-on family wording between classifier and map.  
**Areas Addressed**: Browser UI, canvas rendering, shot-history state, CSV serialization, classifier labels and direction-specific heuristic presentation.  
**Tests Added**: `web/tests/wagon-wheel.test.js` verifies workbook direction-sector examples, all eight candidate lists and wedge/arrow alignment; `web/tests/shot-classifier.test.js` checks classifier/map family agreement for Cover and Mid-on; `web/tests/shot-history.test.js` checks clear/reset, canonical display/CSV columns and preserved diagnostics; `web/tests/page-startup.test.js` checks clear/download controls are wired and disabled for empty history.  
**Boundary Validations**: Missing/unclear movement does not create a stale arrow; left-handed sector mapping remains mirrored; sparse or dispersed motion lowers consistency; equally strong reversals remain ambiguous; spreadsheet formula-like text remains neutralized in CSV. Workbook rows 2–8 yielded 4/7 estimates matching the C:F reference after normalizing case/wording; two Square-leg examples were estimated Fine Leg and one Cover example Point. Seven examples were not used to tune classifier thresholds. The current 17-byte BLE packet contains orientation quaternion + flags only, not raw accel/gyro.  
**Automated Tests**: `node --test web/tests/*.test.js` — **80 passed, 0 failed** (2026-11-17).  
**HITL Required**: Yes — flash was not part of this task. Verify on an ESP32 with real right- and left-handed swings that arrow, highlight, `#shot-name`, history and CSV agree; use independently labeled cricket shots before treating candidates as exact recognition.  
**Regression Risk**: Medium; sector/shot labels now intentionally follow the rendered vector and may differ from prior classifier text when those disagree. The raw classifier values remain available in CSV for diagnosis. Direction-only candidates cannot distinguish similar strokes or identify edges/ball contact.

**ML Assessment**: A supervised model is possible after collecting timestamped, complete, independently labeled shot windows plus raw gyro/accelerometer data, reference pose, mounting/calibration metadata, batting hand, player/session identifiers, and no-shot/setup examples. Validate with player/session-held-out splits and per-class metrics; this seven-row workbook is insufficient for training. See `docs/todo-shot-classifier-alignment.md` for row-by-row review and data requirements.

## 2026-11-17 — Late follow-through could bias the shot direction

**Bug ID**: VCQ-SHOT-005  
**Description**: A bat can continue moving after its main swing lobe, including across or behind the batter. Aggregating that late motion into the shot vector can make the wagon-wheel direction disagree with the batter's swing intent.  
**Root Cause**: Direction was not explicitly bounded at the selected lobe's speed peak, and the primary classifier path lacked regressions for a slower, angled follow-through and for a dropped-packet gap before a later motion burst.  
**Fix Applied**: Estimate the direction from the selected sustained planar angular-motion lobe only through its smoothed speed peak. Split unsupported timing gaps into separate bursts; later follow-through remains available in whole-capture rotation/speed diagnostics but cannot replace the selected shot heading. The canonical wagon-wheel geometry continues to drive the visible direction, sector highlight, arrow, and stroke family.  
**Mounting Frame**: For the user-described mount, the display faces the batter and the board's +X axis points down the bat toward the handle (charging-port end). The classifier ignores axial X-roll for field heading and projects sensor Z to screen horizontal and negative sensor Y to screen vertical, matching the live pointer.  
**Tests Added**: `web/tests/shot-classifier.test.js` verifies slower angled follow-through within the same lobe cannot bend the selected vector and a 320 ms packet-time gap creates a separate burst. Existing orientation and wagon-wheel tests verify classifier/map consistency.  
**Automated Tests**: `node --test web/tests/*.test.js` — **90 passed, 0 failed** (2026-11-17). `http://localhost:8765/?airmouse=1` returned HTTP 200 and served the updated mounting/direction note.  
**HITL Required**: Yes — the signed sensor-axis mapping and field-sector calibration still need to be confirmed with the actual mounted board and known right-/left-handed swings. The web client receives quaternion orientation only; this is a dominant angular-motion estimate, not a measured bat-tip path, ball trajectory, or impact location.  
**Regression Risk**: Medium; stopping at a speed peak is a heuristic impact-phase proxy. Unusual strokes with a true peak after a pause or a faster secondary motion may require labeled real-swing examples before tuning thresholds.

## 2026-11-17 — BLE guard-clear collisions; batter-facing direction convention clarified

**Bug ID**: VCQ-WEB-006  
**Description**: Starting a shot could fail with `GATT operation already in progress` while clearing the previous firmware guard. The reported left/right labels initially looked mirrored but match the existing batter-facing wagon-wheel convention: when the batter faces the UI, their physical right is screen-left and maps to Square Leg; physical left is screen-right and maps to Point for a right-handed batter.  
**Root Cause**: BLE writes were serialized within one page, but a second same-origin UI tab could still issue a write concurrently. Also, Web Bluetooth may briefly retain a characteristic's in-progress state after a successful write promise resolves. No direction-transform defect is established by the reported movement alone.  
**Fix Applied**: Use the Web Locks API, when available, to serialize BLE command writes across same-origin tabs; retain the per-page queue, bounded retries for transient GATT collisions, and a 60 ms settling interval after successful writes. If clearing the firmware guard still fails, show actionable recovery guidance to close any other PowerplAi tab connected to the bat and retry START. The browser captures the guard once for the connected session and reuses that reference for subsequent shots; disconnect resets the browser reference, and the next session establishes a fresh baseline. Game configuration is evaluated in the browser and is not sent to or used by ESP32 shot processing. No firmware change or flash was made.  
**Areas Addressed**: Browser BLE command coordination, guard error recovery, session stance lifecycle, and direction-convention documentation.  
**Tests Added/Updated**: `web/tests/ble-command-queue.test.js` verifies serialization across pages using a shared Web Locks manager, settling, and bounded transient-collision recovery. `web/tests/shot-guard.test.js` and `web/tests/shot-practice.test.js` cover guard capture and reuse. Orientation, classifier, and wagon-wheel tests cover the mapping convention and shared direction/sector geometry.  
**Automated Tests**: `node --test web/tests/*.test.js` — **98 passed, 0 failed** (2026-11-17). `http://localhost:8765/?airmouse=1` returned HTTP 200 and served the current workspace.  
**HITL Required**: Yes — with the mounted ESP32 connected, confirm physical-right → Square Leg and physical-left → Point while facing the UI, verify the live arrow/highlight together, then start multiple shots in one connection and confirm the guard stays fixed. Disconnect/reconnect and confirm the new session prompts for a fresh stance. Browser regression tests pass, but physical BLE contention and the actual board/mount could not be exercised here.  
**Regression Risk**: Low-to-medium. Web Locks coordination applies only where the browser exposes that API; the in-page queue and retry path remain as fallback. Direction mapping is intentionally unchanged pending evidence that the on-screen arrow itself contradicts the intended batter-facing field view.

## 2026-11-17 — Require acknowledged game config and explicit stance before START

**Bug ID**: VCQ-BLE-007  
**Description**: The web and ESP32 START controls could previously begin a shot before device settings and the per-session stance were confirmed. Shot countdown could also trigger implicit stance capture, coupling calibration to every shot.  
**Root Cause**: Session setup state was not modeled as an explicit readiness gate shared by the browser and LCD START path. Configuration and stance readback were not both required for a ready session.  
**Fix Applied**: Send and verify the versioned game-config sequence and all selected values through the ESP32 state characteristic; reject stale/mismatched acknowledgements. Require the web UI's explicit three-second stable stance calibration, clear the prior guard, set the new guard and verify the returned quaternion. Retain the stance for the BLE connection and reset setup on disconnect/reconnect. Firmware now rejects LCD START unless streaming, config acceptance and stance are all active. Shot capture no longer changes the guard; it uses the configured browser capture window.  
**Areas Addressed**: ESP32 BLE config/state protocol, firmware START gating, Web Bluetooth session setup, stance calibration, browser shot-cycle capture.  
**Tests Added/Updated**: BLE session tests cover readiness, disconnect reset, unchanged and changed config, mismatched/stale ACKs, and pre-config stance rejection. Stance tests cover continuous sampling, quaternion sign equivalence, movement and long-packet-gap resets. Shot-cycle tests cover countdown/capture boundaries, one result per sample batch, configured capture duration, cancellation and preparation failure. Startup tests assert explicit stance/config wiring and no implicit guard capture.  
**Automated Tests**: `node --test web/tests/*.test.js` — **110 passed, 0 failed** (2026-11-17).  
**Build/Flash**: Clean ESP-IDF 6.0 ESP32-S3 build succeeded on 2026-11-18. Flashed `/dev/cu.wchusbserial585A0867631` (ESP32-S3 MAC `74:4d:bd:2c:97:50`); esptool verified bootloader, partition-table and application image hashes.
**HITL Required**: Yes — on the flashed board, confirm the default/config-edited settings are acknowledged, hold stance for three stable seconds, start from web and LCD, and reconnect to verify setup resets. Flash verification confirms written bytes, not live BLE behavior.
**Regression Risk**: Medium; START is intentionally unavailable until both device config and stance readback are valid. Web tests model the protocol and timing, but hardware BLE behavior and the actual board's IMU stability still require manual confirmation.

## 2026-11-19 — LCD START looked active before session setup was complete

**Description**: The ESP32 LCD could show START/READY while a tap did nothing. Touch requests were rejected until BLE streaming, acknowledged game config, a captured stance, and an idle shot state were all present.
**Root Cause**: The dashboard's enabled-state omitted config and stance checks, while `ble_server_request_shot_start()` correctly enforced them. Touch coordinates and hit-test outcomes were not logged, making a received-but-rejected tap look like an unresponsive touchscreen.
**Fix Applied**: Use the same firmware readiness predicate for both the LCD and the START request. Show “SETUP IN WEB UI”/“SETUP” until eligible, and log debounced CST816S press coordinates plus whether they hit START.
**CST816S Check**: The driver resets the controller, reads the standard gesture/finger-count/X/Y register block, polls it at 50 Hz, and uses a hit-box matching the rendered button. No raw touch was available before this change, so coordinate orientation/controller behavior is not claimed as physically verified.
**Validation**: ESP-IDF build and firmware debounce regression test; target is the newly detected ESP32-S3 MAC `e4:b0:63:a7:61:90`. Physical touch validation remains necessary; serial output now separates coordinate/hit-test issues from setup/readiness rejection.

## 2026-11-20 — Bat lift could obscure broad shot direction

**Bug ID**: VCQ-SHOT-008  
**Description**: A pre-shot bat lift or late follow-through could bias the reported direction away from the main stroke. The detailed wagon-wheel sector alone was also too fine-grained for quickly checking whether a shot was offside/legside and front/back.  
**Root Cause**: Whole-window movement can contain setup, stroke, and follow-through phases. Direction needs to be estimated from the selected dominant directional lobe, and its UI label must use the same canonical geometry as the arrow and highlighted sector.  
**Fix Applied**: Keep the BLE sample cadence fixed at 50 Hz. Select the dominant stroke lobe through its speed peak for shot direction while retaining whole-capture rotation/speed as diagnostics. Display a separate batter-relative broad zone—Offside front, Offside back, Straight, Legside front, or Legside back—alongside the detailed sector in the result, shot report, accessibility label, history, and CSV. A directly behind-wicket result remains separately labeled Behind wicket. Left-handed broad zones mirror with the handedness-aware selected sector.  
**Areas Addressed**: Browser classifier, wagon-wheel geometry, result display, history/CSV, and regression tests; no firmware or BLE cadence changes.  
**Tests Added/Updated**: Dominant-lobe regression cases cover earlier decelerating lift vs stronger stroke, opposing follow-through, and timing gaps. Wagon-wheel/report/history/startup tests cover all broad zones, left-handed mirroring, canonical direction display, and 50 Hz UI messaging. Updated the startup assertion to match the current session-relative stance wording.  
**Automated Tests**: `node --test web/tests/*.test.js` — **117 passed, 0 failed** (2026-11-20). `http://localhost:8765/?airmouse=1` returned HTTP 200 and served the broad direction-zone and fixed-50-Hz UI.  
**HITL Required**: Yes — with the board mounted in its intended orientation, establish stance, play known offside-front, offside-back, straight, legside-front, and legside-back shots, and confirm the broad zone agrees with the actual stroke rather than the pickup/lift. Repeat representative shots with a left-handed configuration. Review the selected lobe diagnostics and raw samples if any zone is wrong.  
**Regression Risk**: Medium; dominant-lobe selection remains a heuristic because the current BLE packet supplies orientation only, not raw accelerometer/gyroscope or ball-contact timing. 50 Hz is unchanged and is not asserted to be the source of direction errors.

## 2026-11-20 — Supplied direction captures could not be replayed in their stance frame

**Bug ID**: VCQ-SHOT-009  
**Description**: The supplied right-/left-handed capture exports and aggregate accuracy notes were not enough to establish which five-zone direction decisions were wrong or tune the classifier safely.  
**Root Cause**: None of the eight exports in `/Users/vinayjagtap/Downloads/vc-data` contains the session stance quaternion. The exports have 84 non-header shot rows, but their counts do not fully match the supplied rollup, and neither the filenames nor aggregate counts provide a verified direction label per shot. Quaternion samples without their exact stance reference cannot reproduce the same relative direction calculation.  
**Fix Applied**: Shot history now snapshots the session stance reference into `guard_reference_json` on every row, next to captured samples. Added a page-startup regression check for passing the reference into the history append call. Corrected the classifier TODO to inventory the actual eight files, record the data limitations, and define the next evidence needed. No direction thresholds were changed because current evidence cannot distinguish a model error from mislabeled/unmatched rows or an unreproducible stance frame.  
**Validation**: `node --test web/tests/*.test.js` — 122 passed. `web/tests/shot-history.test.js` verifies stance snapshot immutability and CSV round-trip; `web/tests/page-startup.test.js` verifies the UI passes the session reference to each history record.  
**HITL Required**: Yes — take new right- and left-handed sessions after this build, preserve CSV rows with `guard_reference_json`, and independently label the actual five-zone direction for each shot before tuning. Confirm known-direction physical swings on the mounted ESP32; no firmware change or flash was made.  
**Regression Risk**: Low for history/export; each row now includes one additional JSON column containing the already-held stance quaternion. Direction accuracy remains unproven on the physical board until a per-shot labeled replay set is available.

## 2026-11-26 — Gate countdown and capture on per-shot IMU reset

**Description**: The observed firmware log showed `0x08` Shot in progress followed by `0x09` Shot ready, with no `0x0A` reset request or IMU reset-complete line. The browser UI also rendered `Ready` during the reset phase.
**Root Cause**: The earlier browser lifecycle could enter countdown before issuing `0x0A`, matching the supplied `0x08` → `0x09` log sequence with no reset request. That trace identified the missing reset in that run, but did not establish its precise browser-side trigger.
**Fix Applied**: The browser now acknowledges START with `0x08`, requests the IMU-only reset with `0x0A`, and waits for firmware status `complete` before checking for a fresh quaternion sample. The UI keeps the visible **Preparing IMU…** phase through reset and stream recovery; only then does it start 3–2–1 and the configured capture window. Reset failures stop the cycle without sending `0x09`. Firmware protocol bytes are unchanged.
**Tests Added/Updated**: `web/tests/device-shot-control.test.js` verifies the START acknowledgement and reset command handling, completion acknowledgement, and explicit failed-write reporting. `web/tests/shot-practice.test.js` verifies reset completion gates countdown/capture and reset failure cannot start a capture or a new shot. `web/tests/page-startup.test.js` verifies reset lifecycle logging, cache-busted scripts, visible Preparing IMU state, and no false READY acknowledgement.
**Validation**: `node --test web/tests/*.test.js` — 133 passed, 0 failed. The shot-cycle regression now explicitly asserts that each reset completes before its countdown. Physical-device verification remains pending; the supplied monitor output showed no reset request for those four shots.
**HITL Required**: Yes — reload the UI, play one shot, and check the browser console for `[IMU reset] requesting`, `sent`, then `complete`; firmware monitor should show one `Command received: 0x0A`, `CMD 0x0A`, and QMI8658 reset-complete message per shot without BLE disconnect. The 3–2–1 countdown and configured capture must follow completion. If reset fails, confirm capture and `0x09` do not occur and follow the UI reconnect instruction.
**Regression Risk**: Low; firmware protocol and BLE connection are unchanged. Sensor reset duration and repeat-shot timing still need confirmation on the physical board.

## 2026-11-26 — Bat orientation calibration kept restarting

**Bug ID**: VCQ-WEB-012  
**Description**: Clicking Set Bat Orientation could leave the three-second hold running/restarting instead of saving the reference.  
**Root Cause**: The stability check treated slow cumulative quaternion yaw drift as physical movement, so the hold timer could restart before reaching three seconds.  
**Fix Applied**: Evaluate sample-to-sample angular rate rather than total displacement from the first sample. Slow IMU drift no longer restarts the hold; faster movement and long sample gaps still reset it. The same shared tracker covers orientation and stance calibration, and its script URL is cache-busted so the browser loads this fix.  
**Areas Addressed**: Browser calibration stability tracker and BLE session setup.  
**Tests Added/Updated**: `web/tests/stance-calibration.test.js` covers slow drift, quaternion sign flips, real movement, long gaps, and invalid quaternions; `web/tests/ble-session-setup.test.js` covers completion with gradual drift.  
**Validation**: `node --test web/tests/*.test.js` — 135 passed. The served tracker page and cache-busted calibration script both return HTTP 200 on port 8765.  
**HITL Required**: Yes — connect the ESP32, click Set Bat Orientation, keep it physically still, and confirm it saves after three seconds; repeat for Take Stance.  
**Regression Risk**: Low-to-medium; deliberate movement slower than the 12°/s threshold is treated as drift because quaternion-only BLE samples do not include gyro data.

## 2026-11-26 — Bat orientation countdown stuck at 3 seconds

**Description**: The calibration dialog remained at “Hold still · 3.0 s” instead of counting down.  
**Root Cause**: Small BLE quaternion jitter could restart the stability tracker; after that was smoothed, a separate first-sample race remained. `onNotify()` passed the fresh packet to calibration before notifying the packet gate. The gate then released the setup wait, but the tracker was created only afterward, so the exact packet proving fresh data was discarded. If notifications paused at that point, the UI stayed at 3.0 seconds.  
**Fix Applied**: Keep the smoothed 120 ms stability calculation and buffer eligible quaternion samples only while waiting for the first post-readback fresh sample. Seed the tracker from those samples when it is created, then continue with live samples. Samples from before the post-readback checkpoint are discarded. The browser still checks/restarts a stale stream and surfaces a clear error if fresh data never arrives. Cache-bust the session-setup script. No firmware or BLE protocol changes.  
**Tests Added/Updated**: `web/tests/ble-session-setup.test.js` reproduces the actual notification/gate ordering and verifies that the fresh packet seeds a regular three-second sample stream; the existing fresh-sample test now uses continuous samples instead of an invalid 3-second packet gap. `web/tests/stance-calibration.test.js` covers noisy 50 Hz samples, slow drift, movement, gaps, and invalid quaternions; `web/tests/stream-recovery.test.js` and `web/tests/page-startup.test.js` cover packet readiness, cancellation, pending-button locking, and the cache-busted script paths.  
**Validation**: `node --test web/tests/*.test.js` — **143 passed, 0 failed** (2026-11-26). `http://localhost:8765/?airmouse=1` returned HTTP 200 and served `ble-session-setup.js?v=20261126-fresh-sample-handoff`. Physical-device calibration remains unverified.  
**HITL Required**: Yes — use Set Bat Orientation and Take Stance on the connected ESP32; confirm both count down and complete while held still, then verify deliberate movement restarts the three-second hold.  
**Regression Risk**: Low; movement estimation is smoothed over 120 ms and may delay detection of a brief movement within that interval. The 12°/s stability threshold is unchanged; when the stream cannot be recovered, calibration fails explicitly instead of completing without samples.  
