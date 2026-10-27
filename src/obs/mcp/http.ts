import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpOAuthError, type McpOAuth } from "../../agent/pi-mcp/oauth.js";
import { sessionJson } from "../sessions/http.js";
import { esc, page } from "../ui/html.js";

export const MCP_OAUTH_CALLBACK = "/mcp/oauth/callback";
const cookie = (nonce: string, maxAge: number) => `mcp_oauth=${nonce}; Path=/mcp/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const redirect = (res: ServerResponse, target: string) => { res.writeHead(303, { Location: target }).end(); };

/** start/logout 与 JSON 在面板鉴权后调用；callback 只认一次性 state + 独立 cookie。 */
export function createMcpRoutes(oauth: McpOAuth | undefined, validatePost: (req: IncomingMessage, host: string) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, host: string, nonce: string): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (url.pathname === "/api/mcp/accounts") {
      if (req.method !== "GET") { res.setHeader("Allow", "GET"); sessionJson(res, 405, { error: "外部账号接口只支持 GET" }); return; }
      if (!oauth) { sessionJson(res, 503, { error: "未启用外部账号" }); return; }
      sessionJson(res, 200, { accounts: oauth.status(), redirectUrl: oauth.redirectUrl }); return;
    }
    if (url.pathname === MCP_OAUTH_CALLBACK) {
      res.setHeader("Set-Cookie", cookie("", 0));
      if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }).end(); return; }
      const resultPage = (title: string, message: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page({
        title, path: MCP_OAUTH_CALLBACK, nonce,
        body: `<p>${esc(message)}</p><p><a href="/mcp/accounts">返回外部账号</a></p>`,
      }));
      try {
        if (!oauth) throw new McpOAuthError("server_unavailable");
        const q = url.searchParams;
        if (["state", "code", "error"].some(name => q.getAll(name).length > 1)) throw new McpOAuthError("invalid_state");
        const result = await oauth.callback({ state: q.get("state") ?? "", code: q.get("code") ?? undefined,
          error: q.has("error") ? q.get("error") || "auth_required" : undefined,
          cookieNonce: /(?:^|;\s*)mcp_oauth=([A-Za-z0-9_-]+)(?:;|$)/u.exec(req.headers.cookie ?? "")?.[1] ?? "" });
        resultPage("外部账号已登录", `服务 ${result.serverId} 登录完成`);
      } catch (error) { resultPage("登录未完成", error instanceof McpOAuthError ? error.code : "auth_required"); }
      return;
    }
    const action = /^\/mcp\/oauth\/(start|logout)\/([A-Za-z][A-Za-z0-9_-]{0,63})$/u.exec(url.pathname);
    if (!action) { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    try {
      await validatePost(req, host);
    } catch {
      sessionJson(res, 403, { error: "表单或 CSRF 校验失败" }); return;
    }
    try {
      if (!oauth) throw new McpOAuthError("server_unavailable");
      if (action[1] === "logout") { await oauth.logout(action[2]); redirect(res, "/mcp/accounts?ok=logout"); return; }
      const nonce = randomBytes(32).toString("base64url");
      res.setHeader("Set-Cookie", cookie(nonce, 600));
      const result = await oauth.start(action[2], nonce);
      if ("authorizationUrl" in result) redirect(res, result.authorizationUrl);
      else { res.setHeader("Set-Cookie", cookie("", 0)); redirect(res, `/mcp/accounts?ok=login&server=${encodeURIComponent(action[2])}`); }
    } catch (error) {
      res.setHeader("Set-Cookie", cookie("", 0));
      redirect(res, `/mcp/accounts?error=${error instanceof McpOAuthError ? error.code : "auth_required"}`);
    }
  };
}
