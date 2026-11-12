import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "../src/sandbox/workspace";
import type { GcOptions } from "../src/sandbox/workspace-gc";
import { type SandboxClient } from "../src/sandbox/client";
import { sha256 } from "../src/media/model";
import { scopePrefix } from "../src/media/repository";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
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
  it("分批GC跨重建续跑，保护两批间的新提交与新租约，完成后释放标记", async () => {
    await runInDurableObject(env.SANDBOX.getByName("gc-pages"), async (_instance, state) => {
      const host = runtime(), workspace = "workspace:gc-pages";
      const deps = { workspace, bucket: env.ASSETS, storage: state.storage, runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready };
      let manager = new WorkspaceManager(deps);
      const prefix = `${await scopePrefix(workspace)}/workspace`, bytes = new TextEncoder().encode("retained"), hash = await sha256(bytes);
      const file = { path: "keep.txt", sha256: hash, bytes: bytes.length, mime: "text/plain", mode: 420 };
      const lateBytes = new TextEncoder().encode("late-lease"), lateHash = await sha256(lateBytes);
      const lateFile = { ...file, path: "late.txt", sha256: lateHash, bytes: lateBytes.length };
      for (let start = 0; start < 1002; start += 50) await Promise.all(Array.from({ length: Math.min(50, 1002 - start) }, async (_, offset) => {
        const index = start + offset, revision = index.toString(16).padStart(4, "0");
        await env.ASSETS.put(`${prefix}/manifests/${revision}`, JSON.stringify({ schemaVersion: 1, workspace, revision, parentRevision: null,
          files: index < 2 ? [file] : index === 2 ? [lateFile] : [], directories: [], totalBytes: index < 2 ? bytes.length : index === 2 ? lateBytes.length : 0 }));
        await env.ASSETS.put(`${prefix}/blobs/${index.toString(16).padStart(64, "0")}`, "obsolete");
        await env.ASSETS.put(`${prefix}/results/${revision}`, "obsolete");
      }));
      await env.ASSETS.put(`${prefix}/blobs/${hash}`, bytes);
      await env.ASSETS.put(`${prefix}/blobs/${lateHash}`, lateBytes);
      const future = Date.now() + 31 * 86_400_000;
      await state.storage.put({ "workspace:head": "0000", "workspace:pins": { "0001": future + 3600_000 } });
      vi.spyOn(Date, "now").mockReturnValue(future);
      const list = vi.spyOn(env.ASSETS, "list");
      const step = async (options: GcOptions) => {
        const calls = list.mock.calls.length;
        const report = await manager.gc(options);
        expect(list.mock.calls.length - calls).toBeLessThanOrEqual(1);
        expect(report.stepScanned).toBeLessThanOrEqual(500);
        manager = new WorkspaceManager(deps);
        return report;
      };
      const finish = async (options: GcOptions) => {
        for (let turn = 0; turn < 80; turn++) {
          const report = await step(options);
          if (report.phase === "done") return report;
        }
        throw new Error("GC did not finish");
      };
      const dry = await finish({ keepManifests: 1, batchSize: 500 });
      expect(dry.deleted).toBe(0);
      expect(dry.candidates).toBeGreaterThan(3000);
      const options = { dryRun: false, keepManifests: 1, batchSize: 500 };
      for (let turn = 0; turn < 20; turn++) {
        if ((await step(options)).phase === "manifests") break;
        if (turn === 19) throw new Error("inventory did not finish");
      }
      await manager.files("0002");
      const collecting = manager.gc(options);
      const writing = manager.run({ operationId: "after-gc", operation: { kind: "write", path: "new.txt", text: "new" } });
      await collecting;
      expect((await writing).status).toBe("committed");
      manager = new WorkspaceManager(deps);
      const complete = await finish(options);
      expect(complete.deleted).toBeGreaterThan(3000);
      expect(state.storage.sql.exec("SELECT * FROM workspace_gc_refs").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM workspace_gc_manifests").toArray()).toEqual([]);
      expect(await manager.resumeGc()).toBeUndefined();
      expect(new TextDecoder().decode((await manager.readBlob("late.txt", "0002")).bytes)).toBe("late-lease");
      expect(await env.ASSETS.get(`${prefix}/manifests/0001`)).not.toBeNull();
      expect(await env.ASSETS.get(`${prefix}/blobs/${hash}`)).not.toBeNull();
      expect(await env.ASSETS.get(`${prefix}/blobs/${(1001).toString(16).padStart(64, "0")}`)).toBeNull();
      expect(await env.ASSETS.get(`${prefix}/results/03e9`)).toBeNull();
      expect(new TextDecoder().decode((await manager.readBlob("new.txt")).bytes)).toBe("new");
      expect(new TextDecoder().decode((await manager.readBlob("keep.txt", "0001")).bytes)).toBe("retained");
    });
  }, 60_000);
  it("原SandboxDO的alarm在重建后继续GC，完成后停止唤醒", async () => {
    const stub = env.SANDBOX.getByName("gc-alarm");
    expect((await stub.gc({ dryRun: false })).phase).not.toBe("done");
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).not.toBeNull();
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const failure = vi.spyOn(WorkspaceManager.prototype, "resumeGc").mockRejectedValueOnce(new Error("r2_temporarily_unavailable"));
      const failedAt = Date.now();
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(failedAt + 300_000);
      expect(await state.storage.get("workspace:gc:apply")).toBeDefined();
      failure.mockRestore();
      for (let turn = 0; turn < 8 && await state.storage.getAlarm() !== null; turn++) await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await state.storage.get("workspace:gc:apply:last")).toMatchObject({ phase: "done", deleted: 0 });
    });
  });
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
