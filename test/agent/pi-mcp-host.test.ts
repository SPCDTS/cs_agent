import { createHash } from "node:crypto";
import { trace, type LiveEvent } from "../../src/shared/trace.js";
import { AgentDoc, ToolResultEntry, type ConversationId } from "@earendil-works/pi-durable";
import { McpDelegationDoc } from "../../src/agent/pi-mcp/delegation.js";
import { McpCatalogsDoc } from "../../src/agent/pi-mcp/catalog.js";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMcpConfig } from "../../src/agent/pi-mcp/config.js";
import type { PiBackendOptions } from "../../src/agent/backends/pi.js";
import type { ThreadKey } from "../../src/agent/host/types.js";
import type { PiCallBinding } from "../../src/agent/pi-tools/request.js";
import { httpFixture } from "./fixtures/pi-mcp-http.js";
import { call, context, gate, isChild, lastUser, reply, residentRig, type ResidentRig } from "./resident-fixture.js";

const servers: Awaited<ReturnType<typeof httpFixture>>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

/** 从真实发给模型的 system 条目重建本次可用工具，覆盖扩展选择接线。 */
function offeredTools(transcript: TranscriptContext): string[] {
  const names = new Set<string>();
  for (const message of transcript.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return [...names];
}

async function mcpFixture(access: object = {}): Promise<{ server: Awaited<ReturnType<typeof httpFixture>>; mcp: NonNullable<PiBackendOptions["mcp"]> }> {
  const server = await httpFixture(); servers.push(server);
  const config = parseMcpConfig({ version: 1, enabled: true, servers: [{ ...server.config, access: { ...server.config.access, ...access }, tools: { allow: ["first"] } }] });
  if (config.kind !== "enabled") throw new Error("fixture_config_invalid");
  return { server, mcp: { config, secrets: { readReferencedVariable: name => name === "FIXTURE_SECRET" ? "host-fixture-secret" : undefined } } };
}

describe("Pi MCP 真实宿主接线", () => {
  it("资源经过真实 Pi hooks，trace 仅含 URI 摘要及调用元数据", async () => {
    const { server, mcp } = await mcpFixture();
    if (mcp.config.kind !== "enabled") throw new Error("config");
    mcp.config.value.servers[0].resources.allow = ["notion://docs/"];
    const uri = "notion://docs/PRIVATE_URI_SENTINEL", events: LiveEvent[] = [];
    const stop = trace.tap(event => events.push(event));
    try {
      const r = await residentRig({ mcp, brain: transcript => {
        if (endRole(transcript) === "toolResult") return reply();
        const tools = offeredTools(transcript);
        expect(tools).toContain("mcp_read_resource"); expect(tools).toContain("mcp_refresh_tools");
        return lastUser(transcript).includes("错误") ? call(["mcp_read_resource", { server: "fixture", uri: "notion://docs/missing" }])
          : lastUser(transcript).includes("列出") ? call(["mcp_list_resources", {}])
            : call(["mcp_read_resource", { server: "fixture", uri }]);
      } });
      for (const message of ["读取资料", "读取错误", "列出资料"]) { await r.say("1", message, null); await r.idle(); }
      const calls = events.filter(event => event.stage === "mcp_resource");
      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({ status: "ok", duration_ms: expect.any(Number), detail: {
        serverId: "fixture", op: "read", scheme: "notion", uriBytes: Buffer.byteLength(uri),
        uriDigest: createHash("sha256").update(uri).digest("hex").slice(0, 12), outputBytes: expect.any(Number), callId: expect.any(String) } });
      expect(calls[1]).toMatchObject({ status: "failed", detail: { code: "remote_error" } });
      expect(calls[2]).toMatchObject({ status: "ok", detail: { op: "list", count: 3, uriBytes: 0 } });
      expect(calls[2].detail).not.toHaveProperty("uriDigest");
      expect(events.filter(event => event.stage === "tool:mcp_read_resource").map(event => event.status))
        .toEqual(["started", "ok", "started", "failed"]);
      const logged = JSON.stringify(events);
      for (const sentinel of [uri, "notion://docs/missing", "RESOURCE_BODY_SENTINEL", "RESOURCE_ERROR_SENTINEL", "host-fixture-secret", "Memory Title"]) {
        expect(logged).not.toContain(sentinel);
      }
      expect(server.messages.filter(message => "method" in message && message.method === "resources/read")).toHaveLength(2);
    } finally { stop(); }
  });

  it("owner 私聊首轮直接选出 MCP 原生工具并通过真实回合绑定调用一次", async () => {
    const { server, mcp } = await mcpFixture();
    const seen: string[][] = [], bindings: PiCallBinding[] = [];
    let r!: ResidentRig;
    r = await residentRig({ mcp, brain: async transcript => {
      seen.push(offeredTools(transcript));
      if (transcript.messages.some(message => message.role === "toolResult")) return reply("调用完成");
      const id = (await r.pi.readThreadIds()).owner;
      if (id !== undefined) {
        const binding = await r.pi.binding(id);
        if (binding) bindings.push(binding);
      }
      const tool = seen.at(-1)?.find(name => name.startsWith("mcp_fixture_"));
      return tool ? call([tool, {}]) : reply("没有 MCP 工具");
    } });
    await r.say("1", "使用外部工具", null);
    await r.idle();
    expect(seen[0]).toEqual(expect.arrayContaining(["read", "write", "send_message", expect.stringMatching(/^mcp_fixture_first_/)]));
    expect(seen[0]?.filter(name => name.startsWith("mcp_fixture_"))).toHaveLength(1);
    expect(seen[0]).toContain("mcp_refresh_tools");
    expect(bindings[0]).toMatchObject({ threadKey: "owner", scope: "private:1", access: "all", child: false,
      identity: { kind: "user", sender: "1" } });
    expect(server.calls).toBe(1);
    expect(server.messages.filter(message => "method" in message && message.method === "initialize")).toHaveLength(1);
    expect(server.messages.filter(message => "method" in message && message.method === "tools/list")).toHaveLength(2);
    expect(server.messages.find(message => "method" in message && message.method === "tools/call"))
      .toMatchObject({ params: { name: "first", arguments: {} } });
  });

  it.each([{ user: "1", group: "7" }, { user: "5", group: null }])("群聊/普通私聊不发现 MCP：%j", async ({ user, group }) => {
    const { server, mcp } = await mcpFixture();
    const seen: string[][] = [];
    const r = await residentRig({ mcp, brain: transcript => { seen.push(offeredTools(transcript)); return reply(); } });
    await r.say(user, "查看可用工具", group);
    await r.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("read");
    expect(seen[0]?.some(name => name.startsWith("mcp_"))).toBe(false);
    expect(server.messages).toEqual([]);
    expect(server.paths).toEqual([]);
    expect(server.calls).toBe(0);
  });
});

async function childConversation(r: ResidentRig, key: ThreadKey = "owner") {
  const child = (await r.pi.subagents(key))[0];
  if (!child) throw new Error("missing_child");
  const conversation = await r.pi.harness.conversation(Number(child.session) as ConversationId, context);
  if (!conversation) throw new Error("missing_conversation");
  return conversation;
}
const endRole = (transcript: TranscriptContext) => transcript.messages.findLast(message => message.role !== "system")?.role;
function delegate(transcript: TranscriptContext) {
  if (endRole(transcript) === "toolResult" || lastUser(transcript).startsWith("[子 agent ")) return reply();
  return lastUser(transcript).includes("续发") ? call(["subagent", { action: "message", name: "worker", task: "继续调用" }])
    : call(["subagent", { action: "spawn", name: "worker", task: "调用外部工具" }]);
}
async function childIdle(r: ResidentRig, key: ThreadKey = "owner") {
  await r.idle();
  await vi.waitFor(async () => expect((await r.pi.subagents(key))[0]?.state).toBe("done"), { timeout: 10_000 });
  await r.idle();
}

describe("Pi MCP 子 agent 委派", () => {
  it("授权 spawn、续发和刷新使用子目录；父子连接隔离，未委派的服务不会加入", async () => {
    const { server, mcp } = await mcpFixture({ allowSubagent: true });
    const extra = await mcpFixture({ allowSubagent: false });
    if (mcp.config.kind !== "enabled" || extra.mcp.config.kind !== "enabled") throw new Error("config");
    const excluded = { ...extra.mcp.config.value.servers[0]!, id: "excluded" };
    mcp.config.value.servers.push(excluded);
    const childTools: string[][] = [];
    const r = await residentRig({ mcp, brain: transcript => {
      if (!isChild(transcript)) return delegate(transcript);
      const tools = offeredTools(transcript); childTools.push(tools);
      const last = transcript.messages.findLast(message => message.role !== "system");
      if (last?.role === "toolResult" && last.toolName !== "mcp_refresh_tools") return reply("完成");
      if (last?.role !== "toolResult") return call(["mcp_refresh_tools", {}]);
      return call([tools.find(name => name.startsWith("mcp_fixture_first_"))!, {}]);
    } });
    await r.say("1", "开始", null); await childIdle(r);
    const child = await childConversation(r);
    expect((await r.pi.harness.snapshot(McpDelegationDoc, child.id, context))?.grant).toMatchObject({ principal: "1", wake: false, scheduled: false });
    expect(Object.keys((await r.pi.harness.snapshot(McpDelegationDoc, child.id, context))!.grant!.servers)).toEqual(["fixture"]);
    expect(server.calls).toBe(1); expect(extra.server.calls).toBe(0);
    const initializations = () => server.messages.filter(message => "method" in message && message.method === "initialize").length;
    expect(initializations()).toBe(2);
    const revisions = Object.values((await r.pi.harness.snapshot(McpCatalogsDoc, context))!.revisions).filter(revision => revision.serverId === "fixture");
    expect(new Set(revisions.map(revision => revision.scopeDigest)).size).toBe(2);
    const parent = await r.pi.harness.conversation((await r.pi.readThreadIds()).owner as ConversationId, context);
    const parentNames = (await parent!.agent(context)).tools.map(tool => tool.name);
    expect(childTools[0]).toContain("read"); expect(childTools[0]).toContain("mcp_refresh_tools");
    expect(childTools[0]).not.toContain("send_message"); expect(childTools[0]).not.toContain("subagent");
    const childName = childTools[0]!.find(name => name.startsWith("mcp_fixture_first_"));
    expect(parentNames).not.toContain(childName);
    excluded.access.allowSubagent = true;
    const before = extra.server.messages.length;
    await r.say("1", "续发", null); await childIdle(r);
    expect(server.calls).toBe(2); expect(initializations()).toBe(2);
    expect(childTools.every(tools => !tools.some(name => name.startsWith("mcp_excluded_")))).toBe(true);
    // 新服务只由父回合发现；子刷新和调用不产生额外连接。
    expect(extra.server.messages.slice(before).filter(message => "method" in message && message.method === "initialize")).toHaveLength(1);
  });

  it.each([
    { user: "1", group: null, enabled: false, key: "owner" },
    { user: "1", group: "7", enabled: true, key: "group:7" },
    { user: "5", group: null, enabled: true, key: "private:5" },
  ] as const)("父回合或服务不允许委派：%j", async ({ user, group, enabled, key }) => {
    const { server, mcp } = await mcpFixture({ allowSubagent: enabled });
    const seen: string[][] = [];
    const r = await residentRig({ mcp, brain: transcript => {
      if (!isChild(transcript)) return delegate(transcript);
      seen.push(offeredTools(transcript));
      return endRole(transcript) === "toolResult" ? reply() : call(["mcp_refresh_tools", {}]);
    } });
    await r.say(user, "开始", group); await childIdle(r, key);
    const child = await childConversation(r, key);
    expect((await r.pi.harness.snapshot(McpDelegationDoc, child.id, context))?.grant).toBeNull();
    expect(seen.every(tools => !tools.some(name => name.startsWith("mcp_")))).toBe(true);
    expect(server.calls).toBe(0);
    expect(server.messages.filter(message => "method" in message && message.method === "initialize")).toHaveLength(enabled ? 0 : 1);
    if (!enabled) {
      const parent = await r.pi.harness.conversation((await r.pi.readThreadIds())[key] as ConversationId, context);
      expect(JSON.stringify((await parent!.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is)))
        .toContain("该子 agent 没有 MCP 工具（当前未获委派），需要 MCP 的步骤请自己调用。");
    }
    const results = (await child.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
    expect(results[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "tool_unavailable" })]));
  });

  it.each(["owner", "server", "allowSubagent"] as const)("派出后撤销 %s，已选中的工具调用也不发送", async revoke => {
    const { server, mcp } = await mcpFixture({ allowSubagent: true });
    const blocked = gate();
    const r = await residentRig({ mcp, brain: async (transcript, signal) => {
      if (!isChild(transcript)) return delegate(transcript);
      if (endRole(transcript) === "toolResult") return reply();
      const name = offeredTools(transcript).find(name => name.startsWith("mcp_fixture_"))!;
      await blocked.wait(signal); return call([name, {}]);
    } });
    await r.say("1", "开始", null);
    await vi.waitFor(() => expect(blocked.entered).toBe(1));
    if (mcp.config.kind !== "enabled") throw new Error("config");
    if (revoke === "owner") r.owners.splice(0);
    else if (revoke === "server") mcp.config.value.servers[0]!.enabled = false;
    else mcp.config.value.servers[0]!.access.allowSubagent = false;
    blocked.open(); await childIdle(r);
    expect(server.calls).toBe(0);
    const child = await childConversation(r);
    const results = (await child.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
    expect(results[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_denied" })]));
    expect((await child.agent(context)).tools.some(tool => tool.name.startsWith("mcp_"))).toBe(false);
  });

  it.each([false, true])("子 run 重启前撤权=%s：恢复先重配工具，续发不扩大快照", async revoke => {
    const { server, mcp } = await mcpFixture({ allowSubagent: true });
    const blocked = gate();
    const r = await residentRig({ mcp, brain: async (transcript, signal) => {
      if (!isChild(transcript)) return delegate(transcript);
      await blocked.wait(signal); return reply();
    } });
    await r.say("1", "开始", null);
    await vi.waitFor(() => expect(blocked.entered).toBe(1));
    const child = await childConversation(r), id = child.id;
    const grant = (await r.pi.harness.snapshot(McpDelegationDoc, id, context))!.grant;
    if (mcp.config.kind !== "enabled") throw new Error("config");
    if (revoke) mcp.config.value.servers[0]!.access.allowSubagent = false;
    // 持久工具选择带有父目录名称时，恢复也必须重建为子目录。
    const parentId = (await r.pi.readThreadIds()).owner as ConversationId;
    const parentState = await r.pi.harness.snapshot(AgentDoc, parentId, context);
    await r.pi.harness.commit(async tx => { (await tx.doc(AgentDoc, id)).extensions = parentState!.extensions; }, context);
    const seen: string[][] = [];
    r.brain.current = transcript => {
      if (!isChild(transcript)) return delegate(transcript);
      const tools = offeredTools(transcript); seen.push(tools);
      if (endRole(transcript) === "toolResult") return reply();
      const name = tools.find(name => name.startsWith("mcp_fixture_"));
      return name ? call([name, {}]) : reply("没有授权");
    };
    await r.restart(); await childIdle(r);
    expect(seen[0]?.some(name => name.startsWith("mcp_fixture_"))).toBe(!revoke);
    expect(server.calls).toBe(revoke ? 0 : 1);
    const recovered = await childConversation(r);
    expect(recovered.id).toBe(id);
    expect((await recovered.entries({}, 100, undefined, context)).items.filter(entry => entry.kind === "pi.user")).toHaveLength(1);
    expect((await r.pi.harness.snapshot(McpDelegationDoc, id, context))!.grant).toEqual(grant);
    await r.say("1", "续发", null); await childIdle(r);
    expect(server.calls).toBe(revoke ? 0 : 2);
  });

  it("未知唤醒续发会收紧已有快照，后续 owner message 不重新提权", async () => {
    const { server, mcp } = await mcpFixture({ allowSubagent: true });
    const seen: string[][] = [];
    const r = await residentRig({ mcp, brain: transcript => {
      if (!isChild(transcript)) return delegate(transcript);
      seen.push(offeredTools(transcript)); return reply();
    } });
    await r.say("1", "开始", null); await childIdle(r);
    expect(seen[0]?.some(name => name.startsWith("mcp_fixture_"))).toBe(true);
    const child = await childConversation(r);
    const parent = await r.pi.harness.conversation((await r.pi.readThreadIds()).owner as ConversationId, context);
    await (await parent!.submit({ type: "input", content: "续发", whenBusy: "followUp" }, context)).wait(context);
    await childIdle(r);
    expect((await r.pi.harness.snapshot(McpDelegationDoc, child.id, context))!.grant).toBeNull();
    await r.say("1", "续发", null); await childIdle(r);
    expect(seen).toHaveLength(3);
    expect(seen.slice(1).every(tools => !tools.some(name => name.startsWith("mcp_")))).toBe(true);
    expect(server.calls).toBe(0);
  });

  it("未获授权的 spawn 在启用开关后续发、重启仍无 MCP", async () => {
    const { server, mcp } = await mcpFixture();
    const seen: string[][] = [];
    const r = await residentRig({ mcp, brain: transcript => {
      if (!isChild(transcript)) return delegate(transcript);
      seen.push(offeredTools(transcript)); return reply();
    } });
    await r.say("1", "开始", null); await childIdle(r);
    if (mcp.config.kind !== "enabled") throw new Error("config");
    mcp.config.value.servers[0]!.access.allowSubagent = true;
    await r.say("1", "续发", null); await childIdle(r);
    await r.restart(); await r.say("1", "续发", null); await childIdle(r);
    expect(seen).toHaveLength(3);
    expect(seen.every(tools => !tools.some(name => name.startsWith("mcp_")))).toBe(true);
    expect(server.calls).toBe(0);
  });
});
