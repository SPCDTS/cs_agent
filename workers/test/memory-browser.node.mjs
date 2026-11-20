import {test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {parseHTML} from "linkedom";
import {resolve} from "node:path";
import {ADMIN_PAGE_HTML} from "../src/admin/app.generated.ts";
const {window}=parseHTML(ADMIN_PAGE_HTML);
for(const key of ["document","HTMLElement","HTMLInputElement","HTMLSelectElement","HTMLTextAreaElement","HTMLTableCellElement","SVGSVGElement","Event"])globalThis[key]=window[key];
globalThis.MouseEvent=window.Event;globalThis.CSS={escape:x=>x};globalThis.confirm=()=>true;
Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute("selected"))?.value??this.options[0]?.value??"";},set(v){for(const o of this.options){if(o.value===v)o.setAttribute("selected","");else o.removeAttribute("selected");}}});
const dialog=document.querySelector("#memory-detail");dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};
const storage=new Map([["cs-agent-admin-token","synthetic"]]);globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
let notices=[],errors=[],calls=[],handler;
const state=globalThis.__memoryState={memoryNs:"owner",memoryQuery:"",profile:null,memoryView:null,overview:{threads:[{key:"owner",name:"主人"},{key:"group:200",name:"测试群"}]}};
globalThis.__memoryNotice=s=>notices.push(s);globalThis.__memoryFail=e=>errors.push(e);
const code=await build({entryPoints:["browser/memory.ts"],bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"app-boundary",setup(b){
 b.onResolve({filter:/^\.\/app$/},()=>({path:"app",namespace:"fixture"}));
 b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`export {$,el} from ${JSON.stringify(resolve("browser/dom.ts"))};export const state=globalThis.__memoryState,notice=s=>globalThis.__memoryNotice(s),fail=e=>globalThis.__memoryFail(e),time=x=>String(x),showLogin=()=>{};`,resolveDir:process.cwd()}));
}}]});
const ui=await import("data:text/javascript;base64,"+Buffer.from(code.outputFiles[0].text).toString("base64"));
const $=id=>document.querySelector("#"+id);
$("mem-ns").innerHTML='<option value="owner">主人</option><option value="group:200">测试群</option>';
ui.initMemory();
const row=(text="主人偏好",id=1)=>({id,text,kind:"preference",status:"active",subject:"self",since:null,until:null,due_at:null,done_at:null,source_scope:"private:100",source_message_id:"123",author:"dashboard",updated_at:100,recall_count:0});
const profile={text:"画像旧内容",revision:"rev1"};
const detail=r=>({row:r,revision:7,versions:[{id:7,at:100,by:"dashboard",reason:"更正",before_json:JSON.stringify({...r,text:"原正文"}),after_json:JSON.stringify(r)}],links:[],inProfile:true,evidence:[{scope:"private:100",message_id:"123",speaker:"100",quote:"这是来源原话"}]});
function defaults(url,init){
 if(url.pathname==="/admin/memory/list")return Response.json({items:[row(url.searchParams.get("ns")==="owner"?"主人偏好":"群聊偏好")],total:1,profile});
 if(url.pathname==="/admin/memory/jobs")return Response.json({jobs:[]});
 if(url.pathname==="/admin/memory/proposals")return Response.json(init.method==="POST"?{result:"timeout"}:{proposals:[]});
 if(url.pathname==="/admin/memory/candidates")return Response.json({candidates:[]});
 if(url.pathname==="/admin/memory/1")return Response.json(init.method==="DELETE"?{status:"forgotten"}:detail(row(url.searchParams.get("ns")==="owner"?"主人偏好":"群聊偏好")));
 throw new Error("unexpected "+url);
}
globalThis.fetch=async(path,init)=>{const url=new URL(path,"http://test");calls.push({path,method:init.method,body:init.body?JSON.parse(init.body):null});return handler?handler(url,init):defaults(url,init);};
async function settle(){for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));}
async function click(node){assert.ok(node);node.dispatchEvent(new window.Event("click"));await settle();}
const button=text=>[...document.querySelectorAll("button")].find(b=>b.textContent===text);
function reset(){ui.resetMemory();state.memoryNs="owner";state.memoryQuery="";notices=[];errors=[];calls=[];handler=null;$("mem-status").value="active";$("mem-ns").value="owner";}
test("乱序响应不能把旧会话内容写入新会话，遗忘绑定会话与版本",async()=>{
 reset();const waits=[];
 handler=(url,init)=>url.searchParams.get("ns")==="owner"?new Promise(resolve=>waits.push(()=>resolve(defaults(url,init)))):defaults(url,init);
 const old=ui.loadMemory();await settle();state.memoryNs="group:200";await ui.loadMemory();
 for(const release of waits)release();await old;
 assert.match($("memories").textContent,/群聊偏好/);assert.doesNotMatch($("memories").textContent,/主人偏好/);
 handler=null;await ui.memoryDetail(1,"group:200");await click(button("遗忘（可恢复）"));
 const deletion=calls.find(c=>c.method==="DELETE");assert.equal(deletion.path,"/admin/memory/1?ns=group%3A200");assert.equal(deletion.body.expectedVersion,7);
 assert.equal(errors.length,0);
});
test("来源证据和版本差异可读，编辑提交真实字段并携带旧版本",async()=>{
 reset();await ui.loadMemory();await ui.memoryDetail(1);assert.match($("memory-detail-body").textContent,/这是来源原话/);assert.match($("memory-detail-body").textContent,/原正文/);
 await click(button("编辑记忆"));const form=$("memory-detail-body").querySelector("form");form.querySelector("textarea").value="修正内容";
 handler=(url,init)=>init.method==="PUT"?Response.json(row("修正内容")):defaults(url,init);
 form.dispatchEvent(new window.Event("submit",{cancelable:true}));await settle();
 const save=calls.find(c=>c.method==="PUT");assert.equal(save.body.entry.text,"修正内容");assert.equal(save.body.expectedVersion,7);assert.equal(errors.length,0);
});
test("画像冲突保留草稿并展示当前版本，再保存使用新版本",async()=>{
 reset();await ui.loadMemory();await click($("profile-toggle"));$("profile-edit").value="我的草稿";
 handler=(url,init)=>url.pathname==="/admin/memory/profile"?Response.json({error:"conflict",current:{text:"别人修改的画像",revision:"rev2"}},{status:409}):defaults(url,init);
 await click($("profile-save"));assert.equal($("profile-edit").value,"我的草稿");assert.equal($("profile-edit").hidden,false);assert.match($("profile-text").textContent,/别人修改的画像/);
 handler=(url,init)=>url.pathname==="/admin/memory/profile"?Response.json({profile:{text:"我的草稿",revision:"rev3"}}):defaults(url,init);
 await click($("profile-save"));assert.equal(calls.filter(c=>c.path==="/admin/memory/profile").at(-1).body.expected,"rev2");assert.equal(errors.length,0);
});
test("模型超时显示明确失败结果，不能显示笼统的成功",async()=>{
 reset();await ui.loadMemory();await ui.memoryJobs();await click(button("生成画像建议"));
 assert.ok(notices.some(n=>n.includes("模型超时")));assert.ok(!notices.includes("操作完成"));assert.equal(errors.length,0);
});

