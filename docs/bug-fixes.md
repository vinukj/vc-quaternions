# Bug fixes

## 2026-11-14 — NimBLE rejected the readable quaternion characteristic

**Bug ID**: VCQ-BLE-001<br>
**Description**: Firmware restarted during BLE startup before advertising.<br>
**Root Cause**: The quaternion characteristic declared READ and NOTIFY properties but omitted the mandatory NimBLE GATT access callback, so `ble_gatts_count_cfg()` returned `BLE_HS_EINVAL` (3).<br>
**Fix Applied**: Added a read callback that returns the most recent complete 17-byte packet under the existing mutex and rejects unsupported access operations. The packet wire format is unchanged.<br>
**Areas Addressed**: BLE service configuration and read path.<br>
**Tests Added**: None; the failure is at NimBLE service registration and requires the target stack for direct validation.<br>
**Boundary Validations**: Read before a stream is safe because host sync pre-seeds the packet with an identity quaternion; mutex failure and mbuf allocation failure return ATT errors.<br>
**HITL Required**: Yes — boot the board, confirm advertising and sensor initialization, then connect from Edge and verify notifications and command writes.<br>
**Regression Risk**: Low; the change only supplies the callback required for the already-declared READ property and preserves the 17-byte payload.

## 2026-11-14 — NimBLE sync callback dereferenced a null address-type pointer

**Bug ID**: VCQ-BLE-002<br>
**Description**: After GATT registration was fixed, the device panicked at BLE host sync and rebooted continuously.<br>
**Root Cause**: `ble_hs_id_infer_auto()` requires a writable output pointer; passing `NULL` caused a StoreProhibited exception inside NimBLE.<br>
**Fix Applied**: Store the inferred own-address type and pass it to `ble_gap_adv_start()` rather than hard-coding the public-address type.<br>
**Areas Addressed**: BLE host synchronization and advertising configuration.<br>
**Tests Added**: None; validation is on the ESP32-S3 against the bundled ESP-IDF NimBLE stack.<br>
**Boundary Validations**: NimBLE inference errors continue to log and restart rather than advertising with an uninitialized address type.<br>
**HITL Required**: Yes — confirm startup, advertising, connection, notification delivery, and command writes on the physical board.<br>
**Regression Risk**: Low; this follows the target ESP-IDF API contract and the working reference implementation.

## 2026-11-16 — One physical START touch could produce repeated shot captures

**Bug ID**: VCQ-SHOT-003<br>
**Description**: A single physical touch could appear as many one-second shot-history entries. Each entry is one complete capture window; its sensor packets are already aggregated into one analysis result.<br>
**Root Cause**: The LCD accepted both touch press and release after only two 20 ms samples. Brief release glitches from the CST816S could therefore re-arm START, and a subsequent pressed sample could trigger another browser cycle.<br>
**Fix Applied**: Kept the responsive 40 ms press debounce and required 8 stable samples (160 ms) before recognizing release. Short release glitches no longer emit a fresh press edge.<br>
**Areas Addressed**: Firmware touchscreen input and one-capture/one-history behavior.<br>
**Tests Added**: `firmware/tests/test_touch_debounce.c` covers brief release glitches, stable release, and a subsequent intentional press; `web/tests/shot-practice.test.js` verifies 50 packets in one capture produce one result.<br>
**Boundary Validations**: Invalid touch reads do not advance debounce state; release glitches shorter than 160 ms are ignored; a stable release followed by a 40 ms press is accepted.<br>
**HITL Required**: Yes — on the ESP32, make one quick touch, wait through a full capture, and verify exactly one history entry; then repeat a deliberate second touch and verify a second entry. Exercise a real swing and confirm rotation is nonzero.<br>
**Regression Risk**: Low; release recognition is delayed by 120 ms more than press recognition, while touch polling and shot-state handling are unchanged.

## 2026-11-17 — Wagon-wheel sector, arrow, and shot labels disagreed

