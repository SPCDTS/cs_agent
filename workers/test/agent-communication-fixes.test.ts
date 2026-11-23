import { env, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { input } from "./helpers";
import { runtime } from "./sandbox-runtime-fixture";
import { fingerprint, messageId, redactReport } from "../src/communication/model";
import { SENT_LIMIT } from "../src/communication/service";
import { agentSendTool } from "../src/communication/tool";
import { MediaRepository, scopePrefix } from "../src/media/repository";
import { McpPolicyStore } from "../src/mcp/policy";
import { ThreadMcp } from "../src/mcp";
import { MCP_CONFIG } from "../src/mcp/config";

const group = "group:200000001";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function seed(scope: string, user = 10000001, n = 1) {
  await runInDurableObject(env.THREAD.getByName(scope), async (i, s) => {
    await (i as any).queueInput(input(n, "local", user, scope === group ? 200000001 : undefined));
    s.storage.sql.exec("UPDATE inbound SET turn_id='test-turn',status='done'");
    await s.storage.deleteAlarm();
  });
}
async function send(from: string, to: string, seedId = "message", text = "hello", kind?: string) {
  return runInDurableObject(env.THREAD.getByName(from), async (i, s) => {
    const row = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='message' ORDER BY rowid DESC LIMIT 1").one();
    return (i as any).sendAgentMessage({ to, text }, seedId, { ...row, ...(kind ? { kind } : {}) });
  });
}
async function child(parent = "owner") {
  const cid = crypto.randomUUID();
  await seed(parent);
  const identity = { turn: "message", as: { userId: "10000001", nickname: "", owner: true } };
  const origin = { generation: 0, target: parent === group ? { kind: "group", groupId: "200000001" } : { kind: "private", userId: "10000001" }, selfId: "99999999", scopeName: "", capabilities: { coding: parent === "owner" } };
  await runInDurableObject(env.THREAD.getByName(parent), async (_i, s) => {
    s.storage.sql.exec("INSERT INTO subagents(id,task,created_at,status,identity_json,origin_json,timeout_ms,deadline) VALUES(?,'test',?,'done',?,?,0,0)", cid, Date.now(), JSON.stringify(identity), JSON.stringify(origin));
  });
  const address = "sub:" + parent + ":" + cid;
  await env.SUBAGENT.getByName(address).start({ parent, id: cid, task: "test", identity, model: { provider: "faux", id: "test" } } as any);
  await runInDurableObject(env.SUBAGENT.getByName(address), async (_i, s) => {
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    s.storage.sql.exec("UPDATE meta SET value=? WHERE key='subagent'", JSON.stringify({ ...meta, status: "done" }));
    s.storage.sql.exec("DELETE FROM inbox");
    await s.storage.deleteAlarm();
  });
  return { cid, address, identity, origin };
}

it("group to owner keeps a session principal, cannot borrow owner sandbox, and MCP is bounded by eventAllow", async () => {
  await seed("owner"); await seed(group, 10000003);
  await send(group, "owner");
  await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
    const owner = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='message'").one();
    const peer = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='agent'").one();
    expect((await (i as any).sandboxTaskForInput(owner)).permissions.coding).toBe(true);
    expect(await (i as any).sandboxTaskForInput(peer)).toBeUndefined();
    const authority = await (i as any).mcpAuthority(peer);
    expect(authority).toMatchObject({ kind: "agent", actor: "agent:owner", owner: false });
    const policy = new McpPolicyStore((i as any).database);
    const server = { id: "test", tools: { eventAllow: ["safe_read"] }, resourceAllow: ["private:"] } as any;
    for (const candidate of [authority, { ...authority, owner: true }]) {
      expect(await policy.allows(candidate, server, "write_admin")).toBe(false);
      expect(await policy.allows(candidate, server, "safe_read")).toBe(true);
      expect(await policy.resourcePrefixes(candidate, server)).toEqual([]);
      expect(await policy.environments(candidate, server)).toEqual({ kind: "selected", envIds: [] });
      expect(await policy.requiresApproval(candidate, server, "write_admin")).toBe(true);
      await expect(policy.decide("owner", "invalid", "approve", candidate)).rejects.toThrow("denied");
    }
    const mcp = new ThreadMcp((i as any).database, env, createRegistry(), async () => authority, MCP_CONFIG, { scope: "owner" });
    await expect(mcp.setAccess(group, "notion", { tools: [], resourceAllow: [], actors: ["*"], expiresAt: null }, "none", { ...authority, owner: true })).rejects.toThrow("denied");
    await s.storage.deleteAlarm();
  });
  for (const kind of ["event", "schedule"]) await expect(send("owner", group, kind, "blocked", kind)).rejects.toThrow("agent_turn_denied");
  expect((await send("owner", group, "reply")).status).toBe("accepted");
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    expect(s.storage.sql.exec("SELECT * FROM events WHERE kind='agent_send'").toArray()).toHaveLength(1);
  });
});

