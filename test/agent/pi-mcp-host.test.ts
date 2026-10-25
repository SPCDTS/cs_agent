import type { TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpConfig } from "../../src/agent/pi-mcp/config.js";
import type { PiBackendOptions } from "../../src/agent/backends/pi.js";
import type { PiCallBinding } from "../../src/agent/pi-tools/request.js";
import { httpFixture } from "./fixtures/pi-mcp-http.js";
import { call, reply, residentRig, type ResidentRig } from "./resident-fixture.js";

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

async function mcpFixture(): Promise<{ server: Awaited<ReturnType<typeof httpFixture>>; mcp: NonNullable<PiBackendOptions["mcp"]> }> {
  const server = await httpFixture(); servers.push(server);
  const config = parseMcpConfig({ version: 1, enabled: true, servers: [{ ...server.config, tools: { allow: ["first"] } }] });
  if (config.kind !== "enabled") throw new Error("fixture_config_invalid");
  return { server, mcp: { config, secrets: { readReferencedVariable: name => name === "FIXTURE_SECRET" ? "host-fixture-secret" : undefined } } };
}

describe("Pi MCP 真实宿主接线", () => {
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
