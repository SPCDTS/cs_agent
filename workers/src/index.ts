import { authenticated } from "./auth";
import { handleAdmin } from "./admin/routes";
import { publicOrigin } from "./mcp/config";
import { oauthErrorCode } from "./mcp/oauth-fetch";
import type { Env } from "./env";
import { MAINTENANCE_CRON, runMaintenance } from "./maintenance";

export { RegistryDO } from "./registry";
export { BridgeDO } from "./bridge";
export { ThreadDO } from "./thread";
export { MagpieContainer } from "./magpie-container";
export { ScheduleDO } from "./schedule/do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
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
      const owner = env.THREAD.getByName("owner");
      const [bridge, model, thread, accounts, counts, schedule] = await Promise.all([
        env.BRIDGE.getByName("napcat").status(), owner.modelStatus(), owner.stats(), env.REGISTRY.getByName("main").status(), owner.mcpToolCounts(),
        env.SCHEDULE.getByName("main").status(),
      ]);
      const ok = !("unavailable" in model);
      const { threads, sendRules, ...connection } = bridge;
      return Response.json({ ok, commit: env.CS_AGENT_COMMIT, bridge: connection, model, thread, threads, sendRules, mcp: accounts.map(account => ({ ...account, tools: counts[account.server] ?? 0 })), schedule }, { status: ok ? 200 : 503 });
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (controller.cron) {
      case MAINTENANCE_CRON: ctx.waitUntil(runMaintenance(env, controller.scheduledTime)); break;
    }
  },
} satisfies ExportedHandler<Env>;