it.each(["subagent.message", "agent_send"])("%s rejects another member before insertion without contaminating persistent identity or the old report", async mode => {
  const { cid, address, identity, origin } = await child(group);
  await env.THREAD.getByName(group).subagentReport({ subagentId: cid, requestId: "old", text: "done", identity, outcome: "done", state: { status: "done", version: 1 } } as any);
  await seed(group, 10000003, 2);
  await runInDurableObject(env.THREAD.getByName(group), async (i, s) => {
    const report = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='subagent'").one();
    expect((await (i as any).mcpAuthority(report)).owner).toBe(true);
    if (mode === "subagent.message") {
      expect(await (i as any).subagents.message({ identity: { turn: "message", as: { userId: "10000003", nickname: "", owner: false } }, origin }, cid, "member followup", "followup")).toMatchObject({ error: true, text: "agent_child_identity_denied" });
    } else {
      const member = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='message' ORDER BY rowid DESC LIMIT 1").one();
      await expect((i as any).sendAgentMessage({ to: address, text: "member followup" }, "followup", member)).rejects.toThrow("agent_child_identity_denied");
    }
    expect(JSON.parse(s.storage.sql.exec<any>("SELECT identity_json FROM subagents WHERE id=?", cid).one().identity_json)).toEqual(identity);
    expect((await (i as any).mcpAuthority(report)).owner).toBe(true);
    expect((await (i as any).scheduleAccess(report)).kind).toBe("manage");
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (_i, s) => {
    expect(s.storage.sql.exec("SELECT * FROM inbox WHERE agent_hash IS NOT NULL").toArray()).toHaveLength(0);
    expect(JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value).identity).toEqual(identity);
    await s.storage.deleteAlarm();
  });
});

it("same-owner parent communication retains explicitly delegated child capabilities", async () => {
  const { cid, address } = await child();
  expect((await send("owner", address)).status).toBe("accepted");
  expect(await env.THREAD.getByName("owner").validateSubagentAccess(cid)).toMatchObject({ authority: { owner: true, actor: "10000001" }, capabilities: { coding: true } });
  await runInDurableObject(env.SUBAGENT.getByName(address), (_i, s) => s.storage.deleteAlarm());
});

it("an Agent round forwarding to its owner's child cannot preserve human-owner delegation", async () => {
  const { cid, address } = await child();
  await seed(group, 10000003);
  await send(group, "owner", "peer-request");
  await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
    const peer = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='agent'").one();
    await expect((i as any).sendAgentMessage({ to: address, text: "forwarded request" }, "forward", peer)).rejects.toThrow("agent_child_identity_denied");
    expect((await (i as any).subagentAccess(cid, true)).authority.owner).toBe(true);
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), (_i, s) => s.storage.deleteAlarm());
});

