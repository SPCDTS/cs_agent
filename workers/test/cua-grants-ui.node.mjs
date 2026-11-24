import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_PAGE_HTML } from '../src/admin/app.generated.ts';
import { bundleModule, mountDom } from './browser-harness.mjs';

test('设备分配界面区分群与私聊，节点离线时仍可清空已有分配',async t => {
  const page = mountDom(ADMIN_PAGE_HTML,{token:'synthetic-admin'});
  const ui = await bundleModule('browser/cua-grants.ts');
  const scope = 'private:123456', device = 'direct:desktop.test:8080';
  const directory = {configured:true,enabled:true,online:false,available:false,devices:[],revision:'initial',
    grants:[{scope,spaces:[device]}],threads:[{key:'group:123456',name:'群 A'},{key:scope,name:'私聊 A'}]};
  const writes = [];
  t.mock.method(globalThis,'fetch',async (path,init) => {
    if (path === '/admin/cua/devices') return Response.json(directory);
    assert.equal(path,'/admin/cua/grants');
    writes.push(JSON.parse(init.body));
    directory.grants = []; directory.revision = 'saved';
    return Response.json({revision:directory.revision,grants:directory.grants});
  });
  ui.initCuaGrants();
  await ui.loadCuaGrants();
  const byId = id => page.document.getElementById(id), select = byId('cua-grant-scope');
  assert.deepEqual([...select.options].map(option => option.value),['','group:123456',scope]);
  select.value = scope;
  select.dispatchEvent(new page.window.Event('change'));
  assert.match(byId('cua-grant-status').textContent,/离线/);
  const checkbox = byId('cua-grant-devices').querySelector('input');
  assert.equal(checkbox.value,device);
  assert.ok(checkbox.checked);
  checkbox.checked = false;
  await page.click(byId('cua-grant-save'));
  assert.deepEqual(writes,[{scope,spaces:[],expectedRevision:'initial'}]);
  assert.equal(byId('cua-grant-devices').querySelector('input'),null);
});
