import { promises as fs } from "node:fs";
import path from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { PiInputDoc } from "../../../src/agent/backends/pi-input.js";
import { PiBackend } from "../../../src/agent/backends/pi.js";
import { HostInputDoc, ThreadHostDoc, type ThreadHostState } from "../../../src/agent/host/docs.js";
import { eventInputKey } from "../../../src/agent/events/service.js";
import { parseMcpConfig } from "../../../src/agent/pi-mcp/config.js";
import { PiPathPolicy } from "../../../src/agent/pi-tools/sandbox.js";
import { DeepSeekWeb } from "../../../src/agent/pi-tools/web.js";
import { trace, type LiveEvent } from "../../../src/shared/trace.js";
import { httpFixture } from "../fixtures/pi-mcp-http.js";
import { call, context, gate, reply, residentRig, toolResults, type ResidentRig } from "../resident-fixture.js";

const servers: Awaited<ReturnType<typeof httpFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.close(); });

async function event(r: ResidentRig, name: string) {
  const key = eventInputKey("gmail", name);
  r.bridge.inbox.openEventInput({ key, owner: "1", source: "gmail", count: 1, eventKeys: [key], time: 1,
    text: "[外部事件]\nEVENT_PRIVATE_TITLE\nEVENT_PRIVATE_SUMMARY" });
  await r.inbox.deliverEvent(key);
  return key;
}

/** 保存真实的未确认检查点；恢复时只保留它，模拟 Pi 已提交但宿主确认事务尚未落盘。 */
function captureUnconfirmed(r: ResidentRig) {
  let checkpoint: ThreadHostState | undefined;
  const start = r.pi.startTurn.bind(r.pi);
  vi.spyOn(r.pi, "startTurn").mockImplementation(async (...args) => {
    const result = await start(...args);
    checkpoint = structuredClone(await r.harness.snapshot(ThreadHostDoc, "owner", context));
    expect(checkpoint).toMatchObject({ busy: true, turnKind: "event" });
    expect(checkpoint?.turnId).toBeUndefined();
    const id = (await r.pi.readThreadIds()).owner as ConversationId;
    const live = await r.pi.harness.snapshot(LiveDoc, id, context);
    expect((await r.pi.harness.snapshot(PiInputDoc, id, context))?.submissions[String(live!.run!.inputs[0])])
      .toMatchObject({ inboundKey: args[1][0].inboundKey, identity: { kind: "event", source: "gmail", creator: "1" } });
    return result;
  });
  return async (key: string) => {
    await r.host.idle();
    if (!checkpoint) throw new Error("未捕获开轮确认前检查点");
    await r.harness.commit(async tx => {
      const host = await tx.doc(ThreadHostDoc, "owner", "owner");
      delete host.turnId;
      Object.assign(host, checkpoint);
      const input = await tx.doc(HostInputDoc, key, "owner");
      input.state = "starting";
      delete input.turnId;
    }, context);
    r.bridge.inbox.markInbound([key], "queued");
  };
}

