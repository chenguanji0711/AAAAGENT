import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoPetRenderer } from '../video-pet-renderer.mjs';
import { replyAction, workAction, catalogEntries } from '../video-pet-state.mjs';
import { frameBox } from '../video-pet-face-effects.mjs';

test('automatic replies honor disabled and explicit neutral presets', () => {
  assert.equal(replyAction({presetId:null,emotion:'happy',gesture:'heart'}),'idle');
  assert.equal(replyAction({presetId:'exp-shengqi'},new Set()),'idle');
  assert.equal(replyAction({presetId:'exp-shengqi'},new Set(['exp-shengqi'])),'angry');
  assert.equal(replyAction({emotion:'warm'}),'affectionate');
  assert.equal(replyAction({emotion:'warm'},new Set()),'idle');
});
test('work state follows the exact focused task and project', () => {
  const task={id:'one',projectId:'project'},other={id:'one',projectId:'other'};
  assert.equal(workAction('workbench',{focus:{task},tasks:[{task:other,projection:{phase:'completed'}},{task,projection:{phase:'running'}}]}),'working');
  assert.equal(workAction('workbench',{focus:{task:null},tasks:[{task,projection:{phase:'completed'}}]}),'idle');
  assert.equal(workAction('work',{stage:'failed'}),'error');
});
test('catalog rejects URL syntax and traversal while retaining raw Unicode filenames', () => {
  const invalid=['../secret','%2e%2e%2fsecret','file?query','file#fragment','file:port'];
  const nativeActions=invalid.map((name,n)=>({id:'bad'+n,video:'bad'+n,file:'assets/webm/'+name+'.webm'}));
  nativeActions.push({id:'native:测试',video:'测试',file:'assets/webm/测试.webm'});
  const entries=catalogEntries({nativeActions,actions:[{id:'idle',video:'测试'}],memes:[{id:'meme:x',kind:'meme',file:'https://example.test/image.png'}]});
  assert.deepEqual([...entries.keys()],['native:测试','idle']);
});

const catalog={nativeActions:[{id:'native:idle',video:'idle',file:'assets/webm/idle.webm'},{id:'native:happy',video:'happy',file:'assets/webm/happy.webm'}],
  actions:[{id:'idle',video:'idle',label:'Idle'},{id:'happy',video:'happy',label:'Happy'}]};
