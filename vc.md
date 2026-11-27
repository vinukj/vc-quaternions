# Cricket Bat Tracker — Developer Prompt
## ESP32-S3 (Waveshare) + Web Bluetooth Client

---

## Project Overview

Build a 2-app system for tracking cricket bat movement and classifying shots.

- **App 1:** ESP32-S3 firmware (Waveshare ESP32-S3-LCD-1.28) — reads QMI8658 IMU, runs Madgwick sensor fusion, streams quaternion over BLE notify, drives onboard LCD.
- **App 2:** Web client (single HTML file, Edge/Chrome) — Web Bluetooth connection, Three.js 3D bat render, swing detection, shot classification (direction + type).

**Start with browser client for fast iteration. TV/Unity port comes later.**

---

## Hardware

**Board:** Waveshare ESP32-S3-LCD-1.28
- MCU: ESP32-S3, dual-core 240 MHz
- IMU: QMI8658 (6-axis: 3-axis accel + 3-axis gyro), no magnetometer
- BLE: Bluetooth 5 LE
- LCD: 240×240 round IPS, 65K colors
- Battery: 3.7V LiPo header
- USB: Type-C

**IMU config:**
- Sample rate: 200 Hz
- Gyro range: ±2000 dps (bat swings exceed ±500 dps)
- Accel range: ±8g
- No magnetometer → yaw drifts; use "Take Guard" reference to eliminate drift impact

---

## Architecture

```
QMI8658 (200 Hz) → Madgwick (6-axis, beta=0.1) → quaternion (w,x,y,z)
                                                          ↓
                                                   BLE notify (50/67/100/200 Hz)
                                                          ↓
                                            ┌─────────────┴─────────────┐
                                            ↓                           ↓
                                    Web Bluetooth                  Unity BLE plugin
                                    (Edge/Chrome)                  (Android TV, later)
                                            ↓                           ↓
                                    Three.js 3D bat                Unity 3D bat
                                            ↓                           ↓
                                Swing detector + classifier    Same classifier ported
                                            ↓                           ↓
                                "Cover Drive — Offside"        "Cover Drive — Offside"
```

---

## App 1 — ESP32-S3 Firmware

### Requirements

1. **IMU sampling**
   - Initialize QMI8658 at 200 Hz
   - Gyro range: ±2000 dps
   - Accel range: ±8g
   - Use Waveshare QMI8658 library or SensorLib
   - Serial debug at 115200 baud: raw accel/gyro + quaternion + connection state

2. **Madgwick filter**
   - Run in 6-axis IMU mode (`updateIMU` — no magnetometer)
   - Fixed 5 ms sample interval (200 Hz)
   - Beta = 0.1
   - Output: quaternion (w, x, y, z)
   - Add low-pass on gyro input if drift is excessive (beta → 0.05)

3. **BLE GATT server**
   - Service UUID: `12345678-1234-1234-1234-123456789abc`
   - **Notify characteristic** UUID: `12345678-1234-1234-1234-123456789abd`
     - Properties: READ + NOTIFY
     - Payload: 17 bytes (see protocol below)
      - Stream at the selected cadence (default every 4th IMU sample = 50 Hz;
        `0x0B` selects every 4th/3rd/2nd/1st sample = 50/67/100/200 Hz)
   - **Command characteristic** UUID: `12345678-1234-1234-1234-123456789abe`
     - Properties: WRITE
     - Receives 1-byte commands from client (see command table below)

4. **LCD display (240×240 round)**
   - Show: connection status (Connected / Waiting), battery %, swing count
   - Update at ~5 Hz
   - Use LVGL or simple TFT drawing
   - Color: green when connected, orange when waiting, red on error

5. **Swing detection on ESP32 (optional)**
   - When gyro magnitude > 300 dps, set swing-start flag in BLE packet (bit 0 of flags byte)
   - Helps browser sync swing timing

6. **Power management**
   - Target < 30 mA average on 500 mAh LiPo → ~16 hours
   - Use light sleep between BLE packets if possible

