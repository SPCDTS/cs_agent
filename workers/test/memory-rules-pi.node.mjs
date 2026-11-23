import {test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {readFile} from "node:fs/promises";
import {renderSections,planSystemEntries,replaySections} from "../node_modules/@earendil-works/pi-durable/dist/harness/prompt.js";
import {stream} from "@earendil-works/pi-ai/api/openai-completions";

const bundled=await build({entryPoints:["src/memory/rules.ts"],bundle:true,write:false,format:"esm",platform:"node"});
const {compileRules,renderRules,RULE_UNAVAILABLE}=await import("data:text/javascript;base64,"+Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const text=(body,revision)=>compileRules({epoch:revision,digest:String(revision).repeat(64),scope:"private:10001",items:[{id:72,revision,memoryVersion:revision,hash:"hash",entry:{kind:"rule",text:body}}]});
const user={role:"user",content:"A different topic",timestamp:2};
const old=text("OLD APPROVED REPLY CONVENTION",1),fresh=text("NEW APPROVED REPLY CONVENTION",2);
const message=(value)=>({role:"system",content:"",sections:{"memory-rules":value},timestamp:1});
const view=messages=>({messages,entries:messages.filter(m=>m.role==="system").map((m,i)=>({kind:"pi.system",id:String(i),model:[m]}))});
const context={};
test("pinned Pi keeps thrown sections but explicit degradation replaces them; unchanged/null patches and rebuilt head are deterministic",async()=>{
  assert.equal(JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-durable/package.json",import.meta.url))).version,"1.6.0");
  const shown=new Map([["memory-rules",old]]);
  const thrown=await renderSections([{key:"memory-rules",tag:false,render:()=>{throw Error("read");}}],{},shown,()=>{},context);
  assert.equal(thrown.get("memory-rules"),old);
  const degraded=await renderSections([{key:"memory-rules",tag:false,render:()=>renderRules(async()=>{throw Error("read");})}],{},shown,()=>{},context);
  assert.equal(degraded.get("memory-rules"),RULE_UNAVAILABLE);
  assert.equal(planSystemEntries(view([message(old)]),shown,[],99).length,0);
  const changed=planSystemEntries(view([message(old)]),new Map([["memory-rules",fresh]]),[],99);
  assert.equal(changed[0].model[0].sections["memory-rules"],fresh);
  const removed=planSystemEntries(view([message(old)]),new Map(),[],99);
  assert.equal(removed[0].model[0].sections["memory-rules"],null);
  assert.equal(replaySections([message(old),...removed.flatMap(e=>e.model)]).size,0);
  const compacted={...view([message(old),user]),head:{id:"9"}};
  const rebuilt=planSystemEntries(compacted,new Map([["memory-rules",fresh]]),[],100);
  assert.equal(rebuilt.length,1);
  assert.equal(rebuilt[0].model[0].sections["memory-rules"],fresh);
  assert.deepEqual(rebuilt[0].edits,[{target:"0",action:"omit"}]);
  // Reset has the same full-baseline path, with no retained entries to omit.
  const reset=planSystemEntries({head:{id:"9"},entries:[],messages:[]},new Map([["memory-rules",fresh]]),[],101);
  assert.equal(reset[0].model[0].sections["memory-rules"],fresh);
});
async function finalRequest(messages,supportsMidConvoSystemMessages) {
  let request;
  const model={id:"synthetic",name:"synthetic",api:"openai-completions",provider:"synthetic",baseUrl:"https://synthetic.invalid/v1",
    reasoning:false,input:["text"],contextWindow:32000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
    compat:{supportsMidConvoSystemMessages}};
  const result=await stream(model,{messages},{apiKey:"synthetic-not-a-secret",fetch:async(_url,options)=>{
    request=JSON.parse(options.body);
    return new Response('data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"synthetic","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{"Content-Type":"text/event-stream"}});
  }}).result();
  assert.notEqual(result.stopReason,"error",JSON.stringify(result));
  assert.ok(request);return request;
}
for(const supports of [false,true])test("final provider HTTP payload with supportsMidConvoSystemMessages="+supports,async()=>{
  const history=[message(old),user,message(fresh),{...user,timestamp:4,content:"Another topic"}];
  const sent=await finalRequest(history,supports);
  const systems=sent.messages.filter(m=>m.role==="system");
  if(supports){
    assert.equal(systems.length,2);
    assert.ok(sent.messages.findIndex(m=>m===systems[1])>sent.messages.findIndex(m=>m.role==="user"));
    assert.match(systems[1].content,/NEW APPROVED/);
  }else{
    assert.equal(systems.length,1);assert.equal(sent.messages[0].role,"system");
    assert.match(systems[0].content,/NEW APPROVED/);assert.doesNotMatch(systems[0].content,/OLD APPROVED/);
  }
  const unavailable=await finalRequest([message(old),user,message(RULE_UNAVAILABLE)],supports);
  assert.match(unavailable.messages.filter(m=>m.role==="system").at(-1).content,/unavailable/);
  const removed=await finalRequest([message(old),user,message(null)],supports);
  if(!supports)assert.doesNotMatch(JSON.stringify(removed.messages),/OLD APPROVED/);
  // Prepared cutoff is immutable: adding a later patch does not mutate the prepared request array.
  const cutoff=[message(old),user];const prepared=await finalRequest(cutoff,supports);
  await finalRequest([...cutoff,message(fresh)],supports);
  assert.match(JSON.stringify(prepared.messages),/OLD APPROVED/);
  assert.doesNotMatch(JSON.stringify(prepared.messages),/NEW APPROVED/);
});
