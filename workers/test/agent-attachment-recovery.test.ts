// 合并原 agent-attachment-recovery 与 agent-communication-* 中的附件导入、R2/SQL 恢复和子工作区权限回归用例。
import { env, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxDO } from "../src/sandbox/do";
import { sha256 } from "../src/media/model";
import { MediaRepository, scopePrefix } from "../src/media/repository";
import { fingerprint, messageId } from "../src/communication/model";
import { incomingText } from "../src/communication/service";
import { runtime } from "./sandbox-runtime-fixture";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const group = "group:200000001";
const FIXED_CID = "11111111-1111-4111-8111-111111111111";

async function seed(scope: string, user = 10000001, n = user) {
  await runInDurableObject(env.THREAD.getByName(scope), async (i, s) => {
    await (i as any).queueInput(input(n, "local", user, scope === group ? 200000001 : undefined));
    s.storage.sql.exec("UPDATE inbound SET status='done',turn_id='local-turn'");
    await s.storage.deleteAlarm();
  });
}

async function child(parent = "owner", options: { cid?: string; coding?: boolean; endedAt?: number } = {}) {
  const cid = options.cid ?? crypto.randomUUID();
  await seed(parent, 10000001, 1);
  const identity = { turn: "message", as: { userId: "10000001", nickname: "", owner: true } };
  const origin = {
    generation: 0,
    target: parent === group ? { kind: "group", groupId: "200000001" } : { kind: "private", userId: "10000001" },
    selfId: "99999999",
    scopeName: "",
    capabilities: { coding: options.coding ?? parent === "owner" },
  };
  await runInDurableObject(env.THREAD.getByName(parent), async (_i, s) => {
    s.storage.sql.exec(
      "INSERT INTO subagents(id,task,created_at,status,identity_json,origin_json,timeout_ms,deadline) VALUES(?,'test',?,'done',?,?,0,0)",
      cid,
      Date.now(),
      JSON.stringify(identity),
      JSON.stringify(origin),
    );
  });
  const address = "sub:" + parent + ":" + cid;
  await env.SUBAGENT.getByName(address).start({ parent, id: cid, task: "test", identity, model: { provider: "faux", id: "test" } } as any);
  await runInDurableObject(env.SUBAGENT.getByName(address), async (_i, s) => {
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    const nextMeta = { ...meta, status: "done", ...(options.endedAt !== undefined ? { endedAt: options.endedAt } : {}) };
    s.storage.sql.exec("UPDATE meta SET value=? WHERE key='subagent'", JSON.stringify(nextMeta));
    s.storage.sql.exec("DELETE FROM inbox");
    await s.storage.deleteAlarm();
  });
  return { cid, address };
}

