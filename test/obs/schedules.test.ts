import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ContextStore } from "../../src/context/store.js";
import { ObsStore } from "../../src/obs/store.js";
import { createDashboard } from "../../src/obs/http.js";
import { startAlerts } from "../../src/obs/alerts.js";
import { Trace } from "../../src/shared/trace.js";
import { input, rig as scheduleRig } from "../agent/schedule-fixture.js";

const clean: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const TOKEN = "schedule-dashboard-test-token";

async function rig(enabled = true) {
  const schedule = await scheduleRig(); clean.push(() => schedule.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-schedules-api-"));
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN, QQ_OWNER: "1" });
  const dashboard = createDashboard({ config, store, context, health: () => ({}), queue: () => ({}),
    codex: async () => ({}), pi: async () => ({}), schedules: enabled ? schedule.service : undefined });
  const server: Server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => {
    await dashboard.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); context.close(); rmSync(dir, { recursive: true, force: true });
  });
  const get = (route = "/api/schedules", cookie = true) =>
    fetch(base + route, { headers: cookie ? { Cookie: `obs_token=${TOKEN}` } : {}, redirect: "manual" });
  const initial = await get();
  const csrf = initial.ok ? (await initial.json()).csrf as string : "";
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, { method: "POST", headers: {
      Cookie: `obs_token=${TOKEN}`, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base, ...headers,
    }, body: typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  const definition = () => input({ rule: { kind: "at", at: Date.now() + 3600_000 } });
  return { ...schedule, service: schedule.service, base, server, get, post, csrf, definition };
}

it("真实服务的 JSON 创建、列表、修改、暂停、恢复、立即运行、删除", async () => {
  const r = await rig();
  const created = await r.post("/api/schedules", r.definition());
  expect(created.status).toBe(201);
  expect(created.headers.get("content-type")).toContain("application/json");
  const { schedule } = await created.json();
  expect(schedule).toMatchObject({ name: "日报", created_by: "qq:1", revision: 1 });
  expect((await (await r.get()).json()).schedules).toHaveLength(1);
  const route = `/api/schedules/${schedule.id}`;
  const updated = await r.post(route + "/update", { name: "新名称" });
  expect((await updated.json()).schedule).toMatchObject({ name: "新名称", revision: 2 });
  expect((await (await r.post(route + "/pause", {})).json()).schedule.status).toBe("paused");
  const resumed = (await (await r.post(route + "/resume", {})).json()).schedule;
  expect(resumed.status).toBe("active");
  expect((await (await r.post(route + "/run", {})).json()).run.status).toBe("queued");
  expect((await r.service.get(schedule.id))?.next_fire_at).toBe(resumed.next_fire_at);
  expect(r.admitter.calls).toHaveLength(1);
  expect((await r.post(route + "/delete", {})).status).toBe(200);
  expect((await (await r.get()).json()).schedules).toEqual([]);
  expect((await r.post(route + "/pause", {})).status).toBe(404);
});

it("鉴权来自 cookie，URL 口令只能 GET 换 cookie；Host 防重绑定", async () => {
  const r = await rig();
  expect((await r.get("/api/schedules", false)).status).toBe(401);
  const login = await r.get(`/api/schedules?token=${TOKEN}`, false);
  expect(login.status).toBe(303);
  expect(login.headers.get("set-cookie")).toContain("HttpOnly");
  expect((await r.post(`/api/schedules?token=${TOKEN}`, r.definition(), { Cookie: "" })).status).toBe(401);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(r.base + "/api/schedules", { headers: { Host: "attacker.example", Cookie: `obs_token=${TOKEN}` } },
      res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  expect(status).toBe(403);
  expect(await r.service.list()).toEqual([]);
});

it("同源与 CSRF 同时校验；允许 same-origin 的 null Origin 与 JSON _csrf", async () => {
  const r = await rig();
  const rejectedHeaders: Record<string, string>[] = [
    { Origin: "https://attacker.example" },
    { "Sec-Fetch-Site": "cross-site" },
    { Origin: "null" },
    { "X-CSRF-Token": "" },
  ];
  for (const headers of rejectedHeaders) expect((await r.post("/api/schedules", r.definition(), headers)).status).toBe(403);
  expect((await r.post("/api/schedules", r.definition(), { Origin: "null", "Sec-Fetch-Site": "same-origin" })).status).toBe(201);
  const res = await fetch(r.base + "/api/schedules", { method: "POST", headers: {
    Cookie: `obs_token=${TOKEN}`, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin",
  }, body: JSON.stringify({ ...r.definition(), _csrf: r.csrf }) });
  expect(res.status).toBe(201);
  expect(await r.service.list()).toHaveLength(2);
});

it("错误 JSON、字段、会话、越权身份、额外操作字段、Content-Type 与大小限制", async () => {
  const r = await rig();
  for (const body of ["{", "[]", "null", { ...r.definition(), actor: "qq:2" },
    { ...r.definition(), created_by: "qq:2" }, { ...r.definition(), conversation: "group:invalid" }]) {
    expect((await r.post("/api/schedules", body)).status).toBe(400);
  }
  expect((await r.post("/api/schedules", r.definition(), { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await r.post("/api/schedules", { text: "a".repeat(65 * 1024) })).status).toBe(413);
  const s = (await (await r.post("/api/schedules", r.definition())).json()).schedule;
  expect((await r.post(`/api/schedules/${s.id}/pause`, { actor: "qq:2" })).status).toBe(400);
  expect((await r.post(`/api/schedules/${s.id}/update`, { conversation: "group:2" })).status).toBe(400);
  expect((await r.get(`/api/schedules/${s.id}/delete`)).status).toBe(404);
  expect((await r.post(`/api/schedules/${s.id}/unknown`, {})).status).toBe(404);
  expect((await fetch(r.base + "/api/schedules", { method: "PUT", headers: { Cookie: `obs_token=${TOKEN}` } })).status).toBe(405);
});

it("非法 UTF-8 拒绝，业务状态不变", async () => {
  const r = await rig();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(r.base + "/api/schedules", { method: "POST", headers: {
      Cookie: `obs_token=${TOKEN}`, "Content-Type": "application/json", "X-CSRF-Token": r.csrf,
    } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
  });
  expect(status).toBe(400);
  expect(await r.service.list()).toEqual([]);
});

it("未注入管理服务返回 JSON 404", async () => {
  const r = await rig(false), res = await r.get();
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "定时任务管理未启用" });
});

it("schedule_paused 走已有 owner 告警开关与 30 分钟限频", async () => {
  const trace = new Trace({ append: e => ({ ...e, id: 1, detail_json: JSON.stringify(e.detail ?? {}) }) });
  const sendOps = vi.fn(async (_type: string, _target: string, _text: string) => ({ message_id: "alert" }));
  let now = 1_000_000, enabled = true;
  const alerts = startAlerts({ trace, owner: "1", enabled: () => enabled, now: () => now,
    bridge: { sendOps, status: () => ({ ws_connected: true }) as never } });
  clean.push(() => alerts.stop());
  const pause = () => trace.event("@schedule:test", "schedule_paused", { status: "failed", detail: { reason: "连续 3 次失败" } });
  pause(); pause();
  expect(sendOps).toHaveBeenCalledTimes(1);
  expect(sendOps.mock.calls[0]).toEqual(["private", "1", expect.stringContaining("定时任务连续三次失败")]);
  now += 30 * 60_000; enabled = false; pause();
  expect(sendOps).toHaveBeenCalledTimes(1);
  enabled = true; pause();
  expect(sendOps).toHaveBeenCalledTimes(2);
});
