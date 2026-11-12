import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { resolve } from "node:path";
const {window}=parseHTML("<!doctype html><html><body></body></html>");
for(const key of ["document","HTMLElement","HTMLInputElement","HTMLTableCellElement","Event"])globalThis[key]=window[key];
globalThis.MouseEvent=window.Event;
Object.defineProperty(window.HTMLInputElement.prototype,"checked",{configurable:true,get(){return this.hasAttribute("checked");},set(v){if(v)this.setAttribute("checked","");else this.removeAttribute("checked");}});
const saved=new Map([["cs-agent-admin-token","synthetic-admin"]]);
globalThis.sessionStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,String(v)),removeItem:k=>saved.delete(k)};
let assigned="",errors=[],loads=0,calls=[],conflict=false;
globalThis.location={assign:url=>assigned=url};
globalThis.__githubState={editingSource:null,sourceForms:{}};
globalThis.__githubFail=e=>errors.push(e);
globalThis.__githubLoad=()=>{loads++;};
const bundled=await build({entryPoints:["browser/github.ts"],absWorkingDir:process.cwd(),bundle:true,write:false,format:"esm",platform:"node",
 plugins:[{name:"app-test-boundary",setup(b){b.onResolve({filter:/^\.\/app$/},()=>({path:"app",namespace:"test"}));
 b.onLoad({filter:/.*/,namespace:"test"},()=>({contents:`export {el} from ${JSON.stringify(resolve("browser/dom.ts"))};
 export const state=globalThis.__githubState,bjTime=String,notice=()=>{},fail=e=>globalThis.__githubFail(e),loadSources=async()=>globalThis.__githubLoad(),showLogin=()=>{};`,resolveDir:process.cwd()}));}}]});
const {renderGitHub}=await import("data:text/javascript;base64,"+Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const settings={intervalS:300,mergeWindowS:0,budgetPerHour:10,filters:{requireLabels:[],excludeLabels:[],excludeSenders:[]}};
const view=()=>({configured:true,revision:"1",count:0,capacity:5000,pendingCapacity:200,receipts:[],
 value:{repositoryIds:[],selections:[],paused:false,settings},
 connections:{configured:true,slug:"test-app",identities:[{id:7,login:"owner"}],installations:[{installationId:456,user:{id:7,login:"owner"},status:"active",until:Date.now()+600000,
 repositories:Array.from({length:12},(_,i)=>({id:i+1,name:"owner/repo"+i}))}]}});
const button=(root,text)=>[...root.querySelectorAll("button")].find(b=>b.textContent===text);
async function click(b){assert.ok(b);b.dispatchEvent(new window.Event("click"));for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));}
function reset(){document.body.replaceChildren();globalThis.__githubState.editingSource=null;globalThis.__githubState.sourceForms={};errors=[];calls=[];conflict=false;loads=0;}
globalThis.fetch=async(path,init)=>{
 const body=JSON.parse(init.body);calls.push({path,body,headers:init.headers});
 if(path.endsWith("/start"))return Response.json({url:"https://github.com/login/oauth/authorize?state=test&code_challenge_method=S256",installationUrl:"https://github.com/apps/test-app/installations/new"});
 return Response.json(conflict?{error:"conflict"}:{ok:true},{status:conflict?409:200});
};
test("real GitHub form paginates ten, keeps detached choices and drafts, and preserves CAS conflicts and empty IDs",async()=>{
 reset();const snapshot=view(),card=renderGitHub({paused:false},snapshot);document.body.append(card);
 const form=card.querySelector("details");form.open=true;form.dispatchEvent(new window.Event("toggle"));
 assert.equal(form.querySelector("textarea"),null);
 const label=[...form.querySelectorAll("label")].find(l=>l.textContent.includes("owner/repo0 "));
 const target=label.parentElement,pager=target.nextElementSibling;
 assert.equal(target.children.length,10);label.querySelector("input").checked=true;
 await click(button(pager,"下一页"));assert.equal(target.children.length,2);target.firstElementChild.querySelector("input").checked=true;
 assert.equal(renderGitHub({paused:false},snapshot).querySelector("details"),form);
 conflict=true;await click(button(form,"保存仓库选择与设置"));
 assert.equal(errors.length,1);assert.equal(globalThis.__githubState.editingSource,"github");
 assert.deepEqual(calls.at(-1).body.value.repositoryIds,[{installationId:456,repositoryId:1},{installationId:456,repositoryId:11}]);
 assert.equal(calls.at(-1).body.expectedRevision,"1");
 assert.equal("repositories" in calls.at(-1).body.value,false);
 const all=[...form.querySelectorAll("label")].find(l=>l.textContent.includes("全选 / 清空可见仓库")).querySelector("input");
 all.checked=true;all.dispatchEvent(new window.Event("change"));
 await click(button(form,"保存仓库选择与设置"));assert.equal(calls.at(-1).body.value.repositoryIds.length,12);
 all.checked=false;all.dispatchEvent(new window.Event("change"));

 conflict=false;await click(button(form,"保存仓库选择与设置"));assert.equal(globalThis.__githubState.editingSource,null);
 reset();const empty=renderGitHub({paused:false},view());document.body.append(empty);
 await click(button(empty,"保存仓库选择与设置"));assert.deepEqual(calls.at(-1).body.value.repositoryIds,[]);
});
test("real connection UI uses browser-bound authenticated POST and explicit confirmation, never puts admin token in redirect",async()=>{
 reset();let card=renderGitHub({paused:false},view());document.body.append(card);
 await click(button(card,"连接 / 添加 GitHub 身份"));
 assert.match(saved.get("github-browser"),/^[a-f0-9]{64}$/);assert.equal(calls.at(-1).body.browser,saved.get("github-browser"));
 assert.equal(calls.at(-1).headers.Authorization,"Bearer synthetic-admin");assert.ok(!assigned.includes("synthetic-admin"));
 saved.set("github-oauth-result",JSON.stringify({state:"test",code:"synthetic-code"}));
 card=renderGitHub({paused:false},view());document.body.replaceChildren(card);
 await click(button(card,"确认连接刚授权的 GitHub 身份"));
 assert.equal(calls.at(-1).path,"/admin/github/connect/complete");assert.equal(calls.at(-1).body.code,"synthetic-code");
 assert.equal(saved.has("github-oauth-result"),false);assert.equal(saved.has("github-browser"),false);
});
