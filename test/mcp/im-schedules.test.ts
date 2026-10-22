import { expect, it } from "vitest";
import { SCHEDULE_MANAGEMENT_TOOLS } from "../../src/shared/schedule-tools.js";
import type { GrantBinding } from "../../src/agent/grants.js";
import type { CallBinding } from "../../src/context/media-recall-server.js";
import { scheduleToolsFixture } from "../agent/schedule-tools-fixture.js";
import { imRig } from "./im-fixture.js";

async function setup(user = "1", grant = false, scheduled = false) {
  const f = await scheduleToolsFixture();
  if (grant) await f.grants.panel("auth_grant", { user: `qq:${user}`, caps: ["schedule"], scopes: ["group:7"] });
  let binding = f.binding(user);
  const own = scheduled ? await f.create(binding) : undefined;
  if (own) binding = await f.scheduled(own.id, binding.actor);
  // 令牌只绑定会话；网关按调用所属回合取回宿主给出的本轮绑定（测试中由 turns 表模拟，缺省为 turn-1）。
  const turns = new Map<string, GrantBinding>([["turn-1", binding]]);
  const call = (turnId: string): CallBinding => ({ ...turns.get(turnId)!, turnId, access: { kind: "all" }, workdir: "/w", session: "thr-1",
    imageDir: "/data/images/x", imageRefs: [] });
  const rig = await imRig(binding.threadKey, {
    resolve: meta => { if (!turns.has(meta.turnId ?? "turn-1")) throw new Error("本回合已结束，工具调用不再有效"); return call(meta.turnId ?? "turn-1"); },
    permissions: async b => ({ ...await f.grants.permissions(b), ...await f.tools.permissions(b) }),
    schedule: (b, name, args) => f.tools.tool(b, name, args),
    send: async () => { throw new Error("本测试不发送"); },
  });
  return { ...f, ...rig, own, makeBinding: f.binding, binding, turns };
}

it.each([
  ["1", false, false], ["9", true, false], ["9", false, false], ["1", false, true], ["9", true, true],
] as const)("真实 im 子进程：定时工具全部列出，按本次调用的身份在主进程校验 actor=%s grant=%s scheduled=%s", async (user, grant, scheduled) => {
  const f = await setup(user, grant, scheduled);
  const visible = (await f.client.listTools()).tools.filter(t => t.name.startsWith("schedule_"));
  expect(visible.map(t => t.name)).toEqual([...SCHEDULE_MANAGEMENT_TOOLS, "schedule_control"]);
  if (scheduled || user === "9" && !grant) for (const name of SCHEDULE_MANAGEMENT_TOOLS) {
    expect((await f.tool(name, {})).isError).toBe(true);
    expect((await f.post(name, {})).status).toBe(400);
  }
  if (!scheduled) {
    const args = { action: "complete", reason: "伪造定时回合" };
    expect((await f.tool("schedule_control", args)).isError).toBe(true);
    expect((await f.post("schedule_control", args)).status).toBe(400);
  } else {
    expect(visible.at(-1)!.inputSchema.properties).not.toHaveProperty("id");
    const result = await f.tool("schedule_control", { action: "complete", reason: "监控结束" });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(f.own!.id);
    expect((await f.service.get(f.own!.id))?.status).toBe("completed");
  }
});

it("codex 创建、列出、更新、暂停、恢复、立即运行和删除；大于 2 KiB 的中文 prompt 完整保存", async () => {
  const f = await setup(), args = { ...f.args, prompt: "检查资讯，更新时发到 qq:group:7；".repeat(150) };
  const created = await f.tool("schedule_create", args);
  expect(created.isError).not.toBe(true);
  const schedule = (await f.service.list())[0]!;
  expect(schedule).toMatchObject({ prompt: args.prompt, created_by: "qq:1", conversation: "group:7" });
  expect(JSON.stringify(created.content)).toContain("北京时间");
  expect(JSON.stringify(created.content)).toContain(schedule.id);
  expect(JSON.stringify((await f.tool("schedule_list")).content)).toContain(schedule.id);
  for (const name of ["schedule_update", "schedule_pause", "schedule_resume", "schedule_run_now", "schedule_delete"] as const) {
    const result = await f.tool(name, { id: schedule.id, ...(name === "schedule_update" ? { name: "更名", prompt: args.prompt } : {}) });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(schedule.id);
  }
  expect(await f.service.list()).toEqual([]);
});

it("HTTP 不接受模型传入的身份或来源，授权人不能操作 owner 的任务；唤醒回合没有定时工具", async () => {
  const f = await setup("9", true), ownerSchedule = await f.create(f.makeBinding("1"));
  for (const extra of [{ actor: "qq:1" }, { created_by: "qq:1" }, { conversation: "owner" }]) {
    expect((await f.post("schedule_create", { ...f.args, ...extra })).status).toBe(400);
  }
  for (const name of ["schedule_update", "schedule_pause", "schedule_resume", "schedule_delete", "schedule_run_now"]) {
    expect((await f.post(name, { id: ownerSchedule.id })).status).toBe(400);
  }
  expect(JSON.stringify(await (await f.post("schedule_list", {})).json())).not.toContain(ownerSchedule.id);
  f.turns.set("wake", { ...f.makeBinding("1"), identity: { kind: "wake" } });
  expect((await f.post("schedule_create", f.args, { turnId: "wake" })).status).toBe(400);
  expect((await f.post("schedule_list", {}, { turnId: "wake" })).status).toBe(400);
  expect(await f.service.get(ownerSchedule.id)).toEqual(ownerSchedule);
});

it("HTTP 控制只取本次调用所属的定时运行绑定；跨任务 id 不生效", async () => {
  const f = await setup("1", false, true), other = await f.create(f.makeBinding("1"));
  expect((await f.post("schedule_control", { action: "pause", reason: "结束", id: other.id })).status).toBe(400);
  expect((await f.post("schedule_control", { action: "pause", reason: "等待更新" })).status).toBe(200);
  expect((await f.service.get(f.own!.id))?.status).toBe("paused");
  expect(await f.service.get(other.id)).toEqual(other);
});

it("授权撤销后端点复核拒绝；不属于当前回合的调用与作废令牌均无副作用", async () => {
  const f = await setup("9", true);
  expect((await f.tool("schedule_list")).isError).not.toBe(true);
  await f.grants.panel("auth_revoke", { user: "qq:9" });
  expect((await f.tool("schedule_create", f.args)).isError).toBe(true);
  expect((await f.post("schedule_create", f.args)).status).toBe(400);
  expect((await f.post("schedule_list", {}, { turnId: "ended" })).status).toBe(400);
  f.tokens.revoke(f.binding.threadKey);
  expect((await f.post("schedule_list", {})).status).toBe(401);
  expect(await f.service.list()).toEqual([]);
});
