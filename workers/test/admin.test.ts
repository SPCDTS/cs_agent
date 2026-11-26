import { abortAllDurableObjects, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Errors } from "typebox/value";
import * as C from "../browser/contracts";
import worker from "../src/index";
import { RegistryDO } from "../src/registry";
import { threadView } from "../src/admin/read-views";
import { snapshot } from "../src/requests/snapshot";
import type { RequestDetail } from "../src/requests/types";
import type { Settings, SettingsSnapshot } from "../src/settings";
import { CloudflareGrant } from "../src/cloudflare/cloudflare";
import { CloudflareManagement } from "../src/cloudflare/cloudflare-management";
import { TokenVault, sha256 } from "../src/mcp/crypto";
import { modelEgressDiagnostics } from "../src/models";
import { action, connect, event, input, reply, sendPrivate } from "./helpers";
import { fakeRemote, login, TEST_STORE_KEY, adminEnv } from "./mcp-helpers";

describe("admin routes and data views", () => {
  const TOKEN = "test-admin-only";
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); await abortAllDurableObjects(); vi.restoreAllMocks(); });
  
  function admin(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return worker.fetch(new Request(`https://test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ADMIN_TOKEN: TOKEN });
  }
  async function adminJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await admin(method, path, body);
    if (!response.ok) throw new Error(`admin ${method} ${path} -> ${response.status}: ${await response.text()}`);
    return response.json<T>();
  }
  async function saveSettings(change: Partial<Settings>): Promise<SettingsSnapshot & { applied: boolean }> {
    const current = await adminJson<SettingsSnapshot>("GET", "/admin/settings");
    return adminJson("PUT", "/admin/settings", { value: { ...current.value, ...change }, expectedRevision: current.revision });
  }
  const replyToBot = (messageId: number, botMessageId: string) => ({ ...event(messageId, "接着说", 10000004, 200000001),
    message: [{ type: "reply", data: { id: botMessageId } }, { type: "text", data: { text: "接着说" } }] });
  const groupMessages = (key = "group:200000001") => runInDurableObject(env.THREAD.getByName(key), (_instance, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n);
  
  describe("admin routes", () => {
    it("guards data routes with ADMIN_TOKEN and serves the static page without inline script", async () => {
      for (const token of [null, "", "wrong", "t"]) expect((await admin("GET", "/admin/overview", undefined, token)).status).toBe(401);
      expect((await worker.fetch(new Request("https://test/admin/settings", { headers: { Authorization: `Bearer ${TOKEN}` } }), { ...env, ADMIN_TOKEN: undefined })).status).toBe(401);
      expect((await admin("GET", "/admin/events?access_token=" + TOKEN, undefined, null)).status).toBe(401);
      expect((await admin("GET", "/admin/unknown")).status).toBe(404);
  
      for (const path of ["/admin/", "/admin/app.js"]) {
        const response = await admin("GET", path, undefined, null);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
      const html = await (await admin("GET", "/admin/", undefined, null)).text();
      expect(html).toContain('data-view="workspace"');
      expect(html).toContain('id="workspace-panel"');
      expect(html).not.toContain('data-view="sandbox"');
      expect(html.match(/<script[^>]*>/g)).toEqual(['<script src="/admin/app.js" defer>']);
      const script = await (await admin("GET", "/admin/app.js", undefined, null)).text();
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "localStorage", "document.cookie"]) expect(script).not.toContain(sink);
    });
  
    it("serves a script that parses and only looks up element ids the page defines", async () => {
      const html = await (await admin("GET", "/admin/", undefined, null)).text();
      const script = await (await admin("GET", "/admin/app.js", undefined, null)).text();
      expect(() => new Function(script)).not.toThrow();
      const defined = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
      const used = [...script.matchAll(/\$\("([^"]+)"\)/g)].map(match => match[1]!);
      expect(used).toEqual(expect.arrayContaining(["schedules", "sources", "card-threads-extra", "event-kinds"]));
      expect(used.filter(id => !defined.has(id))).toEqual([]);
    });
  
    it("starts from env defaults, saves with CAS revisions and rejects malformed IDs", async () => {
      const initial = await adminJson<SettingsSnapshot>("GET", "/admin/settings");
      expect(initial).toMatchObject({ value: { groupTrigger: "mention_only", allowGroups: ["200000001"], allowUsers: ["10000003"], extractNamespaces: ["owner"],
        model: { provider: "faux", id: "test" } }, overrides: null });
      expect(initial.defaults).toEqual(initial.value);
      const value: Settings = { groupTrigger: "mention_or_reply", allowGroups: ["200000001", "200000002"], allowUsers: [], extractNamespaces: ["owner", "group:200000001"], model: initial.value.model };
      const saved = await adminJson<SettingsSnapshot & { applied: boolean }>("PUT", "/admin/settings", { value, expectedRevision: initial.revision });
      expect(saved).toMatchObject({ value, overrides: value, defaults: initial.defaults, applied: true });
      expect(saved.revision).not.toBe(initial.revision);
      expect(await adminJson("GET", "/admin/settings")).toMatchObject({ value, revision: saved.revision });
  
      const stale = await admin("PUT", "/admin/settings", { value: initial.value, expectedRevision: initial.revision });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: "conflict", current: { value, revision: saved.revision } });
      for (const bad of [{ ...value, allowGroups: ["1234"] }, { ...value, allowGroups: ["0200000001"] }, { ...value, allowUsers: ["10000003,10000004"] },
        { ...value, extractNamespaces: ["group:abc"] }, { ...value, groupTrigger: "always" }, { ...value, extra: true }]) {
        expect((await admin("PUT", "/admin/settings", { value: bad, expectedRevision: saved.revision })).status).toBe(400);
      }
      expect(await adminJson("GET", "/admin/settings")).toMatchObject({ revision: saved.revision });
    });
  
    it("pushes saved group policy to the live Bridge, including replies to the bot", async () => {
      const { socket, frames } = await connect(sockets);
      socket.send(JSON.stringify(event(1, "帮忙", 10000004, 200000001, true)));
      reply(socket, (await action(frames)).echo, 90000001);
      await expect.poll(async () => { await env.THREAD.getByName("group:200000001").syncAdminView("group:200000001"); return threadView(env, "group:200000001").stats(); }).toMatchObject({ inbound: { done: 1 } });
  
      socket.send(JSON.stringify(replyToBot(2, "90000001")));
      await expect.poll(() => groupMessages()).toBe(3);
      expect(frames.filter(frame => (frame as { action?: string }).action === "send_group_msg")).toHaveLength(1);
  
      expect((await saveSettings({ groupTrigger: "mention_or_reply" })).applied).toBe(true);
      socket.send(JSON.stringify(replyToBot(3, "90000001")));
      const second = await action(frames, 1);
      expect(second.params.message?.[0]?.data.qq).toBe("10000004");
      reply(socket, second.echo, 90000002);
      await expect.poll(async () => { await env.THREAD.getByName("group:200000001").syncAdminView("group:200000001"); return threadView(env, "group:200000001").stats(); }).toMatchObject({ inbound: { done: 2 } });
  
      await saveSettings({ allowGroups: [] });
      socket.send(JSON.stringify(event(4, "还在吗", 10000004, 200000001, true)));
      await expect.poll(() => env.BRIDGE.getByName("napcat").status()).toMatchObject({ ignored: 1 });
      expect(await groupMessages()).toBe(5);
    });
  
    it("reads extraction namespaces from saved settings in the Thread", async () => {
      await saveSettings({ extractNamespaces: ["group:200000001"] });
      const group = env.THREAD.getByName("group:200000001");
      expect(await group.submit(input(1, "本群偏好".repeat(30), 10000004, 200000001, true))).toEqual({ status: "done" });
      await group.syncAdminView("group:200000001");
      expect((await threadView(env, "group:200000001").stats()).memory.extractQueue).toBe(1);
      const owner = env.THREAD.getByName("owner");
      expect(await owner.submit(input(2, "主人偏好".repeat(30), 10000001))).toEqual({ status: "done" });
      await owner.syncAdminView("owner");
      expect((await threadView(env, "owner").stats()).memory.extractQueue).toBe(0);
    });
  });
  
  describe("admin data views", () => {
    type EventPage = { events: { id: number; at: number; kind: string; detail: Record<string, unknown> }[]; next?: number };
  
    it("defaults admin data pages to ten and returns the remaining row on the next page", async () => {
      const owner = env.THREAD.getByName("owner"), store = env.REQUESTS.getByName("main"), at = Date.now() - 1000;
      await owner.syncAdminView("owner");
      await runInDurableObject(owner, (_instance, state) => {
        for (let i = 0; i < 11; i++) state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", at + i, "mcp_call", JSON.stringify({ tool: "tool" + i }));
      });
      await owner.syncAdminView("owner");
      const eventPage = await adminJson<EventPage>("GET", "/admin/events?thread=owner&kind=mcp_call");
      expect(eventPage.events).toHaveLength(10);
      expect(eventPage.next).toBeDefined();
      const eventTail = await adminJson<EventPage>("GET", "/admin/events?thread=owner&kind=mcp_call&before=" + eventPage.next);
      expect(eventTail.events.map(e => e.detail.tool)).toEqual(["tool0"]);
      expect(eventTail.next).toBeUndefined();
  
      for (let i = 0; i < 11; i++) await owner.saveMemory("owner", null, { kind: "fact", text: "分页记录" + i });
      type MemoryPage = { items: { id: number }[]; page: number; limit: number; total: number };
      await owner.syncAdminView("owner");
      const memoryPage = await adminJson<MemoryPage>("GET", "/admin/memory/list?ns=owner");
      expect(memoryPage).toMatchObject({ page: 1, limit: 10, total: 11 });
      expect(memoryPage.items.map(m => m.id)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
      expect((await adminJson<MemoryPage>("GET", "/admin/memory/list?ns=owner&page=2")).items.map(m => m.id)).toEqual([1]);
  
      const ids = Array.from({ length: 11 }, () => crypto.randomUUID());
      for (const id of ids) await store.record({ request: {
        id, startedAt: at, endedAt: at + 10, thread: "owner", actor: "thread", purpose: "conversation", provider: "faux", model: "test",
        status: "done", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, durationMs: 10, contextWindow: 1000,
      }, context: snapshot({ messages: [] }) });
      const traces=await adminJson<Awaited<ReturnType<typeof store.agentTraces>>>("GET","/admin/agent-traces");
      expect(traces.traces).toHaveLength(10);
      expect(traces.next).toBeDefined();
      const tail=await adminJson<typeof traces>("GET","/admin/agent-traces?cursor="+encodeURIComponent(traces.next!));
      expect(tail.traces).toHaveLength(1);
      expect(new Set([...traces.traces,...tail.traces].map(t=>t.root)).size).toBe(11);
      expect((await admin("GET","/admin/agent-traces/detail?thread=owner&root=turn:1",undefined,null)).status).toBe(401);
      expect((await admin("GET","/admin/agent-traces?cursor=bad")).status).toBe(400);

    });
  
    it("keeps dispatches made during a report in the original execution even when tool records arrive in reverse", async () => {
      const store = env.REQUESTS.getByName("main"), at = Date.now();
      const dispatch = (turnId: string, inputId: string, child: string) => store.recordTool({
        id: crypto.randomUUID(), thread: "owner", actor: "thread", binding: { turnId, inputId, generation: 0 },
        callId: "send-" + child, name: "subagent", startedAt: at, endedAt: at, status: "done",
        dispatch: { actor: child, inputId: "task" }, arguments: { text: "{}", chars: 2, truncated: false },
      });
      await dispatch("turn:report-b", "subagent-report:b:task", "c");
      await dispatch("turn:report-a", "subagent-report:a:task", "b");
      await dispatch("turn:root", "web:original", "a");
      await dispatch("turn:report-c", "subagent-report:c:task", "d");
      await dispatch("turn:independent", "web:separate", "e");
      const details = await store.agentTraceDetail("owner", "turn:root");
      expect(details.observations.map(row => row.target?.actor).sort()).toEqual(["a", "b", "c", "d"]);
      expect((await store.agentTraceDetail("owner", "turn:report-b")).observations).toHaveLength(0);
      expect((await store.agentTraceDetail("owner", "turn:independent")).observations).toHaveLength(1);
    });

    it("pages audit events by rowid and filters by kind and result", async () => {
      const owner = env.THREAD.getByName("owner");
      await owner.syncAdminView("owner");
      const rows: [string, object][] = [
        ["mcp_call", { server: "notion", tool: "a", result: "ok" }], ["mcp_catalog", { server: "notion", status: "error", code: "auth_required" }],
        ["memory_extract", { status: "skipped", reason: "too_short" }], ["mcp_call", { server: "notion", tool: "b", result: "outcome_unknown" }],
        ["mcp_catalog", { server: "notion", status: "ok", tools: 3 }], ["mcp_call", { server: "notion", tool: "c", result: "ok" }],
        ["memory_write", { tool: "mem_remember", written: 1 }],
      ];
      await runInDurableObject(owner, (_instance, state) => {
        rows.forEach(([kind, detail], i) => state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", 1_700_000_000_000 + i, kind, JSON.stringify(detail)));
      });
      await owner.syncAdminView("owner");
      const first = await adminJson<EventPage>("GET", "/admin/events?thread=owner&limit=3");
      expect(first.events.map(e => e.kind)).toEqual(["memory_write", "mcp_call", "mcp_catalog"]);
      expect(first.events[1].detail).toEqual({ server: "notion", tool: "c", result: "ok" });
      const second = await adminJson<EventPage>("GET", `/admin/events?thread=owner&limit=3&before=${first.next}`);
      expect(second.events.map(e => e.kind)).toEqual(["mcp_call", "memory_extract", "mcp_catalog"]);
      const last = await adminJson<EventPage>("GET", `/admin/events?thread=owner&limit=3&before=${second.next}`);
      expect(last).toEqual({ events: [expect.objectContaining({ kind: "mcp_call", detail: { server: "notion", tool: "a", result: "ok" } })] });
  
      const calls = await adminJson<EventPage>("GET", "/admin/events?thread=owner&kind=mcp_call");
      expect(calls.events.map(e => e.detail.tool)).toEqual(["c", "b", "a"]);
      const ok = await adminJson<EventPage>("GET", "/admin/events?thread=owner&result=ok");
      expect(ok.events.map(e => e.kind)).toEqual(["memory_write", "mcp_call", "mcp_catalog", "memory_extract", "mcp_call"]);
      const catalogErrors = await adminJson<EventPage>("GET", "/admin/events?thread=owner&kind=mcp_catalog&result=error");
      expect(catalogErrors.events.map(e => e.detail.code)).toEqual(["auth_required"]);
      for (const query of ["thread=owner&limit=201", "thread=../owner", "thread=owner&kind=x'y"]) expect((await admin("GET", `/admin/events?${query}`)).status).toBe(400);
    });
  
    it("filters web_search and coding audit events by their result field", async () => {
      const owner = env.THREAD.getByName("owner");
      await owner.syncAdminView("owner");
      const rows: [string, object][] = [
        ["web_search", { result: "ok", ms: 900, results: 5 }], ["coding_exec", { result: "ok", commandLength: 12, code: 0, ms: 40 }],
        ["web_search", { result: "not_searched", ms: 700, results: 0 }], ["coding_exec", { result: "timeout", commandLength: 30, code: null, ms: 60_000 }],
      ];
      await runInDurableObject(owner, (_instance, state) => {
        rows.forEach(([kind, detail], i) => state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", 1_700_000_000_000 + i, kind, JSON.stringify(detail)));
      });
      await owner.syncAdminView("owner");
      const page = (query: string) => adminJson<EventPage>("GET", `/admin/events?thread=owner&${query}`);
      expect((await page("result=ok")).events.map(e => [e.kind, e.detail.result])).toEqual([["coding_exec", "ok"], ["web_search", "ok"]]);
      expect((await page("kind=web_search&result=not_searched")).events.map(e => e.detail.results)).toEqual([0]);
      expect((await page("kind=coding_exec&result=timeout")).events.map(e => e.detail.commandLength)).toEqual([30]);
      expect((await page("kind=coding_exec&result=not_searched")).events).toEqual([]);
    });
  
    it("lists, forgets and CAS-edits memory of one namespace", async () => {
      const owner = env.THREAD.getByName("owner");
      const first = await adminJson<{ id: number }>("POST", "/admin/memory/entries?ns=owner", { kind: "fact", text: "喜欢烟雾弹" });
      const third = await adminJson<{ id: number }>("POST", "/admin/memory/entries?ns=owner", { kind: "fact", text: "常用闪光弹" });
      const second = await adminJson<{ id: number }>("POST", "/admin/memory/entries?ns=owner", { kind: "preference", text: "群里只在被 @ 时回复" });
      await owner.writeProfile("owner", "初始画像", "none");
      type View = { profile: { text: string; revision: string }; memories: { id: number; status: string }[] };
      await owner.syncAdminView("owner");
      const view = await adminJson<View>("GET", "/admin/memory?ns=owner");
      expect(view.memories.map(row => row.id)).toEqual([second.id, third.id, first.id]);
      expect(view.profile.text).toBe("初始画像");
      expect((await adminJson<View>("GET", "/admin/memory?ns=owner&q=" + encodeURIComponent("烟雾弹"))).memories.map(row => row.id)).toEqual([first.id]);
      expect((await adminJson<View>("GET", `/admin/memory?ns=owner&q=%23${third.id}`)).memories.map(row => row.id)).toEqual([third.id]);
  
      expect(await adminJson("DELETE", `/admin/memory/${second.id}?ns=owner`)).toEqual({ status: "forgotten" });
      await owner.syncAdminView("owner");
      expect((await adminJson<View>("GET", "/admin/memory?ns=owner")).memories.map(row => row.id)).toEqual([third.id, first.id]);
      expect((await threadView(env, "owner").stats()).memory.active).toBe(2);
      expect((await admin("DELETE", "/admin/memory/999?ns=owner")).status).toBe(404);
      await env.THREAD.getByName("private:10000003").syncAdminView("private:10000003");
      expect((await adminJson<View>("GET", "/admin/memory?ns=private:10000003")).memories).toEqual([]);
  
      const reviewed = await adminJson<View>("GET", "/admin/memory?ns=owner");
      const saved = await adminJson<{ profile: { text: string; revision: string } }>("PUT", "/admin/memory/profile", { ns: "owner", text: "新画像", expected: reviewed.profile.revision });
      expect(saved.profile.text).toBe("新画像");
      const conflict = await admin("PUT", "/admin/memory/profile", { ns: "owner", text: "旧页面的画像", expected: view.profile.revision });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: "conflict", current: saved.profile });
      expect((await admin("PUT", "/admin/memory/profile", { ns: "owner", text: "token=synthetic-only", expected: saved.profile.revision })).status).toBe(400);
      await env.THREAD.getByName("owner").syncAdminView("owner");
      expect((await adminJson<View>("GET", "/admin/memory?ns=owner")).profile).toEqual(saved.profile);
    });
  
    it("logs an MCP account out so Registry reports login needed", async () => {
      fakeRemote();
      await login();
      expect((await env.REGISTRY.getByName("main").status())[0]).toMatchObject({ server: "notion", login: "ok" });
      expect(await adminJson("POST", "/admin/mcp/notion/logout")).toEqual({ ok: true });
      expect((await env.REGISTRY.getByName("main").status())[0]).toMatchObject({ server: "notion", login: "needed" });
      expect(await adminJson("POST", "/admin/mcp/notion/login-link")).toEqual({ url: expect.stringMatching(/\/mcp\/oauth\/start\?nonce=/) });
      const unknown = await admin("POST", "/admin/mcp/missing/logout");
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toEqual({ error: "server_unavailable" });
    });
  
    it("releases a tripped send breaker so the next send goes through", async () => {
      const { socket, frames } = await connect(sockets);
      await runInDurableObject(env.BRIDGE.getByName("napcat"), (_instance, state) => {
        for (let i = 0; i < 60; i++) state.storage.sql.exec("INSERT INTO send_log(scope, at) VALUES (?, ?)", "private:10000003", Date.now() - 120_000);
      });
      await expect(sendPrivate("第61条")).rejects.toThrow("暂停本会话发送 60 分钟");
      expect(await adminJson("POST", "/admin/send-rules/release", { scope: "private:10000003" })).toEqual({ released: true });
      expect(await adminJson("POST", "/admin/send-rules/release", { scope: "private:10000003" })).toEqual({ released: false });
      expect((await env.BRIDGE.getByName("napcat").status()).sendRules).toEqual([]);
      const sending = sendPrivate("恢复");
      reply(socket, (await action(frames, 0, "send_private_msg")).echo);
      expect(await sending).toEqual({ message_id: "90000001" });
      expect((await admin("POST", "/admin/send-rules/release", { scope: "everyone" })).status).toBe(400);
    });
  
    it("returns projected stats for every thread and isolates a failing display DO", async () => {
      await runInDurableObject(env.BRIDGE.getByName("napcat"), async (_instance, state) => {
        state.storage.sql.exec("INSERT INTO threads(key, seen_at) VALUES ('group:200000001', 2), ('group:200000002', 1)");
        await state.storage.put("group:200000001", { name: "测试群", expires: Date.now() + 60_000 });
      });
      await env.THREAD.getByName("group:200000001").ingest(input(1, "普通聊天", 10000004, 200000001));
      for (const key of ["owner", "group:200000001", "group:200000002"]) await env.THREAD.getByName(key).syncAdminView(key);
      await runInDurableObject(threadView(env,"group:200000002"), (_instance, state) => { state.storage.sql.exec("DROP TABLE memories; CREATE TABLE memories (broken TEXT)"); });
  
      const response = await admin("GET", "/admin/overview");
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(JSON.parse(raw)).toMatchObject({ commit: "dev", bridge: { connected: false }, model: { provider: "faux", id: "test" }, sendRules: [],
        mcp: expect.arrayContaining([
          expect.objectContaining({ server: "notion", tools: 0 }),
          expect.objectContaining({ server: "cs2-workshop", enabled: true, credential: "static", login: "unconfigured", tools: 0 }),
        ]), configured: { ADMIN_TOKEN: true, OAUTH_STORE_KEY: true, DEEPSEEK_API_KEY: false, GEMINI_API_KEY: false },
        threads: [
          { key: "owner", kind: "owner", stats: { inbound: { queued: 0, done: 0, failed: 0 } } },
          { key: "group:200000001", name: "测试群", kind: "group", stats: { inbound: { queued: 0, done: 0, failed: 0 }, outbox: 0, memory: { active: 0 } } },
          { key: "group:200000002", kind: "group", stats: { error: "unavailable" } },
        ] });
      for (const secret of [TOKEN, "01".repeat(32), "10000001,10000002"]) expect(raw).not.toContain(secret);
    });
  
    it("adds schedule and event backlog to the overview and still answers when either DO fails", async () => {
      type Overview = { schedule: { active?: number; paused?: number; error?: string }; events: { held?: number; error?: string } };
      await env.SCHEDULE.getByName("main").create({ name: "早报", prompt: "整理早报", conversation: "owner",
        rule: { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0", dtstart: Date.now() } }, "qq:10000001");
      expect(await adminJson<Overview>("GET", "/admin/overview")).toMatchObject({ schedule: { active: 1, paused: 0 }, events: { held: 0 } });
  
      const breakTable = (stub: DurableObjectStub, table: string) => runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`DROP TABLE ${table}; CREATE TABLE ${table} (broken TEXT)`);
      });
      await breakTable(env.SCHEDULE.getByName("main"), "schedules");
      const scheduleDown = await admin("GET", "/admin/overview");
      expect(scheduleDown.status).toBe(200);
      expect(await scheduleDown.json()).toMatchObject({ schedule: { error: "unavailable" }, events: { held: 0 }, threads: [{ key: "owner" }] });
  
      await breakTable(env.EVENTS.getByName("main"), "event_source");
      const bothDown = await admin("GET", "/admin/overview");
      expect(bothDown.status).toBe(200);
      expect(await bothDown.json()).toMatchObject({ schedule: { error: "unavailable" }, events: { error: "unavailable" }, threads: [{ key: "owner" }] });
    });
  
    it("stops the in-flight turn of a thread", async () => {
      const { socket, frames } = await connect(sockets);
      const thread = env.THREAD.getByName("group:200000001");
      const turn = (async () => thread.submit(input(1, "一", 10000004, 200000001, true)))();
      const pending = await action(frames);
      await thread.syncAdminView("group:200000001");
      expect((await threadView(env, "group:200000001").stats()).inbound.queued).toBe(1);
      expect(pending.action).toBe("send_group_msg");
      expect(await adminJson("POST", "/admin/threads/group%3A200000001/stop")).toEqual({ stopped: true });
      reply(socket, pending.echo);
      expect(await turn).toEqual({ status: "failed" });
      await thread.syncAdminView("group:200000001");
      expect((await threadView(env, "group:200000001").stats()).inbound).toEqual({ queued: 0, done: 0, failed: 1 });
      expect(await adminJson("POST", "/admin/threads/group:200000001/stop")).toEqual({ stopped: false });
    });
  });
});

describe("browser contracts", () => {
  afterEach(async () => { await reset(); await abortAllDurableObjects(); vi.restoreAllMocks(); });
  const admin = (path: string, method = "GET", body?: unknown) => worker.fetch(new Request("https://test" + path, {
    method, headers: { Authorization: "Bearer browser-test", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ADMIN_TOKEN: "browser-test" });
  
  it("浏览器 schema 接受真实管理路由响应，包括空列表和已保存内容", async () => {
    const owner = env.THREAD.getByName("owner"), requests = env.REQUESTS.getByName("main"), now = Date.now();
    await owner.saveMemory("owner", null, { kind: "fact", text: "浏览器契约检查" });
    await owner.syncAdminView("owner");
    await env.SCHEDULE.getByName("main").create({ name: "契约检查", prompt: "检查", conversation: "owner", rule: { kind: "at", at: now + 3600_000 } }, "qq:10000001");
    expect((await admin("/admin/skills/browser-check", "PUT", { markdown: "---\nname: browser-check\ndescription: 浏览器契约检查\n---\n检查正文" })).status).toBe(200);
    const id = crypto.randomUUID(), toolId = crypto.randomUUID(), binding = { turnId: "turn:browser-check", inputId: "web:browser-check", generation: 0 };
    const detail: RequestDetail = { request: { id, startedAt: now, endedAt: now + 10, thread: "owner", actor: "thread", purpose: "conversation", provider: "faux", model: "test",
      status: "done", inputTokens: 14, outputTokens: 3, cacheRead: 5, cacheWrite: 2, reasoningTokens: 2, durationMs: 10, contextWindow: 1000, binding, toolCalls: [{ id: "call", name: "read" }] },
      context: snapshot({ messages: [{ role: "user", content: "读取文件", timestamp: now }] }) };
    await requests.record(detail);
    await requests.recordTool({ id: toolId, thread: "owner", binding, callId: "call", name: "read", startedAt: now, endedAt: now + 2, status: "done",
      arguments: { text: "{}", chars: 2, truncated: false }, result: { text: "完成", chars: 2, truncated: false } });
    const checks = {
      "/admin/overview": C.Overview, "/admin/settings": C.Settings, "/admin/model": C.ModelView,
      "/admin/schedules": C.Schedules, "/admin/event-sources": C.Sources,
      "/admin/memory?ns=owner": C.MemoryView, "/admin/memory/list?ns=owner": C.MemoryList,
      "/admin/memory/1?ns=owner": C.MemoryDetailSchema, "/admin/memory/jobs?ns=owner": C.MemoryJobsSchema,
      "/admin/memory/proposals?ns=owner": C.MemoryProposalsSchema,
      "/admin/skills": C.Skills, "/admin/skills/browser-check": C.Skill,
      "/admin/persona": C.PersonaSchema, "/admin/grants": C.GrantsSchema, "/admin/ops-settings": C.OpsSchema,
      "/admin/alerts": C.AlertsSchema, "/admin/deliveries": C.DeliveriesSchema, "/admin/mcp/servers": C.McpServersSchema,
      "/admin/threads/owner/chat": C.ChatView, "/admin/threads/owner/history": C.SessionHistorySchema,
      "/admin/threads/owner/subagents": C.Subagents, "/admin/threads/owner/workspace": C.ManifestSchema,
      "/admin/threads/owner/progress?turn=turn:browser-check": C.ChatProgress,
      "/admin/usage": C.Usage, "/admin/agent-topology": C.AgentTopologySchema,
      ["/admin/requests/" + id + "?summary=1"]: C.RequestDetail,
      ["/admin/requests/" + id + "/context"]: C.ContextInspection,
      ["/admin/requests/" + id + "/context/message:0"]: C.ContextBody,
      "/admin/context-timeline?thread=owner": C.ContextTimeline,
      "/admin/agent-traces": C.TracePage, "/admin/agent-traces/detail?thread=owner&root=turn:browser-check": C.TraceDetail,
      "/admin/agent-traces/analysis?thread=owner&root=turn:browser-check": C.ExecutionAnalysis,
      "/admin/agent-traces/runtime?thread=owner&actor=thread&input=web:browser-check": C.PiPage,
      ["/admin/requests/" + id]: C.RequestDetail, ["/admin/tools/" + toolId]: C.ToolDetail,
    };
    for (const [path, schema] of Object.entries(checks)) {
      const response = await admin(path);
      expect(response.status, path).toBe(200);
      expect([...Errors(schema, await response.json())], path).toEqual([]);
    }
  });
});

describe("public boundaries", () => {
  afterEach(async () => { await reset(); await abortAllDurableObjects(); vi.restoreAllMocks(); });
  const adminEnv = { ...env, ADMIN_TOKEN: "test-admin" };
  
  it("公开存活探针不读取绑定，详情需要管理员认证并分别报告各组件", async () => {
    const noBindings = new Proxy(env, { get() { throw new Error("公开探针不应读取绑定"); } });
    const probe = await worker.fetch(new Request("https://test/healthz"), noBindings);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ ok: true });
    expect(probe.headers.get("cache-control")).toBe("no-store");
  
    expect((await worker.fetch(new Request("https://test/admin/health"), adminEnv)).status).toBe(401);
    vi.spyOn(RegistryDO.prototype, "modelStatus").mockResolvedValue({ unavailable: "model_unavailable" });
    const detail = await worker.fetch(new Request("https://test/admin/health", { headers: { Authorization: "Bearer test-admin" } }), adminEnv);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect(await detail.json()).toMatchObject({ overall: "degraded", components: { worker: "ready", bridge: "degraded", model: "unavailable" } });
  });
  
  it("没有配对票据时先拒绝请求，不解析 OAuth 正文", async () => {
    for (const action of ["begin", "complete"]) {
      const request = new Request("https://test/admin/model/oauth/codex/bridge/" + action, { method: "POST", body: "{" });
      const response = await worker.fetch(request, adminEnv);
      expect(response.status).toBe(401);
      expect(request.bodyUsed).toBe(false);
    }
  });
  
  it("按实际流字节拒绝超大配对正文，且不消费可用票据", async () => {
    const start = await worker.fetch(new Request("https://test/admin/model/oauth/codex/start", {
      method: "POST", headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" }, body: "{}",
    }), adminEnv);
    const { ticket } = await start.json<{ ticket: string }>();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(64_000)); controller.enqueue(new Uint8Array(2000)); },
      cancel: cancelled,
    });
    const headers = { Authorization: "Bearer " + ticket, "Content-Type": "application/json" };
    const rejected = await worker.fetch(new Request("https://test/admin/model/oauth/codex/bridge/begin", {
      method: "POST", headers: { ...headers, "Content-Length": "1" }, body: stream,
    }), adminEnv);
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({ error: "request_too_large" });
    expect(cancelled).toHaveBeenCalled();
  
    const accepted = await worker.fetch(new Request("https://test/admin/model/oauth/codex/bridge/begin", {
      method: "POST", headers, body: JSON.stringify({ port: 1455 }),
    }), adminEnv);
    expect(accepted.status).toBe(200);
  });
  
  it("正文未超限时仍拒绝过长 token 字段", async () => {
    const response = await worker.fetch(new Request("https://test/admin/model/oauth/codex/bridge/complete", {
      method: "POST", headers: { Authorization: "Bearer " + "a".repeat(43), "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: "http://localhost:1455/auth/callback", tokens: {
        access_token: "a".repeat(16385), refresh_token: "refresh", token_type: "Bearer", expires_in: 3600,
      } }),
    }), adminEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});

describe("cloudflare management", () => {
  afterEach(async () => { await reset(); await abortAllDurableObjects(); vi.restoreAllMocks(); });
  const instance = { ...env, PUBLIC_ORIGIN:'https://agent.example.test', DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID:'synthetic-client' };
  const target = { account:'a'.repeat(32), zone:'e'.repeat(32), domain:'example.test', token:'synthetic-access' };
  it('PKCE 回调仅使用一次，匹配活动父域，续期轮换加密令牌并区分授权撤销', async () => {
    await runInDurableObject(env.REGISTRY.getByName('main'), async (_instance, state) => {
      const grant = new CloudflareGrant(state.storage.sql, new TokenVault(TEST_STORE_KEY), instance);
      grant.initialize();
      const begin = new URL((await grant.start()).url), nonce = begin.searchParams.get('state')!;
      expect(begin.origin + begin.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
      expect(begin.searchParams.get('code_challenge_method')).toBe('S256');
      let refresh = 0;
      const scopes = 'zone.read dns.write argotunnel.write';
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const req = new Request(input, init), url = new URL(req.url);
        expect(req.redirect).toBe('manual');
        if (url.pathname === '/oauth2/token') {
          const body = new URLSearchParams(await req.text());
          if (body.get('grant_type') === 'authorization_code') {
            expect(body.get('redirect_uri')).toBe(begin.searchParams.get('redirect_uri'));
            expect((await sha256(body.get('code_verifier')!)).toString('base64url')).toBe(begin.searchParams.get('code_challenge'));
            return Response.json({token_type:'Bearer', access_token:target.token, refresh_token:'synthetic-refresh', expires_in:3600, scope:scopes});
          }
          expect(body.get('refresh_token')).toBe(refresh ? 'synthetic-rotated' : 'synthetic-refresh');
          return ++refresh === 1 ? Response.json({token_type:'Bearer',access_token:'synthetic-new',refresh_token:'synthetic-rotated',expires_in:3600})
            : Response.json({error:'invalid_grant'}, {status:400});
        }
        expect(url.pathname).toBe('/client/v4/zones');
        expect(req.headers.get('Authorization')).toBe('Bearer ' + target.token);
        const found = url.searchParams.get('name') === target.domain;
        return Response.json({ success: true, result: found ? [{ id:target.zone, name:target.domain, status:'active', account:{id:target.account} }] : [] });
      });
      await expect(grant.complete('wrong-state','code')).rejects.toThrow('state');
      expect(fetch).not.toHaveBeenCalled();
      expect((await grant.complete(nonce,'code')).domain).toBe(target.domain);
      await expect(grant.complete(nonce,'code')).rejects.toThrow('state');
      expect(await grant.settings()).toEqual(target);
      const saved = JSON.stringify(state.storage.sql.exec('SELECT * FROM cf_grant').toArray());
      expect(saved).not.toContain('synthetic-access'); expect(saved).not.toContain('synthetic-refresh');
      state.storage.sql.exec('UPDATE cf_grant SET expires=0');
      expect((await grant.settings()).token).toBe('synthetic-new');
      state.storage.sql.exec('UPDATE cf_grant SET expires=0');
      await expect(grant.settings()).rejects.toThrow('reauthorize');
      expect(grant.status().reauth).toBe(true);
    });
  });
  it('首次省略 scope 仅保存登记的必需权限，空 scope 和非 JSON 的 Zone 响应返回明确错误', async () => {
    await runInDurableObject(env.REGISTRY.getByName('main'), async (_instance,state) => {
      const grant = new CloudflareGrant(state.storage.sql,new TokenVault(TEST_STORE_KEY),instance);
      grant.initialize();
      const tokens = { token_type:'Bearer', access_token:target.token, refresh_token:'synthetic-refresh', expires_in:3600 };
      const zone = { account:{id:target.account}, id:target.zone, name:target.domain, status:'active' };
      const complete = async () => grant.complete(new URL((await grant.start()).url).searchParams.get('state')!,'code');
      const upstream = vi.spyOn(globalThis,'fetch');
      upstream.mockResolvedValueOnce(Response.json({...tokens,scope:''}));
      await expect(complete()).rejects.toThrow('device_oauth_scope');
      upstream.mockResolvedValueOnce(Response.json(tokens)).mockResolvedValueOnce(new Response('<html>Error</html>',{status:502}));
      await expect(complete()).rejects.toThrow('device_oauth_zone');
      upstream.mockResolvedValueOnce(Response.json(tokens)).mockResolvedValueOnce(Response.json({success:true,result:[]}))
        .mockResolvedValueOnce(Response.json({success:true,result:[zone]}));
      expect((await complete()).scopes.sort()).toEqual(['argotunnel.write','dns.write','zone.read']);
    });
  });
  it('模型申请绑定资源，管理台批准只执行一次，拒绝或过期均无写操作', async () => {
    await runInDurableObject(env.REGISTRY.getByName('main'), async (_instance, state) => {
      const management = new CloudflareManagement(state.storage.sql, async () => target);
      management.initialize();
      const writes: unknown[] = [];
      vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
        const req = new Request(input,init);
        if (new URL(req.url).pathname.endsWith('/workers/workers')) {
          const query = new URL(req.url).searchParams;
          expect(query.get('page')).toBe('2'); expect(query.get('per_page')).toBe('50');
          return Response.json({success:true,result:[{id:'worker-uuid',name:'my-worker'}]});
        }
        if (req.method === 'POST') { writes.push(await req.json()); return Response.json({success:true,result:{id:'ok'}}); }
        return Response.json({success:true,result:[{id:'dns-id',name:'a.example.test',type:'A',proxied:true,content:'private-value'}]});
      });
      expect(await management.inventory('workers',2)).toEqual([{id:'my-worker'}]);
      expect(JSON.stringify(await management.inventory('dns'))).not.toContain('private-value');
      await expect(management.propose({ action:'cache_purge', urls:['https://other.example/'] })).rejects.toThrow('device_invalid');
      await expect(management.propose({action:'dns_create', name:'demo.example.test',type:'AAAA',content:'invalid',proxied:false})).rejects.toThrow('device_invalid');
      const change = {action:'bucket_create' as const,name:'example-bucket'};
      const proposal = await management.propose(change);
      expect(management.list()[0].change).toEqual(change); expect(writes).toEqual([]);
      const answers = await Promise.allSettled([management.review(proposal.id,true),management.review(proposal.id,true)]);
      expect(answers.map(r=>r.status).sort()).toEqual(['fulfilled','rejected']); expect(writes).toEqual([{name:change.name}]);
      const rejected = await management.propose(change);
      await management.review(rejected.id,false); await expect(management.review(rejected.id,true)).rejects.toThrow('expired');
      const expired = await management.propose(change); management.invalidate();
      await expect(management.review(expired.id,true)).rejects.toThrow('expired');
      expect(writes).toHaveLength(1);
      const record = { action:'dns_create' as const,name:'demo.example.test',type:'A' as const,content:'192.0.2.1',proxied:false };
      const dns = await management.propose(record);
      await management.review(dns.id,true);
      expect(writes.at(-1)).toEqual({name:record.name,type:'A',content:record.content,proxied:false,ttl:1});
    });
  });
  it('只有回调可公开访问，浏览器二次提交和审批需要管理口令', async () => {
    const base = env.PUBLIC_ORIGIN + '/admin/cloudflare';
    for (const path of ['/start','/complete','/changes/' + crypto.randomUUID() + '/approve']) {
      expect((await worker.fetch(new Request(base + path, {method:'POST'}), adminEnv())).status).toBe(401);
    }
    const response = await worker.fetch(new Request(env.PUBLIC_ORIGIN + '/admin/devices/cloudflare/callback?state=' + 's'.repeat(43) + '&code=sample'),adminEnv());
    expect(response.status).toBe(303); expect(response.headers.get('location')).toMatch(/^\/admin\/#cloudflare\?/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe("model egress", () => {
  afterEach(async () => { await reset(); await abortAllDurableObjects(); vi.restoreAllMocks(); });
  
  it("requires admin authentication and probes fixed public targets from the owner DO without credentials", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input), headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual");
      expect(headers.has("Authorization")).toBe(false); expect(headers.has("Cookie")).toBe(false);
      if (url.includes("ipify")) return Response.json({ ip: "192.0.2.8", secret: "must-not-return" });
      if (url.includes("auth.openai")) return new Response("sensitive upstream error", { status: 403 });
      return new Response("ip=2a06:98c0:3600::103\nloc=GB\ncolo=LHR\nsecret=must-not-return\n", { headers: { "cf-ray": "example-LHR" } });
    });
    const call = (token: string) => worker.fetch(new Request("https://test/admin/diagnostics/model-egress", {
      method: "POST", headers: { Authorization: "Bearer " + token },
    }), { ...env, ADMIN_TOKEN: "synthetic-admin" });
    expect((await call("wrong")).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
    const response = await call("synthetic-admin"), result = await response.json<Awaited<ReturnType<typeof modelEgressDiagnostics>>>();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(result.executionContext).toBe("ThreadDO/owner"); expect(result.authenticatedOpenAIRequest).toBe(false);
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      "https://api.openai.com/cdn-cgi/trace", "https://auth.openai.com/cdn-cgi/trace",
      "https://www.cloudflare.com/cdn-cgi/trace", "https://api.ipify.org?format=json",
    ].sort());
    expect(result.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "openai-api", sharedWorkerAddress: true, country: "GB", colo: "LHR" }),
      expect.objectContaining({ target: "openai-auth", status: 403 }),
      expect.objectContaining({ target: "ipify", ip: "192.0.2.8" }),
    ]));
    expect(JSON.stringify(result)).not.toMatch(/must-not-return|sensitive upstream error/);
  });
  
  it("bounds diagnostic response bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("x".repeat(9000)));
    const result = await modelEgressDiagnostics();
    expect(result.probes).toHaveLength(4);
    expect(result.probes.every(probe => "error" in probe && probe.error === "body_limit")).toBe(true);
  });
});