**Bug ID**: VCQ-SHOT-004<br>
**Description**: The arrow, highlighted sector, shot-name, report/history, or CSV could disagree (including Fine Leg vs Square Leg and Cover vs Straight). History also needed a way to discard prior in-session shots.<br>
**Root Cause**: UI surfaces retained classifier labels while the wagon wheel separately derived its direction and selected sector from the bat-motion vector; the drawn arrow endpoint was not guaranteed to use the exact selected wedge angle.<br>
**Fix Applied**: Use `WagonWheel.shotGeometry()` as the canonical result geometry for direction, sector, side, shot family, and direction-specific candidate strokes. Feed it to the track map, shot name, accessibility/report/history and CSV primary columns; snap completed-shot arrows to the selected field-sector angle. Keep original classifier outputs only as explicit CSV diagnostic fields. Add accessible clear-history UI behavior which removes in-memory/exported shots, clears the rendered list, disables actions when empty, and restarts numbering. Align Cover/Mid-on family wording between classifier and map.<br>
**Areas Addressed**: Browser UI, canvas rendering, shot-history state, CSV serialization, classifier labels and direction-specific heuristic presentation.<br>
**Tests Added**: `web/tests/wagon-wheel.test.js` verifies workbook direction-sector examples, all eight candidate lists and wedge/arrow alignment; `web/tests/shot-classifier.test.js` checks classifier/map family agreement for Cover and Mid-on; `web/tests/shot-history.test.js` checks clear/reset, canonical display/CSV columns and preserved diagnostics; `web/tests/page-startup.test.js` checks clear/download controls are wired and disabled for empty history.<br>
**Boundary Validations**: Missing/unclear movement does not create a stale arrow; left-handed sector mapping remains mirrored; sparse or dispersed motion lowers consistency; equally strong reversals remain ambiguous; spreadsheet formula-like text remains neutralized in CSV. Workbook rows 2–8 yielded 4/7 estimates matching the C:F reference after normalizing case/wording; two Square-leg examples were estimated Fine Leg and one Cover example Point. Seven examples were not used to tune classifier thresholds. The current 17-byte BLE packet contains orientation quaternion + flags only, not raw accel/gyro.<br>
**Automated Tests**: `node --test web/tests/*.test.js` — **80 passed, 0 failed** (2026-11-17).<br>
**HITL Required**: Yes — flash was not part of this task. Verify on an ESP32 with real right- and left-handed swings that arrow, highlight, `#shot-name`, history and CSV agree; use independently labeled cricket shots before treating candidates as exact recognition.<br>
**Regression Risk**: Medium; sector/shot labels now intentionally follow the rendered vector and may differ from prior classifier text when those disagree. The raw classifier values remain available in CSV for diagnosis. Direction-only candidates cannot distinguish similar strokes or identify edges/ball contact.

**ML Assessment**: A supervised model is possible after collecting timestamped, complete, independently labeled shot windows plus raw gyro/accelerometer data, reference pose, mounting/calibration metadata, batting hand, player/session identifiers, and no-shot/setup examples. Validate with player/session-held-out splits and per-class metrics; this seven-row workbook is insufficient for training. See `docs/todo-shot-classifier-alignment.md` for row-by-row review and data requirements.

## 2026-11-17 — Late follow-through could bias the shot direction

