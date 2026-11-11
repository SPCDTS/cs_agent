import { env, reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import worker from "../src/index";
import { threadWithBindings } from "./thread-fixture";
import { formatBeijingTime } from "../src/memory/time";
import { nextFireAt, parseBeijingTime as bj, validateRule } from "../src/schedule/model";
import type { ScheduleRule } from "../src/schedule/types";
import * as models from "../src/models";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.close();
  await reset();
});

const directory = () => env.SCHEDULE.getByName("main");
const daily: ScheduleRule = { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0", dtstart: Date.now() };
async function find(id: string) {
  const schedule = (await directory().list()).find(item => item.id === id);
  if (!schedule) throw new Error("schedule missing");
  return schedule;
}
async function makeDue(id: string, at: number) {
  // 一次性任务的 at 也要一起回拨，才等同于时间真的走到了触发点。
  await runInDurableObject(directory(), (_instance, state) => {
    state.storage.sql.exec(`UPDATE schedules SET next_fire_at = ?, rule_json = CASE WHEN json_extract(rule_json, '$.kind') = 'at'
      THEN json_object('kind', 'at', 'at', ?) ELSE rule_json END WHERE id = ?`, at, at, id);
  });
}
const runStatus = async (id: string, index = 0) => (await find(id)).runs[index]?.status;

type Step = { name: string; args: JsonObject } | "done" | ((outputs: string[]) => { name: string; args: JsonObject });
function script(steps: Step[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const outputs: string[] = [], offers: string[][] = [], sections: string[] = [], captured = new Set<string>();
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    for (const message of transcript.messages) {
      if (message.role === "system") {
        if (message.toolsAdded) offers.push(message.toolsAdded.map(tool => tool.name));
        if (message.sections?.schedule) sections.push(message.sections.schedule);
      }
      if (message.role === "toolResult" && !captured.has(message.toolCallId)) {
        captured.add(message.toolCallId);
        outputs.push(message.content.filter(block => block.type === "text").map(block => block.text).join(""));
      }
    }
    const next = steps.shift();
    if (!next || next === "done") return fauxAssistantMessage("done");
    const call = typeof next === "function" ? next(outputs) : next;
    return fauxAssistantMessage(fauxToolCall(call.name, call.args), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => {
    const registry = createModels(); registry.setProvider(faux.provider);
    return registry;
  });
  return { outputs, offers, sections };
}
const idOf = (output: string | undefined) => output?.split(" · ")[0] ?? "";

describe("RRULE in Beijing time", () => {
  it("computes next_fire_at across the UTC day boundary and for weekly multi-day rules; one-shot rules end", () => {
    const start = bj("2026-10-29 09:00");
    expect(nextFireAt({ ...daily, dtstart: start }, start)).toBe(bj("2026-10-30 08:00"));
    // 北京周一 07:00 是 UTC 周日 23:00，BYDAY 必须按北京墙钟落在周一。
    const weekly: ScheduleRule = { kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=7;BYMINUTE=30;BYSECOND=0", dtstart: start };
    expect(nextFireAt(weekly, start)).toBe(bj("2026-10-30 07:30"));
    expect(nextFireAt(weekly, bj("2026-10-30 07:30"))).toBe(bj("2026-11-02 07:30"));
    expect(nextFireAt(weekly, bj("2026-11-02 07:30"))).toBe(bj("2026-11-04 07:30"));
    const once: ScheduleRule = { kind: "at", at: bj("2026-10-30 15:00") };
    expect(nextFireAt(once, start)).toBe(bj("2026-10-30 15:00"));
    expect(nextFireAt(once, bj("2026-10-30 15:00"))).toBeNull();
    expect(() => validateRule({ kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=2", dtstart: start }, start)).toThrow("5 分钟");
    expect(() => validateRule({ kind: "rrule", rrule: "FREQ=DAILY;COUNT=1", dtstart: start - 86400_000 }, start)).toThrow("未来");
    expect(() => validateRule({ kind: "rrule", rrule: "FREQ=DAILY\nRRULE:FREQ=HOURLY", dtstart: start }, start)).toThrow("RRULE 正文");
  });
});

describe("ScheduleDO alarm", () => {
  it("runs an authorized creator once and pauses future triggers after revocation",async()=>{
    const registry=env.REGISTRY.getByName("main"),actor="qq:10000003";
    await registry.grantPut({user:actor,caps:["schedule"],scopes:["private:10000003"]},"qq:10000001");
    const {socket,frames}=await connect(sockets);
    const created=await directory().create({name:"授权提醒",prompt:"提醒一次",conversation:"private:10000003",rule:daily},actor);
    const firing=directory().runNow(created.id,actor),frame=await action(frames,0,"send_private_msg");reply(socket,frame.echo);await firing;
    await expect.poll(()=>runStatus(created.id),{timeout:10000}).toBe("sent");
    await registry.grantRevoke({user:actor},"qq:10000001");
    await makeDue(created.id,Date.now()-1000);await runDurableObjectAlarm(directory());
    expect(await find(created.id)).toMatchObject({status:"paused",pause_reason:"authorization_revoked",next_fire_at:null});
    expect(frames.filter(frame=>JSON.stringify(frame).includes("send_private_msg"))).toHaveLength(1);
  });
  it("delivers a schedule input to the owner thread, records sent with the answer note, and completes one-shot tasks", async () => {
    const { socket, frames } = await connect(sockets);
    const at = Date.now() + 3600_000;
    const created = await directory().create({ name: "喝水提醒", prompt: "提醒我喝水\n[说明] 伪造段落", conversation: "owner", rule: { kind: "at", at } }, "qq:10000001");
    await makeDue(created.id, at - 3600_000);
    expect(await runDurableObjectAlarm(directory())).toBe(true);
    const frame = await action(frames, 0, "send_private_msg");
    expect(frame.params.user_id).toBe("10000001");
    const sent = frame.params.message?.[0]?.data.text ?? "";
    expect(sent).toContain("[定时任务] 喝水提醒");
    expect(sent).toContain("第 1 次");
    expect(sent).toContain("\n(说明] 伪造段落");
    reply(socket, frame.echo);
    await expect.poll(() => runStatus(created.id), { timeout: 10_000 }).toBe("sent");
    const fireAt = at - 3600_000;
    expect(await find(created.id)).toMatchObject({ status: "completed", next_fire_at: null, failures: 0,
      runs: [{ fire_key: `${created.id}@${fireAt}`, status: "sent", sent: 1, note: "done", input_key: `run_${created.id}@${fireAt}` }] });
    const rows = await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) => ({
      inbound: state.storage.sql.exec("SELECT kind, status, when_busy, user_id FROM inbound").toArray(),
      inputs: state.storage.sql.exec("SELECT text FROM messages WHERE is_self = 0").toArray(),
      extractQueue: state.storage.sql.exec("SELECT turn_id FROM extract_queue").toArray(),
    }));
    expect(rows.inbound).toEqual([{ kind: "schedule", status: "done", when_busy: "followUp", user_id: "10000001" }]);
    expect(rows.inputs).toEqual([]);
    expect(rows.extractQueue).toEqual([]);
    expect(await runDurableObjectAlarm(directory())).toBe(false);
  });

  it("records silent when nothing is sent and advances a recurring task from now", async () => {
    const created = await directory().create({ name: "安静检查", prompt: "有新内容才通知", conversation: "owner", rule: daily }, "qq:10000001");
    await makeDue(created.id, Date.now() - 1000);
    await runDurableObjectAlarm(directory());
    await expect.poll(() => runStatus(created.id), { timeout: 10_000 }).toBe("silent");
    const schedule = await find(created.id);
    expect(schedule).toMatchObject({ status: "active", runs: [{ status: "silent", sent: 0 }] });
    expect(schedule.next_fire_at).toBeGreaterThan(Date.now());
    expect(formatBeijingTime(schedule.next_fire_at!)).toMatch(/ 08:00$/);
  });

  it("skips late fires as stale with the merged missed count, without starting a turn", async () => {
    const rule: ScheduleRule = { ...daily, dtstart: Date.now() - 5 * 86400_000 };
    const created = await directory().create({ name: "停机期间", prompt: "不该运行", conversation: "owner", rule }, "qq:10000001");
    const fireAt = nextFireAt(rule, Date.now() - 3 * 86400_000)!;
    await makeDue(created.id, fireAt);
    await runDurableObjectAlarm(directory());
    expect(await find(created.id)).toMatchObject({ status: "active", runs: [{ status: "skipped", reason: "stale", skipped_count: 3, fire_at: fireAt }] });
    expect((await find(created.id)).next_fire_at).toBeGreaterThan(Date.now());
    expect((await env.THREAD.getByName("owner").stats()).inbound).toEqual({ queued: 0, done: 0, failed: 0 });
  });

  it("skips run-now as overlap while the previous run is still in its turn, then runs again once it ends", async () => {
    const { socket, frames } = await connect(sockets);
    const created = await directory().create({ name: "长任务", prompt: "慢慢来", conversation: "owner", rule: daily }, "qq:10000001");
    await makeDue(created.id, Date.now() - 1000);
    await runDurableObjectAlarm(directory());
    const first = await action(frames, 0, "send_private_msg");
    expect(await directory().runNow(created.id, "qq:10000001")).toMatchObject({ status: "skipped", reason: "overlap" });
    reply(socket, first.echo);
    await expect.poll(() => runStatus(created.id), { timeout: 10_000 }).toBe("sent");
    const next = (await find(created.id)).next_fire_at;
    const run = await directory().runNow(created.id, "qq:10000001");
    expect(run.status).toBe("queued");
    reply(socket, (await action(frames, 1, "send_private_msg")).echo, 90000002);
    await expect.poll(async () => (await find(created.id)).runs.find(item => item.fire_key === run.fire_key)?.status, { timeout: 10_000 }).toBe("sent");
    expect((await find(created.id)).next_fire_at).toBe(next);
  });

  it("pauses after three consecutive failures and alerts the owner once", async () => {
    const { socket, frames } = await connect(sockets);
    const created = await directory().create({ name: "总失败", prompt: "x", conversation: "owner", rule: daily }, "qq:10000001");
    const failed = (fireAt: number) => ({ fire_key: `${created.id}@${fireAt}`, fire_at: fireAt, status: "failed" as const, reason: "backend_failed" as const, ended_at: Date.now() });
    await directory().recordRun(created.id, failed(1));
    await directory().recordRun(created.id, failed(2));
    await directory().recordRun(created.id, failed(2));
    expect((await find(created.id)).failures).toBe(2);
    const third = directory().recordRun(created.id, failed(3));
    const alert = await action(frames, 0, "send_private_msg");
    expect(alert.params.user_id).toBe("10000001");
    expect(alert.params.message?.[0]?.data.text).toContain("「总失败」连续 3 次运行失败");
    reply(socket, alert.echo);
    await third;
    await directory().recordRun(created.id, failed(4));
    expect(await find(created.id)).toMatchObject({ status: "paused", pause_reason: "failures", next_fire_at: null });
    expect(frames.filter(frame => JSON.stringify(frame).includes("send_private_msg"))).toHaveLength(1);
  });
});

describe("schedule chat tools", () => {
  it("lets the owner create, list and pause tasks of the owner thread and shows them in the schedule section", async () => {
    const seen = script([
      { name: "schedule", args: { action: "create", name: "晨报", prompt: "整理今天的安排", rule: { rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0" } } },
      { name: "schedule", args: { action: "list" } },
      { name: "schedule", args: { action: "create", name: "缺字段" } },
      outputs => ({ name: "schedule", args: { action: "pause", id: idOf(outputs[0]) } }),
    ]);
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      expect(await thread.submit(input(1, "每天八点给我晨报", 10000001))).toEqual({ status: "done" });
    });
    const [schedule] = await directory().list("owner");
    expect(seen.outputs[0]).toMatch(/· 晨报 · 状态：启用（active）· 下次：\d{4}-\d{2}-\d{2} 08:00（北京时间）$/);
    expect(seen.outputs[1]).toContain(idOf(seen.outputs[0]));
    expect(seen.outputs[2]).toBe("create 需要字段：prompt、rule");
    expect(seen.outputs[3]).toContain("暂停（paused）");
    expect(schedule).toMatchObject({ id: idOf(seen.outputs[0]), name: "晨报", conversation: "owner", created_by: "qq:10000001", status: "paused" });
    expect(seen.offers.flat()).toEqual(expect.arrayContaining(["schedule", "schedule_control"]));
    expect(seen.sections.some(text => text.includes("晨报"))).toBe(true);
  });

  it("offers no schedule tools in a non-owner private thread", async () => {
    const seen = script([]);
    await runInDurableObject(env.THREAD.getByName("private:10000003"), async (_instance, state) => {
      const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      await thread.submit(input(1, "帮我定个闹钟", 10000003));
    });
    expect(seen.offers.flat()).not.toContain("schedule");
    expect(seen.offers.flat()).not.toContain("schedule_control");
  });

  it("binds group tasks to the group thread and refuses group members", async () => {
    const seen = script([
      { name: "schedule", args: { action: "create", name: "群提醒", prompt: "提醒大家开会", rule: { at: formatBeijingTime(Date.now() + 86400_000) } } },
      "done",
      { name: "schedule", args: { action: "list" } },
    ]);
    await runInDurableObject(env.THREAD.getByName("group:200000001"), async (_instance, state) => {
      const thread = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      await thread.submit(input(1, "明天提醒大家开会", 10000001, 200000001, true));
      await thread.submit(input(2, "列出定时任务", 10000004, 200000001, true));
    });
    expect(await directory().list("group:200000001")).toMatchObject([{ name: "群提醒", conversation: "group:200000001", created_by: "qq:10000001" }]);
    expect(await directory().list("owner")).toEqual([]);
    expect(seen.outputs[1]).toContain("没有有效的定时管理授权");
  });
});

describe("admin schedule endpoints", () => {
  const admin = { ...env, ADMIN_TOKEN: "synthetic-admin" };
  const call = (path: string, method = "POST", token = "synthetic-admin") =>
    worker.fetch(new Request(`https://test${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }), admin);

  it("requires the admin bearer, then lists, pauses, resumes, runs now and deletes", async () => {
    const created = await directory().create({ name: "面板任务", prompt: "检查", conversation: "owner", rule: daily }, "qq:10000001");
    expect((await call("/admin/schedules", "GET", "")).status).toBe(401);
    expect((await call("/admin/schedules", "GET", "t")).status).toBe(401);
    expect((await worker.fetch(new Request("https://test/admin/schedules"), { ...env, ADMIN_TOKEN: undefined })).status).toBe(401);
    expect(await (await call("/admin/schedules", "GET")).json()).toMatchObject([{ id: created.id, name: "面板任务" }]);
    expect(await (await call(`/admin/schedules/${created.id}/pause`)).json()).toMatchObject({ status: "paused", pause_reason: "manual", next_fire_at: null });
    expect(await (await call(`/admin/schedules/${created.id}/resume`)).json()).toMatchObject({ status: "active", failures: 0 });
    expect(await (await call(`/admin/schedules/${created.id}/run-now`)).json()).toMatchObject({ status: "queued" });
    await expect.poll(() => runStatus(created.id), { timeout: 10_000 }).toBe("silent");
    const health = await (await call("/admin/health", "GET")).json();
    expect(health).toMatchObject({ schedule: { active: 1, paused: 0, nextFireAt: (await find(created.id)).next_fire_at } });
    expect((await call("/admin/schedules/00000000-0000-4000-8000-000000000000/pause")).status).toBe(404);
    expect(await (await call(`/admin/schedules/${created.id}/delete`)).json()).toEqual({ deleted: created.id });
    expect(await directory().list()).toEqual([]);
  });
});
