import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ContextStore } from "../../src/context/store.js";
import { MemoryStore } from "../../src/context/memory/store.js";
import { ProfileStore } from "../../src/context/memory/profile.js";
import { MemoryService } from "../../src/agent/memory/service.js";
import { ObsStore } from "../../src/obs/store.js";
import { createDashboard } from "../../src/obs/http.js";
import { csrfToken } from "../../src/obs/http-util.js";
import type { MemoryEntryDetail, MemoryEntryPage } from "../../src/obs/memory/types.js";

const clean: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const TOKEN = "memory-entries-test-token";

async function rig(enabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-memory-entries-"));
  const obs = new ObsStore(dir), context = new ContextStore(dir), store = new MemoryStore(dir);
  const memory = new MemoryService({ store, profiles: new ProfileStore(dir), owners: ["1"] });
  const owner = { threadKey: "owner", scope: "private:1", identity: { kind: "user" as const, sender: "1" }, inputs: [], turnId: "pi:t1" };
  await memory.tool(owner, "mem_remember", { text: "住在上海浦东", kind: "fact", subject: "self" });
  await memory.tool(owner, "mem_remember", { text: "搬到杭州了", kind: "fact", subject: "self", supersedes: 1 });
  await memory.tool({ ...owner, threadKey: "group:7", scope: "group:7", identity: { kind: "user", sender: "5" } }, "mem_remember",
    { text: "周四前把周报模板发给群主", kind: "commitment", due_at: "2026-10-30" });
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN, QQ_OWNER: "1" });
  const dashboard = createDashboard({ config, store: obs, context, health: () => ({}), queue: () => ({}), codex: async () => ({}), pi: async () => ({}),
    ...(enabled ? { memoryEntries: { store, forget: (id: number) => memory.forgetFromDashboard(id), restore: (id: number) => memory.restoreFromDashboard(id),
      scopeLabel: (scope: string) => scope === "group:7" ? "群 家庭群" : memory.label(scope) } } : {}) });
  const server: Server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => {
    await dashboard.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    obs.close(); context.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const csrf = csrfToken(TOKEN), cookie = `obs_token=${TOKEN}`;
  const get = (route: string) => fetch(base + route, { headers: { Cookie: cookie }, redirect: "manual" });
  const json = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: "POST", redirect: "manual",
    body: JSON.stringify(body), headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base, "X-CSRF-Token": csrf, ...headers } });
  const form = (route: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) => fetch(base + route, { method: "POST", redirect: "manual",
    body: new URLSearchParams({ _csrf: csrf, ...fields }), headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: base, ...headers } });
  return { store, get, json, form };
}

