import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {join,resolve} from 'node:path';
test('native clip contains speech HUD at screen edges without obscuring the model on roomy displays',()=>{
 const dir=mkdtempSync(resolve('desktop/.cache/chat-hud-'));
 try{writeFileSync(join(dir,'main.swift'),`
import Foundation
import CoreGraphics
for screen in [CGRect(x:0,y:0,width:1470,height:900),CGRect(x:-900,y:80,width:900,height:700),CGRect(x:0,y:0,width:320,height:300)] {
 for anchor in [CGPoint(x:screen.minX,y:screen.maxY),CGPoint(x:screen.maxX,y:screen.maxY),CGPoint(x:screen.midX,y:screen.midY),CGPoint(x:screen.midX,y:screen.minY)] {
  for open in [false,true] {
   let l=PetDisplayLayout.fit(width:360,open:open,screen:screen,anchor:anchor)
   guard let x=l.configuration["speechLeft"] as? CGFloat,let y=l.configuration["speechTop"] as? CGFloat,let w=l.configuration["speechWidth"] as? CGFloat,let h=l.configuration["speechHeight"] as? CGFloat else {fatalError("speech geometry missing from native layout")}
   let speech=CGRect(x:screen.minX+x,y:screen.maxY-y-h,width:w,height:h)
   precondition(screen.insetBy(dx:-0.01,dy:-0.01).contains(speech))
   precondition(l.frame.insetBy(dx:-0.01,dy:-0.01).contains(speech))
   precondition(speech.minY >= l.modelFrame.maxY+7,"speech must sit above the model")
   precondition(abs(speech.midX-l.modelFrame.midX)<1 || speech.minX<=screen.minX+0.01 || speech.maxX>=screen.maxX-0.01,"speech centred unless clamped flush to a screen edge")
  }
 }
}
// Edge regression: model canvas may overhang for Trash alignment; controls and native clip may not.
 let wide=CGRect(x:0,y:0,width:1920,height:965)
 let over=PetDisplayLayout.fit(width:572,open:false,screen:wide,anchor:CGPoint(x:1868,y:0))
 precondition(over.modelFrame.maxX>wide.maxX,"model canvas may overhang the screen edge")
 precondition(over.speechFrame.maxX<=wide.maxX+0.01 && over.speechFrame.minX>=wide.minX-0.01,"speech stays on screen when the model overhangs")
 precondition(over.speechFrame.minY>=over.modelFrame.maxY+7,"clamped speech keeps sitting above the model")
 precondition(over.frame.maxX<=wide.maxX+0.01 && over.frame.minX>=wide.minX-0.01,"native clip must not extend past the screen so the Dock stays clear")
 precondition(over.frame.maxY<=wide.maxY+0.01 && over.frame.minY>=wide.minY-0.01,"native clip stays inside the screen vertically")
 let minModel=PetDisplayLayout.fit(width:220,open:false,screen:wide,anchor:CGPoint(x:1900,y:0))
 let maxModel=PetDisplayLayout.fit(width:720,open:false,screen:wide,anchor:CGPoint(x:1900,y:0))
 for l in [minModel,maxModel] {
  let q=l.quickFrame
  precondition(abs(q.width-340)<0.01,"quick keeps its own width regardless of model width")
  precondition(wide.insetBy(dx:-0.01,dy:-0.01).contains(q),"quick stays fully on screen")
  precondition(l.frame.insetBy(dx:-0.01,dy:-0.01).contains(q),"quick inside the native clip, not just the viewport")
  precondition(q.maxY<=l.modelFrame.minY+0.01,"quick sits below the model")
 }
for height in [40.0,56.0,112.0] { for width in [220.0,720.0] {
 let screen=CGRect(x:-1000,y:85,width:1000,height:800)
 let l=PetDisplayLayout.fit(width:width,open:false,screen:screen,anchor:CGPoint(x:screen.maxX,y:screen.minY),quickHeight:height)
 precondition(abs(l.quickFrame.height-height)<0.01,"native reserves the actual composer height")
 precondition(l.frame.insetBy(dx:-0.01,dy:-0.01).contains(l.quickFrame))
 precondition(l.quickFrame.maxY<=l.modelFrame.minY+0.01,"multiline composer remains below model")
 precondition(l.configuration["petHeight"] as? CGFloat == l.petFrame.height)
}}
let dock=PetDisplayLayout.fit(width:540,open:false,screen:CGRect(x:0,y:0,width:1470,height:875),anchor:CGPoint(x:1470,y:0))
precondition(dock.frame.maxX==1470 && dock.frame.minY==0,"stack must dock bottom-right")
let edge=PetDisplayLayout.fit(width:360,open:true,screen:CGRect(x:0,y:0,width:1470,height:900),anchor:CGPoint(x:0,y:900))
precondition(!edge.speechFrame.intersects(edge.drawerFrame),"speech must avoid main drawer when another slot is available")
let screen=CGRect(x:0,y:0,width:1470,height:900), anchor=CGPoint(x:800,y:700)
let visible=PetDisplayLayout.fit(width:360,open:true,screen:screen,anchor:anchor,speechVisible:true,speechHeight:150)
let hidden=PetDisplayLayout.fit(width:360,open:true,screen:screen,anchor:anchor,speechVisible:false,speechHeight:150)
precondition(visible.modelFrame == hidden.modelFrame && visible.drawerFrame == hidden.drawerFrame)
precondition(hidden.frame == hidden.petFrame.union(hidden.drawerFrame))
let tall=PetDisplayLayout.fit(width:360,open:false,screen:screen,anchor:anchor,speechHeight:999)
precondition(tall.configuration["speechHeight"] as? CGFloat == 160)
print("24 speech/screen/edge/drawer combinations; hide independence and height clamp passed")
`);
 const result=spawnSync('swiftc',['-module-cache-path','desktop/.cache/swift','desktop/native/display-layout.swift',join(dir,'main.swift'),'-o',join(dir,'test')],{encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);
 const run=spawnSync(join(dir,'test'),[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);console.log(run.stdout.trim());
 }finally{rmSync(dir,{recursive:true,force:true});}
});
