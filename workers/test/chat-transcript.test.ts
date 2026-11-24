import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { seedChatTranscript } from "./fixtures/chat-transcript";
import worker from "../src/index";

afterEach(reset);
it("会话对话以本 root 已放置的 transcript 为准，并区分收件、发送回执和真实平台消息",async()=>{
  const owner=env.THREAD.getByName("owner");
  await owner.syncAdminView("owner");
  await runInDurableObject(owner,(_instance,state)=>{
    seedChatTranscript(state.storage.sql);
  });
  await owner.syncAdminView("owner");
  const read=async(query="")=>{
    const res=await worker.fetch(new Request("https://test/admin/threads/owner/chat"+query,{headers:{Authorization:"Bearer test"}}),{...env,ADMIN_TOKEN:"test"});
    expect(res.status).toBe(200);return await res.json() as {delta:boolean;revision:number;messages:{id:string;text:string;source:string;status:string;at:number}[]};
  };
  const {messages}=await read(),dump=JSON.stringify(messages);
  for(const text of ["收件合成正文","子报告合成正文","合成静默事件","发件合成正文","合成 QQ 消息","已放置的网页原文"])expect(dump).toContain(text);
  for(const text of ["合成网页消息","隐藏推理","隐藏系统","隐藏路径","内部策略","宿主说明","仅入箱:","别的会话正文","synthetic-secret-value","agent_credentials_forbidden"])expect(dump).not.toContain(text);
  expect(messages.filter(m=>m.id==="sent:agent:"+"a".repeat(64))).toHaveLength(1);
  expect(messages.filter(m=>m.source==="agent-out").map(m=>m.status)).toEqual(["accepted","failed"]);
  expect(messages.filter(m=>m.source==="model").map(m=>m.text)).toEqual(["合成模型回答"]);
  const pending=messages.find(m=>m.status==="waiting")!;
  expect((await read("?after="+(Date.now()+100000)+"&pending="+encodeURIComponent(pending.id))).messages.map(m=>m.id)).toEqual([pending.id]);
  expect(messages.map(m=>m.at)).toEqual(messages.map(m=>m.at).sort((a,b)=>a-b));
  const page=await read();expect(page.messages).toEqual(messages);
  // 老投影不能只按时间取增量，否则补写的旧 transcript 或消失的队列项会永远留错。
  const stale=await read("?after="+(Date.now()+100000)+"&revision="+(page.revision-1));
  expect(stale.delta).toBe(false);expect(stale.messages).toEqual(messages);
  expect(new Set(messages.map(m=>m.id)).size).toBe(messages.length);
  await runInDurableObject(owner,(_instance,state)=>{
    expect(state.storage.sql.exec<{text:string}>("SELECT text FROM messages").toArray().map(r=>r.text)).toEqual(["合成 QQ 消息"]);
    state.storage.sql.exec("DELETE FROM inbound WHERE message_id LIKE 'evt_github_%'");
  });
  await owner.syncAdminView("owner");
  const retained=(await read()).messages.find(m=>m.source==="github");
  expect(retained).toMatchObject({id:messages.find(m=>m.source==="github")!.id,status:null,text:expect.stringContaining("合成静默事件")});
});
