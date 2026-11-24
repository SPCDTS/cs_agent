import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PAGE_HTML } from "../src/admin/app.generated.ts";
import { bundleModule, mountDom } from "./browser-harness.mjs";

test('管理台启动后仍显示失败原因，展开账户面板时加载授权，仅接受本标签页的回调', async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token:'synthetic-admin' });
  globalThis.ResizeObserver = globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  t.after(() => { delete globalThis.ResizeObserver; delete globalThis.IntersectionObserver; });
  const { settle } = page;
  const element = id => page.document.getElementById(id);
  const calls = [], rewrites = [], exchanges = [];
  globalThis.location = { pathname:'/admin/', hash:'#cloudflare?state=other&code=sample' };
  globalThis.history = { replaceState: (_a,_b,path) => { rewrites.push(path); location.hash = ''; } };
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push(path);
    if (path === '/admin/cloudflare/complete') {
      exchanges.push(JSON.parse(init.body));
      return Response.json({ available:true, domain:'example.test', scopes:[], reauth:false });
    }
    if (path === '/admin/cloudflare/status') return Response.json({ available:true, scopes:[], domain:null, reauth:false });
    return new Promise(() => {}); // 其他面板的数据与本次启动回归无关。
  });
  // linkedom 没有原生 details.open 的 toggle 派发。
  const editor = element('cloudflare-editor');
  Object.defineProperty(editor,'open',{get:()=>editor.hasAttribute('open'),set:open=>{
    editor.toggleAttribute('open',open); editor.dispatchEvent(new page.window.Event('toggle'));
  }});
  sessionStorage.setItem('cs-agent-cloudflare-state','expected');
  const { completeCloudflareLogin } = await bundleModule({contents: "import './browser/main.ts'; export { completeCloudflareLogin } from './browser/cloudflare.ts';"});
  await settle();
  assert.deepEqual(rewrites,['/admin/']); assert.ok(editor.open);
  assert.equal(element('mcp-section').hidden, false);
  assert.equal(element('model-section').hidden, true);
  assert.equal(page.document.querySelector('#manage-subtabs button[data-subtab="models-mcp"]')?.getAttribute('aria-selected'), 'true');
  assert.equal(element('status').hidden,false); assert.match(element('status').textContent,/授权未完成/);
  assert.equal(calls.filter(p=>p==='/admin/cloudflare/status').length,1);
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
