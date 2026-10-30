import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../src/sandbox/workspace";
import { sandboxClient } from "../src/sandbox/client";
import { sha256 } from "../src/media/model";
afterEach(async () => { await reset(); });
function runtime() {
  let files = new Map<string,Uint8Array>(), stage = new Map<string,Uint8Array>(), ready = false, executions = 0, failExec = false;
  const client = sandboxClient(async (route, init) => {
    ready = true;
    const url = new URL(route,"http://sandbox"), path = (url.searchParams.get("path") ?? "").replace(/^\/work\//,"");
    switch(url.pathname) {
      case "/restore/start": stage = new Map(); return Response.json({id:"r"});
      case "/restore/blob": if (!(init?.body instanceof Uint8Array)) throw new Error("body"); stage.set(path,new Uint8Array(init.body)); return Response.json({bytes:init.body.length});
      case "/restore/commit": files = stage; return Response.json({restored:true});
      case "/file": if(init?.method === "PUT") { const value = new TextEncoder().encode(String(init.body)); files.set(path,value); return Response.json({bytes:value.length}); } return Response.json({text:new TextDecoder().decode(files.get(path)),startLine:1,endLine:1,totalLines:1});
      case "/exec": executions++; if(failExec) { failExec=false; throw new Error("sandbox_unavailable"); } files.set("binary.bin",new Uint8Array([0,255,1])); return Response.json({stdout:"ok",stderr:"",code:0,timedOut:false,truncated:false});
      case "/blob": return new Response(files.get(path));
      case "/snapshot": { const entries = await Promise.all([...files].map(async ([path,bytes])=>({path,bytes:bytes.length,sha256:await sha256(bytes),mime:"application/octet-stream",mode:420}))); return Response.json({files:entries,directories:[],totalBytes:entries.reduce((sum,file)=>sum+file.bytes,0)}); }
      default: return Response.json([]);
    }
  });
  return { client, ready:()=>ready, reset:async()=>{ready=false;files=new Map();return true;}, executions:()=>executions, fail:()=>{failExec=true;} };
}
describe("持久工作区", () => {
  it("write/exec差量持久化、运行时重建、稳定操作幂等且冲突参数拒绝", async () => {
    await runInDurableObject(env.SANDBOX.getByName("persistence-test"),async (_instance,state)=>{
      const first=runtime(), deps={workspace:"workspace:test",bucket:env.ASSETS,storage:state.storage,runtime:first.client,resetRuntime:first.reset,runtimeReady:first.ready};
      const manager=new WorkspaceManager(deps);
      const write=await manager.run({operationId:"w",operation:{kind:"write",path:"note.txt",text:"中文"}}); expect(write.status).toBe("committed");
      const execute={operationId:"e",operation:{kind:"exec" as const,command:"create binary"}};
      const result=await manager.run(execute); expect(result.status).toBe("committed"); expect(await manager.run(execute)).toEqual(result); expect(first.executions()).toBe(1);
      await expect(manager.run({...execute,operation:{kind:"exec",command:"different"}})).rejects.toThrow("operation_conflict");
      const second=runtime(), rebuilt=new WorkspaceManager({...deps,runtime:second.client,resetRuntime:second.reset,runtimeReady:second.ready});
      expect((await rebuilt.readBlob("binary.bin")).bytes).toEqual(new Uint8Array([0,255,1]));
      const read=await rebuilt.run({operationId:"read",operation:{kind:"read",path:"note.txt"}}); expect(read).toMatchObject({status:"committed",result:{text:"中文"}});
      expect(second.executions()).toBe(0);
    });
  });
  it("命令失联保存unknown，重建后相同ID不再次执行", async()=>{
    await runInDurableObject(env.SANDBOX.getByName("unknown-test"),async (_instance,state)=>{
      const host=runtime();host.fail();const deps={workspace:"workspace:unknown",bucket:env.ASSETS,storage:state.storage,runtime:host.client,resetRuntime:host.reset,runtimeReady:host.ready};
      const input={operationId:"uncertain",operation:{kind:"exec" as const,command:"side effect"}};
      expect((await new WorkspaceManager(deps).run(input)).status).toBe("unknown");
      expect((await new WorkspaceManager(deps).run(input)).status).toBe("unknown");expect(host.executions()).toBe(1);
    });
  });
  it("父子独立blob并显式选文件CAS合并，过期版本不能覆盖新写",async()=>{
    const parent=await runInDurableObject(env.SANDBOX.getByName("parent-test"),async (_instance,state)=>{
      const host=runtime(),manager=new WorkspaceManager({workspace:"workspace:parent",bucket:env.ASSETS,storage:state.storage,runtime:host.client,resetRuntime:host.reset,runtimeReady:host.ready});
      await manager.run({operationId:"p",operation:{kind:"write",path:"a.txt",text:"parent"}});return manager.files();
    });
    const child=await runInDurableObject(env.SANDBOX.getByName("child-test"),async (_instance,state)=>{
      const host=runtime(),manager=new WorkspaceManager({workspace:"workspace:child",bucket:env.ASSETS,storage:state.storage,runtime:host.client,resetRuntime:host.reset,runtimeReady:host.ready});
      expect((await manager.importSnapshot({manifest:parent,expectedRevision:"0"})).ok).toBe(true);
      await manager.run({operationId:"c",operation:{kind:"write",path:"a.txt",text:"child"}});return manager.files();
    });
    await runInDurableObject(env.SANDBOX.getByName("parent-test"),async (_instance,state)=>{
      const host=runtime(),manager=new WorkspaceManager({workspace:"workspace:parent",bucket:env.ASSETS,storage:state.storage,runtime:host.client,resetRuntime:host.reset,runtimeReady:host.ready});
      expect((await manager.importSnapshot({manifest:child,expectedRevision:parent.revision,paths:["a.txt"]})).ok).toBe(true);
      expect(new TextDecoder().decode((await manager.readBlob("a.txt")).bytes)).toBe("child");
      expect((await manager.importSnapshot({manifest:parent,expectedRevision:parent.revision})).ok).toBe(false);
    });
  });
});
