// Adapted from the independent a7fe330 reproductions; assert corrected behavior on the current implementation.
import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { input } from "./helpers";
import { runtime } from "./sandbox-runtime-fixture";
import { messageId, redactReport } from "../src/communication/model";
import { SENT_LIMIT } from "../src/communication/service";
import { MediaRepository } from "../src/media/repository";

const group = "group:200000001", cid = "11111111-1111-4111-8111-111111111111";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function seed(scope: string, user = 10000001, n = 1) {
  await runInDurableObject(env.THREAD.getByName(scope), async (i, s) => {
    await (i as any).queueInput(input(n, "local", user, scope === group ? 200000001 : undefined));
    s.storage.sql.exec("UPDATE inbound SET turn_id='test-turn',status='done'");
    await s.storage.deleteAlarm();
  });
}
async function send(from: string, to: string, seedId = "message", text = "hello", kind?: string) {
  return runInDurableObject(env.THREAD.getByName(from), async (i, s) => {
    const row = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='message' ORDER BY rowid DESC LIMIT 1").one();
    return (i as any).sendAgentMessage({ to, text }, seedId, { ...row, ...(kind ? { kind } : {}) });
  });
}
async function child(parent = "owner") {
  await seed(parent);
  const identity = { turn: "message", as: { userId: "10000001", nickname: "", owner: true } };
  const origin = { generation: 0, target: parent === group ? { kind: "group", groupId: "200000001" } : { kind: "private", userId: "10000001" }, selfId: "99999999", scopeName: "", capabilities: { coding: parent === "owner" } };
  await runInDurableObject(env.THREAD.getByName(parent), async (_i, s) => {
    s.storage.sql.exec("INSERT INTO subagents(id,task,created_at,status,identity_json,origin_json,timeout_ms,deadline) VALUES(?,'test',?,'done',?,?,0,0)", cid, Date.now(), JSON.stringify(identity), JSON.stringify(origin));
  });
  const address = "sub:" + parent + ":" + cid;
  await env.SUBAGENT.getByName(address).start({ parent, id: cid, task: "test", identity, model: { provider: "faux", id: "test" } } as any);
  await runInDurableObject(env.SUBAGENT.getByName(address), async (_i, s) => {
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    s.storage.sql.exec("UPDATE meta SET value=? WHERE key='subagent'", JSON.stringify({ ...meta, status: "done" }));
    s.storage.sql.exec("DELETE FROM inbox");
    await s.storage.deleteAlarm();
  });
  return { address, identity, origin };
}

import { SandboxDO } from "../src/sandbox/do";
import { sha256 } from "../src/media/model";
import { assertNoCredentials } from "../src/communication/model";
import { createCodingExtension } from "../src/tools/coding";