async function blob(name: string, path: string, bytes: Uint8Array) {
  const sandbox = env.SANDBOX.getByName(name), m = await sandbox.files(), hash = await sha256(bytes);
  await env.ASSETS.put((await scopePrefix(m.workspace)) + "/workspace/blobs/" + hash, bytes);
  const relative = path.replace(/^\/work\//, "");
  const parts = relative.split("/"), dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  expect(await sandbox.importSnapshot({ expectedRevision: m.revision, manifest: { ...m, files: [{ path: relative, sha256: hash, bytes: bytes.length, mime: "text/plain", mode: 420 }], directories: dirs, totalBytes: bytes.length } })).toMatchObject({ ok: true });
}

async function wire(sandbox: ReturnType<typeof env.SANDBOX.getByName>, failSecond = false) {
  return runInDurableObject(sandbox, async instance => {
    const i = instance as any;
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
  const to = target === "child" ? (await child("owner", { cid: FIXED_CID })).address : group;
  if (target === "group") { await seed("owner", 10000001, 1); await seed(group, 10000003, 1); }
  const files = await Promise.all(["one", "two"].map(name => new MediaRepository({ bucket: env.ASSETS, scope: "owner" }).put({ bytes: new TextEncoder().encode(name), name: name + ".txt", mime: "text/plain" })));
  const message = { id: messageId("owner", "independent-" + target), from: "owner", to, text: "files", files };
  await runInDurableObject(env.THREAD.getByName("owner"), (_i, s) => s.storage.put("agent-sent:" + message.id, { inputHash: "fixture", message, generation: 0 }));
  const recipient = target === "child" ? env.SUBAGENT.getByName(to) : env.THREAD.getByName(to);
  const sandbox = env.SANDBOX.getByName(to);
  const paths = files.map((f, n) => "/work/agent-files/" + message.id.slice(6) + "/" + n + "-" + f.name);
  return { message, recipient, sandbox, paths };
}

async function receiveError(recipient: any, message: any) {
  return runInDurableObject(recipient, async instance => {
    const i = instance as any;
    try { await i.agentReceive(message); return "accepted"; } catch (e) { return (e as Error).message; }
  });
}

it.each(["edited", "deleted"])("create-only write retries second-file R2 failure after eviction and keeps %s first copy beyond 32 operations", async copy => {
  const sandbox = env.SANDBOX.getByName("attachment-recovery");
  const one = new TextEncoder().encode("one"), two = new TextEncoder().encode("two"), twoHash = await sha256(two);
  await sandbox.writeFile("/work/first.txt", one, "message:0", true);
  // 不同 ID、相同字节本来就成功；该事实不是本次缺陷。
  await sandbox.writeFile("/work/first.txt", one, "different-id", true);
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
    await expect(i.writeFile("/work/second.txt", two, "message:1", true)).rejects.toThrow("synthetic_r2_unavailable");
    expect((await s.storage.list({ prefix: "workspace:op:" })).size).toBe(0);
    expect((await s.storage.list({ prefix: "workspace:attachment:" })).size).toBe(2);
    manager.deps.bucket = original;
    if (copy === "edited") await i.writeFile("/work/first.txt", "edited", "edit-first");
    else expect(await i.run({ operationId: "delete-first", operation: { kind: "remove", path: "/work/first.txt" } })).toMatchObject({ status: "committed" });
    for (let n = 0; n < 33; n++) await i.writeFile("/work/later.txt", String(n), "later-" + n);
  });
  await evictDurableObject(sandbox);
  await sandbox.writeFile("/work/first.txt", one, "message:0", true);
  await sandbox.writeFile("/work/second.txt", two, "message:1", true);
  if (copy === "edited") expect(new TextDecoder().decode((await sandbox.readBlob("/work/first.txt")).bytes)).toBe("edited");
  else await runInDurableObject(sandbox, async i => { await expect(i.readBlob("/work/first.txt")).rejects.toThrow("not_found"); });
  expect(new TextDecoder().decode((await sandbox.readBlob("/work/second.txt")).bytes)).toBe("two");
  await runInDurableObject(sandbox, async i => { await expect(i.writeFile("/work/second.txt", one, "message:1", true)).rejects.toThrow("operation_conflict"); });
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
    await expect(i.writeFile("/work/a.txt", bytes, "atomic", true)).rejects.toThrow("synthetic_transaction_failure");
    expect(await s.storage.get("workspace:head")).toBeUndefined();
    expect((await s.storage.list({ prefix: "workspace:attachment:" })).size).toBe(0);
  });
  await evictDurableObject(sandbox);
  await sandbox.writeFile("/work/a.txt", bytes, "atomic", true);
  expect(new TextDecoder().decode((await sandbox.readBlob("/work/a.txt")).bytes)).toBe("atomic");
});