it.each(["valid", "missing", "mismatched", "wrong-kind"] as const)("Pi 已提交而宿主未确认：%s 身份恢复仍只读", async persisted => {
  const server = await httpFixture(); servers.push(server);
  const config = parseMcpConfig({ version: 1, enabled: true, servers: [{ ...server.config,
    tools: { allow: ["first", "second"], eventAllow: ["first"] }, resources: { allow: ["notion://docs/"] } }] });
  if (config.kind !== "enabled") throw new Error("config");
  const before = gate(), resumed = gate();
  const r = await residentRig({ mcp: { config, secrets: { readReferencedVariable: () => "host-fixture-secret" } },
    brain: async (_transcript, signal) => { await before.wait(signal); return reply(); } });
  const restoreCheckpoint = captureUnconfirmed(r);
  const key = await event(r, persisted);
  await vi.waitFor(() => expect(before.entered).toBe(1));
  const id = (await r.pi.readThreadIds()).owner as ConversationId;
  const first = (await r.pi.harness.snapshot(LiveDoc, id, context))!.run!.inputs[0];
  if (persisted !== "valid") await r.pi.harness.commit(async tx => {
    const doc = await tx.doc(PiInputDoc, id);
    if (persisted === "missing") delete doc.submissions[String(first)];
    else if (persisted === "wrong-kind") doc.submissions[String(first)].identity = { kind: "user", sender: "1" };
    else doc.submissions[String(first)].inboundKey = "wrong-input";
  }, context);
  await restoreCheckpoint(key);
  const policies: PiPathPolicy[] = [];
  const check = PiPathPolicy.prototype.check;
  vi.spyOn(PiPathPolicy.prototype, "check").mockImplementation(function (this: PiPathPolicy, ...args) {
    policies.push(this); return check.apply(this, args);
  });
  await fs.writeFile(path.join(r.dir, "pi-work", "owner", "probe.txt"), "readable", "utf8");
  const offered: string[][] = [];
  r.brain.current = async (transcript, signal) => {
    offered.push(getCurrentTools(transcript.messages).map(tool => tool.name));
    await resumed.wait(signal);
    return toolResults(transcript).length ? reply() : call(["read", { path: "probe.txt" }]);
  };
  // 宿主重排的 startTurn 尚未进入 Pi：强制 snapshot listener 先接管仍在的 run。
  const hostStart = gate(), start = PiBackend.prototype.startTurn;
  vi.spyOn(PiBackend.prototype, "startTurn").mockImplementation(async function (this: PiBackend, ...args) {
    await hostStart.wait(); return start.apply(this, args);
  });
  const restarting = r.restart();
  try {
    await vi.waitFor(() => expect(resumed.entered).toBeGreaterThan(0));
    expect(await r.pi.binding(id)).toMatchObject({ identity: { kind: "event" } });
    await expect(r.pi.spawner(id)).rejects.toThrow("事件回合不能派子 agent");
  } finally { hostStart.open(); }
  await restarting;
  await r.host.idle();
  expect(r.host.currentIdentity("owner")).toMatchObject({ kind: "event", source: persisted === "valid" ? "gmail" : "unidentified" });
  expect(r.host.thread("owner")).toMatchObject({ turnKind: "event", turnSender: persisted === "valid" ? "1" : "", turnInputs: [{ inboundKey: key }] });
  expect(await r.pi.binding(id)).toMatchObject({ identity: { kind: "event" }, inputKey: key });
  await expect(r.pi.spawner(id)).rejects.toThrow("事件回合不能派子 agent");
  const agent = await (await r.pi.harness.conversation(id, context))!.agent(context);
  const tools = [...agent.tools, ...agent.deferred, ...agent.callable].map(tool => tool.name);
  expect(tools).toContain("read"); expect(tools).toContain("send_message");
  expect(tools.filter(name => ["auth", "schedule", "schedule_control"].includes(name) || ["write", "edit", "bash", "subagent", "skill_publish"].includes(name))).toEqual([]);
  expect(offered[0].filter(name => ["auth", "schedule", "schedule_control"].includes(name) || ["write", "edit", "bash", "subagent", "skill_publish"].includes(name))).toEqual([]);
  const mcp = [...new Set(tools.filter(name => name.startsWith("mcp_fixture_")))];
  expect(mcp).toEqual(persisted === "valid" ? [expect.stringMatching(/^mcp_fixture_first_/)] : []);
  resumed.open(); await r.idle();
  expect(policies.length).toBeGreaterThan(0);
  await expect(policies[0].check("forbidden.txt", "write")).rejects.toThrow("事件回合");
  expect(r.bridge.inbox.getInbound(key)?.state).toBe("done");
});

