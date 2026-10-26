import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ContextStore } from "../../src/context/store.js";
import { MemoryStore } from "../../src/context/memory/store.js";
import { PROFILE_NONE, ProfileStore } from "../../src/context/memory/profile.js";
import { MemoryService } from "../../src/agent/memory/service.js";
import { CONSOLIDATE_CONFLICT_PROMPT, MemoryConsolidator } from "../../src/agent/memory/consolidate.js";
import { SettingsStore, memoryConsolidateEnabled, settingsDefaults } from "../../src/agent/settings.js";
import { ObsStore } from "../../src/obs/store.js";
import { createDashboard } from "../../src/obs/http.js";
import { csrfToken } from "../../src/obs/http-util.js";
import { Trace } from "../../src/shared/trace.js";
import type { MemoryJobsStatus, MemoryProfileView } from "../../src/obs/memory/types.js";

const clean: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const TOKEN = "memory-jobs-test-token";
const DAY = 86400;

async function rig(enabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-memory-jobs-"));
  const obs = new ObsStore(dir), context = new ContextStore(dir), store = new MemoryStore(dir), profiles = new ProfileStore(dir);
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN, QQ_OWNER: "1" });
  const settings = await SettingsStore.open(dir, settingsDefaults({ ...config, backendOverrides: {} }), new Trace());
  const memory = new MemoryService({ store, profiles, owners: ["1"] });
  const consolidator = new MemoryConsolidator({ store, profiles, sourceRetentionDays: 30, model: "flash",
    enabled: () => memoryConsolidateEnabled(settings.current()),
    complete: async prompt => prompt.startsWith(CONSOLIDATE_CONFLICT_PROMPT) ? "[]" : '{"profile":"称呼：主人"}' });
  const dashboard = createDashboard({ config, store: obs, context, settings, health: () => ({}), queue: () => ({}), codex: async () => ({}), pi: async () => ({}),
    memoryExtract: { status: () => ({ model: "flash", available: true, queue: 0, running: null, daily_limit: 200, today: { date: "2026-10-26", counts: {} }, recent: [] }), namespaces: () => [] },
    ...(enabled ? { memoryJobs: { profiles, store, consolidator, saveProfile: (ns: string, t: string, rev: string) => memory.saveProfileFromDashboard(ns, t, rev),
      nextRun: () => Date.now() + 3600_000 } } : {}) });
  const server: Server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => {
    await consolidator.close(100); await dashboard.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    obs.close(); context.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const csrf = csrfToken(TOKEN), cookie = `obs_token=${TOKEN}`;
  const get = (route: string) => fetch(base + route, { headers: { Cookie: cookie }, redirect: "manual" });
  const json = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: "POST", redirect: "manual",
    body: JSON.stringify(body), headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base, "X-CSRF-Token": csrf, ...headers } });
  const form = (route: string, fields: Record<string, string> = {}) => fetch(base + route, { method: "POST", redirect: "manual",
    body: new URLSearchParams({ _csrf: csrf, ...fields }), headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: base } });
  /** owner 的 31 条偏好 + 一条 200 天前的经历，跑一次整理：得到一条提议与一个有变更的批次 */
  const seed = async () => {
    for (let i = 0; i < 31; i++) store.remember({ ns: "owner", kind: "preference", text: `偏好 ${i}：喝咖啡不加糖`, author: "extractor" });
    const old = store.remember({ ns: "owner", kind: "episode", text: "去年夏天去了青岛", author: "extractor" }).row;
    // 让这条经历看起来 200 天未召回
    store.touchRecall([old.id]);
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare("UPDATE memories SET last_recalled_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) - 200 * DAY, old.id);
    await consolidator.run();
    return old;
  };
  return { store, profiles, settings, consolidator, get, json, form, seed };
}

describe("画像接口 /api/memory/profile/<ns>", () => {
  it("读出空画像（revision none）；带 revision 保存成功；revision 不符 409 并带当前内容；含凭据 400；ns 非法 400", async () => {
    const r = await rig();
    const v = await (await r.get("/api/memory/profile/owner")).json() as MemoryProfileView;
    expect(v).toMatchObject({ ns: "owner", text: "", revision: PROFILE_NONE, oversize: false, redacted_inside: false });
    const saved = await r.json("/api/memory/profile/owner", { text: "称呼：主人", revision: PROFILE_NONE });
    expect(saved.status).toBe(200);
    const stale = await r.json("/api/memory/profile/owner", { text: "别的内容", revision: PROFILE_NONE });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current: { text: "称呼：主人", revision: (await r.profiles.read("owner")).revision } });
    const rev = (await r.profiles.read("owner")).revision;
    expect((await r.json("/api/memory/profile/owner", { text: "api_key=sk-abcdefghijklmnopqrstuvwx", revision: rev })).status).toBe(400);
    expect((await r.get("/api/memory/profile/shared")).status).toBe(400);
    expect((await r.json("/api/memory/profile/group%3A7", { text: "家庭群", revision: PROFILE_NONE })).status).toBe(200);
    expect((await r.profiles.read("group:7")).text).toBe("家庭群");
  });

  it("写接口要同源与 CSRF；未接入时 404", async () => {
    const r = await rig();
    expect((await r.json("/api/memory/profile/owner", { text: "x", revision: PROFILE_NONE }, { "X-CSRF-Token": "bad" })).status).toBe(403);
    expect((await r.json("/api/memory/profile/owner", { text: "x", revision: PROFILE_NONE }, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await r.json("/api/memory/consolidate/run", {}, { "X-CSRF-Token": "bad" })).status).toBe(403);
    const off = await rig(false);
    expect((await off.get("/api/memory/jobs")).status).toBe(404);
    expect((await off.json("/api/memory/consolidate/run", {})).status).toBe(404);
    expect((await off.get("/memory/jobs")).status).toBe(404);
  });
});

