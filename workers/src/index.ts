import { timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { publicOrigin } from "./mcp/config";
import type { Env } from "./env";
import { parseImport } from "./memory/import";

export { RegistryDO } from "./registry";
export { BridgeDO } from "./bridge";
export { ThreadDO } from "./thread";
export { MagpieContainer } from "./magpie-container";

async function authenticated(request: Request, secret: string | undefined, queryToken = false): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken ? new URL(request.url).searchParams.get("access_token") : null;
  if (token === null) return false;
  // 固定长度摘要交给原生常量时间比较，避免逐字符比较泄露匹配前缀。
  const encode = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(token)),
    crypto.subtle.digest("SHA-256", encode.encode(secret)),
  ]);
  return timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (request.method === "GET" && path === "/oauth/client-metadata.json") {
      const origin = publicOrigin(env.PUBLIC_ORIGIN);
      return Response.json({ client_id: origin + "/oauth/client-metadata.json", client_name: "cs-agent", client_uri: origin,
        redirect_uris: [origin + "/mcp/oauth/callback"], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none" }, { headers: { "Cache-Control": "public, max-age=300" } });
    }
    if ((request.method === "POST" && path === "/admin/mcp/oauth/login-link") ||
        (request.method === "GET" && ["/mcp/oauth/start", "/mcp/oauth/callback"].includes(path))) {
      const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "text/plain; charset=utf-8" };
      if (path.startsWith("/admin/") && !await authenticated(request, env.ADMIN_TOKEN)) return new Response("unauthorized", { status: 401, headers });
      try {
        const registry = env.REGISTRY.getByName("main");
        if (path.startsWith("/admin/")) {
          const body: unknown = await request.json();
          if (!Check(Type.Object({ server: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }) }, { additionalProperties: false }), body)) throw new Error("invalid_request");
          return Response.json(await registry.loginLink(body.server), { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
        }
        if (path === "/mcp/oauth/start") return new Response(null, { status: 302, headers: { ...headers, Location: await registry.startLogin(url.searchParams.get("nonce") ?? "") } });
        const server = await registry.completeLogin(url.searchParams.get("state") ?? "", url.searchParams.has("error") ? "" : url.searchParams.get("code") ?? "");
        return new Response("已登录 " + server, { headers });
      } catch (error) {
        // RPC/SDK 原始错误可能含远端正文；公共回调只输出白名单分类。
        const code = error instanceof Error && ["invalid_state", "unconfigured", "auth_required", "oauth_metadata", "oauth_network", "oauth_token", "server_unavailable"].includes(error.message) ? error.message : "invalid_request";
        return new Response(code, { status: 400, headers });
      }
    }
    if (request.method === "GET" && path === "/onebot") {
      if (!(await authenticated(request, env.NAPCAT_TOKEN, true))) return new Response("unauthorized", { status: 401 });
      return env.BRIDGE.getByName("napcat").fetch(request);
    }
    if (request.method === "POST" && path === "/admin/memory/import") {
      if (!(await authenticated(request, env.ADMIN_TOKEN))) return new Response("unauthorized", { status: 401 });
      let data;
      try { data = parseImport(await request.json()); }
      catch { return Response.json({ error: "invalid memory import" }, { status: 400 }); }
      return Response.json(await env.THREAD.getByName(data.ns).importMemory(data));
    }
    if (request.method === "GET" && path === "/healthz") {
      const owner = env.THREAD.getByName("owner");
      const [bridge, model, thread, accounts, counts] = await Promise.all([
        env.BRIDGE.getByName("napcat").status(), owner.modelStatus(), owner.stats(), env.REGISTRY.getByName("main").status(), owner.mcpToolCounts(),
      ]);
      const ok = !("unavailable" in model);
      const { threads, sendRules, ...connection } = bridge;
      return Response.json({ ok, commit: env.CS_AGENT_COMMIT, bridge: connection, model, thread, threads, sendRules, mcp: accounts.map(account => ({ ...account, tools: counts[account.server] ?? 0 })) }, { status: ok ? 200 : 503 });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
