// Blue-haired girl: the same real Cubism Core path as the Haru rig test, but asserting this
// model's own capabilities. The Haru tests are left untouched: they assert F01..F08 and eight
// expressions, none of which apply here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vm from 'node:vm';

globalThis.__dirname = resolve('desktop/vendor/cubism/Core');
globalThis.require = createRequire(import.meta.url);
vm.runInThisContext(await readFile('desktop/vendor/cubism/Core/live2dcubismcore.min.js', 'utf8'));
for (let i = 0; i < 100; i += 1) {
  try { Live2DCubismCore.Version.csmGetVersion(); break; }
  catch (error) { if (i === 99) throw error; await new Promise(r => setTimeout(r, 10)); }
}

const {JellyfishRenderer} = await import('../cubism-renderer.mjs');
const catalog = JSON.parse(await readFile('desktop/assets/local-model/presets.json'));
const read = async name => {
  const b = await readFile('desktop/assets/local-model/' + name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
class SilentRig extends JellyfishRenderer { draw() {} }
async function createRig(reader = read) {
  const rig = new SilentRig(null);
  try { await rig.loadRig(reader); rig.ready = true; rig.last = performance.now(); return rig; }
  catch (error) { rig.dispose(); throw error; }
}
const view = {state: 'idle', mouth: 0, expression: {emotion: 'neutral', intensity: 0, delivery: '', gesture: null}};
const enabled = catalog.items.filter(i => i.defaultEnabled).map(i => i.id);
test('opaque lace uses the animated ArtMesh and hides covered eyes throughout head turns, expressions and blinking',async()=>{
 const rig=await createRig();
 try {
  const d=rig._model.getModel().drawables, idx=d.ids.indexOf('ArtMeshEyewear');
  assert.ok(rig.opaqueEyewear); assert.equal(d.textureIndices[idx],1);
  const initial=[...d.vertexPositions[idx]], originalUV=[...d.vertexUvs[idx]];
  let displacement=0;
  for(const yaw of [-30,0,30]) for(const pitch of [-30,0,30]) for(const eye of [0,1]) {
   rig.set('ParamAngleX',yaw);rig.set('ParamAngleY',pitch);rig.set('ParamEyeLOpen',eye);rig.set('ParamEyeROpen',eye);
   rig._model.update();rig.opaqueEyewear.apply();
   for(const id of ['ArtMeshIridesL','ArtMeshIridesR','ArtMeshEyewhiteL','ArtMeshEyewhiteR','ArtMeshEyelashL','ArtMeshEyelashR']) assert.equal(d.opacities[d.ids.indexOf(id)],0,id);
   assert.equal(d.opacities[idx],1);assert.ok(d.opacities[d.ids.indexOf('ArtMeshFace')]>0);
   assert.deepEqual([...d.vertexUvs[idx]],originalUV);
   displacement=Math.max(displacement,...Array.from(d.vertexPositions[idx],(v,i)=>Math.abs(v-initial[i])));
  }
  assert.ok(displacement>.001,'eyewear follows real Cubism head deformation');
  for(const name of ['害羞','微笑','认真']) {rig._expressionManager.startMotion(rig.expressions.get(name),false);frames(rig,30);assert.equal(d.opacities[d.ids.indexOf('ArtMeshEyewhiteL')],0);}
 }finally{rig.dispose();}
});
function frames(rig, n = 100) { for (let i = 0; i < n; i += 1) { rig.last = performance.now() - 33; rig.updateView(view); } }

// The v0.3 skin adds one authored axis: the skirt. The count is asserted with the axis itself,
// its real Core bounds, and its behaviour, so a model that merely has the right size fails.
test('the blue-haired girl loads with its own 21 parameters and 3 expressions', async () => {
  const rig = await createRig();
  try {
    assert.equal(rig.parameterIndices.size, 21, 'the model publishes exactly 21 parameters');
    for (const id of ['ParamAngleX', 'ParamEyeLOpen', 'ParamMouthOpenY', 'ParamBreath', 'ParamHairBack', 'ParamSkirtSway']) {
      assert.ok(rig.parameterIndices.has(id), `${id} is present`);
    }
    const parameters = rig._model.getModel().parameters;
    const skirt = rig.parameterIndices.get('ParamSkirtSway');
    assert.equal(parameters.minimumValues[skirt], -1, 'ParamSkirtSway min is -1');
    assert.equal(parameters.maximumValues[skirt], 1, 'ParamSkirtSway max is 1');
    assert.equal(parameters.defaultValues[skirt], 0, 'ParamSkirtSway default is 0');
    // Parameters this model does not have must not be assumed to exist.
    for (const id of ['ParamAngleX2', 'ParamCheek', 'ParamEyeLSmile']) {
      assert.equal(rig.parameterIndices.has(id), false, `${id} is absent`);
    }
    assert.equal(rig.expressions.size, 3, 'three expressions, not the Haru set');
    for (const name of ['害羞', '微笑', '认真']) assert.ok(rig.expressions.has(name), `${name} exists`);
    assert.equal(rig.expressions.has('F01'), false, 'no Haru expression names are invented');
  } finally { rig.dispose(); }
});

test('idle breathes and head physics drive the hair', async () => {
  const rig = await createRig();
  try {
    assert.equal(rig.setAutomaticPolicy({modelId: catalog.modelId, revision: 0, enabledIds: enabled}), true);
    const breath = [];
    for (let i = 0; i < 120; i += 1) { frames(rig, 1); breath.push(rig.get('ParamBreath')); }
    assert.ok(Math.max(...breath) - Math.min(...breath) > 0.05, 'breathing actually moves');

    const hairBefore = rig.get('ParamHairBack');
    rig.beginAttention();
    frames(rig, 30);                                  // physics needs frames to settle
    const hairAfter = rig.get('ParamHairBack');
    assert.ok(Math.abs(hairAfter - hairBefore) > 1e-4, 'hair physics respond to the head');
    assert.ok(Math.abs(rig.get('ParamAngleY')) > 0.1, 'attention turns the head');
    assert.ok(Array.from(rig._model.getModel().parameters.values).every(Number.isFinite));
  } finally { rig.dispose(); }
});

test('speaking opens the mouth and idle returns it to zero', async () => {
  const rig = await createRig();
  try {
    rig.setAutomaticPolicy({modelId: catalog.modelId, revision: 0, enabledIds: enabled});
    view.state = 'speaking'; view.mouth = 0.4;
    frames(rig, 1);
    assert.ok(rig.get('ParamMouthOpenY') > 0.5, 'voice opens the mouth');

    view.state = 'idle'; view.mouth = 0; rig.reset();
    frames(rig, 100);
    assert.equal(rig.get('ParamMouthOpenY'), 0, 'a silent idle closes the mouth completely');
    assert.ok(Math.abs(rig.get('ParamMouthForm') - rig.defaults[rig.parameterIndices.get('ParamMouthForm')]) < 0.001);
  } finally { rig.dispose(); }
});

test('disabling every automatic item releases the pose to the model defaults', async () => {
  const rig = await createRig();
  try {
    rig.setAutomaticPolicy({modelId: catalog.modelId, revision: 0, enabledIds: enabled});
    frames(rig, 30);
    rig.setAutomaticPolicy({modelId: catalog.modelId, revision: 1, enabledIds: []});
    frames(rig, 30);
    for (const id of ['ParamAngleX', 'ParamAngleZ', 'ParamBodyAngleX']) {
      assert.equal(rig.get(id), rig.defaults[rig.parameterIndices.get(id)], `${id} is back at its default`);
    }
    assert.ok(Array.from(rig._model.getModel().parameters.values).every(Number.isFinite));
  } finally { rig.dispose(); }
});

test('tampered model bytes are rejected by the catalog fingerprint', async () => {
  await assert.rejects(
    () => createRig(async name => {
      const b = await read(name);
      if (name.endsWith('.moc3')) new Uint8Array(b)[100] ^= 1;
      return b;
    }),
    /模型与预设目录版本不一致/,
  );
});

test('a suspended rig freezes, and resuming never replays the paused time', async () => {
  const rig = await createRig();
  try {
    assert.equal(rig.setAutomaticPolicy({modelId: catalog.modelId, revision: 0, enabledIds: enabled}), true);
    frames(rig, 40);
    const elapsed = rig.elapsed, before = rig.snapshot();
    assert.ok(elapsed > 0.5, 'the rig advanced before it was hidden');
    rig.setSuspended(true);
    frames(rig, 40);
    assert.equal(rig.elapsed, elapsed, 'a suspended rig advances no time');
    assert.deepEqual(rig.snapshot(), before, 'and no parameter moves while hidden');
    rig.setSuspended(false);
    rig.updateView(view);
    assert.ok(rig.elapsed > elapsed, 'resuming advances again');
    assert.ok(rig.elapsed - elapsed < 0.05, 'the paused wall-clock gap is not replayed as one jump');
    frames(rig, 40);
    assert.ok(rig.elapsed - elapsed > 0.5, 'and it keeps running normally afterwards');
    assert.ok(Array.from(rig._model.getModel().parameters.values).every(Number.isFinite));
  } finally { rig.dispose(); }
});

/** Drawable names, straight from Core, for assertions that must name a real drawable. */
function drawableNames(rig) {
  const count = rig._model.getDrawableCount();
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const id = rig._model.getDrawableId(i);
    names.push(typeof id.getString === 'function' ? id.getString() : String(id));
  }
  return names;
}
/** Drawable index by substring; the match list is reported when nothing matches. */
function drawableIndex(rig, fragment) {
  const hit = drawableNames(rig).findIndex(name => String(name).includes(fragment));
  assert.ok(hit >= 0, `no drawable matching '${fragment}' in ${drawableNames(rig).join(', ')}`);
  return hit;
}
function vertices(rig, index) {
  rig._model.update();
  return Array.from(rig._model.getDrawableVertexPositions(index));
}
// Vertex buffers are flat x,y pairs, so the loop must step by two or the last read is undefined.
function maxDelta(a, b) {
  let worst = 0;
  for (let i = 0; i + 1 < a.length && i + 1 < b.length; i += 2) {
    worst = Math.max(worst, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1]));
  }
  return worst;
}

