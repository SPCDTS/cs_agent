import { describe, expect, it, vi } from "vitest";
import { CodexScript } from "./codex-fixture.js";
import { call, isChild, lastUser, reply, residentRig } from "./resident-fixture.js";

/** 面板拓扑的数据来源：pi 的子 agent 登记、codex app-server 的子 agent 通知，以及会话列表里子 agent 的标签。 */
const G = "group:7";

describe("Agent 拓扑：后端给出的子 agent", () => {
  it("pi：派出的子 agent 带名称、任务、状态与结果；子会话标为「会话 › 名称」并随父会话活动", async () => {
    const r = await residentRig({ brain: ctx => {
      if (isChild(ctx)) return reply("晴，25 度");
      const input = lastUser(ctx);
      if (input.startsWith("[子 agent 完成]")) return reply("转告完毕");
      if (ctx.messages.at(-1)!.role === "toolResult") return reply("已派出");
      return call(["subagent", { action: "spawn", name: "w", task: "查天气" }]);
    } });
    expect(await r.pi.subagents(G)).toEqual([]);
    await r.say("5", "查一下天气");
    await vi.waitFor(async () => expect((await r.pi.subagents(G))[0]?.state).toBe("done"), { timeout: 15_000 });
    const [child] = await r.pi.subagents(G);
    expect(child).toMatchObject({ name: "w", task: "查天气", result: expect.stringContaining("晴，25 度") });
    const listed = await r.pi.sessionSource.listConversations();
    expect(listed.find(c => c.id === child!.session)).toMatchObject({ label: `${G} › w`, scope: G, status: "active" });
    await r.idle(15_000);
  });

  it("codex：spawnAgent 的 prompt 为任务，agentPath 末段为名称；运行中、完成、中断分别显示", async () => {
    const script = new CodexScript();
    const r = await residentRig({ backend: "codex", codex: script });
    await r.say("5", "派子 agent");
    await r.idle();
    const parent = script.turns[0]!;
    const item = (type: string, extra: Record<string, unknown>) => parent.child.notify("item/completed", { threadId: parent.threadId, turnId: parent.turnId, item: { type, ...extra } });
    item("collabAgentToolCall", { id: "c-1", tool: "spawnAgent", prompt: "查资料", receiverThreadIds: ["child-1"], senderThreadId: parent.threadId, status: "completed" });
    item("subAgentActivity", { id: "a-1", agentThreadId: "child-1", agentPath: "/root/researcher", kind: "started" });
    item("subAgentActivity", { id: "a-2", agentThreadId: "child-2", agentPath: "/root/helper", kind: "started" });
    await vi.waitFor(() => expect(r.codex.subagents(G)).toHaveLength(2));
    expect(r.codex.subagents(G)).toEqual([
      expect.objectContaining({ session: "child-2", name: "helper", state: "running" }),
      expect.objectContaining({ session: "child-1", name: "researcher", state: "running", task: "查资料" }),
    ]);
    item("subAgentActivity", { id: "a-3", agentThreadId: "child-1", agentPath: "/root/researcher", kind: "completed" });
    item("subAgentActivity", { id: "a-4", agentThreadId: "child-2", agentPath: "/root/helper", kind: "interrupted" });
    await vi.waitFor(() => expect(r.codex.subagents(G).map(a => a.state)).toEqual(["stopped", "done"]));
    expect(r.codex.subagents("group:9")).toEqual([]);
  });
});