it.each(["second-file", "inbound-sql"])("real importFiles -> SandboxDO -> WorkspaceManager survives %s failure and preserves subsequently edited copy", async failure => {
  await seed("owner"); await seed(group, 10000003);
  const files = await Promise.all(["one", "two"].map(name => new MediaRepository({ bucket: env.ASSETS, scope: "owner" }).put({ bytes: new TextEncoder().encode(name), name: name + ".txt", mime: "text/plain" })));
  const message = { id: messageId("owner", "0:retry"), from: "owner", to: group, text: "files", files };
  await runInDurableObject(env.THREAD.getByName("owner"), (_i, s) => s.storage.put("agent-sent:" + message.id, { inputHash: "fixture", message, generation: 0 }));
  const sandbox = env.SANDBOX.getByName(group);
  await runInDurableObject(sandbox, async (i) => {
    const host = runtime();
    // Only the unavailable container boundary is replaced. saveAttachment, run, manifests, CAS and R2 remain real.
    Object.assign((i as any).workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });

  });
  if (failure === "second-file") await env.ASSETS.delete(await scopePrefix("owner") + "/assets/" + files[1]!.id);
  if (failure === "inbound-sql") await runInDurableObject(env.THREAD.getByName(group), (_i, s) => {
    s.storage.sql.exec("CREATE TRIGGER fail_agent_insert BEFORE INSERT ON inbound WHEN NEW.kind='agent' BEGIN SELECT RAISE(ABORT,'synthetic_sql_failure'); END");
  });
  const error = await runInDurableObject(env.THREAD.getByName(group), async i => {
    try { await i.agentReceive(message); return ""; } catch (error) { return (error as Error).message; }
  });
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

it("automatic reports retain over 20K text, redact credential-shaped values without failing the task", async () => {
  const { address } = await child();
  const answer = "normal\n" + "x".repeat(21000) + "\npassword=example-value\naccess_token: example-value\nEND-MARKER";
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('report-test','task',?,'answered',?,'done')", Date.now(), answer);
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    const row = s.storage.sql.exec("SELECT * FROM inbox WHERE request_id='report-test'").one();
    await (i as any).report(meta, row);
    expect(s.storage.sql.exec<any>("SELECT status FROM inbox WHERE request_id='report-test'").one().status).toBe("reported");
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    const text = s.storage.sql.exec<any>("SELECT text FROM inbound WHERE kind='subagent'").one().text;
    expect(text).toContain("[子 agent 完成]"); expect(text).toContain("END-MARKER");
    expect(text).toContain("x".repeat(21000)); expect(text).not.toContain("example-value");
    await s.storage.deleteAlarm();
  });
  expect(redactReport('password="first\nsecond"\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\ntail')).not.toMatch(/first|second|private-material/);
});

it("successful sends compact payloads, retain verifiable replay proofs and fail closed at the bounded current-generation limit", async () => {
  await seed("owner"); await seed(group, 10000003);
  const receipt = await send("owner", group);
  await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
    const proof = await s.storage.get<any>("agent-sent:" + receipt.messageId);
    expect(proof.message).toBeUndefined(); expect(proof.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await i.agentProof(receipt.messageId, proof.hash)).toBe(true);
    for (let n = 0; n < SENT_LIMIT - 1; n++) await s.storage.put("agent-sent:fixture-" + n, { generation: 0, inputHash: "fixture", hash: "fixture" });
  });
  expect((await send("owner", group)).status).toBe("duplicate");
  await expect(send("owner", group, "over-limit")).rejects.toThrow("agent_history_full");
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    // 模拟旧版本已超过新上限的历史；清理不能随拒绝新发送一起回滚。
    await s.storage.put("agent-sent:legacy-extra", { generation: 0, inputHash: "old" });
    s.storage.sql.exec("UPDATE session_state SET generation=1");
  });
  await seed("owner", 10000001, 2);
  await expect(send("owner", group, "new-generation")).rejects.toThrow("agent_history_full");
  expect((await send("owner", group, "new-generation")).status).toBe("accepted");
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    expect((await s.storage.list({ prefix: "agent-sent:" })).size).toBe(1);
  });
});

it("agent_send returns sanitized business errors as isError instead of throwing", async () => {
  const tool = agentSendTool(async () => { throw new Error("agent_session_denied"); });
  const result = await (tool as any).execute({ to: group, text: "test" }, { conversationId: 1, taskId: 1 }, {});
  expect(result).toEqual({ isError: true, output: [{ type: "text", text: "agent_session_denied" }] });
});

