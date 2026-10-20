import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { WeChatApi,ILINK_ORIGIN,type WeChatCredentials } from '../../wechat/api.js';
import { wechatVoiceReplySender,encodeNativeVoice } from '../../wechat/output.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';
import type { TtsProvider } from '../../contracts/index.js';
const signal=new AbortController().signal,auth:WeChatCredentials={token:'synthetic',userId:'user',botId:'bot',baseUrl:ILINK_ORIGIN};
const json=(v:unknown)=>new Response(JSON.stringify(v));
const speech=(seconds:number,rate=24000)=>pcm16Wav(Float32Array.from({length:Math.round(rate*seconds)},(_,i)=>Math.sin(i/6)*0.4),rate);

test('native voice encodes official SILK v3 at the documented rate and refuses what it cannot express',async()=>{
  const {silk,playtime}=await encodeNativeVoice(speech(1));
  assert.equal(silk[0],2,'the wire format starts with 0x02');
  assert.equal(Buffer.from(silk.subarray(1,10)).toString('ascii'),'#!SILK_V3');
  assert.equal(playtime,1000,'a one second clip reports one second of playback');
  await assert.rejects(encodeNativeVoice(speech(1,48000)),/24 kHz mono/,'a 48 kHz clip is refused, never resampled blindly');
  await assert.rejects(encodeNativeVoice(speech(61)),/longer than one minute/);
});

test('voice reply sends a tappable SILK bubble as item type 3, never as a file',async()=>{
  const media=new MemoryMediaStore();const uploads:any[]=[],sent:any[]=[];let syntheses=0;
  const api=new WeChatApi((async(u,o)=>{const b=JSON.parse(String(o!.body));if(String(u).endsWith('getuploadurl')){uploads.push(b);return json({upload_param:'opaque'});}sent.push(b);return json({ret:0});}) as typeof fetch);
  const tts:TtsProvider={async synthesize(i){syntheses++;return {scope:i.scope,audio:await media.put(i.scope,speech(1),'audio/wav'),expression:i.expression,durationMs:1000,synchronization:'amplitude'};}};
  const transport=(async()=>new Response(null,{headers:{'x-encrypted-param':'download'}})) as typeof fetch;
  await wechatVoiceReplySender(media,tts,api,transport)(auth,'context','你好呀','client',signal);
  assert.equal(syntheses,1,'a reply is synthesized exactly once');
  assert.equal(uploads[0].media_type,4,'the native bubble uploads with media_type 4');
  assert.equal(sent[0].msg.item_list[0].type,3);
  const voice=sent[0].msg.item_list[0].voice_item;
  assert.equal(voice.encode_type,6);assert.equal(voice.sample_rate,24000);assert.equal(voice.bits_per_sample,16);
  assert.equal(voice.media.encrypt_type,1);assert.ok(voice.playtime>=990&&voice.playtime<=1010);
  assert.equal(media.count,0);
});

test('a bubble that cannot be built falls back to the file copy from the same synthesis',async()=>{
  const media=new MemoryMediaStore();const uploads:any[]=[],sent:any[]=[];let syntheses=0;
  const api=new WeChatApi((async(u,o)=>{const b=JSON.parse(String(o!.body));if(String(u).endsWith('getuploadurl')){uploads.push(b);return json({upload_param:'opaque'});}sent.push(b);return json({ret:0});}) as typeof fetch);
  const tts:TtsProvider={async synthesize(i){syntheses++;return {scope:i.scope,audio:await media.put(i.scope,speech(1,48000),'audio/wav'),expression:i.expression,durationMs:1000,synchronization:'amplitude'};}};
  const transport=(async()=>new Response(null,{headers:{'x-encrypted-param':'download'}})) as typeof fetch;
  await wechatVoiceReplySender(media,tts,api,transport)(auth,'context','你好呀','client',signal);
  assert.equal(syntheses,1,'the fallback reuses the one synthesis');
  assert.deepEqual(uploads.map(u=>u.media_type),[3]);
  assert.equal(sent[0].msg.item_list[0].type,4,'the fallback is the reviewed file wire');
  assert.equal(sent[0].msg.item_list[0].file_item.len,String(48000*2+44));
  assert.equal(media.count,0);
});

test('the sealed upload round-trips to the SILK clip and the buffers are wiped afterwards',async()=>{
  const media=new MemoryMediaStore();const original=speech(1);let encrypted:Uint8Array|undefined,live:Uint8Array|undefined,uploadRequest:any;
  const api=new WeChatApi((async(u,o)=>{const b=JSON.parse(String(o!.body));if(String(u).endsWith('getuploadurl')){uploadRequest=b;return json({upload_param:'opaque'});}return json({ret:0});}) as typeof fetch);
  const tts:TtsProvider={async synthesize(i){return {scope:i.scope,audio:await media.put(i.scope,original,'audio/wav'),expression:i.expression,durationMs:1000,synchronization:'amplitude'};}};
  const transport=(async(_u:unknown,o:any)=>{live=o!.body as Uint8Array;encrypted=live.slice();return new Response(null,{headers:{'x-encrypted-param':'download'}});}) as typeof fetch;
  await wechatVoiceReplySender(media,tts,api,transport)(auth,'context','你好呀','client',signal);
  const d=createDecipheriv('aes-128-ecb',Buffer.from(uploadRequest.aeskey,'hex'),null);
  const plain=Buffer.concat([d.update(encrypted!),d.final()]);
  assert.equal(plain[0],2);assert.equal(plain.subarray(1,10).toString('ascii'),'#!SILK_V3','the client decrypts to the SILK clip, not the WAV');
  assert.ok(!plain.equals(Buffer.from(original)),'the upload is ciphertext in transit');
  plain.fill(0);assert.ok(live!.every(v=>v===0),'the live upload buffer is wiped after the send');original.fill(0);
});