it("owner Agent reads and forwards received files through real tools without coding_exec or access to other owner files", async () => {
  await seed("owner", 10000001); await seed(group, 10000003);
  await env.SANDBOX.getByName(group).writeFile("/work/out/note.txt", new TextEncoder().encode("peer-visible\nsecond"), "source", true);
  await env.SANDBOX.getByName("owner").writeFile("/work/private.txt", new TextEncoder().encode("OWNER-PRIVATE-SENTINEL"), "owner-private", true);
  const path = "/work/agent-files/" + messageId(group, "0:owner-file").slice(6) + "/0-note.txt";
  const seen = scriptedModel([{ name: "codemode", args: { code: [
    'text(await tools.read({path:' + JSON.stringify(path) + ',limit:1}));',
    'try{text(await tools.read({path:"/work/private.txt"}));}catch(e){text("read-denied:"+String(e));}',
    'try{text(await tools.r2_read({key:"private.txt"}));}catch(e){text("r2-denied:"+String(e));}',
    'try{text(await tools.bash({command:"echo forbidden"}));}catch(e){text("bash-denied:"+String(e));}',
    'try{text(await tools.write({path:"/work/private.txt",content:"forbidden"}));}catch(e){text("write-denied:"+String(e));}',
  ].join("\n") } }]);
  const run = vi.spyOn(SandboxDO.prototype, "run"), readObject = vi.spyOn(SandboxDO.prototype, "readObject");
  await runInDurableObject(env.THREAD.getByName(group), async (i, s) => {
    const row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='message'").one();
    expect((await (i as any).sendAgentMessage({ to: "owner", text: "file", files: ["/work/out/note.txt"] }, "owner-file", row)).status).toBe("accepted");
  });
  await vi.waitFor(() => expect(seen.outputs.join("\n")).toContain("peer-visible"), { timeout: 10000 });
  await vi.waitFor(async () => {
    await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
      const row = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='agent'").one();
      expect(row.status).toBe("done");
      expect(await (i as any).sandboxTaskForInput(row)).toBeUndefined();
    });
  }, { timeout: 10000 });
  expect(seen.outputs.join("\n")).not.toContain("OWNER-PRIVATE-SENTINEL");
  expect(readObject).not.toHaveBeenCalled();
  for (const [{ operation }] of run.mock.calls) expect(operation).toMatchObject({ kind: "writeBytes", createOnly: true, path });
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

it("owner receives a valid group attachment and reads only that attachment without a sandbox task", async () => {
  await seed("owner", 10000001, 1); await seed(group, 10000003, 1);
  const file = await new MediaRepository({ bucket: env.ASSETS, scope: group }).put({ bytes: new TextEncoder().encode("public attachment"), name: "public.txt", mime: "text/plain" });
  const message = { id: messageId(group, "owner-file"), from: group, to: "owner", text: "file", files: [file] };
  await runInDurableObject(env.THREAD.getByName(group), (_i, s) => s.storage.put("agent-sent:" + message.id, { inputHash: "fixture", message, generation: 0 }));
  expect(await receiveError(env.THREAD.getByName("owner"), message)).toBe("accepted");
  await runInDurableObject(env.THREAD.getByName("owner"), async (instance, s) => {
    const i = instance as any;
    const row = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE message_id=?", message.id).one();
    expect(await i.sandboxTaskForInput(row)).toBeUndefined();
    expect(new TextDecoder().decode((await i.readAgentBlob(row, JSON.parse(row.agent_files)[0])).bytes)).toBe("public attachment");
    await expect(i.readAgentBlob(row, "/work/private.txt")).rejects.toThrow("agent_file_access_denied");
    await s.storage.deleteAlarm();
  });
});