it("pending text sends store only hashes and replay through real recipient readiness recovery", async () => {
  await seed("owner");
  await expect(send("owner", group, "pending", "p".repeat(20000))).rejects.toThrow("agent_recipient_not_ready");
  await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
    const proofs = await s.storage.list<any>({ prefix: "agent-sent:" });
    expect(proofs.size).toBe(1);
    const [key, proof] = [...proofs][0]!;
    expect(proof.message).toBeUndefined(); expect(proof.receipt).toBeUndefined();
    expect(JSON.stringify(proof).length).toBeLessThan(500);
    expect(await i.agentProof(key.slice("agent-sent:".length), proof.hash)).toBe(true);
  });
  await seed(group, 10000003);
  expect((await send("owner", group, "pending", "p".repeat(20000))).status).toBe("accepted");
});

it("pending reports freeze metadata across child version changes without retaining full text in KV", async () => {
  const { address } = await child();
  await runInDurableObject(env.THREAD.getByName("owner"), (_i, s) => {
    s.storage.sql.exec("CREATE TRIGGER fail_report BEFORE INSERT ON inbound WHEN NEW.kind='subagent' BEGIN SELECT RAISE(ABORT,'report_sql_failure'); END");
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('pending-report','task',?,'answered',?,'done')", Date.now(), "result".repeat(30000));
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    const row = s.storage.sql.exec("SELECT * FROM inbox WHERE request_id='pending-report'").one();
    await expect((i as any).report(meta, row)).rejects.toThrow("agent_delivery_unknown");
    const proof = [...(await s.storage.list<any>({ prefix: "agent-sent:" })).values()][0];
    expect(proof.message).toBeUndefined(); expect(proof.report.text).toBeUndefined();
    expect(JSON.stringify(proof).length).toBeLessThan(1000);
    s.storage.sql.exec("UPDATE meta SET value=? WHERE key='subagent'", JSON.stringify({ ...meta, version: meta.version + 1 }));
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.THREAD.getByName("owner"), (_i, s) => { s.storage.sql.exec("DROP TRIGGER fail_report"); });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    const row = s.storage.sql.exec("SELECT * FROM inbox WHERE request_id='pending-report'").one();
    await (i as any).report(meta, row);
    expect(s.storage.sql.exec<any>("SELECT status FROM inbox WHERE request_id='pending-report'").one().status).toBe("reported");
    await s.storage.deleteAlarm();
  });
  expect(redactReport('example authorization=Basic c3ludGhldGljLWNyZWRlbnRpYWw= end')).not.toContain("c3ludGhldGljLWNyZWRlbnRpYWw");
});

it("a child without coding_exec can receive, read and return only its registered attachments", async () => {
  const { cid, address } = await child(group);
  await env.SANDBOX.getByName(group).saveAttachment("/work/source.txt", new TextEncoder().encode("child-visible"), "child-source");
  const receipt = await runInDurableObject(env.THREAD.getByName(group), async (i, s) => {
    const row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='message'").one();
    return (i as any).sendAgentMessage({ to: address, text: "file", files: ["/work/source.txt"] }, "child-file", row);
  });
  const parent = env.THREAD.getByName(group);
  expect((await parent.validateSubagentAccess(cid))?.capabilities.coding).toBe(false);
  await runInDurableObject(parent, async i => {
    expect(JSON.stringify(await i.subagentCoding(cid, { kind: "read", operationId: "read-attachment", path: receipt.files[0] }))).toContain("child-visible");
    expect((await i.subagentCoding(cid, { kind: "exec", operationId: "no-exec", command: "echo forbidden", timeoutMs: 1000 })).isError).toBe(true);
    expect((await i.subagentCoding(cid, { kind: "read", operationId: "private-read", path: "/work/private.txt" })).isError).toBe(true);
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    expect((await (i as any).sendAgentMessage({ to: group, text: "return", files: receipt.files }, "child-return")).status).toBe("accepted");
    await s.storage.deleteAlarm();
  });
});
