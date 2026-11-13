import { readBounded, WebhookError, MAX_CONFIG_BYTES } from "../github/model";
import { readAdminCursor } from "./pagination";
import { healthReport } from "./health";
import { threadView, workspaceView } from "./read-views";
import { ADMIN_PAGE_SIZE } from "./pagination";
import { workspaceRoutes } from "./workspace-routes";
import { createMcpAdminRoutes } from "./mcp-routes";
import { MCP_SERVER_ROUTES } from "./mcp-servers-routes";
import { accessRoutes } from "./access-routes";
import { createMemoryAdminRoutes } from "./memory-routes";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { authenticated } from "../auth";
import type { Env } from "../env";
import { parseImport } from "../memory/import";
import { oauthErrorCode } from "../mcp/oauth-fetch";
import { ModelSelectionSchema, QQ_ID, SettingsSchema, type Settings } from "../settings";
import { modelLoginErrorCode, TokenResponseSchema } from "../codex-login";
import { catalogFailure } from "../codex-catalog-error";
import { refreshFailure } from "../codex-refresh-error";
import type { EventQuery } from "../thread";
import { SkillError, parseSkill } from "../skills";
import { MESSAGE_IMPORT_MAX_BYTES, importThreadKey, parseMessageImport } from "../message-import";
import { ownerIds } from "../policy";
import { SUBAGENT_ID } from "../subagent/model";
import { ADMIN_PAGE_HTML } from "./page";
import { ADMIN_APP_JS } from "./app.generated";
import { CHATGPT_HELPER } from "./chatgpt-helper";
import { SCHEDULE_IMPORT_MAX_BYTES } from "../schedule/import";
import type { RequestQuery } from "../requests/types";

export type AdminContext = { env: Env; request: Request; url: URL; params: Record<string, string> };
export type AdminRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string | RegExp;
  // 静态资源无需口令；bridge 路由在处理函数中校验短期配对票据。
  public?: true;
  handle(ctx: AdminContext): Promise<Response>;
};

const API_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const THREAD_KEY = `owner|group:${QQ_ID}|private:${QQ_ID}`;
const MEMORY_NS = new RegExp(`^(owner|(?:group|private):${QQ_ID})$`);
const SERVER = "[A-Za-z][A-Za-z0-9_-]{0,63}";
const SOURCE = "[A-Za-z][A-Za-z0-9_:-]{0,63}";
const SKILL = "[^/]{1,128}";
const strict = { additionalProperties: false } as const;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: object = {}) { super(code); }
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: API_HEADERS });
const plain = (body: string, status: number) => new Response(body, { status, headers: { ...API_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });

// Plain result envelopes preserve classification across DO RPC serialization.
async function githubConnectResponse<T>(operation: "start" | "complete",
  work: (requestId: string) => Promise<import("../github/connect-diagnostics").ConnectResult<T>>): Promise<Response> {
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    const result = await work(requestId);
    response = result.ok ? json(result.value) : json({ error: result.code, requestId: result.requestId }, result.status);
  } catch {
    // Constructor/RPC failures happen before the DO boundary. Do not inspect their message.
    console.error({ event: "github_connect_failed", requestId, operation, stage: "rpc", code: "internal", status: 500 });
    response = json({ error: "internal", requestId }, 500);
  }
  response.headers.set("X-Request-ID", requestId);
  return response;
}