it.each([false, true])("safe 工具 execute 检查点重放不泄露正文，宿主未保存 turnId=%s", async unconfirmed => {
  const executing = gate(), afterRestart = gate(), web = new DeepSeekWeb();
  const search = vi.spyOn(web, "search").mockImplementation(async (_query, _count, signal) => {
    await executing.wait(signal); return "EVENT_PRIVATE_TITLE EVENT_PRIVATE_SUMMARY";
  });
  const r = await residentRig({ web, brain: transcript => {
    if (!toolResults(transcript).length) return call(["web_search", { query: "EVENT_PRIVATE_TITLE" }]);
    for (let i = 0; i < 10001; i++) trace.metadataOnly("before-model-response:" + i);
    return reply("EVENT_PRIVATE_SUMMARY");
  } });
  const restoreCheckpoint = captureUnconfirmed(r);
  const key = await event(r, "tool-replay-" + unconfirmed);
  await vi.waitFor(() => expect(executing.entered).toBe(1));
  const tasks = (await r.pi.harness.inspect(context)).tasks.map(task => task.record);
  expect(tasks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "pi.tool",
    state: expect.objectContaining({ checkpoint: expect.objectContaining({ phase: "execute" }) }) })]));
  if (unconfirmed) await restoreCheckpoint(key);
  search.mockImplementation(async () => { await afterRestart.wait(); return "EVENT_PRIVATE_TITLE EVENT_PRIVATE_SUMMARY"; });
  // 模拟新进程没有内存标记，也覆盖有界标记被淘汰的情况。
  for (let i = 0; i < 10001; i++) trace.metadataOnly("evicted:" + i);
  const events: LiveEvent[] = [];
  const stop = trace.tap(item => events.push(item));
  try {
    await r.restart();
    await vi.waitFor(() => expect(afterRestart.entered).toBe(1));
    for (let i = 0; i < 10001; i++) trace.metadataOnly("evicted-again:" + i);
    afterRestart.open(); await r.idle();
    const tools = events.filter(item => item.stage === "tool:web_search");
    expect(tools.map(item => item.status)).toEqual(["ok"]); // 重放没有 beforeTool。
    expect(tools[0].detail).toEqual({ backend: "pi" });
    expect(events.some(item => item.stage === "model_turn" && item.status === "ok")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("EVENT_PRIVATE");
    expect(search).toHaveBeenCalledTimes(2);
  } finally { stop(); afterRestart.open(); }
});

it("发送完成与回合失败独立恢复 metadataOnly，不依赖入站键或先前钩子", async () => {
  const r = await residentRig(), events: LiveEvent[] = [];
  const send = r.call.getMockImplementation()!;
  r.call.mockImplementation(async (...args) => {
    for (let i = 0; i < 10001; i++) trace.metadataOnly("during-send:" + i);
    return send(...args);
  });
  const stop = trace.tap(item => events.push(item));
  try {
    await r.sendService.send({ threadKey: "owner", scope: "private:1", turnId: "pi:recovered-send",
      identity: { kind: "event", source: "gmail", creator: "1" }, inputs: [], access: { kind: "all" }, workdir: r.dir },
    { text: "EVENT_PRIVATE_TITLE EVENT_PRIVATE_SUMMARY" }, "recovered-send");
    expect(events.find(item => item.stage === "send_message")?.detail).toEqual({ system: false, status: "sent", already_sent: false });
    r.monitor.events.turnEnded!({ threadKey: "owner", turnId: "pi:unmarked-end", kind: "event", inputs: [],
      status: "failed", error: "EVENT_PRIVATE_TITLE EVENT_PRIVATE_SUMMARY" });
    await r.monitor.idle();
    expect(events.find(item => item.key === "turn:pi:unmarked-end")?.detail).toMatchObject({ terminal: true, kind: "event", status: "failed" });
    expect(JSON.stringify(events)).not.toContain("EVENT_PRIVATE");
  } finally { stop(); }
});
