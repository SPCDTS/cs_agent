import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpOAuth } from "../../src/agent/pi-mcp/oauth.js";
import { loadConfig } from "../../src/config.js";
import { ContextStore } from "../../src/context/store.js";
import { ObsStore } from "../../src/obs/store.js";
import { createDashboard } from "../../src/obs/http.js";
import { csrfToken } from "../../src/obs/http-util.js";
import { REDIRECT_URL, oauthFixture } from "../agent/fixtures/pi-mcp-oauth.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const OBS_TOKEN = "fixture-dashboard-password";
async function rig(enabled = true) {
  const fixture = await oauthFixture(); cleanup.push(fixture.close);
  const dir = await mkdtemp(join(tmpdir(), "mcp-http-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const oauth = new McpOAuth({ dataDir: dir, redirectUrl: REDIRECT_URL, servers: [fixture.config], allowLoopbackHttp: true });
  cleanup.push(() => oauth.close());
  const context = new ContextStore(dir), store = new ObsStore(dir);
  cleanup.push(() => { context.close(); store.close(); });
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN, QQ_OWNER: "123456", QQ_ALLOW_USERS: "123456" });
  const dashboard = createDashboard({ config, context, store, sessionAdapters: {}, mcpOAuth: enabled ? oauth : undefined,
    health: () => ({}), queue: () => ({}), codex: async () => ({}), pi: async () => ({}) });
  cleanup.push(() => dashboard.close());
  const server = createServer((req, res) => void dashboard.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: RequestInit = {}, cookie = `obs_token=${OBS_TOKEN}`) => fetch(origin + path, {
    ...init, redirect: "manual", headers: { cookie, ...init.headers },
  });
  const post = (path: string, csrf = csrfToken(OBS_TOKEN)) => request(path, { method: "POST", body: new URLSearchParams({ _csrf: csrf }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin } });
  const start = async () => {
    const response = await post("/mcp/oauth/start/notion");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).toContain("正在跳转到授权页");
    expect(html).toContain("如果没有自动跳转，请点击链接");
    const escapedUrl = /<meta http-equiv="refresh" content="0;url=([^"]+)">/u.exec(html)?.[1];
    if (!escapedUrl) throw new Error("fixture_missing_authorization_url");
    expect(html).toContain(`<a href="${escapedUrl}">前往授权页</a>`);
    const nonce = /<style nonce="([^"]+)">/u.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get("content-security-policy")).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    const url = escapedUrl.replaceAll("&amp;", "&");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/mcp_oauth=[A-Za-z0-9_-]+; Path=\/mcp\/oauth; HttpOnly; SameSite=Lax; Max-Age=600/u);
    return { state: new URL(url).searchParams.get("state")!, code: await fixture.authorize(url), cookie: cookie.split(";")[0] };
  };
  return { fixture, oauth, request, post, start };
}

describe("面板 MCP 外部账号", () => {
  it("真实 start/callback 使用 CSRF 与 cookie，JSON 不含 token，logout 删除凭据", async () => {
    const r = await rig();
    expect((await r.request("/api/mcp/accounts", {}, "")).status).toBe(401);
    const bad = await r.post("/mcp/oauth/start/notion", "wrong-csrf");
    expect(bad.status).toBe(403); expect(r.fixture.paths).toEqual([]);
    const flow = await r.start();
    // 跨站回调只有 Lax OAuth cookie，不携带 Strict 面板 cookie。
    const callback = await r.request(`/mcp/oauth/callback?${new URLSearchParams({ state: flow.state, code: flow.code })}`, {}, flow.cookie);
    expect(callback.status).toBe(200);
    expect(callback.headers.get("location")).toBeNull();
    expect(callback.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await callback.text();
    expect(html).toContain("外部账号已登录");
    expect(html).toContain("服务 notion 登录完成");
    expect(html).toContain('href="/mcp/accounts"');
    expect(html).not.toContain(flow.code); expect(html).not.toContain(flow.state);
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
    const response = await r.request("/api/mcp/accounts"), text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ redirectUrl: REDIRECT_URL, accounts: [{ serverId: "notion", accountId: "owner-notion",
      revision: "1", loggedIn: true, hasRefresh: true }] });
    for (const secret of [r.fixture.token.access_token, r.fixture.token.refresh_token, "access_token", "refresh_token", "client_secret", "code_verifier"]) {
      expect(text).not.toContain(secret);
    }
    expect((await r.post("/mcp/oauth/logout/notion", "wrong-csrf")).status).toBe(403);
    expect((await r.post("/mcp/oauth/logout/notion")).headers.get("location")).toBe("/mcp/accounts?ok=logout");
    expect(r.oauth.status()[0].loggedIn).toBe(false);
  });

  it("回调缺 cookie 时拒绝并清 cookie，不能换取 token", async () => {
    const r = await rig(), flow = await r.start();
    const response = await r.request(`/mcp/oauth/callback?${new URLSearchParams({ state: flow.state, code: flow.code })}`, {}, "");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("登录未完成"); expect(html).toContain("invalid_state");
    expect(html).toContain('href="/mcp/accounts"');
    expect(html).not.toContain(flow.code); expect(html).not.toContain(flow.state);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(r.fixture.grants).toEqual([]);
  });

  it("账号页展示登录状态与两个 CSRF 表单，不含 token，错误码显示中文", async () => {
    const r = await rig(), flow = await r.start();
    await r.request(`/mcp/oauth/callback?${new URLSearchParams({ state: flow.state, code: flow.code })}`, {}, flow.cookie);
    const response = await r.request("/mcp/accounts"), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("notion"); expect(html).toContain("已登录");
    const csrf = `name="_csrf" value="${csrfToken(OBS_TOKEN)}"`;
    expect(html).toMatch(new RegExp(`action="/mcp/oauth/start/notion">[^]*?${csrf}[^]*?action="/mcp/oauth/logout/notion"[^>]*>[^]*?${csrf}`, "u"));
    for (const secret of [r.fixture.token.access_token, r.fixture.token.refresh_token]) expect(html).not.toContain(secret);
    expect(await (await r.request("/mcp/accounts?error=invalid_state")).text()).toContain("登录链接已失效");
  });

  it("未配置 OAuth 的 JSON 接口返回 503", async () => {
    const r = await rig(false), response = await r.request("/api/mcp/accounts");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "未启用外部账号" });
  });
});