const PAIRING_BODY_MAX_BYTES = 64 * 1024;
async function limitedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    await request.body?.cancel();
    throw new HttpError(413, "request_too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_json");
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new HttpError(413, "request_too_large");
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function body<T extends TSchema>(request: Request, schema: T, maxBytes?: number): Promise<Static<T>> {
  let value: unknown;
  try { value = await (maxBytes === undefined ? request.json() : limitedJson(request, maxBytes)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "invalid_json"); }
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
  const thread = get("thread") ?? "owner", kind = get("kind"), result = get("result"), before = get("before"), limit = get("limit") ?? String(ADMIN_PAGE_SIZE);
  if (!new RegExp(`^(${THREAD_KEY})$`).test(thread) || [kind, result].some(value => value !== undefined && !/^[a-z_]{1,32}$/.test(value))
    || (before !== undefined && !/^\d{1,15}$/.test(before)) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
    throw new HttpError(400, "invalid_query");
  }
  return { thread, query: { kind, result, before: before === undefined ? undefined : Number(before), limit: Number(limit) } };
}
// 子 agent 的 DO 名字含父线程键，按 id 定位要带上它。
function threadParam(url: URL): string {
  const thread = url.searchParams.get("thread") ?? "";
  if (!new RegExp(`^(${THREAD_KEY})$`).test(thread)) throw new HttpError(400, "invalid_thread");
  return thread;
}
const threadKind = (key: string) => key === "owner" ? "owner" : key.startsWith("group:") ? "group" : "private";
async function putSettings(env: Env, value: Settings, expectedRevision: string) {
  const result = await env.REGISTRY.getByName("main").putSettings(value, expectedRevision);
  if (!result.ok && result.error === "conflict") throw new HttpError(409, "conflict", { current: result.current });
  if (!result.ok) throw new HttpError(400, "invalid_model", { reason: result.reason });
  return result.current;
}
function pairingTicket(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) throw new HttpError(401, "invalid_state");
  return match[1]!;
}
async function modelLogin<T>(work: () => Promise<T>): Promise<Response> {
  try { return json(await work()); } catch (error) { throw new HttpError(400, modelLoginErrorCode(error), { diagnostic: catalogFailure(error) ?? refreshFailure(error) }); }
}

function requestQuery(url: URL): RequestQuery {
  const p = url.searchParams, now = Date.now();
  const num = (key: string, fallback: number) => {
    const raw = p.get(key); if (raw !== null && !/^\d{1,16}$/.test(raw)) throw new HttpError(400, "invalid_query");
    const n = raw === null ? fallback : Number(raw); if (!Number.isSafeInteger(n)) throw new HttpError(400, "invalid_query"); return n;
  };
  const since = num("since", now - 86400_000), until = num("until", now), limit = num("limit", ADMIN_PAGE_SIZE), before = num("before", 0);
  const thread = p.get("thread") || undefined, model = p.get("model") || undefined, status = p.get("status") || undefined, purpose = p.get("purpose") || undefined, turnId = p.get("turn") || undefined;
  if (until < since || until - since > 31 * 86400_000 || limit < 1 || limit > 100 ||
    thread && !new RegExp("^(" + THREAD_KEY + ")$").test(thread) || model && model.length > 200 ||
    status && !["running", "done", "error", "aborted", "interrupted"].includes(status) ||
    purpose && !["conversation", "background", "subagent", "compaction"].includes(purpose) || turnId && (!thread || !/^turn:[A-Za-z0-9:_-]{1,180}$/.test(turnId))) throw new HttpError(400, "invalid_query");
  return { since, until, limit, ...(before ? { before } : {}), thread, model, status: status as RequestQuery["status"], purpose, turnId };
}
async function knownThread(env: Env, key: string) {
  if (key !== "owner" && !(await env.BRIDGE.getByName("napcat").threadList()).some(t => t.key === key)) throw new HttpError(404, "not_found");
  return env.THREAD.getByName(key);
}

async function knownView(env: Env, key: string) {
  if (key !== "owner" && !(await env.BRIDGE.getByName("napcat").threadList()).some(t => t.key === key)) throw new HttpError(404, "not_found");
  return threadView(env, key);
}

const SECRET_NAMES = ["ADMIN_TOKEN", "NAPCAT_TOKEN", "QQ_OWNER", "QQ_ALLOW_USERS", "QQ_ALLOW_GROUPS", "OAUTH_STORE_KEY", "DEEPSEEK_API_KEY"] as const;

