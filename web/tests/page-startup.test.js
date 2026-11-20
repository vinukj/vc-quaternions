const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const webDir = path.join(__dirname, '..');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.listeners = new Map();
    this.attributes = new Map();
    this.children = [];
    this.classNames = new Set();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.disabled = id === 'history-download' || id === 'history-clear';
    this.open = false;
    this.hidden = id === 'history-list' || id === 'game-outcome-card';
    this.width = 0;
    this.height = 0;
    this.classList = {
      add: name => this.classNames.add(name),
      remove: name => this.classNames.delete(name),
      contains: name => this.classNames.has(name),
      toggle: (name, force) => {
        if (force === undefined ? !this.classNames.has(name) : force) this.classNames.add(name);
        else this.classNames.delete(name);
      },
    };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return { width: 290, height: 290 };
  }

  getContext(type) {
    if (type !== '2d') return null;
    return {
      setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, ellipse() {}, fill() {}, save() {}, restore() {}, clip() {},
      stroke() {}, strokeText() {}, fillText() {}, setLineDash() {}, moveTo() {}, lineTo() {}, closePath() {},
    };
  }

  prepend(child) { this.children.unshift(child); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
}

test('shot map starts without loading the optional Three.js preview', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const appendedScripts = [];
  const persistedConfig = new Map();
  const document = {
    getElementById: id => elements.get(id),
    createElement: tag => new FakeElement(tag),
    head: { appendChild: script => appendedScripts.push(script) },
  };
  const window = {
    devicePixelRatio: 1,
    addEventListener() {},
    localStorage: {
      getItem: key => persistedConfig.get(key) ?? null,
      setItem: (key, value) => persistedConfig.set(key, String(value)),
    },
  };
  const context = vm.createContext({
    window,
    document,
    navigator: {},
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    console,
  });

  for (const file of ['direction-tracker.js', 'wagon-wheel.js', 'shot-classifier.js', 'game-layer.js', 'shot-report.js', 'shot-practice.js', 'shot-history.js', 'quaternion-packet-gate.js', 'shot-guard.js', 'device-shot-control.js', 'ble-command-queue.js', 'stream-recovery.js', 'device-config.js', 'stance-calibration.js', 'ble-session-setup.js']) {
    vm.runInContext(fs.readFileSync(path.join(webDir, file), 'utf8'), context, { filename: file });
  }
  let practiceOptions;
  let practiceInstance;
  context.ShotPractice.create = options => {
    practiceOptions = options;
    practiceInstance = {
      state: 'ready', lastResult: null,
      setCaptureMs: value => { practiceInstance.captureMs = value; return true; },
      start: async () => true, cancel() {}, addSample() { return false; },
    };
    return practiceInstance;
  };
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.equal(inlineScripts.length, 1, 'expected one application bootstrap script');
  vm.runInContext(inlineScripts[0], context, { filename: 'web/index.html:inline-script' });

  assert.equal(elements.get('status').textContent, 'Ready — click "Connect to Bat"');
  assert.ok(elements.get('btn-air-mouse').listeners.has('click'), 'PowerplAi Tracker action is visible and wired');
  assert.ok(elements.get('history-toggle').listeners.has('click'), 'history disclosure is wired');
  assert.ok(elements.get('history-download').listeners.has('click'), 'CSV download control is wired');
  assert.ok(elements.get('history-clear').listeners.has('click'), 'clear-history control is wired');
  assert.equal(elements.get('history-download').disabled, true, 'CSV download starts disabled until a shot is captured');
  assert.equal(elements.get('history-clear').disabled, true, 'clear starts disabled while history is empty');
  assert.equal(elements.get('history-list').hidden, true, 'history starts collapsed');
  assert.deepEqual(['game-difficulty', 'game-bowled-prob', 'game-edge-prob', 'game-capture-window-ms'].map(id => elements.get(id).value),
    ['dry_pitch', '3', '10', '525'], 'game settings start with the agreed defaults');
  assert.equal(practiceOptions.captureMs, 525, 'the configured default reaches the capture cycle');
  for (const id of ['game-difficulty', 'game-bowled-prob', 'game-edge-prob', 'game-capture-window-ms']) {
    assert.ok(elements.get(id).listeners.has('change'), `${id} persists and applies when changed`);
  }
  elements.get('game-capture-window-ms').value = '400';
  elements.get('game-capture-window-ms').listeners.get('change')();
  assert.equal(practiceInstance.captureMs, 400, 'changing the capture duration updates future shot windows');
  assert.equal(JSON.parse(persistedConfig.get('powerplai.game_config')).capture_window_ms, 400);

  const rawShot = {
    direction: 'Right', fieldSector: 'Point', shotType: 'Cut-like swing',
    aggression: 'Aggressive', height: 'Estimated ground-level', estimatedLoftDegrees: 5,
    peakAngularVelocityDegS: 293, dominantMotionVector: { x: 0.8, y: 0 },
  };
  const originalShot = structuredClone(rawShot);
  practiceOptions.onResult(rawShot, [{ w: 1, x: 0, y: 0, z: 0, t: 10 }], {
    captureMs: 400, sampleCount: 20, sampleSpanMs: 380,
    context: { capture_window_ms: 400 },
  });
  assert.deepEqual(rawShot, originalShot, 'game simulation does not mutate raw classifier data');
  assert.equal(elements.get('game-outcome-card').hidden, false, 'the browser game result is shown separately');
  assert.match(elements.get('shot-meta').children.map(child => child.textContent).join(' '),
    /Capture: 400 ms configured · 20 samples received · 380 ms observed span/,
    'the displayed shot reports the selected window separately from real packet timing');
  assert.match(elements.get('shot-meta').children.map(child => child.textContent).join(' '),
    /Direction zone: Offside back/, 'the primary result includes the broad batter-relative direction zone');
  const historyMetrics = elements.get('history-list').children[0].children[1];
  const captureMetric = historyMetrics.children.findIndex(child => child.textContent === 'Capture');
  assert.ok(captureMetric >= 0, 'shot history includes capture diagnostics');
  assert.match(historyMetrics.children[captureMetric + 1].textContent,
    /400 ms configured · 20 samples received · 380 ms observed span/);
  const displayedOutcome = JSON.parse(elements.get('game-outcome-json').textContent);
  assert.equal(displayedOutcome.direction, 'point');
  assert.equal(displayedOutcome.shot, 'cut_like_swing', 'without a direction candidate, the normalized family is retained as the game shot');
  assert.equal(displayedOutcome.family, 'Cut-like swing');
  assert.match(inlineScripts[0], /deviceShotControl\.requestStart\(\)/, 'shot practice is started by the ESP32 touch button');
  const webStartHandler = inlineScripts[0].slice(
    inlineScripts[0].indexOf("btnAirMouse.addEventListener('click'"),
    inlineScripts[0].indexOf("btnGuard.addEventListener('click'"),
  );
  assert.match(webStartHandler, /deviceShotControl\.requestStart\(\)/,
    'web START uses the same guarded shot cycle as the ESP32 touch button');
  assert.doesNotMatch(webStartHandler, /startAirMouse|stopAirMouse/,
    'web START must not switch to the legacy continuous tracker');
  assert.match(webStartHandler, /deviceShotControl\.requestStart\(\)/,
    'web START and LCD START share the same guarded shot cycle');
  assert.match(inlineScripts[0], /captureReadout\.textContent = String\(detail\.remaining/, 'the web UI visibly renders each countdown number');
  assert.match(inlineScripts[0], /const sessionSetup = BleSessionSetup\.create\(/, 'BLE session setup owns config and stance readiness');
  assert.match(inlineScripts[0], /sessionSetup\.calibrateStance\(/, 'the explicit stance action calibrates once per connection');
  assert.match(elements.get('stance-reference').textContent, /saved pose becomes Straight · 0° for this session/i,
    'the initial UI explains how the captured stance defines the neutral reference');
  assert.match(inlineScripts[0], /Saved stance direction: Straight · 0° session-relative baseline/,
    'stance calibration confirmation identifies the session-relative direction');
  assert.match(inlineScripts[0], /Shot directions are measured from this pose; this is not a compass heading/,
    'the UI explains the relative frame without implying absolute yaw');
  assert.match(inlineScripts[0], /ESP32 ACK ✓.*Browser uses this window/,
    'the UI reports verified ESP32 readback, not only a browser-local setting');
  assert.match(inlineScripts[0], /browser uses this window.*BLE stays at 50 Hz/i,
    'the UI separates browser capture duration from the fixed BLE notification cadence');
  assert.match(inlineScripts[0], /referenceQuaternion: shotGuardReference/,
    'shot classification uses the same saved stance frame as the live direction tracker');
  assert.match(inlineScripts[0], /showShot\(result, samples, geometry, gameOutcome, captureDetail\)/,
    'the configured window and observed packet diagnostics reach the result display');
  assert.doesNotMatch(inlineScripts[0], /onTakeGuard\s*:/, 'shot countdown never recaptures session stance');
  assert.doesNotMatch(inlineScripts[0], /detectSwing\(|classifySwing\(/,
    'the continuous legacy detector must not create extra history entries outside a one-second START capture');
  const prepareStart = inlineScripts[0].indexOf('async function prepareShotCapture()');
  const prepareEnd = inlineScripts[0].indexOf('async function takeStance()', prepareStart);
  assert.doesNotMatch(inlineScripts[0].slice(prepareStart, prepareEnd), /ShotGuard\.capture\(/,
    'shot preparation only checks the stream; stance calibration is explicit');
  assert.ok(elements.get('advanced-tools').listeners.has('toggle'), 'opening Advanced initializes the optional preview');
  assert.equal(appendedScripts.length, 0, 'the optional 3D library is not requested during normal startup');
  assert.ok(html.indexOf('id="track-panel"') < html.indexOf('id="practice-controls"'), 'the cricket field is the primary pane');
  const historySection = html.indexOf('<section id="history"');
  assert.ok(historySection > html.indexOf('</main>'), 'history follows the primary practice UI');
  assert.ok(historySection > html.indexOf('</details>'), 'history is outside Advanced tools and diagnostics');
  assert.match(html, /aria-expanded="false" aria-controls="history-list"/);
  assert.match(html, /id="history-download"[^>]*aria-label="Download shot history as CSV"/);
  assert.match(html, /id="history-clear"[^>]*aria-label="Clear shot history"/);
  assert.match(html, /id="game-outcome-json"/);
  assert.match(html, /id="game-config"/);
  assert.match(html, /\$\{resultGeometry\.fieldZone\} · \$\{resultGeometry\.direction\} · \$\{resultGeometry\.mappedSector\}/,
    'the wagon-wheel callout exposes the broad direction zone next to its detailed sector');
  assert.match(html, /<script src="game-layer\.js"><\/script>/);
  assert.doesNotMatch(html, /Swing history \(last 5\)/i);
  const mainMarkup = html.slice(html.indexOf('<main id="practice">'), html.indexOf('</main>'));
  assert.doesNotMatch(mainMarkup, /id="btn-shot-start"/, 'the LCD button owns shot-cycle start');
  assert.match(mainMarkup, /id="btn-air-mouse"/);

  const advanced = elements.get('advanced-tools');
  advanced.open = true;
  advanced.listeners.get('toggle')();
  assert.equal(appendedScripts.length, 1);
  appendedScripts[0].onerror();
  assert.ok(elements.get('canvas-wrap').classList.contains('preview-unavailable'));
  assert.match(elements.get('canvas-overlay').textContent, /PowerplAi Tracker works without it/);

  const historyToggle = elements.get('history-toggle');
  historyToggle.listeners.get('click')();
  assert.equal(elements.get('history-list').hidden, false);
  assert.equal(historyToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(historyToggle.textContent, 'Show history ▲');
  historyToggle.listeners.get('click')();
  assert.equal(elements.get('history-list').hidden, true);
  assert.equal(historyToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(historyToggle.textContent, 'Show history ▼');
  elements.get('history-clear').listeners.get('click')();
  assert.equal(elements.get('history-title').textContent, 'Shot history (0)');
  assert.equal(elements.get('history-download').disabled, true);
  assert.equal(elements.get('history-clear').disabled, true);
  assert.deepEqual(elements.get('history-list').children, []);
});

test('PowerplAi Tracker requires session readiness and Stop keeps BLE connected', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const start = html.slice(
    html.indexOf('async function startAirMouse()'),
    html.indexOf('function stopAirMouse()', html.indexOf('async function startAirMouse()')),
  );
  const streamStart = start.indexOf('sendCommand(0x05)');

  assert.ok(streamStart >= 0, 'tracker starts the stream when needed');
  assert.match(start, /!sessionSetup\.isReady\(\)/, 'tracker requires the current config and verified stance');
  assert.doesNotMatch(start, /ShotGuard\.capture\(/, 'tracker does not silently capture a new stance');
  const guardHelper = fs.readFileSync(path.join(webDir, 'shot-guard.js'), 'utf8');
  assert.match(guardHelper, /CLEAR_GUARD/);
  assert.match(guardHelper, /TAKE_GUARD/);
  assert.equal((guardHelper.match(/waitFor\(PACKETS_PER_TRANSITION/g) || []).length, 2);

  const stopStart = html.indexOf('function stopAirMouse()');
  const stopEnd = html.indexOf('function updateConnectedStatus()', stopStart);
  const stop = html.slice(stopStart, stopEnd);
  assert.doesNotMatch(stop, /sendCommand\(0x06\)|\.gatt\.disconnect\(/);
});

test('a stalled sensor stream restarts notifications without deliberately disconnecting GATT', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const watchdogStart = html.indexOf('// Keep the rate/status useful when notifications stop arriving.');
  const watchdog = html.slice(watchdogStart, html.indexOf('/* Init. */', watchdogStart));
  assert.match(html, /streamRecovery\s*=\s*StreamRecovery\.create\(/);
  assert.match(watchdog, /streamRecovery\.check\(now\)/);
  assert.doesNotMatch(watchdog, /\.gatt\.disconnect\(\)/,
    'notification stalls may restart streaming but must keep the user-owned BLE connection');
});

test('shot output uses the same batched geometry for the map, accessibility label, and console report', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  assert.match(html, /const resultGeometry = displayingResult\s*\?\s*WagonWheel\.shotGeometry\(/);
  assert.match(html, /sector,\s*snapToSector:\s*Boolean\(displayingResult && resultGeometry\.snapToSector\),\s*battingHand:/,
    'the canonical result sector and snap behavior reach the ground renderer');
  assert.match(html, /showShot\(result, samples, geometry, gameOutcome, captureDetail\)/);
  assert.match(html, /ShotReport\.log\(r, samples, console, undefined, geometry, gameOutcome\)/);
  assert.equal([...html.matchAll(/ShotReport\.log\(/g)].length, 1,
    'each completed capture is reported only once');
});
