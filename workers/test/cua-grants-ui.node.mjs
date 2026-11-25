import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_PAGE_HTML } from '../src/admin/app.generated.ts';
import { bundleModule, mountDom } from './browser-harness.mjs';

function toggleCheckbox(page, checkbox, next) {
  checkbox.checked = next;
  checkbox.dispatchEvent(new page.window.Event('change'));
}

function cardBySpace(page, spaceId) {
  return page.document.querySelector(`[data-space="${spaceId}"]`);
}

function buttonWithText(root, text) {
  return [...root.querySelectorAll('button')].find(node => node.textContent === text);
}

test('Cua 工具展示目录只读、固定读写执行以及可选只读桌面/后台查询标记', async () => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'synthetic-admin' }), ui = await bundleModule('browser/mcp-servers.ts');
  const tools = { allow: [], readOnly: [] };
  ui.mcpServers.rows = [{
    server: {
      id: 'cua', enabled: true, tools, resourceAllow: [], credential: { kind: 'managed' },
      transport: { kind: 'reverse-websocket', url: 'https://example.test/mcp/reverse/cua' },
    },
    revision: 'initial', credentialSet: true,
    discovered: [
      { name: 'list_spaces', description: '设备目录' },
      { name: 'list_tools', description: 'Driver 目录' },
      { name: 'space_bash', description: '短命令' },
      { name: 'space_job', description: '后台任务' },
      { name: 'space_write', description: '写文件' },
      { name: 'call_tool', description: '桌面操作' },
    ],
  }];
  const checkbox = name => page.document.querySelector('input[data-readonly="' + name + '"]');
  ui.mcpServerRender('cua');
  for (const name of ['list_spaces', 'list_tools']) {
    assert.equal(checkbox(name).parentElement.textContent, '目录只读');
    assert.equal(checkbox(name).checked, true);
    assert.equal(checkbox(name).disabled, true);
  }
  for (const name of ['space_bash', 'space_write']) {
    assert.equal(checkbox(name).parentElement.textContent, '读写执行');
    assert.equal(checkbox(name).checked, false);
    assert.equal(checkbox(name).disabled, true);
  }
  assert.equal(checkbox('call_tool').parentElement.textContent, '仅允许只读桌面查询');
  assert.equal(checkbox('call_tool').disabled, false);
  assert.equal(checkbox('call_tool').checked, false);
  assert.equal(checkbox('space_job').parentElement.textContent, '仅允许查询后台任务');
  assert.equal(checkbox('space_job').disabled, false);
  assert.equal(checkbox('space_job').checked, false);

  tools.allow = ['list_spaces', 'list_tools', 'space_bash', 'space_job', 'space_write', 'call_tool'];
  tools.readOnly = ['list_spaces', 'list_tools', 'call_tool', 'space_job'];
  ui.mcpServerRender('cua');
  assert.equal(checkbox('call_tool').checked, true);
  assert.equal(checkbox('space_job').checked, true);
  tools.readOnly = ['list_spaces', 'list_tools'];
  ui.mcpServerRender('cua');
  assert.equal(checkbox('call_tool').checked, false);
  assert.equal(checkbox('space_job').checked, false);
});

