import {AnimationStateMachine,normalizeMotionSettings} from './animation-state.mjs';
// Semantic timing only. Model IDs and physical ranges belong to the renderer.
const smooth=t=>t*t*(3-2*t);
const curve=(t,points)=>{for(let i=1;i<points.length;i++){const [end,value]=points[i],[start,previous]=points[i-1];if(t<=end)return previous+(value-previous)*smooth(Math.max(0,(t-start)/(end-start)));}return points.at(-1)[1];};
export class InteractionMotion {
  constructor(){this.values={yaw:0,pitch:0,roll:0,body:0,bodyY:0,bodyZ:0,gazeX:0,gazeY:0,blink:0,sleep:0,form:0,brow:0};this.attentionAt=null;this.animation=new AnimationStateMachine();this.settings=normalizeMotionSettings();this.pointer=null;this.micro={x:0,y:0};this.nextMicro=4;}
  start(now,region="body"){this.attentionAt=now;this.animation.request(region==="head"?"Shy":"Interact");}
  release(){this.attentionAt=null;this.animation.request('Idle');}
  request(name){return this.animation.request(name);}
  configure(settings){this.settings=normalizeMotionSettings(settings,this.settings);}
  setLookAt(point){this.pointer=point&&Number.isFinite(point.x)&&Number.isFinite(point.y)?{x:Math.max(-1,Math.min(1,point.x)),y:Math.max(-1,Math.min(1,point.y))}:null;}
  sample({now,delta,elapsed,state,head,body,blink,work=false,reducedMotion=false}){
    delta=Number.isFinite(delta)?Math.max(0,Math.min(.1,delta)):0;
    const settings=this.settings;
    const motion=this.animation.advance(delta,{state,pointer:settings.tracking?this.pointer:null});
    const weights=motion.weights;
    const phase=elapsed*settings.speed;
    const amount=settings.amount*(reducedMotion?.12:1)*(1-.8*weights.Drag)*(1-weights.Sleep);
    if(settings.frequency>0&&this.animation.time>=this.nextMicro){
      this.nextMicro=this.animation.time+(3+Math.random()*5)/settings.frequency;
      this.micro={x:(Math.random()-.5)*.14,y:(Math.random()-.5)*.08};
    }
    const age=this.attentionAt===null?Infinity:Math.max(0,(now-this.attentionAt)/1000);
    if(age>.9)this.attentionAt=null;
    const tap=age<=.9?curve(age,[[0,0],[.12,-1],[.32,.42],[.7,0],[.9,0]]):0;
    const eye=age<=.4?curve(age,[[0,0],[.09,1],[.16,1],[.35,0],[.4,0]]):0;
    const speaking=state==='speaking'||motion.state==='Talking',thinking=state==='thinking',listening=state==='listening';
    const target={
      yaw:thinking?4+Math.sin(elapsed*.45)*.7:(Math.sin(phase*.75)+.23*Math.sin(phase*1.27+1.4))*(speaking?5:2)*amount,
      pitch:(thinking?-4:listening?3:Math.sin(phase*1.1)*2)*amount+tap*12,
      roll:(thinking?-7+Math.sin(phase*.35)*.6:Math.sin(phase*.65)*(speaking?4:2))*amount+tap*2,
      body:Math.sin(phase*.75)*(speaking?2:1)*amount+tap*1.8,
      gazeX:thinking?.3+Math.sin(elapsed*.4)*.035:0,
      gazeY:thinking?.18:age<.9?.1:0,
      blink:Math.max(eye,motion.blink),
      bodyY:Math.sin(phase*.63+1.1)*.45*amount,
      bodyZ:Math.sin(phase*.58+.7)*.5*amount,
      sleep:weights.Sleep,
      form:.65*weights.Happy+.2*weights.Shy-.15*weights.Surprised,
      brow:.25*weights.Happy+.35*weights.Shy+.55*weights.Surprised
    };
    target.pitch+=-7*weights.Sleep-3*weights.Shy+3*weights.Surprised;
    target.roll+=2.5*weights.Happy+3*weights.Shy;
    if(settings.tracking&&motion.layers.LookAt&&this.pointer){
      target.yaw+=this.pointer.x*10;target.pitch+=this.pointer.y*6;
      target.gazeX=this.pointer.x*.7;target.gazeY=this.pointer.y*.65;
    }else if(weights.Sleep>.01){target.gazeX=0;target.gazeY=0;}
    if(settings.frequency>0){target.gazeX+=this.micro.x*amount;target.gazeY+=this.micro.y*amount;}
    target.gazeX=Math.max(-.7,Math.min(.7,target.gazeX));target.gazeY=Math.max(-.65,Math.min(.65,target.gazeY));
    if(work){
      const cycle=reducedMotion?0:elapsed;
      target.yaw=1.5+Math.sin(cycle*.55)*.7;
      target.pitch=-8+Math.sin(cycle*.8)*.9;
      target.roll=-2.5+Math.sin(cycle*.4)*.4;
      target.body=Math.sin(cycle*.55)*.55;
      target.gazeX=.14+Math.sin(cycle*.4)*.03;
      target.gazeY=-.28;
      target.blink=.16;
    }
    for(const key of Object.keys(target)){
      const allowed=key.startsWith('body')?body:['blink','sleep'].includes(key)?blink:head;
      if(!allowed){this.values[key]=0;continue;}
      const tau=key==='blink'?.035:(age<.9?.055:.22);
      this.values[key]+=(target[key]-this.values[key])*(1-Math.exp(-Math.max(0,delta)/tau));
    }
    return this.values;
  }
}
