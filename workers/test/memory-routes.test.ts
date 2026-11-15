import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryAdminRoutes } from "../src/admin/memory-routes";
import type { AdminContext } from "../src/admin/routes";

const context = (path: string, params: Record<string, string> = {}): AdminContext => {
  const request = new Request("https://test" + path);
  return { env, request, url: new URL(request.url), params };
};
describe("memory admin route boundaries", () => {
  it("supports private namespaces and returns expected HTTP codes after RPC erases Error prototypes", async () => {
    for (const [code, status] of [["not_found", 404], ["conflict", 409], ["invalid", 400]] as const) {
      const routes = createMemoryAdminRoutes(() => { throw new Error(`memory_admin:${code}`); });
      const list = routes.find(r => r.path === "/admin/memory/list")!;
      const response = await list.handle(context("/admin/memory/list?ns=private:10000003"));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }
  });
  it("rejects invalid namespaces and malformed cursor/page values before a Thread RPC", async () => {
    let called = 0;
    const routes = createMemoryAdminRoutes(() => { called++; throw new Error("should_not_call"); });
    const list = routes.find(r => r.path === "/admin/memory/list")!;
    for (const path of ["/admin/memory/list?ns=../owner", "/admin/memory/list?ns=owner&cursor=-1", "/admin/memory/list?ns=owner&limit=101", "/admin/memory/list?ns=owner&kind=invalid"]) {
      const response = await list.handle(context(path));
      expect(response.status).toBe(400);
    }
    expect(called).toBe(0);
  });
});

afterEach(()=>reset());
it("管理接口写入经镜像可读，过期编辑返回冲突，候选来源保留",async()=>{
 const {default:worker}=await import("../src/index");
 const {DurableObjectSqliteDatabase}=await import("@earendil-works/pi-durable/storage/sqlite/cloudflare");
 const {MemoryStore}=await import("../src/memory/store");
 const {applyExtraction}=await import("../src/memory/extractor");
 const call=(method:string,path:string,value?:unknown)=>worker.fetch(new Request("https://test/admin/memory"+path,{method,headers:{Authorization:"Bearer synthetic-admin"},...(value===undefined?{}:{body:JSON.stringify(value)})}),{...env,ADMIN_TOKEN:"synthetic-admin"});
 const created=await call("POST","/entries?ns=owner",{kind:"preference",text:"喜欢旧咖啡",subject:"self"});expect(created.status).toBe(200);
 const row=await created.json<{id:number}>(),path="/"+row.id+"?ns=owner";
 const detail=await call("GET",path);expect(detail.status).toBe(200);const current=await detail.json<{revision:number}>();
 expect((await call("PUT",path,{entry:{kind:"preference",text:"喜欢红茶",subject:"self"},expectedVersion:current.revision})).status).toBe(200);
 expect((await call("PUT",path,{entry:{kind:"preference",text:"过期修改"},expectedVersion:current.revision})).status).toBe(409);
 expect((await call("DELETE",path,{expectedVersion:current.revision})).status).toBe(409);
 const thread=env.THREAD.getByName("owner");
 await runInDurableObject(thread,async(_instance,state)=>{
  const store=new MemoryStore(new DurableObjectSqliteDatabase(state.storage),"owner");
  await applyExtraction(store,"source-turn",[{kind:"preference",text:"喜欢绿茶",subject:"self",confidence:1,supersedes:row.id,source_message_id:"source",quote:"喜欢绿茶"}],
   [{text:"喜欢绿茶",nickname:"测试",user_id:"10000001",received_at:1900000000,platform_message_id:"source",chat_kind:"private",chat_id:"10000001"}],[{id:row.id,version:await store.revision(row.id)}]);
 });
 await thread.syncAdminView("owner");
 const pending=await call("GET","/candidates?ns=owner");expect(pending.status).toBe(200);const {candidates}=await pending.json<{candidates:{id:number}[]}>();expect(candidates).toHaveLength(1);
 expect((await call("POST","/candidates/"+candidates[0].id+"/accept?ns=owner")).status).toBe(200);
 const list=await(await call("GET","/list?ns=owner")).json<{items:{id:number;text:string}[]}>();expect(list.items).toHaveLength(1);expect(list.items[0].text).toBe("喜欢绿茶");
 const accepted=await(await call("GET","/"+list.items[0].id+"?ns=owner")).json<{evidence:{quote:string}[]}>();expect(accepted.evidence[0].quote).toBe("喜欢绿茶");
 expect((await call("DELETE","/"+list.items[0].id+"?ns=owner")).status).toBe(200);
});
