# PowerplAi Cricket Bat Tracker

PowerplAi estimates cricket-bat movement and likely shot direction using a
Waveshare ESP32-S3-LCD-1.28 and its QMI8658 IMU. The project has two parts:

- **ESP32-S3 firmware**: samples the IMU, maintains orientation with Madgwick
  sensor fusion, shows device status on the LCD, and streams quaternion packets
  over BLE.
- **Browser client**: connects with Web Bluetooth, sets up the session, captures
  a configured shot window, estimates direction/stroke family, draws a wagon
  wheel, and optionally simulates a game outcome locally.

The browser classifier is an IMU-based estimate, not ball tracking or exact
stroke recognition. A future Unity client can consume the same BLE sensor
stream and implement its own presentation/gameplay layer.

## Recent changes

- **Configurable BLE sampling cadence (`0x0B`).** The IMU fusion rate stays at
  200 Hz; only how often quaternions are sent over BLE changes. A dedicated
  two-byte command `[0x0B, sampcnt]` selects `sampcnt` 1–4 → every 4th/3rd/2nd/1st
  sample = 50/67/100/200 Hz (default 50 Hz). Values outside 1–4 are rejected.
  The selected code is echoed in state byte 9 bits 4–5 and the browser reads it
  back and verifies it before enabling START.
- **Cadence in the browser game config.** A 50/67/100/200 Hz selector is stored
  with the game settings and sent through the serialized BLE command queue. A
  cadence change invalidates the saved batting stance but preserves the separate
  bat-orientation reference. Classifier timing/gap assumptions and the
  sample-count diagnostics use the configured rate instead of assuming 50 Hz.