test('首次启用提交桥令牌一次并展示 VPS Relay 状态变化、桥地址与能力标签', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'synthetic-admin' }), ui = await bundleModule('browser/cua-grants.ts');
  const token = 'test-bridge-token-'.repeat(3);
  const view = {
    setup: 'new', configured: false, enabled: false, online: false, available: false, tools: [],
    revision: '0', devices: [], threads: [], grants: [], bridgeUrl: 'wss://bridge.test/mcp/reverse/cua',
  };
  let saves = 0;
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/admin/cua/devices') return Response.json(view);
    assert.equal(path, '/admin/cua/setup'); assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(init.body), { token });
    saves++; Object.assign(view, { setup: 'pending', configured: true });
    return Response.json({ saved: true });
  });
  const byId = id => page.document.getElementById(id);
  ui.initCuaGrants(); await ui.loadCuaGrants();
  const form = byId('cua-setup-form'), input = form.querySelector('input');
  assert.equal(form.hidden, false);
  assert.match(byId('cua-relay-pill').textContent, /未配置 VPS Relay/);
  assert.equal(byId('cua-pair-add').disabled, true);
  input.value = token;
  form.dispatchEvent(new page.window.Event('submit', { cancelable: true }));
  form.dispatchEvent(new page.window.Event('submit', { cancelable: true }));
  await page.settle();
  assert.equal(saves, 1); assert.equal(input.value, ''); assert.equal(form.hidden, true);
  assert.match(byId('cua-relay-pill').textContent, /等待 VPS Relay 连接/);
  assert.match(byId('cua-grant-status').textContent, /等待 VPS 连接/);
  assert.ok([...page.storage.values()].every(value => !value.includes(token)));

  Object.assign(view, {
    setup: 'managed', enabled: true, online: true, available: true,
    tools: ['list_spaces', 'space_bash', 'call_tool'],
  });
  await ui.loadCuaGrants();
  assert.equal(byId('cua-relay-pill').textContent, 'VPS Relay 已连接');
  assert.match(byId('cua-bridge-url').textContent, /wss:\/\/bridge\.test\/mcp\/reverse\/cua/);
  assert.equal(byId('cua-relay-tools').hidden, false);
  assert.match(byId('cua-relay-tools').textContent, /Shell 命令/);
  assert.match(byId('cua-grant-status').textContent, /尚未列出设备/);
  assert.equal(byId('cua-pair-add').disabled, false);

  Object.assign(view, { online: false, available: false });
  await ui.loadCuaGrants();
  assert.match(byId('cua-relay-pill').textContent, /离线/);
  assert.equal(byId('cua-pair-add').disabled, true);

  Object.assign(view, { enabled: false });
  await ui.loadCuaGrants();
  assert.match(byId('cua-relay-pill').textContent, /停用/);
});

test('节点离线时仍显示已授权设备卡，锁定未授权会话并可保存撤销', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'synthetic-admin' });
  const ui = await bundleModule('browser/cua-grants.ts');
  const groupScope = 'group:123456', privateScope = 'private:123456', device = 'direct:desktop.test:8080';
  const directory = {
    configured: true, enabled: true, online: false, available: false, devices: [], revision: 'initial',
    grants: [{ scope: privateScope, spaces: [device] }],
    threads: [{ key: groupScope, name: '群 A' }, { key: privateScope, name: '私聊 A' }],
  };
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/admin/cua/devices') return Response.json(directory);
    assert.equal(path, '/admin/cua/device-grants');
    writes.push(JSON.parse(init.body));
    directory.grants = []; directory.revision = 'saved';
    return Response.json({ revision: directory.revision, grants: directory.grants });
  });
  ui.initCuaGrants();
  await ui.loadCuaGrants();
  const byId = id => page.document.getElementById(id);
  assert.match(byId('cua-grant-status').textContent, /离线/);
  assert.match(byId('cua-relay-pill').textContent, /离线/);

  const card = cardBySpace(page, device);
  assert.ok(card, '离线但有已有授权的设备仍应展示设备卡');
  const groupCb = card.querySelector(`input[type=checkbox][value="${groupScope}"]`);
  const privateCb = card.querySelector(`input[type=checkbox][value="${privateScope}"]`);
  assert.equal(groupCb.checked, false);
  assert.equal(groupCb.disabled, true);
  assert.equal(privateCb.checked, true);
  assert.equal(privateCb.disabled, false);
  assert.equal(buttonWithText(card, '全选').disabled, true);

  toggleCheckbox(page, privateCb, false);
  const saveBtn = buttonWithText(cardBySpace(page, device), '保存授权');
  assert.equal(saveBtn.disabled, false);
  await page.click(saveBtn);
  assert.deepEqual(writes, [{ space: device, scopes: [], expectedRevision: 'initial' }]);
  assert.equal(cardBySpace(page, device), null);
});

