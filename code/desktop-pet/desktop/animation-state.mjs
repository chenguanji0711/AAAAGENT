export const ANIMATION_STATES=Object.freeze(['Idle','Breathing','Blink','LookAt','Talking','Happy','Surprised','Shy','Sleep','Drag','Interact']);
export const DEFAULT_MOTION_SETTINGS=Object.freeze({amount:.6,speed:.75,frequency:1,rate:'60',tracking:true});
const durations={Breathing:2,Blink:.28,LookAt:2.5,Talking:2,Happy:2.5,Surprised:1,Shy:2.8,Interact:.9};
const number=(v,min,max,fallback)=>typeof v==='number'&&Number.isFinite(v)?Math.max(min,Math.min(max,v)):fallback;
export function normalizeMotionSettings(patch={},prior=DEFAULT_MOTION_SETTINGS){
 const p=patch&&typeof patch==='object'&&!Array.isArray(patch)?patch:{};
 const b={...DEFAULT_MOTION_SETTINGS,...prior};
 return {amount:number(p.amount,0,1,b.amount),speed:number(p.speed,.2,2,b.speed),frequency:number(p.frequency,0,2,b.frequency),rate:['60','high','eco'].includes(p.rate)?p.rate:b.rate,tracking:typeof p.tracking==='boolean'?p.tracking:b.tracking};
}
/** Timing concerns only: no model IDs, expressions, audio amplitudes, or mouth ownership. */
export class AnimationStateMachine{
 constructor(){this.time=0;this.requested='Idle';this.until=Infinity;this.started=0;this.weights=Object.fromEntries(ANIMATION_STATES.map(x=>[x,x==='Idle'?1:0]));this.current={state:'Idle',weights:{...this.weights},layers:{Breathing:true,Blink:true,LookAt:false},blink:0};}
 request(name){if(!ANIMATION_STATES.includes(name))return false;this.requested=name;this.started=this.time;this.until=durations[name]?this.time+durations[name]:Infinity;return true;}
 advance(delta,{state='idle',pointer=null,dragging=false}={}){
  const dt=number(delta,0,.1,0);this.time+=dt;
  if(this.time>=this.until)this.requested='Idle';
  const speech=state==='speaking';
  if(this.requested==='Sleep'&&(speech||state==='listening'))this.request('Idle');
  const selected=dragging?'Drag':this.requested!=='Idle'?this.requested:speech?'Talking':'Idle';
  const sleeping=selected==='Sleep';const layers={Breathing:true,Blink:!sleeping,LookAt:!sleeping&&!!pointer};
  const blend=1-Math.exp(-dt/.16);
  for(const key of ANIMATION_STATES){const target=key===selected||key==='Talking'&&speech?1:0;this.weights[key]+=(target-this.weights[key])*blend;}
  const blink=selected==='Blink'?Math.sin(Math.PI*Math.max(0,Math.min(1,(this.time-this.started)/durations.Blink)))**2:0;
  this.current={state:selected,weights:{...this.weights},layers,blink};return this.current;
 }
 snapshot(){return this.current;}
}
