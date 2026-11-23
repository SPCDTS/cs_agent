import { env, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxDO } from "../src/sandbox/do";
import { sha256 } from "../src/media/model";
import { messageId } from "../src/communication/model";
import { runtime } from "./sandbox-runtime-fixture";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const group = "group:200000001";
async function seed(scope: string, user: number) {
  await runInDurableObject(env.THREAD.getByName(scope), async (i, s) => {
    await (i as any).queueInput(input(user, "local", user, scope === group ? 200000001 : undefined));
    s.storage.sql.exec("UPDATE inbound SET status='done',turn_id='local-turn'");
    await s.storage.deleteAlarm();
  });
}

it.each(["edited", "deleted"])("real saveAttachment retries second-file R2 failure after eviction and keeps %s first copy beyond 32 operations", async copy => {
  const sandbox = env.SANDBOX.getByName("attachment-recovery");
  const one = new TextEncoder().encode("one"), two = new TextEncoder().encode("two"), twoHash = await sha256(two);
  await sandbox.saveAttachment("/work/first.txt", one, "message:0");
  // 不同 ID、相同字节本来就成功；该事实不是本次缺陷。
  await sandbox.saveAttachment("/work/first.txt", one, "different-id");
  await runInDurableObject(sandbox, async (i, s) => {
    const manager = (i as any).workspace, host = runtime(), original = manager.deps.bucket as R2Bucket;
    Object.assign(manager.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
    manager.deps.bucket = new Proxy(original, { get(target, prop) {
      if (prop === "put") return async (...args: any[]) => {
        if (args[0].endsWith("/blobs/" + twoHash)) throw new Error("synthetic_r2_unavailable");
        return (target.put as any)(...args);
      };
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(i.saveAttachment("/work/second.txt", two, "message:1")).rejects.toThrow("synthetic_r2_unavailable");
    expect((await s.storage.list({ prefix: "workspace:op:" })).size).toBe(0);
    expect((await s.storage.list({ prefix: "workspace:attachment:" })).size).toBe(2);
    manager.deps.bucket = original;
    if (copy === "edited") await i.writeFile("/work/first.txt", "edited", "edit-first");
    else expect(await i.run({ operationId: "delete-first", operation: { kind: "remove", path: "/work/first.txt" } })).toMatchObject({ status: "committed" });
    for (let n = 0; n < 33; n++) await i.writeFile("/work/later.txt", String(n), "later-" + n);
  });
  await evictDurableObject(sandbox);
  await sandbox.saveAttachment("/work/first.txt", one, "message:0");
  await sandbox.saveAttachment("/work/second.txt", two, "message:1");
  if (copy === "edited") expect(new TextDecoder().decode((await sandbox.readBlob("/work/first.txt")).bytes)).toBe("edited");
  else await runInDurableObject(sandbox, async i => { await expect(i.readBlob("/work/first.txt")).rejects.toThrow("not_found"); });
  expect(new TextDecoder().decode((await sandbox.readBlob("/work/second.txt")).bytes)).toBe("two");
  await runInDurableObject(sandbox, async i => { await expect(i.saveAttachment("/work/second.txt", one, "message:1")).rejects.toThrow("operation_conflict"); });
});

it("attachment head and receipt roll back together on durable transaction failure, then recover after eviction", async () => {
  const sandbox = env.SANDBOX.getByName("attachment-sql"), bytes = new TextEncoder().encode("atomic");
  await runInDurableObject(sandbox, async (i, s) => {
    const manager = (i as any).workspace, storage = manager.deps.storage as DurableObjectStorage;
    manager.deps.storage = new Proxy(storage, { get(target, prop) {
      if (prop === "transaction") return (work: (tx: DurableObjectTransaction) => Promise<unknown>) => target.transaction(async tx => {
        await work(tx); throw new Error("synthetic_transaction_failure");
      });
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(i.saveAttachment("/work/a.txt", bytes, "atomic")).rejects.toThrow("synthetic_transaction_failure");
    expect(await s.storage.get("workspace:head")).toBeUndefined();
    expect((await s.storage.list({ prefix: "workspace:attachment:" })).size).toBe(0);
  });
  await evictDurableObject(sandbox);
  await sandbox.saveAttachment("/work/a.txt", bytes, "atomic");
  expect(new TextDecoder().decode((await sandbox.readBlob("/work/a.txt")).bytes)).toBe("atomic");
});

it("owner Agent reads and forwards received files through real tools without coding_exec or access to other owner files", async () => {
  await seed("owner", 10000001); await seed(group, 10000003);
  await env.SANDBOX.getByName(group).saveAttachment("/work/out/note.txt", new TextEncoder().encode("peer-visible\nsecond"), "source");
  await env.SANDBOX.getByName("owner").saveAttachment("/work/private.txt", new TextEncoder().encode("OWNER-PRIVATE-SENTINEL"), "owner-private");
  const path = "/work/agent-files/" + messageId(group, "0:owner-file").slice(6) + "/0-note.txt";
  const seen = scriptedModel([{ name: "codemode", args: { code: [
    'text(await tools.read({path:' + JSON.stringify(path) + ',limit:1}));',
    'try{text(await tools.read({path:"/work/private.txt"}));}catch(e){text("read-denied:"+String(e));}',
    'try{text(await tools.bash({command:"echo forbidden"}));}catch(e){text("bash-denied:"+String(e));}',
    'try{text(await tools.write({path:"/work/private.txt",content:"forbidden"}));}catch(e){text("write-denied:"+String(e));}',
  ].join("\n") } }]);
  const run = vi.spyOn(SandboxDO.prototype, "run");
  await runInDurableObject(env.THREAD.getByName(group), async (i, s) => {
    const row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='message'").one();
    expect((await (i as any).sendAgentMessage({ to: "owner", text: "file", files: ["/work/out/note.txt"] }, "owner-file", row)).status).toBe("accepted");
  });
  await vi.waitFor(() => expect(seen.outputs.join("\n")).toContain("peer-visible"));
  await vi.waitFor(async () => {
    await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
      const row = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='agent'").one();
      expect(row.status).toBe("done");
      expect(await (i as any).sandboxTaskForInput(row)).toBeUndefined();
    });
  });
  expect(seen.outputs.join("\n")).not.toContain("OWNER-PRIVATE-SENTINEL");
  expect(run).not.toHaveBeenCalled();
  await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
    const row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='agent'").one();
    expect((await (i as any).sendAgentMessage({ to: group, text: "return copy", files: [path] }, "forward-file", row)).status).toBe("accepted");
    await expect((i as any).sendAgentMessage({ to: group, text: "denied", files: ["/work/private.txt"] }, "private-file", row)).rejects.toThrow("agent_file_access_denied");
  });
  await runInDurableObject(env.THREAD.getByName(group), async (i, s) => {
    const row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='agent' ORDER BY rowid DESC LIMIT 1").one();
    await expect((i as any).sendAgentMessage({ to: "owner", text: "not received", files: ["/work/out/note.txt"] }, "group-agent-file", row)).rejects.toThrow("agent_file_access_denied");
    const received = JSON.parse((row as any).agent_files);
    expect((await (i as any).sendAgentMessage({ to: "owner", text: "received file", files: received }, "group-received-file", row)).status).toBe("accepted");
  });
  expect(new TextDecoder().decode((await env.SANDBOX.getByName("owner").readBlob("/work/private.txt")).bytes)).toBe("OWNER-PRIVATE-SENTINEL");
});
