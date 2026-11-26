import { createHash } from "node:crypto";
import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager, type WorkspaceManifest } from "../src/sandbox/workspace";
import { cleanupTemporaryObjects, ObjectFiles, temporaryFileRef, persistentFileKey } from "../src/sandbox/object-files";
import type { GcOptions } from "../src/sandbox/workspace-gc";
import { SandboxDO } from "../src/sandbox/do";
import { runtime } from "./sandbox-runtime-fixture";
import { sha256 } from "../src/media/model";
import { scopePrefix, MediaRepository } from "../src/media/repository";
import { importFiles } from "../src/communication/service";
import { messageId } from "../src/communication/model";
import { inspectWorkspaceSkill, publishWorkspaceSkill, type WorkspaceReadApi } from "../src/tools/workspace-admin";
import { scriptedModel } from "./events-helpers";
import { input, syncedView } from "./helpers";

describe("workspace persistence and gc", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  describe("持久工作区", () => {
    it("旧工作区首次物化生成归档，冷启动可直接恢复，差量版本仍按最新清单读取", async () => {
      await runInDurableObject(env.SANDBOX.getByName("backup-upgrade"), async (_, ctx) => {
        const host = runtime();
        const deps = { workspace: "workspace:" + ctx.id, storage: ctx.storage, bucket: env.ASSETS,
          runtime: host.client, runtimeReady: host.ready, resetRuntime: host.reset };
        const legacy = new WorkspaceManager(deps);
        await legacy.run({ operationId: "legacy", operation: { kind: "write", path: "old.txt", text: "旧数据" } });
        const snapshot = await legacy.files(), bytes = (await legacy.readBlob("old.txt")).bytes;
        const restore = host.client.restore.bind(host.client);
        const fromManifest = vi.spyOn(host.client, "restore");
        const record = { id: crypto.randomUUID(), size: bytes.length, dir: "/work", sha256: await sha256(bytes), format: "tar+zstd/1" as const };
        const backup = host.client.backupDirectory = vi.fn(async () => record);
        const load = host.client.restoreDirectory = vi.fn(async () => restore(snapshot, async () => bytes));
        const read = (manager: WorkspaceManager, path: string) => manager.run({ operationId: crypto.randomUUID(), operation: { kind: "read", path } });
        const upgraded = new WorkspaceManager(deps);
        expect(await read(upgraded, "old.txt")).toMatchObject({ result: { text: "旧数据" } });
        expect(backup).toHaveBeenCalledTimes(1);
        fromManifest.mockClear();
        const cold = new WorkspaceManager(deps);
        expect(await read(cold, "old.txt")).toMatchObject({ result: { text: "旧数据" } });
        expect(load).toHaveBeenCalledWith(record);
        expect(fromManifest).not.toHaveBeenCalled();
        await cold.run({operationId: "append", operation: {kind: "write", path: "new.txt", text: "新增"}});
        const next = new WorkspaceManager(deps);
        expect(await read(next, "new.txt")).toMatchObject({ result: { text: "新增" } });
        expect(fromManifest.mock.calls.at(-1)?.[2]).toMatchObject({revision: snapshot.revision});
        expect(backup).toHaveBeenCalledTimes(1);
      });
    });
    it("Agent 附件经过真实 manifest/CAS 提交后可重建并通过 read 消费（容器客户端为本地夹具）", async () => {
      await runInDurableObject(env.SANDBOX.getByName("agent-import"), async (_instance, state) => {
        const host = runtime(), workspace = "workspace:agent-import";
        const deps = { workspace, bucket: env.ASSETS, storage: state.storage, runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready };
        const manager = new WorkspaceManager(deps);
        const bytes = new TextEncoder().encode("持久附件正文");
        const ref = await new MediaRepository({bucket:env.ASSETS,scope:"owner"}).put({bytes,name:"note.txt",mime:"text/plain"});
        const message = { id: messageId("owner","persist"), from:"owner", to:"group:200000001", text:"附件", files:[ref] };
        const save = async (path: string, data: Uint8Array) => {
          const result = await manager.run({operationId:"agent-copy:"+path,operation:{kind:"writeBytes",path,data,createOnly:true}});
          expect(result.status).toBe("committed");
        };
        const paths = await importFiles(env,message,save);
        expect(await importFiles(env,message,save)).toEqual(paths);
        // 改变源会话后，目标副本仍读取接收时的快照。
        await new MediaRepository({bucket:env.ASSETS,scope:"owner"}).put({bytes:new TextEncoder().encode("源已变化"),name:"note.txt",mime:"text/plain"});
        const rebuiltHost = runtime();
        const rebuilt = new WorkspaceManager({...deps,runtime:rebuiltHost.client,resetRuntime:rebuiltHost.reset,runtimeReady:rebuiltHost.ready});
        expect(new TextDecoder().decode((await rebuilt.readBlob(paths[0]!)).bytes)).toBe("持久附件正文");
        expect((await rebuilt.run({operationId:"agent-read",operation:{kind:"read",path:paths[0]!}}))).toMatchObject({status:"committed",result:{text:"持久附件正文"}});
        expect((await rebuilt.files()).files).toHaveLength(1);
      });
    });
  
    it("自动附件和子资源产物跨资源到期回收，长期文件和新产物继续可读", async () => {
      const now = Date.now(), old = now - 8 * 86400_000;
      const owner = new ObjectFiles(env.ASSETS, "owner"), child = new ObjectFiles(env.ASSETS, "child");
      const attachment = temporaryFileRef("attachments/monthly.csv", old), output = child.outputPrefix("report", old) + "/output.txt";
      const fresh = child.outputPrefix("report", now) + "/output.txt", saved = "attachments/monthly.csv";
      await owner.write(attachment, "old");
      await child.write(output, "old");
      await child.write(fresh, "fresh");
      await owner.write(persistentFileKey(saved), "saved");
      expect(() => persistentFileKey(attachment)).toThrow("invalid_request");
      await expect(owner.read(fresh)).rejects.toThrow("not_found");
      await cleanupTemporaryObjects(env.ASSETS, now);
      await expect(owner.read(attachment)).rejects.toThrow("not_found");
      await expect(child.read(output)).rejects.toThrow("not_found");
      expect(new TextDecoder().decode(await owner.read(saved))).toBe("saved");
      expect(new TextDecoder().decode(await child.read(fresh))).toBe("fresh");
    });
    it("分批GC跨重建续跑，保护两批间的新提交与新租约，完成后释放标记", async () => {
      await runInDurableObject(env.SANDBOX.getByName("gc-pages"), async (_instance, state) => {
        const host = runtime(), workspace = "workspace:gc-pages";
        const deps = { workspace, bucket: env.ASSETS, storage: state.storage, runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready };
        let manager = new WorkspaceManager(deps);
        const prefix = `${await scopePrefix(workspace)}/workspace`, bytes = new TextEncoder().encode("retained"), hash = await sha256(bytes);
        const file = { path: "keep.txt", sha256: hash, bytes: bytes.length, mime: "text/plain", mode: 420 };
        const lateBytes = new TextEncoder().encode("late-lease"), lateHash = await sha256(lateBytes);
        const lateFile = { ...file, path: "late.txt", sha256: lateHash, bytes: lateBytes.length };
        // 用小批次跨过真实 R2 游标边界，避免为分页行为创建数千个对象。
        const versions = 8, batchSize = 3;
        await Promise.all(Array.from({ length: versions }, async (_, index) => {
          const revision = index.toString(16).padStart(4, "0");
          await env.ASSETS.put(`${prefix}/manifests/${revision}`, JSON.stringify({ schemaVersion: 1, workspace, revision, parentRevision: null,
            files: index < 2 ? [file] : index === 2 ? [lateFile] : [], directories: [], totalBytes: index < 2 ? bytes.length : index === 2 ? lateBytes.length : 0 }));
          await env.ASSETS.put(`${prefix}/blobs/${index.toString(16).padStart(64, "0")}`, "obsolete");
          await env.ASSETS.put(`${prefix}/results/${revision}`, "obsolete");
        }));
        await env.ASSETS.put(`${prefix}/blobs/${hash}`, bytes);
        await env.ASSETS.put(`${prefix}/blobs/${lateHash}`, lateBytes);
        const future = Date.now() + 31 * 86_400_000;
        const record = { id: crypto.randomUUID(), dir: "/work", size: 3, sha256: hash, format: "tar+zstd/1" };
        const active = `${prefix}/archives/${record.id}.tar.zst`, orphan = `${prefix}/archives/${crypto.randomUUID()}.tar.zst`;
        await Promise.all([env.ASSETS.put(active, "active"), env.ASSETS.put(orphan, "old")]);
        await state.storage.put({ "workspace:archive": { revision: "0003", record, savedAt: Date.now() }, "workspace:head": "0000", "workspace:pins": { "0001": future + 3600_000 } });
        vi.spyOn(Date, "now").mockReturnValue(future);
        const list = vi.spyOn(env.ASSETS, "list");
        const step = async (options: GcOptions) => {
          const calls = list.mock.calls.length;
          const report = await manager.gc(options);
          expect(list.mock.calls.length - calls).toBeLessThanOrEqual(1);
          expect(report.stepScanned).toBeLessThanOrEqual(batchSize);
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
        const dry = await finish({ keepManifests: 1, batchSize });
        expect(dry.deleted).toBe(0);
        expect(await env.ASSETS.head(orphan)).not.toBeNull();
        expect(list.mock.calls.some(([options]) => options?.cursor)).toBe(true);
        expect(dry.candidates).toBeGreaterThan(versions * 2);
        const options = { dryRun: false, keepManifests: 1, batchSize };
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
        expect(complete.deleted).toBeGreaterThan(versions * 2);
        expect(await env.ASSETS.head(active)).not.toBeNull();
        expect(await env.ASSETS.head(`${prefix}/manifests/0003`)).not.toBeNull();
        expect(await env.ASSETS.head(orphan)).toBeNull();
        expect(state.storage.sql.exec("SELECT * FROM workspace_gc_refs").toArray()).toEqual([]);
        expect(state.storage.sql.exec("SELECT * FROM workspace_gc_manifests").toArray()).toEqual([]);
        expect(await manager.resumeGc()).toBeUndefined();
        expect(new TextDecoder().decode((await manager.readBlob("late.txt", "0002")).bytes)).toBe("late-lease");
        expect(await env.ASSETS.get(`${prefix}/manifests/0001`)).not.toBeNull();
        expect(await env.ASSETS.get(`${prefix}/blobs/${hash}`)).not.toBeNull();
        expect(await env.ASSETS.get(`${prefix}/blobs/${(versions - 1).toString(16).padStart(64, "0")}`)).toBeNull();
        expect(await env.ASSETS.get(`${prefix}/results/${(versions - 1).toString(16).padStart(4, "0")}`)).toBeNull();
        expect(new TextDecoder().decode((await manager.readBlob("new.txt")).bytes)).toBe("new");
        expect(new TextDecoder().decode((await manager.readBlob("keep.txt", "0001")).bytes)).toBe("retained");
      });
    });
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
    it("二进制输出按内容幂等提交，重建后字节不变，目录删除也持久化", async () => {
      await runInDurableObject(env.SANDBOX.getByName("binary-output"), async (_instance, state) => {
        const first = runtime(), deps = { workspace: "workspace:binary", bucket: env.ASSETS, storage: state.storage, runtime: first.client, resetRuntime: first.reset, runtimeReady: first.ready };
        const manager = new WorkspaceManager(deps), path = "/work/.codemode/output/image.png", data = new Uint8Array([17, 0, 255, 128, 23]).subarray(1, 4);
        expect((await manager.run({ operationId: "dir", operation: { kind: "mkdir", path: "/work/.codemode/output" } })).status).toBe("committed");
        const write = { operationId: "image", operation: { kind: "writeBytes" as const, path, data } };
        const result = await manager.run(write);
        expect(result).toMatchObject({ status: "committed", result: { bytes: 3 } });
        expect(await manager.run(write)).toEqual(result);
        const attachment = { kind: "writeBytes" as const, path: "/work/incoming.zip", data, createOnly: true };
        const [saved, repeated] = await Promise.all(["recall-1", "recall-2"].map(operationId => manager.run({ operationId, operation: attachment })));
        expect(saved).toMatchObject({ status: "committed", result: { bytes: 3 } });
        expect(repeated).toEqual(saved);
        await expect(manager.run({ operationId: "other-file", operation: { ...attachment, data: new Uint8Array([99]) } })).rejects.toThrow("workspace_conflict");
        expect((await manager.readBlob(attachment.path)).bytes).toEqual(data);
        await expect(manager.run({ ...write, operation: { ...write.operation, data: new Uint8Array([0, 255, 129]) } })).rejects.toThrow("operation_conflict");
        const second = runtime(), rebuilt = new WorkspaceManager({ ...deps, runtime: second.client, resetRuntime: second.reset, runtimeReady: second.ready });
        expect((await rebuilt.readBlob(path)).bytes).toEqual(data);
        expect((await rebuilt.files()).directories).toContain(".codemode/output");
        expect((await rebuilt.run({ operationId: "remove", operation: { kind: "remove", path: "/work/.codemode/output" } })).status).toBe("committed");
        expect((await rebuilt.files()).files.map(file => file.path)).toEqual(["incoming.zip"]);
        await expect(rebuilt.readBlob(path)).rejects.toThrow("not_found");
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
});

describe("workspace admin skill publish", () => {
  afterEach(async () => { await reset(); });
  it("检查固定工作区版本后发布技能，旧Registry版本不能覆盖新发布",async()=>{
    const texts=new Map([["skills/demo/SKILL.md","---\nname: demo\ndescription: 中文示例技能\n---\n先读取 references/guide.md，再执行。"],["skills/demo/references/guide.md","这是配套说明。"]]);
    const files=await Promise.all([...texts].map(async([path,text])=>({path,sha256:await sha256(text),bytes:new TextEncoder().encode(text).length,mime:"text/plain",mode:420})));
    const manifest:WorkspaceManifest={schemaVersion:1,workspace:"workspace:test",revision:"abcdef01",parentRevision:"0",files,directories:["skills","skills/demo","skills/demo/references"],totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)};
    const readRevisions:string[]=[];
    const sandbox:WorkspaceReadApi={files:async revision=>{if(revision&&revision!==manifest.revision)throw new Error("wrong_revision");return manifest;},readBlob:async(path,revision)=>{readRevisions.push(revision??"");const text=texts.get(path);if(text===undefined)throw new Error("not_found");return{bytes:new TextEncoder().encode(text),mime:"text/plain",name:path.split("/").at(-1)??"file"};}};
    const registry=env.REGISTRY.getByName("main");
    const inspection=await inspectWorkspaceSkill(sandbox,registry,{path:"/work/skills/demo"});
    expect(inspection).toMatchObject({name:"demo",description:"中文示例技能",workspaceRevision:manifest.revision,expectedRevision:"absent"});
    const request={path:"skills/demo",workspaceRevision:inspection.workspaceRevision,expectedRevision:inspection.expectedRevision};
    expect(await publishWorkspaceSkill(sandbox,registry,request)).toMatchObject({ok:true,value:{name:"demo",revision:expect.any(String)}});
    expect((await registry.skillGet("demo"))?.files).toEqual({"references/guide.md":"这是配套说明。"});
    expect(await publishWorkspaceSkill(sandbox,registry,request)).toMatchObject({ok:false,conflict:{revision:await registry.skillRevision("demo")}});
    expect(readRevisions.every(value=>value===manifest.revision)).toBe(true);
  });
});

describe("cloudflare workspace resources", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  const resources = () => env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner");
  const resourceId = (seed: string) => "sbx:" + createHash("sha256").update(seed).digest("hex");
  const legacyResource = (seed: string, name: string) => ({
    id: resourceId(seed), owner: "owner", kind: "cloudflare", providerId: "cloudflare", name, createdAt: 42,
  });
  
  it("维护页继续扫描登记表，只返回当前owner已就绪的Cloudflare工作区", async () => {
    const expected = Array.from({ length: 7 }, (_, index) => legacyResource("maintenance:" + index, "resource:maintenance-" + index));
    await runInDurableObject(resources(), async (_instance, state) => {
      for (const resource of expected) await state.storage.put("resource:" + resource.id, { kind: "ready", resource });
      await state.storage.put("resource:foreign", { kind: "ready", resource: { ...legacyResource("foreign", "group:200000001"), owner: "group:200000001" } });
      await state.storage.put("resource:preparing", { kind: "preparing", resource: legacyResource("preparing", "resource:preparing"), fingerprint: "" });
      await state.storage.put("resource:remote", { kind: "ready", resource: { id: "remote", kind: "remote" } });
    });
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await resources().maintenancePage("owner", cursor);
      expect(page.resources.length).toBeLessThanOrEqual(5);
      collected.push(...page.resources.map(resource => resource.id)); cursor = page.cursor;
    } while (cursor);
    expect(collected.sort()).toEqual(expected.map(resource => resource.id).sort());
  });
  
  it("保留旧 Cloudflare ID 和物理名称，旧远程记录不出现也不占创建配额", async () => {
    const existing = legacyResource("owner:create:legacy", "resource:old-physical");
    const oldRemote = Array.from({ length: 256 }, (_, index) => {
      const id = resourceId("old-remote:" + index);
      return { id, owner: "owner", kind: "remote", providerId: "remote:legacy", workspace: id };
    });
    await runInDurableObject(resources(), async (_instance, state) => {
      for (const resource of oldRemote) {
        await state.storage.put("resource:" + resource.id, { kind: "ready", resource });
      }
      await state.storage.put("resource:" + existing.id, { kind: "ready", resource: existing, fingerprint: '{"providerId":"cloudflare"}' });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(resources());
    const list = await resources().list("owner");
    expect(await runInDurableObject(resources(), (_instance, state) => state.storage.getAlarm())).toBeNull();
    expect(list.assignedSandboxId).toBe(resourceId("owner:cloudflare"));
    expect(list.resources).toEqual(expect.arrayContaining([existing, expect.objectContaining({ id: list.assignedSandboxId, name: "owner" })]));
    expect(list.resources).toHaveLength(2);
    expect(await resources().get("owner", oldRemote[0]!.id)).toBeNull();
    expect(await resources().get("group:200000001", existing.id)).toBeNull();
    expect(await resources().create("owner", "legacy", {})).toEqual(existing);
    expect((await resources().create("owner", "new", {})).id).toBe(resourceId("owner:create:new"));
  });
  
  it("恢复旧 preparing 克隆时使用原先锁定的快照", async () => {
    const source = legacyResource("owner:cloudflare", "owner"), clone = legacyResource("owner:create:clone", "resource:old-clone");
    const snapshot = { sourceName: source.name, sourceRevision: "pinned", expectedRevision: "0", operationId: "original-op" };
    await runInDurableObject(resources(), async (_instance, state) => {
      await state.storage.put("resource:" + clone.id, { kind: "preparing", resource: { ...clone, sourceId: source.id },
        fingerprint: JSON.stringify({ sourceId: source.id, providerId: "cloudflare" }), clone: snapshot });
    });
    const cloneFrom = vi.spyOn(SandboxDO.prototype, "cloneFrom").mockImplementation(async function(this: SandboxDO) {
      return { ok: true, manifest: await this.files() };
    });
    expect(await resources().get("owner", clone.id)).toBeNull();
    expect(await resources().create("owner", "clone", { sourceId: source.id })).toMatchObject({ ...clone, sourceId: source.id });
    expect(await resources().get("owner", clone.id)).toMatchObject({ ...clone, sourceId: source.id });
    expect(cloneFrom).toHaveBeenCalledWith(snapshot);
    await expect((async () => resources().create("owner", "clone", {}))()).rejects.toThrow("operation_conflict");
  });
});

describe("owner workspace read", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  const groupA = "group:200000001", groupB = "group:200000002";
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  async function seed(workspace: string, label: string) {
    const sandbox = env.SANDBOX.getByName(workspace), current = await sandbox.files();
    const entries = [{ path: "out/report.md", bytes: new TextEncoder().encode("首行\n" + label + "\n末行") }, { path: "out/image.png", bytes: png }];
    const files = await Promise.all(entries.map(async ({ path, bytes }) => {
      const digest = await sha256(bytes);
      await env.ASSETS.put((await scopePrefix(current.workspace)) + "/workspace/blobs/" + digest, bytes);
      return { path, bytes: bytes.length, sha256: digest, mime: path.endsWith("png") ? "image/png" : "text/plain", mode: 420 };
    }));
    const result = await sandbox.importSnapshot({ expectedRevision: current.revision, manifest: { ...current, files, directories: ["out"], totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) } });
    expect(result.ok).toBe(true);
    return (await sandbox.files()).revision;
  }
  
  it.each(["qq", "web"] as const)("owner %s 使用原 read 读取多个群的持久文件，保留分段和图片格式且不启动运行时", async channel => {
    const beforeA = await seed(groupA, "甲群内容"), beforeB = await seed(groupB, "乙群内容");
    const run = vi.spyOn(SandboxDO.prototype, "run");
    const seen = scriptedModel([{ name: "codemode", args: { code: [
      'text((await tools.read({workspace:"group:200000001",path:"/work/out/report.md",offset:2,limit:1})).text);',
      'text((await tools.read({workspace:"group:200000002",path:"out/report.md"})).text);',
      'const picture=await tools.read({workspace:"group:200000001",path:"out/image.png"});text(picture);',
      'try { await tools.write({workspace:"group:200000001",path:"out/report.md",content:"禁止改写"}); } catch(error) { text(String(error)); }',
      'try { await tools.read({workspace:"group:200000001",path:"../../outside"}); } catch(error) { text(String(error)); }',
    ].join("\n") } }]);
    const thread = env.THREAD.getByName("owner");
    if (channel === "web") {
      await thread.submitWeb("owner", crypto.randomUUID(), "查看群产物");
      await expect.poll(async () => (await (await syncedView("owner")).chatView("owner")).active, { timeout: 5000 }).toBe(0);
    } else await thread.submit(input(1, "查看群产物", 10000001));
    const output = seen.outputs.join("\n");
    expect(output).toContain("甲群内容\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
    expect(output).toContain("乙群内容");
    expect(output).toContain('"kind":"image"');
    expect(output).toContain("iVBORw0KGgoA/w==");
    expect(output).toContain("path_denied");
    expect(run).not.toHaveBeenCalled();
    expect((await env.SANDBOX.getByName(groupA).files()).revision).toBe(beforeA);
    expect((await env.SANDBOX.getByName(groupB).files()).revision).toBe(beforeB);
  });
  
  it.each([10000001, 10000004])("群回合中的用户 %s 不获得跨群读取权", async actor => {
    await seed(groupB, "乙群私有内容");
    const read = vi.spyOn(SandboxDO.prototype, "readBlob");
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.read({workspace:"group:200000002",path:"out/report.md"}));' } }]);
    await env.THREAD.getByName(groupA).submit(input(1, "跨群查看", actor, 200000001, true));
    expect(seen.outputs.join("\n")).toContain("permission_denied");
    expect(read).not.toHaveBeenCalled();
  });
  
  it("owner 任务撤销后下一次跨群读取立即拒绝", async () => {
    await seed(groupA, "授权期间可读");
    const original = SandboxDO.prototype.readBlob;
    const read = vi.spyOn(SandboxDO.prototype, "readBlob").mockImplementationOnce(async function (this: SandboxDO, path, revision) {
      const value = await original.call(this, path, revision);
      await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) => { state.storage.sql.exec("UPDATE sandbox_tasks SET revoked_at=1"); });
      return value;
    });
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text((await tools.read({workspace:"group:200000001",path:"out/report.md"})).text);text(await tools.read({workspace:"group:200000001",path:"out/report.md"}));' } }]);
    await env.THREAD.getByName("owner").submit(input(1, "查看群产物", 10000001));
    expect(read).toHaveBeenCalledTimes(1);
    expect(seen.outputs.join("\n")).toContain("授权期间可读");
    expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
  });
});
