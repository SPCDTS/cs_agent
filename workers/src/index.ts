import { authenticated } from "./auth";
import { handleAdmin } from "./admin/routes";
import { publicOrigin } from "./mcp/config";
import { oauthErrorCode } from "./mcp/oauth-fetch";
import type { Env } from "./env";
import { MAINTENANCE_CRON, runMaintenance } from "./maintenance";
import { readPush, verifyPushToken } from "./gmail/pubsub";

export { RequestsDO } from "./requests/do";
export { RegistryDO } from "./registry";
export { BridgeDO } from "./bridge";
export { ThreadDO } from "./thread";
export { ScheduleDO } from "./schedule/do";
export { EventsDO } from "./events/do";
export { SubagentDO } from "./subagent/do";
export { SandboxDO } from "./sandbox/do";

// 按 wrangler.jsonc 的 crons 字符串分派，各后台任务各占一行。
const CRONS: Record<string, (env: Env, scheduledTime: number) => Promise<void>> = {
  "*/5 * * * *": env => env.EVENTS.getByName("main").tick(),
  [MAINTENANCE_CRON]: runMaintenance,
};

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (request.method === "POST" && path === "/gmail/pubsub") {
      // 未配置服务账号即视为推送未启用；Pub/Sub 要求快速确认，真正的拉取放到 waitUntil。
      const account = env.GMAIL_PUBSUB_SERVICE_ACCOUNT?.trim();
      if (!account || !await verifyPushToken(request.headers.get("Authorization"), publicOrigin(env.PUBLIC_ORIGIN) + "/gmail/pubsub", account)) {
        return new Response("forbidden", { status: 403 });
      }
      if (!await readPush(request)) return new Response("invalid push", { status: 400 });
      ctx?.waitUntil(env.EVENTS.getByName("main").notify("gmail"));
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && path === "/oauth/client-metadata.json") {
      const origin = publicOrigin(env.PUBLIC_ORIGIN);
      return Response.json({ client_id: origin + "/oauth/client-metadata.json", client_name: "cs-agent", client_uri: origin,
        redirect_uris: [origin + "/mcp/oauth/callback"], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none" }, { headers: { "Cache-Control": "public, max-age=300" } });
    }
    if (request.method === "GET" && ["/mcp/oauth/start", "/mcp/oauth/callback"].includes(path)) {
      const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "text/plain; charset=utf-8" };
      try {
        const registry = env.REGISTRY.getByName("main");
        if (path === "/mcp/oauth/start") return new Response(null, { status: 302, headers: { ...headers, Location: await registry.startLogin(url.searchParams.get("nonce") ?? "") } });
        const server = await registry.completeLogin(url.searchParams.get("state") ?? "", url.searchParams.has("error") ? "" : url.searchParams.get("code") ?? "");
        return new Response("已登录 " + server, { headers });
      } catch (error) {
        return new Response(oauthErrorCode(error), { status: 400, headers });
      }
    }
    if (request.method === "GET" && path === "/onebot") {
      if (!(await authenticated(request, env.NAPCAT_TOKEN, true))) return new Response("unauthorized", { status: 401 });
      return env.BRIDGE.getByName("napcat").fetch(request);
    }
    if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(request, env);
    if (request.method === "GET" && path === "/healthz") {
      const owner = env.THREAD.getByName("owner"), registry = env.REGISTRY.getByName("main");
      const [bridge, model, thread, accounts, counts, schedule, events] = await Promise.all([
        env.BRIDGE.getByName("napcat").status(), registry.modelStatus(), owner.stats(), registry.status(), owner.mcpToolCounts(),
        env.SCHEDULE.getByName("main").status(), env.EVENTS.getByName("main").health(),
      ]);
      const ok = !("unavailable" in model);
      const { threads, sendRules, ...connection } = bridge;
      return Response.json({ ok, commit: env.CS_AGENT_COMMIT, bridge: connection, model, thread, threads, sendRules, mcp: accounts.map(account => ({ ...account, tools: counts[account.server] ?? 0 })), schedule, events }, { status: ok ? 200 : 503 });
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = CRONS[controller.cron];
    if (job) ctx.waitUntil(job(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
