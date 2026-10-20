// Selects the pet's spoken voice through the normal managed-settings store, so the
// change gets a new revision and keeps the existing history instead of editing the
// state file by hand.
//
//   node tools/select-pet-voice.mjs --list
//   node tools/select-pet-voice.mjs --voice longanlingxi
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { ManagementSettingsStore } from '../dist/management/settings-store.js';
import { availableAdapters } from '../dist/management/settings.js';

const json = value => JSON.stringify(value, null, 2) + '\n';
export async function selectVoice(root, voice, log = () => {}) {
  const directory = resolve(root, '.local/model-evaluation/trial/user-trial');
  const configFile = resolve(directory, 'config.json');
  const base = await readActiveTrialConfiguration(configFile, resolve(directory, 'activation.json'));
  const store = await ManagementSettingsStore.open(resolve(directory, 'management-settings.json'), base);
  const snapshot = store.snapshot();
  const adapter = availableAdapters(base).find(item => item.id === snapshot.saved.providers.tts.adapterId);
  const offered = adapter?.choices?.find(choice => choice.configuration.model === snapshot.saved.providers.tts.model)?.voices ?? [];
  if (!voice) { log(json({ current: snapshot.saved.providers.tts.voice, revision: snapshot.revision, offered })); return { current: snapshot.saved.providers.tts.voice, offered }; }
  if (!offered.some(entry => entry.id === voice)) throw Error(`该音色不在已登记的系统音色内：${offered.map(entry => entry.id).join(', ')}`);
  if (voice === snapshot.saved.providers.tts.voice) { log(json({ unchanged: voice, revision: snapshot.revision })); return { unchanged: voice }; }
  const settings = structuredClone(snapshot.saved);
  settings.providers.tts = { ...settings.providers.tts, voice };
  const next = await store.save(snapshot.revision, settings);
  await store.drain();
  const saved = JSON.parse(await readFile(resolve(directory, 'management-settings.json'), 'utf8'));
  log(json({ previous: snapshot.saved.providers.tts.voice, voice, revisionBefore: snapshot.revision, revisionAfter: next.revision,
    historyLength: saved.history.length, savedVoice: saved.current.settings.providers.tts.voice }));
  return { voice, revision: next.revision };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--voice');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  await selectVoice(root, at >= 0 ? String(args[at + 1] ?? '') : '', value => process.stdout.write(value));
}
