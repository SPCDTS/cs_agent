import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { authenticated } from "../auth";
import type { Env } from "../env";
import { parseImport } from "../memory/import";
import { oauthErrorCode } from "../mcp/oauth-fetch";
import { ModelSelectionSchema, QQ_ID, SettingsSchema, type Settings } from "../settings";
import { modelLoginErrorCode } from "../codex-login";
import type { EventQuery } from "../thread";
import { ADMIN_APP_JS, ADMIN_PAGE_HTML } from "./page";

export type AdminContext = { env: Env; request: Request; url: URL; params: Record<string, string> };
export type AdminRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string | RegExp;
  // 只有静态页面与脚本不需要口令；它们不含任何数据，数据都经带 Bearer 的接口取得。
  public?: true;
  handle(ctx: AdminContext): Promise<Response>;
};

const API_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const THREAD_KEY = `owner|group:${QQ_ID}|private:${QQ_ID}`;
const MEMORY_NS = new RegExp(`^(owner|group:${QQ_ID})$`);
const SERVER = "[A-Za-z][A-Za-z0-9_-]{0,63}";
const SOURCE = "[A-Za-z][A-Za-z0-9_:-]{0,63}";
const strict = { additionalProperties: false } as const;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: object = {}) { super(code); }
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: API_HEADERS });
const plain = (body: string, status: number) => new Response(body, { status, headers: { ...API_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });

async function body<T extends TSchema>(request: Request, schema: T): Promise<Static<T>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new HttpError(400, "invalid_json"); }
  if (!Check(schema, value)) throw new HttpError(400, "invalid_request");
  return value;
}
function memoryNs(url: URL): string {
  const ns = url.searchParams.get("ns") ?? "";
  if (!MEMORY_NS.test(ns)) throw new HttpError(400, "invalid_namespace");
  return ns;
}
async function oauth<T>(work: () => Promise<T>): Promise<Response> {
  try { return json(await work()); } catch (error) { throw new HttpError(400, oauthErrorCode(error)); }
}
function eventQuery(url: URL): { thread: string; query: EventQuery } {
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  const thread = get("thread") ?? "owner", kind = get("kind"), result = get("result"), before = get("before"), limit = get("limit") ?? "50";
  if (!new RegExp(`^(${THREAD_KEY})$`).test(thread) || [kind, result].some(value => value !== undefined && !/^[a-z_]{1,32}$/.test(value))
    || (before !== undefined && !/^\d{1,15}$/.test(before)) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
    throw new HttpError(400, "invalid_query");
  }
  return { thread, query: { kind, result, before: before === undefined ? undefined : Number(before), limit: Number(limit) } };
}
const threadKind = (key: string) => key === "owner" ? "owner" : key.startsWith("group:") ? "group" : "private";
async function putSettings(env: Env, value: Settings, expectedRevision: string) {
  const result = await env.REGISTRY.getByName("main").putSettings(value, expectedRevision);
  if (!result.ok && result.error === "conflict") throw new HttpError(409, "conflict", { current: result.current });
  if (!result.ok) throw new HttpError(400, "invalid_model", { reason: result.reason });
  return result.current;
}
async function modelLogin<T>(work: () => Promise<T>): Promise<Response> {
  try { return json(await work()); } catch (error) { throw new HttpError(400, modelLoginErrorCode(error)); }
}

const SECRET_NAMES = ["ADMIN_TOKEN", "NAPCAT_TOKEN", "QQ_OWNER", "QQ_ALLOW_USERS", "QQ_ALLOW_GROUPS", "OAUTH_STORE_KEY", "DEEPSEEK_API_KEY"] as const;