### Command table (client → ESP32 via command characteristic)

| Byte | Command | ESP32 action |
|---|---|---|
| `0x01` | Recenter yaw | Reset Madgwick yaw to 0, keep pitch/roll converged |
| `0x02` | Full reset | Re-initialize entire filter (quaternion = identity, bias = 0) |
| `0x03` | Take Guard | Capture current orientation as reference; stream **relative** orientation from now on |
| `0x04` | Clear reference | Revert to absolute orientation |
| `0x0B` | Set sampling cadence | Two-byte frame `[0x0B, sampcnt]`; sampcnt 1–4 → notify every 4th/3rd/2nd/1st sample (50/67/100/200 Hz). IMU fusion stays at 200 Hz. |

### "Take Guard" implementation (critical)

Instead of wiping the filter, capture guard position as a **reference quaternion** and report:

```
q_relative = q_current ⊗ q_guard⁻¹   (quaternion conjugate multiply)
```

This preserves filter stability and makes all swing measurements relative to the batter's actual stance. Solves yaw drift entirely — you only care about movement from guard, not absolute heading.

### Firmware code structure

```
firmware/
├── main.cpp (or .ino)
├── madgwick.h / madgwick.cpp
├── qmi8658_driver.h / .cpp
├── ble_service.h / .cpp
├── lcd_display.h / .cpp
└── libraries.txt
```

### Libraries required
- QMI8658 (Waveshare official or SensorLib)
- BLE (built-in ESP32 Arduino core)
- LVGL or TFT_eSPI (for LCD)
- MadgwickAHRS (Arduino library or custom)

---

## App 2 — Web Client (Edge/Chrome)

### Stack
- Vanilla JS + Three.js (via CDN) + Web Bluetooth API
- Single `index.html` file, no build step
- Open directly in Edge or Chrome (requires HTTPS or localhost)

### Requirements

1. **BLE connection**
   - Button "Connect to Bat" → `navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] })`
   - Connect to GATT server → get primary service → get notify characteristic → `startNotifications()`
   - Also get command characteristic (write) for software buttons
   - Parse 17-byte payload → quaternion (w, x, y, z) as Float32 little-endian + flags byte
   - Display: connection status, packet rate (Hz), RSSI if available

2. **3D rendering (Three.js)**
   - Procedural cricket bat: cylinder handle + box blade (no external model needed for prototype)
   - Apply received quaternion to bat's rotation
   - Coordinate conversion: IMU is typically Z-up, Three.js is Y-up → rotate 90° around X on client side
   - Render at 60 fps, smooth with slerp between packets
   - Ground plane + stumps for reference
   - Camera: fixed behind batter, looking toward offside

3. **Swing detection (browser side)**
   - Buffer last 500 ms of quaternion samples
   - Compute angular velocity magnitude from quaternion delta
   - When magnitude > threshold (tunable, default 2.0 rad/s) → mark swing start
   - Capture 300 ms window after trigger → extract swing features
   - Also check BLE swing-start flag (bit 0 of flags byte) for sync

4. **Shot classification (rule-based)**
   - Extract from swing window:
     - **Swing plane angle** (average rotation during downswing) → direction: offside (0–90°), straight (90–120°), legside (120–180°)
     - **Peak velocity** → power rating (Low / Medium / High)
     - **Bat angle at contact** (relative to vertical) → height: ground (<30°), air (>30°)
     - **Follow-through angle** → completeness
   - Map to shot name (see classification table below)
   - Display: "Shot: Cover Drive — Offside — Ground — Medium Power"

5. **Software buttons (BLE commands)**
   - **[Take Guard]** → sends `0x03` → captures current orientation as reference
   - **[Recenter]** → sends `0x01` → resets yaw only
   - **[Full Reset]** → sends `0x02` → re-initializes filter
   - **[Clear Reference]** → sends `0x04` → reverts to absolute orientation
   - All buttons write to command characteristic

