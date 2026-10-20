import test from 'node:test';
import assert from 'node:assert/strict';
import {JsonDialogueProvider} from '../../providers/qwen-dialogue.js';
import {partialDialogueText} from '../../providers/dialogue-stream.js';
import {ProviderTransport,type CallOutcome} from '../../providers/transport.js';
import type {DialogueRequest,TurnScope} from '../../contracts/index.js';
const scope:TurnScope={characterId:'companion',sessionId:'stream',turnId:'one',generation:1};
const input:DialogueRequest={scope,text:'你好',context:{scope,characterPrompt:'陪伴',recent:[{id:'u',characterId:'companion',role:'user',text:'你好',createdAt:'2026-10-18T00:00:00Z'}],summary:'',memories:[],perception:null,inputTokenBudget:32768}};
const expression={emotion:'calm',intensity:.4,delivery:'自然',gesture:null};
function fixture(parts:string[],finish=true){
 const outcomes:CallOutcome[]=[];let sent:any;const chunks=parts.map(content=>'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:null}]})+'\n\n');
 if(finish)chunks.push('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{completion_tokens:9}})+'\n\n');
 const transport=new ProviderTransport(async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(new ReadableStream({start(c){for(const s of chunks)c.enqueue(new TextEncoder().encode(s));c.close();}}));});
 const provider=new JsonDialogueProvider({endpoint:'https://unit.invalid/chat/completions',model:'unit',apiKey:()=> 'test-only',authorizer:{async authorize(){return{async settle(o){outcomes.push(o);}};}}},transport);
 return{provider,outcomes,payload:()=>sent};
}
test('dialogue publishes decoded text snapshots before completion, never metadata or reasoning',async()=>{
 const f=fixture(['{"expression":'+JSON.stringify(expression)+',"text":"你','好，\\"朋','友\\"！\\n再见','"}']);const progress:string[]=[];
 const result=await f.provider.reply(input,new AbortController().signal,text=>progress.push(text));
 assert.ok(progress.length>=3,'must forward multiple live snapshots');assert.equal(progress[0],'你');assert.equal(progress.at(-1),'你好，"朋友"！\n再见');assert.equal(result.text.includes('你好'),true);assert.equal(f.payload().stream,true);assert.equal(f.outcomes[0]?.status,'success');
});
test('incomplete streamed JSON fails instead of committing a partial reply',async()=>{
 const f=fixture(['{"text":"只有半句'],false),progress:string[]=[];
 await assert.rejects(f.provider.reply(input,new AbortController().signal,text=>progress.push(text)));
 assert.deepEqual(progress,['只有半句']);assert.equal(f.outcomes[0]?.status,'failed');
});

test('partial JSON exposes only the top-level spoken string and completes split Unicode escapes',()=>{
 assert.equal(partialDialogueText('{"metadata":{"text":"private"},"reasoning":"hidden"}'),undefined);
 assert.equal(partialDialogueText('{"metadata":{"text":"private"},"text":"公开'), '公开');
 assert.equal(partialDialogueText('{"text":"\\u4f'), '');
 assert.equal(partialDialogueText('{"text":"\\u4f60\\ud83d'), '你');
 assert.equal(partialDialogueText('{"text":"\\u4f60\\ud83d\\ude00'), '你😀');
 assert.equal(partialDialogueText('{"text":"<b>plain text</b>'), '<b>plain text</b>');
 assert.equal(partialDialogueText('{"text":"bad\\x'),undefined);
});