- **Consistent "Behind batter" wording.** The broad field zone for the
  "Behind batter" sector now reads **Behind batter** (previously "Behind
  wicket"), so the detailed sector, broad zone, and direction terminology agree
  in the result, report, history, and accessibility label.
- **Quieter firmware log.** The recurring "BLE stream … packets sent" line is
  downgraded to DEBUG; connection, command, reset, and error logs are retained.
- **Cache-busted browser modules.** Changed `web/` modules are loaded with a
  `?v=` query so a stale cached script (for example an old `game-layer.js`
  without `sampcnt`) cannot break the session setup after an update. Reload the
  page after pulling new client code.

## Hardware and sensing

**Board:** Waveshare ESP32-S3-LCD-1.28 (SKU 26541)

- MCU: ESP32-S3R2, dual-core 240 MHz
- IMU: QMI8658, 3-axis accelerometer and gyroscope; no magnetometer
- LCD: 1.28-inch round GC9A01, 240 × 240
- BLE: Bluetooth Low Energy via ESP-IDF NimBLE
- Sampling: **200 Hz IMU**; notifications: **configurable 50/67/100/200 Hz BLE** (default 50 Hz)
- Sensor ranges: ±8 g acceleration and ±2048 dps gyroscope

The current mount convention is for the display to face the batter, with the
board's +X axis down the bat toward the handle. In the browser's field
projection, +X is treated as axial roll (not shot heading); the current screen
mapping uses sensor Z for horizontal direction and sensor Y for vertical
direction. Signed physical directions must still be checked with known swings
on the actual mount.

## Shot/session flow

1. Serve the browser client from localhost or HTTPS and connect to the BLE
   device advertising as `CricketBat-…`.
2. The browser sends game settings and checks the ESP32's state response for an
   exact configuration acknowledgement. The BLE sampling cadence (50/67/100/200 Hz)
   is sent with the `0x0B` command and read back from the state frame before START
   is enabled; the IMU fusion rate stays at 200 Hz regardless of the selected
   cadence or capture duration.
3. Select right- or left-handed batting, then take stance once for the session.
   Hold still for **3 seconds**. The saved pose is displayed as **Straight ·
   0° session baseline**; shot directions are relative to this pose, not a
   compass heading. Disconnecting ends the stance session.
4. Start a shot from the browser or the ESP32's LCD button. The browser shows
   **Preparing IMU**, acknowledges START, requests the IMU-only reset, and waits
   for firmware completion and a fresh quaternion sample. It then shows the
   **3–2–1** countdown and captures the configured window (default **525 ms**),
   producing one result for that window. BLE remains connected throughout.
5. Direction is selected from the dominant sustained movement lobe through its
   speed peak so that later follow-through is less likely to redirect the
   estimate. The wagon-wheel arrow, highlighted field sector, direction, broad
   zone, and likely stroke family share the same canonical map geometry.
6. Review the expandable shot history, download its CSV, or clear it for a new
   session. The optional game layer is a deterministic **browser simulation**;
   its runs, timing, edge, and dismissal values are not measured ball outcomes
   and are not sent over BLE.

The field map uses eight sectors: Straight, Cover, Point, Third man, Behind
batter, Fine leg, Square leg, and Mid-on. A separate broad zone is also shown:
offside front/back, straight, legside front/back, or behind batter. Candidate
stroke names are direction-based possibilities; quaternion orientation alone
cannot establish the exact stroke or contact point.

## Web client

No frontend build tool is required; the client is static HTML, CSS, and
JavaScript in `web/`. Web Bluetooth works in supported browsers on localhost or
HTTPS.

```bash
python3 -m http.server 8765 --directory web
```

Open the normal client at `http://localhost:8765/` or the tracker route at
`http://localhost:8765/?airmouse=1`.

Game settings default to:

```json
{"game_config":{"difficulty":"dry_pitch","bowled_prob":3,"edge_base_prob":10,"capture_window_ms":525,"sampcnt":1}}
```

The capture window can be selected from 400, 500, 525, 600, 700, 800, or
900 ms. The BLE sampling cadence (`sampcnt` 1–4) selects 50, 67, 100, or 200 Hz
(every 4th/3rd/2nd/1st 200 Hz IMU sample). At 50 Hz a 525 ms window is about 26
samples; the browser derives the expected sample count from the configured
cadence and checks packet timestamps so delayed timer callbacks do not expand the
requested window. Settings are stored in the browser and sent to the device on
connect/change; a cadence change invalidates the saved batting stance but keeps
the separate bat-orientation reference.

## Firmware build and flash

Install ESP-IDF and the ESP32-S3 toolchain (the project is maintained with
ESP-IDF 6.0), then activate the ESP-IDF environment. The `idf.py` commands run
from the `firmware/` directory:

```bash
cd firmware
idf.py build
idf.py -p PORT flash
```

Or use the root helper after activating ESP-IDF:

```bash
./build-flash.sh build
./build-flash.sh flash
```

The default helper command builds, flashes, and starts the serial monitor;
`./build-flash.sh clean` removes generated build state. Serial diagnostics use
115200 baud. Do not commit `firmware/build/`, generated managed components, or
the machine-specific `firmware/sdkconfig`.

## BLE interface

The GATT service UUID is `12345678-1234-1234-1234-123456789abc`.

| Characteristic | UUID suffix | Purpose |
|---|---|---|
| Quaternion notify | `…9abd` | 17-byte little-endian quaternion packet at the selected cadence (default 50 Hz) |
| Command write | `…9abe` | Device commands and versioned game configuration |
| State read | `…9abf` | Configuration acknowledgement and saved stance state |

Quaternion notification layout:

| Offset | Size | Value |
|---:|---:|---|
| 0 | 4 bytes | `q.w`, float32 little-endian |
| 4 | 4 bytes | `q.x`, float32 little-endian |
| 8 | 4 bytes | `q.y`, float32 little-endian |
| 12 | 4 bytes | `q.z`, float32 little-endian |
| 16 | 1 byte | Flags: bit 0 swing start; bit 1 LCD start request |

Command characteristic frames (client → device):

| Length | Frame | Meaning |
|---|---|---|
| 1 byte | `0x01`–`0x0A` | Single-byte commands (recenter, reset, take/clear guard, start/pause stream, shot lifecycle, IMU-only reset) |
| 2 bytes | `0x0B`, `sampcnt` | Set BLE sampling cadence; `sampcnt` 1–4 (50/67/100/200 Hz); values outside 1–4 rejected |
| 8 bytes | `0xA1`, version, sequence, difficulty, bowled%, edge%, window LE | Versioned game configuration |

State characteristic frame (device → client, 26 bytes, READ):

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | Magic `0xA1` |
| 1 | 1 | Version |
| 2 | 1 | Config sequence |
| 3 | 1 | Flags: bit 0 config accepted; bit 1 stance/guard active |
| 4 | 1 | Difficulty |
| 5 | 1 | Bowled % |
| 6 | 1 | Edge % |
| 7 | 2 | Capture window (LE) |
| 9 | 1 | Status: bits 0–1 IMU reset; bits 2–3 shot lifecycle; bits 4–5 sampling-cadence code (`sampcnt − 1`) |
| 10 | 16 | Stance quaternion w/x/y/z (float32 LE) |

The command characteristic accepts single-byte commands, a two-byte sampling
cadence frame `[0x0B, sampcnt]` (sampcnt 1–4), and a versioned 8-byte game
configuration frame. The state characteristic reports the accepted sequence,
settings, cadence code (byte 9 bits 4–5), and stance quaternion. See
`firmware/main/ble/ble_server.h` and `web/device-config.js` for the authoritative
wire layout and validation.

## Project layout

```text
firmware/                  ESP-IDF project and ESP32-S3 firmware
  main/                    IMU/BLE tasks, GATT server, LCD, touch, and IMU drivers
  tests/                   Firmware unit tests
  sdkconfig.defaults        Shared ESP-IDF defaults
web/                       Static browser client and shot-analysis modules
  tests/                   Node.js regression tests for browser modules
docs/                      Implementation notes, bug fixes, and task records
build-flash.sh             Root build/flash/monitor helper
```

## Development checks

Run the browser-side regression suite with Node.js:

```bash
node --test web/tests/*.test.js
```

The current suite covers BLE session/configuration and stance setup, sampling
cadence encode/decode/readback and stance invalidation, cadence-aware classifier
timing, packet and capture-window handling, dominant-path classification,
map/report/history consistency (including the "Behind batter" broad zone), and
browser game-layer simulation. The firmware state/protocol test
(`firmware/tests/test_shot_state_transition.c`) covers the cadence pack/decode and
divisor mapping and can be built standalone with a C compiler. Automated tests do
not replace hardware-in-the-loop checks for actual sensor orientation, BLE
stability, or shot-direction calibration.

## License and references

MIT. Board reference: [Waveshare ESP32-S3-LCD-1.28 documentation](https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.28).
