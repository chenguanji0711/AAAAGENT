import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,rm,copyFile,stat,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {collectFirstRunRuntimePins} from '../../dist/app/runtime-pins.js';
import {readActiveTrialConfiguration} from '../../dist/app/trial-config.js';
import {verifyTrialRuntime} from '../../dist/app/trial-launcher.js';
const app=fileURLToPath(new URL('../..',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const parent=resolve(app,'desktop/.cache');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(parent,'reregister-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const code=resolve(root,'code/desktop-pet');await mkdir(resolve(code,'tools'),{recursive:true});
 await writeFile(resolve(code,'package.json'),'{"type":"module"}');
 // Copy the actual script and its real runtime dependency graph. No private config or keys.
 await copyFile(resolve(app,'tools/reregister-runtime.mjs'),resolve(code,'tools/reregister-runtime.mjs'));
 const copied=new Set();
 async function module(relative){
  if(copied.has(relative))return;copied.add(relative);
  const source=resolve(app,'dist',relative),dest=resolve(code,'dist',relative),text=await readFile(source,'utf8');
  await mkdir(dirname(dest),{recursive:true});await writeFile(dest,text);
  for(const m of text.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
   const next=resolve(dirname(source),m[1]);if(next.startsWith(resolve(app,'dist')+'/'))await module(next.slice(resolve(app,'dist').length+1));
  }
 }
 for(const p of ['app/runtime-pins.js','app/trial-config.js','app/trial-launcher.js'])await module(p);
 for(const p of ['dist/app/trial-backend.js','desktop/build/renderer.js','desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet']){await mkdir(dirname(resolve(code,p)),{recursive:true});await writeFile(resolve(code,p),'synthetic-runtime');}
 const model={provider:'dashscope',model:'qwen-plus-2025-12-01',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',credentialFile:'/nonexistent-synthetic-key',reservationMicros:100000,inputTokenLimit:32768,outputTokenLimit:32768,inputMicrosPerToken:.8,outputMicrosPerToken:2};
 const c={version:1,product:'companion-v1',phaseId:'local-trial-synthetic',purpose:'smoke-text',smokeInput:'synthetic',projectRoot:root,sourceRevision:'a'.repeat(40),
  database:resolve(root,'.local/data/companion.sqlite'),budgetFile:resolve(root,'.local/model-evaluation/budget.json'),budgetBatchId:'synthetic',limitMicros:20000000,phaseLimitMicros:20000000,maxCalls:200,
  operationLimits:{admission:40,dialogue:40,memory_turn:40,summary:20,perception:0,tts:40},memory:{mode:'strict',scheduling:'semantic-admission',timeoutMs:300000},runtimeFiles:await collectFirstRunRuntimePins(root),
  models:{dialogue:model,admission:model,summary:model,memory_turn:{...model,provider:'deepseek',model:'deepseek-v4-pro',endpoint:'https://api.deepseek.com/chat/completions',reservationMicros:11000000,inputMicrosPerToken:9,outputMicrosPerToken:27,outputTokenLimit:393216,thinking:'high'},
   perception:{...model,model:'qwen3.5-omni-flash-2026-03-15',inputTokenLimit:196608,outputTokenLimit:65536,inputMicrosPerToken:18,outputMicrosPerToken:13.3,reservationMicros:4500000},
   tts:{...model,model:'qwen3-tts-instruct-flash-2026-01-26',endpoint:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',characterMicros:80}}};
 const config=resolve(root,'.local/model-evaluation/trial/user-trial/config.json'),activation=resolve(dirname(config),'activation.json'),raw=JSON.stringify(c);
 await mkdir(dirname(config),{recursive:true});await writeFile(config,raw,{mode:0o600});await writeFile(activation,JSON.stringify({version:1,status:'active',phaseId:c.phaseId,configSha256:sha(raw)}),{mode:0o600});
 const before={config:await readFile(config),activation:await readFile(activation)};
 const run=(mode,preload=[])=>spawnSync(process.execPath,[...preload,resolve(code,'tools/reregister-runtime.mjs'),mode,'--reason','synthetic regression'],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,HOME:root+'-home'}});
 return {root,code,c,config,activation,before,run};
}
function report(result){assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.slice(0,result.stdout.lastIndexOf('}')+1));}
test('runtime review describes changed artifacts without modifying configuration or activation',async t=>{
 const f=await fixture(t);await writeFile(resolve(f.code,'dist/app/trial-backend.js'),'reviewed synthetic update');
 const r=report(f.run('--review'));assert.deepEqual(r.changed.map(x=>x.path),['code/desktop-pet/dist/app/trial-backend.js']);
 assert.deepEqual(await readFile(f.config),f.before.config);assert.deepEqual(await readFile(f.activation),f.before.activation);
});
test('runtime apply updates both hashes and remains loadable without a manual activation repair',async t=>{
 const f=await fixture(t);await writeFile(resolve(f.code,'dist/app/trial-backend.js'),'reviewed synthetic update');
 const r=report(f.run('--apply')),raw=await readFile(f.config),activation=JSON.parse(await readFile(f.activation,'utf8'));
 assert.notEqual(r.nextSourceRevision,f.c.sourceRevision);assert.equal(activation.configSha256,sha(raw));assert.equal(activation.phaseId,f.c.phaseId);assert.equal(activation.status,'active');
 const current=await readActiveTrialConfiguration(f.config,f.activation);await verifyTrialRuntime(current);
 assert.deepEqual(current.models,f.c.models);assert.equal(current.database,f.c.database);assert.equal(current.budgetFile,f.c.budgetFile);
 assert.equal((await stat(f.config)).mode&0o777,0o600);assert.equal((await stat(f.activation)).mode&0o777,0o600);
 const next=report(f.run('--review'));assert.deepEqual(next.changed,[]);assert.deepEqual(next.added,[]);assert.deepEqual(next.removed,[]);
});
test('runtime apply refuses an already tampered activation pair without blessing or rewriting it',async t=>{
 const f=await fixture(t),tampered=Buffer.concat([f.before.config,Buffer.from(' ')]);await writeFile(f.config,tampered);
 const r=f.run('--apply');assert.equal(r.error,undefined);assert.notEqual(r.status,0);assert.match(r.stderr,/不一致/);
 assert.deepEqual(await readFile(f.config),tampered);assert.deepEqual(await readFile(f.activation),f.before.activation);
});
test('runtime apply refuses missing registered files and leaves the active pair unchanged',async t=>{
 const f=await fixture(t);await rm(resolve(f.code,'desktop/build/renderer.js'));
 const r=f.run('--apply');assert.equal(r.error,undefined);assert.notEqual(r.status,0);assert.match(r.stderr,/已登记文件消失/);
 assert.deepEqual(await readFile(f.config),f.before.config);assert.deepEqual(await readFile(f.activation),f.before.activation);
});

test('failed activation commit rolls configuration back instead of leaving a mismatched active pair',async t=>{
 const f=await fixture(t);await writeFile(resolve(f.code,'dist/app/trial-backend.js'),'reviewed synthetic update');
 const hook=resolve(f.code,'failure-hook.mjs');
 await writeFile(hook,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
 const rename=fs.rename;fs.rename=async(from,to)=>{if(String(to).endsWith('/activation.json'))throw Object.assign(Error('synthetic activation commit failed'),{code:'EACCES'});return rename(from,to);};syncBuiltinESMExports();`);
 const r=f.run('--apply',['--import',hook]);assert.equal(r.error,undefined);assert.notEqual(r.status,0);assert.match(r.stderr,/activation commit failed/i);
 assert.deepEqual(await readFile(f.config),f.before.config,'a failed second commit must restore original config bytes');
 assert.deepEqual(await readFile(f.activation),f.before.activation);
 // The original active configuration remains readable (runtime bytes still need explicit review).
 await readActiveTrialConfiguration(f.config,f.activation);
});

test('rollback failure is reported explicitly, never claims success, and keeps the audit',async t=>{
 const f=await fixture(t);await writeFile(resolve(f.code,'dist/app/trial-backend.js'),'reviewed synthetic update');
 const hook=resolve(f.code,'rollback-failure-hook.mjs');
 // Forward config commit is allowed once; the activation commit and then the rollback rename fail.
 await writeFile(hook,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
 const rename=fs.rename;let configCommits=0;
 fs.rename=async(from,to)=>{const target=String(to);
  if(target.endsWith('/config.json')){configCommits+=1;if(configCommits>1)throw Object.assign(Error('synthetic rollback rename failed'),{code:'EACCES'});}
  if(target.endsWith('/activation.json'))throw Object.assign(Error('synthetic activation commit failed'),{code:'EACCES'});
  return rename(from,to);};
 syncBuiltinESMExports();`);
 const r=f.run('--apply',['--import',hook]);
 assert.equal(r.error,undefined);
 assert.notEqual(r.status,0,'a failed rollback must exit nonzero');
 assert.match(r.stderr,/rollback also failed/i,'the rollback failure must be named explicitly');
 assert.doesNotMatch(r.stdout,/已登记\s+\d+/,'must not claim a successful registration');
 // The forward config commit stands (rollback failed), so the pair is mismatched by design here:
 // the audit record is the operator's only recovery path and must survive.
 assert.notDeepEqual(await readFile(f.config),f.before.config,'rollback failure leaves the new config bytes in place');
 assert.deepEqual(await readFile(f.activation),f.before.activation,'activation never advanced');
 const audit=await readdir(resolve(f.root,'.local/model-evaluation'));
 assert.ok(audit.some(name=>/^runtime-reregister-\d+\.json$/.test(name)),'audit record must be preserved for recovery');
});