it("a child without coding_exec can receive, read and return only its registered attachments", async () => {
  const { cid, address } = await child(group);
  await env.SANDBOX.getByName(group).writeFile("/work/source.txt", new TextEncoder().encode("child-visible"), "child-source", true);
  const receipt = await runInDurableObject(env.THREAD.getByName(group), async (i, s) => {
    const row = s.storage.sql.exec<{ received_at: number }>("SELECT * FROM inbound WHERE kind='message'").one();
    const args = { to: address, text: "file", files: ["/work/source.txt"] };
    const ticket = await (i as any).reserveAgentMessage(args, "child-file", row.received_at);
    return (i as any).sendAgentMessage(args, "child-file", row, undefined, ticket);
  });
  const parent = env.THREAD.getByName(group);
  expect((await parent.validateSubagentAccess(cid))?.capabilities.coding).toBe(false);
  await runInDurableObject(parent, async i => {
    expect(JSON.stringify(await i.subagentCoding(cid, { kind: "read", operationId: "read-attachment", path: receipt.files[0] }))).toContain("child-visible");
    expect((await i.subagentCoding(cid, { kind: "exec", operationId: "no-exec", command: "echo forbidden", timeoutMs: 1000 })).isError).toBe(true);
    expect((await i.subagentCoding(cid, { kind: "read", operationId: "private-read", path: "/work/private.txt" })).isError).toBe(true);
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    const row = s.storage.sql.exec<{ received_at: number }>("SELECT received_at FROM inbox WHERE request_id=?", receipt.messageId).one();
    const args = { to: group, text: "return", files: receipt.files };
    const ticket = await (i as any).reserveAgentMessage(args, "child-return", row.received_at);
    expect((await (i as any).sendAgentMessage(args, "child-return", undefined, ticket)).status).toBe("accepted");
    await s.storage.deleteAlarm();
  });
});

it.each(["second-file", "inbound-sql"])("real importFiles -> SandboxDO -> WorkspaceManager survives %s failure and preserves subsequently edited copy", async failure => {
  await seed("owner", 10000001, 1); await seed(group, 10000003, 1);
  const files = await Promise.all(["one", "two"].map(name => new MediaRepository({ bucket: env.ASSETS, scope: "owner" }).put({ bytes: new TextEncoder().encode(name), name: name + ".txt", mime: "text/plain" })));
  const message = { id: messageId("owner", "0:retry"), from: "owner", to: group, text: "files", files };
  await runInDurableObject(env.THREAD.getByName("owner"), (_i, s) => s.storage.put("agent-sent:" + message.id, { inputHash: "fixture", message, generation: 0 }));
  const sandbox = env.SANDBOX.getByName(group);
  await wire(sandbox);
  if (failure === "second-file") await env.ASSETS.delete(await scopePrefix("owner") + "/assets/" + files[1]!.id);
  if (failure === "inbound-sql") await runInDurableObject(env.THREAD.getByName(group), (_i, s) => {
    s.storage.sql.exec("CREATE TRIGGER fail_agent_insert BEFORE INSERT ON inbound WHEN NEW.kind='agent' BEGIN SELECT RAISE(ABORT,'synthetic_sql_failure'); END");
  });
  const error = await receiveError(env.THREAD.getByName(group), message);
  expect(error).toContain(failure === "second-file" ? "asset_not_found" : "synthetic_sql_failure");
  const path = "/work/agent-files/" + message.id.slice(6) + "/0-one.txt";
  expect(new TextDecoder().decode((await sandbox.readBlob(path)).bytes)).toBe("one");
  await sandbox.writeFile(path, "receiver edited", "edit-copy");
  // 跨过工作区最近 32 个操作结果的退休边界；附件重放仍只回执，不覆盖编辑。
  if (failure === "inbound-sql") for (let n = 0; n < 33; n++) await sandbox.writeFile("/work/later.txt", String(n), "later-" + n);
  if (failure === "inbound-sql") await runInDurableObject(env.THREAD.getByName(group), (_i, s) => { s.storage.sql.exec("DROP TRIGGER fail_agent_insert"); });
  if (failure === "second-file") await new MediaRepository({ bucket: env.ASSETS, scope: "owner" }).put({ bytes: new TextEncoder().encode("two"), name: "two.txt", mime: "text/plain" });
  await evictDurableObject(sandbox);
  const receipt = await env.THREAD.getByName(group).agentReceive(message);
  expect(receipt.status).toBe("accepted");
  expect(receipt.files).toHaveLength(2);
  expect(new TextDecoder().decode((await sandbox.readBlob(path)).bytes)).toBe("receiver edited");
  expect(new TextDecoder().decode((await sandbox.readBlob(receipt.files[1]!)).bytes)).toBe("two");
  expect((await env.THREAD.getByName(group).agentReceive(message)).status).toBe("duplicate");
  expect((await env.ASSETS.list({ prefix: await scopePrefix(group) + "/assets/" })).objects).toEqual([]);
  await runInDurableObject(env.THREAD.getByName(group), async (_i, s) => {
    expect(s.storage.sql.exec("SELECT * FROM inbound WHERE message_id=?", message.id).toArray()).toHaveLength(1);
    await s.storage.deleteAlarm();
  });
});

