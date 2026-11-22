import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, it, expect, vi } from "vitest";
import { input } from "./helpers";
import { fingerprint, messageId } from "../src/communication/model";
import { incomingText } from "../src/communication/service";
import { MediaRepository, scopePrefix } from "../src/media/repository";
import { sha256 } from "../src/media/model";
import { McpPolicyStore, GrantInput } from "../src/mcp/policy";
import { Check } from "typebox/value";
afterEach(async()=>{ await reset(); });
const group="group:200000001", cid="11111111-1111-4111-8111-111111111111", address="sub:owner:"+cid;
async function seed(scope:string, value:any) {
 await runInDurableObject(env.THREAD.getByName(scope),async(instance,state)=>{
  await (instance as any).queueInput(value);
  state.storage.sql.exec("UPDATE inbound SET turn_id='review-local',status='done'");
  await state.storage.deleteAlarm();
 });
}
async function setupChild() {
 await seed("owner",input(1,"local",10000001));
 const identity={turn:"message",as:{userId:"10000001",nickname:"",owner:true}};
 const origin={generation:0,target:{kind:"private",userId:"10000001"},selfId:"99999999",scopeName:"",capabilities:{coding:true}};
 await runInDurableObject(env.THREAD.getByName("owner"),async(_i,s)=>{
  s.storage.sql.exec("INSERT INTO subagents(id,task,created_at,status,identity_json,origin_json,timeout_ms,deadline) VALUES(?, 'review', ?, 'done', ?, ?, 0, 0)",cid,Date.now(),JSON.stringify(identity),JSON.stringify(origin));
 });
 await env.SUBAGENT.getByName(address).start({parent:"owner",id:cid,task:"review",identity,model:{provider:"faux",id:"test"}} as any);
 await runInDurableObject(env.SUBAGENT.getByName(address),async(_i,s)=>{
  const raw=s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one();
  const meta={...JSON.parse(raw.value),status:"done",endedAt:Date.now()};
  s.storage.sql.exec("UPDATE meta SET value=? WHERE key='subagent'",JSON.stringify(meta));
  s.storage.sql.exec("DELETE FROM inbox");
  await s.storage.deleteAlarm();
 });
}
async function blob(name:string,path:string,bytes:Uint8Array) {
 const sandbox=env.SANDBOX.getByName(name), m=await sandbox.files(), hash=await sha256(bytes);
 await env.ASSETS.put((await scopePrefix(m.workspace))+"/workspace/blobs/"+hash,bytes);
 const relative=path.replace(/^\/work\//,"");
 const parts=relative.split("/"); const dirs=parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join("/"));
 expect(await sandbox.importSnapshot({expectedRevision:m.revision,manifest:{...m,files:[{path:relative,sha256:hash,bytes:bytes.length,mime:"text/plain",mode:420}],directories:dirs,totalBytes:bytes.length}})).toMatchObject({ok:true});
}
it("session MCP authority survives speaker changes, requires an explicit session grant and revokes live",async()=>{
 await seed("owner",input(1,"owner",10000001));
 async function round(n:number,user:number) {
  await seed(group,input(n,"local member",user,200000001));
  await runInDurableObject(env.THREAD.getByName("owner"),async(i,s)=>{
   const row=s.storage.sql.exec("SELECT * FROM inbound LIMIT 1").one();
   await (i as any).sendAgentMessage({to:group,text:"same peer request"},"review-"+n,row);
  });
  return runInDurableObject(env.THREAD.getByName(group),async(i,s)=>{
   const row=s.storage.sql.exec("SELECT * FROM inbound WHERE kind='agent' ORDER BY rowid DESC LIMIT 1").one();
   await s.storage.deleteAlarm();
   return (i as any).mcpAuthority(row);
  });
 }
 const a=await round(2,10000003),b=await round(3,10000004);
 expect(a).toEqual(b);
 expect(a).toMatchObject({actor:"agent:"+group,kind:"agent",owner:false,generation:0,replyChannel:"qq"});
 const c=await round(4,10000001); // Even an owner speaking in the group cannot elevate the group Agent.
 expect(c).toEqual(a);
 const decisions=await runInDurableObject(env.THREAD.getByName(group),async(i)=>{
  const policy=new McpPolicyStore((i as any).database);
  await policy.initialize();
  const server={id:"review",access:{revision:"r"},resourceAllow:["repo:"],tools:{eventAllow:[]}} as any;
  const grant={scope:group,server:"review",revision:"g",serverRevision:"r",tools:["read"],resourceAllow:[],actors:["10000003"],expiresAt:null};
  await (i as any).database.run("INSERT INTO mcp_access(scope,server_id,value_json,revision) VALUES(?,?,?,?)",group,"review",JSON.stringify(grant),"g");

  expect(await policy.allows(a,server,"read")).toBe(false);
  grant.actors=["*"];
  await (i as any).database.run("UPDATE mcp_access SET value_json=?",JSON.stringify(grant));
  expect(await policy.allows(b,server,"read")).toBe(false);
  const explicit={...grant,actors:["agent:"+group],resourceAllow:["repo:"],environments:["dev"],environmentApproval:"required"};
  const {scope,server:serverId,revision,serverRevision,...payload}=explicit;
  expect(Check(GrantInput,payload)).toBe(true);
  await (i as any).database.run("UPDATE mcp_access SET value_json=?",JSON.stringify(explicit));
  expect(await policy.environments(a,server)).toEqual({kind:"selected",envIds:["dev"]});
  expect(await policy.resourcePrefixes(a,server)).toEqual(["repo:"]);
  expect(await policy.requiresApproval(a,server,"read")).toBe(true);
  const decisions={a:await policy.allows(a,server,"read"),b:await policy.allows(b,server,"read")};
  expect(await (i as any).currentMcpAuthority(a)).toEqual(a);
  await (i as any).database.run("DELETE FROM mcp_access");
  expect(await policy.allows(a,server,"read")).toBe(false);
  expect(await policy.resourcePrefixes(a,server)).toEqual([]);
  expect(await policy.environments(a,server)).toEqual({kind:"selected",envIds:[]});
  await (i as any).database.run("UPDATE session_state SET generation=1");
  expect(await (i as any).currentMcpAuthority(a)).toBeUndefined();
  return decisions;
 });
 expect(decisions).toEqual({a:true,b:true});
 await env.THREAD.getByName(group).syncAdminView(group);
 console.log("REVIEW_AUTHORITY",JSON.stringify({a,b,decisions}));
});
it.each(["edited","deleted"])("duplicate child delivery preserves %s copies and returns the stored receipt",async(copy)=>{
 await setupChild();
 const bytes=new TextEncoder().encode("original");
 const ref=await new MediaRepository({bucket:env.ASSETS,scope:"owner"}).put({bytes,name:"review.txt",mime:"text/plain"});
 const message={id:messageId("owner","0:review-duplicate"),from:"owner",to:address,text:"file",files:[ref]};
 const path="/work/agent-files/"+message.id.slice(6)+"/0-review.txt";
 await runInDurableObject(env.THREAD.getByName("owner"),async(_i,s)=>{
  await s.storage.put("agent-sent:"+message.id,{inputHash:"fixture",message,generation:0});
 });
 // Reachable durable state after successful delivery and the receiver subsequently editing its copy.
 await runInDurableObject(env.SUBAGENT.getByName(address),async(_i,s)=>{
  s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,agent_hash,agent_files) VALUES(?,?,?,'reported',?,?)",message.id,incomingText(message,[path]),Date.now(),fingerprint(message),JSON.stringify([path]));
 });
 if(copy==="edited") await blob(address,path,new TextEncoder().encode("receiver edited"));
 const before=await env.SANDBOX.getByName(address).files();

 const receipts=await runInDurableObject(env.SUBAGENT.getByName(address),async(i)=>Promise.all([i.agentReceive(message),i.agentReceive(message)]));
 expect(receipts).toEqual([0,1].map(()=>({messageId:message.id,status:"duplicate",files:[path]})));
 expect(await env.SANDBOX.getByName(address).files()).toEqual(before);
 const conflict={...message,text:"different"};
 await runInDurableObject(env.THREAD.getByName("owner"),async(_i,s)=>{
  await s.storage.put("agent-sent:"+message.id,{inputHash:"fixture",message:conflict,generation:0});
 });
 await runInDurableObject(env.SUBAGENT.getByName(address),async(i,s)=>{
  await expect(i.agentReceive(conflict)).rejects.toThrow("agent_message_conflict");
  await s.storage.deleteAlarm();
 });
 console.log("REVIEW_DUPLICATE",copy,JSON.stringify(receipts));
});
it.each(["reset","stop"])("retires an answered report after parent %s without heartbeat retries",async(mode)=>{
 await setupChild();
 await runInDurableObject(env.THREAD.getByName("owner"),async(_i,s)=>{if(mode==="reset") s.storage.sql.exec("UPDATE session_state SET generation=1"); else s.storage.sql.exec("UPDATE subagents SET status='cancelled'");});
 await runInDurableObject(env.SUBAGENT.getByName(address),async(i,s)=>{
  s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('task','review',?,'answered','finished','done')",Date.now());
  const meta=JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
  const row=s.storage.sql.exec("SELECT * FROM inbox").one();
  await (i as any).report(meta,row);
  expect(await (i as any).step()).toBe(false);
  await (i as any).update(async()=>false);
  expect(s.storage.sql.exec<any>("SELECT status FROM inbox").one().status).toBe("cancelled");
  const alarm=await s.storage.getAlarm();
  expect(alarm).not.toBeNull();
  expect(alarm!-Date.now()).toBeGreaterThan(60_000);
  console.log("REVIEW_REVOKED_REPORT",JSON.stringify({status:"cancelled",nextInMs:alarm!-Date.now()}));
  await s.storage.deleteAlarm();
 });
});

