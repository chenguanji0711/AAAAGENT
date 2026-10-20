/** Decode a possibly incomplete JSON string without exposing half an escape/surrogate. */
function quoted(source:string,start:number):{text:string;end:number;complete:boolean}|null {
 let text='';
 for(let i=start+1;i<source.length;i++){
  const c=source[i]!;
  if(c==='"')return{text,end:i+1,complete:true};
  if(c==='\\'){
   const escape=source[++i];if(escape===undefined)break;
   if(escape==='u'){
    const hex=source.slice(i+1,i+5);if(hex.length<4)break;
    if(!/^[0-9a-f]{4}$/i.test(hex))return null;
    text+=String.fromCharCode(parseInt(hex,16));i+=4;
   } else {
    const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
    if(!(escape in escapes))return null;text+=escapes[escape];
   }
  }else{if(c<' ')return null;text+=c;}
 }
 if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
 return{text,end:source.length,complete:false};
}
/** Read only a top-level text string; nested metadata/reasoning never enters the HUD. */
export function partialDialogueText(raw:string):string|undefined {
 const source=raw.trimStart().replace(/^```(?:json)?\s*\n/,'');
 if(source[0]!=='{')return;
 let depth=0;
 for(let i=0;i<source.length;i++){
  const c=source[i];
  if(c==='{'||c==='[')depth++;
  else if(c==='}'||c===']')depth--;
  else if(c==='"'){
   const key=quoted(source,i);if(!key?.complete)return;
   let next=key.end;while(/\s/.test(source[next]??'')&&next<source.length)next++;
   if(depth===1&&key.text==='text'&&source[next]===':'){
    next++;while(/\s/.test(source[next]??'')&&next<source.length)next++;
    return source[next]==='"'?quoted(source,next)?.text:undefined;
   }
   i=key.end-1;
  }
 }
}
