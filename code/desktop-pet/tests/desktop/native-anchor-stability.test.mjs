// Run the actual native orchestration with hidden views; no backend or user settings writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve, join} from 'node:path';
const cache=resolve('desktop/.cache'); mkdirSync(cache,{recursive:true});
const dir=mkdtempSync(join(cache,'anchor-native-'));
try {
 writeFileSync(join(dir,'shell.swift'),readFileSync('desktop/native/main.swift','utf8').split('#if !DESKTOP_WORKLET_TEST')[0]+'\n#endif\n');
 writeFileSync(join(dir,'main.swift'),`
import AppKit
import WebKit
let app=NSApplication.shared
app.setActivationPolicy(.prohibited)
let screen=NSScreen.main!.visibleFrame
func makeDelegate() -> AppDelegate {
 let d=AppDelegate()
 d.panel=PetPanel(contentRect:CGRect(x:screen.midX,y:screen.midY,width:380,height:360),styleMask:[.borderless],backing:.buffered,defer:false)
 d.web=WKWebView(frame:.zero)
 // pageReady stays false: no loaded content, transport, JS or persisted settings changes.
 return d
}
func same(_ a:CGRect,_ b:CGRect,_ message:String) {
 precondition(abs(a.minX-b.minX)<0.01 && abs(a.minY-b.minY)<0.01 && abs(a.width-b.width)<0.01 && abs(a.height-b.height)<0.01,message+" before=\\(a) after=\\(b)")
}
let mode=CommandLine.arguments[1]
let d=makeDelegate(); d.applyDisplay(); let original=d.modelScreenFrame!
if mode == "composer" {
 for _ in 0..<3 {
  d.quickHeight=112;d.applyDisplay()
  d.quickHeight=56;d.applyDisplay()
  same(original,d.modelScreenFrame!,"composer roundtrip must restore model rect")
 }
} else if mode == "passive" {
 d.speechVisible=false;d.displayOpen=true;d.applyDisplay()
 d.speechVisible=true;d.displayOpen=false;d.applyDisplay()
 same(original,d.modelScreenFrame!,"independent chat visibility must preserve model rect")
} else if mode == "collapse" {
 // Match the production message handler's non-dragged collapse/restore transition.
 d.displayCollapsed=true;d.applyDisplay()
 d.displayCollapsed=false;d.applyDisplay()
 same(original,d.modelScreenFrame!,"collapse without dragging must not relocate the model")
} else if mode == "resize" {
 d.displayPreferences.resize("begin",width:nil)
 d.displayPreferences.resize("update",width:720);d.applyDisplay()
 d.displayPreferences.resize("cancel",width:nil);d.applyDisplay()
 same(original,d.modelScreenFrame!,"cancelled resize must restore the original model rect")
} else if mode == "ball-drag" {
 d.displayCollapsed=true;d.applyDisplay()
 let target=CGPoint(x:screen.midX,y:screen.maxY-190)
 d.applyDisplay(proposedModelTop:target)
 d.displayCollapsed=false;d.applyDisplay()
 precondition(abs(d.modelScreenFrame!.midX-target.x)<0.01,"dragged ball must reposition the restored character")
 let moved=d.modelScreenFrame!
 d.quickHeight=112;d.applyDisplay();d.quickHeight=56;d.applyDisplay()
 same(moved,d.modelScreenFrame!,"ball drag target must survive composer roundtrip")
} else if mode == "drag" {
 let target=CGPoint(x:screen.midX,y:screen.maxY-190)
 d.applyDisplay(proposedModelTop:target)
 let dragged=d.modelScreenFrame!
 precondition(abs(dragged.midX-original.midX)>10,"explicit dragging must move the model")
 d.quickHeight=112;d.applyDisplay();d.quickHeight=56;d.applyDisplay()
 same(dragged,d.modelScreenFrame!,"passive fitting must preserve the user's drag target")
}
print(mode+": passed")
`);
 const r=spawnSync('swiftc',['-D','DESKTOP_WORKLET_TEST','-module-cache-path',join(cache,'swift'),'-framework','AppKit','-framework','WebKit','desktop/native/asset-response.swift','desktop/native/display-layout.swift','desktop/native/motion-preferences.swift',join(dir,'shell.swift'),join(dir,'main.swift'),'-o',join(dir,'probe')],{encoding:'utf8',timeout:90000});
 assert.equal(r.status,0,r.stderr);
 for(const mode of ['composer','passive','collapse','drag','ball-drag','resize']) test('native anchor stability: '+mode,()=>{
  const r=spawnSync(join(dir,'probe'),[mode],{encoding:'utf8',timeout:20000});
  assert.equal(r.status,0,r.stderr); console.log(r.stdout.trim());
 });
 test.after(()=>rmSync(dir,{recursive:true,force:true}));
} catch(e) {rmSync(dir,{recursive:true,force:true});throw e;}
