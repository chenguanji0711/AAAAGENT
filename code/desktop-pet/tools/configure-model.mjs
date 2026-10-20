// Rebuild a catalog binding for a model the user has already installed locally.
//
// Safety contract, in order of importance:
//   * Never downloads, copies, decrypts, alters or removes a watermark from any model.
//   * Never writes into the model itself: only `presets.json` is created, and only when it
//     is absent (or when --replace is passed, which first renames the existing catalog).
//   * Never touches `assets/local-model/dsh-pet/` (the video character) or any other asset.
//   * Every referenced path is validated and must resolve inside the model directory.
//
// The generated catalog is deliberately conservative: it only advertises what the manifest
// actually proves exists, maps nothing onto the semantic emotion slots, and leaves every
// expression and motion disabled for manual use until the owner has looked at it.
import {readFile,writeFile,rename,realpath,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectModelReferences,isSafeModelPath} from '../desktop/model-references.mjs';

const code=fileURLToPath(new URL('..',import.meta.url));
const argv=process.argv.slice(2);
const flag=name=>argv.includes(name);
const option=(name,fallback)=>{const i=argv.indexOf(name);return i>=0&&argv[i+1]&&!argv[i+1].startsWith('--')?argv[i+1]:fallback;};
const directory=option('--dir','desktop/assets/local-model');
const modelId=option('--id','local-model');
if(!/^[a-zA-Z0-9_-]{1,100}$/.test(modelId))throw Error('--id must be 1-100 characters of letters, digits, "_" or "-"');

const base=await realpath(resolve(code,directory));
const manifestPath=resolve(base,'pet.model3.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const refs=collectModelReferences(manifest);

/** Every reference the descriptor names, validated before anything is read. */
async function resolveReference(path){
  if(!isSafeModelPath(path))throw Error(`Unsafe model-relative path: ${path}`);
  const actual=await realpath(resolve(base,path));
  const rel=relative(base,actual);
  if(rel.startsWith('..')||isAbsolute(rel))throw Error(`Model reference escapes its directory: ${path}`);
  return actual;
}
const referenced=[...new Set([...refs.required,...refs.optional])].sort();
for(const path of referenced)await resolveReference(path);

// The binding must stay byte-for-byte identical to the one the renderer and the management
// side compute, or a valid catalog would be rejected as stale. Same set, same order.
const fingerprintPaths=[...new Set(['pet.model3.json',...refs.fingerprint].filter(Boolean))].sort();
let binding='';
for(const path of fingerprintPaths)binding+=path+'\0'+createHash('sha256').update(await readFile(await resolveReference(path))).digest('hex')+'\n';
const modelFingerprint=createHash('sha256').update(binding).digest('hex');

const template=JSON.parse(await readFile(resolve(code,'config/presets.example.json'),'utf8'));
const items=[];
if(refs.motions.Idle?.[0]?.File)items.push({id:'motion-idle-0',label:'自然待机',category:'idle',source:'model-motion',availability:'automatic',defaultEnabled:true,previewable:true});
// Procedural layers need no model file: the renderer skips a parameter the rig does not have.
for(const [id,label] of [['proc-head','视线与头部互动'],['proc-body','身体轻摆'],['proc-blink','自然眨眼'],['proc-breath','呼吸'],['proc-work-focus','专注工作']])
  items.push({id,label,category:'idle',source:'procedural',availability:'automatic',defaultEnabled:true,previewable:true});
// Expressions and motions are advertised for manual use only. Nothing is mapped onto the
// six semantic emotion slots here: that needs a human looking at the rig first.
const used=new Set(items.map(item=>item.id));
refs.expressions.forEach((expression,index)=>{
  let id=`expression-${String(index+1).padStart(2,'0')}`;while(used.has(id))id+='x';used.add(id);
  const name=typeof expression.Name==='string'&&expression.Name.trim()?expression.Name:expression.File;
  items.push({id,label:name.slice(0,100),category:'expression',source:'model-expression',availability:'manual',defaultEnabled:false,previewable:true,expressionName:name});
});
for(const [group,motions] of Object.entries(refs.motions))motions.forEach((motion,index)=>{
  if(group==='Idle'&&index===0)return;
  let id=`motion-${group.toLowerCase()}-${index}`.replace(/[^a-zA-Z0-9_-]/g,'-');while(used.has(id))id+='x';used.add(id);
  const label=(typeof motion.Name==='string'&&motion.Name.trim()?motion.Name:null)??`${group} ${index+1}`;
  items.push({id,label:label.slice(0,100),category:group==='Idle'?'idle':'pose',source:'model-motion',availability:'manual',defaultEnabled:false,previewable:true,motionGroup:group,motionIndex:index});
});
if(!items.length)items.push({...template.items[0],label:refs.expressions.length||Object.keys(refs.motions).length?'Map your licensed model first':'No expressions or motions found in this model'});
if(items.length>200)throw Error(`This model advertises ${items.length} catalog items; the presentation schema allows 200. Trim the model or split the catalog.`);

const target=resolve(base,'presets.json');
const exists=await access(target).then(()=>true,()=>false);
if(exists&&!flag('--replace'))throw Error('presets.json already exists. Re-run with --replace to keep the current one as a timestamped backup.');
if(exists)await rename(target,`${target}.bak-${new Date().toISOString().replace(/[:.]/g,'-')}`);

await writeFile(target,JSON.stringify({...template,modelId,modelFingerprint,items},null,2)+'\n',{flag:'wx'});
const manual=items.filter(item=>item.availability==='manual').length;
console.log(`Created a disabled catalog for "${modelId}" bound to local model bytes.`);
console.log(`  fingerprint : ${modelFingerprint.slice(0,16)}… over ${fingerprintPaths.length} files`);
console.log(`  required    : ${refs.required.join(', ')}`);
console.log(`  optional    : ${refs.optional.length?refs.optional.join(', '):'(none present)'}`);
console.log(`  items       : ${items.length} (${manual} manual, 0 mapped to emotions)`);
console.log(`  next        : fill desktop/assets/local-model/parameter-map.json, look at every`);
console.log('                expression and motion in the console, then promote the ones you');
console.log('                verified to "automatic" with their emotions. Neutral stays expressionless.');