it("unknown report delivery stays answered and retries",async()=>{
 await setupChild();
 await runInDurableObject(env.SUBAGENT.getByName(address),async(i,s)=>{
  s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('task','review',?,'answered','finished','done')",Date.now());
  const meta=JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
  const row=s.storage.sql.exec("SELECT * FROM inbox").one();
  const send=vi.spyOn(i as any,"sendAgentMessage").mockRejectedValue(new Error("agent_delivery_unknown"));
  await expect((i as any).report(meta,row)).rejects.toThrow("agent_delivery_unknown");
  expect(s.storage.sql.exec<any>("SELECT status FROM inbox").one().status).toBe("answered");
  await (i as any).update(async()=>false);
  expect((await s.storage.getAlarm())!-Date.now()).toBeLessThanOrEqual(60_000);
  send.mockRestore();
  await s.storage.deleteAlarm();
 });
});

it("replays an actual inbox delivery whose receipt was lost after insertion",async()=>{
 await setupChild();
 const message={id:messageId("owner","0:lost-receipt"),from:"owner",to:address,text:"message",files:[]};
 await runInDurableObject(env.THREAD.getByName("owner"),async(i,s)=>{
  await s.storage.put("agent-sent:"+message.id,{inputHash:"fixture",message,generation:0});
 });
 await runInDurableObject(env.SUBAGENT.getByName(address),async(i)=>{
  const original=i.message.bind(i);
  const receive=vi.spyOn(i,"message").mockImplementationOnce(async(...args)=>{
   await original(...args);
   throw new Error("synthetic_receipt_lost");
  });
  try { await expect(i.agentReceive(message)).rejects.toThrow("synthetic_receipt_lost"); }
  finally { receive.mockRestore(); }
 });
 await runInDurableObject(env.SUBAGENT.getByName(address),async(_i,s)=>{
  expect(s.storage.sql.exec<any>("SELECT agent_hash FROM inbox WHERE request_id=?",message.id).one().agent_hash).toBe(fingerprint(message));
  await s.storage.deleteAlarm();
 });
 await runInDurableObject(env.SUBAGENT.getByName(address),async(i,s)=>{
  expect(await i.agentReceive(message)).toEqual({messageId:message.id,status:"duplicate",files:[]});
  await s.storage.deleteAlarm();
 });
});