test('ParamSkirtSway deforms the hem in both directions and leaves the rest alone', async () => {
  const rig = await createRig();
  try {
    const skirt = drawableIndex(rig, 'Bottomwear');
    const face = drawableIndex(rig, 'Face');
    const leg = drawableIndex(rig, 'Legwear');
    assert.ok(skirt >= 0 && face >= 0 && leg >= 0, 'the expected drawables exist');

    rig.set('ParamSkirtSway', 0);
    const rest = vertices(rig, skirt);
    const faceRest = vertices(rig, face);
    const legRest = vertices(rig, leg);

    // Both keyform directions must move the hem: the previous revision only wrote +1.
    rig.set('ParamSkirtSway', 1);
    const readBack = rig.get('ParamSkirtSway');
    const plus = vertices(rig, skirt);
    rig.set('ParamSkirtSway', -1);
    const minus = vertices(rig, skirt);
    const plusDelta = maxDelta(rest, plus), minusDelta = maxDelta(rest, minus);
    console.log('SKIRT-DIAG readBack=' + readBack + ' plusDelta=' + plusDelta + ' minusDelta=' + minusDelta + ' verts=' + rest.length);
    assert.ok(plusDelta > 0, 'the hem must move at +1');
    assert.ok(minusDelta > 0, 'the hem must move at -1');

    rig.set('ParamSkirtSway', 1);
    assert.equal(maxDelta(faceRest, vertices(rig, face)), 0, 'the face must not follow the skirt axis');
    assert.equal(maxDelta(legRest, vertices(rig, leg)), 0, 'the legs must not follow the skirt axis');

    // The pinned fulcrum means the topmost skirt vertex barely travels while the hem moves.
    // Core coordinates have Y pointing up. Check the same top vertices in both axes,
    // rather than checking the lowest Y with a pixel-sized tolerance in model units.
    const topY = Math.max(...rest.filter((_, i) => i % 2 === 1));
    const topIndices = rest.map((_, i) => i).filter(i => i % 2 === 0 && rest[i + 1] >= topY - 0.01);
    assert.ok(topIndices.length > 0);
    for (const [direction, posed] of [[1, plus], [-1, minus]]) {
      const travel = Math.max(...topIndices.map(i => Math.hypot(posed[i] - rest[i], posed[i + 1] - rest[i + 1])));
      assert.ok(travel < 0.0001, `the pinned top edge moves ${travel} at ${direction}`);
    }
    rig.set('ParamSkirtSway', 0);
  } finally { rig.dispose(); }
});