describe("记忆任务接口 /api/memory/jobs", () => {
  it("列出整理报告、待确认提议与批次；采纳在画像被改过时 409，拒绝后不再列出", async () => {
    const r = await rig();
    await r.seed();
    const jobs = await (await r.get("/api/memory/jobs")).json() as MemoryJobsStatus;
    expect(jobs.extract).toMatchObject({ model: "flash" });
    expect(jobs.consolidate).toMatchObject({ enabled: true, running: false, next_run: expect.any(Number), last_report: expect.objectContaining({ status: "ok" }) });
    expect(jobs.proposals).toEqual([expect.objectContaining({ ns: "owner", text: "称呼：主人", stale: false, current: { text: "", revision: PROFILE_NONE } })]);
    expect(jobs.batches).toEqual([expect.objectContaining({ ns: "owner", changes: 1, rolled_back: false })]);
    const id = jobs.proposals[0]!.id;
    await r.profiles.write("owner", "手改", PROFILE_NONE);
    expect((await r.json(`/api/memory/proposals/${id}/accept`, {})).status).toBe(409);
    expect((await r.json(`/api/memory/proposals/${id}/reject`, {})).status).toBe(200);
    expect((await r.json(`/api/memory/proposals/${id}/reject`, {})).status).toBe(409);
    expect((await r.json(`/api/memory/proposals/999/accept`, {})).status).toBe(404);
    expect(((await (await r.get("/api/memory/jobs")).json()) as MemoryJobsStatus).proposals).toEqual([]);
  });

  it("按批次回退：恢复后再回退 409，未知批次 404；立即运行在开关关闭时 409", async () => {
    const r = await rig();
    const old = await r.seed();
    expect(r.store.get(old.id)!.status).toBe("retired");
    const [batch] = r.store.consolidateBatches();
    const res = await r.json(`/api/memory/consolidate/${batch!.batch_id}/rollback`, {});
    expect(await res.json()).toMatchObject({ restored: 1, skipped: 0 });
    expect(r.store.get(old.id)!.status).toBe("active");
    expect((await r.json(`/api/memory/consolidate/${batch!.batch_id}/rollback`, {})).status).toBe(409);
    expect((await r.json("/api/memory/consolidate/00000000-0000-0000-0000-000000000000/rollback", {})).status).toBe(404);
    expect((await r.json("/api/memory/consolidate/run", {})).status).toBe(202);
    await r.consolidator.run();
    await r.settings.update({ memory: { consolidate: false } }, "test");
    expect((await r.json("/api/memory/consolidate/run", {})).status).toBe(409);
  });
});

describe("页面", () => {
  it("画像页表单保存后 303 回画像页；冲突 409 重新渲染当前内容并保留草稿", async () => {
    const r = await rig();
    const page = await (await r.get("/memory/profile/owner")).text();
    expect(page).toContain('action="/memory/profile/owner"');
    expect(page).toContain(`name="revision" value="${PROFILE_NONE}"`);
    const ok = await r.form("/memory/profile/owner", { content: "称呼：主人", revision: PROFILE_NONE });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/memory/profile/owner?ok=profileSaved");
    const conflict = await r.form("/memory/profile/owner", { content: "我的草稿", revision: PROFILE_NONE });
    expect(conflict.status).toBe(409);
    const html = await conflict.text();
    expect(html).toContain("称呼：主人");
    expect(html).toContain("我的草稿");
    expect(html).toContain("已在别处被修改");
  });

  it("记忆任务页：提议并排对照、采纳写入画像；回退按钮；首页抽取卡改名并链到 /memory/jobs", async () => {
    const r = await rig();
    await r.seed();
    const html = await (await r.get("/memory/jobs")).text();
    expect(html).toContain("当前画像");
    expect(html).toContain("建议改写");
    expect(html).toMatch(/action="\/memory\/consolidate\/[0-9a-f-]+\/rollback"/);
    const id = r.store.proposals()[0]!.id;
    const accepted = await r.form(`/memory/proposals/${id}/accept`);
    expect(accepted.headers.get("location")).toBe("/memory/jobs?ok=proposalAccepted");
    expect((await r.profiles.read("owner")).text).toBe("称呼：主人");
    const home = await (await r.get("/memory")).text();
    expect(home).toContain("记忆任务");
    expect(home).toContain('href="/memory/jobs"');
  });

  it("设置页的整理开关与抽取开关同一表单；只提交抽取时不动整理开关", async () => {
    const r = await rig();
    expect(await (await r.get("/settings")).text()).toContain('name="consolidate"');
    const off = await r.form("/settings/memory-extract", { ns: "owner", "extract:owner": "on", consolidate_field: "1" });
    expect(off.status).toBe(303);
    expect(r.settings.current().memory).toEqual({ extract: {}, consolidate: false });
    await r.form("/settings/memory-extract", { ns: "owner" });
    expect(r.settings.current().memory).toEqual({ extract: { owner: false }, consolidate: false });
    await r.form("/settings/memory-extract", { ns: "owner", "extract:owner": "on", consolidate_field: "1", consolidate: "on" });
    expect(r.settings.current().memory.consolidate).toBe(true);
  });
});