test("退出登录清空画像草稿，晚到的冲突响应不能恢复旧内容",async()=>{
 reset();await ui.loadMemory();await click($("profile-toggle"));$("profile-edit").value="只在本次登录内保留";
 let release;handler=(url,init)=>url.pathname==="/admin/memory/profile"?new Promise(resolve=>{release=()=>resolve(Response.json({error:"conflict",current:{text:"旧登录的画像",revision:"late"}},{status:409}));}):defaults(url,init);
 $("profile-save").dispatchEvent(new window.Event("click"));await settle();assert.equal(typeof release,"function");ui.resetMemory();release();await settle();
 assert.equal($("profile-edit").value,"");assert.equal($("profile-edit").hidden,true);assert.equal(state.profile,null);assert.equal($("profile-text").textContent,"");
});

test("规则批准必须展示精确提案后单独确认，候选预览不会自动激活",async()=>{
 reset();
 handler=(url,init)=>{
  if(url.pathname==="/admin/memory/1")return Response.json(detail({...row(),kind:"rule"}));
  if(url.pathname==="/admin/memory/rules/scopes")return Response.json({scopes:["private:10000001"]});
  if(url.pathname==="/admin/memory/rules")return Response.json({bindings:[]});
  if(url.pathname==="/admin/memory/rules/proposals")return Response.json({id:"proposal-id",payload_hash:"h".repeat(64),payload_json:JSON.stringify({kind:"rule",text:"精确批准正文"}),scope_key:"private:10000001",memory_version:7,binding_revision:0});
  if(url.pathname==="/admin/memory/rules/confirm")return Response.json({status:"committed"});
  return defaults(url,init);
 };
 await ui.memoryDetail(1);
 await click(button("规则批准 / 修改 / 撤销"));
 await click(button("生成精确批准预览"));
 const proposed=calls.find(c=>c.path.startsWith("/admin/memory/rules/proposals"));
 assert.equal(proposed.body.expectedVersion,7);assert.equal(proposed.body.expectedBindingRevision,0);
 assert.equal(calls.some(c=>c.path.startsWith("/admin/memory/rules/confirm")),false);
 assert.match($("memory-detail-body").textContent,/精确批准正文/);
 await click(button("我批准以上精确版本和正文"));
 const confirmed=calls.find(c=>c.path.startsWith("/admin/memory/rules/confirm"));
 assert.equal(confirmed.body.proposalId,"proposal-id");assert.equal(confirmed.body.payloadHash,"h".repeat(64));
 assert.equal(confirmed.body.approved,undefined);
 assert.match($("memory-detail-body").textContent,/下一次成功 prepare/);
});

