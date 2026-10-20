import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vm from 'node:vm';
globalThis.__dirname=resolve('desktop/vendor/cubism/Core');
globalThis.require=createRequire(import.meta.url);
vm.runInThisContext(await readFile('desktop/vendor/cubism/Core/live2dcubismcore.min.js','utf8'));
for(let i=0;i<100;i++){
  try{Live2DCubismCore.Version.csmGetVersion();break;}
  catch(error){if(i===99)throw error;await new Promise(r=>setTimeout(r,10));}
}
const {JellyfishRenderer}=await import('../cubism-renderer.mjs');
const catalog=JSON.parse(await readFile('desktop/assets/local-model/presets.json'));
const read=async name=>{
  const b=await readFile('desktop/assets/local-model/'+name);
  return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
};
class SilentRig extends JellyfishRenderer {draw(){}}
async function createRig(reader=read){
  const rig=new SilentRig(null);
  try{await rig.loadRig(reader);rig.ready=true;rig.last=performance.now();return rig;}
  catch(error){rig.dispose();throw error;}
}
const view={state:'idle',mouth:0,expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null}};
const enabled=catalog.items.filter(i=>i.defaultEnabled).map(i=>i.id);
function frames(rig,n=100){for(let i=0;i<n;i++){rig.last=performance.now()-33;rig.updateView(view);}}
test('Haru loads with standard parameters, without old character-only parameters',async()=>{
  let rig;
  await assert.doesNotReject(async()=>{rig=await createRig();});
  try{assert.ok(rig.parameterIndices.has('ParamAngleX'));assert.equal(rig.parameterIndices.has('ParamAngleX2'),false);assert.equal(rig.expressions.size,8);}
  finally{rig?.dispose();}
});
test('Haru idle, breathing and interaction use real model parameters',async()=>{
  const rig=await createRig();
  try{
    assert.equal(rig.setAutomaticPolicy({modelId:catalog.modelId,revision:0,enabledIds:enabled}),true);
    const breath=[];for(let i=0;i<120;i++){frames(rig,1);breath.push(rig.get('ParamBreath'));}
    assert.ok(Math.max(...breath)-Math.min(...breath)>.1);
    rig.beginAttention();frames(rig,6);assert.ok(Math.abs(rig.get('ParamAngleY'))>.1);
    assert.ok(Array.from(rig._model.getModel().parameters.values).every(Number.isFinite));
  }finally{rig.dispose();}
});
test('all semantic faces release to neutral; lips follow playback and interruption',async()=>{
  const rig=await createRig();
  try{
    rig.setAutomaticPolicy({modelId:catalog.modelId,revision:0,enabledIds:enabled});
    for(const [emotion,name] of [['happy','F01'],['sad','F04'],['warm','F05'],['angry','F03'],['surprised','F06']]){
      view.expression={emotion,intensity:1,delivery:'',gesture:null};frames(rig);assert.equal(rig.faceKey,name);
    }
    view.state='speaking';view.mouth=.4;frames(rig,1);assert.ok(rig.get('ParamMouthOpenY')>.5);
    view.state='idle';view.mouth=.4;view.expression={emotion:'neutral',intensity:0,delivery:'',gesture:null};rig.reset();frames(rig,100);
    assert.equal(rig.faceKey,'');assert.equal(rig.get('ParamMouthOpenY'),0);
    assert.ok(Math.abs(rig.get('ParamMouthForm')-rig.defaults[rig.parameterIndices.get('ParamMouthForm')])<.001);
    rig.setAutomaticPolicy({modelId:catalog.modelId,revision:1,enabledIds:[]});frames(rig,1);
    assert.equal(rig.get('ParamAngleX'),rig.defaults[rig.parameterIndices.get('ParamAngleX')]);
  }finally{rig.dispose();}
});
test('changed moc bytes remain rejected by the catalog fingerprint',async()=>{
  await assert.rejects(()=>createRig(async name=>{const b=await read(name);if(name.endsWith('.moc3'))new Uint8Array(b)[100]^=1;return b;}),/模型与预设目录版本不一致/);
});
test('a suspended rig freezes, and resuming never replays the paused time',async()=>{
  const rig=await createRig();
  try{
    assert.equal(rig.setAutomaticPolicy({modelId:catalog.modelId,revision:0,enabledIds:enabled}),true);
    frames(rig,40);
    const elapsed=rig.elapsed,before=rig.snapshot();
    assert.ok(elapsed>.5,'the rig advanced before it was hidden');
    rig.setSuspended(true);
    frames(rig,40);                                  // hidden or collapsed: nothing may advance
    assert.equal(rig.elapsed,elapsed,'a suspended rig advances no time');
    assert.deepEqual(rig.snapshot(),before,'and no model parameter moves while hidden');
    rig.setSuspended(false);
    rig.updateView(view);                            // resume with no back-dated clock
    assert.ok(rig.elapsed>elapsed,'resuming advances again');
    assert.ok(rig.elapsed-elapsed<.05,'the paused wall-clock gap is not replayed as one jump');
    frames(rig,40);
    assert.ok(rig.elapsed-elapsed>.5,'and it keeps running normally afterwards');
    assert.ok(Array.from(rig._model.getModel().parameters.values).every(Number.isFinite));
  }finally{rig.dispose();}
});