async function wire(sandbox: ReturnType<typeof env.SANDBOX.getByName>, failSecond = false) {
  return runInDurableObject(sandbox, async (instance)=>{ const i=instance as any;
    const host = runtime(), snapshot = host.client.snapshot.bind(host.client);
    let snapshots = 0;
    host.client.snapshot = async (...args: any[]) => {
      snapshots++;
      if (failSecond && snapshots === 2) throw new Error("synthetic_snapshot_outage");
      return snapshot(...args);
    };
    i.reviewSnapshots = () => snapshots;
    Object.assign(i.workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
  });
}
async function fileFixture(target: "group" | "child") {
  const to = target === "child" ? (await child()).address : group;
  if (target === "group") { await seed("owner"); await seed(group, 10000003); }
  const files = await Promise.all(["one", "two"].map(name => new MediaRepository({bucket:env.ASSETS,scope:"owner"}).put({bytes:new TextEncoder().encode(name),name:name+".txt",mime:"text/plain"})));
  const message = {id:messageId("owner","independent-"+target),from:"owner",to,text:"files",files};
  await runInDurableObject(env.THREAD.getByName("owner"),(_i,s)=>s.storage.put("agent-sent:"+message.id,{inputHash:"fixture",message,generation:0}));
  const recipient = target === "child" ? env.SUBAGENT.getByName(to) : env.THREAD.getByName(to);
  const sandbox = env.SANDBOX.getByName(to);
  const paths=files.map((f,n)=>"/work/agent-files/"+message.id.slice(6)+"/"+n+"-"+f.name);
  return {message,recipient,sandbox,paths};
}
async function receiveError(recipient:any,message:any) {
  return runInDurableObject(recipient,async (instance)=>{ const i=instance as any;
    try { await i.agentReceive(message); return "accepted"; } catch(e) { return (e as Error).message; }
  });
}
it("owner receives a valid group attachment and reads only that attachment without a sandbox task",async()=>{
  await seed("owner"); await seed(group,10000003);
  const file=await new MediaRepository({bucket:env.ASSETS,scope:group}).put({bytes:new TextEncoder().encode("public attachment"),name:"public.txt",mime:"text/plain"});
  const message={id:messageId(group,"owner-file"),from:group,to:"owner",text:"file",files:[file]};
  await runInDurableObject(env.THREAD.getByName(group),(_i,s)=>s.storage.put("agent-sent:"+message.id,{inputHash:"fixture",message,generation:0}));
  expect(await receiveError(env.THREAD.getByName("owner"),message)).toBe("accepted");
  await runInDurableObject(env.THREAD.getByName("owner"),async (instance,s)=>{ const i=instance as any;
    const row=s.storage.sql.exec<any>("SELECT * FROM inbound WHERE message_id=?",message.id).one();
    expect(await i.sandboxTaskForInput(row)).toBeUndefined();
    expect(new TextDecoder().decode((await i.readAgentBlob(row,JSON.parse(row.agent_files)[0])).bytes)).toBe("public attachment");
    await expect(i.readAgentBlob(row,"/work/private.txt")).rejects.toThrow("agent_file_access_denied");
    await s.storage.deleteAlarm();
  });
});
it("text communication cannot grant group coding, while the human group turn retains its task",async()=>{
  await seed("owner"); await seed(group,10000003);
  await send("owner",group);
  const sandbox=env.SANDBOX.getByName(group); await wire(sandbox);
  await runInDurableObject(env.THREAD.getByName(group),async (instance,s)=>{ const i=instance as any;
    const peer=s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='agent'").one();
    expect(s.storage.sql.exec("SELECT * FROM mcp_access").toArray()).toEqual([]);
    const task=await i.sandboxTaskForInput(peer);
    expect(task).toBeUndefined();
    const human=s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='message'").one();
    expect((await i.sandboxTaskForInput(human)).permissions.coding).toBe(true);
    const ext=createCodingExtension({allowed:async()=>!!(await i.sandboxTaskForInput(peer))?.permissions.coding,sandbox:()=>env.SANDBOX.getByName(group),record:async()=>{}});
    const write=(ext as any).tools.find((t:any)=>t.name==="write");
    const out=await write.execute({path:"/work/not-an-attachment.txt",content:"unexpected-write"},{taskId:"proof-write"},{});
    expect(out).toHaveProperty("isError",true);
    expect((await env.SANDBOX.getByName(group).files()).files).toHaveLength(0);
    const exec=(ext as any).tools.find((t:any)=>t.name==="bash");
    expect(await exec.execute({command:"echo forbidden"},{taskId:"proof-exec"},{})).toHaveProperty("isError",true);
    await s.storage.deleteAlarm();
  });
});
it.each(["group","child"] as const)("%s attachment import no longer invokes the failing second container snapshot",async target=>{
  const f=await fileFixture(target); await wire(f.sandbox,true);
  expect(await receiveError(f.recipient,f.message)).toBe("accepted");
  await runInDurableObject(f.sandbox,async (instance,s)=>{ const i=instance as any;
    expect(i.reviewSnapshots()).toBe(0);
    expect((await s.storage.list({prefix:"workspace:op:"})).size).toBe(0);
    const rebuilt=new SandboxDO(s,env);
    await rebuilt.saveAttachment(f.paths[1]!,new TextEncoder().encode("two"),"agent-import:"+f.message.id+":1");
    expect(new TextDecoder().decode((await rebuilt.readBlob(f.paths[1]!)).bytes)).toBe("two");
  });
  expect((await f.recipient.agentReceive(f.message)).status).toBe("duplicate");
  await runInDurableObject(f.recipient,(_i,s)=>s.storage.deleteAlarm());
});
it.each(["group","child"] as const)("%s recovers a real second attachment R2 failure across SandboxDO reconstruction",async target=>{
  const f=await fileFixture(target), hash=await sha256(new TextEncoder().encode("two"));
  await runInDurableObject(f.sandbox,async (instance)=>{ const i=instance as any;
    const bucket=i.workspace.deps.bucket;
    i.workspace.deps.bucket=new Proxy(bucket,{get(target,prop){
      if(prop==="put")return async(...args:any[])=>{if(args[0].endsWith("/blobs/"+hash))throw new Error("synthetic_r2_outage");return target.put(...args);};
      const value=Reflect.get(target,prop);return typeof value==="function"?value.bind(target):value;
    }});
  });
  expect(await receiveError(f.recipient,f.message)).toBe("synthetic_r2_outage");
  expect(new TextDecoder().decode((await f.sandbox.readBlob(f.paths[0]!)).bytes)).toBe("one");
  await runInDurableObject(f.sandbox,async(_i,s)=>{
    const rebuilt=new SandboxDO(s,env);
    await rebuilt.saveAttachment(f.paths[1]!,new TextEncoder().encode("two"),"agent-import:"+f.message.id+":1");
    expect(new TextDecoder().decode((await rebuilt.readBlob(f.paths[1]!)).bytes)).toBe("two");
  });
  expect((await f.recipient.agentReceive(f.message)).status).toBe("accepted");
  expect((await f.recipient.agentReceive(f.message)).status).toBe("duplicate");
  await runInDurableObject(f.recipient,(_i,s)=>s.storage.deleteAlarm());
});
it.each(["group","child"] as const)("%s SQL failure then delete, 33 operations, fresh SandboxDO: no overwrite or resurrection",async target=>{
  const f=await fileFixture(target); await wire(f.sandbox);
  const table=target==="child"?"inbox":"inbound";
  await runInDurableObject(f.recipient,(_i,s)=>s.storage.sql.exec("CREATE TRIGGER reviewer_fail BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'reviewer_sql_failure'); END"));
  expect(await receiveError(f.recipient,f.message)).toContain("reviewer_sql_failure");
  await f.sandbox.run({operationId:"delete-first",operation:{kind:"remove",path:f.paths[0]!}});
  for(let n=0;n<33;n++)await f.sandbox.writeFile("/work/later.txt",String(n),"expire-"+n);
  await runInDurableObject(f.sandbox,async(_i,s)=>{
    const rebuilt=new SandboxDO(s,env),host=runtime();
    Object.assign((rebuilt as any).workspace.deps,{runtime:host.client,resetRuntime:host.reset,runtimeReady:host.ready});
    await rebuilt.saveAttachment(f.paths[0]!,new TextEncoder().encode("one"),"agent-import:"+f.message.id+":0");
    await expect(rebuilt.readBlob(f.paths[0]!)).rejects.toThrow("not_found");
    expect(new TextDecoder().decode((await rebuilt.readBlob(f.paths[1]!)).bytes)).toBe("two");
  });
  await runInDurableObject(f.recipient,(_i,s)=>s.storage.sql.exec("DROP TRIGGER reviewer_fail"));
  expect((await f.recipient.agentReceive(f.message)).status).toBe("accepted");
  expect(await runInDurableObject(f.sandbox,async(i)=>{try{await i.readBlob(f.paths[0]!);return "present";}catch(e){return (e as Error).message;}})).toBe("not_found");
  expect(new TextDecoder().decode((await f.sandbox.readBlob(f.paths[1]!)).bytes)).toBe("two");
  await runInDurableObject(f.recipient,(_i,s)=>s.storage.deleteAlarm());
});
it("unknown container command remains unknown across real SandboxDO reconstruction and is not replayed",async()=>{
  await runInDurableObject(env.SANDBOX.getByName("review-unknown"),async (instance,s)=>{ const i=instance as any;
    const host=runtime();host.fail();
    Object.assign(i.workspace.deps,{runtime:host.client,resetRuntime:host.reset,runtimeReady:host.ready});
    const command={operationId:"lost-command",operation:{kind:"exec" as const,command:"unknown"}};
    expect((await i.run(command)).status).toBe("unknown");
    const rebuilt=new SandboxDO(s,env);
    Object.assign((rebuilt as any).workspace.deps,{runtime:host.client,resetRuntime:host.reset,runtimeReady:host.ready});
    expect((await rebuilt.run(command)).status).toBe("unknown");
    expect(host.executions()).toBe(1);
  });
});
it.each(["owner",group])("known YAML password block is completely redacted in automatic report to %s",async parent=>{
  const {address}=await child(parent);
  // Use literal newlines, a standard structured credential shape, never real secrets.
  const source=["password: |","  SYNTHETIC_BLOCK_VALUE_123456","end"].join("\n");
  expect(()=>assertNoCredentials(source)).toThrow("agent_credentials_forbidden");
  expect(redactReport(source)).not.toContain("SYNTHETIC_BLOCK_VALUE_123456");
  await runInDurableObject(env.SUBAGENT.getByName(address),async (instance,s)=>{ const i=instance as any;
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('yaml','task',?,'answered',?,'done')",Date.now(),source);
    await i.report(JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value),s.storage.sql.exec("SELECT * FROM inbox WHERE request_id='yaml'").one());
    expect(s.storage.sql.exec("SELECT status,outcome FROM inbox WHERE request_id='yaml'").one()).toMatchObject({status:"reported",outcome:"done"});
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.THREAD.getByName(parent),async(_i,s)=>{
    const report=s.storage.sql.exec<any>("SELECT text FROM inbound WHERE kind='subagent'").one().text;
    expect(report).not.toContain("SYNTHETIC_BLOCK_VALUE_123456");
    expect(report).toContain("end");
    expect(report).toContain("已隐藏");
    await s.storage.deleteAlarm();
  });
});
it("capacity remains full after successful pending retry; existing proof survives but new IDs stay rejected",async()=>{
  await seed("owner");
  await expect(send("owner",group,"pending-limit")).rejects.toThrow("agent_recipient_not_ready");
  await runInDurableObject(env.THREAD.getByName("owner"),async(_i,s)=>{
    for(let n=0;n<SENT_LIMIT-1;n++)await s.storage.put("agent-sent:review-"+n,{generation:0,inputHash:"fixture",hash:"fixture"});
  });
  await seed(group,10000003);
  expect((await send("owner",group,"pending-limit")).status).toBe("accepted");
  for(let n=0;n<2;n++)await expect(send("owner",group,"new-"+n)).rejects.toThrow("agent_history_full");
  expect((await send("owner",group,"pending-limit")).status).toBe("duplicate");
  await runInDurableObject(env.THREAD.getByName("owner"),async (instance,s)=>{ const i=instance as any;
    const rows=await s.storage.list<any>({prefix:"agent-sent:"});expect(rows.size).toBe(SENT_LIMIT);
    const [key,p]=[...rows].find(([,v])=>v.receipt)!;expect(await i.agentProof(key.slice(11),p.hash)).toBe(true);
  });
});
it("rejected Agent followup cannot contaminate original owner retry or concurrent original report",async()=>{
  const {address,identity}=await child();
  await runInDurableObject(env.THREAD.getByName("owner"),async i=>{await expect(i.agentChildNarrow(cid)).rejects.toThrow("agent_child_identity_denied");});
  await Promise.all([
    send("owner",address,"owner-after-narrow"),
    env.THREAD.getByName("owner").subagentReport({subagentId:cid,requestId:"stale",text:"old",identity,outcome:"done",state:{status:"done",version:2}} as any)
  ]);
  await runInDurableObject(env.THREAD.getByName("owner"),async (instance,s)=>{ const i=instance as any;
    expect(JSON.parse(s.storage.sql.exec<any>("SELECT identity_json FROM subagents WHERE id=?",cid).one().identity_json)).toEqual(identity);
    // 与真实 admission 一样先绑定 turn；否则 MCP 会仅因尚未接纳而返回 undefined。
    s.storage.sql.exec("UPDATE inbound SET turn_id='review-report-turn' WHERE kind='subagent'");
    const report=s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='subagent'").one();
    expect(report.user_id).toBe("10000001");
    expect((await i.mcpAuthority(report)).owner).toBe(true);
    expect((await i.scheduleAccess(report)).kind).toBe("manage");
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.SUBAGENT.getByName(address),(_i,s)=>s.storage.deleteAlarm());
});


it.each([
  ["literal", "password: |\n  SYNTHETIC_A\n  SYNTHETIC_B\nvisible: keep", true],
  ["folded", "password: >-\n  SYNTHETIC_A\n  SYNTHETIC_B\nvisible: keep", true],
  ["indent and CRLF", "nested:\r\n  access_token: |2+\r\n    SYNTHETIC_A\r\n  visible: keep", true],
  ["sequence", "- client_secret: >\n    SYNTHETIC_A\n  visible: keep", true],
  ["plain continuation", "password: SYNTHETIC_A\n  SYNTHETIC_B\nvisible: keep", true],
  ["empty and continuation", "password:\n  SYNTHETIC_A\nvisible: keep", true],
  ["escaped quote", 'password: "SYNTHETIC_A\\"SYNTHETIC_B"\nvisible: keep', true],
  ["YAML doubled quote", "password: 'SYNTHETIC_A''SYNTHETIC_B'\nvisible: keep", true],
  ["escaped newline", 'password: "SYNTHETIC_A\\\nSYNTHETIC_B"\nvisible: keep', true],
  ["unclosed quote", 'password: "SYNTHETIC_A\n  SYNTHETIC_B\nambiguous continuation', false],
  ["unclosed inline JSON", '{"password": "SYNTHETIC_A\nSYNTHETIC_B', false],
])("redacts complete credential values: %s", (_name, source, closed) => {
  const out = redactReport("before: retained\n" + source);
  expect(out).not.toContain("SYNTHETIC_");
  expect(out).toContain("before: retained");
  expect(out).toContain("已隐藏");
  expect(out).toContain(closed ? "visible: keep" : "后续内容已隔离");
  expect(redactReport(out)).toBe(out);
});