it.each(["edited", "deleted"])("duplicate child delivery preserves %s copies and returns the stored receipt", async copy => {
  const { address } = await child("owner", { cid: FIXED_CID, coding: true, endedAt: Date.now() });
  const bytes = new TextEncoder().encode("original");
  const ref = await new MediaRepository({ bucket: env.ASSETS, scope: "owner" }).put({ bytes, name: "review.txt", mime: "text/plain" });
  const message = { id: messageId("owner", "0:review-duplicate"), from: "owner", to: address, text: "file", files: [ref] };
  const path = "/work/agent-files/" + message.id.slice(6) + "/0-review.txt";
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    await s.storage.put("agent-sent:" + message.id, { inputHash: "fixture", message, generation: 0 });
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (_i, s) => {
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,agent_hash,agent_files) VALUES(?,?,?,'reported',?,?)", message.id, incomingText(message, [path]), Date.now(), fingerprint(message), JSON.stringify([path]));
  });
  if (copy === "edited") await blob(address, path, new TextEncoder().encode("receiver edited"));
  const before = await env.SANDBOX.getByName(address).files();
  const receipts = await runInDurableObject(env.SUBAGENT.getByName(address), async i => Promise.all([i.agentReceive(message), i.agentReceive(message)]));
  expect(receipts).toEqual([0, 1].map(() => ({ messageId: message.id, status: "duplicate", files: [path] })));
  expect(await env.SANDBOX.getByName(address).files()).toEqual(before);
  const conflict = { ...message, text: "different" };
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    await s.storage.put("agent-sent:" + message.id, { inputHash: "fixture", message: conflict, generation: 0 });
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    await expect(i.agentReceive(conflict)).rejects.toThrow("agent_message_conflict");
    await s.storage.deleteAlarm();
  });
});

it.each(["group", "child"] as const)("%s attachment import no longer invokes the failing second container snapshot", async target => {
  const f = await fileFixture(target); await wire(f.sandbox, true);
  expect(await receiveError(f.recipient, f.message)).toBe("accepted");
  await runInDurableObject(f.sandbox, async (instance, s) => {
    const i = instance as any;
    expect(i.reviewSnapshots()).toBe(0);
    expect((await s.storage.list({ prefix: "workspace:op:" })).size).toBe(0);
    const rebuilt = new SandboxDO(s, env);
    await rebuilt.writeFile(f.paths[1]!, new TextEncoder().encode("two"), "agent-import:" + f.message.id + ":1", true);
    expect(new TextDecoder().decode((await rebuilt.readBlob(f.paths[1]!)).bytes)).toBe("two");
  });
  expect((await f.recipient.agentReceive(f.message)).status).toBe("duplicate");
  await runInDurableObject(f.recipient, (_i, s) => s.storage.deleteAlarm());
});

