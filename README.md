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

## Hardware and sensing

**Board:** Waveshare ESP32-S3-LCD-1.28 (SKU 26541)

- MCU: ESP32-S3R2, dual-core 240 MHz
- IMU: QMI8658, 3-axis accelerometer and gyroscope; no magnetometer
- LCD: 1.28-inch round GC9A01, 240 × 240
- BLE: Bluetooth Low Energy via ESP-IDF NimBLE
- Sampling: **200 Hz IMU**; notifications: **fixed 50 Hz BLE**
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
   exact configuration acknowledgement. BLE sensor notifications remain at
   50 Hz regardless of the selected capture duration.
3. Select right- or left-handed batting, then take stance once for the session.
   Hold still for **3 seconds**. The saved pose is displayed as **Straight ·
   0° session baseline**; shot directions are relative to this pose, not a
   compass heading. Disconnecting ends the stance session.
4. Start a shot from the browser or the ESP32's LCD button. After the
   3–2–1 countdown, the browser captures the configured window (default
   **525 ms**) and emits one result for that window.
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
offside front/back, straight, legside front/back, or behind wicket. Candidate
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
{"game_config":{"difficulty":"dry_pitch","bowled_prob":3,"edge_base_prob":10,"capture_window_ms":525}}
```

The capture window can be selected from 400, 500, 525, 600, 700, 800, or
900 ms. At a 50 Hz notification rate this represents approximately 20–45
samples; the browser also checks packet timestamps so delayed timer callbacks
do not expand the requested window. Settings are stored in the browser and sent
to the device on connect/change.

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
| Quaternion notify | `…9abd` | 17-byte little-endian quaternion packet at 50 Hz |
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

The command characteristic accepts byte commands and a versioned 8-byte game
configuration frame. The state characteristic reports the accepted sequence,
settings, and stance quaternion. See `firmware/main/ble/ble_server.h` and
`web/device-config.js` for the authoritative wire layout and validation.

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

The current suite covers BLE session/configuration and stance setup, packet and
capture-window handling, dominant-path classification, map/report/history
consistency, and browser game-layer simulation. Automated tests do not replace
hardware-in-the-loop checks for actual sensor orientation, BLE stability, or
shot-direction calibration.

## License and references

MIT. Board reference: [Waveshare ESP32-S3-LCD-1.28 documentation](https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.28).
