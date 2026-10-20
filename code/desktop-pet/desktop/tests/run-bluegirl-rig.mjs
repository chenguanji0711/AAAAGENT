import {build} from 'esbuild';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {modelPlugins} from '../model-build-options.mjs';
const out=resolve('desktop/.cache');await mkdir(out,{recursive:true});
const dir=await mkdtemp(join(out,'bluegirl-rig-'));
try{
  const entry=join(dir,'test.mjs');
  await build({entryPoints:['desktop/tests/live2d-bluegirl.test.mjs'],bundle:true,platform:'node',format:'esm',outfile:entry,plugins:modelPlugins});
  const run=spawnSync(process.execPath,['--test',entry],{stdio:'inherit'});process.exitCode=run.status??1;
}finally{await rm(dir,{recursive:true,force:true});}