test('the skirt pendulum responds to the body and stays inside the axis', async () => {
  const rig = await createRig();
  try {
    rig.setAutomaticPolicy({modelId: catalog.modelId, revision: 0, enabledIds: enabled});
    rig.beginAttention();
    const seen = [];
    for (let i = 0; i < 180; i += 1) { frames(rig, 1); seen.push(rig.get('ParamSkirtSway')); }
    assert.ok(seen.every(Number.isFinite), 'the pendulum stays finite');
    assert.ok(seen.every(v => v >= -1 && v <= 1), 'the pendulum never leaves the -1..1 axis');
    assert.ok(Math.max(...seen) - Math.min(...seen) > 1e-3, 'physics actually drives ParamSkirtSway');
    // Releasing the head must bring it back towards centre, not leave it stuck at a limit.
    rig.reset();
    rig.setAutomaticPolicy({modelId: catalog.modelId, revision: 1, enabledIds: []});
    for (let i = 0; i < 360; i += 1) frames(rig, 1);
    assert.ok(Math.abs(rig.get('ParamSkirtSway')) < 0.001, 'without driven head/body input the pendulum returns to centre');
  } finally { rig.dispose(); }
});

test('manual sleep and talking use actual eyelids and never invent mouth amplitude',async()=>{
 const rig=await createRig();try{
  rig.setAutomaticPolicy({modelId:catalog.modelId,revision:0,enabledIds:enabled});
  rig.configureMotion({amount:.6,tracking:true});assert.equal(rig.setAnimationState('Sleep'),true);frames(rig,150);
  assert.equal(rig.snapshot().animation.state,'Sleep');assert.ok(rig.get('ParamEyeLOpen')<.01);assert.equal(rig.get('ParamMouthOpenY'),0);
  view.state='speaking';view.mouth=.4;frames(rig,1);assert.equal(rig.snapshot().animation.state,'Talking');assert.ok(rig.get('ParamMouthOpenY')>.5);
  view.state='idle';view.mouth=0;rig.setAnimationState('Talking');frames(rig,1);assert.equal(rig.get('ParamMouthOpenY'),0,'a talking pose with no audio remains silent');
  assert.equal(rig.setAnimationState('unsupported'),false);
 }finally{view.state='idle';view.mouth=0;rig.dispose();}
});
test('motion settings zero the idle sway, genuine gaze follows, and shy brows release',async()=>{
 const rig=await createRig();try{
  rig.setAutomaticPolicy({modelId:catalog.modelId,revision:0,enabledIds:enabled});rig.configureMotion({amount:0,tracking:false,frequency:0});frames(rig,100);
  for(const id of ['ParamAngleX','ParamAngleY','ParamAngleZ','ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ'])assert.ok(Math.abs(rig.get(id))<1e-4,id);
  rig.configureMotion({tracking:true});rig.setLookAt({x:1,y:0});frames(rig,60);assert.ok(rig.get('ParamEyeBallX')>.5);
  rig.setLookAt(null);rig.setAnimationState('Shy');frames(rig,20);assert.ok(rig.get('ParamBrowLY')>.1);assert.equal(rig.get('ParamMouthOpenY'),0);
  frames(rig,200);assert.equal(rig.snapshot().animation.state,'Idle');assert.ok(Math.abs(rig.get('ParamBrowLY'))<.001);
 }finally{rig.dispose();}
});
test('body sway feeds the same frame into hair and clothing physics',async()=>{
 const rig=await createRig();try{
  rig.setAutomaticPolicy({modelId:catalog.modelId,revision:0,enabledIds:enabled});
  rig.configureMotion({amount:1,frequency:0,tracking:false});
  let input;
  const evaluate=rig._physics.evaluate.bind(rig._physics);
  rig._physics.evaluate=(model,dt)=>{input=['ParamBodyAngleX','ParamBodyAngleZ'].map(id=>rig.get(id));evaluate(model,dt);};
  frames(rig,90);
  for(const [i,id] of ['ParamBodyAngleX','ParamBodyAngleZ'].entries())
   assert.ok(Math.abs(input[i]-rig.get(id))<1e-6,`${id}: physics saw ${input[i]}, rendered ${rig.get(id)}`);
 }finally{rig.dispose();}
});
