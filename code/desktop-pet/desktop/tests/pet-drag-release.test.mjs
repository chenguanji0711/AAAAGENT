import test from 'node:test';
import assert from 'node:assert/strict';
import {installPetWindowControls} from '../pet-window-controls.mjs';
test('a completed drag releases its pose once; cancellation also releases once',()=>{
 const nodes=Object.fromEntries(['character','pet-ball','pet-collapse','workbench-collapse','work-records-collapse','pet','drawer'].map(id=>[id,{style:{},setPointerCapture(){},hasPointerCapture(){return false;}}]));
 const changes=[];
 const control=installPetWindowControls({get:id=>nodes[id],shell(){},panelOpen:()=>false,onCollapse(){},onRestore(){},onPetClick(){},onDragChange:value=>changes.push(value)});
 const event={button:0,pointerId:1,screenX:10,screenY:10};
 nodes.character.onpointerdown(event);
 nodes.character.onpointermove({...event,screenX:20});
 nodes.character.onpointerup({...event,screenX:20});
 assert.deepEqual(changes,[true,false]);
 nodes.character.onpointerdown(event);
 nodes.character.onpointermove({...event,screenX:30});
 control.cancel();nodes.character.onlostpointercapture(event);
 assert.deepEqual(changes,[true,false,true,false]);
});