function ruleFixture(url,init){
 if(/^\/admin\/memory\/[12]$/.test(url.pathname)){
  const id=Number(url.pathname.split("/").at(-1)),ns=url.searchParams.get("ns");
  return Response.json(detail({...row(ns==="owner"?(id===1?"OWNER-RULE":"OTHER-MEMORY"):"GROUP-MEMORY",id),kind:id===1&&ns==="owner"?"rule":"fact"}));
 }
 if(url.pathname==="/admin/memory/rules/scopes")return Response.json({scopes:["private:10000001","private:10000002"]});
 if(url.pathname==="/admin/memory/rules")return Response.json({bindings:[{memory_id:1,revision:3,state:"enabled"}]});
 if(url.pathname==="/admin/memory/rules/proposals")return Response.json({id:"proposal-id",payload_hash:"a".repeat(64),payload_json:'{"kind":"rule","text":"LATE-PROPOSAL"}',scope_key:"private:10000001",memory_version:7,binding_revision:3});
 if(url.pathname==="/admin/memory/rules/confirm"||url.pathname==="/admin/memory/rules/revoke")return Response.json({status:"committed"});
 if(url.pathname.startsWith("/admin/memory/rules/receipts/"))return Response.json(null);
 return defaults(url,init);
}
async function openRule(){await ui.memoryDetail(1);await click(button("规则批准 / 修改 / 撤销"));}
const rulePath={scopes:"/admin/memory/rules/scopes",bindings:"/admin/memory/rules",proposals:"/admin/memory/rules/proposals"};
async function deferRule(stage){
 let release;
 handler=(url,init)=>url.pathname===rulePath[stage]?new Promise(resolve=>{release=value=>resolve(value??ruleFixture(url,init));}):ruleFixture(url,init);
 await openRule();
 if(stage==="proposals")await click(button("生成精确批准预览"));
 assert.equal(typeof release,"function");return value=>release(value);
}
test("迟到 scopes、bindings、proposals 不覆盖其他 namespace、记忆或关闭后的详情",async()=>{
 for(const stage of ["scopes","bindings","proposals"]){
  reset();const release=await deferRule(stage);
  if(stage==="scopes"){state.memoryNs="group:200";await ui.memoryDetail(1,"group:200");}
  else if(stage==="bindings")await ui.memoryDetail(2);
  else {await click($("memory-detail-close"));await ui.memoryDetail(2);}
  const title=$("memory-detail-title").textContent,body=$("memory-detail-body").textContent;
  release();await settle();
  assert.equal($("memory-detail-title").textContent,title);
  assert.equal($("memory-detail-body").textContent,body);
  assert.equal(button("生成精确批准预览"),undefined);
  assert.equal(button("我批准以上精确版本和正文"),undefined);
  assert.equal(errors.length,0);
 }
});
test("退出重登后的迟到读取和提案错误不能恢复旧编辑器或注销新登录",async()=>{
 for(const [stage,status] of [["scopes",401],["bindings",500],["proposals",400]]){
  reset();const release=await deferRule(stage);
  ui.resetMemory();sessionStorage.setItem("cs-agent-admin-token","synthetic-new-session");
  await ui.memoryDetail(2);
  const body=$("memory-detail-body").textContent;
  release(Response.json({error:"late"},{status}));await settle();
  assert.equal($("memory-detail-body").textContent,body);
  assert.equal(sessionStorage.getItem("cs-agent-admin-token"),"synthetic-new-session");
  assert.equal(errors.length,0);assert.equal(notices.length,0);
 }
});
test("失效编辑器的旧按钮引用不能生成提案、确认、撤销或查询回执",async()=>{
 globalThis.window=window;window.confirm=()=>true;
 for(const invalidate of [
  async()=>{await click($("memory-detail-close"));await ui.memoryDetail(2);},
  async()=>{$("memory-detail").dispatchEvent(new window.Event("cancel"));await settle();},
  async()=>{state.memoryNs="group:200";await ui.memoryDetail(1,"group:200");},
  async()=>{await ui.memoryDetail(2);},
  async()=>{ui.resetMemory();await ui.memoryDetail(1);},
 ]){
  reset();handler=ruleFixture;await openRule();
  const prepare=button("生成精确批准预览"),revoke=button("撤销此批准版本");
  await invalidate();const count=calls.length;
  await click(prepare);await click(revoke);
  assert.equal(calls.length,count);
 }
 reset();handler=ruleFixture;await openRule();await click(button("生成精确批准预览"));
 const confirm=button("我批准以上精确版本和正文");
 await ui.memoryDetail(2);let count=calls.length;await click(confirm);assert.equal(calls.length,count);
 reset();handler=(url,init)=>url.pathname==="/admin/memory/rules/proposals"?Response.json({error:"synthetic"},{status:500}):ruleFixture(url,init);
 await openRule();await click(button("生成精确批准预览"));const receipt=button("查询操作回执");
 await click($("memory-detail-close"));await ui.memoryDetail(2);count=calls.length;await click(receipt);assert.equal(calls.length,count);
});
test("已发送确认或撤销的迟到响应不能污染新的详情，且不会再发写请求",async()=>{
 globalThis.window=window;window.confirm=()=>true;
 for(const [action,status] of [["confirm",200],["revoke",500]]){
  reset();let release;
  handler=(url,init)=>url.pathname==="/admin/memory/rules/"+action?new Promise(resolve=>{release=()=>resolve(Response.json({status:"committed"},{status}));}):ruleFixture(url,init);
  await openRule();
  if(action==="confirm"){await click(button("生成精确批准预览"));await click(button("我批准以上精确版本和正文"));}
  else await click(button("撤销此批准版本"));
  assert.equal(typeof release,"function");await ui.memoryDetail(2);
  const body=$("memory-detail-body").textContent,count=calls.length;release();await settle();
  assert.equal($("memory-detail-body").textContent,body);assert.equal(calls.length,count);
  assert.equal(errors.length,0);assert.equal(notices.length,0);
 }
});
test("同编辑器切换scope后，旧bindings失败不覆盖当前作用域",async()=>{
 reset();let release;
 handler=(url,init)=>url.pathname==="/admin/memory/rules"&&url.searchParams.get("scope")==="private:10000001"
  ?new Promise(resolve=>{release=()=>resolve(Response.json({error:"late"},{status:500}));}):ruleFixture(url,init);
 await openRule();const select=$("memory-detail-body").querySelector("select");
 select.value="private:10000002";select.dispatchEvent(new window.Event("change"));await settle();
 assert.ok(button("生成精确批准预览"));const body=$("memory-detail-body").textContent;
 release();await settle();assert.equal($("memory-detail-body").textContent,body);assert.equal(errors.length,0);
});
