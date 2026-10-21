import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ContextStore } from "../../src/context/store.js";
import { ObsStore } from "../../src/obs/store.js";
import { createDashboard } from "../../src/obs/http.js";
import { csrfToken } from "../../src/obs/http-util.js";
import { draftFromForm, ruleFromDraft } from "../../src/obs/schedule-panel.js";
import { describeRule, draftOf, emptyDraft, sameRule, scheduleDetailBody, schedulesListBody, simpleRule } from "../../src/obs/ui/schedule-pages.js";
import type { Schedule } from "../../src/obs/ui/schedule-pages.js";
import { rig as scheduleRig } from "../agent/schedule-fixture.js";

const clean: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const TOKEN = "schedule-panel-test-token";
const BJ = 8 * 3600_000;
/** 北京时间 → 毫秒 */
const bj = (y: number, m: number, d: number, h: number, mi: number) => Date.UTC(y, m - 1, d, h, mi) - BJ;
const NOW = bj(2026, 10, 20, 12, 0);

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1", revision: 3, name: "早报", prompt: "整理新闻发给我", conversation: "group:123",
    rule: { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30", dtstart: NOW }, status: "active",
    options: { stale_after_ms: 600_000, timeout_ms: 300_000 }, created_by: "qq:1", created_at: NOW, updated_at: NOW,
    next_fire_at: bj(2026, 10, 21, 8, 30), failures: 0, runs: [], ...overrides,
  };
}

