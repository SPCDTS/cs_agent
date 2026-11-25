import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_PAGE_HTML } from '../src/admin/app.generated.ts';
import { bundleModule, mountDom } from './browser-harness.mjs';

test('Cua 工具展示目录只读、固定读写执行以及可选只读桌面/后台查询标记',async () => {
  const page = mountDom(ADMIN_PAGE_HTML,{token:'synthetic-admin'}), ui = await bundleModule('browser/mcp-servers.ts');
  const tools = {allow:[],readOnly:[]};
  ui.mcpServers.rows = [{server:{id:'cua',enabled:true,tools,resourceAllow:[],credential:{kind:'managed'},
    transport:{kind:'reverse-websocket',url:'https://example.test/mcp/reverse/cua'}},revision:'initial',credentialSet:true,
    discovered:[
      {name:'list_spaces',description:'设备目录'},
      {name:'list_tools',description:'Driver 目录'},
      {name:'space_bash',description:'短命令'},
      {name:'space_job',description:'后台任务'},
      {name:'space_write',description:'写文件'},
      {name:'call_tool',description:'桌面操作'},
    ]}];
  const checkbox = name => page.document.querySelector('input[data-readonly="'+name+'"]');
  ui.mcpServerRender('cua');
  for (const name of ['list_spaces','list_tools']) {
    assert.equal(checkbox(name).parentElement.textContent,'目录只读');
    assert.equal(checkbox(name).checked,true);
    assert.equal(checkbox(name).disabled,true);
  }
  for (const name of ['space_bash','space_write']) {
    assert.equal(checkbox(name).parentElement.textContent,'读写执行');
    assert.equal(checkbox(name).checked,false);
    assert.equal(checkbox(name).disabled,true);
  }
  assert.equal(checkbox('call_tool').parentElement.textContent,'仅允许只读桌面查询');
  assert.equal(checkbox('call_tool').disabled,false);
  assert.equal(checkbox('call_tool').checked,false);
  assert.equal(checkbox('space_job').parentElement.textContent,'仅允许查询后台任务');
  assert.equal(checkbox('space_job').disabled,false);
  assert.equal(checkbox('space_job').checked,false);

  tools.allow = ['list_spaces','list_tools','space_bash','space_job','space_write','call_tool'];
  tools.readOnly = ['list_spaces','list_tools','call_tool','space_job'];
  ui.mcpServerRender('cua');
  assert.equal(checkbox('call_tool').checked,true);
  assert.equal(checkbox('space_job').checked,true);
  tools.readOnly = ['list_spaces','list_tools'];
  ui.mcpServerRender('cua');
  assert.equal(checkbox('call_tool').checked,false);
  assert.equal(checkbox('space_job').checked,false);
});

test('首次启用提交桥令牌一次并区分等待连接与设备可用',async t => {
  const page = mountDom(ADMIN_PAGE_HTML,{token:'synthetic-admin'}), ui = await bundleModule('browser/cua-grants.ts');
  const token = 'test-bridge-token-'.repeat(3);
  const view = {setup:'new',configured:false,enabled:false,online:false,available:false,
    revision:'0',devices:[],threads:[],grants:[],bridgeUrl:'wss://bridge.test/mcp/reverse/cua'};
  let saves = 0;
  t.mock.method(globalThis,'fetch',async (path,init) => {
    if (path === '/admin/cua/devices') return Response.json(view);
    assert.equal(path,'/admin/cua/setup'); assert.equal(init.method,'PUT');
    assert.deepEqual(JSON.parse(init.body),{token});
    saves++; Object.assign(view,{setup:'pending',configured:true});
    return Response.json({saved:true});
  });
  ui.initCuaGrants(); await ui.loadCuaGrants();
  const form = page.document.getElementById('cua-setup-form'), input = form.querySelector('input');
  assert.equal(form.hidden,false);
  input.value = token;
  form.dispatchEvent(new page.window.Event('submit',{cancelable:true}));
  form.dispatchEvent(new page.window.Event('submit',{cancelable:true}));
  await page.settle();
  assert.equal(saves,1); assert.equal(input.value,''); assert.equal(form.hidden,true);
  assert.match(page.document.getElementById('cua-grant-status').textContent,/等待 VPS 连接/);
  assert.ok([...page.storage.values()].every(value => !value.includes(token)));
  Object.assign(view,{setup:'managed',enabled:true,online:true,available:true});
  await ui.loadCuaGrants();
  assert.match(page.document.getElementById('cua-grant-status').textContent,/尚未列出设备/);
});

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

