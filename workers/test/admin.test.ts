import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { snapshot } from "../src/requests/snapshot";
import type { Settings, SettingsSnapshot } from "../src/settings";
import { action, connect, event, input, reply, sendPrivate } from "./helpers";
import { fakeRemote, login } from "./mcp-helpers";

const TOKEN = "test-admin-only";
const sockets: WebSocket[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const socket of sockets.splice(0)) socket.close(); await reset(); });

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
    expect(html).toContain('data-view="sandbox"');
    expect(html).toContain('id="sandbox-toggle"');
    expect(html).toContain('id="sandbox-pair-create"');
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
    await expect.poll(() => env.THREAD.getByName("group:200000001").stats()).toMatchObject({ inbound: { done: 1 } });

    socket.send(JSON.stringify(replyToBot(2, "90000001")));
    await expect.poll(() => groupMessages()).toBe(3);
    expect(frames.filter(frame => (frame as { action?: string }).action === "send_group_msg")).toHaveLength(1);

    expect((await saveSettings({ groupTrigger: "mention_or_reply" })).applied).toBe(true);
    socket.send(JSON.stringify(replyToBot(3, "90000001")));
    const second = await action(frames, 1);
    expect(second.params.message?.[0]?.data.qq).toBe("10000004");
    reply(socket, second.echo, 90000002);
    await expect.poll(() => env.THREAD.getByName("group:200000001").stats()).toMatchObject({ inbound: { done: 2 } });

    await saveSettings({ allowGroups: [] });
    socket.send(JSON.stringify(event(4, "还在吗", 10000004, 200000001, true)));
    await expect.poll(() => env.BRIDGE.getByName("napcat").status()).toMatchObject({ ignored: 1 });
    expect(await groupMessages()).toBe(5);
  });

  it("reads extraction namespaces from saved settings in the Thread", async () => {
    await saveSettings({ extractNamespaces: ["group:200000001"] });
    const group = env.THREAD.getByName("group:200000001");
    expect(await group.submit(input(1, "本群偏好".repeat(30), 10000004, 200000001, true))).toEqual({ status: "done" });
    expect((await group.stats()).memory.extractQueue).toBe(1);
    const owner = env.THREAD.getByName("owner");
    expect(await owner.submit(input(2, "主人偏好".repeat(30), 10000001))).toEqual({ status: "done" });
    expect((await owner.stats()).memory.extractQueue).toBe(0);
  });
});