test('每张设备卡可单独改名与恢复默认名称，且保留同卡与跨卡待保存的勾选', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'test-admin' }), ui = await bundleModule('browser/cua-grants.ts');
  const a = 'direct:host-a:8080', b = 'direct:host-b:8080', scope = 'group:12345', scope2 = 'private:999';
  const directory = {
    configured: true, enabled: true, online: true, available: true, revision: 'initial',
    grants: [{ scope, spaces: [a] }],
    threads: [{ key: scope, name: '测试群' }, { key: scope2, name: '小号私聊' }],
    devices: [
      { id: a, name: 'work-mac', os: 'macos', status: 'running', scopes: [scope] },
      { id: b, name: 'win-vm', defaultName: 'win-vm', os: 'windows', status: 'running', scopes: [] },
    ],
  };
  const writes = [];
  let conflict = false;
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/admin/cua/devices') return Response.json(directory);
    assert.equal(init.method, 'PUT');
    const body = JSON.parse(init.body);
    writes.push({ path, body });
    if (path === '/admin/cua/name') {
      if (conflict) return Response.json({ error: 'conflict' }, { status: 409 });
      return Response.json({ name: body.name });
    }
    assert.equal(path, '/admin/cua/device-grants');
    const saved = directory.devices.find(d => d.id === body.space);
    if (saved) saved.scopes = body.scopes;
    directory.revision = 'updated';
    return Response.json({ revision: directory.revision, grants: [] });
  });
  ui.initCuaGrants();
  await ui.loadCuaGrants();

  const cb = (spaceId, s) => cardBySpace(page, spaceId).querySelector(`input[type=checkbox][value="${s}"]`);
  // 在两张设备卡上同时做出未保存的会话勾选草稿
  toggleCheckbox(page, cb(a, scope2), true);
  toggleCheckbox(page, cb(a, scope), false);
  toggleCheckbox(page, cb(b, scope), true);

  const edit = () => page.click(buttonWithText(cardBySpace(page, a), '改名'));
  const renameInput = () => cardBySpace(page, a).querySelector('input[type=text]');
  await edit(); renameInput().value = '放弃的名称'; await page.click(buttonWithText(cardBySpace(page, a), '取消'));
  assert.equal(cardBySpace(page, a).querySelector('.cua-card-name strong').textContent, 'work-mac');

  await edit(); renameInput().value = '名'.repeat(65); await page.click(buttonWithText(cardBySpace(page, a), '保存名称'));
  assert.deepEqual(writes, []);

  renameInput().value = ' 客户端一号 '; await page.click(buttonWithText(cardBySpace(page, a), '保存名称'));
  assert.deepEqual(writes, [{ path: '/admin/cua/name', body: { space: a, name: '客户端一号', expectedName: '', expectedRevision: 'initial' } }]);
  assert.equal(cardBySpace(page, a).querySelector('.cua-card-name strong').textContent, '客户端一号');
  assert.equal(cardBySpace(page, b).querySelector('.cua-card-name strong').textContent, 'win-vm');
  assert.equal(cb(a, scope2).checked, true); assert.equal(cb(a, scope).checked, false); assert.equal(cb(b, scope).checked, true);

  await edit(); assert.equal(renameInput().value, '客户端一号');
  renameInput().value = '另一个名称'; conflict = true;
  await page.click(buttonWithText(cardBySpace(page, a), '保存名称'));
  assert.equal(renameInput().value, '另一个名称');
  assert.equal(cardBySpace(page, a).querySelector('.cua-card-name strong').textContent, '客户端一号');

  conflict = false;
  await page.click(buttonWithText(cardBySpace(page, a), '恢复默认名称'));
  assert.equal(renameInput().value, '');
  await page.click(buttonWithText(cardBySpace(page, a), '保存名称'));
  assert.equal(cardBySpace(page, a).querySelector('.cua-card-name strong').textContent, 'work-mac');
  assert.deepEqual(writes.at(-1), { path: '/admin/cua/name', body: { space: a, name: '', expectedName: '客户端一号', expectedRevision: 'initial' } });
  assert.equal(cb(a, scope2).checked, true); assert.equal(cb(a, scope).checked, false); assert.equal(cb(b, scope).checked, true);

  await page.click(buttonWithText(cardBySpace(page, a), '保存授权'));
  assert.deepEqual(writes.filter(write => write.path === '/admin/cua/device-grants'), [
    { path: '/admin/cua/device-grants', body: { space: a, scopes: [scope2], expectedRevision: 'initial' } },
  ]);
  // 另一张卡的草稿继续保留
  assert.equal(cb(b, scope).checked, true);
  assert.equal(buttonWithText(cardBySpace(page, b), '保存授权').disabled, false);
});