export const ADMIN_ROUTES: AdminRoute[] = [
  { method: "GET", path: "/admin", public: true, handle: async () => new Response(null, { status: 308, headers: { ...API_HEADERS, Location: "/admin/" } }) },
  { method: "GET", path: "/admin/", public: true,
    handle: async () => new Response(ADMIN_PAGE_HTML, { headers: { ...API_HEADERS, "Content-Security-Policy": CSP, "Content-Type": "text/html; charset=utf-8" } }) },
  { method: "GET", path: "/admin/app.js", public: true,
    handle: async () => new Response(ADMIN_APP_JS, { headers: { ...API_HEADERS, "Content-Security-Policy": CSP, "Content-Type": "text/javascript; charset=utf-8" } }) },

  { method: "GET", path: "/admin/overview", handle: async ({ env }) => {
    const bridge = env.BRIDGE.getByName("napcat"), owner = env.THREAD.getByName("owner"), registry = env.REGISTRY.getByName("main");
    const [status, list, model, accounts, counts] = await Promise.all([
      bridge.status(), bridge.threadList(), registry.modelStatus(), registry.status(), owner.mcpToolCounts(),
    ]);
    const { threads: _keys, sendRules, ...connection } = status;
    // owner 线程总是列出，Bridge 还没见过 owner 私聊时也能从面板查看它的事件与记忆。
    const keys = list.some(thread => thread.key === "owner") ? list : [{ key: "owner", seenAt: 0, name: undefined }, ...list];
    // 单个 Thread 失败只标记该行，不能拖垮整页。
    const threads = await Promise.all(keys.map(async ({ key, name, seenAt }) => {
      let stats;
      try { stats = await env.THREAD.getByName(key).stats(); } catch { stats = { error: "unavailable" as const }; }
      return { key, ...(name ? { name } : {}), kind: threadKind(key), seenAt, stats };
    }));
    return json({ commit: env.CS_AGENT_COMMIT, bridge: connection, model, sendRules, threads,
      mcp: accounts.map(account => ({ ...account, tools: counts[account.server] ?? 0 })),
      configured: Object.fromEntries(SECRET_NAMES.map(name => [name, !!env[name]])) });
  } },

  { method: "GET", path: "/admin/schedules", handle: async ({ env }) => json(await env.SCHEDULE.getByName("main").list()) },
  { method: "POST", path: /^\/admin\/schedules\/(?<id>[0-9a-f-]{36})\/(?<action>pause|resume|delete|run-now)$/, handle: async ({ env, params }) => {
    const schedules = env.SCHEDULE.getByName("main"), id = params.id!, action = params.action!;
    if (!(await schedules.list()).some(schedule => schedule.id === id)) throw new HttpError(404, "not_found");
    try {
      if (action === "delete") { await schedules.remove(id, "admin"); return json({ deleted: id }); }
      if (action === "run-now") return json(await schedules.runNow(id, "admin"));
      return json(await schedules.setStatus(id, action === "pause" ? "paused" : "active", undefined, "admin"));
    } catch (error) {
      // ScheduleDO 的错误是自己的固定分类文本（如 overlap、paused），不含用户正文。
      throw new HttpError(400, error instanceof Error ? error.message.slice(0, 200) : "failed");
    }
  } },

  // 外部事件来源；/admin/events 已是线程审计事件，这里另起前缀。
  { method: "GET", path: "/admin/event-sources", handle: async ({ env }) => json(await env.EVENTS.getByName("main").adminStatus()) },
  { method: "POST", path: new RegExp(`^/admin/event-sources/(?<source>${SOURCE})/(?<action>pause|resume)$`), handle: async ({ env, params }) => {
    if (!await env.EVENTS.getByName("main").setPaused(params.source!, params.action === "pause")) throw new HttpError(404, "not_found");
    return json({ ok: true });
  } },
  { method: "PUT", path: new RegExp(`^/admin/event-sources/(?<source>${SOURCE})/settings$`), handle: async ({ env, request, params }) => {
    let value: unknown;
    try { value = await request.json(); } catch { throw new HttpError(400, "invalid_json"); }
    const result = await env.EVENTS.getByName("main").putSettings(params.source!, value);
    if (result === "unknown_source") throw new HttpError(404, "not_found");
    if (result === "invalid") throw new HttpError(400, "invalid_settings");
    return json({ ok: true });
  } },

  { method: "GET", path: "/admin/settings", handle: async ({ env }) => json(await env.REGISTRY.getByName("main").settings()) },
  { method: "PUT", path: "/admin/settings", handle: async ({ env, request }) => {
    const { value, expectedRevision } = await body(request, Type.Object({ value: SettingsSchema, expectedRevision: Type.String({ pattern: "^[0-9a-f]{16}$" }) }, strict));
    const current = await putSettings(env, value, expectedRevision);
    let applied = false;
    try { applied = await env.BRIDGE.getByName("napcat").reloadSettings() === current.revision; }
    catch { console.error({ event: "settings_reload_failed" }); }
    return json({ ...current, applied });
  } },

  // 模型选择是设置的一项，共用 revision 做 CAS；Thread 在下一批接纳输入时读新值，Bridge 不用它。
  { method: "GET", path: "/admin/model", handle: async ({ env }) => json(await env.REGISTRY.getByName("main").modelView()) },
  { method: "PUT", path: "/admin/model", handle: async ({ env, request }) => {
    const { model, expectedRevision } = await body(request, Type.Object({ model: ModelSelectionSchema, expectedRevision: Type.String({ pattern: "^[0-9a-f]{16}$" }) }, strict));
    const registry = env.REGISTRY.getByName("main");
    await putSettings(env, { ...(await registry.settings()).value, model }, expectedRevision);
    return json(await registry.modelView());
  } },
  // ChatGPT 订阅登录：回调地址是 localhost:1455，浏览器打不开，用户把整串地址贴回来。错误只回分类。
  { method: "POST", path: "/admin/model/oauth/codex/start", handle: ({ env }) => modelLogin(() => env.REGISTRY.getByName("main").codexLoginStart()) },
  { method: "POST", path: "/admin/model/oauth/codex/complete", handle: async ({ env, request }) => {
    const { callbackUrl } = await body(request, Type.Object({ callbackUrl: Type.String({ minLength: 1, maxLength: 16384 }) }, strict));
    return modelLogin(async () => ({ loggedIn: true, ...await env.REGISTRY.getByName("main").codexLoginComplete(callbackUrl) }));
  } },
  { method: "POST", path: "/admin/model/oauth/codex/logout",
    handle: ({ env }) => modelLogin(async () => { await env.REGISTRY.getByName("main").codexLogout(); return { ok: true }; }) },

  { method: "GET", path: "/admin/events", handle: async ({ env, url }) => {
    const { thread, query } = eventQuery(url);
    return json(await env.THREAD.getByName(thread).events(query));
  } },
  { method: "POST", path: new RegExp(`^/admin/threads/(?<key>${THREAD_KEY})/stop$`),
    handle: async ({ env, params }) => json(await env.THREAD.getByName(params.key).stop()) },

  { method: "GET", path: "/admin/memory", handle: async ({ env, url }) => {
    const ns = memoryNs(url), q = url.searchParams.get("q") ?? "";
    if (q.length > 200) throw new HttpError(400, "invalid_query");
    return json(await env.THREAD.getByName(ns).memoryView(ns, q));
  } },
  { method: "DELETE", path: /^\/admin\/memory\/(?<id>[1-9]\d{0,14})$/, handle: async ({ env, url, params }) => {
    const ns = memoryNs(url), result = await env.THREAD.getByName(ns).forgetMemory(ns, Number(params.id));
    if (result.status === "not_found") throw new HttpError(404, "not_found");
    return json(result);
  } },
  { method: "PUT", path: "/admin/memory/profile", handle: async ({ env, request }) => {
    const { ns, text, expected } = await body(request, Type.Object({ ns: Type.String({ pattern: MEMORY_NS.source }),
      text: Type.String({ maxLength: 8192 }), expected: Type.String({ maxLength: 64 }) }, strict));
    const result = await env.THREAD.getByName(ns).writeProfile(ns, text, expected);
    if (result.status === "invalid") throw new HttpError(400, "invalid_profile", { reason: result.reason });
    if (result.status === "conflict") throw new HttpError(409, "conflict", { current: result.current });
    return json({ profile: result.current });
  } },
  { method: "POST", path: "/admin/memory/import", handle: async ({ env, request }) => {
    let data;
    try { data = parseImport(await request.json()); }
    catch { return json({ error: "invalid memory import" }, 400); }
    return json(await env.THREAD.getByName(data.ns).importMemory(data));
  } },

  // 旧路径保留纯文本错误分类，已有脚本与文档按它解析。
  { method: "POST", path: "/admin/mcp/oauth/login-link", handle: async ({ env, request }) => {
    try {
      const value: unknown = await request.json();
      if (!Check(Type.Object({ server: Type.String({ pattern: `^${SERVER}$` }) }, strict), value)) throw new Error("invalid_request");
      return json(await env.REGISTRY.getByName("main").loginLink(value.server));
    } catch (error) { return plain(oauthErrorCode(error), 400); }
  } },
  { method: "POST", path: new RegExp(`^/admin/mcp/(?<server>${SERVER})/login-link$`),
    handle: ({ env, params }) => oauth(() => env.REGISTRY.getByName("main").loginLink(params.server)) },
  { method: "POST", path: new RegExp(`^/admin/mcp/(?<server>${SERVER})/logout$`),
    handle: ({ env, params }) => oauth(async () => { await env.REGISTRY.getByName("main").logout(params.server); return { ok: true }; }) },
  { method: "POST", path: new RegExp(`^/admin/mcp/(?<server>${SERVER})/refresh$`), handle: async ({ env }) => {
    try { return json({ results: await env.THREAD.getByName("owner").refreshMcp() }); }
    catch { throw new HttpError(503, "unavailable"); }
  } },

  { method: "POST", path: "/admin/send-rules/release", handle: async ({ env, request }) => {
    const { scope } = await body(request, Type.Object({ scope: Type.String({ pattern: `^(global|group:${QQ_ID}|private:${QQ_ID})$` }) }, strict));
    return json(await env.BRIDGE.getByName("napcat").releaseSendRule(scope));
  } },
];

function match(path: string | RegExp, actual: string): Record<string, string> | undefined {
  if (typeof path === "string") return path === actual ? {} : undefined;
  const found = path.exec(actual);
  return found ? { ...found.groups } : undefined;
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return plain("not found", 404); }
  for (const route of ADMIN_ROUTES) {
    const params = route.method === request.method ? match(route.path, path) : undefined;
    if (!params) continue;
    if (!route.public && !await authenticated(request, env.ADMIN_TOKEN)) return plain("unauthorized", 401);
    try { return await route.handle({ env, request, url, params }); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, ...error.extra }, error.status);
      // 原始异常可能带存储或远端内容，只记录路由。
      console.error({ event: "admin_failed", method: route.method, path: String(route.path), error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : typeof error });
      return json({ error: "internal" }, 500);
    }
  }
  return plain("not found", 404);
}
