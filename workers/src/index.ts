import { devicePairing } from "./cua/pairing";
import { finishCuaSetup } from "./cua/setup";
import { registerReverse } from "./mcp/reverse-route";
import { handleMediaRequest } from "./media/routes";
import { authenticated } from "./auth";
import { ICON_SVG, JOULE_PNG_BASE64, LANDING_APP_JS, LANDING_PAGE_HTML } from "./admin/app.generated";
import { API_HEADERS } from "./admin/http";
import { handleAdmin } from "./admin/routes";

let joulePngBytes: Uint8Array | undefined;
function getJoulePng(): Uint8Array {
  if (joulePngBytes) return joulePngBytes;
  const bin = atob(JOULE_PNG_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  joulePngBytes = bytes;
  return bytes;
}
import { publicOrigin } from "./mcp/config";
import { oauthErrorCode } from "./mcp/oauth-fetch";
import type { Env } from "./env";
import { MAINTENANCE_CRON, runMaintenance } from "./maintenance";
import { githubAppConfigured } from "./github/app";
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
  "*/5 * * * *": async env => { await Promise.all([env.EVENTS.getByName("main").tick(),env.BRIDGE.getByName("napcat").tick(),env.REGISTRY.getByName("main").opsTick(),finishCuaSetup(env)]); },
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
    if (request.method === "GET" && (path === "/" || path === "/landing.js")) {
      const csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      const commit = (env.JOULE_COMMIT || "dev").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "dev";
      const body = path === "/" ? LANDING_PAGE_HTML.replaceAll("__JOULE_COMMIT__", commit) : LANDING_APP_JS;
      return new Response(body, {
        headers: {
          ...API_HEADERS,
          "Content-Security-Policy": csp,
          "Content-Type": path === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        },
      });
    }
    if (request.method === "GET" && (path === "/joule.png" || path === "/favicon.ico")) {
      return new Response(getJoulePng(), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (request.method === "GET" && (path === "/icon.svg" || path === "/favicon.svg")) {
      return new Response(ICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (request.method === "GET" && path === "/healthz") return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    if (path.startsWith("/cua/join/")) return devicePairing(request,env);
    const media = await handleMediaRequest(request, { bucket: env.ASSETS, authenticateAdmin: req => authenticated(req, env.ADMIN_TOKEN) });
    if (media) return media;
    if (request.method === "POST" && path === "/github/webhook") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          (async () => {
            if (!githubAppConfigured(env)) throw new WebhookError(503,"unconfigured");
            const delivery = await readWebhook(request, env.GITHUB_APP_WEBHOOK_SECRET);
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
      return Response.json({ client_id: origin + "/oauth/client-metadata.json", client_name: "joule", client_uri: origin,
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
    const reverse = /^\/mcp\/reverse\/([A-Za-z][A-Za-z0-9_-]{0,63})$/.exec(path);
    if (reverse && request.method === "GET") return registerReverse(request, env, reverse[1]!, ctx);
    if (request.method === "GET" && path === "/onebot") {
      if (!(await authenticated(request, env.NAPCAT_TOKEN, true))) return new Response("unauthorized", { status: 401 });
      return env.BRIDGE.getByName("napcat").fetch(request);
    }
    if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(request, env, ctx);
    return new Response("not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = CRONS[controller.cron];
    if (job) ctx.waitUntil(job(env, controller.scheduledTime));
  },
  async tail(events: TraceItem[], env: Env, ctx: ExecutionContext): Promise<void> {
    const batch: import("./shared/diagnostics").DiagRecord[] = [];
    for (const item of events) {
      if (!item.outcome || item.outcome === "ok" || "consumedEvents" in (item.event ?? {})) continue;
      const firstException = item.exceptions[0];
      const errorName = firstException && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(firstException.name) ? firstException.name : undefined;
      batch.push({
        at: item.eventTimestamp ?? Date.now(),
        level: "error",
        event: "platform_invocation_failed",
        code: item.outcome,
        ...(errorName ? { errorName } : {}),
        ...(item.scriptVersion?.id ? { detail: { scriptVersion: item.scriptVersion.id.slice(0, 64) } } : {}),
      });
      if (batch.length >= 20) break;
    }
    if (batch.length) ctx.waitUntil(env.REQUESTS.getByName("main").recordDiagBatch(batch).catch(() => {}));
  },
} satisfies ExportedHandler<Env>;
