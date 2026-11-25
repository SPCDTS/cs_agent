import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PairingSlots, pairingCaddy } from '../src/cua-pairing.ts';

test('同一张配对码绑定首台设备，恢复、重试、退役和耗尽保持原端口身份',t => {
  const root = mkdtempSync(join(tmpdir(),'pair-test-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const make = () => new PairingSlots(root,'wss://relay.example.test');
  const store = make(), client = 'a'.repeat(64), other = 'b'.repeat(64);
  const claim = {action:'claim',invitation:randomUUID(),client};
  assert.equal(store.request({action:'ready'}).status,'ready');
  const issued = store.request(claim);
  assert.ok('registration' in issued && issued.registration && issued.deviceToken);
  assert.notEqual(issued.registration,issued.deviceToken);
  if (process.platform !== 'win32') assert.equal(statSync(join(root,'paired-1','registration.token')).mode & 0o777,0o600);
  assert.deepEqual(make().request(claim),issued);
  assert.deepEqual(store.request({...claim,client:other}),{status:'used'});
  writeFileSync(join(root,'paired-1','retired'),'');
  assert.equal(store.request(claim).status,'used');
  const dirCaddy = pairingCaddy('directory');
  for (let i=2; i<=8; i++) {
    const result = store.request({...claim,invitation:randomUUID(),client:i.toString().repeat(64)});
    assert.equal(result.machineId,'paired-'+i);
    assert.match(pairingCaddy('join'),new RegExp('import join paired-'+i+' '+(19100+i)));
    assert.match(dirCaddy,new RegExp('127[.]0[.]0[.]1:'+(19200+i)));
  }
  for (let i=1; i<=8; i++) {
    assert.match(dirCaddy,new RegExp(`http://127\\.0\\.0\\.1:${19200+i} \\{\\n import device-execution paired-${i} ${19100+i}\\n import directory paired-${i} ${19100+i}\\n\\}`));
  }
  assert.equal(store.request({action:'ready'}).status,'full');
  assert.equal(store.request({...claim,invitation:randomUUID()}).status,'full');
  const expanded = new PairingSlots(root,'wss://relay.example.test','9');
  assert.equal(expanded.request({...claim,invitation:randomUUID()}).machineId,'paired-9');
  assert.throws(() => pairingCaddy('directory','101'));
});

for (const shell of ['powershell.exe','pwsh.exe']) {
  test(shell+' 接入、私有目录及无配对码重连',{skip:process.platform!=='win32'},async t => {
    const {execFileSync} = await import('node:child_process');
    const {fileURLToPath} = await import('node:url');
    const dir = mkdtempSync(join(tmpdir(),'cua-windows-'));
    t.after(() => rmSync(dir,{recursive:true,force:true}));
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    execFileSync(shell,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./fixtures/cua-pair-windows.ps1',import.meta.url)),
      dir,fileURLToPath(new URL('../../workers/device/join.ps1',import.meta.url)),process.execPath],{timeout:45_000,env});
  });
}