describe("/api/memory/entries", () => {
  it("列表按命名空间、种类、状态与关键词筛选；参数非法 400；时间为毫秒", async () => {
    const r = await rig();
    const all = await (await r.get("/api/memory/entries")).json() as MemoryEntryPage;
    expect(all).toMatchObject({ total: 3, page: 0, has_more: false });
    expect(all.items.map(e => e.id).sort()).toEqual([1, 2, 3]);
    expect(all.namespaces).toEqual([{ ns: "group:7", label: "群 家庭群" }, { ns: "owner", label: "owner 私聊" }]);
    const group = all.items.find(e => e.ns === "group:7")!;
    expect(group).toMatchObject({ ns_label: "群 家庭群", kind: "commitment", due_at: Date.UTC(2026, 9, 29, 16), author: "qq:5",
      source: { scope: "group:7", label: "群 家庭群", turn_id: "pi:t1" } });
    expect(group.created_at % 1000).toBe(0);
    const pick = async (q: string) => ((await (await r.get("/api/memory/entries?" + q)).json()) as MemoryEntryPage).items.map(e => e.id);
    expect(await pick("ns=owner&status=active")).toEqual([2]);
    expect(await pick("status=superseded")).toEqual([1]);
    expect(await pick("kind=commitment")).toEqual([3]);
    expect(await pick("q=杭州")).toEqual([2]);
    for (const q of ["ns=shared", "kind=wish", "status=gone", "page=-1", "foo=1", "ns=owner&ns=owner"]) expect((await r.get("/api/memory/entries?" + q)).status).toBe(400);
  });

  it("详情含版本历史与取代链；不存在 404", async () => {
    const r = await rig();
    const d = await (await r.get("/api/memory/entries/1")).json() as MemoryEntryDetail;
    expect(d.entry).toMatchObject({ id: 1, status: "superseded", text: "住在上海浦东" });
    expect(d.versions.map(v => [v.status_before, v.status_after, v.reason])).toEqual([[null, "active", "remember"], ["active", "superseded", "superseded"]]);
    expect(d.links).toEqual([expect.objectContaining({ from_id: 2, to_id: 1, rel: "supersedes" })]);
    expect((await r.get("/api/memory/entries/99")).status).toBe(404);
    expect((await r.get("/api/memory/entries/abc")).status).toBe(400);
  });

  it("POST 遗忘 / 恢复：要 JSON、同源与 CSRF；恢复回到遗忘前的状态；未遗忘的条目恢复为 409", async () => {
    const r = await rig();
    expect((await r.json("/api/memory/entries/2/forget", {}, { "X-CSRF-Token": "bad" })).status).toBe(403);
    expect((await r.json("/api/memory/entries/2/forget", {}, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await r.json("/api/memory/entries/2/forget", { extra: 1 })).status).toBe(400);
    expect((await r.json("/api/memory/entries/2/explode", {})).status).toBe(404);
    expect((await r.json("/api/memory/entries/99/forget", {})).status).toBe(404);
    const forgot = await r.json("/api/memory/entries/2/forget", {});
    expect(forgot.status).toBe(200);
    expect(((await forgot.json()) as MemoryEntryDetail).entry.status).toBe("forgotten");
    expect(r.store.versions(2).at(-1)).toMatchObject({ by: "dashboard" });
    expect((await r.json("/api/memory/entries/3/restore", {})).status).toBe(409);
    const restored = await r.json("/api/memory/entries/2/restore", {});
    expect(((await restored.json()) as MemoryEntryDetail).entry.status).toBe("active");
    // 其它记忆接口仍只读
    expect((await r.json("/api/memory/search", {})).status).toBe(405);
  });

  it("未接入记忆时接口与页面都是 404", async () => {
    const r = await rig(false);
    expect((await r.get("/api/memory/entries")).status).toBe(404);
    expect((await r.get("/memory/entries")).status).toBe(404);
    expect((await r.json("/api/memory/entries/1/forget", {})).status).toBe(404);
  });
});

describe("/memory/entries 页面", () => {
  it("列表与详情渲染，表单 POST 遗忘后 303 回详情页并提示，CSRF 不符 403", async () => {
    const r = await rig();
    const list = await r.get("/memory/entries?status=active");
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain("搬到杭州了");
    expect(html).not.toContain("住在上海浦东");
    expect(html).toContain('action="/memory/entries/2/forget"');
    expect(html).toContain('name="_csrf"');
    const detail = await (await r.get("/memory/entries/1")).text();
    expect(detail).toContain("取代链");
    expect(detail).toContain('href="/memory/entries/2"');
    expect((await r.get("/memory/entries/99")).status).toBe(404);
    expect((await r.form("/memory/entries/2/forget", { _csrf: "bad" })).status).toBe(403);
    const posted = await r.form("/memory/entries/2/forget");
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe("/memory/entries/2?ok=memoryForgotten");
    expect(r.store.get(2)?.status).toBe("forgotten");
    const after = await (await r.get("/memory/entries/2?ok=memoryForgotten")).text();
    expect(after).toContain("记忆已遗忘");
    expect(after).toContain('action="/memory/entries/2/restore"');
    expect((await r.form("/memory/entries/3/restore")).status).toBe(409);
    expect((await r.form("/memory/entries/2/restore")).headers.get("location")).toBe("/memory/entries/2?ok=memoryRestored");
    expect(await (await r.get("/memory")).text()).toContain('href="/memory/entries"');
  });
});