describe("admin data views", () => {
  type EventPage = { events: { id: number; at: number; kind: string; detail: Record<string, unknown> }[]; next?: number };

  it("defaults admin data pages to ten and returns the remaining row on the next page", async () => {
    const owner = env.THREAD.getByName("owner"), store = env.REQUESTS.getByName("main"), at = Date.now() - 1000;
    await owner.stats();
    await runInDurableObject(owner, (_instance, state) => {
      for (let i = 0; i < 11; i++) state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", at + i, "mcp_call", JSON.stringify({ tool: "tool" + i }));
    });
    const eventPage = await adminJson<EventPage>("GET", "/admin/events?thread=owner&kind=mcp_call");
    expect(eventPage.events).toHaveLength(10);
    expect(eventPage.next).toBeDefined();
    const eventTail = await adminJson<EventPage>("GET", "/admin/events?thread=owner&kind=mcp_call&before=" + eventPage.next);
    expect(eventTail.events.map(e => e.detail.tool)).toEqual(["tool0"]);
    expect(eventTail.next).toBeUndefined();

    const memories = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, ns: "owner", kind: "fact", text: "分页记录" + i, author: "dashboard", updated_at: 1_700_000_000 + i }));
    await adminJson("POST", "/admin/memory/import", { ns: "owner", memories });
    type MemoryPage = { items: { id: number }[]; page: number; limit: number; total: number };
    const memoryPage = await adminJson<MemoryPage>("GET", "/admin/memory/list?ns=owner");
    expect(memoryPage).toMatchObject({ page: 1, limit: 10, total: 11 });
    expect(memoryPage.items.map(m => m.id)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect((await adminJson<MemoryPage>("GET", "/admin/memory/list?ns=owner&page=2")).items.map(m => m.id)).toEqual([1]);

    const ids = Array.from({ length: 11 }, () => crypto.randomUUID());
    for (const id of ids) await store.record({ request: {
      id, startedAt: at, endedAt: at + 10, thread: "owner", actor: "thread", purpose: "conversation", provider: "faux", model: "test",
      status: "done", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, durationMs: 10, contextWindow: 1000,
    }, context: snapshot({ messages: [] }) });
    type RequestPage = Awaited<ReturnType<typeof store.list>>;
    const requestPage = await adminJson<RequestPage>("GET", "/admin/requests");
    expect(requestPage.requests.map(r => r.id)).toEqual(ids.slice(1).reverse());
    expect(requestPage.next).toBeDefined();
    const requestTail = await adminJson<RequestPage>("GET", "/admin/requests?before=" + requestPage.next);
    expect(requestTail.requests.map(r => r.id)).toEqual([ids[0]]);
    expect(requestTail.next).toBeUndefined();
  });

  it("pages audit events by rowid and filters by kind and result", async () => {
    const owner = env.THREAD.getByName("owner");
    await owner.stats();
    const rows: [string, object][] = [
      ["mcp_call", { server: "notion", tool: "a", result: "ok" }], ["mcp_catalog", { server: "notion", status: "error", code: "auth_required" }],
      ["memory_extract", { status: "skipped", reason: "too_short" }], ["mcp_call", { server: "notion", tool: "b", result: "outcome_unknown" }],
      ["mcp_catalog", { server: "notion", status: "ok", tools: 3 }], ["mcp_call", { server: "notion", tool: "c", result: "ok" }],
      ["memory_write", { tool: "mem_remember", written: 1 }],
    ];
    await runInDurableObject(owner, (_instance, state) => {
      rows.forEach(([kind, detail], i) => state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", 1_700_000_000_000 + i, kind, JSON.stringify(detail)));
    });
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
    await owner.stats();
    const rows: [string, object][] = [
      ["web_search", { result: "ok", ms: 900, results: 5 }], ["coding_exec", { result: "ok", commandLength: 12, code: 0, ms: 40 }],
      ["web_search", { result: "not_searched", ms: 700, results: 0 }], ["coding_exec", { result: "timeout", commandLength: 30, code: null, ms: 60_000 }],
    ];
    await runInDurableObject(owner, (_instance, state) => {
      rows.forEach(([kind, detail], i) => state.storage.sql.exec("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", 1_700_000_000_000 + i, kind, JSON.stringify(detail)));
    });
    const page = (query: string) => adminJson<EventPage>("GET", `/admin/events?thread=owner&${query}`);
    expect((await page("result=ok")).events.map(e => [e.kind, e.detail.result])).toEqual([["coding_exec", "ok"], ["web_search", "ok"]]);
    expect((await page("kind=web_search&result=not_searched")).events.map(e => e.detail.results)).toEqual([0]);
    expect((await page("kind=coding_exec&result=timeout")).events.map(e => e.detail.commandLength)).toEqual([30]);
    expect((await page("kind=coding_exec&result=not_searched")).events).toEqual([]);
  });

  it("lists, forgets and CAS-edits memory of one namespace", async () => {
    const memories = [
      { id: 11, ns: "owner", kind: "fact", text: "喜欢烟雾弹", author: "dashboard", updated_at: 1_700_000_100 },
      { id: 12, ns: "owner", kind: "preference", text: "群里只在被 @ 时回复", author: "owner", updated_at: 1_700_000_300 },
      { id: 13, ns: "owner", kind: "fact", text: "常用闪光弹", author: "extractor", updated_at: 1_700_000_200 },
    ];
    await adminJson("POST", "/admin/memory/import", { ns: "owner", profile: { text: "初始画像" }, memories });
    type View = { profile: { text: string; revision: string }; memories: { id: number; status: string }[] };
    const view = await adminJson<View>("GET", "/admin/memory?ns=owner");
    expect(view.memories.map(row => row.id)).toEqual([12, 13, 11]);
    expect(view.profile.text).toBe("初始画像");
    expect((await adminJson<View>("GET", "/admin/memory?ns=owner&q=" + encodeURIComponent("烟雾弹"))).memories.map(row => row.id)).toEqual([11]);
    expect((await adminJson<View>("GET", "/admin/memory?ns=owner&q=%2313")).memories.map(row => row.id)).toEqual([13]);

    expect(await adminJson("DELETE", "/admin/memory/12?ns=owner")).toEqual({ status: "forgotten" });
    expect((await adminJson<View>("GET", "/admin/memory?ns=owner")).memories.map(row => row.id)).toEqual([13, 11]);
    expect((await env.THREAD.getByName("owner").stats()).memory.active).toBe(2);
    expect((await admin("DELETE", "/admin/memory/999?ns=owner")).status).toBe(404);
    expect((await adminJson<View>("GET", "/admin/memory?ns=private:10000003")).memories).toEqual([]);

    const saved = await adminJson<{ profile: { text: string; revision: string } }>("PUT", "/admin/memory/profile", { ns: "owner", text: "新画像", expected: view.profile.revision });
    expect(saved.profile.text).toBe("新画像");
    const conflict = await admin("PUT", "/admin/memory/profile", { ns: "owner", text: "旧页面的画像", expected: view.profile.revision });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "conflict", current: saved.profile });
    expect((await admin("PUT", "/admin/memory/profile", { ns: "owner", text: "token=synthetic-only", expected: saved.profile.revision })).status).toBe(400);
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

  it("returns stats for every thread and isolates a failing Thread DO", async () => {
    await runInDurableObject(env.BRIDGE.getByName("napcat"), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO threads(key, seen_at) VALUES ('group:200000001', 2), ('group:200000002', 1)");
      await state.storage.put("group:200000001", { name: "测试群", expires: Date.now() + 60_000 });
    });
    await env.THREAD.getByName("group:200000001").ingest(input(1, "普通聊天", 10000004, 200000001));
    await runInDurableObject(env.THREAD.getByName("group:200000002"), (_instance, state) => { state.storage.sql.exec("CREATE TABLE memories (broken TEXT)"); });

    const response = await admin("GET", "/admin/overview");
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(JSON.parse(raw)).toMatchObject({ commit: "dev", bridge: { connected: false }, model: { provider: "faux", id: "test" }, sendRules: [],
      mcp: expect.arrayContaining([
        expect.objectContaining({ server: "notion", tools: 0 }),
        expect.objectContaining({ server: "cs2-workshop", enabled: true, credential: "static", login: "unconfigured", tools: 0 }),
      ]), configured: { ADMIN_TOKEN: true, OAUTH_STORE_KEY: true, DEEPSEEK_API_KEY: false },
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
    expect((await thread.stats()).inbound.queued).toBe(1);
    expect(pending.action).toBe("send_group_msg");
    expect(await adminJson("POST", "/admin/threads/group%3A200000001/stop")).toEqual({ stopped: true });
    reply(socket, pending.echo);
    expect(await turn).toEqual({ status: "failed" });
    expect((await thread.stats()).inbound).toEqual({ queued: 0, done: 0, failed: 1 });
    expect(await adminJson("POST", "/admin/threads/group:200000001/stop")).toEqual({ stopped: false });
  });
});
