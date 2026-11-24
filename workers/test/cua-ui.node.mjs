import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PAGE_HTML } from '../src/admin/app.generated.ts';
import { bundleModule, mountDom } from './browser-harness.mjs';

test('Cua 设备卡使用显示名，首次配置预选唯一的聚合服务', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, {token:'synthetic-admin'});
  const element = id => page.document.getElementById(id);
  t.mock.method(globalThis, 'fetch', async path => {
    if (path === '/admin/mcp/servers') return Response.json({servers:[]});
    assert.equal(path, '/admin/cua/spaces');
    return Response.json({configured:true,spaces:[
      {id:'relay:sample-vm',name:'开发机',os:'windows',status:'ready',features:[],services:['driver']},
    ]});
  });
  const { initCua } = await bundleModule('./browser/cua.ts');
  initCua();
  await page.click(element('cua-refresh'));
  assert.equal(element('cua-list').querySelector('strong')?.textContent, '开发机');
  assert.match(element('cua-list').textContent, /可用.*relay:sample-vm/);
  await page.click(element('cua-login'));
  assert.equal(element('mcp-server-id').value, 'cua');
  assert.equal(element('mcp-server-auth').value, 'token');
  assert.equal(element('mcp-server-editor').open, true);
});
