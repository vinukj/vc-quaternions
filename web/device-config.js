/* Versioned game-config and device-state frames for the BLE command characteristic. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeviceConfig = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const MAGIC = 0xA1;
  const VERSION = 1;
  const DIFFICULTIES = ['dry_pitch', 'green_pitch', 'flat_pitch'];
  const CAPTURE_WINDOWS = [400, 500, 525, 600, 700, 800, 900];
  const CONFIG_LENGTH = 8;
  const STATE_LENGTH = 26;
  // sampcnt command byte -> BLE notify divisor (IMU fusion stays at 200 Hz).
  const SAMPCNT_COMMAND = 0x0B;
  const SAMPcnt_TO_SKIP = { 1: 4, 2: 3, 3: 2, 4: 1 };
  const SAMPcnt_TO_HZ = { 1: 50, 2: 67, 3: 100, 4: 200 };

  function sampcntToHz(sampcnt) {
    return 200 / (SAMPcnt_TO_SKIP[sampcnt] || 4);
  }

  function encode(sequence, config) {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 255) throw new RangeError('sequence must be a byte');
    if (!DIFFICULTIES.includes(config.difficulty)) throw new RangeError('unsupported pitch difficulty');
    if (!Number.isInteger(config.bowled_prob) || config.bowled_prob < 0 || config.bowled_prob > 100 ||
        !Number.isInteger(config.edge_base_prob) || config.edge_base_prob < 0 || config.edge_base_prob > 100 ||
        config.bowled_prob + config.edge_base_prob > 100) throw new RangeError('invalid game probabilities');
    if (!CAPTURE_WINDOWS.includes(config.capture_window_ms)) throw new RangeError('unsupported capture window');
    return new Uint8Array([
      MAGIC, VERSION, sequence, DIFFICULTIES.indexOf(config.difficulty),
      config.bowled_prob, config.edge_base_prob,
      config.capture_window_ms & 0xff, config.capture_window_ms >> 8,
    ]);
  }

  function decode(value) {
    const bytes = value instanceof DataView
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : value instanceof ArrayBuffer ? new Uint8Array(value)
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array(value);
    if (bytes.length !== STATE_LENGTH || bytes[0] !== MAGIC || bytes[1] !== VERSION) {
      throw new RangeError('unsupported or incomplete ESP32 state response');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      sequence: bytes[2],
      configAccepted: Boolean(bytes[3] & 0x01),
      guardActive: Boolean(bytes[3] & 0x02),
      difficulty: DIFFICULTIES[bytes[4]] || null,
      bowled_prob: bytes[5],
      edge_base_prob: bytes[6],
      capture_window_ms: view.getUint16(7, true),
      imuResetStatus: ['idle', 'pending', 'complete', 'failed'][bytes[9] & 0x03],
      shotState: ['ready', 'start_requested', 'in_progress', 'unknown'][(bytes[9] >> 2) & 0x03],
      sampcnt: ((bytes[9] >> 4) & 0x03) + 1,
      guard: {
        w: view.getFloat32(10, true),
        x: view.getFloat32(14, true),
        y: view.getFloat32(18, true),
        z: view.getFloat32(22, true),
      },
    };
  }

  function matches(state, sequence, config) {
    return state.sequence === sequence && state.configAccepted &&
      state.difficulty === config.difficulty && state.bowled_prob === config.bowled_prob &&
      state.edge_base_prob === config.edge_base_prob && state.capture_window_ms === config.capture_window_ms;
  }

  return { MAGIC, VERSION, DIFFICULTIES, CAPTURE_WINDOWS, CONFIG_LENGTH, STATE_LENGTH,
    SAMPCNT_COMMAND, SAMPcnt_TO_SKIP, SAMPcnt_TO_HZ, sampcntToHz, encode, decode, matches };
});
