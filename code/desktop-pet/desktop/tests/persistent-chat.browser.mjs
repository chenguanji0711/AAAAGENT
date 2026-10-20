import {build} from 'esbuild';
import {optionalLive2dBuild} from '../optional-live2d-build.mjs';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const out=resolve(process.env.PET_HUD_TEST_OUT??'../../tasks/bottom-right-pet-20261018');
const temp=await mkdtemp(resolve('../../tasks/parallel-mode/.runtime/tmp/hud-'));
let browser,server;const cases=[];
try {
 await writeFile(join(temp,'main.swift'),`
import Foundation
import CoreGraphics
let screen=CGRect(x:0,y:0,width:1000,height:800)
let anchors=[CGPoint(x:190,y:800),CGPoint(x:810,y:800),CGPoint(x:190,y:376),CGPoint(x:810,y:376)]
let configs = [220.0,360.0,720.0].flatMap { width in [56.0,112.0].flatMap { quickHeight in anchors.map { anchor in
 ["shown":PetDisplayLayout.fit(width:width,open:false,screen:screen,anchor:anchor,speechHeight:70,quickHeight:quickHeight).configuration,
  "hidden":PetDisplayLayout.fit(width:width,open:false,screen:screen,anchor:anchor,speechVisible:false,speechHeight:70,quickHeight:quickHeight).configuration]
} } }
let data=try JSONSerialization.data(withJSONObject:configs)
print(String(data:data,encoding:.utf8)!)
`);
 const compiled=spawnSync('swiftc',['-module-cache-path','desktop/.cache/swift','desktop/native/display-layout.swift',join(temp,'main.swift'),'-o',join(temp,'geometry')],{encoding:'utf8',timeout:60000});assert.equal(compiled.status,0,compiled.stderr);
 const geometry=spawnSync(join(temp,'geometry'),[],{encoding:'utf8'});assert.equal(geometry.status,0,geometry.stderr);const nativeLayouts=JSON.parse(geometry.stdout);
 const live2d=await optionalLive2dBuild();
 await build({entryPoints:['desktop/main.mjs'],bundle:true,format:'esm',platform:'browser',target:'safari17',outfile:join(temp,'renderer.js'),plugins:live2d.plugins});
 const desktop=resolve('desktop');
 server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path==='/build/renderer.js'?join(temp,'renderer.js'):resolve(desktop,'.'+(path==='/'?'/index.html':path));if(file!==join(temp,'renderer.js')&&!file.startsWith(desktop+'/'))throw Error();res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:2});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.wires=[];window.webkit={messageHandlers:Object.fromEntries(['desktop','diagnostic','shell'].map(name=>[name,{postMessage(value){wires.push({name,value});}}]))};});
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.waitForFunction(()=>window.petBridge);
 const layout={mode:'full',preferredWidth:360,modelWidth:360,modelHeight:340,drawerHeight:500,petLeft:100,petTop:120,petWidth:380,drawerLeft:490,drawerTop:40,drawerWidth:480,rendererKind:'live2d',collapsed:false};
 await page.evaluate(v=>petBridge.displayConfig(v),layout);
 await page.waitForFunction(()=>WhaleDesktop.snapshot()?.ready,null,{timeout:45000});
 await page.evaluate(()=>{petBridge.connectionChanged({generation:1,state:'connecting'});return petBridge.receive({channel:'backend_ready',bridgeVersion:'0.8.0',characterId:'companion',sessionId:'hud-test'},1);});
 const visible=id=>page.locator('#'+id).isVisible();
 assert.equal(await visible('speech-bubble'),true,'chat bar must render before any reply');
 assert.equal(await visible('open'),false,'聊一会儿 should not be displayed');
 assert.equal(await visible('quick-chat'),true);assert.equal(await visible('drawer'),false);cases.push('default visible waiting bar and quick input');
 await page.screenshot({path:join(out,'browser-default.png')});
 await page.locator('#speech-hide').click();assert.equal(await visible('speech-bubble'),false);assert.equal(await visible('quick-chat'),true);assert.equal(await visible('drawer'),false);cases.push('close hides only speech bar');
 await page.locator('#speech-show').click();assert.equal(await visible('speech-bubble'),true);
 await page.locator('#character').click({position:{x:180,y:180}});assert.equal(await visible('drawer'),true);
 await page.locator('#speech-hide').click();assert.equal(await visible('drawer'),true);assert.equal(await visible('quick-chat'),true);
 await page.locator('#speech-show').click();await page.locator('#close').click();cases.push('show restores without changing main drawer');
 await page.locator('#quick-hide').click();assert.equal(await visible('quick-chat'),false);assert.equal(await visible('speech-bubble'),true);await page.locator('#quick-show').click();cases.push('quick input owns independent hide/show');
 await page.locator('#speech-hide').click();await page.locator('#quick-text').fill('合成测试：你好');await page.locator('#quick-send').click();assert.equal(await visible('quick-chat'),true);assert.equal(await page.locator('#quick-text').inputValue(),'');
 await page.locator('#quick-text').fill('下一条草稿');
 const request=await page.evaluate(()=>wires.filter(w=>w.name==='desktop'&&w.value.message.command?.type==='submit_text').at(-1).value.message.command);
 const scope={characterId:'companion',sessionId:'hud-test',turnId:'t1',generation:1};
 const receive=m=>page.evaluate(m=>petBridge.receive(m,1),m);
 await receive({channel:'event',event:{type:'turn',input:{kind:'text',scope,startedAt:'',clientRequestId:request.clientRequestId}}});await receive({channel:'input_route',route:'companion',scope});
 assert.equal(await page.locator('#quick-send').isEnabled(),true,'route acknowledgement refreshes a draft typed while pending');
 await receive({channel:'event',event:{type:'reply_progress',scope,text:'你好'}});assert.equal(await visible('speech-bubble'),false,'streaming must not undo manual hide');await page.locator('#speech-show').click();assert.equal(await page.locator('#speech-text').innerText(),'你好');
 await page.locator('#character').click({position:{x:180,y:180}});
 await page.evaluate(()=>{window.readingNode=document.querySelector('#reply .chat-row.user div').firstChild;const range=document.createRange();range.selectNodeContents(readingNode);getSelection().removeAllRanges();getSelection().addRange(range);window.readingText=getSelection().toString();});
 await receive({channel:'event',event:{type:'reply_progress',scope,text:'你好，我在这里。'}});
 assert.equal(await page.evaluate(()=>readingNode.isConnected&&getSelection().toString()===readingText),true,'streaming HUD must preserve main-window reading selection');await page.locator('#close').click();assert.equal(await page.locator('#speech-text').innerText(),'你好，我在这里。');
 await receive({channel:'event',event:{type:'reply_progress',scope:{...scope,generation:0},text:'过期内容'}});assert.equal(await page.locator('#speech-text').innerText(),'你好，我在这里。');
 const expression={emotion:'warm',intensity:.5,delivery:'',gesture:null};
 await receive({channel:'event',event:{type:'reply',reply:{scope,text:'你好，我在这里陪你。',expression}}});await receive({channel:'event',event:{type:'playback',playback:{scope,type:'started',audioId:'synthetic',at:''}}});await receive({channel:'event',event:{type:'playback',playback:{scope,type:'ended',at:''}}});
 await page.waitForTimeout(6500);assert.equal(await visible('speech-bubble'),true);assert.equal(await page.locator('#speech-text').innerText(),'你好，我在这里陪你。');assert.equal(await visible('quick-chat'),true);cases.push('scoped incremental updates; hidden state retained; playback end plus 6.5 seconds never hides');
 await page.locator('#quick-text').fill('下一条消息');await page.locator('#quick-send').click();assert.equal(await page.locator('#speech-text').innerText(),'你好，我在这里陪你。');cases.push('new user input retains previous assistant text');
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const checkClip=async(id,config)=>{
  const result=await page.locator('#'+id).evaluate((n,c)=>{
   const r=n.getBoundingClientRect(),eps=.75;
   const bounds={left:c.clipLeft,top:c.clipTop,right:c.clipLeft+c.clipWidth,bottom:c.clipTop+c.clipHeight};
   const inside=r.width>0&&r.height>0&&r.left>=bounds.left-eps&&r.top>=bounds.top-eps&&r.right<=bounds.right+eps&&r.bottom<=bounds.bottom+eps;
   const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
   return {inside,hit:hit===n||n.contains(hit),rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},bounds};
  },config);
  if(!result.inside||!result.hit){await page.screenshot({path:join(out,'browser-edge-failure.png')});await writeFile(join(out,'browser-edge-failure.json'),JSON.stringify({id,config,...result},null,2));}
  assert.ok(result.inside,id+' must fit native clip: '+JSON.stringify(result));
  assert.ok(result.hit,id+' must be reachable by pointer');
 };
 for(const nativeCase of nativeLayouts){
  const shown={...layout,...nativeCase.shown},hidden={...layout,...nativeCase.hidden};
  await page.evaluate(v=>petBridge.displayConfig(v),shown);
  await page.locator('#quick-text').fill(shown.quickHeight>56?'第一行\n第二行\n第三行\n第四行\n第五行\n第六行':'');await settle();
  for(const id of ['speech-bubble','quick-chat','speech-hide','quick-hide'])await checkClip(id,shown);
  assert.equal(await page.evaluate(()=>{const s=document.getElementById('speech-bubble').getBoundingClientRect(),m=document.getElementById('character').getBoundingClientRect();return s.bottom<=m.top-7;}),true,'speech remains above model after independent edge fitting');
  await page.locator('#speech-hide').click();await page.evaluate(v=>petBridge.displayConfig(v),hidden);await settle();
  assert.equal(await visible('quick-chat'),true);assert.equal(await visible('drawer'),false);await checkClip('speech-show',hidden);
  await page.locator('#speech-show').click();await page.evaluate(v=>petBridge.displayConfig(v),shown);await settle();assert.equal(await visible('speech-bubble'),true);
  await page.locator('#quick-hide').click();await settle();await checkClip('quick-show',shown);
  assert.equal(await visible('speech-bubble'),true);await page.locator('#quick-show').click();await settle();await checkClip('quick-chat',shown);
  // Reapply the same host configuration: clipping corrections must never accumulate drift.
  const before=await page.locator('#quick-chat').boundingBox();await page.evaluate(v=>petBridge.displayConfig(v),shown);await settle();
  assert.deepEqual(await page.locator('#quick-chat').boundingBox(),before,'repeated layout acknowledgement preserves composer position');
 }
 assert.equal(await page.evaluate(()=>wires.some(w=>w.name==='shell'&&w.value.type==='set_chat_hud'&&w.value.quickHeight>80)),true,'multiline composer publishes its measured height to native host');
 cases.push('24 native edge/size/composer-height cases: rendered controls fit clip, independent hide/restore are clickable, acknowledgements do not drift');
 await page.evaluate(v=>petBridge.displayConfig(v),{...layout,modelWidth:220,modelHeight:220*340/360,petWidth:240});
 await page.locator('#speech-hide').click();await page.locator('#quick-hide').click();
 assert.equal(await visible('open'),false);assert.equal(await visible('speech-show'),true);assert.equal(await visible('quick-show'),true);
 await page.locator('#speech-show').click();await page.locator('#quick-show').click();cases.push('minimum pet size preserves independent restore controls and hidden opener');
 await page.evaluate(v=>petBridge.displayConfig(v),layout);await page.screenshot({path:join(out,'browser-reply.png')});
 assert.deepEqual(errors,[]);const model=await page.evaluate(()=>WhaleDesktop.snapshot());
 await writeFile(join(out,'browser-result.json'),JSON.stringify({passed:true,cases,errors,model,boundary:'Production DOM, compiled entry and official Core/WebGL; synthetic backend bridge messages; no cloud or microphone calls.'},null,2));
 console.log(JSON.stringify({passed:true,cases:cases.length,errors}));
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
