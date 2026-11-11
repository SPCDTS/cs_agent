import { env, reset, runInDurableObject, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { RequestsDO } from "../src/requests/do";
import { ThreadDO } from "../src/thread";
import { threadView } from "../src/admin/read-views";
import { ModelAlarm } from "../src/model-alarm";
afterEach(async()=>{vi.restoreAllMocks();await reset();});
const admin=(path:string)=>worker.fetch(new Request("https://test"+path,{headers:{Authorization:"Bearer test"}}),{...env,ADMIN_TOKEN:"test"});
it("未同步的查询返回待同步，不唤醒执行 DO",async()=>{
  const chat=vi.spyOn(ThreadDO.prototype,"chatView");const stats=vi.spyOn(ThreadDO.prototype,"stats");
  const response=await admin("/admin/threads/owner/chat");expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"view_pending"});
  expect((await worker.fetch(new Request("https://test/healthz"),env)).status).toBe(200);
  expect(chat).not.toHaveBeenCalled();expect(stats).not.toHaveBeenCalled();
});
it("聊天与记忆增量同步，管理查询不回调执行对象",async()=>{
  const owner=env.THREAD.getByName("owner"),view=threadView(env,"owner");
  await owner.submitWeb("owner","projection-test","展示同步");
  await expect.poll(async()=>{try{return(await view.chatView("owner")).messages.some(m=>m.role==="assistant");}catch{return false;}}).toBe(true);
  await owner.importMemory({ns:"owner",memories:[{id:1,kind:"fact",text:"这是展示同步测试",author:"test"}]});
  await owner.syncAdminView("owner");
  const chat=vi.spyOn(ThreadDO.prototype,"chatView").mockRejectedValue(new Error("execution_read_forbidden"));
  const stats=vi.spyOn(ThreadDO.prototype,"stats").mockRejectedValue(new Error("execution_read_forbidden"));
  const events=vi.spyOn(ThreadDO.prototype,"events").mockRejectedValue(new Error("execution_read_forbidden"));
  for(const path of ["/admin/threads/owner/chat","/admin/threads/owner/history","/admin/events?thread=owner","/admin/memory/list?ns=owner","/admin/overview"]){expect((await admin(path)).status,path).toBe(200);}
  expect((await view.memoryList("owner",{})).items.some(row=>row.text==="这是展示同步测试")).toBe(true);
  expect(chat).not.toHaveBeenCalled();expect(stats).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();
});
it("alarm 出站保留字节与流，取消已排队请求不会发到上游",async()=>{
  await runInDurableObject(env.THREAD.getByName("transport-test"),async(_instance,state)=>{
    const gate=new ModelAlarm(state),upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{
      expect([...new Uint8Array(init!.body as ArrayBuffer)]).toEqual([1,2,3]);
      return new Response("data: done\n\n",{headers:{"content-type":"text/event-stream"}});
    });
    const response=gate.fetch("https://chatgpt.com/backend-api/codex/responses",{method:"POST",body:new Uint8Array([1,2,3])});
    await new Promise(resolve=>setTimeout(resolve,0));gate.dispatch();
    expect(await(await response).text()).toBe("data: done\n\n");
    const controller=new AbortController();
    const cancelled=gate.fetch("https://chatgpt.com/backend-api/codex/responses",{signal:controller.signal}).then(()=>false,()=>true);
    expect(gate.pending).toBe(true);controller.abort();gate.dispatch();
    expect(await cancelled).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);await state.storage.deleteAlarm();
  });
});

it("同步失败保留变更，执行对象重启后补齐且更新删除不会留下旧记忆",async()=>{
  const owner=env.THREAD.getByName("owner"),view=threadView(env,"owner");
  const fail=vi.spyOn(RequestsDO.prototype,"applyProjection").mockRejectedValue(new Error("display_offline"));
  await owner.importMemory({ns:"owner",memories:[{id:1,kind:"fact",text:"需要同步的记忆",author:"test"}]});
  const error = await owner.syncAdminView("owner").then(() => "", error => error.message);
  expect(error).toContain("view_sync_failed");
  expect(await runInDurableObject(owner,(_instance,state)=>state.storage.sql.exec("SELECT 1 FROM admin_projection_changes").toArray().length)).toBeGreaterThan(0);
  fail.mockRestore();await evictDurableObject(owner);await runDurableObjectAlarm(owner);
  await expect.poll(async()=>{try{return(await view.memoryView("owner","需要同步")).memories.length;}catch{return 0;}}).toBe(1);
  await runInDurableObject(owner,(_instance,state)=>state.storage.sql.exec("UPDATE memories SET text='已经更新的记忆' WHERE id=1").toArray());
  await owner.syncAdminView("owner");
  expect((await view.memoryView("owner","需要同步")).memories).toEqual([]);
  expect((await view.memoryView("owner","已经更新")).memories).toHaveLength(1);
  await runInDurableObject(owner,(_instance,state)=>state.storage.sql.exec("DELETE FROM memories WHERE id=1").toArray());
  await owner.syncAdminView("owner");expect((await view.memoryList("owner",{})).items).toEqual([]);
});
