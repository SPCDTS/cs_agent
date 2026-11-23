import { env, reset, runInDurableObject, evictDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { input } from "./helpers";
import { SENT_LIMIT, sendAgent, type AgentTicket } from "../src/communication/service";
import { messageId, type AgentSend } from "../src/communication/model";
import { ThreadDO } from "../src/thread";
import { SubagentDO } from "../src/subagent/do";
import { runtime } from "./sandbox-runtime-fixture";

const group = "group:200000001", cid = "11111111-1111-4111-8111-111111111111";
// 容量测试停在真实持久入箱边界，不让无关模型/QQ 消费数千条夹具；存储、接收和沙箱均为真实实现。
async function clearFixtures() {
  // 长测中的空闲对象可能已自然驱逐；显式清理固定夹具地址并丢弃内存缓存，避免跨用例状态泄漏。
  await abortAllDurableObjects();
  const children = ["sub:owner:" + cid, "sub:" + group + ":" + cid];
  const stubs: DurableObjectStub[] = [env.THREAD.getByName("owner"), env.THREAD.getByName(group),
    ...children.map(name => env.SUBAGENT.getByName(name)),
    ...["owner", group, ...children].map(name => env.SANDBOX.getByName(name))];
  for (const stub of stubs) await runInDurableObject<DurableObject, void>(stub, async (_i, s) => { await s.storage.deleteAlarm(); await s.storage.deleteAll(); });
  await reset(); await abortAllDurableObjects();
}
beforeEach(async () => {
  await clearFixtures();
  vi.spyOn(ThreadDO.prototype, "alarm").mockResolvedValue(undefined);
  vi.spyOn(SubagentDO.prototype, "alarm").mockResolvedValue(undefined);
});
afterEach(async () => { await clearFixtures(); vi.restoreAllMocks(); });
// 慢 CI 会自然驱逐空闲对象；先真实唤醒，再显式驱逐，不能把“已不在内存”当成恢复失败。
async function evict(stub: DurableObjectStub) {
  await runInDurableObject<DurableObject, void>(stub, () => {});
  await evictDurableObject(stub);
}
async function seed(scope: string) {
  await runInDurableObject(env.THREAD.getByName(scope), async (instance, s) => {
    await (instance as any).queueInput(input(1, "local", 10000001, scope === group ? 200000001 : undefined));
    s.storage.sql.exec("UPDATE inbound SET status='done',turn_id='local'");
    await s.storage.deleteAlarm();
  });
}
async function reserve(scope: string, args: AgentSend, id: string, at = Date.now()): Promise<AgentTicket> {
  return runInDurableObject(env.THREAD.getByName(scope), async instance => (instance as any).reserveAgentMessage(args, id, at));
}
async function deliver(scope: string, args: AgentSend, id: string, ticket?: AgentTicket) {
  return runInDurableObject(env.THREAD.getByName(scope), async (instance, s) => {
    const i = instance as any, row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='message' ORDER BY rowid DESC LIMIT 1").one();
    return i.sendAgentMessage(args, id, row, undefined, ticket);
  });
}
async function burst(scope: string, to: string, count: number, prefix = "burst", files?: string[]) {
  await runInDurableObject(env.THREAD.getByName(scope), async (instance, s) => {
    const i = instance as any, row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='message' ORDER BY rowid DESC LIMIT 1").one();
    for (let n = 0; n < count; n++) {
      const args = { to, text: prefix + n, ...(files ? { files } : {}) }, id = prefix + n;
      const ticket = await i.reserveAgentMessage(args, id, Date.now());
      expect((await i.sendAgentMessage(args, id, row, undefined, ticket)).status).toBe("accepted");
      if (n % 128 === 0) expect((await s.storage.list({ prefix: "agent-sent:" })).size).toBeLessThanOrEqual(SENT_LIMIT);
    }
    expect((await s.storage.list({ prefix: "agent-sent:" })).size).toBeLessThanOrEqual(SENT_LIMIT);
    expect(s.storage.sql.exec<any>("SELECT generation FROM session_state").one().generation).toBe(0);
  });
}
async function child(parent: string) {
  await seed(parent);
  const identity = { turn: "message", as: { userId: "10000001", nickname: "", owner: true } };
  const origin = { generation: 0, target: parent === group ? { kind: "group", groupId: "200000001" } : { kind: "private", userId: "10000001" }, selfId: "99999999", scopeName: "", capabilities: { coding: false } };
  await runInDurableObject(env.THREAD.getByName(parent), (_i, s) => {
    s.storage.sql.exec("INSERT INTO subagents(id,task,created_at,status,identity_json,origin_json,timeout_ms,deadline) VALUES(?,'test',?,'done',?,?,0,0)", cid, Date.now(), JSON.stringify(identity), JSON.stringify(origin));
  });
  const address = "sub:" + parent + ":" + cid;
  await env.SUBAGENT.getByName(address).start({ parent, id: cid, task: "test", identity, model: { provider: "faux", id: "test" } } as any);
  await runInDurableObject(env.SUBAGENT.getByName(address), async (_i, s) => {
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    s.storage.sql.exec("UPDATE meta SET value=? WHERE key='subagent'", JSON.stringify({ ...meta, status: "done" }));
    s.storage.sql.exec("DELETE FROM inbox"); await s.storage.deleteAlarm();
  });
  return { address, identity, origin };
}

it.each(["owner", group])("%s crosses two full proof cycles without resetting and rejects retired, altered and stale-generation calls", async from => {
  const to = from === "owner" ? group : "owner";
  await seed(from); await seed(to);
  const args = { to, text: "original" }, at = Date.now(), ticket = await reserve(from, args, "original", at);
  const receipt = await deliver(from, args, "original", ticket);
  expect((await deliver(from, args, "original", ticket)).status).toBe("duplicate");
  await expect(deliver(from, { to, text: "altered" }, "original", ticket)).rejects.toThrow("agent_message_conflict");
  await burst(from, to, SENT_LIMIT * 2 + 5);
  console.log("proof-cycle-complete", { from, delivered: SENT_LIMIT * 2 + 6 });
  await expect(deliver(from, args, "original", ticket)).rejects.toThrow("agent_message_expired");
  await expect(reserve(from, args, "original", at)).rejects.toThrow("agent_message_expired");
  await runInDurableObject(env.THREAD.getByName(from), async (_i, s) => {
    expect(await s.storage.get("agent-sent:" + receipt.messageId)).toBeUndefined();
    expect(await s.storage.get<any>("agent-proof-state")).toMatchObject({ generation: 0 });
    expect((await s.storage.list({ prefix: "agent-proof" })).size).toBe(1);
  });
  await runInDurableObject(env.THREAD.getByName(to), async (_i, s) => {
    expect(s.storage.sql.exec<any>("SELECT count(*) AS n FROM inbound WHERE kind='agent'").one().n).toBe(SENT_LIMIT * 2 + 6);
    s.storage.sql.exec("UPDATE inbound SET status='done'"); await s.storage.deleteAlarm();
  });
  const lastArgs = { to, text: "last" }, lastTicket = await reserve(from, lastArgs, "last");
  await deliver(from, lastArgs, "last", lastTicket);
  await runInDurableObject(env.THREAD.getByName(to), async (_i, s) => { s.storage.sql.exec("UPDATE inbound SET status='done'"); await s.storage.deleteAlarm(); });
  vi.mocked(ThreadDO.prototype.alarm).mockRestore();
  expect(await env.THREAD.getByName(to).resetSession(to, "target-reset", "archive")).toMatchObject({ generation: 1 });
  await expect(deliver(from, lastArgs, "last", lastTicket)).rejects.toThrow("agent_session_revoked");
}, 120_000);

it("protects reserved and unknown slots across GC and real eviction; definite preparation refusals are reclaimable", async () => {
  await seed("owner");
  const args = { to: group, text: "pending" }, pending = await reserve("owner", args, "pending");
  await expect(deliver("owner", args, "pending", pending)).rejects.toThrow("agent_recipient_not_ready");
  const prepared = await reserve("owner", { to: group, text: "reserved" }, "reserved");
  await expect(deliver("owner", { to: group, text: "legacy" }, "legacy")).rejects.toThrow("agent_message_expired");
  await seed(group);
  const bad = { to: group, files: ["/work/secret.txt"] };
  await env.SANDBOX.getByName("owner").saveAttachment("/work/secret.txt", new TextEncoder().encode("password=synthetic-secret-for-test"), "source");
  const refused = await reserve("owner", bad, "refused");
  await expect(deliver("owner", bad, "refused", refused)).rejects.toThrow("agent_credentials_forbidden");
  await burst("owner", group, SENT_LIMIT * 2 + 2);
  await evict(env.SANDBOX.getByName("owner")); // 本地也覆盖夹具在清理前已离开内存的情形。
  await evict(env.THREAD.getByName("owner")); await evict(env.THREAD.getByName(group));
  expect((await deliver("owner", args, "pending", pending)).status).toBe("accepted");
  expect((await deliver("owner", { to: group, text: "reserved" }, "reserved", prepared)).status).toBe("accepted");
  await expect(deliver("owner", bad, "refused", refused)).rejects.toThrow("agent_message_expired");
}, 120_000);

it("all in-flight slots backpressure before file preparation, then one completion automatically admits a fresh send", async () => {
  await seed("owner"); await seed(group);
  const args = { to: group, text: "in-flight" }, tickets: AgentTicket[] = [];
  for (let n = 0; n < SENT_LIMIT; n++) tickets.push(await reserve("owner", args, "pending" + n));
  const before = (await env.ASSETS.list()).objects.map(o => o.key);
  await expect(reserve("owner", { to: group, files: ["/work/nonexistent.txt"] }, "full-file")).rejects.toThrow("agent_history_full");
  expect((await env.ASSETS.list()).objects.map(o => o.key)).toEqual(before);
  expect((await deliver("owner", args, "pending0", tickets[0])).status).toBe("accepted");
  const next = await reserve("owner", args, "after-full");
  expect((await deliver("owner", args, "after-full", next)).status).toBe("accepted");
  await expect(deliver("owner", args, "pending0", tickets[0])).rejects.toThrow("agent_message_expired");
  expect((await deliver("owner", args, "pending511", tickets[511])).status).toBe("accepted");
}, 120_000);

it("a lost source receipt commit recovers after real eviction without reimporting an edited/deleted attachment", async () => {
  await seed("owner"); await seed(group);
  await env.SANDBOX.getByName("owner").saveAttachment("/work/file.txt", new TextEncoder().encode("original"), "source");
  const args = { to: group, files: ["/work/file.txt"] }, ticket = await reserve("owner", args, "lost");
  let path = "";
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    const storage = new Proxy(s.storage, { get(target, prop) {
      if (prop === "transaction") return (work: any) => target.transaction(async tx => {
        const result = await work(tx);
        if ((await tx.get<any>("agent-sent:" + messageId("owner", "0:lost")))?.receipt) throw new Error("receipt_commit_lost");
        return result;
      });
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(sendAgent({ env, storage, agentSessionId: "owner", generation: 0, readFile: p => env.SANDBOX.getByName("owner").readBlob(p) }, args, "lost", undefined, ticket)).rejects.toThrow("agent_delivery_unknown");
    const proof = await s.storage.get<any>("agent-sent:" + messageId("owner", "0:lost"));
    expect(proof.receipt).toBeUndefined(); expect(proof.message.files).toHaveLength(1);
  });
  await runInDurableObject(env.THREAD.getByName(group), async (_i, s) => { path = JSON.parse(s.storage.sql.exec<any>("SELECT agent_files FROM inbound WHERE kind='agent'").one().agent_files)[0]; await s.storage.deleteAlarm(); });
  const sandbox = env.SANDBOX.getByName(group);
  await runInDurableObject(sandbox, async (instance, s) => {
    const i = instance as any, host = runtime();
    Object.assign(i.workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
    expect((await s.storage.list({ prefix: "workspace:attachment:" })).size).toBe(0);
    await i.writeFile(path, "edited", "edit");
    expect((await i.run({ operationId: "remove", operation: { kind: "remove", path } })).status).toBe("committed");
  });
  await evict(sandbox); await evict(env.THREAD.getByName("owner")); await evict(env.THREAD.getByName(group));
  expect((await deliver("owner", args, "lost", ticket)).status).toBe("duplicate");
  await runInDurableObject(sandbox, async i => { await expect(i.readBlob(path)).rejects.toThrow("not_found"); });
  await runInDurableObject(env.THREAD.getByName(group), (_i, s) => expect(s.storage.sql.exec<any>("SELECT count(*) AS n FROM inbound WHERE kind='agent'").one().n).toBe(1));
});

it("a late concurrent completion cannot resurrect a proof already collected after another completion", async () => {
  await seed("owner"); await seed(group);
  await runInDurableObject(env.THREAD.getByName("owner"), async (instance, s) => {
    const i = instance as any, args = { to: group, text: "concurrent" }, ticket = await i.reserveAgentMessage(args, "concurrent", Date.now());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const real = env.THREAD.getByName(group);
    const delayed = { ...env, THREAD: { getByName: () => ({ agentGeneration: () => real.agentGeneration(), agentReceive: async (message: any) => { const receipt = await real.agentReceive(message); entered(); await gate; return receipt; } }) } } as any;
    const slow = sendAgent({ env: delayed, storage: s.storage, agentSessionId: "owner", generation: 0, readFile: async () => { throw new Error("unused"); } }, args, "concurrent", undefined, ticket);
    await reached;
    try {
      const row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='message'").one();
      expect((await i.sendAgentMessage(args, "concurrent", row, undefined, ticket)).status).toBe("duplicate");
      for (let n = 0; n < SENT_LIMIT; n++) {
        const value = { to: group, text: "later" + n }, id = "later" + n;
        const next = await i.reserveAgentMessage(value, id, Date.now());
        await i.sendAgentMessage(value, id, row, undefined, next);
      }
      expect(await s.storage.get("agent-sent:" + messageId("owner", "0:concurrent"))).toBeUndefined();
    } finally { release(); }
    await slow;
    expect(await s.storage.get("agent-sent:" + messageId("owner", "0:concurrent"))).toBeUndefined();
    expect((await s.storage.list({ prefix: "agent-sent:" })).size).toBeLessThanOrEqual(SENT_LIMIT);
  });
}, 120_000);

it.each(["owner", group])("%s child follow-ups, replies and automatic reports continue beyond 512 with bounded proof storage", async parent => {
  const f = await child(parent);
  await runInDurableObject(env.THREAD.getByName(parent), async (instance, s) => {
    const i = instance as any;
    for (let n = 0; n < SENT_LIMIT + 3; n++) {
      const args = { to: f.address, text: "follow-up" + n }, id = "follow" + n;
      const ticket = await i.reserveAgentMessage(args, id, Date.now());
      expect((await i.subagents.message({ identity: f.identity, origin: f.origin }, cid, args.text, id, ticket)).error).toBeUndefined();
    }
    expect((await s.storage.list({ prefix: "agent-sent:" })).size).toBeLessThanOrEqual(SENT_LIMIT);
  });
  await runInDurableObject(env.SUBAGENT.getByName(f.address), async (instance, s) => {
    const i = instance as any;
    // 模型回答不是本测试目标；用已持久回答输入真实自动报告状态机。
    s.storage.sql.exec("UPDATE inbox SET status='answered',answer='visible answer',outcome='done',answered_at=?", Date.now());
    const rows = s.storage.sql.exec("SELECT * FROM inbox ORDER BY rowid").toArray();
    for (const [index, row] of rows.entries()) {
      s.storage.sql.exec("UPDATE inbox SET answered_at=? WHERE request_id=?", Date.now(), row.request_id);
      const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
      await i.report(meta, row);
      // 自动报告自身跨过 512；普通回复分别在容量轮转前后验证，避免重复一整套压力矩阵。
      if (index === 0 || index === rows.length - 1) {
        const args = { to: parent, text: "reply:" + row.request_id }, id = "reply:" + row.request_id;
        const ticket = await i.reserveAgentMessage(args, id, Date.now());
        expect((await i.sendAgentMessage(args, id, undefined, ticket)).status).toBe("accepted");
      }
    }
    expect(s.storage.sql.exec<any>("SELECT count(*) AS n FROM inbox WHERE status='reported'").one().n).toBe(SENT_LIMIT + 3);
    expect((await s.storage.list({ prefix: "agent-sent:" })).size).toBeLessThanOrEqual(SENT_LIMIT);
    expect(s.storage.sql.exec<any>("SELECT count(*) AS n FROM inbox WHERE report_ticket IS NULL").one().n).toBe(0);
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.THREAD.getByName(parent), async (_i, s) => {
    expect(s.storage.sql.exec<any>("SELECT count(*) AS n FROM inbound WHERE kind='subagent'").one().n).toBe(SENT_LIMIT + 3);
    expect(s.storage.sql.exec<any>("SELECT count(*) AS n FROM inbound WHERE kind='agent'").one().n).toBe(2);
    await s.storage.deleteAlarm();
  });
}, 120_000);

it("legacy pending records remain recoverable after migration; collected legacy successes cannot be reissued", async () => {
  await seed("owner");
  const pending = { to: group, text: "old pending" }, completed = { to: group, text: "old complete" }, at = Date.now();
  await expect(deliver("owner", pending, "old-pending")).rejects.toThrow("agent_recipient_not_ready");
  await seed(group);
  await deliver("owner", completed, "old-complete");
  await burst("owner", group, SENT_LIMIT + 1, "upgrade");
  expect((await deliver("owner", pending, "old-pending")).status).toBe("accepted");
  await expect(deliver("owner", completed, "old-complete")).rejects.toThrow("agent_message_expired");
  await expect(reserve("owner", completed, "old-complete", at)).rejects.toThrow("agent_message_expired");
  await expect(reserve("owner", completed, "old-complete", 0)).rejects.toThrow("agent_message_expired");
  expect(await reserve("owner", pending, "old-pending", 0)).toHaveProperty("nonce");
}, 120_000);

it.each(["group", "child"] as const)("%s partial attachment commits survive cleanup pressure, then retire only after durable inbox commit", async target => {
  const to = target === "child" ? (await child("owner")).address : group;
  if (target === "group") { await seed("owner"); await seed(group); }
  const source = env.SANDBOX.getByName("owner"), recipient = env.SANDBOX.getByName(to);
  await source.saveAttachment("/work/one.txt", new TextEncoder().encode("one"), "source-one");
  await source.saveAttachment("/work/two.txt", new TextEncoder().encode("two"), "source-two");
  const args = { to, files: ["/work/one.txt", "/work/two.txt"] }, ticket = await reserve("owner", args, "partial");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("two")))).map(n => n.toString(16).padStart(2, "0")).join("");
  await runInDurableObject(recipient, instance => {
    const i = instance as any, bucket = i.workspace.deps.bucket;
    i.workspace.deps.bucket = new Proxy(bucket, { get(t, p) {
      if (p === "put") return (...values: any[]) => { if (values[0].endsWith("/blobs/" + hash)) throw new Error("round4_blob_outage"); return t.put(...values); };
      const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v;
    } });
  });
  await expect(deliver("owner", args, "partial", ticket)).rejects.toThrow("agent_delivery_unknown");
  const first = "/work/agent-files/" + messageId("owner", "0:partial").slice(6) + "/0-one.txt";
  await runInDurableObject(recipient, async (instance, s) => {
    const i = instance as any, host = runtime();
    Object.assign(i.workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
    expect((await s.storage.list({ prefix: "workspace:attachment:" })).size).toBe(1);
    expect((await i.run({ operationId: "delete-first", operation: { kind: "remove", path: first } })).status).toBe("committed");
  });
  // 另一个可达目标的成功发送触发 GC，不能删除这条部分导入的证明。
  if (target === "child") await seed(group);
  await burst("owner", group, SENT_LIMIT + 1, "while-partial");
  await evict(recipient); await evict(env.THREAD.getByName("owner"));
  if (target === "child") await evict(env.SUBAGENT.getByName(to)); else await evict(env.THREAD.getByName(to));
  const receipt = await deliver("owner", args, "partial", ticket);
  expect(receipt.status).toBe("accepted");
  await runInDurableObject(recipient, async i => { await expect(i.readBlob(first)).rejects.toThrow("not_found"); });
  expect(new TextDecoder().decode((await recipient.readBlob(receipt.files[1])).bytes)).toBe("two");
  await runInDurableObject(recipient, async (_i, s) => expect((await s.storage.list({ prefix: "workspace:attachment:" })).size).toBe(0));
  expect((await deliver("owner", args, "partial", ticket)).status).toBe("duplicate");
}, 120_000);

it("an unknown automatic report retains its original ticket across GC, eviction and concurrent completion", async () => {
  const f = await child("owner");
  await runInDurableObject(env.THREAD.getByName("owner"), (_i, s) => {
    s.storage.sql.exec("CREATE TRIGGER fail_report BEFORE INSERT ON inbound WHEN NEW.kind='subagent' BEGIN SELECT RAISE(ABORT,'round4_report_sql'); END");
  });
  let originalTicket = "";
  await runInDurableObject(env.SUBAGENT.getByName(f.address), async (instance, s) => {
    const i = instance as any;
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome,answered_at) VALUES('report','task',?,'answered','complete answer','done',?)", Date.now(), Date.now());
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    await expect(i.report(meta, s.storage.sql.exec("SELECT * FROM inbox WHERE request_id='report'").one())).rejects.toThrow("agent_delivery_unknown");
    originalTicket = s.storage.sql.exec<any>("SELECT report_ticket FROM inbox WHERE request_id='report'").one().report_ticket;
    for (let n = 0; n < SENT_LIMIT + 1; n++) {
      const args = { to: "owner", text: "later" + n }, id = "later" + n;
      const ticket = await i.reserveAgentMessage(args, id, Date.now());
      await i.sendAgentMessage(args, id, undefined, ticket);
    }
    expect(s.storage.sql.exec<any>("SELECT status FROM inbox WHERE request_id='report'").one().status).toBe("answered");
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => { s.storage.sql.exec("DROP TRIGGER fail_report"); await s.storage.deleteAlarm(); });
  await evict(env.THREAD.getByName("owner")); await evict(env.SUBAGENT.getByName(f.address));
  await runInDurableObject(env.SUBAGENT.getByName(f.address), async (instance, s) => {
    const i = instance as any, row = s.storage.sql.exec<any>("SELECT * FROM inbox WHERE request_id='report'").one();
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    expect(row.report_ticket).toBe(originalTicket);
    await Promise.all([i.report(meta, row), i.report(meta, row)]);
    expect(s.storage.sql.exec<any>("SELECT status FROM inbox WHERE request_id='report'").one().status).toBe("reported");
    expect(JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value).reportCount).toBe(1);
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.THREAD.getByName("owner"), (_i, s) => expect(s.storage.sql.exec<any>("SELECT count(*) AS n FROM inbound WHERE kind='subagent'").one().n).toBe(1));
}, 120_000);

it("the child retention alarm preserves a valid unresolved proof instead of silently deleting it", async () => {
  const f = await child("owner"), realNow = Date.now();
  await runInDurableObject(env.SUBAGENT.getByName(f.address), async (instance, s) => {
    const i = instance as any;
    const ticket = await i.reserveAgentMessage({ to: "owner", text: "reserved" }, "retained", Date.now());
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    s.storage.sql.exec("UPDATE meta SET value=? WHERE key='subagent'", JSON.stringify({ ...meta, endedAt: meta.createdAt }));
    vi.mocked(SubagentDO.prototype.alarm).mockRestore();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 15 * 86400_000);
    try {
      await i.alarm();
      expect(await s.storage.get<any>("agent-sent:" + messageId(f.address, meta.createdAt + ":retained"))).toMatchObject({ nonce: ticket.nonce });
      expect(s.storage.sql.exec("SELECT * FROM meta WHERE key='subagent'").toArray()).toHaveLength(1);
      expect(await s.storage.getAlarm()).toBeGreaterThan(Date.now());
    } finally { clock.mockRestore(); await s.storage.deleteAlarm(); }
  });
});

it("parent follow-up authorization rejects the wrong reply channel before reserving a proof slot", async () => {
  const f = await child("owner");
  await runInDurableObject(env.THREAD.getByName("owner"), async (instance, s) => {
    const i = instance as any;
    let reservations = 0;
    const result = await i.subagents.message({ identity: f.identity, origin: { ...f.origin, replyChannel: "web" } }, cid, "wrong channel", "wrong-channel", async () => {
      reservations++;
      return i.reserveAgentMessage({ to: f.address, text: "wrong channel" }, "wrong-channel", Date.now());
    });
    expect(result.error).toBe(true); expect(reservations).toBe(0);
    expect((await s.storage.list({ prefix: "agent-sent:" })).size).toBe(0);
  });
});
