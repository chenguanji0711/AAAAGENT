import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioOutput, normalizeAudio, gainOf } from '../audio-output.mjs';

test('audio state is clamped and never trusted from an outside value', () => {
  assert.deepEqual(normalizeAudio(undefined), { muted: false, volume: 1 });
  assert.deepEqual(normalizeAudio({ muted: true, volume: 4 }), { muted: true, volume: 1 });
  assert.deepEqual(normalizeAudio({ muted: 'yes', volume: -3 }), { muted: false, volume: 0 });
  assert.deepEqual(normalizeAudio({ muted: false, volume: Number.NaN }), { muted: false, volume: 1 });
});

test('mute is a real zero gain, not a separate flag consumers can forget', () => {
  assert.equal(gainOf({ muted: true, volume: 1 }), 0);
  assert.equal(gainOf({ muted: false, volume: 0 }), 0);
  assert.equal(gainOf({ muted: false, volume: 0.4 }), 0.4);
});

test('changes publish once, persist, and incoming host values do not loop back', () => {
  const persisted = [], seen = [];
  const audio = createAudioOutput({ initial: { muted: false, volume: 0.8 }, persist: value => persisted.push(value) });
  audio.subscribe(state => seen.push(state));
  assert.equal(audio.gain, 0.8);
  assert.deepEqual(audio.set({ muted: true }), { muted: true, volume: 0.8 });
  assert.deepEqual(persisted, [{ muted: true, volume: 0.8 }], 'the user choice is written to the host');
  assert.deepEqual(audio.set({ muted: true }), audio.state, 'an unchanged value is a no-op');
  assert.equal(persisted.length, 1);
  // The host echo must not be re-persisted.
  audio.receive({ muted: false, volume: 0.25 });
  assert.equal(persisted.length, 1);
  assert.equal(audio.gain, 0.25);
  assert.equal(seen.at(-1).volume, 0.25);
});