**Bug ID**: VCQ-SHOT-005<br>
**Description**: A bat can continue moving after its main swing lobe, including across or behind the batter. Aggregating that late motion into the shot vector can make the wagon-wheel direction disagree with the batter's swing intent.<br>
**Root Cause**: Direction was not explicitly bounded at the selected lobe's speed peak, and the primary classifier path lacked regressions for a slower, angled follow-through and for a dropped-packet gap before a later motion burst.<br>
**Fix Applied**: Estimate the direction from the selected sustained planar angular-motion lobe only through its smoothed speed peak. Split unsupported timing gaps into separate bursts; later follow-through remains available in whole-capture rotation/speed diagnostics but cannot replace the selected shot heading. The canonical wagon-wheel geometry continues to drive the visible direction, sector highlight, arrow, and stroke family.<br>
**Mounting Frame**: For the user-described mount, the display faces the batter and the board's +X axis points down the bat toward the handle (charging-port end). The classifier ignores axial X-roll for field heading and projects sensor Z to screen horizontal and negative sensor Y to screen vertical, matching the live pointer.<br>
**Tests Added**: `web/tests/shot-classifier.test.js` verifies slower angled follow-through within the same lobe cannot bend the selected vector and a 320 ms packet-time gap creates a separate burst. Existing orientation and wagon-wheel tests verify classifier/map consistency.<br>
**Automated Tests**: `node --test web/tests/*.test.js` — **90 passed, 0 failed** (2026-11-17). `http://localhost:8765/?airmouse=1` returned HTTP 200 and served the updated mounting/direction note.<br>
**HITL Required**: Yes — the signed sensor-axis mapping and field-sector calibration still need to be confirmed with the actual mounted board and known right-/left-handed swings. The web client receives quaternion orientation only; this is a dominant angular-motion estimate, not a measured bat-tip path, ball trajectory, or impact location.<br>
**Regression Risk**: Medium; stopping at a speed peak is a heuristic impact-phase proxy. Unusual strokes with a true peak after a pause or a faster secondary motion may require labeled real-swing examples before tuning thresholds.

## 2026-11-17 — BLE guard-clear collisions; batter-facing direction convention clarified

**Bug ID**: VCQ-WEB-006<br>
**Description**: Starting a shot could fail with `GATT operation already in progress` while clearing the previous firmware guard. The reported left/right labels initially looked mirrored but match the existing batter-facing wagon-wheel convention: when the batter faces the UI, their physical right is screen-left and maps to Square Leg; physical left is screen-right and maps to Point for a right-handed batter.<br>
**Root Cause**: BLE writes were serialized within one page, but a second same-origin UI tab could still issue a write concurrently. Also, Web Bluetooth may briefly retain a characteristic's in-progress state after a successful write promise resolves. No direction-transform defect is established by the reported movement alone.<br>
**Fix Applied**: Use the Web Locks API, when available, to serialize BLE command writes across same-origin tabs; retain the per-page queue, bounded retries for transient GATT collisions, and a 60 ms settling interval after successful writes. If clearing the firmware guard still fails, show actionable recovery guidance to close any other PowerplAi tab connected to the bat and retry START. The browser captures the guard once for the connected session and reuses that reference for subsequent shots; disconnect resets the browser reference, and the next session establishes a fresh baseline. Game configuration is evaluated in the browser and is not sent to or used by ESP32 shot processing. No firmware change or flash was made.<br>
**Areas Addressed**: Browser BLE command coordination, guard error recovery, session stance lifecycle, and direction-convention documentation.<br>
**Tests Added/Updated**: `web/tests/ble-command-queue.test.js` verifies serialization across pages using a shared Web Locks manager, settling, and bounded transient-collision recovery. `web/tests/shot-guard.test.js` and `web/tests/shot-practice.test.js` cover guard capture and reuse. Orientation, classifier, and wagon-wheel tests cover the mapping convention and shared direction/sector geometry.<br>
**Automated Tests**: `node --test web/tests/*.test.js` — **98 passed, 0 failed** (2026-11-17). `http://localhost:8765/?airmouse=1` returned HTTP 200 and served the current workspace.<br>
**HITL Required**: Yes — with the mounted ESP32 connected, confirm physical-right → Square Leg and physical-left → Point while facing the UI, verify the live arrow/highlight together, then start multiple shots in one connection and confirm the guard stays fixed. Disconnect/reconnect and confirm the new session prompts for a fresh stance. Browser regression tests pass, but physical BLE contention and the actual board/mount could not be exercised here.<br>
**Regression Risk**: Low-to-medium. Web Locks coordination applies only where the browser exposes that API; the in-page queue and retry path remain as fallback. Direction mapping is intentionally unchanged pending evidence that the on-screen arrow itself contradicts the intended batter-facing field view.

## 2026-11-17 — Require acknowledged game config and explicit stance before START

