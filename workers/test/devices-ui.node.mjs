import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PAGE_HTML } from "../src/admin/app.generated.ts";
import { bundleModule, mountDom } from "./browser-harness.mjs";

const { window, document, click, settle } = mountDom(ADMIN_PAGE_HTML);
globalThis.__deviceCs = { epoch: 0 };
globalThis.__deviceErrors = [];
let requests = [], devices = [], firstFailure = true;
globalThis.__deviceRead = async (_schema, method, path, body) => {
  requests.push({ method, path, body });
  if (method === "GET") return { configured: true, devices };
  if (path === "/admin/devices") {
    if (firstFailure) { firstFailure = false; throw new Error("synthetic-network"); }
    const device = { ...body, state: "pairing", expiresAt: Date.now() + 10000, createdAt: Date.now(), serverId: "device-" + body.id, desktopServerId: null };
    devices = [device]; return { device, pairingUrl: "https://agent.test/admin/devices/" + body.id + "/pair#synthetic-code" };
  }
  assert.ok(path.endsWith("/revoke")); devices[0].state = "revoked"; return devices[0];
};
const { initDevices, loadDevices } = await bundleModule("browser/devices.ts", {
  "./app": 'export { $, el } from "./browser/dom.ts"; export const loadOverview = async () => {}, renderMcpService = () => {}, fail = e => globalThis.__deviceErrors.push(e), show = () => {}, showLogin = () => {}, notice = () => {}, readToken = () => true;',
  "./api": "export const readApi = (...args) => globalThis.__deviceRead(...args); export const api = (...args) => globalThis.__deviceRead(null,...args);",
  "./console": "export const cs = globalThis.__deviceCs;",
  "./management": "export const selectManagementSubtab = () => {};",
  "./mcp-servers": "export const loadMcpServers = async () => {};",
});
const node = id => document.getElementById(id);
test("真实设备表单默认只选命令行，失败重试复用设备 ID，关闭后清除配对链接", async () => {
  globalThis.location = { pathname:'/admin/', hash:'' };
  initDevices(); await loadDevices();
  assert.equal(node("device-desktop").hasAttribute("checked"), false);
  node("device-desktop").checked = false; node("device-name").value = "我的 Mac";
  await click(node("device-create")); assert.equal(globalThis.__deviceErrors.length, 1);
  const original = requests.find(request => request.method === "POST").body;
  assert.equal(original.desktop, false);
  await click(node("device-create"));
  assert.deepEqual(requests.filter(request => request.method === "POST")[1].body, original);
  assert.match(node("device-link").value, /synthetic-code$/);
  assert.ok(node("device-list").textContent.includes("我的 Mac"));
  node("device-editor").open = false; node("device-editor").dispatchEvent(new window.Event("toggle"));
  assert.equal(node("device-link").value, ""); assert.equal(node("device-pairing").hidden, true);
  const revoke = [...node("device-list").querySelectorAll("button")].find(button => button.textContent === "撤销接入");
  await click(revoke); assert.match(node("device-list").textContent, /已撤销/);
});

test('管理台启动后仍显示失败原因，展开设备面板时加载设备，仅接受本标签页的回调', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token:'synthetic-admin' });
  globalThis.ResizeObserver = globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  t.after(() => { delete globalThis.ResizeObserver; delete globalThis.IntersectionObserver; });
  const element = id => page.document.getElementById(id);
  const calls = [], rewrites = [], exchanges = [];
  globalThis.location = { pathname:'/admin/', hash:'#cloudflare?state=other&code=sample' };
  globalThis.history = { replaceState: (_a,_b,path) => { rewrites.push(path); location.hash = ''; } };
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push(path);
    if (path === '/admin/devices/cloudflare/complete') {
      exchanges.push(JSON.parse(init.body));
      return Response.json({ available:true, domain:'example.test', scopes:[], reauth:false });
    }
    if (path === '/admin/devices') return Response.json({ configured:true, devices:[] });
    return new Promise(() => {}); // 其他面板的数据与本次启动回归无关。
  });
  // linkedom 没有原生 details.open 的 toggle 派发。
  const editor = element('device-editor');
  Object.defineProperty(editor,'open',{get:()=>editor.hasAttribute('open'),set:open=>{
    editor.toggleAttribute('open',open); editor.dispatchEvent(new page.window.Event('toggle'));
  }});
  sessionStorage.setItem('cs-agent-cloudflare-state','expected');
  const { completeCloudflareLogin } = await bundleModule({contents: "import './browser/main.ts'; export { completeCloudflareLogin } from './browser/devices.ts';"});
  await settle();
  assert.deepEqual(rewrites,['/admin/']); assert.ok(editor.open);
  assert.equal(element('mcp-section').hidden, false);
  assert.equal(element('model-section').hidden, true);
  assert.equal(page.document.querySelector('#manage-subtabs button[data-subtab="models-mcp"]')?.getAttribute('aria-selected'), 'true');
  assert.equal(element('status').hidden,false); assert.match(element('status').textContent,/授权未完成/);
  assert.equal(calls.filter(p=>p==='/admin/devices').length,1);
  assert.ok(!calls.some(p=>p.endsWith('/complete')));

  await page.click(page.document.querySelector('#manage-subtabs button[data-subtab="models-core"]'));
  assert.equal(element('mcp-section').hidden, true);

  t.mock.timers.enable({apis:['setTimeout']});
  location.hash = '#cloudflare?state=expected&code=sample';
  sessionStorage.setItem('cs-agent-cloudflare-state','expected');
  await completeCloudflareLogin();
  assert.deepEqual(exchanges,[{state:'expected',code:'sample'}]);
  assert.equal(element('mcp-section').hidden, false);
  assert.equal(page.document.querySelector('#manage-subtabs button[data-subtab="models-mcp"]')?.getAttribute('aria-selected'), 'true');
  assert.match(element('status').textContent,/example.test/);
  assert.equal(element('status').className,'status-line info');
  t.mock.timers.tick(6000);
  assert.equal(element('status').hidden,true);
  assert.equal(sessionStorage.getItem('cs-agent-cloudflare-state'),null);
  delete globalThis.history; delete globalThis.location;
});

