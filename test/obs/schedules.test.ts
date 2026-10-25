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

it("服务创建的任务可通过 JSON 列表、暂停、恢复、立即运行和删除", async () => {
  const r = await rig();
  const schedule = await r.service.create("qq:1", r.definition());
  const list = await r.get();
  expect(list.status).toBe(200);
  expect(list.headers.get("content-type")).toContain("application/json");
  expect((await list.json()).schedules).toEqual([schedule]);
  const route = `/api/schedules/${schedule.id}`;
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

it("JSON 创建和更新路由返回 404，不创建或修改任务", async () => {
  const r = await rig();
  const create = await r.post("/api/schedules", r.definition());
  expect(create.status).toBe(404);
  expect(await create.json()).toEqual({ error: "接口不存在" });
  expect(await r.service.list()).toEqual([]);
  const s = await r.service.create("qq:1", r.definition());
  const update = await r.post(`/api/schedules/${s.id}/update`, { name: "改名", prompt: "改提示词" });
  expect(update.status).toBe(404);
  expect(await update.json()).toEqual({ error: "接口不存在" });
  expect(await r.service.list()).toEqual([s]);
});

it("鉴权来自 cookie，URL 口令只能 GET 换 cookie；Host 防重绑定", async () => {
  const r = await rig();
  expect((await r.get("/api/schedules", false)).status).toBe(401);
  const login = await r.get(`/api/schedules?token=${TOKEN}`, false);
  expect(login.status).toBe(303);
  expect(login.headers.get("set-cookie")).toContain("HttpOnly");
  const s = await r.service.create("qq:1", r.definition());
  expect((await r.post(`/api/schedules/${s.id}/pause?token=${TOKEN}`, {}, { Cookie: "" })).status).toBe(401);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(r.base + "/api/schedules", { headers: { Host: "attacker.example", Cookie: `obs_token=${TOKEN}` } },
      res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  expect(status).toBe(403);
  expect(await r.service.list()).toEqual([s]);
});

it("同源与 CSRF 同时校验；允许 same-origin 的 null Origin 与 JSON _csrf", async () => {
  const r = await rig();
  const s = await r.service.create("qq:1", r.definition());
  const route = `/api/schedules/${s.id}`;
  const rejectedHeaders: Record<string, string>[] = [
    { Origin: "https://attacker.example" },
    { "Sec-Fetch-Site": "cross-site" },
    { Origin: "null" },
    { "X-CSRF-Token": "" },
  ];
  for (const headers of rejectedHeaders) expect((await r.post(route + "/pause", {}, headers)).status).toBe(403);
  expect(await r.service.list()).toEqual([s]);
  expect((await r.post(route + "/pause", {}, { Origin: "null", "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  expect((await r.service.get(s.id))!.status).toBe("paused");
  const res = await fetch(r.base + route + "/resume", { method: "POST", headers: {
    Cookie: `obs_token=${TOKEN}`, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin",
  }, body: JSON.stringify({ _csrf: r.csrf }) });
  expect(res.status).toBe(200);
  expect((await r.service.get(s.id))!.status).toBe("active");
  expect(await r.service.list()).toHaveLength(1);
});

it("错误 JSON、额外操作字段、Content-Type 与大小限制", async () => {
  const r = await rig();
  const s = await r.service.create("qq:1", r.definition());
  const route = `/api/schedules/${s.id}/pause`;
  for (const body of ["{", "[]", "null", { actor: "qq:2" }, { created_by: "qq:2" }, { conversation: "group:2" }]) {
    expect((await r.post(route, body)).status).toBe(400);
  }
  expect((await r.post(route, {}, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await r.post(route, { text: "a".repeat(65 * 1024) })).status).toBe(413);
  expect(await r.service.list()).toEqual([s]);
  expect((await r.get(`/api/schedules/${s.id}/delete`)).status).toBe(404);
  expect((await r.post(`/api/schedules/${s.id}/unknown`, {})).status).toBe(404);
  expect((await fetch(r.base + "/api/schedules", { method: "PUT", headers: { Cookie: `obs_token=${TOKEN}` } })).status).toBe(405);
});

it("非法 UTF-8 拒绝，业务状态不变", async () => {
  const r = await rig();
  const s = await r.service.create("qq:1", r.definition());
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(r.base + `/api/schedules/${s.id}/pause`, { method: "POST", headers: {
      Cookie: `obs_token=${TOKEN}`, "Content-Type": "application/json", "X-CSRF-Token": r.csrf,
    } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
  });
  expect(status).toBe(400);
  expect(await r.service.list()).toEqual([s]);
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