**Bug ID**: VCQ-BLE-007<br>
**Description**: The web and ESP32 START controls could previously begin a shot before device settings and the per-session stance were confirmed. Shot countdown could also trigger implicit stance capture, coupling calibration to every shot.<br>
**Root Cause**: Session setup state was not modeled as an explicit readiness gate shared by the browser and LCD START path. Configuration and stance readback were not both required for a ready session.<br>
**Fix Applied**: Send and verify the versioned game-config sequence and all selected values through the ESP32 state characteristic; reject stale/mismatched acknowledgements. Require the web UI's explicit three-second stable stance calibration, clear the prior guard, set the new guard and verify the returned quaternion. Retain the stance for the BLE connection and reset setup on disconnect/reconnect. Firmware now rejects LCD START unless streaming, config acceptance and stance are all active. Shot capture no longer changes the guard; it uses the configured browser capture window.<br>
**Areas Addressed**: ESP32 BLE config/state protocol, firmware START gating, Web Bluetooth session setup, stance calibration, browser shot-cycle capture.<br>
**Tests Added/Updated**: BLE session tests cover readiness, disconnect reset, unchanged and changed config, mismatched/stale ACKs, and pre-config stance rejection. Stance tests cover continuous sampling, quaternion sign equivalence, movement and long-packet-gap resets. Shot-cycle tests cover countdown/capture boundaries, one result per sample batch, configured capture duration, cancellation and preparation failure. Startup tests assert explicit stance/config wiring and no implicit guard capture.<br>
**Automated Tests**: `node --test web/tests/*.test.js` — **110 passed, 0 failed** (2026-11-17).<br>
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

**Bug ID**: VCQ-SHOT-008<br>
**Description**: A pre-shot bat lift or late follow-through could bias the reported direction away from the main stroke. The detailed wagon-wheel sector alone was also too fine-grained for quickly checking whether a shot was offside/legside and front/back.<br>
**Root Cause**: Whole-window movement can contain setup, stroke, and follow-through phases. Direction needs to be estimated from the selected dominant directional lobe, and its UI label must use the same canonical geometry as the arrow and highlighted sector.<br>
**Fix Applied**: Keep the BLE sample cadence fixed at 50 Hz. Select the dominant stroke lobe through its speed peak for shot direction while retaining whole-capture rotation/speed as diagnostics. Display a separate batter-relative broad zone—Offside front, Offside back, Straight, Legside front, or Legside back—alongside the detailed sector in the result, shot report, accessibility label, history, and CSV. A directly behind-wicket result remains separately labeled Behind wicket. Left-handed broad zones mirror with the handedness-aware selected sector.<br>
**Areas Addressed**: Browser classifier, wagon-wheel geometry, result display, history/CSV, and regression tests; no firmware or BLE cadence changes.<br>
**Tests Added/Updated**: Dominant-lobe regression cases cover earlier decelerating lift vs stronger stroke, opposing follow-through, and timing gaps. Wagon-wheel/report/history/startup tests cover all broad zones, left-handed mirroring, canonical direction display, and 50 Hz UI messaging. Updated the startup assertion to match the current session-relative stance wording.<br>
**Automated Tests**: `node --test web/tests/*.test.js` — **117 passed, 0 failed** (2026-11-20). `http://localhost:8765/?airmouse=1` returned HTTP 200 and served the broad direction-zone and fixed-50-Hz UI.<br>
**HITL Required**: Yes — with the board mounted in its intended orientation, establish stance, play known offside-front, offside-back, straight, legside-front, and legside-back shots, and confirm the broad zone agrees with the actual stroke rather than the pickup/lift. Repeat representative shots with a left-handed configuration. Review the selected lobe diagnostics and raw samples if any zone is wrong.<br>
**Regression Risk**: Medium; dominant-lobe selection remains a heuristic because the current BLE packet supplies orientation only, not raw accelerometer/gyroscope or ball-contact timing. 50 Hz is unchanged and is not asserted to be the source of direction errors.