function fixture(t) {
  const saved=new Map();
  const install=(name,value)=>{saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});};
  const nodes=[];
  class Element extends EventTarget {
    constructor(tag){super();this.tag=tag;this.dataset={};this.style={};this.children=[];this.autoLoad=true;this.readyState=0;nodes.push(this);}
    setAttribute(name,value){this[name]=value;}
    removeAttribute(name){delete this[name];}
    append(...children){this.children.push(...children);}
    after(child){this.sibling=child;}
    replaceChildren(...children){this.children=children;}
    remove(){this.removed=true;}
    getContext(){return {};}
    pause(){this.paused=true;}
    play(){this.paused=false;return Promise.resolve();}
    load(){if(this.src&&this.autoLoad)queueMicrotask(()=>{this.readyState=2;this.dispatchEvent(new Event('loadeddata'));});}
    dispatchEvent(event){const result=super.dispatchEvent(event);this['on'+event.type]?.(event);return result;}
  }
  install('document',{createElement:tag=>new Element(tag),body:new Element('body')});
  install('location',{href:'pet://app/index.html'});
  install('fetch',async()=>({ok:true,json:async()=>catalog}));
  install('requestAnimationFrame',()=>1);install('cancelAnimationFrame',()=>{});
  const canvas=new Element('canvas'),renderer=new VideoPetRenderer(canvas);
  t.after(()=>{renderer.dispose();for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return {renderer,canvas,nodes};
}
test('one non-preloading video handles playback, suspension, ambient recovery and disposal', async t => {
  const {renderer,canvas,nodes}=fixture(t);
  await renderer.load();
  assert.equal(renderer.ready,true);assert.equal(canvas.hidden,true);
  assert.equal(nodes.filter(node=>node.tag==='video').length,1);
  assert.equal(renderer.video.preload,'none');
  assert.equal(renderer.video.src,'pet://app/assets/local-model/dsh-pet/assets/webm/idle.webm');
  await renderer.play('happy');
  renderer.setSuspended(true);assert.equal(renderer.video.paused,true);
  renderer.setSuspended(false);assert.equal(renderer.video.paused,false);
  renderer.video.dispatchEvent(new Event('ended'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(renderer.current,'idle');assert.equal(renderer.video.loop,true);
  renderer.dispose();assert.equal(renderer.ready,false);assert.equal(renderer.video.src,undefined);
  assert.equal(renderer.root.removed,true);assert.equal(canvas.hidden,false);
});
test('changing the action cancels an unfinished load; disposal cancels the next load', async t => {
  const {renderer}=fixture(t);await renderer.load();renderer.video.autoLoad=false;
  const old=renderer.play('happy'),next=renderer.play('idle',{loop:true});
  assert.equal(await old,false);
  renderer.video.dispatchEvent(new Event('loadeddata'));assert.equal(await next,true);
  const pending=renderer.play('happy');renderer.dispose();assert.equal(await pending,false);
});
test('missing resources report failure without reporting model readiness', async t => {
  const {renderer}=fixture(t);globalThis.fetch=async()=>{throw Error('synthetic missing resource');};
  await assert.rejects(renderer.load(),/视频桌宠素材未安装/);assert.equal(renderer.ready,false);
});
test('video pixels map through the object-fit box the browser actually draws', () => {
  // The clip is 16:9 inside a 641x340 element, so contain letterboxes it horizontally.
  const box = frameBox({ left: 100, top: 50, width: 641, height: 340 });
  assert.equal(box.scale, 340 / 360);
  assert.equal(box.top, 50);
  assert.ok(Math.abs(box.left - (100 + (641 - 640 * (340 / 360)) / 2)) < 1e-9);
  const square = frameBox({ left: 0, top: 0, width: 320, height: 360 });
  assert.equal(square.scale, 0.5);
  assert.equal(square.left, 0);
  assert.equal(square.top, 90);
});
test('the clip the pet mutters with is driven by the live output amplitude', async t => {
  const {renderer}=fixture(t);await renderer.load();
  const seen=[];renderer.effects.setSpeaking=value=>seen.push(value);
  renderer.updateView({state:'speaking',mouth:0.42},'speaking');
  renderer.updateView({state:'speaking',mouth:0.05},'speaking');
  renderer.updateView({state:'idle',mouth:0.05},'idle');
  assert.deepEqual(seen,[0.42,0.05,null],'the renderer passes real amplitude, never a model guess');
});
test('a loud syllable speeds the shipped mouth animation and silence restores it', async t => {
  const {renderer}=fixture(t);await renderer.load();
  renderer.updateView({state:'speaking',mouth:0.25},'speaking');
  const loud=renderer.video.playbackRate;
  assert.ok(loud>1&&loud<=1.6,`a loud syllable plays the clip faster (got ${loud})`);
  assert.ok(renderer.snapshot().mouthOpen>0,'the opening is reported for diagnostics');
  renderer.updateView({state:'idle',mouth:0},'idle');
  assert.equal(renderer.video.playbackRate,1,'the ambient clip returns to normal speed');
});
test('a finished reply is followed by one randomized enabled action, silently', async t => {
  const {renderer}=fixture(t);await renderer.load();
  renderer.setAutomaticPolicy({modelId:'dsh-video-pet',enabledIds:['exp-tushe','exp-zzz','exp-qianqing']});
  const spoken=[];renderer.onAction=id=>spoken.push(id);
  assert.deepEqual(renderer.actionPool(),['happy'],'held states such as rest and listening are never picked');
  assert.equal(renderer.afterSpeech(),'happy');
  assert.deepEqual(renderer.actionPool(),[],'the action that just played is excluded until another one runs');
  assert.deepEqual(spoken,[],'a randomized flourish does not talk over the reply that just ended');
  assert.equal(renderer.afterSpeech(),null,'the same action is not played twice in a row');
  await new Promise(resolve=>setImmediate(resolve));
  renderer.request('happy');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(spoken,['happy'],'a user-triggered action still carries its voice line');
});
test('an empty automatic policy falls back to the ambient state instead of guessing', async t => {
  const {renderer}=fixture(t);await renderer.load();
  renderer.setAutomaticPolicy({modelId:'disconnected',enabledIds:[]});
  assert.deepEqual(renderer.actionPool(),[]);
  assert.equal(renderer.afterSpeech(),null);
  assert.equal(renderer.ambient,'idle');
});
