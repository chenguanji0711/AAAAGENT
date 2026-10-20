import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('native asset planner rejects invalid paths and serves exact synthetic ranges', {skip:process.platform!=='darwin'?'Requires the macOS Swift toolchain':false}, async () => {
  const prefix=join(tmpdir(),'aaaagent-native-assets-'),temporary=await mkdtemp(prefix);
  try {
    const binary=join(temporary,'asset-test');
    const source=name=>fileURLToPath(new URL(name,import.meta.url));
    const compiled=spawnSync('swiftc',[source('../native/asset-response.swift'),source('./asset-response-test.swift'),'-o',binary],{encoding:'utf8',timeout:60000});
    assert.equal(compiled.status,0,compiled.stderr);
    const result=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/Native synthetic asset ranges/);
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(prefix)));
    await rm(temporary,{recursive:true,force:true});
  }
});
test('Swift desktop host compiles with the streaming asset handler without launching it', {skip:process.platform!=='darwin'?'Requires macOS AppKit and WebKit':false}, async () => {
  const prefix=join(tmpdir(),'aaaagent-native-compile-'),temporary=await mkdtemp(prefix);
  try {
    const source=name=>fileURLToPath(new URL('../native/'+name,import.meta.url));
    const result=spawnSync('swiftc',['-framework','AppKit','-framework','WebKit',source('asset-response.swift'),source('display-layout.swift'),source('motion-preferences.swift'),source('main.swift'),'-o',join(temporary,'DesktopPet')],{encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stderr);
  } finally {
    assert.ok(resolve(temporary).startsWith(resolve(prefix)));
    await rm(temporary,{recursive:true,force:true});
  }
});
