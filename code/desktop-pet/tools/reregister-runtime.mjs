// Re-baseline the registered runtime fingerprints after a deliberate local change.
//
// The integrity gate is never disabled: prepareTrialLaunch still verifies every
// registered file before the app starts, and this tool re-verifies the whole set
// itself before writing. It only records the new digests, together with an
// auditable before/after diff, so a reviewed source change does not leave the
// activation hashes permanently stale.
//
// Usage:
//   node tools/reregister-runtime.mjs --review [--reason "text"]
//   node tools/reregister-runtime.mjs --apply  [--reason "text"] [--allow-removals]
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFirstRunRuntimePins } from '../dist/app/runtime-pins.js';
import { validateTrialConfiguration } from '../dist/app/trial-config.js';
import { verifyTrialRuntime } from '../dist/app/trial-launcher.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const allowRemovals = args.includes('--allow-removals');
const reasonAt = args.indexOf('--reason');
const reason = reasonAt >= 0 ? String(args[reasonAt + 1] ?? '') : '';
if (!apply && !args.includes('--review')) throw Error('请显式选择 --review 或 --apply。');

const directory = resolve(root, '.local/model-evaluation/trial/user-trial');
const configFile = resolve(directory, 'config.json');
const activationFile = resolve(directory, 'activation.json');
const configBytes = await readFile(configFile);
const current = validateTrialConfiguration(JSON.parse(configBytes));
if (resolve(current.projectRoot) !== root) throw Error('配置不属于当前项目。');
const activation = JSON.parse(await readFile(activationFile, 'utf8'));
if (activation.status !== 'active' || activation.phaseId !== current.phaseId || activation.configSha256 !== sha(configBytes))
  throw Error('当前激活状态与 config.json 不一致，未改动任何文件。');

const pins = await collectFirstRunRuntimePins(root);
const added = [], changed = [], removed = [];
for (const [path, digest] of Object.entries(pins)) {
  if (!(path in current.runtimeFiles)) added.push(path);
  else if (current.runtimeFiles[path] !== digest) changed.push(path);
}
for (const path of Object.keys(current.runtimeFiles)) if (!(path in pins)) removed.push(path);

const report = {
  projectRoot: root,
  reviewedAt: new Date().toISOString(),
  reason,
  previousSourceRevision: current.sourceRevision,
  nextSourceRevision: sha(JSON.stringify(pins)).slice(0, 40),
  registeredFiles: Object.keys(pins).length,
  added, removed,
  changed: changed.map(path => ({ path, before: current.runtimeFiles[path], after: pins[path] }))
};
process.stdout.write(json(report));

if (!apply) {
  process.stdout.write('审查模式：未写入任何文件。确认改动后加 --apply 登记。\n');
} else {
  if (removed.length && !allowRemovals) throw Error('检测到已登记文件消失，未登记；如确为有意删除请加 --allow-removals。');
  const next = validateTrialConfiguration({ ...current, sourceRevision: report.nextSourceRevision, runtimeFiles: pins });
  await verifyTrialRuntime(next);
  const nextBytes = json(next);
  const nextActivation = json({ ...activation, configSha256: sha(Buffer.from(nextBytes)) });
  const reviewFile = resolve(root, `.local/model-evaluation/runtime-reregister-${Date.now()}.json`);
  await mkdir(dirname(reviewFile), { recursive: true, mode: 0o700 });
  await writeFile(reviewFile, json(report), { flag: 'wx', mode: 0o600 });
  const swap = async (target, content) => {
    const temporary = `${target}.${process.pid}.next`;
    try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  await swap(configFile, nextBytes);
  try { await swap(activationFile, nextActivation); }
  catch {
    // A failed second commit must not strand an old activation with a new config.
    // This handles reported I/O failure, not process termination or power loss.
    try { await swap(configFile, configBytes); }
    catch { throw Error('Activation commit failed; configuration rollback also failed. Preserve the registration audit for recovery.'); }
    throw Error('Activation commit failed; prior configuration restored.');
  }
  process.stdout.write(`已登记 ${Object.keys(pins).length} 个运行时文件指纹；审查记录：${reviewFile}\n`);
}
