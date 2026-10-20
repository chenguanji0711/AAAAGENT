import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { encode as encodeSilk } from 'silk-wasm';
import type { TtsProvider, TurnScope } from '../contracts/index.js';
import { MemoryMediaStore } from '../media/store.js';
import { abortable, assertScope } from '../media/scope.js';
import { inspectPcmWav } from '../media/wav.js';
import { channelKey } from './store.js';
import { WeChatApi, type WeChatCredentials } from './api.js';

const CDN='https://novac2c.cdn.weixin.qq.com';
const SILK_HEADER='#!SILK_V3';
const MAX_SILK=128*1024;

type Sealed={ciphertext:Buffer;key:Buffer;size:number;filekey:string};
const scopeFor=(auth:WeChatCredentials):TurnScope=>({characterId:'companion',sessionId:'wechat-tts:'+channelKey(auth),turnId:randomUUID(),generation:1});

/** One bounded synthesis. The returned WAV belongs to the caller, which must wipe it. */
async function synthesizeWav(media:MemoryMediaStore,tts:TtsProvider,scope:TurnScope,text:string,context:string,signal:AbortSignal):Promise<Uint8Array>{
  signal.throwIfAborted();
  if(!context||!text.trim()||text.length>20000||text.includes('\0'))throw Error('Invalid audio reply');
  const pending=tts.synthesize({scope,text,expression:{emotion:'neutral',intensity:0,delivery:'natural',gesture:null}},signal);
  // A provider which finishes after cancellation cannot leave its generated media alive.
  void pending.then(async()=>{if(signal.aborted)await media.releaseScope(scope);},()=>{});
  const result=await abortable(pending,signal);signal.throwIfAborted();assertScope(scope,result.scope);
  if(result.audio.mimeType!=='audio/wav')throw Error('Expected generated PCM WAV');
  const bytes=await media.read(scope,result.audio);
  try{
    signal.throwIfAborted();inspectPcmWav(bytes);
    if(bytes.length>20*1024*1024)throw Error('Audio reply exceeds bounded upload');
    return bytes;
  }finally{await media.releaseScope(scope);}
}
function seal(bytes:Uint8Array):Sealed{
  const size=bytes.length,filekey=randomBytes(16).toString('hex'),key=randomBytes(16);
  const cipher=createCipheriv('aes-128-ecb',key,null),body=cipher.update(bytes),tail=cipher.final();
  try{return {ciphertext:Buffer.concat([body,tail]),key,size,filekey};}
  finally{body.fill(0);tail.fill(0);}
}
/** Uploads sealed bytes and returns the download parameter the client must quote back. */
async function uploadClip(api:WeChatApi,auth:WeChatCredentials,transport:typeof fetch,clip:Sealed,mediaType:number,signal:AbortSignal):Promise<string>{
  const {ciphertext,key,size,filekey}=clip;
  const upload=await api.uploadAudioUrl(auth,{filekey,rawsize:size,rawfilemd5:createHash('md5').update(ciphertext).digest('hex'),filesize:ciphertext.length,aeskey:key.toString('hex')},signal,mediaType);
  signal.throwIfAborted();
  const full=upload.upload_full_url,param=upload.upload_param;
  if(full!==undefined&&(typeof full!=='string'||full.length>8192)||!full&&(typeof param!=='string'||!param||param.length>4096))throw Error('Invalid upload destination');
  const url=new URL(full||CDN+'/c2c/upload?encrypted_query_param='+encodeURIComponent(param!)+'&filekey='+filekey);
  if(url.origin!==CDN||url.pathname!=='/c2c/upload'||url.username||url.password||url.hash)throw Error('Invalid upload destination');
  const active=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
  const uploadBody=new Uint8Array(ciphertext);
  try{
    const pendingUpload=transport(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:uploadBody,redirect:'error',credentials:'omit',signal:active});
    void pendingUpload.then(response=>{if(active.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
    const response=await abortable(pendingUpload,active);
    try{
      active.throwIfAborted();
      const downloadParam=response.headers.get('x-encrypted-param');
      if(response.status!==200||response.redirected||response.url&&new URL(response.url).href!==url.href||!downloadParam||downloadParam.length>8192)throw Error('Upload not accepted');
      return downloadParam;
    }finally{void response.body?.cancel().catch(()=>{});}
  }finally{uploadBody.fill(0);}
}
/**
 * Official SILK v3 in the wire format the reviewed probe documents: 24 kHz mono 16-bit,
 * `encode_type: 6`, `media_type: 4`. Anything the encoder cannot express honestly
 * (wrong rate, wrong layout, oversize clip) is refused so the caller can fall back.
 */
export async function encodeNativeVoice(wav:Uint8Array):Promise<{silk:Uint8Array;playtime:number}>{
  const {sampleRate,channels,bits,data}=inspectPcmWav(wav);
  if(sampleRate!==24000||channels!==1||bits!==16)throw Error('Native voice needs 24 kHz mono 16-bit PCM');
  const seconds=data.length/(sampleRate*channels*2);
  if(seconds>60)throw Error('Native voice clip is longer than one minute');
  // Pad to whole 960-byte frames, exactly as the reviewed probe does, so the encoder
  // cannot truncate the last frame of speech.
  const pcm=new Uint8Array(Math.ceil(data.length/960)*960);
  try{
    pcm.set(data);
    const silk=(await encodeSilk(pcm,24000)).data;
    // The reviewed wire format starts with 0x02 and carries the header from offset 1.
    if(silk.length<=10||silk[0]!==2||Buffer.from(silk.subarray(1,10)).toString('ascii')!==SILK_HEADER)throw Error('Encoder did not produce SILK v3');
    if(silk.length>MAX_SILK)throw Error('Native voice exceeds the wire limit');
    return {silk,playtime:Math.max(1,Math.round(pcm.length/48))};
  }finally{pcm.fill(0);}
}
/** The reviewed FILE wire. Used on its own, and as the fallback when no bubble can be built. */
export function wechatAudioFileSender(media:MemoryMediaStore,tts:TtsProvider,api:WeChatApi,transport:typeof fetch=fetch){
  return async(auth:WeChatCredentials,context:string,text:string,clientId:string,signal:AbortSignal):Promise<void>=>{
    const scope=scopeFor(auth);let wav:Uint8Array|undefined,clip:Sealed|undefined;
    try{
      wav=await synthesizeWav(media,tts,scope,text,context,signal);
      clip=seal(wav);wav.fill(0);
      const downloadParam=await uploadClip(api,auth,transport,clip,3,signal);
      await api.sendAudioFile(auth,context,{downloadParam,aesHex:clip.key.toString('hex'),size:clip.size},clientId,signal);
      signal.throwIfAborted();
    }catch{signal.throwIfAborted();throw Error('WeChat audio file delivery unconfirmed');}
    finally{wav?.fill(0);clip?.ciphertext.fill(0);clip?.key.fill(0);await media.releaseScope(scope);}
  };
}
/**
 * Native VOICE bubble first, FILE copy second, from a single synthesis.
 *
 * The bubble is what a WeChat user can tap and play, so it is attempted first; when it
 * cannot be built or sent the reviewed file wire still carries the same recording. The
 * caller already sent the readable text, so a bubble that silently fails to render can
 * cost the audio but never the answer itself.
 */
export function wechatVoiceReplySender(media:MemoryMediaStore,tts:TtsProvider,api:WeChatApi,transport:typeof fetch=fetch){
  return async(auth:WeChatCredentials,context:string,text:string,clientId:string,signal:AbortSignal):Promise<void>=>{
    const scope=scopeFor(auth);let wav:Uint8Array|undefined,silk:Uint8Array|undefined,clip:Sealed|undefined;
    const leave=async()=>{wav?.fill(0);silk?.fill(0);clip?.ciphertext.fill(0);clip?.key.fill(0);await media.releaseScope(scope);};
    try{
      wav=await synthesizeWav(media,tts,scope,text,context,signal);
      let bubble=false;
      try{
        const native=await encodeNativeVoice(wav);silk=native.silk;
        clip=seal(silk);
        const downloadParam=await uploadClip(api,auth,transport,clip,4,signal);
        await api.sendVoiceMessage(auth,context,{downloadParam,aesHex:clip.key.toString('hex'),playtime:native.playtime},clientId,signal);
        signal.throwIfAborted();bubble=true;
      }catch{signal.throwIfAborted();}
      if(bubble)return;
      clip?.ciphertext.fill(0);clip?.key.fill(0);clip=seal(wav);
      const downloadParam=await uploadClip(api,auth,transport,clip,3,signal);
      await api.sendAudioFile(auth,context,{downloadParam,aesHex:clip.key.toString('hex'),size:clip.size},clientId,signal);
      signal.throwIfAborted();
    }catch{signal.throwIfAborted();throw Error('WeChat voice delivery unconfirmed');}
    finally{await leave();}
  };
}
