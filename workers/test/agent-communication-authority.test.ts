// 合并原 agent-communication-fixes / review / review-regressions 中的权限边界、脱敏、回执与生命周期回归用例。
import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { Check } from "typebox/value";
import { input } from "./helpers";
import { runtime } from "./sandbox-runtime-fixture";
import { assertNoCredentials, fingerprint, messageId, redactReport } from "../src/communication/model";
import { SENT_LIMIT } from "../src/communication/service";
import { agentSendTool } from "../src/communication/tool";
import { McpPolicyStore, GrantInput } from "../src/mcp/policy";
import { ThreadMcp } from "../src/mcp";
import { MCP_CONFIG } from "../src/mcp/config";
import { createCodingExtension } from "../src/tools/coding";

const group = "group:200000001";
const FIXED_CID = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

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

async function child(parent = "owner", options: { cid?: string; coding?: boolean; endedAt?: number } = {}) {
  const cid = options.cid ?? crypto.randomUUID();
  await seed(parent);
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

it("text communication cannot grant group coding, while the human group turn retains its task", async () => {
  await seed("owner"); await seed(group, 10000003);
  await send("owner", group);
  await runInDurableObject(env.SANDBOX.getByName(group), async instance => {
    const host = runtime();
    Object.assign((instance as any).workspace.deps, { runtime: host.client, resetRuntime: host.reset, runtimeReady: host.ready });
  });
  await runInDurableObject(env.THREAD.getByName(group), async (instance, s) => {
    const i = instance as any;
    const peer = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='agent'").one();
    expect(s.storage.sql.exec("SELECT * FROM mcp_access").toArray()).toEqual([]);
    expect(await i.sandboxTaskForInput(peer)).toBeUndefined();
    const human = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='message'").one();
    expect((await i.sandboxTaskForInput(human)).permissions.coding).toBe(true);
    const ext = createCodingExtension({ allowed: async () => !!(await i.sandboxTaskForInput(peer))?.permissions.coding, sandbox: () => env.SANDBOX.getByName(group), record: async () => {} });
    const write = (ext as any).tools.find((t: any) => t.name === "write");
    expect(await write.execute({ path: "/work/not-an-attachment.txt", content: "unexpected-write" }, { taskId: "proof-write" }, {})).toHaveProperty("isError", true);
    expect((await env.SANDBOX.getByName(group).files()).files).toHaveLength(0);
    const exec = (ext as any).tools.find((t: any) => t.name === "bash");
    expect(await exec.execute({ command: "echo forbidden" }, { taskId: "proof-exec" }, {})).toHaveProperty("isError", true);
    await s.storage.deleteAlarm();
  });
});

it("session MCP authority survives speaker changes, requires an explicit session grant and revokes live", async () => {
  await seed("owner");
  async function round(n: number, user: number) {
    await seed(group, user, n);
    await runInDurableObject(env.THREAD.getByName("owner"), async (i, s) => {
      const row = s.storage.sql.exec("SELECT * FROM inbound LIMIT 1").one();
      await (i as any).sendAgentMessage({ to: group, text: "same peer request" }, "review-" + n, row);
    });
    return runInDurableObject(env.THREAD.getByName(group), async (i, s) => {
      const row = s.storage.sql.exec("SELECT * FROM inbound WHERE kind='agent' ORDER BY rowid DESC LIMIT 1").one();
      await s.storage.deleteAlarm();
      return (i as any).mcpAuthority(row);
    });
  }
  const a = await round(2, 10000003), b = await round(3, 10000004);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ actor: "agent:" + group, kind: "agent", owner: false, generation: 0, replyChannel: "qq" });
  const c = await round(4, 10000001); // Even an owner speaking in the group cannot elevate the group Agent.
  expect(c).toEqual(a);
  const decisions = await runInDurableObject(env.THREAD.getByName(group), async i => {
    const policy = new McpPolicyStore((i as any).database);
    await policy.initialize();
    const server = { id: "review", access: { revision: "r" }, resourceAllow: ["repo:"], tools: { eventAllow: [] } } as any;
    const grant = { scope: group, server: "review", revision: "g", serverRevision: "r", tools: ["read"], resourceAllow: [], actors: ["10000003"], expiresAt: null };
    await (i as any).database.run("INSERT INTO mcp_access(scope,server_id,value_json,revision) VALUES(?,?,?,?)", group, "review", JSON.stringify(grant), "g");
    expect(await policy.allows(a, server, "read")).toBe(false);
    grant.actors = ["*"];
    await (i as any).database.run("UPDATE mcp_access SET value_json=?", JSON.stringify(grant));
    expect(await policy.allows(b, server, "read")).toBe(false);
    const explicit = { ...grant, actors: ["agent:" + group], resourceAllow: ["repo:"], environments: ["dev"], environmentApproval: "required" };
    const { scope: _s, server: _id, revision: _rev, serverRevision: _srev, ...payload } = explicit;
    expect(Check(GrantInput, payload)).toBe(true);
    await (i as any).database.run("UPDATE mcp_access SET value_json=?", JSON.stringify(explicit));
    expect(await policy.environments(a, server)).toEqual({ kind: "selected", envIds: ["dev"] });
    expect(await policy.resourcePrefixes(a, server)).toEqual(["repo:"]);
    expect(await policy.requiresApproval(a, server, "read")).toBe(true);
    const decisions = { a: await policy.allows(a, server, "read"), b: await policy.allows(b, server, "read") };
    expect(await (i as any).currentMcpAuthority(a)).toEqual(a);
    await (i as any).database.run("DELETE FROM mcp_access");
    expect(await policy.allows(a, server, "read")).toBe(false);
    expect(await policy.resourcePrefixes(a, server)).toEqual([]);
    expect(await policy.environments(a, server)).toEqual({ kind: "selected", envIds: [] });
    await (i as any).database.run("UPDATE session_state SET generation=1");
    expect(await (i as any).currentMcpAuthority(a)).toBeUndefined();
    return decisions;
  });
  expect(decisions).toEqual({ a: true, b: true });
  await env.THREAD.getByName(group).syncAdminView(group);
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

it("rejected Agent followup cannot contaminate original owner retry or concurrent original report", async () => {
  const { cid, address, identity } = await child("owner", { cid: FIXED_CID });
  await runInDurableObject(env.THREAD.getByName("owner"), async i => {
    await expect(i.agentChildNarrow(cid)).rejects.toThrow("agent_child_identity_denied");
  });
  await Promise.all([
    send("owner", address, "owner-after-narrow"),
    env.THREAD.getByName("owner").subagentReport({ subagentId: cid, requestId: "stale", text: "old", identity, outcome: "done", state: { status: "done", version: 2 } } as any),
  ]);
  await runInDurableObject(env.THREAD.getByName("owner"), async (instance, s) => {
    const i = instance as any;
    expect(JSON.parse(s.storage.sql.exec<any>("SELECT identity_json FROM subagents WHERE id=?", cid).one().identity_json)).toEqual(identity);
    // 与真实 admission 一样先绑定 turn；否则 MCP 会仅因尚未接纳而返回 undefined。
    s.storage.sql.exec("UPDATE inbound SET turn_id='review-report-turn' WHERE kind='subagent'");
    const report = s.storage.sql.exec<any>("SELECT * FROM inbound WHERE kind='subagent'").one();
    expect(report.user_id).toBe("10000001");
    expect((await i.mcpAuthority(report)).owner).toBe(true);
    expect((await i.scheduleAccess(report)).kind).toBe("manage");
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), (_i, s) => s.storage.deleteAlarm());
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

it.each(["owner", group])("known YAML password block is completely redacted in automatic report to %s", async parent => {
  const { address } = await child(parent, { cid: FIXED_CID });
  // Use literal newlines, a standard structured credential shape, never real secrets.
  const source = ["password: |", "  SYNTHETIC_BLOCK_VALUE_123456", "end"].join("\n");
  expect(() => assertNoCredentials(source)).toThrow("agent_credentials_forbidden");
  expect(redactReport(source)).not.toContain("SYNTHETIC_BLOCK_VALUE_123456");
  await runInDurableObject(env.SUBAGENT.getByName(address), async (instance, s) => {
    const i = instance as any;
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('yaml','task',?,'answered',?,'done')", Date.now(), source);
    await i.report(JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value), s.storage.sql.exec("SELECT * FROM inbox WHERE request_id='yaml'").one());
    expect(s.storage.sql.exec("SELECT status,outcome FROM inbox WHERE request_id='yaml'").one()).toMatchObject({ status: "reported", outcome: "done" });
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.THREAD.getByName(parent), async (_i, s) => {
    const report = s.storage.sql.exec<any>("SELECT text FROM inbound WHERE kind='subagent'").one().text;
    expect(report).not.toContain("SYNTHETIC_BLOCK_VALUE_123456");
    expect(report).toContain("end");
    expect(report).toContain("已隐藏");
    await s.storage.deleteAlarm();
  });
});

it.each([
  ["literal", "password: |\n  SYNTHETIC_A\n  SYNTHETIC_B\nvisible: keep", true],
  ["folded", "password: >-\n  SYNTHETIC_A\n  SYNTHETIC_B\nvisible: keep", true],
  ["indent and CRLF", "nested:\r\n  access_token: |2+\r\n    SYNTHETIC_A\r\n  visible: keep", true],
  ["sequence", "- client_secret: >\n    SYNTHETIC_A\n  visible: keep", true],
  ["plain continuation", "password: SYNTHETIC_A\n  SYNTHETIC_B\nvisible: keep", true],
  ["empty and continuation", "password:\n  SYNTHETIC_A\nvisible: keep", true],
  ["escaped quote", 'password: "SYNTHETIC_A\\"SYNTHETIC_B"\nvisible: keep', true],
  ["YAML doubled quote", "password: 'SYNTHETIC_A''SYNTHETIC_B'\nvisible: keep", true],
  ["escaped newline", 'password: "SYNTHETIC_A\\\nSYNTHETIC_B"\nvisible: keep', true],
  ["unclosed quote", 'password: "SYNTHETIC_A\n  SYNTHETIC_B\nambiguous continuation', false],
  ["unclosed inline JSON", '{"password": "SYNTHETIC_A\nSYNTHETIC_B', false],
])("redacts complete credential values: %s", (_name, source, closed) => {
  const out = redactReport("before: retained\n" + source);
  expect(out).not.toContain("SYNTHETIC_");
  expect(out).toContain("before: retained");
  expect(out).toContain("已隐藏");
  expect(out).toContain(closed ? "visible: keep" : "后续内容已隔离");
  expect(redactReport(out)).toBe(out);
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

it("legacy unticketed backlog stays protected until lifecycle migration; existing pending proof survives", async () => {
  await seed("owner");
  await expect(send("owner", group, "pending-limit")).rejects.toThrow("agent_recipient_not_ready");
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    for (let n = 0; n < SENT_LIMIT - 1; n++) await s.storage.put("agent-sent:review-" + n, { generation: 0, inputHash: "fixture", hash: "fixture" });
  });
  await seed(group, 10000003);
  expect((await send("owner", group, "pending-limit")).status).toBe("accepted");
  for (let n = 0; n < 2; n++) await expect(send("owner", group, "new-" + n)).rejects.toThrow("agent_history_full");
  expect((await send("owner", group, "pending-limit")).status).toBe("duplicate");
  await runInDurableObject(env.THREAD.getByName("owner"), async (instance, s) => {
    const i = instance as any;
    const rows = await s.storage.list<any>({ prefix: "agent-sent:" });
    expect(rows.size).toBe(SENT_LIMIT);
    const [key, p] = [...rows].find(([, v]) => v.receipt)!;
    expect(await i.agentProof(key.slice(11), p.hash)).toBe(true);
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

it.each(["reset", "stop"])("retires an answered report after parent %s without heartbeat retries", async mode => {
  const { address } = await child("owner", { cid: FIXED_CID, coding: true, endedAt: Date.now() });
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    if (mode === "reset") s.storage.sql.exec("UPDATE session_state SET generation=1");
    else s.storage.sql.exec("UPDATE subagents SET status='cancelled'");
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('task','review',?,'answered','finished','done')", Date.now());
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    const row = s.storage.sql.exec("SELECT * FROM inbox").one();
    await (i as any).report(meta, row);
    expect(await (i as any).step()).toBe(false);
    await (i as any).update(async () => false);
    expect(s.storage.sql.exec<any>("SELECT status FROM inbox").one().status).toBe("cancelled");
    const alarm = await s.storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeGreaterThan(60_000);
    await s.storage.deleteAlarm();
  });
});

it("unknown report delivery stays answered and retries", async () => {
  const { address } = await child("owner", { cid: FIXED_CID, coding: true, endedAt: Date.now() });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    s.storage.sql.exec("INSERT INTO inbox(request_id,text,received_at,status,answer,outcome) VALUES('task','review',?,'answered','finished','done')", Date.now());
    const meta = JSON.parse(s.storage.sql.exec<any>("SELECT value FROM meta WHERE key='subagent'").one().value);
    const row = s.storage.sql.exec("SELECT * FROM inbox").one();
    const send = vi.spyOn(i as any, "sendAgentMessage").mockRejectedValue(new Error("agent_delivery_unknown"));
    await expect((i as any).report(meta, row)).rejects.toThrow("agent_delivery_unknown");
    expect(s.storage.sql.exec<any>("SELECT status FROM inbox").one().status).toBe("answered");
    await (i as any).update(async () => false);
    expect((await s.storage.getAlarm())! - Date.now()).toBeLessThanOrEqual(60_000);
    send.mockRestore();
    await s.storage.deleteAlarm();
  });
});

it("replays an actual inbox delivery whose receipt was lost after insertion", async () => {
  const { address } = await child("owner", { cid: FIXED_CID, coding: true, endedAt: Date.now() });
  const message = { id: messageId("owner", "0:lost-receipt"), from: "owner", to: address, text: "message", files: [] };
  await runInDurableObject(env.THREAD.getByName("owner"), async (_i, s) => {
    await s.storage.put("agent-sent:" + message.id, { inputHash: "fixture", message, generation: 0 });
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async i => {
    const original = i.message.bind(i);
    const receive = vi.spyOn(i, "message").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("synthetic_receipt_lost");
    });
    try { await expect(i.agentReceive(message)).rejects.toThrow("synthetic_receipt_lost"); }
    finally { receive.mockRestore(); }
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (_i, s) => {
    expect(s.storage.sql.exec<any>("SELECT agent_hash FROM inbox WHERE request_id=?", message.id).one().agent_hash).toBe(fingerprint(message));
    await s.storage.deleteAlarm();
  });
  await runInDurableObject(env.SUBAGENT.getByName(address), async (i, s) => {
    expect(await i.agentReceive(message)).toEqual({ messageId: message.id, status: "duplicate", files: [] });
    await s.storage.deleteAlarm();
  });
});