export const ADMIN_ROUTES: AdminRoute[] = [
  { method: "GET", path: "/admin/health", handle: async ({ env }) => json(await healthReport(env)) },
  ...MCP_SERVER_ROUTES,
  ...accessRoutes(),
  ...workspaceRoutes({forThread:async(thread,ctx)=>{
    const stub=ctx.env.THREAD.getByName(thread), view=workspaceView(ctx.env,thread);
    return {list:()=>view.list(),download:input=>view.download(input),
      resetRuntime:()=>stub.workspaceResetRuntime(thread),inspectChild:input=>view.inspectChild(input),mergeChild:input=>stub.workspaceMergeChild(thread,input)};
  }}),
  ...createMcpAdminRoutes((ctx, scope) => ctx.env.THREAD.getByName(scope), (ctx, scope) => threadView(ctx.env, scope)),
  ...createMemoryAdminRoutes((ctx, ns) => ctx.env.THREAD.getByName(ns), (ctx, ns) => threadView(ctx.env, ns)),

  { method: "GET", path: new RegExp("^/admin/threads/(?<key>" + THREAD_KEY + ")/history$"), handle: async ({ env, params, url }) => {
    try { return json(await (await knownView(env, params.key!)).sessionHistory(params.key!, url.searchParams.get("cursor") ?? undefined)); }
    catch (error) { if (error instanceof Error && error.message.includes("invalid_cursor")) throw new HttpError(400, "invalid_cursor"); throw error; }
  } },
  { method: "POST", path: new RegExp("^/admin/threads/(?<key>" + THREAD_KEY + ")/reset$"), handle: async ({ env, params, request }) => {
    const value = await body(request, Type.Object({ requestId: Type.String({ format: "uuid" }), label: Type.String({ maxLength: 200 }) }, strict));
    const result = await (await knownThread(env, params.key!)).resetSession(params.key!, value.requestId, value.label);
    return json(result, "error" in result ? 409 : 200);
  } },
  { method: "POST", path: new RegExp("^/admin/threads/(?<key>" + THREAD_KEY + ")/compact$"), handle: async ({ env, params, request }) => {
    const value = await body(request, Type.Object({ instructions: Type.Optional(Type.String({ maxLength: 2000 })) }, strict));
    const result = await (await knownThread(env, params.key!)).compactSession(params.key!, value.instructions);
    return json(result, "error" in result ? 409 : 202);
  } },

  { method: "GET", path: "/admin", public: true, handle: async () => new Response(null, { status: 308, headers: { ...API_HEADERS, Location: "/admin/" } }) },
  { method: "GET", path: "/admin/", public: true,
    handle: async () => new Response(ADMIN_PAGE_HTML, { headers: { ...API_HEADERS, "Content-Security-Policy": CSP, "Content-Type": "text/html; charset=utf-8" } }) },
  { method: "GET", path: "/admin/app.js", public: true,
    handle: async () => new Response(ADMIN_APP_JS, { headers: { ...API_HEADERS, "Content-Security-Policy": CSP, "Content-Type": "text/javascript; charset=utf-8" } }) },

  { method: "POST", path: "/admin/diagnostics/model-egress", handle: async ({ env }) => json(await env.THREAD.getByName("owner").modelEgressDiagnostics()) },
  { method: "GET", path: "/admin/requests", handle: async ({ env, url }) => json(await env.REQUESTS.getByName("main").list(requestQuery(url))) },
  { method: "GET", path: "/admin/context-timeline", handle: async ({ env, url }) => {
    const thread = threadParam(url), actor = url.searchParams.get("actor") ?? "thread";
    if (actor !== "thread" && !/^[0-9a-f-]{36}$/.test(actor)) throw new HttpError(400, "invalid_actor");
    let cursor; try { cursor = readAdminCursor(url); } catch { throw new HttpError(400, "invalid_cursor"); }
    return json(await env.REQUESTS.getByName("main").contextTimeline(thread, actor, cursor));
  } },
  { method: "GET", path: /^\/admin\/tools\/(?<id>[0-9a-f-]{36})\/execution$/, handle: async ({ env, params }) => {
    const execution = await env.REQUESTS.getByName("main").toolExecution(params.id!);
    if (!execution) throw new HttpError(404, "not_found");
    return json(execution);
  } },
  { method: "GET", path: /^\/admin\/requests\/(?<id>[0-9a-f-]{36})\/context$/, handle: async ({ env, params }) => {
    const inspection = await env.REQUESTS.getByName("main").contextInspection(params.id!);
    if (!inspection) throw new HttpError(404, "not_found");
    return json(inspection);
  } },
  { method: "GET", path: /^\/admin\/requests\/(?<id>[0-9a-f-]{36})\/context\/(?<part>system|response|message:\d+|tool:\d+)$/, handle: async ({ env, params }) => {
    const part = await env.REQUESTS.getByName("main").contextPart(params.id!, params.part!);
    if (!part) throw new HttpError(404, "not_found");
    return json(part);
  } },
  { method: "GET", path: "/admin/agent-topology", handle: async ({ env }) => json(await env.REQUESTS.getByName("main").agentTopology()) },
  { method: "GET", path: "/admin/usage", handle: async ({ env, url }) => json(await env.REQUESTS.getByName("main").usage(requestQuery(url))) },
  { method: "GET", path: /^\/admin\/requests\/(?<id>[0-9a-f-]{36})$/, handle: async ({ env, params, url }) => {
    const detail = await env.REQUESTS.getByName("main").detail(params.id!, url.searchParams.get("summary") === "1");
    if (!detail) throw new HttpError(404, "not_found");
    return json(detail);
  } },
  { method: "GET", path: new RegExp("^/admin/threads/(?<key>" + THREAD_KEY + ")/chat$"), handle: async ({ env, params, url }) => {
    const after = url.searchParams.get("after"), pending = url.searchParams.getAll("pending");
    if (after !== null && (!/^\d{1,16}(?:\.\d+)?$/.test(after) || !Number.isFinite(Number(after))) || pending.length > 100 || pending.some(id => !/^(?:qq:\d+|web:[A-Za-z0-9-]+)$/.test(id))) throw new HttpError(400, "invalid_query");
    return json(await (await knownView(env, params.key!)).chatView(params.key!, after === null ? undefined : { after: Number(after), pending }));
  } },
  { method: "GET", path: new RegExp("^/admin/threads/(?<key>" + THREAD_KEY + ")/trace$"), handle: async ({ env, params, url }) => {
    const turns = url.searchParams.getAll("turn"), after = url.searchParams.get("after") ?? "0";
    if (turns.length > 100 || turns.some(turn => !/^turn:[A-Za-z0-9:_-]{1,180}$/.test(turn)) || !/^\d{1,15}$/.test(after)) throw new HttpError(400, "invalid_query");
    return json(await env.REQUESTS.getByName("main").turnTrace(params.key!, [...new Set(turns)], Number(after)));
  } },
  { method: "GET", path: /^\/admin\/tools\/(?<id>[0-9a-f-]{36})$/, handle: async ({ env, params }) => {
    const detail = await env.REQUESTS.getByName("main").toolDetail(params.id!);
    if (!detail) throw new HttpError(404, "not_found");
    return json(detail);
  } },
  { method: "POST", path: new RegExp("^/admin/threads/(?<key>" + THREAD_KEY + ")/chat$"), handle: async ({ env, request, params }) => {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > 68000) throw new HttpError(413, "too_large");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new HttpError(400, "invalid_json"); }
    const schema = Type.Object({ requestId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }), text: Type.String({ minLength: 1, maxLength: 16000 }) }, strict);
    if (!Check(schema, value) || !value.text.trim()) throw new HttpError(400, "invalid_request");
    const result = await (await knownThread(env, params.key!)).submitWeb(params.key!, value.requestId, value.text.trim());
    if ("error" in result) throw new HttpError(409, result.error!);
    return json(result, 202);
  } },

  { method: "GET", path: "/admin/overview", handle: async ({ env }) => {
    const bridge = env.BRIDGE.getByName("napcat"), owner = threadView(env, "owner"), registry = env.REGISTRY.getByName("main");
    const unavailable = () => ({ error: "unavailable" as const });
    // 定时与事件只给总览卡片一行小字，任一个 DO 出错都不能拖垮整页。
    const [status, list, model, accounts, counts, schedule, events] = await Promise.all([
      bridge.status(), bridge.threadList(), registry.modelStatus(), registry.status(), owner.mcpToolCounts().catch(() => null),
      env.SCHEDULE.getByName("main").status().catch(unavailable), env.EVENTS.getByName("main").health().catch(unavailable),
    ]);
    const { threads: _keys, sendRules, ...connection } = status;
    // owner 线程总是列出，Bridge 还没见过 owner 私聊时也能从面板查看它的事件与记忆。
    const keys = list.some(thread => thread.key === "owner") ? list : [{ key: "owner", seenAt: 0, name: undefined }, ...list];
    // 单个 Thread 失败只标记该行，不能拖垮整页。
    const threads = await Promise.all(keys.map(async ({ key, name, seenAt }) => {
      let stats;
      try { stats = await threadView(env, key).stats(); } catch (error) { stats = { error: error instanceof Error && error.message.includes("view_pending") ? "view_pending" : "unavailable" }; }
      // 主人与群会话各有独立 Linux 沙箱；读取状态不会启动容器。
      const sandbox = key === "owner" || key.startsWith("group:") ? await env.SANDBOX.getByName(key).status().catch(() => "unavailable" as const) : undefined;
      return { key, ...(name ? { name } : {}), kind: threadKind(key), seenAt, stats, ...(sandbox ? { sandbox } : {}) };
    }));
    return json({ commit: env.CS_AGENT_COMMIT, bridge: connection, model, sendRules, threads, schedule, events,
      mcp: accounts.map(account => ({ ...account, tools: counts === null ? null : counts[account.server] ?? 0 })),
      configured: Object.fromEntries(SECRET_NAMES.map(name => [name, !!env[name]])) });
  } },

  { method: "POST", path: "/admin/schedules/import", handle: async ({ env, request }) => {
    if (Number(request.headers.get("Content-Length") ?? 0) > SCHEDULE_IMPORT_MAX_BYTES) throw new HttpError(413, "too_large");
    const raw = await request.arrayBuffer();
    if (raw.byteLength > SCHEDULE_IMPORT_MAX_BYTES) throw new HttpError(413, "too_large");
    let input: unknown;
    try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new HttpError(400, "invalid_json"); }
    const result = await env.SCHEDULE.getByName("main").importSchedules(input);
    if (result.error) throw new HttpError(result.error === "schedule_conflict" ? 409 : 400, result.error);
    return json(result);
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

  { method: "POST", path: "/admin/github/capabilities/refresh", handle: async ({env}) => json(await env.EVENTS.getByName("main").refreshGitHubCapabilities(true)) },
  { method: "GET", path: "/admin/github/capabilities", handle: async ({env}) => json(await env.EVENTS.getByName("main").refreshGitHubCapabilities()) },
  { method: "GET", path: "/admin/github/connections", handle: async ({env}) => json(await env.EVENTS.getByName("main").githubConnectionsView()) },
  { method: "POST", path: "/admin/github/connect/start", handle: async ({env,request}) => {
    const v=await body(request,Type.Object({browser:Type.String({pattern:"^[a-f0-9]{64}$"})},strict));
    return githubConnectResponse("start",requestId => env.EVENTS.getByName("main").startGitHubConnect(env.ADMIN_TOKEN ?? "",v.browser,requestId));
  }},
  { method: "POST", path: "/admin/github/connect/complete", handle: async ({env,request}) => {
    const v=await body(request,Type.Object({browser:Type.String({pattern:"^[a-f0-9]{64}$"}),state:Type.String({maxLength:100}),code:Type.String({maxLength:512})},strict));
    return githubConnectResponse("complete",requestId => env.EVENTS.getByName("main").completeGitHubConnect(v.state,v.code,env.ADMIN_TOKEN ?? "",v.browser,requestId));
  }},
  { method: "POST", path: "/admin/github/connect/sync", handle: async ({env,request}) => {
    const v=await body(request,Type.Object({userId:Type.Optional(Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}))},strict));
    return json(await env.EVENTS.getByName("main").syncGitHubConnect(v.userId));
  }},
  { method: "POST", path: "/admin/github/connect/disconnect", handle: async ({env,request}) => {
    const v=await body(request,Type.Object({kind:Type.Union([Type.Literal("user"),Type.Literal("installation")]),id:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER})},strict));
    return json(await env.EVENTS.getByName("main").disconnectGitHubConnect(v.kind,v.id));
  }},

  { method: "GET", path: /^\/admin\/github\/receipts\/(?<id>[A-Za-z0-9-]{1,80})$/, handle: async ({ env, params }) => {
    const receipt = await env.EVENTS.getByName("main").githubReceipt(params.id!);
    if (!receipt) throw new HttpError(404, "not_found");
    return json(receipt);
  } },
  { method: "PUT", path: "/admin/github/config", handle: async ({ env, request }) => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(await readBounded(request, MAX_CONFIG_BYTES + 1024))); }
    catch (error) { throw new HttpError(error instanceof WebhookError ? error.status : 400, "invalid_request"); }
    if (!value || typeof value !== "object" || !("value" in value) || !("expectedRevision" in value)
      || typeof value.expectedRevision !== "string" || !/^[0-9]{1,16}$/.test(value.expectedRevision)) throw new HttpError(400, "invalid_request");
    const result = await env.EVENTS.getByName("main").putGitHubConfig(value.value, value.expectedRevision);
    if (!result.ok) throw new HttpError(result.error === "conflict" ? 409 : 400, result.error, "current" in result ? { current: result.current } : {});
    return json(result.current);
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
  { method: "GET", path: "/admin/model/oauth/codex/helper.mjs", public: true,
    handle: async () => new Response(CHATGPT_HELPER, { headers: { ...API_HEADERS, "Content-Type": "text/javascript; charset=utf-8",
      "Content-Disposition": 'attachment; filename="chatgpt-login.mjs"' } }) },
  { method: "POST", path: "/admin/model/oauth/codex/start", handle: async ({ env, request }) => {
    const { accountId } = await body(request, Type.Object({ accountId: Type.Optional(Type.String({ format: "uuid" })) }, strict));
    return modelLogin(() => env.REGISTRY.getByName("main").codexLoginStart(accountId));
  } },
  { method: "POST", path: "/admin/model/oauth/codex/bridge/begin", public: true, handle: async ({ env, request }) => {
    const ticket = pairingTicket(request);
    const { port } = await body(request, Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }) }, strict), PAIRING_BODY_MAX_BYTES);
    return modelLogin(() => env.REGISTRY.getByName("main").codexLoginBegin(ticket, port));
  } },
  { method: "POST", path: "/admin/model/oauth/codex/bridge/complete", public: true, handle: async ({ env, request }) => {
    const ticket = pairingTicket(request);
    const { callbackUrl, tokens } = await body(request, Type.Object({ callbackUrl: Type.String({ minLength: 1, maxLength: 16384 }), tokens: TokenResponseSchema }, strict), PAIRING_BODY_MAX_BYTES);
    return modelLogin(async () => await env.REGISTRY.getByName("main").codexLoginComplete(ticket, callbackUrl, tokens));
  } },
  { method: "POST", path: "/admin/model/oauth/codex/select", handle: async ({ env, request }) => {
    const { accountId } = await body(request, Type.Object({ accountId: Type.String({ format: "uuid" }) }, strict));
    return modelLogin(async () => { const registry = env.REGISTRY.getByName("main"); await registry.codexSelect(accountId); return registry.modelView(); });
  } },
  { method: "POST", path: "/admin/model/oauth/codex/catalog", handle: ({ env }) => modelLogin(async () => {
    const registry = env.REGISTRY.getByName("main"); await registry.codexRefreshCatalog(); return registry.modelView();
  }) },
  { method: "POST", path: "/admin/model/oauth/codex/logout",
    handle: ({ env }) => modelLogin(() => env.REGISTRY.getByName("main").codexLogout()) },

  { method: "GET", path: "/admin/events", handle: async ({ env, url }) => {
    const { thread, query } = eventQuery(url);
    return json(await threadView(env, thread).events(query));
  } },
  { method: "POST", path: new RegExp(`^/admin/threads/(?<key>${THREAD_KEY})/stop$`),
    handle: async ({ env, params }) => json(await env.THREAD.getByName(params.key).stop()) },
  { method: "GET", path: new RegExp(`^/admin/threads/(?<key>${THREAD_KEY})/subagents$`),
    handle: async ({ env, params }) => json(await threadView(env, params.key).subagentList()) },
  { method: "POST", path: new RegExp(`^/admin/subagents/(?<id>${SUBAGENT_ID})/cancel$`), handle: async ({ env, url, params }) => {
    const status = await env.THREAD.getByName(threadParam(url)).cancelSubagent(params.id);
    if (!status) throw new HttpError(404, "not_found");
    return json({ id: params.id, status });
  } },
  { method: "GET", path: new RegExp(`^/admin/subagents/(?<id>${SUBAGENT_ID})/history$`), handle: async ({ env, url, params }) => {
    try {
      const result = await threadView(env, threadParam(url)).subagentHistory(params.id, url.searchParams.get("cursor") ?? undefined);
      if (!result) throw new HttpError(404, "not_found");
      return json(result);
    } catch (error) { if (error instanceof Error && error.message.includes("invalid_cursor")) throw new HttpError(400, "invalid_cursor"); throw error; }
  } },
  { method: "GET", path: new RegExp(`^/admin/subagents/(?<id>${SUBAGENT_ID})/transcript$`), handle: async ({ env, url, params }) => {
    const limit = url.searchParams.get("limit") ?? "20";
    if (!/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50) throw new HttpError(400, "invalid_query");
    const result = await threadView(env, threadParam(url)).subagentTranscript(params.id, Number(limit));
    if (!result) throw new HttpError(404, "not_found");
    return json(result);
  } },
  { method: "POST", path: new RegExp(`^/admin/threads/(?<key>${THREAD_KEY})/sandbox/reset$`), handle: async ({ env, params }) => {
    try { return json(await env.SANDBOX.getByName(params.key!).reset()); }
    catch { throw new HttpError(503, "sandbox_unavailable"); }
  } },

  { method: "GET", path: "/admin/memory", handle: async ({ env, url }) => {
    const ns = memoryNs(url), q = url.searchParams.get("q") ?? "";
    if (q.length > 200) throw new HttpError(400, "invalid_query");
    return json(await threadView(env, ns).memoryView(ns, q));
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
  { method: "POST", path: "/admin/messages/import", handle: async ({ env, request }) => {
    if (Number(request.headers.get("Content-Length") ?? 0) > MESSAGE_IMPORT_MAX_BYTES) throw new HttpError(413, "too_large");
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MESSAGE_IMPORT_MAX_BYTES) throw new HttpError(413, "too_large");
    let data;
    try { data = parseMessageImport(JSON.parse(new TextDecoder().decode(raw))); }
    catch { throw new HttpError(400, "invalid_import"); }
    return json(await env.THREAD.getByName(importThreadKey(data.scope, ownerIds(env))).importMessages(data));
  } },

  // 技能目录：Registry 是唯一来源，Thread 按 digest 缓存目录；名字不合法也要匹配到路由，才能回 400 而不是 404。
  { method: "GET", path: "/admin/skills", handle: async ({ env }) => json({ skills: await env.REGISTRY.getByName("main").skillsList() }) },
  { method: "GET", path: new RegExp(`^/admin/skills/(?<name>${SKILL})$`), handle: async ({ env, params }) => {
    const skill = await env.REGISTRY.getByName("main").skillGet(params.name!);
    if (!skill) throw new HttpError(404, "not_found");
    return json(skill);
  } },
  { method: "PUT", path: new RegExp(`^/admin/skills/(?<name>${SKILL})$`), handle: async ({ env, request, params }) => {
    const { markdown, files } = await body(request, Type.Object({ markdown: Type.String(), files: Type.Optional(Type.Record(Type.String(), Type.String())) }, strict));
    let skill;
    try { skill = parseSkill(params.name!, markdown, files); }
    catch (error) { throw error instanceof SkillError ? new HttpError(400, error.code) : error; }
    return json(await env.REGISTRY.getByName("main").skillPut(skill));
  } },
  { method: "DELETE", path: new RegExp(`^/admin/skills/(?<name>${SKILL})$`), handle: async ({ env, params }) => {
    if (!await env.REGISTRY.getByName("main").skillDelete(params.name!)) throw new HttpError(404, "not_found");
    return json({ deleted: params.name });
  } },
  { method: "POST", path: new RegExp(`^/admin/skills/(?<name>${SKILL})/(?<action>enable|disable)$`), handle: async ({ env, params }) => {
    if (!await env.REGISTRY.getByName("main").skillSetEnabled(params.name!, params.action === "enable")) throw new HttpError(404, "not_found");
    return json({ name: params.name, enabled: params.action === "enable" });
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
      if (error instanceof Error && error.message.includes("view_pending")) return json({error:"view_pending"}, 503);
      if (error instanceof HttpError) return json({ error: error.code, ...error.extra }, error.status);
      // 原始异常可能带存储或远端内容，只记录路由。
      console.error({ event: "admin_failed", method: route.method, path: String(route.path), error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : typeof error });
      return json({ error: "internal" }, 500);
    }
  }
  return plain("not found", 404);
}
