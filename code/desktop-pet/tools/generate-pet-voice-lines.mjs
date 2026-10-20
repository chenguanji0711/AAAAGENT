// Generates the pet's fixed action lines once with the configured QwenAudio
// system voice, then caches them as local WAV files so every later playback is
// free and offline.
//
// Paid access goes through the same reviewed path as the app: the shared batch
// ledger reserves before each call and settles with the supplier's own usage,
// and an operation id that already exists in the ledger is never called again.
//
//   node tools/generate-pet-voice-lines.mjs --dry-run
//   node tools/generate-pet-voice-lines.mjs --run
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { TrialTransport, createTrialTtsProvider, keyReader } from '../dist/app/trial-backend.js';
import { effectiveTrialConfiguration } from '../dist/management/settings.js';
import { credentialRegistry } from '../dist/management/credentials.js';
import { EvaluationBudget } from '../dist/core/evaluation-budget.js';
import { MemoryMediaStore } from '../dist/media/store.js';
import { inspectPcmWav } from '../dist/media/wav.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
export const PREFIX = 'PET-VOICE-LINES:';

/** Short, everyday lines. Written to be spoken naturally, not read aloud. */
export const LINES = Object.freeze({
  greeting: ['你回来啦', '早上好呀', '欸，被你发现啦'],
  pat: ['诶嘿，好舒服', '再摸摸嘛', '呜，别摸了啦'],
  eat: ['哇，好好吃', '我开动啦', '还要还要'],
  happy: ['嘿嘿，好开心', '最喜欢你了', '今天也超棒'],
  sleepy: ['呼，好困哦', '再睡五分钟嘛', '晚安啦'],
  tired: ['好累哦', '让我歇一会儿'],
  pouty: ['哼', '不理你了啦'],
  curious: ['欸？', '什么什么？'],
  surprised: ['哇啊！', '吓我一跳']
});
/** Delivery hints keep the short lines lively instead of a flat read-out. */
export const DELIVERY = Object.freeze({
  greeting: '像见到熟人那样自然又雀跃地打招呼，语速稍快，尾音上扬。',
  pat: '被摸头时的即兴语气，像日常撒娇一样自然，不要夸张。',
  eat: '尝到好吃的东西时开心地感叹，很有生活感。',
  happy: '开心地小声欢呼，语气轻快自然。',
  sleepy: '困倦时的含糊低语，语速慢一点，带一点鼻音。',
  tired: '疲惫地叹气，声音放轻。',
  pouty: '假装生气的傲娇语气，短促但不凶。',
  curious: '好奇地追问，语气活泼。',
  surprised: '突然被吓到的短促惊呼。'
});

export function lineFiles() {
  return Object.entries(LINES).flatMap(([category, texts]) =>
    texts.map((text, index) => ({ category, index, text, operationId: `${PREFIX}${category}:${index}`,
      file: `${category}-${String(index + 1).padStart(2, '0')}.wav` })));
}
export function manifestFor(files, voice) {
  const categories = {};
  for (const line of files) (categories[line.category] ??= []).push({ file: line.file, text: line.text });
  return { version: 1, voice, generatedBy: 'qwen-audio-tts', license: 'Provider output; see THIRD_PARTY_NOTICES.md',
    categories };
}