6. **UI layout**
   ```
   ┌─────────────────────────────────────┐
   │  [Connect to Bat]                   │
   │  Status: Connected (47 Hz)          │
   │                                     │
   │  ┌─────────────────────────────┐    │
   │  │                             │    │
   │  │      3D Bat View            │    │
   │  │                             │    │
   │  └─────────────────────────────┘    │
   │                                     │
   │  [Take Guard] [Recenter] [Reset]    │
   │                                     │
   │  Last shot: Cover Drive             │
   │  Direction: Offside                 │
   │  Height: Ground  Power: Medium      │
   │                                     │
   │  Swing count: 12                    │
   │  Battery: 87%                       │
   └─────────────────────────────────────┘
   ```

7. **Debug panel**
   - Raw quaternion values (w, x, y, z)
   - Angular velocity magnitude graph (canvas, scrolling)
   - Packet rate (Hz)
   - Swing detection log (timestamps + results)
   - Tuning sliders: threshold, sensitivity, coordinate offset

8. **Shot history**
   - Last 5 shots with timestamps
   - Each entry: shot name, direction, height, power, time

### Files
```
web/
├── index.html          (single file, all inline JS/CSS)
├── bat-model.js        (procedural bat geometry — cylinder handle + box blade)
└── shot-classifier.js  (rule-based classification logic)
```

No build step. Open `index.html` directly in Edge/Chrome. Serve via `python -m http.server` if Web Bluetooth requires localhost.

---

## BLE Protocol

### Packet format (17 bytes, little-endian)

| Offset | Size | Field | Type |
|---|---|---|---|
| 0 | 4 | q.w | float32 |
| 4 | 4 | q.x | float32 |
| 8 | 4 | q.y | float32 |
| 12 | 4 | q.z | float32 |
| 16 | 1 | flags | uint8 (bit 0 = swing-start) |

### Command frames (client → device)

| Length | Frame | Meaning |
|---|---|---|
| 1 byte | `0x01`..`0x0A` | Single-byte commands (recenter, reset, guard, stream, shot lifecycle, IMU reset) |
| 2 bytes | `0x0B`, `sampcnt` | Set BLE sampling cadence; `sampcnt` 1–4 (50/67/100/200 Hz), values outside 1–4 rejected |
| 8 bytes | `0xA1`, version, sequence, difficulty, bowled%, edge%, window LE | Versioned game configuration |

### State frame (device → client, 26 bytes, READ)

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | magic `0xA1` |
| 1 | 1 | version |
| 2 | 1 | config sequence |
| 3 | 1 | flags (bit 0 config accepted, bit 1 guard active) |
| 4 | 1 | difficulty |
| 5 | 1 | bowled % |
| 6 | 1 | edge % |
| 7 | 2 | capture window (LE) |
| 9 | 1 | status: bits 0–1 IMU reset, bits 2–3 shot lifecycle, bits 4–5 sampling-cadence code (sampcnt − 1) |
| 10 | 16 | stance quaternion w/x/y/z (float32 LE) |

### UUIDs

| Name | UUID |
|---|---|
| Service | `12345678-1234-1234-1234-123456789abc` |
| Notify (quaternion stream) | `12345678-1234-1234-1234-123456789abd` |
| Command (write) | `12345678-1234-1234-1234-123456789abe` |

### Coordinate convention

- IMU (QMI8658): X-forward, Y-left, Z-up (typical)
- Three.js/Unity: X-right, Y-up, Z-forward
- Conversion: rotate quaternion by (−90° around X) on the client side
- Document which side does the conversion (recommend: client side, so firmware stays board-agnostic)

---

## Shot Classification Rules

### Direction (from swing plane angle)

```
swing_plane = atan2(avg_gyro_y, avg_gyro_x) in degrees

if swing_plane < 30:   direction = "Straight"
elif swing_plane < 90: direction = "Offside"
else:                  direction = "Legside"
```

### Height

