import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendStartupError, formatBackendStartupFailure } from '../../app/backend-startup-diagnostics.js';
import { ManagementError } from '../../contracts/management.js';
import type { TrialConfiguration, TrialModel } from '../../app/trial-config.js';

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const entry = fileURLToPath(new URL('../../app/trial-backend.js', import.meta.url));
// Synthetic canaries cover paths, JSON parser excerpts and line injection, never real secrets.
const privateValue = 'SYNTHETIC_PRIVATE_CANARY';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const parent = resolve('desktop/.cache/startup-diagnostics'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-')); t.after(() => rm(root, { recursive: true, force: true }));
  const model: TrialModel = { provider:'dashscope',model:'qwen-plus-2025-12-01',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    credentialFile:'/nonexistent-'+privateValue,reservationMicros:100000,inputTokenLimit:32768,outputTokenLimit:32768,inputMicrosPerToken:.8,outputMicrosPerToken:2 };
  const configuration: TrialConfiguration = {version:1,product:'companion-v1',phaseId:'local-trial-synthetic',purpose:'smoke-text',smokeInput:privateValue,
    projectRoot:root,sourceRevision:'a'.repeat(40),database:join(root,'.local/data/companion.sqlite'),budgetFile:join(root,'.local/model-evaluation/budget.json'),
    budgetBatchId:'synthetic',limitMicros:20000000,phaseLimitMicros:20000000,maxCalls:200,
    operationLimits:{admission:40,dialogue:40,memory_turn:40,summary:20,perception:0,tts:40},
    memory:{mode:'strict',scheduling:'semantic-admission',timeoutMs:300000},
    runtimeFiles:Object.fromEntries(['dist/app/trial-backend.js','dist/app/trial-launcher.js','desktop/build/renderer.js','desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet']
      .map(p=>['code/desktop-pet/'+p,hash('synthetic-runtime')])),
    models:{dialogue:model,admission:model,summary:model,
      memory_turn:{...model,provider:'deepseek',model:'deepseek-v4-pro',endpoint:'https://api.deepseek.com/chat/completions',reservationMicros:11000000,inputMicrosPerToken:9,outputMicrosPerToken:27,outputTokenLimit:393216,thinking:'high'},
      perception:{...model,model:'qwen3.5-omni-flash-2026-03-15',inputTokenLimit:196608,outputTokenLimit:65536,inputMicrosPerToken:18,outputMicrosPerToken:13.3,reservationMicros:4500000},
      tts:{...model,model:'qwen3-tts-instruct-flash-2026-01-26',endpoint:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',characterMicros:80}}};
  const configFile=join(root,'config.json'),activationFile=join(root,'activation.json');
  async function save(raw=JSON.stringify(configuration),digest=hash(raw)) {
    await writeFile(configFile,raw);await writeFile(activationFile,JSON.stringify({version:1,status:'active',phaseId:configuration.phaseId,configSha256:digest}));
  }
  async function runtimeFiles() { for(const p of Object.keys(configuration.runtimeFiles)){await mkdir(dirname(join(root,p)),{recursive:true});await writeFile(join(root,p),'synthetic-runtime');} }
  return {root,configuration,configFile,activationFile,save,runtimeFiles};
}
for(const scenario of [
  {kind:'missing environment',stage:'configuration',reason:'configuration_required'},
  {kind:'activation digest mismatch',stage:'configuration',reason:'configuration_changed'},
  {kind:'malformed configuration',stage:'configuration',reason:'invalid_json'},
  {kind:'unregistered model endpoint',stage:'configuration',reason:'model_not_registered'},
  {kind:'invalid credential location',stage:'configuration',reason:'credential_configuration_invalid'},
  {kind:'missing runtime artifacts',stage:'runtime',reason:'runtime_integrity_failed'},
  {kind:'malformed management settings',stage:'settings',reason:'invalid_json'},
]) test('CLI preserves a safe, distinct startup cause: '+scenario.kind,async t=>{
  const f=await fixture(t);
  if(scenario.kind==='unregistered model endpoint') (f.configuration.models.dialogue as {endpoint:string}).endpoint='https://private.invalid/'+privateValue;
  if(scenario.kind==='invalid credential location') (f.configuration.models.dialogue as {credentialFile:string}).credentialFile=join(f.root,privateValue);
  if(scenario.kind==='malformed management settings') {await f.runtimeFiles();await writeFile(join(f.root,'management-settings.json'),'{"token":"'+privateValue+'", BROKEN');}
  await f.save(scenario.kind==='malformed configuration'?'[{"secret":"'+privateValue+'"}, BROKEN':JSON.stringify(f.configuration),scenario.kind==='activation digest mismatch'?'0'.repeat(64):undefined);
  const result=spawnSync(process.execPath,[entry],{env:{PATH:process.env.PATH,HOME:f.root+'-home',TMPDIR:f.root,
    ...(scenario.kind==='missing environment'?{}:{PET_TRIAL_CONFIG:f.configFile,PET_TRIAL_ACTIVATION:f.activationFile})},encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stdout,'','diagnostics must not corrupt the JSON stdout protocol');
  const line=result.stderr.trim().split('\n').at(-1)!;
  assert.ok(line.startsWith('backend_startup_failure '),'startup failure must include a structured diagnostic instead of only the generic message');
  const diagnostic=JSON.parse(line.slice('backend_startup_failure '.length));
  assert.equal(diagnostic.stage,scenario.stage);assert.equal(diagnostic.reason,scenario.reason);assert.equal(typeof diagnostic.detail,'string');
  assert.ok(diagnostic.detail.length>0);assert.ok(result.stderr.length<1500);
  for(const secret of [privateValue,f.root,f.configFile,f.activationFile,'private.invalid'])assert.ok(!result.stderr.includes(secret),'diagnostic leaked a sensitive value');
});

function diagnostic(error: unknown) {
  const output=formatBackendStartupFailure(error);
  assert.equal(output.trim().split('\n').length,1,'exception content cannot inject log records');
  assert.ok(output.length<1500);assert.ok(!output.includes(privateValue));
  return JSON.parse(output.slice('backend_startup_failure '.length));
}
test('safe startup diagnostics distinguish model selection and credential reference failures',()=>{
  const model=diagnostic(new BackendStartupError('settings',new ManagementError('invalid_request','这个型号尚未登记适配能力和费用边界，不能应用。')));
  const credential=diagnostic(new BackendStartupError('settings',new ManagementError('invalid_request','请选择已登记的同供应商凭据。')));
  assert.equal(model.reason,'model_not_registered');assert.equal(credential.reason,'credential_configuration_invalid');
  assert.equal(model.stage,'settings');assert.equal(credential.kind,'ManagementError');
});
test('unknown exceptions, causes, names and OS paths never enter startup diagnostics',()=>{
  const error=Object.assign(new Error('Authorization: Bearer '+privateValue+'\n'+privateValue,{cause:{token:privateValue}}),
    {name:privateValue,code:privateValue,path:'/private/'+privateValue,request:{headers:{authorization:privateValue}}});
  const unknown=diagnostic(new BackendStartupError('services',error));
  assert.equal(unknown.stage,'services');assert.equal(unknown.reason,'unexpected_error');assert.equal(unknown.kind,'Error');assert.equal(unknown.code,undefined);
  const denied=diagnostic(new BackendStartupError('storage',Object.assign(error,{code:'EACCES'})));
  assert.equal(denied.reason,'permission_denied');assert.equal(denied.code,'EACCES');
  const json=diagnostic(new BackendStartupError('settings',new SyntaxError('JSON contains '+privateValue)));
  assert.equal(json.reason,'invalid_json');assert.equal(json.stage,'settings');
});
test('non-Error throws and hostile getters cannot leak values or break startup reporting',()=>{
  const circular:{self?:unknown;token:string}={token:privateValue};circular.self=circular;
  for(const thrown of [undefined,null,privateValue,circular,{toString(){throw Error(privateValue);}},
    Object.defineProperty(new Error(),'message',{get(){throw Error(privateValue);}}),
    new Proxy(new Error(),{getPrototypeOf(){throw Error(privateValue);}})]) {
    assert.doesNotThrow(()=>diagnostic(thrown));
  }
  let reads=0;
  const changing=Object.defineProperty(new Error(privateValue),'name',{get(){return ++reads===1?'Error':privateValue;}});
  assert.equal(diagnostic(changing).kind,'Error','validate and use the same snapshot of untrusted metadata');
});
