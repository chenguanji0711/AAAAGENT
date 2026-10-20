import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../renderer-switch.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
// Renderer loading is the external SDK/media boundary. These small fixtures own
// observable resource state so we test the replacement lifecycle, not a mock call.
class ResourceRenderer {
  constructor(failure=false){this.failure=failure;this.live=true;this.ready=false;}
  async load(){if(this.failure)throw Error('broken texture');this.ready=true;}
  dispose(){this.live=false;this.ready=false;}
}
test('failed replacement releases only the new renderer and retains the working pet',async()=>{
  assert.equal(typeof module.loadRendererReplacement,'function','safe replacement behavior must exist');
  const current=new ResourceRenderer();await current.load();const next=new ResourceRenderer(true);
  await assert.rejects(()=>module.loadRendererReplacement(current,next),/broken texture/);
  assert.equal(current.live,true);assert.equal(current.ready,true);assert.equal(next.live,false);
});
test('successful replacement becomes ready before releasing the previous renderer',async()=>{
  assert.equal(typeof module.loadRendererReplacement,'function');
  const current=new ResourceRenderer();await current.load();const next=new ResourceRenderer();
  const load=next.load.bind(next);next.load=async()=>{assert.equal(current.live,true);await load();};
  const result=await module.loadRendererReplacement(current,next);
  assert.equal(result,next);assert.equal(next.ready,true);assert.equal(current.live,false);
});
