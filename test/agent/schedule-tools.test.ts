import { describe, expect, it } from "vitest";
import { SCHEDULE_MANAGEMENT_TOOLS } from "../../src/shared/schedule-tools.js";
import { parseBeijingTime, parseToolRule, formatBeijingTime, scheduleDescriptions } from "../../src/agent/schedule/tool-schema.js";
import { ScheduleRuntimeDoc } from "../../src/agent/schedule/docs.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { scheduleToolsFixture } from "./schedule-tools-fixture.js";

describe("定时工具", () => {
  it.each([
    ["1", false, false, true, false],
    ["9", true, false, true, false],
    ["9", false, false, false, false],
    ["1", false, true, false, true],
    ["9", true, true, false, true],
  ] as const)("可见性 actor=%s grant=%s scheduled=%s", async (user, grant, scheduled, schedule, scheduleControl) => {
    const f = await scheduleToolsFixture();
    if (grant) await f.grants.panel("auth_grant", { user: `qq:${user}`, caps: ["schedule"], scopes: ["group:7"] });
    let binding = f.binding(user);
    if (scheduled) binding = await f.scheduled((await f.create(binding)).id, binding.actor);
    expect(await f.tools.permissions(binding)).toEqual({ schedule, scheduleControl });
    if (!schedule) for (const name of SCHEDULE_MANAGEMENT_TOOLS) {
      await expect(f.tools.tool(binding, name, {})).rejects.toThrow("交互回合");
    }
    if (!scheduleControl) await expect(f.tools.tool(binding, "schedule_control", { action: "complete", reason: "结束" })).rejects.toThrow("仅限定时");
  });

  it.each([["1", null, "owner"], ["1", "7", "group:7"], ["9", null, "private:9"], ["9", "7", "group:7"]] as const)(
    "来源绑定 user=%s group=%s → %s", async (user, group, conversation) => {
      const f = await scheduleToolsFixture();
      await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"] });
      const bound = f.binding(user, group), schedule = await f.create(bound);
      expect(schedule).toMatchObject({ conversation, created_by: `qq:${user}`, prompt: f.args.prompt, mode: "thread" });
      for (const extra of [{ conversation: "group:8" }, { created_by: "qq:1" }, { actor: "qq:1" }]) {
        await expect(f.tools.tool(bound, "schedule_create", { ...f.args, ...extra })).rejects.toThrow();
      }
      expect(f.event).toHaveBeenCalledWith("thr:" + bound.threadKey, "schedule_tool", { detail: {
        action: "create", id: schedule.id, actor: `qq:${user}`, tool: "schedule_create",
      } });
    });

  it("非 owner 只见自己的任务，所有按 id 操作均拒绝其他人的定义", async () => {
    const f = await scheduleToolsFixture(), owner = f.binding(), member = f.binding("9");
    await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"] });
    const theirs = await f.create(owner), own = await f.create(member);
    expect(await f.tools.tool(owner, "schedule_list", {})).toContain(own.id);
    const listed = await f.tools.tool(member, "schedule_list", {});
    expect(listed).toContain(own.id); expect(listed).not.toContain(theirs.id);
    for (const name of ["schedule_update", "schedule_pause", "schedule_resume", "schedule_delete", "schedule_run_now"] as const) {
      await expect(f.tools.tool(member, name, { id: theirs.id })).rejects.toThrow("只能管理自己");
    }
    expect(await f.service.get(theirs.id)).toEqual(theirs);
    expect(await f.tools.tool(owner, "schedule_pause", { id: own.id })).toContain("暂停");
  });

  it("实时复核授权撤销、过期与 scopes；唤醒回合没有定时工具；send 授权不赋予 schedule", async () => {
    const f = await scheduleToolsFixture(), member = f.binding("9"), own = await f.create();
    await f.grants.panel("auth_grant", { user: "qq:9", caps: ["send"], targets: ["qq:group:8"] });
    expect((await f.tools.permissions(member)).schedule).toBe(false);
    await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: ["group:7"] });
    expect((await f.tools.permissions(member)).schedule).toBe(true);
    expect((await f.tools.permissions(f.binding("9", "8"))).schedule).toBe(false);
    await f.grants.panel("auth_revoke", { user: "qq:9" });
    for (const name of SCHEDULE_MANAGEMENT_TOOLS) await expect(f.tools.tool(member, name, { id: own.id })).rejects.toThrow("授权");
    await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], expires_in_hours: Number.MIN_VALUE });
    expect((await f.tools.permissions(member)).schedule).toBe(false);
    const wake = { ...f.binding(), identity: { kind: "wake" as const } };
    expect(await f.tools.permissions(wake)).toEqual({ schedule: false, scheduleControl: false });
    await expect(f.tools.tool(wake, "schedule_list", {})).rejects.toThrow("基础权限");
  });

  it("管理动作返回 id、状态和北京时间；run_now 不改计划，update 不改来源", async () => {
    const f = await scheduleToolsFixture(), bound = f.binding(), s = await f.create(bound);
    const next = formatBeijingTime(s.next_fire_at!);
    expect(await f.tools.tool(bound, "schedule_list", {})).toContain(`${next}（北京时间）`);
    expect(await f.tools.tool(bound, "schedule_update", { id: s.id, name: "新名称", prompt: "检查并通知" })).toContain("新名称");
    expect(await f.tools.tool(bound, "schedule_pause", { id: s.id })).toContain("下次：无");
    expect(await f.tools.tool(bound, "schedule_resume", { id: s.id })).toContain("启用");
    const before = (await f.service.get(s.id))!;
    expect(await f.tools.tool(bound, "schedule_run_now", { id: s.id })).toContain("本次运行：queued");
    expect((await f.service.get(s.id))!.next_fire_at).toBe(before.next_fire_at);
    await expect(f.tools.tool(bound, "schedule_update", { id: s.id, conversation: "group:8" })).rejects.toThrow();
    expect(await f.tools.tool(bound, "schedule_delete", { id: s.id })).toContain("已删除");
    expect(await f.tools.tool(bound, "schedule_list", {})).toBe("没有可见的定时任务。");
  });

  it.each(["pause", "complete"] as const)("schedule_control %s 只影响运行绑定定义，保留在途记录", async action => {
    const f = await scheduleToolsFixture(), first = await f.create(), other = await f.create();
    const bound = await f.scheduled(first.id), before = (await f.service.get(first.id))!;
    await expect(f.tools.tool(bound, "schedule_control", { action, reason: "结束", id: other.id })).rejects.toThrow();
    const result = await f.tools.tool(bound, "schedule_control", { action, reason: "监控结束" });
    const updated = (await f.service.get(first.id))!;
    expect(result).toContain(first.id);
    expect(updated).toMatchObject({ status: action === "pause" ? "paused" : "completed", next_fire_at: null, revision: before.revision + 1, runs: before.runs });
    expect((await f.harness.snapshot(ScheduleRuntimeDoc, BACKGROUND_CONTEXT))?.tasks[first.id]).toBeUndefined();
    expect(await f.service.get(other.id)).toEqual(other);
    await f.tools.tool(bound, "schedule_control", { action, reason: "监控结束" });
    expect((await f.service.get(first.id))?.revision).toBe(updated.revision);
    expect(f.event.mock.calls.at(-1)?.[2]).toMatchObject({ detail: { action, id: first.id, actor: "qq:1", reason: "监控结束" } });
    await f.service.recordRun(first.id, { ...before.runs[0], status: "silent", ended_at: Date.now() });
    expect((await f.service.get(first.id))?.status).toBe(updated.status);
  });

  it("授权人失权后仍能停止自己的在途任务；不存在运行记录的定时输入不能控制", async () => {
    const f = await scheduleToolsFixture(), member = f.binding("9");
    await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"] });
    const own = await f.create(member), run = await f.scheduled(own.id, "qq:9");
    await f.grants.panel("auth_revoke", { user: "qq:9" });
    expect(await f.tools.tool(run, "schedule_control", { action: "complete", reason: "停止" })).toContain("已完成");
    const key = "run_" + "e".repeat(40);
    await expect(f.tools.tool({ ...run, inputs: [key] }, "schedule_control", { action: "complete", reason: "停止" })).rejects.toThrow("绑定");
  });
});