test('概览和两个服务选择器区分同名设备与桌面，操作仍按原服务 ID 定位', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: 'synthetic-admin' });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const shell = { id: ids[0], name: '开发机', capability: 'shell' };
  const services = [
    { server: 'device-' + ids[0], device: shell },
    { server: 'device-' + ids[0] + '-desktop', device: { ...shell, capability: 'desktop' } },
    { server: 'device-' + ids[1], device: { ...shell, id: ids[1] } },
    { server: 'device-manual', purpose: 'environment' },
    { server: 'remote-gui', purpose: 'desktop' },
  ];
  const paths = [];
  t.mock.method(globalThis, 'fetch', async path => {
    paths.push(String(path));
    if (path === '/admin/devices') return Response.json({ configured: true, devices: [
      { id: ids[0], name: '开发机', desktop: true, state: 'ready', createdAt: 1, expiresAt: 0, serverId: services[0].server, desktopServerId: services[1].server },
      { id: '33333333-3333-4333-8333-333333333333', name: '等待安装', desktop: false, state: 'pairing', createdAt: 2, expiresAt: 3, serverId: 'pending', desktopServerId: null },
    ] });
    if (path === '/admin/mcp/servers') return Response.json({ servers: services.map(({ server, device }) => ({
      server: { id: server, enabled: true, transport: { url: 'https://example.test/mcp', headers: {} },
        credential: { kind: 'managed' }, resourceAllow: [], access: {}, tools: { allow: [] } },
      device, revision: 'v1', credentialSet: true, discovered: null,
    })) });
    if (String(path).startsWith('/admin/mcp/access?')) return Response.json({ grant: null });
    if (String(path).startsWith('/admin/mcp/approvals?')) return Response.json({ approvals: [] });
    return new Promise(() => {});
  });
  const { renderMcp, loadDevices, loadMcpServers, mcpUiLoad } = await bundleModule({ contents:
    "export { loadDevices } from './browser/devices.ts'; export { renderMcp } from './browser/app.ts'; export { loadMcpServers } from './browser/mcp-servers.ts'; export { mcpUiLoad } from './browser/mcp.ts';" });
  renderMcp(services.map(service => ({ ...service, login: 'ok', credential: 'static', enabled: true, tools: 4 })));
  const cards = [...page.document.querySelector('#device-list').children];
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /开发机.*11111111.*命令行.*桌面/);
  assert.match(cards[1].textContent, /开发机.*22222222.*命令行.*凭据已配置/);
  assert.equal(cards[0].textContent.includes(ids[0]), false);
  assert.equal(cards[0].querySelectorAll('strong').length, 1);
  const rows = [...page.document.querySelector('#mcp-list').children];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /device-manual.*环境管理/);
  assert.match(rows[1].textContent, /remote-gui.*桌面控制/);
  await page.click(cards[0].querySelectorAll('button')[1]);
  assert.ok(paths.includes('/admin/mcp/' + services[1].server + '/refresh'));
  await loadDevices();
  const joined = [...page.document.getElementById('device-list').children];
  assert.equal(joined.length, 3);
  assert.match(joined[0].textContent, /开发机.*已完成配对.*撤销接入.*命令行.*桌面/);
  assert.match(joined[1].textContent, /等待安装.*等待设备配对.*继续配对/);
  assert.match(joined[2].textContent, /22222222.*命令行/);
  await loadMcpServers(services[1].server);
  await mcpUiLoad();
  for (const selectId of ['mcp-server-select', 'mcp-access-server']) {
    const option = [...page.document.getElementById(selectId).options].find(o => o.value === services[1].server);
    assert.equal(option.textContent, '开发机 · 设备桌面 · 11111111');
  }
  assert.equal(page.document.getElementById('mcp-server-id').value, services[1].server);
});
