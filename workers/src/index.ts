import { backfillViews } from "./admin/read-views";
import { handleMediaRequest } from "./media/routes";
import { authenticated } from "./auth";
import { handleAdmin } from "./admin/routes";
import { publicOrigin } from "./mcp/config";
import { oauthErrorCode } from "./mcp/oauth-fetch";
import type { Env } from "./env";
import { MAINTENANCE_CRON, runMaintenance } from "./maintenance";
import { readWebhook, WebhookError } from "./github/model";
import { readPush, verifyPushToken } from "./gmail/pubsub";

export { RequestsDO } from "./requests/do";
export { RegistryDO } from "./registry";
export { BridgeDO } from "./bridge";
export { ThreadDO } from "./thread";
export { ScheduleDO } from "./schedule/do";
export { EventsDO } from "./events/do";
export { SubagentDO } from "./subagent/do";
export { SandboxDO } from "./sandbox/do";
export { CloudflareWorkspaceResourcesDO } from "./sandbox/resources";

// 按 wrangler.jsonc 的 crons 字符串分派，各后台任务各占一行。
const CRONS: Record<string, (env: Env, scheduledTime: number) => Promise<void>> = {
  "*/5 * * * *": async env => { await Promise.all([env.EVENTS.getByName("main").tick(),env.BRIDGE.getByName("napcat").tick(),env.REGISTRY.getByName("main").opsTick(),backfillViews(env)]); },
  [MAINTENANCE_CRON]: runMaintenance,
};

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (request.method === "GET" && ["/admin/github/oauth/callback","/admin/github/callback"].includes(path)) {
      const nonce=crypto.randomUUID();
      const payload=JSON.stringify({state:url.searchParams.get("state")?.slice(0,100) ?? "",code:url.searchParams.get("error") ? "" : url.searchParams.get("code")?.slice(0,512) ?? ""}).replace(/</g,String.fromCharCode(92)+"u003c");
      const script=path.endsWith("/oauth/callback") ? "sessionStorage.setItem('github-oauth-result',"+JSON.stringify(payload)+");" : "";
      return new Response("<!doctype html><meta charset=utf-8><title>GitHub</title><script nonce='"+nonce+"'>history.replaceState(null,'','/admin');"+script+"location.replace('/admin');</script>",{headers:{
        "Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer",
        "Content-Security-Policy":"default-src 'none'; script-src 'nonce-"+nonce+"'; base-uri 'none'; frame-ancestors 'none'"}});
    }
    if (request.method === "GET" && path === "/healthz") return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    const media = await handleMediaRequest(request, { bucket: env.ASSETS, authenticateAdmin: req => authenticated(req, env.ADMIN_TOKEN) });
    if (media) return media;
    if (request.method === "POST" && path === "/github/webhook") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          (async () => {
            const delivery = await readWebhook(request, env.GITHUB_MODE === "app" ? env.GITHUB_APP_WEBHOOK_SECRET : env.GITHUB_WEBHOOK_SECRET, env.GITHUB_MODE === "app");
            return env.EVENTS.getByName("main").receiveGitHub(delivery);
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WebhookError(503, "receipt_timeout")), 9000); }),
        ]);
        return Response.json({ status: result.code }, { status: result.status, headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return Response.json({ error: error instanceof WebhookError ? error.code : "receipt_unavailable" },
          { status: error instanceof WebhookError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
      } finally { clearTimeout(timer); }
    }
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
    return new Response("not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = CRONS[controller.cron];
    if (job) ctx.waitUntil(job(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