test('目录仅含不支持的设备时说明原因，混合目录可勾选保存并显示中文错误', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'test-admin' }), ui = await bundleModule('browser/cua-grants.ts');
  const scope = 'group:12345', device = { id: 'relay:device01', name: '测试机', os: 'macos', status: 'running', scopes: [] };
  const directory = {
    configured: true, enabled: true, online: true, available: true, revision: 'initial',
    grants: [], threads: [{ key: scope }], devices: [{ ...device, id: 'local:unsupported' }],
  };
  let rejection;
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/admin/cua/devices') return Response.json(directory);
    assert.equal(path, '/admin/cua/device-grants');
    assert.deepEqual(JSON.parse(init.body), { space: device.id, scopes: [scope], expectedRevision: 'initial' });
    return Response.json({ error: rejection.code }, { status: rejection.status });
  });
  ui.initCuaGrants(); await ui.loadCuaGrants();
  const byId = id => page.document.getElementById(id), list = byId('cua-grant-devices'), status = byId('cua-grant-status');
  assert.match(status.textContent, /设备 ID 暂不支持分配/);
  assert.equal(list.querySelector('[data-space]'), null);

  directory.devices.push(device); await ui.loadCuaGrants();
  const card = cardBySpace(page, device.id);
  assert.ok(card);
  assert.equal(status.textContent, '');
  for (rejection of [
    { code: 'cua_directory_unavailable', status: 503, message: /无法读取 Cua 设备目录/ },
    { code: 'unknown_space', status: 400, message: /设备已不在当前目录/ },
  ]) {
    toggleCheckbox(page, card.querySelector(`input[type=checkbox][value="${scope}"]`), true);
    await page.click(buttonWithText(card, '保存授权'));
    assert.match(byId('status').textContent, rejection.message);
  }
});

test('名称写入期间手动和自动刷新合并等待并保留勾选；新登录和登出清理不等待旧请求', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'first-user' }), ui = await bundleModule('browser/cua-grants.ts');
  const scope = 'group:12345', space = 'relay:device01';
  const directory = {
    configured: true, enabled: true, online: true, available: true, revision: 'v1', threads: [{ key: scope }],
    grants: [], devices: [{ id: space, name: 'work-mac', defaultName: 'work-mac', os: 'macos', status: 'running', scopes: [] }],
  };
  const writes = [], gets = [];
  let gate = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/admin/cua/devices') {
      gets.push(init.headers.Authorization + ':' + directory.devices[0].name);
      return Response.json(directory);
    }
    writes.push(path);
    assert.equal(path, '/admin/cua/name');
    await gate.promise;
    const { name } = JSON.parse(init.body);
    directory.devices[0].alias = directory.devices[0].name = name;
    return Response.json({ name });
  });
  const byId = id => page.document.getElementById(id), reload = byId('cua-grant-reload');
  ui.initCuaGrants(); await ui.loadCuaGrants();
  const card = () => cardBySpace(page, space);
  toggleCheckbox(page, card().querySelector(`input[type=checkbox][value="${scope}"]`), true);
  await page.click(buttonWithText(card(), '改名'));
  card().querySelector('input[type=text]').value = '机房 Mac';
  await page.click(buttonWithText(card(), '保存名称'));
  assert.ok(reload.disabled);
  assert.ok(buttonWithText(card(), '保存授权').disabled);
  await page.click(reload);
  const automatic = ui.loadCuaGrants();
  await page.settle();
  assert.deepEqual(gets, ['Bearer first-user:work-mac']);
  assert.deepEqual(writes, ['/admin/cua/name']);
  gate.resolve(); await automatic;
  assert.deepEqual(gets, ['Bearer first-user:work-mac', 'Bearer first-user:机房 Mac']);
  assert.equal(card().querySelector('.cua-card-name strong').textContent, '机房 Mac');
  assert.ok(card().querySelector(`input[type=checkbox][value="${scope}"]`).checked);
  assert.ok(!reload.disabled && !buttonWithText(card(), '保存授权').disabled);

  // 登出与切换新登录不等待旧登录改名请求
  gate = Promise.withResolvers();
  await page.click(buttonWithText(card(), '改名'));
  card().querySelector('input[type=text]').value = '过期响应';
  await page.click(buttonWithText(card(), '保存名称'));
  const stale = ui.loadCuaGrants();
  page.storage.delete('cs-agent-admin-token');
  await ui.loadCuaGrants();
  assert.equal(byId('cua-grant-devices').querySelector('[data-space]'), null);

  directory.devices[0].alias = undefined;
  directory.devices[0].name = '新登录设备';
  page.storage.set('cs-agent-admin-token', 'second-user');
  await ui.loadCuaGrants();
  assert.equal(card().querySelector('.cua-card-name strong').textContent, '新登录设备');
  gate.resolve(); await stale; await page.settle();
  assert.equal(card().querySelector('.cua-card-name strong').textContent, '新登录设备');
});

