import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ConversationId } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { SUBAGENT_REPORT_KIND, SubagentDoc } from "../../src/agent/pi-tools/subagent.js";
import { call, context, gate, isChild, lastUser, reply, residentRig } from "./resident-fixture.js";

it("owner 用户派出、定时回合追问后无继承身份的汇报，重启仍保留基础 wake 工具", async () => {
  const childHold = gate();
  let wakeHold = gate();
  const offered: string[][] = [];
  const r = await residentRig({ brain: async (transcript, signal) => {
    if (isChild(transcript)) { await childHold.wait(signal); return reply("任务完成"); }
    if (transcript.messages.at(-1)?.role === "toolResult") return reply("已安排");
    const input = lastUser(transcript);
    if (input.startsWith("[子 agent")) {
      offered.push(getCurrentTools(transcript.messages).map(tool => tool.name));
      await wakeHold.wait(signal);
      return reply("收到汇报");
    }
    if (input.includes("定时追问")) return call(["subagent", { action: "message", name: "worker", task: "补充任务" }]);
    return call(["subagent", { action: "spawn", name: "worker", task: "初始任务" }]);
  } });

  await r.say("1", "派出", null);
  await r.idle();
  await vi.waitFor(() => expect(childHold.entered).toBe(1));
  const id = (await r.pi.readThreadIds()).owner as ConversationId;
  expect((await r.pi.harness.snapshot(SubagentDoc, id, context))?.children.worker?.spawner)
    .toEqual({ turn: "user", as: { kind: "user", person: "1", owner: true } });

  const scheduled = r.bridge.inbox.openScheduledInput({ key: "run_" + "a".repeat(40), scope: "private:1", thread_key: "owner",
    creator: "qq:1", text: "[定时任务] 定时追问", time: 1 });
  await r.inbox.deliverScheduled(scheduled.key);
  await r.idle();
  expect((await r.pi.harness.snapshot(SubagentDoc, id, context))?.children.worker?.spawner).toEqual({ turn: "scheduled" });
  childHold.open();
  await vi.waitFor(() => expect(wakeHold.entered).toBeGreaterThan(0));

  const assertBasicWake = async () => {
    expect(r.host.currentIdentity("owner")).toEqual({ kind: "wake" });
    expect(await r.pi.binding(id)).toMatchObject({ identity: { kind: "wake" }, access: "private:1", auth: false });
    await expect(r.pi.spawner(id)).resolves.toEqual({ turn: "wake" });
    const tools = offered.at(-1)!;
    expect(tools).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "subagent", "send_message"]));
    expect(tools.filter(name => /^(auth_|schedule_)/.test(name))).toEqual([]);
  };
  await assertBasicWake();
  const conv = (await r.pi.harness.conversation(id, context))!;
  const reports = (await conv.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(entry => entry.kind === SUBAGENT_REPORT_KIND);
  expect(reports.length).toBeGreaterThan(0);
  for (const report of reports) {
    expect(report.data).toHaveProperty("spawner");
    expect(report.data).not.toHaveProperty("spawner.as");
  }

  wakeHold = gate();
  await r.restart();
  await vi.waitFor(() => expect(wakeHold.entered).toBeGreaterThan(0));
  await assertBasicWake();
  wakeHold.open();
  await r.idle();
});
