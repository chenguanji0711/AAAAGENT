// The settings surface and its wiring. These checks read the real files rather than a mock, so a
// renamed option or a dropped control fails here instead of only in the running window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.mjs', import.meta.url), 'utf8');
const controls = await readFile(new URL('../pet-window-controls.mjs', import.meta.url), 'utf8');
const swift = await readFile(new URL('../native/motion-preferences.swift', import.meta.url), 'utf8');

const BEHAVIOURS = [
  ['Idle', '待机'], ['Breathing', '呼吸'], ['Blink', '眨眼'], ['LookAt', '注视'], ['Talking', '说话'],
  ['Happy', '开心'], ['Surprised', '惊讶'], ['Shy', '害羞'], ['Sleep', '睡觉'], ['Drag', '拖动'], ['Interact', '互动'],
];

test('the settings window offers every behaviour with its Chinese label', () => {
  const block = html.match(/<select id="motion-animation">([\s\S]*?)<\/select>/)?.[1] ?? '';
  for (const [name, label] of BEHAVIOURS) {
    assert.match(block, new RegExp(`<option value="${name}">${label}</option>`), `${name} is offered as ${label}`);
  }
  const offered = [...block.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(offered, BEHAVIOURS.map(([name]) => name), 'no extra behaviour is silently offered');
});

test('the knobs carry the documented ranges and defaults', () => {
  const control = (id) => html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] ?? '';
  assert.match(control('motion-amount'), /min="0" max="1" step="0\.05" value="0\.6"/, 'amount is 0..1 default 0.6');
  assert.match(control('motion-speed'), /min="0\.2" max="2" step="0\.05" value="0\.75"/, 'speed is 0.2..2 default 0.75');
  assert.match(control('motion-frequency'), /min="0" max="2" step="0\.05" value="1"/, 'frequency is 0..2 default 1');
  assert.match(control('motion-tracking'), /type="checkbox" checked/, 'tracking defaults to on');
  const rates = html.match(/<select id="motion-rate">([\s\S]*?)<\/select>/)?.[1] ?? '';
  assert.deepEqual([...rates.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['60', 'high', 'eco']);
  assert.match(html, /<output id="motion-stats"/, 'a frame-time readout exists');
});

test('the page drives rendering through the scheduler instead of a hand-rolled gate', () => {
  assert.match(main, /import \{ FrameScheduler \} from '\.\/frame-scheduler\.mjs'/, 'the scheduler is imported');
  assert.match(main, /frameScheduler\.tick\(at, \{ visible: !petWindow\.collapsed && !document\.hidden \}\)/, 'visibility is handed to the scheduler');
  assert.match(main, /frameScheduler\.record\(performance\.now\(\) - started\)/, 'the draw time is measured, not assumed');
  assert.match(main, /frameScheduler\.stats\(\)/, 'the readout uses real samples');
  assert.doesNotMatch(main, /at - lastRender > 32/, 'the old fixed 30 FPS gate is gone');
});

test('the requested behaviour is passed through and the refusal is reported', () => {
  // Whether a silent Talking request opens the mouth is the renderer's decision (its state machine
  // only drives the mouth while audio plays). The page must not pre-empt that, but it must not
  // claim success either.
  assert.doesNotMatch(main, /appliedAnimation/, 'no stale local rewrite of the requested state survives');
  assert.match(main, /const accepted = rendererCapability\('setAnimationState', selectedAnimation\)/, 'the boolean result is read');
  assert.match(main, /if \(accepted === false\) report\(\{ type: 'animation-state-rejected'/, 'a refusal is reported');
});

test('the click region is described as coarse, not as precise hit testing', () => {
  assert.match(main, /Coarse screen partition, not an ArtMesh hit test/, 'the approximation is stated');
  assert.match(main, /regionForClick/, 'the region helper exists');
  assert.match(main, /rendererCapability\('beginAttention', region\)/, 'the region is passed to the renderer');
});

test('drag holds a Drag pose and the release hands control back', () => {
  assert.match(controls, /onDragChange\?\.\(true\)/, 'drag start is reported');
  assert.match(controls, /onDragChange\?\.\(false\)/, 'drag end is reported');
  assert.match(controls, /onPetClick\(event\)/, 'the click event reaches the page');
  assert.match(main, /onDragChange: applyDragState,/, 'the drag handler is the module-scope applyDragState');
  assert.match(main, /function applyDragState\(dragging\) \{/, 'and it is defined at module scope');
});

test('settings persist through the native host, with localStorage only for a browser preview', () => {
  assert.match(main, /native\('shell', \{ type: 'set_motion', settings: motionConfig, animation: selectedAnimation \}\)/, 'the host is told to persist');
  assert.match(main, /else writeStoredMotion\(/, 'the browser preview falls back to localStorage');
  assert.match(main, /motionConfig: applyHostMotionConfig,/, 'the host can push settings back through a named function');
});

test('the native helper keeps preferences in its own suite', () => {
  assert.match(swift, /UserDefaults\(suiteName: name\)/, 'a named suite is used');
  assert.doesNotMatch(swift, /UserDefaults\.standard\.set\(/, 'nothing is written into the shared domain');
  for (const rate of ['"60"', '"high"', '"eco"']) assert.ok(swift.includes(rate), `the ${rate} rate is known to the helper`);
});

test('the settings surface matches the renderer state list exactly', async () => {
  const {ANIMATION_STATES, DEFAULT_MOTION_SETTINGS, normalizeMotionSettings} = await import('../animation-state.mjs');
  const block = html.match(/<select id="motion-animation">([\s\S]*?)<\/select>/)?.[1] ?? '';
  const offered = [...block.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(offered, [...ANIMATION_STATES], 'the window offers exactly the states the renderer accepts');

  // The controls must start on the renderer's own defaults, or the first frame would differ from
  // the stored settings.
  assert.equal(Number(html.match(/<input id="motion-amount"[^>]*value="([^"]+)"/)[1]), DEFAULT_MOTION_SETTINGS.amount);
  assert.equal(Number(html.match(/<input id="motion-speed"[^>]*value="([^"]+)"/)[1]), DEFAULT_MOTION_SETTINGS.speed);
  assert.equal(Number(html.match(/<input id="motion-frequency"[^>]*value="([^"]+)"/)[1]), DEFAULT_MOTION_SETTINGS.frequency);
  assert.equal(html.match(/<select id="motion-rate">[\s\S]*?<option value="([^"]+)" selected/)?.[1] ?? DEFAULT_MOTION_SETTINGS.rate, DEFAULT_MOTION_SETTINGS.rate);
  assert.match(html, /<input id="motion-tracking" type="checkbox" checked/);

  // The page must call the shared normaliser rather than re-clamping the fields itself.
  assert.match(main, /import \{[^}]*normalizeMotionSettings[^}]*\} from '\.\/animation-state\.mjs'/, 'the shared normaliser is imported');
  assert.match(main, /motionConfig = normalizeMotionSettings\(config, motionConfig\)/, 'host config goes through it');
  assert.match(main, /normalizeMotionSettings\(\{ \[key\]: Number\(node\.value\) \}, motionConfig\)/, 'slider input goes through it');

  // A couple of contract checks on the shared function itself, at the boundary the page relies on.
  assert.deepEqual(normalizeMotionSettings({}, undefined), {...DEFAULT_MOTION_SETTINGS});
  assert.equal(normalizeMotionSettings({amount: 9, speed: -1, frequency: 9}, DEFAULT_MOTION_SETTINGS).amount, 1);
  assert.equal(normalizeMotionSettings({speed: -1}, DEFAULT_MOTION_SETTINGS).speed, 0.2);
  assert.equal(normalizeMotionSettings({rate: 'turbo'}, DEFAULT_MOTION_SETTINGS).rate, '60');
  assert.equal(normalizeMotionSettings({tracking: 'yes'}, DEFAULT_MOTION_SETTINGS).tracking, true);
});

test('the shared state machine owns sleep, speech, drag and gaze layering', async () => {
  const {AnimationStateMachine} = await import('../animation-state.mjs');
  const sleeping = new AnimationStateMachine();
  sleeping.request('Sleep');
  let current = sleeping.advance(0.1, {state: 'idle'});
  assert.equal(current.state, 'Sleep', 'a Sleep request holds');
  assert.equal(current.layers.Blink, false, 'sleep closes the blink layer instead of blinking');
  current = sleeping.advance(0.1, {state: 'speaking'});
  assert.equal(current.state, 'Talking', 'real speech wakes the character out of Sleep');
  assert.equal(current.layers.Blink, true, 'and blinking comes back');

  const dragging = new AnimationStateMachine();
  assert.equal(dragging.advance(0.1, {dragging: true}).state, 'Drag', 'dragging overrides the request');
  const gazing = new AnimationStateMachine();
  assert.equal(gazing.advance(0.1, {pointer: {x: 0.5, y: 0.5}}).layers.LookAt, true, 'the gaze layer follows a real pointer');
  assert.equal(gazing.advance(0.1, {pointer: null}).layers.LookAt, false, 'and releases without one');
  assert.equal(new AnimationStateMachine().request('Nonexistent'), false, 'an unknown state is refused');
});

test('the mouth stays the renderer\'s decision and only opens for real speech', async () => {
  const renderer = await readFile(new URL('../cubism-renderer.mjs', import.meta.url), 'utf8');
  // The page hands over the requested behaviour; the renderer decides the mouth from the playback
  // state, so a manual Talking request can never open it over silence.
  assert.match(renderer, /view\.state === 'speaking'/, 'the mouth gate reads the playback state');
});

test('the gaze mapping is executed, not just grepped, and matches the core convention', () => {
  // main.mjs is a page module with no test seams, so the shipped function is lifted out and
  // executed for real. A regex over the source would not catch a wrong sign or a forgotten centre.
  const match = main.match(/function toLookAtPoint\([\s\S]*?\n\}/);
  assert.ok(match, 'toLookAtPoint is present');
  const toLookAtPoint = new Function(`${match[0]}; return toLookAtPoint;`)();
  const box = {left: 0, top: 0, width: 100, height: 100};

  assert.deepEqual(toLookAtPoint(50, 50, box), {x: 0, y: 0}, 'the centre of the character maps to the origin, not to the right');
  assert.deepEqual(toLookAtPoint(100, 0, box), {x: 1, y: 1}, 'the top-right corner is +x and +y: the core points y up');
  assert.deepEqual(toLookAtPoint(0, 100, box), {x: -1, y: -1}, 'the bottom-left corner is -x and -y');
  assert.deepEqual(toLookAtPoint(75, 25, box), {x: 0.5, y: 0.5}, 'intermediate positions stay linear');
  // A box offset from the window origin must be respected, or an inset layout would drift.
  assert.deepEqual(toLookAtPoint(150, 150, {left: 100, top: 100, width: 100, height: 100}), {x: 0, y: 0});
  // Out-of-range and missing inputs are refused rather than producing a bogus gaze.
  assert.deepEqual(toLookAtPoint(-80, 300, box), {x: -1, y: -1}, 'values outside the box clamp to the axis ends');
  assert.equal(toLookAtPoint(Number.NaN, 10, box), null, 'a non-finite coordinate is refused');
  assert.equal(toLookAtPoint(10, 10, null), null, 'a missing box is refused');
  assert.equal(toLookAtPoint(10, 10, {left: 0, top: 0, width: 0, height: 10}), null, 'a degenerate box is refused');
});

test('gaze is released on pointerleave and when tracking is switched off', () => {
  assert.match(main, /addEventListener\('pointerleave', \(\) => rendererCapability\('setLookAt', null\)\)/, 'leaving the character releases the gaze');
  assert.match(main, /if \(!motionConfig\.tracking\) rendererCapability\('setLookAt', null\)/, 'turning tracking off releases it too');
  assert.match(main, /if \(!motionConfig\.tracking\) return;/, 'and no stale point is sent while it is off');
});

test('a settings change never restarts the running action', () => {
  // Only an explicit choice (selectAnimation) or a brand-new renderer may request an action.
  assert.match(main, /function applyMotionConfig\(\{ persist = false, requestCurrentAnimation = false \} = \{\}\)/, 'the flag defaults to off');
  assert.match(main, /if \(requestCurrentAnimation\) requestAnimation\(\{ force: true \}\)/, 'only a new renderer asks');
  assert.match(main, /applyMotionConfig\(\{ requestCurrentAnimation: true \}\)/, 'the renderer-ready path asks once');
  assert.doesNotMatch(main, /applyMotionConfig[^\n]*setAnimation\(/, 'no config path restarts the animation');
  assert.match(main, /function bindMotionUi\(\)/, 'and the UI binder is a module-scope declaration');
  // bindMotionUi must be declared at column 0: a block-scoped copy would make the host callback throw.
  assert.match(main, /^function bindMotionUi\(\) \{/m, 'bindMotionUi is not block-scoped');
  assert.match(main, /^function updateMotionStats\(\) \{/m, 'updateMotionStats is not block-scoped');
});

/** Pulls a delivered function out of the page module so it can be executed, not grepped. */
function extractFunction(name) {
  const match = main.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} is defined at module scope`);
  return match[0];
}

/** A stand-in module scope for the motion functions: every collaborator is recorded, not faked away. */
function motionHarness() {
  const body = `
    let selectedAnimation = 'Idle';
    let animationOwner = null;
    let renderer = { id: 'r1' };
    let motionConfig = { amount: 0.6, speed: 0.75, frequency: 1, rate: '60', tracking: true };
    const calls = [];
    const reported = [];
    const report = value => reported.push(value);
    const normalizeMotionSettings = (patch, prior) => ({ ...prior, ...patch });
    const hosted = true;
    const native = (name, value) => calls.push([name, value]);
    const writeStoredMotion = () => {};
    const frameScheduler = { configure: value => calls.push(['configure', value]) };
    function rendererCapability(name, ...args) { calls.push([name, ...args]); return true; }
    let uiBindings = 0;
    function bindMotionUi() { uiBindings += 1; }
    ${['requestAnimation', 'selectAnimation', 'applyDragState', 'applyMotionConfig', 'applyHostMotionConfig'].map(extractFunction).join('\n')}
    return {
      requestAnimation, selectAnimation, applyDragState, applyMotionConfig, applyHostMotionConfig,
      calls, reported,
      selected: () => selectedAnimation,
      uiBindings: () => uiBindings,
      setRenderer: value => { renderer = value; },
    };
  `;
  return new Function(body)();
}

test('a settings change reconfigures without restarting the running action', () => {
  const rig = motionHarness();
  rig.applyMotionConfig({ persist: false });
  rig.applyMotionConfig({ persist: false });
  assert.equal(rig.calls.filter(call => call[0] === 'configureMotion').length, 2, 'the knobs reach the renderer each time');
  assert.equal(rig.calls.filter(call => call[0] === 'configure').length, 2, 'and the scheduler is reconfigured');
  assert.equal(rig.calls.filter(call => call[0] === 'setAnimationState').length, 0, 'but the action is never restarted');
});

test('a new renderer receives the settings and the current action exactly once', () => {
  const boot = motionHarness();
  boot.applyMotionConfig({ requestCurrentAnimation: true });
  assert.equal(boot.calls.filter(call => call[0] === 'setAnimationState').length, 1, 'the boot path asks once');
  boot.calls.length = 0;
  boot.applyMotionConfig();
  assert.equal(boot.calls.filter(call => call[0] === 'setAnimationState').length, 0, 'and never again for the same instance');
});

test('dragging applies a temporary pose and never pollutes the selection', () => {
  const rig = motionHarness();
  rig.selectAnimation('Shy');
  assert.equal(rig.selected(), 'Shy');
  rig.calls.length = 0;

  rig.applyDragState(true);
  assert.deepEqual(rig.calls, [['setAnimationState', 'Drag']], 'the drag pose goes straight to the renderer');
  assert.equal(rig.selected(), 'Shy', 'the user selection is untouched by the drag');

  rig.calls.length = 0;
  rig.applyDragState(false);
  assert.deepEqual(rig.calls, [['setAnimationState', 'Shy']], 'releasing returns to the chosen action, not Drag');
});

test('re-picking the same transient action replays it', () => {
  const rig = motionHarness();
  rig.selectAnimation('Blink');
  rig.calls.length = 0;
  rig.selectAnimation('Blink');
  assert.deepEqual(rig.calls, [['setAnimationState', 'Blink']], 'an explicit re-pick is not swallowed by de-duplication');
});

test('the host callback is callable and only requests an action when it really changed', () => {
  const rig = motionHarness();
  // This is the exact failure the scope bug produced: calling the host callback threw.
  assert.doesNotThrow(() => rig.applyHostMotionConfig({ amount: 0.9, animation: 'Happy' }));
  assert.equal(rig.uiBindings(), 1, 'the settings UI is re-bound');
  assert.equal(rig.calls.filter(call => call[0] === 'setAnimationState').length, 1, 'a changed action is requested once');
  assert.deepEqual(rig.calls.filter(call => call[0] === 'configureMotion').length, 1, 'and the knobs are applied');

  rig.calls.length = 0;
  rig.applyHostMotionConfig({ amount: 0.9, animation: 'Happy' });
  assert.equal(rig.calls.filter(call => call[0] === 'setAnimationState').length, 0, 'a round-trip with the same action does not restart it');
  assert.equal(rig.applyHostMotionConfig(null), undefined, 'a missing payload is ignored');
});
