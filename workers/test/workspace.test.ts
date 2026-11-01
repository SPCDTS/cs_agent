import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../src/sandbox/workspace";
import { type SandboxClient } from "../src/sandbox/client";
import { sha256 } from "../src/media/model";
afterEach(async () => { await reset(); });
function runtime() {
  let files = new Map<string,Uint8Array>(), ready = false, executions = 0, failExec = false;
  const relative = (path: string) => path.replace(/^\/work\//, "");
  const client: SandboxClient = {
    async restore(snapshot, readBlob) { ready = true; files = new Map(await Promise.all(snapshot.files.map(async (file): Promise<[string, Uint8Array]> => [file.path, await readBlob(file)]))); },
    async writeFile(path, text) { const value = new TextEncoder().encode(text); files.set(relative(path), value); return { bytes: value.length }; },
    async readFile(path) { return { text: new TextDecoder().decode(files.get(relative(path))), startLine: 1, endLine: 1, totalLines: 1 }; },
    async exec() { executions++; if (failExec) { failExec = false; throw new Error("sandbox_unavailable"); } files.set("binary.bin", new Uint8Array([0,255,1])); return { stdout: "ok", stderr: "", code: 0, timedOut: false, truncated: false }; },
    async readBlob(path) { const value = files.get(relative(path)); if (!value) throw new Error("not_found"); return value; },
    async snapshot() { const entries = await Promise.all([...files].map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mime: "application/octet-stream", mode: 420 }))); return { files: entries, directories: [], totalBytes: entries.reduce((sum, file) => sum + file.bytes, 0) }; },
    async list() { return []; },
    async editFile() { throw new Error("unused"); },
  };
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