describe("规则人话描述与表单换算", () => {
  it("describeRule 覆盖每天、每周、工作日、一次性、间隔与原文回退", () => {
    const r = (rrule: string) => describeRule({ kind: "rrule", rrule, dtstart: NOW }, NOW);
    expect(r("FREQ=DAILY;BYHOUR=8;BYMINUTE=30")).toBe("每天 08:30");
    expect(r("FREQ=WEEKLY;BYDAY=WE,MO;BYHOUR=9;BYMINUTE=0")).toBe("每周一、三 09:00");
    expect(r("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=5")).toBe("工作日 18:05");
    expect(r("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=7;BYMINUTE=0")).toBe("每天 07:00");
    expect(r("FREQ=MINUTELY;INTERVAL=30")).toBe("每 30 分钟");
    expect(r("FREQ=HOURLY")).toBe("每小时");
    expect(r("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0")).toBe("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0");
    expect(r("FREQ=WEEKLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0")).toBe("FREQ=WEEKLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0");
    expect(r("FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0")).toBe("FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0");
    expect(describeRule({ kind: "at", at: bj(2026, 10, 21, 14, 0) }, NOW)).toBe("一次 10-21 14:00");
    expect(describeRule({ kind: "at", at: bj(2027, 1, 2, 3, 4) }, NOW)).toBe("一次 2027-01-02 03:04");
    expect(simpleRule("FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0")).toBeNull();
  });

  it("表单按北京时间换算为一次性时刻与 DAILY / WEEKLY RRULE，起点取整分钟", () => {
    const form = (fields: Record<string, string | string[]>) => {
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
      return draftFromForm(f);
    };
    const now = NOW + 12_345;
    expect(ruleFromDraft(form({ type: "once", date: "2026-10-21", time: "14:00" }), now)).toEqual({ kind: "at", at: bj(2026, 10, 21, 14, 0) });
    expect(ruleFromDraft(form({ type: "repeat", time: "08:30" }), now)).toEqual({ kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30", dtstart: NOW });
    expect(ruleFromDraft(form({ type: "repeat", time: "09:05", days: ["WE", "MO", "XX"] }), now))
      .toEqual({ kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=5", dtstart: NOW });
    expect(ruleFromDraft(form({ type: "rrule", rrule: " RRULE:FREQ=MONTHLY;BYMONTHDAY=1 " }), now))
      .toEqual({ kind: "rrule", rrule: "FREQ=MONTHLY;BYMONTHDAY=1", dtstart: NOW });
    expect(() => ruleFromDraft(form({ type: "once", date: "2026-02-30", time: "10:00" }), now)).toThrow("日期");
    expect(() => ruleFromDraft(form({ type: "repeat", time: "25:00" }), now)).toThrow("时刻");
    const s = schedule({ rule: { kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=5", dtstart: 0 } });
    expect(draftOf(s)).toMatchObject({ type: "repeat", time: "09:05", days: ["MO", "WE"], timeout: "300" });
    expect(sameRule(form({ type: "repeat", time: "09:05", days: ["MO", "WE"] }), draftOf(s))).toBe(true);
    expect(sameRule(form({ type: "repeat", time: "09:05", days: ["MO"] }), draftOf(s))).toBe(false);
    expect(draftOf(schedule({ rule: { kind: "at", at: bj(2026, 10, 21, 14, 0) } }))).toMatchObject({ type: "once", date: "2026-10-21", time: "14:00" });
  });
});

describe("页面渲染", () => {
  const view = { conversations: ["owner", "group:123"], names: { "group:123": "家庭群" }, csrf: "tok", now: NOW };

  it("空列表显示空状态、计数与新建表单", () => {
    const html = schedulesListBody({ ...view, schedules: [] }, emptyDraft(NOW));
    expect(html).toContain("还没有定时任务");
    expect(html).toContain('action="/schedules"');
    expect(html).toContain('<option value="group:123">家庭群（group:123）</option>');
    expect(html).toContain('name="_csrf" value="tok"');
  });

  it("列表显示群名、人话规则、北京时间、状态与暂停原因、最近运行和操作", () => {
    const html = schedulesListBody({ ...view, schedules: [
      schedule(),
      schedule({ id: "s2", name: "周报", conversation: "private:9", status: "paused", pause_reason: "连续 3 次失败", next_fire_at: null, failures: 3,
        rule: { kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0", dtstart: NOW },
        runs: [{ fire_key: "s2@1", fire_at: bj(2026, 10, 19, 9, 0), status: "failed", reason: "timeout" }] }),
      schedule({ id: "s3", name: "提醒", conversation: "owner", status: "completed", next_fire_at: null, rule: { kind: "at", at: bj(2026, 10, 20, 10, 0) } }),
    ] });
    expect(html).toMatch(/运行中<\/div><div class="figure s-ok">1/);
    expect(html).toContain("家庭群");
    expect(html).toContain("每天 08:30");
    expect(html).toContain("10-21 08:30");
    expect(html).toContain("每周一、三 09:00");
    expect(html).toContain("连续 3 次失败");
    expect(html).toContain("私聊 9");
    expect(html).toContain("owner 私聊");
    expect(html).toContain("一次 10-20 10:00");
    expect(html).toContain('action="/schedules/s1/pause"');
    expect(html).toContain('action="/schedules/s2/resume"');
    expect(html).not.toContain('action="/schedules/s3/resume"');
    expect(html).toContain('action="/schedules/s1/run"');
    expect(html).toContain('<details class="gate"><summary>删除</summary>');
    expect(html).toContain('href="/schedules/s1"');
    expect(html).not.toContain("confirm(");
  });

  it("详情页显示完整提示词、规则、创建者、超时与倒序运行记录，并预填编辑表单", () => {
    const html = scheduleDetailBody(schedule({ runs: [
      { fire_key: "s1@1", fire_at: bj(2026, 10, 18, 8, 30), status: "sent", sent: 2, note: "第一次记录", started_at: 1, ended_at: 4_001, ticket: "run_abc" },
      { fire_key: "s1@2", fire_at: bj(2026, 10, 19, 8, 30), status: "skipped", reason: "stale", skipped_count: 3 },
    ] }), { names: view.names, csrf: "tok", now: NOW });
    expect(html).toContain("整理新闻发给我");
    expect(html).toContain("FREQ=DAILY;BYHOUR=8;BYMINUTE=30");
    expect(html).toContain("qq:1");
    expect(html).toContain("<dt>超时</dt><dd>5 分 0 秒");
    expect(html).toContain("4.0 秒");
    expect(html.indexOf("2026-10-19 08:30")).toBeLessThan(html.indexOf("2026-10-18 08:30"));
    expect(html).toContain("迟到或停机（合并 3 次）");
    expect(html).toContain("第一次记录");
    expect(html).toContain('href="/tickets/run_abc"');
    expect(html).toContain('action="/schedules/s1/update"');
    expect(html).toMatch(/name="time" value="08:30"/);
    expect(html).toMatch(/value="repeat" checked/);
  });
});

async function rig(owner = "1") {
  const schedule = await scheduleRig(); clean.push(() => schedule.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-schedule-panel-"));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  context.ingest({ message_id: "m1", message_type: "group", group_id: "123", group_name: "家庭群", user_id: "5", self_id: "2", nickname: "甲",
    time: Math.floor(Date.now() / 1000), text: "你好", route_text: "你好", truncated: false, mentioned_self: false, images: [], segments: [] } as never);
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN, QQ_OWNER: owner });
  const dashboard = createDashboard({ config, store, context, health: () => ({}), queue: () => ({}),
    codex: async () => ({}), pi: async () => ({}), schedules: schedule.service });
  const server: Server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => {
    await dashboard.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); context.close(); rmSync(dir, { recursive: true, force: true });
  });
  const csrf = csrfToken(TOKEN);
  const get = (route: string) => fetch(base + route, { headers: { Cookie: `obs_token=${TOKEN}` }, redirect: "manual" });
  const post = (route: string, fields: Record<string, string | string[]>, headers: Record<string, string> = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries({ _csrf: csrf, ...fields })) for (const x of [v].flat()) body.append(k, x);
    return fetch(base + route, { method: "POST", redirect: "manual", body, headers: {
      Cookie: `obs_token=${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded", Origin: base, ...headers } });
  };
  return { ...schedule, service: schedule.service, get, post };
}

const tomorrow = () => new Date(Date.now() + 86400_000 + BJ).toISOString().slice(0, 10);

describe("面板路由", () => {
  it("导航含定时任务；空列表；会话下拉显示已知群名", async () => {
    const r = await rig();
    const res = await r.get("/schedules");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/schedules" aria-current="page">定时任务</a>');
    expect(html).toContain("还没有定时任务");
    expect(html).toContain("家庭群（group:123）");
    expect((await r.get("/schedules/new")).status).toBe(200);
    expect((await r.get("/schedules/nope")).status).toBe(404);
  });

  it("表单创建、编辑、暂停、恢复、立即运行、删除", async () => {
    const r = await rig();
    const created = await r.post("/schedules", { name: "早报", prompt: "整理新闻", conversation: "group:123", type: "repeat", time: "08:30", days: ["MO", "WE"], timeout: "120" });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/schedules?ok=created");
    const [s] = await r.service.list();
    expect(s).toMatchObject({ name: "早报", conversation: "group:123", created_by: "qq:1", options: { timeout_ms: 120_000 },
      rule: { kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=30" } });
    const list = await (await r.get("/schedules?ok=created")).text();
    expect(list).toContain("定时任务已创建");
    expect(list).toContain("每周一、三 08:30");
    expect(list).toContain("家庭群");

    const detail = await r.get(`/schedules/${s!.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("整理新闻");

    const edited = await r.post(`/schedules/${s!.id}/update`, { name: "晨报", prompt: "整理要闻", type: "repeat", time: "08:30", days: ["MO", "WE"], timeout: "120" });
    expect(edited.status).toBe(303);
    expect(edited.headers.get("location")).toBe(`/schedules/${s!.id}?ok=saved`);
    const after = (await r.service.get(s!.id))!;
    expect(after).toMatchObject({ name: "晨报", prompt: "整理要闻", rule: s!.rule, conversation: "group:123" });

    expect((await r.post(`/schedules/${s!.id}/update`, { name: "晨报", prompt: "整理要闻", type: "once", date: tomorrow(), time: "07:00" })).status).toBe(303);
    expect((await r.service.get(s!.id))!.rule.kind).toBe("at");

    const paused = await r.post(`/schedules/${s!.id}/pause`, { back: "detail" });
    expect(paused.headers.get("location")).toBe(`/schedules/${s!.id}?ok=paused`);
    expect((await r.service.get(s!.id))!.status).toBe("paused");
    expect((await r.post(`/schedules/${s!.id}/resume`, { back: "list" })).headers.get("location")).toBe("/schedules?ok=resumed");
    expect((await r.service.get(s!.id))!.status).toBe("active");
    expect((await r.post(`/schedules/${s!.id}/run`, {})).status).toBe(303);
    expect(r.admitter.calls).toHaveLength(1);
    const withRun = await (await r.get(`/schedules/${s!.id}`)).text();
    expect(withRun).toContain("排队");
    const deleted = await r.post(`/schedules/${s!.id}/delete`, { back: "detail" });
    expect(deleted.headers.get("location")).toBe("/schedules?ok=deleted");
    expect(await r.service.list()).toEqual([]);
  });

  it("CSRF 与同源校验失败时不写入", async () => {
    const r = await rig();
    const fields = { name: "x", prompt: "y", conversation: "owner", type: "repeat", time: "08:00" };
    expect((await r.post("/schedules", { ...fields, _csrf: "bad" })).status).toBe(403);
    expect((await r.post("/schedules", fields, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await r.post("/schedules", fields, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(await r.service.list()).toEqual([]);
    const s = await r.service.create("qq:1", { name: "a", prompt: "b", conversation: "owner", rule: { kind: "at", at: Date.now() + 3600_000 } });
    for (const action of ["pause", "run", "delete"]) expect((await r.post(`/schedules/${s.id}/${action}`, { _csrf: "" })).status).toBe(403);
    expect((await r.service.get(s.id))!.status).toBe("active");
    expect(r.admitter.calls).toHaveLength(0);
  });

  it("服务校验错误以 flash 显示并保留表单输入", async () => {
    const r = await rig();
    const past = await r.post("/schedules", { name: "过去的提醒", prompt: "保留这段提示词", conversation: "group:123", type: "once", date: "2020-01-01", time: "08:00" });
    expect(past.status).toBe(400);
    const html = await past.text();
    expect(html).toContain('class="flash err"');
    expect(html).toContain("规则必须包含未来的触发时刻");
    expect(html).toContain('value="过去的提醒"');
    expect(html).toContain("保留这段提示词");
    expect(html).toContain('<option value="group:123" selected>');
    expect(html).toMatch(/value="once" checked/);
    const bad = await r.post("/schedules", { name: "坏规则", prompt: "p", conversation: "owner", type: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=1" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain("触发间隔不得少于 5 分钟");
    expect(badHtml).toContain('value="FREQ=MINUTELY;INTERVAL=1"');
    expect((await r.post("/schedules", { name: "", prompt: "p", conversation: "owner", type: "repeat", time: "08:00" })).status).toBe(400);
    expect(await r.service.list()).toEqual([]);

    const s = await r.service.create("qq:1", { name: "a", prompt: "b", conversation: "owner", rule: { kind: "at", at: Date.now() + 3600_000 } });
    const editBad = await r.post(`/schedules/${s.id}/update`, { name: "改了名字", prompt: "b", type: "rrule", rrule: "NOPE" });
    expect(editBad.status).toBe(400);
    const editHtml = await editBad.text();
    expect(editHtml).toContain("RRULE");
    expect(editHtml).toContain('value="改了名字"');
    expect((await r.service.get(s.id))!.name).toBe("a");
    expect((await r.post("/schedules/missing/pause", {})).status).toBe(404);
  });

  it("未配置 owner 时页面只读提示，写操作 404", async () => {
    const r = await rig("");
    expect(await (await r.get("/schedules")).text()).toContain("定时任务管理未启用");
    expect((await r.post("/schedules", { name: "x" })).status).toBe(404);
  });
});
