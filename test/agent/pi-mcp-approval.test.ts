import { createServer } from "node:http";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ToolResultEntry, type ConversationId } from "@earendil-works/pi-durable";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMcpConfig } from "../../src/agent/pi-mcp/config.js";
import { McpApprovalDoc } from "../../src/agent/pi-mcp/approval.js";
import { McpDelegationDoc } from "../../src/agent/pi-mcp/delegation.js";
import { trace, type LiveEvent } from "../../src/shared/trace.js";
import { call, context, isChild, lastUser, reply, residentRig, type ResidentRig } from "./resident-fixture.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const reads = ["workshop_browse", "workshop_context", "workshop_status", "workshop_results"];
const writes = ["workshop_prepare", "workshop_edit", "workshop_mode", "workshop_trial", "workshop_produce"];

async function fixture(access: object = {}) {
  const calls: unknown[] = [], sessions: string[] = [];
  let resultError = false;
  const http = createServer(async (req, res) => {
    req.on("error", () => {}); res.on("error", () => {});
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (req.method === "DELETE") { res.writeHead(202).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const msg = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (!("id" in msg) || !("method" in msg)) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (msg.method === "initialize") {
      const id = String(sessions.length + 1); sessions.push(id); res.setHeader("mcp-session-id", id);
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "workshop", version: "1" } };
    } else if (msg.method === "tools/list") result = { tools: [...reads, ...writes].map(name => ({ name,
      inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })) };
    else if (msg.method === "tools/call") {
      calls.push(msg.params);
      result = { content: [{ type: "text", text: resultError ? "项目不可编辑" : "完成 token=keep-private" }],
        structuredContent: { ok: !resultError }, isError: resultError };
    } else { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("address");
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const config = parseMcpConfig({ version: 1, enabled: true, servers: [{ id: "workshop",
    transport: { kind: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, allowLoopbackHttp: true },
    credential: { kind: "external-account", accountId: "owner-workshop", revision: "1" },
    tools: { allow: [...reads, ...writes], approval: writes }, access: { kind: "owner-private", groups: ["7"], ...access }, replay: "unsafe" }] });
  if (config.kind !== "enabled") throw new Error("config");
  return { calls, sessions, config, fail: () => { resultError = true; },
    mcp: { config, secrets: { readReferencedVariable: () => undefined } } };
}

const endRole = (ctx: TranscriptContext) => ctx.messages.findLast(m => m.role !== "system")?.role;
const offered = (ctx: TranscriptContext) => getCurrentTools(ctx.messages);
const nameOf = (ctx: TranscriptContext, remote: string) => offered(ctx).find(t => t.name.startsWith(`mcp_workshop_${remote}_`))?.name;
function brain(remote = "workshop_edit", callId?: string) {
  return (ctx: TranscriptContext) => {
    if (endRole(ctx) === "toolResult") return reply();
    const name = nameOf(ctx, remote);
    return !name ? reply("没有工具") : callId ? fauxAssistantMessage([{ type: "toolCall", id: callId, name, arguments: { project: "demo-A" } }], { stopReason: "toolUse" })
      : call([name, { project: "demo-A" }]);
  };
}
async function records(r: ResidentRig) { return r.approvals!.records(); }
async function request(r: ResidentRig, user = "5") {
  await r.say(user, "编辑项目"); await r.idle();
  return (await records(r)).at(-1)!;
}
async function results(r: ResidentRig) {
  const id = (await r.pi.readThreadIds())["group:7"];
  const conv = await r.pi.harness.conversation(id as ConversationId, context);
  return (await conv!.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(ToolResultEntry.is);
}

describe("群内 MCP 宿主审批", () => {
  it("owner 群内写工具直接执行；成员读工具直接执行，共用本群 owner 连接；成员沿用 owner 用过的工具名进入审批", async () => {
    let ownerEdit: string | undefined;
    const s = await fixture(), r = await residentRig({ mcp: s.mcp, brain: ctx => { ownerEdit ??= nameOf(ctx, "workshop_edit"); return brain()(ctx); } });
    await r.say("9", "编辑项目"); await r.idle();
    r.brain.current = brain("workshop_status");
    await r.say("5", "查看状态"); await r.idle();
    expect(s.calls).toEqual([{ name: "workshop_edit", arguments: { project: "demo-A" } }, { name: "workshop_status", arguments: { project: "demo-A" } }]);
    expect(s.sessions).toHaveLength(1); expect(await records(r)).toEqual([]);
    r.brain.current = ctx => endRole(ctx) === "toolResult" ? reply() : call([ownerEdit!, { project: "demo-A" }]);
    await r.say("5", "编辑项目"); await r.idle();
    expect((await records(r)).map(x => x.state)).toEqual(["pending"]); expect(s.calls).toHaveLength(2);
    await r.say("1", "查看状态", null); await r.idle();
    expect(s.sessions).toHaveLength(2);
  });

  it("成员申请返回编号并 @首个 owner；相同 call_id 重放仍是同一请求", async () => {
    const s = await fixture(), seen: TranscriptContext[] = [], r = await residentRig({ mcp: s.mcp, brain: ctx => { seen.push(ctx); return brain("workshop_edit", "stable-call")(ctx); } });
    const first = await request(r);
    await request(r);
    expect(await records(r)).toHaveLength(1); expect(s.calls).toHaveLength(0);
    expect(first).toMatchObject({ state: "pending", requester: "5", requester_name: "用户5", scope: "group:7", args: { project: "demo-A" }, call_id: "stable-call" });
    expect(first.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect(first.expires_at - first.requested_at).toBe(30 * 60_000);
    expect(first.request_message_id).toBeTruthy(); expect(r.mentions()).toEqual(["1"]);
    expect(r.texts()[0]).toContain(`待审批 #${first.code}`);
    expect(JSON.stringify(await results(r))).toContain(`已提交主人审批（#${first.code}）`);
    expect((await results(r)).every(e => e.model?.some(m => m.role === "toolResult" && !m.isError))).toBe(true);
    expect(offered(seen[0]!).find(t => t.name.includes("workshop_edit"))?.description).toContain("需主人审批");
    expect(offered(seen[0]!).some(t => t.name === "mcp_refresh_tools")).toBe(true);
    expect((await r.harness.snapshot(McpApprovalDoc, first.code, context))?.record?.code).toBe(first.code);
    expect(await r.pi.harness.snapshot(McpApprovalDoc, first.code, context)).toBeUndefined();
  });

  it("owner 引用批准精确执行保存参数一次，消费输入并引用答复 @申请人，消息进入期间上下文", async () => {
    const s = await fixture(), events: LiveEvent[] = [];
    cleanup.push(trace.tap(e => events.push(e)));
    const r = await residentRig({ mcp: s.mcp, brain: brain() }), record = await request(r);
    const model = vi.fn(() => reply()); r.brain.current = model;
    const key = await r.say("9", "[reply][at] 允许", "7", { segments: [{ type: "reply", data: { id: record.request_message_id! } }] });
    expect(r.bridge.inbox.getInbound(key)?.state).toBe("done"); expect(model).not.toHaveBeenCalled();
    expect(s.calls).toEqual([{ name: "workshop_edit", arguments: record.args }]);
    expect(s.sessions).toHaveLength(1); expect((await records(r))[0]).toMatchObject({ state: "done", result_summary: expect.stringContaining("完成 token=[已隐藏]") });
    expect(r.mentions()).toEqual(["1", "5"]);
    expect(r.sent.at(-1)?.params.message).toEqual(expect.arrayContaining([{ type: "reply", data: { id: r.bridge.inbox.getInbound(key)!.message_id } }]));
    await r.say("1", `批准 #${record.code}`); expect(s.calls).toHaveLength(1); expect(model).not.toHaveBeenCalled();
    const next = await r.say("5", "再看看"); await r.idle();
    const rendered = await r.inbox.render([r.bridge.inbox.getInbound(next)!], "pi");
    expect(rendered.text).toContain("[期间消息]"); expect(rendered.text).toContain(`#${record.code} 已执行`);
    const audit = events.filter(e => e.stage.startsWith("mcp_approval_"));
    expect(audit.map(e => e.stage)).toEqual(["mcp_approval_requested", "mcp_approval_decided", "mcp_approval_executed"]);
    expect(audit.map(e => e.status)).toEqual(["pending", "approved", "done"]);
    expect(JSON.stringify(events.filter(e => e.stage.startsWith("mcp_") || e.stage === "send_message"))).not.toContain("demo-A");
  });

  it("owner 按编号拒绝，成员的批准仍交给模型且请求保持 pending", async () => {
    const s = await fixture(), r = await residentRig({ mcp: s.mcp, brain: brain() }), record = await request(r);
    const model = vi.fn(() => reply()); r.brain.current = model;
    await r.say("6", `批准 #${record.code}`); await r.idle();
    expect(model).toHaveBeenCalledTimes(1); expect((await records(r))[0]?.state).toBe("pending");
    await r.say("1", `不允许 #${record.code}`);
    expect(model).toHaveBeenCalledTimes(1); expect((await records(r))[0]?.state).toBe("rejected");
    expect(r.texts().at(-1)).toContain(`#${record.code} 已拒绝`); expect(r.mentions().at(-1)).toBe("5"); expect(s.calls).toHaveLength(0);
  });

  it("过期批准只转 expired；裸批准要求引用或编号，不进入模型", async () => {
    let now = Date.now();
    const s = await fixture(), r = await residentRig({ mcp: s.mcp, brain: brain(), now: () => now });
    const a = await request(r); await request(r, "6");
    const model = vi.fn(() => reply()); r.brain.current = model;
    await r.say("1", "批准"); expect(r.texts().at(-1)).toContain("请引用待审批消息");
    now += 30 * 60_000 + 1;
    await r.say("1", `同意${a.code}`);
    expect((await records(r))[0]?.state).toBe("expired"); expect(r.texts().at(-1)).toContain("已过期");
    expect(model).not.toHaveBeenCalled(); expect(s.calls).toHaveLength(0);
  });

  it("未配置的群不提供 MCP 工具", async () => {
    const s = await fixture(), seen: string[] = [];
    const r = await residentRig({ mcp: s.mcp, brain: ctx => { seen.push(...offered(ctx).map(t => t.name)); return reply(); } });
    await r.say("1", "编辑", "8"); await r.idle();
    expect(seen.some(n => n.startsWith("mcp_"))).toBe(false); expect(s.sessions).toEqual([]);
  });

  it("每人最多 3 条、每群最多 5 条待审批，超限返回等待提示", async () => {
    const s = await fixture(), r = await residentRig({ mcp: s.mcp, brain: brain() });
    for (let i = 0; i < 4; i++) await request(r);
    expect(await records(r)).toHaveLength(3); expect(JSON.stringify((await results(r)).at(-1))).toContain("请等待");
    await request(r, "6"); await request(r, "6"); await request(r, "7");
    expect(await records(r)).toHaveLength(5); expect(JSON.stringify((await results(r)).at(-1))).toContain("请等待"); expect(s.calls).toHaveLength(0);
  });

  it("通知发送失败仍保存 pending，按编号批准可执行", async () => {
    const s = await fixture(), r = await residentRig({ mcp: s.mcp, brain: brain() });
    const send = vi.spyOn(r.sendService, "system").mockRejectedValueOnce(new Error("发送失败"));
    const record = await request(r);
    expect(record.state).toBe("pending"); expect(record.request_message_id).toBeUndefined();
    expect(JSON.stringify(await results(r))).toContain("审批通知未确认送达"); send.mockRestore();
    await r.say("1", `批准 #${record.code}`); expect(s.calls).toHaveLength(1); expect((await records(r))[0]?.state).toBe("done");
  });

  it("批准前配置变更撤权拒绝执行；远端错误记 failed", async () => {
    const s = await fixture(), r = await residentRig({ mcp: s.mcp, brain: brain() }), record = await request(r);
    s.config.value.servers[0]!.tools.approval = [];
    await r.say("1", `批准 #${record.code}`);
    expect(s.calls).toHaveLength(0); expect((await records(r))[0]?.state).toBe("failed");
    s.config.value.servers[0]!.tools.approval = writes;
    const next = await request(r, "6"); s.fail();
    await r.say("1", `通过 #${next.code}`);
    expect((await records(r)).at(-1)?.state).toBe("failed"); expect(r.texts().at(-1)).toContain("项目不可编辑");
  });

  it.each(["1", "5"])("群内 %s 派出子任务：继承派出者身份，读直接执行、成员写需审批", async user => {
    const s = await fixture({ allowSubagent: true }), seen: string[][] = [];
    const r = await residentRig({ mcp: s.mcp, brain: ctx => {
      if (isChild(ctx)) {
        seen.push(offered(ctx).map(t => t.name));
        const last = ctx.messages.findLast(m => m.role !== "system");
        if (last?.role === "toolResult" && !last.toolName.startsWith("mcp_workshop_workshop_status_")) return reply();
        const remote = last?.role === "toolResult" ? "workshop_edit" : "workshop_status";
        const name = nameOf(ctx, remote);
        return name ? fauxAssistantMessage([{ type: "toolCall", id: `child-${remote}`, name, arguments: { project: "demo-A" } }], { stopReason: "toolUse" })
          : reply("没有工具");
      }
      if (endRole(ctx) === "toolResult" || lastUser(ctx).startsWith("[子 agent ")) return reply();
      return call(["subagent", { action: "spawn", name: "worker", task: "查看并编辑项目" }]);
    } });
    await r.say(user, "派出子任务");
    await vi.waitFor(async () => expect((await r.pi.subagents("group:7"))[0]?.state).toBe("done"), { timeout: 10000 });
    await r.idle();
    const childId = Number((await r.pi.subagents("group:7"))[0]!.session) as ConversationId;
    expect((await r.pi.harness.snapshot(McpDelegationDoc, childId, context))?.grant)
      .toMatchObject({ principal: user, wake: false, scheduled: false });
    expect(seen[0]).toEqual(expect.arrayContaining([expect.stringMatching(/^mcp_workshop_workshop_status_/), expect.stringMatching(/^mcp_workshop_workshop_edit_/)]));
    const readCall = { name: "workshop_status", arguments: { project: "demo-A" } };
    const writeCall = { name: "workshop_edit", arguments: { project: "demo-A" } };
    expect(s.calls).toEqual(user === "1" ? [readCall, writeCall] : [readCall]);
    expect(s.sessions).toHaveLength(2);
    if (user === "1") expect(await records(r)).toEqual([]);
    else {
      expect(await records(r)).toHaveLength(1);
      const record = (await records(r))[0]!;
      expect(record).toMatchObject({ state: "pending", requester: user, scope: "group:7", thread_key: "group:7",
        conversation_id: Number(childId), call_id: "child-workshop_edit", tool: "workshop_edit", args: writeCall.arguments });
      const child = await r.pi.harness.conversation(childId, context);
      expect(JSON.stringify((await child!.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is))).toContain(`已提交主人审批（#${record.code}）`);
      await r.say("9", `批准 #${record.code}`);
      expect((await records(r))[0]?.state).toBe("done");
      await r.say("1", `批准 #${record.code}`);
      expect(s.calls).toEqual([readCall, writeCall]);
      expect(s.sessions).toHaveLength(2);
    }
  });

  it("成员派出的子任务由 owner 续发后撤掉 MCP，并提示交代人与派出人不同", async () => {
    const s = await fixture({ allowSubagent: true }), seen: string[][] = [];
    const r = await residentRig({ mcp: s.mcp, brain: ctx => {
      if (isChild(ctx)) {
        if (endRole(ctx) !== "toolResult") seen.push(offered(ctx).map(t => t.name));
        return brain("workshop_status")(ctx);
      }
      if (endRole(ctx) === "toolResult" || lastUser(ctx).startsWith("[子 agent ")) return reply();
      return call(["subagent", { action: lastUser(ctx).includes("续发") ? "message" : "spawn", name: "worker", task: "查看状态" }]);
    } });
    await r.say("5", "派出子任务");
    await vi.waitFor(async () => expect((await r.pi.subagents("group:7"))[0]?.state).toBe("done"), { timeout: 10000 });
    await r.idle();
    expect(seen[0]?.some(n => n.startsWith("mcp_"))).toBe(true);
    await r.say("1", "续发任务");
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 10000 });
    await vi.waitFor(async () => expect((await r.pi.subagents("group:7"))[0]?.state).toBe("done"), { timeout: 10000 });
    await r.idle();
    const childId = Number((await r.pi.subagents("group:7"))[0]!.session) as ConversationId;
    expect((await r.pi.harness.snapshot(McpDelegationDoc, childId, context))?.grant).toBeNull();
    expect(seen.slice(1).every(tools => !tools.some(n => n.startsWith("mcp_")))).toBe(true);
    expect(JSON.stringify(await results(r))).toContain("该子 agent 没有 MCP 工具（交代人与派出人不同），需要 MCP 的步骤请自己调用。");
    expect(s.calls).toEqual([{ name: "workshop_status", arguments: { project: "demo-A" } }]);
    expect(await records(r)).toEqual([]);
  });

  it.each(["1", "5"])("子任务汇报唤醒 %s：按继承的人决定直接执行或审批", async user => {
    const s = await fixture({ allowWake: true }), r = await residentRig({ mcp: s.mcp, brain: ctx => {
      if (isChild(ctx) || endRole(ctx) === "toolResult") return reply();
      if (lastUser(ctx).startsWith("[子 agent ")) return brain()(ctx);
      return call(["subagent", { action: "spawn", name: "worker", task: "给出编辑建议" }]);
    } });
    await r.say(user, "派出子任务");
    await vi.waitFor(async () => expect(user === "1" ? s.calls.length : (await records(r)).length).toBe(1), { timeout: 10000 });
    await r.idle();
    expect(s.calls).toHaveLength(user === "1" ? 1 : 0);
    if (user === "5") expect((await records(r))[0]).toMatchObject({ state: "pending", requester: "5" });
  });

  it.each([{ user: "1", enabled: true }, { user: "5", enabled: true }, { user: "5", enabled: false }])("定时身份仍按人授权：%j", async ({ user, enabled }) => {
    const s = await fixture({ allowScheduled: enabled }), r = await residentRig({ mcp: s.mcp, brain: brain() });
    const record = r.bridge.inbox.openScheduledInput({ key: `run_${user.repeat(40)}`, creator: `qq:${user}`, scope: "group:7", thread_key: "group:7", text: "[定时任务] 编辑项目", time: Date.now() / 1000 });
    await r.inbox.deliverScheduled(record.key); await r.idle();
    expect(s.calls).toHaveLength(enabled && user === "1" ? 1 : 0);
    expect(await records(r)).toHaveLength(enabled && user === "5" ? 1 : 0);
  });
});