test('每台设备可单独改名和恢复主机名，操作保留其他行待保存的分配',async t => {
  const page = mountDom(ADMIN_PAGE_HTML,{token:'test-admin'}), ui = await bundleModule('browser/cua-grants.ts');
  const a = 'direct:host-a:8080', b = 'direct:host-b:8080', scope = 'group:12345';
  const directory = {configured:true,enabled:true,online:true,available:true,revision:'initial',
    grants:[{scope,spaces:[a]}],threads:[{key:scope}],devices:[
      {id:a,name:'work-mac',os:'macos',status:'running',scopes:[scope]},
      {id:b,name:'win-vm',defaultName:'win-vm',os:'windows',status:'running',scopes:[]},
    ]};
  const writes = [];
  let conflict = false;
  t.mock.method(globalThis,'fetch',async (path,init) => {
    if (path === '/admin/cua/devices') return Response.json(directory);
    assert.equal(init.method,'PUT');
    const body = JSON.parse(init.body);
    writes.push({path,body});
    if (path === '/admin/cua/name') {
      if (conflict) return Response.json({error:'conflict'},{status:409});
      return Response.json({name:body.name});
    }
    assert.equal(path,'/admin/cua/grants');
    directory.grants = [{scope,spaces:body.spaces}]; directory.revision = 'updated';
    return Response.json({revision:directory.revision,grants:directory.grants});
  });
  ui.initCuaGrants();
  await ui.loadCuaGrants();
  const byId = id => page.document.getElementById(id);
  const select = byId('cua-grant-scope'), list = byId('cua-grant-devices');
  select.value = scope;
  select.dispatchEvent(new page.window.Event('change'));
  const [mac,vm] = [...list.children];
  const action = (row,text) => [...row.querySelectorAll('button')].find(node => node.textContent === text);
  const edit = () => page.click(action(mac,'改名'));
  const input = () => mac.querySelector('input[type=text]');
  const checked = row => row.querySelector('input[type=checkbox]');
  checked(vm).checked = true;
  checked(mac).checked = false;
  assert.equal(action(mac,'改名').closest('label'),null);
  await edit(); input().value = '放弃的名称'; await page.click(action(mac,'取消'));
  assert.equal(mac.querySelector('strong').textContent,'work-mac');
  await edit(); input().value = '名'.repeat(65); await page.click(action(mac,'保存名称'));
  assert.deepEqual(writes,[]);
  input().value = ' 客户端一号 '; await page.click(action(mac,'保存名称'));
  assert.deepEqual(writes,[{path:'/admin/cua/name',body:{space:a,name:'客户端一号',expectedName:'',expectedRevision:'initial'}}]);
  assert.equal(mac.querySelector('strong').textContent,'客户端一号');
  assert.equal(vm.querySelector('strong').textContent,'win-vm');
  assert.equal(checked(vm).checked,true); assert.equal(checked(mac).checked,false);
  await edit(); assert.equal(input().value,'客户端一号');
  input().value = '另一个名称'; conflict = true;
  await page.click(action(mac,'保存名称'));
  assert.equal(input().value,'另一个名称'); assert.equal(mac.querySelector('strong').textContent,'客户端一号');
  conflict = false;
  await page.click(action(mac,'恢复默认名称')); assert.equal(input().value,''); await page.click(action(mac,'保存名称'));
  assert.equal(mac.querySelector('strong').textContent,'work-mac');
  assert.deepEqual(writes.at(-1),{path:'/admin/cua/name',body:{space:a,name:'',expectedName:'客户端一号',expectedRevision:'initial'}});
  assert.equal(checked(vm).checked,true); assert.equal(checked(mac).checked,false);
  await page.click(byId('cua-grant-save'));
  assert.deepEqual(writes.filter(write => write.path === '/admin/cua/grants'),[
    {path:'/admin/cua/grants',body:{scope,spaces:[b],expectedRevision:'initial'}},
  ]);
});

test('目录仅含不支持的设备时说明原因，混合目录仍可选择有效设备并显示中文保存错误',async t => {
  const page = mountDom(ADMIN_PAGE_HTML,{token:'test-admin'}), ui = await bundleModule('browser/cua-grants.ts');
  const scope = 'group:12345', device = {id:'relay:device01',name:'测试机',os:'macos',status:'running',scopes:[]};
  const directory = {configured:true,enabled:true,online:true,available:true,revision:'initial',
    grants:[],threads:[{key:scope}],devices:[{...device,id:'local:unsupported'}]};
  let rejection;
  t.mock.method(globalThis,'fetch',async (path,init) => {
    if (path === '/admin/cua/devices') return Response.json(directory);
    assert.equal(path,'/admin/cua/grants');
    assert.deepEqual(JSON.parse(init.body).spaces,[device.id]);
    return Response.json({error:rejection.code},{status:rejection.status});
  });
  ui.initCuaGrants(); await ui.loadCuaGrants();
  const byId = id => page.document.getElementById(id);
  const select = byId('cua-grant-scope'), list = byId('cua-grant-devices'), status = byId('cua-grant-status');
  select.value = scope; select.dispatchEvent(new page.window.Event('change'));
  assert.match(status.textContent,/设备 ID 暂不支持分配/);
  assert.equal(list.childElementCount,0);
  assert.ok(byId('cua-grant-save').disabled);

  directory.devices.push(device); await ui.loadCuaGrants();
  assert.equal(list.childElementCount,1);
  assert.equal(status.textContent,'');
  for (rejection of [{code:'cua_directory_unavailable',status:503,message:/无法读取 Cua 设备目录/},
    {code:'unknown_space',status:400,message:/设备已不在当前目录/}]) {
    list.querySelector('input[type=checkbox]').checked = true;
    await page.click(byId('cua-grant-save'));
    assert.match(byId('status').textContent,rejection.message);
  }
});