it.each(["group", "child"] as const)("%s recovers a real second attachment R2 failure across SandboxDO reconstruction", async target => {
  const f = await fileFixture(target), hash = await sha256(new TextEncoder().encode("two"));
  await runInDurableObject(f.sandbox, async instance => {
    const i = instance as any, bucket = i.workspace.deps.bucket;
    i.workspace.deps.bucket = new Proxy(bucket, { get(t, prop) {
      if (prop === "put") return async (...args: any[]) => { if (args[0].endsWith("/blobs/" + hash)) throw new Error("synthetic_r2_outage"); return t.put(...args); };
      const value = Reflect.get(t, prop); return typeof value === "function" ? value.bind(t) : value;
    } });
  });
  expect(await receiveError(f.recipient, f.message)).toBe("synthetic_r2_outage");
  expect(new TextDecoder().decode((await f.sandbox.readBlob(f.paths[0]!)).bytes)).toBe("one");
  await runInDurableObject(f.sandbox, async (_i, s) => {
    const rebuilt = new SandboxDO(s, env);
    await rebuilt.writeFile(f.paths[1]!, new TextEncoder().encode("two"), "agent-import:" + f.message.id + ":1", true);
    expect(new TextDecoder().decode((await rebuilt.readBlob(f.paths[1]!)).bytes)).toBe("two");
  });
  expect((await f.recipient.agentReceive(f.message)).status).toBe("accepted");
  expect((await f.recipient.agentReceive(f.message)).status).toBe("duplicate");
  await runInDurableObject(f.recipient, (_i, s) => s.storage.deleteAlarm());
});

it.each(["group", "child"] as const)("%s SQL failure then delete, 33 operations, fresh SandboxDO: no overwrite or resurrection", async target => {
  const f = await fileFixture(target); await wire(f.sandbox);
  const table = target === "child" ? "inbox" : "inbound";
  await runInDurableObject(f.recipient, (_i, s) => s.storage.sql.exec("CREATE TRIGGER reviewer_fail BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(ABORT,'reviewer_sql_failure'); END"));
  expect(await receiveError(f.recipient, f.message)).toContain("reviewer_sql_failure");
  await f.sandbox.run({ operationId: "delete-first", operation: { kind: "remove", path: f.paths[0]! } });
  for (let n = 0; n < 33; n++) await f.sandbox.writeFile("/work/later.txt", String(n), "expire-" + n);
  await runInDurableObject(f.sandbox, async (_i, s) => {
    const rebuilt = new SandboxDO(s, env), host = runtime();
    Object.assign((rebuilt as any).workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
    await rebuilt.writeFile(f.paths[0]!, new TextEncoder().encode("one"), "agent-import:" + f.message.id + ":0", true);
    await expect(rebuilt.readBlob(f.paths[0]!)).rejects.toThrow("not_found");
    expect(new TextDecoder().decode((await rebuilt.readBlob(f.paths[1]!)).bytes)).toBe("two");
  });
  await runInDurableObject(f.recipient, (_i, s) => s.storage.sql.exec("DROP TRIGGER reviewer_fail"));
  expect((await f.recipient.agentReceive(f.message)).status).toBe("accepted");
  expect(await runInDurableObject(f.sandbox, async i => { try { await i.readBlob(f.paths[0]!); return "present"; } catch (e) { return (e as Error).message; } })).toBe("not_found");
  expect(new TextDecoder().decode((await f.sandbox.readBlob(f.paths[1]!)).bytes)).toBe("two");
  await runInDurableObject(f.recipient, (_i, s) => s.storage.deleteAlarm());
});

it("unknown container command remains unknown across real SandboxDO reconstruction and is not replayed", async () => {
  await runInDurableObject(env.SANDBOX.getByName("review-unknown"), async (instance, s) => {
    const i = instance as any, host = runtime();
    host.fail();
    Object.assign(i.workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
    const command = { operationId: "lost-command", operation: { kind: "exec" as const, command: "unknown" } };
    expect((await i.run(command)).status).toBe("unknown");
    const rebuilt = new SandboxDO(s, env);
    Object.assign((rebuilt as any).workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
    expect((await rebuilt.run(command)).status).toBe("unknown");
    expect(host.executions()).toBe(1);
  });
});