async function swap(path, bytes) {
  const temporary = `${path}.${process.pid}.next`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function context(root) {
  const directory = resolve(root, '.local/model-evaluation/trial/user-trial');
  const configFile = resolve(directory, 'config.json'), activationFile = resolve(directory, 'activation.json');
  const base = await readActiveTrialConfiguration(configFile, activationFile);
  const settings = structuredClone(JSON.parse(await readFile(resolve(directory, 'management-settings.json'), 'utf8')).current.settings);
  const effective = effectiveTrialConfiguration(base, settings);
  const selection = settings.providers.tts;
  const keyFile = await realpath(credentialRegistry(base).file(selection.credentialRef, 'dashscope'));
  const info = await stat(keyFile), local = relative(root, keyFile);
  if ((!local.startsWith('..') && !isAbsolute(local)) || !info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw Error('A restricted external 0600 key file is required');
  // The application's own reader owns the accepted key format; never reimplement it.
  const readKey = keyReader(base.models.tts.credentialFile, base, configFile, activationFile);
  return { base, effective, selection, keyFile, readKey, ledgerFile: base.budgetFile };
}

export async function generate(root, { run = false, log = () => {} } = {}) {
  const c = await context(root);
  const files = lineFiles();
  const voiceDir = resolve(root, 'code/desktop-pet/desktop/assets/voice');
  await mkdir(voiceDir, { recursive: true, mode: 0o700 });
  const ledger = JSON.parse(await readFile(c.ledgerFile, 'utf8'));
  const attempted = new Set(ledger.entries.map(entry => entry.operationId));
  const budget = new EvaluationBudget(c.ledgerFile, ledger.batchId, ledger.limitMicros);
  const reservation = c.effective.models.tts.reservationMicros;
  const characters = files.reduce((total, line) => total + Buffer.byteLength(line.text, 'utf8'), 0);
  const plan = { voice: c.selection.voice, model: c.selection.model, files: files.length, characters,
    estimatedMicros: characters * c.selection.characterMicros, worstCaseReservedMicros: reservation,
    alreadyGenerated: files.filter(line => attempted.has(line.operationId)).length };
  log(json(plan));
  if (!run) { log('干跑：未调用任何接口，未写入任何文件。确认后加 --run。\n'); return { ...plan, generated: 0 }; }

  const results = [];
  for (const line of files) {
    const target = resolve(voiceDir, line.file);
    if (attempted.has(line.operationId)) {
      const present = await stat(target).then(value => value.isFile(), () => false);
      results.push({ ...line, status: present ? 'skipped_existing' : 'skipped_ledger_without_file' });
      continue;
    }
    const store = new MemoryMediaStore();
    const scope = { characterId: 'companion', sessionId: 'pet-voice-lines', turnId: line.operationId, generation: 1 };
    let reserved = false, settled = false, usage = null, status = 'failed', failure = null;
    const authorizer = { async authorize(request, signal) {
      signal.throwIfAborted();
      if (request.operation !== 'tts' || request.model !== c.selection.model || request.endpoint !== c.selection.endpoint)
        throw Error('Only the configured speech endpoint may be called');
      await budget.reserve(line.operationId, c.selection.model, reservation); reserved = true;
      return { async settle(outcome) { usage = outcome?.usage ?? null; await budget.settle(line.operationId, settleMicros(usage, line.text, c.selection.characterMicros)); settled = true; } };
    } };
    const transport = new TrialTransport(c.effective, fetch, undefined, undefined);
    const endpoint = { ...c.effective.models.tts, authorizer, apiKey: c.readKey };
    try {
      const provider = createTrialTtsProvider(c.selection, endpoint, store, transport);
      const result = await provider.synthesize({ scope, text: line.text, expression: { emotion: 'warm', intensity: 0.4, delivery: DELIVERY[line.category], gesture: null } }, AbortSignal.timeout(120_000));
      const audio = await store.read(scope, result.audio), wav = inspectPcmWav(audio);
      if (wav.sampleRate !== 24_000 || wav.channels !== 1) throw Error('Unexpected speech format');
      await swap(target, audio);
      status = 'generated'; results.push({ ...line, status, bytes: audio.length, durationMs: wav.durationMs, sha256: sha(audio) });
      log(`  ✔ ${line.category}/${line.file} ${line.text} (${wav.durationMs} ms)\n`);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      results.push({ ...line, status: 'failed', failure });
      log(`  ✖ ${line.category}/${line.file} ${failure}\n`);
      if (!settled && reserved) await budget.settle(line.operationId, null);
      await store.releaseScope(scope).catch(() => {});
      break; // Never retry inside one run; the ledger already records the attempt.
    } finally {
      await store.releaseScope(scope).catch(() => {});
      if (reserved && !settled) await budget.settle(line.operationId, null);
    }
  }

  const done = results.filter(result => ['generated', 'skipped_existing'].includes(result.status));
  if (done.length === files.length) {
    await swap(resolve(voiceDir, 'lines.json'), json(manifestFor(done, c.selection.voice)));
    log(`声音台词已就绪：${done.length} 条，${resolve(voiceDir, 'lines.json')}\n`);
  } else {
    log(`未全部完成（${done.length}/${files.length}）；lines.json 未改写，界面继续按缺少素材处理。\n`);
  }
  const after = JSON.parse(await readFile(c.ledgerFile, 'utf8'));
  const entries = after.entries.filter(entry => entry.operationId.startsWith(PREFIX));
  return { ...plan, generated: results.filter(result => result.status === 'generated').length,
    spentMicros: entries.reduce((total, entry) => total + (entry.actualMicros ?? entry.reservedMicros), 0),
    results };
}

/** The supplier's own billed character count is authoritative when it is present and sane. */
export function settleMicros(usage, text, characterMicros) {
  const reported = usage && typeof usage === 'object' ? Number(usage.characters) : Number.NaN;
  const characters = Number.isSafeInteger(reported) && reported >= 0 ? reported : Buffer.byteLength(text, 'utf8');
  return characters * characterMicros;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const run = process.argv.includes('--run');
  const result = await generate(root, { run, log: value => process.stdout.write(value) });
  process.stdout.write(json({ voice: result.voice, model: result.model, files: result.files, generated: result.generated ?? 0, spentMicros: result.spentMicros ?? 0 }));
}
