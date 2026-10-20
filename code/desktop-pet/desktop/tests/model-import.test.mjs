// The import flow has to accept every legitimate rig while refusing anything unsafe.
// A Cubism descriptor may omit Physics, Pose, DisplayInfo, UserData, Expressions and
// Motions; only Moc and Textures are load-bearing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {collectModelReferences,isSafeModelPath} from '../model-references.mjs';

const tool=resolve('tools/configure-model.mjs');

function rig(files){
  const dir=mkdtempSync(resolve(tmpdir(),'model-import-'));
  for(const [name,body] of Object.entries(files)){
    const full=resolve(dir,name);
    mkdirSync(resolve(full,'..'),{recursive:true});
    writeFileSync(full,body);
  }
  return dir;
}
const minimal={Moc:'model.moc3',Textures:['texture_00.png']};
const descriptor=(refs)=>({Version:3,FileReferences:refs});

test('only Moc and Textures are required; every other section is genuinely optional',()=>{
  const bare=collectModelReferences(descriptor(minimal));
  assert.equal(bare.moc,'model.moc3');
  assert.deepEqual(bare.expressions,[]);
  assert.deepEqual(bare.motions,{});
  assert.deepEqual(bare.fingerprint,['model.moc3'],'a rig with no motions hashes just its moc');
  assert.deepEqual(bare.required,['model.moc3','texture_00.png']);

  const full=collectModelReferences(descriptor({...minimal,Physics:'p.physics3.json',Pose:'m.pose3.json',
    DisplayInfo:'m.cdi3.json',UserData:'m.userdata3.json',Expressions:[{Name:'F01',File:'exp/a.exp3.json'}],
    Motions:{Idle:[{File:'motions/idle.motion3.json'}],TapBody:[{File:'motions/tap.motion3.json'}]}}));
  assert.deepEqual(full.fingerprint,['model.moc3','p.physics3.json','exp/a.exp3.json','motions/idle.motion3.json','motions/tap.motion3.json']);
  assert.ok(full.optional.includes('m.pose3.json'),'Pose is read even though it is not hashed');

  assert.throws(()=>collectModelReferences(descriptor({Textures:['a.png']})),/Moc/);
  assert.throws(()=>collectModelReferences(descriptor({Moc:'model.moc3'})),/Textures/);
  assert.throws(()=>collectModelReferences({Version:3}),/FileReferences/);
});

test('a reference is accepted only as a plain relative path inside the model',()=>{
  for(const good of ['model.moc3','textures/tex_00.png','a.b.c/model.model3.json','Haru.2048/texture_00.png'])
    assert.ok(isSafeModelPath(good),good);
  for(const bad of ['','/etc/passwd','../secret.png','a/../../b.png','a/./b.png','C:\\win.png','a\\b.png','a%2e%2e/b.png','a:b.png','./rel.png',null,42])
    assert.equal(isSafeModelPath(bad),false,String(bad));
});

test('the import tool generates a conservative catalog for a rig with no optional sections',()=>{
  const dir=rig({'pet.model3.json':JSON.stringify(descriptor(minimal)),'model.moc3':'moc','texture_00.png':'png'});
  try{
    const run=spawnSync(process.execPath,[tool,'--dir',dir,'--id','my-rig'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const catalog=JSON.parse(readFileSync(resolve(dir,'presets.json'),'utf8'));
    assert.equal(catalog.modelId,'my-rig');
    assert.match(catalog.modelFingerprint,/^[a-f0-9]{64}$/);
    assert.ok(catalog.items.length>0&&catalog.items.length<=200);
    assert.equal(new Set(catalog.items.map(i=>i.id)).size,catalog.items.length,'ids stay unique');
    assert.equal(catalog.items.some(i=>i.emotions||i.gestures),false,'nothing is mapped onto an emotion slot');
    assert.equal(catalog.items.some(i=>i.source==='model-expression'),false,'a rig with no expressions advertises none');
    assert.equal(catalog.items.some(i=>i.id==='motion-idle-0'),false,'no idle motion is advertised when the rig has none');
    assert.equal(catalog.items.find(i=>i.id==='proc-breath').availability,'automatic');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('expressions and motions are advertised for manual use and never auto-mapped',()=>{
  const dir=rig({'pet.model3.json':JSON.stringify(descriptor({...minimal,
      Expressions:[{Name:'Smile',File:'exp/smile.exp3.json'},{File:'exp/plain.exp3.json'}],
      Motions:{Idle:[{File:'motions/idle.motion3.json'}],TapBody:[{File:'motions/tap.motion3.json'}]}})),
    'model.moc3':'moc','texture_00.png':'png','exp/smile.exp3.json':'e','exp/plain.exp3.json':'e',
    'motions/idle.motion3.json':'m','motions/tap.motion3.json':'m'});
  try{
    const run=spawnSync(process.execPath,[tool,'--dir',dir],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const catalog=JSON.parse(readFileSync(resolve(dir,'presets.json'),'utf8'));
    const expressions=catalog.items.filter(i=>i.source==='model-expression');
    assert.equal(expressions.length,2);
    assert.deepEqual(expressions.map(i=>i.availability),['manual','manual']);
    assert.deepEqual(expressions.map(i=>i.expressionName),['Smile','exp/plain.exp3.json']);
    assert.equal(expressions.every(i=>i.defaultEnabled===false),true);
    assert.equal(catalog.items.find(i=>i.id==='motion-idle-0').availability,'automatic');
    const tap=catalog.items.find(i=>i.motionGroup==='TapBody');
    assert.equal(tap.availability,'manual');
    assert.equal(tap.motionIndex,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the tool refuses unsafe references, a second run, and keeps a backup when told to replace',()=>{
  const dir=rig({'pet.model3.json':JSON.stringify(descriptor({Moc:'../escape.moc3',Textures:['t.png']})),'t.png':'png','../escape.moc3':'x'});
  try{
    const escaped=spawnSync(process.execPath,[tool,'--dir',dir],{encoding:'utf8'});
    assert.notEqual(escaped.status,0,'a reference outside the model directory is refused');
    assert.match(escaped.stderr,/Unsafe model-relative path|escapes its directory/);
    assert.equal(existsSync(resolve(dir,'presets.json')),false,'nothing is written when the rig is rejected');
  }finally{rmSync(dir,{recursive:true,force:true});}

  const safe=rig({'pet.model3.json':JSON.stringify(descriptor(minimal)),'model.moc3':'moc','texture_00.png':'png'});
  try{
    assert.equal(spawnSync(process.execPath,[tool,'--dir',safe],{encoding:'utf8'}).status,0);
    const before=readFileSync(resolve(safe,'presets.json'),'utf8');
    const again=spawnSync(process.execPath,[tool,'--dir',safe],{encoding:'utf8'});
    assert.notEqual(again.status,0,'an existing catalog is never silently overwritten');
    assert.match(again.stderr,/already exists/);
    assert.equal(readFileSync(resolve(safe,'presets.json'),'utf8'),before);
    assert.equal(spawnSync(process.execPath,[tool,'--dir',safe,'--replace'],{encoding:'utf8'}).status,0);
    const backups=readFileSync(resolve(safe,'presets.json'),'utf8');
    assert.equal(backups,before,'--replace rewrites the same content for an unchanged rig');
  }finally{rmSync(safe,{recursive:true,force:true});}
});
