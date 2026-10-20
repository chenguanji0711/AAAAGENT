import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceLines, parseVoiceManifest, VOICE_COOLDOWN_MS, VOICE_MIN_GAP_MS } from '../voice-lines.mjs';

const manifest = {
  version: 1,
  categories: {
    greeting: [{ file: 'greeting-01.wav' }, { file: 'greeting-02.wav' }],
    pat: [{ file: 'pat-01.wav' }],
    happy: [{ file: 'happy-01.wav' }],
    curious: [{ file: 'curious-01.wav' }],
    sleepy: [{ file: 'sleepy-01.wav' }]
  }
};
/** Defers only the clip request, never the manifest lookup. */
function fetcherFor(body = manifest, { defer = false } = {}) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let firstClip = true;
  const fetcher = async url => {
    if (defer && firstClip && !String(url).endsWith('lines.json')) { firstClip = false; await pending; }
    return { ok: true, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  fetcher.release = () => release();
  return fetcher;
}
function audioFactory(started) {
  return () => ({
    state: 'running', currentTime: 0, destination: {},
    decodeAudioData: async () => ({ duration: 0.4 }), resume: async () => {},
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBufferSource() {
      const node = { onended: null, connect() {}, disconnect() {}, stop() {},
        start() { started.push(node); queueMicrotask(() => node.onended?.()); } };
      return node;
    }
  });
}
function build(t, { body = manifest, busy = () => false, gain = () => 1, now = () => 0, defer = false } = {}) {
  const started = [];
  const fetcher = fetcherFor(body, { defer });
  const lines = createVoiceLines({ base: new URL('pet://app/assets/voice/'), fetcher, gain, busy, now, contextFactory: audioFactory(started) });
  t.after(() => lines.dispose());
  return { lines, started, fetcher };
}

test('a manifest can never point outside the shipped voice directory', () => {
  const parsed = parseVoiceManifest({ categories: {
    greeting: [{ file: 'ok-01.wav' }, { file: '../secret.wav' }, { file: '/etc/passwd.wav' },
      { file: 'sub/dir.wav' }, { file: 'no-extension' }, { file: 'ok-02.mp3' }, 'plain.wav'],
    'Bad Name': [{ file: 'x.wav' }],
    empty: []
  } });
  assert.deepEqual(Object.keys(parsed.categories), ['greeting']);
  assert.deepEqual(parsed.categories.greeting.map(line => line.file), ['ok-01.wav', 'ok-02.mp3', 'plain.wav']);
  assert.equal(parsed.files, 3);
  assert.deepEqual(parseVoiceManifest(null), { version: 0, categories: {}, files: 0 });
  assert.ok(VOICE_MIN_GAP_MS < VOICE_COOLDOWN_MS, 'the global gap is shorter than the per-category cooldown');
});

test('a missing manifest simply leaves the feature off', async t => {
  const started = [];
  const silent = createVoiceLines({ base: new URL('pet://app/assets/voice/'), fetcher: async () => ({ ok: false }), contextFactory: audioFactory(started) });
  t.after(() => silent.dispose());
  assert.equal(await silent.load(), false);
  assert.equal(silent.enabled, false);
  assert.equal(await silent.action('happy'), false);
  assert.equal(started.length, 0);
});

test('a mapped action plays once and an unmapped one never does', async t => {
  const { lines, started } = build(t);
  assert.equal(await lines.load(), true);
  assert.equal(lines.stats.files, 6);
  assert.equal(await lines.action('idle'), false, 'ambient states stay silent');
  assert.equal(lines.stats.skippedUnmapped, 1);
  assert.equal(started.length, 0);
  assert.equal(await lines.action('pat-gentle'), true);
  assert.equal(lines.stats.spoken, 1);
  assert.equal(lines.stats.lastCategory, 'pat');
  assert.equal(lines.stats.lastFile, 'pat-01.wav');
  assert.equal(started.length, 1);
});

test('an action line never plays over the dynamic reply and never plays while muted', async t => {
  const busy = build(t, { busy: () => true });
  await busy.lines.load();
  assert.equal(await busy.lines.action('happy'), false);
  assert.equal(busy.lines.stats.skippedBusy, 1);
  assert.equal(busy.started.length, 0);

  const muted = build(t, { gain: () => 0 });
  await muted.lines.load();
  assert.equal(await muted.lines.action('happy'), false);
  assert.equal(muted.lines.stats.skippedSilent, 1);
  assert.equal(muted.started.length, 0);
});

test('cooldowns stop repeats and the same clip is not chosen twice in a row', async t => {
  let clock = 0;
  const { lines } = build(t, { now: () => clock });
  await lines.load();
  assert.equal(await lines.action('pat-gentle'), true);
  clock += 1_000;
  assert.equal(await lines.action('happy'), false, 'the global minimum gap still applies');
  assert.equal(lines.stats.skippedCooldown, 1);
  clock += VOICE_COOLDOWN_MS;
  assert.equal(await lines.action('pat-gentle'), true);
  assert.equal(lines.stats.lastFile, 'pat-01.wav');
  clock += VOICE_COOLDOWN_MS;
  assert.equal(await lines.action('session-start'), true);
  const first = lines.stats.lastFile;
  clock += VOICE_COOLDOWN_MS;
  assert.equal(await lines.action('session-start'), true);
  assert.notEqual(lines.stats.lastFile, first, 'the greeting alternates instead of repeating');
  assert.equal(lines.stats.spoken, 4);
});

test('a stopped clip is discarded even after its bytes were decoded', async t => {
  const { lines, started, fetcher } = build(t, { defer: true });
  await lines.load();
  const pending = lines.action('pat-gentle');
  lines.stop();
  fetcher.release();
  assert.equal(await pending, false);
  assert.equal(started.length, 0);
  assert.equal(lines.stats.spoken, 0);
});

test('two actions in the same tick cannot overlap', async t => {
  const { lines, started } = build(t);
  await lines.load();
  const [first, second] = await Promise.all([lines.action('happy'), lines.action('curious')]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(started.length, 1);
  assert.equal(lines.stats.spoken, 1);
});
