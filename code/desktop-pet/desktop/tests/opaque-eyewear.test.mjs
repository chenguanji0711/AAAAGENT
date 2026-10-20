import test from 'node:test';
import assert from 'node:assert/strict';
import { bindOpaqueEyewear } from '../opaque-eyewear.mjs';
const profile={drawable:'ArtMeshEyewear',texture:1,hide:['ArtMeshIridesL','ArtMeshEyewhiteL'],uvRect:[0,0,1,1]};
function fixture(){return {ids:['ArtMeshEyewear','ArtMeshIridesL','ArtMeshEyewhiteL','ArtMeshMouth'],textureIndices:new Int32Array([0,0,0,0]),vertexUvs:[new Float32Array([.2,.4,.6,.4,.6,.8,.2,.8])],opacities:new Float32Array([1,1,1,1])};}
test('maps existing eyewear mesh to a separate texture, hides only covered eyes after each Core update',()=>{
 const d=fixture(); const adapter=bindOpaqueEyewear(d,profile,2); adapter.apply();
 assert.equal(d.textureIndices[0],1); assert.deepEqual([...d.vertexUvs[0]],[0,0,1,0,1,1,0,1]);
 assert.deepEqual([...d.opacities],[1,0,0,1]); d.opacities.fill(1);adapter.apply();assert.deepEqual([...d.opacities],[1,0,0,1]);
});
test('an absent appearance profile never changes an imported model',()=>{const d=fixture();assert.equal(bindOpaqueEyewear(d,undefined,1),null);assert.deepEqual([...d.opacities],[1,1,1,1]);});
test('rejects invalid profiles before changing any model buffer',()=>{for(const change of [{texture:7},{drawable:'missing'},{hide:['ArtMeshMouth']},{uvRect:[0,0,Infinity,1]}]){const d=fixture();assert.throws(()=>bindOpaqueEyewear(d,{...profile,...change},2));assert.equal(d.textureIndices[0],0);}});