```
if bat_angle_at_peak < 30°: height = "Ground"
else:                       height = "Air"
```

### Shot name mapping

| Direction | Height | Shot Name |
|---|---|---|
| Straight | Ground | Straight Drive |
| Offside | Ground | Cover Drive |
| Offside | Air | Square Cut / Upper Cut |
| Legside | Air | Hook / Pull |
| Legside | Ground | Flick / Sweep |

### Power rating (from peak angular velocity)

| Peak velocity | Rating |
|---|---|
| < 3.0 rad/s | Low |
| 3.0 – 6.0 rad/s | Medium |
| > 6.0 rad/s | High |

### Tunable thresholds (expose as sliders in debug panel)
- Swing detection threshold (default: 2.0 rad/s)
- Swing plane boundaries (default: 30°, 90°)
- Height boundary (default: 30°)
- Power boundaries (default: 3.0, 6.0 rad/s)

---

## Web Bluetooth test snippet

```javascript
const SERVICE_UUID = '12345678-1234-1234-1234-123456789abc';
const NOTIFY_UUID  = '12345678-1234-1234-1234-123456789abd';
const CMD_UUID     = '12345678-1234-1234-1234-123456789abe';

// Connect
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: [SERVICE_UUID] }]
});
const server  = await device.gatt.connect();
const service = await server.getPrimaryService(SERVICE_UUID);
const notifyChar = await service.getCharacteristic(NOTIFY_UUID);
const cmdChar    = await service.getCharacteristic(CMD_UUID);

// Subscribe to quaternion stream
await notifyChar.startNotifications();
notifyChar.addEventListener('characteristicvaluechanged', (e) => {
  const v = e.target.value;
  const q = {
    w: v.getFloat32(0, true),
    x: v.getFloat32(4, true),
    y: v.getFloat32(8, true),
    z: v.getFloat32(12, true)
  };
  const flags = v.getUint8(16);
  const swingStart = (flags & 0x01) !== 0;
  // Apply to Three.js bat
  bat.quaternion.set(q.x, q.y, q.z, q.w);
  if (swingStart) onSwingStart();
});

// Send command
async function sendCommand(cmd) {
  await cmdChar.writeValue(new Uint8Array([cmd]));
}
// Take Guard:  sendCommand(0x03)
// Recenter:    sendCommand(0x01)
// Full Reset:  sendCommand(0x02)
// Clear Ref:   sendCommand(0x04)
```

---

## Testing Plan

1. **Flash firmware** → verify serial output shows quaternion streaming at 200 Hz
2. **Open index.html in Edge** → click Connect → verify 3D bat moves with board rotation
3. **Swing the board** → verify swing detection triggers and shot classification displays
4. **Test all 5 shot types** → tune thresholds until ≥60% accuracy
5. **Mount board on bat handle** → test with real swings
6. **(Later)** Port to Unity + Android TV with BLE plugin

---

## Success Criteria

- 3D bat orientation matches physical board rotation within 5°
- Swing detection catches ≥90% of real swings
- Shot classification ≥60% accuracy on rule-based (target 85%+ with ML later)
- BLE connection stable for ≥5 minutes continuous use
- Battery lasts ≥2 hours on 500 mAh LiPo
- "Take Guard" makes all measurements relative to batter's stance

---

## Notes for the Developer

- Start with firmware + browser client only. Do not touch Unity/TV until browser pipeline is proven.
- Use `Serial.println` liberally in firmware for debugging.
- Web Bluetooth requires HTTPS or localhost — serve via `python -m http.server` or use `localhost`.
- QMI8658 library: check Waveshare's GitHub for the official example; gyro data may need axis remapping depending on board orientation.
- If Madgwick drifts too much, reduce beta to 0.05 or add a simple low-pass on gyro input.
- All control actions are software-driven via BLE command characteristic — no physical button needed on the board.
- For cricket, the "Take Guard" command is the most important — it makes every measurement relative to the batter's stance, which is far more useful than any absolute reset.
