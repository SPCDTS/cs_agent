import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { loadObsToken } from '../../src/obs/token.js';
import { registerSecrets } from '../../src/shared/redact.js';
import { readFileSync, statSync } from 'node:fs';
import { createDashboard } from '../../src/obs/http.js';
import { ObsStore } from '../../src/obs/store.js';
import { Trace } from '../../src/shared/trace.js';
import { ContextStore } from '../../src/context/store.js';
import { loadConfig } from '../../src/config.js';
import { log, logBuffer } from '../../src/shared/log.js';
import { formatRecent } from '../../src/context/format.js';
const clean:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
let cookie = '';
const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, {...init,headers:{...(cookie ? {Cookie:cookie} : {}),...init?.headers}});
async function rig(token?: string){
  const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-http-'));const store=new ObsStore(dir),context=new ContextStore(dir),trace=new Trace(store);
  const config=loadConfig({DATA_DIR:dir,OBS_TOKEN:token ?? '',NAPCAT_TOKEN:'fake-napcat-secret'});
  config.OBS_TOKEN = await loadObsToken(dir,config.OBS_TOKEN);
  cookie = token === undefined ? 'obs_token='+config.OBS_TOKEN : '';
  trace.event('turn:pi:7:1','received',{scope:'group:7',detail:{text:'原文 <script>坏</script>',sender:'用户',thread_key:'group:7',kind:'user'}});
  trace.event('turn:pi:7:1','tool:web_search',{detail:{query:'天气'}});
  trace.event('turn:pi:7:1','reply_sent',{detail:{terminal:true,status:'completed',thread_key:'group:7'}});
  context.ingest({message_id:'m',time:Math.floor(Date.now()/1000),message_type:'group',group_id:'7',user_id:'1',self_id:'2',nickname:'小明',text:'中文历史',route_text:'中文历史',truncated:false,mentioned_self:true,images:[],segments:[]});
  const dashboard=createDashboard({config,store,context,health:()=>({ws_connected:true}),queue:()=>({active:0}),codex:async()=>({owner:null}),pi:async()=>({count:0,keys:[]})});
  const server=createServer(dashboard.handle);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  clean.push(()=>{store.close();context.close();rmSync(dir,{recursive:true,force:true});},async()=>{dashboard.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {base,dir,store,context,config};
}
it('八个页面和回合详情可离线渲染；HTML 转义；共享上下文与配置脱敏',async()=>{
  const {base,context}=await rig();const sizes:Record<string,number>={};
  for(const [url,title] of Object.entries({'/':'运行总览','/turns':'chat-layout','/turns/pi%3A7%3A1':'回合详情','/conversations/group%3A7':'最近回合','/logs':'实时日志','/context':'上下文检索','/agents':'Agent','/agents/codex/sessions':'Codex 会话','/config':'生效配置'})){
    const res=await fetch(base+url);const text=await res.text();expect(res.status).toBe(200);expect(text).toContain(title);expect(text).not.toContain('fake-napcat-secret');expect(text).not.toMatch(/https:\/\/.*(?:cdn|unpkg)/);sizes[url]=Buffer.byteLength(text);
    if(url==='/turns/pi%3A7%3A1')expect(text).toContain('&lt;script&gt;');
  }
  const text=await (await fetch(base+'/context?scope=group%3A7')).text();expect(text).toContain(formatRecent(context.recent({kind:'scope',scope:'group:7'},{limit:30}),2500,{ids:true}));
});
it('favicon 无需鉴权且缓存一天，页面 head 引用同一个内嵌 SVG',async()=>{
  const {base}=await rig('fake-panel-secret');
  const res=await fetch(base+'/favicon.ico');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/svg+xml');
  expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  expect(res.headers.get('set-cookie')).toBeNull();
  const icon=await res.text();
  expect(icon).toMatch(/^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  expect(icon).toContain('<rect'); expect(icon).toContain('#2b47b5');
  expect(icon).not.toContain('fake-panel-secret'); expect(icon).not.toContain('fake-napcat-secret');
  expect(icon).not.toContain('<script'); expect(Buffer.byteLength(icon)).toBeLessThan(1024);
  const page=await fetch(base+'/'); expect(page.status).toBe(401);
  expect(await page.text()).toMatch(/<head>[\s\S]*<link rel="icon" href="\/favicon\.ico">[\s\S]*<\/head>/);
});
it('口令保护页面与 SSE；正确口令换 HttpOnly cookie 并移除 URL 中的口令',async()=>{
  const {base}=await rig('fake-panel-secret');
  for(const url of ['/','/context','/logs/stream'])expect((await fetch(base+url)).status).toBe(401);
  expect((await fetch(base+'/?token=wrong')).status).toBe(401);
  const login=await fetch(base+'/?token=fake-panel-secret',{redirect:'manual'});expect(login.status).toBe(303);expect(login.headers.get('location')).toBe('/');
  expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  const res=await fetch(base+'/',{headers:{Cookie:login.headers.get('set-cookie')!.split(';')[0]!}});expect(res.status).toBe(200);
  expect(await res.text()).not.toContain('fake-panel-secret');
});
it('SSE 实时发出过滤后的结构化日志；缓冲有界且脱敏',async()=>{
  const {base}=await rig();const abort=new AbortController();
  const res=await fetch(base+'/logs/stream?key=group:7&level=info',{signal:abort.signal});expect(res.headers.get('content-type')).toBe('text/event-stream');
  const reader=res.body!.getReader();log.info('忽略',{thread:'group:8'});log.info('实时中文',{thread:'group:7',token:'fake-sensitive'});
  const chunk=await reader.read();const text=new TextDecoder().decode(chunk.value);expect(text).toContain('实时中文');expect(text).not.toContain('fake-sensitive');expect(text).not.toContain('忽略');
  abort.abort();await reader.cancel().catch(()=>undefined);expect(logBuffer.recent().length).toBeLessThanOrEqual(1000);
});

it('未配置口令自动生成并复用文件，首页与上下文始终要求认证',async()=>{
  const {base,config,dir}=await rig('');
  expect(config.OBS_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(readFileSync(path.join(dir,'obs-token'),'utf8').trim()).toBe(config.OBS_TOKEN);
  expect(await loadObsToken(dir)).toBe(config.OBS_TOKEN);
  if(process.platform!=='win32')expect(statSync(path.join(dir,'obs-token')).mode&0o777).toBe(0o600);
  expect((await fetch(base+'/')).status).toBe(401);
  expect((await fetch(base+'/context')).status).toBe(401);
});
it('上下文正文、昵称、摘要和表单回显在 HTML 转义前脱敏',async()=>{
  const {base,context}=await rig();const secret='registered-context-secret';registerSecrets([secret]);
  const now=Math.floor(Date.now()/1000);
  context.ingest({message_id:'secret',time:now,message_type:'group',group_id:'7',user_id:'1',self_id:'2',nickname:'昵称'+secret,text:'正文'+secret+' <script>',route_text:'',truncated:false,mentioned_self:true,images:[],segments:[]});
  context.writeSummary({scope:'group:7',level:'day',period_start:now-86400,period_end:now-1,text:'摘要'+secret,msg_count:5});
  for(const route of ['/context','/context?query='+secret,'/turns?thread='+secret,'/logs?key='+secret]){
    const res=await fetch(base+route);expect(res.status).toBe(200);const html=await res.text();expect(html).not.toContain(secret);expect(html).toContain('[已隐藏]');
  }
  const html=await (await fetch(base+'/context?query='+secret)).text();expect(html).toContain('摘要');expect(html).toContain('昵称');expect(html).toContain('&lt;script&gt;');
});
it('回合详情的时间线使用 after 游标分页，降级首页仍可渲染',async()=>{
  const {base,store}=await rig();
  const first=await (await fetch(base+'/turns/pi%3A7%3A1?limit=1')).text();expect(first).toContain('下一页事件');expect(first).not.toContain('<code class="faint">tool:web_search</code>');
  const id=store.events('turn:pi:7:1',{limit:1})[0]!.id;
  expect(await (await fetch(base+'/turns/pi%3A7%3A1?limit=1&after='+id)).text()).toContain('<code class="faint">tool:web_search</code>');
  store.degrade();const res=await fetch(base+'/');expect(res.status).toBe(200);expect(await res.text()).toContain('degraded: true');
});