test('名称写入期间手动和自动刷新合并等待，保留待保存的勾选',async t => {
  const page = mountDom(ADMIN_PAGE_HTML,{token:'first-user'}), ui = await bundleModule('browser/cua-grants.ts');
  const scope = 'group:12345', space = 'relay:device01';
  const directory = {configured:true,enabled:true,online:true,available:true,revision:'v1',threads:[{key:scope}],
    grants:[],devices:[{id:space,name:'work-mac',defaultName:'work-mac',os:'macos',status:'running',scopes:[]}]};
  const writes = [], gets = [], gate = Promise.withResolvers();
  t.mock.method(globalThis,'fetch',async (path,init) => {
    if (path === '/admin/cua/devices') { gets.push(directory.devices[0].name); return Response.json(directory); }
    writes.push(path);
    assert.equal(path,'/admin/cua/name'); await gate.promise;
    const {name} = JSON.parse(init.body);
    directory.devices[0].alias = directory.devices[0].name = name;
    return Response.json({name});
  });
  const byId = id => page.document.getElementById(id), list = byId('cua-grant-devices');
  const select = byId('cua-grant-scope'), reload = byId('cua-grant-reload'), save = byId('cua-grant-save');
  ui.initCuaGrants(); await ui.loadCuaGrants();
  select.value = scope; select.dispatchEvent(new page.window.Event('change'));
  list.querySelector('input[type=checkbox]').checked = true;
  await page.click(list.querySelector('button'));
  list.querySelector('input[type=text]').value = '机房 Mac';
  await page.click([...list.querySelectorAll('button')].find(node => node.textContent === '保存名称'));
  assert.ok(reload.disabled && save.disabled);
  await page.click(save); await page.click(reload);
  const automatic = ui.loadCuaGrants();
  await page.settle();
  assert.deepEqual(gets,['work-mac']);
  assert.deepEqual(writes,['/admin/cua/name']);
  gate.resolve(); await automatic;
  assert.deepEqual(gets,['work-mac','机房 Mac']);
  assert.equal(list.querySelector('strong').textContent,'机房 Mac');
  assert.equal(select.value,scope); assert.ok(list.querySelector('input[type=checkbox]').checked);
  assert.ok(!reload.disabled && !save.disabled);
});

test('新登录和登出清理不等待旧登录的改名请求',async t => {
  const page = mountDom(ADMIN_PAGE_HTML,{token:'first-user'}), ui = await bundleModule('browser/cua-grants.ts');
  const fresh = name => ({configured:true,enabled:true,online:true,available:true,revision:'v1',threads:[],
    grants:[],devices:[{id:'relay:device02',name,os:'macos',status:'running',scopes:[]}]});
  const gate = Promise.withResolvers();
  t.mock.method(globalThis,'fetch',async (path,init) => {
    if (path === '/admin/cua/devices') return Response.json(fresh(init.headers.Authorization === 'Bearer first-user' ? '旧登录' : '新登录'));
    assert.equal(path,'/admin/cua/name'); await gate.promise; return Response.json({name:'过期响应'});
  });
  ui.initCuaGrants(); await ui.loadCuaGrants();
  const list = page.document.getElementById('cua-grant-devices');
  await page.click(list.querySelector('button'));
  list.querySelector('input[type=text]').value = '过期响应';
  await page.click([...list.querySelectorAll('button')].find(node => node.textContent === '保存名称'));
  const stale = ui.loadCuaGrants();
  page.storage.delete('cs-agent-admin-token'); await ui.loadCuaGrants();
  assert.equal(list.children.length,0);
  page.storage.set('cs-agent-admin-token','second-user'); await ui.loadCuaGrants();
  assert.equal(list.querySelector('strong').textContent,'新登录');
  gate.resolve(); await stale; await page.settle();
  assert.equal(list.querySelector('strong').textContent,'新登录');
});