test('点击添加设备新增待接入设备卡，支持切换系统、预选会话并在上线后带入新卡', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'synthetic-admin' }), ui = await bundleModule('browser/cua-grants.ts');
  const ticket = 'a'.repeat(180), expires = Date.now() + 60_000;
  const scope = 'group:200000001', newSpace = 'relay:paired-1';
  const directory = {
    configured: true, enabled: true, online: true, available: true, revision: 'test',
    devices: [], grants: [], threads: [{ key: scope, name: '测试群' }],
  };
  const deviceGrantWrites = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (path === '/admin/cua/devices') return Response.json(directory);
    if (path === '/admin/cua/pair') {
      assert.equal(init.method, 'POST');
      return Response.json({ ticket, expires, origin: 'https://agent.example.test' });
    }
    assert.equal(path, '/admin/cua/device-grants');
    const body = JSON.parse(init.body);
    deviceGrantWrites.push(body);
    directory.devices[0].scopes = body.scopes;
    return Response.json({ revision: 'saved', grants: [{ scope, spaces: [newSpace] }] });
  });
  const byId = id => page.document.getElementById(id);
  ui.initCuaGrants(); await ui.loadCuaGrants();
  assert.equal(byId('cua-pair-add').disabled, false);

  await page.click(byId('cua-pair-add'));
  const pendingCard = () => page.document.querySelector('[data-pending-card]');
  assert.ok(pendingCard(), '点击添加设备应创建待接入设备卡');
  assert.equal(byId('cua-stat-pending').textContent, '1');
  const cmd = () => pendingCard().querySelector('textarea').value;
  assert.ok(cmd().includes('/cua/join/mac.sh'));
  assert.ok(cmd().includes(ticket));
  assert.ok([...page.storage.values()].every(value => !value.includes(ticket)));

  // 切换系统为 Windows 并预选会话
  const select = pendingCard().querySelector('select');
  select.value = 'windows';
  select.dispatchEvent(new page.window.Event('change'));
  assert.ok(cmd().includes('/cua/join/windows.ps1'));
  assert.ok(cmd().includes(ticket));

  const preCb = pendingCard().querySelector(`input[type=checkbox][value="${scope}"]`);
  toggleCheckbox(page, preCb, true);
  assert.match(pendingCard().textContent, /上线后生效/);

  // 模拟新设备握手上线后点击刷新检测
  directory.devices.push({ id: newSpace, name: 'paired-mac', os: 'macos', status: 'running', scopes: [] });
  await page.click(buttonWithText(pendingCard(), '刷新检测上线'));
  assert.equal(pendingCard(), null);
  assert.equal(byId('cua-stat-pending').textContent, '0');
  const liveCard = cardBySpace(page, newSpace);
  assert.ok(liveCard);
  assert.equal(liveCard.querySelector(`input[type=checkbox][value="${scope}"]`).checked, true);
  assert.match(liveCard.textContent, /待新增/);
  await page.click(buttonWithText(liveCard, '保存授权'));
  assert.deepEqual(deviceGrantWrites, [{ space: newSpace, scopes: [scope], expectedRevision: 'test' }]);
});