describe("北京时间工具输入", () => {
  it.each([
    ["2026-10-20 08:30", "2026-10-20T00:30:00.000Z"],
    ["2026-10-20 00:05", "2026-10-19T16:05:00.000Z"],
    ["2028-02-29 23:59", "2028-02-29T15:59:00.000Z"],
  ])("%s 转真实 UTC 时刻", (input, expected) => {
    expect(new Date(parseBeijingTime(input)).toISOString()).toBe(expected);
    expect(formatBeijingTime(parseBeijingTime(input))).toBe(input);
  });
  it.each(["2026-02-29 08:30", "2026-04-31 08:30", "2026-13-01 08:30", "2026-10-20 24:00",
    "2026-10-20 08:60", "2026-10-20T08:30", "2026-10-20 08:30Z", "2026-1-2 08:30", " 2026-10-20 08:30"])("拒绝 %s", input => {
    expect(() => parseBeijingTime(input)).toThrow();
  });
  it("RRULE start 缺省为现在；at 与显式 start 都按北京墙钟解析", () => {
    expect(parseToolRule({ rrule: "FREQ=DAILY" }, 123456789)).toEqual({ kind: "rrule", rrule: "FREQ=DAILY", dtstart: 123456789 });
    const input = "2026-10-20 08:30", ms = Date.parse("2026-10-20T00:30Z");
    expect(parseToolRule({ at: input }, 0)).toEqual({ kind: "at", at: ms });
    expect(parseToolRule({ rrule: "FREQ=DAILY", start: input }, 0)).toMatchObject({ dtstart: ms });
    expect(scheduleDescriptions.schedule_create).toContain("qq_chats");
    expect(scheduleDescriptions.schedule_create).toContain("silent if nothing new");
    expect(scheduleDescriptions.schedule_create).toContain("qq:group:123");
  });
});
