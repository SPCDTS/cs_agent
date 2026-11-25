import { createExecutionContext, createScheduledController, env, reset, runInDurableObject, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import worker from "../src/index";
import { threadWithBindings } from "./thread-fixture";
import { recall } from "../src/context";
import { MAINTENANCE_CRON, type MaintenanceJob } from "../src/maintenance";
import { formatBeijingTime } from "../src/memory/time";
import { memoryHash } from "../src/memory/store";
import type { MemoryKind } from "../src/memory/types";
import { nextFireAt, parseBeijingTime as bj, validateRule } from "../src/schedule/model";
import type { ScheduleRule } from "../src/schedule/types";
import * as models from "../src/models";
import { ThreadDO } from "../src/thread";
import { SandboxDO } from "../src/sandbox/do";
import { action, connect, input, reply } from "./helpers";

describe("schedule suite", () => {
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
      await env.THREAD.getByName("owner").syncAdminView("owner");
      expect((await env.REQUESTS.getByName("view:thread:owner").stats()).inbound).toEqual({ queued: 0, done: 0, failed: 0 });
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
});

describe("maintenance suite", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  
  const DAY = 86400;
  const bj = (date: string, time = "10:00") => Date.parse(`${date}T${time}:00+08:00`);
  const GROUP = "group:200000001";
  
  /** 按提示词分辨三种调用：冲突判定按送审对数全判 a_supersedes_b，周摘要与日摘要返回固定文本。 */
  function fauxModel() {
    const prompts: string[] = [];
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      const user = transcript.messages.findLast(message => message.role === "user");
      const prompt = typeof user?.content === "string" ? user.content : "";
      prompts.push(prompt);
      if (prompt.includes("<数据>")) {
        const pairs = prompt.match(/"pair":\d/g)?.length ?? 0;
        return fauxAssistantMessage(JSON.stringify(Array.from({ length: pairs }, (_, i) => ({ pair: i + 1, verdict: "a_supersedes_b" }))));
      }
      return fauxAssistantMessage(prompt.includes("一周内每天的摘要") ? "本周围绕烟雾弹训练做了安排。" : "成员讨论了烟雾弹训练。");
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(() => {
      const registry = createModels(); registry.setProvider(faux.provider);
      return registry;
    });
    return prompts;
  }
  
  async function withThread<T>(name: string, vars: Record<string, string>, fn: (thread: ThreadDO, db: DurableObjectSqliteDatabase) => Promise<T>) {
    return runInDurableObject(env.THREAD.getByName(name), async (_instance, state) => {
      const thread = new ThreadDO(state, { ...env, ...vars });
      await thread.syncAdminView(name);
      return fn(thread, new DurableObjectSqliteDatabase(state.storage));
    });
  }
  async function chat(db: DurableObjectSqliteDatabase, date: string, count: number, scope = GROUP) {
    for (let i = 0; i < count; i++) {
      await db.run("INSERT INTO messages (scope, message_id, time, user_id, nickname, text) VALUES (?, ?, ?, '10000004', '成员', ?)",
        scope, `${date}-${i}`, bj(date) / 1000 + i * 60, `第 ${i} 条闲聊`);
    }
  }
  const run = (thread: ThreadDO, kind: MaintenanceJob["kind"], now: number) => thread.maintain({ kind, now });
  const count = async (db: DurableObjectSqliteDatabase, sql: string, ...args: (string | number)[]) => (await db.get<{ n: number }>(sql, ...args))?.n;
  
  it("retention维护显式登记的Cloudflare工作区并保存登记分页游标", async () => {
    const names = Array.from({ length: 6 }, (_, index) => "resource:registered-" + index);
    await runInDurableObject(env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner"), async (_instance, state) => {
      for (const [index, name] of names.entries()) {
        const id = "sbx:" + String(index).padStart(64, "0");
        await state.storage.put("resource:" + id, { kind: "ready", resource: { id, owner: GROUP, kind: "cloudflare", providerId: "cloudflare", name, createdAt: 0 } });
      }
    });
    const collected: string[] = [];
    vi.spyOn(SandboxDO.prototype, "gc").mockImplementation(async function(this: SandboxDO) {
      collected.push((await this.files()).workspace);
      return { phase: "done", startedAt: 0, scanned: 0, stepScanned: 0, candidates: 0, deleted: 0, dryRun: false };
    });
    await withThread(GROUP, {}, async thread => {
      await run(thread, "retention", Date.now());
      await run(thread, "retention", Date.now() + 86400_000);
    });
    expect(collected).toEqual(expect.arrayContaining(names.map(name => "workspace:" + env.SANDBOX.idFromName(name).toString())));
    expect(collected).toHaveLength(8); // 每轮默认工作区一次，登记工作区按5+1推进。
  });
  
  describe("chat history aging", () => {
    it("summarizes days with five or more messages once, then folds a finished week and recalls summaries", async () => {
      const prompts = fauxModel();
      await withThread(GROUP, {}, async (thread, db) => {
        await chat(db, "2026-10-20", 6);
        await chat(db, "2026-10-21", 5);
        await chat(db, "2026-10-22", 3);
        const saturday = bj("2026-10-24", "03:30");
        expect(await run(thread, "aging", saturday)).toMatchObject({ status: "ok", day: 2, week: 0, failed: 0 });
        expect(await run(thread, "aging", saturday)).toEqual({ kind: "aging", status: "skipped" });
        expect(await run(thread, "aging", bj("2026-10-25", "03:30"))).toMatchObject({ status: "ok", day: 0, week: 0 });
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain("日期：2026-10-20");
        expect(prompts[0]).toContain("第 5 条闲聊");
  
        const monday = bj("2026-10-26", "03:30");
        expect(await run(thread, "aging", monday)).toMatchObject({ day: 0, week: 1 });
        expect(prompts).toHaveLength(3);
        expect(await db.all("SELECT kind, period_start, msg_count FROM summaries")).toEqual([{ kind: "week", period_start: bj("2026-10-19", "00:00") / 1000, msg_count: 11 }]);
        await thread.syncAdminView(GROUP);
        expect((await env.REQUESTS.getByName("view:thread:" + GROUP).stats()).maintenance).toEqual({ agingLastRun: monday, consolidateLastRun: null, summaries: { day: 0, week: 1 } });
  
        expect(await recall(db, GROUP, { query: "烟雾弹训练" })).toBe("[周摘要 10-19~10-25] 本周围绕烟雾弹训练做了安排。");
        expect(await recall(db, GROUP, { query: "训练" })).toContain("[周摘要 10-19~10-25]");
        expect(await recall(db, "group:200000002", { query: "烟雾弹训练" })).toContain("未找到");
      });
    });
  
    it("purges covered raw messages after the retention days, keeps uncovered ones until the hard cap, and honors zero", async () => {
      fauxModel();
      const seed = async (db: DurableObjectSqliteDatabase) => {
        await chat(db, "2026-07-01", 3);
        await chat(db, "2026-10-20", 6);
        await chat(db, "2026-10-21", 5);
        // 周摘要覆盖整周，未摘要的少量消息只有落在没有摘要的周里才算“未覆盖”。
        await chat(db, "2026-10-28", 3);
        await db.run("INSERT INTO summaries (scope, kind, period_start, period_end, text, created_at) VALUES (?, 'week', ?, ?, '去年的周摘要', 0)",
          GROUP, bj("2025-09-01", "00:00") / 1000, bj("2025-09-08", "00:00") / 1000);
      };
      const remaining = (db: DurableObjectSqliteDatabase) => db.all<{ day: string }>(
        "SELECT DISTINCT substr(message_id, 1, 10) AS day FROM messages ORDER BY day");
      await withThread(GROUP, {}, async (thread, db) => {
        await seed(db);
        await run(thread, "aging", bj("2026-10-24", "03:30"));
        expect(await remaining(db)).toEqual([{ day: "2026-10-20" }, { day: "2026-10-21" }, { day: "2026-10-28" }]);
        expect(await run(thread, "aging", bj("2026-12-01", "03:30"))).toMatchObject({ week: 1, purgedMessages: 11 });
        expect(await remaining(db)).toEqual([{ day: "2026-10-28" }]);
        expect(await db.all("SELECT text FROM summaries")).toEqual([{ text: "本周围绕烟雾弹训练做了安排。" }]);
      });
      const registry = env.REGISTRY.getByName("main"), settings = await registry.opsSettings();
      await registry.putOpsSettings({ ...settings.value, threads: { "group:200000002": { rawDays: 0 } } }, settings.revision);
      await withThread("group:200000002", {}, async (thread, db) => {
        await seed(db);
        expect(await run(thread, "aging", bj("2026-12-01", "03:30"))).toMatchObject({ day: 2, purgedMessages: 0 });
        expect(await count(db, "SELECT COUNT(*) AS n FROM messages")).toBe(17);
      });
    });
  });
  
  describe("memory consolidation", () => {
    it("dedups, supersedes extractor-written conflicts, protects explicit writes, orphans and retires with versions and an event", async () => {
      const prompts = fauxModel();
      const owner = env.THREAD.getByName("owner");
      await owner.ingest(input(1, "还在的来源消息", 10000001));
      const now = Date.now(), sec = Math.floor(now / 1000);
      type Seed = { id: number; kind?: MemoryKind; subject?: string; text: string; author?: string; source_scope?: string; source_message_id?: string; created_at?: number; updated_at?: number; last_recalled_at?: number };
      const seeds: Seed[] = [
        { id: 1, text: "早上喝咖啡" }, { id: 2, text: "早上喝咖啡。", created_at: sec - 5 * DAY },
        { id: 3, kind: "preference", subject: "咖啡", text: "每天早上喜欢喝美式咖啡", author: "qq:10000001" },
        { id: 4, kind: "preference", subject: "咖啡", text: "每天早上喜欢喝拿铁咖啡" },
        { id: 5, kind: "rule", subject: "训练", text: "每周三晚上练习烟雾弹投掷" },
        { id: 6, kind: "rule", subject: "训练", text: "每周三晚上练习闪光弹投掷", author: "qq:10000001" },
        { id: 7, text: "来源已撤回", source_scope: "private:10000001", source_message_id: "404", created_at: sec - DAY },
        { id: 8, text: "来源还在", source_scope: "private:10000001", source_message_id: "1", created_at: sec - DAY },
        { id: 9, kind: "episode", text: "很久以前的比赛", created_at: sec - 200 * DAY },
        { id: 10, kind: "episode", text: "最近还被想起的比赛", created_at: sec - 200 * DAY, last_recalled_at: sec - 10 * DAY },
      ];
      await owner.syncAdminView("owner");
      await withThread("owner", {}, async (thread, db) => {
        for (const s of seeds) {
          const kind = s.kind ?? "fact", created = s.created_at ?? sec - 10 * DAY, updated = s.updated_at ?? sec - 10 * DAY;
          await db.run(`INSERT INTO memories(id,ns,kind,subject,text,status,author,source_scope,source_message_id,confidence,created_at,updated_at,last_recalled_at,recall_count,hash)
            VALUES (?,'owner',?,?,?,'active',?,?,?,1,?,?,?,0,?)`,
            s.id, kind, s.subject ?? null, s.text, s.author ?? "extractor", s.source_scope ?? null, s.source_message_id ?? null, created, updated, s.last_recalled_at ?? null, memoryHash("owner", kind, s.text));
        }
        expect(await run(thread, "consolidate", now)).toMatchObject({ status: "ok", dedup: 1, orphaned: 1, retired: 1,
          conflicts: { pairs: 2, superseded: 1, protected: 1 } });
        expect(prompts).toHaveLength(1);
        const status = Object.fromEntries((await db.all<{ id: number; status: string }>("SELECT id, status FROM memories ORDER BY id")).map(r => [r.id, r.status]));
        expect(status).toEqual({ 1: "active", 2: "superseded", 3: "active", 4: "superseded", 5: "active", 6: "active", 7: "orphaned", 8: "active", 9: "retired", 10: "active" });
        expect(await db.all("SELECT from_id, to_id FROM memory_links WHERE rel = 'supersedes' ORDER BY to_id")).toEqual([{ from_id: 1, to_id: 2 }, { from_id: 3, to_id: 4 }]);
        const versions = await db.all<{ memory_id: number; by: string; reason: string }>("SELECT memory_id, by, reason FROM memory_versions WHERE by LIKE 'consolidate:%' ORDER BY memory_id");
        expect(versions.map(v => [v.memory_id, v.reason])).toEqual([[2, "consolidate_duplicate"], [4, "consolidate_conflict"], [7, "consolidate_orphan"], [9, "consolidate_retire"]]);
        expect(new Set(versions.map(v => v.by)).size).toBe(1);
  
        expect(await run(thread, "consolidate", now)).toMatchObject({ dedup: 0, conflicts: { pairs: 0 } });
        expect(prompts).toHaveLength(1);
        const events = await db.all<{ detail: string }>("SELECT detail FROM events WHERE kind = 'memory_consolidate'");
        expect(events).toHaveLength(2);
        expect(JSON.parse(events[0]!.detail)).toMatchObject({ batchId: versions[0]!.by.slice(12), dedup: 1, retired: 1, tokens: expect.any(Object), ms: expect.any(Number) });
        expect(events.map(e => e.detail).join()).not.toMatch(/咖啡|比赛|撤回/);
        await thread.syncAdminView("owner");
        expect((await env.REQUESTS.getByName("view:thread:owner").stats()).maintenance.consolidateLastRun).toBe(now);
      });
    });
  
    it("skips threads without memories", async () => {
      await withThread(GROUP, {}, async thread => {
        expect(await run(thread, "consolidate", Date.now())).toEqual({ kind: "consolidate", status: "skipped" });
      });
    });
  });
  
  describe("audit retention", () => {
    it("deletes expired events, settled inbound, outbox and stale extraction queue rows", async () => {
      const now = Date.now(), old = now - 31 * DAY * 1000, recent = now - DAY * 1000;
      await withThread("owner", {}, async (thread, db) => {
        for (const at of [old, recent]) await db.run("INSERT INTO events (at, kind, detail) VALUES (?, 'memory_extract', '{}')", at);
        for (const [id, status, at] of [["a", "done", old], ["b", "failed", old], ["c", "queued", old], ["d", "done", recent]] as const) {
          await db.run("INSERT INTO inbound (message_id, user_id, text, received_at, status) VALUES (?, '10000001', '', ?, ?)", id, Math.floor(at / 1000), status);
        }
        for (const at of [old, recent]) await db.run("INSERT INTO outbox (message_id, text, sent_at) VALUES ('m', '', ?)", at);
        for (const [turn, at] of [["stale", now - 8 * DAY * 1000], ["fresh", recent]] as const) await db.run("INSERT INTO extract_queue VALUES (?, ?)", turn, at);
        expect(await run(thread, "retention", now)).toEqual({ kind: "retention", events: 1, inbound: 2, outbox: 1, extractQueue: 1, subagents: 0 });
        expect(await db.all("SELECT at FROM events")).toEqual([{ at: recent }]);
        expect(await db.all("SELECT message_id FROM inbound ORDER BY message_id")).toEqual([{ message_id: "c" }, { message_id: "d" }]);
        expect(await db.all("SELECT turn_id FROM extract_queue")).toEqual([{ turn_id: "fresh" }]);
      });
    });
  });
  
  describe("scheduled maintenance", () => {
    it("runs every registered thread serially and keeps going after one RPC throws", async () => {
      await runInDurableObject(env.BRIDGE.getByName("napcat"), (_instance, state) => {
        for (const key of [GROUP, "group:200000002"]) state.storage.sql.exec("INSERT INTO threads (key, seen_at) VALUES (?, 0)", key);
      });
      const maintain = vi.spyOn(ThreadDO.prototype, "maintain").mockImplementationOnce(async () => { throw new Error("synthetic"); });
      const now = bj("2026-10-24", "03:30"), ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron: MAINTENANCE_CRON, scheduledTime: now }), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(maintain.mock.calls.map(([job]) => job)).toEqual(["aging", "consolidate", "retention", "aging", "consolidate", "retention"].map(kind => ({ kind, now })));
      await env.THREAD.getByName(GROUP).syncAdminView(GROUP);
      await env.THREAD.getByName("group:200000002").syncAdminView("group:200000002");
      expect((await env.REQUESTS.getByName("view:thread:" + GROUP).stats()).maintenance.agingLastRun).toBeNull();
      expect((await env.REQUESTS.getByName("view:thread:group:200000002").stats()).maintenance.agingLastRun).toBe(now);
    });
  });
});
